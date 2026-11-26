import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { AnvaError } from "../errors.ts";

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const MAX_ENV_NAME_LEN = 128;
const MAX_ENV_VALUE_LEN = 32 * 1024;

/** Variables a harness, shell, or Anva itself owns; never override via agent .env. */
const RESERVED_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "TZ",
  "IFS",
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
]);

const RESERVED_ENV_PREFIXES = ["LC_", "DYLD_", "LD_", "ANVA_"];

export function isReservedEnvName(name: string): boolean {
  return RESERVED_ENV_NAMES.has(name) || RESERVED_ENV_PREFIXES.some((p) => name.startsWith(p));
}

export function validateEnvName(name: string): void {
  if (!ENV_NAME_RE.test(name) || name.length > MAX_ENV_NAME_LEN) {
    throw new AnvaError(
      "env_name_invalid",
      "Use uppercase letters, digits, and underscores, not starting with a digit.",
    );
  }
  if (isReservedEnvName(name)) {
    throw new AnvaError(
      "env_name_reserved",
      `Environment variable "${name}" is reserved by the system or Anva; choose another name.`,
    );
  }
}

export function validateEnvValue(value: string): void {
  if (value.length > MAX_ENV_VALUE_LEN) {
    throw new AnvaError("env_value_too_large", "Environment variable values are limited to 32 KB.");
  }
  if (value.includes("\0")) {
    throw new AnvaError(
      "env_value_invalid",
      "Environment variable values cannot contain NUL bytes.",
    );
  }
}

function formatDotEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value) && value.length > 0) {
    return value;
  }
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return `"${escaped}"`;
}

export function parseDotEnv(content: string): Record<string, string> {
  const parsed = parseEnv(content);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (ENV_NAME_RE.test(key) && typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

export function formatDotEnv(entries: Readonly<Record<string, string>>): string {
  const keys = Object.keys(entries).sort();
  if (keys.length === 0) {
    return "";
  }
  return `${keys.map((key) => `${key}=${formatDotEnvValue(entries[key] ?? "")}`).join("\n")}\n`;
}

export function readDotEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }
  return parseDotEnv(readFileSync(filePath, "utf8"));
}

export function writeDotEnvFile(filePath: string, entries: Readonly<Record<string, string>>): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.env.tmp.${process.pid}.${Date.now()}`);
  writeFileSync(tmpPath, formatDotEnv(entries), { encoding: "utf8", mode: 0o600 });
  renameSync(tmpPath, filePath);
}

export function setAgentEnvVar(envPath: string, name: string, value: string): void {
  validateEnvName(name);
  validateEnvValue(value);
  const current = readDotEnvFile(envPath);
  current[name] = value;
  writeDotEnvFile(envPath, current);
}

export function unsetAgentEnvVar(envPath: string, name: string): boolean {
  validateEnvName(name);
  const current = readDotEnvFile(envPath);
  if (!(name in current)) {
    return false;
  }
  delete current[name];
  writeDotEnvFile(envPath, current);
  return true;
}

export function listAgentEnvNames(envPath: string): string[] {
  return loadAgentEnvFromFile(envPath).names;
}

export function loadAgentEnv(agentHomeDir: string): {
  readonly vars: Record<string, string>;
  readonly names: string[];
} {
  return loadAgentEnvFromFile(join(agentHomeDir, ".env"));
}

function loadAgentEnvFromFile(envPath: string): {
  readonly vars: Record<string, string>;
  readonly names: string[];
} {
  const parsed = readDotEnvFile(envPath);
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!ENV_NAME_RE.test(key) || key.length > MAX_ENV_NAME_LEN || isReservedEnvName(key)) {
      continue;
    }
    if (value.includes("\0") || value.length > MAX_ENV_VALUE_LEN) {
      continue;
    }
    vars[key] = value;
  }
  return {
    vars,
    names: Object.keys(vars).sort(),
  };
}
