export { MockProductCatalog } from "./mock-catalog.ts";
export {
  createGeminiGroundedShopperFromEnvironment,
  createGoogleSearchGroundedShopper,
  GeminiGroundedShopper,
} from "./gemini-research.ts";
export { mockCatalogProducts } from "./mock-data.ts";
export type {
  GroundedSearchClient,
  GroundedSearchQuery,
  GroundedSearchResponse,
  ShopperModels,
} from "./gemini-research.ts";
export type {
  BudgetCurrency,
  BrandConfidence,
  GroundedProductCandidate,
  GroundedShopperResult,
  MockCatalogProduct,
  ProductCatalog,
  ProductCitation,
  ProductResearcher,
  ProductCategory,
  StylistShoppingRequest,
  ShopperCriteria,
  ShopperResult,
  VideoBrandReference,
} from "./types.ts";
