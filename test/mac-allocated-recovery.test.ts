import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeBoat, FakeChat, fakeRepos, defaultSettings, memoryStore } from "./fakes.ts";
import { createBoatProvider } from "../src/providers/boat/provider.ts";
import type { BoatApi } from "../src/providers/boat/api.ts";
import { createProviderRegistry } from "../src/providers/registry.ts";
import { createInstaboxProvider, machineName, instaboxLeaseInput } from "../src/providers/instabox/provider.ts";
import { BoatService } from "../src/service.ts";
import type { SandboxInfo, SandboxProvider } from "../src/providers/types.ts";
import { InstaboxCli } from "../src/providers/instabox/cli.ts";
import { InstaboxRest } from "../src/providers/instabox/api.ts";
// @ts-expect-error: a plain JavaScript fixture.
import { startFakeInstaboxApi } from "../src/providers/instabox/fixtures/fake-api.mjs";

async function fixture(repo:string|null=null) {
  const store=memoryStore(),boat=new FakeBoat(),chat=new FakeChat(),base=createBoatProvider(boat as unknown as BoatApi),calls:string[]=[];
  const start=new Date(Date.now()-1000).toISOString(),until=new Date(Date.now()+24*3_600_000-1000).toISOString();
  let machine:SandboxInfo|null=null;
  const provider:SandboxProvider={...base,id:"instabox",displayName:"Fake Instabox",idPattern:/^m_/,classifiesCreateErrors:true,macLeaseKind:"day",caps:{...base.caps,systems:["linux","macos"]},
    macModels:async()=>[{id:"m2",label:"M2",cpus:8,memoryMiB:12288,minimumCost:10.8,minimumHours:24,hourPrice:0.45,currency:"USD"}],
    create:async options=>{calls.push("create");machine={id:"m_fake_allocated",name:machineName(options.name),state:"idle",health:"ok",url:null,desktopUrl:null,environment:null,createdAt:start,archiveAfter:null,stoppedAt:null,setupStatus:null,error:null,system:"macos",scheduledReleaseAt:until,mac:{model:"m2",leaseId:"fake-lease",startedAt:start,chargeUntil:until,minimumCost:10.8,hourPrice:0.45,cpus:8,memoryMiB:12288}};return machine;},
    list:async()=>machine?[machine]:[],info:async()=>{calls.push("info");if(!machine)throw Error("missing fake machine");return machine;},findInfo:async()=>machine,
    delete:async()=>{calls.push("delete");},resume:async()=>{calls.push("resume");},extend:async()=>{calls.push("extend");return {ttlSeconds:60};},cancelLeaseRelease:async()=>{calls.push("cancel-release");},assertTaskReady:async()=>{calls.push("credentials");},processes:async()=>({processes:[],live:true,sampledAt:new Date().toISOString()}),
  };
  const service=new BoatService(createProviderRegistry([base,provider]),store,{chat,repos:fakeRepos(boat),settings:async()=>defaultSettings({maxActiveSandboxes:0,workerMode:"chat"}),lifecycle:new AbortController().signal,changed(){},notify:async()=>{},log:{info(){},warn(){}}});
  await assert.rejects(service.startTask({title:"Native tools",brief:"Check fake native tools",role:"custom",repo,confirmUntrustedChat:repo?[repo]:null,sandboxSystem:"macos",runner:"chat"}),{code:"mac_rental_confirmation_required"});
  const source=store.list({limit:1})[0]!,quote=(await service.ownMacNotice(source))!.offer!;
  await assert.rejects(service.answerOwnMacRental(source.id,"rent",quote.id),{code:"lease_unknown"});
  const failed=store.list({limit:10}).find(task=>task.id!==source.id)!;
  const record=()=>store.macLeases.record({id:"instabox:fake-lease",provider:"instabox",machineId:machine!.id,size:"m2",startedAt:start,paidUntil:until,minimumCost:10.8,hourPrice:0.45,currency:"USD",cpus:8,memoryMiB:12288});
  return {service,store,source,failed,quote,calls,provider,chat,boat,record,machine:()=>machine!,setMachine:(patch:Partial<SandboxInfo>)=>{machine={...machine!,...patch};}};
}

test("lease admission failure preserves allocated physical Mac and durable task binding",async()=>{
  const env=await fixture();assert.equal(env.failed.turns,0);assert.equal(env.failed.threadId,null);
  assert.deepEqual(env.calls.filter(call=>["create","delete","resume","extend","cancel-release"].includes(call)),["create"]);
  assert.deepEqual(env.store.ownMacEventData(env.failed.id,"ownmac-allocation"),{machineId:env.machine().id,provider:"instabox",leaseId:"fake-lease",startedAt:env.machine().mac!.startedAt,ledgerLeaseId:instaboxLeaseInput(env.store.macLeases,env.machine())!.id});
});

test("explicit recovery starts the same task on its active paid Mac without changing release or renting",async()=>{
  const env=await fixture();const lease=env.record();env.store.macLeases.schedule(lease.id,env.machine().scheduledReleaseAt!);
  const result=await env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true);
  assert.equal(result.id,env.failed.id);assert.equal(result.turns,1);assert.equal(result.sandboxId,env.machine().id);
  assert.equal(env.store.list({limit:10}).length,2);assert.equal(env.chat.spawns.length,1);
  assert.equal(env.store.macLeases.held()[0]!.releaseAt,env.machine().scheduledReleaseAt);
  assert.deepEqual(env.calls.filter(call=>["create","delete","resume","extend","cancel-release"].includes(call)),["create"]);
});

