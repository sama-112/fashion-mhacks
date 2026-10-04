import { ElevenLabsCall, type ElevenLabsEvent, type ElevenLabsSocketConstructor, type ElevenLabsSocket } from "@relaymessenger/elevenlabs";
import { setTimeout as delay } from "node:timers/promises";
import { needsCallCamera } from "./camera.ts";
import { voiceEventId, type VoiceIdentity } from "./auth.ts";
import { spokenReply, type VoiceInbox } from "./endpoint.ts";

export function createWebsocketVoiceTurn(options: {
  inbox: VoiceInbox; validate(identity: VoiceIdentity): Promise<boolean>;
  snapshot(identity: VoiceIdentity, eventId: string): Promise<string | null>;
}) {
  return async (identity: VoiceIdentity, turns: readonly { id: number; text: string }[], signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted();
    if (!(await options.validate(identity))) throw new Error("Call is not active.");
    const text = turns.at(-1)?.text;
    if (!text || text.length > 10000 || turns.length > 256) throw new Error("Invalid spoken turn.");
    // ASR event IDs are scoped to this private call. Repeated tool calls never execute a turn twice.
    const eventId = voiceEventId(identity.callId, ["websocket", ...turns.map(turn => String(turn.id))]);
    const cached = await options.inbox.voiceReply(eventId);
    if (cached) return spokenReply(cached);
    const callPhoto = needsCallCamera(text) ? { callId: identity.callId, storagePath: await options.snapshot(identity, eventId) } : undefined;
    await options.inbox.acceptOnce({ eventId, agentId: identity.agentId, payload: { source: "elevenlabs-websocket", callId: identity.callId },
      message: { userId: identity.userId, conversationId: identity.conversationId, text, deliveryKind: "voice", ...(callPhoto ? { callPhoto } : {}) } });
    const deadline = Date.now() + 110000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const reply = await options.inbox.voiceReply(eventId);
      if (reply) return spokenReply(reply);
      await delay(300, undefined, { signal });
    }
    throw new Error("Stylist reply timed out.");
  };
}

export function createWebsocketTools(options: {
  run(turns: readonly { id: number; text: string }[], signal: AbortSignal): Promise<string>;
  send(value: object): void;
}) {
  const stop = new AbortController();
  const turns: Array<{ id: number; text: string }> = [];
  const ids = new Set<number>();
  const operations = new Map<number, Promise<string>>();
  const toolCalls = new Map<string, Promise<void>>();
  let audioChunks = 0, interruptions = 0;
  return {
    event(event: ElevenLabsEvent) {
      if (stop.signal.aborted) return;
      if (event.type === "audio") { audioChunks++; return; }
      if (event.type === "interruption") { interruptions++; return; }
      if (event.type === "user_transcript") {
        const value = event.user_transcription_event as { event_id?: unknown; user_transcript?: unknown } | undefined;
        if (typeof value?.event_id !== "number" || !Number.isSafeInteger(value.event_id) || value.event_id < 0
          || typeof value.user_transcript !== "string" || !value.user_transcript.trim() || value.user_transcript.length > 10000
          || ids.has(value.event_id) || turns.length >= 256) return;
        ids.add(value.event_id); turns.push({ id: value.event_id, text: value.user_transcript.trim() });
        return;
      }
      if (event.type !== "client_tool_call") return;
      const tool = event.client_tool_call as { tool_call_id?: unknown; tool_name?: unknown } | undefined;
      if (typeof tool?.tool_call_id !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(tool.tool_call_id) || toolCalls.size >= 256) return;
      const toolId = tool.tool_call_id;
      if (toolCalls.has(toolId)) return;
      const task = (async () => {
        let result: string, isError = false;
        try {
          if (tool.tool_name !== "fashion_stylist" || !turns.length) throw new Error("A spoken request is required.");
          // Ignore ALL model-supplied arguments, including identity, text, images and proposed actions.
          const count = turns.length;
          let operation = operations.get(count);
          if (!operation) {
            operation = options.run([...turns], stop.signal);
            operations.set(count, operation);
            operation.catch(() => { operations.delete(count); });
          }
          result = await operation;
        } catch { result = "I could not get the stylist reply. Please try again."; isError = true; }
        if (!stop.signal.aborted) options.send({ type: "client_tool_result", tool_call_id: toolId, result, is_error: isError });
      })();
      // Keep exceptions in a send listener from escaping into the provider/bridge event loop.
      toolCalls.set(toolId, task.catch(() => undefined));
    },
    async settled() { await Promise.allSettled([...toolCalls.values()]); },
    close() {
      stop.abort();
      console.log(`Voice WebSocket summary: spokenTurns=${turns.length} audioChunks=${audioChunks} interruptions=${interruptions}.`);
    },
  };
}

// The pinned official 0.1.1 bridge accepts a WebSocket constructor at runtime, while its
// public declaration omits that injection hook. This narrow adapter is covered by tests.
export function websocketToolConnection(run: (turns: readonly { id: number; text: string }[], signal: AbortSignal) => Promise<string>,
  Socket: ElevenLabsSocketConstructor = WebSocket as unknown as ElevenLabsSocketConstructor) {
  let socket: ElevenLabsSocket | undefined;
  const tools = createWebsocketTools({ run, send: value => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(value));
  } });
  const CapturedSocket = class {
    constructor(url: string) { socket = new Socket(url); return socket; }
  } as unknown as ElevenLabsSocketConstructor;
  return { tools, options: { WebSocket: CapturedSocket, onEvent: tools.event } };
}

export type ToolBridgeOptions = Parameters<typeof ElevenLabsCall.connect>[0] & { WebSocket: ElevenLabsSocketConstructor };
