import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import Relay, { RelayAPIError, signWebhookHeaders } from "@relaymessenger/sdk";
import { MAX_ATTEMPTS, type AcceptedEvent, type EventInbox, type PendingEvent } from "../src/db/inbox.ts";
import { RelayAdapter } from "../src/integrations/relay.ts";
import { createRelayServer } from "../src/server.ts";
import { createConversationHandler, type ConversationHandler } from "../src/services/conversation.ts";
import { processPending } from "../src/services/relay-worker.ts";

// Synthetic credentials, identities, storage and API transport. No provider is contacted.
const secret = `whsec_${randomBytes(32).toString("base64")}`;
const chatId: string = randomUUID();
const userId: string = randomUUID();
const messageId: string = randomUUID();
const agentId: string = randomUUID();
const testConversation: ConversationHandler = async () => ({ text: "Your stylist is connected." });
function fixture() {
  return {
    api_version: "v1", webhook_version: "2026-08-30", event_type: "message.received",
    event_id: randomUUID(), agent_id: agentId, created_at: new Date().toISOString(),
    trace_id: "fixture-trace",
    data: {
      id: messageId, chat: { id: chatId, is_group: false }, direction: "inbound",
      sender_handle: { id: userId, handle: "fixture_user", kind: "user", is_me: false },
      parts: [{ type: "text", value: "hello" }],
    },
  };
}

class MemoryInbox implements EventInbox {
  rows = new Map<string, PendingEvent & { done: boolean }>();
  failWrites = false;
  commitGate: Promise<void> | null = null;
  lastRetryAfter = 0;
  async acceptOnce(event: AcceptedEvent) {
    if (this.failWrites) throw new Error("Fixture storage failure.");
    if (this.commitGate) await this.commitGate;
    if (event.message && !this.rows.has(event.eventId)) {
      this.rows.set(event.eventId, {
        eventId: event.eventId, message: event.message, attempts: 0, replyText: null, done: false,
      });
    }
  }
  async pending() {
    return [...this.rows.values()].filter(row => !row.done && row.attempts < MAX_ATTEMPTS)
      .map(row => ({ ...row }));
  }
  async saveReply(eventId: string, text: string) { this.rows.get(eventId)!.replyText = text; }
  async complete(eventId: string) { this.rows.get(eventId)!.done = true; }
  async retry(eventId: string, attempts: number, terminal: boolean, retryAfterSeconds = 0) {
    this.rows.get(eventId)!.attempts = terminal ? MAX_ATTEMPTS : attempts;
    this.lastRetryAfter = retryAfterSeconds;
  }
}

function harness() {
  const requests: { url: string; body: unknown }[] = [];
  let sendError: Error | null = null;
  const adapter = new RelayAdapter(new Relay({
    apiKey: "synthetic-test-token", webhookSecret: secret, maxRetries: 0,
    fetch: async (input, init) => {
      requests.push({ url: input.toString(), body: JSON.parse(init?.body as string) });
      if (sendError instanceof RelayAPIError) {
        return new Response(JSON.stringify({ code: 2003, message: "fixture error" }), {
          status: sendError.status ?? 500, headers: {
            "Content-Type": "application/json",
            ...(sendError.retryAfter ? { "Retry-After": String(sendError.retryAfter) } : {}),
          },
        });
      }
      if (sendError) throw sendError;
      return new Response(JSON.stringify({ message: { id: randomUUID() } }), {
        status: 201, headers: { "Content-Type": "application/json" },
      });
    },
  }));
  return { adapter, requests, inbox: new MemoryInbox(), failSend(error: Error | null) { sendError = error; } };
}

function verified(adapter: RelayAdapter, event: ReturnType<typeof fixture>) {
  const body = JSON.stringify(event);
  return adapter.verify(Buffer.from(body), signWebhookHeaders(secret, { id: event.event_id, body }));
}

test("human hello preserves identities and sends the documented reply with a stable key", async () => {
  const { adapter, inbox, requests } = harness();
  const event = fixture();
  const accepted = verified(adapter, event);
  assert.deepEqual(accepted.message, { text: "hello", userId, conversationId: chatId, messageId });
  await inbox.acceptOnce(accepted);
  await processPending(inbox, adapter, testConversation);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, `https://api.relayapp.im/v1/chats/${chatId}/messages`);
  assert.deepEqual(requests[0]!.body, {
    message: {
      parts: [{ type: "text", value: "Your stylist is connected." }],
      reply_to: { message_id: messageId }, idempotency_key: `stylist-reply:${event.event_id}`,
    },
  });
});

test("Gemini uses 3.6 Flash first and falls back to 3.5 Flash", async () => {
  const models: string[] = [];
  const handleConversation = createConversationHandler({
    models: {
      generateContent: async params => {
        models.push(params.model ?? "");
        if (params.model === "gemini-3.6-flash") throw new Error("Synthetic primary-model failure.");
        return { text: "Try pairing it with a neutral layer." };
      },
    },
  }, { text: "gemini-3.6-flash", fallback: "gemini-3.5-flash" });

  const reply = await handleConversation({ text: "What should I wear with these jeans?" });
  assert.deepEqual(models, ["gemini-3.6-flash", "gemini-3.5-flash"]);
  assert.equal(reply.text, "Try pairing it with a neutral layer.");
});

