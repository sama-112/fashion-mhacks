import { setTimeout as delay } from "node:timers/promises";
import { MAX_ATTEMPTS, type EventInbox } from "../db/inbox.ts";
import { isTerminalSendError, retryAfterSeconds, safeRelayError, type RelayAdapter } from "../integrations/relay.ts";
import { handleConversation } from "./conversation.ts";

export async function processPending(inbox: EventInbox, adapter: RelayAdapter, signal?: AbortSignal) {
  for (const event of await inbox.pending()) {
    if (signal?.aborted) return;
    try {
      // Persist the exact answer before sending: retries keep the same body, even after a restart.
      const text = event.replyText ?? (await handleConversation(event.message)).text;
      if (event.replyText === null) await inbox.saveReply(event.eventId, text);
      await adapter.sendReply(event.eventId, event.message, text, signal);
      await inbox.complete(event.eventId);
      console.log(`Reply accepted by Relay: event=${event.eventId} chat=${event.message.conversationId}`);
    } catch (error) {
      if (signal?.aborted) return;
      const terminal = isTerminalSendError(error);
      const attempts = event.attempts + 1;
      await inbox.retry(event.eventId, attempts, terminal, retryAfterSeconds(error));
      const detail = error instanceof Error && error.message.startsWith("Supabase inbox")
        ? "Inbox state update failed; the persisted reply can be retried safely."
        : safeRelayError(error);
      const attention = terminal || attempts >= MAX_ATTEMPTS ? " Manual attention required." : "";
      console.error(`Reply attempt failed: event=${event.eventId} attempt=${attempts}. ${detail}${attention}`);
    }
  }
}

export async function runWorker(inbox: EventInbox, adapter: RelayAdapter, signal: AbortSignal) {
  // One worker per deployment. This polls our durable inbox, not the Relay API.
  while (!signal.aborted) {
    try {
      await processPending(inbox, adapter, signal);
    } catch {
      console.error("Inbox worker unavailable; pending work remains stored. Check Supabase.");
    }
    try {
      await delay(1000, undefined, { signal });
    } catch {
      if (!signal.aborted) throw new Error("Worker timer failed.");
    }
  }
}
