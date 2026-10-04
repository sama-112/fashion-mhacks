import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import Relay, { signWebhookHeaders } from "@relaymessenger/sdk";
import { ElevenLabsCall } from "@relaymessenger/elevenlabs";
import { mintCallToken, verifyCallToken, voiceEventId } from "../src/voice/auth.ts";
import { createVoiceCalls, inboundCall, matchesLiveCall } from "../src/voice/calls.ts";
import { createVoiceEndpoint, parseVoiceRequest, requestsEndCall, spokenReply, type VoiceInbox } from "../src/voice/endpoint.ts";
import { voiceAgentConfiguration } from "../src/voice/elevenlabs.ts";
import { RelayAdapter } from "../src/integrations/relay.ts";
import { processPending } from "../src/services/relay-worker.ts";
import type { AcceptedEvent, PendingEvent } from "../src/db/inbox.ts";
import type { ConversationReply } from "../src/services/conversation.ts";

const secret = randomBytes(32).toString("hex");
const identity = { callId: randomUUID(), agentId: randomUUID(), userId: randomUUID(), conversationId: randomUUID() };
const call = {
  id: identity.callId, chat_id: identity.conversationId,
  from: { id: identity.userId, handle: "test-user", kind: "user" as const },
  to: [{ id: identity.agentId, handle: "test-agent", kind: "agent" as const }], status: "ringing" as const,
  revision: 1, created_at: new Date().toISOString(), ringing_at: new Date().toISOString(), answered_at: null, ended_at: null,
} as Awaited<ReturnType<Relay["calls"]["retrieve"]>>["call"];
const event = (): AcceptedEvent => ({ eventId: randomUUID(), agentId: identity.agentId, message: null,
  payload: { api_version: "v1", webhook_version: "2026-08-30", event_type: "call.created", event_id: randomUUID(), agent_id: identity.agentId, data: { call } } });

test("call tokens authenticate the verified caller and reject tampering, expiry and malformed identities", () => {
  const token = mintCallToken(identity, secret, 1000);
  assert.deepEqual(verifyCallToken(token, secret, 1001), identity);
  const [data, signature] = token.split(".");
  // Change signature bytes, rather than unused base64 padding bits in the last character.
  const changed = `${signature!.startsWith("a") ? "b" : "a"}${signature!.slice(1)}`;
  assert.throws(() => verifyCallToken(`${data}.${changed}`, secret, 1001));
  assert.throws(() => verifyCallToken(token, secret, 1000 + 15 * 60_000));
  assert.throws(() => verifyCallToken(token, "wrong-secret".repeat(5), 1001));
  assert.throws(() => mintCallToken({ ...identity, userId: "someone-else" }, secret));
});

test("signed call events retain the whole payload; only inbound human calls to this agent may join", () => {
  const signingSecret = `whsec_${randomBytes(32).toString("base64")}`;
  const adapter = new RelayAdapter(new Relay({ apiKey: "synthetic-token", webhookSecret: signingSecret }));
  const fixture = event(); fixture.payload.event_id = fixture.eventId;
  const body = JSON.stringify(fixture.payload);
  const accepted = adapter.verify(Buffer.from(body), signWebhookHeaders(signingSecret, { id: fixture.eventId, body }));
  assert.equal(accepted.message, null);
  assert.deepEqual(inboundCall(accepted), identity);
  assert.deepEqual(accepted.payload, fixture.payload);
  for (const changed of [
    { ...call, from: { ...call.from, kind: "agent" } },
    { ...call, to: [{ ...call.to[0], id: randomUUID() }] },
    { ...call, status: "completed" },
    { ...call, chat_id: "malformed" },
    { ...call, to: [] },
  ]) assert.equal(inboundCall({ ...accepted, payload: { ...accepted.payload, data: { call: changed } } }), null);
  assert.equal(matchesLiveCall(identity, { ...call, status: "completed" }), false);
  assert.equal(matchesLiveCall({ ...identity, userId: randomUUID() }, call), false);
});

