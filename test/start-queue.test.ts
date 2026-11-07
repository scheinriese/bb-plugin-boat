import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { TaskStore } from "../src/store.ts";
import { BoatService, TaskError, type StartTaskInput } from "../src/service.ts";
import type { BoatApi } from "../src/boat-api.ts";
import { createStartQueue } from "../src/start-queue.ts";
import { StartQueueStore, durableStartInput } from "../src/start-queue-store.ts";
import { createPaidStartInteractions } from "../src/start-queue-interaction.ts";
import { createQuotaReader, type Quotas, type QuotaReader } from "../src/quota.ts";
import { defaultSettings, FakeBoat } from "./fakes.ts";
import { createTestHost } from "./fakes.ts";
import { registerStartQueueRpc } from "../src/start-queue-rpc.ts";
import type { Runtime } from "../src/runtime.ts";
import plugin from "../server.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const input: StartTaskInput = { title: "Cart drawer", role: "implement", brief: "Implement the quantity controls.", repo: "demo/storefront", baseBranch: "main", orchestratorThreadId: "thr_orch" };
const quotas = (claude = 95, codex = 97): Quotas => new Map(([ ["claude",claude], ["codex",codex] ] as const).map(([provider,usedPercent]) => [provider,{provider,usedPercent,resetsAt:"2026-11-08T00:00:00Z",window:"Weekly limit"}]));
function gate() { let release!: () => void; const promise = new Promise<void>(r=>{release=r;}); return {promise,release}; }
async function until(check: () => boolean) { const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw Error("Timed out");await new Promise(r=>setTimeout(r,2));} }
function setup() {
  const db = new DatabaseSync(":memory:"); for(const sql of TaskStore.migrations())db.exec(sql);
  const database = () => db as unknown as Database.Database;
  const registry = new TaskStore(database), store = new StartQueueStore(database), boat = new FakeBoat();
  const { bb, harness } = createFakePluginHost({pluginId:"boat"}); let closed=false, projectValid=true, settings=defaultSettings(), clock=Date.now(), usage=quotas(), readCount=0;
  let preflight: (()=>Promise<void>) | null=null, onFresh: ((n:number)=>void)|null=null, afterInsertFailure=false;
  harness.sdk.stub("threads.get", async ({threadId}:{threadId:string})=>({id:threadId,archivedAt:closed?1:null,deletedAt:null}));
  const reader:QuotaReader={async read(_signal,options){if(options?.fresh){onFresh?.(++readCount);}return new Map([...usage].map(([k,v])=>[k,{...v}]));}};
  const lifecycle = new AbortController();
  const service=new BoatService(boat as unknown as BoatApi,registry,{settings:async()=>settings,lifecycle:lifecycle.signal,changed(){if(afterInsertFailure){afterInsertFailure=false;throw Error("Simulated reload after registry insertion");}},notify:async()=>{},log:{info(){},warn(){}},quotas:reader,preflight:async()=>{await preflight?.();},checkPreview:async()=>"up"});
  const controllers:ReturnType<typeof createStartQueue>[]=[];
  const start=()=>{const q=createStartQueue({bb,service,store,quotas:reader,changed(){},wake(){},now:()=>clock,projectCurrent:()=>projectValid});controllers.push(q);return q;};
  const queue=start();
  return {db,bb,harness,registry,store,boat,service,queue,start,reader,
    setUsage(v:Quotas){usage=v;}, setClosed(){closed=true;}, changeProject(){projectValid=false;}, advance(ms:number){clock+=ms;}, setPreflight(fn:(()=>Promise<void>)|null){preflight=fn;}, setFresh(fn:((n:number)=>void)|null){onFresh=fn;}, get freshReads(){return readCount;}, get settings(){return settings;}, setSettings(next:Partial<typeof settings>){settings={...settings,...next};}, failAfterInsert(){afterInsertFailure=true;},
    async queued(overrides:Partial<StartTaskInput>={}){const r=await queue.launch({...input,...overrides},5000);assert.equal(r.kind,"queued");if(r.kind!=="queued")throw Error("Not queued");return r.request;},
    async settle(){await until(()=>registry.list().every(t=>t.status!=="starting"));},
    async dispose(){controllers.forEach(q=>q.dispose());lifecycle.abort();await harness.lifecycle.dispose();},
  };
}

