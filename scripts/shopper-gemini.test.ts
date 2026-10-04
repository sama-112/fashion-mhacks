import assert from "node:assert/strict";
import { test } from "node:test";
import { GeminiGroundedShopper, type GroundedSearchClient, type GroundedSearchResponse } from "../src/shopper/gemini-research.ts";
import type { StylistShoppingRequest } from "../src/shopper/types.ts";

const request: StylistShoppingRequest = {
  market: "US",
  category: "tops",
  keywords: ["linen", "relaxed"],
  sizes: ["M", "L"],
  colors: ["white", "sand"],
  budget: { max: 100, currency: "USD" },
  preferredBrands: ["Everlane"],
  referenceBrands: [{ name: "Patagonia", confidence: "medium" }],
  maxResults: 2,
};

const citedUrl = "https://www.everlane.com/products/linen-shirt";
const productText = JSON.stringify({
  products: [{
    name: "The Linen Shirt",
    brand: "Everlane",
    retailer: "Everlane",
    productUrl: citedUrl,
    summary: "Relaxed linen shirt in white and sand tones.",
    matchReason: "Matches the preferred brand, requested category, and relaxed linen style.",
    reportedPrice: { amount: 88, currency: "USD", sourceUrl: citedUrl },
  }],
});

function groundedResponse(text = productText): GroundedSearchResponse {
  return {
    text,
    citations: [{ title: "The Linen Shirt", url: citedUrl }],
  };
}

test("Gemini product results must have matching HTTPS citations and explicit uncertainty labels", async () => {
  const client: GroundedSearchClient = async () => groundedResponse(JSON.stringify({
    products: [
      ...JSON.parse(productText).products,
      {
        name: "Uncited Shirt", brand: "Other Brand", retailer: "Other Store",
        productUrl: "https://other.example/product", summary: "Not supported by a source.",
        matchReason: "The model supplied an uncited URL.",
      },
      {
        name: "Insecure Shirt", brand: "Other Brand", retailer: "Other Store",
        productUrl: "http://unsafe.example/product", summary: "Not secure.",
        matchReason: "HTTP product links are rejected.",
      },
    ],
  }));
  const shopper = new GeminiGroundedShopper(client, { primary: "gemini-3.6-flash", fallback: "gemini-3.5-flash" },
    () => new Date("2026-10-03T12:00:00.000Z"));

  const result = await shopper.search(request);

  assert.equal(result.source, "gemini-google-search");
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0]!.brandMatch, "preferred-brand");
  assert.equal(result.products[0]!.citation.url, citedUrl);
  assert.equal(result.products[0]!.reportedPrice?.status, "search-cited-unverified");
  assert.equal(result.products[0]!.availability.status, "unverified");
  assert.equal(result.retrievedAt, "2026-10-03T12:00:00.000Z");
});

test("Gemini search distinguishes user-preferred brands from video reference brands", async () => {
  let prompt = "";
  const client: GroundedSearchClient = async query => {
    prompt = query.prompt;
    return groundedResponse();
  };
  await new GeminiGroundedShopper(client).search(request);

  assert.match(prompt, /explicitlyPreferredBrands/);
  assert.match(prompt, /videoReferenceBrands/);
  assert.match(prompt, /visual inspiration only/);
  assert.match(prompt, /United States/);
});

test("Google grounding redirect citations can support direct retailer product links by cited domain", async () => {
  const client: GroundedSearchClient = async () => ({
    text: [
      "PRODUCT: [European Linen Shirt](https://www.quince.com/women/linen-shirt)",
      "BRAND: Quince",
      "RETAILER: Quince",
      "SUMMARY: Relaxed linen shirt.",
      "MATCH: A similar neutral linen style.",
    ].join("\n"),
    citations: [{
      title: "quince.com",
      url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/example-token",
    }],
  });

  const result = await new GeminiGroundedShopper(client).search(request);

  assert.equal(result.products.length, 1);
  assert.equal(result.products[0]!.productUrl, "https://www.quince.com/women/linen-shirt");
  assert.match(result.products[0]!.citation.url, /grounding-api-redirect/);
  assert.equal(result.products[0]!.brandMatch, "alternative");
});

test("Gemini 3.5 is used if the primary grounded search fails", async () => {
  const models: string[] = [];
  const client: GroundedSearchClient = async query => {
    models.push(query.model);
    if (query.model === "gemini-3.6-flash") throw new Error("Synthetic primary failure.");
    return groundedResponse();
  };
  const shopper = new GeminiGroundedShopper(client, {
    primary: "gemini-3.6-flash",
    fallback: "gemini-3.5-flash",
  });

  const result = await shopper.search(request);

  assert.deepEqual(models, ["gemini-3.6-flash", "gemini-3.5-flash"]);
  assert.equal(result.products[0]!.brand, "Everlane");
});

test("unsupported markets and invalid result limits are rejected before searching", async () => {
  let called = false;
  const client: GroundedSearchClient = async () => {
    called = true;
    return groundedResponse();
  };
  const shopper = new GeminiGroundedShopper(client);

  await assert.rejects(shopper.search({ ...request, market: "CA" as "US" }), /US market only/);
  await assert.rejects(shopper.search({ ...request, maxResults: 6 }), /maxResults must be an integer/);
  assert.equal(called, false);
});
