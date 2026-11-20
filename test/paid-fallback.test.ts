import assert from "node:assert/strict";
import {test} from "node:test";
import {agentForWork,automaticPaidClaude,decideRelay,type RelaySettings,type OrchestratorView} from "../src/relay.ts";
import {applyLimitFlags,createQuotaReader,poolExtraUsage,type Quotas} from "../src/quota.ts";
const now=Date.now();
const settings:RelaySettings={enabled:true,preferred:"claude",switchAtPercent:98,switchBackBelowPercent:50,quietMinutes:10,paidClaudeFallback:true};
function usage(claude=100,codex=100):Quotas{return new Map(([['claude',claude],['codex',codex]] as const).map(([provider,usedPercent])=>[provider,{provider,usedPercent,resetsAt:null,window:"Weekly limit",...(provider==='claude'?{paidAttemptAllowed:true,extraUsage:{allowed:true,observedAt:now}}:{})}]))}
const view:OrchestratorView={threadId:"thr_demo",provider:"codex",status:"idle",updatedAt:now-3600000,archived:false,hasProject:true};
test("paid fallback requires explicit policy, included limits and a usable Claude route, not extra-usage telemetry",()=>{
 const q=usage();assert.equal(automaticPaidClaude(q,settings,"both",now),true);
 assert.equal(automaticPaidClaude(q,{...settings,paidClaudeFallback:false},"both",now),false);
 assert.equal(automaticPaidClaude(usage(100,97),settings,"both",now),false);
 assert.equal(automaticPaidClaude(q,settings,"codex",now),false);
 q.delete("codex");assert.equal(automaticPaidClaude(q,settings,"both",now),false);assert.equal(automaticPaidClaude(q,settings,"claude",now),true);
 for(const evidence of [undefined,{allowed:false,observedAt:null},{allowed:false,status:"rejected" as const,observedAt:now},{allowed:true,observedAt:now-3600000},{allowed:true,observedAt:now+1}]){const value=usage();value.get("claude")!.extraUsage=evidence;assert.equal(automaticPaidClaude(value,settings,"both",now),true);}
 for (const route of [undefined, false]) {const value=usage();value.get("claude")!.paidAttemptAllowed=route;assert.equal(automaticPaidClaude(value,settings,"both",now),false);}
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
test("a stale Pooler rejection keeps its own time and status; it is never restamped as fresh",async()=>{
 const old=now-30*60_000;const pool=(accounts:unknown[],routing=true)=>({sdk:{plugins:{callRpc:async()=>({routing:{claude:routing,codex:true},accounts})}}}) as never;
 assert.deepEqual(await poolExtraUsage(pool([{id:'a',provider:'claude',status:'ready',usageRestriction:null,extraUsage:{status:'rejected',observedAt:old,source:'usage'}}]),'claude'),{allowed:false,status:'rejected',observedAt:old,pool:'on'});
 assert.deepEqual(await poolExtraUsage(pool([{id:'a',provider:'claude',status:'ready',usageRestriction:{reason:'spend_control_reached'},extraUsage:{status:'allowed',observedAt:old}}]),'claude'),{allowed:false,status:'disabled',observedAt:old,pool:'on'});
 assert.deepEqual(await poolExtraUsage(pool([{id:'a',provider:'claude',status:'ready'}]),'claude'),{allowed:false,status:'unknown',observedAt:null,pool:'on'});
 assert.deepEqual(await poolExtraUsage(pool([],false),'claude'),{allowed:false,status:'unknown',observedAt:null,pool:'not-routing'});
 assert.deepEqual(await poolExtraUsage({sdk:{plugins:{callRpc:async()=>{throw new Error('disabled')}}}} as never,'claude'),{allowed:false,status:'unknown',observedAt:null,pool:'off'});
 // Newest allowed wins; a disabled account's reading doesn't count.
 assert.deepEqual(await poolExtraUsage(pool([{id:'a',provider:'claude',status:'ready',extraUsage:{status:'rejected',observedAt:now}},{id:'b',provider:'claude',status:'ready',extraUsage:{status:'allowed',observedAt:old}},{id:'c',provider:'claude',status:'disabled',extraUsage:{status:'allowed',observedAt:now}}]),'claude'),{allowed:true,status:'allowed',observedAt:old,pool:'on'});
 // Telemetry is shown with its own timestamp; an authorized attempt uses route state.
 const q=usage();q.get('claude')!.extraUsage={allowed:true,status:'allowed',observedAt:old,pool:'on'};assert.equal(automaticPaidClaude(q,settings,'both',now),true);
 q.get('claude')!.extraUsage={allowed:false,status:'rejected',observedAt:now,pool:'on'};assert.equal(automaticPaidClaude(q,settings,'both',now),true);
});

test("routed ready unrestricted accounts permit attempts despite rejected or missing observations; account restrictions still block", async()=>{
 let account:Record<string,unknown>={id:"fake-claude",provider:"claude",enabled:true,status:"ready",usageRestriction:null,extraUsage:{status:"rejected",observedAt:now-3600000}};
 let routing=true;
 const bb={sdk:{plugins:{callRpc:async({method}:{method:string})=>{
  if(method==="status.get")return {routing:{claude:routing,codex:true},accounts:[account]};
  if(method.endsWith("listResources"))return {resources:[{id:"fake-claude",providerId:"claude-code"},{id:"fake-codex",providerId:"codex"}]};
  return {usage:{status:"ok",windows:[{usedPercent:100,model:null}]}};
 }}}} as never;
 const read=()=>createQuotaReader(bb,{sources:["account-pool"]}).read(undefined,{fresh:true});
 assert.equal(automaticPaidClaude(await read(),settings,"both",now),true);
 account.extraUsage=null;assert.equal(automaticPaidClaude(await read(),settings,"both",now),true);
 account.extraUsage={status:"disabled",observedAt:null};assert.equal(automaticPaidClaude(await read(),settings,"both",now),true);
 for(const change of [{enabled:false},{status:"auth_required"},{usageRestriction:{reason:"spend_control_reached"}},{heldUntil:now+3600000},{error:{message:"Authentication failed"}}]){
  const saved={...account};account={...account,...change};assert.equal(automaticPaidClaude(await read(),settings,"both",now),false);account=saved;
 }
 routing=false;assert.equal(automaticPaidClaude(await read(),settings,"both",now),false);
});
