export type ProductCategory = "tops" | "bottoms" | "dresses" | "footwear" | "outerwear";
export type BudgetCurrency = "USD";

export interface ShopperCriteria {
  readonly category?: ProductCategory;
  readonly keywords?: readonly string[];
  readonly sizes?: readonly string[];
  readonly colors?: readonly string[];
  readonly occasion?: string;
  readonly budget?: {
    readonly min?: number;
    readonly max?: number;
    readonly currency: BudgetCurrency;
  };
}

export interface MockCatalogProduct {
  readonly id: string;
  readonly name: string;
  readonly category: ProductCategory;
  readonly brand: string;
  readonly description: string;
  readonly sizes: readonly string[];
  readonly colors: readonly string[];
  readonly occasions: readonly string[];
  readonly source: "mock";
  readonly price: {
    readonly amount: number;
    readonly currency: BudgetCurrency;
    readonly isMock: true;
  };
  readonly availability: {
    readonly status: "mock-only";
    readonly note: "No live inventory is connected.";
  };
}

export interface ShopperResult {
  readonly source: "mock-catalog";
  readonly products: readonly MockCatalogProduct[];
  readonly disclaimer: "MOCK DATA ONLY — prices and availability are illustrative, not real.";
}

export interface ProductCatalog {
  search(criteria: ShopperCriteria): Promise<ShopperResult>;
}

export type BrandConfidence = "low" | "medium" | "high";

export interface VideoBrandReference {
  readonly name: string;
  readonly confidence: BrandConfidence;
}

/** Provisional Stylist-to-Shopper request; it does not contain the source video. */
export interface StylistShoppingRequest extends ShopperCriteria {
  readonly market: "US";
  /** Brands the user explicitly said they like. */
  readonly preferredBrands: readonly string[];
  /** Brands recognized on garments in video; these are style references, not preferences. */
  readonly referenceBrands: readonly VideoBrandReference[];
  readonly maxResults?: number;
}

export interface ProductCitation {
  readonly title?: string;
  readonly url: string;
}

export interface GroundedProductCandidate {
  readonly id: string;
  readonly name: string;
  readonly brand: string;
  readonly retailer: string;
  readonly productUrl: string;
  readonly summary: string;
  readonly matchReason: string;
  readonly brandMatch: "preferred-brand" | "alternative";
  readonly citation: ProductCitation;
  readonly reportedPrice?: {
    readonly amount: number;
    readonly currency: string;
    readonly sourceUrl: string;
    readonly status: "search-cited-unverified";
  };
  readonly availability: {
    readonly status: "unverified";
    readonly note: "Confirm availability with the retailer before purchase.";
  };
}

export interface GroundedShopperResult {
  readonly source: "gemini-google-search";
  readonly retrievedAt: string;
  readonly products: readonly GroundedProductCandidate[];
  readonly disclaimer: "Search-cited product details are not independently verified; prices can change and inventory is unverified.";
}

export interface ProductResearcher {
  search(request: StylistShoppingRequest): Promise<GroundedShopperResult>;
}
