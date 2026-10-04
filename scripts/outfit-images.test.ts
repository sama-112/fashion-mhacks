import assert from "node:assert/strict";
import { test } from "node:test";
import { GeminiOutfitImages, OutfitImageError, type OutfitImageAssets } from "../src/images/outfits.ts";
import type { ConversationImage } from "../src/services/conversation.ts";

const identity={userId:"user",conversationId:"chat"};
const outfit={name:"Casual",rationale:"Relaxed.",pieces:[{description:"Blue shirt",wardrobeItemId:"shirt"}]};
class Assets implements OutfitImageAssets {
  image:Blob|null=null;attachment:ConversationImage|null=null;
  async load(){return this.image?{image:this.image,attachment:this.attachment}:null;}
  async save(_identity:unknown,_event:string,image:Blob){this.image=image;}
  async attach(_identity:unknown,_event:string,attachment:ConversationImage){this.attachment=attachment;}
}
test("Gemini image output is private and cached before upload, then cached attachment avoids regeneration on retries",async()=>{
  const assets=new Assets();let modelCalls=0,uploads=0;
  const images=new GeminiOutfitImages({models:{generateContent:async params=>{
    modelCalls++;assert.equal(params.model,"image-model");assert.deepEqual(params.config?.responseModalities,["TEXT","IMAGE"]);
    assert.match(params.contents as string,/not an exact photo/);assert.match(params.contents as string,/Blue shirt/);
    return {candidates:[{content:{parts:[{inlineData:{mimeType:"image/png",data:Buffer.from("synthetic image").toString("base64")}}]}}]};
  } }},"image-model",assets,async()=>{uploads++;assert.ok(assets.image);if(uploads===1)throw new Error("private upload failure");return {attachmentId:"a",mimeType:"image/png"};});
  await assert.rejects(images.generate(identity,"event",outfit),OutfitImageError);
  const image=await images.generate(identity,"event",outfit);assert.equal(modelCalls,1);assert.equal(uploads,2);
  assert.deepEqual(await images.generate(identity,"event",outfit),image);assert.equal(modelCalls,1);assert.equal(uploads,2);
});
test("blocked or malformed image output fails safely and abort prevents provider calls",async()=>{
  let calls=0;const images=new GeminiOutfitImages({models:{generateContent:async()=>{calls++;return {candidates:[{content:{parts:[{text:"No image."}]}}]};}}},"image-model",new Assets(),async()=>{assert.fail("Invalid output uploaded.");});
  await assert.rejects(images.generate(identity,"event",outfit),{message:"I couldn't generate an outfit image right now. Your wardrobe is saved; please try again shortly."});
  const stop=new AbortController();stop.abort();await assert.rejects(images.generate(identity,"event",outfit,stop.signal),{name:"AbortError"});assert.equal(calls,1);
});
