import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ScalewayApi } from "../src/providers/scaleway/api.ts";
import { ScalewayKeys, type SshRequest } from "../src/providers/scaleway/ssh.ts";
import { createScalewayProvider, BOOTSTRAP } from "../src/providers/scaleway/provider.ts";
import { memoryStore, FakeBoat, FakeChat, defaultSettings } from "./fakes.ts";
import { createBoatProvider } from "../src/providers/boat/provider.ts";
import { createProviderRegistry, unavailableProvider } from "../src/providers/registry.ts";
import { BoatService } from "../src/service.ts";
import { defineProviderSecrets } from "../src/provider-settings.ts";
import { SECRET_SETTINGS } from "../src/settings.ts";
import { providersView } from "../src/rpc-providers.ts";
import { macRunsOn } from "../src/mac-lease-view.ts";
import type { SandboxProvider } from "../src/providers/types.ts";
const projectId = "10000000-0000-4000-8000-000000000001";
const serverId = "20000000-0000-4000-8000-000000000001";
const keyId = "30000000-0000-4000-8000-000000000001";
const secret = "test-only-scaleway-secret";
const type = { name: "M1-M", stock: "high_stock", cpu: { core_count: 8 }, memory: { capacity: 8*1024**3 }, default_os: { id: "macos-stable", name: "macOS" } };
const product = { locality: { zone: "fr-par-3" }, status: "general_availability", properties: { apple_silicon: { server_type: "M1-M" } }, unit_of_measure: { unit: "hour", size: 1 }, price: { retail_price: { currency_code: "EUR", units: 0, nanos: 110000000 } } };
async function fixture(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), "scaleway-test-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = memoryStore(), keys = new ScalewayKeys(dir);
  const calls: { method: string; path: string; body: any }[] = [], ssh: SshRequest[] = [];
  let servers: any[] = [], quota = 2, available = true, beta = false, failSetup = false, ambiguousCreate = false, poll = 0;
  const api = new ScalewayApi({ key: async () => secret, config: async () => ({ projectId, zone: "fr-par-3" }), fetch: (async (url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("X-Auth-Token"), secret);
    const u = new URL(url), method = init.method!, path = u.pathname, body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    const json = (value: unknown) => new Response(JSON.stringify(value));
    if (path.includes("public-catalog")) return json({ products: [product, { ...product, unit_of_measure: { unit: "month", size: 1 } }], total_count: 2 });
    if (path.endsWith("server-types")) return json({ server_types: [{ ...type, default_os: { ...type.default_os, is_beta: beta }, stock: available ? "high_stock" : "no_stock" }] });
    if (path.includes("/projects/")) return json({ organization_id: "org" });
    if (path.endsWith("quota")) return json({ quota: [{ name: "apple_silicon_m1_m", limits: [{ zone: "fr-par-3", limit: quota }] }], total_count: 1 });
    if (path.endsWith("ssh-keys") && method === "POST") return json({ id: keyId });
    if (path.includes("ssh-keys/") && method === "DELETE") return new Response(null,{ status: 204 });
    if (path.endsWith("/servers") && method === "POST") {
      const start = Date.now()-25*3600000;
      const server = { zone: "fr-par-3", id: serverId, name: body.name, type: body.type, project_id: projectId, status: "starting", delivered: false, ip: "192.0.2.1", ssh_username: "m1", created_at: new Date(start).toISOString(), deletable_at: new Date(start+86400000).toISOString(), tags: body.tags };
      servers.push(server); if (ambiguousCreate) throw new Error(secret); return json(server);
    }
    if (path.endsWith("/servers") && method === "GET") return json({ servers, total_count: servers.length });
    if (method === "PATCH") { Object.assign(servers[0], body); return json(servers[0]); }
    if (method === "DELETE") { servers = []; return new Response(null,{status:204}); }
    if (method === "GET" && servers[0]) { poll++; if (poll >= 2) Object.assign(servers[0], { status: "ready", delivered: true }); return json(servers[0]); }
    return new Response(JSON.stringify({ message: secret }), {status:404});
  }) as typeof fetch });
  const provider = createScalewayProvider({ api, keys, ledger: store.macLeases, pollMs: 1, ssh: async (_target, request) => {
    ssh.push(request); request.onOutput?.("bb installed");
    return { exitCode: failSetup && request.stdin === BOOTSTRAP ? 1 : 0, stdout: "ok", stderr: "" };
  } });
  const create = () => provider.create({ name: "bb-task", type: "default", system: "macos", ttlSeconds: 3600, gitGuard: true });
  return { api, provider, store, keys, calls, ssh, create, setQuota: (n:number) => { quota=n; }, stock: (value:boolean) => { available=value; }, beta: () => { beta=true; }, failSetup: () => { failSetup=true; }, ambiguousCreate: () => { ambiguousCreate=true; }, servers: () => servers };
}
test("Scaleway create waits for delivered and SSH, bootstraps tools, stores a private key and releases it", async t => {
  const f=await fixture(t); const sandbox=await f.create();
  assert.equal(sandbox.state,"idle"); assert.equal(sandbox.system,"macos");
  const create=f.calls.find(c=>c.path.endsWith("/servers") && c.method==="POST")!;
  assert.equal(create.body.commitment_type,"none"); assert.equal(create.body.os_id,"macos-stable"); assert.equal(create.body.enable_vpc,false);
  const record=(await f.keys.records())[0]!;
  assert.equal((await stat(f.keys.path(record.token))).mode & 0o777,0o600);
  assert.match(await readFile(f.keys.path(record.token),"utf8"),/BEGIN OPENSSH PRIVATE KEY/);
  assert.ok(f.ssh.some(r=>r.stdin===BOOTSTRAP));
  const output:string[]=[];
  await f.provider.executor!(sandbox.id).exec({ command:["sh","-c","install bb"],stdin:"test-enrollment",timeoutMs:900000,signal:new AbortController().signal,onOutput:s=>output.push(s) });
  assert.equal(f.ssh.at(-1)!.stdin,"test-enrollment"); assert.deepEqual(output,["bb installed"]);
  assert.equal(f.store.macLeases.held()[0]!.currency,"EUR"); assert.equal(f.store.macLeases.held()[0]!.dayPrice,2.64);
  await f.provider.exec(sandbox.id,"echo hello");
  await f.provider.delete(sandbox.id);
  assert.equal(f.store.macLeases.held().length,0); assert.equal((await f.keys.records()).length,0);
  assert.ok(f.calls.some(c=>c.path.endsWith(keyId)&&c.method==="DELETE"));
  assert.doesNotMatch(JSON.stringify(f.calls)+JSON.stringify(f.ssh),new RegExp(secret));
});
test("Scaleway quota and stock count its organization servers, including other projects, and ignore other providers",async t=>{
  const f=await fixture(t); assert.equal((await f.provider.capacity()).canStart,true);
  await f.create(); f.setQuota(1); f.servers()[0]!.project_id="other-project";
  assert.equal((await f.provider.capacity()).canStart,false); assert.equal((await f.provider.capacity()).activeSandboxes,1);
  f.setQuota(2); assert.equal((await f.provider.capacity()).canStart,true);
  f.stock(false); assert.equal((await f.provider.capacity()).canStart,false);
  await assert.rejects(f.create(),/stock, quota/);
});
test("Scaleway refuses release inside the minimum, keeps SSH keys and never powers down a shared Mac",async t=>{
  const f=await fixture(t); const sandbox=await f.create(); f.servers()[0]!.deletable_at=new Date(Date.now()+3600000).toISOString();
  await assert.rejects(f.provider.delete(sandbox.id),/24 h minimum/);
  await f.provider.stop(sandbox.id);
  assert.equal((await f.keys.records()).length,1); assert.equal(f.calls.filter(c=>c.method==="DELETE").length,0);
});
test("failed Scaleway bootstrap records the allocation and schedules deletion instead of silently falling back",async t=>{
  const f=await fixture(t); f.failSetup(); await assert.rejects(f.create(),{code:"creation_allocated"});
  assert.equal(f.store.macLeases.held().length,1);
  assert.ok(f.calls.some(c=>c.method==="PATCH"&&c.body.deletion_scheduled===true));
  assert.equal((await f.provider.list())[0]?.state,"stopping");
});
test("Scaleway pricing uses hourly EUR catalog entries only; external deletion cleans keys on reconciliation",async t=>{
  const f=await fixture(t); assert.match((await f.provider.pricing!())!,/EUR 0.11\/h · EUR 2.64 minimum/);
  const sandbox=await f.create();
  await f.api.request("DELETE",`/apple-silicon/v1alpha1/zones/fr-par-3/servers/${serverId}`);
  assert.deepEqual(await f.provider.list(),[]); assert.equal((await f.keys.records()).length,0);
  assert.equal(await f.provider.findInfo(sandbox.id),null);
});
test("Scaleway secrets fail closed and response, network and parse errors never echo keys",async()=>{
  for (const mode of ["missing","http","network","parse"]) {
    let requests=0;
    const api=new ScalewayApi({key:async()=>mode==="missing"?null:secret,config:async()=>({projectId,zone:"fr-par-3"}),fetch:(async()=>{requests++;if(mode==="network")throw new Error(secret);return new Response(mode==="parse"?secret:JSON.stringify({message:secret}),{status:mode==="parse"?200:403});}) as typeof fetch});
    await assert.rejects(api.parse((await import("zod")).z.object({ok:(await import("zod")).z.boolean()}),"GET","/test"),error=>{assert.doesNotMatch(String(error),new RegExp(secret));return true;});
    assert.equal(requests,mode==="missing"?0:1);
  }
});
test("Scaleway secret comes only from its bb secret setting and presence updates",async()=>{
  let values:Record<string,string>={},changed=()=>{};
  const secrets=await defineProviderSecrets({settings:{define:(descriptors:unknown)=>{assert.equal(descriptors,SECRET_SETTINGS);return {get:async()=>values,onChange:(listener:()=>void)=>{changed=listener;}};}}} as never);
  assert.equal(secrets.scalewayKeyPresent(),false); values={scalewaySecretKey:secret}; changed(); await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(secrets.scalewayKeyPresent(),true); assert.equal(await secrets.scalewayKey(),secret); assert.equal(await secrets.instaboxKey(),null);
  values={}; changed(); await new Promise(resolve=>setTimeout(resolve,0)); assert.equal(secrets.scalewayKeyPresent(),false);
});
async function routing(preferred:string, options:{disabled?:string; fail?:string; ambiguous?:boolean; held?:string;listFail?:string}={}) {
  const store=memoryStore(),chat=new FakeChat(),boat=new FakeBoat(),creates:string[]=[];
  const providers=["instabox","scaleway"].map(id=>{
    const inert=unavailableProvider(id);
    const p:SandboxProvider={...inert,displayName:id==="instabox"?"Instabox":"Scaleway",caps:{...inert.caps,os:"macos",bbEnrollment:true},machine:{id:`${id}-sandbox`} as never,exec:async()=>({exitCode:0,stdout:"",stderr:""}),findInfo:async sid=>({id:sid,state:"idle",system:"macos"} as never),macModels:async()=>[{id:"M1-M",label:"M1-M",cpus:8,memoryMiB:16384,dayPrice:10,currency:"EUR"}],list:async()=>{if(options.listFail===id)throw new Error("List unavailable");return options.held===id?[{id:`${id}_held`,state:"idle"} as never]:[];},capacity:async()=>({canStart:true,activeSandboxes:0,maxActiveSandboxes:4} as never),create:async()=>{creates.push(id);if(options.fail===id)throw Object.assign(new Error("No Mac free"),{code:options.ambiguous?"creation_unknown":"at_capacity"}); const start=Date.now();store.macLeases.record({id:`${id}:lease`,provider:id,machineId:`${id}_new`,size:"M1-M",startedAt:new Date(start).toISOString(),paidUntil:new Date(start+86400000).toISOString(),dayPrice:10,currency:"EUR",cpus:8,memoryMiB:16384});return {id:`${id}_new`,state:"idle",system:"macos"} as never;},info:async id=>({id,state:"idle",system:"macos"} as never)};
    return p;
  });
  const registry=createProviderRegistry([createBoatProvider(boat as never),...providers],{isEnabled:p=>p.id!==options.disabled});
  const service=new BoatService(registry,store,{settings:async()=>defaultSettings({maxActiveSandboxes:0,workerMode:"chat",adhocWorkerMode:"chat",evidenceUploader:""}),chat,lifecycle:new AbortController().signal,changed:()=>{},notify:async()=>{},log:{info:()=>{},warn:()=>{}}});
  const initial=await service.startTask({title:"Mac",role:"custom",brief:"Check tools",provider:"codex",runner:"boat"});
  const task=store.update(initial.id,{sandboxProvider:preferred,sandboxSystem:"macos",runner:"chat",sandboxId:null})!;
  if(options.held)store.macLeases.record({id:`${options.held}:held`,provider:options.held,machineId:`${options.held}_held`,size:"M1-M",startedAt:new Date().toISOString(),paidUntil:new Date(Date.now()+86400000).toISOString(),dayPrice:10,currency:"EUR",cpus:8,memoryMiB:16384});
  const seam=service as unknown as {createMacFor(task:import("../src/store.ts").Task,type:"default",signal:AbortSignal):Promise<{id:string}>;heldMacFor(task:import("../src/store.ts").Task,type:"default",parent:null):Promise<string|null>};
  return {store,creates,task,seam,service,chat};
}
for(const preferred of ["instabox","scaleway"]) for(const kind of ["fail","disabled"] as const) test(`Mac routing falls back from ${preferred} when ${kind}`,async()=>{
  const other=preferred==="instabox"?"scaleway":"instabox";const f=await routing(preferred,{[kind]:preferred});
  assert.equal((await f.seam.createMacFor(f.task,"default",new AbortController().signal)).id,`${other}_new`);
  assert.equal(f.store.get(f.task.id)?.sandboxProvider,other);assert.ok(f.store.events(f.task.id).some(e=>/fallback/.test(e.text)));
});
test("Mac routing reuses any held provider before renting the project's preferred provider",async()=>{
  const f=await routing("instabox",{held:"scaleway"});assert.equal(await f.seam.heldMacFor(f.task,"default",null),"scaleway_held");assert.deepEqual(f.creates,[]);assert.equal(f.store.get(f.task.id)?.sandboxProvider,"scaleway");
});
test("ambiguous Mac create fails closed without a second rental",async()=>{
  const f=await routing("scaleway",{fail:"scaleway",ambiguous:true});await assert.rejects(f.seam.createMacFor(f.task,"default",new AbortController().signal),{code:"creation_unknown"});assert.deepEqual(f.creates,["scaleway"]);
});
test("Scaleway settings, Runs on and task lease lines use existing UI contracts",async()=>{
  const boat=unavailableProvider("boat"),scw=unavailableProvider("scaleway");const registry=createProviderRegistry([boat,{...scw,caps:{...scw.caps,os:"macos",systems:["macos"]}}]);
  const view=providersView({registry,boat:null,connections:new Map([["scaleway","connected"]]),projects:[]});const row=view.providers.find(r=>r.id==="scaleway")!;
  assert.equal(row.apiKey?.setting,"Scaleway secret key");assert.equal(row.systems[0]?.ready,true);assert.equal(view.options.find(o=>o.provider==="scaleway")?.disabledReason,null);
  const f=await routing("scaleway",{held:"scaleway"});assert.equal(macRunsOn(f.store.macLeases,"scaleway_held",[])?.label,"Scaleway");
});

