import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannelRouter } from "@anva/channels";
import {
  createAnvaApp,
  type HarnessAdapter,
  type HarnessOpenOptions,
  type HarnessSessionCallbacks,
  type HarnessSessionHandle,
} from "@anva/core";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { runCli } from "./main.ts";

function createMockHarness(): HarnessAdapter {
  let seq = 0;
  return {
    has: (harnessId) => harnessId === "mock",
    refusesEnv: () => false,
    catalog: () =>
      Promise.resolve([
        {
          id: "mock",
          name: "Mock",
          installed: true,
          noEnv: false,
          auth: { kind: "signed_in", account: "local" },
        },
      ]),
    probe: () =>
      Promise.resolve({
        id: "mock",
        name: "Mock",
        installed: true,
        noEnv: false,
        auth: { kind: "signed_in", account: "local" },
      }),
    models: () =>
      Promise.resolve({
        kind: "ok",
        models: [{ id: "mock-1", name: "Mock 1", isDefault: true }],
      }),
    open: (options: HarnessOpenOptions, callbacks: HarnessSessionCallbacks) => {
      seq += 1;
      const sessionId = options.resume ?? `mock-session-${seq}`;
      const handle: HarnessSessionHandle = {
        id: sessionId,
        noEnv: false,
        supportsImages: true,
        deliver: (text: string) => {
          queueMicrotask(() => {
            callbacks.onTextDelta(`reply:${text}`);
            callbacks.onTurnEnded({ kind: "completed" });
          });
          return Promise.resolve("prompted");
        },
        abort: () => Promise.resolve(),
        dispose: () => Promise.resolve(),
        contextUsage: () => null,
        activeModel: () => options.model ?? "mock-1",
        isRunning: () => false,
      };
      return Promise.resolve(handle);
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) {
      await fn();
    }
  }
});

