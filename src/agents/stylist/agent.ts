import { formatStylistPlan, parseStylistPlan } from "./plan.ts";
import type { StylistAnswer, StylistModel, StylistRequest, StylistShopper } from "./types.ts";
import { formatShopperResult } from "./shopper-results.ts";
import { applyCategoryBudget, filterShoppingResult } from "../../preferences/types.ts";

export class StylistAgent {
  constructor(model: StylistModel, catalog: StylistShopper) { this.model = model; this.catalog = catalog; }
  private readonly model: StylistModel;
  private readonly catalog: StylistShopper;

  async respond(request: StylistRequest, signal?: AbortSignal): Promise<StylistAnswer> {
    if (!request.text.trim() || request.text.length > 10000) throw new Error("Stylist message must contain 1–10000 characters.");
    signal?.throwIfAborted();
    const parsed = parseStylistPlan(await this.model.plan(request, signal), request.wardrobe);
    const plan = { ...parsed, shoppingCriteria: parsed.shoppingCriteria ? applyCategoryBudget(parsed.shoppingCriteria, request.shoppingPreferences) : null };
    signal?.throwIfAborted();
    let shopping: StylistAnswer["shopping"] = null;
    let text = formatStylistPlan(plan);
    if (plan.shoppingCriteria !== null) {
      try {
        shopping = filterShoppingResult(await this.catalog.search(plan.shoppingCriteria), plan.shoppingCriteria, request.shoppingPreferences,request.avoidRecentProducts);
        signal?.throwIfAborted();
        text += `\n\n${formatShopperResult(shopping)}`;
      } catch {
        signal?.throwIfAborted();
        text += "\n\nProduct search is unavailable right now. Try again shortly; no purchase has been made.";
      }
    }
    return { plan, shopping, text };
  }
}
