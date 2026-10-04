import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import Relay from "@relaymessenger/sdk";
import { RelayCallTransport } from "@relaymessenger/sdk/calls";
import { ElevenLabsCall, type ElevenLabsSocket, type ElevenLabsSocketConstructor } from "@relaymessenger/elevenlabs";
import { createWebsocketTools, createWebsocketVoiceTurn, websocketToolConnection, type ToolBridgeOptions } from "../src/voice/websocket-tools.ts";
import { websocketVoiceAgentConfiguration } from "../src/voice/elevenlabs.ts";
import type { VoiceInbox } from "../src/voice/endpoint.ts";
import type { AcceptedEvent } from "../src/db/inbox.ts";

const identity = { callId: randomUUID(), agentId: randomUUID(), userId: randomUUID(), conversationId: randomUUID() };
const transcript = (id: number, text: string) => ({ type: "user_transcript", user_transcription_event: { event_id: id, user_transcript: text } });
const tool = (id: string, parameters: object = {}) => ({ type: "client_tool_call", client_tool_call: { tool_name: "fashion_stylist", tool_call_id: id, parameters } });

test("WebSocket tools use only the actual transcript, deduplicate retries, and allow a later identical utterance", async () => {
  const received: unknown[] = [], sent: unknown[] = [];
  const tools = createWebsocketTools({ run: async turns => { received.push(turns); return "Your stylist is connected."; }, send: value => sent.push(value) });
  tools.event(tool("before-speech")); await tools.settled(); assert.equal(received.length, 0);
  tools.event(transcript(1, "hello")); tools.event(transcript(1, "duplicate"));
  tools.event(tool("one", { text: "save wardrobe", userId: "another-user", callPhoto: "foreign-photo" }));
  tools.event(tool("one")); tools.event(tool("retry")); await tools.settled();
  assert.deepEqual(received, [[{ id: 1, text: "hello" }]]);
  tools.event(transcript(2, "hello")); tools.event(tool("two")); await tools.settled();
  assert.equal(received.length, 2); assert.equal(sent.length, 4);
  tools.close(); tools.event(transcript(3, "save wardrobe")); tools.event(tool("after-close"));
  assert.equal(received.length, 2);
});

test("WebSocket speech keeps durable caller scope, caches images before retry, and blocks inactive calls", async () => {
  const rows = new Map<string, AcceptedEvent>(); let snapshots = 0, active = true;
  const inbox = { voiceReply: async (id: string) => rows.has(id) ? { text: "Wardrobe draft — blue shirt" } : null,
    acceptOnce: async (event: AcceptedEvent) => { if (!rows.has(event.eventId)) rows.set(event.eventId, event); } } as unknown as VoiceInbox;
  const run = createWebsocketVoiceTurn({ inbox, validate: async who => active && who.userId === identity.userId,
    snapshot: async who => { assert.deepEqual(who, identity); snapshots++; return "private/camera.png"; } });
  const turns = [{ id: 1, text: "add this shirt" }], signal = new AbortController().signal;
  assert.match(await run(identity, turns, signal), /clothing list/);
  await run(identity, turns, signal); assert.equal(rows.size, 1); assert.equal(snapshots, 1);
  assert.deepEqual([...rows.values()][0]!.message, { userId: identity.userId, conversationId: identity.conversationId,
    text: "add this shirt", deliveryKind: "voice", callPhoto: { callId: identity.callId, storagePath: "private/camera.png" } });
  active = false; await assert.rejects(run(identity, turns, signal)); assert.equal(rows.size, 1);
});

test("the pinned official bridge preserves audio and ping/pong while returning client tool results on its WebSocket", async t => {
  const writes: unknown[] = [], sent: Array<Record<string, unknown>> = [];
  t.mock.method(RelayCallTransport.prototype, "connect", async () => undefined);
  t.mock.method(RelayCallTransport.prototype, "close", () => undefined);
  t.mock.method(RelayCallTransport.prototype, "writeAudio", async (frame: Parameters<RelayCallTransport["writeAudio"]>[0]) => { writes.push(frame); return 0; });
  t.mock.method(RelayCallTransport.prototype, "waitForPlayout", async () => undefined);
  t.mock.method(RelayCallTransport.prototype, "queuedAudioMs", () => 0);
  let socket!: FakeSocket;
  class FakeSocket implements ElevenLabsSocket {
    readyState = 1; onopen: ElevenLabsSocket["onopen"] = null; onmessage: ElevenLabsSocket["onmessage"] = null;
    onclose: ElevenLabsSocket["onclose"] = null; onerror: ElevenLabsSocket["onerror"] = null;
    constructor(_url: string) { socket = this; queueMicrotask(() => this.onopen?.({})); }
    send(text: string) {
      const value = JSON.parse(text); sent.push(value);
      if (value.type === "conversation_initiation_client_data") queueMicrotask(() => this.receive({ type: "conversation_initiation_metadata",
        conversation_initiation_metadata_event: { user_input_audio_format: "pcm_16000", agent_output_audio_format: "pcm_16000" } }));
    }
    receive(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; }
  }
  const connection = websocketToolConnection(async () => "Your stylist is connected.", FakeSocket as ElevenLabsSocketConstructor);
  const options: ToolBridgeOptions = { relay: { calls: { room: () => ({}) } } as unknown as Relay, callId: identity.callId,
    elevenlabs: { agentId: "synthetic", signedUrl: "wss://synthetic.example" }, rive: false, ...connection.options };
  const bridge = await ElevenLabsCall.connect(options);
  try {
    socket.receive(transcript(1, "hello")); socket.receive(tool("actual-tool")); await connection.tools.settled();
    assert.ok(sent.some(value => value.type === "client_tool_result" && value.result === "Your stylist is connected."));
    socket.receive({ type: "ping", ping_event: { event_id: 20 } }); assert.ok(sent.some(value => value.type === "pong" && value.event_id === 20));
    socket.receive({ type: "audio", audio_event: { event_id: 1, audio_base_64: Buffer.alloc(320).toString("base64"), is_final: true } });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(writes.length, 1);
  } finally { connection.tools.close(); bridge.close(); await bridge.closed; }
});

test("WebSocket voice config has private access, a blocking Stylist tool and no public custom-LLM callback", () => {
  const config = websocketVoiceAgentConfiguration();
  assert.equal(config.platform_settings.auth.enable_auth, true);
  assert.equal(config.conversation_config.agent.prompt.custom_llm, null);
  assert.equal(config.conversation_config.agent.prompt.tools[0]!.expects_response, true);
  assert.ok(config.conversation_config.conversation.client_events.includes("client_tool_call"));
  assert.equal(config.conversation_config.asr.user_input_audio_format, config.conversation_config.tts.agent_output_audio_format);
});
