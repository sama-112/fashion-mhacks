import Relay, { RelayAPIError, type WebhookHeaders } from "@relaymessenger/sdk";
import type { AcceptedEvent } from "../db/inbox.ts";
import type { ConversationMessage } from "../services/conversation.ts";

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
      // Milestone 1 responds to human direct messages. Keep every raw part in the inbox.
      if (sender.kind === "user" && sender.is_me === false &&
          data.direction === "inbound" && chat.is_group === false && text.trim()) {
        message = { text, userId, conversationId, messageId };
      }
    }
    return { eventId, agentId, payload, message };
  }

  async checkAccess(): Promise<void> {
    await this.client.chats.listChats({ limit: 1 });
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
