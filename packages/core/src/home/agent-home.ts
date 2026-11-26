import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { AnvaError } from "../errors.ts";
import { buildDefaultMemoryMarkdown, buildDefaultPersonaMarkdown } from "../prompts.ts";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new AnvaError(
      "agent_slug_invalid",
      "Agent slug must be 1-64 characters: lowercase letters, digits, hyphens, or underscores, starting with a letter or digit.",
    );
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function ensureRelativeSkillsSymlink(linkPath: string, homeDir: string): void {
  const target = "../skills";
  let stat: ReturnType<typeof lstatSync> | null = null;
  try {
    stat = lstatSync(linkPath);
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }

  if (stat !== null) {
    if (stat.isSymbolicLink()) {
      if (readlinkSync(linkPath) === target) {
        return;
      }
      unlinkSync(linkPath);
    } else if (stat.isDirectory()) {
      if (readdirSync(linkPath).length === 0) {
        rmdirSync(linkPath);
      } else {
        throw new AnvaError(
          "skills_path_conflict",
          `Cannot link "${linkPath}" to "../skills" because a non-empty directory already exists there. Move its skills into "${join(homeDir, "skills")}" and remove "${linkPath}".`,
          409,
        );
      }
    } else {
      throw new AnvaError(
        "skills_path_conflict",
        `Cannot link "${linkPath}" to "../skills" because a file already exists at that path. Remove or move "${linkPath}" and try again.`,
        409,
      );
    }
  }

  symlinkSync(target, linkPath, "dir");
}

export function ensureAgentHome(
  homeDir: string,
  options: { readonly name: string; readonly persona?: string },
): void {
  mkdirSync(join(homeDir, "skills"), { recursive: true });
  mkdirSync(join(homeDir, ".agents"), { recursive: true });
  mkdirSync(join(homeDir, ".claude"), { recursive: true });

  const gitignorePath = join(homeDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, ".env\nattachments/\n", "utf8");
  }

  const envPath = join(homeDir, ".env");
  if (!existsSync(envPath)) {
    writeFileSync(envPath, "", { encoding: "utf8", mode: 0o600 });
  }

  const personaPath = join(homeDir, "PERSONA.md");
  if (!existsSync(personaPath)) {
    writeFileSync(personaPath, buildDefaultPersonaMarkdown(options.name, options.persona), "utf8");
  }

  const memoryPath = join(homeDir, "MEMORY.md");
  if (!existsSync(memoryPath)) {
    writeFileSync(memoryPath, buildDefaultMemoryMarkdown(options.name), "utf8");
  }

  ensureRelativeSkillsSymlink(join(homeDir, ".agents", "skills"), homeDir);
  ensureRelativeSkillsSymlink(join(homeDir, ".claude", "skills"), homeDir);
}

export function readPersona(homeDir: string): string {
  const filePath = join(homeDir, "PERSONA.md");
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

export function readMemory(homeDir: string): string {
  const filePath = join(homeDir, "MEMORY.md");
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}
