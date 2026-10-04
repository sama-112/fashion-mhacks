import { createClient } from "@supabase/supabase-js";
import { emptyPathwayState, type PathwayState } from "../pathways/types.ts";
import type { WardrobeCandidate } from "../wardrobe/types.ts";

export interface StylistIdentity { userId: string; conversationId: string }
export interface WardrobeDraft {
  items: readonly WardrobeCandidate[];
  mediaPath: string | null;
  mode: "append" | "replace";
}
export interface StylistProfile {
  wardrobe: readonly WardrobeCandidate[];
  draft: WardrobeDraft | null;
  pathways: PathwayState;
}
export interface StoredProfile { version: number; data: StylistProfile }
export interface StylistStore {
  load(identity: StylistIdentity): Promise<StoredProfile>;
  commit(identity: StylistIdentity, eventId: string, profile: StoredProfile, text: string): Promise<string>;
  saveVideo(identity: StylistIdentity, eventId: string, video: Blob): Promise<string>;
}
export function emptyProfile(): StoredProfile {
  return { version: 0, data: { wardrobe: [], draft: null, pathways: emptyPathwayState() } };
}

export function createStylistStore(url: string, secret: string): StylistStore & { checkAccess(): Promise<void> } {
  const client = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, {
      ...init, signal: AbortSignal.any([AbortSignal.timeout(60000), ...(init?.signal ? [init.signal] : [])]),
    }) },
  });
  function check(error: unknown) {
    if (error) throw new Error("Supabase stylist storage failed; check credentials and the memory migration.");
  }
  return {
    async checkAccess() {
      const { error } = await client.from("stylist_profiles").select("version").limit(1);
      check(error);
      const bucket = await client.storage.getBucket("wardrobe-videos");
      check(bucket.error);
      if (!bucket.data || bucket.data.public) throw new Error("Supabase stylist video bucket must be private.");
    },
    async load(identity) {
      const { data, error } = await client.from("stylist_profiles")
        .select("data,version").eq("user_id", identity.userId).eq("conversation_id", identity.conversationId)
        .abortSignal(AbortSignal.timeout(5000)).maybeSingle();
      check(error);
      return data ? { version: data.version as number, data: { ...emptyProfile().data, ...data.data } as StylistProfile } : emptyProfile();
    },
    async commit(identity, eventId, profile, text) {
      const { data, error } = await client.rpc("commit_stylist_turn", {
        p_event_id: eventId, p_user_id: identity.userId, p_conversation_id: identity.conversationId,
        p_expected_version: profile.version, p_data: profile.data, p_reply_text: text,
      }).abortSignal(AbortSignal.timeout(5000));
      check(error);
      if (typeof data !== "string") throw new Error("Supabase stylist reply could not be committed.");
      return data;
    },
    async saveVideo(identity, eventId, video) {
      const extension = video.type === "video/quicktime" ? "mov" : video.type === "video/webm" ? "webm" : "mp4";
      const path = `${identity.userId}/${identity.conversationId}/${eventId}.${extension}`;
      const { error } = await client.storage.from("wardrobe-videos").upload(path, video, {
        contentType: video.type, upsert: false,
      });
      // Object names are derived from the verified event, so a retry reuses its upload.
      if (error && (!("statusCode" in error) || String(error.statusCode) !== "409")) check(error);
      return path;
    },
  };
}
