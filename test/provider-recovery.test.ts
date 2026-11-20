import assert from "node:assert/strict";
import {test} from "node:test";
import {createProviderRecovery} from "../src/provider-recovery.ts";
import {unavailableProvider} from "../src/providers/registry.ts";
test("recovery skips missing Scaleway keys and throttles success and warnings per provider",async()=>{
 let now=0,key=false,calls=0;const warnings:string[]=[];
 const provider={...unavailableProvider("scaleway"),recoverCreations:async()=>{calls++;throw Error("not configured")}};
 const tick=createProviderRecovery({providers:()=>[provider],keyPresent:()=>key,signal:new AbortController().signal,warn:m=>warnings.push(m),now:()=>now});
 await tick();now+=15_000;await tick();assert.equal(calls,0);assert.equal(warnings.length,0);
 key=true;await tick();assert.equal(calls,1);
 for(let i=0;i<19;i++){now+=15_000;await tick();}assert.equal(calls,1);assert.equal(warnings.length,1);
 now+=15_000;await tick();assert.equal(calls,2);assert.equal(warnings.length,2);
});