for (const scenario of [
  {name:"missing explicit request",change:async(_env:Awaited<ReturnType<typeof fixture>>)=>{},approved:false,code:"approval_required"},
  {name:"changed physical model",change:async(env:Awaited<ReturnType<typeof fixture>>)=>env.setMachine({mac:{...env.machine().mac!,model:"m4"}})},
  {name:"changed paid minimum",change:async(env:Awaited<ReturnType<typeof fixture>>)=>env.setMachine({mac:{...env.machine().mac!,minimumCost:20}})},
  {name:"changed ongoing rate",change:async(env:Awaited<ReturnType<typeof fixture>>)=>env.setMachine({mac:{...env.machine().mac!,hourPrice:1}})},
  {name:"new physical lease",change:async(env:Awaited<ReturnType<typeof fixture>>)=>env.setMachine({mac:{...env.machine().mac!,leaseId:"another-lease"}})},
  {name:"stopped machine",change:async(env:Awaited<ReturnType<typeof fixture>>)=>env.setMachine({state:"stopped"})},
  {name:"uncertain health",change:async(env:Awaited<ReturnType<typeof fixture>>)=>env.setMachine({health:null})},
  {name:"near hand-back",change:async(env:Awaited<ReturnType<typeof fixture>>)=>env.setMachine({scheduledReleaseAt:new Date(Date.now()+60_000).toISOString()})},
  {name:"ended ledger",change:async(env:Awaited<ReturnType<typeof fixture>>)=>env.store.macLeases.end(env.store.macLeases.held()[0]!.id,"deleted")},
  {name:"provider-native work",change:async(env:Awaited<ReturnType<typeof fixture>>)=>{env.provider.conversations=async()=>[{id:"fake-work",harness:"codex",model:null,running:false,prompts:1,lastPromptAt:null,lastPromptPreview:null}];}},
  {name:"unknown process sample",change:async(env:Awaited<ReturnType<typeof fixture>>)=>{env.provider.processes=async()=>({live:null,sampledAt:null,processes:[]});}},
  {name:"busy processes",change:async(env:Awaited<ReturnType<typeof fixture>>)=>{env.provider.processes=async()=>({live:true,sampledAt:new Date().toISOString(),processes:[{pid:9,command:"npm run build",cpuPercent:90,memoryMb:200,commandId:null}]});}},
  {name:"original request cancelled",change:async(env:Awaited<ReturnType<typeof fixture>>)=>{await env.service.closeTask(env.source.id,{status:"cancelled"});}},
  {name:"credentials unavailable",change:async(env:Awaited<ReturnType<typeof fixture>>)=>{env.provider.assertTaskReady=async()=>{throw Error("fake credential unavailable");};},code:undefined},
  {name:"account unavailable",change:async(env:Awaited<ReturnType<typeof fixture>>)=>{env.provider.capacity=async()=>{throw Error("fake account unavailable");};},code:undefined},
]) test(`same-Mac recovery refuses ${scenario.name} without provider mutation`,async()=>{
  const env=await fixture(),lease=env.record();env.store.macLeases.schedule(lease.id,env.machine().scheduledReleaseAt!);
  await scenario.change(env);
  const before=env.calls.filter(call=>["create","delete","resume","extend","cancel-release"].includes(call));
  await assert.rejects(env.service.recoverAllocatedMac(env.failed.id,env.machine().id,scenario.approved!==false),scenario.name.includes("unavailable")?()=>true:{code:scenario.code ?? "mac_recovery_refused"});
  assert.equal(env.store.get(env.failed.id)!.status,"failed");assert.equal(env.chat.spawns.length,0);
  assert.deepEqual(env.calls.filter(call=>["create","delete","resume","extend","cancel-release"].includes(call)),before);
});

test("source cancellation during a current-machine read refuses recovery",async()=>{
  const env=await fixture(),lease=env.record();env.store.macLeases.schedule(lease.id,env.machine().scheduledReleaseAt!);
  const info=env.provider.info;let read!:()=>void,finish!:()=>void;
  const entered=new Promise<void>(resolve=>{read=resolve;}),gate=new Promise<void>(resolve=>{finish=resolve;});
  env.provider.info=async(...args)=>{const value=await info(...args);read();await gate;return value;};
  const recovery=env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true);
  await entered;await env.service.closeTask(env.source.id,{status:"cancelled"});finish();
  await assert.rejects(recovery,{code:"mac_recovery_refused"});assert.equal(env.chat.spawns.length,0);
});

test("concurrent recovery requests can dispatch only one existing task",async()=>{
  const env=await fixture(),lease=env.record();env.store.macLeases.schedule(lease.id,env.machine().scheduledReleaseAt!);
  const outcomes=await Promise.allSettled([env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true),env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true)]);
  assert.equal(outcomes.filter(r=>r.status==="fulfilled").length,1);assert.equal(env.chat.spawns.length,1);
  assert.equal(env.calls.filter(call=>call==="create").length,1);
});

test("a full new-rental quota does not consume another start to recover the existing paid Mac",async()=>{
  const env=await fixture(),lease=env.record();env.store.macLeases.schedule(lease.id,env.machine().scheduledReleaseAt!);
  const capacity=await env.provider.capacity();env.provider.capacity=async()=>({...capacity,canStart:false,blockedReason:"No new-rental quota."});
  assert.equal((await env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true)).id,env.failed.id);
  assert.equal(env.calls.filter(call=>call==="create").length,1);
});

test("lease_unknown allocation cannot be deleted by closing the failed task with no ledger",async()=>{
  const env=await fixture();await env.service.closeTask(env.failed.id,{status:"cancelled",discard:true});
  assert.equal(env.calls.filter(call=>call==="delete").length,0);
});

test("recovery can prepare the original repository and enroll its existing Mac once",async()=>{
  const env=await fixture("acme/web"),lease=env.record();env.store.macLeases.schedule(lease.id,env.machine().scheduledReleaseAt!);
  const result=await env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true);
  assert.equal(result.id,env.failed.id);assert.equal(result.repo,"acme/web");assert.ok(result.repoPath);assert.equal(result.turns,1);
  assert.equal(env.boat.prepared.length,1);assert.equal(env.chat.machines.length,1);assert.equal(env.chat.spawns.length,1);
});

test("legacy allocation recovery binds the normalized provider name when app allocation fields are absent",async()=>{
  const env=await fixture(),lease=env.record();env.store.macLeases.schedule(lease.id,env.machine().scheduledReleaseAt!);
  env.store.update(env.failed.id,{sandboxId:null});env.store.addOwnMacEvent(env.failed.id,"ownmac-allocation","legacy fixture",null);env.store.addOwnMacEvent(env.failed.id,"ownmac-rental-approved","legacy fixture",null);
  assert.equal((await env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true)).id,env.failed.id);
});

