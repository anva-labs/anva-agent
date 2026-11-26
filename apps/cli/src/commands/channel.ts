import { resolve } from "node:path";
import {
  AnvaError,
  type ChannelConnectionSummary,
  type ChannelSendResult,
  resolveAnvaPaths,
  setAgentEnvVar,
  validateSlug,
} from "@anva/core";
import { defineCommand } from "citty";
import {
  apiRequest,
  emitResult,
  getCliRuntime,
  requireAgentScope,
  resolveConnection,
} from "../context.ts";

const channelListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List connected channels",
  },
  args: {
    agent: { type: "string", description: "Filter by agent slug" },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const conn = resolveConnection(getCliRuntime().env);
    const params = new URLSearchParams();
    const agent = args.agent?.trim();
    if (agent) {
      params.set("agent", agent);
    }
    const qs = params.toString();
    const res = await apiRequest<{ readonly connections: ChannelConnectionSummary[] }>(
      conn,
      "GET",
      `/v1/channels${qs ? `?${qs}` : ""}`,
    );
    const lines = res.connections.map(
      (c) =>
        `${c.id}\t${c.platform}\tagent=${c.agentSlug}\t${c.botName ?? "-"}\tenv=${c.envKey}\t${c.connected ? "connected" : "disconnected"}`,
    );
    emitResult(args.json, res, lines.length > 0 ? lines.join("\n") : "(no channel connections)");
  },
});

const channelConnectCommand = defineCommand({
  meta: {
    name: "connect",
    description: "Connect a messaging channel (currently telegram) to an agent",
  },
  args: {
    platform: { type: "positional", description: "Channel platform (telegram)", required: true },
    agent: { type: "string", description: "Agent slug (defaults to ANVA_AGENT_SLUG)" },
    "env-key": { type: "string", description: "Env var name holding the bot token" },
    token: {
      type: "string",
      description: "Write bot token into local agent .env before connecting",
    },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const rt = getCliRuntime();
    const conn = resolveConnection(rt.env);
    const agentSlug = requireAgentScope(
      args.agent,
      rt.env,
      `anva channel connect ${args.platform} --agent <slug>`,
    );
    validateSlug(agentSlug);
    const envKey = args["env-key"]?.trim() || "TELEGRAM_BOT_TOKEN";

    if (args.token !== undefined) {
      const paths = resolveAnvaPaths(rt.env.ANVA_HOME);
      setAgentEnvVar(paths.agentEnv(agentSlug), envKey, args.token);
    }

    const res = await apiRequest<{ readonly connection: ChannelConnectionSummary }>(
      conn,
      "POST",
      "/v1/channels/connect",
      { platform: args.platform, agent: agentSlug, envKey },
    );
    const summary = `Connected ${res.connection.platform} (${res.connection.botName ?? res.connection.id}) -> agent "${res.connection.agentSlug}"`;
    const textOut = res.connection.pairingUrl
      ? `${summary}\nOpen in Telegram to pair as owner (valid 10m):\n${res.connection.pairingUrl}`
      : summary;
    emitResult(args.json, res, textOut);
  },
});

const channelDisconnectCommand = defineCommand({
  meta: {
    name: "disconnect",
    description: "Disconnect and remove a channel connection",
  },
  args: {
    connectionId: {
      type: "positional",
      description: "Channel connection ID (ch_xxx)",
      required: true,
    },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const conn = resolveConnection(getCliRuntime().env);
    const res = await apiRequest<{ readonly ok: boolean }>(
      conn,
      "DELETE",
      `/v1/channels/${encodeURIComponent(args.connectionId)}`,
    );
    emitResult(args.json, res, `Disconnected channel ${args.connectionId}`);
  },
});

function isExplicitTarget(token: string): boolean {
  return token.startsWith("th_") || /^-?\d+(?::\d+)?$/.test(token);
}

const channelSendCommand = defineCommand({
  meta: {
    name: "send",
    description: "Proactively send a message or file to a Telegram thread/chat",
  },
  args: {
    agent: { type: "string", description: "Agent slug (when targeting raw chat ID)" },
    thread: { type: "string", description: "Target thread ID (defaults to ANVA_THREAD_ID)" },
    file: { type: "string", description: "Local file path to send as photo or document" },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const rt = getCliRuntime();
    const conn = resolveConnection(rt.env);
    const positionals = args._;
    let target: string | undefined;
    let text: string;

    if (args.thread?.trim()) {
      target = args.thread.trim();
      text = positionals.join(" ").trim();
    } else if (positionals[0] && isExplicitTarget(positionals[0])) {
      target = positionals[0];
      text = positionals.slice(1).join(" ").trim();
    } else {
      target = rt.env.ANVA_THREAD_ID?.trim();
      text = positionals.join(" ").trim();
    }

    const filePath = args.file ? resolve(args.file) : undefined;
    if (!target || (!text && !filePath)) {
      throw new AnvaError(
        "invalid_args",
        'Usage: anva channel send [<target>] ["<message>"] [--file <path>] [--thread <id>] [--agent <slug>]',
      );
    }
    const agentSlug = args.agent?.trim() || rt.env.ANVA_AGENT_SLUG?.trim();
    const res = await apiRequest<{ readonly sent: ChannelSendResult }>(
      conn,
      "POST",
      "/v1/channels/send",
      {
        ...(agentSlug ? { agent: agentSlug } : {}),
        target,
        ...(text ? { text } : {}),
        ...(filePath ? { filePath } : {}),
      },
    );
    emitResult(
      args.json,
      res,
      `Sent ${res.sent.messageIds.length} message(s) to ${res.sent.externalChatId}${res.sent.externalThreadId ? `:${res.sent.externalThreadId}` : ""}`,
    );
  },
});

export const channelCommand = defineCommand({
  meta: {
    name: "channel",
    description: "Connect Telegram bots and send proactive messages/files",
  },
  subCommands: {
    list: channelListCommand,
    connect: channelConnectCommand,
    disconnect: channelDisconnectCommand,
    send: channelSendCommand,
  },
});
