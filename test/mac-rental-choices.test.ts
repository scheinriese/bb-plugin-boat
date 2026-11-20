import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeBoat, defaultSettings, memoryStore } from "./fakes.ts";
import { createBoatProvider } from "../src/providers/boat/provider.ts";
import type { BoatApi } from "../src/providers/boat/api.ts";
import { createProviderRegistry } from "../src/providers/registry.ts";
import { BoatService } from "../src/service.ts";
import type { MacModel, SandboxProvider } from "../src/providers/types.ts";
import { normalizeProject, toOrchestratorProject } from "../src/projects.ts";

function fixture(currency = "USD", preferred = "boat") {
  const store = memoryStore();
  const creates: string[] = [];
  const model = (id: string, cost: number, currency: string): MacModel => ({id, label:id, cpus:8, memoryMiB:32768, minimumCost:cost, minimumHours:24, hourPrice:cost/24, currency});
  const provider = (id:string, cost:number, currency:string): SandboxProvider => ({
    ...createBoatProvider(new FakeBoat() as unknown as BoatApi), id, displayName:id,
    idPattern:new RegExp(`^${id}_`), macLeaseKind:"day", macModels:async()=>[model(`${id}-m2`,cost,currency)],
    create:async()=>{creates.push(id);throw new Error("fake unknown create outcome");},
  });
  const first=provider("instabox",10.8,"USD"), second=provider("scaleway",5,currency);
  const project=normalizeProject({id:"mac",name:"Mac app",repos:[{repo:"acme/web",baseBranch:"main"}],sandboxProvider:preferred});
  const providers=[createBoatProvider(new FakeBoat() as unknown as BoatApi),first,second];
  const service=new BoatService(createProviderRegistry(providers),store,{settings:async()=>defaultSettings({maxActiveSandboxes:0}),lifecycle:new AbortController().signal,changed:()=>{},notify:async()=>{},projects:()=>[project],log:{info:()=>{},warn:()=>{}}});
  const pending=async()=>{await assert.rejects(service.startTask({title:"Mac check",role:"custom",brief:"Check fake native tools",sandboxSystem:"macos",project:{...toOrchestratorProject(project),repos:[]}}),{code:"mac_rental_confirmation_required"});return store.list({limit:10})[0]!;};
  return {store,service,first,second,creates,pending,providers};
}

test("rental recommendation evaluates every provider before choosing the lower comparable minimum",async()=>{
  const env=fixture(); const task=await env.pending();
  const notice=await env.service.ownMacNotice(task);
  assert.equal(notice?.offer?.provider,"scaleway");
  assert.deepEqual(env.creates,[]);
});

