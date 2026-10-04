import assert from "node:assert/strict";
import { test } from "node:test";
import { ThinkingLevel, type GenerateContentParameters } from "@google/genai";
import { createStylistProductResearcher, type SearchDiagnostic } from "../src/agents/stylist/product-search.ts";

const request={market:"US" as const,category:"tops" as const,keywords:["cotton","polo"],budget:{max:60,currency:"USD" as const},preferredBrands:[],referenceBrands:[],maxResults:3};
const productUrl="https://store.example/product/navy-polo";
const result={text:`PRODUCT: [Cotton polo](${productUrl})\nBRAND: Test brand\nRETAILER: Test store\nSUMMARY: Navy cotton polo.\nMATCH: Matches the requested shirt.\nPRICE: $30 USD`,candidates:[{groundingMetadata:{groundingChunks:[{web:{title:"store.example",uri:productUrl}}]}}]};
function client(generateContent:(params:GenerateContentParameters)=>Promise<unknown>) {
  return {models:{generateContent}} as Parameters<typeof createStylistProductResearcher>[0];
}

test("production product search keeps partner validation and budget constraints with bounded provider retries",async()=>{
  const calls:GenerateContentParameters[]=[];
  const researcher=createStylistProductResearcher(client(async params=>{calls.push(params);return result;}),{primary:"gemini-3.6-flash",fallback:"gemini-3.5-flash"},()=>{});
  const answer=await researcher.search(request);
  assert.equal(answer.products[0]?.productUrl,productUrl);
  assert.match(calls[0]?.contents as string,/"budget":\{"max":60,"currency":"USD"\}/);
  assert.deepEqual(calls[0]?.config?.tools,[{googleSearch:{}}]);
  assert.deepEqual(calls[0]?.config?.httpOptions,{timeout:45000,retryOptions:{attempts:2}});
  assert.deepEqual(calls[0]?.config?.thinkingConfig,{thinkingLevel:ThinkingLevel.MINIMAL});
  assert.match(answer.disclaimer,/not independently verified/);
});

test("an empty primary search tries one fallback without weakening citation requirements",async()=>{
  const calls:string[]=[];
  const researcher=createStylistProductResearcher(client(async params=>{calls.push(params.model);return calls.length===1?{...result,candidates:[]}:result;}),{primary:"primary",fallback:"fallback"},()=>{});
  assert.equal((await researcher.search(request)).products.length,1);
  assert.deepEqual(calls,["primary","fallback"]);
  const uncited=createStylistProductResearcher(client(async()=>({...result,candidates:[]})),{primary:"same",fallback:"same"},()=>{});
  assert.equal((await uncited.search(request)).products.length,0);
});

test("provider failure diagnostics contain statuses and counts without keys, prompts, products or raw errors",async()=>{
  const logs:SearchDiagnostic[]=[];const calls:string[]=[];
  const researcher=createStylistProductResearcher(client(async params=>{
    calls.push(params.model);
    if(calls.length===1)throw Object.assign(new Error("Private prompt and credential; request timed out"),{status:503});
    return result;
  }),{primary:"primary",fallback:"fallback"},d=>logs.push(d));
  assert.equal((await researcher.search(request)).products.length,1);
  assert.deepEqual(calls,["primary","fallback"]);assert.equal(logs[0]?.httpStatus,503);assert.equal(logs[0]?.timedOut,true);
  assert.equal(logs[1]?.sources,1);assert.doesNotMatch(JSON.stringify(logs),/Private|credential|polo|store\.example/);
});

test("empty results survive a failed fallback and newer models use a supported low thinking level",async()=>{
  const calls:GenerateContentParameters[]=[];
  const researcher=createStylistProductResearcher(client(async params=>{
    calls.push(params);if(calls.length===1)return {text:'{"products":[]}',candidates:[]};throw new Error("Provider unavailable");
  }),{primary:"gemini-3.8-flash",fallback:"gemini-3.5-flash"},()=>{});
  assert.equal((await researcher.search(request)).products.length,0);
  assert.deepEqual(calls[0]?.config?.thinkingConfig,{thinkingLevel:ThinkingLevel.LOW});
  assert.equal(calls.length,2);
});
