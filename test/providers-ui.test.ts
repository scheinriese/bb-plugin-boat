// Sandbox providers in the UI: the contract's fields (contract-providers.ts),
// the server's view of them (src/rpc-providers.ts), a project's Runs on
// pick, where each task and sandbox runs, and the words the UI puts on them
// (web/providers-logic.ts). The whole plugin's answers come last, from bb's
// fake host and the fake boat CLI.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type Database from "better-sqlite3";
import plugin from "../server.ts";
import { projectSchema, runsOnSchema, sandboxProvidersResultSchema, taskSchema, type SandboxProvidersResultDto } from "../contract.ts";
import { ProjectStore } from "../src/projects.ts";
import { createProviderRegistry, unavailableProvider } from "../src/providers/registry.ts";
import type { SandboxProvider } from "../src/providers/types.ts";
import { PROVIDER_CATALOG, providerHandlers, providersView, runsOnOf, type BoatReading } from "../src/rpc-providers.ts";
import type { Runtime } from "../src/runtime.ts";
import { TaskStore } from "../src/store.ts";
import { chipProvider, keyHint, keyLine, providerGlyph, providerStatus, readyProvidersText, runsOnGlyph, runsOnLine, runsOnMachine } from "../web/providers-logic.ts";
import { createTestHost } from "./fakes.ts";
import * as fixtures from "./fixtures/providers.ts";

const fakeBoat = fileURLToPath(new URL("../src/providers/boat/fixtures/fake-boat.mjs", import.meta.url));

/** A provider with only the members the view reads (the rest refuse). */
function stubProvider(id: string, displayName: string, os: "linux" | "macos" = "linux"): SandboxProvider {
  const inert = unavailableProvider(id);
  return { ...inert, displayName, caps: { ...inert.caps, os } };
}

const BOAT = stubProvider("boat", "boat.dev");
const INSTABOX = stubProvider("instabox", "Instabox");

const SIGNED_IN: BoatReading = {
  cli: { found: true, version: "1.0.0" },
  account: { signedIn: true, identifier: null, plan: "Standard", error: null },
  plan: {
    name: "Standard",
    accessTier: "standard",
    trial: false,
    trialEndsAt: null,
    checkoutRequired: false,
    canStart: true,
    startBlockedReason: null,
    activeSandboxes: 3,
    maxActiveSandboxes: 6,
    startsLeftToday: null,
    startsPerDay: null,
    vmHoursRemaining: 475,
    machineTypes: [],
    extraStartsEnabled: false,
    autoStopCapHours: null,
  },
};

function projectStore(): ProjectStore {
  const db = new DatabaseSync(":memory:");
  for (const sql of TaskStore.migrations()) db.exec(sql);
  return new ProjectStore(() => db as unknown as Database.Database);
}

const STOREFRONT = { id: "storefront", name: "Storefront", repos: [{ repo: "acme/storefront", baseBranch: "main" }] };
const API = { id: "api", name: "API", repos: [{ repo: "acme/api", baseBranch: "main" }] };

// ------------------------------------------------------------------ the contract and its fixtures

test("every design state's fixture fits the contract", () => {
  for (const view of [fixtures.PROVIDERS_CONNECTED, fixtures.PROVIDERS_BOAT_ONLY, fixtures.PROVIDERS_SIGNED_OUT]) {
    assert.deepEqual(sandboxProvidersResultSchema.parse(view), view);
  }
  for (const runsOn of Object.values(fixtures.RUNS_ON)) assert.deepEqual(runsOnSchema.parse(runsOn), runsOn);
});

test("tasks, sandboxes and projects read as before without the new fields", () => {
  const task = taskSchema.shape.runsOn;
  assert.equal(task.safeParse(undefined).success, true, "a task without runsOn still parses");
  assert.equal(projectSchema.shape.sandboxProvider.safeParse(undefined).success, true);
  assert.equal(projectSchema.shape.sandboxProvider.safeParse(null).success, true);
});

// ------------------------------------------------------------------ the server's view

