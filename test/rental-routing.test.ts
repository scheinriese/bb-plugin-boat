import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { ProjectStore, normalizeProject, parseOrchestratorProject, toOrchestratorProject } from "../src/projects.ts";
import { TaskStore } from "../src/store.ts";
import { durableStartInput, queueDigest } from "../src/start-queue-store.ts";
import { BoatService } from "../src/service.ts";
import { createRuntime } from "../src/runtime.ts";
import { buildCli } from "../src/cli.ts";
import { registerTools } from "../src/tools.ts";
import { registerRpc } from "../src/rpc.ts";
import { createBoatProvider } from "../src/providers/boat/provider.ts";
import { createProviderRegistry } from "../src/providers/registry.ts";
import { createMigratingSettingsStore } from "../src/settings-store.ts";
import type { BoatApi } from "../src/providers/boat/api.ts";
import type { SandboxProvider } from "../src/providers/types.ts";
import type { ProtocolStore } from "../src/protocol.ts";
import { FakeBoat, defaultSettings } from "./fakes.ts";

const projectInput = { id: "mac-app", name: "Mac app", repos: [{ repo: "acme/web", baseBranch: "main" }] };
test("project routing survives current snapshots, thread metadata and durable input; changing it changes the policy digest", () => {
  const before = toOrchestratorProject(normalizeProject(projectInput));
  const after = toOrchestratorProject(normalizeProject({ ...projectInput, sandboxProvider: "scaleway", sandboxSystem: "macos" }));
  assert.notEqual(queueDigest(before), queueDigest(after), "routing changes must invalidate a waiting start's project snapshot");
  const parsed = parseOrchestratorProject(after)!;
  assert.equal((parsed as unknown as {sandboxProvider?: string}).sandboxProvider, "scaleway");
  const durable = durableStartInput({ title: "Native checks", brief: "Check the app", role: "custom", project: parsed });
  assert.deepEqual(durable.project, after);
});

test("CLI runs-on persists into explicit and inherited boat_dispatch project routing with fake providers", async t => {
  const { bb, harness } = createFakePluginHost({ pluginId: "boat" });
  bb.storage.migrate(bb.storage.database(), TaskStore.migrations());
  const projects = new ProjectStore(() => bb.storage.database());
  const store = new TaskStore(() => bb.storage.database());
  const original = projects.save(projectInput);
  const settings = await createMigratingSettingsStore(bb);
  const boat = new FakeBoat();
  let createCalls = 0;
  const mac = (id: string): SandboxProvider => ({
    ...createBoatProvider(new FakeBoat() as unknown as BoatApi), id, displayName: id,
    caps: { ...createBoatProvider(boat as unknown as BoatApi).caps, os: "macos", systems: ["macos"] },
    macLeaseKind: "day",
    macModels: async () => [{ id: `${id}-standard`, label: "Standard Mac", cpus: 8, memoryMiB: 16384, minimumCost: 12, minimumHours: 24, hourPrice: 0.5, currency: "USD" }],
    create: async () => { createCalls++; throw Error("No create before owner consent"); },
  });
  const registry = createProviderRegistry([createBoatProvider(boat as unknown as BoatApi), mac("instabox"), mac("scaleway")]);
  const controller = new AbortController();
  const service = new BoatService(registry, store, { settings: async () => defaultSettings(), projects: () => projects.list(), lifecycle: controller.signal, changed() {}, notify: async () => {}, log: { info() {}, warn() {} } });
  const runtime = createRuntime({ bb, service, projects, settings, protocol: { read: () => ({ text: "", custom: false, path: "", updatedAt: null }) } as unknown as ProtocolStore, readRepoFile: async () => "", changed() {}, wake() {} });
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ project: toOrchestratorProject(original) }));
  harness.sdk.stub("threads.send", async () => ({ ok: true }));
  bb.cli.register(buildCli(runtime)); registerTools(runtime); registerRpc(runtime);
  t.after(async () => { controller.abort(); runtime.startQueue.dispose(); await harness.lifecycle.dispose(); });
  const saved = await harness.runCli(["config", "runs-on", "mac-app", "scaleway", "--json"]);
  assert.equal(saved.exitCode, 0, saved.stderr);
  assert.equal(JSON.parse(saved.stdout).runsOn, "scaleway");
  for (const explicit of [true, false]) {
    const result = await harness.callAgentTool("boat_dispatch", { title: `Native check ${explicit}`, brief: "Check app", role: "custom", tier: "build", reason: "Native fixture", agent: "codex", sandbox_system: "macos", ...(explicit ? {project: "mac-app"} : {}) }, { threadId: "thr_orchestrator", projectId: "proj_local" });
    assert.equal((result as {isError?: boolean}).isError, true, "pending rental reports consent requirement");
    const task = store.list({ limit: 1 })[0]!;
    assert.equal(task.boatProject, "mac-app");
    const quote = store.ownMacEventData(task.id, "ownmac-rental-offer") as {provider: string};
    assert.equal(quote.provider, "scaleway", JSON.stringify(result));
    const count = store.list({ limit: 100 }).length;
    const cliOffers = await harness.runCli(["task", "rental-options", task.id, "--json"]);
    assert.equal(cliOffers.exitCode, 0, cliOffers.stderr);
    assert.equal(JSON.parse(cliOffers.stdout).notice.offer.provider, "scaleway");
    const refreshed = await harness.callRpc("refreshMacRentalOffers", { taskId: task.id }) as {notice:{offers:{id:string;provider:string}[]}};
    const alternative = refreshed.notice.offers.find(q => q.provider === "instabox")!;
    assert.ok(alternative);
    const selection = await harness.callAgentTool("boat_rental_options", { task_id: task.id, quote_id: alternative.id, answer: "rent" });
    assert.notEqual((selection as {isError?:boolean}).isError, true, JSON.stringify(selection));
    assert.match(typeof selection === "string" ? selection : JSON.stringify(selection), /No rental is authorized/);
    assert.equal((await service.ownMacNotice(service.mustGet(task.id)))?.offer?.provider, "instabox");
    const selected = await harness.callRpc("selectMacRentalOffer", { taskId: task.id, quoteId: alternative.id }) as {notice:{offer:{provider:string}}};
    assert.equal(selected.notice.offer.provider, "instabox");
    assert.equal(store.list({ limit: 100 }).length, count, "selection keeps the original task");
    assert.equal(projects.get("mac-app")?.sandboxProvider, "scaleway", "selection leaves project routing intact");
  }
  assert.equal(createCalls, 0);
});

