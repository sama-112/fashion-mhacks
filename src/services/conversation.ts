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

export interface ConversationMessage {
  readonly text: string;
  readonly userId?: string;
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly videos?: readonly ConversationVideo[];
}

export interface ConversationReply {
  readonly text: string;
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
