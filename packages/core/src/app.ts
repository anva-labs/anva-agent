import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { createApiApp } from "./api/server.ts";
import type { ChannelBridge, ChannelBridgeFactory } from "./channels/types.ts";
import { createOarHarnessAdapter, type HarnessAdapter } from "./harness/oar-adapter.ts";
import { type AnvaPaths, resolveAnvaPaths } from "./paths.ts";
import { NO_REPLY_SENTINEL } from "./prompts.ts";
import { AutomationEngine } from "./runtime/automation-engine.ts";
import { HistoryIndex } from "./runtime/history-index.ts";
import { ThreadManager } from "./runtime/thread-manager.ts";
import { AnvaStore } from "./store/db.ts";

export interface RuntimeInfoFile {
  readonly pid: number;
  readonly url: string;
  readonly token: string;
}

export interface CreateAnvaAppOptions {
  readonly home?: string;
  readonly host?: string;
  readonly port?: number;
  readonly idleTtlMs?: number;
  readonly automationPollMs?: number;
  readonly harness?: HarnessAdapter;
  readonly channels?: ChannelBridgeFactory;
  readonly cliPath?: string;
  readonly token?: string;
}

export interface AnvaApp {
  readonly paths: AnvaPaths;
  readonly store: AnvaStore;
  readonly harness: HarnessAdapter;
  readonly history: HistoryIndex;
  readonly threads: ThreadManager;
  readonly channels: ChannelBridge | null;
  readonly automations: AutomationEngine;
  readonly url: string;
  readonly token: string;
  start(): Promise<RuntimeInfoFile>;
  stop(): Promise<void>;
}

function writeRuntimeFile(runtimePath: string, data: RuntimeInfoFile): void {
  const tmp = join(
    runtimePath.slice(0, runtimePath.lastIndexOf("/")),
    `.runtime.tmp.${process.pid}.${Date.now()}`,
  );
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, runtimePath);
}

function removeOwnRuntimeFile(runtimePath: string): void {
  if (!existsSync(runtimePath)) {
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(runtimePath, "utf8")) as Partial<RuntimeInfoFile>;
    if (parsed.pid === process.pid) {
      rmSync(runtimePath, { force: true });
    }
  } catch {
    rmSync(runtimePath, { force: true });
  }
}

export function createAnvaApp(options: CreateAnvaAppOptions = {}): AnvaApp {
  const paths = resolveAnvaPaths(options.home);
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  mkdirSync(paths.agentsDir, { recursive: true });

  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 3721;
  const token = options.token ?? randomBytes(32).toString("hex");

  const store = new AnvaStore(paths.db);
  const harness = options.harness ?? createOarHarnessAdapter();
  const history = new HistoryIndex(store);

  let currentUrl = `http://${host}:${requestedPort}`;
  let channels: ChannelBridge | null = null;

  const threads = new ThreadManager({
    store,
    harness,
    paths,
    idleTtlMs:
      options.idleTtlMs ??
      (process.env.ANVA_IDLE_TTL_MS ? Number(process.env.ANVA_IDLE_TTL_MS) : undefined),
    cliPath: options.cliPath,
    getApiConfig: () => ({ url: currentUrl, token }),
    onBackgroundReply: async ({ threadId, agentSlug, reply }) => {
      const trimmed = reply.trim();
      if (!trimmed || trimmed === NO_REPLY_SENTINEL) {
        return;
      }
      if (!channels || !store.getChannelRouteByThread(threadId)) {
        return;
      }
      await channels.send({
        agentSlug,
        target: threadId,
        text: trimmed,
      });
    },
  });

  channels = options.channels ? options.channels({ store, harness, threads, paths }) : null;

  const automations = new AutomationEngine({
    store,
    threads,
    paths,
    pollIntervalMs: options.automationPollMs,
    getApiConfig: () => ({ url: currentUrl, token }),
    getChannels: () => channels,
  });

  const hono = createApiApp({
    store,
    harness,
    paths,
    history,
    threads,
    channels,
    automations,
    token,
  });

  let server: ServerType | undefined;
  let stopped = false;

  return {
    paths,
    store,
    harness,
    history,
    threads,
    channels,
    automations,
    get url() {
      return currentUrl;
    },
    token,

    async start(): Promise<RuntimeInfoFile> {
      if (server) {
        return { pid: process.pid, url: currentUrl, token };
      }
      server = await new Promise<ServerType>((resolve, reject) => {
        const srv = serve(
          {
            fetch: hono.fetch,
            hostname: host,
            port: requestedPort,
          },
          (info: AddressInfo) => {
            currentUrl = `http://${host}:${info.port}`;
            resolve(srv);
          },
        );
        if ("requestTimeout" in srv) {
          srv.requestTimeout = 0;
        }
        srv.once("error", reject);
      });

      const runtimeInfo: RuntimeInfoFile = {
        pid: process.pid,
        url: currentUrl,
        token,
      };
      writeRuntimeFile(paths.runtime, runtimeInfo);
      threads.recoverStaleThreads();
      if (channels) {
        await channels.start();
      }
      automations.start();
      return runtimeInfo;
    },

    async stop(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      removeOwnRuntimeFile(paths.runtime);
      await automations.stop();
      if (channels) {
        await channels.stop();
      }
      await threads.shutdown();
      if (server) {
        const srv = server;
        server = undefined;
        await new Promise<void>((resolve) => {
          srv.close(() => resolve());
          if ("closeAllConnections" in srv && typeof srv.closeAllConnections === "function") {
            srv.closeAllConnections();
          }
        });
      }
      store.close();
    },
  };
}
