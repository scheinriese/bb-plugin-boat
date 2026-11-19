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
async function fixture(t: { after(fn: () => unknown): void }, ageHours = 25) {
  const dir = await mkdtemp(join(tmpdir(), "scaleway-test-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = memoryStore(), keys = new ScalewayKeys(dir);
  const calls: { method: string; path: string; body: any }[] = [], ssh: SshRequest[] = [];
  let servers: any[] = [], quota = 2, available = true, beta = false, failSetup = false, ambiguousCreate = false, ambiguousAbsent = false, failList = false, failSchedule = false, noAgentLogin = false, noGithubLogin = false, poll = 0;
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
      const allowed=["name","project_id","type","os_id","enable_vpc","commitment_type","public_bandwidth_bps","runner_configuration","applied_runner_configurations","enable_kext"];
      if(Object.keys(body).some(key=>!allowed.includes(key)) || body.commitment_type!=="duration_24h") return new Response("invalid create fields",{status:400});
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
    if (method === "GET" && servers[0]) { poll++; if (poll >= 2) Object.assign(servers[0], { status: "ready", delivered: true }); return json(servers[0]); }
    return new Response(JSON.stringify({ message: secret }), {status:404});
  }) as typeof fetch });
  const provider = createScalewayProvider({ api, keys, ledger: store.macLeases, pollMs: 1, ssh: async (_target, request) => {
    ssh.push(request); request.onOutput?.("bb installed");
    return { exitCode: (failSetup && request.stdin === BOOTSTRAP) || (noAgentLogin && /codex.*login status|claude.*auth status/.test(JSON.stringify(request.command))) || (noGithubLogin && /gh.*auth status/.test(JSON.stringify(request.command))) ? 1 : 0, stdout: "ok", stderr: "" };
  } });
  const create = () => provider.create({ name: "bb-task", type: "default", system: "macos", ttlSeconds: 3600, gitGuard: true });
  return { api, provider, store, keys, calls, ssh, create, setQuota: (n:number) => { quota=n; }, stock: (value:boolean) => { available=value; }, beta: () => { beta=true; }, failSetup: () => { failSetup=true; }, ambiguousCreate: () => { ambiguousCreate=true; }, ambiguousAbsent:()=>{ambiguousAbsent=true;}, listFailure:(value:boolean)=>{failList=value;}, scheduleFailure:()=>{failSchedule=true;}, noAgentLogin:()=>{noAgentLogin=true;}, noGithubLogin:()=>{noGithubLogin=true;}, servers: () => servers };
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
    const p:SandboxProvider={...inert,idPattern:new RegExp(`^${id}_`),displayName:id==="instabox"?"Instabox":"Scaleway",caps:{...inert.caps,os:"macos",bbEnrollment:true,headlessAgentRunner:id!=="scaleway"},sizes:[{id:"default",label:"Standard",cpus:id==="scaleway"?2:4,memoryGb:id==="scaleway"?4:8}],machine:{id:`${id}-sandbox`} as never,exec:async()=>({exitCode:0,stdout:"",stderr:""}),findInfo:async sid=>({id:sid,state:"idle",system:"macos"} as never),macModels:async()=>[{minimumHours:24,id:"M1-M",label:"M1-M",cpus:8,memoryMiB:16384,minimumCost:10,hourPrice:10/24,currency:"EUR"}],list:async()=>{if(options.listFail===id)throw new Error("List unavailable");return options.held===id?[{id:`${id}_held`,state:"idle"} as never]:[];},capacity:async()=>({canStart:true,activeSandboxes:0,maxActiveSandboxes:4} as never),create:async()=>{creates.push(id);if(options.fail===id)throw Object.assign(new Error("No Mac free"),{code:options.ambiguous?"creation_unknown":"at_capacity"}); const start=Date.now();store.macLeases.record({id:`${id}:lease`,provider:id,machineId:`${id}_new`,size:"M1-M",startedAt:new Date(start).toISOString(),paidUntil:new Date(start+86400000).toISOString(),minimumCost:10,hourPrice:10/24,currency:"EUR",cpus:8,memoryMiB:16384});return {id:`${id}_new`,state:"idle",system:"macos"} as never;},info:async id=>({id,state:"idle",system:"macos"} as never)};
    return p;
  });
  const registry=createProviderRegistry([createBoatProvider(boat as never),...providers],{isEnabled:p=>p.id!==options.disabled});
  const service=new BoatService(registry,store,{projects:()=>[{id:"mac",name:"Mac app",repos:[],machineType:null,sandboxProvider:preferred,sandboxSystem:"macos"}],settings:async()=>defaultSettings({maxActiveSandboxes:0,workerMode:"chat",adhocWorkerMode:"chat",evidenceUploader:""}),chat,lifecycle:new AbortController().signal,changed:()=>{},notify:async()=>{},log:{info:()=>{},warn:()=>{}}});
  const initial=await service.startTask({title:"Mac",role:"custom",brief:"Check tools",provider:"codex",runner:"boat"});
  const task=store.update(initial.id,{sandboxProvider:preferred,sandboxSystem:"macos",runner:"chat",sandboxId:null})!;
  if(options.held)store.macLeases.record({id:`${options.held}:held`,provider:options.held,machineId:`${options.held}_held`,size:"M1-M",startedAt:new Date().toISOString(),paidUntil:new Date(Date.now()+86400000).toISOString(),minimumCost:10,hourPrice:10/24,currency:"EUR",cpus:8,memoryMiB:16384});
  const seam=service as unknown as {createMacFor(task:import("../src/store.ts").Task,type:"default",signal:AbortSignal):Promise<{id:string}>;heldMacFor(task:import("../src/store.ts").Task,type:"default",parent:null):Promise<string|null>};
  return {store,creates,task,seam,service,chat,providers};
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
  assert.equal(row.apiKey?.setting,"Scaleway secret key");assert.equal(row.systems[0]?.ready,true);assert.equal(view.options.find(o=>o.provider==="scaleway"),undefined);assert.equal(providerGlyph(row),"box");
  assert.deepEqual(view.options.find(o=>o.provider==="scaleway-macos"),{provider:"scaleway-macos",label:"Scaleway · Mac",disabledReason:null});
  const f=await routing("scaleway",{held:"scaleway"});assert.equal(macRunsOn(f.store.macLeases,"scaleway_held",[])?.label,"Scaleway");
});

