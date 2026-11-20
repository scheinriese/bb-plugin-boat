import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeBoat, FakeChat, fakeRepos, defaultSettings, memoryStore } from "./fakes.ts";
import { createBoatProvider } from "../src/providers/boat/provider.ts";
import type { BoatApi } from "../src/providers/boat/api.ts";
import { createProviderRegistry } from "../src/providers/registry.ts";
import { machineName } from "../src/providers/instabox/provider.ts";
import { BoatService } from "../src/service.ts";
import type { SandboxInfo, SandboxProvider } from "../src/providers/types.ts";

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
  assert.deepEqual(env.store.ownMacEventData(env.failed.id,"ownmac-allocation"),{machineId:env.machine().id,provider:"instabox",leaseId:"fake-lease"});
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
