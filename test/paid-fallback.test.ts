import assert from "node:assert/strict";
import {test} from "node:test";
import {agentForWork,automaticPaidClaude,decideRelay,PAID_USAGE_EVIDENCE_MS,type RelaySettings,type OrchestratorView} from "../src/relay.ts";
import {applyLimitFlags,createQuotaReader,type Quotas} from "../src/quota.ts";
const now=Date.now();
const settings:RelaySettings={enabled:true,preferred:"claude",switchAtPercent:98,switchBackBelowPercent:50,quietMinutes:10,paidClaudeFallback:true};
function usage(claude=100,codex=100):Quotas{return new Map(([['claude',claude],['codex',codex]] as const).map(([provider,usedPercent])=>[provider,{provider,usedPercent,resetsAt:null,window:"Weekly limit",...(provider==='claude'?{extraUsage:{allowed:true,observedAt:now}}:{})}]))}
const view:OrchestratorView={threadId:"thr_demo",provider:"codex",status:"idle",updatedAt:now-3600000,archived:false,hasProject:true};
test("paid fallback requires explicit policy, both actual limits, fresh affirmative availability and a connected Claude choice",()=>{
 const q=usage();assert.equal(automaticPaidClaude(q,settings,"both",now),true);
 assert.equal(automaticPaidClaude(q,{...settings,paidClaudeFallback:false},"both",now),false);
 assert.equal(automaticPaidClaude(usage(100,97),settings,"both",now),false);
 assert.equal(automaticPaidClaude(q,settings,"codex",now),false);
 q.delete("codex");assert.equal(automaticPaidClaude(q,settings,"both",now),false);assert.equal(automaticPaidClaude(q,settings,"claude",now),true);
 for(const evidence of [undefined,{allowed:false,observedAt:now},{allowed:true,observedAt:now-PAID_USAGE_EVIDENCE_MS-1},{allowed:true,observedAt:now+1}]){const value=usage();value.get("claude")!.extraUsage=evidence;assert.equal(automaticPaidClaude(value,settings,"both",now),false);}
});
test("included usage wins regardless of preferred agent or paid availability",()=>{
 assert.equal(agentForWork("claude",usage(100,20),settings),"codex");assert.equal(agentForWork("codex",usage(0,100),settings),"claude");assert.equal(agentForWork("codex",usage(),settings),"claude");
});
test("a billing/usage refusal blocks automatic paid continuation even if an older header allowed it",()=>{
 const q=applyLimitFlags(usage(),{claude:now+3600000});assert.equal(q.get("claude")!.blockedUntil,now+3600000);assert.equal(automaticPaidClaude(q,settings,"both",now),false);
});
test("orchestrator hands over to authorized Claude, stays there, and returns to included Codex after reset",()=>{
 assert.equal(decideRelay(view,usage(),null,settings,now).kind,"take-over");
 assert.deepEqual(decideRelay({...view,provider:"claude"},usage(),null,settings,now),{kind:"none"});
 const back=decideRelay({...view,provider:"claude"},usage(100,0),{phase:"cooldown",until:now+3600000},settings,now);assert.equal(back.kind,"take-over");assert.equal(back.kind==='take-over'&&back.to,"codex");
 assert.equal(decideRelay({...view,status:"active"},usage(),null,settings,now).kind,"request-handoff");
 const state={phase:"handoff-requested" as const,to:"claude" as const,reason:"Automatic extra usage",since:now-600000};assert.equal(decideRelay(view,usage(),state,{...settings,paidClaudeFallback:false},now).kind,"both-out");
});
test("availability comes from refreshed routed Account Pooler state, not host quota or a disabled account",async()=>{
 let allowed=true,routed=true,ready=true,restricted=false,refreshed=false;const bb={sdk:{plugins:{callRpc:async({method,input}:{method:string;input:{resourceId?:string}})=>{
 if(method==='status.get')return {routing:{claude:routed,codex:true},accounts:[{id:'demo',provider:'claude',status:ready?'ready':'disabled',usageRestriction:restricted?{reason:'spend-control'}:null,extraUsage:{status:allowed&&refreshed?'allowed':'disabled',observedAt:now}}]};
 if(method.endsWith('listResources'))return {resources:[{id:'demo',providerId:'claude-code'}]};refreshed=true;return {usage:{status:'ok',windows:[{usedPercent:100,model:null}]}};
 }}}};
 const read=()=>createQuotaReader(bb as never,{sources:['account-pool']}).read(undefined,{fresh:true});assert.equal((await read()).get('claude')?.extraUsage?.allowed,true);
 allowed=false;assert.equal((await read()).get('claude')?.extraUsage?.allowed,false);allowed=true;restricted=true;assert.equal((await read()).get('claude')?.extraUsage?.allowed,false);restricted=false;ready=false;assert.equal((await read()).size,0);ready=true;routed=false;assert.equal((await read()).size,0);
});