test("legacy task refuses a different provider machine name",async()=>{
  const env=await fixture(),lease=env.record();env.store.macLeases.schedule(lease.id,env.machine().scheduledReleaseAt!);
  env.store.update(env.failed.id,{sandboxId:null});env.store.addOwnMacEvent(env.failed.id,"ownmac-allocation","legacy fixture",null);env.setMachine({name:"unrelated-machine"});
  await assert.rejects(env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true),{code:"mac_recovery_refused"});assert.equal(env.chat.spawns.length,0);
});

test("an in-flight read cannot revive a lease ended after the read began",async()=>{
  const env=await fixture(),lease=env.record();env.store.macLeases.schedule(lease.id,env.machine().scheduledReleaseAt!);
  const info=env.provider.info;let read!:()=>void,finish!:()=>void;
  const entered=new Promise<void>(resolve=>{read=resolve;}),gate=new Promise<void>(resolve=>{finish=resolve;});
  env.provider.info=async(...args)=>{const value=await info(...args);read();await gate;return value;};
  const recovery=env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true);await entered;
  env.store.macLeases.end(lease.id,"deleted",Date.now(),"inferred");finish();
  await assert.rejects(recovery,{code:"mac_recovery_refused"});assert.equal(env.store.macLeases.held().length,0);assert.equal(env.chat.spawns.length,0);
});

test("failed chat setup during recovery keeps the allocated Mac and its enrolled host",async()=>{
  const env=await fixture(),lease=env.record();env.store.macLeases.schedule(lease.id,env.machine().scheduledReleaseAt!);env.chat.spawnError=Error("fake chat unavailable");
  await assert.rejects(env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true),/fake chat unavailable/);
  assert.equal(env.chat.machines.length,1);assert.deepEqual(env.chat.removed,[]);assert.equal(env.store.macLeases.held()[0]!.releaseAt,env.machine().scheduledReleaseAt);
  assert.deepEqual(env.calls.filter(call=>["create","delete","resume","extend","cancel-release"].includes(call)),["create"]);
});

for (const entry of ["CLI","RPC"] as const) test(`public ${entry} recovers only the existing task after explicit request`,async t=>{
  const [{createFakePluginHost},{ProjectStore},{TaskStore},{createMigratingSettingsStore},{createRuntime},{registerRpc},{buildCli}]=await Promise.all([
    import("@get-bb/plugin-sdk/testing"),import("../src/projects.ts"),import("../src/store.ts"),import("../src/settings-store.ts"),import("../src/runtime.ts"),import("../src/rpc.ts"),import("../src/cli.ts"),
  ]);
  const env=await fixture(),lease=env.record();env.store.macLeases.schedule(lease.id,env.machine().scheduledReleaseAt!);
  const {bb,harness}=createFakePluginHost({pluginId:"boat"});bb.storage.migrate(bb.storage.database(),TaskStore.migrations());
  const projects=new ProjectStore(()=>bb.storage.database()),settings=await createMigratingSettingsStore(bb);
  const runtime=createRuntime({bb,service:env.service,projects,settings,protocol:{read:()=>({text:"",custom:false,path:"",updatedAt:null})} as unknown as import("../src/protocol.ts").ProtocolStore,readRepoFile:async()=>"",changed(){},wake(){}});
  t.after(async()=>{runtime.startQueue.dispose();await harness.lifecycle.dispose();});registerRpc(runtime);bb.cli.register(buildCli(runtime));
  if (entry==="CLI") {
    const options=await harness.runCli(["task","rental-options",env.source.id]);
    assert.match(options.stdout,/Approval was consumed/);assert.doesNotMatch(options.stdout,/Nothing was rented|Approve the exact/);
    const refused=await harness.runCli(["task","recover-mac",env.failed.id,env.machine().id,"--json"]);assert.notEqual(refused.exitCode,0);assert.match(refused.stderr,/explicit request/);
    const recovered=await harness.runCli(["task","recover-mac",env.failed.id,env.machine().id,"--user-approved","--json"]);assert.equal(recovered.exitCode,0,recovered.stderr);assert.equal(JSON.parse(recovered.stdout).id,env.failed.id);
  } else {
    await assert.rejects(harness.callRpc("recoverAllocatedMac",{taskId:env.failed.id,machineId:env.machine().id,userApproved:false}),/explicit request/);
    assert.deepEqual(await harness.callRpc("recoverAllocatedMac",{taskId:env.failed.id,machineId:env.machine().id,userApproved:true}),{taskId:env.failed.id,machineId:env.machine().id});
  }
  assert.equal(env.calls.filter(call=>call==="create").length,1);assert.equal(env.chat.spawns.length,1);
});

for (const shape of ["current unadmitted physical lease","stopped current physical lease","active Mac missing lease terms"] as const) test(`placement cannot rent another Mac alongside ${shape}`,async()=>{
  const env=await fixture();
  if (shape==="stopped current physical lease") env.setMachine({state:"stopped"});
  if (shape==="active Mac missing lease terms") env.setMachine({mac:undefined});
  await assert.rejects(env.service.startTask({title:"Another native task",brief:"Fake native work",role:"custom",sandboxSystem:"macos",runner:"chat"}),{code:"lease_unknown"});
  assert.equal(env.calls.filter(call=>call==="create").length,1);
});

test("provider-known allocation metadata survives creation_allocated without inventing a successful create",async()=>{
  const env=await fixture();
  // A separate fresh request cannot reuse the first fixture's allocated Mac.
  env.provider.list=async()=>[];
  env.provider.create=async()=>{throw Object.assign(Error("fake allocated registration failure"),{code:"creation_allocated",machineId:"m_secondfake",leaseId:"known-fake"});};
  await assert.rejects(env.service.startTask({title:"Another native task",brief:"Fake native work",role:"custom",sandboxSystem:"macos",runner:"chat"}),{code:"mac_rental_confirmation_required"});
  const source=env.store.list({limit:10}).find(t=>t.title==="Another native task")!,quote=(await env.service.ownMacNotice(source))!.offer!;
  await assert.rejects(env.service.answerOwnMacRental(source.id,"rent",quote.id),{code:"creation_allocated"});
  const failed=env.store.list({limit:10}).find(t=>t.title===source.title&&t.id!==source.id)!;
  assert.equal(failed.sandboxId,null);assert.deepEqual(env.store.ownMacEventData(failed.id,"ownmac-allocation"),{machineId:"m_secondfake",provider:"instabox",leaseId:"known-fake"});
  assert.equal(env.calls.filter(call=>call==="delete").length,0);
});