test("mixed currencies retain a stable selection without a price recommendation",async()=>{
  const env=fixture("EUR");const task=await env.pending();const notice=await env.service.ownMacNotice(task);
  assert.equal(notice?.offer?.provider,"instabox");assert.equal(notice!.recommendedQuoteId,undefined);assert.match(notice!.recommendationReason!,/without conversion/);
  assert.deepEqual(notice?.offers?.map(q=>q.currency),["USD","EUR"]);
});
test("an explicit project preference wins after all offers are evaluated",async()=>{
  const env=fixture("USD","instabox");const task=await env.pending();const notice=await env.service.ownMacNotice(task);
  assert.equal(notice!.offer!.provider,"instabox");assert.equal(notice!.offers!.length,2);assert.match(notice!.recommendationReason!,/Project preference/);
});
test("same-request selection and refresh never allocate or mutate project routing",async()=>{
  const env=fixture("EUR","instabox");const task=await env.pending();const initial=(await env.service.ownMacNotice(task))!;
  const alternate=initial.offers!.find(q=>q.provider==="scaleway")!;
  const selected=await env.service.selectMacRentalOffer(task.id,alternate.id);
  assert.equal(selected.offer!.provider,"scaleway");assert.equal(selected.taskId,task.id);
  const refreshed=await env.service.refreshMacRentalOffers(task.id);
  assert.equal(refreshed.offer!.provider,"scaleway");assert.notEqual(refreshed.offer!.id,alternate.id);
  assert.equal(env.store.list({limit:10}).length,1);assert.equal(env.store.get(task.id)!.sandboxProvider,"instabox");assert.deepEqual(env.creates,[]);
  await assert.rejects(env.service.selectMacRentalOffer(task.id,alternate.id),{code:"mac_price_changed"});
});
test("selection revalidates actual availability and exposes the factual reason",async()=>{
  const env=fixture();const task=await env.pending();const notice=(await env.service.ownMacNotice(task))!;
  env.second.macRentalModels=async()=> (await env.second.macModels!()).map(model=>({...model,unavailableReason:"No stock in selected zone."}));
  await assert.rejects(env.service.selectMacRentalOffer(task.id,notice.offer!.id),{code:"mac_price_changed"});
  const fresh=(await env.service.ownMacNotice(task))!;
  assert.equal(fresh.offer!.provider,"instabox");assert.match(fresh.unavailable![0]!.reason,/No stock/);assert.deepEqual(env.creates,[]);
});
for(const field of ["minimumCost","hourPrice","minimumHours","currency","id"] as const) {
  test(`approval revalidates changed ${field} without creating`,async()=>{
    const env=fixture();const task=await env.pending();const notice=(await env.service.ownMacNotice(task))!;
    env.second.macModels=async()=>[{id:"scaleway-m2",label:"scaleway-m2",cpus:8,memoryMiB:32768,minimumCost:5,minimumHours:24,hourPrice:5/24,currency:"USD",[field]:field==="currency"?"EUR":field==="id"?"different-model":99}];
    await assert.rejects(env.service.answerOwnMacRental(task.id,"rent",notice.offer!.id),{code:"mac_price_changed"});
    assert.equal(env.store.list({limit:10}).length,1);assert.deepEqual(env.creates,[]);
  });
}
test("expired quote selection refreshes the same request without approval",async()=>{
  const env=fixture();const task=await env.pending();const notice=(await env.service.ownMacNotice(task))!;
  const expired={...notice.offer!,expiresAt:"2000-01-01T00:00:00Z"};
  env.store.addOwnMacEvent(task.id,"ownmac-rental-offer","fake expired",expired);
  env.store.addOwnMacEvent(task.id,"ownmac-rental-choices","fake expired",{offers:[expired]});
  await assert.rejects(env.service.selectMacRentalOffer(task.id,expired.id),{code:"mac_price_changed"});
  assert.notEqual((await env.service.ownMacNotice(task))!.offer!.id,expired.id);assert.deepEqual(env.creates,[]);
});
test("legacy single offers can refresh safely into task-scoped choices",async()=>{
  const env=fixture();const task=await env.pending();
  env.store.addOwnMacEvent(task.id,"ownmac-rental-choices","legacy fixture",null);
  const legacy=(await env.service.ownMacNotice(task))!;assert.equal(legacy.offers,undefined);
  const fresh=await env.service.refreshMacRentalOffers(task.id);
  assert.equal(fresh.offers!.length,2);assert.deepEqual(env.creates,[]);assert.equal(env.store.list({limit:10}).length,1);
});
test("approved alternate provider alone may create; unknown outcome prevents fallback and double clicks",async()=>{
  const env=fixture("EUR","instabox");const task=await env.pending();const notice=(await env.service.ownMacNotice(task))!;
  const selected=await env.service.selectMacRentalOffer(task.id,notice.offers!.find(q=>q.provider==="scaleway")!.id);
  const result=await Promise.allSettled([env.service.answerOwnMacRental(task.id,"rent",selected.offer!.id),env.service.answerOwnMacRental(task.id,"rent",selected.offer!.id)]);
  assert.equal(result.filter(r=>r.status==="rejected").length,2);assert.deepEqual(env.creates,["scaleway"]);
  const failure=result.find(r=>r.status==="rejected" && (r.reason as {code?:string}).code==="creation_unknown");assert.ok(failure);
  await assert.rejects(env.service.answerOwnMacRental(task.id,"rent",selected.offer!.id),{code:"task_busy"});assert.deepEqual(env.creates,["scaleway"]);
});
test("pending requests use waiting presentation even when all options become unavailable",async()=>{
  const env=fixture();const task=await env.pending();assert.equal(env.service.publicStatus(task).label,"Waiting for your choice");
  env.first.macModels=async()=>[];env.second.macModels=async()=>[];
  const fresh=await env.service.refreshMacRentalOffers(task.id);assert.equal(fresh.offers!.length,0);assert.equal(fresh.offer,undefined);
  assert.equal(env.service.publicStatus(task).label,"Waiting for your choice");assert.deepEqual(env.creates,[]);
});

