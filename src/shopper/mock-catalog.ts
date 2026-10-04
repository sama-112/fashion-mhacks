import { mockCatalogProducts } from "./mock-data.ts";
import type { MockCatalogProduct, ProductCatalog, ShopperCriteria, ShopperResult } from "./types.ts";

const DISCLAIMER = "MOCK DATA ONLY — prices and availability are illustrative, not real." as const;

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function hasAnyRequestedValue(available: readonly string[], requested: readonly string[] | undefined) {
  if (!requested?.length) return true;
  const normalizedAvailable = new Set(available.map(normalized));
  return requested.some(value => normalizedAvailable.has(normalized(value)));
}

function validateCriteria(criteria: ShopperCriteria): void {
  const { min, max, currency } = criteria.budget ?? {};
  if (currency !== undefined && currency !== "USD") {
    throw new Error("The mock catalog only supports USD budgets.");
  }
  if (min !== undefined && (!Number.isFinite(min) || min < 0)) {
    throw new Error("Budget minimum must be a non-negative number.");
  }
  if (max !== undefined && (!Number.isFinite(max) || max < 0)) {
    throw new Error("Budget maximum must be a non-negative number.");
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error("Budget minimum must not exceed budget maximum.");
  }
}

function matches(product: MockCatalogProduct, criteria: ShopperCriteria): boolean {
  if (criteria.category && product.category !== criteria.category) return false;
  if (!hasAnyRequestedValue(product.sizes, criteria.sizes)) return false;
  if (!hasAnyRequestedValue(product.colors, criteria.colors)) return false;
  if (criteria.occasion && !product.occasions.some(value => normalized(value) === normalized(criteria.occasion!))) {
    return false;
  }

  const budget = criteria.budget;
  if (budget?.min !== undefined && product.price.amount < budget.min) return false;
  if (budget?.max !== undefined && product.price.amount > budget.max) return false;

  const keywords = criteria.keywords?.map(normalized).filter(Boolean) ?? [];
  if (keywords.length) {
    const searchable = normalized([
      product.name,
      product.brand,
      product.description,
      product.category,
      ...product.colors,
      ...product.occasions,
    ].join(" "));
    if (!keywords.every(keyword => searchable.includes(keyword))) return false;
  }

  return true;
}

export class MockProductCatalog implements ProductCatalog {
  private readonly products: readonly MockCatalogProduct[];

  constructor(products: readonly MockCatalogProduct[] = mockCatalogProducts) {
    this.products = products;
  }

  async search(criteria: ShopperCriteria): Promise<ShopperResult> {
    validateCriteria(criteria);
    return {
      source: "mock-catalog",
      products: this.products.filter(product => matches(product, criteria)),
      disclaimer: DISCLAIMER,
    };
  }
}
