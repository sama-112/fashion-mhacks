import assert from "node:assert/strict";
import { test } from "node:test";
import { FileState } from "@google/genai";
import { GeminiWardrobeAnalyzer, parseWardrobeDraft, reviewWardrobe, type GeminiVideoClient } from "../src/wardrobe/index.ts";

const draft = { items: [{ description: "Blue shirt", category: "tops", colors: ["blue"], uncertain: true }] };
function videoClient() {
  const removed: string[] = [];
  let calls = 0;
  const client: GeminiVideoClient = {
    files: {
      upload: async params => ({ name: params.config?.name, state: FileState.ACTIVE, uri: "https://generativelanguage.googleapis.com/v1beta/files/test", videoMetadata: { videoDuration: "8s" } }),
      get: async () => ({ state: FileState.ACTIVE }),
      delete: async params => { removed.push(params.name); return {}; },
    },
    models: { generateContent: async params => {
      calls++;
      assert.equal(params.config?.responseMimeType, "application/json");
      return { text: JSON.stringify(draft) };
    } },
  };
  return { client, removed, calls: () => calls };
}

test("video extraction returns an uncertain draft and deletes the temporary Gemini file", async () => {
  const h = videoClient();
  const analyzer = new GeminiWardrobeAnalyzer(h.client, { model: "test-vision" });
  const items = await analyzer.analyze(new Blob(["synthetic video"], { type: "video/mp4" }));
  assert.equal(items[0]!.description, "Blue shirt");
  assert.equal(items[0]!.uncertain, true);
  assert.match(items[0]!.id, /^[0-9a-f-]{36}$/);
  assert.equal(h.removed.length, 1);
  assert.equal(h.calls(), 1);
});

test("wardrobe corrections preserve identity, clear uncertain attributes, and require explicit confirmation", () => {
  const items = parseWardrobeDraft(draft);
  const changed = reviewWardrobe("change 1: navy jacket", items);
  assert.equal(changed.action, "update");
  assert.equal(changed.items[0]!.id, items[0]!.id);
  assert.equal(changed.items[0]!.description, "navy jacket");
  assert.deepEqual(changed.items[0]!.colors, []);
  assert.equal(changed.items[0]!.uncertain, false);
  assert.equal(reviewWardrobe("looks good", changed.items).action, "unrecognized");
  assert.equal(reviewWardrobe("save wardrobe", changed.items).action, "confirm");
  assert.equal(reviewWardrobe("remove 1", changed.items).items.length, 0);
  assert.equal(reviewWardrobe("save wardrobe", []).action, "show");
  assert.equal(reviewWardrobe("cancel", items).action, "cancel");
  assert.equal(items[0]!.description, "Blue shirt");
});

test("unsupported video and oversized duration do not start model analysis", async () => {
  const h = videoClient();
  const analyzer = new GeminiWardrobeAnalyzer(h.client, { model: "test" });
  await assert.rejects(analyzer.analyze(new Blob(["data"], { type: "image/jpeg" })), /MP4/);
  h.client.files.upload = async () => ({ state: FileState.ACTIVE, uri: "https://generativelanguage.googleapis.com/v1beta/files/test", videoMetadata: { videoDuration: "121s" } });
  await assert.rejects(analyzer.analyze(new Blob(["video"], { type: "video/mp4" })), /two minutes/);
  assert.equal(h.calls(), 0);
  assert.equal(h.removed.length, 1);
});

test("processing is bounded and provider failures are sanitized with cleanup", async () => {
  const h = videoClient();
  h.client.files.upload = async () => ({ state: FileState.FAILED });
  const analyzer = new GeminiWardrobeAnalyzer(h.client, { model: "test", processingTimeoutMs: 10, pollIntervalMs: 1 });
  await assert.rejects(analyzer.analyze(new Blob(["video"], { type: "video/mp4" })), /could not be analyzed/);
  h.client.files.upload = async () => ({ state: FileState.PROCESSING });
  h.client.files.get = async () => ({ state: FileState.PROCESSING });
  await assert.rejects(analyzer.analyze(new Blob(["video"], { type: "video/mp4" })), /could not be analyzed/);
  assert.equal(h.removed.length, 2);
});

test("invalid model garments cannot be saved as wardrobe items", () => {
  assert.throws(() => parseWardrobeDraft({ items: [{ ...draft.items[0], description: "https://invented.example" }] }));
  assert.throws(() => parseWardrobeDraft({ items: [{ ...draft.items[0], category: "jewelry-brand" }] }));
  assert.deepEqual(parseWardrobeDraft({ items: [] }), []);
});
