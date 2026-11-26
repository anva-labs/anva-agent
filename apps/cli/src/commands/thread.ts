import {
  AnvaError,
  type ThreadReadResult,
  type ThreadRecord,
  type ThreadRuntimeStatus,
  type ThreadSearchHit,
  type ThreadStatusDetail,
  type ThreadWaitResult,
} from "@anva/core";
import { defineCommand } from "citty";
import {
  apiRequest,
  emitResult,
  getCliRuntime,
  requireAgentScope,
  resolveConnection,
} from "../context.ts";

const threadListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List threads ordered by recent activity",
  },
  args: {
    agent: { type: "string", description: "Filter by agent slug" },
    parent: { type: "string", description: "Filter by parent thread ID" },
    children: {
      type: "boolean",
      description: "Filter to child threads of current ANVA_THREAD_ID",
    },
    limit: { type: "string", description: "Maximum threads to return" },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const rt = getCliRuntime();
    const conn = resolveConnection(rt.env);
    const params = new URLSearchParams();
    let parentId = args.parent?.trim();
    if (args.children) {
      const currentThreadId = rt.env.ANVA_THREAD_ID?.trim();
      if (!currentThreadId) {
        throw new AnvaError(
          "invalid_args",
          "--children requires ANVA_THREAD_ID (or pass --parent <thread_id>).",
        );
      }
      parentId = currentThreadId;
    }

    const agent = parentId
      ? args.agent?.trim()
      : args.agent?.trim() || rt.env.ANVA_AGENT_SLUG?.trim();
    if (agent) {
      params.set("agent", agent);
    }
    if (parentId) {
      params.set("parent", parentId);
    }
    if (args.limit) {
      params.set("limit", args.limit);
    }
    const qs = params.toString();
    const res = await apiRequest<{
      readonly threads: (ThreadRecord & { readonly runtime: ThreadRuntimeStatus })[];
    }>(conn, "GET", `/v1/threads${qs ? `?${qs}` : ""}`);
    const lines = res.threads.map((t) => {
      const state = t.runtime.running ? "running" : t.status;
      const parentTag = t.parentThreadId ? `\tparent=${t.parentThreadId}` : "";
      return `${t.id}\t${t.agentSlug}\t${t.harness}${t.model ? `:${t.model}` : ""}\t${state}${parentTag}\t${t.title}`;
    });
    emitResult(args.json, res, lines.length > 0 ? lines.join("\n") : "(no threads)");
  },
});

const threadRenameCommand = defineCommand({
  meta: {
    name: "rename",
    description: "Rename a thread (and its Telegram topic if bound)",
  },
  args: {
    thread: { type: "string", description: "Target thread ID (defaults to ANVA_THREAD_ID)" },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const rt = getCliRuntime();
    const conn = resolveConnection(rt.env);
    const positionals = args._;
    let threadId: string | undefined;
    let title: string;

    if (args.thread?.trim()) {
      threadId = args.thread.trim();
      title = positionals.join(" ").trim();
    } else if (positionals[0]?.startsWith("th_")) {
      threadId = positionals[0];
      title = positionals.slice(1).join(" ").trim();
    } else {
      threadId = rt.env.ANVA_THREAD_ID?.trim();
      title = positionals.join(" ").trim();
    }

    if (!threadId || !title) {
      throw new AnvaError(
        "invalid_args",
        'Usage: anva thread rename [<thread_id>] "<title>" [--thread <id>]',
      );
    }
    const res = await apiRequest<{ readonly thread: ThreadRecord }>(
      conn,
      "PATCH",
      `/v1/threads/${encodeURIComponent(threadId)}/title`,
      { title },
    );
    emitResult(args.json, res, `Renamed thread ${res.thread.id} to "${res.thread.title}"`);
  },
});

const threadStopCommand = defineCommand({
  meta: {
    name: "stop",
    description: "Abort the active turn on a thread",
  },
  args: {
    threadId: { type: "positional", description: "Thread ID", required: false },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const rt = getCliRuntime();
    const conn = resolveConnection(rt.env);
    const threadId = args.threadId?.trim() || rt.env.ANVA_THREAD_ID?.trim();
    if (!threadId) {
      throw new AnvaError("invalid_args", "Usage: anva thread stop <thread_id>");
    }
    const requestedByThreadId = rt.env.ANVA_THREAD_ID?.trim();
    const res = await apiRequest<{ readonly stopped: boolean }>(
      conn,
      "POST",
      `/v1/threads/${encodeURIComponent(threadId)}/stop`,
      requestedByThreadId ? { requestedByThreadId } : undefined,
    );
    emitResult(
      args.json,
      res,
      res.stopped ? `Stopped thread ${threadId}` : `Thread ${threadId} was not running`,
    );
  },
});

const threadReadCommand = defineCommand({
  meta: {
    name: "read",
    description: "Read transcript messages from a thread",
  },
  args: {
    threadId: { type: "positional", description: "Thread ID", required: true },
    agent: { type: "string", description: "Optional agent slug ownership check" },
    tail: { type: "string", description: "Number of recent messages to return" },
    full: { type: "boolean", description: "Disable 2000-character per-message truncation" },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const rt = getCliRuntime();
    const conn = resolveConnection(rt.env);
    const params = new URLSearchParams();
    if (args.agent?.trim()) {
      params.set("agent", args.agent.trim());
    }
    if (args.tail) {
      params.set("tail", args.tail);
    }
    if (args.full) {
      params.set("full", "true");
    }
    const qs = params.toString();
    const res = await apiRequest<ThreadReadResult>(
      conn,
      "GET",
      `/v1/threads/${encodeURIComponent(args.threadId)}/read${qs ? `?${qs}` : ""}`,
    );
    const text =
      res.messages.length === 0
        ? "(empty thread)"
        : res.messages.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
    emitResult(args.json, res, text);
  },
});

