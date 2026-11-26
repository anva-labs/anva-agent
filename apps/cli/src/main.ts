#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANVA_VERSION, AnvaError } from "@anva/core";
import { type CommandDef, defineCommand, renderUsage, runCommand } from "citty";
import { agentCommand } from "./commands/agent.ts";
import { automationCommand } from "./commands/automation.ts";
import { channelCommand } from "./commands/channel.ts";
import { serviceCommand } from "./commands/service.ts";
import { sessionCommand } from "./commands/session.ts";
import { askCommand, dbCommand, harnessesCommand, startCommand } from "./commands/system.ts";
import { threadCommand } from "./commands/thread.ts";
import { type CliResult, runWithCliRuntime } from "./context.ts";

export type { CliResult } from "./context.ts";

export const mainCommand = defineCommand({
  meta: {
    name: "anva",
    version: ANVA_VERSION,
    description: "Always-on personal agents, powered by the coding CLIs you already use",
  },
  subCommands: {
    start: startCommand,
    service: serviceCommand,
    harnesses: harnessesCommand,
    agent: agentCommand,
    ask: askCommand,
    thread: threadCommand,
    session: sessionCommand,
    channel: channelCommand,
    automation: automationCommand,
    db: dbCommand,
  },
});

async function resolveValue<T>(val: T | Promise<T> | (() => T | Promise<T>)): Promise<T> {
  if (typeof val === "function") {
    return (val as () => T | Promise<T>)();
  }
  return val;
}

async function resolveCommandPath(
  root: CommandDef,
  argv: readonly string[],
): Promise<{
  readonly cmd: CommandDef;
  readonly parent?: CommandDef;
  readonly leafOffset: number;
}> {
  let current: CommandDef = root;
  let parent: CommandDef | undefined;
  let idx = 0;

  while (idx < argv.length) {
    const subs = current.subCommands ? await resolveValue(current.subCommands) : undefined;
    if (!subs || Object.keys(subs).length === 0) {
      break;
    }
    const token = argv[idx];
    if (!token || token.startsWith("-")) {
      idx += 1;
      continue;
    }
    const nextSub = token in subs ? await resolveValue(subs[token]) : undefined;
    if (!nextSub) {
      break;
    }
    parent = current;
    current = nextSub;
    idx += 1;
  }

  return { cmd: current, parent, leafOffset: idx };
}

/** Move flags before `--` when a positional looks like a negative number (e.g. Telegram chat ID). */
async function prepareArgvForCitty(argv: readonly string[], root: CommandDef): Promise<string[]> {
  if (argv.includes("--") || !argv.some((a) => /^-\d/.test(a))) {
    return [...argv];
  }
  const { cmd, leafOffset } = await resolveCommandPath(root, argv);
  const argsDef = cmd.args ? await resolveValue(cmd.args) : {};
  const valueFlags = new Set<string>();
  for (const [key, def] of Object.entries(argsDef)) {
    if (def.type === "string" || def.type === "enum") {
      valueFlags.add(key);
    }
  }

  const head = argv.slice(0, leafOffset);
  const flags: string[] = [];
  const positionals: string[] = [];
  const tail = argv.slice(leafOffset);

  for (let i = 0; i < tail.length; i += 1) {
    const token = tail[i]!;
    if (token.startsWith("-") && !/^-\d/.test(token)) {
      flags.push(token);
      if (!token.includes("=")) {
        const flagName = token.replace(/^-{1,2}/, "");
        if (valueFlags.has(flagName) && i + 1 < tail.length) {
          i += 1;
          flags.push(tail[i]!);
        }
      }
      continue;
    }
    positionals.push(token);
  }

  return [...head, ...flags, "--", ...positionals];
}

function hasRootFlag(argv: readonly string[], names: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") {
      break;
    }
    if (names.includes(arg)) {
      return true;
    }
  }
  return false;
}

export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode = 0;

  await runWithCliRuntime(
    {
      env,
      writeOut: (text) => stdoutChunks.push(text),
      writeErr: (text) => stderrChunks.push(text),
      setExitCode: (code) => {
        exitCode = code;
      },
    },
    async () => {
      try {
        if (hasRootFlag(argv, ["-v", "--version"])) {
          const json = hasRootFlag(argv, ["--json"]);
          stdoutChunks.push(
            json ? JSON.stringify({ version: ANVA_VERSION }, null, 2) : ANVA_VERSION,
          );
          return;
        }

        if (argv.length === 0 || hasRootFlag(argv, ["-h", "--help"])) {
          const { cmd, parent } = await resolveCommandPath(mainCommand, argv);
          stdoutChunks.push(await renderUsage(cmd, parent));
          return;
        }

        const prepared = await prepareArgvForCitty(argv, mainCommand);
        await runCommand(mainCommand, { rawArgs: prepared });
      } catch (error) {
        exitCode = 1;
        if (error instanceof AnvaError) {
          stderrChunks.push(`error: ${error.code}\nnext: ${error.next}`);
          return;
        }
        if (error instanceof Error && error.name === "CLIError") {
          const code =
            "code" in error && error.code === "E_UNKNOWN_COMMAND"
              ? "unknown_command"
              : "invalid_args";
          stderrChunks.push(`error: ${code}\nnext: ${error.message}`);
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        stderrChunks.push(`error: invalid_cli_usage\nnext: ${msg}`);
      }
    },
  );

  return {
    exitCode,
    stdout: stdoutChunks.join("\n"),
    stderr: stderrChunks.join("\n"),
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  const selfPath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(selfPath) === realpathSync(entry);
  } catch {
    return selfPath === resolve(entry);
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  if (args[0] === "start" && !args.includes("--help") && !args.includes("-h")) {
    void runCommand(startCommand, { rawArgs: args.slice(1) });
  } else {
    void runCli(args).then((result) => {
      if (result.stdout) {
        process.stdout.write(`${result.stdout}\n`);
      }
      if (result.stderr) {
        process.stderr.write(`${result.stderr}\n`);
      }
      process.exitCode = result.exitCode;
    });
  }
}
