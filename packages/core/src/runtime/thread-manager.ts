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
import {
  buildSystemPromptSnapshot,
  type ChildCompletionNoticeSummary,
  formatChildNotificationsPrompt,
  wrapInlineSystemContext,
} from "../prompts.ts";
import type { AnvaStore, ThreadRecord, ThreadSource, ThreadStatus } from "../store/db.ts";

interface TurnWaiter {
  resolve(result: AskResult): void;
  reject(error: Error): void;
  onToolCall?: (toolName: string) => void;
  onTextSegment?: (text: string, endOffset: number) => void;
  steered: boolean;
}

interface QueuedTurnEntry {
  readonly waiter: TurnWaiter | null;
  readonly notifyParentThreadId: string | null;
}

interface ThreadWaitListener {
  onFinished(): void;
  onError(error: Error): void;
}

interface ActiveThread {
  readonly threadId: string;
  readonly agentSlug: string;
  readonly harness: string;
  readonly handle: HarnessSessionHandle;
  readonly currentWaiters: TurnWaiter[];
  readonly queuedEntries: QueuedTurnEntry[];
  pendingSystemPrompt: string | null;
  turnInFlight: boolean;
  currentTurnSeq: number;
  turnStartedAt: number | null;
  turnText: string;
  textSegmentStart: number;
  currentTool: string | null;
  recentTools: string[];
  notifyParentForTurn: { readonly parentThreadId: string; readonly turnSeq: number } | null;
  stopRequestedByParent: boolean;
  lastActivityAt: number;
  deliverChain: Promise<void>;
}

export interface AskInput {
  readonly agentSlug?: string;
  readonly threadId?: string;
  readonly parentThreadId?: string;
  readonly notifyParentThreadId?: string;
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
      readonly turnSeq: number;
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
  readonly currentTool: string | null;
  readonly recentTools: readonly string[];
  readonly outputChars: number;
  readonly outputPreview: string | null;
  readonly elapsedMs: number | null;
}

export interface ThreadStatusDetail {
  readonly thread: ThreadRecord;
  readonly runtime: ThreadRuntimeStatus;
  readonly lastReply: {
    readonly messageId: string;
    readonly content: string;
    readonly truncated: boolean;
    readonly createdAt: number;
  } | null;
  readonly children: {
    readonly total: number;
    readonly running: number;
  };
}

export interface ThreadWaitItem {
  readonly threadId: string;
  readonly agentSlug: string;
  readonly harness: string;
  readonly status: ThreadStatus;
  readonly turnSeq: number;
  readonly lastError: string | null;
  readonly reply: string | null;
  readonly replyTruncated: boolean;
}

export interface ThreadWaitResult {
  readonly timedOut: boolean;
  readonly threads: readonly ThreadWaitItem[];
}

export interface ChildCompletionNotice extends ChildCompletionNoticeSummary {
  readonly parentThreadId: string;
}

const DEFAULT_IDLE_TTL_MS = 15 * 60_000;
const EVICT_INTERVAL_MS = 60_000;
const RECENT_TOOLS_CAP = 20;
const PREVIEW_CHAR_CAP = 2000;
const LIVE_TAIL_CHARS = 400;

function clipText(
  text: string,
  limit: number,
): { readonly content: string; readonly truncated: boolean } {
  if (text.length <= limit) {
    return { content: text, truncated: false };
  }
  return {
    content: `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars; pass --full to read all]`,
    truncated: true,
  };
}

function tailPreview(text: string, limit: number): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `…${trimmed.slice(-limit)}`;
}

