import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { emptyProfile, type PreparedImageTurn, type StoredProfile, type StylistStore } from "../src/db/stylist-store.ts";
import { createStylistConversation } from "../src/services/stylist-conversation.ts";
import { GeminiStylistModel } from "../src/agents/stylist/gemini.ts";
import { StylistAgent } from "../src/agents/stylist/agent.ts";
import { MockProductCatalog } from "../src/shopper/index.ts";
import { PathwayService, currentPathways, emptyPathwayState } from "../src/pathways/service.ts";
import { isOutfitImageRequest } from "../src/images/requests.ts";
import { parseWardrobeDraft } from "../src/wardrobe/gemini.ts";
import type { ConversationReply } from "../src/services/conversation.ts";
import { GeminiOutfitImages, type OutfitImageAssets } from "../src/images/outfits.ts";
import Relay from "@relaymessenger/sdk";
import { RelayAdapter } from "../src/integrations/relay.ts";

const who={userId:"user",conversationId:"chat",messageId:"message"};
const clothes=[
  {id:"tee",description:"Uniqlo white T-shirt",brand:"Uniqlo",category:"tops",colors:["white"],uncertain:false},
  {id:"jeans",description:"Levi's blue jeans",brand:"Levi's",category:"bottoms",colors:["blue"],uncertain:false},
];
const paths=[
  {title:"Relaxed streetwear",description:"Loose casual layers.",palette:["white","black"],staples:["black bomber jacket"],ownedItemIds:["tee","jeans"]},
  {title:"Smart casual",description:"Structured layers with denim.",palette:["navy","white"],staples:["navy blazer","brown loafers"],ownedItemIds:["tee","jeans"]},
  {title:"Vintage workwear",description:"Textured practical layers.",palette:["brown","blue"],staples:["brown chore jacket","tan boots"],ownedItemIds:["tee","jeans"]},
];
const generation={action:"generate",targetId:null,reason:null,pathways:paths};
class Memory implements StylistStore {
  profile=emptyProfile(); prepared=new Map<string,PreparedImageTurn>(); replies=new Map<string,ConversationReply>();
  async load(){return structuredClone(this.profile);}
  async commit(_who:unknown,event:string,profile:StoredProfile,text:string){return (await this.commitResponse(_who,event,profile,{text})).text;}
  async commitResponse(_who:unknown,event:string,profile:StoredProfile,reply:ConversationReply){
    if(this.replies.has(event))return this.replies.get(event)!;
    this.profile=structuredClone(profile);this.replies.set(event,structuredClone(reply));return reply;
  }
  async loadImageTurn(_who:unknown,event:string){return structuredClone(this.prepared.get(event)??null);}
  async saveImageTurn(_who:unknown,event:string,turn:PreparedImageTurn){if(!this.prepared.has(event))this.prepared.set(event,structuredClone(turn));return structuredClone(this.prepared.get(event)!);}
  async saveVideo(){return "private/video.mp4";}
}

