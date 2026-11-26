import {
  defaultRuntimes,
  type Event,
  type FailureClass,
  type Runtime,
  type RuntimeRegistry,
  type Session,
  type SessionOptions,
  type TurnOutcome,
} from "@botiverse/oar";
import { AnvaError } from "../errors.ts";

export type HarnessFailure = FailureClass | "not_installed";

export type HarnessAuthState =
  | { readonly kind: "signed_in"; readonly account?: string; readonly plan?: string }
  | { readonly kind: "signed_out"; readonly detail?: string }
  | { readonly kind: "unknown" };

export interface HarnessUsageWindow {
  readonly label: string;
  readonly usedRatio: number;
  readonly resetsAt?: string;
}

export interface HarnessUsageSnapshot {
  readonly rateLimited: boolean;
  readonly plan?: string;
  readonly windows: readonly HarnessUsageWindow[];
}

export interface HarnessStatus {
  readonly id: string;
  readonly name: string;
  readonly installed: boolean;
  readonly version?: string;
  readonly noEnv: boolean;
  readonly auth: HarnessAuthState;
  readonly usage?: HarnessUsageSnapshot;
}

export interface HarnessModel {
  readonly id: string;
  readonly name: string;
  readonly isDefault?: boolean;
  readonly disabledReason?: string;
}

export type HarnessModelList =
  | { readonly kind: "ok"; readonly models: readonly HarnessModel[] }
  | { readonly kind: "unauthenticated"; readonly detail?: string }
  | { readonly kind: "unsupported"; readonly reason: string };

