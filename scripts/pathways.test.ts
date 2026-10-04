import assert from "node:assert/strict";
import { test } from "node:test";
import type { GeminiTextClient } from "../src/agents/stylist/gemini.ts";
import { PathwayService, emptyPathwayState, type PathwayState } from "../src/pathways/service.ts";

const models = { text: "test-primary", fallback: "test-fallback" };
const wardrobe = [{ id: "shirt-1", description: "My blue cotton shirt" }];
const minimal = { title: "Relaxed minimal", description: "Easy silhouettes and simple layers.", palette: ["navy", "cream"], staples: ["relaxed trousers", "plain tee"], ownedItemIds: ["shirt-1"] };
const tailored = { title: "Modern tailored", description: "Structured shapes and neat proportions.", palette: ["charcoal", "white"], staples: ["blazer", "straight trousers"], ownedItemIds: ["shirt-1"] };
const sporty = { title: "Casual utility", description: "Comfortable layers with practical details.", palette: ["olive", "gray"], staples: ["overshirt", "cargo trousers"], ownedItemIds: ["shirt-1"] };
const generation = { action: "generate", targetId: null, reason: null, pathways: [minimal, tailored] };

function fake(responses: unknown[]) {
  const inputs: Array<Record<string, unknown>> = [];
  const calledModels: string[] = [];
  const client: GeminiTextClient = { models: { generateContent: async params => {
    calledModels.push(params.model);
    inputs.push(JSON.parse(params.contents as string));
    assert.equal(params.config?.responseMimeType, "application/json");
    assert.ok(params.config?.responseJsonSchema);
    assert.equal(params.config?.httpOptions?.timeout, 20000);
    assert.equal(params.config?.maxOutputTokens, 2500);
    const value = responses.shift();
    if (value instanceof Error) throw value;
    assert.ok(value, "Unexpected model call");
    return { text: typeof value === "string" ? value : JSON.stringify(value) };
  } } };
  return { service: new PathwayService(client, models), inputs, calledModels };
}

function state(): PathwayState {
  return { pathways: [
    { ...minimal, id: "path-minimal", status: "offered" },
    { ...tailored, id: "path-tailored", status: "offered" },
  ], preferences: [], pendingRejectionId: null };
}

test("pathways generate distinct numbered directions and use only saved wardrobe descriptions", async () => {
  const { service, inputs } = fake([generation]);
  const result = await service.handle({ text: "Show me some style pathways", wardrobe }, emptyPathwayState());
  assert.ok(result);
  assert.equal(result.state.pathways.length, 2);
  assert.notEqual(result.state.pathways[0]!.id, result.state.pathways[1]!.id);
  for (const path of result.state.pathways) assert.match(path.id, /^[\da-f-]{36}$/);
  assert.match(result.text, /1\. Relaxed minimal/);
  assert.match(result.text, /2\. Modern tailored/);
  assert.match(result.text, /From your saved wardrobe: My blue cotton shirt/);
  assert.match(result.text, /Which direction feels like you/);
  assert.deepEqual(inputs[0]!.wardrobe, wardrobe);
});

