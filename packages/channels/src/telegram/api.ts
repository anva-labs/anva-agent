import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";

const DEFAULT_API_BASE = "https://api.telegram.org";
const TELEGRAM_PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const TELEGRAM_MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export interface TelegramUser {
  readonly id: number;
  readonly is_bot: boolean;
  readonly first_name: string;
  readonly username?: string;
}

export interface TelegramChat {
  readonly id: number;
  readonly type: "private" | "group" | "supergroup" | "channel";
  readonly username?: string;
  readonly first_name?: string;
}

export interface TelegramPhotoSize {
  readonly file_id: string;
  readonly width: number;
  readonly height: number;
  readonly file_size?: number;
}

export interface TelegramDocument {
  readonly file_id: string;
  readonly file_name?: string;
  readonly mime_type?: string;
  readonly file_size?: number;
}

export interface TelegramMediaItem {
  readonly file_id: string;
  readonly file_name?: string;
  readonly mime_type?: string;
  readonly file_size?: number;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly message_thread_id?: number;
  readonly from?: TelegramUser;
  readonly chat: TelegramChat;
  readonly date: number;
  readonly text?: string;
  readonly caption?: string;
  readonly photo?: readonly TelegramPhotoSize[];
  readonly document?: TelegramDocument;
  readonly audio?: TelegramMediaItem;
  readonly voice?: TelegramMediaItem;
  readonly video?: TelegramMediaItem;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
}

export interface TelegramFile {
  readonly file_id: string;
  readonly file_size?: number;
  readonly file_path?: string;
}

export interface TelegramBotCommand {
  readonly command: string;
  readonly description: string;
}

interface TelegramResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly error_code?: number;
  readonly description?: string;
  readonly parameters?: {
    readonly retry_after?: number;
  };
}

export class TelegramApiError extends Error {
  readonly status: number;
  readonly errorCode?: number;
  readonly retryAfterSec?: number;

  constructor(message: string, status: number, errorCode?: number, retryAfterSec?: number) {
    super(message);
    this.name = "TelegramApiError";
    this.status = status;
    this.errorCode = errorCode;
    this.retryAfterSec = retryAfterSec;
  }
}

