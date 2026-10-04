import assert from "node:assert/strict";
import { test } from "node:test";
import { createInbox } from "../src/db/inbox.ts";
import { emptyProfile, type PreparedImageTurn, type StoredProfile, type StylistIdentity, type StylistStore } from "../src/db/stylist-store.ts";
import { handleProfileReset } from "../src/preferences/reset.ts";
import { createStylistConversation } from "../src/services/stylist-conversation.ts";
import type { ConversationReply } from "../src/services/conversation.ts";
import type { WardrobeCandidate } from "../src/wardrobe/types.ts";

const who = { userId: "synthetic-user", conversationId: "synthetic-chat", messageId: "synthetic-message" };
const cutoff = "2026-10-04T12:00:00.000Z";
const oldShirt: WardrobeCandidate = { id: "old-shirt", description: "Old navy shirt", category: "tops", colors: ["navy"], uncertain: false };
const newJeans: WardrobeCandidate = { id: "new-jeans", description: "New black jeans", category: "bottoms", colors: ["black"], uncertain: false };

function populated(): StoredProfile {
  const profile = emptyProfile();
  profile.version = 7;
  Object.assign(profile.data, {
    wardrobe: [oldShirt], draft: { items: [oldShirt], mediaPath: "synthetic/private/video.mp4", mode: "append" },
    referencePhoto: { storagePath: "synthetic/private/reference.png", mimeType: "image/png" },
    pendingPhoto: { messageId: "old-photo-message", photo: { mediaId: "old-photo", mimeType: "image/png" } },
    lastOutfits: [{ name: "Old outfit", rationale: "Saved outfit", pieces: [{ description: oldShirt.description, wardrobeItemId: oldShirt.id }] }],
    weekly: { enabled: true, nextDueAt: "2026-10-11T12:00:00Z" },
  });
  profile.data.pathways = {
    pathways: [{ id: "old-path", title: "Old direction", description: "Old choice", palette: ["navy"], staples: ["blazer"], ownedItemIds: [oldShirt.id], status: "liked" }],
    preferences: [{ pathwayId: "old-path", pathwayTitle: "Old direction", reason: "too formal", evidence: "too formal" }],
    pendingRejectionId: "old-path", offeredIds: ["old-path"],
  };
  const item = { id: "old-product", name: "Old polo", category: "tops" as const, spendingCategory: "shirts" as const };
  profile.data.shopping = {
    recommendations: [item], feedback: [{ item, reason: "price", evidence: "too expensive", recordedAt: "2026-10-03T12:00:00Z" }],
    budgets: { shirts: { max: 30, currency: "USD", evidence: "shirts under $30" } },
    pendingRejection: item, pendingBudget: "shirts", recentlySuggestedIds: [item.id],
  };
  return profile;
}

class Memory implements StylistStore {
  profiles = new Map<string, StoredProfile>();
  replies = new Map<string, ConversationReply>();
  prepared = new Map<string, PreparedImageTurn>();
  uploads = 0;
  key(identity: StylistIdentity) { return JSON.stringify([identity.userId, identity.conversationId]); }
  async load(identity: StylistIdentity) { return structuredClone(this.profiles.get(this.key(identity)) ?? emptyProfile()); }
  async commit(identity: StylistIdentity, event: string, profile: StoredProfile, text: string) {
    return (await this.commitResponse(identity, event, profile, { text })).text;
  }
  async commitResponse(identity: StylistIdentity, event: string, profile: StoredProfile, reply: ConversationReply) {
    const key = `${this.key(identity)}:${event}`;
    if (this.replies.has(key)) return structuredClone(this.replies.get(key)!);
    assert.equal(profile.version, (await this.load(identity)).version);
    this.profiles.set(this.key(identity), structuredClone({ ...profile, version: profile.version + 1 }));
    this.replies.set(key, structuredClone(reply));
    return reply;
  }
  async loadImageTurn(_identity: StylistIdentity, event: string) { return structuredClone(this.prepared.get(event) ?? null); }
  async saveVideo() { this.uploads++; return "synthetic/private/new-video.mp4"; }
}

