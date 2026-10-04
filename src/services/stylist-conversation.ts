import { StylistAgent } from "../agents/stylist/agent.ts";
import { GeminiStylistModel, type GeminiTextClient } from "../agents/stylist/gemini.ts";
import type { StylistStore } from "../db/stylist-store.ts";
import { RelayVideoError } from "../integrations/relay.ts";
import { PathwayService } from "../pathways/service.ts";
import type { StylistShopper } from "../agents/stylist/types.ts";
import { formatWardrobeReview, reviewWardrobe, WardrobeError, type WardrobeAnalyzer } from "../wardrobe/index.ts";
import type { ConversationAudio, ConversationHandler, ConversationHistory, ConversationImage, ConversationMessage, ConversationPhoto, ConversationVideo } from "./conversation.ts";
import { handleItemFeedback } from "../preferences/feedback.ts";
import { rememberRecommendations } from "../preferences/types.ts";
import { handleWeeklySettings, weeklyRequest } from "../weekly/types.ts";
import { OutfitImageError, type OutfitImageGenerator } from "../images/outfits.ts";
import { formatStylistPlan } from "../agents/stylist/plan.ts";
import { ReferencePhotoError } from "../images/photos.ts";
import { isPurchaseReport, PurchaseInputError, VoiceNoteError, type PurchaseInterpreter } from "../purchases/index.ts";
import { parseWardrobeDraft } from "../wardrobe/gemini.ts";

export const CLOSET_HELP = 'Send one MP4, MOV or WebM closet video, up to 50 MiB and two minutes. I will make a draft for you to correct before you reply "save wardrobe".';
export const PHOTO_HELP = 'Optional: send one clear, preferably full-body JPG, PNG or WebP photo of yourself (up to 10 MiB). I will save it privately and use it with Gemini to preview outfits on you. Skip it to keep flat-lay outfit pictures.';
export const PURCHASE_HELP = 'Tell me "I bought a navy shirt", say it in a voice note, or send a clothing photo captioned "I bought this". I will show a wardrobe draft; correct it and reply "save wardrobe" to add the items.';

