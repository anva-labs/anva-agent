import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { AnvaError } from "../errors.ts";
import { ensureAgentHome, readMemory, readPersona, validateSlug } from "./agent-home.ts";
import {
  formatDotEnv,
  listAgentEnvNames,
  loadAgentEnv,
  parseDotEnv,
  setAgentEnvVar,
  unsetAgentEnvVar,
} from "./env.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "anva-home-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("Agent home & per-agent .env", () => {
  it("validates agent slugs", () => {
    expect(() => validateSlug("coder-1_a")).not.toThrow();
    expect(() => validateSlug("Coder")).toThrow(AnvaError);
    expect(() => validateSlug("../escape")).toThrow(AnvaError);
    expect(() => validateSlug("-bad")).toThrow(AnvaError);
  });

  it("initializes home files and relative skills symlinks idempotently", () => {
    const home = join(makeTempDir(), "agents", "coder");
    ensureAgentHome(home, { name: "Coder", persona: "You write clean TypeScript." });

    expect(readPersona(home)).toBe("You write clean TypeScript.\n");
    expect(readMemory(home)).toContain("# Coder's Memory");
    const gitignore = readFileSync(join(home, ".gitignore"), "utf8");
    expect(gitignore).toContain(".env");
    expect(gitignore).toContain("attachments/");

    const agentsLink = join(home, ".agents", "skills");
    const claudeLink = join(home, ".claude", "skills");
    expect(lstatSync(agentsLink).isSymbolicLink()).toBe(true);
    expect(lstatSync(claudeLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agentsLink)).toBe("../skills");
    expect(readlinkSync(claudeLink)).toBe("../skills");

    // Re-running must preserve existing persona/memory without throwing.
    ensureAgentHome(home, { name: "Coder", persona: "Different" });
    expect(readPersona(home)).toBe("You write clean TypeScript.\n");
  });

  it("reads, writes, unsets .env variables with 0600 permissions and rejects reserved names", () => {
    const home = join(makeTempDir(), "agents", "coder");
    ensureAgentHome(home, { name: "Coder" });
    const envPath = join(home, ".env");

    setAgentEnvVar(envPath, "GITHUB_TOKEN", "test_token_123456");
    setAgentEnvVar(envPath, "MULTI_LINE", "line1\nline2");

    expect(listAgentEnvNames(envPath)).toEqual(["GITHUB_TOKEN", "MULTI_LINE"]);
    const loaded = loadAgentEnv(home);
    expect(loaded.vars).toEqual({
      GITHUB_TOKEN: "test_token_123456",
      MULTI_LINE: "line1\nline2",
    });

    expect(statSync(envPath).mode & 0o777).toBe(0o600);

    expect(() => setAgentEnvVar(envPath, "PATH", "/tmp")).toThrow(AnvaError);
    expect(() => setAgentEnvVar(envPath, "ANVA_TOKEN", "spoof")).toThrow(AnvaError);
    expect(() => setAgentEnvVar(envPath, "DYLD_INSERT_LIBRARIES", "/x")).toThrow(AnvaError);

    expect(unsetAgentEnvVar(envPath, "MULTI_LINE")).toBe(true);
    expect(unsetAgentEnvVar(envPath, "MULTI_LINE")).toBe(false);
    expect(listAgentEnvNames(envPath)).toEqual(["GITHUB_TOKEN"]);

    const roundtrip = parseDotEnv(formatDotEnv({ A: "hello world", B: "plain" }));
    expect(roundtrip).toEqual({ A: "hello world", B: "plain" });
  });

  it("refuses to overwrite non-empty real skills directories or files, while repairing stale symlinks and empty dirs", () => {
    const home = join(makeTempDir(), "agents", "coder");
    ensureAgentHome(home, { name: "Coder" });

    // 1. Replace symlink pointing elsewhere and an empty directory without data loss.
    const agentsLink = join(home, ".agents", "skills");
    const claudeLink = join(home, ".claude", "skills");
    rmSync(agentsLink, { force: true });
    symlinkSync("../other", agentsLink, "dir");
    rmSync(claudeLink, { force: true });
    mkdirSync(claudeLink);

    ensureAgentHome(home, { name: "Coder" });
    expect(lstatSync(agentsLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agentsLink)).toBe("../skills");
    expect(lstatSync(claudeLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(claudeLink)).toBe("../skills");

    // 2. Non-empty real directory must throw skills_path_conflict and keep user files intact.
    rmSync(claudeLink, { force: true });
    mkdirSync(join(claudeLink, "user-skill"), { recursive: true });
    const userSkillFile = join(claudeLink, "user-skill", "SKILL.md");
    writeFileSync(userSkillFile, "# custom skill\n", "utf8");

    expect(() => ensureAgentHome(home, { name: "Coder" })).toThrowError(
      expect.objectContaining({ code: "skills_path_conflict" }),
    );
    expect(readFileSync(userSkillFile, "utf8")).toBe("# custom skill\n");

    // 3. Regular file at symlink path must throw skills_path_conflict and remain intact.
    rmSync(claudeLink, { recursive: true, force: true });
    writeFileSync(claudeLink, "user file", "utf8");
    expect(() => ensureAgentHome(home, { name: "Coder" })).toThrowError(
      expect.objectContaining({ code: "skills_path_conflict" }),
    );
    expect(readFileSync(claudeLink, "utf8")).toBe("user file");
  });
});
