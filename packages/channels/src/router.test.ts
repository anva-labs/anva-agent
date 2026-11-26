import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnvaStore,
  type HarnessAdapter,
  type HarnessInputImage,
  type HarnessOpenOptions,
  type HarnessSessionCallbacks,
  type HarnessSessionHandle,
  loadAgentEnv,
  resolveAnvaPaths,
  setAgentEnvVar,
  ThreadManager,
} from "@anva/core";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createChannelRouter, type TelegramUpdate } from "./index.ts";

interface RecordedApiCall {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

function richMarkdown(call: RecordedApiCall): string | undefined {
  const richMessage = call.body.rich_message;
  if (
    call.method === "sendRichMessage" &&
    richMessage &&
    typeof richMessage === "object" &&
    "markdown" in richMessage &&
    typeof richMessage.markdown === "string"
  ) {
    return richMessage.markdown;
  }
  return undefined;
}

function createMockTelegramFetch(options: { readonly rejectToken?: string } = {}) {
  const calls: RecordedApiCall[] = [];
  const queue: TelegramUpdate[] = [];
  let nextMsgId = 1000;
  let notifyPoll: (() => void) | null = null;

  const pushUpdate = (update: TelegramUpdate) => {
    queue.push(update);
    const wake = notifyPoll;
    notifyPoll = null;
    wake?.();
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/file/bot")) {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }

    const match = /\/bot([^/]+)\/([A-Za-z0-9_]+)$/.exec(url);
    const token = match?.[1] ?? "";
    const method = match?.[2] ?? "";

    if (options.rejectToken && token === options.rejectToken) {
      return Response.json(
        { ok: false, error_code: 401, description: "Unauthorized" },
        { status: 401 },
      );
    }

    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } else if (init?.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) {
        body[k] = typeof v === "string" ? v : `blob:${(v as File).name}`;
      }
    }

    if (method === "getUpdates") {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notifyPoll = resolve;
          init?.signal?.addEventListener(
            "abort",
            () => {
              if (notifyPoll === resolve) {
                notifyPoll = null;
              }
              resolve();
            },
            { once: true },
          );
        });
      }
      if (init?.signal?.aborted) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }
      const batch = queue.splice(0, queue.length);
      return Response.json({ ok: true, result: batch });
    }

    calls.push({ method, body });

    if (method === "getMe") {
      return Response.json({
        ok: true,
        result: { id: 777, is_bot: true, first_name: "AnvaDemo", username: "anva_demo_bot" },
      });
    }
    if (
      method === "setMyCommands" ||
      method === "sendChatAction" ||
      method === "setMessageReaction" ||
      method === "editForumTopic"
    ) {
      return Response.json({ ok: true, result: true });
    }
    if (method === "getFile") {
      return Response.json({
        ok: true,
        result: { file_id: body.file_id, file_path: "photos/sample.jpg" },
      });
    }
    if (method === "editMessageText") {
      return Response.json({ ok: true, result: true });
    }
    if (
      method === "sendMessage" ||
      method === "sendRichMessage" ||
      method === "sendPhoto" ||
      method === "sendDocument"
    ) {
      nextMsgId += 1;
      return Response.json({
        ok: true,
        result: {
          message_id: nextMsgId,
          chat: { id: Number(body.chat_id), type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: typeof body.text === "string" ? body.text : undefined,
        },
      });
    }
    return Response.json({ ok: false, description: `Unhandled ${method}` }, { status: 400 });
  }) as typeof fetch;

  return { fetchImpl, calls, pushUpdate };
}

