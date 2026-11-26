import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AnvaPaths {
  readonly home: string;
  readonly db: string;
  readonly runtime: string;
  readonly logsDir: string;
  readonly agentsDir: string;
  agentHome(slug: string): string;
  agentEnv(slug: string): string;
  agentAttachments(slug: string): string;
}

export function resolveAnvaPaths(homeOverride?: string): AnvaPaths {
  const home = resolve(homeOverride ?? process.env.ANVA_HOME?.trim() ?? join(homedir(), ".anva"));
  const agentsDir = join(home, "agents");
  return {
    home,
    db: join(home, "anva.db"),
    runtime: join(home, "runtime.json"),
    logsDir: join(home, "logs"),
    agentsDir,
    agentHome(slug: string): string {
      return join(agentsDir, slug);
    },
    agentEnv(slug: string): string {
      return join(agentsDir, slug, ".env");
    },
    agentAttachments(slug: string): string {
      return join(agentsDir, slug, "attachments");
    },
  };
}
