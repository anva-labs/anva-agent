import { AnvaError, type SessionReadResult, type SessionSearchHit } from "@anva/core";
import { defineCommand } from "citty";
import {
  apiRequest,
  emitResult,
  getCliRuntime,
  requireAgentScope,
  resolveConnection,
} from "../context.ts";

const sessionSearchCommand = defineCommand({
  meta: {
    name: "search",
    description: "Search past conversations across Chinese and English text",
  },
  args: {
    agent: { type: "string", description: "Agent slug (defaults to ANVA_AGENT_SLUG)" },
    thread: { type: "string", description: "Restrict search to one thread ID" },
    limit: { type: "string", description: "Maximum hits to return" },
    "include-automation": {
      type: "boolean",
      description: "Include automation threads (use --no-include-automation to exclude)",
    },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const rt = getCliRuntime();
    const conn = resolveConnection(rt.env);
    const query = args._.join(" ").trim();
    if (!query) {
      throw new AnvaError("invalid_args", 'Usage: anva session search "<query>" [--agent <slug>]');
    }
    const agentSlug = requireAgentScope(
      args.agent,
      rt.env,
      'anva session search "query" --agent <slug>',
    );
    const params = new URLSearchParams({
      agent: agentSlug,
      q: query,
    });
    if (args.thread) {
      params.set("thread", args.thread);
    } else if (rt.env.ANVA_THREAD_ID?.trim()) {
      params.set("excludeThread", rt.env.ANVA_THREAD_ID.trim());
    }
    if (args.limit) {
      params.set("limit", args.limit);
    }
    if (args["include-automation"] === false) {
      params.set("includeAutomation", "false");
    }
    const res = await apiRequest<{ readonly hits: SessionSearchHit[] }>(
      conn,
      "GET",
      `/v1/sessions/search?${params.toString()}`,
    );
    const text =
      res.hits.length === 0
        ? "(no matches)"
        : res.hits
            .map((h) => {
              const ctx = h.context.map((c) => `  [${c.role}] ${c.content}`).join("\n");
              return `thread=${h.threadId} (${h.threadTitle || h.threadSource})\n* [${h.role}] ${h.snippet}${ctx ? `\n${ctx}` : ""}`;
            })
            .join("\n---\n");
    emitResult(args.json, res, text);
  },
});

const sessionReadCommand = defineCommand({
  meta: {
    name: "read",
    description: "Read transcript messages from a thread",
  },
  args: {
    threadId: { type: "positional", description: "Thread ID", required: true },
    agent: { type: "string", description: "Agent slug (defaults to ANVA_AGENT_SLUG)" },
    tail: { type: "string", description: "Number of recent messages to return" },
    full: { type: "boolean", description: "Disable 2000-character per-message truncation" },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const rt = getCliRuntime();
    const conn = resolveConnection(rt.env);
    const agentSlug = requireAgentScope(
      args.agent,
      rt.env,
      `anva session read ${args.threadId} --agent <slug>`,
    );
    const params = new URLSearchParams({ agent: agentSlug });
    if (args.tail) {
      params.set("tail", args.tail);
    }
    if (args.full) {
      params.set("full", "true");
    }
    const res = await apiRequest<SessionReadResult>(
      conn,
      "GET",
      `/v1/sessions/${encodeURIComponent(args.threadId)}/read?${params.toString()}`,
    );
    const text =
      res.messages.length === 0
        ? "(empty thread)"
        : res.messages.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
    emitResult(args.json, res, text);
  },
});

export const sessionCommand = defineCommand({
  meta: {
    name: "session",
    description: "Search and inspect conversation history",
  },
  subCommands: {
    search: sessionSearchCommand,
    read: sessionReadCommand,
  },
});