const threadSearchCommand = defineCommand({
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
      throw new AnvaError("invalid_args", 'Usage: anva thread search "<query>" [--agent <slug>]');
    }
    const agentSlug = requireAgentScope(
      args.agent,
      rt.env,
      'anva thread search "query" --agent <slug>',
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
    const res = await apiRequest<{ readonly hits: ThreadSearchHit[] }>(
      conn,
      "GET",
      `/v1/threads/search?${params.toString()}`,
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

const threadStatusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Inspect thread execution status, live progress, and latest reply",
  },
  args: {
    threadId: {
      type: "positional",
      description: "Thread ID (defaults to ANVA_THREAD_ID)",
      required: false,
    },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const rt = getCliRuntime();
    const conn = resolveConnection(rt.env);
    const threadId = args.threadId?.trim() || rt.env.ANVA_THREAD_ID?.trim();
    if (!threadId) {
      throw new AnvaError("invalid_args", "Usage: anva thread status <thread_id>");
    }
    const res = await apiRequest<ThreadStatusDetail>(
      conn,
      "GET",
      `/v1/threads/${encodeURIComponent(threadId)}/status`,
    );
    const { thread, runtime, lastReply, children } = res;
    const state = runtime.running ? "running" : thread.status;
    const lines = [
      `Thread: ${thread.id} (${thread.agentSlug})`,
      `Harness: ${thread.harness}${(runtime.activeModel ?? thread.model) ? ` / ${runtime.activeModel ?? thread.model}` : ""}`,
      `Status: ${state} (turn #${thread.turnSeq})`,
    ];
    if (thread.parentThreadId) {
      lines.push(`Parent: ${thread.parentThreadId}`);
    }
    if (children.total > 0) {
      lines.push(`Children: ${children.running} running / ${children.total} total`);
    }
    if (thread.lastError) {
      lines.push(`Error: ${thread.lastError}`);
    }
    if (runtime.running) {
      const elapsedSec =
        runtime.elapsedMs !== null ? `${Math.round(runtime.elapsedMs / 1000)}s` : "0s";
      lines.push(`Elapsed: ${elapsedSec}`);
      if (runtime.currentTool) {
        lines.push(`Current tool: ${runtime.currentTool}`);
      }
      if (runtime.recentTools.length > 0) {
        lines.push(`Recent tools: ${runtime.recentTools.join(" -> ")}`);
      }
      lines.push(`Live output: ${runtime.outputChars} chars`);
      if (runtime.outputPreview) {
        lines.push("", runtime.outputPreview);
      }
    } else if (lastReply) {
      lines.push("", "Latest reply:", lastReply.content);
    }
    emitResult(args.json, res, lines.join("\n"));
  },
});

const threadWaitCommand = defineCommand({
  meta: {
    name: "wait",
    description: "Wait for one or more threads to finish and retrieve their latest results",
  },
  args: {
    timeout: {
      type: "string",
      description: "Maximum seconds to wait before returning (does not stop threads)",
    },
    any: { type: "boolean", description: "Return as soon as any listed thread finishes" },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const rt = getCliRuntime();
    const conn = resolveConnection(rt.env);
    const threadIds = args._.map((s) => s.trim()).filter(Boolean);
    if (threadIds.length === 0) {
      throw new AnvaError(
        "invalid_args",
        "Usage: anva thread wait <thread_id...> [--timeout <seconds>] [--any]",
      );
    }
    let timeoutMs: number | undefined;
    if (args.timeout !== undefined) {
      const sec = Number(args.timeout);
      if (!Number.isFinite(sec) || sec < 0) {
        throw new AnvaError(
          "invalid_args",
          `Invalid --timeout "${args.timeout}"; expected a non-negative number of seconds.`,
        );
      }
      timeoutMs = Math.round(sec * 1000);
    }

    const res = await apiRequest<ThreadWaitResult>(conn, "POST", "/v1/threads/wait", {
      threadIds,
      ...(args.any ? { any: true } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });

    const lines: string[] = [];
    if (res.timedOut) {
      lines.push("Timed out waiting (threads are still running if marked status=running):");
    }
    for (const item of res.threads) {
      lines.push(
        `[${item.threadId}] agent=${item.agentSlug} harness=${item.harness} status=${item.status} turn=#${item.turnSeq}`,
      );
      if (item.lastError) {
        lines.push(`error: ${item.lastError}`);
      }
      if (item.reply !== null) {
        lines.push(item.reply);
      }
      lines.push("");
    }
    emitResult(args.json, res, lines.join("\n").trim());
  },
});

export const threadCommand = defineCommand({
  meta: {
    name: "thread",
    description: "Inspect, search, read, wait, rename, or stop agent threads",
  },
  subCommands: {
    list: threadListCommand,
    rename: threadRenameCommand,
    stop: threadStopCommand,
    read: threadReadCommand,
    search: threadSearchCommand,
    status: threadStatusCommand,
    wait: threadWaitCommand,
  },
});
