import { extname, join } from "node:path";
import type {
  InboundAttachment,
  InboundMessage,
  LiveReplyHandle,
  OutboundTarget,
} from "../types.ts";
import { TelegramApi, TelegramApiError, type TelegramMessage } from "./api.ts";
import { markdownToTelegramHtml, splitTelegramText } from "./format.ts";

export type InboundAuthDecision = "allow" | "paired" | "deny";

export interface TelegramChannelOptions {
  readonly connectionId: string;
  readonly token: string;
  readonly attachmentsDir: string;
  readonly pollTimeoutSec?: number;
  readonly typingIntervalMs?: number;
  readonly toolFlushThrottleMs?: number;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly authorizeInbound?: (senderId: string, text: string) => InboundAuthDecision;
  readonly onMessage: (msg: InboundMessage) => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_TYPING_INTERVAL_MS = 4500;
const DEFAULT_TOOL_FLUSH_THROTTLE_MS = 500;
const TELEGRAM_CAPTION_LIMIT = 1000;
const TELEGRAM_TOOL_TRACE_LIMIT = 3900;
const MAX_BACKOFF_MS = 30_000;

function formatToolTrace(tools: readonly string[]): string {
  const joined = tools.join(" → ");
  const full = `🔧 ${joined}`;
  if (full.length <= TELEGRAM_TOOL_TRACE_LIMIT) {
    return full;
  }
  const prefix = "🔧 … → ";
  const sliceLen = Math.max(1, TELEGRAM_TOOL_TRACE_LIMIT - prefix.length);
  return `${prefix}${joined.slice(joined.length - sliceLen)}`;
}

function sanitizeFileName(raw: string): string {
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+/, "");
  return safe || "file.bin";
}

function extractRawAttachments(msg: TelegramMessage): InboundAttachment[] {
  const attachments: InboundAttachment[] = [];
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    if (largest) {
      attachments.push({
        kind: "photo",
        fileId: largest.file_id,
        fileName: `photo-${msg.message_id}.jpg`,
        mimeType: "image/jpeg",
        fileSize: largest.file_size,
      });
    }
  }
  if (msg.document) {
    attachments.push({
      kind: "document",
      fileId: msg.document.file_id,
      fileName: msg.document.file_name ?? `doc-${msg.message_id}`,
      mimeType: msg.document.mime_type,
      fileSize: msg.document.file_size,
    });
  }
  if (msg.audio) {
    attachments.push({
      kind: "audio",
      fileId: msg.audio.file_id,
      fileName: msg.audio.file_name ?? `audio-${msg.message_id}.mp3`,
      mimeType: msg.audio.mime_type,
      fileSize: msg.audio.file_size,
    });
  }
  if (msg.voice) {
    attachments.push({
      kind: "voice",
      fileId: msg.voice.file_id,
      fileName: `voice-${msg.message_id}.ogg`,
      mimeType: msg.voice.mime_type ?? "audio/ogg",
      fileSize: msg.voice.file_size,
    });
  }
  if (msg.video) {
    attachments.push({
      kind: "video",
      fileId: msg.video.file_id,
      fileName: msg.video.file_name ?? `video-${msg.message_id}.mp4`,
      mimeType: msg.video.mime_type,
      fileSize: msg.video.file_size,
    });
  }
  return attachments;
}

async function sendHtmlWithFallback(
  api: TelegramApi,
  target: OutboundTarget,
  chunk: string,
): Promise<TelegramMessage> {
  try {
    return await api.sendMessage({
      chatId: target.externalChatId,
      messageThreadId: target.externalThreadId || undefined,
      text: markdownToTelegramHtml(chunk),
      parseMode: "HTML",
    });
  } catch (error) {
    if (error instanceof TelegramApiError && error.status === 400) {
      return api.sendMessage({
        chatId: target.externalChatId,
        messageThreadId: target.externalThreadId || undefined,
        text: chunk,
      });
    }
    throw error;
  }
}

export async function sendTelegramText(
  api: TelegramApi,
  target: OutboundTarget,
  text: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (const chunk of splitTelegramText(text, 3800)) {
    const msg = await sendHtmlWithFallback(api, target, chunk);
    ids.push(String(msg.message_id));
  }
  return ids;
}

export async function sendTelegramFile(
  api: TelegramApi,
  target: OutboundTarget,
  filePath: string,
  caption?: string,
): Promise<string[]> {
  const ids: string[] = [];
  const trimmedCaption = caption?.trim() ?? "";
  const inlineCaption =
    trimmedCaption.length > 0 && trimmedCaption.length <= TELEGRAM_CAPTION_LIMIT
      ? trimmedCaption
      : undefined;

  const sent = await api.sendSmartFile({
    chatId: target.externalChatId,
    messageThreadId: target.externalThreadId || undefined,
    filePath,
    caption: inlineCaption,
  });
  ids.push(String(sent.message_id));

  if (trimmedCaption && !inlineCaption) {
    const extraIds = await sendTelegramText(api, target, trimmedCaption);
    ids.push(...extraIds);
  }
  return ids;
}

