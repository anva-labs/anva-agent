import { AnvaError, type AutomationRecord, type AutomationRunRecord } from "@anva/core";
import { defineCommand } from "citty";
import {
  apiRequest,
  emitResult,
  getCliRuntime,
  requireAgentScope,
  resolveConnection,
} from "../context.ts";

function parseRunAt(raw: string): number {
  const num = Number(raw);
  if (Number.isFinite(num) && num > 0) {
    return Math.trunc(num);
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AnvaError(
      "invalid_args",
      `Invalid --once value "${raw}". Pass an ISO timestamp or epoch milliseconds.`,
    );
  }
  return parsed;
}

function parseDeliverOption(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  useOriginDefault: boolean,
): string | null | undefined {
  if (explicit === undefined) {
    if (!useOriginDefault) {
      return undefined;
    }
    return env.ANVA_THREAD_ID?.trim() || null;
  }
  const trimmed = explicit.trim();
  if (!trimmed || trimmed === "none") {
    return null;
  }
  return trimmed;
}

const automationListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List scheduled automations",
  },
  args: {
    agent: { type: "string", description: "Filter by agent slug" },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const rt = getCliRuntime();
    const conn = resolveConnection(rt.env);
    const agent = args.agent?.trim() || rt.env.ANVA_AGENT_SLUG?.trim();
    const qs = agent ? `?agent=${encodeURIComponent(agent)}` : "";
    const res = await apiRequest<{ readonly automations: AutomationRecord[] }>(
      conn,
      "GET",
      `/v1/automations${qs}`,
    );
    const lines = res.automations.map((a) => {
      const sched = a.triggerType === "cron" ? `${a.cronExpr} (${a.timezone})` : `once@${a.runAt}`;
      const state = a.enabled ? "enabled" : "disabled";
      const next = a.nextRunAt ? new Date(a.nextRunAt).toISOString() : "-";
      return `${a.id}\t${a.agentSlug}\t${state}\t${sched}\tnext=${next}\t${a.name}`;
    });
    emitResult(args.json, res, lines.length > 0 ? lines.join("\n") : "(no automations)");
  },
});

const automationCreateCommand = defineCommand({
  meta: {
    name: "create",
    description: "Create a script-first or prompt-driven automation",
  },
  args: {
    agent: { type: "string", description: "Agent slug (defaults to ANVA_AGENT_SLUG)" },
    name: { type: "string", description: "Human-readable automation name", required: true },
    cron: { type: "string", description: "Cron expression (5 or 6 fields)" },
    once: { type: "string", description: "One-shot run time (ISO timestamp or epoch ms)" },
    timezone: { type: "string", description: "IANA timezone (default UTC)" },
    script: { type: "string", description: "Shell command for preflight or pure script run" },
    "timeout-ms": { type: "string", description: "Script timeout in ms (default 60000)" },
    prompt: { type: "string", description: "Agent prompt (omit for pure script mode)" },
    thread: {
      type: "string",
      description: "Existing thread ID to reuse (omit to create a new thread)",
    },
    harness: { type: "string", description: "Optional harness override for new_thread" },
    model: { type: "string", description: "Optional model override for new_thread" },
    deliver: {
      type: "string",
      description:
        'Channel target (th_xxx, chatId[:topicId], or "none"; defaults to origin ANVA_THREAD_ID)',
    },
    disabled: { type: "boolean", description: "Create in disabled state" },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const rt = getCliRuntime();
    const conn = resolveConnection(rt.env);
    const agentSlug = requireAgentScope(
      args.agent,
      rt.env,
      'anva automation create --agent <slug> --name "Daily" --cron "0 9 * * *" --prompt "..."',
    );

    if (!args.cron && !args.once) {
      throw new AnvaError("invalid_args", 'Specify either --cron "<expr>" or --once "<iso|ms>".');
    }
    if (args.cron && args.once) {
      throw new AnvaError("invalid_args", "Pass either --cron or --once, not both.");
    }

    const triggerType = args.cron ? "cron" : "once";
    const runAt = args.once ? parseRunAt(args.once) : undefined;
    const timeoutMs = args["timeout-ms"] ? Number(args["timeout-ms"]) : undefined;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 100)) {
      throw new AnvaError("invalid_args", "--timeout-ms must be an integer >= 100.");
    }

    const threadId = args.thread?.trim() || undefined;
    const deliverTarget = parseDeliverOption(args.deliver, rt.env, true);

    const res = await apiRequest<{ readonly automation: AutomationRecord }>(
      conn,
      "POST",
      "/v1/automations",
      {
        agent: agentSlug,
        name: args.name,
        enabled: !args.disabled,
        triggerType,
        ...(args.cron ? { cronExpr: args.cron } : {}),
        ...(runAt !== undefined ? { runAt } : {}),
        ...(args.timezone ? { timezone: args.timezone } : {}),
        ...(args.script ? { scriptCommand: args.script } : {}),
        ...(timeoutMs !== undefined ? { scriptTimeoutMs: timeoutMs } : {}),
        ...(threadId ? { targetThreadId: threadId } : {}),
        ...(args.harness ? { harnessOverride: args.harness } : {}),
        ...(args.model ? { modelOverride: args.model } : {}),
        ...(args.prompt ? { prompt: args.prompt } : {}),
        ...(deliverTarget !== undefined ? { deliverTarget } : {}),
      },
    );
    emitResult(
      args.json,
      res,
      `Created automation "${res.automation.name}" (${res.automation.id})`,
    );
  },
});

