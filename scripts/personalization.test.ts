import assert from "node:assert/strict";
import { test } from "node:test";
import { handleItemFeedback } from "../src/preferences/feedback.ts";
import { applyCategoryBudget, emptyShoppingPreferences, filterShoppingResult, rememberRecommendations } from "../src/preferences/types.ts";
import { StylistAgent } from "../src/agents/stylist/agent.ts";
import { MockProductCatalog } from "../src/shopper/index.ts";
import { emptyProfile, type StoredProfile, type StylistIdentity, type StylistStore } from "../src/db/stylist-store.ts";
import { createStylistConversation } from "../src/services/stylist-conversation.ts";
import type { ConversationReply } from "../src/services/conversation.ts";
import { handleWeeklySettings, emptyWeeklySettings, WEEK_MS } from "../src/weekly/types.ts";
import { createWeeklyTick } from "../src/weekly/scheduler.ts";

const now = new Date("2026-10-04T14:00:00Z");
const shirt = { id:"shirt-1",name:"Linen Shirt",category:"tops" as const,spendingCategory:"shirts" as const,price:{amount:80,currency:"USD"} };

test("item rejection asks why, remembers the actual price reason, then saves only the item's clothing budget", () => {
  const state=emptyShoppingPreferences(); state.recommendations=[shirt];
  assert.match(handleItemFeedback("I don’t like item 1",state,now)!,/What don't you like/);
  assert.equal(state.feedback.length,0);
  assert.match(handleItemFeedback("price",state,now)!,/maximum in USD for shirts/);
  assert.equal(state.feedback[0]!.reason,"price");
  assert.equal(state.feedback[0]!.evidence,"price");
  assert.deepEqual(state.budgets,{});
  assert.match(handleItemFeedback("$40",state,now)!,/shirts at or below \$40/);
  assert.equal(state.budgets.shirts?.max,40);
  assert.equal(state.budgets.jackets,undefined);
  assert.equal(state.pendingBudget,null);
});

test("explicit shirt and jacket budgets remain separate and unrelated searches aren't consumed as settings", () => {
  const state=emptyShoppingPreferences();
  assert.match(handleItemFeedback("shirts under $40; jackets under $150",state,now)!,/Saved separate/);
  assert.equal(state.budgets.shirts?.max,40); assert.equal(state.budgets.jackets?.max,150);
  assert.equal(handleItemFeedback("Find shirts under $50",state,now),null);
  assert.equal(applyCategoryBudget({category:"tops",keywords:["shirt"],budget:{min:60,max:100,currency:"USD"}},state).budget?.max,40);
  assert.equal(applyCategoryBudget({category:"tops",keywords:["shirt"],budget:{min:60,max:100,currency:"USD"}},state).budget?.min,undefined);
  assert.equal(applyCategoryBudget({category:"outerwear",keywords:["jacket"]},state).budget?.max,150);
  assert.equal(applyCategoryBudget({category:"tops",keywords:["sweater"]},state).budget,undefined);
});

test("color feedback doesn't lower budgets, unknown item numbers don't mutate state, and unrelated questions preserve pending feedback", () => {
  const state=emptyShoppingPreferences(); state.recommendations=[shirt];
  handleItemFeedback("I don't like item 9",state,now);
  assert.equal(Boolean(state.pendingRejection),false);
  handleItemFeedback("I don't like item 1",state,now);
  assert.equal(handleItemFeedback("Show style pathways",state,now),null);
  assert.equal(state.pendingRejection?.id,shirt.id);
  handleItemFeedback("the color",state,now);
  assert.equal(state.feedback[0]!.reason,"color"); assert.deepEqual(state.budgets,{});
});

test("a reported price is not an invented spending cap, and non-USD budgets aren't silently interpreted as USD", () => {
  const state=emptyShoppingPreferences(); state.recommendations=[shirt];
  handleItemFeedback("I don't like item 1 because the price is $80",state,now);
  assert.deepEqual(state.budgets,{});
  assert.match(handleItemFeedback("40 CAD",state,now)!,/currently use USD/);
  assert.deepEqual(state.budgets,{});
});

test("Stylist enforces saved budgets before calling Shopper and filters rejected and over-budget results", async () => {
  const state=emptyShoppingPreferences(); state.budgets.shirts={max:40,currency:"USD",evidence:"shirts under $40"};
  let received: unknown;
  const stylist=new StylistAgent({plan:async()=>({intro:"Shirts for you.",outfits:[],questions:[],shoppingCriteria:{category:"tops",keywords:["shirt"]}})},{search:async criteria=>{received=criteria; return new MockProductCatalog().search({category:"tops"});}});
  const response=await stylist.respond({text:"Find a shirt",shoppingPreferences:state});
  assert.equal((received as {budget:{max:number}}).budget.max,40);
  assert.ok(response.shopping?.products.every(product=>"price" in product && product.price.amount<=40));
  const result=await new MockProductCatalog().search({category:"tops"});
  state.feedback=[{item:{...shirt,id:result.products[0]!.id},reason:"color",evidence:"too blue",recordedAt:now.toISOString()}];
  assert.ok(!filterShoppingResult(result,{},state).products.some(item=>item.id===result.products[0]!.id));
  state.recentlySuggestedIds=result.products.map(product=>product.id);
  assert.equal(filterShoppingResult(result,{},state,true).products.length,0);
  assert.equal(rememberRecommendations(result,{category:"tops"})[0]?.spendingCategory,"shirts");
  state.feedback=[]; state.recentlySuggestedIds=[];
  const broad = filterShoppingResult(result,{category:"tops"},state);
  assert.ok(broad.products.every(item=>!/shirt/i.test(item.name) || ("price" in item && item.price.amount<=40)));
  assert.deepEqual(broad.products.filter(item=>!/shirt/i.test(item.name)),result.products.filter(item=>!/shirt/i.test(item.name)));
});

test("weekly enrollment is idempotent, schedules seven days later, and can be paused", () => {
  const settings=emptyWeeklySettings();
  handleWeeklySettings("weekly on",settings,now);
  assert.equal(settings.nextDueAt,new Date(now.getTime()+WEEK_MS).toISOString());
  handleWeeklySettings("weekly on",settings,new Date(now.getTime()+1000));
  assert.equal(settings.nextDueAt,new Date(now.getTime()+WEEK_MS).toISOString());
  assert.match(handleWeeklySettings("weekly status",settings,now)!,/Next scheduled batch/);
  handleWeeklySettings("weekly off",settings,now);
  assert.equal(settings.enabled,false); assert.equal(settings.nextDueAt,null);
});

test("weekly maintenance polls once per minute and retries an unavailable queue", async () => {
  let clock=0,calls=0; const tick=createWeeklyTick({enqueueDue:async()=>{calls++;if(calls===1)throw new Error("offline");return 1;}},()=>clock);
  await assert.rejects(tick()); await tick(); await tick(); assert.equal(calls,2);
  clock=60001; await tick(); assert.equal(calls,3);
});

class MemoryStore implements StylistStore {
  data=new Map<string,StoredProfile>(); replies=new Map<string,ConversationReply>();
  async load(identity:StylistIdentity) {return structuredClone(this.data.get(`${identity.userId}:${identity.conversationId}`)??emptyProfile());}
  async commit(identity:StylistIdentity,event:string,profile:StoredProfile,text:string) {return (await this.commitResponse(identity,event,profile,{text})).text;}
  async commitResponse(identity:StylistIdentity,event:string,profile:StoredProfile,reply:ConversationReply) {
    if(this.replies.has(event))return structuredClone(this.replies.get(event)!);
    this.data.set(`${identity.userId}:${identity.conversationId}`,structuredClone({...profile,version:profile.version+1}));this.replies.set(event,structuredClone(reply));return reply;
  }
  async saveVideo(){return "private/video.mp4";}
}
const identity={userId:"user-1",conversationId:"chat-1",messageId:"message-1"};
const modelPlan={intro:"Try this.",outfits:[{name:"Casual",rationale:"Easy to combine.",pieces:[{description:"Blue shirt",wardrobeItemId:null}]}],questions:[],shoppingCriteria:null};
function handler(store:MemoryStore, shopping=false, images?: Parameters<typeof createStylistConversation>[0]["images"]) {
  return createStylistConversation({store,models:{text:"test",fallback:"test"},catalog:new MockProductCatalog(),
    client:{models:{generateContent:async()=>({text:JSON.stringify({...modelPlan,shoppingCriteria:shopping?{category:"tops",keywords:["shirt"]}:null})})}},
    analyzer:{analyze:async()=>[]},downloadVideo:async()=>new Blob(),images,now:()=>now});
}

test("weekly preview, rejection memory and budgets survive new handlers and stay isolated by user/chat", async () => {
  const store=new MemoryStore();const run=handler(store,true);
  await run({...identity,text:"weekly on"},{eventId:"on"});
  const due=(await store.load(identity)).data.weekly.nextDueAt;
  const preview=await run({...identity,text:"weekly picks now"},{eventId:"picks"});
  assert.match(preview.text,/weekly clothing picks/);assert.ok((await store.load(identity)).data.shopping.recommendations.length);
  assert.equal((await store.load(identity)).data.weekly.nextDueAt,due);
  await run({...identity,text:"I don't like item 1"},{eventId:"reject"});
  await handler(store)({...identity,text:"price"},{eventId:"reason"});
  await handler(store)({...identity,text:"$30"},{eventId:"budget"});
  assert.equal((await store.load(identity)).data.shopping.budgets.shirts?.max,30);
  assert.equal((await store.load({...identity,userId:"other"})).data.shopping.budgets.shirts,undefined);
});

test("paused weekly events do not invoke Gemini or send a message", async () => {
  const store=new MemoryStore();const reply=await handler(store)({...identity,text:"Weekly clothing suggestions",deliveryKind:"weekly"},{eventId:"scheduled"});
  assert.equal(reply.skipDelivery,true);assert.equal(store.replies.size,0);
});

test("outfit image responses persist the attachment together with the caption and preserve wardrobe", async () => {
  const store=new MemoryStore();let calls=0;
  const run=handler(store,false,{generate:async(_identity,event,outfit)=>{calls++;assert.equal(event,"image");assert.equal(outfit.pieces[0]!.description,"Blue shirt");return {attachmentId:"00000000-0000-4000-8000-000000000001",mimeType:"image/png"};}});
  await run({...identity,text:"Style a shirt"},{eventId:"outfit"});
  const reply=await run({...identity,text:"generate outfit image 1"},{eventId:"image"});
  assert.match(reply.text,/AI-generated outfit concept/);assert.equal(reply.images?.length,1);
  assert.deepEqual(store.replies.get("image"),reply);assert.equal(calls,1);assert.equal((await store.load(identity)).data.wardrobe.length,0);
  const missing=await run({...identity,text:"generate outfit image 9"},{eventId:"unknown"});
  assert.equal(missing.images,undefined);assert.equal(calls,1);
});

test("a specific image request plans new clothes instead of reusing the previous outfit", async () => {
  const store=new MemoryStore(); const profile=emptyProfile(); profile.data.lastOutfits=modelPlan.outfits;
  store.data.set(`${identity.userId}:${identity.conversationId}`,profile);
  let plans=0;
  const run=createStylistConversation({store,models:{text:"test",fallback:"test"},catalog:{search:async()=>{throw new Error("Unexpected shopping call");}},
    client:{models:{generateContent:async()=>{plans++;return {text:JSON.stringify({...modelPlan,outfits:[{name:"New outfit",rationale:"Requested black shirt",pieces:[{description:"Black shirt",wardrobeItemId:null}]}]})};}}},
    analyzer:{analyze:async()=>[]},downloadVideo:async()=>new Blob(),
    images:{generate:async(_identity,_event,outfit)=>{assert.equal(outfit.pieces[0]!.description,"Black shirt");return {attachmentId:"00000000-0000-4000-8000-000000000002",mimeType:"image/png"};}}});
  const reply=await run({...identity,text:"Generate an outfit image of a black shirt"},{eventId:"new-image"});
  assert.equal(plans,1); assert.equal(reply.images?.length,1); assert.match(reply.text,/Black shirt/);
});