test("legacy evidence cannot authorize a fresh physical lease begun after the failure",async()=>{
  const env=await fixture();
  env.store.addOwnMacEvent(env.failed.id,"ownmac-allocation","legacy fixture",null);
  const failedAt=new Date(Date.now()-10_000).toISOString();env.store.update(env.failed.id,{finishedAt:failedAt});
  const start=new Date(Date.now()-1000).toISOString(),until=new Date(Date.now()+24*3_600_000-1000).toISOString();
  env.setMachine({mac:{...env.machine().mac!,startedAt:start,chargeUntil:until},scheduledReleaseAt:until});
  await assert.rejects(env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true),{code:"mac_recovery_refused"});
  assert.equal(env.chat.spawns.length,0);assert.equal(env.calls.filter(call=>call==="create").length,1);
});

test("Mac maintenance preserves held accounting when an authoritative read fails",async()=>{
  const env=await fixture(),lease=env.record();env.store.macLeases.schedule(lease.id,env.machine().scheduledReleaseAt!);
  env.provider.findInfo=async()=>{throw Error("fake account temporarily unavailable");};
  await assert.rejects(env.service.processMacLeases(),/fake account temporarily unavailable/);
  assert.equal(env.store.macLeases.held()[0]!.id,lease.id);assert.equal(env.store.macLeases.held()[0]!.releaseAt,env.machine().scheduledReleaseAt);
  assert.equal(env.calls.filter(call=>call==="delete").length,0);
});

test("cancelling the source request during recovered chat spawn stops and archives the late chat",async()=>{
  const env=await fixture(),lease=env.record();env.store.macLeases.schedule(lease.id,env.machine().scheduledReleaseAt!);
  const spawn=env.chat.spawn.bind(env.chat);let entered!:()=>void,finish!:()=>void;
  const spawning=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{finish=resolve;});
  env.chat.spawn=async args=>{const created=await spawn(args);entered();await gate;return created;};
  const recovery=env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true);
  await spawning;await env.service.closeTask(env.source.id,{status:"cancelled"});finish();
  const result=await recovery;
  assert.equal(result.status,"cancelled");assert.equal(env.store.get(env.failed.id)!.status,"cancelled");assert.equal(env.store.get(env.failed.id)!.turns,0);
  const thread=env.chat.spawns[0]!.threadId;assert.ok(env.chat.stopped.includes(thread));assert.ok(env.chat.archived.includes(thread));
  assert.equal(env.store.macLeases.held()[0]!.releaseAt,env.machine().scheduledReleaseAt);assert.deepEqual(env.chat.removed,[]);
  assert.deepEqual(env.calls.filter(call=>["create","delete","resume","extend","cancel-release"].includes(call)),["create"]);
});

async function legacyDeletedFixture(t:TestContext) {
  const env=await fixture(),lease=env.record();
  const db=(env.store as unknown as {db:()=>import("node:sqlite").DatabaseSync}).db();
  // Neutral synthetic chronology: approval precedes allocation, then failed
  // admission and a legacy local deletion follow the same physical start.
  const minute=Date.UTC(2031,4,7,9,42);
  const at=(offset:number)=>new Date(minute+offset).toISOString();
  const approvalAt=at(11_000),createdAt=at(11_200),failedAt=at(31_299),endedAt=at(32_793);
  const startedAt=at(27_670).replace("670Z","670853Z");
  const paidUntil=new Date(minute+27_670+86_400_000).toISOString().replace("670Z","670853Z");
  db.prepare("UPDATE tasks SET created_at=? WHERE id=?").run(at(5000),env.source.id);
  db.prepare("UPDATE tasks SET created_at=? WHERE id=?").run(createdAt,env.failed.id);
  env.store.update(env.source.id,{updatedAt:at(31_301),finishedAt:at(6000)});
  env.store.update(env.failed.id,{updatedAt:failedAt,finishedAt:failedAt,sandboxId:null});
  const quote={...env.quote,checkedAt:at(10_000),expiresAt:at(610_000)};
  env.store.addOwnMacEvent(env.source.id,"ownmac-rental-offer","Synthetic pre-approval quote",quote);
  db.prepare("UPDATE task_events SET at=? WHERE task_id=? AND kind='ownmac-rental-offer'").run(at(10_000),env.source.id);
  db.prepare("UPDATE task_events SET at=? WHERE task_id=? AND kind='ownmac-rental-answer' AND json_extract(metadata,'$.ownMac.answer')='rent'").run(approvalAt,env.source.id);
  db.prepare("UPDATE task_events SET at=? WHERE task_id=? AND kind='ownmac-rental-answer' AND json_extract(metadata,'$.ownMac.answer')='failed'").run(at(31_301),env.source.id);
  db.prepare("UPDATE task_events SET at=? WHERE task_id=? AND kind='created'").run(createdAt,env.failed.id);
  db.prepare("UPDATE task_events SET at=? WHERE task_id=? AND kind='failed'").run(at(31_300),env.failed.id);
  env.store.macLeases.end(lease.id,"deleted",Date.parse(endedAt));
  db.prepare("UPDATE mac_leases SET id=?,started_at=?,paid_until=?,end_evidence='legacy' WHERE id=?").run("instabox:73",startedAt,paidUntil,lease.id);
  lease.id="instabox:73";lease.startedAt=startedAt;lease.paidUntil=paidUntil;
  env.setMachine({createdAt:startedAt,mac:{...env.machine().mac!,leaseId:"73",startedAt,chargeUntil:paidUntil},scheduledReleaseAt:paidUntil});
  env.store.addOwnMacEvent(env.failed.id,"ownmac-allocation","legacy allocation evidence",null);
  env.store.addOwnMacEvent(env.failed.id,"ownmac-rental-approved","legacy approval evidence",null);
  t.mock.timers.enable({apis:["Date"],now:minute+40_000});
  assert.ok(Date.parse(approvalAt)<Date.parse(createdAt));assert.ok(Date.parse(createdAt)<Date.parse(startedAt));assert.ok(Date.parse(startedAt)<Date.parse(failedAt));
  return {...env,lease,endedAt,adoption:{ledgerId:lease.id,leaseId:env.machine().mac!.leaseId,sourceTaskId:env.source.id,startedAt:lease.startedAt,paidUntil:lease.paidUntil,endedAt,failedAt,noReleaseRequested:true as const}};
}

