import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeRegistry, type Runtime } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { type AnvaApp, createAnvaApp } from "./app.ts";
import type { ChannelBridge, ChannelSendInput } from "./channels/types.ts";
import {
  createOarHarnessAdapter,
  type HarnessAdapter,
  type HarnessOpenOptions,
  type HarnessSessionCallbacks,
  type HarnessSessionHandle,
} from "./harness/oar-adapter.ts";
import { setAgentEnvVar } from "./home/env.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) {
      await fn();
    }
  }
});

function setupApp(
  options: {
    readonly failResumeOn?: Set<string>;
    readonly onTurn?: Parameters<typeof scriptedRuntime>[0]["turn"];
  } = {},
): { readonly app: AnvaApp; readonly home: string } {
  const home = mkdtempSync(join(tmpdir(), "anva-app-test-"));

  const baseAlpha = scriptedRuntime({
    id: "alpha",
    brand: { name: "Alpha", icon: null },
    turn:
      options.onTurn ??
      (async (turn) => {
        if (turn.input === "slow") {
          await new Promise((r) => setTimeout(r, 80));
          turn.say(`done:${turn.steered.join("+")}`);
          return;
        }
        const envVal = turn.options.env?.MY_API_KEY ?? "none";
        turn.say(`echo:${turn.input}|env=${envVal}|model=${turn.options.model ?? "default"}`);
      }),
  });

  const alpha: Runtime = {
    ...baseAlpha,
    listModels: async () => ({
      kind: "ok",
      models: [
        { id: "alpha-1", displayName: "Alpha 1", default: true },
        { id: "alpha-2", displayName: "Alpha 2" },
      ],
    }),
    session: (installation, sessionOptions, context) => {
      if (sessionOptions.resume && options.failResumeOn?.has(sessionOptions.resume)) {
        return Promise.reject(new Error(`missing session ${sessionOptions.resume}`));
      }
      return baseAlpha.session(installation, sessionOptions, context);
    },
  };

  const beta = scriptedRuntime({
    id: "beta",
    brand: { name: "Beta", icon: null },
    turn: (turn) => {
      turn.say(`beta:${turn.input}`);
    },
  });

  const registry = createRuntimeRegistry([alpha, beta]);
  const app = createAnvaApp({
    home,
    port: 0,
    harness: createOarHarnessAdapter(registry),
    idleTtlMs: 60_000,
  });

  cleanups.push(async () => {
    await app.stop();
    rmSync(home, { recursive: true, force: true });
  });

  return { app, home };
}

