import assert from "node:assert/strict";
import {test} from "node:test";
import {createBlockedStart} from "../web/blocked-start.ts";
import {rpcErrorInfo} from "../contract.ts";
import {refuse} from "../src/rpc.ts";
const blocked=(id:string)=>Object.assign(new Error("GitHub setup required"),{issues:[{path:["taskId"],message:id}]});
test("unchanged dialog resubmits follow the latest blocked task instead of starting new requests",async()=>{
 const submit=createBlockedStart();let starts=0,retries=0;const ids:string[]=[];
 const start=async()=>{starts++;throw blocked("t_first");};
 const retry=async(id:string)=>{ids.push(id);retries++;throw blocked(`t_retry${retries}`);};
 for(let i=0;i<4;i++)await assert.rejects(submit({brief:"Read the repo",machineType:"small"},start,retry),/GitHub/);
 assert.equal(starts,1);assert.deepEqual(ids,["t_first","t_retry1","t_retry2"]);
 await assert.rejects(submit({brief:"A different task",machineType:"large"},start,retry));assert.equal(starts,2);
});
test("simultaneous submissions of the same form share a single initial launch",async()=>{
 const submit=createBlockedStart();let calls=0,release!:()=>void;
 const gate=new Promise<void>(r=>release=r);
 const start=async()=>{calls++;await gate;return "accepted";};
 const a=submit({brief:"Read"},start,async()=>"retried"),b=submit({brief:"Read"},start,async()=>"retried");
 release();assert.deepEqual(await Promise.all([a,b]),["accepted","accepted"]);assert.equal(calls,1);
});
test("an unexpected provider failure preserves its recorded task ID in the RPC refusal",async()=>{
 await assert.rejects(refuse(async()=>{throw Object.assign(new Error("Adapter disconnected"),{taskId:"t_recorded"});}),error=>{
  assert.deepEqual(rpcErrorInfo(error),{code:"provider_failed",message:"Adapter disconnected",hint:null,taskId:"t_recorded"});return true;
 });
});
