import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { AnvaError } from "../errors.ts";
import type { ChannelBridge } from "../channels/types.ts";
import type { HarnessAdapter } from "../harness/oar-adapter.ts";
import { ensureAgentHome, validateSlug } from "../home/agent-home.ts";
import type { AnvaPaths } from "../paths.ts";
import type { AutomationEngine } from "../runtime/automation-engine.ts";
import type { HistoryIndex } from "../runtime/history-index.ts";
import type { ThreadManager } from "../runtime/thread-manager.ts";
import type { AnvaStore } from "../store/db.ts";
import { ANVA_VERSION } from "../version.ts";

export interface ApiDeps {
  readonly store: AnvaStore;
  readonly harness: HarnessAdapter;
  readonly paths: AnvaPaths;
  readonly history: HistoryIndex;
  readonly threads: ThreadManager;
  readonly channels?: ChannelBridge | null;
  readonly automations: AutomationEngine;
  readonly token: string;
}

const createAgentSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  harness: z.string().min(1),
  model: z.string().min(1).nullable().optional(),
  persona: z.string().optional(),
});

const updateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  harness: z.string().min(1).optional(),
  model: z.string().min(1).nullable().optional(),
});

const askSchema = z.object({
  agent: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  prompt: z.string().min(1),
  harness: z.string().min(1).optional(),
  model: z.string().min(1).nullable().optional(),
  async: z.boolean().optional(),
});

const switchModelSchema = z.object({
  model: z.string().min(1).nullable(),
});

const renameThreadSchema = z.object({
  title: z.string().trim().min(1).max(128),
});

const createAutomationSchema = z.object({
  agent: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().optional(),
  triggerType: z.enum(["cron", "once"]),
  cronExpr: z.string().min(1).nullable().optional(),
  runAt: z.number().int().positive().nullable().optional(),
  timezone: z.string().min(1).optional(),
  scriptCommand: z.string().min(1).nullable().optional(),
  scriptTimeoutMs: z.number().int().min(100).max(3_600_000).optional(),
  targetThreadId: z.string().min(1).nullable().optional(),
  harnessOverride: z.string().min(1).nullable().optional(),
  modelOverride: z.string().min(1).nullable().optional(),
  prompt: z.string().min(1).nullable().optional(),
  deliverTarget: z.string().min(1).nullable().optional(),
});

const updateAutomationSchema = createAutomationSchema.omit({ agent: true }).partial();

const connectChannelSchema = z.object({
  platform: z.string().min(1),
  agent: z.string().min(1),
  envKey: z.string().min(1).optional(),
});

const sendChannelSchema = z
  .object({
    agent: z.string().min(1).optional(),
    target: z.string().min(1),
    text: z.string().optional(),
    filePath: z.string().min(1).optional(),
  })
  .refine((val) => Boolean(val.text?.trim() || val.filePath?.trim()), {
    message: "Provide non-empty text or filePath.",
  });

function requireChannels(deps: ApiDeps): ChannelBridge {
  if (!deps.channels) {
    throw new AnvaError(
      "channels_unavailable",
      "Channels subsystem is not enabled in this daemon.",
      501,
    );
  }
  return deps.channels;
}

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const res = schema.safeParse(raw);
  if (!res.success) {
    const issue = res.error.issues[0];
    const msg = issue
      ? `${issue.path.join(".") || "body"}: ${issue.message}`
      : "Invalid request body";
    throw new AnvaError("invalid_request", msg, 400);
  }
  return res.data;
}

function tokenMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AnvaError("invalid_json", "Request body must be valid JSON.", 400);
  }
}

