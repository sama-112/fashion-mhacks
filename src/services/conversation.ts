import { StylistAgent } from "../agents/stylist/agent.ts";
import { GeminiStylistModel, type GeminiTextClient } from "../agents/stylist/gemini.ts";
import { MockProductCatalog, type ProductCatalog } from "../shopper/index.ts";
export type { GeminiTextClient } from "../agents/stylist/gemini.ts";

// These are internal service types, not a Relay request or response format.
export interface ConversationVideo {
  readonly mediaId: string;
  readonly mimeType: string;
  readonly sizeBytes?: number;
  readonly durationMs?: number;
}
export interface ConversationPhoto { readonly mediaId: string; readonly mimeType: string; readonly sizeBytes?: number }
export interface ConversationAudio extends ConversationPhoto { readonly durationMs?: number }

export interface ConversationMessage {
  readonly text: string;
  readonly userId?: string;
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly videos?: readonly ConversationVideo[];
  readonly photos?: readonly ConversationPhoto[];
  readonly audio?: readonly ConversationAudio[];
  // Only trusted internal delivery creates this flag; webhook input cannot set it.
  readonly deliveryKind?: "weekly" | "voice";
  // Private snapshot reference from a verified live call, never webhook/body input.
  readonly callPhoto?: { readonly callId: string; readonly storagePath: string | null };
}

export interface ConversationImage { readonly attachmentId: string; readonly mimeType: string }
export interface ConversationReply {
  readonly text: string;
  readonly images?: readonly ConversationImage[];
  readonly skipDelivery?: true;
}

export interface ConversationTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface ConversationContext {
  readonly eventId?: string;
  readonly signal?: AbortSignal;
  readonly receivedAt?: string;
}

export type ConversationHandler = (message: ConversationMessage, context?: ConversationContext) => Promise<ConversationReply>;
export type ConversationHistory = (message: ConversationMessage, before: string) => Promise<readonly ConversationTurn[]>;

export function createConversationHandler(
  client: GeminiTextClient,
  models: { text: string; fallback: string },
  options: { catalog: ProductCatalog; history?: ConversationHistory } = { catalog: new MockProductCatalog() },
): ConversationHandler {
  const stylist = new StylistAgent(new GeminiStylistModel(client, models), options.catalog);
  return async (message, context) => {
    if (message.text.trim().length === 0) {
      throw new Error("Message text must not be empty.");
    }

    context?.signal?.throwIfAborted();
    // Preserve the original milestone-1 acceptance reply without requiring a model call.
    if (message.text.trim().toLowerCase() === "hello") return { text: "Your stylist is connected." };
    const history = context?.receivedAt && options.history
      ? await options.history(message, context.receivedAt) : [];
    const answer = await stylist.respond({ text: message.text, history }, context?.signal);
    return { text: answer.text };
  };
}