export function createStylistConversation(options: {
  client: GeminiTextClient;
  models: { text: string; fallback: string };
  catalog: StylistShopper;
  store: StylistStore;
  analyzer: WardrobeAnalyzer;
  downloadVideo(message: ConversationMessage, video: ConversationVideo, signal?: AbortSignal): Promise<Blob>;
  downloadPhoto?(message: ConversationMessage, photo: ConversationPhoto, signal?: AbortSignal): Promise<Blob>;
  downloadAudio?(message:ConversationMessage,audio:ConversationAudio,signal?:AbortSignal):Promise<Blob>;
  purchases?:PurchaseInterpreter;
  history?: ConversationHistory;
  images?: OutfitImageGenerator;
  now?: () => Date;
}): ConversationHandler {
  const stylist = new StylistAgent(new GeminiStylistModel(options.client, options.models), options.catalog);
  const pathways = new PathwayService(options.client, options.models);
  return async (message, context) => {
    let text = message.text.trim();
    const videos = message.videos ?? [];
    let photos = message.photos ?? [];
    const audio=message.audio??[];
    context?.signal?.throwIfAborted();
    if (!text && !videos.length && !photos.length && !audio.length) throw new Error("Message text must not be empty.");
    if (text.toLowerCase() === "hello" && !videos.length && !photos.length && !audio.length) return { text: "Your stylist is connected." };
    if (!message.userId || !message.conversationId || !context?.eventId) throw new Error("Missing stylist turn identity.");
    const identity = { userId: message.userId, conversationId: message.conversationId };
    const profile = await options.store.load(identity);
    const finish = async (text: string, images?: readonly ConversationImage[]) => {
      if (options.store.commitResponse) return options.store.commitResponse(identity,context.eventId!,profile,{text,...(images?.length ? {images} : {})});
      if (images?.length) throw new Error("Image response persistence is unavailable.");
      return { text: await options.store.commit(identity,context.eventId!,profile,text) };
    };
    const now = options.now?.() ?? new Date();
    if (audio.length) {
      if (audio.length!==1 || videos.length) return finish("Please send one voice note at a time, separately from a closet video.");
      if (!options.purchases || !options.downloadAudio) return finish("Voice notes aren't configured on this backend yet. Please type what you bought.");
      try {
        const recording=await options.downloadAudio(message,audio[0]!,context.signal);
        const transcript=await options.purchases.transcribe(recording,context.signal);
        text=[text,transcript].filter(Boolean).join("\n");
        if (text.length>10000)throw new VoiceNoteError();
      } catch(error) {
        context.signal?.throwIfAborted();
        if (error instanceof VoiceNoteError) return finish(error.message);
        throw error;
      }
    }
    let photoMessage=message;
    if (!photos.length && profile.data.pendingPhoto) {
      if (/^cancel photo$/i.test(text)) {profile.data.pendingPhoto=null;return finish("Canceled that photo question.");}
      if (/^(?:my photo|personal photo|photo of me|outfit preview|purchase|purchased clothes|clothing I bought)$/i.test(text)) {
        photos=[profile.data.pendingPhoto.photo];photoMessage={...message,messageId:profile.data.pendingPhoto.messageId};
      }
    }
    if (photos.length) {
      if (photos.length!==1 || videos.length) return finish("Please send one photo at a time, separately from a closet video.");
      const purchasePhoto=isPurchaseReport(text) || /^(?:purchase|purchased clothes|clothing I bought)$/i.test(text);
      const personalPhoto=/\b(?:my photo|personal photo|photo of me|picture of me|outfit preview|reference photo)\b/i.test(text);
      if (!purchasePhoto && !personalPhoto) {
        if (!photoMessage.messageId)throw new Error("Missing photo message identity.");
        profile.data.pendingPhoto={photo:photos[0]!,messageId:photoMessage.messageId};
        return finish('Is this a photo of you for outfit previews, or clothing you bought? Reply "my photo" or "purchase". Nothing has been added to your wardrobe.');
      }
      if (purchasePhoto && profile.data.draft) return finish('You have a wardrobe draft waiting for review. Reply "save wardrobe" or "cancel" before adding a purchase.');
      if (!options.downloadPhoto || (purchasePhoto ? !options.purchases : !options.store.saveReferencePhoto)) return finish("Photo processing isn't configured on this backend yet.");
      try {
        const photo=await options.downloadPhoto(photoMessage,photos[0]!,context.signal);
        if (purchasePhoto) {
          const items=await options.purchases!.fromPhoto(photo,text,context.signal);
          if (!items.length)return finish("I couldn't identify clothing in that photo. Tell me what you bought or send a clearer photo. Nothing has been added yet.");
          profile.data.draft={items,mediaPath:null,mode:"append"};profile.data.pendingPhoto=null;
          return finish(`Let's add your purchase after you check this list.\n\n${formatWardrobeReview(items)}`);
        }
        profile.data.referencePhoto=await options.store.saveReferencePhoto!(identity,context.eventId,photo);
        profile.data.pendingPhoto=null;
        return finish('Saved your personal reference photo privately. Future outfit pictures will preview the clothes on you. Ask for an outfit, then say "generate outfit image 1". AI previews are approximate; actual fit can differ.');
      } catch(error) {
        context.signal?.throwIfAborted();
        if (error instanceof PurchaseInputError) return finish(error.message);
        if (error instanceof ReferencePhotoError) return finish(purchasePhoto ? new PurchaseInputError().message : error.message);
        throw error;
      }
    }
    if (/^(?:use flat[- ]lay(?: images| pictures)?|skip(?: my| the)? photo)$/i.test(text)) {
      profile.data.referencePhoto=null;
      profile.data.pendingPhoto=null;
      return finish('I will use flat-lay outfit pictures. You can send a personal photo later to enable previews on you.');
    }
    if (message.deliveryKind === "weekly" && !profile.data.weekly.enabled) return { text: "", skipDelivery: true };
    if (!videos.length && message.deliveryKind!=="weekly" && isPurchaseReport(text)) {
      if (profile.data.draft) return finish('You have a wardrobe draft waiting for review. Reply "save wardrobe" or "cancel" before adding a purchase.');
      if (/^(?:add|record) (?:a |my |this |these )?purchase[.!]?$/i.test(text))return finish(PURCHASE_HELP);
      try {
        const number=text.match(/\b(?:item|product|suggestion)\s*(\d+)\b/i);
        let items;
        if (number) {
          const item=profile.data.shopping.recommendations[Number(number[1])-1];
          if (!item)return finish("Which item did you buy? Use an item number from my latest suggestions, describe it, or send a clothing photo.");
          items=parseWardrobeDraft({items:[{description:item.name,category:item.category,colors:[],uncertain:true}]});
        } else {
          if (!options.purchases)return finish("Purchase recording isn't configured on this backend yet.");
          items=await options.purchases.fromText(text,context.signal);
        }
        if (!items.length)return finish("What clothing did you buy? Describe the items, give an item number from my latest suggestions, or send a clothing photo.");
        profile.data.draft={items,mediaPath:null,mode:"append"};
        return finish(`Let's add your purchase after you check this list.\n\n${formatWardrobeReview(items)}`);
      } catch(error) {
        context.signal?.throwIfAborted();
        if(error instanceof PurchaseInputError || error instanceof WardrobeError)return finish(new PurchaseInputError().message);
        throw error;
      }
    }
    if (!videos.length && message.deliveryKind !== "weekly") {
      const settings = handleWeeklySettings(text,profile.data.weekly,now);
      if (settings) return finish(settings);
      const feedback = handleItemFeedback(text,profile.data.shopping,now);
      if (feedback) return finish(feedback);
    }
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
        return finish(`Saved your reviewed wardrobe (${combined.size} items). Ask me to "show style pathways" to explore directions using your clothes. Say "weekly on" for weekly clothing picks.`);
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
    if (/^(?:scan|upload|add) (?:my )?(?:closet|wardrobe|video)$/i.test(text)) return finish(CLOSET_HELP);
    if (/^(?:help|start)$/i.test(text)) return finish(`${PHOTO_HELP}\n\n${CLOSET_HELP}\n\n${PURCHASE_HELP}\n\nTry "show style pathways", "weekly on", "weekly picks now", "weekly off", "shirts under $40; jackets under $150", or "show budgets". After shopping, say "I don't like item 2". Ask for an outfit, then "generate outfit image 1" to see it.`);
    if (/^save wardrobe$/i.test(text)) return finish(`There is no wardrobe draft waiting to be saved. ${CLOSET_HELP}`);
    const history = context.receivedAt && options.history ? await options.history(message, context.receivedAt) : [];
    const request = { text, wardrobe: profile.data.wardrobe, history };
    const imageRequest = /\b(?:generate|create|show|picture|visuali[sz]e|render)\b.*\b(?:outfit|fit)\b.*\b(?:image|picture|photo|preview)\b|\b(?:generate|create|show|visuali[sz]e|render)\b.*\b(?:image|picture|photo)\b.*\b(?:outfit|fit)\b|^(?:picture|visuali[sz]e|render) (?:my |the )?outfit\b/i.test(text);
    if (imageRequest && message.deliveryKind !== "weekly") {
      if (!options.images || !options.store.commitResponse) return finish("Outfit image generation isn't configured on this backend yet.");
      const requested = text.match(/\b(?:image|picture|photo|outfit)\s*(\d+)\b/i);
      const index = requested ? Number(requested[1]) - 1 : 0;
      const usePrevious = /^(?:generate|create|show|render|visuali[sz]e) (?:my |the )?outfit (?:image|picture|photo|preview)(?: \d+)?[.!]?$/i.test(text)
        || /^(?:picture|visuali[sz]e|render) (?:my |the )?outfit(?: \d+)?[.!]?$/i.test(text);
      if (!profile.data.lastOutfits.length || !usePrevious) {
        const planned = await stylist.respond({ ...request, preferences: profile.data.pathways, shoppingPreferences: profile.data.shopping },context.signal);
        profile.data.lastOutfits = planned.plan.outfits;
      }
      const outfit = profile.data.lastOutfits[index];
      if (!outfit || !outfit.pieces.length) return finish('Which outfit should I illustrate? Ask for an outfit first, then say "generate outfit image 1" or "generate outfit image 2".');
      try {
        const image = await options.images.generate(identity,context.eventId,outfit,context.signal,profile.data.referencePhoto);
        const label=profile.data.referencePhoto ? `AI-generated outfit preview on your photo: ${outfit.name}. This is an approximate preview; actual garment appearance and fit can differ.`
          : `AI-generated outfit concept: ${outfit.name}. This is an approximate illustration, not an exact photo or virtual try-on.`;
        const caption = formatStylistPlan({intro:label,outfits:[outfit],questions:[],shoppingCriteria:null});
        return finish(caption,[image]);
      } catch (error) {
        context.signal?.throwIfAborted();
        if (error instanceof OutfitImageError) return finish(error.message);
        throw error;
      }
    }
    const weekly = message.deliveryKind === "weekly" || /^(?:(?:show|get|send|preview) )?weekly (?:picks|suggestions) (?:now|preview)$/i.test(text);
    if (weekly) {
      const answer = await stylist.respond({ ...request, text:weeklyRequest(), preferences:profile.data.pathways, shoppingPreferences:profile.data.shopping, avoidRecentProducts:true },context.signal);
      if (!answer.shopping || !answer.plan.shoppingCriteria) return finish(`I need a little more style context before choosing weekly products. ${answer.text}\n\nTry "show style pathways" and tell me which direction you like.`);
      profile.data.shopping.recommendations = rememberRecommendations(answer.shopping,answer.plan.shoppingCriteria);
      profile.data.shopping.recentlySuggestedIds = [...new Set([...profile.data.shopping.recentlySuggestedIds,...profile.data.shopping.recommendations.map(item=>item.id)])].slice(-50);
      profile.data.lastOutfits = answer.plan.outfits;
      return finish(`Your weekly clothing picks\n\n${answer.text}\n\nSay "I don't like item 2" to give feedback, or "weekly off" to pause scheduled picks.`);
    }
    const pathwayReply = await pathways.handle(request, profile.data.pathways, context.signal);
    if (pathwayReply) {
      profile.data.pathways = pathwayReply.state;
      return finish(pathwayReply.text);
    }
    const answer = await stylist.respond({ ...request, preferences: profile.data.pathways, shoppingPreferences:profile.data.shopping }, context.signal);
    if (answer.plan.outfits.length) profile.data.lastOutfits = answer.plan.outfits;
    if (answer.shopping && answer.plan.shoppingCriteria) {
      profile.data.shopping.recommendations = rememberRecommendations(answer.shopping,answer.plan.shoppingCriteria);
      profile.data.shopping.recentlySuggestedIds = [...new Set([...profile.data.shopping.recentlySuggestedIds,...profile.data.shopping.recommendations.map(item=>item.id)])].slice(-50);
    }
    return finish(answer.text);
  };
}
