import assert from "node:assert/strict";
import { createConversationHandler } from "../src/services/conversation.ts";

const handleConversation = createConversationHandler({
  models: { generateContent: async () => ({ text: "Your stylist is connected." }) },
}, { text: "gemini-3.6-flash", fallback: "gemini-3.5-flash" });
const reply = await handleConversation({ text: "hello" });
assert.deepEqual(reply, { text: "Your stylist is connected." });
await assert.rejects(
  handleConversation({ text: "   " }),
  /Message text must not be empty\./,
);

console.log("PASS: local hello reply and empty-input rejection.");
console.log("This calls the service directly. A live Relay test is still pending.");