test("with only boat.dev: boat.dev connected and default, Instabox without a key, the Mac rows greyed out", () => {
  const projects = projectStore();
  projects.save(STOREFRONT);
  const view = providersView({ registry: createProviderRegistry([BOAT]), boat: SIGNED_IN, projects: projects.list() });
  assert.deepEqual(view, { ...fixtures.PROVIDERS_BOAT_ONLY, projects: fixtures.PROVIDERS_BOAT_ONLY.projects.slice(0, 1) });
  // Nothing claims a working provider that isn't there.
  assert.equal(view.providers.filter((row) => row.connection === "connected").length, 1);
  assert.equal(view.providers.find((row) => row.id === "instabox")!.apiKey!.setting, null, "no setting to point at in this version");
});

test("boat.dev signed out, or not checked yet, reads as not connected", () => {
  const registry = createProviderRegistry([BOAT]);
  const signedOut = providersView({ registry, boat: { ...SIGNED_IN, account: { ...SIGNED_IN!.account, signedIn: false } }, projects: [] });
  assert.deepEqual(signedOut.providers[0], fixtures.PROVIDERS_SIGNED_OUT.providers[0]);
  const noCli = providersView({ registry, boat: { ...SIGNED_IN, cli: { found: false, version: null } }, projects: [] });
  assert.equal(noCli.providers[0]!.summary, "Linux · the boat CLI isn't installed");
  const unknown = providersView({ registry, boat: null, projects: [] });
  assert.equal(unknown.providers[0]!.connection, "not-connected");
  assert.equal(unknown.providers[0]!.summary, "Linux · not checked yet");
});

test("an enabled Linux-only Instabox: Linux ready, Mac coming next, its own prices, and a project's pick", () => {
  const projects = projectStore();
  projects.save(STOREFRONT);
  projects.save({ ...API, sandboxProvider: "instabox" });
  projects.save({ id: "docs", name: "Docs", repos: [{ repo: "acme/docs", baseBranch: "main" }] });
  const prices = new Map([["instabox", fixtures.INSTABOX_CONNECTED.pricing!]]);
  const view = providersView({ registry: createProviderRegistry([BOAT, INSTABOX]), boat: SIGNED_IN, connections: new Map([["instabox", "connected"]]), prices, projects: projects.list() });
  assert.deepEqual(view, fixtures.PROVIDERS_CONNECTED);
  const mac = view.providers.find((row) => row.id === "instabox")!.systems.find((system) => system.os === "macos")!;
  assert.deepEqual([mac.ready, mac.note], [false, "coming next"], "connecting a Linux-only provider never advertises Mac");

  // Once the provider says it starts Mac sandboxes, Mac is ready too.
  const withMac = { ...INSTABOX, caps: { ...INSTABOX.caps, systems: ["linux", "macos"] as const } };
  const later = providersView({ registry: createProviderRegistry([BOAT, withMac]), boat: SIGNED_IN, connections: new Map([["instabox", "connected"]]), prices, projects: [] });
  assert.deepEqual(later.providers.find((row) => row.id === "instabox"), fixtures.INSTABOX_WITH_MAC);

  const missingKey = providersView({ registry: createProviderRegistry([BOAT, INSTABOX]), boat: SIGNED_IN, connections: new Map([["instabox", "key-missing"]]), projects: [] });
  const instabox = missingKey.providers.find((row) => row.id === "instabox")!;
  assert.equal(instabox.connection, "key-missing");
  assert.equal(instabox.enabled, true);
  assert.deepEqual(instabox.systems.map((system) => system.ready), [false, false, false]);
  assert.equal(missingKey.options.find((option) => option.provider === "instabox")!.disabledReason, "Add its API key first");
});

test("a provider the catalog doesn't know still gets a row, and an unknown pick still shows", () => {
  const projects = projectStore();
  projects.save({ ...STOREFRONT, sandboxProvider: "modal" });
  const view = providersView({ registry: createProviderRegistry([BOAT, stubProvider("vercel", "Vercel")]), boat: SIGNED_IN, projects: projects.list() });
  assert.equal(view.providers.at(-1)!.label, "Vercel");
  assert.deepEqual(view.options.at(-1), { provider: "modal", label: "modal", disabledReason: "Not available in this version" });
  assert.equal(view.projects[0]!.provider, "modal");
});

