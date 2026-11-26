import { spawn } from "node:child_process";
import { AnvaError } from "../errors.ts";

const MAX_CAPTURE_CHARS = 256 * 1024;
const SIGKILL_GRACE_MS = 1500;

export interface ScriptExecOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ScriptExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface PreflightOutcome {
  readonly runAgent: boolean;
  readonly context?: unknown;
}

function appendCapped(current: string, chunk: string): string {
  if (current.length >= MAX_CAPTURE_CHARS) {
    return current;
  }
  const remaining = MAX_CAPTURE_CHARS - current.length;
  return chunk.length <= remaining ? current + chunk : current + chunk.slice(0, remaining);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

export function runPreflightScript(options: ScriptExecOptions): Promise<ScriptExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", options.command], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killEscalationTimer: ReturnType<typeof setTimeout> | null = null;

    const terminateGroup = () => {
      if (!child.pid) {
        return;
      }
      signalProcessGroup(child.pid, "SIGTERM");
      if (!killEscalationTimer) {
        killEscalationTimer = setTimeout(() => {
          if (child.pid) {
            signalProcessGroup(child.pid, "SIGKILL");
          }
        }, SIGKILL_GRACE_MS);
        killEscalationTimer.unref();
      }
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateGroup();
    }, options.timeoutMs);
    timeoutTimer.unref();

    const onAbort = () => {
      terminateGroup();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      terminateGroup();
    }

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killEscalationTimer) {
        clearTimeout(killEscalationTimer);
        killEscalationTimer = null;
      }
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

export function parsePreflightJson(stdout: string): PreflightOutcome {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1);
  if (!lastLine) {
    throw new AnvaError(
      "preflight_invalid_json",
      'Preflight script produced no output; last non-empty stdout line must be {"runAgent": boolean, "context"?: ...}.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    throw new AnvaError(
      "preflight_invalid_json",
      `Preflight script last stdout line is not valid JSON: ${lastLine.slice(0, 120)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AnvaError(
      "preflight_invalid_json",
      'Preflight script JSON must be an object with boolean "runAgent".',
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.runAgent !== "boolean") {
    throw new AnvaError(
      "preflight_invalid_json",
      'Preflight script JSON requires a boolean "runAgent" field.',
    );
  }
  return {
    runAgent: obj.runAgent,
    ...("context" in obj ? { context: obj.context } : {}),
  };
}
