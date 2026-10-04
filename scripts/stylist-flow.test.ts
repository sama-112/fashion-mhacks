import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyProfile, type StoredProfile, type StylistStore } from "../src/db/stylist-store.ts";
import { createStylistConversation } from "../src/services/stylist-conversation.ts";
import { MockProductCatalog } from "../src/shopper/index.ts";
import type { WardrobeCandidate } from "../src/wardrobe/types.ts";

const garment: WardrobeCandidate = { id: "shirt-1", description: "Blue shirt", category: "tops", colors: ["blue"], uncertain: false };
class MemoryStore implements StylistStore {
  profiles = new Map<string, StoredProfile>();
  replies = new Map<string, string>();
  uploads = 0;
  async load(identity: { userId: string; conversationId: string }) { return structuredClone(this.profiles.get(`${identity.userId}:${identity.conversationId}`) ?? emptyProfile()); }
  async commit(identity: { userId: string; conversationId: string }, event: string, profile: StoredProfile, text: string) {
    if (this.replies.has(event)) return this.replies.get(event)!;
    this.profiles.set(`${identity.userId}:${identity.conversationId}`, structuredClone({ ...profile, version: profile.version + 1 }));
    this.replies.set(event, text);
    return text;
  }
  async saveVideo() { this.uploads++; return "private/video.mp4"; }
}
const user = { userId: "user-1", conversationId: "chat-1", messageId: "message-1" };
const modelPlan = { intro: "Style your shirt with trousers.", outfits: [], questions: [], shoppingCriteria: null };

test("video -> review -> correction -> explicit save persists only confirmed clothes and supplies them to styling", async () => {
  const store = new MemoryStore();
  let suppliedWardrobe: unknown;
  const handler = createStylistConversation({
    store, models: { text: "test", fallback: "test" }, catalog: new MockProductCatalog(),
    client: { models: { generateContent: async params => { suppliedWardrobe = JSON.parse(params.contents as string).wardrobe; return { text: JSON.stringify(modelPlan) }; } } },
    analyzer: { analyze: async () => [garment] }, downloadVideo: async () => new Blob(["video"], { type: "video/mp4" }),
  });
  const scan = await handler({ ...user, text: "", videos: [{ mediaId: "media-1", mimeType: "video/mp4" }] }, { eventId: "event-1" });
  assert.match(scan.text, /Wardrobe draft/);
  assert.deepEqual((await store.load(user)).data.wardrobe, []);
  await handler({ ...user, text: "change 1: navy shirt" }, { eventId: "event-2" });
  assert.deepEqual((await store.load(user)).data.wardrobe, []);
  const saved = await handler({ ...user, text: "save wardrobe" }, { eventId: "event-3" });
  assert.match(saved.text, /Saved your reviewed wardrobe/);
  assert.equal((await store.load(user)).data.wardrobe[0]!.description, "navy shirt");
  assert.equal((await store.load(user)).data.draft, null);
  await handler({ ...user, text: "Style my shirt" }, { eventId: "event-4" });
  assert.deepEqual(suppliedWardrobe, (await store.load(user)).data.wardrobe);
  assert.deepEqual((await store.load({ ...user, userId: "another-user" })).data.wardrobe, []);
});

test("wardrobe cancellation and ordinary confirmation words cannot silently save a draft", async () => {
  const store = new MemoryStore();
  const handler = createStylistConversation({
    store, models: { text: "test", fallback: "test" }, catalog: new MockProductCatalog(),
    client: { models: { generateContent: async () => { assert.fail("Review should not need an AI call."); } } },
    analyzer: { analyze: async () => [garment] }, downloadVideo: async () => new Blob(["video"], { type: "video/mp4" }),
  });
  await handler({ ...user, text: "", videos: [{ mediaId: "media-1", mimeType: "video/mp4" }] }, { eventId: "scan" });
  await handler({ ...user, text: "yes" }, { eventId: "yes" });
  assert.equal((await store.load(user)).data.wardrobe.length, 0);
  await handler({ ...user, text: "cancel" }, { eventId: "cancel" });
  assert.equal((await store.load(user)).data.draft, null);
  assert.equal((await store.load(user)).data.wardrobe.length, 0);
});

test("saved pathway choices survive a new handler and inform subsequent outfit advice", async () => {
  const store = new MemoryStore();
  const make = (response: unknown) => createStylistConversation({
    store, models: { text: "test", fallback: "test" }, catalog: new MockProductCatalog(),
    client: { models: { generateContent: async () => ({ text: JSON.stringify(response) }) } },
    analyzer: { analyze: async () => [] }, downloadVideo: async () => new Blob(),
  });
  const path = (title: string) => ({ title, description: "A clear style direction.", palette: ["blue"], staples: ["shirt"], ownedItemIds: [] });
  await make({ action: "generate", targetId: null, reason: null, pathways: [path("Relaxed"), path("Tailored")] })({ ...user, text: "Show style pathways" }, { eventId: "paths" });
  const selected = (await store.load(user)).data.pathways.pathways[0]!;
  await make({ action: "like", targetId: selected.id, reason: null, pathways: [] })({ ...user, text: "I like option 1" }, { eventId: "like" });
  assert.equal((await store.load(user)).data.pathways.pathways[0]!.status, "liked");
});
