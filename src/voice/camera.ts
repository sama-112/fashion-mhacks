import { PNG } from "pngjs";
import { VideoBufferType, VideoRotation, VideoStream, type RelayCallTransport, type RemoteVideoTrack, type VideoFrameEvent } from "@relaymessenger/sdk/calls";
import { spokenCommand } from "./commands.ts";

export const CAMERA_MAX_AGE_MS = 5000;

/** Bound encoding cost and apply the phone's rotation before sending an image to Gemini. */
export function cameraPng({ frame, rotation }: VideoFrameEvent): Blob {
  const { width, height } = frame;
  const degrees = [0, 90, 180, 270][rotation];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1920 || height > 1920
    || degrees === undefined) throw new Error("Invalid camera frame.");
  const rgba = frame.convert(VideoBufferType.RGBA);
  if (rgba.data.length !== width * height * 4) throw new Error("Invalid camera pixels.");
  const sideways = rotation === VideoRotation.VIDEO_ROTATION_90 || rotation === VideoRotation.VIDEO_ROTATION_270;
  const rotatedWidth = sideways ? height : width, rotatedHeight = sideways ? width : height;
  const scale = Math.min(1, 720 / Math.max(rotatedWidth, rotatedHeight));
  const png = new PNG({ width: Math.max(1, Math.floor(rotatedWidth * scale)), height: Math.max(1, Math.floor(rotatedHeight * scale)) });
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const rx = Math.min(rotatedWidth - 1, Math.floor(x / scale)), ry = Math.min(rotatedHeight - 1, Math.floor(y / scale));
    const sx = degrees === 90 ? ry : degrees === 180 ? width - 1 - rx : degrees === 270 ? width - 1 - ry : rx;
    const sy = degrees === 90 ? height - 1 - rx : degrees === 180 ? height - 1 - ry : degrees === 270 ? rx : ry;
    const source = (sy * width + sx) * 4, target = (y * png.width + x) * 4;
    png.data.set(rgba.data.subarray(source, source + 4), target);
  }
  return new Blob([new Uint8Array(PNG.sync.write(png))], { type: "image/png" });
}

export function createCallCamera(transport: RelayCallTransport, now = Date.now) {
  let latest: { event: VideoFrameEvent; receivedAt: number } | null = null;
  let reader: ReadableStreamDefaultReader<VideoFrameEvent> | undefined;
  let stopped = false;
  let cameraOn = true;
  let previousSample = -Infinity;
  const subscribe = (track: RemoteVideoTrack) => {
    if (stopped || reader) return;
    reader = new VideoStream(track, { format: VideoBufferType.I420, capacity: 1 }).getReader();
    const current = reader;
    void (async () => {
      try {
        while (!stopped) {
          const { value, done } = await current.read();
          if (done) break;
          const timestamp = now();
          if (cameraOn && timestamp - previousSample >= 500) { latest = { event: value!, receivedAt: timestamp }; previousSample = timestamp; }
        }
      } catch { if (!stopped) console.warn("Call camera unavailable; voice remains available."); }
      finally { latest = null; current.releaseLock(); }
    })();
  };
  const cameraState = (on: boolean) => { cameraOn = on; if (!on) latest = null; };
  transport.on("trackSubscribed", subscribe).on("remoteVideo", cameraState);
  // Track subscription may precede ElevenLabsCall.connect resolving.
  if (transport.remoteVideoTrack) subscribe(transport.remoteVideoTrack);
  return {
    snapshot(): Blob | null {
      if (stopped || !latest || now() - latest.receivedAt > CAMERA_MAX_AGE_MS) return null;
      try { return cameraPng(latest.event); } catch { return null; }
    },
    close() {
      stopped = true; latest = null;
      transport.off("trackSubscribed", subscribe).off("remoteVideo", cameraState);
      void reader?.cancel().catch(() => undefined);
    },
  };
}

export function needsCallCamera(text: string): boolean {
  const command = spokenCommand(text);
  if (/^(?:save wardrobe|cancel|show wardrobe|remove \d+|change \d+:.*)$/i.test(command)) return false;
  return /\b(?:this|these|what (?:I am|I'm|I’m) wearing|on (?:the )?camera|look at|showing you)\b/i.test(text)
    && /\b(?:clothes?|clothing|shirt|jacket|jeans|pants|trousers|dress|shoes?|outfit|fit|wearing|add|save|scan|look|think|like|color|colour|match|style|see|showing|what|describe|bought|purchased|got)\b/i.test(text);
}
