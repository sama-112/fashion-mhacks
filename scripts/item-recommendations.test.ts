import assert from "node:assert/strict";
import { test } from "node:test";
import { StylistAgent } from "../src/agents/stylist/agent.ts";
import { GeminiStylistModel } from "../src/agents/stylist/gemini.ts";
import { clothingRecommendation } from "../src/agents/stylist/recommendations.ts";
import { emptyProfile, type StoredProfile, type StylistStore } from "../src/db/stylist-store.ts";
import { createStylistConversation } from "../src/services/stylist-conversation.ts";
import type { GroundedShopperResult, ShopperCriteria } from "../src/shopper/types.ts";

const wardrobe = [{ id:"jeans", description:"Levi's straight blue jeans", brand:"Levi's", category:"bottoms" as const, colors:["blue"], uncertain:false }];
const preferences = { pathways:[{ id:"smart", title:"Smart casual", description:"Clean relaxed layers", palette:["navy","white"], staples:["Navy cotton shirt"], ownedItemIds:["jeans"], status:"liked" as const }], preferences:[], pendingRejectionId:null };
const plan = { intro:"A navy cotton shirt adds a smart casual layer to your jeans.", outfits:[], questions:[],
  shoppingCriteria:{category:"tops" as const,keywords:["cotton","shirt"],colors:["navy"]},
  shoppingPairing:{wardrobeItemId:"jeans",pathwayId:"smart",rationale:"The clean shirt balances the relaxed denim."} };
const products = (amounts: readonly number[]): GroundedShopperResult => ({
  source:"gemini-google-search",retrievedAt:"2026-10-04T12:00:00.000Z",
  disclaimer:"Search-cited product details are not independently verified; prices can change and inventory is unverified.",
  products:amounts.map((amount,index)=>({id:`https://store.example/product/shirt-${index}`,name:`Navy cotton shirt ${index}`,brand:"Test brand",retailer:"Test store",
    productUrl:`https://store.example/product/shirt-${index}`,summary:"A navy cotton shirt",matchReason:"Cotton layers for smart casual style",brandMatch:"alternative",
    citation:{url:`https://store.example/product/shirt-${index}`},reportedPrice:{amount,currency:"USD",sourceUrl:`https://store.example/product/shirt-${index}`,status:"search-cited-unverified"},
    availability:{status:"unverified",note:"Confirm availability with the retailer before purchase."} })),
});
const who = {userId:"synthetic-user",conversationId:"synthetic-chat",messageId:"synthetic-message"};
class Memory implements StylistStore {
  profile=emptyProfile();
  async load(){return structuredClone(this.profile);}
  async commit(_who:unknown,_event:string,next:StoredProfile,text:string){this.profile=structuredClone(next);return text;}
  async saveVideo():Promise<string>{throw new Error("Unexpected video");}
}

test("natural clothing recommendations route separately from fits, path generation, ownership and feedback",()=>{
  for(const text of ["Recommend a clothing item for my track","Can you recommend me a jacket under $100?","what should I buy next?","clothing item recommendation","give me a recommendation","I want a clothing recommendation","recommend something","find something for my style"]) assert.ok(clothingRecommendation(text),text);
  assert.deepEqual(clothingRecommendation("recommend a jacket under $100"),{limit:1,needsChosenStyle:false});
  assert.deepEqual(clothingRecommendation("recommend some clothing items for my style"),{limit:3,needsChosenStyle:true});
  for(const text of ["give me a fit for today","recommend an outfit","suggest three style tracks","show style pathways","I don't like item 1","don't recommend jackets","show my wardrobe","I bought a shirt"])assert.equal(clothingRecommendation(text),null,text);
});

