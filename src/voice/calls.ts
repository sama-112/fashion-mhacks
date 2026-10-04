import type Relay from "@relaymessenger/sdk";
import { ElevenLabsCall } from "@relaymessenger/elevenlabs";
import type { AcceptedEvent } from "../db/inbox.ts";
import { mintCallToken, UUID, type VoiceIdentity } from "./auth.ts";
import { createCallCamera } from "./camera.ts";
import { websocketToolConnection } from "./websocket-tools.ts";

export function inboundCall(event: AcceptedEvent): VoiceIdentity | null {
  const payload = event.payload as { event_type?: string; data?: { call?: { id?: string; chat_id?: string; status?: string; from?: { id?: string; kind?: string }; to?: Array<{ id?: string; kind?: string }> } } };
  const call = payload.data?.call;
  if (payload.event_type !== "call.created" || !call || call.status !== "ringing" || call.from?.kind !== "user"
    || !Array.isArray(call.to) || call.to.length !== 1 || call.to[0]?.id !== event.agentId || call.to[0]?.kind !== "agent") return null;
  const values = [call.id, event.agentId, call.from.id, call.chat_id];
  if (values.some(value => typeof value !== "string" || !UUID.test(value))) return null;
  return { callId: call.id!, agentId: event.agentId, userId: call.from.id!, conversationId: call.chat_id! };
}

export function matchesLiveCall(identity: VoiceIdentity, call: Awaited<ReturnType<Relay["calls"]["retrieve"]>>["call"]): boolean {
  return call.id === identity.callId && call.chat_id === identity.conversationId && call.from.id === identity.userId
    && call.from.kind === "user" && call.to.length === 1 && call.to[0].id === identity.agentId && call.to[0].kind === "agent"
    && ["ringing", "in-progress"].includes(call.status);
}

export interface VoiceCallHandle { closed: Promise<void>; close(): void; transport?: ElevenLabsCall["transport"] }
export function createVoiceCalls(options: {
  relay: Relay; apiKey: string; agentId: string; secret: string;
  connect?: typeof ElevenLabsCall.connect;
  mode?: "http" | "websocket";
  voiceTurn?(identity: VoiceIdentity, turns: readonly { id: number; text: string }[], signal: AbortSignal): Promise<string>;
}) {
  type Entry = { identity: VoiceIdentity; promise: Promise<void>; call?: VoiceCallHandle; camera?: ReturnType<typeof createCallCamera> };
  const active = new Map<string, Entry>();
  const attempted = new Set<string>();
  let stopped = false;
  const connect = options.connect ?? ElevenLabsCall.connect;
  return {
    snapshot(identity: VoiceIdentity) {
      const entry = active.get(identity.callId);
      if (!entry || stopped || entry.identity.userId !== identity.userId || entry.identity.conversationId !== identity.conversationId || entry.identity.agentId !== identity.agentId) return null;
      return entry.camera?.snapshot() ?? null;
    },
    async validate(identity: VoiceIdentity) {
      if (stopped || !active.has(identity.callId)) return false;
      const { call } = await options.relay.calls.retrieve(identity.callId);
      return matchesLiveCall(identity, call);
    },
    dispatch(event: AcceptedEvent) {
      const identity = inboundCall(event);
      if (!identity || stopped || attempted.has(identity.callId) || active.size >= 4) return;
      attempted.add(identity.callId);
      // Bound recent duplicate suppression; durable snapshots + live retrieve prevent resurrection.
      if (attempted.size > 1000) attempted.delete(attempted.values().next().value!);
      const entry: Entry = { identity, promise: Promise.resolve() };
      active.set(identity.callId, entry);
      entry.promise = (async () => {
        let generatedAudio = 0;
        let reportedAudio = 0;
        let diagnosticTimer: NodeJS.Timeout | undefined;
        const websocket = options.mode === "websocket" ? websocketToolConnection((turns, signal) => {
          if (!options.voiceTurn) throw new Error("WebSocket voice is unavailable.");
          return options.voiceTurn(identity, turns, signal);
        }) : null;
        try {
          const { call } = await options.relay.calls.retrieve(identity.callId);
          if (stopped || !matchesLiveCall(identity, call)) return;
          entry.call = await connect({
            relay: options.relay, callId: identity.callId, inputSampleRate: 16000, rive: false,
            elevenlabs: { apiKey: options.apiKey, agentId: options.agentId,
              initiationData: websocket ? {} : { dynamic_variables: { secret__fashion_call_token: mintCallToken(identity, options.secret) } } },
            ...(websocket?.options ?? {}),
            onEvent: event => {
              websocket?.tools.event(event);
              if (event.type === "audio") generatedAudio++;
            },
            onWarning: warning => console.warn(warning.startsWith("Relay refused ElevenLabs audio")
              ? "Voice audio delivery failed at Relay." : "Voice transport warning; check call connectivity."),
          });
          if (entry.call.transport) entry.camera = createCallCamera(entry.call.transport);
          diagnosticTimer = setInterval(() => {
            if (!entry.call?.transport || generatedAudio === reportedAudio) return;
            reportedAudio = generatedAudio;
            const stats = entry.call.transport.diagnostics();
            console.log(`Voice audio delivery: generatedChunks=${generatedAudio} sentPackets=${stats.outbound.rtpPackets ?? 0} receivedPackets=${stats.inbound.rtpPackets ?? 0}.`);
          }, 5000);
          diagnosticTimer.unref();
          if (stopped) entry.call.close();
          else console.log(`Voice call connected: ${identity.callId}`);
          await entry.call.closed;
        } catch { console.error(`Voice call could not connect: ${identity.callId}. Check ElevenLabs settings and Relay connectivity.`); }
        finally { clearInterval(diagnosticTimer); websocket?.tools.close(); entry.camera?.close(); active.delete(identity.callId); }
      })();
    },
    async stop() {
      stopped = true;
      for (const entry of active.values()) { entry.camera?.close(); entry.call?.close(); }
      await Promise.allSettled([...active.values()].map(entry => entry.promise));
    },
  };
}
