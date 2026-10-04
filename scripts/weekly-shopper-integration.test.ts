import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyProfile, type StoredProfile, type StylistStore } from "../src/db/stylist-store.ts";
import { createStylistProductResearcher } from "../src/agents/stylist/product-search.ts";
import { createStylistConversation } from "../src/services/stylist-conversation.ts";

test("weekly picks, previews, on-demand recommendations and direct requests share the grounded Shopper and return retailer links", async () => {
  let profile = emptyProfile();
  profile.data.weekly = { enabled: true, nextDueAt: "2026-10-11T12:00:00.000Z" };
  profile.data.shopping.budgets.shirts = { max: 40, currency: "USD", evidence: "shirts under $40" };
  profile.data.wardrobe=[{id:"pants",description:"Black jeans",category:"bottoms",colors:["black"],uncertain:false}];
  profile.data.pathways={...profile.data.pathways,pathways:[{id:"relaxed",title:"Relaxed",description:"Easy outfits",palette:["black"],staples:["shirt"],ownedItemIds:["pants"],status:"liked"}]};
  const store: StylistStore = {
    load: async () => structuredClone(profile),
    commit: async (_identity, _event, next: StoredProfile, text) => { profile = structuredClone(next); return text; },
    saveVideo: async () => { throw new Error("No video expected"); },
  };
  const planningInputs: Array<{ message: string; productRecommendation?: { limit: number } }> = [];
  const searchPrompts: string[] = [];
  // Synthetic provider responses exercise the real Google Search adapter and parsing.
  const searchClient = { models: { generateContent: async (params: { contents: string; config?: { tools?: unknown[] } }) => {
    assert.deepEqual(params.config?.tools, [{ googleSearch: {} }]);
    searchPrompts.push(params.contents);
    const number = searchPrompts.length;
    const url = `https://retailer.example/products/shirt-${number}`;
    return {
      text: [url,`${url}-alternative`,`${url}-other`].map((link,i)=>`PRODUCT: [Test shirt ${number}-${i}](${link})\nBRAND: Test brand\nRETAILER: Test retailer\nSUMMARY: A cotton shirt.\nMATCH: Matches the shirt budget.\nPRICE: $30 USD`).join("\n\n"),
      candidates: [{ groundingMetadata: { groundingChunks: [url,`${url}-alternative`,`${url}-other`].map(uri=>({ web: { title: "Test product page", uri } })) } }],
    };
  } } } as unknown as Parameters<typeof createStylistProductResearcher>[0];
  const shopper = createStylistProductResearcher(searchClient, { primary: "primary", fallback: "fallback" },()=>{});
  const handler = createStylistConversation({
    store, models: { text: "test", fallback: "test" },
    client: { models: { generateContent: async params => {
      planningInputs.push(JSON.parse(params.contents as string));
      return { text: JSON.stringify({
        intro: "Here are shirts to explore.", outfits: [], questions: [],
        shoppingCriteria: { category: "tops", keywords: ["shirt"] },
        shoppingPairing: {wardrobeItemId:"pants",pathwayId:"relaxed",rationale:"A relaxed shirt works with these jeans."},
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
    { ...identity, text: "Can you recommend a clothing item for my track?" },
    { ...identity, text: "Recommend some clothing items for my style", deliveryKind: "voice" as const },
  ].entries()) {
    const reply = await handler(message, { eventId: `event-${index}` });
    assert.match(reply.text, new RegExp(`https://retailer\\.example/products/shirt-${index + 1}`));
    assert.match(reply.text, /Reported price \(verify with retailer\): 30\.00 USD/);
    assert.match(reply.text, /Search-cited product details are not independently verified/);
    assert.doesNotMatch(reply.text, /MOCK DATA/);
    assert.match(reply.text,/Pair with your saved wardrobe: Black jeans/);
    assert.equal(profile.data.shopping.recommendations[0]?.url, `https://retailer.example/products/shirt-${index + 1}`);
    assert.equal(profile.data.shopping.recommendations.length,index===3?1:3);
    assert.equal((reply.text.match(/Item \d:/g)??[]).length,index===3?1:3);
    assert.equal(profile.data.weekly.nextDueAt, "2026-10-11T12:00:00.000Z");
  }
  assert.equal(searchPrompts.length, 5);
  for (const prompt of searchPrompts) assert.match(prompt, /"budget":\{"currency":"USD","max":40\}/);
  assert.match(planningInputs[0]!.message, /Supply Shopper criteria/);
  assert.match(planningInputs[1]!.message, /Supply Shopper criteria/);
  assert.equal(planningInputs[2]!.message, "Find me a shirt under $40");
  assert.deepEqual(planningInputs.map(p=>p.productRecommendation?.limit),[3,3,undefined,1,3]);
  assert.equal(planningInputs[3]!.message,"Can you recommend a clothing item for my track?");
});