test("on-demand recommendations filter before choosing one actual listing and store only the displayed item",async()=>{
  const store=new Memory();store.profile.data.wardrobe=wardrobe;store.profile.data.pathways=preferences;
  store.profile.data.lastOutfits=[{name:"Saved denim fit",rationale:"Your current clothes",pieces:[{wardrobeItemId:"jeans",description:wardrobe[0]!.description}]}];
  const previousOutfits=structuredClone(store.profile.data.lastOutfits);
  store.profile.data.shopping.budgets.shirts={max:40,currency:"USD",evidence:"shirts under $40"};
  store.profile.data.shopping.budgets.jackets={max:150,currency:"USD",evidence:"jackets under $150"};
  store.profile.data.shopping.recentlySuggestedIds=["https://store.example/product/shirt-1"];
  store.profile.data.shopping.pendingRejection={id:"old",name:"Old shirt",category:"tops",spendingCategory:"shirts"};
  const searches:ShopperCriteria[]=[];
  const run=createStylistConversation({store,models:{text:"test",fallback:"test"},
    client:{models:{generateContent:async params=>{
      const input=JSON.parse(params.contents as string);
      assert.equal(input.message,"Recommend a clothing item under $40 for my track");
      assert.deepEqual(input.productRecommendation,{limit:1});
      assert.equal(input.stylePreferences.pathways[0].id,"smart");
      return {text:JSON.stringify({...plan,shoppingCriteria:{...plan.shoppingCriteria,budget:{max:40,currency:"USD"}}})};
    }}},catalog:{search:async criteria=>{searches.push(criteria);return products([70,30,35,38]);}},
    analyzer:{analyze:async()=>[]},downloadVideo:async()=>new Blob(),
  });
  const answer=await run({...who,text:"Recommend a clothing item under $40 for my track"},{eventId:"recommend"});
  assert.equal(searches.length,1);assert.equal(searches[0]?.budget?.max,40);
  assert.match(answer.text,/https:\/\/store.example\/product\/shirt-2/);
  assert.doesNotMatch(answer.text,/shirt-0|shirt-1|shirt-3|Item 2|like item 2/);
  assert.match(answer.text,/Pair with your saved wardrobe: Levi's straight blue jeans/);
  assert.match(answer.text,/Style path: Smart casual/);assert.match(answer.text,/like item 1/);
  assert.equal(store.profile.data.shopping.recommendations.length,1);
  assert.equal(store.profile.data.shopping.recommendations[0]?.id,"https://store.example/product/shirt-2");
  assert.equal(store.profile.data.shopping.pendingRejection?.id,"old");
  assert.deepEqual(store.profile.data.shopping.feedback,[]);assert.deepEqual(store.profile.data.wardrobe,wardrobe);
  assert.deepEqual(store.profile.data.lastOutfits,previousOutfits);
  assert.equal(store.profile.data.shopping.budgets.jackets?.max,150);
  const feedback=await run({...who,text:"I don't like item 1"},{eventId:"reject"});
  assert.match(feedback.text,/What don't you like about Navy cotton shirt 2/);
  assert.equal(store.profile.data.shopping.pendingRejection?.id,"https://store.example/product/shirt-2");
});

test("a recommendation cannot silently become advice, and fallback supplies the Shopper criteria",async()=>{
  const calls:string[]=[];
  const model=new GeminiStylistModel({models:{generateContent:async params=>{
    calls.push(params.model);return {text:JSON.stringify(calls.length===1?{...plan,shoppingCriteria:null,shoppingPairing:null}:plan)};
  }}},{text:"primary",fallback:"fallback"});
  const answer=await new StylistAgent(model,{search:async()=>products([35])}).respond({text:"Recommend an item",wardrobe,preferences,productRecommendation:{limit:1}});
  assert.deepEqual(calls,["primary","fallback"]);assert.equal(answer.shopping?.products.length,1);
  await assert.rejects(new StylistAgent({plan:async()=>({...plan,shoppingCriteria:{category:"tops"},shoppingPairing:plan.shoppingPairing})},{search:async()=>{assert.fail("Invalid criteria searched");}})
    .respond({text:"Recommend an item",wardrobe,preferences,productRecommendation:{limit:1}}),/invalid plan/);
});

test("necessary currency clarification and empty or failed searches never fabricate a store item",async()=>{
  const request={text:"Recommend a jacket under 80 EUR",wardrobe,preferences,productRecommendation:{limit:1 as const}};
  const clarify=await new StylistAgent({plan:async()=>({...plan,shoppingCriteria:null,shoppingPairing:null,questions:["What is your maximum in USD?"]})},{search:async()=>{assert.fail("Unclarified currency searched");}}).respond(request);
  assert.match(clarify.text,/maximum in USD/);assert.equal(clarify.shopping,null);
  const empty=await new StylistAgent({plan:async()=>plan},{search:async()=>products([])}).respond({...request,text:"Recommend an item"});
  assert.match(empty.text,/No cited product pages matched/);assert.doesNotMatch(empty.text,/Item 1|https:\/\//);
  const failed=await new StylistAgent({plan:async()=>plan},{search:async()=>{throw new Error("Private provider error");}}).respond({...request,text:"Recommend an item"});
  assert.match(failed.text,/Product search is unavailable/);assert.doesNotMatch(failed.text,/Private provider error|Item 1/);
});

test("generic recommendations offer style paths first, while named garment requests can search without prior likes",async()=>{
  const store=new Memory();store.profile.data.wardrobe=wardrobe;
  let searches=0,models=0;
  const run=createStylistConversation({store,models:{text:"test",fallback:"test"},client:{models:{generateContent:async params=>{
    models++;const input=JSON.parse(params.contents as string);
    if(input.generateOnly)return {text:JSON.stringify({action:"generate",targetId:null,targetIds:[],reason:null,pathways:["Relaxed","Clean","Bold"].map((title,i)=>({title,description:"An alternative style",palette:["navy"],staples:[["Navy shirt"],["Black bomber jacket"],["Brown boots"]][i],ownedItemIds:["jeans"]}))})};
    return {text:JSON.stringify({...plan,shoppingPairing:{...plan.shoppingPairing,pathwayId:null}})};
  }}},catalog:{search:async()=>{searches++;return products([35]);}},analyzer:{analyze:async()=>[]},downloadVideo:async()=>new Blob()});
  const onboarding=await run({...who,text:"recommend a clothing item"},{eventId:"onboarding"});
  assert.match(onboarding.text,/Choose one or two style paths first/);assert.equal(searches,0);assert.equal(store.profile.data.pathways.pathways.length,3);
  const named=await run({...who,text:"recommend a navy shirt under $40"},{eventId:"named"});
  assert.match(named.text,/https:\/\/store.example\/product\/shirt-0/);assert.equal(searches,1);assert.equal(models,2);
});
