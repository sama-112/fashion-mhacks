import { createClient } from "@supabase/supabase-js";
import { validatePhoto } from "../images/photos.ts";
import type { StylistIdentity } from "../db/stylist-store.ts";
import type { VoiceIdentity } from "./auth.ts";
import { UUID } from "./auth.ts";

export function createCallSnapshots(url: string, secret: string) {
  const client = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([AbortSignal.timeout(10000), ...(init?.signal ? [init.signal] : [])]) }) } });
  const bucket = client.storage.from("outfit-images");
  return {
    async save(identity: VoiceIdentity, eventId: string, image: Blob): Promise<string> {
      if (![identity.userId, identity.conversationId, identity.callId, eventId].every(id => UUID.test(id))) throw new Error("Invalid call snapshot identity.");
      await validatePhoto(image);
      const path = `${identity.userId}/${identity.conversationId}/calls/${identity.callId}/${eventId}.png`;
      const { error } = await bucket.upload(path, image, { contentType: "image/png", upsert: false });
      if (error && String(error.statusCode) !== "409") throw new Error("Supabase call snapshot could not be saved.");
      return path;
    },
    async load(identity: StylistIdentity, callId: string, path: string, signal?: AbortSignal): Promise<Blob> {
      const prefix = `${identity.userId}/${identity.conversationId}/calls/${callId}/`;
      const eventId = path.slice(prefix.length).replace(/\.png$/, "");
      if (![identity.userId, identity.conversationId, callId, eventId].every(id => UUID.test(id)) || path !== `${prefix}${eventId}.png`) throw new Error("Supabase call snapshot identity mismatch.");
      signal?.throwIfAborted();
      const { data, error } = await bucket.download(path);
      signal?.throwIfAborted();
      if (error || !data) throw new Error("Supabase call snapshot unavailable.");
      await validatePhoto(data);
      return data;
    },
  };
}
