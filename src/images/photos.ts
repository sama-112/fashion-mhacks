export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export interface ReferencePhoto { storagePath: string; mimeType: string }
export class ReferencePhotoError extends Error {
  constructor() { super("I couldn't save that photo. Send one JPG, PNG or WebP picture of yourself, up to 10 MiB. You can also skip the photo and use flat-lay outfit pictures."); }
}
export async function validatePhoto(photo: Blob): Promise<void> {
  if (!(PHOTO_TYPES as readonly string[]).includes(photo.type) || !photo.size || photo.size > MAX_PHOTO_BYTES) throw new ReferencePhotoError();
  const bytes=Buffer.from(await photo.slice(0,12).arrayBuffer());
  const valid=photo.type==="image/jpeg" ? bytes.subarray(0,3).equals(Buffer.from([255,216,255]))
    : photo.type==="image/png" ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : bytes.subarray(0,4).toString()==="RIFF" && bytes.subarray(8,12).toString()==="WEBP";
  if (!valid) throw new ReferencePhotoError();
}