function createFakeHarness(busyTurn?: {
  readonly delivery: "queued" | "steered";
  readonly finish: Promise<void>;
}) {
  const delivered: Array<{
    readonly harness: string;
    readonly text: string;
    readonly model: string | null;
    readonly images?: readonly HarnessInputImage[];
  }> = [];
  let seq = 0;

  const harness: HarnessAdapter = {
    has: (id) => id === "mock" || id === "alt",
    refusesEnv: () => false,
    catalog: () =>
      Promise.resolve([
        {
          id: "mock",
          name: "Mock",
          installed: true,
          noEnv: false,
          auth: { kind: "signed_in", account: "tester" },
        },
        {
          id: "alt",
          name: "Alt",
          installed: true,
          noEnv: false,
          auth: { kind: "signed_in", account: "tester-alt" },
        },
      ]),
    probe: (harnessId) =>
      Promise.resolve({
        id: harnessId,
        name: harnessId === "alt" ? "Alt" : "Mock",
        installed: true,
        version: "1.0.0",
        noEnv: false,
        auth: { kind: "signed_in", account: "tester", plan: "Pro" },
        usage: {
          rateLimited: false,
          windows: [{ label: "5h", usedRatio: 0.25 }],
        },
      }),
    models: (harnessId) =>
      Promise.resolve({
        kind: "ok",
        models:
          harnessId === "alt"
            ? [
                { id: "alt-1", name: "Alt 1", isDefault: true },
                { id: "alt-2", name: "Alt 2" },
              ]
            : [
                { id: "mock-1", name: "Mock 1", isDefault: true },
                { id: "mock-2", name: "Mock 2" },
              ],
      }),
    open: (options: HarnessOpenOptions, callbacks: HarnessSessionCallbacks) => {
      seq += 1;
      const defaultModel = options.harness === "alt" ? "alt-1" : "mock-1";
      const model = options.model ?? defaultModel;
      let running = false;
      const steeredNotes: string[] = [];
      const queuedNotes: string[] = [];
      const handle: HarnessSessionHandle = {
        id: options.resume ?? `sess_${seq}`,
        noEnv: false,
        supportsImages: true,
        deliver: (text: string, _inputId: string, images?: readonly HarnessInputImage[]) => {
          delivered.push({ harness: options.harness, text, model, images });
          if (running) {
            if (busyTurn?.delivery === "queued") {
              queuedNotes.push(text);
              return Promise.resolve("queued");
            }
            steeredNotes.push(text);
            return Promise.resolve("steered");
          }
          running = true;
          if (text === "wait-turn") {
            return Promise.resolve("prompted");
          }
          if (text === "busy-turn" && busyTurn) {
            void busyTurn.finish.then(() => {
              running = false;
              callbacks.onTextDelta(["busy reply", ...steeredNotes].join(" + "));
              callbacks.onTurnEnded({ kind: "completed" });
              for (const note of queuedNotes) {
                callbacks.onTextDelta(`queued reply: ${note}`);
                callbacks.onTurnEnded({ kind: "completed" });
              }
            });
            return Promise.resolve("prompted");
          }
          if (text.startsWith("use-tools")) {
            setTimeout(() => {
              callbacks.onTextDelta("Checking files first.");
              callbacks.onToolCallStarted?.("read");
            }, 10);
            setTimeout(() => {
              callbacks.onTextDelta("Running command next.");
              callbacks.onToolCallStarted?.("bash");
            }, 30);
            setTimeout(() => {
              running = false;
              callbacks.onTextDelta("Tool answer with **bold** and `code`");
              callbacks.onTurnEnded({ kind: "completed" });
            }, 60);
            return Promise.resolve("prompted");
          }
          if (text === "tools-no-final") {
            setTimeout(() => {
              callbacks.onTextDelta("Intermediate progress only.");
              callbacks.onToolCallStarted?.("read");
            }, 10);
            setTimeout(() => {
              running = false;
              callbacks.onTurnEnded({ kind: "completed" });
            }, 30);
            return Promise.resolve("prompted");
          }
          queueMicrotask(() => {
            running = false;
            callbacks.onTextDelta(`echo[${model}]:${text}`);
            callbacks.onTurnEnded({ kind: "completed" });
          });
          return Promise.resolve("prompted");
        },
        abort: () => {
          running = false;
          callbacks.onTurnEnded({ kind: "aborted" });
          return Promise.resolve();
        },
        dispose: () => Promise.resolve(),
        contextUsage: () => ({ tokens: 1200, contextWindow: 100_000, percent: 1.2 }),
        activeModel: () => model,
        isRunning: () => running,
      };
      return Promise.resolve(handle);
    },
  };

  return { harness, delivered };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 15));
  }
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

