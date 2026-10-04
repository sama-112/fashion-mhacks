import Relay, { RelayAPIError, type WebhookHeaders } from "@relaymessenger/sdk";
import type { AcceptedEvent } from "../db/inbox.ts";
import type { ConversationAudio, ConversationImage, ConversationMessage, ConversationPhoto, ConversationVideo } from "../services/conversation.ts";
import { MAX_IMAGE_BYTES } from "../images/outfits.ts";
import { MAX_PHOTO_BYTES, PHOTO_TYPES, ReferencePhotoError, validatePhoto } from "../images/photos.ts";
import { MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS, SUPPORTED_VIDEO_TYPES } from "../wardrobe/types.ts";
import { AUDIO_TYPES, MAX_AUDIO_BYTES, MAX_AUDIO_MS, VoiceNoteError } from "../purchases/index.ts";

export class RelayVideoError extends Error {
  constructor(message = "I couldn't download that video. Please send it again as an MP4, MOV or WebM clip up to 50 MiB and two minutes.") {
    super(message);
    this.name = "RelayVideoError";
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Relay object.");
  }
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid Relay ID.");
  }
  return value;
}

export class RelayAdapter {
  constructor(privateClient: Relay) {
    this.client = privateClient;
  }
  private readonly client: Relay;

  verify(rawBody: Buffer, headers: WebhookHeaders): AcceptedEvent {
    // The official SDK validates signature and timestamp before parsing JSON.
    const payload = object(this.client.webhooks.unwrap<unknown>(rawBody, { headers }));
    const eventId = id(payload.event_id);
    const headerId = headers instanceof Headers ? headers.get("webhook-id") : headers["webhook-id"];
    if (headerId !== eventId || payload.api_version !== "v1" ||
        payload.webhook_version !== "2026-08-30" || typeof payload.event_type !== "string") {
      throw new Error("Unsupported Relay envelope.");
    }
    const agentId = id(payload.agent_id);
    let message: ConversationMessage | null = null;
    if (payload.event_type === "message.received") {
      const data = object(payload.data);
      const chat = object(data.chat);
      const sender = object(data.sender_handle);
      const conversationId = id(chat.id);
      const userId = id(sender.id);
      const messageId = id(data.id);
      if (!Array.isArray(data.parts) || data.parts.length > 100) {
        throw new Error("Invalid Relay message parts.");
      }
      const text = data.parts.map(part => {
        const item = object(part);
        if (item.type !== "text") return "";
        if (typeof item.value !== "string" || item.value.length > 10000) {
          throw new Error("Invalid Relay text part.");
        }
        return item.value;
      }).filter(Boolean).join("\n");
      const videos: ConversationVideo[] = data.parts.flatMap(part => {
        const item = object(part);
        if (item.type !== "media" || typeof item.mime_type !== "string" || !item.mime_type.startsWith("video/")) return [];
        return [{ mediaId: id(item.id), mimeType: item.mime_type,
          ...(typeof item.size_bytes === "number" ? { sizeBytes: item.size_bytes } : {}),
          ...(typeof item.duration_ms === "number" ? { durationMs: item.duration_ms } : {}),
        }];
      });
      const photos: ConversationPhoto[] = data.parts.flatMap(part => {
        const item=object(part);
        if (item.type!=="media" || typeof item.mime_type!=="string" || !item.mime_type.startsWith("image/")) return [];
        return [{mediaId:id(item.id),mimeType:item.mime_type,...(typeof item.size_bytes==="number" ? {sizeBytes:item.size_bytes} : {})}];
      });
      const audio:ConversationAudio[]=data.parts.flatMap(part=>{
        const item=object(part);
        if(item.type!=="media" || typeof item.mime_type!=="string" || !item.mime_type.startsWith("audio/"))return [];
        return [{mediaId:id(item.id),mimeType:item.mime_type,...(typeof item.size_bytes==="number" ? {sizeBytes:item.size_bytes}:{}),...(typeof item.duration_ms==="number" ? {durationMs:item.duration_ms}:{})}];
      });
      if (text.length > 10000) throw new Error("Relay message text is too long.");
      // Keep every raw part in the inbox; only human direct messages start work.
      if (sender.kind === "user" && sender.is_me === false &&
          data.direction === "inbound" && chat.is_group === false && (text.trim() || videos.length || photos.length || audio.length)) {
        message = { text, userId, conversationId, messageId, ...(videos.length ? { videos } : {}),...(photos.length ? {photos} : {}),...(audio.length ? {audio}: {}) };
      }
    }
    return { eventId, agentId, payload, message };
  }

