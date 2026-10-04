import type { ConversationTurn } from "../../services/conversation.ts";
import type { GroundedShopperResult, ShopperCriteria, ShopperResult } from "../../shopper/types.ts";
import type { PathwayState } from "../../pathways/types.ts";
import type { ShoppingPreferences } from "../../preferences/types.ts";

export interface WardrobeItem {
  readonly id: string;
  readonly description: string;
  readonly brand?: string | null;
}

export interface StylistRequest {
  readonly text: string;
  readonly history?: readonly ConversationTurn[];
  readonly wardrobe?: readonly WardrobeItem[];
  readonly preferences?: PathwayState;
  readonly shoppingPreferences?: ShoppingPreferences;
  readonly avoidRecentProducts?: boolean;
  /** A requested product recommendation must search, or ask a necessary clarification. */
  readonly productRecommendation?: { readonly limit: 1 | 3 };
  readonly outfitMode?: "closet" | "preview";
}

export interface OutfitPiece {
  readonly description: string;
  readonly wardrobeItemId: string | null;
}

export interface OutfitSuggestion {
  readonly name: string;
  readonly rationale: string;
  readonly pieces: readonly OutfitPiece[];
}

export interface StylistPlan {
  readonly intro: string;
  readonly outfits: readonly OutfitSuggestion[];
  readonly questions: readonly string[];
  readonly shoppingCriteria: ShopperCriteria | null;
  readonly shoppingPairing?: { readonly wardrobeItemId: string; readonly pathwayId: string | null; readonly rationale: string } | null;
}

export interface StylistAnswer {
  readonly text: string;
  readonly plan: StylistPlan;
  readonly shopping: StylistShopperResult | null;
}

export type StylistShopperResult = ShopperResult | GroundedShopperResult;

export interface StylistShopper {
  search(criteria: ShopperCriteria): Promise<StylistShopperResult>;
}

// The model plans outfits; product search belongs to the partner's Shopper module.
export interface StylistModel {
  plan(request: StylistRequest, signal?: AbortSignal): Promise<unknown>;
}

export class StylistError extends Error {
  readonly code: "MODEL_FAILED" | "INVALID_PLAN";
  constructor(code: "MODEL_FAILED" | "INVALID_PLAN") {
    super(code === "MODEL_FAILED" ? "Stylist model request failed." : "Stylist returned an invalid plan.");
    this.name = "StylistError";
    this.code = code;
  }
}