test("default boat routing preserves an unknown selected rental outcome and cannot approve twice",async()=>{
  const env=fixture();const task=await env.pending();const initial=(await env.service.ownMacNotice(task))!;
  const selected=await env.service.selectMacRentalOffer(task.id,initial.offers!.find(q=>q.provider==="instabox")!.id);
  await assert.rejects(env.service.answerOwnMacRental(task.id,"rent",selected.offer!.id),{code:"creation_unknown"});
  const stopped=(await env.service.ownMacNotice(env.store.get(task.id)!))!;
  assert.ok(stopped.replacementId);assert.equal(env.store.get(stopped.replacementId!)!.sandboxProvider,"instabox");
  assert.equal(env.store.history({taskId:stopped.replacementId!,limit:30}).events.find(e=>e.kind==="stopped")!.cause,"creation_unknown");
  await assert.rejects(env.service.answerOwnMacRental(task.id,"rent",selected.offer!.id),{code:"task_busy"});assert.deepEqual(env.creates,["instabox"]);
});
test("account capacity is checked before recommending a creatable template",async()=>{
  const env=fixture();env.second.capacity=async()=>({...await env.first.capacity(),canStart:false,blockedReason:"Account Mac quota is full."});
  const task=await env.pending();const notice=(await env.service.ownMacNotice(task))!;
  assert.equal(notice.offer!.provider,"instabox");assert.match(notice.unavailable![0]!.reason,/Account Mac quota is full/);assert.deepEqual(env.creates,[]);
});

test("the public generic retry refuses a selected rental with an unknown create outcome",async t=>{
  const [{createFakePluginHost},{ProjectStore},{TaskStore},{createMigratingSettingsStore},{createRuntime},{registerRpc}]=await Promise.all([
    import("@get-bb/plugin-sdk/testing"),import("../src/projects.ts"),import("../src/store.ts"),import("../src/settings-store.ts"),import("../src/runtime.ts"),import("../src/rpc.ts"),
  ]);
  const env=fixture();const task=await env.pending();const notice=(await env.service.ownMacNotice(task))!;
  await assert.rejects(env.service.answerOwnMacRental(task.id,"rent",notice.offer!.id),{code:"creation_unknown"});
  const replacement=(await env.service.ownMacNotice(env.store.get(task.id)!))!.replacementId!;
  const {bb,harness}=createFakePluginHost({pluginId:"boat"});bb.storage.migrate(bb.storage.database(),TaskStore.migrations());
  const projects=new ProjectStore(()=>bb.storage.database()),settings=await createMigratingSettingsStore(bb);
  const runtime=createRuntime({bb,service:env.service,projects,settings,protocol:{read:()=>({text:"",custom:false,path:"",updatedAt:null})} as unknown as import("../src/protocol.ts").ProtocolStore,readRepoFile:async()=>"",changed(){},wake(){}});
  t.after(async()=>{runtime.startQueue.dispose();await harness.lifecycle.dispose();});registerRpc(runtime);
  const response=await harness.callRpc("task",{id:replacement}) as {task:{providerFailure:{code:string;canRetry:boolean}}};
  assert.equal(response.task.providerFailure.code,"creation_unknown");assert.equal(response.task.providerFailure.canRetry,false);
  await assert.rejects(harness.callRpc("retryProviderStart",{id:replacement}),/Check the provider machine list/);
  assert.deepEqual(env.creates,["scaleway"]);
});


