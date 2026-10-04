import { ThinkingLevel, type GoogleGenAI } from "@google/genai";
import { GeminiGroundedShopper, type ShopperModels } from "../../shopper/gemini-research.ts";
import type { ProductResearcher, ProductCitation } from "../../shopper/types.ts";

export interface SearchDiagnostic {
  readonly outcome: "response" | "provider-error" | "empty-primary";
  readonly elapsedMs: number;
  readonly httpStatus?: number;
  readonly timedOut?: boolean;
  readonly sources?: number;
  readonly outputLimited?: boolean;
}

/** The Stylist owns provider settings; product parsing/citation checks remain the partner's. */
export function createStylistProductResearcher(
  client: Pick<GoogleGenAI, "models">,
  models: ShopperModels,
  observe: (diagnostic: SearchDiagnostic) => void = diagnostic => console.log(`Product search: ${JSON.stringify(diagnostic)}`),
): ProductResearcher {
  const search = async ({model,prompt}: {model:string;prompt:string}) => {
    const started=Date.now();
    try {
      const response=await client.models.generateContent({model,contents:prompt,config:{
        tools:[{googleSearch:{}}],maxOutputTokens:6144,
        ...(/^gemini-3(?:[.-])/.test(model) ? {thinkingConfig:{thinkingLevel:/^gemini-3\.[56]-flash(?:$|-)/.test(model)?ThinkingLevel.MINIMAL:ThinkingLevel.LOW}} : {}),
        httpOptions:{timeout:45000,retryOptions:{attempts:2}},
      }});
      const citations:ProductCitation[]=[];
      for(const chunk of response.candidates?.[0]?.groundingMetadata?.groundingChunks??[]) {
        if(chunk.web?.uri)citations.push({title:chunk.web.title,url:chunk.web.uri});
      }
      observe({outcome:"response",elapsedMs:Date.now()-started,sources:citations.length,outputLimited:response.candidates?.[0]?.finishReason==="MAX_TOKENS"});
      return {text:response.text??"",citations};
    } catch(error) {
      const status=typeof error==="object"&&error!==null&&"status" in error?Number(error.status):NaN;
      observe({outcome:"provider-error",elapsedMs:Date.now()-started,
        ...(Number.isInteger(status)&&status>=400&&status<=599?{httpStatus:status}:{}),
        timedOut:error instanceof Error&&/timeout|timed out|aborted/i.test(error.message)});
      throw error;
    }
  };
  const primary=new GeminiGroundedShopper(search,models);
  const fallback=new GeminiGroundedShopper(search,{primary:models.fallback,fallback:models.fallback});
  return {search:async request=>{
    const result=await primary.search(request);
    if(result.products.length||models.primary===models.fallback)return result;
    // An empty parsed primary used to stop immediately, even if the fallback could find cited pages.
    observe({outcome:"empty-primary",elapsedMs:0});
    try{return await fallback.search(request);}catch{return result;}
  }};
}
