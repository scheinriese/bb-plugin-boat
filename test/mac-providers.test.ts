import {withFakeMacRentalConsent} from "./mac-consent.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeBoat, defaultSettings, memoryStore } from "./fakes.ts";
import { createBoatProvider } from "../src/providers/boat/provider.ts";
import type { BoatApi } from "../src/providers/boat/api.ts";
import { createProviderRegistry } from "../src/providers/registry.ts";
import { BoatService } from "../src/service.ts";
import type { SandboxInfo, SandboxProvider } from "../src/providers/types.ts";
import { normalizeProject, toOrchestratorProject } from "../src/projects.ts";
import { providerHandlers } from "../src/rpc-providers.ts";
import type { Runtime } from "../src/runtime.ts";
import { macUsageSchema } from "../contract-providers.ts";

function fixture(capsOnly=false) {
  const store=memoryStore(),boat=new FakeBoat(),mac=new FakeBoat();
  mac.limitsValue={...mac.limitsValue,maxActiveSandboxes:10};
  const base=createBoatProvider(mac as unknown as BoatApi);
  const system=(sandbox:SandboxInfo):SandboxInfo=>({...sandbox,system:"macos"});
  let creates=0;
  const provider:SandboxProvider={...base,id:"orchard",displayName:"Orchard",idPattern:/^om_/,
    caps:{...base.caps,systems:capsOnly?["linux","macos"]:["linux"]},
    sizes:[{id:"default",label:"Standard",cpus:3,memoryGb:6}],
    ...(capsOnly?{macModels:undefined}:{macModels:async()=>[{id:"custom-mac",label:"Custom Mac",cpus:6,memoryMiB:12288,minimumCost:7,minimumHours:12,hourPrice:0.8,currency:"EUR"}]}),
    create:async options=>{
      assert.equal(options.system,"macos");creates++;
      const sandbox=await base.create(options),id=`om_${creates}`;mac.sandboxes.delete(sandbox.id);
      const machine=system({...sandbox,id});mac.sandboxes.set(id,machine);
      const start=Date.now();store.macLeases.record({id:`orchard:${id}`,provider:"orchard",machineId:id,size:"custom-mac",startedAt:new Date(start).toISOString(),paidUntil:new Date(start+12*3600000).toISOString(),minimumCost:7,hourPrice:0.8,currency:"EUR",cpus:6,memoryMiB:12288});
      return machine;
    },
    info:async(id,signal)=>system(await base.info(id,signal)),
    findInfo:async(id,signal)=>{const sandbox=await base.findInfo(id,signal);return sandbox?system(sandbox):null},
  };
  const registry=createProviderRegistry([createBoatProvider(boat as unknown as BoatApi),provider]);
  let project=normalizeProject({id:"mac",name:"Mac app",repos:[{repo:"acme/web",baseBranch:"main"}],sandboxProvider:provider.id,sandboxSystem:"macos"});
  const service=new BoatService(registry,store,{settings:async()=>defaultSettings({maxActiveSandboxes:0}),lifecycle:new AbortController().signal,changed:()=>{},notify:async()=>{},projects:()=>[project],log:{info:()=>{},warn:()=>{}}});
  withFakeMacRentalConsent(service);
  const start=()=>service.startTask({title:"Mac work",role:"custom",brief:"Check tools",sandboxSystem:"macos",project:{...toOrchestratorProject(project),repos:[]}});
  const projects={get:(id:string)=>id===project.id?project:null,list:()=>[project],save:(input:Parameters<typeof normalizeProject>[0])=>{project=normalizeProject(input,project);return project}};
  return {store,boat,mac,provider,service,start,projects,registry,creates:()=>creates};
}
test("a second Mac provider routes, shares and reserves its own 3 CPU / 6 GiB task size",async()=>{
  const env=fixture();const first=await env.start(),second=await env.start(),third=await env.start();
  assert.equal(first.sandboxProvider,"orchard");assert.equal(first.sandboxId,second.sandboxId);assert.notEqual(first.sandboxId,third.sandboxId);
  assert.equal(env.creates(),2);assert.equal(env.boat.sandboxes.size,0);
  const tasks=env.store.macLeases.tasks(env.store.macLeases.held(first.sandboxId!)[0]!.id);
  assert.equal(tasks.length,2);for(const task of tasks)assert.deepEqual([task.cpus,task.memoryMiB],[3,6144]);
});
test("caps-only Mac providers reuse held capacity and refuse unpriced new rentals",async()=>{
  const env=fixture(true);
  await assert.rejects(env.service.startTask({title:"Mac",role:"custom",brief:"Check",sandboxSystem:"macos"}),/confirmed pricing/);
  await env.provider.create({name:"fake held Mac",type:"default",system:"macos",ttlSeconds:3600,gitGuard:true});
  const task=await env.service.startTask({title:"Mac",role:"custom",brief:"Check",sandboxSystem:"macos"});
  assert.equal(task.sandboxProvider,"orchard");assert.equal(task.status,"running");
});
test("every provider's info.system guards Linux placement on an untracked Mac",async()=>{
  const env=fixture();env.mac.addSandbox("om_external","default","idle");
  await assert.rejects(env.service.startTask({title:"Linux",role:"custom",brief:"Check",sandboxSystem:"linux",sandbox:"om_external"}),/Linux tasks cannot use a Mac sandbox/);
  assert.equal(env.creates(),0);
});
test("Mac Runs on choices and persistence use the chosen provider, including live model-only support",async()=>{
  const env=fixture();
  const handlers=providerHandlers({service:env.service,projects:env.projects,bb:{rpc:{experimental_invalidate:()=>{}}},changed:()=>{}} as unknown as Runtime);
  const view=await handlers.sandboxProviders();
  assert.ok(view.options.some(option=>option.provider==="orchard-macos"&&option.disabledReason===null));
  assert.equal(view.projects[0]!.provider,"orchard-macos");
  await handlers.setProjectRunsOn({projectId:"mac",provider:"orchard"});assert.equal(env.projects.get("mac")!.sandboxSystem,undefined);
  await handlers.setProjectRunsOn({projectId:"mac",provider:"orchard-macos"});
  assert.equal(env.projects.get("mac")!.sandboxProvider,"orchard");assert.equal(env.projects.get("mac")!.sandboxSystem,"macos");
});

