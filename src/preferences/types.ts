import type { ProductCategory, ShopperCriteria } from "../shopper/types.ts";
import type { StylistShopperResult } from "../agents/stylist/types.ts";

export const spendingCategories = ["shirts", "knitwear", "pants", "shorts", "skirts", "dresses", "shoes", "jackets", "coats", "tops", "bottoms", "footwear", "outerwear"] as const;
export type SpendingCategory = typeof spendingCategories[number];
export interface Recommendation {
  readonly id: string;
  readonly name: string;
  readonly brand?: string;
  readonly category: ProductCategory;
  readonly spendingCategory: SpendingCategory;
  readonly price?: { amount: number; currency: string };
  readonly url?: string;
}
export interface ItemFeedback {
  readonly item: Recommendation;
  readonly reason: "price" | "color" | "fit" | "style" | "material" | "other";
  readonly evidence: string;
  readonly recordedAt: string;
}
export interface CategoryBudget {
  readonly max: number;
  readonly currency: "USD";
  readonly evidence: string;
}
export interface ShoppingPreferences {
  recommendations: readonly Recommendation[];
  feedback: readonly ItemFeedback[];
  budgets: Partial<Record<SpendingCategory, CategoryBudget>>;
  pendingRejection: Recommendation | null;
  pendingBudget: SpendingCategory | null;
  recentlySuggestedIds: readonly string[];
}
export function emptyShoppingPreferences(): ShoppingPreferences {
  return { recommendations: [], feedback: [], budgets: {}, pendingRejection: null, pendingBudget: null, recentlySuggestedIds: [] };
}

const groups: Record<SpendingCategory, ProductCategory> = {
  shirts: "tops", knitwear: "tops", tops: "tops", pants: "bottoms", shorts: "bottoms", skirts: "bottoms", bottoms: "bottoms",
  dresses: "dresses", shoes: "footwear", footwear: "footwear", jackets: "outerwear", coats: "outerwear", outerwear: "outerwear",
};
const words: readonly [SpendingCategory, RegExp][] = [
  ["shirts", /\b(?:shirts?|overshirts?|t[- ]?shirts?|tees?|blouses?|polos?)\b/i], ["knitwear", /\b(?:knitwear|sweaters?|jumpers?|cardigans?|hoodies?)\b/i],
  ["pants", /\b(?:pants?|trousers?|jeans?|chinos?)\b/i], ["shorts", /\bshorts\b/i], ["skirts", /\bskirts?\b/i],
  ["dresses", /\bdress(?:es)?\b/i], ["shoes", /\b(?:shoes?|sneakers?|boots?|sandals?|loafers?)\b/i],
  ["jackets", /\b(?:jackets?|blazers?)\b/i], ["coats", /\b(?:coats?|parkas?)\b/i],
  ["tops", /\btops?\b/i], ["bottoms", /\bbottoms?\b/i], ["footwear", /\bfootwear\b/i], ["outerwear", /\bouterwear\b/i],
];
export function spendingCategory(text: string, fallback?: ProductCategory): SpendingCategory | null {
  return words.find(([, pattern]) => pattern.test(text))?.[0] ?? fallback ?? null;
}
export function productCategory(category: SpendingCategory): ProductCategory { return groups[category]; }

export function applyCategoryBudget(criteria: ShopperCriteria, state?: ShoppingPreferences): ShopperCriteria {
  if (!state) return criteria;
  const kind = spendingCategory((criteria.keywords ?? []).join(" "), criteria.category);
  if (!kind) return criteria;
  const limits = [state.budgets[kind]?.max, state.budgets[groups[kind]]?.max, criteria.budget?.max]
    .filter((value): value is number => value !== undefined);
  if (!limits.length) return criteria;
  const max = Math.min(...limits);
  const min = criteria.budget?.min;
  return { ...criteria, category: criteria.category ?? groups[kind], budget: {
    currency: "USD", max, ...(min !== undefined && min <= max ? { min } : {}),
  } };
}

export function filterShoppingResult(result: StylistShopperResult, criteria: ShopperCriteria, state?: ShoppingPreferences, avoidRecent = false): StylistShopperResult {
  const rejected = new Set([...(state?.feedback.map(feedback => feedback.item.id) ?? []), ...(avoidRecent ? state?.recentlySuggestedIds ?? [] : [])]);
  const maximum = (name: string) => {
    const kind = spendingCategory(name,criteria.category);
    const limits = [criteria.budget?.max, ...(kind ? [state?.budgets[kind]?.max,state?.budgets[groups[kind]]?.max] : [])]
      .filter((value): value is number=>value!==undefined);
    return limits.length ? Math.min(...limits) : undefined;
  };
  if (result.source === "mock-catalog") return { ...result, products: result.products.filter(item => {
    const max = maximum(item.name);
    return !rejected.has(item.id) && (max===undefined || item.price.amount<=max);
  }) };
  return { ...result, products: result.products.filter(item => {
    const max = maximum(item.name);
    return !rejected.has(item.id) && (max===undefined || !item.reportedPrice || (item.reportedPrice.currency==="USD" && item.reportedPrice.amount<=max));
  }) };
}

export function rememberRecommendations(result: StylistShopperResult, criteria: ShopperCriteria): Recommendation[] {
  return result.products.slice(0, 3).map(item => {
    const fallback = result.source === "mock-catalog" && "category" in item ? item.category : criteria.category;
    const kind = spendingCategory(item.name, fallback) ?? "tops";
    const category = productCategory(kind);
    const price = "reportedPrice" in item ? item.reportedPrice : "price" in item ? item.price : undefined;
    return { id: item.id, name: item.name, brand: item.brand, category, spendingCategory: kind,
      ...(price ? { price: { amount: price.amount, currency: price.currency } } : {}),
      ...("productUrl" in item ? { url: item.productUrl } : {}),
    };
  });
}
