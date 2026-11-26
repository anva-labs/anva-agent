import { Marked, type RendererObject, type Tokens } from "marked";

export const TELEGRAM_SAFE_TEXT_LIMIT = 4000;

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

export function splitTelegramText(text: string, maxLen = TELEGRAM_SAFE_TEXT_LIMIT): string[] {
  const limit = Math.max(1, maxLen);
  const normalized = text.trim();
  if (!normalized) {
    return [""];
  }
  if (normalized.length <= limit) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    let splitAt = window.lastIndexOf("\n\n");
    if (splitAt < Math.floor(limit * 0.4)) {
      splitAt = window.lastIndexOf("\n");
    }
    if (splitAt < Math.floor(limit * 0.4)) {
      splitAt = window.lastIndexOf(" ");
    }
    if (splitAt <= 0) {
      splitAt = limit;
    }

    const head = remaining.slice(0, splitAt).trimEnd();
    if (head) {
      chunks.push(head);
    }
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }
  return chunks.length > 0 ? chunks : [""];
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const telegramRenderer: RendererObject = {
  space() {
    return "";
  },
  code({ text, lang }: Tokens.Code) {
    const clean = text.replace(/\r?\n$/, "");
    const safeLang = lang?.trim() ?? "";
    return safeLang
      ? `<pre><code class="language-${escapeHtml(safeLang)}">${escapeHtml(clean)}</code></pre>\n\n`
      : `<pre><code>${escapeHtml(clean)}</code></pre>\n\n`;
  },
  blockquote({ tokens }: Tokens.Blockquote) {
    const inner = this.parser.parse(tokens).trim();
    return `<blockquote>${inner}</blockquote>\n\n`;
  },
  html({ text, block }: Tokens.HTML | Tokens.Tag) {
    const escaped = escapeHtml(text);
    return block && !escaped.endsWith("\n\n") ? `${escaped.trimEnd()}\n\n` : escaped;
  },
  def() {
    return "";
  },
  heading({ tokens }: Tokens.Heading) {
    return `<b>${this.parser.parseInline(tokens)}</b>\n\n`;
  },
  hr() {
    return "———\n\n";
  },
  list(token: Tokens.List) {
    const startNum = typeof token.start === "number" ? token.start : 1;
    const lines = token.items.map((item, idx) => {
      const prefix = token.ordered ? `${startNum + idx}. ` : "• ";
      return `${prefix}${this.listitem(item).trim()}`;
    });
    return `${lines.join("\n")}\n\n`;
  },
  listitem(item: Tokens.ListItem) {
    const check = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
    return `${check}${this.parser.parse(item.tokens).trim()}`;
  },
  checkbox() {
    return "";
  },
  paragraph({ tokens }: Tokens.Paragraph) {
    return `${this.parser.parseInline(tokens)}\n\n`;
  },
  table(token: Tokens.Table) {
    const head = token.header.map((c) => this.parser.parseInline(c.tokens)).join(" | ");
    const rows = token.rows.map((r) => r.map((c) => this.parser.parseInline(c.tokens)).join(" | "));
    return `<pre>${escapeHtml([head, ...rows].join("\n"))}</pre>\n\n`;
  },
  tablerow({ text }: Tokens.TableRow) {
    return text;
  },
  tablecell({ tokens }: Tokens.TableCell) {
    return this.parser.parseInline(tokens);
  },
  strong({ tokens }: Tokens.Strong) {
    return `<b>${this.parser.parseInline(tokens)}</b>`;
  },
  em({ tokens }: Tokens.Em) {
    return `<i>${this.parser.parseInline(tokens)}</i>`;
  },
  codespan({ text }: Tokens.Codespan) {
    return `<code>${escapeHtml(text)}</code>`;
  },
  br() {
    return "\n";
  },
  del({ tokens }: Tokens.Del) {
    return `<s>${this.parser.parseInline(tokens)}</s>`;
  },
  link({ href, tokens }: Tokens.Link) {
    const label = this.parser.parseInline(tokens);
    if (/^(https?:\/\/|mailto:|tg:\/\/)/i.test(href)) {
      return `<a href="${href.replaceAll('"', "&quot;")}">${label}</a>`;
    }
    return `${label} (${escapeHtml(href)})`;
  },
  image({ href, text }: Tokens.Image) {
    return text ? `${escapeHtml(text)} (${escapeHtml(href)})` : escapeHtml(href);
  },
  text(token: Tokens.Text | Tokens.Escape) {
    if ("tokens" in token && token.tokens) {
      return this.parser.parseInline(token.tokens);
    }
    return escapeHtml(token.text);
  },
};

const telegramMarked = new Marked({ gfm: true, breaks: false, renderer: telegramRenderer });

export function markdownToTelegramHtml(text: string): string {
  return telegramMarked.parse(text, { async: false }).trimEnd();
}