export function createApiApp(deps: ApiDeps): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof AnvaError) {
      return c.json({ error: error.code, next: error.next }, error.status as ContentfulStatusCode);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return c.json({ error: "internal", next: detail || "Unexpected Anva daemon error." }, 500);
  });

  app.get("/v1/health", (c) => c.json({ ok: true, version: ANVA_VERSION }));

  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/health") {
      await next();
      return;
    }
    const authHeader = c.req.header("authorization") ?? "";
    const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!provided || !tokenMatches(deps.token, provided)) {
      throw new AnvaError("unauthorized", "Missing or invalid Bearer token.", 401);
    }
    await next();
  });

  app.get("/v1/harnesses", async (c) => {
    const harnesses = await deps.harness.catalog();
    return c.json({ harnesses });
  });

  app.get("/v1/harnesses/:id/models", async (c) => {
    const id = c.req.param("id");
    const result = await deps.harness.models(id);
    return c.json(result);
  });

  app.get("/v1/agents", (c) => {
    const agents = deps.store.listAgents().map((agent) => ({
      ...agent,
      home: deps.paths.agentHome(agent.slug),
      noEnv: deps.harness.refusesEnv(agent.defaultHarness),
    }));
    return c.json({ agents });
  });

  app.post("/v1/agents", async (c) => {
    const body = parseBody(createAgentSchema, await readJsonBody(c));
    validateSlug(body.slug);
    if (!deps.harness.has(body.harness)) {
      throw new AnvaError(
        "harness_unknown",
        `Unknown harness "${body.harness}". Run "anva harnesses" to inspect available harnesses.`,
        400,
      );
    }
    if (deps.store.getAgent(body.slug)) {
      throw new AnvaError("agent_already_exists", `Agent "${body.slug}" already exists.`, 409);
    }
    const homeDir = deps.paths.agentHome(body.slug);
    ensureAgentHome(homeDir, { name: body.name, persona: body.persona });
    const agent = deps.store.createAgent({
      slug: body.slug,
      name: body.name,
      defaultHarness: body.harness,
      defaultModel: body.model ?? null,
    });
    return c.json(
      {
        agent: {
          ...agent,
          home: homeDir,
          noEnv: deps.harness.refusesEnv(agent.defaultHarness),
        },
      },
      201,
    );
  });

  app.patch("/v1/agents/:slug", async (c) => {
    const slug = c.req.param("slug");
    const body = parseBody(updateAgentSchema, await readJsonBody(c));
    if (body.harness && !deps.harness.has(body.harness)) {
      throw new AnvaError(
        "harness_unknown",
        `Unknown harness "${body.harness}". Run "anva harnesses" to inspect available harnesses.`,
        400,
      );
    }
    const agent = deps.store.updateAgent(slug, {
      name: body.name,
      defaultHarness: body.harness,
      defaultModel: body.model,
    });
    return c.json({
      agent: {
        ...agent,
        home: deps.paths.agentHome(agent.slug),
        noEnv: deps.harness.refusesEnv(agent.defaultHarness),
      },
    });
  });

  app.post("/v1/ask", async (c) => {
    const body = parseBody(askSchema, await readJsonBody(c));
    const result = await deps.threads.ask({
      agentSlug: body.agent,
      threadId: body.threadId,
      prompt: body.prompt,
      harness: body.harness,
      model: body.model,
      async: body.async,
      source: "cli",
    });
    return c.json(result);
  });

  app.get("/v1/threads", (c) => {
    const agentSlug = c.req.query("agent");
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const threads = deps.store
      .listThreads({
        agentSlug: agentSlug || undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
      })
      .map((t) => ({
        ...t,
        runtime: deps.threads.getThreadRuntimeStatus(t.id),
      }));
    return c.json({ threads });
  });

  app.get("/v1/threads/:id", (c) => {
    const id = c.req.param("id");
    const thread = deps.store.getThread(id);
    if (!thread) {
      throw new AnvaError("thread_not_found", `Thread "${id}" was not found.`, 404);
    }
    return c.json({
      thread: {
        ...thread,
        runtime: deps.threads.getThreadRuntimeStatus(thread.id),
      },
    });
  });

  app.patch("/v1/threads/:id/model", async (c) => {
    const id = c.req.param("id");
    const body = parseBody(switchModelSchema, await readJsonBody(c));
    const thread = await deps.threads.switchModel(id, body.model);
    return c.json({ thread });
  });

  app.patch("/v1/threads/:id/title", async (c) => {
    const id = c.req.param("id");
    const body = parseBody(renameThreadSchema, await readJsonBody(c));
    const thread = deps.store.updateThreadTitle(id, body.title);
    await deps.channels?.renameThreadTopic?.(id, body.title).catch(() => {});
    return c.json({ thread });
  });

  app.post("/v1/threads/:id/stop", async (c) => {
    const id = c.req.param("id");
    const res = await deps.threads.stopThread(id);
    return c.json(res);
  });

  app.get("/v1/sessions/search", (c) => {
    const agentSlug = c.req.query("agent")?.trim();
    const query = c.req.query("q")?.trim();
    if (!agentSlug) {
      throw new AnvaError("agent_required", "Provide ?agent=<slug> when searching sessions.", 400);
    }
    if (!query) {
      throw new AnvaError("query_required", "Provide a non-empty search query ?q=...", 400);
    }
    const threadId = c.req.query("thread")?.trim() || undefined;
    const excludeThreadId = c.req.query("excludeThread")?.trim() || undefined;
    const includeAutomation = c.req.query("includeAutomation") !== "false";
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;

    const hits = deps.history.search({
      agentSlug,
      query,
      threadId,
      excludeThreadId,
      includeAutomation,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return c.json({ hits });
  });

  app.get("/v1/sessions/:threadId/read", (c) => {
    const threadId = c.req.param("threadId");
    const agentSlug = c.req.query("agent")?.trim();
    if (!agentSlug) {
      throw new AnvaError("agent_required", "Provide ?agent=<slug> when reading a session.", 400);
    }
    const tailRaw = c.req.query("tail");
    const tail = tailRaw ? Number(tailRaw) : undefined;
    const full = c.req.query("full") === "true";
    const result = deps.history.read({
      agentSlug,
      threadId,
      tail: Number.isFinite(tail) ? tail : undefined,
      full,
    });
    return c.json(result);
  });

  app.post("/v1/db/rebuild-fts", (c) => {
    deps.history.rebuild();
    return c.json({ ok: true });
  });

  app.get("/v1/channels", (c) => {
    const channels = requireChannels(deps);
    const agentSlug = c.req.query("agent")?.trim() || undefined;
    return c.json({ connections: channels.listConnections(agentSlug) });
  });

  app.post("/v1/channels/connect", async (c) => {
    const channels = requireChannels(deps);
    const body = parseBody(connectChannelSchema, await readJsonBody(c));
    const connection = await channels.connect({
      platform: body.platform,
      agentSlug: body.agent,
      envKey: body.envKey,
    });
    return c.json({ connection }, 201);
  });

  app.delete("/v1/channels/:id", async (c) => {
    const channels = requireChannels(deps);
    const id = c.req.param("id");
    await channels.disconnect(id);
    return c.json({ ok: true });
  });

  app.post("/v1/channels/send", async (c) => {
    const channels = requireChannels(deps);
    const body = parseBody(sendChannelSchema, await readJsonBody(c));
    const sent = await channels.send({
      agentSlug: body.agent,
      target: body.target,
      text: body.text,
      filePath: body.filePath,
    });
    return c.json({ sent });
  });

  app.get("/v1/automations", (c) => {
    const agentSlug = c.req.query("agent")?.trim() || undefined;
    return c.json({ automations: deps.automations.list(agentSlug) });
  });

  app.post("/v1/automations", async (c) => {
    const body = parseBody(createAutomationSchema, await readJsonBody(c));
    const automation = deps.automations.create({
      agentSlug: body.agent,
      name: body.name,
      enabled: body.enabled,
      triggerType: body.triggerType,
      cronExpr: body.cronExpr,
      runAt: body.runAt,
      timezone: body.timezone,
      scriptCommand: body.scriptCommand,
      scriptTimeoutMs: body.scriptTimeoutMs,
      targetThreadId: body.targetThreadId,
      harnessOverride: body.harnessOverride,
      modelOverride: body.modelOverride,
      prompt: body.prompt,
      deliverTarget: body.deliverTarget,
    });
    return c.json({ automation }, 201);
  });

  app.patch("/v1/automations/:id", async (c) => {
    const id = c.req.param("id");
    const body = parseBody(updateAutomationSchema, await readJsonBody(c));
    const automation = deps.automations.update(id, body);
    return c.json({ automation });
  });

  app.delete("/v1/automations/:id", (c) => {
    const id = c.req.param("id");
    deps.automations.delete(id);
    return c.json({ ok: true });
  });

  app.post("/v1/automations/:id/test", async (c) => {
    const id = c.req.param("id");
    const run = await deps.automations.test(id);
    return c.json({ run });
  });

  app.get("/v1/automations/:id/runs", (c) => {
    const id = c.req.param("id");
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const runs = deps.automations.runs(id, Number.isFinite(limit) ? limit : undefined);
    return c.json({ runs });
  });

  return app;
}
