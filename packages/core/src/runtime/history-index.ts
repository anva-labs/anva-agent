import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { AnvaError } from "../errors.ts";
import { type AnvaStore, type MessageRecord, toMessage } from "../store/db.ts";

const DEFAULT_READ_CHAR_CAP = 2000;
const EXCERPT_CHARS = 240;
const SHORT_SCAN_LIMIT = 20_000;

export interface SearchContextMessage {
  readonly id: string;
  readonly role: string;
  readonly content: string;
  readonly createdAt: number;
}

export interface ThreadSearchHit {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly threadSource: string;
  readonly messageId: string;
  readonly role: string;
  readonly snippet: string;
  readonly createdAt: number;
  readonly context: readonly SearchContextMessage[];
}

export interface ThreadReadResult {
  readonly threadId: string;
  readonly agentSlug: string;
  readonly title: string;
  readonly harness: string;
  readonly model: string | null;
  readonly messages: readonly {
    readonly id: string;
    readonly role: string;
    readonly content: string;
    readonly truncated: boolean;
    readonly createdAt: number;
  }[];
}

export function splitSearchTerms(query: string): string[] {
  return (query.match(/"([^"]+)"|\S+/g) ?? [])
    .map((term) => term.replace(/^"|"$/g, "").trim())
    .filter(Boolean);
}

function buildExcerpt(text: string, terms: readonly string[], limit: number): string {
  const lower = text.toLocaleLowerCase();
  const positions = terms
    .map((t) => lower.indexOf(t.toLocaleLowerCase()))
    .filter((idx) => idx >= 0);
  const anchor = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, anchor - Math.floor(limit / 3));
  const slice = text.slice(start, start + limit);
  return `${start > 0 ? "…" : ""}${slice}${text.length > start + limit ? "…" : ""}`;
}

function clipContent(
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

type SqlRow = Record<string, SQLOutputValue>;

export class HistoryIndex {
  private readonly store: AnvaStore;

  constructor(store: AnvaStore) {
    this.store = store;
  }

  search(options: {
    readonly agentSlug: string;
    readonly query: string;
    readonly threadId?: string;
    readonly excludeThreadId?: string;
    readonly includeAutomation?: boolean;
    readonly limit?: number;
  }): ThreadSearchHit[] {
    const terms = splitSearchTerms(options.query);
    if (terms.length === 0) {
      return [];
    }

    const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
    const includeAutomation = options.includeAutomation ?? true;
    const longTerms = terms.filter((t) => Array.from(t).length >= 3);
    const shortTerms = terms.filter((t) => Array.from(t).length < 3);

    const commonWhere: string[] = ["m.agent_slug = ?"];
    const commonParams: SQLInputValue[] = [options.agentSlug];

    if (options.threadId) {
      commonWhere.push("m.thread_id = ?");
      commonParams.push(options.threadId);
    } else if (options.excludeThreadId) {
      commonWhere.push("m.thread_id != ?");
      commonParams.push(options.excludeThreadId);
    }
    if (!includeAutomation) {
      commonWhere.push("t.source != 'automation'");
    }
    for (const shortTerm of shortTerms) {
      commonWhere.push("instr(lower(m.content), lower(?)) > 0");
      commonParams.push(shortTerm);
    }

    let sql: string;
    let allParams: SQLInputValue[];
    if (longTerms.length > 0) {
      const ftsExpr = longTerms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" AND ");
      sql = `
        SELECT m.rowid, m.id, m.agent_slug, m.thread_id, m.role, m.content, m.created_at,
               t.title AS thread_title, t.source AS thread_source
        FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        JOIN threads t ON t.id = m.thread_id
        WHERE messages_fts MATCH ? AND ${commonWhere.join(" AND ")}
        ORDER BY CASE WHEN t.source = 'automation' THEN 1 ELSE 0 END ASC,
                 bm25(messages_fts) ASC,
                 m.created_at DESC,
                 m.rowid DESC
        LIMIT ?
      `;
      allParams = [ftsExpr, ...commonParams, limit * 4];
    } else {
      sql = `
        SELECT m.rowid, m.id, m.agent_slug, m.thread_id, m.role, m.content, m.created_at,
               t.title AS thread_title, t.source AS thread_source
        FROM (
          SELECT rowid, id, agent_slug, thread_id, role, content, created_at
          FROM messages
          WHERE agent_slug = ?
          ORDER BY rowid DESC
          LIMIT ?
        ) m
        JOIN threads t ON t.id = m.thread_id
        WHERE ${commonWhere.join(" AND ")}
        ORDER BY CASE WHEN t.source = 'automation' THEN 1 ELSE 0 END ASC,
                 m.created_at DESC,
                 m.rowid DESC
        LIMIT ?
      `;
      allParams = [options.agentSlug, SHORT_SCAN_LIMIT, ...commonParams, limit * 4];
    }

    const rows = this.store.db.prepare(sql).all(...allParams) as SqlRow[];

    const seenThreads = new Set<string>();
    const hits: ThreadSearchHit[] = [];
    for (const row of rows) {
      const msg: MessageRecord = toMessage(row);
      if (seenThreads.has(msg.threadId)) {
        continue;
      }
      seenThreads.add(msg.threadId);
      const { before, after } = this.store.listMessagesAroundRowid(msg.threadId, msg.rowid, 2);
      const context: SearchContextMessage[] = [...before, ...after].map((c) => ({
        id: c.id,
        role: c.role,
        content: buildExcerpt(c.content, [], EXCERPT_CHARS),
        createdAt: c.createdAt,
      }));
      hits.push({
        threadId: msg.threadId,
        threadTitle: typeof row.thread_title === "string" ? row.thread_title : "",
        threadSource: typeof row.thread_source === "string" ? row.thread_source : "cli",
        messageId: msg.id,
        role: msg.role,
        snippet: buildExcerpt(msg.content, terms, EXCERPT_CHARS),
        createdAt: msg.createdAt,
        context,
      });
      if (hits.length >= limit) {
        break;
      }
    }
    return hits;
  }

  read(options: {
    readonly agentSlug?: string;
    readonly threadId: string;
    readonly tail?: number;
    readonly full?: boolean;
  }): ThreadReadResult {
    const thread = this.store.getThread(options.threadId);
    if (!thread || (options.agentSlug && thread.agentSlug !== options.agentSlug)) {
      throw new AnvaError(
        "thread_not_found",
        options.agentSlug
          ? `Thread "${options.threadId}" was not found for agent "${options.agentSlug}".`
          : `Thread "${options.threadId}" was not found.`,
        404,
      );
    }
    const rawMessages = this.store.listMessages(thread.id, options.tail ?? 20);
    const full = options.full ?? false;
    return {
      threadId: thread.id,
      agentSlug: thread.agentSlug,
      title: thread.title,
      harness: thread.harness,
      model: thread.model,
      messages: rawMessages.map((m) => {
        if (full) {
          return {
            id: m.id,
            role: m.role,
            content: m.content,
            truncated: false,
            createdAt: m.createdAt,
          };
        }
        const clipped = clipContent(m.content, DEFAULT_READ_CHAR_CAP);
        return {
          id: m.id,
          role: m.role,
          content: clipped.content,
          truncated: clipped.truncated,
          createdAt: m.createdAt,
        };
      }),
    };
  }

  rebuild(): void {
    this.store.rebuildFts();
  }
}
