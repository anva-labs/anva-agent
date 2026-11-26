import { describe, expect, it } from "vite-plus/test";
import { runCli } from "../main.ts";
import { renderLaunchdPlist, renderSystemdUnit } from "./service.ts";

describe("anva service templates and CLI validation", () => {
  it("renders a systemd user unit with escaped env values and optional flags", () => {
    const unit = renderSystemdUnit({
      nodePath: "/opt/node/bin/node",
      cliPath: "/home/admin/anva/apps/cli/dist/main.js",
      workingDir: "/home/admin",
      pathEnv: '/home/admin/.local/bin:/usr/bin:"quoted"%s',
      anvaHome: "/home/admin/.anva",
      idleTtlMs: "900000",
      host: "127.0.0.1",
      port: 3721,
      stdoutLogPath: "/home/admin/.anva/logs/daemon.stdout.log",
      stderrLogPath: "/home/admin/.anva/logs/daemon.stderr.log",
    });

    expect(unit).toContain("Type=simple");
    expect(unit).toContain("WorkingDirectory=/home/admin");
    expect(unit).toContain('Environment="PATH=/home/admin/.local/bin:/usr/bin:\\"quoted\\"%%s"');
    expect(unit).toContain('Environment="ANVA_HOME=/home/admin/.anva"');
    expect(unit).toContain('Environment="ANVA_IDLE_TTL_MS=900000"');
    expect(unit).toContain(
      "ExecStart=/opt/node/bin/node /home/admin/anva/apps/cli/dist/main.js start --host 127.0.0.1 --port 3721",
    );
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("renders a macOS launchd plist with XML escaping and log paths", () => {
    const plist = renderLaunchdPlist({
      nodePath: "/usr/local/bin/node",
      cliPath: "/Users/dev & test/anva/apps/cli/dist/main.js",
      workingDir: "/Users/dev & test",
      pathEnv: "/opt/homebrew/bin:/usr/bin",
      stdoutLogPath: "/Users/dev & test/.anva/logs/daemon.stdout.log",
      stderrLogPath: "/Users/dev & test/.anva/logs/daemon.stderr.log",
    });

    expect(plist).toContain("<string>dev.anva.daemon</string>");
    expect(plist).toContain("<string>/Users/dev &amp; test/anva/apps/cli/dist/main.js</string>");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<string>/Users/dev &amp; test/.anva/logs/daemon.stdout.log</string>");
  });

  it("validates --delay and --port arguments cleanly", async () => {
    const badDelay = await runCli(["service", "restart", "--delay", "999"]);
    expect(badDelay.exitCode).toBe(1);
    expect(badDelay.stderr).toContain("error: invalid_args");

    const badPort = await runCli(["service", "install", "--port", "99999"]);
    expect(badPort.exitCode).toBe(1);
    expect(badPort.stderr).toContain("error: invalid_port");
  });
});