test("rejecting asks why, then explicit feedback produces alternatives and saved evidence", async () => {
  const { service, inputs } = fake([
    { action: "reject", targetId: "path-tailored", reason: null, pathways: [] },
    { action: "revise", targetId: "path-tailored", reason: "Too formal for everyday wear", pathways: [sporty] },
  ]);
  const initial = state();
  const rejected = await service.handle({ text: "I don't like option 2", wardrobe }, initial);
  assert.ok(rejected);
  assert.match(rejected.text, /What don't you like about Modern tailored/);
  assert.deepEqual(rejected.state.preferences, []);
  assert.equal(rejected.state.pendingRejectionId, "path-tailored");
  assert.equal(initial.pathways[1]!.status, "offered", "Input state must remain unchanged");
  const revised = await service.handle({ text: "It's too formal for everyday wear", wardrobe }, rejected.state);
  assert.ok(revised);
  assert.equal(revised.state.pendingRejectionId, null);
  assert.deepEqual(revised.state.preferences, [{ pathwayId: "path-tailored", pathwayTitle: "Modern tailored", reason: "Too formal for everyday wear", evidence: "It's too formal for everyday wear" }]);
  assert.equal(revised.state.pathways.find(path => path.id === "path-tailored")!.status, "rejected");
  assert.match(revised.text, /Casual utility/);
  assert.equal((inputs[1]!.state as PathwayState).pendingRejectionId, "path-tailored");
});

test("liked directions are preserved when requesting fresh pathways and revising others", async () => {
  const { service } = fake([
    { action: "like", targetId: "path-minimal", reason: null, pathways: [] },
    { action: "revise", targetId: "path-tailored", reason: "Too formal", pathways: [sporty] },
    generation,
  ]);
  const liked = await service.handle({ text: "I like option 1", wardrobe }, state());
  assert.ok(liked);
  assert.equal(liked.state.pathways[0]!.status, "liked");
  const revised = await service.handle({ text: "Option 2 is too formal", wardrobe }, liked.state);
  assert.ok(revised);
  assert.deepEqual(revised.state.pathways[0], liked.state.pathways[0]);
  const fresh = await service.handle({ text: "Show me different style pathways", wardrobe }, revised.state);
  assert.ok(fresh);
  assert.deepEqual(fresh.state.pathways[0], liked.state.pathways[0]);
  assert.deepEqual(fresh.state.preferences, revised.state.preferences);
});

test("a bare rejection cannot silently become an inferred preference", async () => {
  for (const text of ["I don't like option 2", "I don't like the second option", "I don't like Modern tailored"]) {
    const { service } = fake([{ action: "revise", targetId: "path-tailored", reason: "Dislikes formal clothing", pathways: [sporty] }]);
    const result = await service.handle({ text, wardrobe }, state());
    assert.ok(result);
    assert.deepEqual(result.state.preferences, []);
    assert.equal(result.state.pathways.length, 2);
    assert.match(result.text, /What don't you like/);
  }
});

test("unknown pathway targets ask for clarification and cannot mutate saved preferences", async () => {
  const { service } = fake([{ action: "revise", targetId: "invented", reason: "Too formal", pathways: [sporty] }]);
  const original = state();
  const result = await service.handle({ text: "I dislike option 9 because it's too formal", wardrobe }, original);
  assert.ok(result);
  assert.equal(result.state, original);
  assert.match(result.text, /couldn't match/);
});

test("unrelated clothing requests fall through, including during a pending pathway question", async () => {
  const { service, calledModels } = fake([
    { action: "unrelated", targetId: null, reason: null, pathways: [] },
    { action: "unrelated", targetId: null, reason: null, pathways: [] },
  ]);
  assert.equal(await service.handle({ text: "Find a linen shirt under $50", wardrobe }, state()), null);
  assert.equal(calledModels.length, 0);
  assert.equal(await service.handle({ text: "I like this shirt; find something similar", wardrobe }, state()), null);
  assert.equal(await service.handle({ text: "Find a jacket", wardrobe }, { ...state(), pendingRejectionId: "path-tailored" }), null);
  assert.equal(calledModels.length, 2);
});

test("unknown wardrobe references and malformed schema trigger fallback before state changes", async () => {
  for (const invalid of [
    { ...generation, pathways: [{ ...minimal, ownedItemIds: ["invented-coat"] }, tailored] },
    { ...generation, pathways: [{ ...minimal, palette: [] }, tailored] },
    { ...generation, pathways: [minimal, minimal] },
    "not json",
  ]) {
    const { service, calledModels } = fake([invalid, generation]);
    const result = await service.handle({ text: "Give me style pathways", wardrobe }, emptyPathwayState());
    assert.ok(result);
    assert.deepEqual(calledModels, [models.text, models.fallback]);
  }
});

test("provider failures are sanitized and abort never starts a model request", async () => {
  const { service, calledModels } = fake([new Error("private credentials"), new Error("private credentials")]);
  const initial = emptyPathwayState();
  await assert.rejects(service.handle({ text: "Give me style pathways", wardrobe }, initial), { message: "Style pathway request failed." });
  assert.deepEqual(initial, emptyPathwayState());
  assert.equal(calledModels.length, 2);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(service.handle({ text: "Give me style pathways", wardrobe }, initial, stop.signal), { name: "AbortError" });
  assert.equal(calledModels.length, 2);
});

test("automatic generation rejects unrelated actions and labels video items as drafts", async () => {
  const { service, inputs, calledModels } = fake([
    { action: "unrelated", targetId: null, reason: null, pathways: [] }, generation,
  ]);
  const original = { ...state(), pendingRejectionId: "path-tailored" };
  const snapshot = structuredClone(original);
  const result = await service.handle({ text: "Closet onboarding", wardrobe, generateOnly: true, wardrobeSource: "video-draft" }, original);
  assert.ok(result);
  assert.deepEqual(calledModels, [models.text, models.fallback]);
  assert.equal(inputs[0]!.generateOnly, true);
  assert.equal(inputs[0]!.wardrobeSource, "video-draft");
  assert.match(result.text, /preliminary/);
  assert.match(result.text, /From your video draft/);
  assert.doesNotMatch(result.text, /From your saved wardrobe/);
  assert.deepEqual(original, snapshot, "Generating previews must not mutate saved preferences.");
});
