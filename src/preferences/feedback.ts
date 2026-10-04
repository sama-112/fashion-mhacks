import { productCategory, spendingCategory, type ShoppingPreferences, type SpendingCategory } from "./types.ts";

function usdAmount(text: string): number | null {
  if (/\b(?:CAD|EUR|GBP|AUD|euros?|pounds?|canadian)\b/i.test(text)) return null;
  const match = text.match(/(?:\$|\bUSD\s*)(\d+(?:\.\d{1,2})?)/i)
    ?? text.match(/\b(?:under|below|up to|max(?:imum)?|budget(?: is| of)?|spend(?: up to)?)\s*\$?(\d+(?:\.\d{1,2})?)\b/i)
    ?? text.match(/^\s*(\d+(?:\.\d{1,2})?)(?:\s*USD)?[.!]?\s*$/i);
  const value = Number(match?.[1]);
  return match && Number.isFinite(value) && value > 0 && value <= 100000 ? value : null;
}

function reasonFor(text: string): "price" | "color" | "fit" | "style" | "material" | "other" {
  if (/\b(?:price|prices|cost|costs|costly|expensive|cheap|cheaper|budget|afford|spend)\b/i.test(text)) return "price";
  if (/\b(?:colou?r|blue|red|green|black|white|pink|brown|yellow|purple|orange)\b/i.test(text)) return "color";
  if (/\b(?:fit|size|tight|loose|baggy|small|large|short|long)\b/i.test(text)) return "fit";
  if (/\b(?:fabric|material|cotton|polyester|linen|wool|itchy)\b/i.test(text)) return "material";
  if (/\b(?:style|formal|casual|look|vibe|pattern)\b/i.test(text)) return "style";
  return "other";
}

// Commands and quoted feedback are parsed without allowing a model to invent a reason or budget.
export function handleItemFeedback(text: string, state: ShoppingPreferences, now = new Date()): string | null {
  const evidence = text.trim().slice(0, 1000);
  if (/^(?:show|my|view) (?:budgets|spending preferences)$/i.test(evidence)) {
    const limits = Object.entries(state.budgets).map(([category, budget]) => `${category}: up to $${budget!.max.toFixed(2)} USD`);
    return limits.length ? `Your spending limits:\n${limits.join("\n")}` : "You haven't set category spending limits yet. Try: shirts under $40; jackets under $150.";
  }
  if (/^(?:cancel feedback|never mind|nevermind)$/i.test(evidence) && (state.pendingRejection || state.pendingBudget)) {
    state.pendingRejection = null; state.pendingBudget = null;
    return "Canceled that feedback question. Your saved preferences remain available.";
  }

  // Accept multiple explicit category limits in a single message.
  const clauses = evidence.split(/[,;\n]|\band\b/i);
  const settings: { category: SpendingCategory; amount: number }[] = [];
  for (const clause of /\b(?:find|search|shop|suggest|recommend|show)\b/i.test(evidence) ? [] : clauses) {
    const category = spendingCategory(clause);
    const amount = usdAmount(clause);
    if (category && amount !== null && /\b(?:budget|max(?:imum)?|under|below|up to|spend|limit)\b/i.test(clause)) settings.push({ category, amount });
  }
  if (settings.length) {
    for (const { category, amount } of settings) state.budgets[category] = { max: amount, currency: "USD", evidence };
    state.pendingBudget = null;
    // If this answers an item's price question, retain the rejection too.
    if (state.pendingRejection) {
      state.feedback = [...state.feedback, { item: state.pendingRejection, reason: "price" as const, evidence, recordedAt: now.toISOString() }].slice(-100);
      state.pendingRejection = null;
    }
    return `Saved separate spending limits: ${settings.map(item => `${item.category} up to $${item.amount.toFixed(2)} USD`).join("; ")}. I'll use them when searching and making weekly suggestions.`;
  }
  if (state.pendingBudget) {
    const amount = usdAmount(evidence);
    if (amount !== null) {
      const category = state.pendingBudget;
      state.budgets[category] = { max: amount, currency: "USD", evidence };
      state.pendingBudget = null;
      return `I'll keep ${category} at or below $${amount.toFixed(2)} USD. Your other clothing budgets stay separate.`;
    }
    if (/\b(?:CAD|EUR|GBP|AUD|euros?|pounds?)\b/i.test(evidence)) return "Spending limits currently use USD. What USD maximum would you like?";
  }

  const rejection = evidence.match(/(?:\b(?:reject|dislike|hate)|\b(?:don['’]t|dont|do not)\s+like|\bnot\s+(?:into|a fan of))\s+(?:the\s+)?(?:clothing\s+)?(?:item|product|suggestion)\s*(\d+)/i);
  if (rejection) {
    const item = state.recommendations[Number(rejection[1]) - 1];
    if (!item) return "Which product do you mean? Use an item number from my latest shopping suggestions, such as: I don't like item 2.";
    state.pendingRejection = item;
    state.pendingBudget = null;
    const suppliedReason = evidence.slice((rejection.index ?? 0) + rejection[0].length).replace(/^\s*[,.:—-]?\s*(?:because\s+|it(?:['’]s| is)\s+)?/i, "").replace(/\s*please[.!]?$/i,"").trim();
    if (!suppliedReason) return `What don't you like about ${item.name}—price, color, fit, material, style, or something else?`;
    return recordReason(suppliedReason, evidence, state, now);
  }
  if (state.pendingRejection) {
    // Don't consume an unrelated request as the answer to "why".
    if (/\b(?:show|find|search|generate|picture|pathway|wardrobe|weekly|outfit|shop)\b/i.test(evidence)) return null;
    if (/^(?:yes|no|ok|okay|idk|not sure)$/i.test(evidence)) return "What specifically bothers you about that item: price, color, fit, material, style, or something else?";
    return recordReason(evidence, evidence, state, now);
  }
  return null;
}

function recordReason(reason: string, evidence: string, state: ShoppingPreferences, now: Date): string {
  const item = state.pendingRejection!;
  const kind = reasonFor(reason);
  state.feedback = [...state.feedback, { item, reason: kind, evidence, recordedAt: now.toISOString() }].slice(-100);
  state.pendingRejection = null;
  if (kind !== "price") return `Thanks—I've saved your feedback about ${item.name}. I'll consider it in future ${item.spendingCategory} suggestions and avoid recommending that item again.`;
  state.pendingBudget = item.spendingCategory;
  const amount = /\b(?:under|below|budget|max(?:imum)?|up to|spend|limit)\b/i.test(reason) ? usdAmount(reason) : null;
  if (amount !== null) {
    state.budgets[item.spendingCategory] = { max: amount, currency: "USD", evidence };
    state.pendingBudget = null;
    return `Saved: ${item.spendingCategory} up to $${amount.toFixed(2)} USD. I'll look for cheaper ${item.spendingCategory} without lowering your other clothing budgets.`;
  }
  // A price objection conveys affordability, but does not tell us an exact numeric limit.
  return `Got it—the price is too high for ${item.spendingCategory}. What is your maximum in USD for ${item.spendingCategory}? I'll keep that separate from ${productCategory(item.spendingCategory) === "outerwear" ? "shirts" : "jackets"} and other clothing.`;
}
