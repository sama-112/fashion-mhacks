import { StylistAgent } from "../agents/stylist/agent.ts";
import { GeminiStylistModel, type GeminiTextClient } from "../agents/stylist/gemini.ts";
import type { PreparedImageTurn, StylistStore } from "../db/stylist-store.ts";
import { RelayVideoError } from "../integrations/relay.ts";
import { PathwayError, PathwayService, pathwayOutfit, type PathwayReply } from "../pathways/service.ts";
import type { OutfitSuggestion, StylistShopper } from "../agents/stylist/types.ts";
import { isOutfitImageRequest } from "../images/requests.ts";
import { formatWardrobeReview, reviewWardrobe, WardrobeError, type WardrobeAnalyzer } from "../wardrobe/index.ts";
import type { ConversationAudio, ConversationHandler, ConversationHistory, ConversationImage, ConversationMessage, ConversationPhoto, ConversationVideo } from "./conversation.ts";
import { handleItemFeedback } from "../preferences/feedback.ts";
import { rememberRecommendations } from "../preferences/types.ts";
import { handleWeeklySettings, weeklyRequest } from "../weekly/types.ts";
import { OutfitImageError, type OutfitImageGenerator } from "../images/outfits.ts";
import { formatStylistPlan } from "../agents/stylist/plan.ts";
import { ReferencePhotoError } from "../images/photos.ts";
import { isPurchaseReport, isWardrobeAddition, PurchaseInputError, VoiceNoteError, type PurchaseInterpreter } from "../purchases/index.ts";
import { parseWardrobeDraft } from "../wardrobe/gemini.ts";
import { CallVisionError, type CallVision } from "../voice/vision.ts";
import { spokenCommand } from "../voice/commands.ts";
import { clothingRecommendation } from "../agents/stylist/recommendations.ts";
import { handleProfileReset } from "../preferences/reset.ts";