export class ThreadManager {
  private readonly store: AnvaStore;
  private readonly harness: HarnessAdapter;
  private readonly paths: AnvaPaths;
  private readonly idleTtlMs: number;
  private readonly cliPath: string;
  private readonly getApiConfig: () => { readonly url: string; readonly token: string };
  private readonly onBackgroundReply?: (input: {
    readonly threadId: string;
    readonly agentSlug: string;
    readonly reply: string;
  }) => Promise<void>;
  private readonly active = new Map<string, ActiveThread>();
  private readonly opening = new Map<string, Promise<ActiveThread>>();
  private readonly pendingParentNotices = new Map<string, ChildCompletionNotice[]>();
  private readonly flushingParents = new Set<string>();
  private readonly threadWaitListeners = new Map<string, Set<ThreadWaitListener>>();
  private readonly evictTimer: ReturnType<typeof setInterval>;

  constructor(options: {
    readonly store: AnvaStore;
    readonly harness: HarnessAdapter;
    readonly paths: AnvaPaths;
    readonly idleTtlMs?: number;
    readonly cliPath?: string;
    readonly getApiConfig: () => { readonly url: string; readonly token: string };
    readonly onBackgroundReply?: (input: {
      readonly threadId: string;
      readonly agentSlug: string;
      readonly reply: string;
    }) => Promise<void>;
  }) {
    this.store = options.store;
    this.harness = options.harness;
    this.paths = options.paths;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.cliPath = options.cliPath ?? "anva";
    this.getApiConfig = options.getApiConfig;
    this.onBackgroundReply = options.onBackgroundReply;

    this.evictTimer = setInterval(() => {
      void this.evictIdleSessions();
    }, EVICT_INTERVAL_MS);
    this.evictTimer.unref();
  }

  recoverStaleThreads(): number {
    return this.store.recoverStaleRunningThreads(Date.now());
  }

