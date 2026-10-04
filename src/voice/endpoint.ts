import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventInbox } from "../db/inbox.ts";
import type { ConversationReply } from "../services/conversation.ts";
import { verifyCallToken, voiceEventId, VoiceRequestError, type VoiceIdentity } from "./auth.ts";
import { needsCallCamera } from "./camera.ts";

export interface VoiceInbox extends EventInbox {
  voiceReply(eventId: string): Promise<ConversationReply | null>;
}

export function parseVoiceRequest(value: unknown): { userTurns: string[]; text: string } {
  const body = value as { messages?: Array<{ role?: string; content?: unknown }> } | null;
  if (!body || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 256) throw new VoiceRequestError(400, "Invalid voice request.");
  const last = body.messages.at(-1)!;
  if (last?.role !== "user" || typeof last.content !== "string" || !last.content.trim() || last.content.length > 10000) throw new VoiceRequestError(400, "A spoken user message is required.");
  const userTurns = body.messages.filter(message => message?.role === "user").map(message => {
    if (typeof message.content !== "string" || !message.content.trim() || message.content.length > 10000) throw new VoiceRequestError(400, "Invalid voice transcript.");
    return message.content.trim();
  });
  return { userTurns, text: last.content.trim() };
}

export function spokenReply(reply: ConversationReply): string {
  const hasLinks = /https?:\/\//i.test(reply.text);
  const text = reply.text.replace(/https?:\/\/[^\s]+/gi, "").replace(/\*\*/g, "").trim();
  return `${text}${hasLinks ? "\nI sent the product links in our Relay chat." : ""}${reply.images?.length ? "\nThe outfit picture is in our Relay chat." : ""}${/Wardrobe draft —|Your saved wardrobe:/i.test(reply.text) ? "\nThe clothing list is also in our Relay chat." : ""}`;
}

export function requestsEndCall(value: unknown): boolean {
  const body = value as { messages?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ type?: string; function?: { name?: string } }> };
  const last = body?.messages?.at(-1);
  return last?.role === "user" && typeof last.content === "string"
    && /^(?:(?:ok(?:ay)?[, ]+)?(?:bye|goodbye|hang up|end (?:the |this )?call|stop (?:the |this )?call))(?:[,.! ]+(?:please|thanks|thank you))*[.!]?$/i.test(last.content.trim())
    && Array.isArray(body.tools) && body.tools.some(tool => tool?.type === "function" && tool.function?.name === "end_call");
}

function completionStream(response: ServerResponse) {
  const id = `chatcmpl-${randomUUID()}`; const created = Math.floor(Date.now()/1000);
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  return {
    chunk(delta: object, finishReason: string | null = null) {
      response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "fashion-stylist",
        choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    },
    done() { response.end("data: [DONE]\n\n"); },
  };
}

async function body(request: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > 128 * 1024) throw new VoiceRequestError(413, "Voice request too large.");
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); }
  catch { throw new VoiceRequestError(400, "Invalid voice JSON."); }
}

export function createVoiceEndpoint(options: { secret: string; inbox: VoiceInbox; validate(identity: VoiceIdentity): Promise<boolean>;
  snapshot?(identity: VoiceIdentity, eventId: string): Promise<string | null>;
}) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const stop = new AbortController();
    response.once("close", () => stop.abort());
    try {
      if (request.method !== "POST") { response.writeHead(405, { Allow: "POST" }).end(); return; }
      const identity = verifyCallToken(request.headers["x-fashion-call-token"], options.secret);
      if (!(await options.validate(identity))) throw new VoiceRequestError(403, "Call is not active.");
      const payload = await body(request);
      const { userTurns, text } = parseVoiceRequest(payload);
      if (requestsEndCall(payload)) {
        const stream = completionStream(response);
        stream.chunk({ role: "assistant", content: "Goodbye!", tool_calls: [{ index: 0, id: `call_${randomUUID()}`, type: "function",
          function: { name: "end_call", arguments: JSON.stringify({ reason: "The user asked to end the call." }) } }] });
        stream.chunk({}, "tool_calls"); stream.done(); return;
      }
      const eventId = voiceEventId(identity.callId, userTurns);
      const visual = needsCallCamera(text);
      // Only verified transport frames can create this reference. Body image/identity fields are ignored.
      const cached = await options.inbox.voiceReply(eventId);
      const callPhoto = visual && !cached ? { callId: identity.callId, storagePath: await options.snapshot?.(identity, eventId) ?? null } : undefined;
      // Enter the same durable inbox as chat. Its single worker serializes all profile writes.
      await options.inbox.acceptOnce({ eventId, agentId: identity.agentId,
        payload: { source: "elevenlabs-voice", callId: identity.callId },
        message: { userId: identity.userId, conversationId: identity.conversationId, text, deliveryKind: "voice", ...(callPhoto ? { callPhoto } : {}) },
      });
      const stream = completionStream(response);
      stream.chunk({ role: "assistant", content: "One moment... " });
      const deadline = Date.now() + 150_000;
      while (!stop.signal.aborted && Date.now() < deadline) {
        const reply = await options.inbox.voiceReply(eventId);
        if (reply) {
          stream.chunk({ content: spokenReply(reply) }); stream.chunk({}, "stop");
          stream.done(); return;
        }
        // SSE comments keep proxies alive without adding spoken words.
        response.write(": waiting\n\n");
        await delay(500, undefined, { signal: stop.signal });
      }
      if (!stop.signal.aborted) {
        stream.chunk({ content: "That is taking longer than expected. Please check our Relay chat or try again shortly." });
        stream.chunk({}, "stop"); stream.done();
      }
    } catch (error) {
      if (stop.signal.aborted) return;
      if (response.headersSent) { response.end("data: [DONE]\n\n"); return; }
      const status = error instanceof VoiceRequestError ? error.status : 503;
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof VoiceRequestError ? error.message : "Voice service unavailable." }));
    }
  };
}
