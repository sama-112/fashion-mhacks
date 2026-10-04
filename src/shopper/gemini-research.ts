import { GoogleGenAI } from "@google/genai";
import type { GroundedProductCandidate, GroundedShopperResult, ProductCitation, ProductResearcher, StylistShoppingRequest } from "./types.ts";

const DISCLAIMER = "Search-cited product details are not independently verified; prices can change and inventory is unverified." as const;
const AVAILABILITY_NOTE = "Confirm availability with the retailer before purchase." as const;
const MAX_RESULTS = 5;

export interface GroundedSearchResponse {
  readonly text: string;
  readonly citations: readonly ProductCitation[];
}

export interface GroundedSearchQuery {
  readonly model: string;
  readonly prompt: string;
}

export type GroundedSearchClient = (query: GroundedSearchQuery) => Promise<GroundedSearchResponse>;

export interface ShopperModels {
  readonly primary: string;
  readonly fallback: string;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function validateRequest(request: StylistShoppingRequest): void {
  if (request.market !== "US") throw new Error("The Shopper currently supports the US market only.");
  if (!Array.isArray(request.preferredBrands) || !Array.isArray(request.referenceBrands)) {
    throw new Error("Shopper requests must separate preferred brands from video-reference brands.");
  }
  if (request.referenceBrands.some(brand =>
    !brand.name.trim() || !["low", "medium", "high"].includes(brand.confidence))) {
    throw new Error("Video-reference brands must include a name and confidence level.");
  }
  if (request.maxResults !== undefined &&
      (!Number.isInteger(request.maxResults) || request.maxResults < 1 || request.maxResults > MAX_RESULTS)) {
    throw new Error(`maxResults must be an integer from 1 to ${MAX_RESULTS}.`);
  }
  const { min, max, currency } = request.budget ?? {};
  if (currency !== undefined && currency !== "USD") {
    throw new Error("The Shopper currently supports USD budgets only.");
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

function buildPrompt(request: StylistShoppingRequest, maxResults: number): string {
  const searchRequest = {
    market: "United States",
    category: request.category,
    keywords: request.keywords,
    sizes: request.sizes,
    colors: request.colors,
    occasion: request.occasion,
    budget: request.budget,
    explicitlyPreferredBrands: request.preferredBrands,
    videoReferenceBrands: request.referenceBrands,
    maxResults,
  };

  return [
    "You are a careful apparel product researcher. Find current clothing product pages for this US shopper using Google Search.",
    "Search explicitly preferred brands first. Video-reference brands are visual inspiration only; do not say the user prefers them.",
    "Then include style alternatives from other clothing brands when useful.",
    "Return only real product-specific pages found in the search. Each productUrl must be the direct HTTPS retailer destination, never a Google grounding redirect, and its domain must be represented in the Google Search citations. Do not invent brands, products, URLs, prices, discounts, or stock.",
    "Include reportedPrice only when a cited product source explicitly shows a numeric price and currency; set sourceUrl to the direct retailer product URL that shows it. Omit price if uncertain. Never report availability; the app will mark it unverified.",
    "Give a short factual summary and explain why it matches the request. If no cited product pages match, return an empty products array.",
    `For every item use this exact plain-text block, with one label per line and no JSON/code fence:\nPRODUCT: [product name](direct product URL)\nBRAND: actual clothing brand\nRETAILER: store name\nSUMMARY: one factual sentence\nMATCH: why it fits\nPRICE: $amount USD only when a cited source explicitly shows one price; omit PRICE if missing or ambiguous. Return at most ${maxResults} blocks.`,
    `Structured request: ${JSON.stringify(searchRequest)}`,
  ].join("\n");
}

function normalizedHttpsUrl(value: unknown, allowGoogleCitation = false): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLocaleLowerCase("en-US");
    if (url.protocol !== "https:" || url.username || url.password ||
        (!allowGoogleCitation && (host === "google.com" || host.endsWith(".google.com") ||
          host === "googleusercontent.com" || host.endsWith(".googleusercontent.com")))) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function citationDomain(title: string | undefined): string | null {
  if (!title) return null;
  const match = title.toLocaleLowerCase("en-US").match(/(?:[a-z0-9-]+\.)+[a-z]{2,}/);
  return match?.[0].replace(/^www\./, "") ?? null;
}

function citationForProductUrl(productUrl: string, citations: readonly ProductCitation[]): ProductCitation | undefined {
  const exact = citations.find(citation => normalizedHttpsUrl(citation.url) === productUrl);
  if (exact) return exact;

  const hostname = new URL(productUrl).hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  return citations.find(citation => {
    const domain = citationDomain(citation.title);
    return domain !== null && (hostname === domain || hostname.endsWith(`.${domain}`));
  });
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function parseJson(text: string): Record<string, unknown> | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return object(JSON.parse(stripped));
  } catch {
    return null;
  }
}

function plainTextProductRows(text: string): Record<string, unknown>[] {
  const stripped = text.trim().replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/, "");
  const blocks = stripped.split(/(?=^(?:\d+\.\s*)?PRODUCT:\s*)/mi);
  const rows: Record<string, unknown>[] = [];
  for (const block of blocks) {
    const productLine = block.match(/^(?:\d+\.\s*)?PRODUCT:\s*(.+)$/mi)?.[1]?.trim();
    if (!productLine) continue;
    const productLink = productLine.match(/^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/i);
    const field = (name: string) => block.match(new RegExp(`^${name}:\\s*(.+)$`, "mi"))?.[1]?.trim();
    const productUrl = productLink?.[2] ?? field("URL");
    if (!productUrl) continue;

    const priceText = field("PRICE");
    const simplePrice = priceText?.match(/^(?:US\$|\$)?\s*([\d,]+(?:\.\d{1,2})?)\s*(USD)?$/i);
    const amount = simplePrice ? Number(simplePrice[1]!.replaceAll(",", "")) : NaN;
    rows.push({
      name: productLink?.[1] ?? productLine,
      brand: field("BRAND"),
      retailer: field("RETAILER"),
      productUrl,
      summary: field("SUMMARY"),
      matchReason: field("MATCH"),
      ...(Number.isFinite(amount) ? {
        reportedPrice: { amount, currency: "USD", sourceUrl: productUrl },
      } : {}),
    });
  }
  return rows;
}

function candidateProducts(
  response: GroundedSearchResponse,
  request: StylistShoppingRequest,
  maxResults: number,
): GroundedProductCandidate[] | null {
  const parsed = parseJson(response.text);
  const rows = parsed && Array.isArray(parsed.products)
    ? parsed.products : plainTextProductRows(response.text);
  if (!parsed && rows.length === 0) return null;
  if (!Array.isArray(rows)) return null;

  const citationByUrl = new Map<string, ProductCitation>();
  for (const citation of response.citations) {
    const url = normalizedHttpsUrl(citation.url, true);
    if (url) citationByUrl.set(url, { title: citation.title, url });
  }

  const products: GroundedProductCandidate[] = [];
  const seen = new Set<string>();
  for (const value of rows) {
    const item = object(value);
    if (!item) continue;
    const productUrl = normalizedHttpsUrl(item.productUrl);
    if (!productUrl || seen.has(productUrl)) continue;
    const productCitation = citationForProductUrl(productUrl, [...citationByUrl.values()]);
    if (!productCitation) continue;

    const name = typeof item.name === "string" ? item.name.trim() : "";
    const brand = typeof item.brand === "string" ? item.brand.trim() : "";
    const retailer = typeof item.retailer === "string" ? item.retailer.trim() : "";
    const summary = typeof item.summary === "string" ? item.summary.trim() : "";
    const matchReason = typeof item.matchReason === "string" ? item.matchReason.trim() : "";
    if (!name || !brand || !retailer || !summary || !matchReason) continue;

    const reportedPrice = object(item.reportedPrice);
    let sourceReportedPrice: GroundedProductCandidate["reportedPrice"];
    if (reportedPrice && typeof reportedPrice.amount === "number" &&
        Number.isFinite(reportedPrice.amount) && reportedPrice.amount >= 0 &&
        typeof reportedPrice.currency === "string" && /^[A-Z]{3}$/.test(reportedPrice.currency)) {
      const priceSource = normalizedHttpsUrl(reportedPrice.sourceUrl);
      if (priceSource && citationForProductUrl(priceSource, [...citationByUrl.values()])) {
        sourceReportedPrice = {
          amount: reportedPrice.amount,
          currency: reportedPrice.currency,
          sourceUrl: priceSource,
          status: "search-cited-unverified",
        };
      }
    }

    const preferred = request.preferredBrands.some(value => normalized(value) === normalized(brand));
    products.push({
      id: productUrl,
      name,
      brand,
      retailer,
      productUrl,
      summary,
      matchReason,
      brandMatch: preferred ? "preferred-brand" : "alternative",
      citation: productCitation,
      ...(sourceReportedPrice ? { reportedPrice: sourceReportedPrice } : {}),
      availability: {
        status: "unverified",
        note: AVAILABILITY_NOTE,
      },
    });
    seen.add(productUrl);
    if (products.length >= maxResults) break;
  }
  return products;
}

export class GeminiGroundedShopper implements ProductResearcher {
  private readonly searchClient: GroundedSearchClient;
  private readonly models: ShopperModels;
  private readonly now: () => Date;

