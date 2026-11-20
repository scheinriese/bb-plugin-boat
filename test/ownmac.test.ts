import { footerOnCount } from "../web/own-mac-count.ts";
import { PLUGIN_SETTINGS, settingProblem } from "../src/settings.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import {
  createOwnMacProvider,
  type OwnMacConfig,
} from "../src/providers/ownmac/provider.ts";
import {
  AVAILABILITY_SCRIPT,
  availability,
  parseReading,
  refusal,
  type Reading,
} from "../src/providers/ownmac/probe.ts";
import { ownMacConfigSchema, sshAliasSchema } from "../contract-providers.ts";
import {
  createCredentialSource,
  CREDENTIAL_CLEANUP_SCRIPT,
  GITHUB_LOGIN_SCRIPT,
  type CredentialSource,
} from "../src/credentials.ts";
import { createProviderRegistry } from "../src/providers/registry.ts";
import { createBoatProvider } from "../src/providers/boat/provider.ts";
import type { BoatApi } from "../src/providers/boat/api.ts";
import { FakeBoat, FakeChat, defaultSettings, memoryStore } from "./fakes.ts";
import { BoatService } from "../src/service.ts";
import { providerHandlers, runsOnOf } from "../src/rpc-providers.ts";
import type { Runtime } from "../src/runtime.ts";
import type { SshRequest } from "../src/providers/scaleway/ssh.ts";
import { normalizeProject, toOrchestratorProject } from "../src/projects.ts";
import { runsOnLine } from "../web/providers-logic.ts";

const local = { hardware: "a".repeat(64), user: "fake-owner", uid: 501 };
const reading: Reading = {
  hardware: local.hardware,
  user: "fake-worker",
  uid: 502,
  admin: false,
  vm:false,
  ac: true,
  session: true,
  memoryMiB: 32768,
  freeMiB: 24576,
  cpus: 8,
  load: 0.5,
};
const output = (value: Reading) =>
  Object.entries(value)
    .map(
      ([key, value]) =>
        `${key}=${value===null?"unknown":typeof value === "boolean" ? (value ? 1 : 0) : value}`,
    )
    .join("\n");