async function publicHarness(env:Awaited<ReturnType<typeof fixture>>,t:{after(fn:()=>Promise<void>):void}) {
  const [{createFakePluginHost},{ProjectStore},{TaskStore},{createMigratingSettingsStore},{createRuntime},{registerRpc},{buildCli}]=await Promise.all([
    import("@get-bb/plugin-sdk/testing"),import("../src/projects.ts"),import("../src/store.ts"),import("../src/settings-store.ts"),import("../src/runtime.ts"),import("../src/rpc.ts"),import("../src/cli.ts"),
  ]);
  const {bb,harness}=createFakePluginHost({pluginId:"boat"});bb.storage.migrate(bb.storage.database(),TaskStore.migrations());
  const projects=new ProjectStore(()=>bb.storage.database()),settings=await createMigratingSettingsStore(bb);
  const runtime=createRuntime({bb,service:env.service,projects,settings,protocol:{read:()=>({text:"",custom:false,path:"",updatedAt:null})} as unknown as import("../src/protocol.ts").ProtocolStore,readRepoFile:async()=>"",changed(){},wake(){}});
  t.after(async()=>{runtime.startQueue.dispose();await harness.lifecycle.dispose();});registerRpc(runtime);bb.cli.register(buildCli(runtime));
  return harness;
}

function authoritativeProviderReads(env:Awaited<ReturnType<typeof fixture>>) {
  const cli={json:async(args:string[])=>{
    env.calls.push(`adapter:${args.join(" ")}`);
    assert.equal(args[0],"get","recovery adapter reads must never create or start a machine");
    const current=env.machine(),mac=current.mac!;
    return {machine:{id:current.id,name:current.name,state:"running",runtime:{ready:true},template:{id:"macos"},model:mac.model,
      metadata:{"created-by":"bb-boat","boat-mac-model":mac.model},spec:{vcpus:mac.cpus,memMiB:mac.memoryMiB},
      lease:{id:mac.leaseId,startedAt:mac.startedAt,chargeUntil:mac.chargeUntil,hourUSD:mac.hourPrice},deleteAt:current.scheduledReleaseAt}};
  }} as unknown as import("../src/providers/instabox/cli.ts").InstaboxCli;
  const provider=createInstaboxProvider(cli,{} as import("../src/providers/instabox/api.ts").InstaboxRest,{ledger:env.store.macLeases});
  env.provider.info=provider.info.bind(provider);
}

test("public RPC explicitly adopts the same legacy deleted lease ended just after failed admission",async t=>{
  const env=await legacyDeletedFixture(t),harness=await publicHarness(env,t);
  authoritativeProviderReads(env);
  env.provider.scheduleLeaseRelease=async()=>{env.calls.push("schedule-release");};
  env.calls.length=0; // The physical allocation predates this recovery operation.
  const rawBefore=(env.store as unknown as {db:()=>import("node:sqlite").DatabaseSync}).db().prepare("SELECT * FROM mac_leases WHERE id=?").get(env.lease.id);
  assert.deepEqual(await harness.callRpc("recoverAllocatedMac",{taskId:env.failed.id,machineId:env.machine().id,userApproved:true,adoptLegacyLease:env.adoption}),{taskId:env.failed.id,machineId:env.machine().id});
  assert.equal(env.store.get(env.failed.id)!.turns,1);assert.equal(env.store.list({limit:10}).length,2);
  assert.equal(env.store.macLeases.held()[0]!.id,env.lease.id);assert.equal(env.store.macLeases.held()[0]!.releaseAt,env.machine().scheduledReleaseAt);
  assert.equal(env.store.macLeases.list().length,1);assert.equal(env.store.macLeases.summary().month.costs.USD,10.8);
  const usage=await harness.callRpc("macUsage",null) as import("../contract-providers.ts").MacUsageDto;
  assert.equal(usage.held.length,1);assert.equal(usage.month.costs.USD,10.8);
  assert.equal(usage.adoptions?.[0]?.operatorProof.ledgerId,env.lease.id);
  assert.equal(usage.adoptions?.[0]?.original.endedAt,env.endedAt);
  assert.match(usage.notices?.[0]?.text ?? "",/Original history is retained/);
  const rawAfter=(env.store as unknown as {db:()=>import("node:sqlite").DatabaseSync}).db().prepare("SELECT * FROM mac_leases WHERE id=?").get(env.lease.id);assert.deepEqual(rawAfter,rawBefore);
  assert.deepEqual(env.calls.filter(call=>["create","delete","resume","extend","cancel-release","schedule-release"].includes(call)),[],"zero physical allocation, renewal, extension or release-schedule mutations during recovery");
});

test("public CLI requires explicit exact evidence to adopt a legacy deleted physical lease",async t=>{
  const env=await legacyDeletedFixture(t),harness=await publicHarness(env,t);
  const refused=await harness.runCli(["task","recover-mac",env.failed.id,env.machine().id,"--user-approved","--json"]);assert.notEqual(refused.exitCode,0);
  assert.equal(env.store.macLeases.held().length,0);
  const result=await harness.runCli(["task","recover-mac",env.failed.id,env.machine().id,"--user-approved","--adopt-legacy-lease",JSON.stringify(env.adoption),"--json"]);
  assert.equal(result.exitCode,0,result.stderr);assert.equal(JSON.parse(result.stdout).id,env.failed.id);
  assert.deepEqual((env.store.ownMacEventData(env.failed.id,"ownmac-legacy-adoption") as {proof:unknown}).proof,env.adoption);
  assert.deepEqual(env.calls.filter(call=>["create","delete","resume","extend","cancel-release"].includes(call)),["create"]);
});