  async checkAccess(): Promise<void> {
    await this.client.chats.listChats({ limit: 1 });
  }

  async downloadVideo(message: ConversationMessage, video: ConversationVideo, signal?: AbortSignal): Promise<Blob> {
    const deadline = AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]);
    try {
      if (!(SUPPORTED_VIDEO_TYPES as readonly string[]).includes(video.mimeType) ||
          (video.sizeBytes !== undefined && (!Number.isFinite(video.sizeBytes) || video.sizeBytes <= 0 || video.sizeBytes > MAX_VIDEO_BYTES)) ||
          (video.durationMs !== undefined && (!Number.isFinite(video.durationMs) || video.durationMs > MAX_VIDEO_SECONDS * 1000))) {
        throw new RelayVideoError();
      }
      if (!message.messageId || !message.userId || !message.conversationId) throw new RelayVideoError();
      const original = await this.client.messages.retrieve(message.messageId, { signal: deadline });
      if (original.id !== message.messageId || original.chat_id !== message.conversationId || original.is_from_me ||
          original.from_handle?.id !== message.userId || original.from_handle.kind !== "user" ||
          !original.parts?.some(part => part.type === "media" && part.id === video.mediaId && part.mime_type === video.mimeType)) {
        throw new RelayVideoError();
      }
      // Refresh signed links through the authenticated API, never use a URL from user text.
      const attachment = await this.client.attachments.retrieve(video.mediaId, { signal: deadline });
      if (attachment.id !== video.mediaId || attachment.status !== "complete" ||
          attachment.content_type !== video.mimeType || !attachment.download_url ||
          attachment.size_bytes <= 0 || attachment.size_bytes > MAX_VIDEO_BYTES ||
          (attachment.duration_ms ?? 0) > MAX_VIDEO_SECONDS * 1000) throw new RelayVideoError();
      const url = new URL(attachment.download_url);
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
          url.hostname === "localhost" || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) throw new RelayVideoError();
      const response = await fetch(url, { signal: deadline, redirect: "error" });
      if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > MAX_VIDEO_BYTES) {
        await response.body?.cancel();
        throw new RelayVideoError();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_VIDEO_BYTES) throw new RelayVideoError();
          chunks.push(new Uint8Array(chunk.value));
        }
      } finally { await reader.cancel(); }
      if (!bytes || bytes !== attachment.size_bytes) throw new RelayVideoError();
      return new Blob(chunks, { type: video.mimeType });
    } catch {
      signal?.throwIfAborted();
      throw new RelayVideoError();
    }
  }

  async downloadPhoto(message: ConversationMessage, photo: ConversationPhoto, signal?: AbortSignal): Promise<Blob> {
    try {
      const blob=await this.downloadSmallMedia(message,photo,PHOTO_TYPES,MAX_PHOTO_BYTES,signal);
      await validatePhoto(blob);return blob;
    } catch {signal?.throwIfAborted();throw new ReferencePhotoError();}
  }

  async downloadAudio(message:ConversationMessage,audio:ConversationAudio,signal?:AbortSignal):Promise<Blob> {
    try {return await this.downloadSmallMedia(message,audio,AUDIO_TYPES,MAX_AUDIO_BYTES,signal,MAX_AUDIO_MS);}
    catch {signal?.throwIfAborted();throw new VoiceNoteError();}
  }

  private async downloadSmallMedia(message:ConversationMessage,photo:ConversationAudio,types:readonly string[],maxBytes:number,signal?:AbortSignal,maxDuration?:number):Promise<Blob> {
    const deadline=AbortSignal.any([AbortSignal.timeout(60000),...(signal ? [signal] : [])]);
    try {
      if (!types.includes(photo.mimeType) ||
          (photo.sizeBytes!==undefined && (!Number.isFinite(photo.sizeBytes) || photo.sizeBytes<=0 || photo.sizeBytes>maxBytes)) ||
          (maxDuration!==undefined && photo.durationMs!==undefined && (!Number.isFinite(photo.durationMs) || photo.durationMs<0 || photo.durationMs>maxDuration)) ||
          !message.messageId || !message.userId || !message.conversationId) throw new ReferencePhotoError();
      const original=await this.client.messages.retrieve(message.messageId,{signal:deadline});
      if (original.id!==message.messageId || original.chat_id!==message.conversationId || original.is_from_me ||
          original.from_handle?.id!==message.userId || original.from_handle.kind!=="user" ||
          !original.parts?.some(part=>part.type==="media" && part.id===photo.mediaId && part.mime_type===photo.mimeType)) throw new ReferencePhotoError();
      const attachment=await this.client.attachments.retrieve(photo.mediaId,{signal:deadline});
      if (attachment.id!==photo.mediaId || attachment.status!=="complete" || attachment.content_type!==photo.mimeType ||
          !attachment.download_url || !Number.isFinite(attachment.size_bytes) || attachment.size_bytes<=0 || attachment.size_bytes>maxBytes ||
          (maxDuration!==undefined && attachment.duration_ms!==null && attachment.duration_ms!==undefined && (!Number.isFinite(attachment.duration_ms) || attachment.duration_ms<0 || attachment.duration_ms>maxDuration))) throw new ReferencePhotoError();
      const url=new URL(attachment.download_url);
      if (url.protocol!=="https:" || url.username || url.password || url.port || url.hostname==="localhost" ||
          /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) throw new ReferencePhotoError();
      const response=await fetch(url,{signal:deadline,redirect:"error"});
      if (!response.ok || !response.body || Number(response.headers.get("content-length")??0)>maxBytes) {
        await response.body?.cancel(); throw new ReferencePhotoError();
      }
      const reader=response.body.getReader(),chunks:Uint8Array<ArrayBuffer>[]=[]; let bytes=0;
      try {
        while(true) {
          const chunk=await reader.read(); if(chunk.done)break;
          bytes+=chunk.value.byteLength; if(bytes>maxBytes)throw new ReferencePhotoError();
          chunks.push(new Uint8Array(chunk.value));
        }
      } finally {await reader.cancel();}
      if (!bytes || bytes!==attachment.size_bytes)throw new ReferencePhotoError();
      return new Blob(chunks,{type:photo.mimeType});
    } catch {signal?.throwIfAborted(); throw new ReferencePhotoError();}
  }

  async uploadImage(image: Blob, signal?: AbortSignal): Promise<ConversationImage> {
    if (!["image/png", "image/jpeg", "image/webp"].includes(image.type) || !image.size || image.size > MAX_IMAGE_BYTES) throw new Error("Invalid outfit image.");
    const deadline = AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]);
    const extension = image.type === "image/jpeg" ? "jpg" : image.type === "image/webp" ? "webp" : "png";
    const allocation = await this.client.attachments.create({ filename: `outfit-concept.${extension}`, content_type: image.type, size_bytes: image.size }, { signal: deadline });
    await this.client.attachments.upload(allocation, image, { signal: deadline });
    // Relay may need a short processing interval before the attachment can be sent.
    for (let attempt = 0; attempt < 10; attempt++) {
      deadline.throwIfAborted();
      const attachment = await this.client.attachments.retrieve(allocation.attachment_id, { signal: deadline });
      if (attachment.status === "complete" && attachment.content_type === image.type && attachment.size_bytes === image.size) {
        return { attachmentId: id(attachment.id), mimeType: image.type };
      }
      if (attachment.status === "failed") break;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, 500);
        const abort = () => { clearTimeout(timer); deadline.removeEventListener("abort", abort); reject(new Error("Image upload interrupted.")); };
        function done() { deadline.removeEventListener("abort", abort); resolve(); }
        deadline.addEventListener("abort", abort, { once: true });
      });
    }
    throw new Error("Relay outfit image upload failed.");
  }

  async sendReply(eventId: string, message: ConversationMessage, text: string, signal?: AbortSignal, images: readonly ConversationImage[] = []) {
    if (!message.conversationId || (!message.messageId && message.deliveryKind !== "weekly")) throw new Error("Missing reply identity.");
    if (images.length > 1) throw new Error("Invalid outfit image count.");
    await this.client.chats.messages.send(message.conversationId, {
      message: {
        parts: [{ type: "text", value: text }, ...images.map(image => ({ type: "media" as const, attachment_id: id(image.attachmentId) }))],
        ...(message.messageId ? { reply_to: { message_id: message.messageId } } : {}),
        idempotency_key: `${message.deliveryKind === "weekly" ? "stylist-weekly" : "stylist-reply"}:${eventId}`,
      },
    }, { signal });
  }
}

export function safeRelayError(error: unknown): string {
  if (error instanceof RelayAPIError) {
    return `Relay request failed (HTTP ${error.status ?? "unknown"}, code ${error.code ?? "unknown"}).`;
  }
  return "Relay request failed; check network connectivity and configuration.";
}

export function isTerminalSendError(error: unknown): boolean {
  return error instanceof RelayAPIError && error.status !== undefined &&
    error.status >= 400 && error.status < 500 && error.status !== 429 && error.status !== 408;
}

export function retryAfterSeconds(error: unknown): number {
  return error instanceof RelayAPIError && Number.isFinite(error.retryAfter)
    ? Math.max(0, error.retryAfter!) : 0;
}
