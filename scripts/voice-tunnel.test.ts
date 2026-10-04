import assert from "node:assert/strict";
import { test } from "node:test";
import { createTunnelOutput, createTunnelSync, tunnelOrigin } from "./voice-tunnel-output.ts";

test("tunnel announcements survive split output and reject unrelated or spoofed URLs", () => {
  const origins: string[] = [];
  const output = createTunnelOutput(origin => origins.push(origin));
  output("banner\nabc123.lhr.life tunneled with tls termination, https://abc");
  output("123.lhr.life\r\nQR code\nxyz.localhost.run tunneled with tls termination, https://xyz.localhost.run\n");
  assert.deepEqual(origins, ["https://abc123.lhr.life", "https://xyz.localhost.run"]);
  for (const line of [
    "visit https://untrusted.example", "abc.lhr.life tunneled with tls termination, https://other.lhr.life",
    "abc.lhr.life tunneled with tls termination, https://abc.lhr.life@untrusted.example",
    "abc.lhr.life tunneled with tls termination, https://abc.lhr.life/path",
    "untrusted.example tunneled with tls termination, https://untrusted.example",
  ]) assert.equal(tunnelOrigin(line), null);
});

test("callback rotation is serialized, ignores duplicates, and retries a failed provider update", async () => {
  const updates: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let failures = 0;
  let fail = false;
  const sync = createTunnelSync(async origin => {
    if (fail) { fail = false; throw new Error("provider unavailable"); }
    updates.push(origin);
    if (origin === "https://first.lhr.life") await blocked;
  }, () => { failures++; });
  const initial = sync.request("https://first.lhr.life");
  void sync.request("https://intermediate.lhr.life");
  void sync.request("https://latest.lhr.life");
  release(); await initial;
  assert.deepEqual(updates, ["https://first.lhr.life", "https://latest.lhr.life"]);
  await sync.request("https://latest.lhr.life"); assert.equal(updates.length, 2);
  fail = true; await sync.request("https://rotated.lhr.life"); assert.equal(failures, 1);
  await sync.retry(); assert.equal(updates.at(-1), "https://rotated.lhr.life");
});
