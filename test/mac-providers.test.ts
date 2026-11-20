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
test("caps-only Mac providers are eligible for an unconfigured Mac task",async()=>{
  const env=fixture(true);
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
