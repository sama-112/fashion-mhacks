import assert from "node:assert/strict";
import { test } from "node:test";
import { MockProductCatalog } from "../src/shopper/index.ts";

const catalog = new MockProductCatalog();

test("search combines category, keyword, size, color, occasion, and budget criteria", async () => {
  const result = await catalog.search({
    category: "tops",
    keywords: ["linen", "warm"],
    sizes: ["M"],
    colors: ["sand"],
    occasion: "travel",
    budget: { max: 50, currency: "USD" },
  });

  assert.deepEqual(result.products.map(product => product.id), ["mock-top-001"]);
});

test("results explicitly identify mock products, prices, and availability", async () => {
  const result = await catalog.search({ category: "footwear" });

  assert.equal(result.source, "mock-catalog");
  assert.equal(result.disclaimer, "MOCK DATA ONLY — prices and availability are illustrative, not real.");
  assert.ok(result.products.length > 0);
  for (const product of result.products) {
    assert.equal(product.source, "mock");
    assert.equal(product.price.isMock, true);
    assert.equal(product.availability.status, "mock-only");
    assert.equal(product.availability.note, "No live inventory is connected.");
    assert.match(product.name, /^MOCK:/);
  }
});

test("case-insensitive criteria match and unmatched criteria return no products", async () => {
  const matched = await catalog.search({ colors: ["SAND"], sizes: ["m"] });
  const unmatched = await catalog.search({ category: "dresses", occasion: "skiing" });

  assert.deepEqual(matched.products.map(product => product.id), ["mock-top-001"]);
  assert.deepEqual(unmatched.products, []);
});

test("multiple sizes and colors are alternatives; every keyword must match", async () => {
  const alternatives = await catalog.search({
    sizes: ["XS", "XXL"],
    colors: ["sand", "forest"],
  });
  const allKeywordsMatch = await catalog.search({ keywords: ["linen", "warm"] });
  const oneKeywordMisses = await catalog.search({ keywords: ["linen", "denim"] });

  assert.deepEqual(
    alternatives.products.map(product => product.id),
    ["mock-top-001", "mock-outerwear-001"],
  );
  assert.deepEqual(allKeywordsMatch.products.map(product => product.id), ["mock-top-001"]);
  assert.deepEqual(oneKeywordMisses.products, []);
});

test("invalid budget ranges are rejected", async () => {
  await assert.rejects(
    catalog.search({ budget: { min: 90, max: 40, currency: "USD" } }),
    /Budget minimum must not exceed budget maximum\./,
  );
});
