import { StylistAgent } from "../agents/stylist/agent.ts";
import { GeminiStylistModel, type GeminiTextClient } from "../agents/stylist/gemini.ts";
import type { StylistStore } from "../db/stylist-store.ts";
import { RelayVideoError } from "../integrations/relay.ts";
import { PathwayService } from "../pathways/service.ts";
import type { StylistShopper } from "../agents/stylist/types.ts";
import { formatWardrobeReview, reviewWardrobe, WardrobeError, type WardrobeAnalyzer } from "../wardrobe/index.ts";
import type { ConversationHandler, ConversationHistory, ConversationMessage, ConversationVideo } from "./conversation.ts";

export const CLOSET_HELP = 'Send one MP4, MOV or WebM closet video, up to 50 MiB and two minutes. I will make a draft for you to correct before you reply "save wardrobe".';

export function createStylistConversation(options: {
  client: GeminiTextClient;
  models: { text: string; fallback: string };
  catalog: StylistShopper;
  store: StylistStore;
  analyzer: WardrobeAnalyzer;
  downloadVideo(message: ConversationMessage, video: ConversationVideo, signal?: AbortSignal): Promise<Blob>;
  history?: ConversationHistory;
}): ConversationHandler {
  const stylist = new StylistAgent(new GeminiStylistModel(options.client, options.models), options.catalog);
  const pathways = new PathwayService(options.client, options.models);
  return async (message, context) => {
    const text = message.text.trim();
    const videos = message.videos ?? [];
    context?.signal?.throwIfAborted();
    if (!text && !videos.length) throw new Error("Message text must not be empty.");
    if (text.toLowerCase() === "hello" && !videos.length) return { text: "Your stylist is connected." };
    if (!message.userId || !message.conversationId || !context?.eventId) throw new Error("Missing stylist turn identity.");
    const identity = { userId: message.userId, conversationId: message.conversationId };
    const profile = await options.store.load(identity);
    const finish = async (reply: string) => ({ text: await options.store.commit(identity, context.eventId!, profile, reply) });
    if (videos.length) {
      if (videos.length !== 1) return finish(`Please send one closet video at a time. ${CLOSET_HELP}`);
      if (profile.data.draft) return finish('You have a wardrobe draft waiting for review. Reply "save wardrobe" or "cancel" before sending another video.');
      try {
        const video = await options.downloadVideo(message, videos[0]!, context.signal);
        const items = await options.analyzer.analyze(video, context.signal);
        const mediaPath = await options.store.saveVideo(identity, context.eventId, video);
        profile.data.draft = { items, mediaPath, mode: "append" };
        return finish(formatWardrobeReview(items));
      } catch (error) {
        context.signal?.throwIfAborted();
        if (error instanceof WardrobeError || error instanceof RelayVideoError) return finish(error.message);
        throw error;
      }
    }
    if (profile.data.draft) {
      const draft = profile.data.draft;
      const review = reviewWardrobe(text, draft.items);
      if (review.action === "confirm") {
        const previous = draft.mode === "replace" ? [] : profile.data.wardrobe;
        const combined = new Map(previous.map(item => [item.description.toLowerCase(), item]));
        for (const item of review.items) combined.set(item.description.toLowerCase(), item);
        if (combined.size > 200) return finish("This wardrobe supports 200 items. Please remove items from the draft before saving.");
        profile.data.wardrobe = [...combined.values()];
        profile.data.draft = null;
        return finish(`Saved your reviewed wardrobe (${combined.size} items). Ask me to "show style pathways" to explore directions using your clothes.`);
      }
      if (review.action === "cancel") profile.data.draft = null;
      if (review.action === "update") profile.data.draft = { ...draft, items: review.items };
      return finish(review.text);
    }
    if (/^(?:show|my|view) wardrobe$/i.test(text)) {
      return finish(profile.data.wardrobe.length
        ? `Your saved wardrobe:\n${profile.data.wardrobe.map((item, i) => `${i + 1}. ${item.description}`).join("\n")}\n\nReply "edit wardrobe" to correct it.`
        : `Your wardrobe is empty. ${CLOSET_HELP}`);
    }
    if (/^edit wardrobe$/i.test(text)) {
      profile.data.draft = { items: profile.data.wardrobe.slice(0, 40), mediaPath: null, mode: "replace" };
      // Editing replaces only the displayed batch; avoid truncating larger wardrobes.
      if (profile.data.wardrobe.length > 40) {
        profile.data.draft = null;
        return finish("Your wardrobe has more than 40 items. Send a video of additional clothes to add a reviewed batch.");
      }
      return finish(formatWardrobeReview(profile.data.draft.items));
    }
    if (/^(?:scan|upload|add) (?:my )?(?:closet|wardrobe|video)$/i.test(text) || /^(?:help|start)$/i.test(text)) return finish(CLOSET_HELP);
    if (/^save wardrobe$/i.test(text)) return finish(`There is no wardrobe draft waiting to be saved. ${CLOSET_HELP}`);
    const history = context.receivedAt && options.history ? await options.history(message, context.receivedAt) : [];
    const request = { text, wardrobe: profile.data.wardrobe, history };
    const pathwayReply = await pathways.handle(request, profile.data.pathways, context.signal);
    if (pathwayReply) {
      profile.data.pathways = pathwayReply.state;
      return finish(pathwayReply.text);
    }
    const answer = await stylist.respond({ ...request, preferences: profile.data.pathways }, context.signal);
    return finish(answer.text);
  };
}
