import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeBoat, defaultSettings, memoryStore } from "./fakes.ts";
import { createBoatProvider } from "../src/providers/boat/provider.ts";
import type { BoatApi } from "../src/providers/boat/api.ts";
import { createProviderRegistry } from "../src/providers/registry.ts";
import { BoatService } from "../src/service.ts";
import type { SandboxProvider } from "../src/providers/types.ts";

function gate() {
  let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;});
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  return {entered,release,async wait(){enter();await waiting;}};
}
async function fixture() {
  const store=memoryStore(),base=createBoatProvider(new FakeBoat() as unknown as BoatApi);let creates=0;
  const provider:SandboxProvider={...base,id:"scaleway",displayName:"Fake rental",macLeaseKind:"day",macModels:async()=>[{id:"fake-m2",label:"M2",cpus:8,memoryMiB:32768,minimumCost:5,minimumHours:24,hourPrice:5/24,currency:"EUR"}],create:async()=>{creates++;throw Error("fake unknown create outcome");}};
  const service=new BoatService(createProviderRegistry([base,provider]),store,{settings:async()=>defaultSettings({maxActiveSandboxes:0}),lifecycle:new AbortController().signal,changed(){},notify:async()=>{},log:{info(){},warn(){}}});
  await assert.rejects(service.startTask({title:"Mac check",brief:"Check fake native tools",role:"custom",sandboxSystem:"macos"}),{code:"mac_rental_confirmation_required"});
  const task=store.list({limit:1})[0]!,offer=(await service.ownMacNotice(task))!.offer!;
  return {service,store,provider,task,offer,creates:()=>creates};
}

for(const blockedCheck of [1,2])test(`cancelling a rental request during subscription check ${blockedCheck} prevents replacement insertion and allocation`,async()=>{
  const env=await fixture(),check=gate();let checks=0;
  env.service.assertSubscriptionRoom=async()=>{if(++checks===blockedCheck)await check.wait();return false;};
  const answer=env.service.answerOwnMacRental(env.task.id,"rent",env.offer.id).catch(error=>error);
  await check.entered;
  await env.service.closeTask(env.task.id,{status:"cancelled"});assert.equal(env.creates(),0);
  check.release();await answer;
  assert.equal(env.creates(),0,"source cancellation must revoke the pending replacement before any create");
  assert.equal(env.store.get(env.task.id)!.status,"cancelled");assert.equal(env.store.list({limit:10}).length,1);
});

test("cancelling a rental request after replacement insertion prevents allocation after an ignored-signal capacity await",async()=>{
  const env=await fixture(),capacity=gate(),readCapacity=env.provider.capacity;
  env.provider.macRentalModels=env.provider.macModels;
  env.provider.capacity=async signal=>{if(env.store.list({limit:10}).length>1)await capacity.wait();return readCapacity(signal);};
  const answer=env.service.answerOwnMacRental(env.task.id,"rent",env.offer.id).catch(error=>error);
  await capacity.entered;
  await env.service.closeTask(env.task.id,{status:"cancelled"});assert.equal(env.creates(),0);
  capacity.release();await answer;
  assert.equal(env.creates(),0,"a provider that ignores abort while reading capacity must not receive create");
  const replacement=env.store.list({limit:10}).find(task=>task.id!==env.task.id)!;
  assert.ok(replacement);assert.equal(replacement.status,"cancelled");
  await assert.rejects(env.service.answerOwnMacRental(env.task.id,"rent",env.offer.id),{code:"task_busy"});
});


test("cancelling during the selected quote revalidation prevents a replacement start",async()=>{
  const env=await fixture(),models=gate(),readModels=env.provider.macModels!;
  env.provider.macRentalModels=async signal=>{await models.wait();return readModels(signal);};
  const answer=env.service.answerOwnMacRental(env.task.id,"rent",env.offer.id).catch(error=>error);
  await models.entered;
  await env.service.closeTask(env.task.id,{status:"cancelled"});assert.equal(env.creates(),0);
  models.release();await answer;
  assert.equal(env.creates(),0);assert.equal(env.store.list({limit:10}).length,1);assert.equal(env.store.get(env.task.id)!.status,"cancelled");
});