test("a dispatched Mac task reaches a Scaleway bb chat when Instabox is unconfigured",async()=>{
  const f=await routing("instabox",{disabled:"instabox"});
  const task=await f.service.startTask({title:"Mac task",brief:"Check Xcode",role:"custom",sandboxSystem:"macos",runner:"chat"});
  assert.equal(task.status,"running",task.error??""); assert.equal(task.sandboxProvider,"scaleway");
  assert.equal(task.sandboxId,"scaleway_new"); assert.equal(f.chat.spawns.at(-1)?.where.kind,"machine");
  assert.ok(f.store.events(task.id).some(e=>/fallback/.test(e.text)));
});

test("an uncertain Scaleway create preserves its key and blocks another rental until listing recovers it",async t=>{
  const f=await fixture(t);f.ambiguousCreate();
  await assert.rejects(f.create(),error=>{assert.equal((error as {code:string}).code,"creation_unknown");assert.doesNotMatch(String(error),new RegExp(secret));return true;});
  assert.equal((await f.keys.records())[0]?.serverId,undefined);
  await assert.rejects(f.create(),{code:"creation_unknown"});
  assert.equal(f.calls.filter(c=>c.method==="POST"&&c.path.endsWith("/servers")).length,1);
  await f.provider.list();assert.equal((await f.keys.records())[0]?.serverId,serverId);assert.equal(f.store.macLeases.held().length,1);
});

test("a failed machine list never authorizes another rental on that provider",async()=>{
  const f=await routing("instabox",{listFail:"instabox"});
  const task=await f.service.startTask({title:"Mac task",brief:"Check tools",role:"custom",sandboxSystem:"macos",runner:"chat"});
  assert.equal(task.status,"running",task.error??"");assert.deepEqual(f.creates,["scaleway"]);
});
test("an unconfirmed held Mac prevents new rentals on either provider",async()=>{
  const f=await routing("instabox",{listFail:"instabox",held:"instabox"});
  await assert.rejects(f.service.startTask({title:"Mac task",brief:"Check tools",role:"custom",sandboxSystem:"macos",runner:"chat"}),/List unavailable/);
  assert.deepEqual(f.creates,[]);
});

test("Scaleway never selects a beta default OS",async t=>{
  const f=await fixture(t);f.beta();assert.deepEqual(await f.provider.macModels!(),[]);
  assert.deepEqual(f.provider.caps.systems,[]);await assert.rejects(f.create(),/stock, quota/);
  assert.ok(!f.calls.some(c=>c.method==="POST"));
});
