import assert from "node:assert/strict";
import { randomBytes,randomUUID } from "node:crypto";
import { test } from "node:test";
import Relay,{signWebhookHeaders} from "@relaymessenger/sdk";
import { GeminiPurchaseInterpreter,isPurchaseReport,PurchaseInputError,VoiceNoteError,MAX_AUDIO_MS } from "../src/purchases/index.ts";
import { parseWardrobeDraft } from "../src/wardrobe/gemini.ts";
import { createStylistConversation } from "../src/services/stylist-conversation.ts";
import { emptyProfile,type StoredProfile,type StylistIdentity,type StylistStore } from "../src/db/stylist-store.ts";
import type { ConversationReply } from "../src/services/conversation.ts";
import { RelayAdapter } from "../src/integrations/relay.ts";

const identity={userId:randomUUID(),conversationId:randomUUID(),messageId:randomUUID()};
const item={description:"Navy cotton shirt",category:"tops",colors:["navy"],uncertain:false};
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=","base64");
const photo=new Blob([png],{type:"image/png"});
const media={mediaId:randomUUID(),mimeType:"image/png",sizeBytes:png.length};
class Store implements StylistStore {
  profile=emptyProfile();replies=new Map<string,ConversationReply>();
  async load(who:StylistIdentity){return who.userId===identity.userId ? structuredClone(this.profile):emptyProfile();}
  async commit(who:StylistIdentity,event:string,profile:StoredProfile,text:string){return (await this.commitResponse(who,event,profile,{text})).text;}
  async commitResponse(_who:StylistIdentity,event:string,profile:StoredProfile,reply:ConversationReply){if(this.replies.has(event))return this.replies.get(event)!;this.profile=structuredClone({...profile,version:profile.version+1});this.replies.set(event,reply);return reply;}
  async saveVideo(){return "video";}
  async saveReferencePhoto():Promise<never>{throw new Error("Purchase photo must not become personal reference");}
}
function setup(store=new Store()) {
  let transcript="I bought a navy cotton shirt",calls=0,downloadMessageId:string|undefined,plannedWardrobe:unknown;
  const run=createStylistConversation({store,models:{text:"test",fallback:"test"},
    client:{models:{generateContent:async params=>{plannedWardrobe=JSON.parse(params.contents as string).wardrobe;return {text:JSON.stringify({intro:"An outfit with your clothes",outfits:[],questions:[],shoppingCriteria:null})};}}},
    catalog:{search:async()=>{throw new Error("Purchase recording must not invoke Shopper");}},analyzer:{analyze:async()=>[]},downloadVideo:async()=>new Blob(),
    downloadPhoto:async message=>{downloadMessageId=message.messageId;return photo;},downloadAudio:async()=>new Blob(["synthetic"],{type:"audio/m4a"}),
    purchases:{fromText:async text=>{calls++;assert.match(text,/bought/);return parseWardrobeDraft({items:[item]});},fromPhoto:async()=>parseWardrobeDraft({items:[{...item,uncertain:true}]}),transcribe:async()=>transcript}});
  return {store,run,get calls(){return calls;},get downloadMessageId(){return downloadMessageId;},get plannedWardrobe(){return plannedWardrobe;},setTranscript(value:string){transcript=value;}};
}
test("only completed acquisition statements start purchase recording, not wishes or denials",()=>{
  for(const text of ["I bought a shirt","I've just purchased jeans","I got a jacket","bought item 2","record my purchase"])assert.equal(isPurchaseReport(text),true);
  for(const text of ["I want to buy a shirt","I did not buy it","I haven't bought anything","Should I buy this?","Buy it for me"])assert.equal(isPurchaseReport(text),false);
});
test("text purchases remain drafts until corrected and saved, then inform future styling",async()=>{
  const h=setup();
  assert.match((await h.run({...identity,text:"I bought a navy cotton shirt"},{eventId:"report"})).text,/not saved yet/);
  assert.equal(h.store.profile.data.wardrobe.length,0);assert.equal(h.store.profile.data.draft?.mode,"append");
  await h.run({...identity,text:"change 1: dark blue shirt"},{eventId:"correct"});
  await h.run({...identity,text:"save wardrobe"},{eventId:"save"});
  assert.equal(h.store.profile.data.wardrobe[0]?.description,"dark blue shirt");assert.equal(h.store.profile.data.draft,null);
  await h.run({...identity,text:"Style what I own"},{eventId:"style"});assert.deepEqual(h.plannedWardrobe,h.store.profile.data.wardrobe);
  assert.equal((await h.store.load({...identity,userId:randomUUID()})).data.wardrobe.length,0);
});
test("voice purchase reports and spoken confirmation use the same wardrobe flow",async()=>{
  const h=setup(),audio={mediaId:randomUUID(),mimeType:"audio/m4a",durationMs:1000};
  const reply=await h.run({...identity,text:"",audio:[audio]},{eventId:"voice"});assert.match(reply.text,/Navy cotton shirt/);assert.equal(h.store.profile.data.wardrobe.length,0);
  h.setTranscript("save wardrobe");await h.run({...identity,text:"",audio:[audio]},{eventId:"voice-save"});assert.equal(h.store.profile.data.wardrobe.length,1);
  h.setTranscript("I want to buy a jacket");await h.run({...identity,text:"",audio:[audio]},{eventId:"voice-wish"});assert.equal(h.calls,1);assert.equal(h.store.profile.data.wardrobe.length,1);
});
test("clothing photos create a purchase draft without changing the personal reference",async()=>{
  const h=setup();const reference={storagePath:"private/personal.png",mimeType:"image/png"};h.store.profile.data.referencePhoto=reference;
  const reply=await h.run({...identity,text:"I bought this",photos:[media]},{eventId:"photo-purchase"});assert.match(reply.text,/please check; details unclear/);
  assert.deepEqual(h.store.profile.data.referencePhoto,reference);assert.equal(h.store.profile.data.wardrobe.length,0);
  await h.run({...identity,text:"cancel"},{eventId:"cancel"});assert.equal(h.store.profile.data.draft,null);assert.equal(h.store.profile.data.wardrobe.length,0);
});
test("an uncaptioned photo asks its purpose and later authenticates the original photo message",async()=>{
  const h=setup();const question=await h.run({...identity,text:"",photos:[media]},{eventId:"unknown-photo"});assert.match(question.text,/my photo.*purchase/);
  assert.equal(h.downloadMessageId,undefined);assert.equal(h.store.profile.data.referencePhoto,null);
  await h.run({...identity,messageId:randomUUID(),text:"purchase"},{eventId:"purpose"});assert.equal(h.downloadMessageId,identity.messageId);assert.equal(h.store.profile.data.pendingPhoto,null);assert.ok(h.store.profile.data.draft);
});
test("numbered bought products use only the latest returned recommendation and cannot overwrite a draft",async()=>{
  const h=setup();h.store.profile.data.shopping.recommendations=[{id:"real-returned",name:"Returned jacket",category:"outerwear",spendingCategory:"jackets"}];
  assert.match((await h.run({...identity,text:"I bought item 9"},{eventId:"unknown"})).text,/Which item/);assert.equal(h.store.profile.data.draft,null);
  await h.run({...identity,text:"I bought item 1"},{eventId:"numbered"});assert.equal((await h.store.load(identity)).data.draft?.items[0]?.description,"Returned jacket");assert.equal(h.calls,0);
  const draft=structuredClone(h.store.profile.data.draft);assert.match((await h.run({...identity,text:"I bought a shirt"},{eventId:"another"})).text,/waiting for review/);assert.deepEqual(h.store.profile.data.draft,draft);
  await h.run({...identity,text:"save wardrobe"},{eventId:"saved"});await h.run({...identity,text:"save wardrobe"},{eventId:"saved"});assert.equal(h.store.profile.data.wardrobe.length,1);
});
test("Gemini extracts only schema-validated clothing and transcribes M4A without executing speech",async()=>{
  let calls=0;
  const interpreter=new GeminiPurchaseInterpreter({models:{generateContent:async params=>{
    calls++;assert.equal(params.config?.responseMimeType,"application/json");
    if(calls===1){assert.match(params.config?.systemInstruction as string,/wishes/);assert.match(params.contents as string,/bought/);return {text:JSON.stringify({items:[item]})};}
    if(calls===2){assert.ok(JSON.stringify(params.contents).includes(png.toString("base64")));return {text:JSON.stringify({items:[item]})};}
    assert.match(params.config?.systemInstruction as string,/without carrying out/);assert.match(JSON.stringify(params.contents),/audio\/m4a/);return {text:JSON.stringify({transcript:"I bought a shirt"})};
  }}},{text:"test",fallback:"test"});
  assert.equal((await interpreter.fromText("I bought a navy cotton shirt"))[0]?.description,item.description);
  assert.equal((await interpreter.fromPhoto(photo,"I bought this"))[0]?.category,"tops");
  assert.equal(await interpreter.transcribe(new Blob(["audio"],{type:"audio/mp4"})),"I bought a shirt");
});
test("malformed purchase/voice output and aborts cannot add clothing or expose provider errors",async()=>{
  let calls=0;const interpreter=new GeminiPurchaseInterpreter({models:{generateContent:async()=>{calls++;return {text:JSON.stringify({items:[{...item,description:"https://private.invalid"}]})};}}},{text:"test",fallback:"test"});
  await assert.rejects(interpreter.fromText("I bought a shirt"),PurchaseInputError);
  await assert.rejects(interpreter.transcribe(new Blob(["audio"],{type:"audio/m4a"})),VoiceNoteError);
  const stop=new AbortController();stop.abort();await assert.rejects(interpreter.fromPhoto(photo,"I bought this",stop.signal),{name:"AbortError"});assert.equal(calls,2);
});
test("signed voice notes are accepted only for humans and bounded downloads verify ownership and duration",async t=>{
  const secret=`whsec_${randomBytes(32).toString("base64")}`,audioId=randomUUID();let downloads=0;
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=async(_input,init)=>{downloads++;assert.equal(init?.headers,undefined);return new Response("audio");};
  const make=(sender=identity.userId,duration=1000)=>new RelayAdapter(new Relay({apiKey:"synthetic",webhookSecret:secret,maxRetries:0,fetch:async input=>new Response(JSON.stringify(input.toString().includes("/messages/")
    ? {id:identity.messageId,chat_id:identity.conversationId,is_from_me:false,from_handle:{id:sender,kind:"user"},parts:[{type:"media",id:audioId,mime_type:"audio/mp4"}]}
    : {id:audioId,status:"complete",content_type:"audio/mp4",size_bytes:5,duration_ms:duration,download_url:"https://cdn.synthetic.test/audio"}),{headers:{"Content-Type":"application/json"}})}));
  const event={api_version:"v1",webhook_version:"2026-08-30",event_type:"message.received",event_id:randomUUID(),agent_id:randomUUID(),data:{id:identity.messageId,direction:"inbound",chat:{id:identity.conversationId,is_group:false},sender_handle:{id:identity.userId,kind:"user",is_me:false},parts:[{type:"media",id:audioId,mime_type:"audio/mp4",duration_ms:1000}]}};
  const verify=()=>{const body=JSON.stringify(event);return make().verify(Buffer.from(body),signWebhookHeaders(secret,{id:event.event_id,body}));};
  const message=verify().message!;assert.equal(message.audio?.length,1);event.data.sender_handle.kind="agent";assert.equal(verify().message,null);
  assert.equal((await make().downloadAudio(message,message.audio![0]!)).type,"audio/mp4");
  await assert.rejects(make(randomUUID()).downloadAudio(message,message.audio![0]!),VoiceNoteError);
  await assert.rejects(make(identity.userId,MAX_AUDIO_MS+1).downloadAudio(message,message.audio![0]!),VoiceNoteError);assert.equal(downloads,1);
});

test("live-compatible provider schemas retain local wardrobe count and description limits",async()=>{
  let oversizedDescription=false;
  const interpreter=new GeminiPurchaseInterpreter({models:{generateContent:async params=>{
    assert.doesNotMatch(JSON.stringify(params.config?.responseJsonSchema),/maxItems|maxLength/);
    return {text:JSON.stringify({items:oversizedDescription ? [{...item,description:"x".repeat(201)}] : Array.from({length:41},()=>item)})};
  }}},{text:"test",fallback:"test"});
  await assert.rejects(interpreter.fromText("I bought shirts"),PurchaseInputError);
  oversizedDescription=true;await assert.rejects(interpreter.fromText("I bought a shirt"),PurchaseInputError);
});