describe("@anva/cli", () => {
  it("prints version and citty usage help", async () => {
    const ver = await runCli(["--version"]);
    expect(ver.exitCode).toBe(0);
    expect(ver.stdout).toBe("0.0.1");

    const help = await runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("anva");
    expect(help.stdout).toContain("ask");
    expect(help.stdout).toContain("agent");
    expect(help.stdout).toContain("channel");

    const agentHelp = await runCli(["agent", "--help"]);
    expect(agentHelp.exitCode).toBe(0);
    expect(agentHelp.stdout).toContain("env");
  });

  it("manages per-agent .env locally without a running daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "anva-cli-env-"));
    cleanups.push(async () => {
      rmSync(home, { recursive: true, force: true });
    });
    const env = { ...process.env, ANVA_HOME: home };

    const setRes = await runCli(
      ["agent", "env", "set", "coder", "TELEGRAM_BOT_TOKEN", "123:abc"],
      env,
    );
    expect(setRes.exitCode).toBe(0);

    const listRes = await runCli(["agent", "env", "list", "coder", "--json"], env);
    expect(listRes.exitCode).toBe(0);
    expect(JSON.parse(listRes.stdout)).toEqual({
      slug: "coder",
      names: ["TELEGRAM_BOT_TOKEN"],
    });

    const unsetRes = await runCli(["agent", "env", "unset", "coder", "TELEGRAM_BOT_TOKEN"], env);
    expect(unsetRes.exitCode).toBe(0);
  });

  it("runs agent create, multi-turn ask, thread list, and session search/read against daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "anva-cli-e2e-"));
    const app = createAnvaApp({
      home,
      port: 0,
      harness: createMockHarness(),
    });
    await app.start();
    cleanups.push(async () => {
      await app.stop();
      rmSync(home, { recursive: true, force: true });
    });

    const env = { ...process.env, ANVA_HOME: home };

    const createRes = await runCli(
      ["agent", "create", "coder", "--name", "Coder", "--harness", "mock", "--json"],
      env,
    );
    expect(createRes.exitCode).toBe(0);

    const ask1 = await runCli(["ask", "coder", "记忆中的部署方案是什么", "--json"], env);
    expect(ask1.exitCode).toBe(0);
    const parsed1 = JSON.parse(ask1.stdout) as {
      readonly threadId: string;
      readonly reply: string;
    };
    expect(parsed1.reply).toBe("reply:记忆中的部署方案是什么");

    const ask2 = await runCli(["ask", "--thread", parsed1.threadId, "补充说明", "--json"], env);
    expect(ask2.exitCode).toBe(0);
    expect((JSON.parse(ask2.stdout) as { readonly threadId: string }).threadId).toBe(
      parsed1.threadId,
    );

    const searchRes = await runCli(
      ["session", "search", "部署方案", "--agent", "coder", "--json"],
      env,
    );
    expect(searchRes.exitCode).toBe(0);
    const searchData = JSON.parse(searchRes.stdout) as {
      readonly hits: { readonly threadId: string }[];
    };
    expect(searchData.hits[0]?.threadId).toBe(parsed1.threadId);

    // Inside an agent session (ANVA_THREAD_ID set), session search automatically excludes the current thread unless --thread is passed
    const excludedSearchRes = await runCli(
      ["session", "search", "部署方案", "--agent", "coder", "--json"],
      { ...env, ANVA_THREAD_ID: parsed1.threadId },
    );
    expect(excludedSearchRes.exitCode).toBe(0);
    expect(
      (JSON.parse(excludedSearchRes.stdout) as { readonly hits: unknown[] }).hits,
    ).toHaveLength(0);

    const explicitThreadSearchRes = await runCli(
      ["session", "search", "部署方案", "--agent", "coder", "--thread", parsed1.threadId, "--json"],
      { ...env, ANVA_THREAD_ID: parsed1.threadId },
    );
    expect(explicitThreadSearchRes.exitCode).toBe(0);
    expect(
      (JSON.parse(explicitThreadSearchRes.stdout) as { readonly hits: { threadId: string }[] })
        .hits[0]?.threadId,
    ).toBe(parsed1.threadId);

    const readRes = await runCli(
      ["session", "read", parsed1.threadId, "--agent", "coder", "--json"],
      env,
    );
    expect(readRes.exitCode).toBe(0);
    const readData = JSON.parse(readRes.stdout) as {
      readonly messages: { readonly role: string; readonly content: string }[];
    };
    expect(readData.messages).toHaveLength(4);
  });

  it("connects, lists, sends text/file, and disconnects a telegram channel via CLI", async () => {
    const home = mkdtempSync(join(tmpdir(), "anva-cli-chan-"));
    const sentPayloads: Array<{ readonly method: string; readonly chatId?: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = url.split("/").pop() ?? "";
      if (method === "getUpdates") {
        await new Promise<void>((resolve) => {
          init?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }
      if (method === "getMe") {
        return Response.json({
          ok: true,
          result: { id: 88, is_bot: true, first_name: "CliBot", username: "anva_cli_bot" },
        });
      }
      if (method === "setMyCommands") {
        return Response.json({ ok: true, result: true });
      }
      if (method === "sendMessage" || method === "sendDocument") {
        let chatId = "";
        if (typeof init?.body === "string") {
          chatId = String((JSON.parse(init.body) as { chat_id?: string }).chat_id ?? "");
        } else if (init?.body instanceof FormData) {
          const val = init.body.get("chat_id");
          chatId = typeof val === "string" ? val : "";
        }
        sentPayloads.push({ method, chatId });
        return Response.json({
          ok: true,
          result: { message_id: 501, chat: { id: 999, type: "private" }, date: 1 },
        });
      }
      return Response.json({ ok: false, description: `Unexpected ${method}` }, { status: 400 });
    }) as typeof fetch;

    const app = createAnvaApp({
      home,
      port: 0,
      harness: createMockHarness(),
      channels: (ctx) => createChannelRouter(ctx, { fetchImpl, pollTimeoutSec: 1 }),
    });
    await app.start();
    cleanups.push(async () => {
      await app.stop();
      rmSync(home, { recursive: true, force: true });
    });

    const env = { ...process.env, ANVA_HOME: home };
    await runCli(["agent", "create", "coder", "--name", "Coder", "--harness", "mock"], env);

    const connectRes = await runCli(
      ["channel", "connect", "telegram", "--agent", "coder", "--token", "123:abc", "--json"],
      env,
    );
    expect(connectRes.exitCode).toBe(0);
    const connData = JSON.parse(connectRes.stdout) as {
      readonly connection: {
        readonly id: string;
        readonly botName: string;
        readonly pairingUrl?: string;
      };
    };
    expect(connData.connection.botName).toBe("@anva_cli_bot");
    expect(connData.connection.pairingUrl).toMatch(
      /^https:\/\/t\.me\/anva_cli_bot\?start=[A-Za-z0-9_-]+$/,
    );

    const listRes = await runCli(["channel", "list", "--json"], env);
    expect(listRes.exitCode).toBe(0);
    expect(listRes.stdout).toContain(connData.connection.id);

    const sendRes = await runCli(["channel", "send", "999", "hello world", "--json"], env);
    expect(sendRes.exitCode).toBe(0);

    const notePath = join(home, "note.txt");
    writeFileSync(notePath, "report content", "utf8");
    const fileRes = await runCli(
      ["channel", "send", "999:7", "attached", "--file", notePath, "--json"],
      env,
    );
    expect(fileRes.exitCode).toBe(0);

    // Implicit ANVA_THREAD_ID target when <target> is omitted
    const routedThread = app.store.createThread({
      agentSlug: "coder",
      title: "tg",
      source: "channel",
      harness: "mock",
    });
    app.store.upsertChannelRoute({
      connectionId: connData.connection.id,
      externalChatId: "999",
      externalThreadId: "7",
      threadId: routedThread.id,
    });
    const implicitRes = await runCli(
      ["channel", "send", "--file", notePath, "implicit caption", "--json"],
      { ...env, ANVA_THREAD_ID: routedThread.id },
    );
    expect(implicitRes.exitCode).toBe(0);

    const negTargetRes = await runCli(
      ["channel", "send", "-100123", "negative chat id", "--json"],
      env,
    );
    expect(negTargetRes.exitCode).toBe(0);
    expect(sentPayloads).toEqual([
      { method: "sendMessage", chatId: "999" },
      { method: "sendDocument", chatId: "999" },
      { method: "sendDocument", chatId: "999" },
      { method: "sendMessage", chatId: "-100123" },
    ]);

    const renameRes = await runCli(
      ["thread", "rename", routedThread.id, "Renamed Topic", "--json"],
      env,
    );
    expect(renameRes.exitCode).toBe(0);
    expect(
      (JSON.parse(renameRes.stdout) as { readonly thread: { readonly title: string } }).thread
        .title,
    ).toBe("Renamed Topic");

    const disconnectRes = await runCli(
      ["channel", "disconnect", connData.connection.id, "--json"],
      env,
    );
    expect(disconnectRes.exitCode).toBe(0);
  });
});
