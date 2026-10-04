import { createClient } from "@supabase/supabase-js";
import type { ConversationMessage } from "../services/conversation.ts";

export interface AcceptedEvent {
  eventId: string;
  agentId: string;
  payload: Record<string, unknown>;
  message: ConversationMessage | null;
}

export interface PendingEvent {
  eventId: string;
  message: ConversationMessage;
  attempts: number;
  replyText: string | null;
}

export interface EventInbox {
  acceptOnce(event: AcceptedEvent): Promise<void>;
  pending(): Promise<PendingEvent[]>;
  saveReply(eventId: string, text: string): Promise<void>;
  complete(eventId: string): Promise<void>;
  retry(eventId: string, attempts: number, terminal: boolean, retryAfterSeconds?: number): Promise<void>;
}

export const MAX_ATTEMPTS = 5;

export function createInbox(url: string, secretKey: string) {
  const client = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => fetch(input, {
        ...init,
        signal: AbortSignal.any([
          AbortSignal.timeout(5000),
          ...(init?.signal ? [init.signal] : []),
        ]),
      }),
    },
  });
  const table = () => client.from("relay_event_inbox");
  function check(error: unknown) {
    // Provider responses can contain request details. Keep secrets and payloads out of logs.
    if (error) throw new Error("Supabase inbox operation failed; check credentials and migration.");
  }

  return {
    async checkAccess() {
      const { error } = await table().select("event_id").limit(1);
      check(error);
    },
    async acceptOnce(event: AcceptedEvent) {
      const { error } = await table().upsert({
        event_id: event.eventId,
        agent_id: event.agentId,
        payload: event.payload,
        message: event.message,
        completed_at: event.message ? null : new Date().toISOString(),
      }, { onConflict: "event_id", ignoreDuplicates: true })
        .abortSignal(AbortSignal.timeout(5000));
      check(error);
    },
    async pending(): Promise<PendingEvent[]> {
      const { data, error } = await table()
        .select("event_id,message,attempts,reply_text")
        .is("completed_at", null)
        .lt("attempts", MAX_ATTEMPTS)
        .lte("next_attempt_at", new Date().toISOString())
        .order("received_at")
        .limit(10);
      check(error);
      return (data ?? []).map(row => ({
        eventId: row.event_id as string,
        message: row.message as ConversationMessage,
        attempts: row.attempts as number,
        replyText: row.reply_text as string | null,
      }));
    },
    async saveReply(eventId: string, text: string) {
      const { error } = await table().update({ reply_text: text }).eq("event_id", eventId);
      check(error);
    },
    async complete(eventId: string) {
      const { error } = await table().update({ completed_at: new Date().toISOString() })
        .eq("event_id", eventId);
      check(error);
    },
    async retry(eventId: string, attempts: number, terminal: boolean, retryAfterSeconds = 0) {
      const delay = Math.max(Math.min(60000, 1000 * 2 ** attempts), retryAfterSeconds * 1000);
      const { error } = await table().update({
        attempts: terminal ? MAX_ATTEMPTS : attempts,
        next_attempt_at: new Date(Date.now() + delay).toISOString(),
      }).eq("event_id", eventId);
      check(error);
    },
  } satisfies EventInbox & { checkAccess(): Promise<void> };
}