const input = {
  name: "fake task",
  type: "small" as const,
  system: "macos" as const,
  ttlSeconds: 0,
  gitGuard: true,
};
async function fixture(source?: CredentialSource) {
  const data = new Map<string, unknown>();
  const kv = {
    get: async (key: string) => data.get(key),
    set: async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    },
  } as PluginKvStorage;
  const config: OwnMacConfig = {
    ownMacIsolation:"vm",
    ownMacAlias: "fake-mac",
    ownMacEnabled: true,
    ownMacPaused: false,
    ownMacMaxTasks: 1,
  };
  data.set("ownMacSetupV1",{step:7,testedAlias:config.ownMacAlias,target:{alias:config.ownMacAlias,hardware:reading.hardware,user:reading.user,uid:reading.uid,vm:reading.vm}});
  const calls: { alias: string; request: SshRequest }[] = [],
    cleaned: string[] = [];
  let current = { ...reading },
    fail = false,
    cleanupFail = false,
    clock = 0;
  const boat = new FakeBoat();
  const credentials: CredentialSource = source ?? {
    githubConfigured: async () => false,
    agentAvailable: async () => true,
    assertGithubAccess: async () => {},
    assertReady: async () => {},
    ensureGithub: async () => null,
    cleanupGithub: async () => {},
    cleanup: async (id) => {
      if (cleanupFail) throw Error("fake cleanup failed");
      cleaned.push(id);
    },
  };
  const options = {
    config: async () => config,
    kv,
    credentials,
    now: () => clock,
    local: async () => local,
    ssh: async (alias: string, request: SshRequest) => {
      calls.push({ alias, request });
      if (fail) return { exitCode: 255, stdout: "", stderr: "fake offline" };
      if (request.command.at(-1) === AVAILABILITY_SCRIPT)
        return { exitCode: 0, stdout: output(current), stderr: "" };
      if (request.stdin === undefined)
        return boat.exec("fake", request.command.at(-1)!);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const provider = await createOwnMacProvider(options);
  return {
    provider,
    config,
    calls,
    cleaned,
    kv,
    options,
    set: (patch: Partial<Reading>) => {
      current = { ...current, ...patch };
    },
    offline: (value = true) => {
      fail = value;
    },
    cleanupFail: (value = true) => {
      cleanupFail = value;
    },
    tick: () => {
      clock += 45001;
    },
  };
}
for (const [name, remote, expected] of [
  [
    "same machine and user",
    { ...reading, user: local.user, uid: local.uid },
    true,
  ],
  ["same name", { ...reading, user: local.user }, true],
  ["same uid", { ...reading, uid: local.uid }, true],
  ["separate user", reading, false],
  [
    "VM",
    { ...reading, hardware: "b".repeat(64), user: local.user, uid: local.uid },
    false,
  ],
  ["administrator", { ...reading, admin: true }, true],
] as const)
  test(`Your Mac identity guard: ${name}`, () =>
    assert.equal(refusal(remote, local) !== null, expected));
for (const [state, patch] of [
  ["Available", {}],
  ["On battery", { ac: false }],
  ["No logged-in session", { session: false }],
  ["Not enough free memory", { freeMiB: 1024 }],
  ["Not enough free CPU", { load: 9 }],
] as const)
  test(`Your Mac probe parses ${state}`, () => {
    const parsed = parseReading(output({ ...reading, ...patch }));
    assert.equal(availability(parsed, local, 0, 1), state);
  });
test("malformed and missing probe fields fail closed", () => {
  for (const value of [
    "",
    output(reading).replace("ac=1", "ac=unknown"),
    output(reading).replace("freeMiB=24576", "freeMiB=NaN"),
    output(reading).replace(/hardware=.*/, "hardware="),
  ])
    assert.throws(() => parseReading(value));
});
for (const alias of ["fake-mac", "fake_vm2", ""])
  test(`SSH alias accepts ${alias || "empty setup"}`, () =>
    assert.equal(sshAliasSchema.safeParse(alias).success, true));
for (const alias of [
  "/tmp/fake-key",
  "~/.ssh/fake",
  "fake mac",
  "-fake",
  "fake@host",
  "host.example",
  "fake\nmac",
  "fake;id",
  "fake/../key",
])
  test(`SSH alias rejects ${JSON.stringify(alias)}`, () =>
    assert.equal(sshAliasSchema.safeParse(alias).success, false));
test("task limits validate at the settings boundary", () => {
  for (const max of [0, 1.5, 5, 17])
    assert.equal(
      ownMacConfigSchema.safeParse({
        ownMacEnabled: true,
        ownMacPaused: false,
        ownMacAlias: "fake",
        ownMacMaxTasks: max,
      }).success,
      false,
    );
});
test("availability caches one cheap SSH probe for 45 seconds", async () => {
  const env = await fixture();
  await env.provider.ownMacStatus!();
  await env.provider.ownMacStatus!();
  assert.equal(env.calls.length, 1);
  env.tick();
  await env.provider.ownMacStatus!();
  assert.equal(env.calls.length, 2);
  env.set({ admin: true });
  assert.match(
    (await env.provider.ownMacStatus!(true)).status,
    /admin user/,
  );
});
test("disabled, unset and paused Macs do not use SSH; network failure is unavailable", async () => {
  const env = await fixture();
  env.config.ownMacEnabled = false;
  assert.equal((await env.provider.ownMacStatus!()).status, "Off");
  env.config.ownMacEnabled = true;
  env.config.ownMacAlias = "";
  assert.equal((await env.provider.ownMacStatus!()).status, "Not set up");
  const paused=await fixture();
  paused.config.ownMacPaused = true;
  assert.equal((await paused.provider.ownMacStatus!()).status, "Paused");
  assert.equal(env.calls.length, 0);
  assert.equal(paused.calls.length,0);
  paused.config.ownMacPaused = false;
  paused.offline();
  assert.equal(
    (await paused.provider.ownMacStatus!()).status,
    "Asleep or unreachable",
  );
});
test("admission checks identity again even with a warm available cache", async () => {
  const env = await fixture();
  await env.provider.ownMacStatus!();
  env.set({ user: local.user, uid: local.uid });
  await assert.rejects(env.provider.create(input), /Test connection again/);
  assert.equal(env.calls.length, 2);
});
test("per-task homes, persisted targets and capacity survive restart", async () => {
  const env = await fixture();
  env.config.ownMacMaxTasks = 2;
  const first = await env.provider.create(input),
    second = await env.provider.create(input);
  assert.notEqual(first.id, second.id);
  await assert.rejects(env.provider.create(input), /task limit/);
  await env.provider.exec(first.id, "true");
  assert.match(
    env.calls.at(-1)!.request.command.at(-1)!,
    new RegExp(`HOME=.*${first.id}`),
  );
  const restarted = await createOwnMacProvider(env.options);
  assert.equal((await restarted.ownMacStatus!()).running, 2);
  env.config.ownMacAlias = "fake-new-alias";
  await restarted.closeTaskCredentials!(first.id);
  assert.equal(env.calls.at(-1)!.alias, "fake-mac");
  assert.deepEqual(env.cleaned, [first.id]);
  assert.equal((await restarted.ownMacStatus!()).running, 1);
});
test("cleanup still works when paused and disabled; failed cleanup stays visible and retries", async () => {
  const env = await fixture();
  const task = await env.provider.create(input);
  env.config.ownMacEnabled = false;
  env.config.ownMacPaused = true;
  env.cleanupFail();
  await assert.rejects(
    env.provider.closeTaskCredentials!(task.id),
    /could not be verified/,
  );
  assert.match(env.provider.releaseNotice!()!, /Login cleanup/);
  env.cleanupFail(false);
  await env.provider.closeTaskCredentials!(task.id);
  assert.equal(env.provider.releaseNotice!(), null);
});
test("cleanup refuses changed alias identity before touching credentials", async () => {
  const env = await fixture();
  const task = await env.provider.create(input);
  env.set({ hardware: "c".repeat(64) });
  await assert.rejects(
    env.provider.closeTaskCredentials!(task.id),
    /could not be verified/,
  );
  assert.equal(env.cleaned.length, 0);
});
test("unremoved bb machine keeps a proxy cleanup warning", async () => {
  const env = await fixture();
  const task = await env.provider.create(input);
  await assert.rejects(
    env.provider.closeTaskCredentials!(task.id, undefined, false),
    /revoke its agent proxy/,
  );
  assert.match(env.provider.releaseNotice!()!, /proxy/);
  const state=await env.provider.ownMacStatus!();
  assert.equal(state.running, 0);
  assert.equal(state.code,"cleanup");
  assert.deepEqual(env.cleaned,[task.id]);
});
test("Your Mac uses unchanged stdin delivery and verified cleanup scripts", async () => {
  const fakeToken = "fake_github_token";
  const source = createCredentialSource({
    githubToken: async () => fakeToken,
    agentAvailable: async () => true,
    fetch: async () =>
      new Response("{}", {
        headers: {
          "github-authentication-token-expiration": "2030-01-01T00:00:00Z",
        },
      }),
  });
  const env = await fixture(source);
  const task = await env.provider.create(input);
  await env.provider.beforeRepo!(task.id);
  const delivery = env.calls.find(
    (call) => call.request.stdin === `${fakeToken}\n`,
  )!;
  assert.ok(delivery);
  assert.ok(!JSON.stringify(delivery.request.command).includes(fakeToken));
  assert.ok(delivery.request.command.at(-1)!.includes(GITHUB_LOGIN_SCRIPT));
  await env.provider.closeTaskCredentials!(task.id);
  assert.ok(
    env.calls.some((call) =>
      call.request.command.at(-1)?.includes(CREDENTIAL_CLEANUP_SCRIPT),
    ),
  );
});
test("Your Mac reports zero rent without any lease or lease-days", async () => {
  const env = await fixture();
  const usage = await env.provider.usage("fake");
  assert.equal(usage.dollars, 0);
  assert.equal(await env.provider.pricing!(), "$0 rent");
  assert.equal(
    runsOnLine(runsOnOf(env.provider, "small", "boat")),
    "Your Mac · VM · $0",
  );
});

async function routingFixture(monthly = false, rentalId="fake-rental") {
  const env = await fixture();
  const store = memoryStore(),
    boat = new FakeBoat(),
    chat = new FakeChat();
  const rental = {
    ...createBoatProvider(boat as unknown as BoatApi),
    id: rentalId,
    displayName: "Fake rental",
    caps: { ...env.provider.caps, headlessAgentRunner: true },
    idPattern: /^fake_rental_/,
    pricing: async () => "USD 10 minimum",
    macModels:async()=>[{id:"fake-m2",label:"Fake Mac M2",cpus:8,memoryMiB:32768,minimumCost:10,minimumHours:24,hourPrice:0.5,currency:"USD"}],
  };
  // Never allocate in this fixture: held leases must win, or cost consent stops it.
  rental.create = async () => {
    throw Error("unexpected new rental");
  };
  const monthlyProvider = {
    ...rental,
    id: "fake-monthly",
    displayName: "Fake monthly",
    idPattern: /^fake_monthly_/,
    macLeaseKind: "monthly" as const,
  };
  const registry = createProviderRegistry([
    createBoatProvider(new FakeBoat() as unknown as BoatApi),
    rental,
    ...(monthly ? [monthlyProvider] : []),
    env.provider,
  ]);
  let project = normalizeProject({
    id: "fake-mac-project",
    name: "Fake Mac",
    repos: [{ repo: "acme/fake", baseBranch: "main" }],
    sandboxProvider: "ownmac",
    sandboxSystem: "macos",
  });
  const told:{threadId:string;text:string}[]=[];
  let failNotice=false;
  const service = new BoatService(registry, store, {
    settings: async () => defaultSettings({ maxActiveSandboxes: 0 }),
    chat,
    tell:async(threadId,text)=>{if(failNotice){failNotice=false;throw Error("fake chat unavailable");}told.push({threadId,text});},
    lifecycle: new AbortController().signal,
    projects: () => [project],
    changed: () => {},
    notify: async () => {},
    log: { info: () => {}, warn: () => {} },
    connect: async () => ({ state: "ready", detail: "fake", fix: null }),
  });
  const start = (provider = "ownmac", system: "macos" | "linux" = "macos") => {
    project = normalizeProject(
      { ...project, sandboxProvider: provider, sandboxSystem: system },
      project,
    );
    return service.startTask({
      title: "Fake Mac task",
      role: "custom",
      brief: "Check fake tools",
      provider: "claude",
      runner: "chat",
      confirmUntrustedChat: [],
      sandboxSystem: system,
      project: { ...toOrchestratorProject(project), repos: [] },
    });
  };
  function held() {
    const at = Date.now();
    boat.addSandbox("fake_rental_1", "default", "idle");
    store.macLeases.record({
      id: "fake-lease",
      provider: rental.id,
      machineId: "fake_rental_1",
      size: "fake",
      startedAt: new Date(at).toISOString(),
      paidUntil: new Date(at + 86400000).toISOString(),
      minimumCost: 10,
      hourPrice: 0.5,
      currency: "USD",
      cpus: 8,
      memoryMiB: 32768,
    });
  }
  return { ...env, store, chat, service, start, held, rental, boat, told, failNextNotice:()=>{failNotice=true;} };
}
test("automatic Mac routing chooses Your Mac before a held rental", async () => {
  const env = await routingFixture();
  env.held();
  const task = await env.start("fake-rental");
  assert.equal(task.sandboxProvider, "ownmac");
  assert.equal(task.status, "running");
  assert.equal(env.store.macLeases.tasks("fake-lease").length, 0);
  assert.equal(env.store.macLeases.held().length, 1);
});
for (const state of ["paused", "battery", "full"] as const)
  test(`Mac routing falls back to held capacity when Your Mac is ${state}`, async () => {
    const env = await routingFixture();
    env.held();
    if (state === "paused") env.config.ownMacPaused = true;
    if (state === "battery") env.set({ ac: false });
    if (state === "full") await env.provider.create(input);
    const task = await env.start();
    assert.equal(task.sandboxProvider, "fake-rental");
    assert.equal(task.sandboxId, "fake_rental_1");
    assert.equal(task.status, "running");
  });
test("Your Mac fallback offers a rental estimate without silently renting", async () => {
  const env = await routingFixture();
  env.config.ownMacPaused = true;
  await assert.rejects(
    env.start(),
    /USD 10.00 minimum/,
  );
});
for (const status of ["done", "cancelled"] as const)
  test(`closing Your Mac as ${status} cleans credentials and removes its bb proxy machine`, async () => {
    const env = await routingFixture();
    const task = await env.start();
    assert.equal(task.status, "running");
    await env.service.closeTask(task.id, {
      status,
      discard: true,
      keepSandbox: true,
    });
    assert.deepEqual(env.cleaned, [task.sandboxId]);
    assert.deepEqual(env.chat.removed, [task.hostId]);
    assert.equal(env.store.get(task.id)!.status, status);
    assert.equal((await env.provider.ownMacStatus!()).running, 0);
  });
test("usage RPC includes Your Mac with zero rent and no lease-days", async () => {
  const env = await routingFixture();
  await env.start();
  const usage = await providerHandlers({
    service: env.service,
    bb: {},
  } as unknown as Runtime).macUsage();
  assert.equal(usage.ownMac!.rent, 0);
  assert.equal(usage.ownMac!.running, 1);
  assert.equal(usage.month.leaseDays, 0);
  assert.deepEqual(usage.held, []);
});

test("already rented monthly capacity wins before a held day lease", async () => {
  const env = await routingFixture(true);
  env.config.ownMacPaused = true;
  env.held();
  env.boat.addSandbox("fake_monthly_1", "default", "idle");
  const lease = env.store.macLeases.held()[0]!;
  env.store.macLeases.record({
    ...lease,
    id: "fake-monthly-lease",
    provider: "fake-monthly",
    machineId: "fake_monthly_1",
  });
  const task = await env.start("fake-rental");
  assert.equal(task.sandboxProvider, "fake-monthly");
  assert.equal(env.store.macLeases.tasks("fake-lease").length, 0);
});
test("Linux tasks leave Your Mac untouched", async () => {
  const env = await routingFixture();
  const task = await env.start("boat", "linux");
  assert.equal(task.sandboxProvider ?? "boat", "boat");
  assert.equal(task.status, "running");
  assert.equal(env.calls.length, 0);
});
test("closed task homes cannot receive credentials again", async () => {
  const env = await fixture();
  const task = await env.provider.create(input);
  await env.provider.closeTaskCredentials!(task.id);
  await assert.rejects(env.provider.refreshGithubLogin!(task.id), /closed/);
});
test("CPU and RAM reservations preserve headroom while starts are pending", async () => {
  const env = await fixture();
  env.config.ownMacMaxTasks = 4;
  env.set({ cpus: 4 });
  await env.provider.allocate!(input);
  await assert.rejects(env.provider.allocate!(input), /headroom/);
});

test("settings reject SSH paths, spaces and option-like aliases",()=>{
  for(const alias of ["/tmp/fake-key","fake mac","-fake"])
    assert.ok(settingProblem("ownMacAlias",PLUGIN_SETTINGS.ownMacAlias,alias));
  assert.equal(settingProblem("ownMacAlias",PLUGIN_SETTINGS.ownMacAlias,"fake-mac"),null);
});

test("VM detection permits admins only inside a VM; server's own login always refuses",async()=>{
  assert.equal(refusal({...reading,admin:true,vm:true},local),null);
  assert.match(refusal({...reading,admin:true,vm:false},local)!,/admin user/);
  assert.match(refusal({...reading,admin:true,vm:null},local)!,/admin user/);
  assert.match(refusal({...reading,user:local.user,uid:local.uid,admin:true,vm:true},local)!,/your own login/);
  const env=await fixture();env.set({vm:true,admin:true});assert.equal((await env.provider.testOwnMacConnection!()).code,"available");
});
test("6 GB is the admission threshold and session has priority over battery",async()=>{
  assert.equal(availability({...reading,freeMiB:6144},local,0,1),"Available");
  assert.equal(availability({...reading,freeMiB:6143},local,0,1),"Not enough free memory");
  assert.equal(availability({...reading,session:false,ac:false},local,0,1),"No logged-in session");
});
for(const patch of [{ac:false},{session:false}])test(`setup can finish while ${JSON.stringify(patch)}`,async()=>{
  const env=await fixture();env.config.ownMacEnabled=false;env.set(patch);
  const state=await env.provider.testOwnMacConnection!();assert.equal(state.tested,true);assert.equal(state.testResult!.ok,true);
  env.config.ownMacEnabled=true;const enabled=await env.provider.ownMacStatus!(true);assert.equal(enabled.code,patch.ac===false?"battery":"session");
  assert.equal(enabled.setupSteps,7);
});
test("battery, low memory and manual pause do not stop an admitted task",async()=>{
  const env=await fixture();const task=await env.provider.create(input);env.config.ownMacPaused=true;env.set({ac:false,session:false,freeMiB:1024});
  await env.provider.assertTaskReady!({agent:"claude",repos:[],sandboxId:task.id});await env.provider.resume(task.id,{ttlSeconds:0});
  assert.equal(env.cleaned.length,0);assert.ok(!(env.calls.some(call=>/shutdown|pmset .*sleep|kill /.test(call.request.command.join(" ")))));
});
test("failed cleanup automatically pauses admission; Check again is read-only",async()=>{
  const env=await fixture();const task=await env.provider.create(input);env.cleanupFail();await assert.rejects(env.provider.closeTaskCredentials!(task.id));
  assert.equal((await env.provider.ownMacStatus!()).code,"cleanup");await assert.rejects(env.provider.create(input),/Logins left behind/);
  const count=env.cleaned.length;const before=env.calls.length;const checked=await env.provider.checkOwnMacCleanup!();
  assert.equal(checked.cleanup!.failed,false);assert.equal(env.cleaned.length,count);
  assert.ok(env.calls.slice(before).every(call=>!call.request.command.join(" ").includes("rm -")));
});
test("a changed Mac is skipped and paid capacity runs the task",async()=>{
  const env=await routingFixture();env.held();env.set({user:local.user,uid:local.uid});const task=await env.start();
  assert.equal(task.sandboxProvider,"fake-rental");const notice=await env.service.ownMacNotice(task);assert.equal(notice!.reason,"can't be used");assert.equal(notice!.fallback!.provider,"fake-rental");assert.equal(env.service.publicStatus(task).needsYou,false);
});
test("waiting for Your Mac resumes only a task with no prior execution",async()=>{
  const env=await routingFixture();env.config.ownMacPaused=true;await assert.rejects(env.start(),/Rent a Mac/);
  const task=env.store.list({statuses:["failed"],limit:10})[0]!;const notice=await env.service.ownMacNotice(task);assert.ok(notice!.offer);
  await env.service.answerOwnMacRental(task.id,"wait");assert.equal(env.service.publicStatus(env.store.get(task.id)!).needsYou,false);
  env.config.ownMacPaused=false;await env.service.maintainOwnMac();
  const next=env.store.list({statuses:["running"],limit:10});assert.equal(next.length,1);assert.equal(next[0]!.sandboxProvider,"ownmac");
  assert.equal(env.store.get(task.id)!.status,"cancelled");await env.service.maintainOwnMac();assert.equal(env.store.list({statuses:["running"],limit:10}).length,1);
});
test("rental consent is bound to the displayed quote and is consumed once",async()=>{
  const env=await routingFixture();env.config.ownMacPaused=true;await assert.rejects(env.start());const task=env.store.list({statuses:["failed"],limit:10})[0]!;
  const notice=await env.service.ownMacNotice(task);await assert.rejects(env.service.answerOwnMacRental(task.id,"rent","fake-wrong-quote"),/quote changed/);
  env.rental.create=async()=>{const at=Date.now();env.boat.addSandbox("fake_rental_new","default","idle");env.store.macLeases.record({id:"fake-new-lease",provider:env.rental.id,machineId:"fake_rental_new",size:"fake-m2",startedAt:new Date(at).toISOString(),paidUntil:new Date(at+86400000).toISOString(),minimumCost:10,hourPrice:0.5,currency:"USD",cpus:8,memoryMiB:32768});return {...(await env.rental.info("fake_rental_new")),system:"macos"};};
  const replacement=await env.service.answerOwnMacRental(task.id,"rent",notice!.offer!.id);assert.ok(replacement);assert.equal(env.store.get(replacement!)!.sandboxProvider,"fake-rental");
  await assert.rejects(env.service.answerOwnMacRental(task.id,"rent",notice!.offer!.id),/cannot be replayed/);assert.equal(env.store.macLeases.held().length,1);
});

test("footer counts running Your Mac tasks once, including with admission off",()=>{
  const sandboxes=[{state:"idle",runsOn:{provider:"boat"}},{state:"idle",runsOn:{provider:"ownmac"}},{state:"idle",runsOn:{provider:"ownmac"}}];
  assert.equal(footerOnCount(sandboxes,1),2);assert.equal(footerOnCount(sandboxes,0),1);
});
test("an idle task releases its admission slot while retaining credentials until close",async()=>{
  const env=await fixture();let idle=false;
  const own=await createOwnMacProvider({...env.options,taskState:()=>idle?"idle":"running"});const first=await own.create(input);idle=true;
  assert.equal((await own.ownMacStatus!()).running,0);await own.create(input);assert.equal(env.cleaned.length,0);
  await own.closeTaskCredentials!(first.id);assert.deepEqual(env.cleaned,[first.id]);
});
test("a failed SSH reading is cached for Settings, and a forced test bypasses it",async()=>{
  const env=await fixture();env.offline();await env.provider.ownMacStatus!();await env.provider.ownMacStatus!();assert.equal(env.calls.length,1);
  env.offline(false);const result=await env.provider.testOwnMacConnection!();assert.equal(result.testResult!.ok,true);
});
test("a changed rental price creates a fresh offer without renting",async()=>{
  const env=await routingFixture();env.config.ownMacPaused=true;await assert.rejects(env.start());const task=env.store.list({statuses:["failed"],limit:10})[0]!;const offer=(await env.service.ownMacNotice(task))!.offer!;
  const models=await env.rental.macModels!();env.rental.macModels=async()=>models.map(model=>({...model,minimumCost:20,hourPrice:1}));
  await assert.rejects(env.service.answerOwnMacRental(task.id,"rent",offer.id),/Nothing was rented/);assert.equal(env.store.macLeases.held().length,0);
});

test("expired quotes are refreshed in place and never rent",async()=>{
  const env=await routingFixture();env.config.ownMacPaused=true;await assert.rejects(env.start());const task=env.store.list({statuses:["failed"],limit:10})[0]!;const offer=(await env.service.ownMacNotice(task))!.offer!;
  env.store.addOwnMacEvent(task.id,"ownmac-rental-offer","fake expired quote",{...offer,expiresAt:"2000-01-01T00:00:00Z"});
  await assert.rejects(env.service.answerOwnMacRental(task.id,"rent",offer.id),/quote changed/);
  const refreshed=(await env.service.ownMacNotice(task))!.offer!;assert.notEqual(refreshed.id,offer.id);assert.ok(Date.parse(refreshed.expiresAt)>Date.now());assert.equal(env.store.macLeases.held().length,0);assert.equal(env.store.list({limit:10}).length,1);
});

test("two simultaneous rental approvals cannot allocate twice",async()=>{
  const env=await routingFixture();env.config.ownMacPaused=true;await assert.rejects(env.start());const task=env.store.list({statuses:["failed"],limit:10})[0]!;const offer=(await env.service.ownMacNotice(task))!.offer!;
  let creates=0;env.rental.create=async()=>{creates++;throw new Error("fake allocation rejected before any machine existed");};
  const result=await Promise.allSettled([env.service.answerOwnMacRental(task.id,"rent",offer.id),env.service.answerOwnMacRental(task.id,"rent",offer.id)]);
  assert.equal(result.filter(r=>r.status==="rejected").length,2);assert.equal(creates,1);assert.equal(env.store.macLeases.held().length,0);
});
test("a host disconnect produces a chat notice and never replays the worker",async()=>{
  const env=await routingFixture();const task=await env.start();env.chat.finish(task.threadId!,"fake host disconnected","error");
  await env.service.syncChatThread(task.threadId!,{kind:"failed",error:"fake host disconnected"});
  assert.equal(env.chat.sends.length,0);assert.ok(env.told.every(item=>item.threadId!==task.threadId));assert.match((await env.service.ownMacNotice(env.store.get(task.id)!))!.disconnect!,/not moved or replayed/);
  await env.service.maintainOwnMac();assert.equal(env.store.list({statuses:["running"],limit:10}).length,0);
});

test("cleanup rechecks retain the automatic pause until proxy revocation is verified",async()=>{
  const env=await fixture();const task=await env.provider.create(input);await assert.rejects(env.provider.closeTaskCredentials!(task.id,undefined,false));
  assert.equal((await env.provider.checkOwnMacCleanup!()).code,"cleanup");assert.equal((await env.provider.checkOwnMacCleanup!(async()=>false)).code,"cleanup");
  const checked=await env.provider.checkOwnMacCleanup!(async()=>true);assert.equal(checked.cleanup!.failed,false);
});

test("copied cleanup steps use each original task home without nesting them",async()=>{
  const env=await fixture();env.config.ownMacMaxTasks=2;
  const tasks=[await env.provider.create(input),await env.provider.create(input)];
  env.cleanupFail();for(const task of tasks)await assert.rejects(env.provider.closeTaskCredentials!(task.id));
  const root=mkdtempSync(join(tmpdir(),"fake-ownmac-cleanup-"));
  try {
    const bin=join(root,"fake-bin");mkdirSync(bin);
    for(const tool of ["gh","claude","codex"])writeFileSync(join(bin,tool),"#!/bin/sh\nexit 0\n",{mode:0o700});
    for(const task of tasks){const home=join(root,".bb-ownmac",task.id);for(const path of [".config/gh/hosts.yml",".claude/.credentials.json",".codex/auth.json"]){const file=join(home,path);mkdirSync(join(file,".."),{recursive:true});writeFileSync(file,"fake credential placeholder");}}
    const untouched=join(root,"fake-owner-file");writeFileSync(untouched,"fake owner file");
    const steps=env.provider.ownMacCleanup!()!.steps;
    execFileSync("/bin/bash",["-c",steps],{env:{HOME:root,PATH:`${bin}:/bin:/usr/bin`},stdio:"pipe"});
    for(const task of tasks)for(const path of [".config/gh",".claude/.credentials.json",".codex/auth.json"])assert.equal(existsSync(join(root,".bb-ownmac",task.id,path)),false);
    assert.ok(existsSync(untouched));
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("a failed chat archive pauses Your Mac until proxy removal is proven",async()=>{
  const env=await routingFixture();const task=await env.start();env.chat.archive=async()=>{throw Error("fake archive failed");};
  await assert.rejects(env.service.closeTask(task.id,{status:"done",discard:true}),/proxy/);
  assert.deepEqual(env.cleaned,[task.sandboxId]);
  await assert.rejects(env.provider.refreshGithubLogin!(task.sandboxId!),/closed/);
  assert.equal((await env.provider.ownMacStatus!()).code,"cleanup");
  assert.equal((await env.service.checkOwnMacCleanup())!.code,"cleanup");
});

test("a rental click after Your Mac returns records its actual zero-rent route",async()=>{
  const env=await routingFixture();env.config.ownMacPaused=true;await assert.rejects(env.start());const task=env.store.list({statuses:["failed"],limit:10})[0]!;const offer=(await env.service.ownMacNotice(task))!.offer!;
  env.config.ownMacPaused=false;
  const next=await env.service.answerOwnMacRental(task.id,"rent",offer.id);
  assert.equal(env.store.get(next!)!.sandboxProvider,"ownmac");
  assert.equal((await env.service.ownMacNotice(env.store.get(task.id)!))!.answer,"auto");
  assert.equal(env.store.macLeases.held().length,0);
});

for(const [name,patch] of Object.entries({user:{user:"fake-other"},uid:{uid:503},hardware:{hardware:"b".repeat(64)},vm:{vm:true},unknownVM:{vm:null}}))test(`pinned ${name} change is refused, and Test connection re-pins`,async()=>{
  const env=await fixture();await env.provider.ownMacStatus!();env.set(patch);
  const state=await env.provider.ownMacStatus!(true);assert.equal(state.status,"Test connection again");assert.equal(state.code,"target");
  await assert.rejects(env.provider.assertTaskReady!({agent:"claude",repos:[]}),/Test connection again/);
  await assert.rejects(env.provider.allocate!(input),/Test connection again/);
  assert.ok(env.calls.every(call=>call.request.command.at(-1)===AVAILABILITY_SCRIPT));
  assert.match(env.provider.ownMacTargetNotice!()!.text,/Your Mac target changed; Test connection again before tasks run there/);
  assert.equal((await env.provider.testOwnMacConnection!()).code,"available");
  const pinned=await env.kv.get<any>("ownMacSetupV1");for(const [key,value] of Object.entries(patch))assert.equal(pinned.target[key],value);
  await env.provider.allocate!(input);
});

test("a changed alias cannot receive task setup or credentials until re-tested",async()=>{
  const env=await fixture();env.config.ownMacAlias="fake-other-mac";
  assert.equal((await env.provider.ownMacStatus!()).status,"Test connection again");
  await assert.rejects(env.provider.allocate!(input),/Test connection again/);assert.equal(env.calls.length,0);
  await env.provider.testOwnMacConnection!();await env.provider.allocate!(input);
  assert.ok(env.calls.every(call=>call.alias==="fake-other-mac"));
});

test("an old display-only test is not migrated into a trusted identity",async()=>{
  const env=await fixture();await env.kv.set("ownMacSetupV1",{step:7,testedAlias:"fake-mac"});
  const provider=await createOwnMacProvider(env.options);
  assert.equal((await provider.ownMacStatus!()).status,"Test connection again");
  await assert.rejects(provider.allocate!(input),/Test connection again/);assert.equal(env.calls.length,0);
  await provider.testOwnMacConnection!();assert.equal((await provider.ownMacStatus!()).status,"Available");
});

test("a task-start check verifies the recorded VM flag and current pin",async()=>{
  const env=await fixture();const task=await env.provider.allocate!(input);env.set({vm:true});
  await assert.rejects(env.provider.assertTaskReady!({agent:"claude",repos:[],sandboxId:task.id}),/different account/);
  assert.equal((await env.provider.ownMacStatus!()).status,"Test connection again");
  env.set({vm:false});env.config.ownMacAlias="fake-other";
  await assert.rejects(env.provider.assertTaskReady!({agent:"claude",repos:[],sandboxId:task.id}),/Test connection again/);
});

test("target-change notices reach orchestrators, deduplicate, and survive restart",async()=>{
  const env=await routingFixture();env.store.addOrchestrator("fake-orchestrator");env.store.addOrchestrator("fake-retired");env.store.removeOrchestrator("fake-retired");
  env.config.ownMacAlias="fake-other";await env.service.maintainOwnMac();
  assert.deepEqual(env.told,[{threadId:"fake-orchestrator",text:"Your Mac target changed; Test connection again before tasks run there"}]);
  await env.service.maintainOwnMac();assert.equal(env.told.length,1);
  const reloaded=await createOwnMacProvider(env.options);assert.deepEqual(reloaded.ownMacTargetNotice!()!.deliveredTo,["fake-orchestrator"]);
  await reloaded.testOwnMacConnection!();env.set({uid:503});await reloaded.ownMacStatus!(true);
  assert.deepEqual(reloaded.ownMacTargetNotice!()!.deliveredTo,[]);
});

test("task count comes only from the task store, not stray CLI processes",async()=>{
  const env=await fixture();let state:"running"|"idle"="running";
  const provider=await createOwnMacProvider({...env.options,taskState:()=>state});await provider.allocate!(input);
  assert.equal((await provider.ownMacStatus!()).code,"busy");state="idle";
  assert.equal((await provider.ownMacStatus!()).code,"available");assert.equal((await provider.ownMacStatus!()).running,0);
  assert.equal(availability(parseReading(output(reading)+"\nrunning=99"),local,0,1),"Available");
});

for(const provider of ["scaleway","instabox"]) {
  test(`explicit ${provider} Runs-on wins over an available Your Mac`,async()=>{
    const env=await routingFixture(false,provider);env.held();const before=env.calls.length;
    const task=await env.start(provider);assert.equal(task.sandboxProvider,provider);assert.equal(task.sandboxId,"fake_rental_1");assert.equal(env.calls.length,before);
  });
  test(`new ${provider} day lease requires consent with ownmac registered`,async()=>{
    const env=await routingFixture(false,provider);let creates=0;env.rental.create=async()=>{creates++;throw Error("fake create");};
    await assert.rejects(env.start(provider),{code:"mac_rental_confirmation_required"});assert.equal(creates,0);assert.equal(env.calls.length,0);
    const task=env.store.list({statuses:["failed"],limit:5})[0]!;const quote=(await env.service.ownMacNotice(task))!.offer!;assert.equal(quote.provider,provider);
    assert.equal((await env.service.ownMacNotice(task))!.canWaitForOwnMac,false);
    await env.service.maintainOwnMac();assert.equal(env.store.list({limit:10}).length,1);assert.equal(creates,0);
    await assert.rejects(env.service.answerOwnMacRental(task.id,"wait"),/Runs on/);
    await assert.rejects(env.service.answerOwnMacRental(task.id,"rent",quote.id),/outcome is unknown/);assert.equal(creates,1);
  });
}

test("failed target-change delivery stays pending until the orchestrator can receive it",async()=>{
  const env=await routingFixture();env.store.addOrchestrator("fake-orchestrator");env.config.ownMacAlias="fake-other";env.failNextNotice();
  await assert.rejects(env.service.maintainOwnMac(),/fake chat unavailable/);assert.deepEqual(env.provider.ownMacTargetNotice!()!.deliveredTo,[]);
  await env.service.maintainOwnMac();assert.equal(env.told.length,1);assert.deepEqual(env.provider.ownMacTargetNotice!()!.deliveredTo,["fake-orchestrator"]);
});

test("restoring an edited alias still requires a new test after the change was observed",async()=>{
  const env=await fixture();env.config.ownMacAlias="fake-other";
  assert.equal((await env.provider.ownMacStatus!()).code,"target");env.config.ownMacAlias="fake-mac";
  assert.equal((await env.provider.ownMacStatus!()).code,"target");await assert.rejects(env.provider.allocate!(input),/Test connection again/);
  await env.provider.testOwnMacConnection!();assert.equal((await env.provider.ownMacStatus!()).code,"available");
});
