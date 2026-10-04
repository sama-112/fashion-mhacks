import { GoogleGenAI } from "@google/genai";
import Relay from "@relaymessenger/sdk";
import { conversationMode, geminiImageModel, geminiModels, geminiVisionModel, required, relayOrigin, serverPort, voiceConfig } from "./config.ts";
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
import { createVoiceEndpoint } from "./voice/endpoint.ts";
import { createVoiceCalls } from "./voice/calls.ts";
import { createCallSnapshots } from "./voice/snapshots.ts";
import { GeminiCallVision } from "./voice/vision.ts";
import { setTimeout as delay } from "node:timers/promises";

async function main() {
  const port = serverPort();
  const mode = conversationMode();
  const inbox = createInbox(required("SUPABASE_URL"), required("SUPABASE_SECRET_KEY"));
  const relay = new Relay({
    apiKey: required("RELAY_AGENT_TOKEN"),
    baseURL: relayOrigin(),
    webhookSecret: required("RELAY_WEBHOOK_SECRET"),
    timeout: 10000,
    maxRetries: 2,
  });
  const adapter = new RelayAdapter(relay);
  let conversation: ConversationHandler = async message => ({ text: message.text.trim().toLowerCase() === "hello"
    ? "Your stylist is connected." : "The connection test is ready. Send hello; styling will be available after setup." });
  let maintenance: (() => Promise<void>) | undefined;
  let snapshots: ReturnType<typeof createCallSnapshots> | undefined;
  if (mode === "stylist") {
    const client = new GoogleGenAI({ apiKey: required("GEMINI_API_KEY") });
    const models = geminiModels();
    const researcher = createGoogleSearchGroundedShopper(client, {
      primary: models.text,
      fallback: models.fallback,
    });
    const store = createStylistStore(required("SUPABASE_URL"), required("SUPABASE_SECRET_KEY"));
    snapshots = createCallSnapshots(required("SUPABASE_URL"), required("SUPABASE_SECRET_KEY"));
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
      callVision: new GeminiCallVision(client, geminiVisionModel()),
      loadCallPhoto: snapshots.load,
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
  const voice = voiceConfig();
  if (voice && mode !== "stylist") throw new Error("CONVERSATION_MODE must be stylist for voice calls.");
  if (voice && !(await relay.me.retrieve()).calls_enabled) throw new Error("Set up voice on a Relay server with calls enabled.");
  const calls = voice ? createVoiceCalls({ relay, ...voice }) : null;
  const server = createRelayServer(adapter, inbox, {
    ...(calls && voice ? { voice: createVoiceEndpoint({ secret: voice.secret, inbox, validate: identity => calls.validate(identity),
      snapshot: async (identity, eventId) => {
        const photo = calls.snapshot(identity);
        return photo && snapshots ? snapshots.save(identity, eventId, photo) : null;
      },
    }) } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  console.log(`Relay receiver listening on port ${port}; POST /webhooks/relay.`);
  console.log("Credentials and inbox access verified. Waiting for a real Relay message.");
  console.log(`Conversation mode: ${mode}.`);
  console.log(`ElevenLabs calls: ${calls ? "enabled" : "disabled"}.`);
  const shutdown = () => {
    stop.abort();
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // Call joining runs separately so a long product search cannot let a new call ring out.
  const callWorker = async () => {
    if (!calls) return;
    while (!stop.signal.aborted) {
      try { for (const event of await inbox.pendingCalls()) calls.dispatch(event); }
      catch { console.error("Voice event polling unavailable; check inbox access."); }
      try { await delay(1000, undefined, { signal: stop.signal }); } catch { break; }
    }
    await calls.stop();
  };
  await Promise.all([runWorker(inbox, adapter, conversation, stop.signal, maintenance), callWorker()]);
}

main().catch(error => {
  // Only our known configuration errors are printed; never dump SDK requests or responses.
  const message = error instanceof Error &&
    /^(Set |PORT |RELAY_API_URL |CONVERSATION_MODE |Supabase |Relay request failed)/.test(error.message)
    ? error.message : "Startup failed; check server configuration and port availability.";
  console.error(message);
  process.exitCode = 1;
});
