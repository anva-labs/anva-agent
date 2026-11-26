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
    '- `session search "<query>" --json` / `session read <thread_id> --tail 20` — search or read past conversations',
    '- `channel send --file <path> ["<caption>"]` — send a file or image to the current thread (or pass `<target>`)',
    "- `automation ...` — schedule cron or one-shot tasks (`--help` for options)",
    "- `service restart --delay <seconds>` — schedule a daemon self-restart after code/config changes (1-300s)",
    '- `ask <agent> "<prompt>" --json` — message another agent',
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
