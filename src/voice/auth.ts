import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface VoiceIdentity { callId: string; agentId: string; userId: string; conversationId: string }
export class VoiceRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function mintCallToken(identity: VoiceIdentity, secret: string, now = Date.now()): string {
  if (secret.length < 32 || Object.values(identity).some(value => !UUID.test(value))) throw new Error("Invalid voice configuration.");
  const data = Buffer.from(JSON.stringify({ ...identity, expiresAt: now + 15 * 60_000 })).toString("base64url");
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}

export function verifyCallToken(token: unknown, secret: string, now = Date.now()): VoiceIdentity {
  try {
    if (secret.length < 32 || typeof token !== "string" || token.length > 2048) throw new Error();
    const [data, signature, extra] = token.split(".");
    if (!data || !signature || extra !== undefined) throw new Error();
    const expected = createHmac("sha256", secret).update(data).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error();
    const value = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!Number.isFinite(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 15 * 60_000) throw new Error();
    for (const field of ["callId", "agentId", "userId", "conversationId"]) if (typeof value[field] !== "string" || !UUID.test(value[field])) throw new Error();
    return { callId: value.callId, agentId: value.agentId, userId: value.userId, conversationId: value.conversationId };
  } catch { throw new VoiceRequestError(401, "Voice authentication failed."); }
}

/** Retries of the same spoken turn keep their event ID, even if assistant prose changes. */
export function voiceEventId(callId: string, userTurns: readonly string[]): string {
  const bytes = createHash("sha256").update(JSON.stringify(["fashion-voice-v1", callId, userTurns])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
