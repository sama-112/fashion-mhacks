import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PNG } from "pngjs";
import Relay from "@relaymessenger/sdk";
import { VideoBufferType, VideoFrame, VideoRotation, type VideoFrameEvent, type RemoteVideoTrack, type RelayCallTransport } from "@relaymessenger/sdk/calls";
import { cameraPng, createCallCamera, needsCallCamera } from "../src/voice/camera.ts";
import { spokenCommand } from "../src/voice/commands.ts";
import { GeminiCallVision, CallVisionError } from "../src/voice/vision.ts";
import { createCallSnapshots } from "../src/voice/snapshots.ts";
import { createStylistConversation } from "../src/services/stylist-conversation.ts";
import { emptyProfile, type StylistStore, type StoredProfile, type StylistIdentity } from "../src/db/stylist-store.ts";
import { parseWardrobeDraft } from "../src/wardrobe/gemini.ts";
import { isWardrobeAddition } from "../src/purchases/index.ts";
import { RelayAdapter } from "../src/integrations/relay.ts";
import type { ConversationMessage, ConversationReply } from "../src/services/conversation.ts";
import type { ShopperCriteria } from "../src/shopper/types.ts";

const identity = { userId: randomUUID(), conversationId: randomUUID() };
const callId = randomUUID();
const pixels = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);
const frame: VideoFrameEvent = { frame: new VideoFrame(pixels, 2, 1, VideoBufferType.RGBA), timestampUs: 0n, rotation: VideoRotation.VIDEO_ROTATION_0 };
const image = cameraPng(frame);
const item = { description: "Blue shirt", category: "tops", colors: ["blue"], uncertain: false };

class Store implements StylistStore {
  profile = emptyProfile();
  replies = new Map<string, ConversationReply>();
  async load(who: StylistIdentity) { return who.userId === identity.userId && who.conversationId === identity.conversationId ? structuredClone(this.profile) : emptyProfile(); }
  async commit(who: StylistIdentity, id: string, profile: StoredProfile, text: string) { return (await this.commitResponse(who, id, profile, { text })).text; }
  async commitResponse(_who: StylistIdentity, id: string, profile: StoredProfile, reply: ConversationReply) {
    if (this.replies.has(id)) return this.replies.get(id)!;
    this.profile = structuredClone({ ...profile, version: profile.version + 1 }); this.replies.set(id, reply); return reply;
  }
  async saveVideo(): Promise<string> { throw new Error("No recorded video should be saved by a camera question"); }
}

function setup() {
  const store = new Store();
  let extractions = 0, descriptions = 0;
  let planned: { wardrobe: unknown[]; message: string } | undefined;
  const searches: ShopperCriteria[] = [];
  const run = createStylistConversation({ store, models: { text: "test", fallback: "test" },
    client: { models: { generateContent: async params => {
      planned = JSON.parse(params.contents as string);
      return { text: JSON.stringify({ intro: "Try a matching shirt.", outfits: [], questions: [], shoppingCriteria: { category: "tops", keywords: ["blue"], budget: { max: 40, currency: "USD" } } }) };
    } } },
    catalog: { search: async criteria => { searches.push(criteria); return { source: "gemini-google-search", retrievedAt: new Date().toISOString(), products: [], disclaimer: "Search-cited product details are not independently verified; prices can change and inventory is unverified." }; } },
    analyzer: { analyze: async () => { throw new Error("Camera must not scan a video"); } }, downloadVideo: async () => new Blob(),
    loadCallPhoto: async (who, id, path) => { assert.deepEqual(who, identity); assert.equal(id, callId); assert.equal(path, "private-call.png"); return image; },
    callVision: { describe: async () => { descriptions++; return "A visible blue cotton shirt; brand and size unclear."; } },
    purchases: { fromText: async () => { extractions++; return parseWardrobeDraft({ items: [item] }); },
      fromPhoto: async () => { extractions++; return parseWardrobeDraft({ items: [{ ...item, uncertain: true }] }); }, transcribe: async () => { throw new Error("ElevenLabs supplies the transcript"); } },
  });
  const say = (text: string, id: string = randomUUID(), visual = false, missing = false) => run({ ...identity, text, deliveryKind: "voice",
    ...(visual ? { callPhoto: { callId, storagePath: missing ? null : "private-call.png" } } : {}) }, { eventId: id });
  return { store, say, searches, get extractions() { return extractions; }, get descriptions() { return descriptions; }, get planned() { return planned; } };
}

