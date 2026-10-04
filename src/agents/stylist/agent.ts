import { formatStylistPlan, parseStylistPlan } from "./plan.ts";
import type { StylistAnswer, StylistModel, StylistRequest, StylistShopper } from "./types.ts";
import { formatShopperResult } from "./shopper-results.ts";

export class StylistAgent {
  constructor(model: StylistModel, catalog: StylistShopper) { this.model = model; this.catalog = catalog; }
  private readonly model: StylistModel;
  private readonly catalog: StylistShopper;

  async respond(request: StylistRequest, signal?: AbortSignal): Promise<StylistAnswer> {
    if (!request.text.trim() || request.text.length > 10000) throw new Error("Stylist message must contain 1–10000 characters.");
    signal?.throwIfAborted();
    const plan = parseStylistPlan(await this.model.plan(request, signal), request.wardrobe);
    signal?.throwIfAborted();
    let shopping: StylistAnswer["shopping"] = null;
    let text = formatStylistPlan(plan);
    if (plan.shoppingCriteria !== null) {
      try {
        shopping = await this.catalog.search(plan.shoppingCriteria);
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