test("video sends three numbered clothes previews; two draft choices survive explicit wardrobe confirmation",async()=>{
  const store=new Memory();let call=0;const previews:Array<{slot:number|undefined;owned:number;additions:number;photo:unknown}>=[];
  const run=createStylistConversation({store,models:{text:"test",fallback:"test"},
    client:{models:{generateContent:async params=>{call++;const input=JSON.parse(params.contents as string);
      if(call===1){assert.equal(input.wardrobeSource,"video-draft");return {text:JSON.stringify(generation)};}
      return {text:JSON.stringify({action:"like",targetId:input.numberedOptions[0].id,targetIds:[input.numberedOptions[0].id,input.numberedOptions[2].id],reason:null,pathways:[]})};
    }}},catalog:new MockProductCatalog(),analyzer:{analyze:async()=>clothes},downloadVideo:async()=>new Blob(["video"],{type:"video/mp4"}),
    images:{generate:async(_who,_event,outfit,_signal,photo,slot)=>{previews.push({slot,owned:outfit.pieces.filter(p=>p.wardrobeItemId).length,additions:outfit.pieces.filter(p=>!p.wardrobeItemId).length,photo});return {attachmentId:randomUUID(),mimeType:"image/png"};}},
  });
  const first=await run({...who,text:"",videos:[{mediaId:"video",mimeType:"video/mp4"}]},{eventId:"scan"});
  assert.equal(first.images?.length,3);assert.deepEqual(previews.map(p=>p.slot),[0,1,2]);
  assert.deepEqual(previews.map(p=>p.additions),[1,2,2]);assert.ok(previews.every(p=>p.owned===2&&p.photo===null));
  assert.match(first.text,/Send a clear photo of yourself/);assert.match(first.text,/Choose one or two/);
  assert.equal(store.profile.data.wardrobe.length,0);assert.equal(store.profile.data.pathways.pathways.length,0);
  await run({...who,text:"I like 1 and 3"},{eventId:"choose"});assert.equal(store.profile.data.wardrobe.length,0);
  assert.equal(store.profile.data.draft?.pathways?.pathways.filter(p=>p.status==="liked").length,2);
  await run({...who,text:"save wardrobe"},{eventId:"save"});
  assert.deepEqual(store.profile.data.wardrobe,clothes);assert.deepEqual(store.profile.data.pathways.pathways.filter(p=>p.status==="liked").map(p=>p.title),[paths[0].title,paths[2].title]);
  assert.equal(call,2,"Saving chosen draft tracks does not replace them with unrelated directions.");
});

test("an interrupted three-image turn freezes plans and reuses each image slot across a fresh handler",async()=>{
  const store=new Memory();store.profile.data.wardrobe=clothes;const reference={storagePath:"user/chat/reference/me.png",mimeType:"image/png"};store.profile.data.referencePhoto=reference;
  const attachments=new Map<number,string>();let fail=true,plans=0;const generatedSlots:number[]=[];
  const make=()=>createStylistConversation({store,models:{text:"test",fallback:"test"},client:{models:{generateContent:async()=>{plans++;return {text:JSON.stringify(generation)};}}},
    catalog:new MockProductCatalog(),analyzer:{analyze:async()=>[]},downloadVideo:async()=>new Blob(),
    images:{generate:async(_who,_event,_outfit,_signal,photo,slot=0)=>{
      assert.deepEqual(photo,reference);if(slot===1&&fail)throw new Error("Synthetic upload interruption");
      if(!attachments.has(slot)){generatedSlots.push(slot);attachments.set(slot,randomUUID());}return {attachmentId:attachments.get(slot)!,mimeType:"image/png"};
    }},
  });
  await assert.rejects(make()({...who,text:"Show style tracks"},{eventId:"pictures"}));
  assert.equal(store.replies.size,0);const frozen=structuredClone(store.prepared.get("pictures")!);
  store.profile.version++;
  store.profile.data.shopping.budgets.shirts={max:25,currency:"USD",evidence:"shirts under $25"};
  fail=false;const result=await make()({...who,text:"Show style tracks"},{eventId:"pictures"});
  assert.equal(plans,1);assert.equal(result.images?.length,3);assert.deepEqual(generatedSlots.sort(),[0,1,2]);
  assert.deepEqual(store.profile.data.pathways,frozen.profile.data.pathways);assert.match(result.text,/personal photo/);
  assert.equal(store.profile.data.shopping.budgets.shirts?.max,25,"A later budget survives the delayed image retry.");
});

test("rejecting all paths offers three new images immediately and numbering excludes retained liked directions",async()=>{
  const initial={...emptyPathwayState(),pathways:paths.map((p,i)=>({...p,id:`old-${i}`,status:"offered" as const})),offeredIds:["old-0","old-1","old-2"]};
  const service=new PathwayService({models:{generateContent:async()=>({text:JSON.stringify(generation)})}},{text:"test",fallback:"test"});
  const next=await service.handle({text:"I don't like any of these; show another set",wardrobe:clothes},initial);
  assert.equal(next?.generated?.length,3);assert.ok(next?.state.pathways.filter(p=>p.id.startsWith("old-")).every(p=>p.status==="rejected"));
  assert.equal(next?.state.preferences.length,0,"No invented reason for rejecting the whole set.");
  const selected={...next!.state,pathways:next!.state.pathways.map((p,i)=>i===0?{...p,status:"liked" as const}:p)};
  assert.deepEqual(currentPathways(selected).map(p=>p.id),next!.generated!.map(p=>p.id));
});

