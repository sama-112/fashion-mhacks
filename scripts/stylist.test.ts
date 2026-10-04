import assert from "node:assert/strict";
import { test } from "node:test";
import { StylistAgent } from "../src/agents/stylist/agent.ts";
import { GeminiStylistModel } from "../src/agents/stylist/gemini.ts";
import { parseStylistPlan } from "../src/agents/stylist/plan.ts";
import { createInbox } from "../src/db/inbox.ts";
import { createConversationHandler } from "../src/services/conversation.ts";
import { MockProductCatalog, type GroundedShopperResult, type ShopperCriteria } from "../src/shopper/index.ts";

const models = { text: "test-primary", fallback: "test-fallback" };
function plan(shoppingCriteria: ShopperCriteria | null = null) {
  return {
    intro: "Try a linen shirt with neutral trousers.",
    outfits: [{ name: "Daytime outfit", rationale: "Light fabric keeps it comfortable.", pieces: [{ description: "A linen shirt", wardrobeItemId: null }] }],
    questions: [], shoppingCriteria,
  };
}

test("Stylist passes the partner's exact criteria and presents only returned mock products", async () => {
  const criteria: ShopperCriteria = {
    category: "tops", keywords: ["linen"], sizes: ["M"], colors: ["sand"],
    occasion: "travel", budget: { max: 50, currency: "USD" },
  };
  const searches: ShopperCriteria[] = [];
  const catalog = new MockProductCatalog();
  const stylist = new StylistAgent({ plan: async () => plan(criteria) }, {
    search: async request => { searches.push(request); return catalog.search(request); },
  });
  const reply = await stylist.respond({ text: "Find a sand linen travel shirt in M under 50 USD." });
  assert.deepEqual(searches, [criteria]);
  assert.deepEqual(reply.shopping?.products.map(item => item.id), ["mock-top-001"]);
  assert.ok(reply.text.includes(reply.shopping!.disclaimer));
  assert.match(reply.text, /MOCK: Harbor Linen Shirt/);
  assert.match(reply.text, /Illustrative price: 42\.00 USD/);
  assert.match(reply.text, /No live inventory is connected\./);
  assert.doesNotMatch(reply.text, /Cloudline|https?:\/\//);
});

test("Stylist presents the partner's cited grounded products with uncertainty labels", async () => {
  const criteria: ShopperCriteria = { category: "tops", keywords: ["linen"], budget: { max: 100, currency: "USD" } };
  const grounded = {
    source: "gemini-google-search",
    retrievedAt: "2026-10-03T12:00:00.000Z",
    products: [{
      id: "https://retailer.example/linen-shirt",
      name: "Linen Shirt",
      brand: "Example Brand",
      retailer: "Example Retailer",
      productUrl: "https://retailer.example/linen-shirt",
      summary: "A relaxed linen shirt.",
      matchReason: "Matches the requested fabric and budget.",
      brandMatch: "alternative",
      citation: { title: "Example Retailer", url: "https://retailer.example/linen-shirt" },
      reportedPrice: {
        amount: 80,
        currency: "USD",
        sourceUrl: "https://retailer.example/linen-shirt",
        status: "search-cited-unverified",
      },
      availability: { status: "unverified", note: "Confirm availability with the retailer before purchase." },
    }],
    disclaimer: "Search-cited product details are not independently verified; prices can change and inventory is unverified.",
  } satisfies GroundedShopperResult;
  const searches: ShopperCriteria[] = [];
  const stylist = new StylistAgent({ plan: async () => plan(criteria) }, {
    search: async request => { searches.push(request); return grounded; },
  });

  const reply = await stylist.respond({ text: "Find a linen shirt under 100 USD." });

  assert.deepEqual(searches, [criteria]);
  assert.equal(reply.shopping?.source, "gemini-google-search");
  assert.match(reply.text, /https:\/\/retailer\.example\/linen-shirt/);
  assert.match(reply.text, /Reported price \(verify with retailer\): 80\.00 USD/);
  assert.match(reply.text, /Confirm availability with the retailer before purchase/);
});

test("styling advice and clarifying questions do not call the Shopper", async () => {
  const stylist = new StylistAgent({ plan: async () => ({ ...plan(), questions: ["What is the occasion?"] }) }, {
    search: async () => { assert.fail("Unexpected shopping request."); },
  });
  const reply = await stylist.respond({ text: "How do I style linen?" });
  assert.equal(reply.shopping, null);
  assert.match(reply.text, /Daytime outfit/);
  assert.match(reply.text, /What is the occasion\?/);
});

test("empty Shopper results and failures are honest without exposing provider errors", async () => {
  const noMatch = new StylistAgent({ plan: async () => plan({ category: "dresses", occasion: "skiing" }) }, new MockProductCatalog());
  const empty = await noMatch.respond({ text: "Find a skiing dress." });
  assert.match(empty.text, /MOCK DATA ONLY/);
  assert.match(empty.text, /No sample products match/);
  const unavailable = new StylistAgent({ plan: async () => plan({ category: "tops" }) }, {
    search: async () => { throw new Error("private provider error"); },
  });
  const failed = await unavailable.respond({ text: "Find a shirt." });
  assert.match(failed.text, /Product search is unavailable/);
  assert.doesNotMatch(failed.text, /private provider error|Illustrative price/);
});

test("invalid budgets, unsupported categories, URLs and unknown wardrobe IDs never reach Shopper", async () => {
  for (const bad of [
    { ...plan(), shoppingCriteria: { budget: { min: 80, max: 20, currency: "USD" } } },
    { ...plan(), shoppingCriteria: { budget: { max: 20, currency: "CAD" } } },
    { ...plan(), shoppingCriteria: { category: "jewelry" } },
    { ...plan(), intro: "Buy at https://fabricated.example" },
    { ...plan(), outfits: [{ ...plan().outfits[0], pieces: [{ description: "Claimed owned shirt", wardrobeItemId: "unknown" }] }] },
  ]) {
    const stylist = new StylistAgent({ plan: async () => bad }, {
      search: async () => { assert.fail("Invalid plan reached Shopper."); },
    });
    await assert.rejects(stylist.respond({ text: "Find a shirt." }), /invalid plan/);
  }
  assert.throws(() => parseStylistPlan({ ...plan(), shoppingCriteria: { budget: { max: Infinity, currency: "USD" } } }));
});

test("known wardrobe pieces retain the supplied description", () => {
  const parsed = parseStylistPlan({ ...plan(), outfits: [{
    ...plan().outfits[0], pieces: [{ description: "Invented designer jacket", wardrobeItemId: "shirt-1" }],
  }] }, [{ id: "shirt-1", description: "My blue cotton shirt" }]);
  assert.equal(parsed.outfits[0]!.pieces[0]!.description, "My blue cotton shirt");
});

test("malformed primary output falls back using a structured schema and bounded request", async () => {
  const calls: string[] = [];
  const model = new GeminiStylistModel({ models: { generateContent: async params => {
    calls.push(params.model);
    assert.equal(params.config?.responseMimeType, "application/json");
    assert.ok(params.config?.responseJsonSchema);
    assert.equal(params.config?.httpOptions?.timeout, 20000);
    return { text: params.model === models.text ? "not JSON" : JSON.stringify(plan()) };
  } } }, models);
  const result = await model.plan({ text: "Style my shirt." });
  assert.deepEqual(calls, [models.text, models.fallback]);
  assert.deepEqual(result, plan());
});

test("total Gemini failure is sanitized and abort does not trigger a fallback", async () => {
  let calls = 0;
  const model = new GeminiStylistModel({ models: { generateContent: async () => {
    calls++;
    throw new Error("private API credential details");
  } } }, models);
  await assert.rejects(model.plan({ text: "Style a shirt." }), { message: "Stylist model request failed." });
  assert.equal(calls, 2);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(model.plan({ text: "Style a shirt." }, stop.signal), { name: "AbortError" });
  assert.equal(calls, 2);
});

test("hello keeps the exact acceptance reply without Gemini, history or Shopper calls", async () => {
  const handler = createConversationHandler({ models: { generateContent: async () => { assert.fail("Hello called Gemini."); } } }, models, {
    catalog: { search: async () => { assert.fail("Hello called Shopper."); } },
    history: async () => { assert.fail("Hello loaded history."); },
  });
  assert.deepEqual(await handler({ text: " hello " }, { receivedAt: "2026-10-04T00:00:00Z" }), { text: "Your stylist is connected." });
  await assert.rejects(handler({ text: " " }), /must not be empty/);
});

test("conversation uses prior context for a follow-up through the typed Shopper contract", async () => {
  const history = [{ role: "user" as const, text: "Find a linen shirt." }, { role: "assistant" as const, text: "What is your budget?" }];
  const message = { text: "Under 50 USD", userId: "test-user", conversationId: "test-chat" };
  const before = "2026-10-04T00:00:00Z";
  const handler = createConversationHandler({ models: { generateContent: async params => {
    assert.deepEqual(JSON.parse(params.contents as string), { message: message.text, history, wardrobe: [] });
    return { text: JSON.stringify(plan({ category: "tops", keywords: ["linen"], budget: { max: 50, currency: "USD" } })) };
  } } }, models, {
    catalog: new MockProductCatalog(),
    history: async (received, cutoff) => { assert.deepEqual(received, message); assert.equal(cutoff, before); return history; },
  });
  assert.match((await handler(message, { receivedAt: before })).text, /MOCK: Harbor Linen Shirt/);
});

test("inbox history is limited to earlier completed messages from the same user and chat", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let query: URL | undefined;
  globalThis.fetch = async input => {
    query = new URL(input.toString());
    return new Response(JSON.stringify([
      { message: { text: "Newer message" }, reply_text: "Newer reply" },
      { message: { text: "Older message" }, reply_text: "Older reply" },
    ]), { headers: { "Content-Type": "application/json" } });
  };
  const inbox = createInbox("https://synthetic.supabase.test", "synthetic-key");
  const before = "2026-10-04T00:00:00Z";
  const history = await inbox.recentConversation({ text: "Current", userId: "u-1", conversationId: "c-1" }, before);
  assert.equal(query!.searchParams.get("message->>userId"), "eq.u-1");
  assert.equal(query!.searchParams.get("message->>conversationId"), "eq.c-1");
  assert.equal(query!.searchParams.get("received_at"), `lt.${before}`);
  assert.equal(query!.searchParams.get("completed_at"), "not.is.null");
  assert.equal(query!.searchParams.get("reply_text"), "not.is.null");
  assert.equal(query!.searchParams.get("limit"), "6");
  assert.deepEqual(history.map(turn => turn.text), ["Older message", "Older reply", "Newer message", "Newer reply"]);
  assert.deepEqual(await inbox.recentConversation({ text: "No identity" }, before), []);
});
