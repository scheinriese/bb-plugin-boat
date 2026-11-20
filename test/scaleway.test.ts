import {withFakeMacRentalConsent} from "./mac-consent.ts";
import { createCredentialSource, type CredentialSource } from "../src/credentials.ts";
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
import { BoatService, type ServiceHooks } from "../src/service.ts";
import { defineProviderSecrets } from "../src/provider-settings.ts";
import { SECRET_SETTINGS } from "../src/settings.ts";
import { providersView, providerHandlers } from "../src/rpc-providers.ts";
import { normalizeProject, toOrchestratorProject } from "../src/projects.ts";
import { macRunsOn } from "../src/mac-lease-view.ts";
import { providerGlyph } from "../web/providers-logic.ts";
import { ProviderError, type SandboxProvider } from "../src/providers/types.ts";
const macTaskProject = () => ({ ...toOrchestratorProject(normalizeProject({id:"mac",name:"Mac app",repos:[{repo:"acme/mac",baseBranch:"main"}]})), repos: [] });
const projectId = "10000000-0000-4000-8000-000000000001";
const serverId = "20000000-0000-4000-8000-000000000001";
const keyId = "30000000-0000-4000-8000-000000000001";
const secret = "test-only-scaleway-secret";
const type = { name: "M1-M", stock: "high_stock", cpu: { core_count: 8 }, memory: { capacity: 8*1024**3 }, default_os: { id: "macos-stable", name: "macOS" } };
const product = { locality: { zone: "fr-par-3" }, status: "general_availability", properties: { apple_silicon: { server_type: "M1-M" } }, unit_of_measure: { unit: "hour", size: 1 }, price: { retail_price: { currency_code: "EUR", units: 0, nanos: 110000000 } } };
async function fixture(t: { after(fn: () => unknown): void }, ageHours = 25, credentials?: CredentialSource, readyTimeoutMs?: number) {
  const dir = await mkdtemp(join(tmpdir(), "scaleway-test-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = memoryStore(), keys = new ScalewayKeys(dir);
  const order: string[] = [];
  const calls: { method: string; path: string; body: any }[] = [], ssh: SshRequest[] = [];
  let servers: any[] = [], quota = 2, available = true, beta = false, failSetup = false, ambiguousCreate = false, ambiguousAbsent = false, failList = false, failSchedule = false, noAgentLogin = false, noGithubLogin = false, poll = 0;
  let secondModel = false;
  let createGate: { entered(): void; ready: Promise<void> } | null = null;
  let failKey = false, sshCode = 0, rawFailures = 0;
  let forcedState: string | null = null;
  let sshHook: ((request: SshRequest) => Promise<void>) | undefined;
  const api = new ScalewayApi({ key: async () => secret, config: async () => ({ projectId, zone: "fr-par-3" }), fetch: (async (url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("X-Auth-Token"), secret);
    const u = new URL(url), method = init.method!, path = u.pathname, body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body }); order.push(`${method} ${path}`);
    const json = (value: unknown) => new Response(JSON.stringify(value));
    if (path.includes("public-catalog")) return json({ products: [product, { ...product, unit_of_measure: { unit: "month", size: 1 } }, ...(secondModel ? [{...product, properties:{apple_silicon:{server_type:"M2-M"}}}] : [])], total_count: secondModel ? 3 : 2 });
    if (path.endsWith("server-types")) return json({ server_types: [{ ...type, default_os: { ...type.default_os, is_beta: beta }, stock: available ? "high_stock" : "no_stock" }, ...(secondModel ? [{...type,name:"M2-M"}] : [])] });
    if (path.includes("/projects/")) return json({ organization_id: "org" });
    if (path.endsWith("quota")) return json({ quota: [{ name: "apple_silicon_m1_m", limits: [{ zone: "fr-par-3", limit: quota }] }, ...(secondModel ? [{name:"apple_silicon_m2_m",limits:[{zone:"fr-par-3",limit:quota}]}] : [])], total_count: secondModel ? 2 : 1 });
    if (path.endsWith("ssh-keys") && method === "POST") return failKey ? new Response("unavailable",{status:503}) : json({ id: keyId });
    if (path.includes("ssh-keys/") && method === "DELETE") return new Response(null,{ status: 204 });
    if (path.endsWith("/servers") && method === "POST") {
      const allowed=["name","project_id","type","os_id","enable_vpc","commitment_type","public_bandwidth_bps","runner_configuration","applied_runner_configurations","enable_kext"];
      if(Object.keys(body).some(key=>!allowed.includes(key)) || body.commitment_type!=="duration_24h") return new Response("invalid create fields",{status:400});
      if (createGate) { createGate.entered(); await createGate.ready; }
      if(ambiguousAbsent) throw new Error(secret);
      const start = Date.now()-ageHours*3600000;
      const server = { zone: "fr-par-3", id: serverId, name: body.name, type: body.type, project_id: projectId, status: "starting", delivered: false, ip: "192.0.2.1", ssh_username: "m1", created_at: new Date(start).toISOString(), deletable_at: new Date(start+86400000).toISOString(), tags: [] };
      servers.push(server); if (ambiguousCreate) throw new Error(secret); return json(server);
    }
    if (path.endsWith("/servers") && method === "GET") { if(failList)return new Response("unavailable",{status:503}); return json({ servers, total_count: servers.length }); }
    if (method === "PATCH") {
      if(Object.keys(body).some(key=>!["schedule_deletion","name","enable_vpc","commitment_type","public_bandwidth_bps","runner_configuration","applied_runner_configurations"].includes(key)))return new Response("invalid update fields",{status:400});
      if(failSchedule)return new Response("schedule rejected",{status:503});
      if(body.schedule_deletion!==undefined)servers[0].deletion_scheduled=body.schedule_deletion;
      return json(servers[0]);
    }
    if (method === "DELETE") { servers = []; return new Response(null,{status:204}); }
    if (method === "GET" && servers[0]) { if(rawFailures > 0) {rawFailures--;return new Response("temporary error",{status:503});} poll++; if (poll >= 2) Object.assign(servers[0], { status: forcedState ?? "ready", delivered: true }); return json(servers[0]); }
    return new Response(JSON.stringify({ message: secret }), {status:404});
  }) as typeof fetch });
  const makeProvider = (source = credentials) => createScalewayProvider({ api, keys, ledger: store.macLeases, credentials: source, readyTimeoutMs, pollMs: 1, ssh: async (_target, request) => {
    ssh.push(request); order.push(request.command.join(" ")); request.onOutput?.("bb installed");
    await sshHook?.(request);
    return { exitCode: sshCode || ((failSetup && request.stdin === BOOTSTRAP) || (noAgentLogin && /codex.*login status|claude.*auth status/.test(JSON.stringify(request.command))) || (noGithubLogin && /gh.*auth status/.test(JSON.stringify(request.command))) ? 1 : 0), stdout: "ok", stderr: "" };
  } });
  const provider = makeProvider();
  const create = () => provider.create({ name: "bb-task", type: "default", system: "macos", ttlSeconds: 3600, gitGuard: true });
  const blockCreate = () => {
    let release!:()=>void,entered!:()=>void;
    const ready=new Promise<void>(resolve=>{release=resolve;});
    const waiting=new Promise<void>(resolve=>{entered=resolve;});
    createGate={entered,ready};return {entered:waiting,release};
  };
  return { secondModel: () => { secondModel=true; }, failNextServerGets: (count:number) => { rawFailures=count; }, remainingGetFailures: () => rawFailures, makeProvider, sshExit: (code: number) => { sshCode = code; }, status: (state: string) => { forcedState = state; }, onSsh: (hook: typeof sshHook) => { sshHook = hook; }, order, blockCreate, failKey:()=>{failKey=true;}, api, provider, store, keys, calls, ssh, create, setQuota: (n:number) => { quota=n; }, stock: (value:boolean) => { available=value; }, beta: () => { beta=true; }, failSetup: () => { failSetup=true; }, ambiguousCreate: () => { ambiguousCreate=true; }, ambiguousAbsent:()=>{ambiguousAbsent=true;}, listFailure:(value:boolean)=>{failList=value;}, scheduleFailure:()=>{failSchedule=true;}, noAgentLogin:()=>{noAgentLogin=true;}, noGithubLogin:()=>{noGithubLogin=true;}, servers: () => servers };
}
test("Scaleway create waits for delivered and SSH, bootstraps tools, stores a private key and releases it", async t => {
  const f=await fixture(t); const sandbox=await f.create();
  assert.equal(sandbox.state,"idle"); assert.equal(sandbox.system,"macos");
  const create=f.calls.find(c=>c.path.endsWith("/servers") && c.method==="POST")!;
  assert.equal(create.body.commitment_type,"duration_24h"); assert.equal(create.body.os_id,"macos-stable"); assert.equal(create.body.enable_vpc,false);
  const record=(await f.keys.records())[0]!;
  assert.equal((await stat(f.keys.path(record.token))).mode & 0o777,0o600);
  assert.match(await readFile(f.keys.path(record.token),"utf8"),/BEGIN OPENSSH PRIVATE KEY/);
  assert.ok(f.ssh.some(r=>r.stdin===BOOTSTRAP));
  const output:string[]=[];
  await f.provider.executor!(sandbox.id).exec({ command:["sh","-c","install bb"],stdin:"test-enrollment",timeoutMs:900000,signal:new AbortController().signal,onOutput:s=>output.push(s) });
  assert.equal(f.ssh.at(-1)!.stdin,"test-enrollment"); assert.deepEqual(output,["bb installed"]);
  assert.equal(f.store.macLeases.held()[0]!.currency,"EUR"); assert.equal(f.store.macLeases.held()[0]!.minimumCost,2.64);
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
  assert.ok(f.calls.some(c=>c.method==="PATCH"&&c.body.schedule_deletion===true));
  assert.equal((await f.provider.list())[0]?.scheduledReleaseAt,f.servers()[0]!.deletable_at);
});
test("Scaleway pricing uses hourly EUR catalog entries only; external deletion cleans keys on reconciliation",async t=>{
  const f=await fixture(t); assert.match((await f.provider.pricing!())!,/EUR 0.11\/h · EUR 2.64 minimum/);
  const sandbox=await f.create();
  await f.api.request("DELETE",`/apple-silicon/v1alpha1/zones/fr-par-3/servers/${serverId}`);
  const deletes=f.calls.filter(c=>c.method==="DELETE").length;
  assert.deepEqual(await f.provider.list(),[]); await f.provider.orphans!();
  assert.equal((await f.keys.records()).length,1,"read-only listing preserves recovery keys");
  assert.equal(f.calls.filter(c=>c.method==="DELETE").length,deletes,"reads never delete IAM keys");
  await f.provider.recoverCreations!();
  assert.equal((await f.keys.records()).length,0,"normal reconciliation clears absent keys");
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
async function routing(preferred:string, options:{disabled?:string; fail?:string; ambiguous?:boolean; held?:string;listFail?:string;preflight?:ServiceHooks["preflight"]}={}) {
  const store=memoryStore(),chat=new FakeChat(),boat=new FakeBoat(),creates:string[]=[];
  const providers=["instabox","scaleway"].map(id=>{
    const inert=unavailableProvider(id);
    const p:SandboxProvider={...inert,idPattern:new RegExp(`^${id}_`),displayName:id==="instabox"?"Instabox":"Scaleway",caps:{...inert.caps,os:"macos",bbEnrollment:true,headlessAgentRunner:id!=="scaleway"},sizes:[{id:"default",label:"Standard",cpus:id==="scaleway"?2:4,memoryGb:id==="scaleway"?4:8}],machine:{id:`${id}-sandbox`} as never,exec:async()=>({exitCode:0,stdout:"",stderr:""}),findInfo:async sid=>({id:sid,state:"idle",system:"macos"} as never),macModels:async()=>[{minimumHours:24,id:"M1-M",label:"M1-M",cpus:8,memoryMiB:16384,minimumCost:10,hourPrice:10/24,currency:"EUR"}],list:async()=>{if(options.listFail===id)throw new Error("List unavailable");return options.held===id?[{id:`${id}_held`,state:"idle"} as never]:[];},capacity:async()=>({canStart:true,activeSandboxes:0,maxActiveSandboxes:4} as never),create:async()=>{creates.push(id);if(options.fail===id)throw Object.assign(new Error("No Mac free"),{code:options.ambiguous?"creation_unknown":"at_capacity"}); const start=Date.now();store.macLeases.record({id:`${id}:lease`,provider:id,machineId:`${id}_new`,size:"M1-M",startedAt:new Date(start).toISOString(),paidUntil:new Date(start+86400000).toISOString(),minimumCost:10,hourPrice:10/24,currency:"EUR",cpus:8,memoryMiB:16384});return {id:`${id}_new`,state:"idle",system:"macos"} as never;},info:async id=>({id,state:"idle",system:"macos"} as never)};
    return p;
  });
  const registry=createProviderRegistry([createBoatProvider(boat as never),...providers],{isEnabled:p=>p.id!==options.disabled});
  const service=new BoatService(registry,store,{preflight:options.preflight,projects:()=>[{id:"mac",name:"Mac app",repos:[],machineType:null,sandboxProvider:preferred,sandboxSystem:"macos"}],settings:async()=>defaultSettings({maxActiveSandboxes:0,workerMode:"chat",adhocWorkerMode:"chat",evidenceUploader:""}),chat,lifecycle:new AbortController().signal,changed:()=>{},notify:async()=>{},log:{info:()=>{},warn:()=>{}}});
  withFakeMacRentalConsent(service);
  const initial=await service.startTask({title:"Mac",role:"custom",brief:"Check tools",provider:"codex",runner:"boat"});
  const task=store.update(initial.id,{sandboxProvider:preferred,sandboxSystem:"macos",runner:"chat",sandboxId:null})!;
  if(options.held)store.macLeases.record({id:`${options.held}:held`,provider:options.held,machineId:`${options.held}_held`,size:"M1-M",startedAt:new Date().toISOString(),paidUntil:new Date(Date.now()+86400000).toISOString(),minimumCost:10,hourPrice:10/24,currency:"EUR",cpus:8,memoryMiB:16384});
  const seam=service as unknown as {createMacFor(task:import("../src/store.ts").Task,type:"default",signal:AbortSignal):Promise<{id:string}>;heldMacFor(task:import("../src/store.ts").Task,type:"default",parent:null):Promise<string|null>};
  return {store,creates,task,seam,service,chat,providers};
}
for(const preferred of ["instabox","scaleway"]) for(const kind of ["fail","disabled"] as const) test(`Mac routing handles ${preferred} ${kind} with provider-bound consent`,async()=>{
  const other=preferred==="instabox"?"scaleway":"instabox";const f=await routing(preferred,{[kind]:preferred});
  if(kind==="fail") {
    await assert.rejects(f.seam.createMacFor(f.task,"default",new AbortController().signal),{code:"at_capacity"});
    assert.deepEqual(f.creates,[preferred],"selected cost consent cannot authorize a different provider after rejection");
  } else {
    assert.equal((await f.seam.createMacFor(f.task,"default",new AbortController().signal)).id,`${other}_new`);
    assert.equal(f.store.get(f.task.id)?.sandboxProvider,other);assert.ok(f.store.events(f.task.id).some(e=>/Unavailable/.test(e.text)));
  }
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
  assert.equal(row.apiKey?.setting,"Scaleway secret key");assert.equal(row.systems[0]?.ready,true);assert.equal(view.options.find(o=>o.provider==="scaleway"),undefined);assert.equal(providerGlyph(row),"laptop");
  assert.deepEqual(view.options.find(o=>o.provider==="scaleway-macos"),{provider:"scaleway-macos",label:"Scaleway · Mac",disabledReason:null});
  const f=await routing("scaleway",{held:"scaleway"});assert.equal(macRunsOn(f.store.macLeases,"scaleway_held",[])?.label,"Scaleway");
});

for (const preferred of ["instabox", "scaleway"]) for (const unavailable of ["disabled", "fail"] as const) test(`dispatched Mac task handles ${preferred} ${unavailable} through provider capabilities`,async()=>{
  const f=await routing(preferred,{[unavailable]:preferred});
  const chosen=preferred==="instabox"?"scaleway":"instabox";
  const start=()=>f.service.startTask({title:"Mac task",brief:"Check Xcode",role:"custom",runner:"chat",project:macTaskProject()});
  if(unavailable==="fail") {
    await assert.rejects(start(),{code:"at_capacity"});
    assert.deepEqual(f.creates,[preferred]);return;
  }
  const task=await start();
  assert.equal(task.status,"running",task.error??""); assert.equal(task.sandboxProvider,chosen);
  assert.equal(task.sandboxSystem,"macos"); assert.equal(task.sandboxId,`${chosen}_new`);
  assert.equal(f.chat.spawns.at(-1)?.where.kind,"machine");
  assert.equal((await f.service.sandboxProvider(task).info(task.sandboxId!)).system,"macos");
  const lease=f.store.macLeases.held(task.sandboxId!)[0]!;
  const reservation=f.store.macLeases.tasks(lease.id).find(t=>t.taskId===task.id)!;
  assert.deepEqual([reservation.cpus,reservation.memoryMiB],chosen==="scaleway"?[2,4096]:[4,8192]);
  assert.ok(f.store.events(task.id).some(e=>/Unavailable/.test(e.text)));
  assert.deepEqual(f.creates,[chosen]);
});

test("Scaleway task dispatch refuses to spend without an agent and repository login path",async t=>{
  const f=await fixture(t);
  const inert=unavailableProvider("instabox");
  const instabox={...inert,caps:{...inert.caps,systems:["linux","macos"] as const},macModels:async()=>{assert.fail("unconfigured provider must not be queried");}};
  const registry=createProviderRegistry([createBoatProvider(new FakeBoat() as never),instabox,f.provider],{isEnabled:p=>p.id!=="instabox"});
  const chat=new FakeChat();
  const service=new BoatService(registry,f.store,{projects:()=>[{id:"mac",name:"Mac app",repos:[],machineType:null,sandboxProvider:"instabox",sandboxSystem:"macos"}],settings:async()=>defaultSettings({maxActiveSandboxes:0,workerMode:"chat",adhocWorkerMode:"chat",evidenceUploader:""}),chat,lifecycle:new AbortController().signal,changed:()=>{},notify:async()=>{},log:{info:()=>{},warn:()=>{}}});
  await assert.rejects(service.startTask({title:"Mac task",brief:"Check Xcode",role:"custom",runner:"chat",project:macTaskProject()}),/credentials are not configured/);
  assert.equal(f.calls.filter(c=>c.method==="POST"&&c.path.endsWith("/servers")).length,0);
  assert.equal(f.ssh.length,0);assert.equal(chat.spawns.length,0);
});

test("an uncertain Scaleway create preserves its key and blocks another rental until listing recovers it",async t=>{
  const f=await fixture(t);f.ambiguousCreate();
  await assert.rejects(f.create(),error=>{assert.equal((error as {code:string}).code,"creation_unknown");assert.doesNotMatch(String(error),new RegExp(secret));return true;});
  assert.equal((await f.keys.records())[0]?.serverId,undefined);
  await assert.rejects(f.create(),{code:"creation_allocated"});
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

test("shared hand-back schedules Scaleway at its minimum, cancels for new work and protects keep_sandbox",async t=>{
  const f=await fixture(t,1);const sandbox=await f.create();const chat=new FakeChat();
  const service=new BoatService(createProviderRegistry([createBoatProvider(new FakeBoat() as never),f.provider]),f.store,{settings:async()=>defaultSettings({maxActiveSandboxes:0,workerMode:"chat",adhocWorkerMode:"chat",evidenceUploader:""}),chat,lifecycle:new AbortController().signal,changed:()=>{},notify:async()=>{},log:{info:()=>{},warn:()=>{}}});
  const lease=f.store.macLeases.held()[0]!;
  await service.processMacLeases(Date.parse(lease.paidUntil)-20*60000);
  assert.equal(f.servers()[0]!.deletion_scheduled,true);assert.equal(f.store.macLeases.held()[0]!.releaseAt,lease.paidUntil);
  const task=await service.startTask({title:"Mac task",brief:"Check tools",role:"custom",sandboxSystem:"macos",runner:"chat"});
  assert.equal(task.status,"running",task.error??"");assert.equal(task.sandboxId,sandbox.id);
  assert.equal(f.servers()[0]!.deletion_scheduled,false);assert.equal(f.store.macLeases.held()[0]!.releaseAt,null);
  await service.closeTask(task.id,{keepSandbox:true});
  assert.equal(f.store.macLeases.held()[0]!.kept,true);
  await service.processMacLeases(Date.parse(lease.paidUntil)+3600000);
  assert.equal(f.servers().length,1);assert.ok(!f.calls.some(c=>c.method==="DELETE"&&c.path.includes("/servers/")));
});
test("shared hand-back releases an empty Scaleway Mac after its minimum with the correct end reason",async t=>{
  const f=await fixture(t);const sandbox=await f.create();
  const service=new BoatService(createProviderRegistry([createBoatProvider(new FakeBoat() as never),f.provider]),f.store,{settings:async()=>defaultSettings(),lifecycle:new AbortController().signal,changed:()=>{},notify:async()=>{},log:{info:()=>{},warn:()=>{}}});
  await service.processMacLeases();assert.equal(f.servers().length,0);
  assert.equal(f.store.macLeases.list()[0]?.endReason,"handed back");
  assert.equal(f.store.macLeases.list()[0]?.machineId,sandbox.id);assert.deepEqual(await f.keys.records(),[]);
});

test("Scaleway's no-op stop preserves unknown work without a permanent keep, then permits clean hand-back",async t=>{
  const f=await fixture(t);const sandbox=await f.create();const chat=new FakeChat();
  const service=new BoatService(createProviderRegistry([createBoatProvider(new FakeBoat() as never),f.provider]),f.store,{settings:async()=>defaultSettings({maxActiveSandboxes:0,workerMode:"chat",adhocWorkerMode:"chat",evidenceUploader:"",deleteSandboxOnClose:false}),chat,lifecycle:new AbortController().signal,changed:()=>{},notify:async()=>{},log:{info:()=>{},warn:()=>{}}});
  const task=await service.startTask({title:"Mac task",brief:"Check tools",role:"custom",sandboxSystem:"macos",runner:"chat"});
  assert.equal(task.status,"running",task.error??"");assert.equal(task.sandboxId,sandbox.id);
  chat.finish(task.threadId!,"done");
  f.store.update(task.id,{status:"idle",repo:"acme/mac",repoPath:"/work/mac",baseBranch:"main",delivery:"push",turns:1});
  let clean=false;const exec=f.provider.exec;
  f.provider.exec=async(id,script,options)=>script.includes("BOAT_AHEAD")?{exitCode:0,stdout:clean?"BOAT_AHEAD 0 clean\n":"BOAT_AHEAD x x\n",stderr:""}:exec(id,script,options);
  await service.closeTask(task.id);
  const lease=f.store.macLeases.held()[0]!;
  assert.equal(lease.kept,false);assert.equal(f.store.macLeases.tasks(lease.id)[0]!.workOutcome,"unknown");
  await f.provider.stop(sandbox.id);
  assert.equal((await f.provider.info(sandbox.id)).state,"idle");
  await f.provider.scheduleLeaseRelease!(sandbox.id,lease.paidUntil);f.store.macLeases.schedule(lease.id,lease.paidUntil);
  await service.processMacLeases();
  assert.equal(f.servers()[0]!.deletion_scheduled,false);
  assert.equal(f.store.macLeases.held()[0]!.releaseAt,null);assert.equal(f.store.macLeases.held()[0]!.kept,false);
  assert.ok(!f.calls.some(c=>c.method==="DELETE"&&c.path.includes("/servers/")));
  clean=true;await service.processMacLeases();
  assert.equal(f.store.macLeases.tasks(lease.id)[0]!.workOutcome,"clean");
  assert.equal(f.store.macLeases.held().length,0);assert.equal(f.store.macLeases.list()[0]!.endReason,"handed back");
});

test("a provider that requires bb chats is skipped before renting for a headless Mac task",async()=>{
  const f=await routing("scaleway");const task=f.store.update(f.task.id,{runner:"boat"})!;
  await f.seam.createMacFor(task,"default",new AbortController().signal);
  assert.deepEqual(f.creates,["instabox"]);
});

test("Scaleway Runs on saves through the generalized provider Mac option",async()=>{
  const f=await routing("scaleway");
  let project=normalizeProject({id:"mac",name:"Mac app",repos:[{repo:"acme/mac",baseBranch:"main"}]});
  const projects={get:(id:string)=>id===project.id?project:null,list:()=>[project],save:(input:Parameters<typeof normalizeProject>[0])=>{project=normalizeProject(input,project);return project;}};
  const handlers=providerHandlers({service:f.service,projects,bb:{rpc:{experimental_invalidate:()=>{}}},changed:()=>{}} as unknown as import("../src/runtime.ts").Runtime);
  const saved=await handlers.setProjectRunsOn({projectId:"mac",provider:"scaleway-macos"});
  assert.equal(project.sandboxProvider,"scaleway");assert.equal(project.sandboxSystem,"macos");assert.equal(saved.provider,"scaleway-macos");
  await assert.rejects(handlers.setProjectRunsOn({projectId:"mac",provider:"scaleway"}),/isn.t a sandbox provider/);
});

test("review repro: untagged Scaleway servers remain tracked and SSH works by name then recorded ID",async t=>{
  const f=await fixture(t);const sandbox=await f.create();
  assert.deepEqual(f.servers()[0].tags,[]);
  assert.match(f.servers()[0].name,/^bb-boat-[0-9a-f-]{36}$/);
  assert.ok(f.ssh.length>0);
  f.servers()[0].name="renamed-mac";
  const listed=await f.provider.list();assert.equal(listed.length,1);
  f.store.macLeases.reconcile("scaleway",new Set(listed.map(s=>s.id)));
  assert.equal(f.store.macLeases.held().length,1);
  await f.provider.exec(sandbox.id,"true");
  assert.equal(f.calls.filter(c=>c.method==="POST"&&c.path.endsWith("/servers")).length,1);
});
test("review repro: ambiguous POST without allocation clears only after a complete successful list",async t=>{
  const f=await fixture(t);f.ambiguousAbsent();await assert.rejects(f.create(),{code:"creation_unknown"});
  assert.equal((await f.keys.records()).length,1);
  f.listFailure(true);await assert.rejects(f.provider.list());assert.equal((await f.keys.records()).length,1);
  f.listFailure(false);assert.deepEqual(await f.provider.recoverCreations!(),{recovered:0,cleared:1});
  assert.deepEqual(await f.keys.records(),[]);assert.deepEqual(await f.provider.recoverCreations!(),{recovered:0,cleared:0});
});
test("schedule API uses schedule_deletion, and failed bootstrap surfaces a failed safety schedule",async t=>{
  const f=await fixture(t);f.failSetup();f.scheduleFailure();
  await assert.rejects(f.create(),error=>{assert.equal((error as {code:string}).code,"creation_allocated");assert.match(String(error),/automatic deletion could not be scheduled/);return true;});
  assert.ok(f.calls.some(c=>c.method==="PATCH"&&c.body.schedule_deletion===true));
  assert.ok(!f.calls.some(c=>c.method==="PATCH"&&"deletion_scheduled" in c.body));
  assert.equal(f.store.macLeases.held().length,1);assert.equal((await f.provider.list()).length,1);
});
test("held Scaleway Macs require verified agent and GitHub logins before use",async t=>{
  const f=await fixture(t);const sandbox=await f.create();
  await f.provider.assertTaskReady!({agent:"codex",repos:["acme/private"],sandboxId:sandbox.id});
  f.noGithubLogin();await assert.rejects(f.provider.assertTaskReady!({agent:"codex",repos:["acme/private"],sandboxId:sandbox.id}),/GitHub login/);
  f.noAgentLogin();await assert.rejects(f.provider.assertTaskReady!({agent:"codex",repos:[],sandboxId:sandbox.id}),/agent login/);
  await assert.rejects(f.provider.assertTaskReady!({agent:"codex",repos:["acme/private"]}),/GitHub token for rented machines/);
});

test("Scaleway allocation records its lease before the separate slow readiness phase",async t=>{
  const f=await fixture(t);const sandbox=await f.provider.allocate!({name:"task",type:"default",system:"macos",ttlSeconds:3600,gitGuard:true});
  assert.equal(sandbox.state,"starting");assert.equal(f.ssh.length,0);assert.equal(f.store.macLeases.held().length,1);
  await assert.rejects(f.provider.allocate!({name:"second",type:"default",system:"macos",ttlSeconds:3600,gitGuard:true}),{code:"creation_allocated"});
  assert.equal((await f.provider.waitReady!(sandbox.id)).state,"idle");assert.ok(f.ssh.length>0);
});
test("an Instabox create timeout cannot trigger a second rental on Scaleway",async()=>{
  const f=await routing("instabox");
  f.providers[0]!.create=async()=>{f.creates.push("instabox");throw new ProviderError("allocated, but ready timed out",{code:"instabox_timeout"});};
  await assert.rejects(f.service.startTask({title:"Mac",brief:"Check tools",role:"custom",runner:"chat",project:macTaskProject()}),/outcome is unknown/);
  assert.deepEqual(f.creates,["instabox"]);
});
test("a slow Mac bootstrap leaves the placement lock free for hand-back and held-lease reuse",async()=>{
  const f=await routing("scaleway");const scw=f.providers[1]!,ibx=f.providers[0]!;
  let finish!:()=>void,entered!:()=>void;
  const ready=new Promise<void>(resolve=>{finish=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
  scw.list=async()=>f.creates.includes("scaleway")?[{id:"scaleway_new",state:"idle",system:"macos"} as never]:[];
  scw.allocate=scw.create.bind(scw);scw.create=async()=>{throw new Error("must allocate in two phases");};
  scw.waitReady=async id=>{entered();await ready;return scw.info(id);};
  const first=f.service.startTask({title:"Slow Mac",brief:"Check tools",role:"custom",runner:"chat",project:macTaskProject()});
  await waiting;
  const machines:string[]=["instabox_empty"];
  ibx.list=async()=>machines.map(id=>({id,state:"idle",system:"macos"} as never));
  ibx.delete=async id=>{machines.splice(machines.indexOf(id),1);};
  const record=(id:string,start:number)=>f.store.macLeases.record({id:`instabox:${id}`,provider:"instabox",machineId:id,size:"m2",startedAt:new Date(start).toISOString(),paidUntil:new Date(start+86400000).toISOString(),minimumCost:10,hourPrice:10/24,currency:"USD",cpus:8,memoryMiB:16384});
  record("instabox_empty",Date.now()-25*3600000);
  const bounded=async<T>(work:Promise<T>)=>{let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([work,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error("placement lock was held by readiness")),2000);})]);}finally{clearTimeout(timer!);}};
  try {
    await bounded(f.service.processMacLeases());assert.equal(f.store.macLeases.held("instabox_empty").length,0);
    machines.push("instabox_shared");record("instabox_shared",Date.now());
    const next=await bounded(f.service.startTask({title:"Shared Mac",brief:"Check tools",role:"custom",runner:"chat",project:macTaskProject()}));
    assert.equal(next.status,"running",next.error??"");assert.equal(next.sandboxId,"instabox_shared");
    assert.equal(f.store.get((f.store.macLeases.tasks(f.store.macLeases.held("scaleway_new")[0]!.id)[0]!).taskId)?.status,"starting");
  } finally {finish();await first;}
});

test("the fake rejects response-only fields in real Scaleway create and update requests",async t=>{
  const f=await fixture(t);
  await assert.rejects(f.api.request("POST","/apple-silicon/v1alpha1/zones/fr-par-3/servers",{name:"bad",project_id:projectId,type:"M1-M",commitment_type:"duration_24h",tags:["not-supported"]}),{code:"creation_rejected"});
  const sandbox=await f.create();
  await assert.rejects(f.api.request("PATCH",`/apple-silicon/v1alpha1/zones/fr-par-3/servers/${serverId}`,{deletion_scheduled:true}));
  assert.equal((await f.provider.info(sandbox.id)).scheduledReleaseAt,null);
});
test("providers recover clears absent unresolved keys from the supported plugin database directory",async t=>{
  const {createTestHost}=await import("./fakes.ts");const {default:plugin}=await import("../server.ts");
  const {fileURLToPath}=await import("node:url");const {dirname}=await import("node:path");
  const {bb,harness}=await createTestHost({pluginId:"boat",settings:{boatPath:fileURLToPath(new URL("../src/providers/boat/fixtures/fake-boat.mjs",import.meta.url)),evidenceUploader:"",scalewayProjectId:projectId,scalewaySecretKey:secret}});
  t.after(()=>harness.lifecycle.dispose());
  const keys=new ScalewayKeys(join(dirname(bb.storage.database().name),"scaleway-keys"));
  const key=await keys.generate();await keys.save({token:key.token,sshKeyId:keyId,zone:"fr-par-3",projectId});
  const oldFetch=globalThis.fetch;const calls:string[]=[];
  globalThis.fetch=async(url,init)=>{
    const path=new URL(String(url)).pathname;calls.push(`${init?.method} ${path}`);
    if(init?.method==="GET"&&path.endsWith("/servers"))return new Response(JSON.stringify({servers:[],total_count:0}));
    if(init?.method==="DELETE"&&path.endsWith(keyId))return new Response(null,{status:204});
    throw new Error("Unexpected recovery request");
  };
  try {
    await plugin(bb);const result=await harness.runCli(["providers","recover","scaleway","--json"]);
    assert.equal(result.exitCode,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{recovered:0,cleared:1});
    assert.deepEqual(await keys.records(),[]);assert.equal(calls.filter(call=>call.startsWith("POST")).length,0);
  } finally {globalThis.fetch=oldFetch;await keys.remove(key.token);}
});

test("foreign Harbormaster-named Scaleway servers are reported as orphans without adoption or automatic deletion",async t=>{
  const f=await fixture(t);
  const foreign={zone:"fr-par-3",id:serverId,name:"bb-boat-40000000-0000-4000-8000-000000000001",type:"M1-M",project_id:projectId,status:"ready",delivered:true,ip:"192.0.2.1",ssh_username:"mac-user",created_at:new Date(Date.now()-25*3600000).toISOString(),deletable_at:new Date(Date.now()-3600000).toISOString()};
  f.servers().push(foreign);
  const id=`scw_fr-par-3_${serverId}`;
  assert.deepEqual(await f.provider.list(),[]);
  assert.deepEqual(await f.provider.orphans!(),[{id,name:foreign.name}]);
  assert.equal(f.store.macLeases.list().length,0);
  await assert.rejects(f.provider.info(id),{code:"unmanaged_server"});
  await assert.rejects(f.provider.delete(id),{code:"unmanaged_server"});
  await assert.rejects(f.provider.scheduleLeaseRelease!(id,foreign.deletable_at),{code:"unmanaged_server"});
  const registry=createProviderRegistry([createBoatProvider(new FakeBoat() as never),f.provider]);
  const service=new BoatService(registry,f.store,{settings:async()=>defaultSettings(),lifecycle:new AbortController().signal,changed:()=>{},notify:async()=>{},log:{info:()=>{},warn:()=>{}}});
  await service.processMacLeases();
  assert.equal(f.servers().length,1);assert.equal(f.calls.filter(c=>c.method==="DELETE"||c.method==="PATCH").length,0);
  const {providerStates}=await import("../src/provider-status.ts");
  const states=()=>providerStates({registry,projects:()=>[],machines:()=>new Set(),boatSetup:null,instabox:null});
  assert.deepEqual((await states()).find(state=>state.id==="scaleway")?.orphans,[{id,name:foreign.name}]);
  const {createTestHost}=await import("./fakes.ts");const {buildCli}=await import("../src/cli.ts");
  const {fileURLToPath}=await import("node:url");
  const {bb,harness}=await createTestHost({pluginId:"boat",settings:{boatPath:fileURLToPath(new URL("../src/providers/boat/fixtures/fake-boat.mjs",import.meta.url))}});t.after(()=>harness.lifecycle.dispose());
  const runtime={bb,service,projects:{list:()=>[]},projectForThread:async()=>null,providers:{states,keyPresent:()=>true},setup:null} as unknown as import("../src/runtime.ts").Runtime;
  bb.cli.register(buildCli(runtime));
  const output=await harness.runCli(["providers"]);assert.equal(output.exitCode,0,output.stderr);
  assert.ok(output.stdout.includes(`orphan: ${id} (${foreign.name})`));
  const json=await harness.runCli(["providers","--json"]);
  assert.deepEqual(JSON.parse(json.stdout).providers.find((p:any)=>p.id==="scaleway").orphans,[{id,name:foreign.name}]);
  const status=await harness.runCli(["status"]);assert.equal(status.exitCode,0,status.stderr);
  assert.ok(status.stdout.includes(`orphan: ${id} (${foreign.name})`));
  const statusJson=await harness.runCli(["status","--json"]);assert.equal(statusJson.exitCode,0,statusJson.stderr);
  assert.deepEqual(JSON.parse(statusJson.stdout).providers.find((p:any)=>p.provider==="scaleway").orphans,[{id,name:foreign.name}]);
  const page=await providerHandlers(runtime).sandboxProviders();
  assert.match(page.providers.find(p=>p.id==="scaleway")!.status!,/1 orphan server.*not managed/);
  assert.equal(f.store.macLeases.list().length,0);
});

test("listing during an in-flight Scaleway POST cannot remove its IAM or private SSH key",async t=>{
  const f=await fixture(t);const gate=f.blockCreate();
  const creation=f.create();await gate.entered;
  const record=(await f.keys.records())[0]!;
  let listed=false;const listing=f.provider.list().then(result=>{listed=true;return result;});
  try {
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(listed,false,"listing must wait for the allocation outcome");
    assert.equal((await stat(f.keys.path(record.token))).mode & 0o777,0o600);
    assert.equal(f.calls.filter(c=>c.method==="DELETE").length,0);
  } finally {gate.release();}
  const sandbox=await creation;
  assert.equal((await listing)[0]?.id,sandbox.id);
  assert.equal((await f.keys.records())[0]?.serverId,serverId);
  assert.equal((await stat(f.keys.path(record.token))).mode & 0o777,0o600);
  await f.provider.exec(sandbox.id,"true");
  assert.equal(f.calls.filter(c=>c.method==="DELETE").length,0);
});

test("Scaleway classifies IAM failures before allocation without claiming an unknown server",async t=>{
  const f=await fixture(t);f.failKey();
  await assert.rejects(f.create(),{code:"scaleway_failed"});
  assert.equal(f.provider.classifiesCreateErrors,true);
  assert.equal(f.calls.filter(c=>c.method==="POST"&&c.path.endsWith("/servers")).length,0);
  assert.deepEqual(await f.keys.records(),[]);
});

for(const preferred of ["instabox","scaleway"]) test(`a classified ${preferred} pre-allocation error requires new owner choice before fallback`,async()=>{
  const f=await routing(preferred);const chosen=preferred==="instabox"?"scaleway":"instabox";
  const provider=f.providers.find(p=>p.id===preferred)!;provider.classifiesCreateErrors=true;
  provider.create=async()=>{f.creates.push(preferred);throw new ProviderError("Pre-allocation request failed",{code:"catalog_failed"});};
  await assert.rejects(f.service.startTask({title:"Mac",brief:"Check tools",role:"custom",runner:"chat",project:macTaskProject()}),{code:"catalog_failed"});
  assert.deepEqual(f.creates,[preferred],"another provider still requires its own cost consent");
});

test("each Mac fallback provider runs its own agent preflight before models or allocation",async()=>{
  const checked:string[]=[];
  const f=await routing("instabox",{preflight:async input=>{
    if(input.provider)checked.push(input.provider);
    if(input.provider==="instabox")throw new Error("Instabox isn't ready: account is not activated.");
    if(input.provider==="scaleway"&&input.agent){assert.equal(input.agent,"codex");assert.equal(input.runner,"chat");assert.equal(input.newSandbox,true);}
  }});
  f.providers[0]!.macModels=async()=>{assert.fail("models must not be queried before preflight succeeds");};
  const task=await f.service.startTask({title:"Mac",brief:"Check tools",role:"custom",provider:"codex",runner:"chat",project:macTaskProject()});
  assert.equal(task.sandboxProvider,"scaleway");assert.deepEqual(f.creates,["scaleway"]);
  assert.deepEqual(checked,["instabox","scaleway","instabox","scaleway","scaleway"]); // Fresh preflight after fake cost consent too.
  assert.ok(f.store.events(task.id).some(e=>e.text.includes("Instabox isn't ready")));
});

test("providers CLI leaves an unconfigured Scaleway off without making provider reads",async()=>{
 const {providerStates}=await import("../src/provider-status.ts");let reads=0;
 const scw={...unavailableProvider("scaleway"),presentation:async()=>{reads++;return {steps:[]};}};
 const registry=createProviderRegistry([createBoatProvider(new FakeBoat() as never),scw],{isEnabled:p=>p.id!=="scaleway"});
 const states=await providerStates({registry,projects:()=>[],machines:()=>new Set(),boatSetup:null,instabox:null});
 const row=states.find(p=>p.id==="scaleway")!;assert.equal(row.status,"off");assert.equal(row.turnedOn,false);assert.equal(row.problem,null);assert.equal(reads,0);
});

function rentedCredentials(available = true) {
  return createCredentialSource({ githubToken: async () => "fake_mac_github_token", agentAvailable: async agent => available && agent === "codex", fetch: (async () => new Response(JSON.stringify({permissions:{push:true,pull:true}}), {headers:{"github-authentication-token-expiration":new Date(Date.now()+90*86400_000).toISOString()}})) as typeof fetch });
}
test("configured credentials lift the fresh Mac gate for the selected agent and repositories", async t => {
  const f = await fixture(t, 25, rentedCredentials());
  await f.provider.assertTaskReady!({agent:"codex",repos:["acme/web"]});
  await assert.rejects(f.provider.assertTaskReady!({agent:"claude",repos:["acme/web"]}), {code:"task_credentials_missing"});
  assert.equal(f.servers().length, 0);
  const sandbox = await f.create();
  assert.ok(!f.ssh.some(request => request.stdin === "fake_mac_github_token\n"));
  await f.provider.beforeRepo!(sandbox.id);
  const login = f.ssh.find(request => request.stdin === "fake_mac_github_token\n")!;
  assert.ok(login); assert.ok(!JSON.stringify(login.command).includes("fake_mac_github_token"));
  const steps = (await f.provider.presentation!()).steps;
  assert.ok(steps.every(step=>step.done && step.possible));
  assert.match(steps.find(step=>step.id==="agent-route")!.detail, /Codex/);
  await f.provider.delete(sandbox.id);
  const cleanup = f.order.findIndex(command=>command.includes("auth logout"));
  const release = f.order.findIndex(command=>command.startsWith("DELETE /apple-silicon"));
  assert.ok(cleanup >= 0 && cleanup < release, "verified credential removal precedes API release");
});
test("scheduled hand-back cleans delivery; failed tool bootstrap schedules without credential SSH", async t => {
  for (const failed of [false, true]) {
    const f = await fixture(t, 23, rentedCredentials());
    if (failed) { f.failSetup(); await assert.rejects(f.create(), {code:"creation_allocated"}); }
    else { const sandbox = await f.create(); await f.provider.beforeRepo!(sandbox.id); await f.provider.scheduleLeaseRelease!(sandbox.id, f.servers()[0]!.deletable_at); }
    const cleanup = f.order.findIndex(command=>command.includes("auth logout"));
    const schedule = f.order.findIndex(command=>command.startsWith("PATCH /apple-silicon"));
    assert.ok(failed ? cleanup === -1 && schedule >= 0 : cleanup >= 0 && cleanup < schedule);
  }
});
test("cleanup failure prevents both immediate and scheduled release and preserves SSH recovery", async t => {
  const source = rentedCredentials();
  source.cleanup = async () => { throw Object.assign(new Error("Credential removal could not be verified"), {code:"credential_cleanup_failed"}); };
  const f = await fixture(t, 25, source); const sandbox = await f.create(); await f.provider.beforeRepo!(sandbox.id);
  await assert.rejects(f.provider.delete(sandbox.id), {code:"credential_cleanup_failed"});
  await assert.rejects(f.provider.scheduleLeaseRelease!(sandbox.id, f.servers()[0]!.deletable_at), {code:"credential_cleanup_failed"});
  assert.ok(!f.calls.some(call=>call.method==="DELETE" || call.method==="PATCH"));
  assert.equal(f.store.macLeases.held().length, 1); assert.equal((await f.keys.records()).length, 1);
});
test("missing agent route refuses repository task before allocation; every task record stays secret-free", async t => {
  const f = await fixture(t, 25, rentedCredentials(false));
  const registry = createProviderRegistry([createBoatProvider(new FakeBoat() as never),f.provider]);
  const service = new BoatService(registry,f.store,{projects:()=>[{id:"mac",name:"Mac app",repos:[],machineType:null,sandboxProvider:"scaleway",sandboxSystem:"macos"}],settings:async()=>defaultSettings({maxActiveSandboxes:0,workerMode:"chat",adhocWorkerMode:"chat",evidenceUploader:""}),chat:new FakeChat(),lifecycle:new AbortController().signal,changed:()=>{},notify:async()=>{},log:{info:()=>{},warn:()=>{}}});
  await assert.rejects(service.startTask({title:"Mac task",brief:"Check tools",repo:"acme/web",role:"custom",runner:"chat",project:macTaskProject()}));
  assert.equal(f.servers().length,0); assert.ok(!f.calls.some(call=>call.method==="POST"));
  assert.ok(!JSON.stringify(f.store.list().map(task=>({task,events:f.store.events(task.id)}))).includes("fake_mac_github_token"));
});
test("failed bb enrollment invokes private cleanup without logging credentials", async t => {
  const { registerSandboxMachine } = await import("../src/providers/machine.ts");
  const f = await fixture(t, 25, rentedCredentials()); const sandbox = await f.create(); await f.provider.beforeRepo!(sandbox.id);
  let registration: any;
  const logs: string[] = [], values = new Map();
  const bb = { experimental_machines: { register: (value: unknown) => { registration = value; }, bootstrap: async () => { throw new Error("test enrollment failure"); } }, experimental_environments: { register: () => {} }, storage: { kv: { get: async (key: string) => values.get(key), set: async (key: string, value: unknown) => { values.set(key,value); } } } };
  registerSandboxMachine(bb as never, f.provider, {service:{} as never,settings:async()=>defaultSettings(),availability:async()=>({status:"available"})});
  const result = await registration.create({inputs:{sandboxId:sandbox.id},key:"test-machine",checkpoint:async()=>{},report:{step:(line:string)=>logs.push(line),log:(line:string)=>logs.push(line)},signal:new AbortController().signal});
  assert.equal(result.status,"failed");
  assert.ok(f.ssh.at(-1)!.command.some(line=>line.includes("auth logout")));
  assert.ok(!JSON.stringify({logs,result,events:f.store.list().map(task=>f.store.events(task.id))}).includes("fake_mac_github_token"));
  for (const request of f.ssh) assert.ok(!JSON.stringify({...request,stdin:undefined}).includes("fake_mac_github_token"));
});
test("held-lease maintenance re-delivers an expiring GitHub source and records only expiry", async t => {
  const f = await fixture(t); const sandbox = await f.create();
  const registry = createProviderRegistry([createBoatProvider(new FakeBoat() as never), f.provider]);
  const service = new BoatService(registry,f.store,{settings:async()=>defaultSettings(),lifecycle:new AbortController().signal,changed:()=>{},notify:async()=>{},log:{info:()=>{},warn:()=>{}}});
  const initial = await service.startTask({title:"Refresh",brief:"Check tools",role:"custom",runner:"boat"});
  const task = f.store.update(initial.id,{sandboxProvider:"scaleway",sandboxId:sandbox.id,repo:"acme/web",status:"running"})!;
  f.store.addEvent(task.id,"github-token",new Date(Date.now()+60_000).toISOString());
  const expiry = new Date(Date.now()+86400_000).toISOString(); let refreshed = 0;
  f.provider.refreshGithubLogin = async id => { assert.equal(id,sandbox.id); refreshed++; return expiry; };
  await service.processMacLeases();
  assert.equal(refreshed,1); assert.equal(f.store.latestEvent(task.id,"github-token")?.text,expiry);
  assert.ok(f.servers().length,"active task keeps its lease");
});

test("held-lease refresh failure does not interrupt maintenance or repeat unchanged warnings", async t => {
  const f = await fixture(t); const sandbox = await f.create();
  const service = new BoatService(createProviderRegistry([createBoatProvider(new FakeBoat() as never),f.provider]),f.store,{settings:async()=>defaultSettings(),lifecycle:new AbortController().signal,changed:()=>{},notify:async()=>{},log:{info:()=>{},warn:()=>{}}});
  const initial = await service.startTask({title:"Refresh",brief:"Check tools",role:"custom",runner:"boat"});
  const task = f.store.update(initial.id,{sandboxProvider:"scaleway",sandboxId:sandbox.id,repo:"acme/web",status:"running"})!;
  f.store.addEvent(task.id,"github-token",new Date(Date.now()+60_000).toISOString());
  f.provider.refreshGithubLogin = async () => { throw new Error("Replace the rented-machine GitHub token in bb secret settings."); };
  await service.processMacLeases(); await service.processMacLeases();
  assert.equal(f.store.events(task.id).filter(event=>event.kind==="github-refresh-failed").length,1);
  assert.equal(f.store.macLeases.held().length,1);
});

for (const state of ["error", "locked", "ssh-unavailable"] as const) test(`a never-provisioned ${state} Mac can be scheduled and deleted without SSH cleanup`, async t => {
  const f = await fixture(t, 25, rentedCredentials(), state === "ssh-unavailable" ? 500 : 100);
  if (state === "ssh-unavailable") f.sshExit(255); else f.status(state);
  await assert.rejects(f.create(), {code:"creation_allocated"});
  assert.ok(f.calls.some(call=>call.method==="PATCH" && call.body.schedule_deletion));
  assert.equal((await f.keys.records())[0]!.credentialDeliveryAttempted, false);
  assert.ok(!f.ssh.some(request=>request.command.some(line=>line.includes("auth logout"))));
  if (state === "ssh-unavailable") assert.ok(f.ssh.length > 0);
  const id = `scw_fr-par-3_${serverId}`;
  // A provider restart preserves proof that this machine never received a token.
  const restarted = f.makeProvider(rentedCredentials());
  await restarted.scheduleLeaseRelease!(id, f.servers()[0]!.deletable_at);
  await restarted.delete(id);
  assert.equal(f.store.macLeases.held().length, 0);
});
test("delivery attempt is persisted before SSH and an uncertain attempt survives restart", async t => {
  const f = await fixture(t, 25, rentedCredentials()); const sandbox = await f.create();
  f.onSsh(async request => {
    if (request.stdin === "fake_mac_github_token\n") assert.equal((await f.keys.records())[0]!.credentialDeliveryAttempted, true);
  });
  f.sshExit(255);
  await assert.rejects(f.provider.beforeRepo!(sandbox.id));
  const record = (await f.keys.records())[0]!;
  assert.equal(record.credentialDeliveryAttempted, true);
  assert.equal((await stat(`${f.keys.path(record.token)}.json`)).mode & 0o777, 0o600);
  const restarted = f.makeProvider(rentedCredentials());
  await assert.rejects(restarted.scheduleLeaseRelease!(sandbox.id, f.servers()[0]!.deletable_at), {code:"credential_cleanup_failed"});
  await assert.rejects(restarted.delete(sandbox.id), {code:"credential_cleanup_failed"});
  assert.ok(!f.calls.some(call=>call.method==="PATCH" || call.method==="DELETE"));
  f.sshExit(0); await restarted.scheduleLeaseRelease!(sandbox.id, f.servers()[0]!.deletable_at);
  assert.equal((await f.keys.records())[0]!.credentialDeliveryAttempted, false);
});
test("legacy unknown credential state still requires verified cleanup", async t => {
  const f = await fixture(t); const sandbox = await f.create();
  const record = (await f.keys.records())[0]!;
  const { credentialDeliveryAttempted: _attempt, ...legacy } = record;
  await f.keys.save(legacy);
  f.sshExit(255);
  await assert.rejects(f.makeProvider().delete(sandbox.id), {code:"credential_cleanup_failed"});
  assert.ok(!f.calls.some(call=>call.method==="DELETE"));
});
test("held preflight and daemon bootstrap never deliver; scheduled and failed-cancel Macs refuse repository delivery", async t => {
  const f = await fixture(t, 23, rentedCredentials()); const sandbox = await f.create();
  await f.provider.beforeRepo!(sandbox.id);
  await f.provider.scheduleLeaseRelease!(sandbox.id, f.servers()[0]!.deletable_at);
  const deliveries = () => f.ssh.filter(request=>request.stdin === "fake_mac_github_token\n").length;
  const count = deliveries();
  await f.provider.assertTaskReady!({agent:"codex",repos:["acme/web"],sandboxId:sandbox.id});
  await f.provider.machineHooks!({warn:()=>{},debug:()=>{}}).beforeBootstrap!(sandbox.id);
  assert.equal(deliveries(), count);
  await assert.rejects(f.provider.beforeRepo!(sandbox.id), {code:"machine_release_scheduled"});
  await assert.rejects(f.provider.refreshGithubLogin!(sandbox.id), {code:"machine_release_scheduled"});
  f.scheduleFailure(); await assert.rejects(f.provider.cancelLeaseRelease!(sandbox.id));
  await assert.rejects(f.provider.beforeRepo!(sandbox.id), {code:"machine_release_scheduled"});
  assert.equal(deliveries(), count);
  assert.equal((await f.keys.records())[0]!.credentialDeliveryAttempted, false);
});
test("scheduled hand-back waits for a concurrent delivery, then cleans it before PATCH", async t => {
  const f = await fixture(t, 23, rentedCredentials()); const sandbox = await f.create();
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(resolve=>{release=resolve;});
  const waiting = new Promise<void>(resolve=>{entered=resolve;});
  f.onSsh(async request=>{ if (request.stdin === "fake_mac_github_token\n") {entered();await paused;} });
  const delivering = f.provider.beforeRepo!(sandbox.id); await waiting;
  const scheduling = f.provider.scheduleLeaseRelease!(sandbox.id, f.servers()[0]!.deletable_at);
  assert.ok(!f.calls.some(call=>call.method==="PATCH"));
  release(); await delivering; await scheduling;
  const cleanup = f.order.findIndex(line=>line.includes("auth logout"));
  const patch = f.order.findIndex(line=>line.startsWith("PATCH /apple-silicon"));
  assert.ok(cleanup >= 0 && cleanup < patch);
  assert.equal((await f.keys.records())[0]!.credentialDeliveryAttempted, false);
});
test("repo-less Macs do not receive a stored token and are ready without one", async t => {
  let reads = 0;
  const source = createCredentialSource({githubToken:async()=>{reads++;return "fake_unused_token";},agentAvailable:async()=>true,fetch:(async()=>{assert.fail("repo-less tasks must not validate GitHub");}) as typeof fetch});
  const f = await fixture(t, 25, source);
  await f.provider.assertTaskReady!({agent:"codex",repos:[]});
  const sandbox = await f.create();
  await f.provider.machineHooks!({warn:()=>{},debug:()=>{}}).beforeBootstrap!(sandbox.id);
  assert.equal(reads, 0); assert.equal((await f.keys.records())[0]!.credentialDeliveryAttempted,false);
  assert.ok(!f.ssh.some(request=>request.stdin === "fake_unused_token\n"));
  const missing = await fixture(t, 25, createCredentialSource({githubToken:async()=>null,agentAvailable:async()=>true}));
  const presentation = await missing.provider.presentation!();
  assert.equal(presentation.steps.find(step=>step.id==="enabled")!.done,true);
  assert.equal(presentation.steps.find(step=>step.id==="rented-github")!.required,false);
  const {providerStates} = await import("../src/provider-status.ts");
  const states = await providerStates({registry:createProviderRegistry([createBoatProvider(new FakeBoat() as never),missing.provider]),projects:()=>[],machines:()=>new Set(),boatSetup:null,instabox:null});
  assert.equal(states.find(state=>state.id==="scaleway")!.status,"ready");
  await assert.rejects(missing.provider.assertTaskReady!({agent:"codex",repos:["acme/web"]}));
});

function credentialService(f: Awaited<ReturnType<typeof fixture>>, warnings: string[] = [], changed = () => {}) {
  return new BoatService(createProviderRegistry([createBoatProvider(new FakeBoat() as never),f.provider]),f.store,{settings:async()=>defaultSettings(),lifecycle:new AbortController().signal,changed,notify:async()=>{},log:{info:()=>{},warn:line=>warnings.push(line)}});
}
for (const failure of ["create", "resume", "cancel"] as const) test(`failed ${failure} bootstrap preserves a shared Mac's live-task logins`, async t => {
  const {registerSandboxMachine} = await import("../src/providers/machine.ts");
  const f = await fixture(t,25,rentedCredentials()); const sandbox = await f.create(); await f.provider.beforeRepo!(sandbox.id);
  const service = credentialService(f);
  const initial = await service.startTask({title:"Existing task",brief:"Check tools",role:"custom",runner:"boat"});
  f.store.update(initial.id,{sandboxProvider:"scaleway",sandboxId:sandbox.id,repo:"acme/web",status:"running"});
  let registration: any; const values = new Map(); const controller = new AbortController();
  const bb = {experimental_machines:{register:(value:unknown)=>{registration=value;},bootstrap:async()=>{if(failure==="cancel")controller.abort();throw new Error("test enrollment failure");}},experimental_environments:{register:()=>{}},storage:{kv:{get:async(key:string)=>values.get(key),set:async(key:string,value:unknown)=>{values.set(key,value);}}}};
  registerSandboxMachine(bb as never,f.provider,{service,settings:async()=>defaultSettings(),availability:async()=>({status:"available"})});
  const report = {step:()=>{},log:()=>{}};
  const run = failure === "resume" ? registration.resume({resource:{sandboxId:sandbox.id,key:"test"},report,signal:controller.signal}) : registration.create({inputs:{sandboxId:sandbox.id},key:"test",checkpoint:async()=>{},report,signal:controller.signal});
  if(failure==="create")assert.equal((await run).status,"failed");else await assert.rejects(run);
  assert.ok(!f.ssh.some(request=>request.command.some(line=>line.includes("auth logout"))));
  assert.equal((await f.keys.records())[0]!.credentialDeliveryAttempted,true);
});
test("failed bootstrap preserves a live lease attachment even before its sandbox ID is recorded", async t => {
  const f = await fixture(t); const sandbox = await f.create(); const service = credentialService(f);
  const task = await service.startTask({title:"Reserved task",brief:"Check tools",role:"custom",runner:"boat"});
  f.store.update(task.id,{status:"starting",sandboxId:null});
  f.store.macLeases.attach(f.store.macLeases.held(sandbox.id)[0]!.id,task.id,1,1024);
  let cleaned = false;
  await service.cleanupFailedMachineBootstrap(sandbox.id,async()=>{cleaned=true;});
  assert.equal(cleaned,false);
});
test("missing delivery cache re-delivers despite a task's distant recorded expiry", async t => {
  const source = rentedCredentials(); const f = await fixture(t,25,source); const sandbox = await f.create(); await f.provider.beforeRepo!(sandbox.id);
  const service = credentialService(f);
  const initial = await service.startTask({title:"Existing task",brief:"Check tools",role:"custom",runner:"boat"});
  const task = f.store.update(initial.id,{sandboxProvider:"scaleway",sandboxId:sandbox.id,repo:"acme/web",status:"running"})!;
  f.store.addEvent(task.id,"github-token",new Date(Date.now()+90*86400_000).toISOString());
  await source.cleanup(sandbox.id,f.provider.executor!(sandbox.id));
  await (service as unknown as {assertGithubLogin(value:typeof task):Promise<void>}).assertGithubLogin(task);
  assert.equal(f.ssh.filter(request=>request.stdin === "fake_mac_github_token\n").length,2);
});
for (const afterMinimum of [false,true]) test(`one lease's failed ${afterMinimum ? "delete" : "schedule"} does not stop hand-back for the next lease`, async()=>{
  const f = await routing("scaleway"); const provider = f.providers[1]!;
  const warnings:string[]=[];
  const service = new BoatService(createProviderRegistry([createBoatProvider(new FakeBoat() as never),provider]),f.store,{settings:async()=>defaultSettings(),lifecycle:new AbortController().signal,changed:()=>{},notify:async()=>{},log:{info:()=>{},warn:line=>warnings.push(line)}});
  const minimum = Date.now()+(afterMinimum ? -1 : 10*60_000); const done:string[]=[];
  for(const id of ["scaleway_unreachable","scaleway_other"]) f.store.macLeases.record({id,provider:"scaleway",machineId:id,size:"M1-M",startedAt:new Date(minimum-86400_000).toISOString(),paidUntil:new Date(minimum).toISOString(),minimumCost:10,hourPrice:10/24,currency:"EUR",cpus:8,memoryMiB:16384});
  provider.list=async()=>f.store.macLeases.held().map(lease=>({id:lease.machineId,state:"idle",system:"macos"} as never));
  provider.findInfo=async id=>({id,state:"idle",system:"macos",scheduledReleaseAt:null} as never);
  provider.cancelLeaseRelease=async()=>{};
  const release=async(id:string)=>{if(id==="scaleway_unreachable")throw new Error("Credential removal could not be verified");done.push(id);};
  provider.delete=release;provider.scheduleLeaseRelease=release;
  await service.processMacLeases();
  assert.deepEqual(done,["scaleway_other"]);
  assert.ok(warnings.some(line=>line.includes("scaleway_unreachable") && line.includes("Credential removal")));
});

test("failed placement cancellation leaves the scheduled Mac credential-free", async t => {
  const f = await fixture(t,23,rentedCredentials()); const sandbox = await f.create();
  await f.provider.scheduleLeaseRelease!(sandbox.id,f.servers()[0]!.deletable_at);
  f.scheduleFailure();
  const service = new BoatService(createProviderRegistry([createBoatProvider(new FakeBoat() as never),f.provider]),f.store,{settings:async()=>defaultSettings({workerMode:"chat",adhocWorkerMode:"chat",evidenceUploader:""}),chat:new FakeChat(),lifecycle:new AbortController().signal,changed:()=>{},notify:async()=>{},log:{info:()=>{},warn:()=>{}}});
  let failure: unknown;
  try { await service.startTask({title:"Repository task",brief:"Check tools",repo:"acme/web",role:"custom",runner:"chat",provider:"codex",sandboxSystem:"macos",confirmUntrustedChat:["acme/web"]}); } catch (error) { failure = error; }
  assert.ok(failure);
  assert.ok(f.calls.some(call=>call.method==="PATCH" && call.body.schedule_deletion===false),`placement tried to cancel deletion: ${String(failure)}`);
  assert.equal(f.servers()[0]!.deletion_scheduled,true);
  assert.ok(!f.ssh.some(request=>request.stdin==="fake_mac_github_token\n"));
  assert.equal((await f.keys.records())[0]!.credentialDeliveryAttempted,false);
});

test("the only failing start cleans its credentials, while a running owner stays protected", async t => {
  const {registerSandboxMachine} = await import("../src/providers/machine.ts");
  const f = await fixture(t,25,rentedCredentials()); const sandbox = await f.create(); await f.provider.beforeRepo!(sandbox.id);
  const service = credentialService(f);
  const initial = await service.startTask({title:"Starting task",brief:"Check tools",role:"custom",runner:"boat"});
  f.store.update(initial.id,{sandboxProvider:"scaleway",sandboxId:sandbox.id,repo:"acme/web",status:"starting"});
  f.store.macLeases.attach(f.store.macLeases.held(sandbox.id)[0]!.id,initial.id,1,1024);
  let registration: any; const values = new Map();
  const bb = {experimental_machines:{register:(value:unknown)=>{registration=value;},bootstrap:async()=>{throw new Error("test enrollment failure");}},experimental_environments:{register:()=>{}},storage:{kv:{get:async(key:string)=>values.get(key),set:async(key:string,value:unknown)=>{values.set(key,value);}}}};
  registerSandboxMachine(bb as never,f.provider,{service,settings:async()=>defaultSettings(),availability:async()=>({status:"available"})});
  const result = await registration.create({inputs:{sandboxId:sandbox.id,taskId:initial.id},key:"test",checkpoint:async()=>{},report:{step:()=>{},log:()=>{}},signal:new AbortController().signal});
  assert.equal(result.status,"failed");
  assert.ok(f.ssh.some(request=>request.command.some(line=>line.includes("auth logout"))));
  assert.equal((await f.keys.records())[0]!.credentialDeliveryAttempted,false);
  f.store.update(initial.id,{status:"running"});
  let cleaned = false;
  await service.cleanupFailedMachineBootstrap(sandbox.id,async()=>{cleaned=true;},initial.id);
  assert.equal(cleaned,false);
});

test("cleanup failure persists a billing notice, tells attached threads once, and clears after SSH recovery", async t => {
  const f = await fixture(t,26,rentedCredentials()); const sandbox = await f.create(); await f.provider.beforeRepo!(sandbox.id);
  const told:{thread:string;text:string}[]=[];let changed=0;
  const service = new BoatService(createProviderRegistry([createBoatProvider(new FakeBoat() as never),f.provider]),f.store,{settings:async()=>defaultSettings(),lifecycle:new AbortController().signal,changed:()=>{changed++;},tell:async(thread,text)=>{told.push({thread,text});},notify:async()=>{},log:{info:()=>{},warn:()=>{}}});
  for(const thread of ["test_owner_thread",null]) {
    const initial = await service.startTask({title:"Finished task",brief:"Check tools",role:"custom",runner:"boat"});
    f.store.update(initial.id,{status:"done",sandboxProvider:"scaleway",sandboxId:sandbox.id,orchestratorThreadId:thread});
    f.store.macLeases.attach(f.store.macLeases.held(sandbox.id)[0]!.id,initial.id,1,1024);
  }
  const lease = f.store.macLeases.held()[0]!;
  f.store.macLeases.warn(lease.id,Date.now(),false,"Earlier idle notice"); // Must not suppress the new credential alert.
  f.sshExit(255); changed=0;
  for(let n=0;n<3;n++)await service.processMacLeases();
  const saved = f.store.macLeases.held()[0]!;
  assert.equal(told.length,1); assert.equal(told[0]!.thread,"test_owner_thread");
  assert.equal(told[0]!.text,saved.noticeText);assert.ok(changed>0);
  assert.match(told[0]!.text,/Ask the owner/);assert.doesNotMatch(told[0]!.text,/Delete without verified cleanup|--without-verified-cleanup|--confirm-revoke/);
  for(const words of [/keeps billing/,/retry cleanup once SSH works/,/console.scaleway.com.*Apple silicon.*Delete/,/Revoke or rotate the GitHub token/])assert.match(saved.noticeText!,words);
  assert.ok(!f.calls.some(call=>call.method==="DELETE"));
  const runtime={service,projects:{list:()=>[]},setup:null} as unknown as import("../src/runtime.ts").Runtime;
  const handlers=providerHandlers(runtime);
  assert.equal((await handlers.macUsage()).notices?.[0]!.text,saved.noticeText);
  assert.ok((await handlers.sandboxProviders()).providers.find(row=>row.id==="scaleway")!.releaseNotice!.includes(saved.noticeText!));
  const {providerStates}=await import("../src/provider-status.ts");
  const states=await providerStates({registry:service.sandboxProviders,projects:()=>[],machines:()=>new Set(),boatSetup:null,instabox:null});
  assert.ok(states.find(row=>row.id==="scaleway")!.problem!.includes(saved.noticeText!));
  assert.ok(f.store.sandboxTasks(sandbox.id).every(task=>f.store.events(task.id).some(event=>event.kind==="credential-cleanup")));
  await service.processMacLeases(Date.now()+86400_000);assert.equal(told.length,2,"one daily reminder");
  f.sshExit(0);await service.processMacLeases();
  assert.equal(f.store.macLeases.held().length,0);assert.equal((await handlers.macUsage()).notices!.length,1);assert.equal((await handlers.macUsage()).notices![0]!.tokenRevocation,true);
});
test("a setup failure with no delivered credentials skips a transient cleanup GET and schedules deletion",async t=>{
  const f=await fixture(t,1,rentedCredentials());f.failSetup();
  f.onSsh(async request=>{if(request.stdin===BOOTSTRAP)f.failNextServerGets(1);});
  await assert.rejects(f.create(),error=>{assert.match(String(error),/Deletion is scheduled/);assert.doesNotMatch(String(error),/credential removal/);return true;});
  assert.ok(f.calls.some(call=>call.method==="PATCH"&&call.body.schedule_deletion));
  assert.equal(f.remainingGetFailures(),1,"failure path did not GET before its scheduling PATCH");
});
async function failingMachine(f: Awaited<ReturnType<typeof fixture>>, service: BoatService, bootstrap: () => Promise<never>) {
  const {registerSandboxMachine}=await import("../src/providers/machine.ts");let registration:any;const values=new Map();
  const bb={experimental_machines:{register:(value:unknown)=>{registration=value;},bootstrap},experimental_environments:{register:()=>{}},storage:{kv:{get:async(key:string)=>values.get(key),set:async(key:string,value:unknown)=>{values.set(key,value);}}},log:{warn:()=>{}}};
  registerSandboxMachine(bb as never,f.provider,{service,settings:async()=>defaultSettings(),availability:async()=>({status:"available"})});return registration;
}
test("create and resume preserve original enrollment errors even when cleanup fails",async t=>{
  const f=await fixture(t,25,rentedCredentials());const sandbox=await f.create();await f.provider.beforeRepo!(sandbox.id);const service=credentialService(f);
  const original=new Error("test original enrollment failure");
  const registration=await failingMachine(f,service,async()=>{f.sshExit(255);throw original;});const report={step:()=>{},log:()=>{}};
  const result=await registration.create({inputs:{sandboxId:sandbox.id},key:"test",checkpoint:async()=>{},report,signal:new AbortController().signal});
  assert.equal(result.status,"failed");assert.equal(result.message,original.message);
  f.sshExit(0);
  await assert.rejects(registration.resume({resource:{sandboxId:sandbox.id,key:"test"},report,signal:new AbortController().signal}),error=>error===original);
});
test("failed enrollment of the only held task leaves local logins untouched",async t=>{
  const f=await fixture(t);const sandbox=await f.create();
  await f.provider.assertTaskReady!({agent:"codex",repos:[],sandboxId:sandbox.id}); // Observed a local login; the plugin delivered none.
  const service=credentialService(f);const initial=await service.startTask({title:"Held local login",brief:"Check tools",role:"custom",runner:"boat"});
  f.store.update(initial.id,{status:"starting",sandboxProvider:"scaleway",sandboxId:sandbox.id});
  const registration=await failingMachine(f,service,async()=>{throw new Error("test enrollment failure");});
  const result=await registration.create({inputs:{sandboxId:sandbox.id,taskId:initial.id},key:"test",checkpoint:async()=>{},report:{step:()=>{},log:()=>{}},signal:new AbortController().signal});
  assert.equal(result.status,"failed");assert.ok(!f.ssh.some(request=>request.command.some(line=>line.includes("auth logout")||line.includes("codex logout"))));
  assert.equal((await f.keys.records())[0]!.localLoginsObserved,true);
});
test("bootstrap cleanup of a delivered GitHub token does not log out local agents",async t=>{
  const f=await fixture(t,25,rentedCredentials(false));const sandbox=await f.create();
  await f.provider.beforeRepo!(sandbox.id);
  await f.provider.assertTaskReady!({agent:"codex",repos:[],sandboxId:sandbox.id});
  await f.provider.machineHooks!({warn:()=>{},debug:()=>{}}).bootstrapFailed!(sandbox.id);
  const cleanup=f.ssh.at(-1)!.command.join(" ");assert.match(cleanup,/gh auth logout/);assert.doesNotMatch(cleanup,/claude auth logout|codex logout/);
  assert.equal((await f.keys.records())[0]!.localLoginsObserved,true);assert.equal((await f.keys.records())[0]!.pluginGithubAttempted,false);
});
test("slow failed-bootstrap cleanup releases the placement lock while marking the Mac busy",async t=>{
  const f=await fixture(t);const sandbox=await f.create();const service=credentialService(f);
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
  const cleanup=service.cleanupFailedMachineBootstrap(sandbox.id,async()=>{entered();await gate;});await started;
  try{
    assert.equal(service.holdsSandbox(sandbox.id),true);
    const free=(service as unknown as {withMacLock<T>(fn:()=>Promise<T>):Promise<T>}).withMacLock(async()=>"free");
    assert.equal(await Promise.race([free,new Promise(resolve=>setTimeout(()=>resolve("blocked"),300))]),"free");
    await assert.rejects(service.sandboxAction(sandbox.id,"resume",3600),{code:"sandbox_busy"});
    await service.processMacLeases();assert.equal(f.servers().length,1);
  }finally{release();await cleanup;}
  assert.equal(service.holdsSandbox(sandbox.id),false);
});

test("secret Settings description and agent checklist expose the credential risks and docs link",async t=>{
  const {CREDENTIAL_RISKS_URL}=await import("../credential-warnings.ts");
  assert.match(SECRET_SETTINGS.rentedMachineGithubToken.description,/Shared by rented Macs/);
  assert.match(SECRET_SETTINGS.rentedMachineGithubToken.description,/Logout does not revoke/);
  assert.match(SECRET_SETTINGS.rentedMachineGithubToken.description,/dedicated, narrowly scoped token/);
  assert.match(SECRET_SETTINGS.rentedMachineGithubToken.description,/rotate it after any doubt/);
  assert.ok(SECRET_SETTINGS.rentedMachineGithubToken.description.includes(CREDENTIAL_RISKS_URL));
  const f=await fixture(t,25,rentedCredentials());const step=(await f.provider.presentation!()).steps.find(step=>step.id==="agent-route")!;
  assert.equal(step.docsUrl,CREDENTIAL_RISKS_URL);assert.match(step.detail,/Any process on the Mac can use your pooled AI quota until bb removes/);
});

test("cleanup bypass and reminder dismissal are absent from RPC, CLI and native tools",async t=>{
  const {createTestHost}=await import("./fakes.ts");const {buildCli}=await import("../src/cli.ts");const {registerRpc}=await import("../src/rpc.ts");const {registerTools}=await import("../src/tools.ts");
  const f=await fixture(t,26,rentedCredentials());const sandbox=await f.create();await f.provider.beforeRepo!(sandbox.id);f.sshExit(255);
  const service=credentialService(f);const {bb,harness}=await createTestHost({pluginId:"boat",settings:{boatPath:(await import("node:url")).fileURLToPath(new URL("../src/providers/boat/fixtures/fake-boat.mjs",import.meta.url))}});t.after(()=>harness.lifecycle.dispose());
  const runtime={bb,service,projects:{list:()=>[]},projectForThread:async()=>null,changed:()=>{},setup:null} as unknown as import("../src/runtime.ts").Runtime;
  registerRpc(runtime);bb.cli.register(buildCli(runtime));registerTools(runtime);
  for(const method of ["dismissCredentialNotice","credentialOwnerApproval"])await assert.rejects(harness.callRpc(method,{id:sandbox.id,confirmedTokenAction:true},{experimental_caller:{kind:"client"}}));
  await assert.rejects(harness.callRpc("sandboxAction",{id:sandbox.id,action:"delete",withoutVerifiedCleanup:true,confirmRevokeGithubToken:true},{experimental_caller:{kind:"client"}}));
  const cli=await harness.runCli(["sandbox","delete",sandbox.id,"--without-verified-cleanup","--confirm-revoke-github-token"]);assert.notEqual(cli.exitCode,0);
  for(const name of ["boat_delete_without_verified_cleanup","boat_dismiss_credential_notice"])await assert.rejects(harness.callAgentTool(name,{id:sandbox.id}));
  await assert.rejects(service.sandboxAction(sandbox.id,"delete",0,undefined,{withoutVerifiedCleanup:true,confirmRevokeGithubToken:true} as never),{code:"credential_cleanup_failed"});
  assert.equal("deleteWithoutVerifiedCleanup" in f.provider,false);assert.equal("dismissCredentialNotice" in service,false);
  assert.equal(f.servers().length,1);assert.ok(!f.calls.some(call=>call.method==="DELETE"));
});

test("manual console deletion closes the lease on reconcile but token reminders last until delivered expiry",async t=>{
  const f=await fixture(t,26,rentedCredentials());const sandbox=await f.create();await f.provider.beforeRepo!(sandbox.id);
  let changed=0;const service=credentialService(f,[],()=>{changed++;});f.sshExit(255);await service.processMacLeases();
  const lease=f.store.macLeases.held()[0]!;const notice=f.store.macLeases.credentialNotices()[0]!;
  assert.ok(notice.expiresAt);assert.match(notice.text,/Scaleway console/);assert.match(notice.text,/Revoke or rotate/);
  f.servers().splice(0);await service.processMacLeases();
  assert.equal(f.store.macLeases.held().length,0);assert.equal(f.store.macLeases.list()[0]!.endReason,"deleted");
  assert.equal(f.store.macLeases.credentialNotices().length,1);assert.match(f.provider.releaseNotice!()!,/GitHub token revocation required/);
  const page=providerHandlers({service,projects:{list:()=>[]},setup:null} as unknown as import("../src/runtime.ts").Runtime);
  assert.equal((await page.macUsage()).notices![0]!.tokenRevocation,true);
  f.store.macLeases.clearNotice(lease.id);
  service.refreshCredentialNotices();changed=0;
  service.refreshCredentialNotices(Date.parse(notice.expiresAt!)-1);assert.equal(changed,0);
  service.refreshCredentialNotices(Date.parse(notice.expiresAt!));assert.equal(changed,1,"expiry invalidates open views even with no remaining lease");
  assert.equal(f.store.macLeases.credentialNotices(Date.parse(notice.expiresAt!)-1).length,1);
  assert.deepEqual(f.store.macLeases.credentialNotices(Date.parse(notice.expiresAt!)),[]);
});

test("manual deletion without an earlier cleanup failure still leaves a token reminder",async t=>{
  const f=await fixture(t,26,rentedCredentials());const sandbox=await f.create();await f.provider.beforeRepo!(sandbox.id);
  f.servers().splice(0);await credentialService(f).processMacLeases();
  assert.equal(f.store.macLeases.held().length,0);assert.equal(f.store.macLeases.credentialNotices().length,1);
});

test("expiry is durable before SSH, including failed delivery; a database failure prevents stdin",async t=>{
  const f=await fixture(t,26,rentedCredentials());const sandbox=await f.create();
  const lease=f.store.macLeases.held()[0]!;
  f.onSsh(async request=>{if(request.stdin?.includes("fake_mac_github_token")){assert.ok(f.store.macLeases.hasGithubDeliveryRecord(lease.id));f.sshExit(255);}});
  await assert.rejects(f.provider.beforeRepo!(sandbox.id));
  await assert.rejects(f.provider.delete(sandbox.id));
  assert.ok(f.store.macLeases.credentialNotices()[0]!.expiresAt);
  const other=await fixture(t,26,rentedCredentials());const mac=await other.create();const before=other.ssh.length;
  other.store.macLeases.recordGithubDelivery=()=>{throw new Error("test database unavailable");};
  await assert.rejects(other.provider.beforeRepo!(mac.id));assert.equal(other.ssh.length,before);
});

test("held local logins never create a permanent rented-token reminder and recover after cleanup",async t=>{
  const f=await fixture(t,26);const mac=await f.create();
  await f.provider.assertTaskReady!({agent:"codex",repos:["acme/web"],sandboxId:mac.id});
  f.sshExit(255);
  await assert.rejects(f.provider.delete(mac.id));
  assert.deepEqual(f.store.macLeases.credentialNotices(),[]);
  assert.match(f.store.macLeases.held()[0]!.noticeText!,/Local logins.*Keychain/);
  await credentialService(f).processMacLeases();
  assert.deepEqual(f.store.macLeases.credentialNotices(),[]);
  assert.match(f.provider.releaseNotice!()!,/Local logins/);
  f.sshExit(0);await f.provider.scheduleLeaseRelease!(mac.id,f.store.macLeases.held()[0]!.paidUntil);
  assert.equal(f.store.macLeases.held().length,1);assert.equal(f.provider.releaseNotice!(),null);
  await f.provider.delete(mac.id);
  const absent=await fixture(t,26);const other=await absent.create();
  await absent.provider.assertTaskReady!({agent:"codex",repos:["acme/web"],sandboxId:other.id});
  absent.servers().splice(0);await credentialService(absent).processMacLeases();
  assert.deepEqual(absent.store.macLeases.credentialNotices(),[]);
});


test("rental choices check Scaleway stock and quota separately from presentation models", async t => {
  const f = await fixture(t);
  f.stock(false);
  assert.equal((await f.provider.macModels!()).length, 1, "catalog still describes the model");
  const rentalModels = await f.provider.macRentalModels!();
  assert.match(rentalModels[0]!.unavailableReason!, /stock/);
  f.stock(true); f.setQuota(0);
  assert.match((await f.provider.macRentalModels!())[0]!.unavailableReason!, /quota/);
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});

test("Scaleway allocation honors the explicitly approved model instead of the first model", async t => {
  const f = await fixture(t); f.secondModel();
  const model = (await f.provider.macModels!()).find(model => model.id === "M2-M")!;
  await f.provider.allocate!({name:"fake selection",type:"default",system:"macos",ttlSeconds:3600,gitGuard:true,
    macCostLimit:{...model,modelLabel:model.label,provider:"scaleway",model:model.id,expiresAt:new Date(Date.now()+600000).toISOString()}});
  assert.equal(f.calls.find(call => call.method === "POST" && call.path.endsWith("/servers"))!.body.type, "M2-M");
});
