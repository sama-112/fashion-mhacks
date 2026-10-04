// Live Stylist -> partner Shopper check, using synthetic preferences only.
// No Relay messages, saved user profiles, purchases or private provider output.
import assert from "node:assert/strict";
import { GoogleGenAI } from "@google/genai";
import { geminiModels, required } from "../src/config.ts";
import { emptyProfile, type StoredProfile, type StylistStore } from "../src/db/stylist-store.ts";
import { createStylistConversation } from "../src/services/stylist-conversation.ts";
import { createStylistProductResearcher } from "../src/agents/stylist/product-search.ts";
import type { GroundedShopperResult } from "../src/shopper/types.ts";

let stage="configuration";
async function main() {
  const client=new GoogleGenAI({apiKey:required("GEMINI_API_KEY")});
  const models=geminiModels();
  let profile=emptyProfile();
  profile.data.wardrobe=[
    {id:"jeans",description:"Levi's straight blue jeans",brand:"Levi's",category:"bottoms",colors:["blue"],uncertain:false},
    {id:"tee",description:"Uniqlo white T-shirt",brand:"Uniqlo",category:"tops",colors:["white"],uncertain:false},
    {id:"shoes",description:"White low-top sneakers",brand:null,category:"footwear",colors:["white"],uncertain:false},
  ];
  profile.data.pathways={...profile.data.pathways,pathways:[{id:"smart",title:"Smart casual",description:"Clean relaxed layers with denim and simple shoes",palette:["navy","white","blue"],staples:["Navy cotton polo shirt"],ownedItemIds:["jeans","shoes"],status:"liked"}]};
  profile.data.shopping.budgets.shirts={max:60,currency:"USD",evidence:"shirts under $60"};
  const originalWardrobe=structuredClone(profile.data.wardrobe);
  const store:StylistStore={load:async()=>structuredClone(profile),commit:async(_who,_event,next:StoredProfile,text)=>{profile=structuredClone(next);return text;},saveVideo:async()=>{throw new Error("Unexpected media");}};
  const researcher=createStylistProductResearcher(client,{primary:models.text,fallback:models.fallback});
  let result:GroundedShopperResult|undefined;
  const run=createStylistConversation({client,models,store,catalog:{search:async criteria=>{
    stage="criteria-validation";
    assert.ok(criteria.category);assert.ok(criteria.keywords?.length);assert.ok(criteria.budget?.max!==undefined&&criteria.budget.max<=60);
    stage="grounded-search";
    result=await researcher.search({...criteria,market:"US",preferredBrands:[],referenceBrands:[],maxResults:3});return result;
  }},analyzer:{analyze:async()=>[]},downloadVideo:async()=>new Blob()});
  stage="stylist-planning";
  const response=await run({userId:"synthetic",conversationId:"synthetic",messageId:"synthetic",text:"Can you recommend a clothing item for my track under $60?"},{eventId:"synthetic"});
  stage="listing-verification";
  console.log(JSON.stringify({groundedSearchReturned:result!==undefined,storeCandidates:result?.products.length??0,displayedItems:profile.data.shopping.recommendations.length}));
  assert.equal(result?.source,"gemini-google-search");assert.ok(result.products.length);
  assert.equal(profile.data.shopping.recommendations.length,1);
  const item=profile.data.shopping.recommendations[0]!;
  assert.ok(item.url&&result.products.some(p=>p.productUrl===item.url));assert.ok(!item.price||item.price.amount<=60);
  assert.ok(response.text.includes(item.url!));assert.match(response.text,/Pair with your saved wardrobe:/);
  assert.match(response.text,/Style path: Smart casual/);assert.match(response.text,/Search-cited product details are not independently verified/);
  assert.doesNotMatch(response.text,/MOCK DATA|Item 2/);assert.deepEqual(profile.data.wardrobe,originalWardrobe);
  console.log(JSON.stringify({liveGeminiRecommendation:true,partnerGroundedShopper:true,citedStoreItem:1,likedTrackPairing:true,budgetEnforced:true,relayMessagesSent:0,userProfilesChanged:0}));
}
main().catch(()=>{console.error(`Item recommendation smoke failed at ${stage}; no credentials or private provider output were logged.`);process.exitCode=1;});
