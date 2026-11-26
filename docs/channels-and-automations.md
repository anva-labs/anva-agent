# Channels and automations

## Telegram channel

Anva connects to Telegram in **DM-only, outbound-only** mode — no public IP, domain, reverse proxy, or inbound webhook is required.

### Prerequisites

1. Create a bot with `@BotFather` in Telegram.
2. _(Optional, recommended)_ Enable **Threaded Mode** for the bot in `@BotFather` (`Bot Settings -> Threaded Mode`) so each Telegram DM topic maps 1:1 to a separate Anva thread.

### Connect a bot and pair the owner

Attach a bot token to an agent (either pass `--token` inline to store it in `~/.anva/agents/<slug>/.env`, or set `TELEGRAM_BOT_TOKEN` beforehand via `anva agent env set`):

```sh
anva channel connect telegram --agent main --token <TELEGRAM_BOT_TOKEN>
```

Optional flags:

- `--env-key <VAR_NAME>`: read the bot token from a custom `.env` variable instead of `TELEGRAM_BOT_TOKEN`.
- `--json`: print structured connection metadata.

Inspect or disconnect active channels:

```sh
anva channel list [--agent main]
anva channel disconnect <connection_id>
```

### Fail-closed authentication

Telegram bots reject all inbound messages by default whenever `TELEGRAM_ALLOWED_USER_IDS` is empty or unset in the agent's `.env`.

When you run `anva channel connect telegram` on an agent with no allowed user IDs yet, Anva prints a single-use pairing link valid for **10 minutes**:

```text
https://t.me/<bot>?start=<code>
```

Opening that link in Telegram and tapping **Start** authorizes your Telegram user ID in `~/.anva/agents/<slug>/.env` (`TELEGRAM_ALLOWED_USER_IDS`) and immediately enables DM access.

You can also manage the allowlist manually as a comma-separated list:

```sh
anva agent env set main TELEGRAM_ALLOWED_USER_IDS "123456789,987654321"
```

### Interaction behavior

- **1:1 thread mapping**: Each DM chat (or each `message_thread_id` in Threaded Mode) maps to a single persistent Anva thread. Topics can be renamed anytime with `anva thread rename`.
- **Immediate delivery & concurrent steer**: Inbound messages are delivered immediately without artificial buffering. Sending another message while a turn is running steers the active turn (marked with `👍`) rather than generating duplicate replies.
- **Reactions, live text segments, and tool trace**: Inbound messages receive a `👀` reaction and typing indicators. Assistant text emitted before a tool call is sent as its own live message; Anva also updates a single status message with live tool progress (for example `🔧 read → bash → edit`).
- **Message formatting**: Replies and proactive text use [Rich Messages](https://core.telegram.org/bots/api#rich-messages), which require Bot API 10.1 or later. Anva sends each text message as a single Markdown payload. Telegram renders native tables, supported HTML tags, and standalone media links according to its [Rich Markdown rules](https://core.telegram.org/bots/api#rich-markdown-style). Telegram rejects messages that exceed its [rich message limits](https://core.telegram.org/bots/api#rich-message-limits).
- **Attachments**: Inbound files are saved under `~/.anva/agents/<slug>/attachments/`, and supported images (`png`, `jpeg`, `gif`, `webp`) are passed natively when the thread's agent supports image input.
- **Proactive delivery**: Normal replies in a bound conversation are delivered automatically. For out-of-band messages or files from inside a script or another thread, use:

```sh
anva channel send [<target>] ["<message>"] [--file <path>] [--thread <id>] [--agent <slug>]
```

Inside an active session, `<target>` defaults to `$ANVA_THREAD_ID`; explicitly pass `th_xxx` or `<chatId>[:<topicId>]` to target another conversation.

### Slash commands (zero model tokens)

| Command          | Behavior                                                                            |
| ---------------- | ----------------------------------------------------------------------------------- |
| `/new [harness]` | Unbind the current thread (or start a fresh thread on `<harness>`)                  |
| `/stop`          | Abort the active turn on the current thread                                         |
| `/model [model]` | List `/model <id>` options for the current harness, or switch to `<id>` / `default` |
| `/status`        | Display the thread's harness, model, runtime state, and context usage               |
| `/usage`         | Query harness auth status and subscription quota windows                            |

---

## Script-first automations

Automations run recurring (`cron`) or one-shot (`once`) schedules inside the daemon.

### Trigger modes

- **Pure script** (`--script`, omit `--prompt`): Runs a shell command (`sh -c`) in `~/.anva/agents/<slug>/`. Non-empty stdout is delivered if a delivery target is configured.
- **Script preflight + agent** (`--script` and `--prompt`): Runs the script first at zero token cost. The script must print a single JSON object on its **last non-empty stdout line**:
  - `{"runAgent": false}` — marks the run `skipped` and exits without waking an agent.
  - `{"runAgent": true, "context": ...}` — wakes the agent with `--prompt` plus the serialized `context` payload.
- **Prompt-only** (`--prompt`, omit `--script`): Wakes the agent directly on each trigger.

### Injected environment and process isolation

Scripts execute inside `~/.anva/agents/<slug>/` with the agent's `.env` plus:

- `ANVA_API`: local IPC base URL
- `ANVA_TOKEN`: daemon Bearer token
- `ANVA_AGENT_SLUG`: owning agent slug
- `ANVA_AUTOMATION_ID`: automation ID (`au_xxx`)
- `ANVA_RUN_ID`: current run ID (`ar_xxx`)
- `ANVA_LAST_RUN_AT`: epoch millisecond cursor of the previous run (when present)

Scripts run in an isolated process group and terminate cleanly along with any child processes if they exceed `--timeout-ms` (default `60000`, range `100`–`3600000`).

### Concurrency and delivery

- **Fixed `skip` overlap policy**: If a prior run for the same automation is still active, the scheduled tick is recorded as `skipped` instead of queuing concurrent runs.
- **Delivery targets (`--deliver`)**: Accepts `th_xxx`, `<chatId>[:<topicId>]`, or `none`. When created from inside an active session (`ANVA_THREAD_ID` set), `--deliver` defaults to that originating thread; outside a session it defaults to no channel delivery.
- **Silent suppression (`NO_REPLY`)**: In prompt-driven automations, if the agent determines there is nothing actionable to report, replying with the exact string `NO_REPLY` suppresses channel delivery while still recording the run as `succeeded`.

### Examples

Create a zero-token preflight automation that wakes the agent only when new items appear:

```sh
anva automation create \
  --agent main \
  --name "Inbox check" \
  --cron "*/15 * * * *" \
  --timezone "Asia/Shanghai" \
  --script 'node scripts/check-inbox.mjs' \
  --prompt "Review the new items in context and summarize anything urgent. Reply NO_REPLY if nothing requires attention."
```

Schedule a one-shot reminder or run-once task:

```sh
anva automation create \
  --agent main \
  --name "Release follow-up" \
  --once "2026-12-01T09:00:00Z" \
  --thread th_xxx \
  --prompt "Check whether the release tag is live."
```

Manage, dry-run, and inspect execution history:

```sh
anva automation list [--agent main]
anva automation test <au_xxx>
anva automation runs <au_xxx> [--limit 20]
anva automation update <au_xxx> [--disabled | --enabled] [--cron "..."] [--deliver none]
anva automation delete <au_xxx>
```
