import { randomUUID } from "node:crypto";
import { AnvaError } from "../errors.ts";
import type {
  HarnessAdapter,
  HarnessContextUsage,
  HarnessDeliverLanded,
  HarnessInputImage,
  HarnessSessionHandle,
  HarnessTurnEnd,
} from "../harness/oar-adapter.ts";
import { readMemory, readPersona } from "../home/agent-home.ts";
import { loadAgentEnv } from "../home/env.ts";
import type { AnvaPaths } from "../paths.ts";
import { buildSystemPromptSnapshot, wrapInlineSystemContext } from "../prompts.ts";
import type { AnvaStore, ThreadRecord, ThreadSource } from "../store/db.ts";

interface TurnWaiter {
  resolve(result: AskResult): void;
  reject(error: Error): void;
  onToolCall?: (toolName: string) => void;
  onTextSegment?: (text: string, endOffset: number) => void;
  steered: boolean;
}

interface ActiveThread {
  readonly threadId: string;
  readonly agentSlug: string;
  readonly handle: HarnessSessionHandle;
  readonly currentWaiters: TurnWaiter[];
  readonly queuedWaiters: TurnWaiter[];
  pendingSystemPrompt: string | null;
  turnInFlight: boolean;
  turnText: string;
  textSegmentStart: number;
  lastActivityAt: number;
  deliverChain: Promise<void>;
}

export interface AskInput {
  readonly agentSlug?: string;
  readonly threadId?: string;
  readonly prompt: string;
  readonly deliveryPrompt?: string;
  readonly harness?: string;
  readonly model?: string | null;
  readonly async?: boolean;
  readonly source?: ThreadSource;
  readonly images?: readonly HarnessInputImage[];
  readonly onToolCall?: (toolName: string) => void;
  readonly onTextSegment?: (text: string, endOffset: number) => void;
}

export type AskResult =
  | {
      readonly async: true;
      readonly threadId: string;
      readonly accepted: true;
    }
  | {
      readonly async: false;
      readonly threadId: string;
      readonly messageId: string;
      readonly reply: string;
      readonly steered?: boolean;
    };

export interface ThreadRuntimeStatus {
  readonly active: boolean;
  readonly running: boolean;
  readonly activeModel: string | null;
  readonly contextUsage: HarnessContextUsage | null;
}

const DEFAULT_IDLE_TTL_MS = 15 * 60_000;
const EVICT_INTERVAL_MS = 60_000;

export class ThreadManager {
  private readonly store: AnvaStore;
  private readonly harness: HarnessAdapter;
  private readonly paths: AnvaPaths;
  private readonly idleTtlMs: number;
  private readonly cliPath: string;
  private readonly getApiConfig: () => { readonly url: string; readonly token: string };
  private readonly active = new Map<string, ActiveThread>();
  private readonly opening = new Map<string, Promise<ActiveThread>>();
  private readonly evictTimer: ReturnType<typeof setInterval>;

  constructor(options: {
    readonly store: AnvaStore;
    readonly harness: HarnessAdapter;
    readonly paths: AnvaPaths;
    readonly idleTtlMs?: number;
    readonly cliPath?: string;
    readonly getApiConfig: () => { readonly url: string; readonly token: string };
  }) {
    this.store = options.store;
    this.harness = options.harness;
    this.paths = options.paths;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.cliPath = options.cliPath ?? "anva";
    this.getApiConfig = options.getApiConfig;

    this.evictTimer = setInterval(() => {
      void this.evictIdleSessions();
    }, EVICT_INTERVAL_MS);
    this.evictTimer.unref();
  }

