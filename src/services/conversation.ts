import type { GenerateContentParameters } from "@google/genai";

// These are internal service types, not a Relay request or response format.
export interface ConversationMessage {
  readonly text: string;
  readonly userId?: string;
  readonly conversationId?: string;
  readonly messageId?: string;
}

export interface ConversationReply {
  readonly text: string;
}

export type ConversationHandler = (message: ConversationMessage) => Promise<ConversationReply>;

export interface GeminiTextClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<{ text?: string }>;
  };
}

const INSTRUCTIONS = `You are a friendly personal fashion stylist chatting in Relay. Give practical, kind, concise styling advice. Ask a brief follow-up when needed. Never invent product availability, prices, purchases, or actions you did not take. Keep replies under 120 words.`;

export function createConversationHandler(
  client: GeminiTextClient,
  models: { text: string; fallback: string },
): ConversationHandler {
  return async message => {
    if (message.text.trim().length === 0) {
      throw new Error("Message text must not be empty.");
    }

    for (const model of new Set([models.text, models.fallback])) {
      try {
        const response = await client.models.generateContent({
          model,
          contents: message.text,
          config: { systemInstruction: INSTRUCTIONS, maxOutputTokens: 400 },
        });
        const text = response.text?.trim();
        if (text) return { text };
      } catch {
        // Try the configured fallback without logging user content or provider details.
      }
    }
    throw new Error("Stylist response generation failed.");
  };
}