test("closet-only model falls back when an interested-in piece sneaks into an outfit",async()=>{
  const bad={intro:"Today's fit",outfits:[{name:"Fit",rationale:"Simple",pieces:[{description:"Gucci coat you liked",wardrobeItemId:null}]}],questions:[],shoppingCriteria:null,shoppingPairing:null};
  const good={...bad,outfits:[{name:"Your clothes",rationale:"Simple",pieces:[{description:"Fake designer tee",wardrobeItemId:"tee"},{description:"Fake pants",wardrobeItemId:"jeans"}]}]};
  const calls:string[]=[];const model=new GeminiStylistModel({models:{generateContent:async params=>{calls.push(params.model);assert.equal(JSON.parse(params.contents as string).outfitMode,"closet");return {text:JSON.stringify(calls.length===1?bad:good)};}}},{text:"primary",fallback:"fallback"});
  const result=await new StylistAgent(model,{search:async()=>{assert.fail("Closet outfit invoked shopping");}}).respond({text:"Give me a fit for today",wardrobe:clothes,outfitMode:"closet"});
  assert.deepEqual(calls,["primary","fallback"]);assert.match(result.text,/Uniqlo white T-shirt/);assert.match(result.text,/Levi's blue jeans/);assert.doesNotMatch(result.text,/Gucci|Fake/);
});

test("natural spoken preview requests deliver an image in chat with the saved photo and allow hypothetical clothing",async()=>{
  for(const text of ["Can you show me what I'd look like with a leather jacket on?","Show me in a navy suit","Show me wearing red boots"])assert.equal(isOutfitImageRequest(text),true);
  for(const text of ["Give me a fit for today","Show my wardrobe","Find a leather jacket"])assert.equal(isOutfitImageRequest(text),false);
  const store=new Memory();store.profile.data.wardrobe=clothes;store.profile.data.referencePhoto={storagePath:"user/chat/reference/me.png",mimeType:"image/png"};
  let previewed=false;const run=createStylistConversation({store,models:{text:"test",fallback:"test"},client:{models:{generateContent:async params=>{
    assert.equal(JSON.parse(params.contents as string).outfitMode,"preview");return {text:JSON.stringify({intro:"Hypothetical preview",outfits:[{name:"Leather jacket preview",rationale:"Preview only",pieces:[{description:"Black leather jacket",wardrobeItemId:null},{description:"Tee",wardrobeItemId:"tee"}]}],questions:[],shoppingCriteria:null,shoppingPairing:null})};
  }}},catalog:{search:async()=>{assert.fail("Preview invoked shopping");}},analyzer:{analyze:async()=>[]},downloadVideo:async()=>new Blob(),
    images:{generate:async(_who,_event,outfit,_signal,photo)=>{previewed=true;assert.deepEqual(photo,store.profile.data.referencePhoto);assert.match(outfit.pieces[0]!.description,/leather/);return {attachmentId:randomUUID(),mimeType:"image/png"};}},
  });
  const response=await run({...who,text:"Can you show me what I'd look like with a leather jacket on?",deliveryKind:"voice"},{eventId:"voice-preview"});
  assert.equal(response.images?.length,1);assert.ok(previewed);assert.deepEqual(store.profile.data.wardrobe,clothes);
});

test("shopping pairs every returned product with an owned item and rejects unselected pathway IDs",async()=>{
  const preferences={...emptyPathwayState(),pathways:paths.map((p,i)=>({...p,id:`path-${i}`,status:i===0?"liked" as const:"offered" as const}))};
  const plan={intro:"Shirts for your selected style",outfits:[],questions:[],shoppingCriteria:{category:"tops" as const,keywords:["shirt"]},shoppingPairing:{wardrobeItemId:"jeans",pathwayId:"path-0",rationale:"Wear the shirt with your jeans for relaxed layers."}};
  const request={text:"Find me a shirt",wardrobe:clothes,preferences,outfitMode:"closet" as const};
  const response=await new StylistAgent({plan:async()=>plan},new MockProductCatalog()).respond(request);
  assert.equal((response.text.match(/Pair with your saved wardrobe: Levi's blue jeans/g)??[]).length,response.shopping?.products.slice(0,3).length);
  assert.match(response.text,/Style path: Relaxed streetwear/);
  for(const invalid of [{...plan,shoppingPairing:{...plan.shoppingPairing,wardrobeItemId:"interested-product"}},{...plan,shoppingPairing:{...plan.shoppingPairing,pathwayId:"path-1"}},{...plan,shoppingPairing:null}]){
    await assert.rejects(new StylistAgent({plan:async()=>invalid},{search:async()=>{assert.fail("Invalid pairing reached Shopper");}}).respond(request),/invalid plan/);
  }
});

test("brand evidence is retained, unknown brands stay null, and unsafe brand text is rejected",()=>{
  const base={description:"White T-shirt",category:"tops",colors:["white"],uncertain:false};
  const [branded,unknown]=parseWardrobeDraft({items:[{...base,brand:"Uniqlo"},{...base,brand:null}]});
  assert.equal(branded?.brand,"Uniqlo");assert.equal(branded?.description,"Uniqlo White T-shirt");assert.equal(unknown?.brand,null);
  assert.throws(()=>parseWardrobeDraft({items:[{...base,brand:"https://fake.example"}]}));
});

test("image asset slots keep three distinct attachments and never reuse the first picture for the others",async()=>{
  const saved=new Map<number,{image:Blob;attachment:{attachmentId:string;mimeType:string}|null}>();let calls=0;
  const assets:OutfitImageAssets={load:async(_who,_event,slot=0)=>saved.get(slot)??null,save:async(_who,_event,image,slot=0)=>{saved.set(slot,{image,attachment:null});},attach:async(_who,_event,attachment,slot=0)=>{saved.get(slot)!.attachment=attachment;}};
  const image=new GeminiOutfitImages({models:{generateContent:async()=>{calls++;return {candidates:[{content:{parts:[{inlineData:{mimeType:"image/png",data:Buffer.from(`image-${calls}`).toString("base64")}}]}}]};}}},"test",assets,async()=>({attachmentId:randomUUID(),mimeType:"image/png"}));
  const outfits=paths.map(path=>({name:path.title,rationale:path.description,pieces:path.staples.map(description=>({description,wardrobeItemId:null}))}));
  const first=await Promise.all(outfits.map((outfit,slot)=>image.generate(who,"event",outfit,undefined,null,slot)));
  assert.equal(new Set(first.map(p=>p.attachmentId)).size,3);
  assert.deepEqual(await Promise.all(outfits.map((outfit,slot)=>image.generate(who,"event",outfit,undefined,null,slot))),first);assert.equal(calls,3);
});

test("Relay sends three pathway images in one stable text/media reply and refuses a fourth",async()=>{
  const bodies:unknown[]=[];
  const relay=new RelayAdapter(new Relay({apiKey:"synthetic",maxRetries:0,fetch:async(_url,init)=>{
    bodies.push(JSON.parse(init!.body as string));return new Response(JSON.stringify({id:randomUUID()}),{headers:{"Content-Type":"application/json"}});
  }}));
  const message={...who,userId:randomUUID(),conversationId:randomUUID(),messageId:randomUUID(),text:"Show style tracks"};
  const event=randomUUID();const images=Array.from({length:3},()=>({attachmentId:randomUUID(),mimeType:"image/png"}));
  await relay.sendReply(event,message,"Three paths",undefined,images);await relay.sendReply(event,message,"Three paths",undefined,images);
  const body=bodies[0] as {message:{parts:unknown[];idempotency_key:string}};
  assert.deepEqual(body.message.parts,[{type:"text",value:"Three paths"},...images.map(p=>({type:"media",attachment_id:p.attachmentId}))]);
  assert.deepEqual(bodies[0],bodies[1]);
  await assert.rejects(relay.sendReply(event,message,"Too many",undefined,[...images,images[0]!]),/image count/);
});