test("only agents_at_limit queues the bounded original request, deduplicated without task or sandbox allocation",async t=>{
 const e=setup();t.after(()=>e.dispose());const [a,b]=await Promise.all([e.queued(),e.queued()]);
 assert.equal(a.id,b.id);assert.equal(e.queue.list().length,1);assert.equal(e.registry.list().length,0);assert.equal(e.boat.calls.length,0);assert.equal(a.resetsAt,"2026-11-08T00:00:00Z");
 assert.deepEqual(e.store.get(a.id)!.input,input);
 await assert.rejects(e.queue.launch({...input,title:""},5000),(x:unknown)=>x instanceof TaskError&&x.code==="invalid_task");assert.equal(e.queue.list().length,1);
 assert.throws(()=>durableStartInput({...input,brief:"x".repeat(100001)}));
 assert.throws(()=>durableStartInput({...input,nativeReview:{} as never}));
});
test("subscription reset retries original work once across concurrent ticks and reloads",async t=>{
 const e=setup();t.after(()=>e.dispose());const queued=await e.queued();await e.queue.tick();assert.equal(e.boat.calls.length,0);
 e.setUsage(quotas(95,10));e.advance(30001);await Promise.all([e.queue.tick(),e.queue.tick()]);await e.settle();
 const receipt=e.queue.get(queued.id)!;assert.equal(receipt.state,"started");assert.ok(receipt.taskId);assert.equal(e.registry.get(receipt.taskId!)!.provider,"codex");
 assert.equal(e.boat.calls.filter(c=>c.startsWith("create ")).length,1);assert.ok(e.registry.latestEvent(receipt.taskId!,"queued-start"));
 await e.start().tick();assert.equal(e.boat.calls.filter(c=>c.startsWith("create ")).length,1);
 assert.equal(e.queue.cancel(queued.id,queued.revision).taskId,receipt.taskId);assert.equal(e.registry.get(receipt.taskId!)!.status,"running");
});
test("disabled relay preserves the preferred agent: other-agent room keeps waiting until the preferred agent resets",async t=>{
 const e=setup();t.after(()=>e.dispose());e.setSettings({relay:{...e.settings.relay,enabled:false}});const q=await e.queued();e.setUsage(quotas(95,10));await e.queue.tick();assert.equal(e.queue.get(q.id)!.state,"waiting");assert.equal(e.boat.calls.length,0);
 e.setUsage(quotas(10,10));e.advance(30001);await e.queue.tick();await e.settle();const receipt=e.queue.get(q.id)!;assert.equal(receipt.state,"started");assert.equal(e.registry.get(receipt.taskId!)!.provider,"claude");assert.equal(e.boat.calls.filter(c=>c.startsWith("create ")).length,1);
});
test("known reset time never substitutes for actual fresh room; unknown usage keeps work waiting",async t=>{
 const e=setup();t.after(()=>e.dispose());await e.queued();e.advance(8*24*3600_000);e.setUsage(new Map());await e.queue.tick();assert.equal(e.registry.list().length,0);assert.equal(e.boat.calls.length,0);
});
test("a repeated tool request joins its pending receipt even after subscription room returns",async t=>{
 const e=setup();t.after(()=>e.dispose());const first=await e.queued();e.setUsage(quotas(10,20));const second=await e.queued();assert.equal(second.id,first.id);assert.equal(e.registry.list().length,0);assert.equal(e.boat.calls.length,0);await e.queue.tick();await e.settle();assert.equal(e.registry.list().length,1);
});
test("cancel wins during preflight before the atomic insertion, and repeated cancel is harmless",async t=>{
 const e=setup();t.after(()=>e.dispose());const q=await e.queued(), hold=gate();let entered=false;
 e.setUsage(quotas(10,20));e.setPreflight(async()=>{entered=true;await hold.promise;});const ticking=e.queue.tick();await until(()=>entered);
 const current=e.queue.get(q.id)!;e.queue.cancel(q.id,current.revision);e.queue.cancel(q.id,current.revision);hold.release();await ticking;
 assert.equal(e.queue.get(q.id)!.state,"cancelled");assert.equal(e.registry.list().length,0);assert.equal(e.boat.calls.length,0);
});
test("closed original chat cancels waiting work, including a close during async preflight",async t=>{
 for(const late of [false,true]){const e=setup();t.after(()=>e.dispose());const q=await e.queued();e.setUsage(quotas(10,20));const hold=gate();let entered=false;
 if(late)e.setPreflight(async()=>{entered=true;await hold.promise;});else e.setClosed();
 const ticking=e.queue.tick();if(late){await until(()=>entered);e.setClosed();hold.release();}await ticking;
 assert.equal(e.queue.get(q.id)!.state,"cancelled");assert.equal(e.boat.calls.length,0);assert.equal(e.registry.list().length,0);}
});
test("a new or closed parent generation invalidates queued review work",async t=>{
 for(const closed of [false,true]){const e=setup();t.after(()=>e.dispose());const parent=(await e.service.launchTask({...input,provider:"claude"},5000)).task;
 e.registry.update(parent.id,{status:"idle",finishedAt:new Date().toISOString()});e.boat.calls.length=0;
 const q=await e.queued({role:"review",parentTaskId:parent.id});e.registry.update(parent.id,closed?{status:"done"}:{turns:2,promptId:"new-turn"});e.setUsage(quotas(10,20));await e.queue.tick();
 assert.equal(e.queue.get(q.id)!.state,"cancelled");assert.equal(e.boat.calls.length,0);assert.equal(e.registry.list().length,1);}
});
test("reload before insertion recovers a durable dispatch claim; disposal before insert preserves waiting work",async t=>{
 const e=setup();t.after(()=>e.dispose());const q=await e.queued();e.store.transition(q.id,q.revision,["waiting"],"dispatching","Interrupted before insertion");
 e.queue.dispose();e.setUsage(quotas(10,20));await e.start().tick();await e.settle();assert.equal(e.queue.get(q.id)!.state,"started");assert.equal(e.registry.list().length,1);
 const f=setup();t.after(()=>f.dispose());const q2=await f.queued(),hold=gate();let entered=false;f.setUsage(quotas(10,20));f.setPreflight(async()=>{entered=true;await hold.promise;});const work=f.queue.tick();await until(()=>entered);f.queue.dispose();hold.release();await work;
 assert.equal(f.queue.get(q2.id)!.state,"waiting");assert.equal(f.registry.list().length,0);assert.equal(f.boat.calls.length,0);
});
test("reload after atomic insertion never replays a request, and existing service recovery owns the interrupted task",async t=>{
 const e=setup();t.after(()=>e.dispose());const q=await e.queued();e.setUsage(quotas(10,20));e.failAfterInsert();await e.queue.tick();
 const receipt=e.queue.get(q.id)!;assert.equal(receipt.state,"started");assert.equal(e.registry.get(receipt.taskId!)!.status,"starting");assert.equal(e.boat.calls.length,0);
 await e.start().tick();assert.equal(e.registry.list().length,1);e.db.prepare("UPDATE tasks SET created_at=? WHERE id=?").run(new Date(Date.now()-3*60_000).toISOString(),receipt.taskId);await e.service.sweep();assert.equal(e.registry.get(receipt.taskId!)!.status,"failed");assert.equal(e.boat.calls.length,0);
});
test("registry insertion and receipt binding roll back together on failure",async t=>{
 const e=setup();t.after(()=>e.dispose());const parent=(await e.service.launchTask({...input,provider:"claude"},5000)).task;const q=await e.queued();const claimed=e.store.transition(q.id,q.revision,["waiting"],"dispatching","Test")!;
 assert.throws(()=>e.store.attach(claimed,{...parent,id:claimed.reservedTaskId},()=>{e.registry.insert({...parent,id:claimed.reservedTaskId});throw Error("DB attribution failed");}));
 assert.equal(e.registry.get(claimed.reservedTaskId),null);assert.equal(e.queue.get(q.id)!.state,"dispatching");assert.equal(e.queue.get(q.id)!.taskId,null);
});
test("a changed project during preflight cancels its request before insertion",async t=>{
 const e=setup();t.after(()=>e.dispose());const q=await e.queued(),hold=gate();let entered=false;e.setUsage(quotas(10,20));e.setPreflight(async()=>{entered=true;await hold.promise;});const tick=e.queue.tick();await until(()=>entered);e.changeProject();hold.release();await tick;
 assert.equal(e.queue.get(q.id)!.state,"cancelled");assert.equal(e.registry.list().length,0);assert.equal(e.boat.calls.length,0);
});
test("temporary fresh-usage failure retains the original request and still permits closed-source cancellation",async t=>{
 const e=setup();t.after(()=>e.dispose());e.setFresh(()=>{throw Error("Fake usage source offline");});const q=await e.queued();assert.equal(q.state,"waiting");assert.equal(q.resetsAt,null);e.setClosed();await e.queue.tick();assert.equal(e.queue.get(q.id)!.state,"cancelled");assert.equal(e.boat.calls.length,0);
});
test("deduplication includes parent generation, so a new request never reuses an obsolete parent's receipt",async t=>{
 const e=setup();t.after(()=>e.dispose());const parent=(await e.service.launchTask({...input,provider:"claude"},5000)).task;const first=await e.queued({parentTaskId:parent.id});e.registry.update(parent.id,{turns:parent.turns+1});const second=await e.queued({parentTaskId:parent.id});assert.notEqual(first.id,second.id);assert.equal(e.queue.list().length,2);
});
test("the monitor bounds each dispatch batch and finished receipt retention without dropping waiting work",async t=>{
 const e=setup();t.after(()=>e.dispose());for(let i=0;i<5;i++)await e.queued({title:`Batch ${i}`});e.setUsage(quotas(10,20));await e.queue.tick();await e.settle();assert.equal(e.registry.list().length,3);assert.equal(e.queue.list().length,2);
 // Retention is exercised at the persisted store boundary; no provider or VM actions.
 const f=setup();t.after(()=>f.dispose());for(let i=0;i<1003;i++){const q=f.store.enqueue(durableStartInput({...input,title:`Receipt ${i}`}),null,"Waiting",null);f.queue.cancel(q.dto.id,q.dto.revision);}const live=await f.queued({title:"Keep waiting"});
 assert.equal((f.db.prepare("SELECT count(*) AS n FROM start_queue WHERE state='cancelled'").get() as {n:number}).n,1000);assert.equal(f.queue.get(live.id)!.state,"waiting");assert.equal(f.boat.calls.length,0);
});
test("paid confirmation is one original request and explicit provider only; no global settings or account changes",async t=>{
 const e=setup();t.after(()=>e.dispose());const q=await e.queued();const before=structuredClone(e.settings);const quote=await e.queue.quotePaid(q.id,q.revision,"codex");const launched=await e.queue.confirmPaid(quote,5000);
 assert.equal(launched.kind,"started");if(launched.kind!=="started")throw Error("Not started");assert.equal(launched.task.provider,"codex");assert.deepEqual(e.settings,before);
 const evidence=JSON.parse(e.registry.latestEvent(launched.task.id,"paid-start-approved")!.text);assert.equal(evidence.requestId,q.id);assert.equal(evidence.provider,"codex");assert.equal(evidence.quotas.length,2);
 await assert.rejects(e.queue.confirmPaid(quote,5000));assert.equal(e.boat.calls.filter(c=>c.startsWith("create ")).length,1);
 assert.equal(e.harness.sdk.calls.filter(c=>/account|setting/i.test(c.path)).length,0);
});
test("expired, changed, cancelled, unavailable and unknown-usage paid requests never allocate",async t=>{
 for(const change of ["expired","usage","cancel","provider","unknown","beforeInsert"] as const){const e=setup();t.after(()=>e.dispose());const q=await e.queued();const quote=await e.queue.quotePaid(q.id,q.revision,"codex");
 if(change==="expired")e.advance(300001);if(change==="usage")e.setUsage(quotas(96,97));if(change==="cancel")e.queue.cancel(q.id,q.revision);if(change==="provider")e.setSettings({agents:"claude"});if(change==="unknown")e.setUsage(new Map());
 if(change==="beforeInsert"){const at=e.freshReads+2;e.setFresh(n=>{if(n===at)e.setUsage(quotas(98,99));});}
 await assert.rejects(e.queue.confirmPaid(quote,5000));assert.equal(e.registry.list().length,0);assert.equal(e.boat.calls.length,0);}
});
test("settings changes during confirmation or async preparation invalidate paid approval and return automatic work to waiting",async t=>{
 for(const phase of ["quote","paid-preflight","auto-preflight"] as const){const e=setup();t.after(()=>e.dispose());const q=await e.queued();const quote=phase==="auto-preflight"?null:await e.queue.quotePaid(q.id,q.revision,"codex");
 if(phase==="quote"){e.setSettings({machineType:"large"});await assert.rejects(e.queue.confirmPaid(quote!,5000));}
 else {const hold=gate();let entered=false;e.setPreflight(async()=>{entered=true;await hold.promise;});if(!quote)e.setUsage(quotas(10,20));const work=quote?e.queue.confirmPaid(quote,5000):e.queue.tick();await until(()=>entered);e.setSettings({relay:{...e.settings.relay,switchAtPercent:99}});hold.release();if(quote)await assert.rejects(work);else await work;}
 assert.equal(e.queue.get(q.id)!.state,"waiting");assert.equal(e.registry.list().length,0);assert.equal(e.boat.calls.length,0);}
});
test("native paid interaction returns promptly, deduplicates, and requires a matching explicit Start submission",async t=>{
 for(const choice of ["wait","wrong-id","start","cancel","stale-usage","closed-source"] as const){const e=setup();t.after(()=>e.dispose());const q=await e.queued();
 const interaction=createPaidStartInteractions({queue:e.queue,waitMs:5000,requestInput:(r,o)=>e.bb.ui.requestInput(r,o),changed(){}});t.after(()=>interaction.dispose());
 const request=interaction.request({id:q.id,revision:q.revision,provider:"codex"});assert.equal(request.pending,true);assert.equal(request.threadId,"thr_orch");assert.equal(interaction.request({id:q.id,revision:q.revision,provider:"codex"}).duplicate,true);
 await until(()=>e.harness.inspection.pendingInteractions.length>0);const pending=e.harness.inspection.pendingInteractions[0]!;assert.equal(pending.rendererId,"paid-task-start");assert.equal(e.boat.calls.length,0);
 if(choice==="stale-usage")e.setUsage(quotas(96,98));if(choice==="closed-source")e.setClosed();
 if(choice==="cancel")e.harness.behavior.cancelInteraction(pending.id);else e.harness.behavior.submitInteraction(pending.id,{requestId:choice==="wrong-id"?"stale":request.requestId,choice:choice==="wait"?"wait":"start"} as never);
 await interaction.settled();assert.equal(e.boat.calls.filter(c=>c.startsWith("create ")).length,choice==="start"?1:0);assert.equal(e.harness.sdk.callsTo("threads.send").length,0);assert.equal(e.harness.sdk.callsTo("threads.spawn").length,0);if(choice==="wrong-id")assert.match(e.queue.get(q.id)!.message,/choice is invalid/);if(choice==="stale-usage")assert.match(e.queue.get(q.id)!.message,/usage changed/);if(choice==="closed-source")assert.equal(e.queue.get(q.id)!.state,"cancelled");}
});
test("an unavailable paid reviewer publishes queue feedback without opening a question or waking an agent",async t=>{
 const e=setup();t.after(()=>e.dispose());const q=await e.queued();e.setSettings({notConnectedAgents:["codex"]});const interaction=createPaidStartInteractions({queue:e.queue,waitMs:5000,requestInput:(r,o)=>e.bb.ui.requestInput(r,o),changed(){}});t.after(()=>interaction.dispose());
 interaction.request({id:q.id,revision:q.revision,provider:"codex"});await interaction.settled();assert.match(e.queue.get(q.id)!.message,/selected agent is unavailable/);assert.equal(e.harness.inspection.pendingInteractions.length,0);assert.equal(e.harness.sdk.callsTo("threads.send").length,0);assert.equal(e.harness.sdk.callsTo("threads.spawn").length,0);assert.equal(e.boat.calls.length,0);
});
test("queue capacity and serialized data are bounded; corrupt original input cannot authorize a launch",async t=>{
 const e=setup();t.after(()=>e.dispose());for(let i=0;i<100;i++)await e.queued({title:`Task ${i}`});await assert.rejects(e.queued({title:"Overflow"}),/queue is full/);assert.equal(e.queue.list().length,100);assert.equal(e.boat.calls.length,0);
 const first=e.queue.list()[0]!;e.db.prepare("UPDATE start_queue SET input=? WHERE id=?").run(JSON.stringify({...input,provider:"codex"}),first.id);assert.throws(()=>e.queue.get(first.id),/data changed/);assert.equal(e.boat.calls.length,0);
});
test("fresh quota read bypasses cache and explicitly refreshes provider resources",async()=>{
 const refresh:boolean[]=[];let used=95;
 const bb={sdk:{plugins:{async callRpc({method,input}:{method:string,input:{refresh?:boolean}}){if(method.endsWith("listResources"))return{resources:[{id:"claude",providerId:"claude-code"}]};refresh.push(input.refresh===true);return{usage:{status:"ok",windows:[{label:"Weekly",usedPercent:used,resetsAt:null,model:null}]}};}}}};
 const reader=createQuotaReader(bb as never,{sources:["provider-claude-code"],cacheMs:60_000});assert.equal((await reader.read()).get("claude")!.usedPercent,95);used=10;assert.equal((await reader.read()).get("claude")!.usedPercent,95);assert.equal((await reader.read(undefined,{fresh:true})).get("claude")!.usedPercent,10);assert.deepEqual(refresh,[false,true]);
});

