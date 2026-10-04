import type { StylistShopperResult } from "./types.ts";

// Present the Shopper's returned facts directly; Gemini never invents listings.
export function formatShopperResult(result: StylistShopperResult): string {
  if (result.source === "gemini-google-search") {
    const lines: string[] = [result.disclaimer];
    if (!result.products.length) {
      lines.push("No cited product pages matched those criteria. Try a different color, size, or budget.");
    }
    for (const [index, product] of result.products.slice(0, 3).entries()) {
      const price = product.reportedPrice
        ? `\nReported price (verify with retailer): ${product.reportedPrice.amount.toFixed(2)} ${product.reportedPrice.currency}`
        : "\nPrice not reported; check the retailer against your budget.";
      lines.push(`Item ${index + 1}: ${product.name} — ${product.brand} at ${product.retailer}\n${product.productUrl}${price}\nWhy it matches: ${product.matchReason}\n${product.availability.note}`);
    }
    if (result.products.length) lines.push('Tell me "I don\'t like item 2" and I\'ll ask why.');
    return lines.join("\n\n");
  }
  const lines: string[] = [result.disclaimer];
  if (!result.products.length) {
    lines.push("No sample products match those criteria. Try a different color, size, or budget.");
  }
  for (const [index, product] of result.products.slice(0, 3).entries()) {
    lines.push(`Item ${index + 1}: ${product.name} — ${product.brand}\nIllustrative price: ${product.price.amount.toFixed(2)} ${product.price.currency}\nColors: ${product.colors.join(", ")}; sample sizes: ${product.sizes.join(", ")}\n${product.availability.note}`);
  }
  return lines.join("\n\n");
}
