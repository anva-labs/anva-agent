import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AnvaError, resolveAnvaPaths, type RuntimeInfoFile } from "@anva/core";
import { defineCommand } from "citty";
import { emitResult, getCliRuntime } from "../context.ts";

export const LAUNCHD_LABEL = "dev.anva.daemon";
export const SYSTEMD_UNIT_NAME = "anva.service";

export interface ServiceSpec {
  readonly nodePath: string;
  readonly cliPath: string;
  readonly workingDir: string;
  readonly pathEnv: string;
  readonly anvaHome?: string;
  readonly idleTtlMs?: string;
  readonly host?: string;
  readonly port?: number;
  readonly stdoutLogPath: string;
  readonly stderrLogPath: string;
}

type SupportedOs = "darwin" | "linux";

export function escapeSystemdEnvValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
}

export function escapeSystemdArg(arg: string): string {
  if (!/[\s"'\\%;$]/.test(arg)) {
    return arg;
  }
  return `"${escapeSystemdEnvValue(arg)}"`;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildStartArgs(spec: ServiceSpec): string[] {
  const args = [spec.nodePath, spec.cliPath, "start"];
  if (spec.host) {
    args.push("--host", spec.host);
  }
  if (spec.port !== undefined) {
    args.push("--port", String(spec.port));
  }
  return args;
}

export function renderSystemdUnit(spec: ServiceSpec): string {
  const envLines = [`Environment="PATH=${escapeSystemdEnvValue(spec.pathEnv)}"`];
  if (spec.anvaHome) {
    envLines.push(`Environment="ANVA_HOME=${escapeSystemdEnvValue(spec.anvaHome)}"`);
  }
  if (spec.idleTtlMs) {
    envLines.push(`Environment="ANVA_IDLE_TTL_MS=${escapeSystemdEnvValue(spec.idleTtlMs)}"`);
  }

  const execStart = buildStartArgs(spec).map(escapeSystemdArg).join(" ");
  return [
    "[Unit]",
    "Description=Anva Personal Agent Daemon",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${spec.workingDir}`,
    ...envLines,
    `ExecStart=${execStart}`,
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function renderLaunchdPlist(spec: ServiceSpec): string {
  const argsXml = buildStartArgs(spec)
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");

  const envEntries: string[] = [
    `    <key>PATH</key>`,
    `    <string>${escapeXml(spec.pathEnv)}</string>`,
  ];
  if (spec.anvaHome) {
    envEntries.push(`    <key>ANVA_HOME</key>`, `    <string>${escapeXml(spec.anvaHome)}</string>`);
  }
  if (spec.idleTtlMs) {
    envEntries.push(
      `    <key>ANVA_IDLE_TTL_MS</key>`,
      `    <string>${escapeXml(spec.idleTtlMs)}</string>`,
    );
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    argsXml,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${escapeXml(spec.workingDir)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...envEntries,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(spec.stdoutLogPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(spec.stderrLogPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function requireSupportedOs(): SupportedOs {
  if (process.platform === "darwin" || process.platform === "linux") {
    return process.platform;
  }
  throw new AnvaError(
    "service_unsupported_os",
    `anva service supports macOS (launchd) and Linux (systemd --user), not "${process.platform}".`,
    400,
  );
}

function resolveCliEntryPath(): string {
  try {
    return realpathSync(fileURLToPath(new URL("../main.js", import.meta.url)));
  } catch {
    return process.argv[1] ? resolve(process.argv[1]) : "anva";
  }
}

function resolveUnitPath(os: SupportedOs, env: NodeJS.ProcessEnv): string {
  if (os === "darwin") {
    return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  }
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "systemd", "user", SYSTEMD_UNIT_NAME);
}

function supervisorEnv(os: SupportedOs, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (os !== "linux") {
    return baseEnv;
  }
  if (baseEnv.XDG_RUNTIME_DIR?.trim()) {
    return baseEnv;
  }
  const uid = process.getuid?.();
  if (uid === undefined) {
    return baseEnv;
  }
  return { ...baseEnv, XDG_RUNTIME_DIR: `/run/user/${uid}` };
}

function launchdDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new AnvaError("service_unsupported_os", "Could not resolve POSIX user ID.", 400);
  }
  return `gui/${uid}`;
}

function launchdTarget(): string {
  return `${launchdDomain()}/${LAUNCHD_LABEL}`;
}

interface ExecOutput {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runExec(
  cmd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  allowFailure = false,
): ExecOutput {
  const res = spawnSync(cmd, args, { env, encoding: "utf8" });
  if (res.error) {
    throw new AnvaError(
      "service_command_failed",
      `Failed to execute "${cmd}": ${res.error.message}`,
      500,
    );
  }
  const status = res.status ?? 1;
  const stdout = (res.stdout ?? "").trim();
  const stderr = (res.stderr ?? "").trim();
  if (status !== 0 && !allowFailure) {
    const detail = stderr || stdout || `exit code ${status}`;
    throw new AnvaError(
      "service_command_failed",
      `${cmd} ${args.join(" ")} failed: ${detail}`,
      500,
    );
  }
  return { status, stdout, stderr };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readRuntimeInfo(
  runtimePath: string,
): { readonly pid: number; readonly url: string } | null {
  if (!existsSync(runtimePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(runtimePath, "utf8")) as Partial<RuntimeInfoFile>;
    if (typeof parsed.pid === "number" && typeof parsed.url === "string") {
      return { pid: parsed.pid, url: parsed.url };
    }
  } catch {
    // Ignore stale or partially written runtime file.
  }
  return null;
}

function readTailLines(filePath: string, lines: number): string[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const raw = readFileSync(filePath, "utf8").split(/\r?\n/);
  if (raw.at(-1) === "") {
    raw.pop();
  }
  return raw.slice(-lines);
}

const serviceInstallCommand = defineCommand({
  meta: {
    name: "install",
    description: "Install and start Anva as a background user service",
  },
  args: {
    host: { type: "string", description: "Bind address passed to anva start" },
    port: { type: "string", description: "Port passed to anva start" },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  run({ args }) {
    const rt = getCliRuntime();
    let port: number | undefined;
    if (args.port !== undefined) {
      port = Number(args.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new AnvaError("invalid_port", `Port "${args.port}" must be 0-65535.`);
      }
    }

    const os = requireSupportedOs();
    const env = supervisorEnv(os, rt.env);
    const paths = resolveAnvaPaths(rt.env.ANVA_HOME);
    mkdirSync(paths.logsDir, { recursive: true });

    const unitPath = resolveUnitPath(os, rt.env);
    mkdirSync(dirname(unitPath), { recursive: true });

    const spec: ServiceSpec = {
      nodePath: process.execPath,
      cliPath: resolveCliEntryPath(),
      workingDir: homedir(),
      pathEnv: rt.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      ...(rt.env.ANVA_HOME?.trim() ? { anvaHome: resolve(rt.env.ANVA_HOME.trim()) } : {}),
      ...(rt.env.ANVA_IDLE_TTL_MS?.trim() ? { idleTtlMs: rt.env.ANVA_IDLE_TTL_MS.trim() } : {}),
      ...(args.host?.trim() ? { host: args.host.trim() } : {}),
      ...(port !== undefined ? { port } : {}),
      stdoutLogPath: join(paths.logsDir, "daemon.stdout.log"),
      stderrLogPath: join(paths.logsDir, "daemon.stderr.log"),
    };

    if (os === "linux") {
      writeFileSync(unitPath, renderSystemdUnit(spec), "utf8");
      runExec("systemctl", ["--user", "daemon-reload"], env);
      runExec("systemctl", ["--user", "enable", SYSTEMD_UNIT_NAME], env);
      runExec("systemctl", ["--user", "restart", SYSTEMD_UNIT_NAME], env);
      const user = userInfo().username;
      const lingerOut = runExec(
        "loginctl",
        ["show-user", user, "-p", "Linger", "--value"],
        env,
        true,
      );
      const lingerEnabled = lingerOut.status === 0 && lingerOut.stdout === "yes";
      const result = {
        installed: true,
        supervisor: "systemd",
        unitPath,
        lingerEnabled,
      };
      const lines = [`Installed and started ${SYSTEMD_UNIT_NAME} at ${unitPath}`];
      if (!lingerEnabled) {
        lines.push(
          `Note: user linger is disabled. Enable it so Anva survives SSH logout/reboot: sudo loginctl enable-linger ${user}`,
        );
      }
      emitResult(args.json, result, lines.join("\n"));
      return;
    }

    writeFileSync(unitPath, renderLaunchdPlist(spec), "utf8");
    const domain = launchdDomain();
    const target = launchdTarget();
    runExec("launchctl", ["bootout", target], env, true);
    runExec("launchctl", ["bootstrap", domain, unitPath], env);
    runExec("launchctl", ["kickstart", "-k", target], env, true);
    emitResult(
      args.json,
      { installed: true, supervisor: "launchd", unitPath },
      `Installed and started ${LAUNCHD_LABEL} at ${unitPath}`,
    );
  },
});

const serviceUninstallCommand = defineCommand({
  meta: {
    name: "uninstall",
    description: "Stop and remove the background service registration (keeps ~/.anva data)",
  },
  args: {
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  run({ args }) {
    const rt = getCliRuntime();
    const os = requireSupportedOs();
    const env = supervisorEnv(os, rt.env);
    const unitPath = resolveUnitPath(os, rt.env);

    const homePath = resolveAnvaPaths(rt.env.ANVA_HOME).home;
    const supervisor = os === "linux" ? "systemd" : "launchd";
    const unitLabel = os === "linux" ? SYSTEMD_UNIT_NAME : LAUNCHD_LABEL;
    if (os === "linux") {
      runExec("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT_NAME], env, true);
      rmSync(unitPath, { force: true });
      runExec("systemctl", ["--user", "daemon-reload"], env, true);
    } else {
      runExec("launchctl", ["bootout", launchdTarget()], env, true);
      rmSync(unitPath, { force: true });
    }
    emitResult(
      args.json,
      { uninstalled: true, supervisor, unitPath },
      `Uninstalled ${unitLabel} (data in ${homePath} kept).`,
    );
  },
});

function startLaunchd(env: NodeJS.ProcessEnv, unitPath: string, killFirst = false): void {
  const args = killFirst ? ["kickstart", "-k", launchdTarget()] : ["kickstart", launchdTarget()];
  const kicked = runExec("launchctl", args, env, true);
  if (kicked.status !== 0) {
    runExec("launchctl", ["bootstrap", launchdDomain(), unitPath], env);
  }
}

function emitServiceStatus(
  json: boolean | undefined,
  opts: {
    readonly os: SupportedOs;
    readonly supervisor: "systemd" | "launchd";
    readonly label: string;
    readonly unitPath: string;
    readonly installed: boolean;
    readonly running: boolean;
    readonly enabled?: boolean;
    readonly runtime: { readonly pid: number; readonly url: string } | null;
  },
): void {
  const data = {
    platform: opts.os,
    supervisor: opts.supervisor,
    unitPath: opts.unitPath,
    installed: opts.installed,
    running: opts.running,
    ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
    runtime: opts.runtime,
  };
  const summary = [
    `Supervisor: ${opts.supervisor} (${opts.label})`,
    `Installed: ${opts.installed ? `yes (${opts.unitPath})` : "no"}`,
    `Running: ${opts.running ? "yes" : "no"}`,
    ...(opts.runtime ? [`Daemon: pid=${opts.runtime.pid} url=${opts.runtime.url}`] : []),
  ].join("\n");
  emitResult(json, data, summary);
}

function requireInstalledUnit(os: SupportedOs, env: NodeJS.ProcessEnv): string {
  const unitPath = resolveUnitPath(os, env);
  if (!existsSync(unitPath)) {
    throw new AnvaError(
      "service_not_installed",
      'Background service is not installed. Run "anva service install" first.',
      400,
    );
  }
  return unitPath;
}

const serviceStartCommand = defineCommand({
  meta: { name: "start", description: "Start the installed background service" },
  args: { json: { type: "boolean", description: "Print structured JSON output" } },
  run({ args }) {
    const rt = getCliRuntime();
    const os = requireSupportedOs();
    const env = supervisorEnv(os, rt.env);
    const unitPath = requireInstalledUnit(os, rt.env);

    if (os === "linux") {
      runExec("systemctl", ["--user", "start", SYSTEMD_UNIT_NAME], env);
      emitResult(
        args.json,
        { started: true, supervisor: "systemd" },
        `Started ${SYSTEMD_UNIT_NAME}`,
      );
      return;
    }

    startLaunchd(env, unitPath);
    emitResult(args.json, { started: true, supervisor: "launchd" }, `Started ${LAUNCHD_LABEL}`);
  },
});

const serviceStopCommand = defineCommand({
  meta: { name: "stop", description: "Stop the installed background service" },
  args: { json: { type: "boolean", description: "Print structured JSON output" } },
  run({ args }) {
    const rt = getCliRuntime();
    const os = requireSupportedOs();
    const env = supervisorEnv(os, rt.env);
    requireInstalledUnit(os, rt.env);

    if (os === "linux") {
      runExec("systemctl", ["--user", "stop", SYSTEMD_UNIT_NAME], env);
      emitResult(
        args.json,
        { stopped: true, supervisor: "systemd" },
        `Stopped ${SYSTEMD_UNIT_NAME}`,
      );
      return;
    }

    runExec("launchctl", ["bootout", launchdTarget()], env, true);
    emitResult(args.json, { stopped: true, supervisor: "launchd" }, `Stopped ${LAUNCHD_LABEL}`);
  },
});

const serviceRestartCommand = defineCommand({
  meta: {
    name: "restart",
    description: "Restart the installed background service (supports --delay for self-restarts)",
  },
  args: {
    delay: {
      type: "string",
      description:
        "Defer restart by N seconds in the background (1-300; useful inside agent turns)",
    },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  run({ args }) {
    const rt = getCliRuntime();
    let delaySeconds = 0;
    if (args.delay !== undefined) {
      const parsed = Number(args.delay);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 300) {
        throw new AnvaError("invalid_args", "--delay must be a number between 0 and 300 seconds.");
      }
      delaySeconds = parsed;
    }

    const os = requireSupportedOs();
    const env = supervisorEnv(os, rt.env);
    const unitPath = requireInstalledUnit(os, rt.env);
    const supervisor = os === "linux" ? "systemd" : "launchd";

    if (delaySeconds > 0) {
      const cmd =
        os === "linux"
          ? `sleep ${delaySeconds} && systemctl --user restart ${SYSTEMD_UNIT_NAME}`
          : `sleep ${delaySeconds} && (launchctl kickstart -k ${shellQuote(launchdTarget())} || launchctl bootstrap ${shellQuote(launchdDomain())} ${shellQuote(unitPath)})`;
      const child = spawn("sh", ["-c", cmd], {
        env,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      emitResult(
        args.json,
        { scheduled: true, delaySeconds, supervisor },
        `Scheduled ${supervisor} service restart in ${delaySeconds}s.`,
      );
      return;
    }

    if (os === "linux") {
      runExec("systemctl", ["--user", "restart", SYSTEMD_UNIT_NAME], env);
      emitResult(args.json, { restarted: true, supervisor }, `Restarted ${SYSTEMD_UNIT_NAME}`);
      return;
    }

    startLaunchd(env, unitPath, true);
    emitResult(args.json, { restarted: true, supervisor }, `Restarted ${LAUNCHD_LABEL}`);
  },
});

const serviceStatusCommand = defineCommand({
  meta: { name: "status", description: "Inspect background service registration and state" },
  args: { json: { type: "boolean", description: "Print structured JSON output" } },
  run({ args }) {
    const rt = getCliRuntime();
    const os = requireSupportedOs();
    const env = supervisorEnv(os, rt.env);
    const unitPath = resolveUnitPath(os, rt.env);
    const installed = existsSync(unitPath);
    const runtime = readRuntimeInfo(resolveAnvaPaths(rt.env.ANVA_HOME).runtime);

    if (os === "linux") {
      const active = installed
        ? runExec("systemctl", ["--user", "is-active", SYSTEMD_UNIT_NAME], env, true)
        : { status: 1, stdout: "not-installed", stderr: "" };
      const enabled = installed
        ? runExec("systemctl", ["--user", "is-enabled", SYSTEMD_UNIT_NAME], env, true)
        : { status: 1, stdout: "disabled", stderr: "" };
      emitServiceStatus(args.json, {
        os,
        supervisor: "systemd",
        label: SYSTEMD_UNIT_NAME,
        unitPath,
        installed,
        running: active.status === 0 && active.stdout === "active",
        enabled: enabled.status === 0 && enabled.stdout === "enabled",
        runtime,
      });
      return;
    }

    const printed = installed
      ? runExec("launchctl", ["print", launchdTarget()], env, true)
      : { status: 1, stdout: "", stderr: "" };
    emitServiceStatus(args.json, {
      os,
      supervisor: "launchd",
      label: LAUNCHD_LABEL,
      unitPath,
      installed,
      running: printed.status === 0 && /state = running/i.test(printed.stdout),
      runtime,
    });
  },
});

const serviceLogsCommand = defineCommand({
  meta: { name: "logs", description: "View background service logs" },
  args: {
    lines: { type: "string", description: "Number of recent lines (default 50)" },
    follow: { type: "boolean", alias: "f", description: "Stream live log output" },
  },
  run({ args }) {
    const rt = getCliRuntime();
    const lines = args.lines !== undefined ? Number(args.lines) : 50;
    if (!Number.isInteger(lines) || lines < 1 || lines > 5000) {
      throw new AnvaError("invalid_args", "--lines must be an integer between 1 and 5000.");
    }

    const os = requireSupportedOs();
    const env = supervisorEnv(os, rt.env);

    if (os === "linux") {
      if (args.follow) {
        spawnSync("journalctl", ["--user", "-u", SYSTEMD_UNIT_NAME, "-n", String(lines), "-f"], {
          env,
          stdio: "inherit",
        });
        return;
      }
      const res = runExec(
        "journalctl",
        ["--user", "-u", SYSTEMD_UNIT_NAME, "-n", String(lines), "--no-pager"],
        env,
        true,
      );
      rt.writeOut(res.stdout || res.stderr || "(no logs yet)");
      return;
    }

    const paths = resolveAnvaPaths(rt.env.ANVA_HOME);
    const stdoutLog = join(paths.logsDir, "daemon.stdout.log");
    const stderrLog = join(paths.logsDir, "daemon.stderr.log");
    if (args.follow) {
      const existing = [stdoutLog, stderrLog].filter((f) => existsSync(f));
      if (existing.length === 0) {
        rt.writeOut("(no log files yet)");
        return;
      }
      spawnSync("tail", ["-n", String(lines), "-f", ...existing], { env, stdio: "inherit" });
      return;
    }

    const sections: string[] = [];
    const outTail = readTailLines(stdoutLog, lines);
    if (outTail.length > 0) {
      sections.push(`=== ${stdoutLog} ===`, ...outTail);
    }
    const errTail = readTailLines(stderrLog, lines);
    if (errTail.length > 0) {
      sections.push(`=== ${stderrLog} ===`, ...errTail);
    }
    rt.writeOut(sections.length > 0 ? sections.join("\n") : "(no logs yet)");
  },
});

export const serviceCommand = defineCommand({
  meta: {
    name: "service",
    description: "Manage Anva background service (launchd / systemd --user)",
  },
  subCommands: {
    install: serviceInstallCommand,
    uninstall: serviceUninstallCommand,
    start: serviceStartCommand,
    stop: serviceStopCommand,
    restart: serviceRestartCommand,
    status: serviceStatusCommand,
    logs: serviceLogsCommand,
  },
});