test("duplicate ringing events establish one bridge and secret identity stays outside prompts", async () => {
  const received: Parameters<typeof ElevenLabsCall.connect>[0][] = [];
  let close!: () => void;
  const closed = new Promise<void>(resolve => { close = resolve; });
  const relay = { calls: { retrieve: async () => ({ call }) } } as unknown as Relay;
  const calls = createVoiceCalls({ relay, apiKey: "synthetic-key", agentId: "agent_test_voice", secret,
    connect: async options => { received.push(options); return { closed, close } as unknown as ElevenLabsCall; },
  });
  calls.dispatch(event()); calls.dispatch(event());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.length, 1);
  const variables = received[0]!.elevenlabs.initiationData?.dynamic_variables as Record<string, string>;
  assert.deepEqual(verifyCallToken(variables.secret__fashion_call_token, secret), identity);
  assert.equal(received[0]!.elevenlabs.initiationData?.conversation_config_override, undefined);
  assert.equal(await calls.validate(identity), true);
  assert.equal(await calls.validate({ ...identity, callId: randomUUID() }), false);
  await calls.stop();
  calls.dispatch(event()); assert.equal(received.length, 1);
});

test("voice configuration uses the existing backend, private agent access, matching PCM and no default-model fallback", () => {
  const config = voiceAgentConfiguration("https://voice.example", "test-voice");
  assert.equal(`${config.conversation_config.agent.prompt.custom_llm.url}/chat/completions`, "https://voice.example/v1/chat/completions");
  assert.deepEqual(config.conversation_config.agent.prompt.custom_llm.request_headers, { "X-Fashion-Call-Token": { variable_name: "secret__fashion_call_token" } });
  assert.equal(config.platform_settings.auth.enable_auth, true);
  assert.equal(config.platform_settings.privacy.record_voice, false);
  assert.equal(config.conversation_config.asr.user_input_audio_format, "pcm_16000");
  assert.equal(config.conversation_config.tts.agent_output_audio_format, "pcm_16000");
  assert.equal(config.conversation_config.agent.prompt.backup_llm_config.preference, "disabled");
  assert.equal(config.conversation_config.agent.prompt.llm, "custom-llm");
  assert.throws(() => voiceAgentConfiguration("http://localhost:3000"));
  assert.throws(() => voiceAgentConfiguration("https://user:password@voice.example"));
});

test("spoken turns require user text, deduplicate retries, and distinguish repeated words in a later turn", () => {
  assert.deepEqual(parseVoiceRequest({ messages: [{ role: "system", content: "ignored" }, { role: "user", content: "hello" }] }), { userTurns: ["hello"], text: "hello" });
  assert.throws(() => parseVoiceRequest({ messages: [{ role: "assistant", content: "hello" }] }));
  assert.throws(() => parseVoiceRequest({ messages: [{ role: "user", content: "" }] }));
  assert.throws(() => parseVoiceRequest({ messages: [{ role: "user", content: "a".repeat(10001) }] }));
  assert.equal(voiceEventId(identity.callId, ["hello"]), voiceEventId(identity.callId, ["hello"]));
  assert.notEqual(voiceEventId(identity.callId, ["hello"]), voiceEventId(identity.callId, ["hello", "hello"]));
  assert.notEqual(voiceEventId(identity.callId, ["hello"]), voiceEventId(randomUUID(), ["hello"]));
  assert.equal(requestsEndCall({ messages: [{ role: "user", content: "bye" }], tools: [{ type: "function", function: { name: "end_call" } }] }), true);
  assert.equal(requestsEndCall({ messages: [{ role: "user", content: "Find me a goodbye party outfit" }], tools: [{ type: "function", function: { name: "end_call" } }] }), false);
  const spoken = spokenReply({ text: "Item 1: Cotton shirt https://retailer.example/product\nReported price: $30", images: [{ attachmentId: randomUUID(), mimeType: "image/png" }] });
  assert.doesNotMatch(spoken, /https:/); assert.match(spoken, /product links in our Relay chat/); assert.match(spoken, /outfit picture/); assert.match(spoken, /\$30/);
});

