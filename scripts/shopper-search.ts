import { createGeminiGroundedShopperFromEnvironment } from "../src/shopper/gemini-research.ts";
import type { StylistShoppingRequest } from "../src/shopper/types.ts";

const input = process.argv.slice(2).join(" ");
if (!input) {
  console.error('Pass a JSON StylistShoppingRequest, for example: npm run shopper:search -- \'{"market":"US","preferredBrands":[],"referenceBrands":[],"keywords":["linen shirt"]}\'');
  process.exitCode = 2;
} else {
  try {
    const request = JSON.parse(input) as StylistShoppingRequest;
    const result = await createGeminiGroundedShopperFromEnvironment().search(request);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("Set GEMINI_API_KEY")
      ? error.message
      : error instanceof Error && error.message.startsWith("Budget ")
        ? error.message
        : "Shopper search failed; check the request, Gemini access, and model availability.";
    console.error(message);
    process.exitCode = 1;
  }
}
