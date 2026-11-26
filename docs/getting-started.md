# Getting started

## Requirements

- **Operating system**: macOS or Linux (Windows is not supported).
- **Node.js**: `>=24.0.0`
- **pnpm**: `12.x` (matching `packageManager` in [package.json](../package.json); if you run an older version, switch with `corepack enable` or `npm i -g pnpm@12`)
- **Agent CLI**: At least one [OAR](https://github.com/botiverse/oar)-supported coding agent CLI installed and signed in locally (for example Claude Code, Codex, or Pi).

## Install from source

```sh
git clone https://github.com/anva-labs/anva-agent.git
cd anva-agent
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @anva/cli link --global
```

If you prefer not to link globally, invoke `./apps/cli/dist/main.js` directly or run `pnpm --filter @anva/cli exec anva ...`.

## Start Anva

For everyday use, install Anva as a background user service (`launchd` on macOS or `systemd --user` on Linux) — this registers and starts the daemon immediately:

```sh
anva service install [--host 127.0.0.1] [--port 3721]
anva service status
anva service logs [--lines 50] [--follow]
anva service restart [--delay 2]
anva service stop
anva service start
anva service uninstall
```

- On Linux, enable user lingering so the service survives SSH logout and reboots: `sudo loginctl enable-linger <username>`.
- `anva service uninstall` removes only the service registration and keeps all data under `~/.anva/`.

### Foreground mode & environment options

If you prefer not to install a background service, run the daemon in the foreground instead:

```sh
anva start [--host 127.0.0.1] [--port 3721]
```

Configuration is passed through flags or environment variables — there is no global config file:

- `ANVA_HOME`: root data directory (defaults to `~/.anva`).
- `ANVA_HOST`: local HTTP bind address (defaults to `127.0.0.1`).
- `ANVA_PORT`: local HTTP port (defaults to `3721`).
- `ANVA_IDLE_TTL_MS`: idle session eviction timeout in milliseconds (defaults to `900000`, 15 minutes).

## Create and configure an agent

Check which agent CLIs are detected, signed in, and within quota:

```sh
anva harnesses
```

Create a personal agent (using one of the installed IDs, such as `claude`, `codex`, or `pi`):

```sh
anva agent create main --name "Main" --harness <harness-id> [--model <model>] [--persona "Concise personal agent."]
```

This creates `~/.anva/agents/main/` with:

- `PERSONA.md`: role and instructions injected at session startup.
- `MEMORY.md`: long-term Markdown memory (editable anytime by you or the agent).
- `skills/`: agent skills directory (linked for native discovery by installed CLIs).
- `.env`: per-agent credentials and channel tokens (`0600`, ignored by `.gitignore`).
- `attachments/`: inbound channel files.

Manage agents and `.env` variables:

```sh
anva agent list
anva agent update main --model <model>
anva agent env set main GITHUB_TOKEN <value>
anva agent env list main
anva agent env unset main GITHUB_TOKEN
```

`anva agent env` edits `~/.anva/agents/<slug>/.env` directly on disk without sending secrets over the local API.

## Conversations, threads, and history

Start a new thread or continue an existing one:

```sh
anva ask main "Summarize today's git status in ~/DevProjects."
anva ask --thread <thread_id> "Now check the latest commit message."
anva ask main "Run tests in the background." --async
```

You can also override the backend for a new thread with `--harness <id>`, or switch models within an existing thread using `--model <model>`.

Inspect and manage threads:

```sh
anva thread list [--agent main]
anva thread rename <thread_id> "Repo review"
anva thread stop <thread_id>
```

Search past conversations across English and Chinese and read thread transcripts:

```sh
anva session search "deploy checklist" --agent main
anva session read <thread_id> --agent main [--tail 20] [--full]
anva db rebuild-fts
```

All query and mutation CLI commands accept `--json` for structured output (except `anva start` and `anva service logs`).

## Development checks

```sh
pnpm build   # Compile all workspace packages
pnpm check   # Build, typecheck, lint, and run all Vitest suites
pnpm fmt     # Format code with oxfmt
```
