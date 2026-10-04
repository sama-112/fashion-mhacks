import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Relay from "@relaymessenger/sdk";
import { RelayAdapter } from "../src/integrations/relay.ts";
import { processPending } from "../src/services/relay-worker.ts";
import type { EventInbox, PendingEvent } from "../src/db/inbox.ts";
import type { ConversationImage } from "../src/services/conversation.ts";

const attachmentId=randomUUID(),conversationId=randomUUID(),userId=randomUUID();
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json"}});
test("generated images upload through Relay's allocation without leaking API authorization to the upload URL",async()=>{
  const methods:string[]=[];const adapter=new RelayAdapter(new Relay({apiKey:"synthetic-token",maxRetries:0,fetch:async(input,init)=>{
    const url=input.toString();methods.push(`${init?.method} ${url}`);
    if(url.endsWith("/v1/attachments"))return json({attachment_id:attachmentId,upload_url:"https://upload.synthetic.test/image",required_headers:{"Content-Type":"image/png"},http_method:"PUT",download_url:"https://download.synthetic.test/image",expires_at:"2026-10-04T15:00:00Z"});
    if(url==="https://upload.synthetic.test/image"){
      assert.equal(new Headers(init?.headers).get("authorization"),null);
      assert.ok(init?.body instanceof Blob);return new Response(null,{status:200});
    }
    return json({id:attachmentId,status:"complete",content_type:"image/png",size_bytes:5});
  }}));
  assert.deepEqual(await adapter.uploadImage(new Blob(["image"],{type:"image/png"})),{attachmentId,mimeType:"image/png"});
  assert.equal(methods.length,3);
});

test("weekly sends don't require an inbound message and uncertain image sends retry identical persisted media",async()=>{
  const requests:unknown[]=[];let fail=true;
  const adapter=new RelayAdapter(new Relay({apiKey:"synthetic-token",maxRetries:0,fetch:async(_input,init)=>{
    requests.push(JSON.parse(init?.body as string));if(fail)throw new Error("synthetic outage");return json({message:{id:randomUUID()}},201);
  }}));
  const event:PendingEvent={eventId:randomUUID(),message:{userId,conversationId,text:"Weekly clothing suggestions",deliveryKind:"weekly"},attempts:0,replyText:null};
  let done=false,generated=0;
  const inbox:EventInbox={acceptOnce:async()=>{},pending:async()=>done?[]:[{...event}],saveReply:async(_id,text,images)=>{event.replyText=text;event.replyMedia=images;},complete:async()=>{done=true;},retry:async(_id,attempts)=>{event.attempts=attempts;}};
  const images:ConversationImage[]=[{attachmentId,mimeType:"image/png"}];
  const handler=async()=>{generated++;return {text:"Weekly picks",images};};
  await processPending(inbox,adapter,handler);fail=false;await processPending(inbox,adapter,handler);
  assert.equal(generated,1);assert.deepEqual(requests[0],requests[1]);assert.equal(done,true);
  assert.deepEqual(requests[0],{message:{parts:[{type:"text",value:"Weekly picks"},{type:"media",attachment_id:attachmentId}],idempotency_key:`stylist-weekly:${event.eventId}`}});
});

test("canceled queued events and disabled weekly delivery never send",async()=>{
  const adapter=new RelayAdapter(new Relay({apiKey:"synthetic-token",fetch:async()=>{assert.fail("Canceled message sent.");}}));
  const event:PendingEvent={eventId:randomUUID(),message:{userId,conversationId,text:"weekly",deliveryKind:"weekly"},attempts:0,replyText:"cached"};
  let completed=0;const inbox:EventInbox={acceptOnce:async()=>{},pending:async()=>[event],isPending:async()=>false,saveReply:async()=>{},complete:async()=>{completed++;},retry:async()=>{assert.fail("Canceled message retried.");}};
  await processPending(inbox,adapter,async()=>{assert.fail("Canceled event regenerated.");});
  event.replyText=null;inbox.isPending=async()=>true;
  await processPending(inbox,adapter,async()=>({text:"",skipDelivery:true}));assert.equal(completed,1);
});