test("redelivery after completion produces no second send", async () => {
  const { adapter, inbox, requests } = harness();
  const accepted = verified(adapter, fixture());
  await inbox.acceptOnce(accepted);
  await processPending(inbox, adapter, testConversation);
  await inbox.acceptOnce(accepted);
  await processPending(inbox, adapter, testConversation);
  assert.equal(requests.length, 1);
});

test("uncertain sends retry the persisted body and the same key", async () => {
  const h = harness();
  const accepted = verified(h.adapter, fixture());
  await h.inbox.acceptOnce(accepted);
  h.failSend(new Error("Fixture network outage."));
  await processPending(h.inbox, h.adapter, testConversation);
  assert.equal(h.inbox.rows.get(accepted.eventId)!.attempts, 1);
  assert.equal(h.inbox.rows.get(accepted.eventId)!.done, false);
  h.failSend(null);
  await processPending(h.inbox, h.adapter, testConversation);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[0], h.requests[1]);
  assert.equal(h.inbox.rows.get(accepted.eventId)!.done, true);
});

test("an exhausted event does not enter an unbounded retry loop", async () => {
  const h = harness();
  await h.inbox.acceptOnce(verified(h.adapter, fixture()));
  h.failSend(new Error("Fixture outage."));
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await processPending(h.inbox, h.adapter, testConversation);
  assert.equal(h.requests.length, MAX_ATTEMPTS);
});

test("a permanent Relay error stops automatic attempts", async () => {
  const h = harness();
  await h.inbox.acceptOnce(verified(h.adapter, fixture()));
  h.failSend(new RelayAPIError("fixture", { status: 403 }));
  await processPending(h.inbox, h.adapter, testConversation);
  await processPending(h.inbox, h.adapter, testConversation);
  assert.equal(h.requests.length, 1);
});

test("agent messages, outgoing events, groups and media-only messages produce no work", () => {
  const { adapter } = harness();
  const bot = fixture(); bot.data.sender_handle.kind = "agent";
  const outgoing = fixture(); outgoing.data.direction = "outbound";
  const group = fixture(); group.data.chat.is_group = true;
  const media = fixture(); media.data.parts = [{ type: "media", value: "fixture" }];
  const blank = fixture(); blank.data.parts[0]!.value = "   ";
  for (const event of [bot, outgoing, group, media, blank]) assert.equal(verified(adapter, event).message, null);
});

test("rate limiting schedules the next worker attempt after Relay's Retry-After", async () => {
  const h = harness();
  await h.inbox.acceptOnce(verified(h.adapter, fixture()));
  h.failSend(new RelayAPIError("fixture", { status: 429, retryAfter: 120 }));
  await processPending(h.inbox, h.adapter, testConversation);
  assert.equal(h.inbox.lastRetryAfter, 120);
});

test("tampering, stale signatures, mismatched event IDs and malformed messages are rejected", () => {
  const { adapter } = harness();
  const event = fixture(); const body = JSON.stringify(event);
  const headers = signWebhookHeaders(secret, { id: event.event_id, body });
  assert.throws(() => adapter.verify(Buffer.from(body.replace("hello", "other")), headers));
  assert.throws(() => adapter.verify(Buffer.from(body), signWebhookHeaders(secret, {
    id: event.event_id, body, timestamp: new Date(Date.now() - 15 * 60 * 1000),
  })));
  assert.throws(() => adapter.verify(Buffer.from(body), signWebhookHeaders(secret, { id: randomUUID(), body })));
  event.data.chat.id = "bad-id";
  assert.throws(() => verified(adapter, event));
});

test("HTTP receiver rejects unsigned requests and waits for commit before 204", async t => {
  const { adapter, inbox, requests } = harness();
  const server = createRelayServer(adapter, inbox);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/webhooks/relay`, { method: "POST", body: "{}" })).status, 401);
  assert.equal(inbox.rows.size, 0);
  const event = fixture(); const body = JSON.stringify(event);
  const headers = signWebhookHeaders(secret, { id: event.event_id, body });
  let commit!: () => void;
  inbox.commitGate = new Promise<void>(resolve => { commit = resolve; });
  let responded = false;
  const response = fetch(`${base}/webhooks/relay`, { method: "POST", headers, body })
    .then(value => { responded = true; return value; });
  // Wait until verification has reached the storage gate, without using a timing assumption.
  const originalAccept = inbox.acceptOnce.bind(inbox);
  let reached!: () => void;
  const atCommit = new Promise<void>(resolve => { reached = resolve; });
  inbox.acceptOnce = async value => { reached(); await originalAccept(value); };
  await atCommit;
  assert.equal(responded, false);
  assert.equal(requests.length, 0);
  commit();
  assert.equal((await response).status, 204);
  inbox.commitGate = null;
  await processPending(inbox, adapter, testConversation);
  assert.equal(requests.length, 1);
  assert.equal((await fetch(`${base}/webhooks/relay`, { method: "POST", headers, body })).status, 204);
  await processPending(inbox, adapter, testConversation);
  assert.equal(requests.length, 1);
  inbox.failWrites = true;
  const another = fixture(); const otherBody = JSON.stringify(another);
  assert.equal((await fetch(`${base}/webhooks/relay`, {
    method: "POST", body: otherBody,
    headers: signWebhookHeaders(secret, { id: another.event_id, body: otherBody }),
  })).status, 503);
});
