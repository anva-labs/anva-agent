/** Sentinel text indicating an automation reply should suppress channel delivery. */
export const NO_REPLY_SENTINEL = "NO_REPLY";

/** Build the default PERSONA.md contents for a newly created agent. */
export function buildDefaultPersonaMarkdown(name: string, customPersona?: string): string {
  const trimmed = customPersona?.trim();
  return trimmed
    ? `${trimmed}\n`
    : `# ${name}\n\nYou are ${name}, a personal agent running on Anva.\n`;
}

/** Build the default MEMORY.md contents for a newly created agent. */
export function buildDefaultMemoryMarkdown(name: string): string {
  return `# ${name}'s Memory\n\nKeep this file concise: preferences, active context, and key decisions.\n`;
}

export interface SystemPromptContext {
  readonly agentSlug: string;
  readonly agentName: string;
  readonly agentHome: string;
  readonly persona: string;
  readonly memory: string;
  readonly envNames: readonly string[];
  readonly envVarsForInline: Readonly<Record<string, string>>;
  readonly noEnv: boolean;
  readonly cliPath: string;
}

function buildRuntimeBlock(ctx: SystemPromptContext): string {
  const lines = [
    "<anva_runtime>",
    `You are "${ctx.agentName}" (slug: \`${ctx.agentSlug}\`) running in Anva. Working directory: \`${ctx.agentHome}\`.`,
    "- `MEMORY.md`: frozen long-term memory snapshot above; edit on disk to persist notes across sessions.",
    "- `skills/`: custom skills directory.",
    "- Reply directly with plain text (never call `channel send` for normal replies).",
    "",
    `CLI (\`${ctx.cliPath}\`; run \`--help\` for full subcommands such as \`agent\`, \`thread\`, \`harnesses\`):`,
    '- `thread search "<query>" --json` / `thread read <thread_id> --tail 20 [--full]` — search or read thread history',
    "- `thread list [--children]` / `thread status <thread_id>` / `thread stop <thread_id>` — list, inspect progress, or abort threads",
    "- `thread wait <thread_id...> [--timeout <sec>] [--any]` — wait for threads to finish and retrieve results",
    '- `ask [<agent>] "<prompt>" [--harness <h>] [--model <m>] [--async] [--no-notify] [--thread <id>]` — start, delegate, or continue a thread',
    '- `channel send --file <path> ["<caption>"]` — send a file or image to the current thread (or pass `<target>`)',
    "- `automation ...` — schedule cron or one-shot tasks (`--help` for options)",
    "- `service restart --delay <seconds>` — schedule a daemon self-restart after code/config changes (1-300s)",
    "",
    "Delegation with threads:",
    "- Each new thread has independent context (no parent history); write self-contained prompts.",
    "- Short or parallel tasks: start with `ask ... --async` then collect via `thread wait <id...> --timeout <sec>` (wait consumes the completion notice so you are not woken twice).",
    "- Long background tasks: start with `ask ... --async` (auto-notifies this thread on completion or failure; pass `--no-notify` to disable), reply to the user, and end your turn instead of blocking on `thread wait`.",
    "- Parallel threads for the same agent share its working directory; assign non-overlapping paths or separate worktrees when writing files.",
  ];

  if (ctx.envNames.length > 0) {
    lines.push(
      `Shell env vars available: ${ctx.envNames.map((n) => `\`${n}\``).join(", ")} (never print secrets).`,
    );
  }

  if (ctx.noEnv) {
    const anvaApi = ctx.envVarsForInline.ANVA_API ?? "";
    const anvaToken = ctx.envVarsForInline.ANVA_TOKEN ?? "";
    const anvaThreadId = ctx.envVarsForInline.ANVA_THREAD_ID ?? "";
    lines.push(
      `This harness does not inherit custom env; prefix \`${ctx.cliPath}\` calls with \`ANVA_API='${anvaApi}' ANVA_TOKEN='${anvaToken}' ANVA_AGENT_SLUG='${ctx.agentSlug}' ANVA_THREAD_ID='${anvaThreadId}'\`.`,
    );
  }

  lines.push("</anva_runtime>");
  return lines.join("\n");
}