export class TelegramChannel {
  readonly connectionId: string;
  readonly platform = "telegram" as const;
  readonly api: TelegramApi;

  private readonly attachmentsDir: string;
  private readonly pollTimeoutSec: number;
  private readonly typingIntervalMs: number;
  private readonly toolFlushThrottleMs: number;
  private readonly authorizeInbound?: (senderId: string, text: string) => InboundAuthDecision;
  private readonly onMessage: (msg: InboundMessage) => void | Promise<void>;
  private readonly onError?: (error: unknown) => void;

  private running = false;
  private pollAbort: AbortController | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffResolve: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;
  private nextOffset: number | undefined;

  constructor(options: TelegramChannelOptions) {
    this.connectionId = options.connectionId;
    this.attachmentsDir = options.attachmentsDir;
    this.pollTimeoutSec = options.pollTimeoutSec ?? 30;
    this.typingIntervalMs = options.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS;
    this.toolFlushThrottleMs = options.toolFlushThrottleMs ?? DEFAULT_TOOL_FLUSH_THROTTLE_MS;
    this.authorizeInbound = options.authorizeInbound;
    this.onMessage = options.onMessage;
    this.onError = options.onError;
    this.api = new TelegramApi({
      token: options.token,
      apiBaseUrl: options.apiBaseUrl,
      fetchImpl: options.fetchImpl,
    });
  }

  start(): Promise<void> {
    if (this.running) {
      return Promise.resolve();
    }
    this.running = true;
    this.loopPromise = this.pollLoop();
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    if (!this.running && !this.loopPromise) {
      return;
    }
    this.running = false;
    this.pollAbort?.abort();
    this.pollAbort = null;
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    if (this.backoffResolve) {
      const wake = this.backoffResolve;
      this.backoffResolve = null;
      wake();
    }
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }

  async beginLiveReply(
    target: OutboundTarget,
    inboundMessageId?: string,
  ): Promise<LiveReplyHandle> {
    if (inboundMessageId) {
      await this.api
        .setMessageReaction({
          chatId: target.externalChatId,
          messageId: inboundMessageId,
          emoji: "👀",
        })
        .catch(() => {});
    }

    const sendTyping = () =>
      this.api
        .sendChatAction({
          chatId: target.externalChatId,
          messageThreadId: target.externalThreadId || undefined,
          action: "typing",
        })
        .catch(() => {});

    await sendTyping();
    const typingTimer = setInterval(() => {
      void sendTyping();
    }, this.typingIntervalMs);
    typingTimer.unref();

    const toolCalls: string[] = [];
    let toolMessageId: string | null = null;
    let lastSentCount = 0;
    let toolFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let outboundChain: Promise<void> = Promise.resolve();
    let segmentSendFailed = false;

    const enqueueOutbound = <T>(task: () => Promise<T>): Promise<T> => {
      const result = outboundChain.then(task);
      outboundChain = result.then(
        () => {},
        () => {},
      );
      return result;
    };

    const sendToolUpdateNow = (): Promise<void> =>
      enqueueOutbound(async () => {
        if (toolCalls.length === 0 || toolCalls.length === lastSentCount) {
          return;
        }
        const text = formatToolTrace(toolCalls);
        lastSentCount = toolCalls.length;
        try {
          if (toolMessageId === null) {
            const sent = await this.api.sendMessage({
              chatId: target.externalChatId,
              messageThreadId: target.externalThreadId || undefined,
              text,
            });
            toolMessageId = String(sent.message_id);
          } else {
            await this.api.editMessageText({
              chatId: target.externalChatId,
              messageId: toolMessageId,
              text,
            });
          }
        } catch {
          // Ignore transient Telegram failure on tool trace updates.
        }
      });

    const flushToolTrace = async (): Promise<void> => {
      if (toolFlushTimer) {
        clearTimeout(toolFlushTimer);
        toolFlushTimer = null;
      }
      await sendToolUpdateNow();
    };

    const clearReaction = async (): Promise<void> => {
      if (!inboundMessageId) {
        return;
      }
      await this.api
        .setMessageReaction({
          chatId: target.externalChatId,
          messageId: inboundMessageId,
          emoji: null,
        })
        .catch(() => {});
    };

    const finalize = async (text?: string): Promise<void> => {
      clearInterval(typingTimer);
      await flushToolTrace();
      if (text) {
        await enqueueOutbound(() => this.sendText(target, text));
      }
      await clearReaction();
    };

    return {
      sendTextSegment: (text: string) => {
        const trimmed = text.trim();
        if (!trimmed || segmentSendFailed) {
          return Promise.resolve(false);
        }
        return enqueueOutbound(async () => {
          if (segmentSendFailed) {
            return false;
          }
          try {
            await this.sendText(target, trimmed);
            return true;
          } catch {
            segmentSendFailed = true;
            return false;
          }
        });
      },
      recordToolCall: (toolName: string) => {
        toolCalls.push(toolName);
        if (toolMessageId === null && toolCalls.length === 1) {
          void sendToolUpdateNow();
          return;
        }
        if (this.toolFlushThrottleMs <= 0) {
          void sendToolUpdateNow();
          return;
        }
        if (!toolFlushTimer) {
          toolFlushTimer = setTimeout(() => {
            toolFlushTimer = null;
            void sendToolUpdateNow();
          }, this.toolFlushThrottleMs);
          toolFlushTimer.unref();
        }
      },
      finish: (finalText: string) => finalize(finalText.trim() || undefined),
      fail: (errorText: string) => finalize(`⚠️ ${errorText}`),
    };
  }