class MemoryVoiceInbox implements VoiceInbox {
  rows = new Map<string, PendingEvent & { done: boolean }>();
  modelCalls = 0; sent: string[] = [];
  async acceptOnce(event: AcceptedEvent) {
    if (event.message && !this.rows.has(event.eventId)) this.rows.set(event.eventId, { eventId: event.eventId, message: event.message, attempts: 0, replyText: null, done: false });
  }
  async pending() { return [...this.rows.values()].filter(row => !row.done); }
  async saveReply(id: string, text: string) { this.rows.get(id)!.replyText = text; }
  async complete(id: string) { this.rows.get(id)!.done = true; }
  async retry(id: string, attempts: number) { this.rows.get(id)!.attempts = attempts; }
  async voiceReply(id: string) {
    await processPending(this, { sendReply: async (eventId: string) => { this.sent.push(eventId); } } as unknown as RelayAdapter,
      async () => { this.modelCalls++; return { text: "A cotton shirt. https://retailer.example/shirt" }; });
    const text = this.rows.get(id)?.replyText;
    return text === null || text === undefined ? null : { text };
  }
}

test("voice HTTP authenticates before enqueue, streams durable replies, sends links to chat, and never re-applies retries", async () => {
  const inbox = new MemoryVoiceInbox();
  let active = true;
  let snapshots = 0;
  const server = createServer(createVoiceEndpoint({ secret, inbox, validate: async candidate => active && candidate.userId === identity.userId,
    snapshot: async candidate => { assert.deepEqual(candidate, identity); snapshots++; return "verified-private-frame.png"; },
  }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;
  const post = (token: string, input: object) => fetch(url, { method: "POST", headers: { "x-fashion-call-token": token, "Content-Type": "application/json" }, body: JSON.stringify(input) });
  try {
    const request = { userId: randomUUID(), callPhoto: { callId: randomUUID(), storagePath: "other-users/frame.png" }, messages: [{ role: "user", content: "Find a shirt" }] };
    assert.equal((await post("invalid", request)).status, 401); assert.equal(inbox.rows.size, 0);
    const token = mintCallToken(identity, secret);
    active = false; assert.equal((await post(token, request)).status, 403); assert.equal(inbox.rows.size, 0); active = true;
    const response = await post(token, request);
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    const data = await response.text();
    assert.match(data, /chat.completion.chunk/); assert.match(data, /product links in our Relay chat/); assert.match(data, /data: \[DONE\]/);
    assert.doesNotMatch(data, /https:/);
    await (await post(token, { ...request, messages: [{ role: "assistant", content: "different generated preamble" }, ...request.messages] })).text();
    assert.equal(inbox.modelCalls, 1); assert.equal(inbox.rows.size, 1); assert.equal(inbox.sent.length, 1);
    assert.equal([...inbox.rows.values()][0]!.message.userId, identity.userId, "Request-body identity cannot select another wardrobe.");
    assert.equal([...inbox.rows.values()][0]!.message.deliveryKind, "voice");
    assert.equal([...inbox.rows.values()][0]!.message.callPhoto, undefined, "The body cannot inject a camera reference.");
    const visual = { ...request, messages: [...request.messages, { role: "user", content: "Add this shirt" }] };
    await (await post(token, visual)).text();
    assert.equal(snapshots, 1);
    assert.deepEqual([...inbox.rows.values()][1]!.message.callPhoto, { callId: identity.callId, storagePath: "verified-private-frame.png" });
    await (await post(token, visual)).text(); assert.equal(snapshots, 1); assert.equal(inbox.modelCalls, 2);
    await (await post(token, { messages: [...visual.messages, { role: "user", content: "Save these clothes." }] })).text();
    assert.equal(snapshots, 1, "Spoken confirmation must not look for new camera evidence.");
    const ended = await post(token, { messages: [{ role: "user", content: "end the call" }], tools: [{ type: "function", function: { name: "end_call" } }] });
    assert.match(await ended.text(), /"finish_reason":"tool_calls"/); assert.equal(inbox.modelCalls, 3);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("spoken replies without links or media are persisted for ElevenLabs without duplicate chat messages", async () => {
  const inbox = new MemoryVoiceInbox();
  const id = randomUUID();
  await inbox.acceptOnce({ eventId: id, agentId: identity.agentId, payload: {}, message: { ...identity, text: "hello", deliveryKind: "voice" } });
  await processPending(inbox, { sendReply: async () => { assert.fail("Plain spoken reply should not also send to chat"); } } as unknown as RelayAdapter,
    async () => ({ text: "Your stylist is connected." }));
  assert.equal(inbox.rows.get(id)!.replyText, "Your stylist is connected."); assert.equal(inbox.rows.get(id)!.done, true);
});
