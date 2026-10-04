import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import Relay, { signWebhookHeaders } from "@relaymessenger/sdk";
import { RelayAdapter } from "../src/integrations/relay.ts";
import { GeminiOutfitImages, type OutfitImageAssets } from "../src/images/outfits.ts";
import { MAX_PHOTO_BYTES, ReferencePhotoError, validatePhoto } from "../src/images/photos.ts";
import { emptyProfile, type StylistStore } from "../src/db/stylist-store.ts";
import { createStylistConversation } from "../src/services/stylist-conversation.ts";

const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=","base64");
const photo=new Blob([png],{type:"image/png"});
const userId=randomUUID(),conversationId=randomUUID(),messageId=randomUUID(),mediaId=randomUUID();
const identity={userId,conversationId,messageId};
const media={mediaId,mimeType:"image/png",sizeBytes:png.length};
const secret=`whsec_${randomBytes(32).toString("base64")}`;
function transport(sender=userId,size=png.length) {
  return new RelayAdapter(new Relay({apiKey:"synthetic",webhookSecret:secret,maxRetries:0,fetch:async input=>new Response(JSON.stringify(
    input.toString().includes("/messages/") ? {id:messageId,chat_id:conversationId,is_from_me:false,from_handle:{id:sender,kind:"user"},parts:[{type:"media",id:mediaId,mime_type:"image/png"}]}
      : {id:mediaId,status:"complete",content_type:"image/png",size_bytes:size,download_url:"https://cdn.synthetic.test/photo"}
  ),{headers:{"Content-Type":"application/json"}})}));
}
test("signed personal photo-only messages are accepted only in inbound human direct chats",()=>{
  const adapter=transport();
  const value={event_id:randomUUID(),agent_id:randomUUID(),event_type:"message.received",api_version:"v1",webhook_version:"2026-08-30",
    data:{id:messageId,direction:"inbound",chat:{id:conversationId,is_group:false},sender_handle:{id:userId,kind:"user",is_me:false},parts:[{type:"media",id:mediaId,mime_type:"image/png",size_bytes:png.length}]}};
  const verify=()=>{const body=JSON.stringify(value);return adapter.verify(Buffer.from(body),signWebhookHeaders(secret,{id:value.event_id,body}));};
  assert.deepEqual(verify().message?.photos,[media]);
  value.data.chat.is_group=true;assert.equal(verify().message,null);value.data.chat.is_group=false;
  value.data.sender_handle.kind="agent";assert.equal(verify().message,null);value.data.sender_handle.kind="user";
  value.data.direction="outbound";assert.equal(verify().message,null);
});
test("personal photo download authenticates sender and attachment membership before refreshing a bounded private URL",async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let downloads=0;
  globalThis.fetch=async(input,init)=>{downloads++;assert.equal(input.toString(),"https://cdn.synthetic.test/photo");assert.equal(init?.headers,undefined);assert.equal(init?.redirect,"error");return new Response(png);};
  assert.equal((await transport().downloadPhoto({...identity,text:""},media)).size,png.length);
  await assert.rejects(transport(randomUUID()).downloadPhoto({...identity,text:""},media),ReferencePhotoError);
  await assert.rejects(transport(userId,MAX_PHOTO_BYTES+1).downloadPhoto({...identity,text:""},media),ReferencePhotoError);
  await assert.rejects(transport().downloadPhoto({...identity,text:""},{...media,mediaId:randomUUID()}),ReferencePhotoError);
  assert.equal(downloads,1);
});
test("reference photo validation rejects disguised files and unsupported types",async()=>{
  await validatePhoto(photo);
  await assert.rejects(validatePhoto(new Blob(["<svg>"],{type:"image/png"})),ReferencePhotoError);
  await assert.rejects(validatePhoto(new Blob([png],{type:"image/heic"})),ReferencePhotoError);
});
test("a personal reference image enters Gemini editing and cached replies do not reload or regenerate it",async()=>{
  const reference={storagePath:`${userId}/${conversationId}/reference/photo.png`,mimeType:"image/png"};
  let attachment:null|{attachmentId:string;mimeType:string}=null,loads=0,calls=0;
  const assets:OutfitImageAssets={load:async()=>attachment ? {image:photo,attachment}:null,save:async()=>{},attach:async(_who,_event,value)=>{attachment=value;},
    loadReference:async(who,path)=>{assert.deepEqual(who,identity);assert.deepEqual(path,reference);loads++;return photo;}};
  const images=new GeminiOutfitImages({models:{generateContent:async params=>{calls++;const content=JSON.stringify(params.contents);
    assert.match(content,/same person/);assert.match(content,/Preserve their face/);assert.match(content,/Blue shirt/);assert.ok(content.includes(png.toString("base64")));
    return {candidates:[{content:{parts:[{inlineData:{mimeType:"image/png",data:png.toString("base64")}}]}}]};}}},"image-model",assets,async()=>({attachmentId:"cached-photo",mimeType:"image/png"}));
  const outfit={name:"Casual",rationale:"Easy",pieces:[{description:"Blue shirt",wardrobeItemId:null}]};
  await images.generate(identity,"preview",outfit,undefined,reference);await images.generate(identity,"preview",outfit,undefined,reference);
  assert.equal(loads,1);assert.equal(calls,1);
});
test("saving a personal photo persists across handlers, supplies the preview and permits the flat-lay fallback",async()=>{
  let profile=emptyProfile();let saves=0;
  const store:StylistStore={load:async who=>who.userId===userId ? structuredClone(profile):emptyProfile(),saveVideo:async()=>"",
    saveReferencePhoto:async(who,_event,blob)=>{assert.equal(who.userId,userId);await validatePhoto(blob);saves++;return {storagePath:`${userId}/${conversationId}/reference/photo.png`,mimeType:blob.type};},
    commit:async()=>{throw new Error("Unexpected text-only commit");},commitResponse:async(_who,_event,updated,reply)=>{profile=structuredClone(updated);return reply;}};
  let received:unknown;
  const run=createStylistConversation({store,models:{text:"test",fallback:"test"},client:{models:{generateContent:async()=>{throw new Error("No planning needed");}}},catalog:{search:async()=>{throw new Error("No shopping needed");}},
    analyzer:{analyze:async()=>[]},downloadVideo:async()=>new Blob(),downloadPhoto:async()=>photo,
    images:{generate:async(_who,_event,_outfit,_signal,reference)=>{received=reference;return {attachmentId:randomUUID(),mimeType:"image/png"};}}});
  assert.match((await run({...identity,text:"start"},{eventId:"start"})).text,/Optional: send/);
  assert.match((await run({...identity,text:"",photos:[media]},{eventId:"photo-question"})).text,/Reply "my photo" or "purchase"/);assert.equal(saves,0);
  assert.match((await run({...identity,text:"my photo"},{eventId:"photo"})).text,/Saved your personal reference photo/);assert.equal(saves,1);
  assert.equal((await store.load({...identity,userId:randomUUID()})).data.referencePhoto,null);
  profile.data.lastOutfits=[{name:"Casual",rationale:"Easy",pieces:[{description:"Blue shirt",wardrobeItemId:null}]}];
  assert.match((await run({...identity,text:"generate outfit image 1"},{eventId:"preview"})).text,/preview on your photo/);
  assert.deepEqual(received,profile.data.referencePhoto);
  await run({...identity,text:"use flat lay"},{eventId:"skip"});
  assert.match((await run({...identity,text:"generate outfit image 1"},{eventId:"flat"})).text,/AI-generated outfit concept/);assert.equal(received,null);
  const invalid=await run({...identity,text:"",photos:[media,media]},{eventId:"many"});assert.match(invalid.text,/one photo at a time/);assert.equal(saves,1);
});
