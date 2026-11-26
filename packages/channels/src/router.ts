import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import {
  AnvaError,
  formatChannelAttachmentTag,
  type AgentRecord,
  type ChannelBridge,
  type ChannelBridgeContext,
  type ChannelConnectInput,
  type ChannelConnectionRecord,
  type ChannelConnectionSummary,
  type ChannelSendInput,
  type ChannelSendResult,
  type HarnessInputImage,
  loadAgentEnv,
  setAgentEnvVar,
  type ThreadRecord,
} from "@anva/core";
import { TelegramApi } from "./telegram/api.ts";
import { sendTelegramFile, sendTelegramText, TelegramChannel } from "./telegram/channel.ts";
import { parseSlashCommand } from "./telegram/format.ts";
import type { InboundMessage, OutboundTarget } from "./types.ts";

export interface ChannelRouterOptions {
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly pollTimeoutSec?: number;
  readonly typingIntervalMs?: number;
  readonly toolFlushThrottleMs?: number;
  readonly onError?: (error: unknown) => void;
}

interface ActiveConnection {
  connection: ChannelConnectionRecord;
  readonly channel: TelegramChannel;
}

const SLASH_COMMANDS = new Set(["new", "stop", "model", "status", "usage"]);

const TELEGRAM_COMMANDS = [
  { command: "new", description: "Start a new thread (optional: /new <harness>)" },
  { command: "stop", description: "Abort the active turn on this thread" },
  { command: "model", description: "List or switch model on the current harness" },
  { command: "status", description: "Show thread harness, model, and context usage" },
  { command: "usage", description: "Show harness auth status and quota windows" },
] as const;

function parseRawTarget(target: string): OutboundTarget {
  const idx = target.indexOf(":");
  if (idx <= 0) {
    return { externalChatId: target, externalThreadId: "" };
  }
  return {
    externalChatId: target.slice(0, idx),
    externalThreadId: target.slice(idx + 1),
  };
}

const PAIRING_TTL_MS = 10 * 60_000;

function parseAllowedUserIds(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set();
  }
  const ids = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(ids);
}

function codesEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function extractStartPairingCode(text: string): string | null {
  const match = /^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]+)$/i.exec(text.trim());
  return match?.[1] ?? null;
}

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function extractNativeImages(msg: InboundMessage): HarnessInputImage[] {
  const images: HarnessInputImage[] = [];
  for (const att of msg.attachments) {
    if (!att.localPath) {
      continue;
    }
    const isSupported =
      att.kind === "photo" || (att.mimeType ? SUPPORTED_IMAGE_TYPES.has(att.mimeType) : false);
    if (!isSupported) {
      continue;
    }
    images.push({
      path: att.localPath,
      ...(att.mimeType ? { mediaType: att.mimeType } : {}),
    });
  }
  return images;
}

function formatInboundPrompt(msg: InboundMessage): string {
  const parts: string[] = [];
  if (msg.text) {
    parts.push(msg.text);
  }
  for (const att of msg.attachments) {
    parts.push(formatChannelAttachmentTag(att));
  }
  return parts.join("\n\n").trim();
}

