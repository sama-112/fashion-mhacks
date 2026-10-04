import { createConversationHandler } from "../src/services/conversation.ts";

console.log("LOCAL SERVICE DEMO — fixed sample Gemini plan and mock Shopper catalog; no API or Relay calls.");

try {
  const text = process.argv.slice(2).join(" ") || "hello";
  const handleConversation = createConversationHandler({
    models: { generateContent: async () => ({ text: JSON.stringify({
      intro: "For this sample outfit, pair a light linen shirt with neutral trousers.",
      outfits: [{
        name: "Relaxed daytime outfit", rationale: "Light fabric and neutral colors work well together.",
        pieces: [{ description: "A linen shirt", wardrobeItemId: null }, { description: "Neutral trousers", wardrobeItemId: null }],
      }],
      questions: [],
      shoppingCriteria: { category: "tops", keywords: ["linen"], budget: { max: 50, currency: "USD" } },
    }) }) },
  }, { text: "gemini-3.6-flash", fallback: "gemini-3.5-flash" });
  const reply = await handleConversation({ text });
  console.log(`Input: ${text}`);
  console.log(`Mock reply: ${reply.text}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local demo failed.");
  process.exitCode = 1;
}