function handler(store: Memory, overrides: Partial<Parameters<typeof createStylistConversation>[0]> = {}) {
  return createStylistConversation({
    store, models: { text: "synthetic", fallback: "synthetic" }, now: () => new Date(cutoff),
    client: { models: { generateContent: async () => { assert.fail("Reset invoked Gemini planning"); } } },
    catalog: { search: async () => { assert.fail("Reset invoked Shopper"); } },
    analyzer: { analyze: async () => { assert.fail("Reset analyzed old media"); } },
    downloadVideo: async () => { assert.fail("Reset downloaded old media"); },
    loadCallPhoto: async () => { assert.fail("Reset required a camera frame"); },
    images: { generate: async () => { assert.fail("Reset regenerated an old image"); } },
    history: async () => { assert.fail("Reset read old history"); },
    ...overrides,
  });
}

test("profile reset explains the impact and requires the exact confirmation; cancel preserves all data", () => {
  const profile = populated(), original = structuredClone(profile);
  assert.match(handleProfileReset("please reset my profile!", profile, cutoff)!, /confirm reset profile.*pause weekly/);
  assert.deepEqual(profile.data, { ...original.data, pendingReset: true });
  for (const generic of ["yes", "okay", "confirm"]) {
    assert.match(handleProfileReset(generic, profile, cutoff)!, /confirm reset profile/);
    assert.deepEqual(profile.data.wardrobe, [oldShirt]);
  }
  assert.match(handleProfileReset("cancel reset", profile, cutoff)!, /canceled/);
  assert.deepEqual(profile, original);
  assert.match(handleProfileReset("confirm reset profile", profile, cutoff)!, /Send "reset profile" first/);
  for (const unrelated of ['He said "reset profile"', "I might reset profile", "save wardrobe"]) {
    assert.equal(handleProfileReset(unrelated, profile, cutoff), null);
  }
});

test("confirmed reset atomically clears the complete profile and only the authenticated chat", async () => {
  const store = new Memory(), original = populated();
  const otherChat = { ...who, conversationId: "other-chat" }, otherUser = { ...who, userId: "other-user" };
  for (const identity of [who, otherChat, otherUser]) store.profiles.set(store.key(identity), structuredClone(original));
  const run = handler(store);
  await run({ ...who, text: "reset profile" }, { eventId: "request", receivedAt: "2026-10-04T11:59:00Z" });
  const reset = await run({ ...who, text: "confirm reset profile" }, { eventId: "confirm", receivedAt: cutoff });
  assert.match(reset.text, /profile is fresh.*Weekly suggestions are off/);
  assert.deepEqual(await store.load(who), { version: 9, data: { ...emptyProfile().data, historyAfter: cutoff } });
  assert.deepEqual(await store.load(otherChat), original);
  assert.deepEqual(await store.load(otherUser), original);
  assert.equal(store.uploads, 0);
  assert.equal((await run({ ...who, text: "show wardrobe" }, { eventId: "empty" })).text.startsWith("Your wardrobe is empty."), true);
  assert.deepEqual(await run({ ...who, text: "weekly picks now", deliveryKind: "weekly" }, { eventId: "weekly" }), { text: "", skipDelivery: true });
});

test("spoken reset commands work without camera evidence; voice-note confirmation uses its transcript", async () => {
  const store = new Memory(); store.profiles.set(store.key(who), populated());
  let downloads = 0, transcripts = 0;
  const run = handler(store, {
    downloadAudio: async () => { downloads++; return new Blob(["synthetic audio"], { type: "audio/wav" }); },
    purchases: {
      transcribe: async () => { transcripts++; return "Please confirm reset my profile."; },
      fromText: async () => { assert.fail("Reset inferred a purchase"); },
      fromPhoto: async () => { assert.fail("Reset inferred clothing ownership"); },
    },
  });
  await run({ ...who, text: "Please reset my profile.", deliveryKind: "voice", callPhoto: { callId: "verified-call", storagePath: null } }, { eventId: "spoken-request" });
  await run({ ...who, text: "", audio: [{ mediaId: "synthetic-note", mimeType: "audio/wav" }] }, { eventId: "spoken-confirm", receivedAt: cutoff });
  assert.equal(downloads, 1); assert.equal(transcripts, 1);
  assert.deepEqual((await store.load(who)).data, { ...emptyProfile().data, historyAfter: cutoff });
});

