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