for (const preferred of ["instabox", "scaleway"]) for (const unavailable of ["disabled", "fail"] as const) test(`dispatched Mac task falls back from ${preferred} when ${unavailable} through provider capabilities`,async()=>{
  const f=await routing(preferred,{[unavailable]:preferred});
  const chosen=preferred==="instabox"?"scaleway":"instabox";
  const task=await f.service.startTask({title:"Mac task",brief:"Check Xcode",role:"custom",runner:"chat",project:macTaskProject()});
  assert.equal(task.status,"running",task.error??""); assert.equal(task.sandboxProvider,chosen);
  assert.equal(task.sandboxSystem,"macos"); assert.equal(task.sandboxId,`${chosen}_new`);
  assert.equal(f.chat.spawns.at(-1)?.where.kind,"machine");
  assert.equal((await f.service.sandboxProvider(task).info(task.sandboxId!)).system,"macos");
  const lease=f.store.macLeases.held(task.sandboxId!)[0]!;
  const reservation=f.store.macLeases.tasks(lease.id).find(t=>t.taskId===task.id)!;
  assert.deepEqual([reservation.cpus,reservation.memoryMiB],chosen==="scaleway"?[2,4096]:[4,8192]);
  assert.ok(f.store.events(task.id).some(e=>/fallback/.test(e.text)));
  assert.deepEqual(f.creates,unavailable==="disabled"?[chosen]:[preferred,chosen]);
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
  await assert.rejects(f.provider.assertTaskReady!({agent:"codex",repos:["acme/private"]}),/will not rent/);
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
