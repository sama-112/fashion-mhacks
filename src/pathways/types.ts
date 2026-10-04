import type { ConversationTurn } from "../services/conversation.ts";

export interface StylePathway {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly palette: readonly string[];
  readonly staples: readonly string[];
  readonly ownedItemIds: readonly string[];
  readonly status: "offered" | "liked" | "rejected";
}

export interface PathwayFeedback {
  readonly pathwayId: string;
  readonly pathwayTitle: string;
  readonly reason: string;
  readonly evidence: string;
}

export interface PathwayState {
  readonly pathways: readonly StylePathway[];
  readonly preferences: readonly PathwayFeedback[];
  readonly pendingRejectionId: string | null;
  /** The three most recently offered directions; numbering never includes old likes. */
  readonly offeredIds?: readonly string[];
}

export interface PathwayRequest {
  readonly text: string;
  readonly wardrobe: readonly { readonly id: string; readonly description: string }[];
  readonly history?: readonly ConversationTurn[];
  /** Internal onboarding calls must produce fresh directions, not interpret feedback. */
  readonly generateOnly?: boolean;
  readonly wardrobeSource?: "video-draft" | "confirmed";
}

export function emptyPathwayState(): PathwayState {
  return { pathways: [], preferences: [], pendingRejectionId: null };
}

export class PathwayError extends Error {
  readonly code = "PATHWAY_MODEL_FAILED";
  constructor() {
    super("Style pathway request failed.");
    this.name = "PathwayError";
  }
}