  async ask(input: AskInput): Promise<AskResult> {
    const hasImages = (input.images?.length ?? 0) > 0;
    if (!input.prompt.trim() && !hasImages) {
      throw new AnvaError("prompt_required", "Provide a non-empty prompt.", 400);
    }

    let thread: ThreadRecord;
    if (input.threadId) {
      const existing = this.store.getThread(input.threadId);
      if (!existing) {
        throw new AnvaError("thread_not_found", `Thread "${input.threadId}" was not found.`, 404);
      }
      if (input.harness && input.harness !== existing.harness) {
        throw new AnvaError(
          "harness_immutable",
          `Thread "${existing.id}" is pinned to harness "${existing.harness}". Create a new thread to use "${input.harness}".`,
          400,
        );
      }
      if (input.model !== undefined && input.model !== existing.model) {
        thread = await this.switchModel(existing.id, input.model);
      } else {
        thread = existing;
      }
    } else {
      if (!input.agentSlug) {
        throw new AnvaError(
          "agent_required",
          "Specify an agent slug or an existing --thread <id>.",
          400,
        );
      }
      const agent = this.store.getAgent(input.agentSlug);
      if (!agent) {
        throw new AnvaError("agent_not_found", `Agent "${input.agentSlug}" was not found.`, 404);
      }
      const selectedHarness = input.harness ?? agent.defaultHarness;
      if (!this.harness.has(selectedHarness)) {
        throw new AnvaError(
          "harness_unknown",
          `Unknown harness "${selectedHarness}". Run "anva harnesses" to inspect installed harnesses.`,
          400,
        );
      }
      const selectedModel = input.model !== undefined ? input.model : agent.defaultModel;
      thread = this.store.createThread({
        agentSlug: agent.slug,
        title: input.prompt.trim().slice(0, 80),
        source: input.source ?? "cli",
        harness: selectedHarness,
        model: selectedModel,
      });
    }

    const session = await this.ensureSession(thread);
    this.store.insertMessage({
      agentSlug: thread.agentSlug,
      threadId: thread.id,
      role: "user",
      content: input.prompt,
    });
    const now = Date.now();
    session.lastActivityAt = now;
    this.store.touchThread(thread.id, now);

    const inputId = randomUUID();
    const wirePrompt = input.deliveryPrompt ?? input.prompt;
    if (input.async) {
      await this.deliverSerialized(session, wirePrompt, inputId, null, input.images);
      return {
        async: true,
        threadId: thread.id,
        accepted: true,
      };
    }

    return new Promise<AskResult>((resolve, reject) => {
      const waiter: TurnWaiter = {
        resolve,
        reject,
        onToolCall: input.onToolCall,
        onTextSegment: input.onTextSegment,
        steered: false,
      };
      void this.deliverSerialized(session, wirePrompt, inputId, waiter, input.images).catch(reject);
    });
  }

  async validateModel(harnessId: string, agentSlug: string, model: string): Promise<void> {
    const agentHome = this.paths.agentHome(agentSlug);
    const modelList = await this.harness.models(harnessId, agentHome);
    if (modelList.kind === "unauthenticated") {
      throw new AnvaError(
        "harness_unauthenticated",
        modelList.detail ?? `Harness "${harnessId}" is not signed in.`,
        401,
      );
    }
    if (modelList.kind === "ok") {
      const match = modelList.models.find((m) => m.id === model);
      if (!match) {
        throw new AnvaError(
          "model_not_supported",
          `Model "${model}" is not supported by harness "${harnessId}".`,
          400,
        );
      }
      if (match.disabledReason) {
        throw new AnvaError("model_disabled", match.disabledReason, 400);
      }
    }
  }

  async switchModel(threadId: string, model: string | null): Promise<ThreadRecord> {
    const thread = this.store.getThread(threadId);
    if (!thread) {
      throw new AnvaError("thread_not_found", `Thread "${threadId}" was not found.`, 404);
    }
    if (model !== null) {
      await this.validateModel(thread.harness, thread.agentSlug, model);
    }

    const existing = this.active.get(threadId);
    if (existing) {
      if (existing.turnInFlight) {
        throw new AnvaError(
          "thread_busy",
          `Thread "${threadId}" has an active turn; stop it before switching models.`,
          409,
        );
      }
      this.active.delete(threadId);
      await existing.handle.dispose();
    }

    return this.store.updateThreadModel(threadId, model);
  }

  async stopThread(threadId: string): Promise<{ readonly stopped: boolean }> {
    const thread = this.store.getThread(threadId);
    if (!thread) {
      throw new AnvaError("thread_not_found", `Thread "${threadId}" was not found.`, 404);
    }
    const session = this.active.get(threadId);
    if (!session) {
      return { stopped: false };
    }
    await session.handle.abort();
    return { stopped: true };
  }

  getThreadRuntimeStatus(threadId: string): ThreadRuntimeStatus {
    const session = this.active.get(threadId);
    if (!session) {
      return {
        active: false,
        running: false,
        activeModel: null,
        contextUsage: null,
      };
    }
    return {
      active: true,
      running: session.turnInFlight || session.handle.isRunning(),
      activeModel: session.handle.activeModel(),
      contextUsage: session.handle.contextUsage(),
    };
  }