export interface HarnessOpenOptions {
  readonly harness: string;
  readonly model?: string | null;
  readonly cwd: string;
  readonly resume?: string | null;
  readonly appendSystemPrompt: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface HarnessTurnEnd {
  readonly kind: "completed" | "aborted" | "failed";
  readonly failure?: HarnessFailure;
  readonly reason?: string;
}

export interface HarnessSessionCallbacks {
  onTextDelta(text: string): void;
  onToolCallStarted?(toolName: string): void;
  onTurnEnded(outcome: HarnessTurnEnd): void;
  onExited(reason?: string): void;
}

export type HarnessDeliverLanded = "prompted" | "steered" | "queued";

export interface HarnessContextUsage {
  readonly tokens: number | null;
  readonly contextWindow: number | null;
  readonly percent: number | null;
}

export interface HarnessInputImage {
  readonly path: string;
  readonly mediaType?: string;
}

export interface HarnessSessionHandle {
  readonly id: string;
  readonly noEnv: boolean;
  readonly noAppendSystemPrompt?: boolean;
  readonly supportsImages: boolean;
  deliver(
    text: string,
    inputId: string,
    images?: readonly HarnessInputImage[],
  ): Promise<HarnessDeliverLanded>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
  contextUsage(): HarnessContextUsage | null;
  activeModel(): string | null;
  isRunning(): boolean;
}

export interface HarnessAdapter {
  has(harnessId: string): boolean;
  refusesEnv(harnessId: string): boolean;
  catalog(): Promise<HarnessStatus[]>;
  probe(harnessId: string): Promise<HarnessStatus>;
  models(harnessId: string, cwd?: string): Promise<HarnessModelList>;
  open(
    options: HarnessOpenOptions,
    callbacks: HarnessSessionCallbacks,
  ): Promise<HarnessSessionHandle>;
}

const PROBE_TIMEOUT_MS = 15_000;

function selectRuntime(runtime: Runtime): Runtime {
  return runtime.execution === "process" ? runtime.withPlacement("isolated") : runtime;
}

function mapTurnOutcome(outcome: TurnOutcome): HarnessTurnEnd {
  if (outcome.kind === "completed") {
    return { kind: "completed" };
  }
  if (outcome.kind === "aborted") {
    return { kind: "aborted" };
  }
  return {
    kind: "failed",
    failure: outcome.failure,
    reason: outcome.reason,
  };
}

function extractVersion(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  return /\d+(?:\.\d+)+/.exec(raw)?.[0] ?? raw;
}

export function createOarHarnessAdapter(
  registry: RuntimeRegistry = defaultRuntimes,
): HarnessAdapter {
  const getRuntime = (harnessId: string): Runtime => {
    const rt = registry.get(harnessId);
    if (!rt) {
      throw new AnvaError(
        "harness_unknown",
        `Unknown harness "${harnessId}". Run "anva harnesses" to inspect available harnesses.`,
        400,
      );
    }
    return selectRuntime(rt);
  };

  const probeAuth = async (
    runtime: Runtime,
    installation: NonNullable<Awaited<ReturnType<NonNullable<Runtime["installation"]>>>>,
  ): Promise<HarnessAuthState> => {
    if (installation.kind !== "available" || !runtime.authStatus) {
      return { kind: "unknown" };
    }
    const auth = await runtime
      .authStatus(installation, { timeoutMs: PROBE_TIMEOUT_MS })
      .catch(() => undefined);
    if (auth?.kind === "logged_in") {
      const account = auth.account?.email ?? auth.account?.method;
      return {
        kind: "signed_in",
        ...(account ? { account } : {}),
        ...(auth.account?.plan ? { plan: auth.account.plan } : {}),
      };
    }
    if (auth?.kind === "logged_out") {
      return {
        kind: "signed_out",
        ...(auth.detail ? { detail: auth.detail } : {}),
      };
    }
    return { kind: "unknown" };
  };

  const probeUsage = async (
    runtime: Runtime,
    installation: NonNullable<Awaited<ReturnType<NonNullable<Runtime["installation"]>>>>,
  ): Promise<HarnessUsageSnapshot | undefined> => {
    if (installation.kind !== "available" || !runtime.accountUsage) {
      return undefined;
    }
    const usage = await runtime
      .accountUsage(installation, { timeoutMs: PROBE_TIMEOUT_MS, limitResetDetails: false })
      .catch(() => undefined);
    if (usage?.kind !== "available") {
      return undefined;
    }
    return {
      rateLimited: usage.rateLimited,
      ...(usage.plan ? { plan: usage.plan } : {}),
      windows: usage.windows.map((w) => ({
        label: w.label,
        usedRatio: Math.min(1, Math.max(0, w.usedRatio)),
        ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
      })),
    };
  };

  const probeRuntime = async (runtime: Runtime): Promise<HarnessStatus> => {
    const snapshot = await runtime.installation?.().catch(() => undefined);
    const installed = snapshot?.kind === "available";
    const version =
      snapshot?.kind === "available" && snapshot.via === "executable"
        ? extractVersion(snapshot.version)
        : undefined;
    const [auth, usage] =
      snapshot?.kind === "available"
        ? await Promise.all([probeAuth(runtime, snapshot), probeUsage(runtime, snapshot)])
        : [{ kind: "unknown" } as const, undefined];
    return {
      id: runtime.id,
      name: runtime.brand.name,
      installed,
      ...(version ? { version } : {}),
      noEnv: "env" in (runtime.refusedSessionOptions ?? {}),
      auth,
      ...(usage ? { usage } : {}),
    };
  };

  return {
    has(harnessId: string): boolean {
      return registry.get(harnessId) !== undefined;
    },

    refusesEnv(harnessId: string): boolean {
      const rt = registry.get(harnessId);
      return rt ? "env" in (rt.refusedSessionOptions ?? {}) : false;
    },

    async catalog(): Promise<HarnessStatus[]> {
      const runtimes = registry.list().map(selectRuntime);
      return Promise.all(runtimes.map((runtime) => probeRuntime(runtime)));
    },

    async probe(harnessId: string): Promise<HarnessStatus> {
      return probeRuntime(getRuntime(harnessId));
    },

    async models(harnessId: string, cwd?: string): Promise<HarnessModelList> {
      const runtime = getRuntime(harnessId);
      const snapshot = await runtime.installation?.();
      if (snapshot?.kind !== "available") {
        throw new AnvaError(
          "harness_not_installed",
          `Harness "${harnessId}" is not installed on this machine.`,
          400,
        );
      }
      if (!runtime.listModels) {
        return { kind: "unsupported", reason: `${harnessId} does not expose a model list.` };
      }
      const res = await runtime.listModels(snapshot, { cwd, timeoutMs: PROBE_TIMEOUT_MS });
      if (res.kind === "unauthenticated") {
        return { kind: "unauthenticated", ...(res.detail ? { detail: res.detail } : {}) };
      }
      if (res.kind === "unsupported") {
        return { kind: "unsupported", reason: res.reason };
      }
      return {
        kind: "ok",
        models: res.models.map((m) => ({
          id: m.id,
          name: m.displayName ?? m.id,
          ...(m.default ? { isDefault: true } : {}),
          ...(m.disabled ? { disabledReason: m.disabled.reason } : {}),
        })),
      };
    },

    async open(
      options: HarnessOpenOptions,
      callbacks: HarnessSessionCallbacks,
    ): Promise<HarnessSessionHandle> {
      const runtime = getRuntime(options.harness);
      const snapshot = await runtime.installation?.();
      if (snapshot?.kind !== "available") {
        throw new AnvaError(
          "harness_not_installed",
          `Harness "${options.harness}" is not installed on this machine.`,
          400,
        );
      }

      const refused = runtime.refusedSessionOptions ?? {};
      const noEnv = "env" in refused;
      const canAppendPrompt = !("appendSystemPrompt" in refused);

      const sessionOptions: SessionOptions = {
        cwd: options.cwd,
        ...(options.model ? { model: options.model } : {}),
        ...(options.resume ? { resume: options.resume } : {}),
        ...(canAppendPrompt && options.appendSystemPrompt
          ? { appendSystemPrompt: options.appendSystemPrompt }
          : {}),
        ...(!noEnv && Object.keys(options.env).length > 0 ? { env: options.env } : {}),
      };

      let session: Session;
      try {
        session = await runtime.session(snapshot, sessionOptions);
      } catch (error) {
        if (options.resume) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new AnvaError(
            "session_resume_failed",
            `Failed to resume native session "${options.resume}" (${detail}). Start a new thread with "anva ask <agent> ...".`,
            409,
          );
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new AnvaError("harness_open_failed", detail, 502);
      }

      let disposed = false;
      const unsubscribe = session.events((event: Event) => {
        if (disposed) {
          return;
        }
        switch (event.kind) {
          case "text_delta":
            callbacks.onTextDelta(event.text);
            break;
          case "tool_call_started": {
            const name =
              event.server && event.toolName
                ? `${event.server}/${event.toolName}`
                : (event.toolName ?? event.tool);
            callbacks.onToolCallStarted?.(name);
            break;
          }
          case "turn_ended":
            callbacks.onTurnEnded(mapTurnOutcome(event.outcome));
            break;
          case "exited":
            callbacks.onExited(event.reason);
            break;
          default:
            break;
        }
      });

      return {
        id: session.id,
        noEnv,
        noAppendSystemPrompt: !canAppendPrompt,
        supportsImages: session.capabilities.images,

        async deliver(
          text: string,
          inputId: string,
          images?: readonly HarnessInputImage[],
        ): Promise<HarnessDeliverLanded> {
          const attachImages =
            session.capabilities.images && images && images.length > 0 ? images : undefined;
          const res = await session.deliver(text, {
            when: "now",
            inputId,
            ...(attachImages ? { images: attachImages } : {}),
          });
          if (res.landed === "rejected") {
            throw new AnvaError(
              res.failure ?? "deliver_rejected",
              res.reason || `Harness rejected input (${res.code}).`,
              409,
            );
          }
          return res.landed;
        },

        async abort(): Promise<void> {
          await session.abort();
        },

        async dispose(): Promise<void> {
          if (disposed) {
            return;
          }
          disposed = true;
          unsubscribe();
          await session.dispose();
        },

        contextUsage(): HarnessContextUsage | null {
          return session.contextUsage().value;
        },

        activeModel(): string | null {
          return session.model().value;
        },

        isRunning(): boolean {
          return session.status().value.kind === "running";
        },
      };
    },
  };
}
