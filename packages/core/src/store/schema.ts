export const SCHEMA_VERSION = 4;

export const SCHEMA_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
) STRICT;
`;

export interface SchemaMigration {
  readonly version: number;
  readonly sql: string;
}

export const MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS agents (
  slug            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  default_harness TEXT NOT NULL,
  default_model   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS threads (
  id                TEXT PRIMARY KEY,
  agent_slug        TEXT NOT NULL REFERENCES agents(slug) ON DELETE CASCADE,
  title             TEXT NOT NULL DEFAULT '',
  source            TEXT NOT NULL DEFAULT 'cli',
  harness           TEXT NOT NULL,
  model             TEXT,
  native_session_id TEXT,
  last_activity_at  INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_threads_agent_activity ON threads(agent_slug, last_activity_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  rowid      INTEGER PRIMARY KEY,
  id         TEXT NOT NULL UNIQUE,
  agent_slug TEXT NOT NULL REFERENCES agents(slug) ON DELETE CASCADE,
  thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_messages_thread_rowid ON messages(thread_id, rowid);
CREATE INDEX IF NOT EXISTS idx_messages_agent_time ON messages(agent_slug, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`,
  },
  {
    version: 2,
    sql: `
CREATE TABLE IF NOT EXISTS channel_connections (
  id         TEXT PRIMARY KEY,
  platform   TEXT NOT NULL,
  agent_slug TEXT NOT NULL REFERENCES agents(slug) ON DELETE CASCADE,
  bot_id     TEXT,
  bot_name   TEXT,
  env_key    TEXT NOT NULL DEFAULT 'TELEGRAM_BOT_TOKEN',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS channel_routes (
  id                 TEXT PRIMARY KEY,
  connection_id      TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
  external_chat_id   TEXT NOT NULL,
  external_thread_id TEXT NOT NULL DEFAULT '',
  thread_id          TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  updated_at         INTEGER NOT NULL,
  UNIQUE(connection_id, external_chat_id, external_thread_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_routes_thread ON channel_routes(thread_id);
`,
  },
  {
    version: 3,
    sql: `
CREATE TABLE IF NOT EXISTS automations (
  id                TEXT PRIMARY KEY,
  agent_slug        TEXT NOT NULL REFERENCES agents(slug) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  trigger_type      TEXT NOT NULL,
  cron_expr         TEXT,
  run_at            INTEGER,
  timezone          TEXT NOT NULL DEFAULT 'UTC',
  script_command    TEXT,
  script_timeout_ms INTEGER NOT NULL DEFAULT 60000,
  target_kind       TEXT,
  target_thread_id  TEXT REFERENCES threads(id) ON DELETE SET NULL,
  harness_override  TEXT,
  model_override    TEXT,
  prompt            TEXT,
  deliver_target    TEXT,
  last_cursor_at    INTEGER,
  next_run_at       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_automations_due ON automations(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS automation_runs (
  id               TEXT PRIMARY KEY,
  automation_id    TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  agent_slug       TEXT NOT NULL REFERENCES agents(slug) ON DELETE CASCADE,
  status           TEXT NOT NULL,
  script_exit_code INTEGER,
  script_stdout    TEXT,
  script_stderr    TEXT,
  thread_id        TEXT REFERENCES threads(id) ON DELETE SET NULL,
  error            TEXT,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS idx_aruns_auto ON automation_runs(automation_id, started_at DESC);
`,
  },
  {
    version: 4,
    sql: `
ALTER TABLE automations DROP COLUMN target_kind;
`,
  },
];