describe("ChannelRouter + TelegramChannel", () => {
  it("routes DMs/topics, downloads attachments, handles 5 slash commands, and sends files", async () => {
    const home = mkdtempSync(join(tmpdir(), "anva-chan-test-"));
    const paths = resolveAnvaPaths(home);
    const store = new AnvaStore(paths.db);
    const { harness, delivered } = createFakeHarness();
    const threads = new ThreadManager({
      store,
      harness,
      paths,
      getApiConfig: () => ({ url: "http://127.0.0.1:1", token: "tok" }),
    });
    const tg = createMockTelegramFetch({ rejectToken: "bad-token" });
    const router = createChannelRouter(
      { store, harness, threads, paths },
      {
        fetchImpl: tg.fetchImpl,
        pollTimeoutSec: 1,
        typingIntervalMs: 5000,
        toolFlushThrottleMs: 0,
      },
    );

    cleanups.push(async () => {
      await router.stop();
      await threads.shutdown();
      store.close();
      rmSync(home, { recursive: true, force: true });
    });

    store.createAgent({ slug: "coder", name: "Coder", defaultHarness: "mock" });

    // Rejects bad token during connect
    setAgentEnvVar(paths.agentEnv("coder"), "TELEGRAM_BOT_TOKEN", "bad-token");
    await expect(
      router.connect({ platform: "telegram", agentSlug: "coder" }),
    ).rejects.toMatchObject({ code: "channel_auth_failed" });

    // Connects valid token with no allowlist yet -> fail-closed until paired via one-time deep link
    setAgentEnvVar(paths.agentEnv("coder"), "TELEGRAM_BOT_TOKEN", "good-token");
    const conn = await router.connect({ platform: "telegram", agentSlug: "coder" });
    expect(conn.botName).toBe("@anva_demo_bot");
    expect(conn.connected).toBe(true);
    expect(conn.pairingUrl).toMatch(/^https:\/\/t\.me\/anva_demo_bot\?start=[A-Za-z0-9_-]+$/);
    const pairingCode = conn.pairingUrl!.split("?start=")[1]!;

    // Unpaired messages (stranger, wrong code) and group messages are silently denied
    tg.pushUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: -500, type: "group" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 1000,
        text: "ignore group",
      },
    });
    tg.pushUpdate({
      update_id: 2,
      message: {
        message_id: 98,
        chat: { id: 999, type: "private" },
        from: { id: 999, is_bot: false, first_name: "Stranger" },
        date: 1000,
        text: "unauthorized attempt",
        photo: [{ file_id: "blocked_photo", width: 10, height: 10 }],
      },
    });
    tg.pushUpdate({
      update_id: 20,
      message: {
        message_id: 97,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 1000,
        text: "/start wrongcode",
      },
    });

    // Valid one-time /start <code> pairs user 42 into .env and replies
    tg.pushUpdate({
      update_id: 21,
      message: {
        message_id: 96,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 1000,
        text: `/start ${pairingCode}`,
      },
    });
    await waitFor(() =>
      tg.calls.some((c) => richMarkdown(c) === "Paired! You can start chatting now."),
    );
    expect(loadAgentEnv(paths.agentHome("coder")).vars.TELEGRAM_ALLOWED_USER_IDS).toBe("42");

    // Replaying the same single-use pairing code from user 999 is denied
    tg.pushUpdate({
      update_id: 22,
      message: {
        message_id: 99,
        chat: { id: 999, type: "private" },
        from: { id: 999, is_bot: false, first_name: "Stranger" },
        date: 1000,
        text: `/start ${pairingCode}`,
      },
    });
    tg.pushUpdate({
      update_id: 4,
      message: {
        message_id: 12,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 1002,
        caption: "look at photo",
        photo: [{ file_id: "photo_1", width: 100, height: 100 }],
      },
    });

    await waitFor(() =>
      tg.calls.some(
        (c) =>
          richMarkdown(c)?.includes("echo[mock-1]:look at photo") &&
          tg.calls.some(
            (r) =>
              r.method === "setMessageReaction" &&
              Array.isArray(r.body.reaction) &&
              r.body.reaction.length === 0,
          ),
      ),
    );
    expect(tg.calls.some((c) => c.method === "getFile" && c.body.file_id === "blocked_photo")).toBe(
      false,
    );
    expect(
      tg.calls.some(
        (c) =>
          c.method === "setMessageReaction" &&
          c.body.message_id === 12 &&
          Array.isArray(c.body.reaction) &&
          (c.body.reaction[0] as { emoji?: string } | undefined)?.emoji === "👀",
      ),
    ).toBe(true);
    expect(tg.calls.some((c) => c.method === "editMessageText")).toBe(false);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toContain("[Attachment:");
    const attPathMatch = /\[Attachment: ([^\s]+photo-12\.jpg)/.exec(delivered[0]?.text ?? "");
    expect(attPathMatch?.[1]).toBeTruthy();
    expect(attPathMatch![1]!.startsWith(paths.agentAttachments("coder"))).toBe(true);
    expect(delivered[0]?.images).toEqual([{ path: attPathMatch![1]!, mediaType: "image/jpeg" }]);
    expect(readFileSync(attPathMatch![1]!)).toEqual(Buffer.from([1, 2, 3, 4]));

    // DM Threaded Mode routes separately and sends rich replies alongside the tool trace.
    tg.pushUpdate({
      update_id: 5,
      message: {
        message_id: 13,
        message_thread_id: 88,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 1003,
        text: "use-tools",
      },
    });
    await waitFor(() =>
      tg.calls.some(
        (c) =>
          richMarkdown(c) === "Tool answer with **bold** and `code`" &&
          c.body.message_thread_id === 88,
      ),
    );
    expect(
      tg.calls.some(
        (c) =>
          (c.method === "editMessageText" || c.method === "sendMessage") &&
          typeof c.body.text === "string" &&
          c.body.text === "🔧 read → bash",
      ),
    ).toBe(true);

    const segmentIndex = (text: string) => tg.calls.findIndex((c) => richMarkdown(c) === text);
    const toolTraceIndex = tg.calls.findIndex(
      (c) =>
        (c.method === "sendMessage" || c.method === "editMessageText") &&
        typeof c.body.text === "string" &&
        c.body.text.startsWith("🔧 read"),
    );
    const preToolIndex = segmentIndex("Checking files first.");
    const midToolIndex = segmentIndex("Running command next.");
    const finalAnswerIndex = segmentIndex("Tool answer with **bold** and `code`");
    expect(preToolIndex).not.toBe(-1);
    expect(midToolIndex).not.toBe(-1);
    expect(toolTraceIndex).not.toBe(-1);
    expect(finalAnswerIndex).not.toBe(-1);
    expect(preToolIndex).toBeLessThan(toolTraceIndex);
    expect(toolTraceIndex).toBeLessThan(midToolIndex);
    expect(midToolIndex).toBeLessThan(finalAnswerIndex);
    expect(tg.calls.some((c) => c.method === "editForumTopic")).toBe(false);
    const topicRoute = store.getChannelRoute(conn.id, "42", "88");
    const rootRoute = store.getChannelRoute(conn.id, "42", "");
    expect(topicRoute?.threadId).toBeTruthy();
    expect(rootRoute?.threadId).toBeTruthy();
    expect(topicRoute?.threadId).not.toBe(rootRoute?.threadId);

    tg.pushUpdate({
      update_id: 30,
      message: {
        message_id: 60,
        message_thread_id: 89,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 1030,
        text: "tools-no-final",
      },
    });
    await waitFor(() =>
      tg.calls.some(
        (c) => c.body.message_thread_id === 89 && richMarkdown(c) === "Intermediate progress only.",
      ),
    );
    await waitFor(() =>
      tg.calls.some(
        (c) =>
          c.method === "setMessageReaction" &&
          c.body.message_id === 60 &&
          Array.isArray(c.body.reaction) &&
          c.body.reaction.length === 0,
      ),
    );
    expect(
      tg.calls.some((c) => c.body.message_thread_id === 89 && richMarkdown(c) === "(empty reply)"),
    ).toBe(false);

    // 5 slash commands consume 0 model turns
    const countBeforeSlash = delivered.length;
    tg.pushUpdate({
      update_id: 6,
      message: {
        message_id: 14,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 1004,
        text: "/usage",
      },
    });
    await waitFor(() => tg.calls.some((c) => richMarkdown(c)?.includes("5h: 25%")));

    tg.pushUpdate({
      update_id: 6,
      message: {
        message_id: 15,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 1005,
        text: "/status",
      },
    });
    await waitFor(() =>
      tg.calls.some((c) => richMarkdown(c)?.includes(`Thread: ${rootRoute!.threadId}`)),
    );

    tg.pushUpdate({
      update_id: 7,
      message: {
        message_id: 16,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 1006,
        text: "/model mock-2",
      },
    });
    await waitFor(() => tg.calls.some((c) => richMarkdown(c)?.includes("mock-2")));

    tg.pushUpdate({
      update_id: 8,
      message: {
        message_id: 17,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 1007,
        text: "/new",
      },
    });
    await waitFor(() => store.getChannelRoute(conn.id, "42", "") === null);
    expect(delivered).toHaveLength(countBeforeSlash);

    // /stop aborts active turn on the new thread created by the next message
    tg.pushUpdate({
      update_id: 9,
      message: {
        message_id: 18,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 1008,
        text: "wait-turn",
      },
    });
    await waitFor(() => {
      const r = store.getChannelRoute(conn.id, "42", "");
      return Boolean(r && threads.getThreadRuntimeStatus(r.threadId).running);
    });
    const replacedRoute = store.getChannelRoute(conn.id, "42", "")!;
    expect(replacedRoute.threadId).not.toBe(rootRoute?.threadId);
    tg.pushUpdate({
      update_id: 10,
      message: {
        message_id: 19,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 1009,
        text: "/stop",
      },
    });
    await waitFor(() => tg.calls.some((c) => richMarkdown(c)?.includes("Stopped thread")));

    // Proactive text and photo upload by thread ID.
    const report = "Report is **ready**.";
    await router.send({
      target: topicRoute!.threadId,
      text: report,
    });
    expect(
      tg.calls.some((c) => c.body.message_thread_id === 88 && richMarkdown(c) === report),
    ).toBe(true);

    const pngPath = join(home, "chart.png");
    writeFileSync(pngPath, Buffer.from([137, 80, 78, 71]));
    const sendRes = await router.send({
      target: topicRoute!.threadId,
      text: "proactive report",
      filePath: pngPath,
    });
    expect(sendRes.externalChatId).toBe("42");
    expect(sendRes.externalThreadId).toBe("88");
    expect(
      tg.calls.some(
        (c) =>
          c.method === "sendPhoto" &&
          c.body.message_thread_id === "88" &&
          c.body.caption === "proactive report",
      ),
    ).toBe(true);
  });

  it.each([
    {
      delivery: "steered",
      feedback: "⏩ Steered into the current turn.",
      replies: ["busy reply + follow-up"],
    },
    {
      delivery: "queued",
      feedback: "⏳ Queued for the next turn.",
      replies: ["busy reply", "queued reply: follow-up"],
    },
  ] as const)(
    "acknowledges a $delivery message before the active turn finishes",
    async ({ delivery, feedback, replies }) => {
      const home = mkdtempSync(join(tmpdir(), "anva-telegram-busy-test-"));
      const paths = resolveAnvaPaths(home);
      const store = new AnvaStore(paths.db);
      const finishTurn = Promise.withResolvers<void>();
      const { harness, delivered } = createFakeHarness({ delivery, finish: finishTurn.promise });
      const threads = new ThreadManager({
        store,
        harness,
        paths,
        getApiConfig: () => ({ url: "http://127.0.0.1:1", token: "tok" }),
      });
      const tg = createMockTelegramFetch();
      const router = createChannelRouter(
        { store, harness, threads, paths },
        { fetchImpl: tg.fetchImpl },
      );
      cleanups.push(async () => {
        await router.stop();
        await threads.shutdown();
        store.close();
        rmSync(home, { recursive: true, force: true });
      });

      store.createAgent({ slug: "coder", name: "Coder", defaultHarness: "mock" });
      setAgentEnvVar(paths.agentEnv("coder"), "TELEGRAM_BOT_TOKEN", "good-token");
      setAgentEnvVar(paths.agentEnv("coder"), "TELEGRAM_ALLOWED_USER_IDS", "42");
      await router.connect({ platform: "telegram", agentSlug: "coder" });

      const send = (id: number, text: string) =>
        tg.pushUpdate({
          update_id: id,
          message: {
            message_id: id,
            chat: { id: 42, type: "private" },
            from: { id: 42, is_bot: false, first_name: "Alice" },
            date: 1000 + id,
            text,
          },
        });
      const messages = () =>
        tg.calls.filter((call) => call.method === "sendRichMessage").map(richMarkdown);

      send(1, "busy-turn");
      await waitFor(() => delivered.some((entry) => entry.text === "busy-turn"));
      send(2, "follow-up");
      await waitFor(() => messages().includes(feedback));
      expect(messages()).toEqual([feedback]);

      finishTurn.resolve();
      await waitFor(() => replies.every((reply) => messages().includes(reply)));
      expect(messages()).toHaveLength(replies.length + 1);
    },
  );

  it("passes complete Markdown with tables to Telegram as rich messages", async () => {
    const home = mkdtempSync(join(tmpdir(), "anva-telegram-table-test-"));
    const paths = resolveAnvaPaths(home);
    const store = new AnvaStore(paths.db);
    const { harness } = createFakeHarness();
    const threads = new ThreadManager({
      store,
      harness,
      paths,
      getApiConfig: () => ({ url: "http://127.0.0.1:1", token: "tok" }),
    });
    const tg = createMockTelegramFetch();
    const router = createChannelRouter(
      { store, harness, threads, paths },
      { fetchImpl: tg.fetchImpl },
    );
    cleanups.push(async () => {
      await router.stop();
      await threads.shutdown();
      store.close();
      rmSync(home, { recursive: true, force: true });
    });

    store.createAgent({ slug: "coder", name: "Coder", defaultHarness: "mock" });
    setAgentEnvVar(paths.agentEnv("coder"), "TELEGRAM_BOT_TOKEN", "good-token");
    setAgentEnvVar(paths.agentEnv("coder"), "TELEGRAM_ALLOWED_USER_IDS", "42");
    await router.connect({ platform: "telegram", agentSlug: "coder" });

    const table = ["| Item | Count |", "| --- | ---: |", "| **Tea & coffee** | `2` |"].join("\n");
    const markdown = [
      "Inventory",
      "<u>In stock</u>",
      table,
      "![Shelf](https://example.com/shelf.jpg)",
    ].join("\n\n");
    tg.pushUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        message_thread_id: 88,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 1000,
        text: markdown,
      },
    });
    await waitFor(() => tg.calls.some((call) => call.method === "sendRichMessage"));
    const reply = tg.calls.find((call) => call.method === "sendRichMessage");
    expect(reply?.body).toEqual({
      chat_id: "42",
      message_thread_id: 88,
      rich_message: { markdown: `echo[mock-1]:${markdown}` },
    });

    const longTable = `${table}\n${"| Repeated item description | 88 |\n".repeat(120)}| Last item | 1 |`;
    const sent = await router.send({ target: "42:88", text: longTable });
    const richCalls = tg.calls.filter((call) => call.method === "sendRichMessage");
    expect(richCalls).toHaveLength(2);
    expect(richCalls[1]?.body).toEqual({
      chat_id: "42",
      message_thread_id: 88,
      rich_message: { markdown: longTable },
    });
    expect(sent.messageIds).toEqual(["1002"]);

    const codeBlock = `\`\`\`text\n${"Long code example text\n".repeat(200)}\`\`\``;
    await router.send({ target: "42:88", text: codeBlock });
    expect(tg.calls.filter((call) => call.method === "sendRichMessage").slice(2)).toEqual([
      {
        method: "sendRichMessage",
        body: { chat_id: "42", message_thread_id: 88, rich_message: { markdown: codeBlock } },
      },
    ]);
  });

  it("lists /model commands and supports /new <harness> and /new unbinding", async () => {
    const home = mkdtempSync(join(tmpdir(), "anva-model-cmd-test-"));
    const paths = resolveAnvaPaths(home);
    const store = new AnvaStore(paths.db);
    const { harness, delivered } = createFakeHarness();
    const threads = new ThreadManager({
      store,
      harness,
      paths,
      getApiConfig: () => ({ url: "http://127.0.0.1:1", token: "tok" }),
    });
    const tg = createMockTelegramFetch();
    const router = createChannelRouter(
      { store, harness, threads, paths },
      {
        fetchImpl: tg.fetchImpl,
        pollTimeoutSec: 1,
        typingIntervalMs: 5000,
        toolFlushThrottleMs: 0,
      },
    );

    cleanups.push(async () => {
      await router.stop();
      await threads.shutdown();
      store.close();
      rmSync(home, { recursive: true, force: true });
    });

    store.createAgent({ slug: "coder", name: "Coder", defaultHarness: "mock" });
    setAgentEnvVar(paths.agentEnv("coder"), "TELEGRAM_BOT_TOKEN", "good-token");
    setAgentEnvVar(paths.agentEnv("coder"), "TELEGRAM_ALLOWED_USER_IDS", "42");
    const conn = await router.connect({ platform: "telegram", agentSlug: "coder" });

    // 1. /model lists default harness models as inline code without creating a thread.
    tg.pushUpdate({
      update_id: 100,
      message: {
        message_id: 50,
        message_thread_id: 200,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 2000,
        text: "/model",
      },
    });
    await waitFor(() =>
      tg.calls.some(
        (c) => c.body.message_thread_id === 200 && richMarkdown(c)?.includes("`/model mock-1`"),
      ),
    );
    const firstList = tg.calls.find(
      (c) => c.body.message_thread_id === 200 && richMarkdown(c)?.includes("`/model mock-1`"),
    )!;
    expect(richMarkdown(firstList)).toContain("`/model default`");
    expect(richMarkdown(firstList)).toContain("`/model mock-2`");
    expect(firstList.body.reply_markup).toBeUndefined();
    expect(store.getChannelRoute(conn.id, "42", "200")).toBeNull();

    // 2. /new alt starts a thread pinned to alt, and /model lists alt's models.
    tg.pushUpdate({
      update_id: 101,
      message: {
        message_id: 51,
        message_thread_id: 200,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 2001,
        text: "/new alt",
      },
    });
    await waitFor(() => store.getChannelRoute(conn.id, "42", "200") !== null);
    const altRoute = store.getChannelRoute(conn.id, "42", "200")!;
    expect(store.getThread(altRoute.threadId)?.harness).toBe("alt");

    tg.pushUpdate({
      update_id: 102,
      message: {
        message_id: 52,
        message_thread_id: 200,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 2002,
        text: "/model",
      },
    });
    await waitFor(() =>
      tg.calls.some(
        (c) => c.body.message_thread_id === 200 && richMarkdown(c)?.includes("`/model alt-2`"),
      ),
    );

    // 3. /model alt-2 switches model, message runs on alt/alt-2, and /model default resets to null.
    tg.pushUpdate({
      update_id: 103,
      message: {
        message_id: 53,
        message_thread_id: 200,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 2003,
        text: "/model alt-2",
      },
    });
    await waitFor(() => store.getThread(altRoute.threadId)?.model === "alt-2");

    tg.pushUpdate({
      update_id: 104,
      message: {
        message_id: 54,
        message_thread_id: 200,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 2004,
        text: "hello alt",
      },
    });
    await waitFor(() => delivered.some((d) => d.text === "hello alt"));
    expect(delivered.at(-1)?.harness).toBe("alt");
    expect(delivered.at(-1)?.model).toBe("alt-2");

    tg.pushUpdate({
      update_id: 105,
      message: {
        message_id: 55,
        message_thread_id: 200,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 2005,
        text: "/model default",
      },
    });
    await waitFor(() => store.getThread(altRoute.threadId)?.model === null);

    // 4. /new unbinds the route; invalid /model fails without creating a thread; valid /model creates on default harness.
    tg.pushUpdate({
      update_id: 106,
      message: {
        message_id: 56,
        message_thread_id: 200,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 2006,
        text: "/new",
      },
    });
    await waitFor(() => store.getChannelRoute(conn.id, "42", "200") === null);

    tg.pushUpdate({
      update_id: 107,
      message: {
        message_id: 57,
        message_thread_id: 200,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 2007,
        text: "/model nonexistent",
      },
    });
    await waitFor(() =>
      tg.calls.some(
        (c) =>
          c.body.message_thread_id === 200 && richMarkdown(c)?.includes("Failed to switch model"),
      ),
    );
    expect(store.getChannelRoute(conn.id, "42", "200")).toBeNull();

    tg.pushUpdate({
      update_id: 108,
      message: {
        message_id: 58,
        message_thread_id: 200,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Alice" },
        date: 2008,
        text: "/model mock-2",
      },
    });
    await waitFor(() => store.getChannelRoute(conn.id, "42", "200") !== null);
    const freshRoute = store.getChannelRoute(conn.id, "42", "200")!;
    expect(freshRoute.threadId).not.toBe(altRoute.threadId);
    expect(store.getThread(freshRoute.threadId)?.harness).toBe("mock");
    expect(store.getThread(freshRoute.threadId)?.model).toBe("mock-2");
  });
});