for (const [name,mutate] of [
  ["wrong original approval",(env:Awaited<ReturnType<typeof legacyDeletedFixture>>)=>{env.adoption.sourceTaskId="t_wrong_source";}],
  ["wrong physical lease",(env:Awaited<ReturnType<typeof legacyDeletedFixture>>)=>{env.adoption.leaseId="another-physical-lease";}],
  ["wrong historical row",(env:Awaited<ReturnType<typeof legacyDeletedFixture>>)=>{env.adoption.ledgerId="instabox:wrong-row";}],
  ["wrong recorded failure time",(env:Awaited<ReturnType<typeof legacyDeletedFixture>>)=>{env.adoption.failedAt=new Date(Date.parse(env.adoption.failedAt)+1).toISOString();}],
  ["confirmed termination",(env:Awaited<ReturnType<typeof legacyDeletedFixture>>)=>{(env.store as unknown as {db:()=>import("node:sqlite").DatabaseSync}).db().prepare("UPDATE mac_leases SET end_evidence='confirmed' WHERE id=?").run(env.lease.id);}],
  ["handed-back termination",(env:Awaited<ReturnType<typeof legacyDeletedFixture>>)=>{(env.store as unknown as {db:()=>import("node:sqlite").DatabaseSync}).db().prepare("UPDATE mac_leases SET end_reason='handed back' WHERE id=?").run(env.lease.id);}],
  ["delayed termination",(env:Awaited<ReturnType<typeof legacyDeletedFixture>>)=>{env.adoption.endedAt=new Date(Date.parse(env.adoption.failedAt)+10_001).toISOString();(env.store as unknown as {db:()=>import("node:sqlite").DatabaseSync}).db().prepare("UPDATE mac_leases SET ended_at=? WHERE id=?").run(env.adoption.endedAt,env.lease.id);}],
] as const) test(`explicit legacy adoption refuses ${name} without changing effective billing`,async t=>{
  const env=await legacyDeletedFixture(t);mutate(env);
  await assert.rejects(env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true,env.adoption),{code:"mac_recovery_refused"});
  assert.equal(env.store.macLeases.held().length,0);assert.equal(env.store.macLeases.adoptions().length,0);assert.equal(env.chat.spawns.length,0);
  assert.equal(env.store.macLeases.summary().month.costs.USD,10.8);
});

test("explicit adoption does not silently ignore evidence on an ordinary held lease",async t=>{
  const env=await fixture(),lease=env.record();env.store.macLeases.schedule(lease.id,env.machine().scheduledReleaseAt!);
  const proof={ledgerId:lease.id,leaseId:"wrong-physical",sourceTaskId:env.source.id,startedAt:lease.startedAt,paidUntil:lease.paidUntil,endedAt:new Date(Date.now()).toISOString(),failedAt:env.failed.finishedAt!,noReleaseRequested:true as const};
  await assert.rejects(env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true,proof),{code:"mac_recovery_refused"});assert.equal(env.chat.spawns.length,0);
});

test("adoption binds task failure time while accepting a failure event persisted a millisecond later",async t=>{
  const env=await legacyDeletedFixture(t),db=(env.store as unknown as {db:()=>import("node:sqlite").DatabaseSync}).db();
  db.prepare("UPDATE task_events SET at=? WHERE task_id=? AND kind='failed'").run(new Date(Date.parse(env.adoption.failedAt)+1).toISOString(),env.failed.id);
  assert.equal((await env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true,env.adoption)).id,env.failed.id);
});

for(const failure of ["credentials","quota","project trust"] as const)test(`legacy adoption remains absent when final ${failure} validation refuses`,async t=>{
  const env=await legacyDeletedFixture(t);
  if(failure==="credentials")env.provider.assertTaskReady=async()=>{throw Error("fake credential check refused");};
  if(failure==="quota")env.service.assertSubscriptionRoom=async()=>{throw Error("fake quota check refused");};
  if(failure==="project trust") {const hooks=(env.service as unknown as {hooks:import("../src/service.ts").ServiceHooks}).hooks;hooks.settings=async()=>defaultSettings({maxActiveSandboxes:0,workerMode:"boat"});}
  await assert.rejects(env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true,env.adoption));
  assert.equal(env.store.macLeases.adoptions().length,0);assert.equal(env.store.macLeases.held().length,0);assert.equal(env.chat.spawns.length,0);
});

for(const change of ["physical microseconds","paid-until microseconds","owner keep intent"] as const)test(`explicit adoption refuses changed ${change}`,async t=>{
  const env=await legacyDeletedFixture(t);
  if(change==="physical microseconds")env.setMachine({mac:{...env.machine().mac!,startedAt:env.machine().mac!.startedAt.replace("853Z","001Z")}});
  if(change==="paid-until microseconds")env.setMachine({mac:{...env.machine().mac!,chargeUntil:env.machine().mac!.chargeUntil.replace("853Z","001Z")}});
  if(change==="owner keep intent")(env.store as unknown as {db:()=>import("node:sqlite").DatabaseSync}).db().prepare("UPDATE mac_leases SET kept=1 WHERE id=?").run(env.lease.id);
  await assert.rejects(env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true,env.adoption),{code:"mac_recovery_refused"});assert.equal(env.store.macLeases.adoptions().length,0);
});

for(const action of ["stop","delete"] as const)test(`a failed owner ${action} request vetoes explicit legacy adoption`,async t=>{
  const env=await legacyDeletedFixture(t);
  env.provider.stop=async()=>{throw Error("fake provider refused stop");};env.provider.delete=async()=>{throw Error("fake provider refused delete");};
  await assert.rejects(env.service.sandboxAction(env.machine().id,action,0));
  assert.equal(env.store.macLeases.releaseIntent(env.machine().id)?.action,action);
  await assert.rejects(env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true,env.adoption),{code:"mac_recovery_refused"});assert.equal(env.store.macLeases.adoptions().length,0);
});

test("owner deletion intent arriving during a stale provider read prevents legacy adoption",async t=>{
  const env=await legacyDeletedFixture(t),info=env.provider.info;let enter!:()=>void,finish!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{finish=resolve;});
  env.provider.info=async(...args)=>{const current=await info(...args);enter();await gate;return current;};
  env.provider.delete=async()=>{throw Error("fake failed delete");};
  const recovery=env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true,env.adoption);
  await entered;await assert.rejects(env.service.sandboxAction(env.machine().id,"delete",0));finish();
  await assert.rejects(recovery,{code:"mac_recovery_refused"});assert.equal(env.store.macLeases.adoptions().length,0);assert.equal(env.chat.spawns.length,0);
});