  constructor(
    searchClient: GroundedSearchClient,
    models: ShopperModels = { primary: "gemini-3.6-flash", fallback: "gemini-3.5-flash" },
    now: () => Date = () => new Date(),
  ) {
    this.searchClient = searchClient;
    this.models = models;
    this.now = now;
  }

  async search(request: StylistShoppingRequest): Promise<GroundedShopperResult> {
    validateRequest(request);
    const maxResults = request.maxResults ?? 3;
    const prompt = buildPrompt(request, maxResults);

    for (const model of new Set([this.models.primary, this.models.fallback])) {
      try {
        const response = await this.searchClient({ model, prompt });
        const products = candidateProducts(response, request, maxResults);
        if (!products) continue;
        return {
          source: "gemini-google-search",
          retrievedAt: this.now().toISOString(),
          products,
          disclaimer: DISCLAIMER,
        };
      } catch {
        // Try the fallback model without logging request content or provider details.
      }
    }
    throw new Error("Gemini grounded product search failed.");
  }
}

export function createGoogleSearchGroundedShopper(
  client: Pick<GoogleGenAI, "models">,
  models: ShopperModels = {
    primary: process.env.GEMINI_TEXT_MODEL?.trim() || "gemini-3.6-flash",
    fallback: process.env.GEMINI_FALLBACK_MODEL?.trim() || "gemini-3.5-flash",
  },
): GeminiGroundedShopper {
  return new GeminiGroundedShopper(async ({ model, prompt }) => {
    const response = await client.models.generateContent({
      model,
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        maxOutputTokens: 4096,
        httpOptions: { timeout: 30000, retryOptions: { attempts: 1 } },
      },
    });

    const citations: ProductCitation[] = [];
    for (const chunk of response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) {
      if (chunk.web?.uri) citations.push({ title: chunk.web.title, url: chunk.web.uri });
    }
    return { text: response.text ?? "", citations };
  }, models);
}

export function createGeminiGroundedShopperFromEnvironment(): GeminiGroundedShopper {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("Set GEMINI_API_KEY in .env or the server environment.");
  return createGoogleSearchGroundedShopper(new GoogleGenAI({ apiKey }));
}
