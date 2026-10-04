import { GoogleGenAI } from "@google/genai";
import Relay from "@relaymessenger/sdk";
import { conversationMode, geminiImageModel, geminiModels, geminiVisionModel, required, relayOrigin, serverPort } from "./config.ts";
import { createInbox } from "./db/inbox.ts";
import { RelayAdapter, safeRelayError } from "./integrations/relay.ts";
import { createRelayServer } from "./server.ts";
import type { ConversationHandler } from "./services/conversation.ts";
import { createStylistConversation } from "./services/stylist-conversation.ts";
import { createStylistStore } from "./db/stylist-store.ts";
import { GeminiWardrobeAnalyzer } from "./wardrobe/index.ts";
import { runWorker } from "./services/relay-worker.ts";
import { createGoogleSearchGroundedShopper } from "./shopper/index.ts";
import { GeminiOutfitImages } from "./images/outfits.ts";
import { createWeeklyTick } from "./weekly/scheduler.ts";
import { GeminiPurchaseInterpreter } from "./purchases/index.ts";

async function main() {
  const port = serverPort();
  const mode = conversationMode();
  const inbox = createInbox(required("SUPABASE_URL"), required("SUPABASE_SECRET_KEY"));
  const adapter = new RelayAdapter(new Relay({
    apiKey: required("RELAY_AGENT_TOKEN"),
    baseURL: relayOrigin(),
    webhookSecret: required("RELAY_WEBHOOK_SECRET"),
    timeout: 10000,
    maxRetries: 2,
  }));
  let conversation: ConversationHandler = async message => ({ text: message.text.trim().toLowerCase() === "hello"
    ? "Your stylist is connected." : "The connection test is ready. Send hello; styling will be available after setup." });
  let maintenance: (() => Promise<void>) | undefined;
  if (mode === "stylist") {
    const client = new GoogleGenAI({ apiKey: required("GEMINI_API_KEY") });
    const models = geminiModels();
    const researcher = createGoogleSearchGroundedShopper(client, {
      primary: models.text,
      fallback: models.fallback,
    });
    const store = createStylistStore(required("SUPABASE_URL"), required("SUPABASE_SECRET_KEY"));
    await store.checkAccess();
    maintenance = createWeeklyTick(store);
    conversation = createStylistConversation({
      client, models, catalog: {
        search: criteria => researcher.search({
          ...criteria,
          market: "US",
          preferredBrands: [],
          referenceBrands: [],
          maxResults: 3,
        }),
      }, store,
      analyzer: new GeminiWardrobeAnalyzer(client, { model: geminiVisionModel() }),
      downloadVideo: (message, video, signal) => adapter.downloadVideo(message, video, signal),
      downloadPhoto: (message, photo, signal) => adapter.downloadPhoto(message, photo, signal),
      downloadAudio: (message,audio,signal) => adapter.downloadAudio(message,audio,signal),
      purchases:new GeminiPurchaseInterpreter(client,models),
      history: inbox.recentConversation,
      images: new GeminiOutfitImages(client,geminiImageModel(),store.imageAssets,(image,signal) => adapter.uploadImage(image,signal)),
    });
  }
  try {
    await adapter.checkAccess();
  } catch (error) {
    throw new Error(safeRelayError(error));
  }
  await inbox.checkAccess();
  const stop = new AbortController();
  const server = createRelayServer(adapter, inbox);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  console.log(`Relay receiver listening on port ${port}; POST /webhooks/relay.`);
  console.log("Credentials and inbox access verified. Waiting for a real Relay message.");
  console.log(`Conversation mode: ${mode}.`);
  const shutdown = () => {
    stop.abort();
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await runWorker(inbox, adapter, conversation, stop.signal,maintenance);
}

main().catch(error => {
  // Only our known configuration errors are printed; never dump SDK requests or responses.
  const message = error instanceof Error &&
    /^(Set |PORT |RELAY_API_URL |CONVERSATION_MODE |Supabase |Relay request failed)/.test(error.message)
    ? error.message : "Startup failed; check server configuration and port availability.";
  console.error(message);
  process.exitCode = 1;
});
