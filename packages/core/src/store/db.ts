import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { AnvaError } from "../errors.ts";
import { createId } from "../ids.ts";
import { MIGRATIONS, SCHEMA_MIGRATIONS_SQL, SCHEMA_VERSION } from "./schema.ts";

export interface AgentRecord {
  readonly slug: string;
  readonly name: string;
  readonly defaultHarness: string;
  readonly defaultModel: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ThreadSource = "cli" | "channel" | "automation";

export interface ThreadRecord {
  readonly id: string;
  readonly agentSlug: string;
  readonly title: string;
  readonly source: ThreadSource;
  readonly harness: string;
  readonly model: string | null;
  readonly nativeSessionId: string | null;
  readonly lastActivityAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type MessageRole = "user" | "assistant" | "system";

export interface MessageRecord {
  readonly rowid: number;
  readonly id: string;
  readonly agentSlug: string;
  readonly threadId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: number;
}

export interface ChannelConnectionRecord {
  readonly id: string;
  readonly platform: string;
  readonly agentSlug: string;
  readonly botId: string | null;
  readonly botName: string | null;
  readonly envKey: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ChannelRouteRecord {
  readonly id: string;
  readonly connectionId: string;
  readonly externalChatId: string;
  readonly externalThreadId: string;
  readonly threadId: string;
  readonly updatedAt: number;
}

export type AutomationTriggerType = "cron" | "once";
export type AutomationRunStatus =
  | "running_script"
  | "skipped"
  | "running_agent"
  | "succeeded"
  | "failed"
  | "timed_out";

export interface AutomationRecord {
  readonly id: string;
  readonly agentSlug: string;
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
  readonly lastCursorAt: number | null;
  readonly nextRunAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AutomationRunRecord {
  readonly id: string;
  readonly automationId: string;
  readonly agentSlug: string;
  readonly status: AutomationRunStatus;
  readonly scriptExitCode: number | null;
  readonly scriptStdout: string | null;
  readonly scriptStderr: string | null;
  readonly threadId: string | null;
  readonly error: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

type SqlRow = Record<string, SQLOutputValue>;

function str(row: SqlRow, key: string): string {
  const val = row[key];
  if (typeof val !== "string") {
    throw new Error(`Expected string column "${key}"`);
  }
  return val;
}

function nullableStr(row: SqlRow, key: string): string | null {
  const val = row[key];
  if (val === null || val === undefined) {
    return null;
  }
  if (typeof val !== "string") {
    throw new Error(`Expected nullable string column "${key}"`);
  }
  return val;
}

function num(row: SqlRow, key: string): number {
  const val = row[key];
  if (typeof val !== "number") {
    throw new Error(`Expected number column "${key}"`);
  }
  return val;
}

function nullableNum(row: SqlRow, key: string): number | null {
  const val = row[key];
  if (val === null || val === undefined) {
    return null;
  }
  if (typeof val !== "number") {
    throw new Error(`Expected nullable number column "${key}"`);
  }
  return val;
}

function toAgent(row: SqlRow): AgentRecord {
  return {
    slug: str(row, "slug"),
    name: str(row, "name"),
    defaultHarness: str(row, "default_harness"),
    defaultModel: nullableStr(row, "default_model"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

function toThreadSource(value: string): ThreadSource {
  if (value === "cli" || value === "channel" || value === "automation") {
    return value;
  }
  throw new Error(`Unexpected thread source "${value}"`);
}

function toThread(row: SqlRow): ThreadRecord {
  return {
    id: str(row, "id"),
    agentSlug: str(row, "agent_slug"),
    title: str(row, "title"),
    source: toThreadSource(str(row, "source")),
    harness: str(row, "harness"),
    model: nullableStr(row, "model"),
    nativeSessionId: nullableStr(row, "native_session_id"),
    lastActivityAt: num(row, "last_activity_at"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

function toMessageRole(value: string): MessageRole {
  if (value === "user" || value === "assistant" || value === "system") {
    return value;
  }
  throw new Error(`Unexpected message role "${value}"`);
}

export function toMessage(row: SqlRow): MessageRecord {
  return {
    rowid: num(row, "rowid"),
    id: str(row, "id"),
    agentSlug: str(row, "agent_slug"),
    threadId: str(row, "thread_id"),
    role: toMessageRole(str(row, "role")),
    content: str(row, "content"),
    createdAt: num(row, "created_at"),
  };
}

function toChannelConnection(row: SqlRow): ChannelConnectionRecord {
  return {
    id: str(row, "id"),
    platform: str(row, "platform"),
    agentSlug: str(row, "agent_slug"),
    botId: nullableStr(row, "bot_id"),
    botName: nullableStr(row, "bot_name"),
    envKey: str(row, "env_key"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

function toChannelRoute(row: SqlRow): ChannelRouteRecord {
  return {
    id: str(row, "id"),
    connectionId: str(row, "connection_id"),
    externalChatId: str(row, "external_chat_id"),
    externalThreadId: str(row, "external_thread_id"),
    threadId: str(row, "thread_id"),
    updatedAt: num(row, "updated_at"),
  };
}

function toTriggerType(val: string): AutomationTriggerType {
  if (val === "cron" || val === "once") {
    return val;
  }
  throw new Error(`Unexpected automation trigger_type "${val}"`);
}

function toRunStatus(val: string): AutomationRunStatus {
  if (
    val === "running_script" ||
    val === "skipped" ||
    val === "running_agent" ||
    val === "succeeded" ||
    val === "failed" ||
    val === "timed_out"
  ) {
    return val;
  }
  throw new Error(`Unexpected automation run status "${val}"`);
}

function toAutomation(row: SqlRow): AutomationRecord {
  return {
    id: str(row, "id"),
    agentSlug: str(row, "agent_slug"),
    name: str(row, "name"),
    enabled: num(row, "enabled") !== 0,
    triggerType: toTriggerType(str(row, "trigger_type")),
    cronExpr: nullableStr(row, "cron_expr"),
    runAt: nullableNum(row, "run_at"),
    timezone: str(row, "timezone"),
    scriptCommand: nullableStr(row, "script_command"),
    scriptTimeoutMs: num(row, "script_timeout_ms"),
    targetThreadId: nullableStr(row, "target_thread_id"),
    harnessOverride: nullableStr(row, "harness_override"),
    modelOverride: nullableStr(row, "model_override"),
    prompt: nullableStr(row, "prompt"),
    deliverTarget: nullableStr(row, "deliver_target"),
    lastCursorAt: nullableNum(row, "last_cursor_at"),
    nextRunAt: nullableNum(row, "next_run_at"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

function toAutomationRun(row: SqlRow): AutomationRunRecord {
  return {
    id: str(row, "id"),
    automationId: str(row, "automation_id"),
    agentSlug: str(row, "agent_slug"),
    status: toRunStatus(str(row, "status")),
    scriptExitCode: nullableNum(row, "script_exit_code"),
    scriptStdout: nullableStr(row, "script_stdout"),
    scriptStderr: nullableStr(row, "script_stderr"),
    threadId: nullableStr(row, "thread_id"),
    error: nullableStr(row, "error"),
    startedAt: num(row, "started_at"),
    endedAt: nullableNum(row, "ended_at"),
  };
}

export class AnvaStore {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(SCHEMA_MIGRATIONS_SQL);
    const versionRow = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations")
      .get() as SqlRow;
    const currentVersion = num(versionRow, "v");
    if (currentVersion > SCHEMA_VERSION) {
      throw new AnvaError(
        "db_schema_newer",
        `Database schema v${currentVersion} is newer than this Anva build (v${SCHEMA_VERSION}). Upgrade Anva before starting.`,
        500,
      );
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) {
        continue;
      }
      this.db.exec("BEGIN;");
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, Date.now());
        this.db.exec("COMMIT;");
      } catch (error) {
        this.db.exec("ROLLBACK;");
        throw error;
      }
    }
  }

  createAgent(input: {
    readonly slug: string;
    readonly name: string;
    readonly defaultHarness: string;
    readonly defaultModel?: string | null;
  }): AgentRecord {
    const existing = this.getAgent(input.slug);
    if (existing) {
      throw new AnvaError("agent_already_exists", `Agent "${input.slug}" already exists.`, 409);
    }
    const now = Date.now();
    const defaultModel = input.defaultModel ?? null;
    this.db
      .prepare(
        "INSERT INTO agents (slug, name, default_harness, default_model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(input.slug, input.name, input.defaultHarness, defaultModel, now, now);
    return {
      slug: input.slug,
      name: input.name,
      defaultHarness: input.defaultHarness,
      defaultModel,
      createdAt: now,
      updatedAt: now,
    };
  }

  getAgent(slug: string): AgentRecord | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE slug = ?").get(slug) as
      | SqlRow
      | undefined;
    return row ? toAgent(row) : null;
  }

  listAgents(): AgentRecord[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY created_at ASC").all() as SqlRow[];
    return rows.map(toAgent);
  }

  updateAgent(
    slug: string,
    patch: {
      readonly name?: string;
      readonly defaultHarness?: string;
      readonly defaultModel?: string | null;
    },
  ): AgentRecord {
    const current = this.getAgent(slug);
    if (!current) {
      throw new AnvaError("agent_not_found", `Agent "${slug}" was not found.`, 404);
    }
    const now = Date.now();
    const row = this.db
      .prepare(
        "UPDATE agents SET name = ?, default_harness = ?, default_model = ?, updated_at = ? WHERE slug = ? RETURNING *",
      )
      .get(
        patch.name ?? current.name,
        patch.defaultHarness ?? current.defaultHarness,
        patch.defaultModel !== undefined ? patch.defaultModel : current.defaultModel,
        now,
        slug,
      ) as SqlRow;
    return toAgent(row);
  }

  createThread(input: {
    readonly agentSlug: string;
    readonly title?: string;
    readonly source?: ThreadSource;
    readonly harness: string;
    readonly model?: string | null;
  }): ThreadRecord {
    const id = createId("th");
    const now = Date.now();
    const title = input.title ?? "";
    const source = input.source ?? "cli";
    const model = input.model ?? null;
    this.db
      .prepare(
        "INSERT INTO threads (id, agent_slug, title, source, harness, model, native_session_id, last_activity_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
      )
      .run(id, input.agentSlug, title, source, input.harness, model, now, now, now);
    return {
      id,
      agentSlug: input.agentSlug,
      title,
      source,
      harness: input.harness,
      model,
      nativeSessionId: null,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  getThread(id: string): ThreadRecord | null {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as SqlRow | undefined;
    return row ? toThread(row) : null;
  }

  listThreads(
    options: { readonly agentSlug?: string; readonly limit?: number } = {},
  ): ThreadRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    if (options.agentSlug) {
      const rows = this.db
        .prepare(
          "SELECT * FROM threads WHERE agent_slug = ? ORDER BY last_activity_at DESC LIMIT ?",
        )
        .all(options.agentSlug, limit) as SqlRow[];
      return rows.map(toThread);
    }
    const rows = this.db
      .prepare("SELECT * FROM threads ORDER BY last_activity_at DESC LIMIT ?")
      .all(limit) as SqlRow[];
    return rows.map(toThread);
  }

  updateThreadModel(id: string, model: string | null): ThreadRecord {
    const now = Date.now();
    const row = this.db
      .prepare("UPDATE threads SET model = ?, updated_at = ? WHERE id = ? RETURNING *")
      .get(model, now, id) as SqlRow | undefined;
    if (!row) {
      throw new AnvaError("thread_not_found", `Thread "${id}" was not found.`, 404);
    }
    return toThread(row);
  }

  updateThreadTitle(id: string, title: string): ThreadRecord {
    const now = Date.now();
    const row = this.db
      .prepare("UPDATE threads SET title = ?, updated_at = ? WHERE id = ? RETURNING *")
      .get(title, now, id) as SqlRow | undefined;
    if (!row) {
      throw new AnvaError("thread_not_found", `Thread "${id}" was not found.`, 404);
    }
    return toThread(row);
  }

  setThreadNativeSessionId(id: string, nativeSessionId: string): void {
    const now = Date.now();
    this.db
      .prepare("UPDATE threads SET native_session_id = ?, updated_at = ? WHERE id = ?")
      .run(nativeSessionId, now, id);
  }

  touchThread(id: string, at = Date.now()): void {
    this.db
      .prepare("UPDATE threads SET last_activity_at = ?, updated_at = ? WHERE id = ?")
      .run(at, at, id);
  }

  insertMessage(input: {
    readonly agentSlug: string;
    readonly threadId: string;
    readonly role: MessageRole;
    readonly content: string;
  }): MessageRecord {
    const id = createId("msg");
    const now = Date.now();
    const info = this.db
      .prepare(
        "INSERT INTO messages (id, agent_slug, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.agentSlug, input.threadId, input.role, input.content, now);
    const rowid = Number(info.lastInsertRowid);
    return {
      rowid,
      id,
      agentSlug: input.agentSlug,
      threadId: input.threadId,
      role: input.role,
      content: input.content,
      createdAt: now,
    };
  }

  listMessages(threadId: string, tail = 20): MessageRecord[] {
    const limit = Math.max(1, Math.min(tail, 1000));
    const rows = this.db
      .prepare(
        "SELECT * FROM (SELECT * FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY rowid ASC",
      )
      .all(threadId, limit) as SqlRow[];
    return rows.map(toMessage);
  }

  listMessagesAroundRowid(
    threadId: string,
    rowid: number,
    window = 2,
  ): { readonly before: MessageRecord[]; readonly after: MessageRecord[] } {
    const beforeRows = this.db
      .prepare(
        "SELECT * FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?",
      )
      .all(threadId, rowid, window) as SqlRow[];
    const afterRows = this.db
      .prepare(
        "SELECT * FROM messages WHERE thread_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?",
      )
      .all(threadId, rowid, window) as SqlRow[];
    return {
      before: beforeRows.reverse().map(toMessage),
      after: afterRows.map(toMessage),
    };
  }

  rebuildFts(): void {
    this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');");
  }

  createChannelConnection(input: {
    readonly platform: string;
    readonly agentSlug: string;
    readonly botId?: string | null;
    readonly botName?: string | null;
    readonly envKey?: string;
  }): ChannelConnectionRecord {
    const id = createId("ch");
    const now = Date.now();
    const botId = input.botId ?? null;
    const botName = input.botName ?? null;
    const envKey = input.envKey ?? "TELEGRAM_BOT_TOKEN";
    this.db
      .prepare(
        "INSERT INTO channel_connections (id, platform, agent_slug, bot_id, bot_name, env_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.platform, input.agentSlug, botId, botName, envKey, now, now);
    return {
      id,
      platform: input.platform,
      agentSlug: input.agentSlug,
      botId,
      botName,
      envKey,
      createdAt: now,
      updatedAt: now,
    };
  }

  getChannelConnection(id: string): ChannelConnectionRecord | null {
    const row = this.db.prepare("SELECT * FROM channel_connections WHERE id = ?").get(id) as
      | SqlRow
      | undefined;
    return row ? toChannelConnection(row) : null;
  }

  findChannelConnection(platform: string, agentSlug: string): ChannelConnectionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM channel_connections WHERE platform = ? AND agent_slug = ?")
      .get(platform, agentSlug) as SqlRow | undefined;
    return row ? toChannelConnection(row) : null;
  }

  listChannelConnections(agentSlug?: string): ChannelConnectionRecord[] {
    if (agentSlug) {
      const rows = this.db
        .prepare("SELECT * FROM channel_connections WHERE agent_slug = ? ORDER BY created_at ASC")
        .all(agentSlug) as SqlRow[];
      return rows.map(toChannelConnection);
    }
    const rows = this.db
      .prepare("SELECT * FROM channel_connections ORDER BY created_at ASC")
      .all() as SqlRow[];
    return rows.map(toChannelConnection);
  }

  updateChannelConnection(
    id: string,
    patch: {
      readonly botId?: string | null;
      readonly botName?: string | null;
      readonly envKey?: string;
    },
  ): ChannelConnectionRecord {
    const current = this.getChannelConnection(id);
    if (!current) {
      throw new AnvaError("channel_not_found", `Channel connection "${id}" was not found.`, 404);
    }
    const now = Date.now();
    const row = this.db
      .prepare(
        "UPDATE channel_connections SET bot_id = ?, bot_name = ?, env_key = ?, updated_at = ? WHERE id = ? RETURNING *",
      )
      .get(
        patch.botId !== undefined ? patch.botId : current.botId,
        patch.botName !== undefined ? patch.botName : current.botName,
        patch.envKey ?? current.envKey,
        now,
        id,
      ) as SqlRow;
    return toChannelConnection(row);
  }

  deleteChannelConnection(id: string): boolean {
    const info = this.db.prepare("DELETE FROM channel_connections WHERE id = ?").run(id);
    return Number(info.changes) > 0;
  }

  upsertChannelRoute(input: {
    readonly connectionId: string;
    readonly externalChatId: string;
    readonly externalThreadId: string;
    readonly threadId: string;
  }): ChannelRouteRecord {
    const id = createId("rt");
    const now = Date.now();
    const row = this.db
      .prepare(
        `INSERT INTO channel_routes (id, connection_id, external_chat_id, external_thread_id, thread_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(connection_id, external_chat_id, external_thread_id)
         DO UPDATE SET thread_id = excluded.thread_id, updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get(
        id,
        input.connectionId,
        input.externalChatId,
        input.externalThreadId,
        input.threadId,
        now,
      ) as SqlRow;
    return toChannelRoute(row);
  }

  getChannelRoute(
    connectionId: string,
    externalChatId: string,
    externalThreadId: string,
  ): ChannelRouteRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM channel_routes WHERE connection_id = ? AND external_chat_id = ? AND external_thread_id = ?",
      )
      .get(connectionId, externalChatId, externalThreadId) as SqlRow | undefined;
    return row ? toChannelRoute(row) : null;
  }

  getChannelRouteByThread(threadId: string): ChannelRouteRecord | null {
    const row = this.db
      .prepare("SELECT * FROM channel_routes WHERE thread_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(threadId) as SqlRow | undefined;
    return row ? toChannelRoute(row) : null;
  }

  deleteChannelRoute(
    connectionId: string,
    externalChatId: string,
    externalThreadId: string,
  ): boolean {
    const info = this.db
      .prepare(
        "DELETE FROM channel_routes WHERE connection_id = ? AND external_chat_id = ? AND external_thread_id = ?",
      )
      .run(connectionId, externalChatId, externalThreadId);
    return Number(info.changes) > 0;
  }

  createAutomation(input: {
    readonly agentSlug: string;
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
    readonly nextRunAt: number | null;
  }): AutomationRecord {
    const id = createId("au");
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO automations (
          id, agent_slug, name, enabled, trigger_type, cron_expr, run_at, timezone,
          script_command, script_timeout_ms, target_thread_id,
          harness_override, model_override, prompt, deliver_target,
          last_cursor_at, next_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.agentSlug,
        input.name,
        input.enabled ? 1 : 0,
        input.triggerType,
        input.cronExpr,
        input.runAt,
        input.timezone,
        input.scriptCommand,
        input.scriptTimeoutMs,
        input.targetThreadId,
        input.harnessOverride,
        input.modelOverride,
        input.prompt,
        input.deliverTarget,
        input.nextRunAt,
        now,
        now,
      );
    return {
      id,
      ...input,
      lastCursorAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  getAutomation(id: string): AutomationRecord | null {
    const row = this.db.prepare("SELECT * FROM automations WHERE id = ?").get(id) as
      | SqlRow
      | undefined;
    return row ? toAutomation(row) : null;
  }

  listAutomations(agentSlug?: string): AutomationRecord[] {
    if (agentSlug) {
      const rows = this.db
        .prepare("SELECT * FROM automations WHERE agent_slug = ? ORDER BY created_at DESC")
        .all(agentSlug) as SqlRow[];
      return rows.map(toAutomation);
    }
    const rows = this.db
      .prepare("SELECT * FROM automations ORDER BY created_at DESC")
      .all() as SqlRow[];
    return rows.map(toAutomation);
  }

  listDueAutomations(nowMs: number): AutomationRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC",
      )
      .all(nowMs) as SqlRow[];
    return rows.map(toAutomation);
  }

  updateAutomation(
    id: string,
    patch: {
      readonly name?: string;
      readonly enabled?: boolean;
      readonly triggerType?: AutomationTriggerType;
      readonly cronExpr?: string | null;
      readonly runAt?: number | null;
      readonly timezone?: string;
      readonly scriptCommand?: string | null;
      readonly scriptTimeoutMs?: number;
      readonly targetThreadId?: string | null;
      readonly harnessOverride?: string | null;
      readonly modelOverride?: string | null;
      readonly prompt?: string | null;
      readonly deliverTarget?: string | null;
      readonly nextRunAt?: number | null;
    },
  ): AutomationRecord {
    const cur = this.getAutomation(id);
    if (!cur) {
      throw new AnvaError("automation_not_found", `Automation "${id}" was not found.`, 404);
    }
    const now = Date.now();
    const row = this.db
      .prepare(
        `UPDATE automations SET
          name = ?, enabled = ?, trigger_type = ?, cron_expr = ?, run_at = ?, timezone = ?,
          script_command = ?, script_timeout_ms = ?, target_thread_id = ?,
          harness_override = ?, model_override = ?, prompt = ?, deliver_target = ?,
          next_run_at = ?, updated_at = ?
        WHERE id = ?
        RETURNING *`,
      )
      .get(
        patch.name ?? cur.name,
        (patch.enabled ?? cur.enabled) ? 1 : 0,
        patch.triggerType ?? cur.triggerType,
        patch.cronExpr !== undefined ? patch.cronExpr : cur.cronExpr,
        patch.runAt !== undefined ? patch.runAt : cur.runAt,
        patch.timezone ?? cur.timezone,
        patch.scriptCommand !== undefined ? patch.scriptCommand : cur.scriptCommand,
        patch.scriptTimeoutMs ?? cur.scriptTimeoutMs,
        patch.targetThreadId !== undefined ? patch.targetThreadId : cur.targetThreadId,
        patch.harnessOverride !== undefined ? patch.harnessOverride : cur.harnessOverride,
        patch.modelOverride !== undefined ? patch.modelOverride : cur.modelOverride,
        patch.prompt !== undefined ? patch.prompt : cur.prompt,
        patch.deliverTarget !== undefined ? patch.deliverTarget : cur.deliverTarget,
        patch.nextRunAt !== undefined ? patch.nextRunAt : cur.nextRunAt,
        now,
        id,
      ) as SqlRow;
    return toAutomation(row);
  }

  advanceAutomationSchedule(
    id: string,
    input: {
      readonly enabled: boolean;
      readonly nextRunAt: number | null;
      readonly updatedAt: number;
    },
  ): void {
    this.db
      .prepare("UPDATE automations SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(input.enabled ? 1 : 0, input.nextRunAt, input.updatedAt, id);
  }

  deleteAutomation(id: string): boolean {
    const info = this.db.prepare("DELETE FROM automations WHERE id = ?").run(id);
    return Number(info.changes) > 0;
  }

  createAutomationRun(input: {
    readonly automationId: string;
    readonly agentSlug: string;
    readonly status: AutomationRunStatus;
    readonly error?: string | null;
    readonly startedAt?: number;
    readonly endedAt?: number | null;
  }): AutomationRunRecord {
    const id = createId("ar");
    const startedAt = input.startedAt ?? Date.now();
    const error = input.error ?? null;
    const endedAt = input.endedAt ?? null;
    this.db
      .prepare(
        "INSERT INTO automation_runs (id, automation_id, agent_slug, status, error, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.automationId, input.agentSlug, input.status, error, startedAt, endedAt);
    return {
      id,
      automationId: input.automationId,
      agentSlug: input.agentSlug,
      status: input.status,
      scriptExitCode: null,
      scriptStdout: null,
      scriptStderr: null,
      threadId: null,
      error,
      startedAt,
      endedAt,
    };
  }

  getAutomationRun(id: string): AutomationRunRecord | null {
    const row = this.db.prepare("SELECT * FROM automation_runs WHERE id = ?").get(id) as
      | SqlRow
      | undefined;
    return row ? toAutomationRun(row) : null;
  }

  updateAutomationRun(
    id: string,
    patch: {
      readonly status?: AutomationRunStatus;
      readonly scriptExitCode?: number | null;
      readonly scriptStdout?: string | null;
      readonly scriptStderr?: string | null;
      readonly threadId?: string | null;
      readonly error?: string | null;
      readonly endedAt?: number | null;
    },
  ): AutomationRunRecord {
    const cur = this.getAutomationRun(id);
    if (!cur) {
      throw new AnvaError("automation_run_not_found", `Automation run "${id}" was not found.`, 404);
    }
    const row = this.db
      .prepare(
        `UPDATE automation_runs SET
          status = ?, script_exit_code = ?, script_stdout = ?, script_stderr = ?,
          thread_id = ?, error = ?, ended_at = ?
        WHERE id = ?
        RETURNING *`,
      )
      .get(
        patch.status ?? cur.status,
        patch.scriptExitCode !== undefined ? patch.scriptExitCode : cur.scriptExitCode,
        patch.scriptStdout !== undefined ? patch.scriptStdout : cur.scriptStdout,
        patch.scriptStderr !== undefined ? patch.scriptStderr : cur.scriptStderr,
        patch.threadId !== undefined ? patch.threadId : cur.threadId,
        patch.error !== undefined ? patch.error : cur.error,
        patch.endedAt !== undefined ? patch.endedAt : cur.endedAt,
        id,
      ) as SqlRow;
    return toAutomationRun(row);
  }

  listAutomationRuns(automationId: string, limit = 20): AutomationRunRecord[] {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const rows = this.db
      .prepare(
        "SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?",
      )
      .all(automationId, safeLimit) as SqlRow[];
    return rows.map(toAutomationRun);
  }

  markAutomationCursor(id: string, cursorAt: number): void {
    this.db
      .prepare("UPDATE automations SET last_cursor_at = ?, updated_at = ? WHERE id = ?")
      .run(cursorAt, cursorAt, id);
  }

  recoverStaleAutomationRuns(nowMs = Date.now()): number {
    const info = this.db
      .prepare(
        `UPDATE automation_runs
         SET status = 'failed', error = 'Daemon restarted before run completed', ended_at = ?
         WHERE status IN ('running_script', 'running_agent')`,
      )
      .run(nowMs);
    return Number(info.changes);
  }

  close(): void {
    this.db.close();
  }
}