  async ask(input: AskInput): Promise<AskResult> {
    const hasImages = (input.images?.length ?? 0) > 0;
    if (!input.prompt.trim() && !hasImages) {
      throw new AnvaError("prompt_required", "Provide a non-empty prompt.", 400);
    }

    if (input.parentThreadId && !this.store.getThread(input.parentThreadId)) {
      throw new AnvaError(
        "thread_not_found",
        `Parent thread "${input.parentThreadId}" was not found.`,
        404,
      );
    }
    if (input.notifyParentThreadId) {
      if (input.threadId && input.notifyParentThreadId === input.threadId) {
        throw new AnvaError("invalid_request", "A thread cannot notify itself as parent.", 400);
      }
      if (!this.store.getThread(input.notifyParentThreadId)) {
        throw new AnvaError(
          "thread_not_found",
          `Parent thread "${input.notifyParentThreadId}" was not found.`,
          404,
        );
      }
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
        parentThreadId: input.parentThreadId ?? null,
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
      await this.deliverSerialized(
        session,
        wirePrompt,
        inputId,
        null,
        input.images,
        input.notifyParentThreadId,
      );
      return {
        async: true,
        threadId: thread.id,
        turnSeq: session.currentTurnSeq,
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
      void this.deliverSerialized(
        session,
        wirePrompt,
        inputId,
        waiter,
        input.images,
        input.notifyParentThreadId,
      ).catch(reject);
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

  async stopThread(
    threadId: string,
    options?: { readonly requestedByThreadId?: string },
  ): Promise<{ readonly stopped: boolean }> {
    const thread = this.store.getThread(threadId);
    if (!thread) {
      throw new AnvaError("thread_not_found", `Thread "${threadId}" was not found.`, 404);
    }
    const session = this.active.get(threadId);
    if (!session) {
      return { stopped: false };
    }
    if (
      options?.requestedByThreadId &&
      session.notifyParentForTurn?.parentThreadId === options.requestedByThreadId
    ) {
      session.stopRequestedByParent = true;
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
        currentTool: null,
        recentTools: [],
        outputChars: 0,
        outputPreview: null,
        elapsedMs: null,
      };
    }
    const running = session.turnInFlight || session.handle.isRunning();
    return {
      active: true,
      running,
      activeModel: session.handle.activeModel(),
      contextUsage: session.handle.contextUsage(),
      currentTool: running ? session.currentTool : null,
      recentTools: [...session.recentTools],
      outputChars: session.turnText.length,
      outputPreview: tailPreview(session.turnText, LIVE_TAIL_CHARS),
      elapsedMs:
        running && session.turnStartedAt !== null
          ? Math.max(0, Date.now() - session.turnStartedAt)
          : null,
    };
  }

  getThreadStatus(threadId: string): ThreadStatusDetail {
    const thread = this.store.getThread(threadId);
    if (!thread) {
      throw new AnvaError("thread_not_found", `Thread "${threadId}" was not found.`, 404);
    }
    const runtime = this.getThreadRuntimeStatus(threadId);
    const latest = this.store.getLatestAssistantMessage(threadId);
    let lastReply: ThreadStatusDetail["lastReply"] = null;
    if (latest) {
      const clipped = clipText(latest.content, PREVIEW_CHAR_CAP);
      lastReply = {
        messageId: latest.id,
        content: clipped.content,
        truncated: clipped.truncated,
        createdAt: latest.createdAt,
      };
    }
    return {
      thread,
      runtime,
      lastReply,
      children: this.store.countChildThreads(threadId),
    };
  }

  async waitThreads(input: {
    readonly threadIds: readonly string[];
    readonly any?: boolean;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<ThreadWaitResult> {
    const uniqueIds = [...new Set(input.threadIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) {
      throw new AnvaError("invalid_request", "Provide at least one thread ID to wait for.", 400);
    }
    for (const id of uniqueIds) {
      if (!this.store.getThread(id)) {
        throw new AnvaError("thread_not_found", `Thread "${id}" was not found.`, 404);
      }
    }

    const isRunning = (id: string): boolean => {
      const session = this.active.get(id);
      if (session?.turnInFlight) {
        return true;
      }
      return this.store.getThread(id)?.status === "running";
    };

    const isSatisfied = (): boolean =>
      input.any ? uniqueIds.some((id) => !isRunning(id)) : uniqueIds.every((id) => !isRunning(id));

    if (isSatisfied()) {
      const completedIds = uniqueIds.filter((id) => !isRunning(id));
      this.consumeBufferedParentNotices(completedIds);
      return {
        timedOut: false,
        threads: this.buildWaitItems(uniqueIds),
      };
    }

    if (input.signal?.aborted) {
      throw new AnvaError("wait_aborted", "Wait request was aborted.", 499);
    }

    return new Promise<ThreadWaitResult>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const registered: Array<{ readonly id: string; readonly listener: ThreadWaitListener }> = [];

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        input.signal?.removeEventListener("abort", onAbort);
        for (const entry of registered) {
          const set = this.threadWaitListeners.get(entry.id);
          if (set) {
            set.delete(entry.listener);
            if (set.size === 0) {
              this.threadWaitListeners.delete(entry.id);
            }
          }
        }
      };

      const finish = (timedOut: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        const completedIds = uniqueIds.filter((id) => !isRunning(id));
        this.consumeBufferedParentNotices(completedIds);
        resolve({
          timedOut,
          threads: this.buildWaitItems(uniqueIds),
        });
      };

      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new AnvaError("wait_aborted", "Wait request was aborted.", 499));
      };

      if (input.signal) {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }

      if (input.timeoutMs !== undefined && input.timeoutMs >= 0) {
        timer = setTimeout(() => {
          finish(true);
        }, input.timeoutMs);
        timer.unref?.();
      }

      for (const id of uniqueIds) {
        if (!isRunning(id)) {
          continue;
        }
        const listener: ThreadWaitListener = {
          onFinished: () => {
            if (isSatisfied()) {
              finish(false);
            }
          },
          onError: (error) => {
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            reject(error);
          },
        };
        let set = this.threadWaitListeners.get(id);
        if (!set) {
          set = new Set();
          this.threadWaitListeners.set(id, set);
        }
        set.add(listener);
        registered.push({ id, listener });
      }
    });
  }

