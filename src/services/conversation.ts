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

export async function handleConversation(
  message: ConversationMessage,
): Promise<ConversationReply> {
  if (message.text.trim().length === 0) {
    throw new Error("Message text must not be empty.");
  }

  return { text: "Your stylist is connected." };
}
