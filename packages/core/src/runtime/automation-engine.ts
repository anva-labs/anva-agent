import { Cron } from "croner";
import type { ChannelBridge } from "../channels/types.ts";
import { AnvaError } from "../errors.ts";
import { loadAgentEnv } from "../home/env.ts";
import type { AnvaPaths } from "../paths.ts";
import {
  NO_REPLY_SENTINEL,
  appendAutomationDeliveryNote,
  formatAutomationContextPrompt,
} from "../prompts.ts";
import type {
  AnvaStore,
  AutomationRecord,
  AutomationRunRecord,
  AutomationTriggerType,
} from "../store/db.ts";
import { parsePreflightJson, runPreflightScript } from "./script-runner.ts";
import type { ThreadManager } from "./thread-manager.ts";

const DEFAULT_POLL_INTERVAL_MS = 10_000;

interface AutomationBaseFields {
  readonly name: string;
  readonly enabled: boolean;
  readonly triggerType: AutomationTriggerType;
  readonly cronExpr: string | null;
  readonly runAt: number | null;
  readonly timezone: string;
  readonly scriptCommand: string | null;
  readonly scriptTimeoutMs: number;
  readonly targetThreadId: string | null;
  readonly harnessOverride: string | null;
  readonly modelOverride: string | null;
  readonly prompt: string | null;
  readonly deliverTarget: string | null;
}

export type AutomationCreateInput = {
  readonly agentSlug: string;
  readonly name: string;
  readonly triggerType: AutomationTriggerType;
} & Partial<Omit<AutomationBaseFields, "name" | "triggerType">>;

export type AutomationUpdateInput = Partial<AutomationBaseFields>;

export function computeNextRunAt(input: {
  readonly triggerType: AutomationTriggerType;
  readonly cronExpr?: string | null;
  readonly runAt?: number | null;
  readonly timezone: string;
  readonly fromMs?: number;
}): number | null {
  if (input.triggerType === "once") {
    if (typeof input.runAt !== "number" || !Number.isFinite(input.runAt) || input.runAt <= 0) {
      throw new AnvaError(
        "invalid_schedule",
        'Provide a valid future timestamp/ISO datetime for "--once".',
        400,
      );
    }
    return Math.trunc(input.runAt);
  }

  const expr = input.cronExpr?.trim();
  if (!expr) {
    throw new AnvaError(
      "invalid_schedule",
      'Provide a valid cron expression via "--cron" when triggerType is "cron".',
      400,
    );
  }
  try {
    const job = new Cron(expr, { timezone: input.timezone, paused: true });
    const next = job.nextRun(new Date(input.fromMs ?? Date.now()));
    return next ? next.getTime() : null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AnvaError(
      "invalid_schedule",
      `Invalid cron expression "${expr}" or timezone "${input.timezone}" (${detail}).`,
      400,
    );
  }
}

export interface AutomationEngineOptions {
  readonly store: AnvaStore;
  readonly threads: ThreadManager;
  readonly paths: AnvaPaths;
  readonly pollIntervalMs?: number;
  readonly getApiConfig: () => { readonly url: string; readonly token: string };
  readonly getChannels: () => ChannelBridge | null;
}

export class AutomationEngine {
  private readonly store: AnvaStore;
  private readonly threads: ThreadManager;
  private readonly paths: AnvaPaths;
  private readonly pollIntervalMs: number;
  private readonly getApiConfig: () => { readonly url: string; readonly token: string };
  private readonly getChannels: () => ChannelBridge | null;

  private running = false;
  private ticking = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly activeControllers = new Set<AbortController>();
  private readonly runningAutomationIds = new Set<string>();
  private readonly inFlightRuns = new Set<Promise<void>>();

  constructor(options: AutomationEngineOptions) {
    this.store = options.store;
    this.threads = options.threads;
    this.paths = options.paths;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.getApiConfig = options.getApiConfig;
    this.getChannels = options.getChannels;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.store.recoverStaleAutomationRuns(Date.now());
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
    if (this.inFlightRuns.size > 0) {
      await Promise.all(this.inFlightRuns);
    }
  }

  list(agentSlug?: string): AutomationRecord[] {
    return this.store.listAutomations(agentSlug);
  }