test("no amounts reach Settings unless a provider states them", () => {
  assert.doesNotMatch(JSON.stringify(PROVIDER_CATALOG), /\$\s?\d|€\s?\d/);
  const view = providersView({ registry: createProviderRegistry([BOAT, INSTABOX]), boat: SIGNED_IN, connections: new Map([["instabox", "connected"]]), projects: [] });
  assert.doesNotMatch(JSON.stringify(view), /\$\s?\d|€\s?\d/);
  assert.equal(view.providers.find((row) => row.id === "instabox")!.pricing, null);
  assert.equal(providersView({ registry: createProviderRegistry([BOAT]), boat: SIGNED_IN, projects: [] }).providers.every((row) => row.pricing === null), true);
});

test("prices come from the provider, and only while it's connected", async () => {
  let up = true;
  const instabox: SandboxProvider = {
    ...INSTABOX,
    capacity: async () => {
      if (!up) throw Object.assign(new Error("no key"), { code: "key_missing" });
      return {} as never;
    },
    pricing: async () => "M2 $10.80 a day",
  };
  const { runtime } = fakeRuntime(createProviderRegistry([BOAT, instabox]));
  assert.equal((await providerHandlers(runtime).sandboxProviders()).providers.find((row) => row.id === "instabox")!.pricing, "M2 $10.80 a day");
  up = false;
  assert.equal((await providerHandlers(runtime).sandboxProviders()).providers.find((row) => row.id === "instabox")!.pricing, null);
});

// ------------------------------------------------------------------ a project's pick