export interface TelegramApiOptions {
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

function toThreadIdParam(externalThreadId: string | undefined): number | undefined {
  if (!externalThreadId) {
    return undefined;
  }
  const parsed = Number(externalThreadId);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export class TelegramApi {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TelegramApiOptions) {
    this.token = options.token;
    this.baseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private endpoint(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  private async callJson<T>(
    method: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchImpl(this.endpoint(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal,
    });
    return this.unwrap<T>(response);
  }

  private async callMultipart<T>(method: string, form: FormData): Promise<T> {
    const response = await this.fetchImpl(this.endpoint(method), {
      method: "POST",
      body: form,
    });
    return this.unwrap<T>(response);
  }

  private async unwrap<T>(response: Response): Promise<T> {
    let payload: TelegramResponse<T>;
    try {
      payload = (await response.json()) as TelegramResponse<T>;
    } catch {
      throw new TelegramApiError(
        `Telegram API returned HTTP ${response.status} with non-JSON body.`,
        response.status,
      );
    }

    if (!response.ok || !payload.ok || payload.result === undefined) {
      throw new TelegramApiError(
        payload.description ?? `Telegram API error (HTTP ${response.status}).`,
        response.status,
        payload.error_code,
        payload.parameters?.retry_after,
      );
    }
    return payload.result;
  }

  getMe(): Promise<TelegramUser> {
    return this.callJson<TelegramUser>("getMe");
  }

  getUpdates(options: {
    readonly offset?: number;
    readonly timeoutSec?: number;
    readonly signal?: AbortSignal;
  }): Promise<TelegramUpdate[]> {
    return this.callJson<TelegramUpdate[]>(
      "getUpdates",
      {
        ...(options.offset !== undefined ? { offset: options.offset } : {}),
        timeout: options.timeoutSec ?? 30,
        allowed_updates: ["message"],
      },
      options.signal,
    );
  }

  async sendChatAction(params: {
    readonly chatId: string;
    readonly messageThreadId?: string;
    readonly action?: "typing";
  }): Promise<void> {
    const threadNum = toThreadIdParam(params.messageThreadId);
    await this.callJson<boolean>("sendChatAction", {
      chat_id: params.chatId,
      action: params.action ?? "typing",
      ...(threadNum !== undefined ? { message_thread_id: threadNum } : {}),
    });
  }

  sendMessage(params: {
    readonly chatId: string;
    readonly messageThreadId?: string;
    readonly text: string;
    readonly parseMode?: "HTML";
  }): Promise<TelegramMessage> {
    const threadNum = toThreadIdParam(params.messageThreadId);
    return this.callJson<TelegramMessage>("sendMessage", {
      chat_id: params.chatId,
      text: params.text,
      ...(params.parseMode ? { parse_mode: params.parseMode } : {}),
      ...(threadNum !== undefined ? { message_thread_id: threadNum } : {}),
    });
  }

  async editMessageText(params: {
    readonly chatId: string;
    readonly messageId: string | number;
    readonly text: string;
    readonly parseMode?: "HTML";
  }): Promise<void> {
    try {
      await this.callJson<TelegramMessage | boolean>("editMessageText", {
        chat_id: params.chatId,
        message_id: Number(params.messageId),
        text: params.text,
        ...(params.parseMode ? { parse_mode: params.parseMode } : {}),
      });
    } catch (error) {
      if (
        error instanceof TelegramApiError &&
        error.message.toLowerCase().includes("message is not modified")
      ) {
        return;
      }
      throw error;
    }
  }

  async sendSmartFile(params: {
    readonly chatId: string;
    readonly messageThreadId?: string;
    readonly filePath: string;
    readonly caption?: string;
  }): Promise<TelegramMessage> {
    const bytes = readFileSync(params.filePath);
    const fileName = basename(params.filePath);
    const ext = extname(fileName).toLowerCase();
    const isPhoto = TELEGRAM_PHOTO_EXTS.has(ext) && bytes.byteLength <= TELEGRAM_MAX_PHOTO_BYTES;

    const form = new FormData();
    form.set("chat_id", params.chatId);
    const threadNum = toThreadIdParam(params.messageThreadId);
    if (threadNum !== undefined) {
      form.set("message_thread_id", String(threadNum));
    }
    if (params.caption) {
      form.set("caption", params.caption);
    }

    const field = isPhoto ? "photo" : "document";
    form.set(field, new Blob([bytes]), fileName);
    return this.callMultipart<TelegramMessage>(isPhoto ? "sendPhoto" : "sendDocument", form);
  }

  getFile(fileId: string): Promise<TelegramFile> {
    return this.callJson<TelegramFile>("getFile", { file_id: fileId });
  }

  async downloadFile(remoteFilePath: string, destPath: string): Promise<string> {
    const cleaned = remoteFilePath.replace(/^\/+/, "");
    const url = `${this.baseUrl}/file/bot${this.token}/${cleaned}`;
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new TelegramApiError(
        `Failed to download Telegram file "${cleaned}" (HTTP ${response.status}).`,
        response.status,
      );
    }
    const buf = Buffer.from(await response.arrayBuffer());
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, buf);
    return destPath;
  }

  async setMyCommands(commands: readonly TelegramBotCommand[]): Promise<void> {
    await this.callJson<boolean>("setMyCommands", { commands });
  }

  async setMessageReaction(params: {
    readonly chatId: string;
    readonly messageId: string | number;
    readonly emoji?: string | null;
  }): Promise<void> {
    await this.callJson<boolean>("setMessageReaction", {
      chat_id: params.chatId,
      message_id: Number(params.messageId),
      reaction: params.emoji ? [{ type: "emoji", emoji: params.emoji }] : [],
    });
  }

  async editForumTopic(params: {
    readonly chatId: string;
    readonly messageThreadId: string;
    readonly name: string;
  }): Promise<void> {
    const threadNum = toThreadIdParam(params.messageThreadId);
    if (threadNum === undefined) {
      return;
    }
    const cleaned = params.name
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, 128);
    if (!cleaned) {
      return;
    }
    await this.callJson<boolean>("editForumTopic", {
      chat_id: params.chatId,
      message_thread_id: threadNum,
      name: cleaned,
    });
  }
}