  runs(automationId: string, limit?: number): AutomationRunRecord[] {
    const existing = this.store.getAutomation(automationId);
    if (!existing) {
      throw new AnvaError(
        "automation_not_found",
        `Automation "${automationId}" was not found.`,
        404,
      );
    }
    return this.store.listAutomationRuns(automationId, limit);
  }

  private resolveAutomationTargetAndContent(input: {
    readonly agentSlug: string;
    readonly scriptCommand: string | null;
    readonly prompt: string | null;
    readonly targetThreadId: string | null;
  }): {
    readonly scriptCommand: string | null;
    readonly prompt: string | null;
    readonly targetThreadId: string | null;
  } {
    if (!input.scriptCommand && !input.prompt) {
      throw new AnvaError(
        "invalid_automation",
        "Automation must have at least one of scriptCommand or prompt.",
        400,
      );
    }

    const targetThreadId = input.prompt === null ? null : input.targetThreadId?.trim() || null;
    if (targetThreadId !== null) {
      const thread = this.store.getThread(targetThreadId);
      if (!thread || thread.agentSlug !== input.agentSlug) {
        throw new AnvaError(
          "thread_not_found",
          `Thread "${targetThreadId}" was not found for agent "${input.agentSlug}".`,
          404,
        );
      }
    }

    return {
      scriptCommand: input.scriptCommand,
      prompt: input.prompt,
      targetThreadId,
    };
  }

  create(input: AutomationCreateInput): AutomationRecord {
    const agent = this.store.getAgent(input.agentSlug);
    if (!agent) {
      throw new AnvaError("agent_not_found", `Agent "${input.agentSlug}" was not found.`, 404);
    }

    const resolved = this.resolveAutomationTargetAndContent({
      agentSlug: agent.slug,
      scriptCommand: input.scriptCommand?.trim() || null,
      prompt: input.prompt?.trim() || null,
      targetThreadId: input.targetThreadId ?? null,
    });

    const enabled = input.enabled ?? true;
    const timezone = input.timezone?.trim() || "UTC";
    const nextRunAt = enabled
      ? computeNextRunAt({
          triggerType: input.triggerType,
          cronExpr: input.cronExpr,
          runAt: input.runAt,
          timezone,
        })
      : null;

    return this.store.createAutomation({
      agentSlug: agent.slug,
      name: input.name.trim(),
      enabled,
      triggerType: input.triggerType,
      cronExpr: input.cronExpr?.trim() || null,
      runAt: input.runAt ?? null,
      timezone,
      scriptCommand: resolved.scriptCommand,
      scriptTimeoutMs: input.scriptTimeoutMs ?? 60_000,
      targetThreadId: resolved.targetThreadId,
      harnessOverride: input.harnessOverride?.trim() || null,
      modelOverride: input.modelOverride?.trim() || null,
      prompt: resolved.prompt,
      deliverTarget: input.deliverTarget?.trim() || null,
      nextRunAt,
    });
  }

  update(id: string, patch: AutomationUpdateInput): AutomationRecord {
    const current = this.store.getAutomation(id);
    if (!current) {
      throw new AnvaError("automation_not_found", `Automation "${id}" was not found.`, 404);
    }

    const nextEnabled = patch.enabled !== undefined ? patch.enabled : current.enabled;
    const nextTrigger = patch.triggerType ?? current.triggerType;
    const nextCron = patch.cronExpr !== undefined ? patch.cronExpr : current.cronExpr;
    const nextRunAtRaw = patch.runAt !== undefined ? patch.runAt : current.runAt;
    const nextTimezone = patch.timezone?.trim() || current.timezone;

    const resolved = this.resolveAutomationTargetAndContent({
      agentSlug: current.agentSlug,
      scriptCommand:
        patch.scriptCommand !== undefined
          ? patch.scriptCommand?.trim() || null
          : current.scriptCommand,
      prompt: patch.prompt !== undefined ? patch.prompt?.trim() || null : current.prompt,
      targetThreadId:
        patch.targetThreadId !== undefined ? patch.targetThreadId : current.targetThreadId,
    });

    const scheduleChanged =
      !current.enabled ||
      nextTrigger !== current.triggerType ||
      nextCron !== current.cronExpr ||
      nextRunAtRaw !== current.runAt ||
      nextTimezone !== current.timezone;
    const computedNextRun = !nextEnabled
      ? null
      : scheduleChanged
        ? computeNextRunAt({
            triggerType: nextTrigger,
            cronExpr: nextCron,
            runAt: nextRunAtRaw,
            timezone: nextTimezone,
          })
        : current.nextRunAt;

    return this.store.updateAutomation(id, {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      enabled: nextEnabled,
      triggerType: nextTrigger,
      cronExpr: nextCron,
      runAt: nextRunAtRaw,
      timezone: nextTimezone,
      scriptCommand: resolved.scriptCommand,
      ...(patch.scriptTimeoutMs !== undefined ? { scriptTimeoutMs: patch.scriptTimeoutMs } : {}),
      targetThreadId: resolved.targetThreadId,
      ...(patch.harnessOverride !== undefined ? { harnessOverride: patch.harnessOverride } : {}),
      ...(patch.modelOverride !== undefined ? { modelOverride: patch.modelOverride } : {}),
      prompt: resolved.prompt,
      ...(patch.deliverTarget !== undefined
        ? { deliverTarget: patch.deliverTarget?.trim() || null }
        : {}),
      nextRunAt: computedNextRun,
    });
  }