test("a project keeps its own provider; the default's id or null clears it", () => {
  const projects = projectStore();
  assert.equal(projects.save({ ...STOREFRONT, sandboxProvider: "instabox" }).sandboxProvider, "instabox");
  assert.equal(projects.save({ ...STOREFRONT }).sandboxProvider, "instabox", "absent: unchanged");
  assert.equal("sandboxProvider" in projects.save({ ...STOREFRONT, sandboxProvider: "boat" }), false, "boat.dev is no pick");
  projects.save({ ...STOREFRONT, sandboxProvider: "instabox" });
  assert.equal("sandboxProvider" in projects.save({ ...STOREFRONT, sandboxProvider: null }), false);
  assert.throws(() => projects.save({ ...STOREFRONT, sandboxProvider: "Not A Provider" }), /sandbox provider's id/);
});

function fakeRuntime(registry = createProviderRegistry([BOAT])) {
  const projects = projectStore();
  const invalidated: string[][] = [];
  let changes = 0;
  const runtime = {
    service: { sandboxProviders: registry },
    projects,
    setup: null,
    bb: { rpc: { experimental_invalidate: (tags: string[]) => invalidated.push(tags) } },
    changed: () => {
      changes += 1;
    },
  } as unknown as Runtime;
  return { runtime, projects, invalidated, changes: () => changes };
}

test("setProjectRunsOn takes boat.dev, refuses a provider that can't take work, and names a missing project", async () => {
  const { runtime, projects, invalidated, changes } = fakeRuntime();
  projects.save(STOREFRONT);
  const handlers = providerHandlers(runtime);
  await assert.rejects(handlers.setProjectRunsOn({ projectId: "storefront", provider: "instabox" }), /Instabox can't take new work: add its API key first\./);
  await assert.rejects(handlers.setProjectRunsOn({ projectId: "storefront", provider: "your-mac" }), /not available yet/);
  await assert.rejects(handlers.setProjectRunsOn({ projectId: "storefront", provider: "nope" }), /isn't a sandbox provider/);
  await assert.rejects(handlers.setProjectRunsOn({ projectId: "gone", provider: "boat" }), /No project "gone"/);
  assert.equal(changes(), 0);
  const saved = await handlers.setProjectRunsOn({ projectId: "storefront", provider: "boat" });
  assert.deepEqual(saved, { projectId: "storefront", name: "Storefront", detail: "acme/storefront · Linux", provider: "boat", chosen: false });
  assert.equal(changes(), 1);
  assert.deepEqual(invalidated.at(-1), ["boat:providers"]);
});

test("setProjectRunsOn moves a project onto a connected provider and back off one that's gone", async () => {
  let up = true;
  const instabox: SandboxProvider = {
    ...INSTABOX,
    capacity: async () => {
      if (!up) throw Object.assign(new Error("no key"), { code: "key_missing" });
      return {} as never;
    },
  };
  const { runtime, projects } = fakeRuntime(createProviderRegistry([BOAT, instabox]));
  projects.save(STOREFRONT);
  const handlers = providerHandlers(runtime);
  assert.equal((await handlers.setProjectRunsOn({ projectId: "storefront", provider: "instabox" })).provider, "instabox");
  assert.equal(projects.get("storefront")!.sandboxProvider, "instabox");
  assert.equal((await handlers.sandboxProviders()).providers.find((row) => row.id === "instabox")!.connection, "connected");
  up = false;
  // The cached answer counts for a minute; a fresh handler set asks again.
  const later = providerHandlers(runtime);
  assert.equal((await later.sandboxProviders()).providers.find((row) => row.id === "instabox")!.connection, "key-missing");
  assert.equal((await later.setProjectRunsOn({ projectId: "storefront", provider: "boat" })).chosen, false);
});

/** An Instabox whose connection check waits until the test lets it go. */
function gatedInstabox() {
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const checking = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const provider: SandboxProvider = {
    ...INSTABOX,
    capacity: async () => {
      entered();
      await gate;
      return {} as never;
    },
  };
  return { provider, checking, release: () => release() };
}

test("setProjectRunsOn keeps an edit made while the providers were checked, and changes only the provider", async () => {
  const instabox = gatedInstabox();
  const { runtime, projects } = fakeRuntime(createProviderRegistry([BOAT, instabox.provider]));
  projects.save(STOREFRONT);
  const pending = providerHandlers(runtime).setProjectRunsOn({ projectId: "storefront", provider: "instabox" });
  await instabox.checking;
  projects.save({ ...projects.get("storefront")!, instructions: "Run the e2e tests too.", name: "Storefront web" });
  instabox.release();
  const saved = await pending;
  assert.equal(saved.provider, "instabox");
  const project = projects.get("storefront")!;
  assert.equal(project.instructions, "Run the e2e tests too.", "the edit made meanwhile stands");
  assert.equal(project.name, "Storefront web");
  assert.equal(project.sandboxProvider, "instabox");
});

test("setProjectRunsOn doesn't bring back a project deleted while the providers were checked", async () => {
  const instabox = gatedInstabox();
  const { runtime, projects, changes } = fakeRuntime(createProviderRegistry([BOAT, instabox.provider]));
  projects.save(STOREFRONT);
  const pending = providerHandlers(runtime).setProjectRunsOn({ projectId: "storefront", provider: "instabox" });
  await instabox.checking;
  projects.delete("storefront");
  instabox.release();
  await assert.rejects(pending, /No project "storefront"/);
  assert.equal(projects.get("storefront"), null);
  assert.equal(changes(), 0);
});

// ------------------------------------------------------------------ where a task runs

test("runsOn: boat.dev names the size; another provider names the system too", () => {
  assert.deepEqual(runsOnOf(BOAT, "default", "boat"), fixtures.RUNS_ON.boatDefault);
  assert.deepEqual(runsOnOf(BOAT, null, "boat"), fixtures.RUNS_ON.boatUnknown);
  assert.deepEqual(runsOnOf(INSTABOX, "default", "boat"), fixtures.RUNS_ON.instaboxLinux);
  assert.equal(runsOnOf(stubProvider("instabox", "Instabox", "macos"), null, "boat").machine, "Mac");
  // A provider this version doesn't have: its id, never another provider's name.
  assert.deepEqual(runsOnOf(unavailableProvider("modal"), "small", "boat"), { provider: "modal", label: "modal", os: "linux", machine: "Linux · Small", note: null, detail: null });
});

// ------------------------------------------------------------------ the UI's words

test("the task line, the sandbox cell and the chip say where work runs", () => {
  const { RUNS_ON } = fixtures;
  assert.equal(runsOnLine(RUNS_ON.boatDefault), "boat.dev · Default");
  assert.equal(runsOnLine(RUNS_ON.boatUnknown), "boat.dev");
  assert.equal(runsOnLine(RUNS_ON.boatUnknown, "Small"), "boat.dev · Small");
  assert.equal(runsOnLine(RUNS_ON.instaboxLinux), "Instabox · Linux · per second");
  assert.equal(runsOnLine(RUNS_ON.instaboxMac), "Instabox · Mac M2 · lease ends Thu 14:00");
  assert.equal(runsOnLine(RUNS_ON.yourMac), "Your Mac · MacBook Pro · $0");
  assert.equal(runsOnMachine(RUNS_ON.instaboxMacSandbox), "Instabox · Mac M2");
  assert.equal(chipProvider(RUNS_ON.boatDefault), null, "nothing on a boat.dev chip");
  assert.equal(chipProvider(undefined), null);
  assert.equal(chipProvider(RUNS_ON.instaboxMac), "Instabox");
  assert.equal(chipProvider(RUNS_ON.yourMac), "Your Mac");
  assert.deepEqual([RUNS_ON.boatDefault, RUNS_ON.instaboxLinux, RUNS_ON.instaboxMac, RUNS_ON.yourMac].map(runsOnGlyph), ["boat", "box", "laptop", "laptop"]);
});

test("provider rows: glyphs, status, the key line and where the key goes", () => {
  const { BOAT_CONNECTED, INSTABOX_CONNECTED, INSTABOX_NOT_CONNECTED, YOUR_MAC_DISABLED, MONTHLY_MAC_DISABLED } = fixtures;
  assert.deepEqual([BOAT_CONNECTED, INSTABOX_CONNECTED, YOUR_MAC_DISABLED, MONTHLY_MAC_DISABLED].map(providerGlyph), ["boat", "box", "laptop", "laptop-dashed"]);
  assert.deepEqual(providerStatus(BOAT_CONNECTED), { text: "Connected", ok: true });
  assert.deepEqual(providerStatus(INSTABOX_NOT_CONNECTED), { text: "Not connected", ok: false });
  assert.deepEqual(providerStatus(YOUR_MAC_DISABLED), { text: "Not available yet", ok: false });
  assert.equal(keyLine(BOAT_CONNECTED), null);
  assert.deepEqual(keyLine(INSTABOX_CONNECTED), { set: true, action: "Change" });
  assert.deepEqual(keyLine(INSTABOX_NOT_CONNECTED), { set: false, action: "Add key in bb secrets" });
  assert.match(keyHint(INSTABOX_CONNECTED).title, /“Instabox API key” in the settings list/);
  assert.equal(keyHint(INSTABOX_NOT_CONNECTED).title, "This version of Boat can't take a key for Instabox yet");
});

test("the setup line counts providers only once more than one is ready", () => {
  assert.equal(readyProvidersText(fixtures.PROVIDERS_BOAT_ONLY.providers), null, "only boat.dev: the plan as before");
  assert.equal(readyProvidersText(undefined), null);
  assert.equal(readyProvidersText(fixtures.PROVIDERS_CONNECTED.providers), "2 providers ready");
});

// ------------------------------------------------------------------ the whole plugin

test("the plugin answers with providers, Runs on, and where its tasks and sandboxes run", async (t) => {
  process.env.FAKE_BOAT_STATE = join(mkdtempSync(join(tmpdir(), "boat-providers-test-")), "state.json");
  const { bb, harness } = await createTestHost({ pluginId: "boat", settings: { boatPath: fakeBoat, evidenceUploader: "" } });
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
  await plugin(bb);
  t.after(() => harness.lifecycle.dispose());
  const added = await harness.runCli(["project", "add", "--name", "Storefront", "--repo", "acme/storefront@main"]);
  assert.equal(added.exitCode, 0, added.stderr || added.stdout);

  const view = sandboxProvidersResultSchema.parse(await harness.callRpc("sandboxProviders", null)) as SandboxProvidersResultDto;
  assert.deepEqual(view.providers.map((row) => [row.id, row.connection, row.available]), [
    ["boat", "connected", true],
    ["instabox", "key-missing", true],
    ["scaleway", "key-missing", true],
    ["your-mac", "not-connected", false],
    ["monthly-mac", "not-connected", false],
  ]);
  assert.deepEqual(view.projects.map((row) => [row.name, row.provider, row.chosen]), [["Storefront", "boat", false]]);
  await assert.rejects(harness.callRpc("setProjectRunsOn", { projectId: view.projects[0]!.projectId, provider: "instabox" }), /can't take new work/);
  assert.equal(((await harness.callRpc("setProjectRunsOn", { projectId: view.projects[0]!.projectId, provider: "boat" })) as { provider: string }).provider, "boat");

  const started = (await harness.callRpc("startTask", {
    title: "Check acme/web runs in a sandbox",
    brief: "Install the dependencies and run the tests. Don't change any code.",
    role: "custom",
    repo: "acme/web",
    branch: null,
    baseBranch: null,
    provider: "claude",
    model: null,
    tier: "light",
    sandbox: null,
    machineType: "small",
    notifyThreadId: null,
  })) as { task: { id: string; sandboxId: string; runsOn?: unknown } };
  const runsOn = runsOnSchema.parse(started.task.runsOn);
  assert.deepEqual([runsOn.provider, runsOn.label, runsOn.os], ["boat", "boat.dev", "linux"]);
  assert.ok(runsOn.machine === null || runsOn.machine === "Small", `a boat.dev machine is its size, or not known yet: ${runsOn.machine}`);
  const tasks = (await harness.callRpc("tasks", { statuses: null, threadId: null, limit: 50 })) as { tasks: { id: string; runsOn?: { provider: string; label: string } }[] };
  assert.deepEqual(tasks.tasks.map((task) => [task.runsOn?.provider, task.runsOn?.label]), [["boat", "boat.dev"]]);
  const sandboxes = (await harness.callRpc("sandboxes", { all: true })) as { sandboxes: { id: string; runsOn?: { label: string } }[] };
  assert.equal(sandboxes.sandboxes.find((row) => row.id === started.task.sandboxId)?.runsOn?.label, "boat.dev");
});

test("provider presentation is shared for 60 seconds; only Check again bypasses it",async()=>{
 let now=0;const reads={plan:0,capacity:0,presentation:0};let entered!:()=>void,release!:()=>void;
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const boat={...BOAT,usagePlan:async()=>{reads.plan++;return null;}};
 const instabox={...INSTABOX,capacity:async()=>{reads.capacity++;return {} as never;},presentation:async()=>{reads.presentation++;entered();await gate;return {steps:[]};}};
 const {runtime,projects}=fakeRuntime(createProviderRegistry([boat,instabox]));
 const {memoryStore}=await import("./fakes.ts");Object.assign(runtime.service,{store:memoryStore()});
 runtime.setup={peek:()=>({facts:SIGNED_IN})} as unknown as Runtime["setup"];
 const handlers=providerHandlers(runtime,()=>now);
 const first=handlers.sandboxProviders();await started;
 const second=handlers.sandboxProviders();release();await Promise.all([first,second]);
 assert.deepEqual(reads,{plan:1,capacity:1,presentation:1});
 projects.save(STOREFRONT);assert.equal((await handlers.sandboxProviders()).projects.length,1);
 now=59_999;await handlers.sandboxProviders();assert.equal(reads.presentation,1);
 now=60_001;await handlers.sandboxProviders();assert.deepEqual(reads,{plan:2,capacity:2,presentation:2});
 await handlers.checkSandboxProviders();await handlers.sandboxProviders();assert.deepEqual(reads,{plan:3,capacity:3,presentation:3});
});