test("registered queue RPC reads/cancels actual persisted requests and refuses stale paid starts",async t=>{
 const e=setup();t.after(()=>e.dispose());const q=await e.queued();registerStartQueueRpc({bb:e.bb,startQueue:e.queue,launchWaitMs:5000,changed(){},tellOrchestrator:async()=>{}} as unknown as Runtime);
 const listed=await e.harness.callRpc("queuedStarts",{threadId:"thr_orch"}) as {requests:{id:string}[]};assert.equal(listed.requests[0]!.id,q.id);
 const cancelled=await e.harness.callRpc("cancelQueuedStart",{id:q.id,revision:q.revision}) as {state:string};assert.equal(cancelled.state,"cancelled");
 await assert.rejects(e.harness.callRpc("requestPaidStart",{id:q.id,revision:q.revision,provider:"codex"}));assert.equal(e.harness.inspection.pendingInteractions.length,0);assert.equal(e.boat.calls.length,0);
});
test("a post-insertion provider failure keeps a terminal receipt and never automatically starts replacement work",async t=>{
 const e=setup();t.after(()=>e.dispose());const q=await e.queued();const quote=await e.queue.quotePaid(q.id,q.revision,"codex");e.boat.promptError=Error("Fake provider unavailable");await assert.rejects(e.queue.confirmPaid(quote,5000));
 const receipt=e.queue.get(q.id)!;assert.equal(receipt.state,"started");assert.equal(e.registry.get(receipt.taskId!)!.status,"failed");const calls=e.boat.calls.length;await e.start().tick();assert.equal(e.boat.calls.length,calls);
});
test("actual dispatch tool, task-start CLI and New Task RPC all return durable queued receipts without allocating",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"boat-queue-plugin-"));process.env.FAKE_BOAT_STATE=join(dir,"state.json");
 const {bb,harness}=await createTestHost({pluginId:"boat",settings:{boatPath:fileURLToPath(new URL("./fixtures/fake-boat.mjs",import.meta.url)),evidenceUploader:"",agents:"both",relayEnabled:true,avoidExtraUsage:true}});t.after(()=>harness.lifecycle.dispose());
 harness.sdk.stub("threads.get",async()=>({id:"thr_orch",environmentId:null,archivedAt:null,deletedAt:null}));harness.sdk.stub("threads.getPluginMetadata",async()=>({role:"orchestrator"}));harness.sdk.stub("threads.send",async()=>({ok:true,delivery:"sent"}));harness.sdk.stub("system.config",async()=>({primaryHostId:"host_1"}));
 harness.sdk.stub("plugins.callRpc",async({pluginId,method,input}:{pluginId:string;method:string;input:{resourceId?:string}})=>{
  if(pluginId!=="account-pool")throw Error("Fake source unavailable");
  if(method==="status.get")return{routing:{claude:true,codex:true},accounts:[{id:"c",provider:"claude",status:"ready"},{id:"x",provider:"codex",status:"ready"}]};
  if(method.endsWith("listResources"))return{resources:[{id:"c",providerId:"claude-code"},{id:"x",providerId:"codex"}]};
  return{usage:{status:"ok",windows:[{label:"Weekly limit",usedPercent:input.resourceId==="c"?95:97,resetsAt:"2026-11-08T00:00:00Z",model:null}]}};
 });
 await plugin(bb);
 const tool=await harness.callAgentTool("boat_dispatch",{title:"Tool work",brief:input.brief,repo:input.repo,tier:"build",reason:"Normal implementation"},{threadId:"thr_orch"});
 const toolText=typeof tool==="string"?tool:(tool.content as {type:string;text?:string}[]).map(c=>c.text??"").join("\n");assert.match(toolText,/::boat-start-queue\{id="qs_/);assert.match(toolText,/No sandbox has been created/);
 const cli=await harness.runCli(["task","start","--title","CLI work","--brief",input.brief,"--repo",input.repo!,"--headless","--json"],{threadId:"thr_orch"});assert.equal(cli.exitCode,0,cli.stderr);assert.ok(JSON.parse(cli.stdout).queued.id);
 const rpc=await harness.callRpc("startTask",{title:"Page work",brief:input.brief,role:"implement",repo:input.repo!,branch:null,baseBranch:null,provider:null,model:null,sandbox:null,machineType:null,notifyThreadId:"thr_orch"}) as {queued:{id:string};pending:boolean};assert.ok(rpc.queued.id);assert.equal(rpc.pending,true);
 assert.equal((bb.storage.database().prepare("SELECT count(*) AS n FROM start_queue WHERE state='waiting'").get() as {n:number}).n,3);assert.equal((bb.storage.database().prepare("SELECT count(*) AS n FROM tasks").get() as {n:number}).n,0);
 assert.equal(harness.sdk.calls.filter(c=>/spawn|machine.*create|accounts.*(update|remove)/i.test(c.path)).length,0);
});
