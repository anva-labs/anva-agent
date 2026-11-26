import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeRegistry, type Runtime } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { type AnvaApp, createAnvaApp } from "./app.ts";
import { createOarHarnessAdapter } from "./harness/oar-adapter.ts";
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