  async shutdown(): Promise<void> {
    clearInterval(this.evictTimer);
    const sessions = [...this.active.values()];
    this.active.clear();
    await Promise.all(
      sessions.map(async (session) => {
        this.rejectWaiters(
          session,
          new AnvaError("daemon_stopped", "Anva daemon is shutting down.", 503),
        );
        await session.handle.dispose().catch(() => {});
      }),
    );
  }

  private async ensureSession(thread: ThreadRecord): Promise<ActiveThread> {
    const existing = this.active.get(thread.id);
    if (existing) {
      return existing;
    }
    const pendingOpen = this.opening.get(thread.id);
    if (pendingOpen) {
      return pendingOpen;
    }

    const openPromise = this.openSession(thread).finally(() => {
      if (this.opening.get(thread.id) === openPromise) {
        this.opening.delete(thread.id);
      }
    });
    this.opening.set(thread.id, openPromise);
    return openPromise;
  }

  private async openSession(thread: ThreadRecord): Promise<ActiveThread> {
    const agent = this.store.getAgent(thread.agentSlug);
    if (!agent) {
      throw new AnvaError("agent_not_found", `Agent "${thread.agentSlug}" was not found.`, 404);
    }
    const agentHome = this.paths.agentHome(agent.slug);
    const agentEnv = loadAgentEnv(agentHome);
    const api = this.getApiConfig();
    const noEnv = this.harness.refusesEnv(thread.harness);

    const injectedEnv: Record<string, string> = {
      ...agentEnv.vars,
      ANVA_API: api.url,
      ANVA_TOKEN: api.token,
      ANVA_AGENT_SLUG: agent.slug,
      ANVA_THREAD_ID: thread.id,
    };

    const appendSystemPrompt = buildSystemPromptSnapshot({
      agentSlug: agent.slug,
      agentName: agent.name,
      agentHome,
      persona: readPersona(agentHome),
      memory: readMemory(agentHome),
      envNames: agentEnv.names,
      envVarsForInline: injectedEnv,
      noEnv,
      cliPath: this.cliPath,
    });

    let stateRef: ActiveThread | undefined;
    const handle = await this.harness.open(
      {
        harness: thread.harness,
        model: thread.model,
        cwd: agentHome,
        resume: thread.nativeSessionId,
        appendSystemPrompt,
        env: injectedEnv,
      },
      {
        onTextDelta: (text) => {
          if (!stateRef) return;
          stateRef.turnText += text;
          stateRef.lastActivityAt = Date.now();
        },
        onToolCallStarted: (toolName) => {
          if (!stateRef) return;
          stateRef.lastActivityAt = Date.now();
          this.flushTextSegment(stateRef);
          for (const waiter of stateRef.currentWaiters) {
            waiter.onToolCall?.(toolName);
          }
        },
        onTurnEnded: (outcome) => {
          if (!stateRef) return;
          this.handleTurnEnded(stateRef, outcome);
        },
        onExited: (reason) => {
          if (!stateRef) return;
          this.handleExited(stateRef, reason);
        },
      },
    );

    const state: ActiveThread = {
      threadId: thread.id,
      agentSlug: thread.agentSlug,
      handle,
      currentWaiters: [],
      queuedWaiters: [],
      pendingSystemPrompt:
        !thread.nativeSessionId && handle.noAppendSystemPrompt && appendSystemPrompt
          ? appendSystemPrompt
          : null,
      turnInFlight: false,
      turnText: "",
      textSegmentStart: 0,
      lastActivityAt: Date.now(),
      deliverChain: Promise.resolve(),
    };
    stateRef = state;

    if (!thread.nativeSessionId) {
      this.store.setThreadNativeSessionId(thread.id, handle.id);
    }
    this.active.set(thread.id, state);
    return state;
  }

  private flushTextSegment(session: ActiveThread): void {
    const endOffset = session.turnText.length;
    const segment = session.turnText.slice(session.textSegmentStart);
    session.textSegmentStart = endOffset;
    if (!segment.trim()) {
      return;
    }
    for (const waiter of session.currentWaiters) {
      waiter.onTextSegment?.(segment, endOffset);
    }
  }