test("camera snapshots rotate pixels correctly, downsize large frames and reject malformed dimensions", async () => {
  for (const [rotation, expected] of [[VideoRotation.VIDEO_ROTATION_90, [255, 0, 0, 255, 0, 0, 255, 255]], [VideoRotation.VIDEO_ROTATION_270, [0, 0, 255, 255, 255, 0, 0, 255]]] as const) {
    const png = PNG.sync.read(Buffer.from(await cameraPng({ ...frame, rotation }).arrayBuffer()));
    assert.equal(png.width, 1); assert.equal(png.height, 2); assert.deepEqual([...png.data], [...expected]);
  }
  const large = new VideoFrame(new Uint8Array(1440 * 720 * 4), 1440, 720, VideoBufferType.RGBA);
  const png = PNG.sync.read(Buffer.from(await cameraPng({ ...frame, frame: large }).arrayBuffer()));
  assert.equal(png.width, 720); assert.equal(png.height, 360);
  assert.throws(() => cameraPng({ ...frame, frame: { ...large, width: 1921 } as VideoFrame }));
});

test("camera decoding keeps only a recent sampled frame and clears it on camera-off and close", async () => {
  let push!: (event: VideoFrameEvent) => void, unsubscribed = false, now = 1000;
  const track = { _subscribe(consumer: { push(event: VideoFrameEvent): void }) { push = consumer.push; return () => { unsubscribed = true; }; } } as unknown as RemoteVideoTrack;
  const transport = Object.assign(new EventEmitter(), { remoteVideoTrack: track });
  const camera = createCallCamera(transport as unknown as RelayCallTransport, () => now);
  push(frame); await new Promise(resolve => setImmediate(resolve)); assert.ok(camera.snapshot());
  now += 5001; assert.equal(camera.snapshot(), null);
  push(frame); await new Promise(resolve => setImmediate(resolve)); assert.ok(camera.snapshot());
  transport.emit("remoteVideo", false); now += 1000; push(frame); await new Promise(resolve => setImmediate(resolve)); assert.equal(camera.snapshot(), null);
  transport.emit("remoteVideo", true); push(frame); await new Promise(resolve => setImmediate(resolve)); assert.ok(camera.snapshot());
  camera.close(); await new Promise(resolve => setImmediate(resolve)); assert.equal(camera.snapshot(), null); assert.equal(unsubscribed, true);
});

test("spoken corrections are explicit; saving a draft doesn't request camera or treat a generic yes as confirmation", () => {
  assert.equal(spokenCommand("Please save my wardrobe."), "save wardrobe");
  assert.equal(spokenCommand("Save these clothes."), "save wardrobe");
  assert.equal(spokenCommand("Change item two to navy shirt."), "change 2: navy shirt");
  assert.equal(spokenCommand("Remove item one."), "remove 1");
  assert.equal(spokenCommand("yes"), "yes");
  for (const text of ["Add this shirt", "What do you think of this?", "Find jeans like these", "I bought this"]) assert.equal(needsCallCamera(text), true);
  for (const text of ["Save these clothes", "Find a blue shirt", "remove item two", "weekly on"]) assert.equal(needsCallCamera(text), false);
  assert.equal(isWardrobeAddition("I have a blue shirt"), true);
  for (const text of ["I don't have a shirt", "I have no shirts", "I want to add a shirt", "add jeans to my shopping list", "I might own jeans"]) assert.equal(isWardrobeAddition(text), false);
});

test("camera additions are scoped drafts, spoken corrections work, and explicit confirmation alone adds ownership", async () => {
  const h = setup(); const reference = { storagePath: "private/reference.png", mimeType: "image/png" }; h.store.profile.data.referencePhoto = reference;
  const reply = await h.say("Add this shirt.", "camera-add", true);
  assert.match(reply.text, /Blue shirt.*please check/); assert.equal(h.store.profile.data.wardrobe.length, 0); assert.equal(h.extractions, 1);
  await h.say("Add this shirt.", "camera-add", true); assert.equal(h.extractions, 1);
  await h.say("yes"); assert.equal(h.store.profile.data.wardrobe.length, 0);
  await h.say("Change item one to navy shirt."); assert.equal(h.store.profile.data.draft?.items[0]?.description, "navy shirt");
  await h.say("Please save my wardrobe.", "confirm"); await h.say("Please save my wardrobe.", "confirm");
  assert.equal(h.store.profile.data.wardrobe.length, 1); assert.deepEqual(h.store.profile.data.referencePhoto, reference);
  assert.equal(h.descriptions, 0); assert.equal(h.searches.length, 0);
});

