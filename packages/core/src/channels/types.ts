import type { HarnessAdapter } from "../harness/oar-adapter.ts";
import type { AnvaPaths } from "../paths.ts";
import type { ThreadManager } from "../runtime/thread-manager.ts";
import type { AnvaStore, ChannelConnectionRecord } from "../store/db.ts";

export interface ChannelConnectionSummary extends ChannelConnectionRecord {
  readonly connected: boolean;
  readonly pairingUrl?: string;
}

export interface ChannelConnectInput {
  readonly platform: string;
  readonly agentSlug: string;
  readonly envKey?: string;
}

export interface ChannelSendInput {
  readonly agentSlug?: string;
  readonly target: string;
  readonly text?: string;
  readonly filePath?: string;
}

export interface ChannelSendResult {
  readonly connectionId: string;
  readonly externalChatId: string;
  readonly externalThreadId: string;
  readonly messageIds: readonly string[];
}

export interface ChannelBridgeContext {
  readonly store: AnvaStore;
  readonly harness: HarnessAdapter;
  readonly threads: ThreadManager;
  readonly paths: AnvaPaths;
}

export interface ChannelBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  listConnections(agentSlug?: string): ChannelConnectionSummary[];
  connect(input: ChannelConnectInput): Promise<ChannelConnectionSummary>;
  disconnect(connectionId: string): Promise<void>;
  send(input: ChannelSendInput): Promise<ChannelSendResult>;
  renameThreadTopic?(threadId: string, title: string): Promise<void>;
}

export type ChannelBridgeFactory = (ctx: ChannelBridgeContext) => ChannelBridge;