for(const scenario of [
  {label:"lower minimum with higher hourly rate",cost:5,rate:0.6,hours:24,recommended:false},
  {label:"identical terms",cost:10.8,rate:10.8/24,hours:24,recommended:false},
  {label:"different minimum duration",cost:5,rate:0.2,hours:12,recommended:false},
  {label:"lower minimum and hourly rate",cost:5,rate:0.2,hours:24,recommended:true},
  {label:"equal minimum with lower hourly rate",cost:10.8,rate:0.2,hours:24,recommended:true},
  {label:"lower minimum with equal hourly rate",cost:5,rate:10.8/24,hours:24,recommended:true},
])test(`price recommendation respects ${scenario.label}`,async()=>{
  const env=fixture();const original=await env.second.macModels!();
  env.second.macModels=async()=>original.map(model=>({...model,minimumCost:scenario.cost,hourPrice:scenario.rate,minimumHours:scenario.hours}));
  const task=await env.pending(),notice=(await env.service.ownMacNotice(task))!;
  assert.equal(notice.recommendedQuoteId,scenario.recommended?notice.offers!.find(q=>q.provider==="scaleway")!.id:undefined);
  assert.ok(notice.offer,"a neutral price comparison must still leave an actionable selected quote");
  if(scenario.label==="lower minimum with higher hourly rate")assert.match(notice.recommendationReason!,/trades against a higher ongoing rate/);
  assert.deepEqual(env.creates,[]);
});
test("explicit mixed-currency preference is identified without a cheapest-price claim",async()=>{
  const env=fixture("EUR","scaleway"),task=await env.pending(),notice=(await env.service.ownMacNotice(task))!;
  assert.equal(notice.offer!.provider,"scaleway");assert.equal(notice.recommendedQuoteId,notice.offer!.id);
  assert.match(notice.recommendationReason!,/Project preference/);assert.doesNotMatch(notice.recommendationReason!,/Lowest comparable|cheaper|cheapest/);
});
test("a provider preference with model cost tradeoffs remains a preference, not a savings claim",async()=>{
  const env=fixture("USD","scaleway"),models=await env.second.macModels!();
  env.second.macModels=async()=>[...models,{...models[0]!,id:"scaleway-m4",minimumCost:4,hourPrice:1}];
  const task=await env.pending(),notice=(await env.service.ownMacNotice(task))!;
  assert.equal(notice.recommendedQuoteId,notice.offer!.id);assert.match(notice.recommendationReason!,/Project preference/);
  assert.doesNotMatch(notice.recommendationReason!,/Lowest/);
});
test("quote display facts are live, optional for legacy data, and never bypass resource revalidation",async()=>{
  const {macRentalQuoteSchema}=await import("../contract-ownmac.ts");
  const env=fixture(),models=await env.second.macModels!();
  env.second.macModels=async()=>models.map(model=>({...model,region:"test-zone-1"}));
  const task=await env.pending(),notice=(await env.service.ownMacNotice(task))!,offer=notice.offer!;
  assert.equal(offer.cpus,8);assert.equal(offer.memoryMiB,32768);assert.equal(offer.region,"test-zone-1");assert.ok(Number.isFinite(Date.parse(offer.checkedAt!)));
  const {cpus,memoryMiB,region,checkedAt,...legacy}=offer;
  assert.ok(macRentalQuoteSchema.safeParse(legacy).success);
  env.store.addOwnMacEvent(task.id,"ownmac-rental-choices","legacy",null);env.store.addOwnMacEvent(task.id,"ownmac-rental-offer","legacy",legacy);
  await env.service.selectMacRentalOffer(task.id,legacy.id);
  env.second.macModels=async()=>models.map(model=>({...model,cpus:1,memoryMiB:512}));
  await assert.rejects(env.service.answerOwnMacRental(task.id,"rent",legacy.id),{code:"mac_price_changed"});assert.deepEqual(env.creates,[]);
});
test("keeping a rental request queued never auto-starts when Your Mac becomes available",async()=>{
  const env=fixture();let ownCreates=0;
  const own:SandboxProvider={...env.first,id:"ownmac",displayName:"Your Mac",caps:{...env.first.caps,os:"macos"},macModels:undefined,ownMacStatus:async()=>({code:"available",status:"Available",running:0,max:1}),create:async()=>{ownCreates++;throw Error("queued task must not start");}};
  env.providers.push(own);
  const task=await env.pending(),notice=(await env.service.ownMacNotice(task))!;
  assert.equal(await env.service.answerOwnMacRental(task.id,"queue"),null);
  assert.equal((await env.service.ownMacNotice(task))!.answer,"queue");assert.equal(env.service.publicStatus(task).label,"Waiting for your choice");assert.equal(env.service.publicStatus(task).needsYou,false);
  await env.service.maintainOwnMac();assert.equal(env.store.list({limit:10}).length,1);assert.equal(ownCreates,0);assert.deepEqual(env.creates,[]);
  const selected=await env.service.selectMacRentalOffer(task.id,notice.offer!.id);
  await assert.rejects(env.service.answerOwnMacRental(task.id,"rent",selected.offer!.id),{code:"creation_unknown"});assert.equal(env.creates.length,1);assert.equal(ownCreates,0);
});


test("preferred-provider model failure is visible with the alternative quote, without a routing regression",async()=>{
  const env=fixture("EUR","scaleway");
  env.second.macModels=async()=>[];
  const task=await env.pending();const notice=(await env.service.ownMacNotice(task))!;
  assert.equal(notice.offer!.provider,"instabox");
  assert.match(notice.recommendationReason!,/scaleway is unavailable: No usable Mac model with confirmed pricing and availability/);
  assert.equal(notice.unavailable![0]!.provider,"scaleway");
  assert.deepEqual(env.creates,[]);
});
