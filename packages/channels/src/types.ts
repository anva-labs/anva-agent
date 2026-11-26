export type ChannelPlatform = "telegram";

export interface InboundAttachment {
  readonly kind: "photo" | "document" | "audio" | "voice" | "video";
  readonly fileId: string;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly fileSize?: number;
  readonly localPath?: string;
}

export interface InboundMessage {
  readonly connectionId: string;
  readonly platform: ChannelPlatform;
  readonly externalChatId: string;
  readonly externalThreadId: string;
  readonly senderId: string;
  readonly senderName?: string;
  readonly messageId: string;
  readonly text: string;
  readonly attachments: readonly InboundAttachment[];
  readonly receivedAt: number;
}

export interface OutboundTarget {
  readonly externalChatId: string;
  readonly externalThreadId: string;
}

export interface LiveReplyHandle {
  sendTextSegment(text: string): Promise<boolean>;
  recordToolCall(toolName: string): void;
  finish(finalText: string): Promise<void>;
  fail(errorText: string): Promise<void>;
}
