import { handleConversation } from "../src/services/conversation.ts";

console.log("LOCAL SERVICE DEMO — Relay is not connected.");

try {
  const text = process.argv.slice(2).join(" ") || "hello";
  const reply = await handleConversation({ text });
  console.log(`Input: ${text}`);
  console.log(`Fixed reply: ${reply.text}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local demo failed.");
  process.exitCode = 1;
}
