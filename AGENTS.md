# Anva Engineering Principles

Anva is a local daemon that turns installed coding CLIs into always-on personal agents via [OAR](https://github.com/botiverse/oar), **delegating the agent loop, provider auth, and native capabilities to external harnesses while owning multi-agent homes, persistent threads, search, automation, and channel orchestration**.

## Core Principles

1. **Delegate the Harness**

   External harnesses (Claude Code, Codex, Pi, etc.) own the agent loop, model subscriptions, tools, and native skill discovery. Isolate all `@botiverse/oar` imports behind a single adapter boundary (`packages/core/src/harness/`) and preserve upstream semantics rather than re-implementing harness internals.

2. **Threads & Files First**

   Threads are first-class, long-lived conversations with direct natural replies to bound channels. A thread pins its harness at creation and always runs in its agent's home directory (`~/.anva/agents/<slug>/`). Keep agent state and secrets transparent and file-based (`PERSONA.md`, `MEMORY.md`, `skills/`, `.env`).

3. **Headless & Composable**

   Anva is headless-first and self-configurable through the `anva` CLI and local files. Built-in channels must remain outbound-only (no public inbound webhook required) and decoupled from agents and threads. Extend peripheral capabilities via CLI and script-first automations rather than embedding them into the core runtime.

4. **Lightweight & Focused**

   Pursue an architecture with **minimal concepts, short execution paths, and clear ownership**. Prefer Node.js built-ins (`node:sqlite`, `fetch`, `WebSocket`) and existing upstream primitives over new abstractions, frameworks, or speculative edge-case machinery.

For current architecture, data models, and subsystem contracts, see `docs/architecture.md`.
