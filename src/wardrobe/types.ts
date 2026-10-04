export interface WardrobeCandidate {
  readonly id: string;
  readonly description: string;
  readonly category: string;
  readonly colors: readonly string[];
  readonly uncertain: boolean;
}

export const MAX_WARDROBE_ITEMS = 40;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 120;
export const SUPPORTED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;

export interface WardrobeAnalyzer {
  analyze(video: Blob, signal?: AbortSignal): Promise<WardrobeCandidate[]>;
}

export class WardrobeError extends Error {
  readonly code: "INVALID_VIDEO" | "ANALYSIS_FAILED" | "INVALID_DRAFT";
  constructor(code: WardrobeError["code"]) {
    super({
      INVALID_VIDEO: "Use an MP4, MOV or WebM closet video up to 50 MiB and two minutes.",
      ANALYSIS_FAILED: "The closet video could not be analyzed. Please try again.",
      INVALID_DRAFT: "The wardrobe draft could not be read. Please try another clear closet video.",
    }[code]);
    this.name = "WardrobeError";
    this.code = code;
  }
}
