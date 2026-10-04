// Real Gemini checks using synthetic clothes only. No Relay messages or saved user profiles.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { geminiImageModel, geminiModels, required } from "../src/config.ts";
import { PathwayService, emptyPathwayState, pathwayOutfit } from "../src/pathways/service.ts";
import { GeminiStylistModel } from "../src/agents/stylist/gemini.ts";
import { StylistAgent } from "../src/agents/stylist/agent.ts";
import { GeminiOutfitImages, type OutfitImageAssets } from "../src/images/outfits.ts";

async function main() {
  const client=new GoogleGenAI({apiKey:required("GEMINI_API_KEY")});const models=geminiModels();
  const wardrobe=[
    {id:"tee",description:"Uniqlo plain white T-shirt",brand:"Uniqlo"},
    {id:"jeans",description:"Levi's straight blue jeans",brand:"Levi's"},
    {id:"chinos",description:"Beige chinos",brand:null},
    {id:"sneakers",description:"White low-top sneakers",brand:null},
    {id:"shirt",description:"Blue button-down shirt",brand:null},
  ];
  const paths=new PathwayService(client,models);
  const first=await paths.handle({text:"Give me three different style paths based on these clothes, requiring only one or two additions each",wardrobe,generateOnly:true},emptyPathwayState());
  assert.equal(first?.generated?.length,3);
  const chosen=await paths.handle({text:"I like 1 and 3",wardrobe},first!.state);
  assert.equal(chosen?.state.pathways.filter(p=>p.status==="liked").length,2);
  const catalog={search:async()=>{throw new Error("Unexpected product search");}};
  const stylist=new StylistAgent(new GeminiStylistModel(client,models),catalog);
  const fit=await stylist.respond({text:"Give me a fit for today. I was interested in a Gucci jacket last week but have not bought it.",wardrobe,preferences:chosen!.state,outfitMode:"closet"});
  assert.ok(fit.plan.outfits.length);assert.ok(fit.plan.outfits.every(o=>o.pieces.every(p=>p.wardrobeItemId&&wardrobe.some(w=>w.id===p.wardrobeItemId))));
  const shoppingPlan=await new GeminiStylistModel(client,models).plan({text:"Find me a jacket that follows one of my liked style paths and pairs with clothes I own.",wardrobe,preferences:chosen!.state,outfitMode:"closet"}) as typeof fit.plan;
  assert.ok(shoppingPlan.shoppingCriteria);assert.ok(shoppingPlan.shoppingPairing?.wardrobeItemId);
  assert.ok(chosen!.state.pathways.some(p=>p.id===shoppingPlan.shoppingPairing?.pathwayId&&p.status==="liked"));
  console.log(JSON.stringify({realGeminiPaths:3,likedPaths:2,closetOnlyFit:true,shoppingPairing:true}));
  const slots=new Map<number,{image:Blob;attachment:null|{attachmentId:string;mimeType:string}}>();
  const assets:OutfitImageAssets={load:async(_who,_event,slot=0)=>slots.get(slot)??null,save:async(_who,_event,image,slot=0)=>{slots.set(slot,{image,attachment:null});},attach:async(_who,_event,attachment,slot=0)=>{slots.get(slot)!.attachment=attachment;}};
  const images=new GeminiOutfitImages(client,geminiImageModel(),assets,async blob=>({attachmentId:randomUUID(),mimeType:blob.type}));
  const identity={userId:"synthetic",conversationId:"synthetic"};
  const pictures=await Promise.all(first!.generated!.map((path,slot)=>images.generate(identity,"synthetic",pathwayOutfit(path,wardrobe),undefined,null,slot)));
  assert.equal(pictures.length,3);assert.equal(slots.size,3);
  console.log(JSON.stringify({realGeminiImages:3,distinctSlots:slots.size,relayMessagesSent:0,userProfilesChanged:0}));
}
main().catch(()=>{console.error("Style experience smoke failed; no credentials, prompts or provider response were logged.");process.exitCode=1;});