  async shutdown(): Promise<void> {
    clearInterval(this.evictTimer);
    this.pendingParentNotices.clear();
    const daemonErr = new AnvaError("daemon_stopped", "Anva daemon is shutting down.", 503);
    for (const listeners of this.threadWaitListeners.values()) {
      for (const listener of Array.from(listeners)) {
        listener.onError(daemonErr);
      }
    }
    this.threadWaitListeners.clear();

    const sessions = [...this.active.values()];
    this.active.clear();
    await Promise.all(
      sessions.map(async (session) => {
        if (session.turnInFlight) {
          this.store.markThreadTurnEnded(session.threadId, {
            status: "interrupted",
            lastError: "Anva daemon is shutting down.",
          });
        }
        this.rejectWaiters(session, daemonErr);
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
          stateRef.currentTool = null;
          stateRef.lastActivityAt = Date.now();
        },
        onToolCallStarted: (toolName) => {
          if (!stateRef) return;
          stateRef.lastActivityAt = Date.now();
          stateRef.currentTool = toolName;
          stateRef.recentTools.push(toolName);
          if (stateRef.recentTools.length > RECENT_TOOLS_CAP) {
            stateRef.recentTools.splice(0, stateRef.recentTools.length - RECENT_TOOLS_CAP);
          }
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
      harness: thread.harness,
      handle,
      currentWaiters: [],
      queuedEntries: [],
      pendingSystemPrompt:
        !thread.nativeSessionId && handle.noAppendSystemPrompt && appendSystemPrompt
          ? appendSystemPrompt
          : null,
      turnInFlight: false,
      currentTurnSeq: thread.turnSeq,
      turnStartedAt: null,
      turnText: "",
      textSegmentStart: 0,
      currentTool: null,
      recentTools: [],
      notifyParentForTurn: null,
      stopRequestedByParent: false,
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

  private beginActiveTurn(
    session: ActiveThread,
    waiter: TurnWaiter | null,
    notifyParentThreadId?: string | null,
  ): void {
    const startedAt = Date.now();
    const started = this.store.markThreadTurnStarted(session.threadId, startedAt);
    session.turnInFlight = true;
    session.currentTurnSeq = started.turnSeq;
    session.turnStartedAt = startedAt;
    session.currentTool = null;
    session.recentTools = [];
    session.stopRequestedByParent = false;
    session.notifyParentForTurn = notifyParentThreadId
      ? { parentThreadId: notifyParentThreadId, turnSeq: started.turnSeq }
      : null;
    if (waiter) {
      session.currentWaiters.push(waiter);
    }
  }

  private deliverSerialized(
    session: ActiveThread,
    text: string,
    inputId: string,
    waiter: TurnWaiter | null,
    images?: readonly HarnessInputImage[],
    notifyParentThreadId?: string,
  ): Promise<void> {
    const run = session.deliverChain.then(async () => {
      // Pre-arm waiter before awaiting deliver() so fast or microtask turn completions never miss it.
      const preArmed = !session.turnInFlight;
      if (preArmed) {
        this.beginActiveTurn(session, waiter, notifyParentThreadId);
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
            session.turnStartedAt = null;
            session.currentTool = null;
            session.notifyParentForTurn = null;
            const detail = error instanceof Error ? error.message : String(error);
            this.store.markThreadTurnEnded(session.threadId, {
              status: "failed",
              lastError: detail,
            });
            this.notifyThreadWaitListeners(session.threadId);
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
        session.queuedEntries.push({
          waiter,
          notifyParentThreadId: notifyParentThreadId ?? null,
        });
      } else if (session.turnInFlight) {
        if (landed === "steered" && waiter) {
          waiter.steered = true;
        }
        if (waiter) {
          session.currentWaiters.push(waiter);
        }
        if (notifyParentThreadId && !session.notifyParentForTurn) {
          session.notifyParentForTurn = {
            parentThreadId: notifyParentThreadId,
            turnSeq: session.currentTurnSeq,
          };
        }
      } else {
        this.beginActiveTurn(session, waiter, notifyParentThreadId);
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

    const finalStatus: Exclude<ThreadStatus, "idle" | "running"> =
      outcome.kind === "completed"
        ? "completed"
        : outcome.kind === "aborted"
          ? "aborted"
          : "failed";
    const lastError =
      outcome.kind === "completed"
        ? null
        : outcome.kind === "aborted"
          ? "Turn was stopped."
          : outcome.reason || "Harness turn failed.";
    this.store.markThreadTurnEnded(session.threadId, {
      status: finalStatus,
      lastError,
      endedAt: now,
    });

    const finishedTurnSeq = session.currentTurnSeq;
    const notifySpec = session.notifyParentForTurn;
    const stoppedByParent = session.stopRequestedByParent;
    const elapsedMs =
      session.turnStartedAt !== null ? Math.max(0, now - session.turnStartedAt) : null;

    session.currentTool = null;
    session.recentTools = [];
    session.turnStartedAt = null;
    session.notifyParentForTurn = null;
    session.stopRequestedByParent = false;

    const nextEntry = session.queuedEntries.shift();
    if (nextEntry) {
      this.beginActiveTurn(session, nextEntry.waiter, nextEntry.notifyParentThreadId);
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
    } else {
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

    const consumedByWait = this.notifyThreadWaitListeners(session.threadId);
    if (notifySpec && !consumedByWait && !(finalStatus === "aborted" && stoppedByParent)) {
      const clipped = clipText(reply, PREVIEW_CHAR_CAP);
      this.enqueueParentNotice({
        parentThreadId: notifySpec.parentThreadId,
        childThreadId: session.threadId,
        childAgentSlug: session.agentSlug,
        harness: session.harness,
        status: finalStatus,
        turnSeq: finishedTurnSeq,
        elapsedMs,
        replyPreview: clipped.content,
        replyTruncated: clipped.truncated,
        error: lastError,
      });
    }

    if (!session.turnInFlight && this.pendingParentNotices.has(session.threadId)) {
      this.scheduleParentWakeup(session.threadId);
    }
  }

  private handleExited(session: ActiveThread, reason?: string): void {
    if (this.active.get(session.threadId) === session) {
      this.active.delete(session.threadId);
    }
    const wasInFlight = session.turnInFlight;
    const finishedTurnSeq = session.currentTurnSeq;
    const notifySpec = session.notifyParentForTurn;
    const now = Date.now();
    const elapsedMs =
      session.turnStartedAt !== null ? Math.max(0, now - session.turnStartedAt) : null;
    const detail = reason
      ? `Harness process exited: ${reason}`
      : "Harness process exited unexpectedly.";

    session.turnInFlight = false;
    session.currentTool = null;
    session.turnStartedAt = null;
    session.notifyParentForTurn = null;
    session.stopRequestedByParent = false;

    if (wasInFlight) {
      this.store.markThreadTurnEnded(session.threadId, {
        status: "interrupted",
        lastError: detail,
        endedAt: now,
      });
    }

    this.rejectWaiters(session, new AnvaError("runtime_exited", detail, 502));
    const consumedByWait = this.notifyThreadWaitListeners(session.threadId);
    if (wasInFlight && notifySpec && !consumedByWait) {
      const clipped = clipText(session.turnText, PREVIEW_CHAR_CAP);
      this.enqueueParentNotice({
        parentThreadId: notifySpec.parentThreadId,
        childThreadId: session.threadId,
        childAgentSlug: session.agentSlug,
        harness: session.harness,
        status: "interrupted",
        turnSeq: finishedTurnSeq,
        elapsedMs,
        replyPreview: clipped.content,
        replyTruncated: clipped.truncated,
        error: detail,
      });
    }
  }

  private rejectWaiters(session: ActiveThread, error: Error): void {
    const queuedWaiters = session.queuedEntries
      .splice(0, session.queuedEntries.length)
      .map((entry) => entry.waiter)
      .filter((w): w is TurnWaiter => w !== null);
    const all = [
      ...session.currentWaiters.splice(0, session.currentWaiters.length),
      ...queuedWaiters,
    ];
    for (const w of all) {
      w.reject(error);
    }
  }

  private buildWaitItems(threadIds: readonly string[]): ThreadWaitItem[] {
    return threadIds.map((id) => {
      const thread = this.store.getThread(id);
      if (!thread) {
        throw new AnvaError("thread_not_found", `Thread "${id}" was not found.`, 404);
      }
      const latest = this.store.getLatestAssistantMessage(id);
      const clipped = latest ? clipText(latest.content, PREVIEW_CHAR_CAP) : null;
      return {
        threadId: thread.id,
        agentSlug: thread.agentSlug,
        harness: thread.harness,
        status: thread.status,
        turnSeq: thread.turnSeq,
        lastError: thread.lastError,
        reply: clipped ? clipped.content : null,
        replyTruncated: clipped ? clipped.truncated : false,
      };
    });
  }

  private notifyThreadWaitListeners(threadId: string): boolean {
    const listeners = this.threadWaitListeners.get(threadId);
    if (!listeners || listeners.size === 0) {
      return false;
    }
    for (const listener of Array.from(listeners)) {
      listener.onFinished();
    }
    return true;
  }

  private consumeBufferedParentNotices(childThreadIds: readonly string[]): void {
    if (childThreadIds.length === 0 || this.pendingParentNotices.size === 0) {
      return;
    }
    const idSet = new Set(childThreadIds);
    for (const [parentId, list] of this.pendingParentNotices.entries()) {
      const remaining = list.filter((item) => !idSet.has(item.childThreadId));
      if (remaining.length === 0) {
        this.pendingParentNotices.delete(parentId);
      } else if (remaining.length !== list.length) {
        this.pendingParentNotices.set(parentId, remaining);
      }
    }
  }

  private enqueueParentNotice(notice: ChildCompletionNotice): void {
    const existing = this.pendingParentNotices.get(notice.parentThreadId);
    if (existing) {
      existing.push(notice);
    } else {
      this.pendingParentNotices.set(notice.parentThreadId, [notice]);
    }
    this.scheduleParentWakeup(notice.parentThreadId);
  }

  private scheduleParentWakeup(parentThreadId: string): void {
    queueMicrotask(() => {
      void this.flushParentNotices(parentThreadId);
    });
  }

  private async flushParentNotices(parentThreadId: string): Promise<void> {
    if (this.flushingParents.has(parentThreadId)) {
      return;
    }
    const pendingOpen = this.opening.get(parentThreadId);
    if (pendingOpen) {
      await pendingOpen.catch(() => {});
    }
    const activeParent = this.active.get(parentThreadId);
    if (activeParent?.turnInFlight) {
      return;
    }
    const notices = this.pendingParentNotices.get(parentThreadId);
    if (!notices || notices.length === 0) {
      return;
    }
    this.pendingParentNotices.delete(parentThreadId);

    const parentThread = this.store.getThread(parentThreadId);
    if (!parentThread) {
      return;
    }

    this.flushingParents.add(parentThreadId);
    try {
      const runningSiblings = this.store.listRunningChildThreads(parentThreadId);
      const hasChannelRoute = Boolean(this.store.getChannelRouteByThread(parentThreadId));
      const prompt = formatChildNotificationsPrompt(notices, runningSiblings, hasChannelRoute);
      const res = await this.ask({
        threadId: parentThreadId,
        prompt,
      });
      if (!res.async && !res.steered) {
        await this.onBackgroundReply?.({
          threadId: parentThreadId,
          agentSlug: parentThread.agentSlug,
          reply: res.reply,
        }).catch(() => {});
      }
    } catch {
      // Child completion wakeup errors do not crash the daemon; state remains queryable via thread status.
    } finally {
      this.flushingParents.delete(parentThreadId);
      if (
        this.pendingParentNotices.has(parentThreadId) &&
        !this.active.get(parentThreadId)?.turnInFlight
      ) {
        this.scheduleParentWakeup(parentThreadId);
      }
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
