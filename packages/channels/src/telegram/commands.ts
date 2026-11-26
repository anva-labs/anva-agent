export interface ParsedSlashCommand {
  readonly command: string;
  readonly args: string;
}

export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const match = /^\/([a-zA-Z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match || !match[1]) {
    return null;
  }
  return {
    command: match[1].toLowerCase(),
    args: (match[2] ?? "").trim(),
  };
}
