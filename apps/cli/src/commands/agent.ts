import {
  type AgentRecord,
  AnvaError,
  listAgentEnvNames,
  resolveAnvaPaths,
  setAgentEnvVar,
  unsetAgentEnvVar,
  validateSlug,
} from "@anva/core";
import { defineCommand } from "citty";
import { apiRequest, emitResult, getCliRuntime, resolveConnection } from "../context.ts";

const agentEnvListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List configured .env variable names for an agent",
  },
  args: {
    slug: { type: "positional", description: "Agent slug", required: true },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  run({ args }) {
    const slug = args.slug;
    validateSlug(slug);
    const paths = resolveAnvaPaths(getCliRuntime().env.ANVA_HOME);
    const names = listAgentEnvNames(paths.agentEnv(slug));
    emitResult(
      args.json,
      { slug, names },
      names.length > 0 ? names.join("\n") : "(no env vars configured)",
    );
  },
});

const agentEnvSetCommand = defineCommand({
  meta: {
    name: "set",
    description: "Set a variable in an agent's .env file",
  },
  args: {
    slug: { type: "positional", description: "Agent slug", required: true },
    name: { type: "positional", description: "Variable name (or NAME=VALUE)", required: true },
    value: { type: "positional", description: "Variable value", required: false },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  run({ args }) {
    const slug = args.slug;
    validateSlug(slug);
    let name = args.name;
    let value = args.value;
    if (name.includes("=") && value === undefined) {
      const idx = name.indexOf("=");
      value = name.slice(idx + 1);
      name = name.slice(0, idx);
    }
    if (!name || value === undefined) {
      throw new AnvaError("invalid_args", "Usage: anva agent env set <slug> <NAME> <VALUE>");
    }
    const paths = resolveAnvaPaths(getCliRuntime().env.ANVA_HOME);
    const envPath = paths.agentEnv(slug);
    setAgentEnvVar(envPath, name, value);
    emitResult(args.json, { slug, name, set: true }, `Set ${name} in ${envPath}`);
  },
});

const agentEnvUnsetCommand = defineCommand({
  meta: {
    name: "unset",
    description: "Remove a variable from an agent's .env file",
  },
  args: {
    slug: { type: "positional", description: "Agent slug", required: true },
    name: { type: "positional", description: "Variable name", required: true },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  run({ args }) {
    const slug = args.slug;
    validateSlug(slug);
    const paths = resolveAnvaPaths(getCliRuntime().env.ANVA_HOME);
    const envPath = paths.agentEnv(slug);
    const removed = unsetAgentEnvVar(envPath, args.name);
    emitResult(
      args.json,
      { slug, name: args.name, removed },
      removed ? `Removed ${args.name} from ${envPath}` : `${args.name} was not set`,
    );
  },
});

const agentEnvCommand = defineCommand({
  meta: {
    name: "env",
    description: "Manage per-agent .env variables locally",
  },
  subCommands: {
    list: agentEnvListCommand,
    set: agentEnvSetCommand,
    unset: agentEnvUnsetCommand,
  },
});

const agentListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List configured agents",
  },
  args: {
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const conn = resolveConnection(getCliRuntime().env);
    const res = await apiRequest<{
      readonly agents: (AgentRecord & { readonly home: string; readonly noEnv: boolean })[];
    }>(conn, "GET", "/v1/agents");
    const lines = res.agents.map(
      (a) =>
        `${a.slug}\t${a.name}\tharness=${a.defaultHarness}${a.defaultModel ? `\tmodel=${a.defaultModel}` : ""}\thome=${a.home}`,
    );
    emitResult(
      args.json,
      res,
      lines.length > 0 ? lines.join("\n") : "(no agents yet; create one with anva agent create)",
    );
  },
});

const agentCreateCommand = defineCommand({
  meta: {
    name: "create",
    description: "Create a new agent",
  },
  args: {
    slug: { type: "positional", description: "Agent slug", required: true },
    name: { type: "string", description: "Display name", required: true },
    harness: { type: "string", description: "Default OAR harness ID", required: true },
    model: { type: "string", description: "Default model ID" },
    persona: { type: "string", description: "Initial PERSONA.md text" },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const conn = resolveConnection(getCliRuntime().env);
    const res = await apiRequest<{ readonly agent: AgentRecord & { readonly home: string } }>(
      conn,
      "POST",
      "/v1/agents",
      {
        slug: args.slug,
        name: args.name,
        harness: args.harness,
        ...(args.model ? { model: args.model } : {}),
        ...(args.persona ? { persona: args.persona } : {}),
      },
    );
    emitResult(
      args.json,
      res,
      `Created agent "${res.agent.slug}" (${res.agent.defaultHarness}) at ${res.agent.home}`,
    );
  },
});

const agentUpdateCommand = defineCommand({
  meta: {
    name: "update",
    description: "Update an agent's name, default harness, or default model",
  },
  args: {
    slug: { type: "positional", description: "Agent slug", required: true },
    name: { type: "string", description: "New display name" },
    harness: { type: "string", description: "New default harness ID (new threads only)" },
    model: { type: "string", description: "New default model ID" },
    json: { type: "boolean", description: "Print structured JSON output" },
  },
  async run({ args }) {
    const conn = resolveConnection(getCliRuntime().env);
    const res = await apiRequest<{ readonly agent: AgentRecord }>(
      conn,
      "PATCH",
      `/v1/agents/${encodeURIComponent(args.slug)}`,
      {
        ...(args.name ? { name: args.name } : {}),
        ...(args.harness ? { harness: args.harness } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
      },
    );
    emitResult(
      args.json,
      res,
      `Updated agent "${res.agent.slug}" (defaultHarness=${res.agent.defaultHarness})`,
    );
  },
});

export const agentCommand = defineCommand({
  meta: {
    name: "agent",
    description: "Manage agents and per-agent .env variables",
  },
  subCommands: {
    list: agentListCommand,
    create: agentCreateCommand,
    update: agentUpdateCommand,
    env: agentEnvCommand,
  },
});