/** Assemble the system prompt snapshot injected when opening or resuming a harness session. */
export function buildSystemPromptSnapshot(ctx: SystemPromptContext): string {
  const parts: string[] = [];
  const persona = ctx.persona.trim();
  const memory = ctx.memory.trim();

  if (persona) {
    parts.push(`<persona>\n${persona}\n</persona>`);
  }
  if (memory) {
    parts.push(`<memory_snapshot>\n${memory}\n</memory_snapshot>`);
  }
  parts.push(buildRuntimeBlock(ctx));
  return parts.join("\n\n");
}

/** Wrap a session system prompt inline before the first user message when appendSystemPrompt is unsupported. */
export function wrapInlineSystemContext(systemPrompt: string, userMessage: string): string {
  return `<system_context>\n${systemPrompt}\n</system_context>\n\n${userMessage}`;
}

/** Append serialized preflight JSON context to an automation's base prompt. */
export function formatAutomationContextPrompt(basePrompt: string, context: unknown): string {
  return `${basePrompt}\n\nContext:\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``;
}

/** Append delivery and silent-suppression instructions to an automation prompt. */
export function appendAutomationDeliveryNote(prompt: string): string {
  return `${prompt}\n\n[Automation note: Your final reply will be delivered to the user. If nothing requires attention, reply with exactly ${NO_REPLY_SENTINEL} to stay silent.]`;
}

/** Summary of a completed child thread delivered to wake its parent thread. */
export interface ChildCompletionNoticeSummary {
  readonly childThreadId: string;
  readonly childAgentSlug: string;
  readonly harness: string;
  readonly status: string;
  readonly turnSeq: number;
  readonly elapsedMs: number | null;
  readonly replyPreview: string;
  readonly replyTruncated: boolean;
  readonly error: string | null;
}

/** Format coalesced child thread completion notices for parent thread wakeup. */
export function formatChildNotificationsPrompt(
  notices: readonly ChildCompletionNoticeSummary[],
  runningSiblings: readonly {
    readonly id: string;
    readonly agentSlug: string;
    readonly harness: string;
    readonly title: string;
  }[],
  hasChannelRoute: boolean,
): string {
  const lines: string[] = ["<child_thread_notifications>"];
  for (const notice of notices) {
    const duration =
      notice.elapsedMs !== null ? `${Math.max(0, Math.round(notice.elapsedMs / 1000))}s` : "n/a";
    lines.push(
      `[Child ${notice.childThreadId}] agent=${notice.childAgentSlug} harness=${notice.harness} status=${notice.status} turn=#${notice.turnSeq} elapsed=${duration}`,
    );
    if (notice.error) {
      lines.push(`Error: ${notice.error}`);
    }
    if (notice.replyPreview) {
      lines.push("Output:");
      lines.push(notice.replyPreview);
      if (notice.replyTruncated) {
        lines.push(
          `(Truncated. Run \`anva thread read ${notice.childThreadId} --full\` for complete output.)`,
        );
      }
    } else if (!notice.error) {
      lines.push("Output: (empty)");
    }
    lines.push("");
  }

  if (runningSiblings.length > 0) {
    const siblingList = runningSiblings
      .map((s) => `${s.id} (${s.agentSlug}/${s.harness}${s.title ? `: ${s.title}` : ""})`)
      .join(", ");
    lines.push(`Still running child threads: ${siblingList}`);
  } else {
    lines.push("Still running child threads: none");
  }
  lines.push("</child_thread_notifications>");

  if (hasChannelRoute) {
    lines.push(
      "",
      `[Notification note: Your reply will be sent directly to the user. If you want to wait for remaining child threads before updating the user, reply with exactly ${NO_REPLY_SENTINEL}.]`,
    );
  }
  return lines.join("\n");
}

/** Format an inbound channel attachment marker included in the user prompt. */
export function formatChannelAttachmentTag(attachment: {
  readonly kind: string;
  readonly localPath?: string;
  readonly mimeType?: string;
}): string {
  if (attachment.localPath) {
    const meta = attachment.mimeType
      ? `${attachment.kind}, ${attachment.mimeType}`
      : attachment.kind;
    return `[Attachment: ${attachment.localPath} (${meta})]`;
  }
  return `[Attachment (${attachment.kind}): failed to download]`;
}
