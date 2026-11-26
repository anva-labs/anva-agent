import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  AnvaStore,
  type AnvaApp,
  type AutomationRecord,
  type AutomationRunRecord,
  type ChannelBridge,
  type ChannelSendInput,
  createAnvaApp,
  type HarnessAdapter,
  type HarnessOpenOptions,
  type HarnessSessionCallbacks,
  type HarnessSessionHandle,
  resolveAnvaPaths,
} from "../index.ts";

function createTestApp(options: {
  readonly home?: string;
  readonly pollMs?: number;
  readonly sent?: ChannelSendInput[];
  readonly llmCalls?: Array<{ readonly prompt: string }>;
  readonly replyMode?: "normal" | "no_reply" | "slow";
}): { readonly app: AnvaApp; readonly home: string } {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "anva-auto-test-"));
  let seq = 0;

  const harness: HarnessAdapter = {
    has: (id) => id === "mock",
    refusesEnv: () => false,
    catalog: () => Promise.resolve([]),
    probe: () =>
      Promise.resolve({
        id: "mock",
        name: "Mock",
        installed: true,
        noEnv: false,
        auth: { kind: "signed_in" },
      }),
    models: () => Promise.resolve({ kind: "ok", models: [] }),
    open: (openOpts: HarnessOpenOptions, callbacks: HarnessSessionCallbacks) => {
      seq += 1;
      const handle: HarnessSessionHandle = {
        id: openOpts.resume ?? `sess_${seq}`,
        noEnv: false,
        supportsImages: false,
        deliver: (text: string) => {
          options.llmCalls?.push({ prompt: text });
          if (options.replyMode === "slow") {
            setTimeout(() => {
              callbacks.onTextDelta("slow-done");
              callbacks.onTurnEnded({ kind: "completed" });
            }, 120);
            return Promise.resolve("prompted");
          }
          queueMicrotask(() => {
            const reply = options.replyMode === "no_reply" ? "NO_REPLY" : `agent-saw:${text}`;
            callbacks.onTextDelta(reply);
            callbacks.onTurnEnded({ kind: "completed" });
          });
          return Promise.resolve("prompted");
        },
        abort: () => Promise.resolve(),
        dispose: () => Promise.resolve(),
        contextUsage: () => null,
        activeModel: () => "mock-1",
        isRunning: () => false,
      };
      return Promise.resolve(handle);
    },
  };

  const fakeChannelBridge: ChannelBridge = {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    listConnections: () => [],
    connect: () => Promise.reject(new Error("unused")),
    disconnect: () => Promise.resolve(),
    send: (input) => {
      options.sent?.push(input);
      return Promise.resolve({
        connectionId: "ch_1",
        externalChatId: "42",
        externalThreadId: "",
        messageIds: ["m1"],
      });
    },
  };

  const app = createAnvaApp({
    home,
    port: 0,
    automationPollMs: options.pollMs ?? 60_000,
    harness,
    channels: () => fakeChannelBridge,
  });

  return { app, home };
}

