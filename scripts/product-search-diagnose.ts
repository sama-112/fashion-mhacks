// Synthetic product search only. Prints provider counts/statuses, never private chat or raw errors.
import { GoogleGenAI, type GenerateContentParameters } from "@google/genai";
import { required, geminiModels } from "../src/config.ts";
import { createGoogleSearchGroundedShopper } from "../src/shopper/index.ts";
import { createStylistProductResearcher } from "../src/agents/stylist/product-search.ts";

async function main() {
  const client=new GoogleGenAI({apiKey:required("GEMINI_API_KEY")});
  const observed={models:{generateContent:async(params:GenerateContentParameters)=>{
    const started=Date.now();
    try {
      const response=await client.models.generateContent(params);
      console.log(JSON.stringify({model:params.model,elapsedMs:Date.now()-started,responseChars:response.text?.length??0,
        productBlocks:(response.text?.match(/^(?:\d+\.\s*)?PRODUCT:/gm)??[]).length,
        groundingSources:response.candidates?.[0]?.groundingMetadata?.groundingChunks?.length??0,
        blocked:!!response.promptFeedback?.blockReason,outputLimited:response.candidates?.[0]?.finishReason==="MAX_TOKENS",
        outputTokens:response.usageMetadata?.candidatesTokenCount,thinkingTokens:response.usageMetadata?.thoughtsTokenCount}));
      return response;
    } catch(error) {
      const code=typeof error==="object"&&error!==null&&"status" in error?Number(error.status):NaN;
      const text=error instanceof Error?error.message:"";
      console.log(JSON.stringify({model:params.model,elapsedMs:Date.now()-started,
        errorStatus:Number.isInteger(code)&&code>=400&&code<=599?code:undefined,
        quotaFailure:/quota|rate.?limit|resource.?exhausted/i.test(text),timeoutFailure:/timeout|timed out|aborted/i.test(text)}));
      throw error;
    }
  }}};
  const models=geminiModels();
  const factory=process.argv.includes("--original")?createGoogleSearchGroundedShopper:createStylistProductResearcher;
  const researcher=factory(observed as Parameters<typeof createGoogleSearchGroundedShopper>[0],{primary:models.text,fallback:models.fallback});
  const result=await researcher.search({market:"US",category:"tops",keywords:["navy","cotton","polo"],budget:{max:60,currency:"USD"},preferredBrands:[],referenceBrands:[],maxResults:3});
  console.log(JSON.stringify({parsedStoreCandidates:result.products.length,relayMessagesSent:0,userProfilesRead:0,userProfilesChanged:0}));
}
main().catch(()=>{console.error("Synthetic product search diagnostic failed; no private messages or provider errors were printed.");process.exitCode=1;});
