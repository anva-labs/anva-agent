import { AnvaError, type ThreadRecord, type ThreadRuntimeStatus } from "@anva/core";
import { defineCommand } from "citty";
import { apiRequest, emitResult, getCliRuntime, resolveConnection } from "../context.ts";

const threadListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List threads ordered by recent activity",
  },
  args: {
    agent: { type: "string", description: "Filter by agent slug" },
    limit: { type: "string", description: "Maximum threads to return" },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const rt = getCliRuntime();
    const conn = resolveConnection(rt.env);
    const params = new URLSearchParams();
    const agent = args.agent?.trim() || rt.env.ANVA_AGENT_SLUG?.trim();
    if (agent) {
      params.set("agent", agent);
    }
    if (args.limit) {
      params.set("limit", args.limit);
    }
    const qs = params.toString();
    const res = await apiRequest<{
      readonly threads: (ThreadRecord & { readonly runtime: ThreadRuntimeStatus })[];
    }>(conn, "GET", `/v1/threads${qs ? `?${qs}` : ""}`);
    const lines = res.threads.map((t) => {
      const state = t.runtime.running ? "running" : t.runtime.active ? "active" : "idle";
      return `${t.id}\t${t.agentSlug}\t${t.harness}${t.model ? `:${t.model}` : ""}\t${state}\t${t.title}`;
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
    const res = await apiRequest<{ readonly stopped: boolean }>(
      conn,
      "POST",
      `/v1/threads/${encodeURIComponent(threadId)}/stop`,
    );
    emitResult(
      args.json,
      res,
      res.stopped ? `Stopped thread ${threadId}` : `Thread ${threadId} was not running`,
    );
  },
});

export const threadCommand = defineCommand({
  meta: {
    name: "thread",
    description: "Inspect, rename, or stop agent threads",
  },
  subCommands: {
    list: threadListCommand,
    rename: threadRenameCommand,
    stop: threadStopCommand,
  },
});