export const CLOSET_HELP = 'Send one MP4, MOV or WebM closet video, up to 50 MiB and two minutes. I will show a clothing draft and three different style tracks, each with a picture and just one or two proposed additions. Correct the clothes and reply "save wardrobe" to confirm them. Choose one or two tracks you like.';
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
  callVision?: CallVision;
  loadCallPhoto?(identity: { userId: string; conversationId: string }, callId: string, path: string, signal?: AbortSignal): Promise<Blob>;
  history?: ConversationHistory;
  images?: OutfitImageGenerator;
  now?: () => Date;
}): ConversationHandler {
  const stylist = new StylistAgent(new GeminiStylistModel(options.client, options.models), options.catalog);
  const pathways = new PathwayService(options.client, options.models);
  return async (message, context) => {
    let text = message.deliveryKind === "voice" ? spokenCommand(message.text) : message.text.trim();
    const videos = message.videos ?? [];
    let photos = message.photos ?? [];
    const audio=message.audio??[];
    context?.signal?.throwIfAborted();
    if (!text && !videos.length && !photos.length && !audio.length) throw new Error("Message text must not be empty.");
    if (text.toLowerCase() === "hello" && !videos.length && !photos.length && !audio.length) return { text: "Your stylist is connected." };
    if (!message.userId || !message.conversationId || !context?.eventId) throw new Error("Missing stylist turn identity.");
    const identity = { userId: message.userId, conversationId: message.conversationId };
    const currentProfile = await options.store.load(identity);
    const cutoff = currentProfile.data.historyAfter;
    // A delayed pre-reset turn must not restore a former wardrobe, draft or image plan.
    if (cutoff && context.receivedAt && Date.parse(context.receivedAt) < Date.parse(cutoff)) return {text:"",skipDelivery:true};
    const prepared = await options.store.loadImageTurn?.(identity,context.eventId);
    if (cutoff && prepared && prepared.profile.data.historyAfter !== cutoff) return {text:"",skipDelivery:true};
    const profile = prepared?.profile ?? currentProfile;
    const baseProfile = prepared?.baseProfile ?? structuredClone(profile);
    const finish = async (text: string, images?: readonly ConversationImage[]) => {
      if (options.store.commitResponse) return options.store.commitResponse(identity,context.eventId!,profile,{text,...(images?.length ? {images} : {})});
      if (images?.length) throw new Error("Image response persistence is unavailable.");
      return { text: await options.store.commit(identity,context.eventId!,profile,text) };
    };
    const resetCutoff = context.receivedAt ?? (options.now?.() ?? new Date()).toISOString();
    if (!videos.length && !photos.length && !audio.length && message.deliveryKind !== "weekly") {
      const reset = handleProfileReset(text,profile,resetCutoff);
      if (reset) return finish(reset);
    }
    const finishImages = async (text: string, outfits: readonly OutfitSuggestion[]) => {
      if (!options.images || !options.store.commitResponse) return finish(`${text}\n\nOutfit image generation isn't configured on this backend yet.`);
      const turn: PreparedImageTurn = options.store.saveImageTurn
        ? await options.store.saveImageTurn(identity,context.eventId!,{profile,baseProfile,text,outfits}) : {profile,baseProfile,text,outfits};
      // Independent image slots generate together, and each slot reuses its bytes/attachment on retries.
      const images = await Promise.all(turn.outfits.map((outfit,slot) => options.images!.generate(identity,context.eventId!,outfit,context.signal,turn.profile.data.referencePhoto,slot)));
      const current = await options.store.load(identity);
      let committed = turn.profile, caption = turn.text;
      if (current.version !== turn.profile.version) {
        // A delayed image retry must preserve newer budgets, wardrobe and photo choices.
        // Apply only fields changed by this turn whose earlier value is still current.
        const data = {...current.data}; let conflict = false;
        for (const key of Object.keys(data) as Array<keyof typeof data>) {
          const before = turn.baseProfile?.data[key], after = turn.profile.data[key];
          if (JSON.stringify(before) === JSON.stringify(after)) continue;
          if (turn.baseProfile && JSON.stringify(current.data[key]) === JSON.stringify(before)) {
            Object.assign(data,{[key]:after});
          } else conflict = true;
        }
        committed = {version:current.version,data};
        if (conflict) caption += "\n\nSome settings changed while these pictures were being prepared. I kept your latest settings; these previews show the clothes and styles from your earlier request.";
      }
      return options.store.commitResponse(identity,context.eventId!,committed,{text:caption,images});
    };
    if (prepared) return finishImages(prepared.text,prepared.outfits);
    const finishPathways = async (prefix: string, reply: PathwayReply, wardrobe: typeof profile.data.wardrobe, suffix = "") => {
      const text = [prefix,reply.text,suffix].filter(Boolean).join("\n\n");
      if (!reply.generated?.length) return finish(text);
      const label = profile.data.referencePhoto
        ? "Pictures 1–3 show these styles on your personal photo. AI-generated approximate previews; actual appearance and fit can differ."
        : 'Pictures 1–3 show the clothes for each style. Send a clear photo of yourself captioned "my photo" to preview future styles on you. AI-generated approximate concepts.';
      return finishImages(`${text}\n\n${label}`,reply.generated.map(path => pathwayOutfit(path,wardrobe)));
    };
    const automaticTracks = async (wardrobe: typeof profile.data.wardrobe, source: "video-draft" | "confirmed") => {
      try {
        return await pathways.handle({
          text: "Show potential style pathways based on these clothes.", wardrobe,
          generateOnly: true, wardrobeSource: source,
        }, profile.data.pathways, context.signal);
      } catch (error) {
        context.signal?.throwIfAborted();
        if (error instanceof PathwayError) return null;
        throw error;
      }
    };
    const now = options.now?.() ?? new Date();
    if (message.deliveryKind === "voice" && message.callPhoto) {
      const reference = message.callPhoto;
      if (!reference.storagePath) return finish('I do not have a recent camera view. Turn your camera on, hold the clothing still, and ask again. You can also describe the item or send a clothing photo in our chat.');
      if (!options.loadCallPhoto) return finish("Camera analysis isn't configured yet. Describe the clothes to me or send a photo in our chat.");
      const addition = isPurchaseReport(text) || isWardrobeAddition(text)
        || /^(?:add|record) (?:this|these)(?: to (?:my |the )?(?:wardrobe|closet))?$/i.test(text);
      if (addition && profile.data.draft) return finish('You have a wardrobe draft waiting for review. Say "save my wardrobe" or "cancel the draft" before adding more clothes.');
      try {
        const photo = await options.loadCallPhoto(identity, reference.callId, reference.storagePath, context.signal);
        if (addition) {
          if (!options.purchases) return finish("Clothing extraction isn't configured yet. Please describe the item.");
          const items = await options.purchases.fromPhoto(photo, text, context.signal);
          if (!items.length) return finish("I couldn't identify clothing on camera. Hold the garment still in good light or describe it. Nothing has been added.");
          profile.data.draft = { items, mediaPath: null, mode: "append" };
          return finish(`Check these clothes from your camera before I add them.\n\n${formatWardrobeReview(items)}\n\nYou can say "change item one to navy shirt", "remove item two", or "save my wardrobe".`);
        }
        if (!options.callVision) return finish("Camera analysis isn't configured yet. Please describe what you're showing me.");
        const visibleClothes = await options.callVision.describe(photo, text, context.signal);
        text = `${text}\n\nCurrent camera clothing observation (not saved wardrobe ownership): ${visibleClothes}`;
      } catch (error) {
        context.signal?.throwIfAborted();
        if (error instanceof CallVisionError || error instanceof PurchaseInputError || error instanceof ReferencePhotoError) return finish(new CallVisionError().message);
        throw error;
      }
    }
    if (audio.length) {
      if (audio.length!==1 || videos.length) return finish("Please send one voice note at a time, separately from a closet video.");
      if (!options.purchases || !options.downloadAudio) return finish("Voice notes aren't configured on this backend yet. Please type what you bought.");
      try {
        const recording=await options.downloadAudio(message,audio[0]!,context.signal);
        const transcript=await options.purchases.transcribe(recording,context.signal);
        text=spokenCommand([text,transcript].filter(Boolean).join("\n"));
        if (text.length>10000)throw new VoiceNoteError();
      } catch(error) {
        context.signal?.throwIfAborted();
        if (error instanceof VoiceNoteError) return finish(error.message);
        throw error;
      }
    }
    if (audio.length && !videos.length && !photos.length && message.deliveryKind !== "weekly") {
      const reset = handleProfileReset(text,profile,resetCutoff);
      if (reset) return finish(reset);
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
        return finish('Saved your personal reference photo privately. Style paths will now include pictures of you in those styles. You can also ask "show me what I would look like in a black jacket". AI previews are approximate; actual fit can differ.');
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
    if (!videos.length && message.deliveryKind!=="weekly" && (isPurchaseReport(text) || (!profile.data.draft && isWardrobeAddition(text)))) {
      if (profile.data.draft) return finish('You have a wardrobe draft waiting for review. Reply "save wardrobe" or "cancel" before adding a purchase.');
      if (/^(?:add|record) (?:a |my |this |these )?purchase[.!]?$/i.test(text))return finish(PURCHASE_HELP);
      try {
        const number=text.match(/\b(?:item|product|suggestion)\s*(\d+)\b/i);
        let items;
        if (number) {
          const item=profile.data.shopping.recommendations[Number(number[1])-1];
          if (!item)return finish("Which item did you buy? Use an item number from my latest suggestions, describe it, or send a clothing photo.");
          items=parseWardrobeDraft({items:[{description:item.name,category:item.category,colors:[],uncertain:true,brand:item.brand ?? null}]});
        } else {
          if (!options.purchases)return finish("Purchase recording isn't configured on this backend yet.");
          items=await options.purchases.fromText(text,context.signal);
        }
        if (!items.length)return finish("What clothing should I add for review? Describe the items you own, give an item number from my latest suggestions, or show the clothing on camera during a call.");
        profile.data.draft={items,mediaPath:null,mode:"append"};
        return finish(`Let's add these clothes after you check this list.\n\n${formatWardrobeReview(items)}`);
      } catch(error) {
        context.signal?.throwIfAborted();
        if(error instanceof PurchaseInputError || error instanceof WardrobeError)return finish(new PurchaseInputError().message);
        throw error;
      }
    }
    if (!videos.length && message.deliveryKind !== "weekly") {
      const settings = handleWeeklySettings(text,profile.data.weekly,now);
      if (settings) return finish(settings);
      // A new recommendation is not evidence answering a pending rejection/budget question.
      const feedback = clothingRecommendation(text) ? null : handleItemFeedback(text,profile.data.shopping,now);
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
        if (!items.length) return finish(formatWardrobeReview(items));
        const tracks = await automaticTracks(items, "video-draft");
        // Preview directions do not change saved preferences or wardrobe ownership.
        if (tracks) {
          profile.data.draft.pathways = tracks.state;
          return finishPathways(formatWardrobeReview(items),tracks,items);
        }
        return finish(`${formatWardrobeReview(items)}\n\nI could not generate style tracks right now. I will try again when you save the wardrobe.`);
      } catch (error) {
        context.signal?.throwIfAborted();
        if (error instanceof WardrobeError || error instanceof RelayVideoError) return finish(error.message);
        throw error;
      }
    }
    if (profile.data.draft) {
      const draft = profile.data.draft;
      const review = reviewWardrobe(text, draft.items);
      if (review.action === "unrecognized" && draft.mediaPath) {
        const tracks = await pathways.handle({text,wardrobe:draft.items,wardrobeSource:"video-draft"},draft.pathways ?? profile.data.pathways,context.signal);
        if (tracks) {
          draft.pathways = tracks.state;
          return finishPathways("These clothes are still a draft; save wardrobe when you've checked them.",tracks,draft.items);
        }
      }
      if (review.action === "confirm") {
        const previous = draft.mode === "replace" ? [] : profile.data.wardrobe;
        const combined = new Map(previous.map(item => [item.description.toLowerCase(), item]));
        for (const item of review.items) combined.set(item.description.toLowerCase(), item);
        if (combined.size > 200) return finish("This wardrobe supports 200 items. Please remove items from the draft before saving.");
        profile.data.wardrobe = [...combined.values()];
        profile.data.draft = null;
        if (draft.mediaPath) {
          if (draft.pathways?.pathways.some(path => path.status === "liked")) {
            const ids = new Set(profile.data.wardrobe.map(item => item.id));
            profile.data.pathways = {...draft.pathways,pathways:draft.pathways.pathways.map(path => ({...path,ownedItemIds:path.ownedItemIds.filter(id => ids.has(id))}))};
            return finish(`Saved your reviewed wardrobe (${combined.size} items). I've kept your chosen style paths. Ask for an outfit using these clothes or for clothing picks that follow your chosen paths. Say "weekly on" for weekly clothing picks.`);
          }
          const tracks = await automaticTracks(profile.data.wardrobe, "confirmed");
          if (tracks) profile.data.pathways = tracks.state;
          if (tracks) return finishPathways(`Saved your reviewed wardrobe (${combined.size} items).`,tracks,profile.data.wardrobe,'Say "weekly on" for weekly clothing picks.');
          return finish(`Saved your reviewed wardrobe (${combined.size} items). Your clothes are saved, but I could not generate style tracks right now. Say "show style pathways" to try again.`);
        }
        return finish(`Saved your reviewed wardrobe (${combined.size} items). Ask me to "show style pathways" to explore directions using your clothes. Say "weekly on" for weekly clothing picks.`);
      }
      if (review.action === "cancel") profile.data.draft = null;
      if (review.action === "update") profile.data.draft = { ...draft, items: review.items };
      if (review.action !== "unrecognized" || /^(?:yes|yeah|ok|okay|sure|confirm|save|no)[.!?]?$/i.test(text)) return finish(review.text);
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
    if (/^(?:help|start)$/i.test(text)) return finish(`${PHOTO_HELP}\n\n${CLOSET_HELP}\n\n${PURCHASE_HELP}\n\nTry "show style pathways", "recommend a clothing item for my style", "recommend a jacket under $100", "weekly on", "weekly picks now", "weekly off", "shirts under $40; jackets under $150", or "show budgets". After shopping, say "I don't like item 1". Ask for an outfit, then "generate outfit image 1" to see it. To start fresh, send "reset profile" and follow the confirmation.`);
    if (/^save wardrobe$/i.test(text)) return finish(`There is no wardrobe draft waiting to be saved. ${CLOSET_HELP}`);
    const history = context.receivedAt && options.history ? await options.history(message, context.receivedAt,profile.data.historyAfter ?? undefined) : [];
    const request = { text, wardrobe: profile.data.wardrobe, history, outfitMode: "closet" as const };
    const imageRequest = isOutfitImageRequest(text);
    if (imageRequest && message.deliveryKind !== "weekly") {
      if (!options.images || !options.store.commitResponse) return finish("Outfit image generation isn't configured on this backend yet.");
      const requested = text.match(/\b(?:image|picture|photo|outfit)\s*(\d+)\b/i);
      const index = requested ? Number(requested[1]) - 1 : 0;
      const usePrevious = /^(?:generate|create|show|render|visuali[sz]e) (?:my |the )?outfit (?:image|picture|photo|preview)(?: \d+)?[.!]?$/i.test(text)
        || /^(?:picture|visuali[sz]e|render) (?:my |the )?outfit(?: \d+)?[.!]?$/i.test(text);
      if (!profile.data.lastOutfits.length || !usePrevious) {
        const planned = await stylist.respond({ ...request, outfitMode:"preview", preferences: profile.data.pathways, shoppingPreferences: profile.data.shopping },context.signal);
        profile.data.lastOutfits = planned.plan.outfits;
      }
      const outfit = profile.data.lastOutfits[index];
      if (!outfit || !outfit.pieces.length) return finish('Which outfit should I illustrate? Ask for an outfit first, then say "generate outfit image 1" or "generate outfit image 2".');
      try {
        const label=profile.data.referencePhoto ? `AI-generated outfit preview on your photo: ${outfit.name}. This is an approximate preview; actual garment appearance and fit can differ.`
          : `AI-generated outfit concept: ${outfit.name}. This is an approximate illustration, not an exact photo or virtual try-on. Send a photo of yourself captioned "my photo" to see future previews on you.`;
        const caption = formatStylistPlan({intro:label,outfits:[outfit],questions:[],shoppingCriteria:null});
        return await finishImages(caption,[outfit]);
      } catch (error) {
        context.signal?.throwIfAborted();
        if (error instanceof OutfitImageError) return finish(error.message);
        throw error;
      }
    }
    const weekly = message.deliveryKind === "weekly" || /^(?:(?:show|get|send|preview) )?weekly (?:picks|suggestions) (?:now|preview)$/i.test(text);
    const recommendation = clothingRecommendation(text);
    if ((weekly || recommendation?.needsChosenStyle) && !profile.data.pathways.pathways.some(path => path.status === "liked")) {
      const tracks = await pathways.handle({...request,text:"Show three style paths",generateOnly:true},profile.data.pathways,context.signal);
      if (tracks) {profile.data.pathways=tracks.state;return finishPathways("Choose one or two style paths first, so clothing suggestions match what you like.",tracks,profile.data.wardrobe);}
    }
    if (weekly || recommendation) {
      if ((weekly || recommendation?.needsChosenStyle) && !profile.data.wardrobe.length) return finish(`Save your wardrobe first so I can pair each suggestion with something you own. ${CLOSET_HELP}`);
      const answer = await stylist.respond({ ...request, text:weekly ? weeklyRequest() : text, preferences:profile.data.pathways, shoppingPreferences:profile.data.shopping, avoidRecentProducts:true, productRecommendation:{limit:weekly ? 3 : recommendation!.limit} },context.signal);
      if (answer.shopping && answer.plan.shoppingCriteria) {
        profile.data.shopping.recommendations = rememberRecommendations(answer.shopping,answer.plan.shoppingCriteria);
        profile.data.shopping.recentlySuggestedIds = [...new Set([...profile.data.shopping.recentlySuggestedIds,...profile.data.shopping.recommendations.map(item=>item.id)])].slice(-50);
      }
      if (answer.plan.outfits.length) profile.data.lastOutfits = answer.plan.outfits;
      return finish(`${weekly ? "Your weekly clothing picks" : recommendation!.limit === 1 ? "Your clothing recommendation" : "Your clothing picks"}\n\n${answer.text}${weekly ? '\n\nSay "weekly off" to pause scheduled picks.' : ""}`);
    }
    const pathwayReply = await pathways.handle(request, profile.data.pathways, context.signal);
    if (pathwayReply) {
      profile.data.pathways = pathwayReply.state;
      return finishPathways("",pathwayReply,profile.data.wardrobe);
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
