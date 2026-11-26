import { resolve } from "node:path";
import { createChannelRouter } from "@anva/channels";
import { AnvaError, type AskResult, createAnvaApp, type HarnessStatus } from "@anva/core";
import { defineCommand } from "citty";
import { apiRequest, emitResult, getCliRuntime, resolveConnection } from "../context.ts";

export const startCommand = defineCommand({
  meta: {
    name: "start",
    description: "Start the Anva headless daemon",
  },
  args: {
    host: { type: "string", description: "Bind address (default 127.0.0.1)" },
    port: { type: "string", description: "Port to listen on (default 3721)" },
  },
  async run({ args }) {
    const rt = getCliRuntime();
    const host = args.host ?? rt.env.ANVA_HOST ?? "127.0.0.1";
    const portRaw = args.port ?? rt.env.ANVA_PORT ?? "3721";
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      rt.writeErr(`error: invalid_port\nnext: Port "${portRaw}" must be 0-65535.`);
      rt.setExitCode(1);
      return;
    }

    const cliEntry = process.argv[1] ? resolve(process.argv[1]) : "anva";
    const app = createAnvaApp({
      host,
      port,
      cliPath: cliEntry,
      channels: createChannelRouter,
    });
    const info = await app.start();
    rt.writeOut(`Anva daemon listening at ${info.url} (home: ${app.paths.home})`);

    const shutdown = async () => {
      await app.stop();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  },
});

export const harnessesCommand = defineCommand({
  meta: {
    name: "harnesses",
    description: "List installed harnesses, auth status, and usage limits",
  },
  args: {
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const conn = resolveConnection(getCliRuntime().env);
    const res = await apiRequest<{ readonly harnesses: HarnessStatus[] }>(
      conn,
      "GET",
      "/v1/harnesses",
    );
    const lines = res.harnesses.map((h) => {
      const state = h.installed ? `installed${h.version ? ` (${h.version})` : ""}` : "missing";
      const auth =
        h.auth.kind === "signed_in"
          ? `signed_in${h.auth.account ? ` (${h.auth.account})` : ""}`
          : h.auth.kind;
      const usage = h.usage?.windows
        .map((w) => `${w.label}: ${Math.round(w.usedRatio * 100)}%`)
        .join(", ");
      return `${h.id}\t${state}\tauth=${auth}${h.noEnv ? "\tnoEnv" : ""}${usage ? `\tusage=[${usage}]` : ""}`;
    });
    emitResult(args.json, res, lines.length > 0 ? lines.join("\n") : "(no harnesses)");
  },
});

export const askCommand = defineCommand({
  meta: {
    name: "ask",
    description: "Send a prompt to an agent or continue an existing thread",
  },
  args: {
    agent: { type: "string", description: "Agent slug (or pass as first positional)" },
    thread: { type: "string", description: "Existing thread ID to continue" },
    parent: {
      type: "string",
      description: "Parent thread ID (defaults to ANVA_THREAD_ID inside a session)",
    },
    harness: { type: "string", description: "Override harness when starting a new thread" },
    model: { type: "string", description: "Override or switch model on current harness" },
    async: { type: "boolean", description: "Return immediately after queueing the prompt" },
    notify: {
      type: "boolean",
      description:
        "Notify parent thread on completion with --async (default true in a session; pass --no-notify to disable)",
    },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const rt = getCliRuntime();
    const conn = resolveConnection(rt.env);
    const positionals = args._;
    let agentSlug = args.agent?.trim();
    let prompt: string | undefined;

    if (args.thread) {
      prompt = positionals.join(" ").trim();
    } else if (positionals.length >= 2) {
      agentSlug = positionals[0];
      prompt = positionals.slice(1).join(" ").trim();
    } else if (positionals.length === 1) {
      agentSlug = agentSlug || rt.env.ANVA_AGENT_SLUG?.trim();
      prompt = positionals[0]?.trim();
    }

    if (!prompt) {
      throw new AnvaError(
        "invalid_args",
        'Usage: anva ask [<agent>] "<prompt>" [--thread <id>] [--harness <h>] [--model <m>] [--async] [--no-notify]',
      );
    }
    if (!args.thread && !agentSlug) {
      throw new AnvaError(
        "agent_required",
        'Specify an agent slug or --thread <id>: anva ask <agent> "<prompt>"',
      );
    }

    const explicitParent = args.parent?.trim();
    const envParent = rt.env.ANVA_THREAD_ID?.trim();
    const parentThreadId =
      explicitParent ||
      (args.thread
        ? envParent && envParent !== args.thread
          ? envParent
          : undefined
        : envParent) ||
      undefined;

    if (args.notify === true && !args.async) {
      throw new AnvaError("invalid_args", "--notify can only be used together with --async.");
    }
    if (args.notify === true && !parentThreadId) {
      throw new AnvaError(
        "invalid_args",
        "--notify requires an active session (ANVA_THREAD_ID) or --parent <thread_id>.",
      );
    }

    const notifyParent = Boolean(args.async && parentThreadId && args.notify !== false);

    const res = await apiRequest<AskResult>(conn, "POST", "/v1/ask", {
      ...(agentSlug ? { agent: agentSlug } : {}),
      ...(args.thread ? { threadId: args.thread } : {}),
      ...(parentThreadId ? { parentThreadId } : {}),
      ...(args.async ? { notifyParent } : {}),
      prompt,
      ...(args.harness ? { harness: args.harness } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.async ? { async: true } : {}),
    });

    if (res.async) {
      emitResult(
        args.json,
        res,
        `Started thread ${res.threadId} (turn #${res.turnSeq}${notifyParent ? ", will notify parent" : ""})`,
      );
      return;
    }
    emitResult(args.json, res, `[thread=${res.threadId}]\n${res.reply}`);
  },
});

const dbRebuildFtsCommand = defineCommand({
  meta: {
    name: "rebuild-fts",
    description: "Rebuild the SQLite FTS5 search index",
  },
  args: {
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const conn = resolveConnection(getCliRuntime().env);
    const res = await apiRequest<{ readonly ok: boolean }>(conn, "POST", "/v1/db/rebuild-fts");
    emitResult(args.json, res, "Rebuilt FTS5 search index.");
  },
});

export const dbCommand = defineCommand({
  meta: {
    name: "db",
    description: "Database maintenance commands",
  },
  subCommands: {
    "rebuild-fts": dbRebuildFtsCommand,
  },
});