test("post-reset planning loads only the new memory epoch and supplies no previous clothes or preferences", async () => {
  const store = new Memory(); store.profiles.set(store.key(who), populated());
  const runReset = handler(store);
  await runReset({ ...who, text: "reset profile" }, { eventId: "request" });
  await runReset({ ...who, text: "confirm reset profile" }, { eventId: "confirm", receivedAt: cutoff });
  const before = "2026-10-04T12:01:00Z";
  let histories = 0, plans = 0;
  const run = handler(store, {
    history: async (identity, receivedAt, after) => { histories++; assert.equal(identity.userId, who.userId); assert.equal(receivedAt, before); assert.equal(after, cutoff); return []; },
    client: { models: { generateContent: async params => {
      plans++; const input = JSON.parse(params.contents as string);
      assert.deepEqual(input.history, []); assert.deepEqual(input.wardrobe, []);
      assert.deepEqual(input.stylePreferences, emptyProfile().data.pathways);
      assert.deepEqual(input.shoppingPreferences, emptyProfile().data.shopping);
      return { text: JSON.stringify({ intro: "Send a new closet video to begin.", outfits: [], questions: [], shoppingCriteria: null, shoppingPairing: null }) };
    } } },
  });
  await run({ ...who, text: "What should I wear for dinner?" }, { eventId: "new-advice", receivedAt: before });
  assert.equal(histories, 1); assert.equal(plans, 1);
});

test("delayed pre-reset media and frozen image plans cannot revive previous state", async () => {
  const store = new Memory(), old = populated();
  store.profiles.set(store.key(who), { ...emptyProfile(), data: { ...emptyProfile().data, historyAfter: cutoff } });
  store.prepared.set("old-image", { profile: old, baseProfile: old, text: "Old image", outfits: old.data.lastOutfits });
  const run = handler(store), before = await store.load(who);
  assert.deepEqual(await run({ ...who, text: "", videos: [{ mediaId: "old-video", mimeType: "video/mp4" }] }, { eventId: "late-video", receivedAt: "2026-10-04T11:58:00Z" }), { text: "", skipDelivery: true });
  assert.deepEqual(await run({ ...who, text: "show style tracks" }, { eventId: "old-image", receivedAt: "2026-10-04T12:00:01Z" }), { text: "", skipDelivery: true });
  assert.deepEqual(await store.load(who), before); assert.equal(store.replies.size, 0);
});

test("reset confirmation replay preserves newly reviewed clothes and does not reset twice", async () => {
  const store = new Memory(); store.profiles.set(store.key(who), populated());
  const run = handler(store);
  await run({ ...who, text: "reset profile" }, { eventId: "request" });
  const confirmed = await run({ ...who, text: "confirm reset profile" }, { eventId: "confirm", receivedAt: cutoff });
  const current = await store.load(who); current.data.draft = { items: [newJeans], mediaPath: null, mode: "append" };
  store.profiles.set(store.key(who), current);
  await run({ ...who, text: "save wardrobe" }, { eventId: "new-save", receivedAt: "2026-10-04T12:01:00Z" });
  const saved = await store.load(who);
  assert.deepEqual(saved.data.wardrobe, [newJeans]);
  assert.deepEqual(await run({ ...who, text: "confirm reset profile" }, { eventId: "confirm", receivedAt: cutoff }), confirmed);
  assert.deepEqual(await store.load(who), saved);
});

test("inbox applies reset cutoff alongside earlier/completed/user/chat restrictions", async t => {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let query: URL | undefined;
  globalThis.fetch = async input => { query = new URL(input.toString()); return new Response("[]", { headers: { "Content-Type": "application/json" } }); };
  const inbox = createInbox("https://synthetic.supabase.test", "synthetic-key"), before = "2026-10-04T12:01:00Z";
  assert.deepEqual(await inbox.recentConversation({ ...who, text: "New request" }, before, cutoff), []);
  assert.deepEqual(query!.searchParams.getAll("received_at"), [`lt.${before}`, `gt.${cutoff}`]);
  assert.equal(query!.searchParams.get("message->>userId"), `eq.${who.userId}`);
  assert.equal(query!.searchParams.get("message->>conversationId"), `eq.${who.conversationId}`);
  assert.equal(query!.searchParams.get("completed_at"), "not.is.null");
  assert.equal(query!.searchParams.get("reply_text"), "not.is.null");
});
