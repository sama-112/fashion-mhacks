import { StylistError, type OutfitSuggestion, type StylistPlan, type WardrobeItem } from "./types.ts";
import type { ProductCategory, ShopperCriteria } from "../../shopper/types.ts";

const categories: readonly ProductCategory[] = ["tops", "bottoms", "dresses", "footwear", "outerwear"];
const criteriaSchema = {
  type: ["object", "null"], additionalProperties: false,
  description: "Null unless the user requests product search. Copy their constraints; do not assume size or budget. USD only.",
  properties: {
    category: { type: "string", enum: categories },
    keywords: { type: "array", maxItems: 6, items: { type: "string" } },
    sizes: { type: "array", maxItems: 6, items: { type: "string" } },
    colors: { type: "array", maxItems: 6, items: { type: "string" } },
    occasion: { type: "string" },
    budget: {
      type: "object", additionalProperties: false,
      properties: { min: { type: "number", minimum: 0 }, max: { type: "number", minimum: 0 }, currency: { type: "string", enum: ["USD"] } },
      required: ["currency"],
    },
  },
} as const;

export const stylistPlanSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    intro: { type: "string", description: "Brief styling advice. No product links or stock/price claims." },
    outfits: {
      type: "array", maxItems: 2,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          name: { type: "string" },
          rationale: { type: "string" },
          pieces: {
            type: "array", minItems: 1, maxItems: 8,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                description: { type: "string" },
                wardrobeItemId: { type: ["string", "null"], description: "Only an ID supplied in the wardrobe; otherwise null." },
              },
              required: ["description", "wardrobeItemId"],
            },
          },
        },
        required: ["name", "rationale", "pieces"],
      },
    },
    questions: { type: "array", maxItems: 3, items: { type: "string" } },
    shoppingCriteria: criteriaSchema,
  },
  required: ["intro", "outfits", "questions", "shoppingCriteria"],
} as const;

function invalid(): never { throw new StylistError("INVALID_PLAN"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /https?:\/\/|www\./i.test(value)) invalid();
  return value.trim();
}
function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) invalid();
  return value;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) invalid();
}

function parseCriteria(value: unknown): ShopperCriteria | null {
  if (value === null) return null;
  const criteria = object(value);
  onlyKeys(criteria, ["category", "keywords", "sizes", "colors", "occasion", "budget"]);
  const result: { category?: ProductCategory; keywords?: string[]; sizes?: string[]; colors?: string[]; occasion?: string; budget?: { min?: number; max?: number; currency: "USD" } } = {};
  if (criteria.category !== undefined) {
    if (!categories.includes(criteria.category as ProductCategory)) invalid();
    result.category = criteria.category as ProductCategory;
  }
  for (const key of ["keywords", "sizes", "colors"] as const) {
    if (criteria[key] !== undefined) result[key] = array(criteria[key], 6).map(value => text(value, 80));
  }
  if (criteria.occasion !== undefined) result.occasion = text(criteria.occasion, 80);
  if (criteria.budget !== undefined) {
    const budget = object(criteria.budget);
    onlyKeys(budget, ["min", "max", "currency"]);
    if (budget.currency !== "USD") invalid();
    const parsed: { min?: number; max?: number; currency: "USD" } = { currency: "USD" };
    for (const key of ["min", "max"] as const) {
      const value = budget[key];
      if (value !== undefined) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid();
        parsed[key] = value;
      }
    }
    if (parsed.min !== undefined && parsed.max !== undefined && parsed.min > parsed.max) invalid();
    result.budget = parsed;
  }
  return result;
}

export function parseStylistPlan(value: unknown, wardrobe: readonly WardrobeItem[] = []): StylistPlan {
  const plan = object(value);
  const knownItems = new Map(wardrobe.map(item => [item.id, item.description]));
  onlyKeys(plan, ["intro", "outfits", "questions", "shoppingCriteria"]);
  const outfits: OutfitSuggestion[] = array(plan.outfits, 2).map(value => {
    const outfit = object(value);
    onlyKeys(outfit, ["name", "rationale", "pieces"]);
    const pieces = array(outfit.pieces, 8).map(value => {
      const piece = object(value);
      onlyKeys(piece, ["description", "wardrobeItemId"]);
      const id = piece.wardrobeItemId;
      if (id !== null && (typeof id !== "string" || !knownItems.has(id))) invalid();
      // A supplied wardrobe item is displayed using its actual description.
      const description = text(id === null ? piece.description : knownItems.get(id), 200);
      return { description, wardrobeItemId: id as string | null };
    });
    if (!pieces.length) invalid();
    return { name: text(outfit.name, 80), rationale: text(outfit.rationale, 400), pieces };
  });
  return {
    intro: text(plan.intro, 500),
    outfits,
    questions: array(plan.questions, 3).map(value => text(value, 200)),
    shoppingCriteria: parseCriteria(plan.shoppingCriteria),
  };
}

export function formatStylistPlan(plan: StylistPlan): string {
  const sections = [plan.intro];
  for (const outfit of plan.outfits) {
    sections.push(`${outfit.name}\n${outfit.pieces.map(piece => `• ${piece.description}`).join("\n")}\n${outfit.rationale}`);
  }
  if (plan.questions.length) sections.push(plan.questions.join("\n"));
  return sections.join("\n\n");
}