test("a previously recorded local release plan is outside explicit failed-start adoption",async t=>{
  const env=await legacyDeletedFixture(t);
  (env.store as unknown as {db:()=>import("node:sqlite").DatabaseSync}).db().prepare("UPDATE mac_leases SET release_at=? WHERE id=?").run(env.lease.paidUntil,env.lease.id);
  await assert.rejects(env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true,env.adoption),{code:"mac_recovery_refused"});assert.equal(env.store.macLeases.adoptions().length,0);
});

test("source cancellation during the final adoption read leaves the raw end and overlay unchanged",async t=>{
  const env=await legacyDeletedFixture(t),info=env.provider.info;let count=0,enter!:()=>void,finish!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{finish=resolve;});
  env.provider.info=async(...args)=>{const current=await info(...args);if(++count===2){enter();await gate;}return current;};
  const recovery=env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true,env.adoption);
  await entered;await env.service.closeTask(env.source.id,{status:"cancelled"});finish();
  await assert.rejects(recovery,{code:"mac_recovery_refused"});assert.equal(env.store.macLeases.adoptions().length,0);assert.equal(env.store.macLeases.held().length,0);
  assert.equal(env.store.macLeases.rawList()[0]!.endedAt,env.endedAt);assert.equal(env.chat.spawns.length,0);
});

test("failed task admission atomically rolls back the explicit legacy overlay",async t=>{
  const env=await legacyDeletedFixture(t);env.store.transition=()=>null;
  await assert.rejects(env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true,env.adoption),{code:"mac_recovery_refused"});
  assert.equal(env.store.macLeases.adoptions().length,0);assert.equal(env.store.macLeases.held().length,0);assert.equal(env.store.get(env.failed.id)!.status,"failed");assert.equal(env.store.macLeases.rawList()[0]!.endedAt,env.endedAt);
});

test("ordinary recovery cannot bypass a later durable owner deletion intent",async()=>{
  const env=await fixture(),lease=env.record();env.store.macLeases.schedule(lease.id,env.machine().scheduledReleaseAt!);
  env.provider.delete=async()=>{throw Error("fake failed owner delete");};
  await assert.rejects(env.service.sandboxAction(env.machine().id,"delete",0));
  await assert.rejects(env.service.recoverAllocatedMac(env.failed.id,env.machine().id,true),{code:"mac_recovery_refused"});
  assert.equal(env.chat.spawns.length,0);assert.equal(env.store.macLeases.held()[0]!.releaseAt,env.machine().scheduledReleaseAt);
});

/** Real Instabox reads over a child CLI and localhost HTTP; only setup/dispatch
 * stay fake. No sample's live flag is assigned by the service test adapter. */
async function processAdapter(env:Awaited<ReturnType<typeof fixture>>,t:TestContext) {
  const dir=mkdtempSync(join(tmpdir(),"instabox-process-recovery-")),statePath=join(dir,"state.json");
  const current=env.machine(),mac=current.mac!;
  const machine={id:current.id,name:current.name,state:"running",runtime:{ready:true},template:{id:"macos"},model:mac.model,
    metadata:{"created-by":"bb-boat","boat-mac-model":mac.model},spec:{vcpus:mac.cpus,memMiB:mac.memoryMiB},
    lease:{id:mac.leaseId,startedAt:mac.startedAt,chargeUntil:mac.chargeUntil,hourUSD:mac.hourPrice},deleteAt:current.scheduledReleaseAt};
  writeFileSync(statePath,JSON.stringify({machines:{[current.id]:machine}}));
  const state=()=>JSON.parse(readFileSync(statePath,"utf8"));
  const patch=(change:Record<string,unknown>)=>writeFileSync(statePath,JSON.stringify({...state(),...change}));
  const api=await startFakeInstaboxApi({statePath,key:"ibk_fake_process_sample"});
  t.after(async()=>{await api.close();rmSync(dir,{recursive:true,force:true});});
  const cli=new InstaboxCli(async()=>fileURLToPath(new URL("../src/providers/instabox/fixtures/fake-instabox.mjs",import.meta.url)),async()=>"ibk_fake_process_sample");
  const cliEnv=cli.env.bind(cli);
  cli.env=async()=>({...await cliEnv(),FAKE_INSTABOX_STATE:statePath,FAKE_INSTABOX_KEY:"ibk_fake_process_sample"});
  const rest=new InstaboxRest({key:async()=>"ibk_fake_process_sample",baseUrl:()=>api.url});
  const adapter=createInstaboxProvider(cli,rest,{ledger:env.store.macLeases});
  env.provider.info=adapter.info.bind(adapter);
  env.provider.conversations=adapter.conversations.bind(adapter);
  env.provider.processes=adapter.processes.bind(adapter);
  const sample=()=>({machineId:current.id,state:"running",live:true,capturedAt:new Date().toISOString(),trigger:"request",truncated:false,
    processes:[{pid:1,ppid:0,user:"root",cpuPercent:0,memPercent:0.1,elapsedSeconds:60,command:"/sbin/launchd"}]});
  const assertReadsOnly=()=>{
    assert.ok(state().calls.every((call:string)=>call===`get ${current.id} --json` || call===`agent ls ${current.id} --json`),JSON.stringify(state().calls));
    assert.ok(api.received.every((call:{method:string;path:string;keyOk:boolean})=>call.method==="GET" && call.path===`/v1/machines/${current.id}/processes` && call.keyOk));
    assert.deepEqual(env.calls.filter(call=>["create","delete","resume","extend","cancel-release","schedule-release"].includes(call)),["create"]);
  };
  return {state,patch,api,sample,assertReadsOnly,adapter};
}