test("rental approval cannot authorize model usage that exhausted while the owner was choosing", async () => {
  const { memoryStore } = await import("./fakes.ts");
  const store = memoryStore();
  let usedPercent = 10, creates = 0;
  const base = createBoatProvider(new FakeBoat() as unknown as BoatApi);
  const mac: SandboxProvider = { ...base, id: "instabox", displayName: "Instabox", macLeaseKind: "day",
    macModels: async () => [{ id: "m2", label: "M2", cpus: 8, memoryMiB: 16384, minimumCost: 12, minimumHours: 24, hourPrice: .5, currency: "USD" }],
    create: async () => { creates++; throw Error("Create must wait for included model usage"); },
  };
  const service = new BoatService(createProviderRegistry([base, mac]), store, {
    settings: async () => defaultSettings(), lifecycle: new AbortController().signal, changed() {}, notify: async () => {}, log: { info() {}, warn() {} },
    quotas: { read: async () => new Map((["claude", "codex"] as const).map(provider => [provider, { provider, usedPercent, resetsAt: null, window: "Weekly limit" }])) },
  });
  await assert.rejects(service.startTask({ title: "Native check", brief: "Check app", role: "custom", provider: "claude", sandboxSystem: "macos" }), { code: "mac_rental_confirmation_required" });
  const task = store.list({ limit: 1 })[0]!;
  const notice = await service.ownMacNotice(task);
  usedPercent = 100;
  await assert.rejects(service.answerOwnMacRental(task.id, "rent", notice!.offer!.id), { code: "agents_at_limit" });
  assert.equal(creates, 0, "rental consent does not authorize paid model usage");
});

test("a task prefix and its canonical id share the same rental selection lock", async () => {
  const { memoryStore } = await import("./fakes.ts");
  const store = memoryStore();
  let release!: () => void, entered!: () => void, gate: Promise<void> | null = null, creates = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const base = createBoatProvider(new FakeBoat() as unknown as BoatApi);
  const mac: SandboxProvider = { ...base, id: "instabox", displayName: "Instabox", macLeaseKind: "day",
    macModels: async () => { if (gate) { entered(); await gate; } return [{ id: "m2", label: "M2", cpus: 8, memoryMiB: 16384, minimumCost: 12, minimumHours: 24, hourPrice: .5, currency: "USD" }]; },
    create: async () => { creates++; throw Error("No create while quote refresh is pending"); },
  };
  const service = new BoatService(createProviderRegistry([base, mac]), store, { settings: async () => defaultSettings(), lifecycle: new AbortController().signal, changed() {}, notify: async () => {}, log: { info() {}, warn() {} } });
  await assert.rejects(service.startTask({ title: "Native check", brief: "Check app", role: "custom", sandboxSystem: "macos" }), { code: "mac_rental_confirmation_required" });
  const task = store.list({ limit: 1 })[0]!, quote = (await service.ownMacNotice(task))!.offer!;
  gate = new Promise<void>(resolve => { release = resolve; });
  const refresh = service.refreshMacRentalOffers(task.id.slice(0, -1));
  await started;
  const approval = service.answerOwnMacRental(task.id, "rent", quote.id);
  release();
  const [refreshed, answered] = await Promise.allSettled([refresh, approval]);
  assert.equal(refreshed.status, "fulfilled");
  assert.equal(answered.status, "rejected");
  if (answered.status === "rejected") assert.equal(answered.reason.code, "task_busy");
  assert.equal(creates, 0);
});
