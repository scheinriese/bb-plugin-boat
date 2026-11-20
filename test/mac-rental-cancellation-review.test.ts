// Independent cancellation regressions: fake providers only, no external calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { FakeBoat, defaultSettings, memoryStore } from "./fakes.ts";
import { createBoatProvider } from "../src/providers/boat/provider.ts";
import { createProviderRegistry } from "../src/providers/registry.ts";
import { BoatService } from "../src/service.ts";
import { registerRpc } from "../src/rpc.ts";
import type { Runtime } from "../src/runtime.ts";
import type { BoatApi } from "../src/providers/boat/api.ts";
import type { SandboxProvider } from "../src/providers/types.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("cancelling a source during an unknown provider create retains the allocation uncertainty and blocks every retry", async t => {
  const store = memoryStore(), started = gate(), finishCreate = gate();
  const base = createBoatProvider(new FakeBoat() as unknown as BoatApi);
  let creates = 0, allocationSignal: AbortSignal | undefined;
  const mac: SandboxProvider = { ...base, id: "instabox", displayName: "Instabox", macLeaseKind: "day", idPattern: /^fake_mac_/,
    macModels: async () => [{ id: "m2", label: "Mac M2", cpus: 8, memoryMiB: 16384, minimumCost: 12, minimumHours: 24, hourPrice: .5, currency: "USD" }],
    create: async input => { creates++; allocationSignal=input.signal; started.release(); await finishCreate.promise; throw Error("Provider create response was lost"); },
  };
  const service = new BoatService(createProviderRegistry([base, mac]), store, {
    settings: async () => defaultSettings(), lifecycle: new AbortController().signal, changed() {}, notify: async () => {}, log: { info() {}, warn() {} },
  });
  await assert.rejects(service.startTask({ title: "Fake native check", role: "custom", brief: "Check the fake app", sandboxSystem: "macos" }), { code: "mac_rental_confirmation_required" });
  const source = store.list({limit:10})[0]!, offer = (await service.ownMacNotice(source))!.offer!;
  const approval = service.answerOwnMacRental(source.id, "rent", offer.id);
  // Attach an error handler before cancellation; cleanup may complete immediately.
  const result = approval.then(value => ({value}), error => ({error}));
  await started.promise;
  const replacement = store.list({limit:10}).find(task => task.id !== source.id)!;
  assert.ok(replacement);
  const durableReplacementId = (await service.ownMacNotice(store.get(source.id)!))?.replacementId;
  const closing = service.closeTask(source.id, { status: "cancelled" });
  await Promise.race([closing, new Promise(resolve => setTimeout(resolve, 50))]);
  const abortedWhileCreatePending = allocationSignal?.aborted;
  // Release the provider after initiating cancellation so closure must handle an
  // in-flight create whose result cannot be established, rather than replaying it.
  finishCreate.release();
  await Promise.all([closing, result]);
  assert.equal(durableReplacementId, replacement.id, "the source is durably bound before allocation can outlive its service instance");
  assert.equal(abortedWhileCreatePending, true, "source cancellation reaches the in-flight provider signal before its outcome is known");
  assert.equal(store.get(source.id)!.status, "cancelled");
  assert.equal(creates, 1);
  assert.ok(store.history({taskId:replacement.id,limit:50}).events.some(event => event.cause === "creation_unknown"), "cancelled allocation uncertainty remains durable for owner inspection");
  await assert.rejects(service.answerOwnMacRental(source.id, "rent", offer.id), {code:"task_busy"});
  const {bb,harness} = createFakePluginHost({pluginId:"boat"});
  t.after(() => harness.lifecycle.dispose());
  registerRpc({bb,service,projects:{list:()=>[]},settings:{},changed(){},wake(){}} as unknown as Runtime);
  for (const id of [source.id,replacement.id]) await assert.rejects(harness.callRpc("retryProviderStart", {id}), /Check the provider machine list/);
  assert.equal(creates,1);
});

test("a known Mac returned after source cancellation remains tracked and never receives an agent turn", async () => {
  const store=memoryStore(),started=gate(),finishCreate=gate();
  const boat=new FakeBoat(),base=createBoatProvider(boat as unknown as BoatApi);
  let creates=0,prompts=0,deletes=0;
  const machineId="fake_mac_known";
  const mac:SandboxProvider={...base,id:"instabox",displayName:"Instabox",macLeaseKind:"day",idPattern:/^fake_mac_/,
    macModels:async()=>[{id:"m2",label:"Mac M2",cpus:8,memoryMiB:16384,minimumCost:12,minimumHours:24,hourPrice:.5,currency:"USD"}],
    create:async input=>{
      creates++;started.release();await finishCreate.promise;
      const sandbox=await base.create({...input,signal:undefined});
      const start=Date.now();
      store.macLeases.record({id:"fake-known-lease",provider:"instabox",machineId,size:"m2",startedAt:new Date(start).toISOString(),paidUntil:new Date(start+86400000).toISOString(),minimumCost:12,hourPrice:.5,currency:"USD",cpus:8,memoryMiB:16384});
      return {...sandbox,id:machineId,system:"macos"};
    },
    prompt:async()=>{prompts++;throw Error("Cancelled rental must not receive work");},
    delete:async()=>{deletes++;},
  };
  const service=new BoatService(createProviderRegistry([base,mac]),store,{settings:async()=>defaultSettings(),lifecycle:new AbortController().signal,changed(){},notify:async()=>{},log:{info(){},warn(){}}});
  await assert.rejects(service.startTask({title:"Fake native check",role:"custom",brief:"Check the fake app",sandboxSystem:"macos"}),{code:"mac_rental_confirmation_required"});
  const source=store.list({limit:10})[0]!,offer=(await service.ownMacNotice(source))!.offer!;
  const approval=service.answerOwnMacRental(source.id,"rent",offer.id).then(value=>({value}),error=>({error}));
  await started.promise;
  await service.closeTask(source.id,{status:"cancelled"});
  finishCreate.release();await approval;
  const child=store.list({limit:10}).find(task=>task.id!==source.id)!;
  assert.equal(child.status,"cancelled");assert.equal(child.turns,0);
  assert.equal(creates,1);assert.equal(prompts,0);assert.equal(deletes,0,"paid minimum lease is retained for normal hand-back protection");
  assert.equal(store.macLeases.held(machineId).length,1,"returned allocation stays durably tracked despite cancellation");
  await assert.rejects(service.answerOwnMacRental(source.id,"rent",offer.id),{code:"task_busy"});
  assert.equal(creates,1);
});