test("public recovery uses fresh complete Instabox evidence after refusing CLI rows with unknown liveness",async t=>{
  const env=await fixture(),lease=env.record(),box=await processAdapter(env,t),harness=await publicHarness(env,t);
  env.store.macLeases.schedule(lease.id,env.machine().scheduledReleaseAt!);
  // CLI ps --json's actual shape loses the envelope, including cached/truncated
  // provenance. The real adapter must refuse it even with a healthy idle get.
  box.patch({processSample:box.sample().processes});
  await assert.rejects(harness.callRpc("recoverAllocatedMac",{taskId:env.failed.id,machineId:env.machine().id,userApproved:true}),/current machine work state could not be confirmed idle/);
  assert.equal(env.chat.spawns.length,0);assert.equal(env.store.get(env.failed.id)!.turns,0);
  const fresh=box.sample();box.patch({processSample:fresh});
  assert.deepEqual(await harness.callRpc("recoverAllocatedMac",{taskId:env.failed.id,machineId:env.machine().id,userApproved:true}),{taskId:env.failed.id,machineId:env.machine().id});
  const observed=await box.adapter.processes(env.machine().id);
  assert.equal(observed.live,true);assert.equal(observed.sampledAt,fresh.capturedAt);
  assert.equal(env.chat.spawns.length,1);assert.equal(env.store.get(env.failed.id)!.turns,1);
  assert.equal(env.store.get(env.failed.id)!.sandboxId,env.machine().id);assert.equal(env.store.list({limit:10}).length,2);
  assert.equal(env.store.macLeases.held()[0]!.id,lease.id);assert.equal(env.store.macLeases.held()[0]!.releaseAt,env.machine().scheduledReleaseAt);
  assert.equal(env.store.macLeases.list().length,1);assert.equal(env.store.macLeases.summary().month.costs.USD,10.8);
  assert.ok(box.api.received.length>=3,"fresh reads repeat across recovery validation");box.assertReadsOnly();
});

for(const scenario of ["cached","stale","future","missing timestamp","invalid timestamp","unknown live","missing list","malformed row","missing CPU","invalid CPU","blank command","truncated","unknown completeness","wrong machine","stopped sample","stop trigger","HTTP error","malformed JSON","error envelope","busy"] as const) {
  test(`public recovery refuses ${scenario} from the real Instabox process adapter`,async t=>{
    const env=await fixture(),lease=env.record(),box=await processAdapter(env,t),harness=await publicHarness(env,t);
    env.store.macLeases.schedule(lease.id,env.machine().scheduledReleaseAt!);
    const sample:Record<string,any>=box.sample();
    if(scenario==="cached")sample.live=false;
    if(scenario==="stale")sample.capturedAt=new Date(Date.now()-60_000).toISOString();
    if(scenario==="future")sample.capturedAt=new Date(Date.now()+60_000).toISOString();
    if(scenario==="missing timestamp")delete sample.capturedAt;
    if(scenario==="invalid timestamp")sample.capturedAt="0";
    if(scenario==="unknown live")delete sample.live;
    if(scenario==="missing list")delete sample.processes;
    if(scenario==="malformed row")sample.processes.push(null);
    if(scenario==="missing CPU")delete sample.processes[0].cpuPercent;
    if(scenario==="invalid CPU")sample.processes[0].cpuPercent="0";
    if(scenario==="blank command")sample.processes[0].command=" ";
    if(scenario==="truncated")sample.truncated=true;
    if(scenario==="unknown completeness")delete sample.truncated;
    if(scenario==="wrong machine")sample.machineId="m_other";
    if(scenario==="stopped sample")sample.state="stopped";
    if(scenario==="stop trigger")sample.trigger="stop";
    if(scenario==="error envelope")sample.error={code:"host_unavailable",message:"fake unavailable"};
    if(scenario==="busy")sample.processes.push({...sample.processes[0],pid:99,ppid:1,command:"npm run build",cpuPercent:90});
    box.patch({processSample:sample,...(scenario==="HTTP error"?{processStatus:503,processSample:{error:{code:"host_unavailable",message:"fake unavailable"}}}:{}),...(scenario==="malformed JSON"?{processRaw:'{"processes":['}:{})});
    const before=env.store.macLeases.rawList();
    await assert.rejects(harness.callRpc("recoverAllocatedMac",{taskId:env.failed.id,machineId:env.machine().id,userApproved:true}));
    assert.equal(env.chat.spawns.length,0);assert.equal(env.store.get(env.failed.id)!.status,"failed");assert.equal(env.store.get(env.failed.id)!.turns,0);
    assert.equal(env.store.list({limit:10}).length,2);assert.equal(env.store.macLeases.adoptions().length,0);
    assert.deepEqual(env.store.macLeases.rawList(),before);assert.equal(env.store.macLeases.summary().month.costs.USD,10.8);box.assertReadsOnly();
  });
}

test("public legacy adoption also uses real Instabox process evidence and counts one minimum",async t=>{
  const env=await legacyDeletedFixture(t),box=await processAdapter(env,t),harness=await publicHarness(env,t);
  const rawBefore=env.store.macLeases.rawList();
  await harness.callRpc("recoverAllocatedMac",{taskId:env.failed.id,machineId:env.machine().id,userApproved:true,adoptLegacyLease:env.adoption});
  assert.equal(env.store.get(env.failed.id)!.turns,1);assert.equal(env.store.macLeases.adoptions().length,1);
  assert.deepEqual(env.store.macLeases.rawList(),rawBefore);assert.equal(env.store.macLeases.held()[0]!.id,env.lease.id);
  assert.equal(env.store.macLeases.held()[0]!.releaseAt,env.machine().scheduledReleaseAt);assert.equal(env.store.macLeases.summary().month.costs.USD,10.8);
  box.assertReadsOnly();
});

test("legacy adoption refuses when a later real process read becomes cached",async t=>{
  const env=await legacyDeletedFixture(t),box=await processAdapter(env,t),harness=await publicHarness(env,t);
  const rawBefore=env.store.macLeases.rawList();let reads=0;
  env.provider.processes=async(...args)=>{
    if(++reads===2)box.patch({processSample:{...box.sample(),live:false,trigger:"suspend"}});
    return box.adapter.processes(...args);
  };
  await assert.rejects(harness.callRpc("recoverAllocatedMac",{taskId:env.failed.id,machineId:env.machine().id,userApproved:true,adoptLegacyLease:env.adoption}));
  assert.equal(reads,2);assert.equal(env.chat.spawns.length,0);assert.equal(env.store.get(env.failed.id)!.status,"failed");
  assert.equal(env.store.macLeases.adoptions().length,0);assert.equal(env.store.macLeases.held().length,0);
  assert.deepEqual(env.store.macLeases.rawList(),rawBefore);assert.equal(env.store.macLeases.summary().month.costs.USD,10.8);box.assertReadsOnly();
});
