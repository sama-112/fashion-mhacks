import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createForwardingOutput, saveLocalSetting } from "./local-env.ts";

test("forwarder secret is saved across split chunks without printing secret or message content", () => {
  const saved: string[] = [], logs: string[] = [];
  const output = createForwardingOutput(secret => saved.push(secret), line => logs.push(line));
  output("Local signing secret  whsec_c3lu");
  output("dGhldGlj   (set RELAY_WEBHOOK_SECRET)\nprivate message text\n");
  assert.deepEqual(saved, ["whsec_c3ludGhldGlj"]);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs.join(""), /whsec_|private message/);
});

test("local setting update preserves other keys and private file permissions", t => {
  const directory = mkdtempSync(join(tmpdir(), "fashion-env-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, ".env");
  writeFileSync(path, "GEMINI_API_KEY=synthetic-test-key\nRELAY_WEBHOOK_SECRET=\n");
  saveLocalSetting("RELAY_WEBHOOK_SECRET", "whsec_c3ludGhldGlj", path);
  assert.match(readFileSync(path, "utf8"), /GEMINI_API_KEY=synthetic-test-key/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
