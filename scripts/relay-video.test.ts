import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import Relay, { signWebhookHeaders } from "@relaymessenger/sdk";
import { RelayAdapter } from "../src/integrations/relay.ts";
import { MAX_VIDEO_BYTES } from "../src/wardrobe/types.ts";

const secret = `whsec_${randomBytes(32).toString("base64")}`;
const userId = randomUUID(), conversationId = randomUUID(), messageId = randomUUID(), mediaId = randomUUID();
function event() {
  return {
    api_version: "v1", webhook_version: "2026-08-30", event_type: "message.received",
    event_id: randomUUID(), agent_id: randomUUID(), created_at: new Date().toISOString(),
    data: { id: messageId, chat: { id: conversationId, is_group: false }, direction: "inbound",
      sender_handle: { id: userId, kind: "user", is_me: false },
      parts: [{ type: "media", id: mediaId, mime_type: "video/mp4", size_bytes: 5, duration_ms: 1000, url: "https://expired.invalid/video" }],
    },
  };
}
function adapterWithTransport(options: { sender?: string; size?: number; url?: string } = {}) {
  return new RelayAdapter(new Relay({
    apiKey: "synthetic-token", webhookSecret: secret, maxRetries: 0,
    fetch: async input => {
      const url = input.toString();
      const value = url.includes("/messages/")
        ? { id: messageId, chat_id: conversationId, from_handle: { id: options.sender ?? userId, kind: "user" }, is_from_me: false, parts: event().data.parts }
        : { id: mediaId, content_type: "video/mp4", size_bytes: options.size ?? 5, status: "complete", download_url: options.url ?? "https://cdn.synthetic.test/video" };
      return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
    },
  }));
}
function verify(adapter: RelayAdapter, value: ReturnType<typeof event>) {
  const body = JSON.stringify(value);
  return adapter.verify(Buffer.from(body), signWebhookHeaders(secret, { id: value.event_id, body }));
}
test("signed direct video-only messages enter the inbox, but agent/group/outbound videos do not", () => {
  const adapter = adapterWithTransport();
  const accepted = verify(adapter, event());
  assert.equal(accepted.message?.text, "");
  assert.deepEqual(accepted.message?.videos, [{ mediaId, mimeType: "video/mp4", sizeBytes: 5, durationMs: 1000 }]);
  for (const kind of ["agent", "group", "outbound"] as const) {
    const value = event();
    if (kind === "agent") value.data.sender_handle.kind = "agent";
    if (kind === "group") value.data.chat.is_group = true;
    if (kind === "outbound") value.data.direction = "outbound";
    assert.equal(verify(adapter, value).message, null);
  }
});
test("video download checks message ownership and uses a refreshed URL without credentials", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let downloads = 0;
  globalThis.fetch = async (input, init) => {
    downloads++;
    assert.equal(input.toString(), "https://cdn.synthetic.test/video");
    assert.equal(init?.headers, undefined);
    assert.equal(init?.redirect, "error");
    return new Response("video");
  };
  const adapter = adapterWithTransport();
  const message = verify(adapter, event()).message!;
  const blob = await adapter.downloadVideo(message, message.videos![0]!);
  assert.equal(await blob.text(), "video");
  assert.equal(blob.type, "video/mp4");
  await assert.rejects(adapterWithTransport({ sender: randomUUID() }).downloadVideo(message, message.videos![0]!), /download/);
  await assert.rejects(adapterWithTransport({ size: MAX_VIDEO_BYTES + 1 }).downloadVideo(message, message.videos![0]!), /download/);
  await assert.rejects(adapterWithTransport({ url: "http://127.0.0.1/private" }).downloadVideo(message, message.videos![0]!), /download/);
  assert.equal(downloads, 1);
});
test("download failures are sanitized and incorrect response length is rejected", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const adapter = adapterWithTransport();
  const message = verify(adapter, event()).message!;
  globalThis.fetch = async () => new Response("too short", { status: 403 });
  await assert.rejects(adapter.downloadVideo(message, message.videos![0]!), /download/);
  globalThis.fetch = async () => new Response("incorrect length");
  await assert.rejects(adapter.downloadVideo(message, message.videos![0]!), /download/);
});
