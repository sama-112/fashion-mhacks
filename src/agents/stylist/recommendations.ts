import { spendingCategory } from "../../preferences/types.ts";

/** Internal routing only; the Shopper continues to receive its existing criteria contract. */
export function clothingRecommendation(text: string): { limit: 1 | 3; needsChosenStyle: boolean } | null {
  const message = text.trim().replaceAll("’", "'").replace(/\brecomend/gi,"recommend");
  if (/\b(?:don't|dont|do not|stop|never)\s+(?:recommend|suggest)\b|\b(?:don't|dont|do not)\s+like\b/i.test(message)) return null;
  const namedGarment = spendingCategory(message) !== null;
  const clothing = namedGarment || /\b(?:clothing|clothes|shopping|garments?|items?|pieces?)\b/i.test(message);
  const buyQuestion = /\bwhat(?:\s+(?:clothing|clothes|items?|pieces?))?\s+(?:should|could|can)\s+I\s+(?:buy|get|add)(?:\s+next)?\b/i.test(message);
  const recommendationVerb = /\b(?:recommend|suggest)\b/i.test(message)
    && (clothing || /\b(?:something|anything)\b/i.test(message));
  const recommendationNoun = /\b(?:recommendations?|suggestions?|picks?|recs)\b/i.test(message)
    && (clothing || /\b(?:my|chosen|selected)\s+(?:style|tracks?|paths?|pathways?)\b/i.test(message)
      || /^(?:(?:please|can you|could you|would you)\s+)?(?:give|send|show)\s+me\s+(?:a|one|some|a few)\s+(?:recommendations?|suggestions?|picks?|recs)[.!?]?$/i.test(message))
    && (/^(?:(?:please|can you|could you|would you)\s+)?(?:show|give|get|send|find|recommend)\b|^(?:can I get|I'd like|I would like|I want|I need)\b/i.test(message)
      || /^(?:(?:some|a few|a|one)\s+)?(?:clothing|clothes|shopping|garments?|items?|pieces?|recommendations?|suggestions?|picks?|recs)\b/i.test(message));
  const styleAddition = /\b(?:find|give|send|show)\b.*\b(?:something|a piece|an item)\b.*\b(?:style|tracks?|paths?|pathways?)\b/i.test(message);
  if (!buyQuestion && !recommendationVerb && !recommendationNoun && !styleAddition) return null;
  // Outfit advice and path generation remain their own actions.
  if (!namedGarment && /\b(?:outfits?|fits?|style\s+(?:paths?|tracks?|pathways?|directions?|options?))\b/i.test(message)
      && !clothing && !buyQuestion && !styleAddition) return null;
  const plural = /\b(?:a few|some|several|couple|options|items|pieces|picks|suggestions|recommendations|recs|clothes)\b/i.test(message);
  return { limit: plural ? 3 : 1, needsChosenStyle: !namedGarment };
}

export const RECOMMENDATION_INSTRUCTIONS = "Use only my one or two liked style pathways, confirmed wardrobe, previous item rejection reasons, and spending limits by clothing type. Choose a useful wardrobe addition from the selected pathways' proposed staples, not an item I already own. Supply Shopper criteria for one clothing category and shoppingPairing with a real saved wardrobe ID and a liked pathway ID, explaining why the combination works. Do not invent products or prices; the Shopper will provide the listings.";