const automationUpdateCommand = defineCommand({
  meta: {
    name: "update",
    description: "Update an existing automation",
  },
  args: {
    id: { type: "positional", description: "Automation ID (au_xxx)", required: true },
    name: { type: "string", description: "New name" },
    enabled: {
      type: "boolean",
      description: "Enable the automation (use --no-enabled to disable)",
    },
    disabled: { type: "boolean", description: "Disable the automation" },
    cron: { type: "string", description: "New cron expression (switches triggerType to cron)" },
    once: { type: "string", description: "New one-shot time (switches triggerType to once)" },
    timezone: { type: "string", description: "New IANA timezone" },
    script: { type: "string", description: "New script command" },
    "timeout-ms": { type: "string", description: "New script timeout in ms" },
    prompt: { type: "string", description: "New prompt text" },
    thread: { type: "string", description: 'Target thread ID (or "none" to use a new thread)' },
    deliver: { type: "string", description: 'Channel target or "none"' },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const rt = getCliRuntime();
    const conn = resolveConnection(rt.env);

    const enabled = args.disabled ? false : args.enabled;
    const triggerType = args.cron ? "cron" : args.once ? "once" : undefined;
    const runAt = args.once ? parseRunAt(args.once) : undefined;
    const timeoutMs = args["timeout-ms"] ? Number(args["timeout-ms"]) : undefined;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 100)) {
      throw new AnvaError("invalid_args", "--timeout-ms must be an integer >= 100.");
    }
    const deliverTarget = parseDeliverOption(args.deliver, rt.env, false);
    const trimmedThread = args.thread?.trim();
    const targetThreadId =
      args.thread === undefined
        ? undefined
        : !trimmedThread || trimmedThread === "none"
          ? null
          : trimmedThread;

    const res = await apiRequest<{ readonly automation: AutomationRecord }>(
      conn,
      "PATCH",
      `/v1/automations/${encodeURIComponent(args.id)}`,
      {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(triggerType !== undefined ? { triggerType } : {}),
        ...(args.cron !== undefined ? { cronExpr: args.cron, runAt: null } : {}),
        ...(runAt !== undefined ? { runAt, cronExpr: null } : {}),
        ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
        ...(args.script !== undefined ? { scriptCommand: args.script || null } : {}),
        ...(timeoutMs !== undefined ? { scriptTimeoutMs: timeoutMs } : {}),
        ...(targetThreadId !== undefined ? { targetThreadId } : {}),
        ...(args.prompt !== undefined ? { prompt: args.prompt || null } : {}),
        ...(deliverTarget !== undefined ? { deliverTarget } : {}),
      },
    );
    emitResult(
      args.json,
      res,
      `Updated automation "${res.automation.name}" (${res.automation.id})`,
    );
  },
});

const automationDeleteCommand = defineCommand({
  meta: {
    name: "delete",
    description: "Delete an automation",
  },
  args: {
    id: { type: "positional", description: "Automation ID (au_xxx)", required: true },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const conn = resolveConnection(getCliRuntime().env);
    const res = await apiRequest<{ readonly ok: boolean }>(
      conn,
      "DELETE",
      `/v1/automations/${encodeURIComponent(args.id)}`,
    );
    emitResult(args.json, res, `Deleted automation ${args.id}`);
  },
});

const automationTestCommand = defineCommand({
  meta: {
    name: "test",
    description: "Run an automation immediately without advancing its schedule",
  },
  args: {
    id: { type: "positional", description: "Automation ID (au_xxx)", required: true },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const conn = resolveConnection(getCliRuntime().env);
    const res = await apiRequest<{ readonly run: AutomationRunRecord }>(
      conn,
      "POST",
      `/v1/automations/${encodeURIComponent(args.id)}/test`,
    );
    const r = res.run;
    const detail = [
      `Run ${r.id}: status=${r.status}`,
      ...(r.threadId ? [`thread=${r.threadId}`] : []),
      ...(r.scriptExitCode !== null ? [`exitCode=${r.scriptExitCode}`] : []),
      ...(r.error ? [`error=${r.error}`] : []),
    ].join(" ");
    emitResult(args.json, res, detail);
  },
});

const automationRunsCommand = defineCommand({
  meta: {
    name: "runs",
    description: "List execution history for an automation",
  },
  args: {
    id: { type: "positional", description: "Automation ID (au_xxx)", required: true },
    limit: { type: "string", description: "Maximum runs to return" },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const conn = resolveConnection(getCliRuntime().env);
    const qs = args.limit ? `?limit=${encodeURIComponent(args.limit)}` : "";
    const res = await apiRequest<{ readonly runs: AutomationRunRecord[] }>(
      conn,
      "GET",
      `/v1/automations/${encodeURIComponent(args.id)}/runs${qs}`,
    );
    const lines = res.runs.map((r) => {
      const ts = new Date(r.startedAt).toISOString();
      return `${r.id}\t${r.status}\t${ts}${r.threadId ? `\tthread=${r.threadId}` : ""}${r.error ? `\t${r.error}` : ""}`;
    });
    emitResult(args.json, res, lines.length > 0 ? lines.join("\n") : "(no runs yet)");
  },
});

export const automationCommand = defineCommand({
  meta: {
    name: "automation",
    description: "Manage script-first scheduled automations",
  },
  subCommands: {
    list: automationListCommand,
    create: automationCreateCommand,
    update: automationUpdateCommand,
    delete: automationDeleteCommand,
    test: automationTestCommand,
    runs: automationRunsCommand,
  },
});
