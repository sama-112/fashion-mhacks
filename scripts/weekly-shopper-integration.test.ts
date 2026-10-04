import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyProfile, type StoredProfile, type StylistStore } from "../src/db/stylist-store.ts";
import { createGoogleSearchGroundedShopper } from "../src/shopper/index.ts";
import { createStylistConversation } from "../src/services/stylist-conversation.ts";

test("scheduled weekly picks, weekly previews and direct requests share the grounded Shopper and return retailer links", async () => {
  let profile = emptyProfile();
  profile.data.weekly = { enabled: true, nextDueAt: "2026-10-11T12:00:00.000Z" };
  profile.data.shopping.budgets.shirts = { max: 40, currency: "USD", evidence: "shirts under $40" };
  const store: StylistStore = {
    load: async () => structuredClone(profile),
    commit: async (_identity, _event, next: StoredProfile, text) => { profile = structuredClone(next); return text; },
    saveVideo: async () => { throw new Error("No video expected"); },
  };
  const planningInputs: Array<{ message: string }> = [];
  const searchPrompts: string[] = [];
  // Synthetic provider responses exercise the real Google Search adapter and parsing.
  const searchClient = { models: { generateContent: async (params: { contents: string; config?: { tools?: unknown[] } }) => {
    assert.deepEqual(params.config?.tools, [{ googleSearch: {} }]);
    searchPrompts.push(params.contents);
    const number = searchPrompts.length;
    const url = `https://retailer.example/products/shirt-${number}`;
    return {
      text: `PRODUCT: [Test shirt ${number}](${url})\nBRAND: Test brand\nRETAILER: Test retailer\nSUMMARY: A cotton shirt.\nMATCH: Matches the shirt budget.\nPRICE: $30 USD`,
      candidates: [{ groundingMetadata: { groundingChunks: [{ web: { title: "Test product page", uri: url } }] } }],
    };
  } } } as unknown as Parameters<typeof createGoogleSearchGroundedShopper>[0];
  const shopper = createGoogleSearchGroundedShopper(searchClient, { primary: "primary", fallback: "fallback" });
  const handler = createStylistConversation({
    store, models: { text: "test", fallback: "test" },
    client: { models: { generateContent: async params => {
      planningInputs.push(JSON.parse(params.contents as string));
      return { text: JSON.stringify({
        intro: "Here are shirts to explore.", outfits: [], questions: [],
        shoppingCriteria: { category: "tops", keywords: ["shirt"] },
      }) };
    } } },
    // Same request shape and grounded implementation used by src/main.ts.
    catalog: { search: criteria => shopper.search({ ...criteria, market: "US", preferredBrands: [], referenceBrands: [], maxResults: 3 }) },
    analyzer: { analyze: async () => [] }, downloadVideo: async () => new Blob(),
  });
  const identity = { userId: "test-user", conversationId: "test-chat", messageId: "test-message" };
  for (const [index, message] of [
    { ...identity, text: "Weekly clothing suggestions", deliveryKind: "weekly" as const },
    { ...identity, text: "weekly picks now" },
    { ...identity, text: "Find me a shirt under $40" },
  ].entries()) {
    const reply = await handler(message, { eventId: `event-${index}` });
    assert.match(reply.text, new RegExp(`https://retailer\\.example/products/shirt-${index + 1}`));
    assert.match(reply.text, /Reported price \(verify with retailer\): 30\.00 USD/);
    assert.match(reply.text, /Search-cited product details are not independently verified/);
    assert.doesNotMatch(reply.text, /MOCK DATA/);
    assert.equal(profile.data.shopping.recommendations[0]?.url, `https://retailer.example/products/shirt-${index + 1}`);
    assert.equal(profile.data.weekly.nextDueAt, "2026-10-11T12:00:00.000Z");
  }
  assert.equal(searchPrompts.length, 3);
  for (const prompt of searchPrompts) assert.match(prompt, /"budget":\{"currency":"USD","max":40\}/);
  assert.match(planningInputs[0]!.message, /Supply Shopper criteria/);
  assert.match(planningInputs[1]!.message, /Supply Shopper criteria/);
  assert.equal(planningInputs[2]!.message, "Find me a shirt under $40");
});