export function createChannelRouter(
  ctx: ChannelBridgeContext,
  options: ChannelRouterOptions = {},
): ChannelBridge {
  const active = new Map<string, ActiveConnection>();
  const pendingPairings = new Map<string, { readonly code: string; readonly expiresAt: number }>();
  const { store, harness, threads, paths } = ctx;

  function createTelegramAdapter(conn: ChannelConnectionRecord, token: string): TelegramChannel {
    return new TelegramChannel({
      connectionId: conn.id,
      token,
      attachmentsDir: paths.agentAttachments(conn.agentSlug),
      pollTimeoutSec: options.pollTimeoutSec,
      typingIntervalMs: options.typingIntervalMs,
      toolFlushThrottleMs: options.toolFlushThrottleMs,
      apiBaseUrl: options.apiBaseUrl,
      fetchImpl: options.fetchImpl,
      authorizeInbound: (senderId, text) => {
        const agentHome = paths.agentHome(conn.agentSlug);
        const allowed = parseAllowedUserIds(loadAgentEnv(agentHome).vars.TELEGRAM_ALLOWED_USER_IDS);
        if (allowed.has(senderId)) {
          return "allow";
        }
        const pending = pendingPairings.get(conn.id);
        if (!pending) {
          return "deny";
        }
        if (Date.now() > pending.expiresAt) {
          pendingPairings.delete(conn.id);
          return "deny";
        }
        const provided = extractStartPairingCode(text);
        if (!provided || !codesEqual(pending.code, provided)) {
          return "deny";
        }
        pendingPairings.delete(conn.id);
        allowed.add(senderId);
        setAgentEnvVar(
          paths.agentEnv(conn.agentSlug),
          "TELEGRAM_ALLOWED_USER_IDS",
          [...allowed].join(","),
        );
        return "paired";
      },
      onMessage: (msg) => {
        void handleInbound(msg).catch((error) => options.onError?.(error));
      },
      onError: options.onError,
    });
  }

  function createBoundThread(
    conn: ChannelConnectionRecord,
    agent: AgentRecord,
    target: OutboundTarget,
    overrides?: { readonly harness?: string; readonly model?: string | null },
  ): ThreadRecord {
    const thread = store.createThread({
      agentSlug: agent.slug,
      title: "",
      source: "channel",
      harness: overrides?.harness ?? agent.defaultHarness,
      model: overrides?.model !== undefined ? overrides.model : agent.defaultModel,
    });
    store.upsertChannelRoute({
      connectionId: conn.id,
      externalChatId: target.externalChatId,
      externalThreadId: target.externalThreadId,
      threadId: thread.id,
    });
    return thread;
  }

  async function handleSlashCommand(
    entry: ActiveConnection,
    agent: AgentRecord,
    target: OutboundTarget,
    command: string,
    args: string,
  ): Promise<void> {
    const { connection, channel } = entry;
    const route = store.getChannelRoute(
      connection.id,
      target.externalChatId,
      target.externalThreadId,
    );
    const boundThread = route ? store.getThread(route.threadId) : null;

    if (command === "new") {
      const requestedHarness = args.trim();
      if (!requestedHarness) {
        store.deleteChannelRoute(connection.id, target.externalChatId, target.externalThreadId);
        await channel.sendText(
          target,
          `Started fresh. Next message will use default harness \`${agent.defaultHarness}\` (or send \`/new <harness>\`).`,
        );
        return;
      }
      if (!harness.has(requestedHarness)) {
        await channel.sendText(target, `Unknown harness \`${requestedHarness}\`.`);
        return;
      }
      const thread = createBoundThread(connection, agent, target, {
        harness: requestedHarness,
        model: requestedHarness === agent.defaultHarness ? agent.defaultModel : null,
      });
      await channel.sendText(
        target,
        `Started new thread \`${thread.id}\` (harness=${thread.harness}${thread.model ? `, model=${thread.model}` : ""}).`,
      );
      return;
    }

    if (command === "stop") {
      if (!boundThread) {
        await channel.sendText(target, "No active thread in this chat yet.");
        return;
      }
      const res = await threads.stopThread(boundThread.id);
      await channel.sendText(
        target,
        res.stopped
          ? `Stopped thread ${boundThread.id}.`
          : `Thread ${boundThread.id} is not running.`,
      );
      return;
    }

    if (command === "model") {
      if (!args) {
        const targetHarness = boundThread?.harness ?? agent.defaultHarness;
        const currentModel = boundThread ? boundThread.model : agent.defaultModel;
        const list = await harness.models(targetHarness, paths.agentHome(agent.slug));
        const lines = [
          `Harness: ${targetHarness}`,
          `Current model: ${currentModel ?? "(harness default)"}`,
        ];
        if (list.kind === "unauthenticated") {
          lines.push(
            `(${targetHarness} is not signed in: ${list.detail ?? "please sign in first"})`,
          );
        } else if (list.kind === "unsupported") {
          lines.push(`(${list.reason})`);
        } else {
          const enabled = list.models.filter((m) => !m.disabledReason);
          const disabledCount = list.models.length - enabled.length;
          lines.push("", `\`/model default\`${currentModel === null ? " ✓" : ""}`);
          for (const m of enabled) {
            const defTag = m.isDefault ? " (default)" : "";
            const activeTag = currentModel === m.id ? " ✓" : "";
            lines.push(`\`/model ${m.id}\`${defTag}${activeTag}`);
          }
          if (disabledCount > 0) {
            lines.push(`(${disabledCount} disabled model(s) hidden)`);
          }
        }
        lines.push("", "To switch harness, run `/new <harness>`.");
        await channel.sendText(target, lines.join("\n"));
        return;
      }

      const nextModel = args === "default" || args === "reset" ? null : args;
      try {
        if (boundThread) {
          const updated = await threads.switchModel(boundThread.id, nextModel);
          await channel.sendText(
            target,
            `Switched thread ${updated.id} model to ${updated.model ?? "(harness default)"} (harness=${updated.harness}).`,
          );
        } else {
          if (nextModel !== null) {
            await threads.validateModel(agent.defaultHarness, agent.slug, nextModel);
          }
          const created = createBoundThread(connection, agent, target, { model: nextModel });
          await channel.sendText(
            target,
            `Switched thread ${created.id} model to ${created.model ?? "(harness default)"} (harness=${created.harness}).`,
          );
        }
      } catch (error) {
        const msg = error instanceof AnvaError ? error.next : String(error);
        await channel.sendText(target, `Failed to switch model: ${msg}`);
      }
      return;
    }

    if (command === "status") {
      if (!boundThread) {
        await channel.sendText(
          target,
          `Agent: ${agent.slug} (${agent.name})\nNo active thread yet. Send a message or /new to start (default harness=${agent.defaultHarness}).`,
        );
        return;
      }
      const rt = threads.getThreadRuntimeStatus(boundThread.id);
      const state = rt.running ? "running" : rt.active ? "active" : "idle";
      const modelDisplay = rt.activeModel ?? boundThread.model ?? "(default)";
      const ctxDisplay =
        rt.contextUsage && rt.contextUsage.tokens !== null
          ? `${rt.contextUsage.tokens}${rt.contextUsage.contextWindow ? ` / ${rt.contextUsage.contextWindow}` : ""}${rt.contextUsage.percent !== null ? ` (${Math.round(rt.contextUsage.percent)}%)` : ""}`
          : "n/a";
      await channel.sendText(
        target,
        [
          `Agent: ${agent.slug} (${agent.name})`,
          `Thread: ${boundThread.id}`,
          `Harness: ${boundThread.harness}`,
          `Model: ${modelDisplay}`,
          `State: ${state}`,
          `Context: ${ctxDisplay}`,
        ].join("\n"),
      );
      return;
    }

    if (command === "usage") {
      const targetHarness = boundThread?.harness ?? agent.defaultHarness;
      const status = await harness.probe(targetHarness);
      const authText =
        status.auth.kind === "signed_in"
          ? `signed_in${status.auth.account ? ` (${status.auth.account})` : ""}${status.auth.plan ? ` · ${status.auth.plan}` : ""}`
          : status.auth.kind === "signed_out"
            ? `signed_out${status.auth.detail ? ` (${status.auth.detail})` : ""}`
            : "unknown";
      const lines = [
        `Harness: ${status.id}${status.version ? ` (${status.version})` : ""}`,
        `Auth: ${authText}`,
      ];
      if (status.usage) {
        lines.push(`Rate limited: ${status.usage.rateLimited ? "yes" : "no"}`);
        if (status.usage.windows.length === 0) {
          lines.push("Usage windows: (none reported)");
        } else {
          for (const w of status.usage.windows) {
            const pct = Math.round(w.usedRatio * 100);
            lines.push(`- ${w.label}: ${pct}%${w.resetsAt ? ` (resets ${w.resetsAt})` : ""}`);
          }
        }
      } else {
        lines.push("Usage: unavailable for this harness");
      }
      await channel.sendText(target, lines.join("\n"));
    }
  }

  async function handleInbound(msg: InboundMessage): Promise<void> {
    const entry = active.get(msg.connectionId);
    if (!entry) {
      return;
    }
    const agent = store.getAgent(entry.connection.agentSlug);
    if (!agent) {
      return;
    }

    const target: OutboundTarget = {
      externalChatId: msg.externalChatId,
      externalThreadId: msg.externalThreadId,
    };

    if (msg.attachments.length === 0) {
      const parsed = parseSlashCommand(msg.text);
      if (parsed && SLASH_COMMANDS.has(parsed.command)) {
        try {
          await handleSlashCommand(entry, agent, target, parsed.command, parsed.args);
        } catch (error) {
          const errMsg =
            error instanceof AnvaError ? `${error.code}: ${error.next}` : String(error);
          await entry.channel.sendText(target, `⚠️ ${errMsg}`);
        }
        return;
      }
    }

    const prompt = formatInboundPrompt(msg);
    if (!prompt) {
      return;
    }

    const existingRoute = store.getChannelRoute(
      entry.connection.id,
      target.externalChatId,
      target.externalThreadId,
    );
    const existingThread = existingRoute ? store.getThread(existingRoute.threadId) : null;
    const thread = existingThread ?? createBoundThread(entry.connection, agent, target);

    const images = extractNativeImages(msg);
    const alreadyRunning = threads.getThreadRuntimeStatus(thread.id).running;
    if (alreadyRunning) {
      await entry.channel.reactMessage(target, msg.messageId, "👍");
      try {
        const res = await threads.ask({
          threadId: thread.id,
          prompt,
          source: "channel",
          ...(images.length > 0 ? { images } : {}),
        });
        if (!res.async && !res.steered) {
          await entry.channel.sendText(target, res.reply.trim() || "(empty reply)");
        }
      } catch (error) {
        const errMsg =
          error instanceof AnvaError
            ? `${error.code}: ${error.next}`
            : error instanceof Error
              ? error.message
              : String(error);
        await entry.channel.sendText(target, `⚠️ ${errMsg}`);
      } finally {
        await entry.channel.reactMessage(target, msg.messageId, null);
      }
      return;
    }

    const live = await entry.channel.beginLiveReply(target, msg.messageId);
    let streamedLen = 0;
    let segmentChain: Promise<boolean> = Promise.resolve(true);
    try {
      const res = await threads.ask({
        threadId: thread.id,
        prompt,
        source: "channel",
        ...(images.length > 0 ? { images } : {}),
        onToolCall: (toolName) => live.recordToolCall(toolName),
        onTextSegment: (text, endOffset) => {
          const sent = live.sendTextSegment(text);
          segmentChain = segmentChain.then(async (ok) => {
            if (!ok || !(await sent)) {
              return false;
            }
            streamedLen = endOffset;
            return true;
          });
        },
      });

      await segmentChain;
      let finalText = res.async ? "Queued for processing." : res.reply.slice(streamedLen).trim();
      if (!res.async && !finalText && streamedLen === 0) {
        finalText = "(empty reply)";
      }
      await live.finish(finalText);
    } catch (error) {
      const errMsg =
        error instanceof AnvaError
          ? `${error.code}: ${error.next}`
          : error instanceof Error
            ? error.message
            : String(error);
      await live.fail(errMsg);
    }
  }

  function resolveSendTarget(input: ChannelSendInput): {
    readonly conn: ChannelConnectionRecord;
    readonly api: TelegramApi;
    readonly target: OutboundTarget;
  } {
    let conn: ChannelConnectionRecord | null = null;
    let target: OutboundTarget;

    if (input.target.startsWith("th_")) {
      const route = store.getChannelRouteByThread(input.target);
      if (!route) {
        throw new AnvaError(
          "channel_route_not_found",
          `Thread "${input.target}" is not bound to any channel chat.`,
          404,
        );
      }
      conn = store.getChannelConnection(route.connectionId);
      target = {
        externalChatId: route.externalChatId,
        externalThreadId: route.externalThreadId,
      };
    } else {
      target = parseRawTarget(input.target);
      if (input.agentSlug) {
        conn = store.findChannelConnection("telegram", input.agentSlug);
      } else {
        const all = store.listChannelConnections().filter((c) => c.platform === "telegram");
        if (all.length === 1) {
          conn = all[0] ?? null;
        } else if (all.length > 1) {
          throw new AnvaError(
            "agent_required",
            "Multiple Telegram connections exist; pass --agent <slug> or target a th_xxx thread ID.",
            400,
          );
        }
      }
    }

    if (!conn) {
      throw new AnvaError(
        "channel_not_found",
        'No matching Telegram channel connection found. Connect one with "anva channel connect telegram --agent <slug>".',
        404,
      );
    }

    const activeEntry = active.get(conn.id);
    if (activeEntry) {
      return { conn, api: activeEntry.channel.api, target };
    }

    const env = loadAgentEnv(paths.agentHome(conn.agentSlug));
    const token = env.vars[conn.envKey]?.trim();
    if (!token) {
      throw new AnvaError(
        "channel_token_missing",
        `Missing ${conn.envKey} in ${paths.agentEnv(conn.agentSlug)}.`,
        400,
      );
    }
    return {
      conn,
      api: new TelegramApi({
        token,
        apiBaseUrl: options.apiBaseUrl,
        fetchImpl: options.fetchImpl,
      }),
      target,
    };
  }

  return {
    async start(): Promise<void> {
      const connections = store.listChannelConnections();
      for (const conn of connections) {
        if (conn.platform !== "telegram") {
          continue;
        }
        const env = loadAgentEnv(paths.agentHome(conn.agentSlug));
        const token = env.vars[conn.envKey]?.trim();
        if (!token) {
          options.onError?.(
            new AnvaError(
              "channel_token_missing",
              `Skipping Telegram connection ${conn.id} (${conn.agentSlug}): missing ${conn.envKey}.`,
              400,
            ),
          );
          continue;
        }
        const channel = createTelegramAdapter(conn, token);
        active.set(conn.id, { connection: conn, channel });
        await channel.start();
      }
    },

    async stop(): Promise<void> {
      pendingPairings.clear();
      const entries = [...active.values()];
      active.clear();
      await Promise.all(entries.map((entry) => entry.channel.stop()));
    },

    listConnections(agentSlug?: string): ChannelConnectionSummary[] {
      return store.listChannelConnections(agentSlug).map((conn) => ({
        ...conn,
        connected: active.has(conn.id),
      }));
    },

    async connect(input: ChannelConnectInput): Promise<ChannelConnectionSummary> {
      if (input.platform !== "telegram") {
        throw new AnvaError(
          "channel_platform_unsupported",
          `Unsupported channel platform "${input.platform}". Currently supported: telegram.`,
          400,
        );
      }
      const agent = store.getAgent(input.agentSlug);
      if (!agent) {
        throw new AnvaError("agent_not_found", `Agent "${input.agentSlug}" was not found.`, 404);
      }

      const envKey = input.envKey?.trim() || "TELEGRAM_BOT_TOKEN";
      const env = loadAgentEnv(paths.agentHome(agent.slug));
      const token = env.vars[envKey]?.trim();
      if (!token) {
        throw new AnvaError(
          "channel_token_missing",
          `Set ${envKey} first using "anva agent env set ${agent.slug} ${envKey} <token>" (or pass --token).`,
          400,
        );
      }

      const api = new TelegramApi({
        token,
        apiBaseUrl: options.apiBaseUrl,
        fetchImpl: options.fetchImpl,
      });

      let botId: string;
      let botName: string;
      let botUsername: string | undefined;
      try {
        const me = await api.getMe();
        botId = String(me.id);
        botUsername = me.username;
        botName = me.username ? `@${me.username}` : me.first_name;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new AnvaError(
          "channel_auth_failed",
          `Telegram token validation via getMe failed (${detail}).`,
          400,
        );
      }

      const existing = store.findChannelConnection("telegram", agent.slug);
      let saved: ChannelConnectionRecord;
      if (existing) {
        const prev = active.get(existing.id);
        if (prev) {
          active.delete(existing.id);
          await prev.channel.stop();
        }
        saved = store.updateChannelConnection(existing.id, { botId, botName, envKey });
      } else {
        saved = store.createChannelConnection({
          platform: "telegram",
          agentSlug: agent.slug,
          botId,
          botName,
          envKey,
        });
      }

      const channel = createTelegramAdapter(saved, token);
      await channel.api.setMyCommands(TELEGRAM_COMMANDS).catch(() => {});
      active.set(saved.id, { connection: saved, channel });
      await channel.start();

      const allowed = parseAllowedUserIds(
        loadAgentEnv(paths.agentHome(agent.slug)).vars.TELEGRAM_ALLOWED_USER_IDS,
      );
      if (allowed.size === 0) {
        const code = randomBytes(12).toString("base64url");
        pendingPairings.set(saved.id, { code, expiresAt: Date.now() + PAIRING_TTL_MS });
        const pairingUrl = botUsername
          ? `https://t.me/${botUsername}?start=${code}`
          : `/start ${code}`;
        return { ...saved, connected: true, pairingUrl };
      }

      pendingPairings.delete(saved.id);
      return { ...saved, connected: true };
    },

    async disconnect(connectionId: string): Promise<void> {
      pendingPairings.delete(connectionId);
      const existing = active.get(connectionId);
      if (existing) {
        active.delete(connectionId);
        await existing.channel.stop();
      }
      const deleted = store.deleteChannelConnection(connectionId);
      if (!deleted) {
        throw new AnvaError(
          "channel_not_found",
          `Channel connection "${connectionId}" was not found.`,
          404,
        );
      }
    },

    async send(input: ChannelSendInput): Promise<ChannelSendResult> {
      const text = input.text?.trim() ?? "";
      const filePath = input.filePath?.trim();
      if (!text && !filePath) {
        throw new AnvaError("invalid_request", "Provide non-empty text or --file <path>.", 400);
      }
      if (filePath && !existsSync(filePath)) {
        throw new AnvaError("file_not_found", `File "${filePath}" does not exist.`, 400);
      }

      const { conn, api, target } = resolveSendTarget(input);
      const messageIds = filePath
        ? await sendTelegramFile(api, target, filePath, text || undefined)
        : await sendTelegramText(api, target, text);

      return {
        connectionId: conn.id,
        externalChatId: target.externalChatId,
        externalThreadId: target.externalThreadId,
        messageIds,
      };
    },

    async renameThreadTopic(threadId: string, title: string): Promise<void> {
      const route = store.getChannelRouteByThread(threadId);
      if (!route || !route.externalThreadId) {
        return;
      }
      const entry = active.get(route.connectionId);
      if (!entry) {
        return;
      }
      await entry.channel.renameTopic(
        { externalChatId: route.externalChatId, externalThreadId: route.externalThreadId },
        title,
      );
    },
  };
}