test("spoken descriptions add existing clothes, while camera failure cannot invent or save garments", async () => {
  const h = setup();
  await h.say("I have a blue shirt."); assert.equal(h.store.profile.data.wardrobe.length, 0); assert.equal(h.extractions, 1);
  await h.say("Cancel the draft."); assert.equal(h.store.profile.data.draft, null);
  const reply = await h.say("Add this shirt.", "no-camera", true, true);
  assert.match(reply.text, /Turn your camera on/); assert.equal(h.extractions, 1); assert.equal(h.store.profile.data.draft, null);
});

test("camera questions supply visible clothing to Stylist and partner's Shopper without establishing ownership", async () => {
  const h = setup();
  await h.say("Find a shirt like this.", "visual-search", true);
  assert.equal(h.descriptions, 1); assert.match(h.planned!.message, /visible blue cotton shirt/); assert.deepEqual(h.planned!.wardrobe, []);
  assert.equal(h.searches.length, 1); assert.equal(h.searches[0]?.category, "tops"); assert.equal(h.store.profile.data.wardrobe.length, 0);
  await h.say("Find blue shirts under forty dollars."); assert.equal(h.descriptions, 1); assert.equal(h.searches.length, 2);
});

test("Gemini camera vision uses bounded image input and rejects provider links and malformed output", async () => {
  let bad = false;
  const vision = new GeminiCallVision({ models: { generateContent: async params => {
    assert.equal(params.config?.httpOptions?.timeout, 20000); assert.match(JSON.stringify(params.contents), /inlineData/);
    assert.match(params.config?.systemInstruction as string, /infer ownership/);
    assert.match(params.config?.systemInstruction as string, /readable labels/);
    return { text: JSON.stringify({ description: bad ? "https://invented.example/shirt" : "A blue shirt; size unclear." }) };
  } } }, "vision-test");
  assert.equal(await vision.describe(image, "What's this?"), "A blue shirt; size unclear.");
  bad = true; await assert.rejects(vision.describe(image, "What's this?"), CallVisionError);
  const abort = new AbortController(); abort.abort(); await assert.rejects(vision.describe(image, "What's this?", abort.signal), { name: "AbortError" });
});

test("private call snapshots enforce user, chat, call and event scope before downloading", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let requests = 0;
  globalThis.fetch = async (_input, init) => { requests++; return init?.method === "POST" ? new Response(JSON.stringify({ error: "Duplicate", statusCode: "409" }), { status: 409 }) : new Response(image, { headers: { "Content-Type": "image/png" } }); };
  const snapshots = createCallSnapshots("https://synthetic.supabase.test", "synthetic"); const eventId = randomUUID();
  const path = await snapshots.save({ ...identity, callId, agentId: randomUUID() }, eventId, image);
  assert.equal((await snapshots.load(identity, callId, path)).type, "image/png");
  const before = requests;
  await assert.rejects(snapshots.load({ ...identity, userId: randomUUID() }, callId, path), /identity mismatch/);
  await assert.rejects(snapshots.load(identity, randomUUID(), path), /identity mismatch/);
  await assert.rejects(snapshots.load(identity, callId, `${path}/../secret`), /identity mismatch/); assert.equal(requests, before);
});

test("real Relay adapter sends voice product links into chat without a message reply target", async () => {
  let sent: Record<string, unknown> | undefined;
  const client = new Relay({ apiKey: "synthetic", maxRetries: 0, fetch: async (_input, init) => {
    sent = JSON.parse(init!.body as string); return new Response(JSON.stringify({ id: randomUUID() }), { headers: { "Content-Type": "application/json" } });
  } });
  const adapter = new RelayAdapter(client);
  const message: ConversationMessage = { ...identity, text: "find clothes", deliveryKind: "voice" };
  await adapter.sendReply(randomUUID(), message, "Item 1: https://retailer.example/shirt");
  assert.ok(sent); const body = sent.message as Record<string, unknown>; assert.equal(body.reply_to, undefined); assert.match(body.idempotency_key as string, /^stylist-reply:/);
  await assert.rejects(adapter.sendReply(randomUUID(), { ...message, deliveryKind: undefined }, "hello"), /Missing reply identity/);
});