  private deliverSerialized(
    session: ActiveThread,
    text: string,
    inputId: string,
    waiter: TurnWaiter | null,
    images?: readonly HarnessInputImage[],
  ): Promise<void> {
    const run = session.deliverChain.then(async () => {
      // Pre-arm waiter before awaiting deliver() so fast or microtask turn completions never miss it.
      const preArmed = !session.turnInFlight;
      if (preArmed) {
        session.turnInFlight = true;
        if (waiter) {
          session.currentWaiters.push(waiter);
        }
      }

      const inlineSystem = session.pendingSystemPrompt;
      const deliveredText = inlineSystem ? wrapInlineSystemContext(inlineSystem, text) : text;

      let landed: HarnessDeliverLanded;
      try {
        landed = await session.handle.deliver(deliveredText, inputId, images);
      } catch (error) {
        if (preArmed) {
          if (waiter) {
            const idx = session.currentWaiters.indexOf(waiter);
            if (idx >= 0) {
              session.currentWaiters.splice(idx, 1);
            }
          }
          if (session.currentWaiters.length === 0) {
            session.turnInFlight = false;
          }
        }
        throw error;
      }

      if (inlineSystem) {
        session.pendingSystemPrompt = null;
      }

      if (preArmed) {
        return;
      }

      if (landed === "queued" && session.turnInFlight) {
        if (waiter) {
          session.queuedWaiters.push(waiter);
        }
      } else {
        if (landed === "steered" && waiter) {
          waiter.steered = true;
        }
        session.turnInFlight = true;
        if (waiter) {
          session.currentWaiters.push(waiter);
        }
      }
    });
    session.deliverChain = run.catch(() => {});
    return run;
  }

  private handleTurnEnded(session: ActiveThread, outcome: HarnessTurnEnd): void {
    const rawReply = session.turnText;
    session.turnText = "";
    session.textSegmentStart = 0;
    const now = Date.now();
    session.lastActivityAt = now;
    this.store.touchThread(session.threadId, now);

    const waiters = session.currentWaiters.splice(0, session.currentWaiters.length);
    const reply = rawReply;

    let messageId = "";
    if (reply.length > 0) {
      const saved = this.store.insertMessage({
        agentSlug: session.agentSlug,
        threadId: session.threadId,
        role: "assistant",
        content: reply,
      });
      messageId = saved.id;
    }

    const nextQueued = session.queuedWaiters.shift();
    if (nextQueued) {
      session.currentWaiters.push(nextQueued);
      session.turnInFlight = true;
    } else {
      session.turnInFlight = false;
    }

    if (outcome.kind === "completed") {
      for (const w of waiters) {
        w.resolve({
          async: false,
          threadId: session.threadId,
          messageId,
          reply,
          ...(w.steered ? { steered: true } : {}),
        });
      }
      return;
    }

    const error =
      outcome.kind === "aborted"
        ? new AnvaError("turn_aborted", "Turn was stopped.", 499)
        : new AnvaError(
            outcome.failure ?? "turn_failed",
            outcome.reason || "Harness turn failed.",
            502,
          );
    for (const w of waiters) {
      w.reject(error);
    }
  }

  private handleExited(session: ActiveThread, reason?: string): void {
    if (this.active.get(session.threadId) === session) {
      this.active.delete(session.threadId);
    }
    session.turnInFlight = false;
    this.rejectWaiters(
      session,
      new AnvaError(
        "runtime_exited",
        reason ? `Harness process exited: ${reason}` : "Harness process exited unexpectedly.",
        502,
      ),
    );
  }

  private rejectWaiters(session: ActiveThread, error: Error): void {
    const all = [
      ...session.currentWaiters.splice(0, session.currentWaiters.length),
      ...session.queuedWaiters.splice(0, session.queuedWaiters.length),
    ];
    for (const w of all) {
      w.reject(error);
    }
  }

  private async evictIdleSessions(): Promise<void> {
    const now = Date.now();
    for (const [threadId, session] of this.active.entries()) {
      if (session.turnInFlight || session.handle.isRunning()) {
        continue;
      }
      if (now - session.lastActivityAt >= this.idleTtlMs) {
        this.active.delete(threadId);
        await session.handle.dispose().catch(() => {});
      }
    }
  }
}