for (const scenario of [
  {label:"push work that has not shipped",delivery:"push" as const,ahead:"BOAT_AHEAD 1 dirty\n",kept:true,outcome:"unshipped"},
  {label:"a clean pull request workspace",delivery:"pr" as const,ahead:"BOAT_AHEAD 0 clean\n",kept:false,outcome:"clean"},
  {label:"a clean push workspace",delivery:"push" as const,ahead:"BOAT_AHEAD 0 clean\n",kept:false,outcome:"clean"},
  {label:"temporarily unknown push work",delivery:"push" as const,ahead:"BOAT_AHEAD x x\n",kept:false,outcome:"unknown"},
]) test(`source cancellation interrupts a just-running replacement with ${scenario.label}`, async () => {
  const {fakeRepos}=await import("./fakes.ts");
  const {normalizeProject,toOrchestratorProject}=await import("../src/projects.ts");
  const store=memoryStore(),boat=new FakeBoat(),macBoat=new FakeBoat();
  const base=createBoatProvider(macBoat as unknown as BoatApi);
  const system=<T extends object>(sandbox:T)=>({...sandbox,system:"macos" as const});
  const project=normalizeProject({id:"fake-native",name:"Fake native",repos:[{repo:"acme/app",baseBranch:"main"}],delivery:scenario.delivery,workerMode:"boat",sandboxProvider:"instabox",sandboxSystem:"macos"});
  const mac:SandboxProvider={...base,id:"instabox",displayName:"Instabox",macLeaseKind:"day",
    macModels:async()=>[{id:"m2",label:"Mac M2",cpus:8,memoryMiB:16384,minimumCost:12,minimumHours:24,hourPrice:.5,currency:"USD"}],
    create:async input=>{
      const sandbox=await base.create(input),start=Date.now();
      store.macLeases.record({id:"fake-running-lease",provider:"instabox",machineId:sandbox.id,size:"m2",startedAt:new Date(start).toISOString(),paidUntil:new Date(start+86400000).toISOString(),minimumCost:12,hourPrice:.5,currency:"USD",cpus:8,memoryMiB:16384});
      return system(sandbox);
    },
    info:async(id,signal)=>system(await base.info(id,signal)),
    findInfo:async(id,signal)=>{const sandbox=await base.findInfo(id,signal);return sandbox?system(sandbox):null;},
    exec:async(id,script,options)=>script.includes("BOAT_AHEAD")?{exitCode:0,stdout:scenario.ahead,stderr:""}:base.exec(id,script,options),
  };
  let sourceId:string|undefined,childId:string|undefined;
  let closing:Promise<{error?:unknown}>|undefined;
  const service=new BoatService(createProviderRegistry([createBoatProvider(boat as unknown as BoatApi),mac]),store,{
    settings:async()=>defaultSettings({deleteSandboxOnClose:true}),projects:()=>[project],repos:fakeRepos(macBoat),lifecycle:new AbortController().signal,
    changed:()=>{
      const child=sourceId?store.list({limit:10}).find(task=>task.id!==sourceId&&task.status==="running"):null;
      if(child && !closing){childId=child.id;closing=service.closeTask(sourceId!,{status:"cancelled"}).then(()=>({}),error=>({error}));}
    },notify:async()=>{},log:{info(){},warn(){}},
  });
  await assert.rejects(service.startTask({title:"Fake native check",role:"custom",brief:"Check fake app",project:toOrchestratorProject(project),sandboxSystem:"macos"}),{code:"mac_rental_confirmation_required"});
  const source=store.list({limit:10})[0]!;sourceId=source.id;
  const quote=(await service.ownMacNotice(source))!.offer!;
  await service.answerOwnMacRental(source.id,"rent",quote.id).catch(()=>undefined);
  assert.ok(closing,"test cancelled in the running transition callback");
  const closed=await closing;
  assert.equal(closed.error,undefined,"unshipped work must be preserved without preventing cancellation");
  const child=store.get(childId!)!;
  assert.equal(child.status,"cancelled");
  assert.equal(macBoat.convos.get(child.conversationId!)?.running,false,"the agent turn is actually interrupted");
  assert.equal(store.macLeases.held(child.sandboxId!).length,1,"workspace lease remains tracked");
  assert.equal(store.macLeases.held(child.sandboxId!)[0]!.kept,scenario.kept,"only work that has not shipped turns off automatic hand-back");
  assert.equal(store.macLeases.tasks("fake-running-lease").find(attached=>attached.taskId===child.id)!.workOutcome,scenario.outcome,"post-interruption work state remains recorded for hand-back protection");
});
