import { createConversationHandler } from "../src/services/conversation.ts";

console.log("LOCAL SERVICE DEMO — mock Gemini response; no API or Relay calls.");

try {
  const text = process.argv.slice(2).join(" ") || "hello";
  const handleConversation = createConversationHandler({
    models: { generateContent: async () => ({ text: "Your stylist is connected." }) },
  }, { text: "gemini-3.6-flash", fallback: "gemini-3.5-flash" });
  const reply = await handleConversation({ text });
  console.log(`Input: ${text}`);
  console.log(`Mock reply: ${reply.text}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local demo failed.");
  process.exitCode = 1;
}