async function api<T>(app: AnvaApp, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${app.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${app.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json()) as T;
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
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

describe("Phase 3 Script-first Automation", () => {
  it("supports preflight 0-token skip, context wakeup + ANVA_LAST_RUN_AT, and channel delivery", async () => {
    const llmCalls: Array<{ readonly prompt: string }> = [];
    const sent: ChannelSendInput[] = [];
    const { app, home } = createTestApp({ llmCalls, sent });
    await app.start();
    cleanups.push(async () => {
      await app.stop();
      rmSync(home, { recursive: true, force: true });
    });

    await api(app, "POST", "/v1/agents", { slug: "ops", name: "Ops", harness: "mock" });

    // Skip when script emits {"runAgent": false} -> zero LLM invocations
    const skipAuto = await api<{ readonly automation: AutomationRecord }>(
      app,
      "POST",
      "/v1/automations",
      {
        agent: "ops",
        name: "Preflight Skip",
        triggerType: "cron",
        cronExpr: "0 9 * * *",
        scriptCommand: `node -e 'console.log(JSON.stringify({ runAgent: false }))'`,
        prompt: "Summarize alerts",
        deliverTarget: "42",
      },
    );
    const skipRes = await api<{ readonly run: AutomationRunRecord }>(
      app,
      "POST",
      `/v1/automations/${skipAuto.automation.id}/test`,
    );
    expect(skipRes.run.status).toBe("skipped");
    expect(llmCalls).toHaveLength(0);
    expect(sent).toHaveLength(0);

    // Second run passes context and receives ANVA_LAST_RUN_AT from first completed run
    await api(app, "PATCH", `/v1/automations/${skipAuto.automation.id}`, {
      scriptCommand: `node -e 'console.log(JSON.stringify({ runAgent: true, context: { last: process.env.ANVA_LAST_RUN_AT } }))'`,
    });
    const wakeRes = await api<{ readonly run: AutomationRunRecord }>(
      app,
      "POST",
      `/v1/automations/${skipAuto.automation.id}/test`,
    );
    expect(wakeRes.run.status).toBe("succeeded");
    expect(wakeRes.run.threadId).toMatch(/^th_/);
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]?.prompt).toContain("NO_REPLY");
    expect(llmCalls[0]?.prompt).toContain('"last":');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toBe("42");
  });

  it("stays silent when agent replies NO_REPLY and delivers pure-script stdout", async () => {
    const sent: ChannelSendInput[] = [];
    const { app, home } = createTestApp({ sent, replyMode: "no_reply" });
    await app.start();
    cleanups.push(async () => {
      await app.stop();
      rmSync(home, { recursive: true, force: true });
    });

    await api(app, "POST", "/v1/agents", { slug: "ops", name: "Ops", harness: "mock" });

    // Prompt-only job replying NO_REPLY does not push notification
    const silent = await api<{ readonly automation: AutomationRecord }>(
      app,
      "POST",
      "/v1/automations",
      {
        agent: "ops",
        name: "Silent Check",
        triggerType: "cron",
        cronExpr: "*/5 * * * *",
        prompt: "Anything urgent?",
        deliverTarget: "42",
      },
    );
    const silentRes = await api<{ readonly run: AutomationRunRecord }>(
      app,
      "POST",
      `/v1/automations/${silent.automation.id}/test`,
    );
    expect(silentRes.run.status).toBe("succeeded");
    expect(sent).toHaveLength(0);

    // Pure-script mode (prompt omitted) delivers non-empty stdout without LLM
    const pureScript = await api<{ readonly automation: AutomationRecord }>(
      app,
      "POST",
      "/v1/automations",
      {
        agent: "ops",
        name: "Disk Ping",
        triggerType: "cron",
        cronExpr: "*/5 * * * *",
        scriptCommand: `echo "disk ok"`,
        deliverTarget: "42",
      },
    );
    const pureRes = await api<{ readonly run: AutomationRunRecord }>(
      app,
      "POST",
      `/v1/automations/${pureScript.automation.id}/test`,
    );
    expect(pureRes.run.status).toBe("succeeded");
    expect(pureRes.run.threadId).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("disk ok");
  });

  it("enforces skip concurrency on active runs and auto-disables once triggers", async () => {
    const { app, home } = createTestApp({ replyMode: "slow", pollMs: 60_000 });
    await app.start();
    cleanups.push(async () => {
      await app.stop();
      rmSync(home, { recursive: true, force: true });
    });

    await api(app, "POST", "/v1/agents", { slug: "ops", name: "Ops", harness: "mock" });

    // Create due once automation
    const onceCreated = await api<{ readonly automation: AutomationRecord }>(
      app,
      "POST",
      "/v1/automations",
      {
        agent: "ops",
        name: "One Shot",
        triggerType: "once",
        runAt: Date.now() - 1000,
        prompt: "run once",
      },
    );
    await app.automations.tick();
    await new Promise((r) => setTimeout(r, 180));
    const afterOnce = app.store.getAutomation(onceCreated.automation.id)!;
    expect(afterOnce.enabled).toBe(false);
    expect(afterOnce.nextRunAt).toBeNull();
    expect(app.store.listAutomationRuns(afterOnce.id)[0]?.status).toBe("succeeded");

    // Overlap check: due cron automation with an in-flight run skips cleanly
    const overlap = await api<{ readonly automation: AutomationRecord }>(
      app,
      "POST",
      "/v1/automations",
      {
        agent: "ops",
        name: "Overlap Job",
        triggerType: "cron",
        cronExpr: "* * * * *",
        prompt: "slow job",
      },
    );
    app.store.updateAutomation(overlap.automation.id, { nextRunAt: Date.now() - 500 });
    await app.automations.tick();
    app.store.updateAutomation(overlap.automation.id, { nextRunAt: Date.now() - 100 });
    await app.automations.tick();
    await new Promise((r) => setTimeout(r, 180));
    const runs = app.store.listAutomationRuns(overlap.automation.id);
    expect(runs.some((r) => r.status === "skipped")).toBe(true);
    expect(runs.some((r) => r.status === "succeeded")).toBe(true);
  });

  it("kills timed-out script process groups and recovers stale runs + enforces schema guard", async () => {
    const { app, home } = createTestApp({});
    await app.start();
    cleanups.push(async () => {
      await app.stop();
      rmSync(home, { recursive: true, force: true });
    });

    await api(app, "POST", "/v1/agents", { slug: "ops", name: "Ops", harness: "mock" });
    const timed = await api<{ readonly automation: AutomationRecord }>(
      app,
      "POST",
      "/v1/automations",
      {
        agent: "ops",
        name: "Hang Script",
        triggerType: "cron",
        cronExpr: "0 9 * * *",
        scriptCommand: `sleep 10`,
        scriptTimeoutMs: 150,
      },
    );
    const timedRes = await api<{ readonly run: AutomationRunRecord }>(
      app,
      "POST",
      `/v1/automations/${timed.automation.id}/test`,
    );
    expect(timedRes.run.status).toBe("timed_out");

    // Simulate zombie running_script left over from a crash -> start() recovers it
    const stale = app.store.createAutomationRun({
      automationId: timed.automation.id,
      agentSlug: "ops",
      status: "running_script",
    });
    await app.stop();

    const restarted = createTestApp({ home });
    await restarted.app.start();
    expect(restarted.app.store.getAutomationRun(stale.id)?.status).toBe("failed");
    await restarted.app.stop();

    // Opening a DB whose schema_migrations version is higher than current code fails fast
    const dbPath = resolveAnvaPaths(home).db;
    const raw = new DatabaseSync(dbPath);
    raw.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(999, 1);
    raw.close();

    expect(() => new AnvaStore(dbPath)).toThrow(/newer/i);
  });
});
