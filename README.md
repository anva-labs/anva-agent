# Anva Agent

**Always-on personal agents, powered by the coding CLIs you already use.**

Already using Claude Code, Codex, or Pi? Anva keeps them running on your machine with persistent memory, Telegram DMs, and scheduled automations — using the subscriptions, tools, and skills you already have.

## Why Anva

- **Use the CLIs you already pay for** — Works with Claude Code, Codex, Pi, and more on your machine. Keep your existing subscriptions, tools, and skills with no duplicate API keys.
- **The best model for every job** — No single model wins at everything. Pick the CLI or model that fits each task best, while your personal agent keeps memory and context in one place.
- **Automations that don't waste tokens** — Schedule lightweight scripts to check for updates first, and only wake your agent when something actually needs attention.

## Quick start

**Requirements:** macOS or Linux, Node.js `>=24.0.0`, pnpm 12, and at least one signed-in agent CLI (such as Claude Code, Codex, or Pi).

### 1. Build from source

```sh
git clone https://github.com/anva-labs/anva-agent.git
cd anva-agent
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @anva/cli link --global
```

### 2. Start Anva and create an agent

Install and start the background service (`launchd` on macOS, `systemd --user` on Linux), inspect detected CLIs, and send your first message:

```sh
anva service install
anva harnesses
anva agent create main --name "Main" --harness <harness-id>
anva ask main "Hello! What can you help me with?"
```

> Prefer not to install a background service yet? Run `anva start` in a separate terminal instead.

### 3. Connect Telegram (optional)

Create a bot with `@BotFather` (enabling **Threaded Mode** is recommended so each topic maps to its own thread), then connect it:

```sh
anva channel connect telegram --agent main --token <TELEGRAM_BOT_TOKEN>
```

Anva prints a one-time pairing link valid for 10 minutes. Open it in Telegram and tap **Start** to authorize your account — all other users are rejected by default.

## Inside an agent home

Each personal agent gets its own isolated directory on disk:

```text
~/.anva/agents/main/
├── PERSONA.md      # Role and instructions (editable anytime)
├── MEMORY.md       # Long-term Markdown memory
├── skills/         # Agent skills (linked to .agents/skills & .claude/skills)
├── .env            # Per-agent secrets and tokens (0600)
└── attachments/    # Files received from Telegram
```

## Documentation

| Topic                                                           | Guide                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| CLI usage, agent config, history search, and background service | [Getting started](docs/getting-started.md)                   |
| Telegram DMs, slash commands, and script-first automations      | [Channels and automations](docs/channels-and-automations.md) |
| Runtime design, SQLite schema, and security boundaries          | [Architecture](docs/architecture.md)                         |

## Security & platform notes

- **macOS and Linux only** (`>=24.0.0`); Windows is not supported.
- **Single-owner trusted host**: Agents run unattended with your OS user permissions. The local HTTP API binds to `127.0.0.1` with a per-boot Bearer token, `.env` files use mode `0600`, and Telegram rejects unapproved senders by default. Do not expose the daemon port to the public internet.

## License

[MIT](LICENSE)