  delete(id: string): void {
    const deleted = this.store.deleteAutomation(id);
    if (!deleted) {
      throw new AnvaError("automation_not_found", `Automation "${id}" was not found.`, 404);
    }
  }

  async test(id: string): Promise<AutomationRunRecord> {
    const automation = this.store.getAutomation(id);
    if (!automation) {
      throw new AnvaError("automation_not_found", `Automation "${id}" was not found.`, 404);
    }
    if (this.runningAutomationIds.has(id)) {
      throw new AnvaError(
        "automation_busy",
        `Automation "${id}" already has a run in progress.`,
        409,
      );
    }
    this.runningAutomationIds.add(id);
    const run = this.store.createAutomationRun({
      automationId: automation.id,
      agentSlug: automation.agentSlug,
      status: automation.scriptCommand ? "running_script" : "running_agent",
      startedAt: Date.now(),
    });
    const execPromise = this.executeRun(automation, run).finally(() => {
      this.runningAutomationIds.delete(id);
      this.inFlightRuns.delete(execPromise);
    });
    this.inFlightRuns.add(execPromise);
    await execPromise;
    return this.store.getAutomationRun(run.id)!;
  }

  async tick(): Promise<void> {
    if (!this.running || this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const now = Date.now();
      const due = this.store.listDueAutomations(now);
      for (const item of due) {
        if (!this.running) {
          break;
        }
        const nextRunAt =
          item.triggerType === "cron"
            ? computeNextRunAt({
                triggerType: "cron",
                cronExpr: item.cronExpr,
                timezone: item.timezone,
                fromMs: now,
              })
            : null;
        const nextEnabled = item.triggerType !== "once";
        this.store.advanceAutomationSchedule(item.id, {
          enabled: nextEnabled,
          nextRunAt,
          updatedAt: now,
        });

        if (this.runningAutomationIds.has(item.id)) {
          this.store.createAutomationRun({
            automationId: item.id,
            agentSlug: item.agentSlug,
            status: "skipped",
            error: "Skipped because previous run is still active.",
            startedAt: now,
            endedAt: now,
          });
          continue;
        }

        this.runningAutomationIds.add(item.id);
        const updatedAutomation: AutomationRecord = {
          ...item,
          enabled: nextEnabled,
          nextRunAt,
          updatedAt: now,
        };
        const run = this.store.createAutomationRun({
          automationId: item.id,
          agentSlug: item.agentSlug,
          status: item.scriptCommand ? "running_script" : "running_agent",
          startedAt: now,
        });
        const execPromise = this.executeRun(updatedAutomation, run).finally(() => {
          this.runningAutomationIds.delete(item.id);
          this.inFlightRuns.delete(execPromise);
        });
        this.inFlightRuns.add(execPromise);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async executeRun(automation: AutomationRecord, run: AutomationRunRecord): Promise<void> {
    let preflightContext: unknown;
    let hasPreflightContext = false;

    try {
      if (automation.scriptCommand) {
        const agentHome = this.paths.agentHome(automation.agentSlug);
        const agentEnv = loadAgentEnv(agentHome);
        const api = this.getApiConfig();
        const controller = new AbortController();
        this.activeControllers.add(controller);

        let execRes;
        try {
          execRes = await runPreflightScript({
            command: automation.scriptCommand,
            cwd: agentHome,
            env: {
              ...process.env,
              ...agentEnv.vars,
              ANVA_API: api.url,
              ANVA_TOKEN: api.token,
              ANVA_AGENT_SLUG: automation.agentSlug,
              ANVA_AUTOMATION_ID: automation.id,
              ANVA_RUN_ID: run.id,
              ...(automation.lastCursorAt !== null
                ? { ANVA_LAST_RUN_AT: String(automation.lastCursorAt) }
                : {}),
            },
            timeoutMs: automation.scriptTimeoutMs,
            signal: controller.signal,
          });
        } finally {
          this.activeControllers.delete(controller);
        }

        if (execRes.timedOut) {
          this.store.updateAutomationRun(run.id, {
            status: "timed_out",
            scriptExitCode: execRes.exitCode,
            scriptStdout: execRes.stdout,
            scriptStderr: execRes.stderr,
            error: `Script timed out after ${automation.scriptTimeoutMs}ms.`,
            endedAt: Date.now(),
          });
          return;
        }

        if (execRes.exitCode !== 0) {
          this.store.updateAutomationRun(run.id, {
            status: "failed",
            scriptExitCode: execRes.exitCode,
            scriptStdout: execRes.stdout,
            scriptStderr: execRes.stderr,
            error: `Script exited with code ${execRes.exitCode ?? "null"}.`,
            endedAt: Date.now(),
          });
          return;
        }

        if (automation.prompt === null) {
          const endMs = Date.now();
          this.store.updateAutomationRun(run.id, {
            status: "succeeded",
            scriptExitCode: execRes.exitCode,
            scriptStdout: execRes.stdout,
            scriptStderr: execRes.stderr,
            endedAt: endMs,
          });
          this.store.markAutomationCursor(automation.id, endMs);
          await this.deliverOutput(automation, execRes.stdout);
          return;
        }

        const outcome = parsePreflightJson(execRes.stdout);
        if (!outcome.runAgent) {
          const endMs = Date.now();
          this.store.updateAutomationRun(run.id, {
            status: "skipped",
            scriptExitCode: execRes.exitCode,
            scriptStdout: execRes.stdout,
            scriptStderr: execRes.stderr,
            endedAt: endMs,
          });
          this.store.markAutomationCursor(automation.id, endMs);
          return;
        }

        this.store.updateAutomationRun(run.id, {
          status: "running_agent",
          scriptExitCode: execRes.exitCode,
          scriptStdout: execRes.stdout,
          scriptStderr: execRes.stderr,
        });
        if ("context" in outcome && outcome.context !== undefined) {
          preflightContext = outcome.context;
          hasPreflightContext = true;
        }
      }

      const basePrompt = automation.prompt ?? "";
      const prompt = hasPreflightContext
        ? formatAutomationContextPrompt(basePrompt, preflightContext)
        : basePrompt;
      const deliveryPrompt = automation.deliverTarget
        ? appendAutomationDeliveryNote(prompt)
        : undefined;

      const askRes = await this.threads.ask({
        ...(automation.targetThreadId
          ? { threadId: automation.targetThreadId }
          : {
              agentSlug: automation.agentSlug,
              harness: automation.harnessOverride ?? undefined,
              model: automation.modelOverride ?? undefined,
            }),
        prompt,
        ...(deliveryPrompt ? { deliveryPrompt } : {}),
        source: "automation",
      });

      const endMs = Date.now();
      this.store.updateAutomationRun(run.id, {
        status: "succeeded",
        threadId: askRes.threadId,
        endedAt: endMs,
      });
      this.store.markAutomationCursor(automation.id, endMs);

      if (!askRes.async) {
        await this.deliverOutput(automation, askRes.reply);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.store.updateAutomationRun(run.id, {
        status: "failed",
        error: detail,
        endedAt: Date.now(),
      });
    }
  }

  private async deliverOutput(automation: AutomationRecord, rawText: string): Promise<void> {
    if (!automation.deliverTarget) {
      return;
    }
    const trimmed = rawText.trim();
    if (!trimmed || trimmed === NO_REPLY_SENTINEL) {
      return;
    }
    const channels = this.getChannels();
    if (!channels) {
      return;
    }
    await channels.send({
      agentSlug: automation.agentSlug,
      target: automation.deliverTarget,
      text: trimmed,
    });
  }
}