async function api<T>(
  app: AnvaApp,
  method: string,
  path: string,
  body?: unknown,
  token = app.token,
): Promise<{ readonly status: number; readonly data: T }> {
  const res = await fetch(`${app.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json()) as T;
  return { status: res.status, data };
}

describe("AnvaApp + Local IPC API + OAR scriptedRuntime", () => {
  it("enforces Bearer auth, injects per-agent .env, and supports multi-turn & concurrent threads", async () => {
    const { app } = setupApp();
    await app.start();

    const unauth = await fetch(`${app.url}/v1/agents`);
    expect(unauth.status).toBe(401);

    const created = await api<{ readonly agent: { readonly slug: string } }>(
      app,
      "POST",
      "/v1/agents",
      { slug: "coder", name: "Coder", harness: "alpha" },
    );
    expect(created.status).toBe(201);

    setAgentEnvVar(app.paths.agentEnv("coder"), "MY_API_KEY", "secret-xyz-999");

    // Turn 1: creates new thread & receives .env variable
    const turn1 = await api<{ readonly threadId: string; readonly reply: string }>(
      app,
      "POST",
      "/v1/ask",
      { agent: "coder", prompt: "hello" },
    );
    expect(turn1.status).toBe(200);
    expect(turn1.data.reply).toBe("echo:hello|env=secret-xyz-999|model=default");

    // Turn 2: multi-turn on same thread
    const turn2 = await api<{ readonly threadId: string; readonly reply: string }>(
      app,
      "POST",
      "/v1/ask",
      { threadId: turn1.data.threadId, prompt: "follow-up" },
    );
    expect(turn2.status).toBe(200);
    expect(turn2.data.threadId).toBe(turn1.data.threadId);
    expect(turn2.data.reply).toContain("echo:follow-up");

    // Concurrent second thread on the same agent
    const [rA, rB] = await Promise.all([
      api<{ readonly threadId: string; readonly reply: string }>(app, "POST", "/v1/ask", {
        agent: "coder",
        prompt: "parallel-1",
      }),
      api<{ readonly threadId: string; readonly reply: string }>(app, "POST", "/v1/ask", {
        agent: "coder",
        prompt: "parallel-2",
      }),
    ]);
    expect(rA.data.threadId).not.toBe(rB.data.threadId);
    expect(rA.data.reply).toContain("parallel-1");
    expect(rB.data.reply).toContain("parallel-2");
  });

  it("steers into an active turn", async () => {
    const { app } = setupApp();
    await app.start();
    await api(app, "POST", "/v1/agents", { slug: "coder", name: "Coder", harness: "alpha" });

    const firstPromise = api<{ readonly threadId: string; readonly reply: string }>(
      app,
      "POST",
      "/v1/ask",
      { agent: "coder", prompt: "slow" },
    );

    // Wait briefly until thread is persisted and active turn is running
    let threadId = "";
    for (let i = 0; i < 40; i += 1) {
      const list = await api<{ readonly threads: { readonly id: string }[] }>(
        app,
        "GET",
        "/v1/threads?agent=coder",
      );
      const first = list.data.threads[0];
      if (first) {
        threadId = first.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(threadId).toMatch(/^th_/);

    const steeredPromise = api<{ readonly reply: string }>(app, "POST", "/v1/ask", {
      threadId,
      prompt: "extra-hint",
    });

    const [firstRes, steeredRes] = await Promise.all([firstPromise, steeredPromise]);
    expect(firstRes.data.reply).toBe("done:extra-hint");
    expect(steeredRes.data.reply).toBe("done:extra-hint");
  });

  it("enforces immutable thread harness, validates /model against current harness, and fails fast on resume error", async () => {
    const failResumeOn = new Set<string>();
    const { app } = setupApp({ failResumeOn });
    await app.start();

    await api(app, "POST", "/v1/agents", { slug: "coder", name: "Coder", harness: "alpha" });

    const tAlpha = await api<{ readonly threadId: string; readonly reply: string }>(
      app,
      "POST",
      "/v1/ask",
      { agent: "coder", prompt: "initial" },
    );
    expect(tAlpha.status).toBe(200);

    // Changing agent default harness only affects new threads
    await api(app, "PATCH", "/v1/agents/coder", { harness: "beta" });
    const tBeta = await api<{ readonly threadId: string; readonly reply: string }>(
      app,
      "POST",
      "/v1/ask",
      { agent: "coder", prompt: "new-default" },
    );
    expect(tBeta.data.reply).toBe("beta:new-default");

    // Existing thread stays pinned to alpha and rejects cross-harness ask
    const crossHarness = await api<{ readonly error: string }>(app, "POST", "/v1/ask", {
      threadId: tAlpha.data.threadId,
      harness: "beta",
      prompt: "switch",
    });
    expect(crossHarness.status).toBe(400);
    expect(crossHarness.data.error).toBe("harness_immutable");

    // Switching model within current harness validates against listModels
    const badModel = await api<{ readonly error: string }>(
      app,
      "PATCH",
      `/v1/threads/${tAlpha.data.threadId}/model`,
      { model: "nonexistent-model" },
    );
    expect(badModel.status).toBe(400);
    expect(badModel.data.error).toBe("model_not_supported");

    const goodModel = await api<{ readonly thread: { readonly model: string } }>(
      app,
      "PATCH",
      `/v1/threads/${tAlpha.data.threadId}/model`,
      { model: "alpha-2" },
    );
    expect(goodModel.status).toBe(200);
    expect(goodModel.data.thread.model).toBe("alpha-2");

    // Resumes with new model on the same native_session_id
    const resumed = await api<{ readonly reply: string }>(app, "POST", "/v1/ask", {
      threadId: tAlpha.data.threadId,
      prompt: "after-model-switch",
    });
    expect(resumed.status).toBe(200);
    expect(resumed.data.reply).toContain("model=alpha-2");

    // Simulate lost native session + idle eviction -> resume MUST fail fast, never silently create a new session
    const storedThread = app.store.getThread(tAlpha.data.threadId)!;
    expect(storedThread.nativeSessionId).toBeTruthy();
    failResumeOn.add(storedThread.nativeSessionId!);
    await app.threads.switchModel(tAlpha.data.threadId, "alpha-1"); // disposes active handle cleanly

    const failedResume = await api<{ readonly error: string }>(app, "POST", "/v1/ask", {
      threadId: tAlpha.data.threadId,
      prompt: "should-fail",
    });
    expect(failedResume.status).toBe(409);
    expect(failedResume.data.error).toBe("session_resume_failed");
  });

  it("delivers persona, memory, and manual inline on Turn 1 when harness refuses appendSystemPrompt", async () => {
    const home = mkdtempSync(join(tmpdir(), "anva-noprompt-test-"));
    const seenInputs: string[] = [];
    const baseNoPrompt = scriptedRuntime({
      id: "noprompt",
      brand: { name: "NoPrompt", icon: null },
      turn: (turn) => {
        seenInputs.push(turn.input);
        turn.say(`ack:${seenInputs.length}`);
      },
    });
    const noPromptRuntime: Runtime = {
      ...baseNoPrompt,
      refusedSessionOptions: { appendSystemPrompt: "unsupported" },
    };
    const app = createAnvaApp({
      home,
      port: 0,
      harness: createOarHarnessAdapter(createRuntimeRegistry([noPromptRuntime])),
    });

    cleanups.push(async () => {
      await app.stop();
      rmSync(home, { recursive: true, force: true });
    });

    await app.start();
    await api(app, "POST", "/v1/agents", {
      slug: "coder",
      name: "Coder",
      harness: "noprompt",
      persona: "You are a strict Rust reviewer.",
    });

    const t1 = await api<{ readonly threadId: string; readonly reply: string }>(
      app,
      "POST",
      "/v1/ask",
      { agent: "coder", prompt: "first question" },
    );
    expect(t1.status).toBe(200);
    expect(t1.data.reply).toBe("ack:1");

    const t2 = await api<{ readonly threadId: string; readonly reply: string }>(
      app,
      "POST",
      "/v1/ask",
      { threadId: t1.data.threadId, prompt: "second question" },
    );
    expect(t2.status).toBe(200);
    expect(t2.data.reply).toBe("ack:2");

    expect(seenInputs).toHaveLength(2);
    expect(seenInputs[0]).toContain("<system_context>");
    expect(seenInputs[0]).toContain("You are a strict Rust reviewer.");
    expect(seenInputs[0]).toContain("<memory_snapshot>");
    expect(seenInputs[0]).toContain("<anva_runtime>");
    expect(seenInputs[0]).toContain("service restart --delay <seconds>");
    expect(seenInputs[0]).toContain("</system_context>\n\nfirst question");

    expect(seenInputs[1]).toBe("second question");

    const stored = app.store.listMessages(t1.data.threadId, 10);
    expect(stored.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "first question",
      "second question",
    ]);
  });
});

interface ControlledTurn {
  readonly prompt: string;
  readonly callbacks: HarnessSessionCallbacks;
  emitDelta(text: string): void;
  emitTool(name: string): void;
  complete(reply?: string): void;
  fail(reason: string): void;
  exit(reason?: string): void;
}

function createControlledHarness() {
  let seq = 0;
  const turns: ControlledTurn[] = [];
  const deliveredPrompts: Array<{ readonly sessionId: string; readonly text: string }> = [];

  const harness: HarnessAdapter = {
    has: (id) => id === "ctrl" || id === "alt",
    refusesEnv: () => false,
    catalog: () => Promise.resolve([]),
    probe: (id) =>
      Promise.resolve({
        id,
        name: id,
        installed: true,
        noEnv: false,
        auth: { kind: "signed_in" },
      }),
    models: () => Promise.resolve({ kind: "ok", models: [] }),
    open: (options: HarnessOpenOptions, callbacks: HarnessSessionCallbacks) => {
      seq += 1;
      const sessionId = options.resume ?? `ctrl-sess-${seq}`;
      let running = false;
      const handle: HarnessSessionHandle = {
        id: sessionId,
        noEnv: false,
        supportsImages: true,
        deliver: (text: string) => {
          deliveredPrompts.push({ sessionId, text });
          if (running) {
            return Promise.resolve("steered");
          }
          running = true;
          const ctrl: ControlledTurn = {
            prompt: text,
            callbacks,
            emitDelta: (chunk) => callbacks.onTextDelta(chunk),
            emitTool: (name) => callbacks.onToolCallStarted?.(name),
            complete: (reply) => {
              running = false;
              if (reply) {
                callbacks.onTextDelta(reply);
              }
              callbacks.onTurnEnded({ kind: "completed" });
            },
            fail: (reason) => {
              running = false;
              callbacks.onTurnEnded({ kind: "failed", failure: "unknown", reason });
            },
            exit: (reason) => {
              running = false;
              callbacks.onExited(reason);
            },
          };
          turns.push(ctrl);
          return Promise.resolve("prompted");
        },
        abort: () => {
          running = false;
          callbacks.onTurnEnded({ kind: "aborted" });
          return Promise.resolve();
        },
        dispose: () => Promise.resolve(),
        contextUsage: () => null,
        activeModel: () => options.model ?? null,
        isRunning: () => running,
      };
      return Promise.resolve(handle);
    },
  };

  return { harness, turns, deliveredPrompts };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("Thread status, wait, and parent-child delegation", () => {
  it("persists turn status, exposes live progress in status endpoint, and removes /v1/sessions/*", async () => {
    const home = mkdtempSync(join(tmpdir(), "anva-thread-status-"));
    const { harness, turns } = createControlledHarness();
    const app = createAnvaApp({ home, port: 0, harness });
    cleanups.push(async () => {
      await app.stop();
      rmSync(home, { recursive: true, force: true });
    });

    await app.start();
    await api(app, "POST", "/v1/agents", { slug: "main", name: "Main", harness: "ctrl" });

    // Removed session endpoints return 404
    const oldSessionSearch = await fetch(`${app.url}/v1/sessions/search?agent=main&q=hi`, {
      headers: { authorization: `Bearer ${app.token}` },
    });
    expect(oldSessionSearch.status).toBe(404);

    // Start async turn and inspect live progress
    const started = await api<{
      readonly async: true;
      readonly threadId: string;
      readonly turnSeq: number;
    }>(app, "POST", "/v1/ask", { agent: "main", prompt: "long job", async: true });
    expect(started.status).toBe(200);
    expect(started.data.turnSeq).toBe(1);

    await waitUntil(() => turns.length === 1);
    turns[0]!.emitTool("bash");
    turns[0]!.emitDelta("working on step 1");

    const liveStatus = await api<{
      readonly thread: { readonly status: string; readonly turnSeq: number };
      readonly runtime: {
        readonly running: boolean;
        readonly currentTool: string | null;
        readonly recentTools: readonly string[];
        readonly outputChars: number;
        readonly outputPreview: string | null;
      };
    }>(app, "GET", `/v1/threads/${started.data.threadId}/status`);
    expect(liveStatus.status).toBe(200);
    expect(liveStatus.data.thread.status).toBe("running");
    expect(liveStatus.data.runtime.running).toBe(true);
    expect(liveStatus.data.runtime.recentTools).toEqual(["bash"]);
    expect(liveStatus.data.runtime.outputPreview).toBe("working on step 1");

    // Complete -> persisted status=completed
    turns[0]!.complete(" finished");
    await waitUntil(() => app.store.getThread(started.data.threadId)?.status === "completed");

    // Fail-fast checks on ask
    const badNotifySync = await api<{ readonly error: string }>(app, "POST", "/v1/ask", {
      agent: "main",
      prompt: "hi",
      notifyParent: true,
    });
    expect(badNotifySync.status).toBe(400);
    const selfParent = await api<{ readonly error: string }>(app, "POST", "/v1/ask", {
      threadId: started.data.threadId,
      parentThreadId: started.data.threadId,
      notifyParent: true,
      async: true,
      prompt: "self",
    });
    expect(selfParent.status).toBe(400);

    // Failed turn persists failed + lastError; exited turn persists interrupted
    await api(app, "POST", "/v1/ask", {
      threadId: started.data.threadId,
      prompt: "fail me",
      async: true,
    });
    await waitUntil(() => turns.length === 2);
    turns[1]!.fail("quota exceeded");
    await waitUntil(() => app.store.getThread(started.data.threadId)?.status === "failed");
    expect(app.store.getThread(started.data.threadId)?.lastError).toBe("quota exceeded");

    await api(app, "POST", "/v1/ask", {
      threadId: started.data.threadId,
      prompt: "crash me",
      async: true,
    });
    await waitUntil(() => turns.length === 3);
    turns[2]!.exit("SIGKILL");
    await waitUntil(() => app.store.getThread(started.data.threadId)?.status === "interrupted");
    expect(app.store.getThread(started.data.threadId)?.lastError).toContain("SIGKILL");

    // Stale running thread recovery on startup
    const stale = app.store.createThread({ agentSlug: "main", harness: "ctrl", title: "stale" });
    app.store.markThreadTurnStarted(stale.id);
    expect(app.threads.recoverStaleThreads()).toBe(1);
    expect(app.store.getThread(stale.id)?.status).toBe("interrupted");
  });

  it("coalesces concurrent child completions when parent is busy and delivers channel reply with NO_REPLY support", async () => {
    const home = mkdtempSync(join(tmpdir(), "anva-wakeup-test-"));
    const { harness, turns, deliveredPrompts } = createControlledHarness();
    const sentMessages: ChannelSendInput[] = [];
    const mockChannels = (): ChannelBridge => ({
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      listConnections: () => [],
      connect: () => Promise.reject(new Error("unused")),
      disconnect: () => Promise.resolve(),
      send: (input) => {
        sentMessages.push(input);
        return Promise.resolve({
          connectionId: "ch_1",
          externalChatId: "42",
          externalThreadId: "",
          messageIds: ["1"],
        });
      },
    });

    const app = createAnvaApp({ home, port: 0, harness, channels: mockChannels });
    cleanups.push(async () => {
      await app.stop();
      rmSync(home, { recursive: true, force: true });
    });

    await app.start();
    await api(app, "POST", "/v1/agents", { slug: "main", name: "Main", harness: "ctrl" });
    await api(app, "POST", "/v1/agents", { slug: "coder", name: "Coder", harness: "alt" });

    // Create parent thread and bind a channel route to it
    const parentAsk = await api<{ readonly threadId: string }>(app, "POST", "/v1/ask", {
      agent: "main",
      prompt: "busy parent turn",
      async: true,
    });
    const parentId = parentAsk.data.threadId;
    const conn = app.store.createChannelConnection({ platform: "telegram", agentSlug: "main" });
    app.store.upsertChannelRoute({
      connectionId: conn.id,
      externalChatId: "42",
      externalThreadId: "",
      threadId: parentId,
    });
    await waitUntil(() => turns.length === 1);

    // Spawn two async children with notifyParent while parent is busy
    const c1 = await api<{ readonly threadId: string }>(app, "POST", "/v1/ask", {
      agent: "coder",
      parentThreadId: parentId,
      notifyParent: true,
      async: true,
      prompt: "task 1",
    });
    const c2 = await api<{ readonly threadId: string }>(app, "POST", "/v1/ask", {
      agent: "coder",
      parentThreadId: parentId,
      notifyParent: true,
      async: true,
      prompt: "task 2",
    });
    await waitUntil(() => turns.length === 3);

    // Both children complete while parent turn[0] is still in flight -> must NOT steer parent
    turns[1]!.complete("result-1");
    turns[2]!.fail("boom-2");
    await waitUntil(
      () =>
        app.store.getThread(c1.data.threadId)?.status === "completed" &&
        app.store.getThread(c2.data.threadId)?.status === "failed",
    );
    expect(turns).toHaveLength(3);
    expect(deliveredPrompts).toHaveLength(3);

    // Finish parent turn[0] -> coalesces c1 + c2 into ONE wakeup turn[3]
    turns[0]!.complete("parent initial done");
    await waitUntil(() => turns.length === 4);
    expect(turns[3]!.prompt).toContain(c1.data.threadId);
    expect(turns[3]!.prompt).toContain(c2.data.threadId);
    expect(turns[3]!.prompt).toContain("result-1");
    expect(turns[3]!.prompt).toContain("boom-2");
    expect(turns[3]!.prompt).toContain("Still running child threads: none");

    // Parent replies to user -> delivered to channel
    turns[3]!.complete("Combined summary for user");
    await waitUntil(() => sentMessages.length === 1);
    expect(sentMessages[0]?.target).toBe(parentId);
    expect(sentMessages[0]?.text).toBe("Combined summary for user");

    // Cross-agent thread read works without agent slug filter
    const readChild = await api<{ readonly agentSlug: string; readonly messages: unknown[] }>(
      app,
      "GET",
      `/v1/threads/${c1.data.threadId}/read`,
    );
    expect(readChild.status).toBe(200);
    expect(readChild.data.agentSlug).toBe("coder");

    // NO_REPLY suppresses channel delivery on wakeup
    const c3 = await api<{ readonly threadId: string }>(app, "POST", "/v1/ask", {
      agent: "coder",
      parentThreadId: parentId,
      notifyParent: true,
      async: true,
      prompt: "task 3",
    });
    await waitUntil(() => turns.length === 5);
    turns[4]!.complete("quiet result");
    await waitUntil(() => turns.length === 6);
    turns[5]!.complete("NO_REPLY");
    await waitUntil(() => app.store.getThread(parentId)?.status === "completed");
    expect(sentMessages).toHaveLength(1);
    expect(c3.data.threadId).toMatch(/^th_/);
  });

  it("supports thread wait consumption, timeout without abort, and stop suppression", async () => {
    const home = mkdtempSync(join(tmpdir(), "anva-wait-test-"));
    const { harness, turns } = createControlledHarness();
    const app = createAnvaApp({ home, port: 0, harness });
    cleanups.push(async () => {
      await app.stop();
      rmSync(home, { recursive: true, force: true });
    });

    await app.start();
    await api(app, "POST", "/v1/agents", { slug: "main", name: "Main", harness: "ctrl" });

    const parent = await api<{ readonly threadId: string }>(app, "POST", "/v1/ask", {
      agent: "main",
      prompt: "init parent",
      async: true,
    });
    const parentId = parent.data.threadId;
    await waitUntil(() => turns.length === 1);
    turns[0]!.complete("ready");
    await waitUntil(() => app.store.getThread(parentId)?.status === "completed");

    // 1. Spawn two children with notifyParent=true and wait for both -> wait consumes notices so parent is NOT woken
    const c1 = await api<{ readonly threadId: string }>(app, "POST", "/v1/ask", {
      agent: "main",
      parentThreadId: parentId,
      notifyParent: true,
      async: true,
      prompt: "child 1",
    });
    const c2 = await api<{ readonly threadId: string }>(app, "POST", "/v1/ask", {
      agent: "main",
      parentThreadId: parentId,
      notifyParent: true,
      async: true,
      prompt: "child 2",
    });
    await waitUntil(() => turns.length === 3);

    const waitAllPromise = api<{
      readonly timedOut: boolean;
      readonly threads: readonly {
        readonly threadId: string;
        readonly status: string;
        readonly reply: string | null;
      }[];
    }>(app, "POST", "/v1/threads/wait", {
      threadIds: [c1.data.threadId, c2.data.threadId],
      timeoutMs: 2000,
    });

    // Let the HTTP /v1/threads/wait request reach the daemon before completing children
    await new Promise((r) => setTimeout(r, 20));
    turns[1]!.complete("out-1");
    turns[2]!.complete("out-2");

    const waitAll = await waitAllPromise;
    expect(waitAll.status).toBe(200);
    expect(waitAll.data.timedOut).toBe(false);
    expect(waitAll.data.threads.map((t) => [t.threadId, t.status, t.reply])).toEqual([
      [c1.data.threadId, "completed", "out-1"],
      [c2.data.threadId, "completed", "out-2"],
    ]);
    await new Promise((r) => setTimeout(r, 30));
    expect(turns).toHaveLength(3); // Parent was NOT woken twice

    // 2. Timeout returns timedOut: true without aborting child; wait(any: true) returns on first finished
    const c3 = await api<{ readonly threadId: string }>(app, "POST", "/v1/ask", {
      agent: "main",
      parentThreadId: parentId,
      notifyParent: false,
      async: true,
      prompt: "slow child",
    });
    await waitUntil(() => turns.length === 4);

    const timedOutWait = await api<{
      readonly timedOut: boolean;
      readonly threads: readonly { readonly status: string }[];
    }>(app, "POST", "/v1/threads/wait", {
      threadIds: [c3.data.threadId],
      timeoutMs: 25,
    });
    expect(timedOutWait.data.timedOut).toBe(true);
    expect(timedOutWait.data.threads[0]?.status).toBe("running");

    const anyWait = await api<{
      readonly timedOut: boolean;
      readonly threads: readonly { readonly threadId: string; readonly status: string }[];
    }>(app, "POST", "/v1/threads/wait", {
      threadIds: [c1.data.threadId, c3.data.threadId],
      any: true,
      timeoutMs: 1000,
    });
    expect(anyWait.data.timedOut).toBe(false);
    expect(anyWait.data.threads.map((t) => t.status)).toEqual(["completed", "running"]);

    // Finish c3 cleanly
    turns[3]!.complete("slow-done");
    await waitUntil(() => app.store.getThread(c3.data.threadId)?.status === "completed");

    // 3. Parent-initiated stop suppresses parent wakeup and persists aborted status
    const c4 = await api<{ readonly threadId: string }>(app, "POST", "/v1/ask", {
      agent: "main",
      parentThreadId: parentId,
      notifyParent: true,
      async: true,
      prompt: "to be stopped",
    });
    await waitUntil(() => turns.length === 5);

    const stopRes = await api<{ readonly stopped: boolean }>(
      app,
      "POST",
      `/v1/threads/${c4.data.threadId}/stop`,
      { requestedByThreadId: parentId },
    );
    expect(stopRes.status).toBe(200);
    expect(stopRes.data.stopped).toBe(true);
    await waitUntil(() => app.store.getThread(c4.data.threadId)?.status === "aborted");
    await new Promise((r) => setTimeout(r, 30));
    expect(turns).toHaveLength(5); // Parent was NOT woken when parent stopped the child
  });
});