  async sendText(target: OutboundTarget, text: string): Promise<string[]> {
    return sendTelegramText(this.api, target, text);
  }

  async reactMessage(
    target: OutboundTarget,
    messageId: string,
    emoji: string | null,
  ): Promise<void> {
    await this.api
      .setMessageReaction({
        chatId: target.externalChatId,
        messageId,
        emoji,
      })
      .catch(() => {});
  }

  async renameTopic(target: OutboundTarget, title: string): Promise<void> {
    if (!target.externalThreadId) {
      return;
    }
    await this.api
      .editForumTopic({
        chatId: target.externalChatId,
        messageThreadId: target.externalThreadId,
        name: title,
      })
      .catch(() => {});
  }

  async sendFile(target: OutboundTarget, filePath: string, caption?: string): Promise<string[]> {
    return sendTelegramFile(this.api, target, filePath, caption);
  }

  private async pollLoop(): Promise<void> {
    let backoffMs = 1000;
    while (this.running) {
      const controller = new AbortController();
      this.pollAbort = controller;
      try {
        const updates = await this.api.getUpdates({
          offset: this.nextOffset,
          timeoutSec: this.pollTimeoutSec,
          signal: controller.signal,
        });
        this.pollAbort = null;
        backoffMs = 1000;

        for (const update of updates) {
          this.nextOffset = update.update_id + 1;
          if (update.message) {
            await this.handleUpdate(update.message);
          }
        }
      } catch (error) {
        this.pollAbort = null;
        if (!this.running) {
          break;
        }
        if (error instanceof Error && error.name === "AbortError") {
          continue;
        }
        this.onError?.(error);
        const waitMs =
          error instanceof TelegramApiError && error.retryAfterSec
            ? error.retryAfterSec * 1000
            : backoffMs;
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        await this.sleepAbortable(waitMs);
      }
    }
  }

  private sleepAbortable(ms: number): Promise<void> {
    if (!this.running) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.backoffResolve = resolve;
      this.backoffTimer = setTimeout(() => {
        this.backoffTimer = null;
        this.backoffResolve = null;
        resolve();
      }, ms);
      this.backoffTimer.unref();
    });
  }

  private async handleUpdate(msg: TelegramMessage | undefined): Promise<void> {
    if (!msg || msg.chat.type !== "private" || msg.from?.is_bot) {
      return;
    }

    const senderId = String(msg.from?.id ?? msg.chat.id);
    const rawText = (msg.text ?? msg.caption ?? "").trim();
    const decision = this.authorizeInbound?.(senderId, rawText) ?? "allow";
    if (decision === "deny") {
      return;
    }
    if (decision === "paired") {
      await this.sendText(
        {
          externalChatId: String(msg.chat.id),
          externalThreadId:
            msg.message_thread_id !== undefined ? String(msg.message_thread_id) : "",
        },
        "Paired! You can start chatting now.",
      );
      return;
    }

    const rawAttachments = extractRawAttachments(msg);
    const downloaded = await Promise.all(
      rawAttachments.map(async (att): Promise<InboundAttachment> => {
        try {
          const info = await this.api.getFile(att.fileId);
          if (!info.file_path) {
            return att;
          }
          const fallbackExt = extname(info.file_path);
          const baseName = sanitizeFileName(
            att.fileName ?? `${att.kind}-${att.fileId}${fallbackExt}`,
          );
          const destPath = join(this.attachmentsDir, `${msg.message_id}-${baseName}`);
          const localPath = await this.api.downloadFile(info.file_path, destPath);
          return { ...att, localPath };
        } catch (error) {
          this.onError?.(error);
          return att;
        }
      }),
    );

    const text = (msg.text ?? msg.caption ?? "").trim();
    if (!text && downloaded.length === 0) {
      return;
    }

    const senderName = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name;
    const inbound: InboundMessage = {
      connectionId: this.connectionId,
      platform: "telegram",
      externalChatId: String(msg.chat.id),
      externalThreadId: msg.message_thread_id !== undefined ? String(msg.message_thread_id) : "",
      senderId,
      senderName,
      messageId: String(msg.message_id),
      text,
      attachments: downloaded,
      receivedAt: msg.date * 1000,
    };

    try {
      await this.onMessage(inbound);
    } catch (error) {
      this.onError?.(error);
    }
  }
}
