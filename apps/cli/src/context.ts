import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { AnvaError, resolveAnvaPaths, type RuntimeInfoFile } from "@anva/core";

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliRuntime {
  readonly env: NodeJS.ProcessEnv;
  writeOut(text: string): void;
  writeErr(text: string): void;
  setExitCode(code: number): void;
}

const defaultRuntime: CliRuntime = {
  env: process.env,
  writeOut(text: string) {
    process.stdout.write(`${text}\n`);
  },
  writeErr(text: string) {
    process.stderr.write(`${text}\n`);
  },
  setExitCode(code: number) {
    process.exitCode = code;
  },
};

const cliRuntimeStorage = new AsyncLocalStorage<CliRuntime>();

export function runWithCliRuntime<T>(runtime: CliRuntime, fn: () => Promise<T>): Promise<T> {
  return cliRuntimeStorage.run(runtime, fn);
}

export function getCliRuntime(): CliRuntime {
  return cliRuntimeStorage.getStore() ?? defaultRuntime;
}

export function emitResult(json: boolean | undefined, data: unknown, text: string): void {
  const rt = getCliRuntime();
  rt.writeOut(json ? JSON.stringify(data, null, 2) : text);
}

export function resolveConnection(env: NodeJS.ProcessEnv): {
  readonly url: string;
  readonly token: string;
} {
  const envUrl = env.ANVA_API?.trim();
  const envToken = env.ANVA_TOKEN?.trim();
  if (envUrl && envToken) {
    return { url: envUrl.replace(/\/+$/, ""), token: envToken };
  }

  const paths = resolveAnvaPaths(env.ANVA_HOME);
  if (!existsSync(paths.runtime)) {
    throw new AnvaError(
      "anva_not_running",
      'Anva daemon is not running. Start it with "anva start".',
    );
  }
  try {
    const parsed = JSON.parse(readFileSync(paths.runtime, "utf8")) as Partial<RuntimeInfoFile>;
    if (!parsed.url || !parsed.token) {
      throw new Error("Invalid runtime.json");
    }
    return { url: parsed.url.replace(/\/+$/, ""), token: parsed.token };
  } catch {
    throw new AnvaError(
      "anva_runtime_corrupt",
      'Could not read runtime.json. Restart the daemon with "anva start".',
    );
  }
}

export async function apiRequest<T>(
  conn: { readonly url: string; readonly token: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${conn.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${conn.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new AnvaError(
      "anva_not_running",
      'Could not reach Anva daemon. Start it with "anva start".',
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("json")
    ? ((await response.json()) as unknown)
    : await response.text();

  if (!response.ok) {
    const err =
      typeof payload === "object" && payload !== null
        ? (payload as { error?: string; next?: string })
        : {};
    throw new AnvaError(
      err.error ?? `http_${response.status}`,
      err.next ?? `Daemon returned HTTP ${response.status}.`,
      response.status,
    );
  }
  return payload as T;
}

export function requireAgentScope(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  commandHint: string,
): string {
  const slug = explicit?.trim() || env.ANVA_AGENT_SLUG?.trim();
  if (!slug) {
    throw new AnvaError(
      "agent_required",
      `Specify --agent <slug> (or run inside an agent session). Example: ${commandHint}`,
    );
  }
  return slug;
}
