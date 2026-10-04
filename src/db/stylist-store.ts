import { createClient } from "@supabase/supabase-js";
import { emptyPathwayState, type PathwayState } from "../pathways/types.ts";
import type { WardrobeCandidate } from "../wardrobe/types.ts";
import { emptyShoppingPreferences, type ShoppingPreferences } from "../preferences/types.ts";
import { emptyWeeklySettings, type WeeklySettings } from "../weekly/types.ts";
import type { OutfitSuggestion } from "../agents/stylist/types.ts";
import type { ConversationImage, ConversationPhoto, ConversationReply } from "../services/conversation.ts";
import type { OutfitImageAssets } from "../images/outfits.ts";
import { validatePhoto, type ReferencePhoto } from "../images/photos.ts";

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
  shopping: ShoppingPreferences;
  weekly: WeeklySettings;
  lastOutfits: readonly OutfitSuggestion[];
  referencePhoto: ReferencePhoto | null;
  pendingPhoto: {photo:ConversationPhoto;messageId:string} | null;
}
export interface StoredProfile { version: number; data: StylistProfile }
export interface StylistStore {
  load(identity: StylistIdentity): Promise<StoredProfile>;
  commit(identity: StylistIdentity, eventId: string, profile: StoredProfile, text: string): Promise<string>;
  commitResponse?(identity: StylistIdentity, eventId: string, profile: StoredProfile, reply: ConversationReply): Promise<ConversationReply>;
  saveVideo(identity: StylistIdentity, eventId: string, video: Blob): Promise<string>;
  saveReferencePhoto?(identity: StylistIdentity, eventId: string, photo: Blob): Promise<ReferencePhoto>;
}
export function emptyProfile(): StoredProfile {
  return { version: 0, data: { wardrobe: [], draft: null, pathways: emptyPathwayState(), shopping: emptyShoppingPreferences(), weekly: emptyWeeklySettings(), lastOutfits: [], referencePhoto:null, pendingPhoto:null } };
}

export function createStylistStore(url: string, secret: string): StylistStore & { checkAccess(): Promise<void>; imageAssets: OutfitImageAssets; enqueueDue(): Promise<number> } {
  const client = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, {
      ...init, signal: AbortSignal.any([AbortSignal.timeout(60000), ...(init?.signal ? [init.signal] : [])]),
    }) },
  });
  function check(error: unknown) {
    if (error) throw new Error("Supabase stylist storage failed; check credentials and the memory migration.");
  }
  async function commitResponse(identity: StylistIdentity, eventId: string, profile: StoredProfile, reply: ConversationReply): Promise<ConversationReply> {
    const { data, error } = await client.rpc("commit_stylist_response", {
      p_event_id: eventId, p_user_id: identity.userId, p_conversation_id: identity.conversationId,
      p_expected_version: profile.version, p_data: profile.data, p_reply_text: reply.text, p_reply_media: reply.images ?? [],
    }).abortSignal(AbortSignal.timeout(5000));
    check(error);
    if (!data || typeof data.text !== "string" || !Array.isArray(data.images)) throw new Error("Supabase stylist reply could not be committed.");
    return data.images.length ? { text: data.text, images: data.images } : { text: data.text };
  }
  const imageAssets: OutfitImageAssets = {
    async loadReference(identity,photo) {
      if (!photo.storagePath.startsWith(`${identity.userId}/${identity.conversationId}/reference/`) || photo.storagePath.includes("..")) throw new Error("Supabase reference photo identity mismatch.");
      const {data,error}=await client.storage.from("outfit-images").download(photo.storagePath);
      check(error);
      if (!data || data.type!==photo.mimeType) throw new Error("Supabase reference photo unavailable.");
      await validatePhoto(data);
      return data;
    },
    async load(identity, eventId) {
      const { data, error } = await client.from("stylist_image_assets").select("storage_path,attachment")
        .eq("event_id",eventId).eq("user_id",identity.userId).eq("conversation_id",identity.conversationId).maybeSingle();
      check(error);
      if (!data) return null;
      const image = await client.storage.from("outfit-images").download(data.storage_path);
      check(image.error);
      if (!image.data) throw new Error("Supabase outfit image unavailable.");
      return { image: image.data, attachment: data.attachment as ConversationImage | null };
    },
    async save(identity, eventId, image) {
      const extension = image.type === "image/jpeg" ? "jpg" : image.type === "image/webp" ? "webp" : "png";
      const path = `${identity.userId}/${identity.conversationId}/${eventId}.${extension}`;
      const upload = await client.storage.from("outfit-images").upload(path,image,{contentType:image.type,upsert:false});
      if (upload.error && String(upload.error.statusCode) !== "409") check(upload.error);
      const { error } = await client.from("stylist_image_assets").upsert({ event_id:eventId,user_id:identity.userId,conversation_id:identity.conversationId,storage_path:path },{onConflict:"event_id",ignoreDuplicates:true});
      check(error);
    },
    async attach(identity, eventId, attachment) {
      const { error } = await client.from("stylist_image_assets").update({attachment})
        .eq("event_id",eventId).eq("user_id",identity.userId).eq("conversation_id",identity.conversationId);
      check(error);
    },
  };
  return {
    imageAssets,
    async enqueueDue() {
      const { data, error } = await client.rpc("enqueue_due_weekly_suggestions");
      check(error);
      return typeof data === "number" ? data : 0;
    },
    async checkAccess() {
      const { error } = await client.from("stylist_profiles").select("version").limit(1);
      check(error);
      const bucket = await client.storage.getBucket("wardrobe-videos");
      check(bucket.error);
      if (!bucket.data || bucket.data.public) throw new Error("Supabase stylist video bucket must be private.");
      const images = await client.storage.getBucket("outfit-images");
      check(images.error);
      if (!images.data || images.data.public) throw new Error("Supabase outfit image bucket must be private.");
      const media = await client.from("relay_event_inbox").select("reply_media,delivery_key").limit(1);
      check(media.error);
      const assets = await client.from("stylist_image_assets").select("event_id").limit(1);
      check(assets.error);
    },
    async load(identity) {
      const { data, error } = await client.from("stylist_profiles")
        .select("data,version").eq("user_id", identity.userId).eq("conversation_id", identity.conversationId)
        .abortSignal(AbortSignal.timeout(5000)).maybeSingle();
      check(error);
      if (!data) return emptyProfile();
      const defaults=emptyProfile().data;
      return { version:data.version as number,data:{...defaults,...data.data,
        shopping:{...defaults.shopping,...data.data.shopping},weekly:{...defaults.weekly,...data.data.weekly},
      } as StylistProfile };
    },
    commitResponse,
    async saveReferencePhoto(identity,eventId,photo) {
      await validatePhoto(photo);
      const extension=photo.type==="image/jpeg" ? "jpg" : photo.type==="image/webp" ? "webp" : "png";
      const storagePath=`${identity.userId}/${identity.conversationId}/reference/${eventId}.${extension}`;
      const {error}=await client.storage.from("outfit-images").upload(storagePath,photo,{contentType:photo.type,upsert:false});
      if (error && String(error.statusCode)!=="409") check(error);
      return {storagePath,mimeType:photo.type};
    },
    async commit(identity, eventId, profile, text) { return (await commitResponse(identity,eventId,profile,{text})).text; },
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