test("Mac usage includes the provider's display name",async()=>{
  const env=fixture();await env.start();
  const view=await providerHandlers({service:env.service,bb:{}} as unknown as Runtime).macUsage();
  assert.deepEqual(view.providers,[{id:"orchard",label:"Orchard"}]);
});

test("Mac usage keeps a provider-current lease discrepancy visible after an ambiguous local end",async()=>{
  const env=fixture();
  const start=Date.now(),paidUntil=new Date(start+24*3600000).toISOString();
  const lease=env.store.macLeases.record({id:"instabox:fake-lease",provider:"instabox",machineId:"m_fake",size:"m2",startedAt:new Date(start).toISOString(),paidUntil,minimumCost:10.8,hourPrice:0.45,currency:"USD",cpus:8,memoryMiB:12288});
  env.store.macLeases.end(lease.id,"deleted",start+1000);
  const warning=`Instabox still reports this physical lease. USD 10.80 minimum, paid until ${paidUntil}; release scheduled at ${paidUntil}. Local end is uncertain; billing may continue.`;
  env.store.macLeases.observeDiscrepancy(lease.id,warning,start+2000);
  const view=await providerHandlers({service:env.service,bb:{}} as unknown as Runtime).macUsage();
  assert.equal(view.held.length,0,"a visibility read does not reopen a confirmed end");
  assert.equal(view.month.costs.USD,10.8,"minimum is retained exactly once");
  assert.deepEqual(view.notices?.map(notice=>({machineId:notice.machineId,text:notice.text})),[{machineId:"m_fake",text:warning}]);
});

test("public Mac usage shows an adopted physical lease once alongside its original deletion evidence",async()=>{
  const env=fixture(),now=Date.now(),startedAt=new Date(now-10_000).toISOString(),paidUntil=new Date(now-10_000+86400000).toISOString();
  const lease=env.store.macLeases.record({id:"instabox:fake-lease",provider:"instabox",machineId:"m_fake",size:"m2",startedAt,paidUntil,minimumCost:10.8,hourPrice:0.45,currency:"USD",cpus:8,memoryMiB:12288});
  const failedAt=new Date(now-5000).toISOString(),endedAt=new Date(now-3506).toISOString();
  env.store.macLeases.end(lease.id,"deleted",Date.parse(endedAt));
  // An old installation has no end provenance; this is temporary fake storage.
  const db=(env.store as unknown as {db:()=>{prepare(sql:string):{run(...args:unknown[]):unknown}}}).db();
  db.prepare("UPDATE mac_leases SET end_evidence='legacy' WHERE id=?").run(lease.id);
  const original=env.store.macLeases.rawList()[0]!;
  const current={...lease,scheduledReleaseAt:paidUntil,physicalLeaseId:"fake-lease"};
  const operatorProof={ledgerId:lease.id,leaseId:"fake-lease",sourceTaskId:"t_fake_request",startedAt,paidUntil,endedAt,failedAt,noReleaseRequested:true as const};
  const before=macUsageSchema.parse(await providerHandlers({service:env.service,bb:{}} as unknown as Runtime).macUsage());
  assert.equal(before.held.length,0);assert.equal(before.legacyEnded?.[0]?.endedAt,endedAt,"raw end evidence is publicly inspectable before adoption");
  assert.ok(env.store.macLeases.adoptLegacyDeleted(lease.id,current,{revision:env.store.macLeases.revision(),taskId:"t_fake_failed",sourceTaskId:"t_fake_request",failureCause:"lease_unknown",failedAt,observedAt:new Date(now).toISOString(),expectedEndedAt:endedAt,operatorProof}));
  const view=macUsageSchema.parse(await providerHandlers({service:env.service,bb:{}} as unknown as Runtime).macUsage());
  assert.equal(view.held.length,1);assert.equal(view.held[0]!.releaseAt,paidUntil);
  assert.equal(view.month.costs.USD,10.8);
  assert.equal(env.store.macLeases.between(0,Infinity,Date.parse(paidUntil)+3600000).costs.USD,11.25,"same minimum plus elapsed rate, counted once");
  assert.deepEqual(view.adoptions?.[0],{leaseId:lease.id,provider:"instabox",machineId:"m_fake",taskId:"t_fake_failed",sourceTaskId:"t_fake_request",adoptedAt:new Date(now).toISOString(),endedAt:null,operatorProof,original:{endedAt,endReason:"deleted",endEvidence:"legacy",releaseAt:null},observed:{leaseId:"fake-lease",startedAt,paidUntil,model:"m2",minimumCost:10.8,hourPrice:0.45,currency:"USD",scheduledReleaseAt:paidUntil}});
  assert.match(view.notices?.[0]?.text ?? "",/Original history is retained/);
  assert.deepEqual(env.store.macLeases.rawList()[0],original,"public accounting does not rewrite the historical row");
});
