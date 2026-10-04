import Relay, { RelayAPIError, type WebhookHeaders } from "@relaymessenger/sdk";
import type { AcceptedEvent } from "../db/inbox.ts";
import type { ConversationMessage, ConversationVideo } from "../services/conversation.ts";
import { MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS, SUPPORTED_VIDEO_TYPES } from "../wardrobe/types.ts";

export class RelayVideoError extends Error {
  constructor(message = "I couldn't download that video. Please send it again as an MP4, MOV or WebM clip up to 50 MiB and two minutes.") {
    super(message);
    this.name = "RelayVideoError";
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Relay object.");
  }
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid Relay ID.");
  }
  return value;
}

export class RelayAdapter {
  constructor(privateClient: Relay) {
    this.client = privateClient;
  }
  private readonly client: Relay;

  verify(rawBody: Buffer, headers: WebhookHeaders): AcceptedEvent {
    // The official SDK validates signature and timestamp before parsing JSON.
    const payload = object(this.client.webhooks.unwrap<unknown>(rawBody, { headers }));
    const eventId = id(payload.event_id);
    const headerId = headers instanceof Headers ? headers.get("webhook-id") : headers["webhook-id"];
    if (headerId !== eventId || payload.api_version !== "v1" ||
        payload.webhook_version !== "2026-08-30" || typeof payload.event_type !== "string") {
      throw new Error("Unsupported Relay envelope.");
    }
    const agentId = id(payload.agent_id);
    let message: ConversationMessage | null = null;
    if (payload.event_type === "message.received") {
      const data = object(payload.data);
      const chat = object(data.chat);
      const sender = object(data.sender_handle);
      const conversationId = id(chat.id);
      const userId = id(sender.id);
      const messageId = id(data.id);
      if (!Array.isArray(data.parts) || data.parts.length > 100) {
        throw new Error("Invalid Relay message parts.");
      }
      const text = data.parts.map(part => {
        const item = object(part);
        if (item.type !== "text") return "";
        if (typeof item.value !== "string" || item.value.length > 10000) {
          throw new Error("Invalid Relay text part.");
        }
        return item.value;
      }).filter(Boolean).join("\n");
      const videos: ConversationVideo[] = data.parts.flatMap(part => {
        const item = object(part);
        if (item.type !== "media" || typeof item.mime_type !== "string" || !item.mime_type.startsWith("video/")) return [];
        return [{ mediaId: id(item.id), mimeType: item.mime_type,
          ...(typeof item.size_bytes === "number" ? { sizeBytes: item.size_bytes } : {}),
          ...(typeof item.duration_ms === "number" ? { durationMs: item.duration_ms } : {}),
        }];
      });
      if (text.length > 10000) throw new Error("Relay message text is too long.");
      // Keep every raw part in the inbox; only human direct messages start work.
      if (sender.kind === "user" && sender.is_me === false &&
          data.direction === "inbound" && chat.is_group === false && (text.trim() || videos.length)) {
        message = { text, userId, conversationId, messageId, ...(videos.length ? { videos } : {}) };
      }
    }
    return { eventId, agentId, payload, message };
  }

  async checkAccess(): Promise<void> {
    await this.client.chats.listChats({ limit: 1 });
  }

  async downloadVideo(message: ConversationMessage, video: ConversationVideo, signal?: AbortSignal): Promise<Blob> {
    const deadline = AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]);
    try {
      if (!(SUPPORTED_VIDEO_TYPES as readonly string[]).includes(video.mimeType) ||
          (video.sizeBytes !== undefined && (!Number.isFinite(video.sizeBytes) || video.sizeBytes <= 0 || video.sizeBytes > MAX_VIDEO_BYTES)) ||
          (video.durationMs !== undefined && (!Number.isFinite(video.durationMs) || video.durationMs > MAX_VIDEO_SECONDS * 1000))) {
        throw new RelayVideoError();
      }
      if (!message.messageId || !message.userId || !message.conversationId) throw new RelayVideoError();
      const original = await this.client.messages.retrieve(message.messageId, { signal: deadline });
      if (original.id !== message.messageId || original.chat_id !== message.conversationId || original.is_from_me ||
          original.from_handle?.id !== message.userId || original.from_handle.kind !== "user" ||
          !original.parts?.some(part => part.type === "media" && part.id === video.mediaId && part.mime_type === video.mimeType)) {
        throw new RelayVideoError();
      }
      // Refresh signed links through the authenticated API, never use a URL from user text.
      const attachment = await this.client.attachments.retrieve(video.mediaId, { signal: deadline });
      if (attachment.id !== video.mediaId || attachment.status !== "complete" ||
          attachment.content_type !== video.mimeType || !attachment.download_url ||
          attachment.size_bytes <= 0 || attachment.size_bytes > MAX_VIDEO_BYTES ||
          (attachment.duration_ms ?? 0) > MAX_VIDEO_SECONDS * 1000) throw new RelayVideoError();
      const url = new URL(attachment.download_url);
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
          url.hostname === "localhost" || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) throw new RelayVideoError();
      const response = await fetch(url, { signal: deadline, redirect: "error" });
      if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > MAX_VIDEO_BYTES) {
        await response.body?.cancel();
        throw new RelayVideoError();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_VIDEO_BYTES) throw new RelayVideoError();
          chunks.push(new Uint8Array(chunk.value));
        }
      } finally { await reader.cancel(); }
      if (!bytes || bytes !== attachment.size_bytes) throw new RelayVideoError();
      return new Blob(chunks, { type: video.mimeType });
    } catch {
      signal?.throwIfAborted();
      throw new RelayVideoError();
    }
  }

  async sendReply(eventId: string, message: ConversationMessage, text: string, signal?: AbortSignal) {
    if (!message.conversationId || !message.messageId) throw new Error("Missing reply identity.");
    await this.client.chats.messages.send(message.conversationId, {
      message: {
        parts: [{ type: "text", value: text }],
        reply_to: { message_id: message.messageId },
        idempotency_key: `stylist-reply:${eventId}`,
      },
    }, { signal });
  }
}

export function safeRelayError(error: unknown): string {
  if (error instanceof RelayAPIError) {
    return `Relay request failed (HTTP ${error.status ?? "unknown"}, code ${error.code ?? "unknown"}).`;
  }
  return "Relay request failed; check network connectivity and configuration.";
}

export function isTerminalSendError(error: unknown): boolean {
  return error instanceof RelayAPIError && error.status !== undefined &&
    error.status >= 400 && error.status < 500 && error.status !== 429 && error.status !== 408;
}

export function retryAfterSeconds(error: unknown): number {
  return error instanceof RelayAPIError && Number.isFinite(error.retryAfter)
    ? Math.max(0, error.retryAfter!) : 0;
}
