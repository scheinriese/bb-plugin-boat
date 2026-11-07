// Settings in two places: bb's short list and the plugin's own (kv), read
// and written as one (`bb boat config get|set|reset`, the settings RPCs).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rpcErrorInfo, type SettingsResultDto } from "../contract.ts";
import plugin from "../server.ts";
import {
  ALL_SETTINGS,
  ORCHESTRATOR_EFFORTS,
  PLUGIN_SETTINGS,
  SETTINGS,
  SETTING_SECTIONS,
  crossFieldProblems,
  parseSettingText,
  runnersFor,
  settingProblem,
  workersFromLegacy,
} from "../src/settings.ts";
import { ORCHESTRATOR_EFFORT_VALUES } from "../contract.ts";
import { EFFORTS } from "../src/tiers.ts";
import { PLUGIN_SETTINGS_KEY, SettingsError, createSettingsStore, pluginValues } from "../src/settings-store.ts";
import { autoStopHours } from "../src/boat-api.ts";
import { createTestHost } from "./fakes.ts";

const fakeBoat = fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url));

async function setup(t: { after(fn: () => unknown): void }, settings: Record<string, unknown> = {}) {
  process.env.FAKE_BOAT_STATE = join(mkdtempSync(join(tmpdir(), "boat-settings-test-")), "state.json");
  const { bb, harness } = await createTestHost({ pluginId: "boat", settings: { boatPath: fakeBoat, evidenceUploader: "", ...settings }, agentSkillIds: ["boat", "boat-orchestrator"] });
  t.after(() => harness.lifecycle.dispose());
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({ id: threadId, environmentId: null, deletedAt: null, archivedAt: null, status: "idle" }));
  harness.sdk.stub("threads.send", async () => ({ ok: true, delivery: "sent" }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({ role: "orchestrator" }));
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "orchestrator" }));
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
  await plugin(bb);
  const cli = (...args: string[]) => harness.runCli(args);
  return { bb, harness, cli };
}

test("bb's list has the ten everyday settings, in order, with short option labels", () => {
  assert.deepEqual(Object.keys(SETTINGS), [
    "agents",
    "workers",
    "environment",
    "machineType",
    "maxActiveSandboxes",
    "implementProvider",
    "reviewProvider",
    "stopIdleAfterMinutes",
    "pushNotifications",
    "workerInstructions",
  ]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(SETTINGS).map(([key, descriptor]) => [key, descriptor.label])),
    {
      agents: "Coding agents",
      workers: "How tasks run",
      environment: "Boat environment",
      machineType: "Default sandbox size",
      maxActiveSandboxes: "Sandboxes at once",
      implementProvider: "Agent for tasks",
      reviewProvider: "Agent for reviews",
      stopIdleAfterMinutes: "Stop idle sandboxes after (min)",
      pushNotifications: "Notify my devices",
      workerInstructions: "Instructions for every task",
    },
  );
  assert.deepEqual(SETTINGS.workers.options, ["boat", "projects", "all"]);
  assert.deepEqual(SETTINGS.workers.experimental_optionLabels, { boat: "In boat (simplest)", projects: "As chats for projects", all: "As chats everywhere" });
  assert.equal(SETTINGS.workers.default, "boat");
  assert.equal(SETTINGS.agents.default, "auto");
  assert.equal(SETTINGS.maxActiveSandboxes.default, 3);
  assert.equal(SETTINGS.workerInstructions.experimental_multiline, true);
  for (const [key, descriptor] of Object.entries(ALL_SETTINGS)) {
    if (descriptor.type !== "select") continue;
    for (const option of descriptor.options) {
      const label = descriptor.experimental_optionLabels?.[option] ?? option;
      assert.ok(label.length <= 23, `${key}: "${label}" is too long for an option`);
    }
  }
});

test("every other setting is the plugin's own, in a section; no setting is in both places; retired words stay out", () => {
  const sections = new Set(SETTING_SECTIONS.map((section) => section.id));
  for (const [key, spec] of Object.entries(PLUGIN_SETTINGS)) {
    assert.ok(sections.has(spec.section), key);
    assert.ok(!Object.hasOwn(SETTINGS, key), `${key} is in both places`);
    assert.ok(spec.description.length > 0, `${key} needs a description`);
  }
  assert.ok(!Object.hasOwn(ALL_SETTINGS, "pollIntervalSeconds"), "the check interval is a constant now");
  assert.ok(!Object.hasOwn(ALL_SETTINGS, "workerMode") && !Object.hasOwn(ALL_SETTINGS, "adhocWorkerMode"), "workers replaced them");
  assert.equal(PLUGIN_SETTINGS.cloudOrchestratorFullAccess.section, "orchestrators");
  assert.equal(PLUGIN_SETTINGS.cloudOrchestratorFullAccess.default, true);
  assert.equal(PLUGIN_SETTINGS.orchestratorMachineType.label, "Size for chats on a Boat sandbox");
  // The orchestrator section: what they run as (agent, effort) first, then the sidebar, size, and full access right after size.
  const orchestrators = Object.entries(PLUGIN_SETTINGS).filter(([, spec]) => spec.section === "orchestrators").map(([key]) => key);
  assert.deepEqual(orchestrators, ["relayPreferred", "orchestratorEffort", "tasksBeforeAsking", "sidebarLayout", "orchestratorMachineType", "cloudOrchestratorFullAccess"]);
  // The agent setting kept its key (backups) but left the switching block: it decides where new orchestrators start too.
  assert.equal(PLUGIN_SETTINGS.relayPreferred.label, "Agent for orchestrators");
  assert.ok(!("group" in PLUGIN_SETTINGS.relayPreferred), "not only about switching");
  assert.deepEqual(PLUGIN_SETTINGS.relayPreferred.experimental_optionLabels, { claude: "Claude Code", codex: "Codex" });
  assert.match(PLUGIN_SETTINGS.relayEnabled.description, /moves back to the Agent for orchestrators/);
  const retired = /\b(workers?|slots?|tiers?|relay|implementer|usage window|boat conversations?)\b/i;
  for (const [key, descriptor] of Object.entries(ALL_SETTINGS)) {
    const labels = descriptor.type === "select" ? Object.values(descriptor.experimental_optionLabels ?? {}) : [];
    for (const text of [descriptor.label, descriptor.description ?? "", ...labels]) assert.doesNotMatch(text, retired, `${key}: ${text}`);
    assert.doesNotMatch(descriptor.description ?? "", /boatPath|pollInterval/, key);
  }
});

test("Effort for orchestrators: High by default, the four levels Claude Code and Codex both take, and nothing else", () => {
  const spec = PLUGIN_SETTINGS.orchestratorEffort;
  assert.equal(spec.section, "orchestrators");
  assert.equal(spec.label, "Effort for orchestrators");
  assert.equal(spec.default, "high");
  assert.deepEqual(spec.options, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual([...ORCHESTRATOR_EFFORTS], spec.options);
  // The app's copy of the levels (it can't import server modules).
  assert.deepEqual([...ORCHESTRATOR_EFFORT_VALUES], spec.options);
  assert.deepEqual(spec.experimental_optionLabels, { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high" });
  // Each is one of the plugin's effort levels (low, medium, high, xhigh: Claude Code and Codex both take them in bb).
  for (const level of spec.options) assert.ok((EFFORTS as readonly string[]).includes(level), level);
  assert.match(spec.description, /wakes after every task turn/);
  // Where the model comes from, and that it's the one Build tasks use.
  assert.match(spec.description, /Build preset model, as for Build tasks \(Models, above\)/);
  assert.match(PLUGIN_SETTINGS.relaySwitchBackBelow.description, /under this much of its usage limit/);
  // Stored values: a level it doesn't offer falls back to High.
  assert.equal(pluginValues({}).orchestratorEffort, "high");
  assert.equal(pluginValues({ orchestratorEffort: "xhigh" }).orchestratorEffort, "xhigh");
  for (const bad of ["max", "ultra", "ultracode", "none", "High", 3, null]) assert.equal(pluginValues({ orchestratorEffort: bad }).orchestratorEffort, "high", String(bad));
  assert.equal(settingProblem("orchestratorEffort", spec, "max"), "orchestratorEffort must be one of low, medium, high, xhigh");
  assert.equal(settingProblem("orchestratorEffort", spec, "medium"), null);
});

test("stored values: invalid ones fall back to the default; the cross-field rule; text values from the CLI", () => {
  const values = pluginValues({ relaySwitchAt: 500, relayEnabled: "yes", sidebarLayout: "pinned", unknown: 1 });
  assert.equal(values.relaySwitchAt, 90);
  assert.equal(values.relayEnabled, false);
  assert.equal(values.sidebarLayout, "pinned");
  assert.deepEqual(pluginValues(null).boatPath, "");

  assert.deepEqual(crossFieldProblems({ relaySwitchAt: 90, relaySwitchBackBelow: 85 }), []);
  assert.match(crossFieldProblems({ relaySwitchAt: 90, relaySwitchBackBelow: 86 })[0] ?? "", /at least 5 below relaySwitchAt \(90\).*use 85 or less/);
  assert.match(crossFieldProblems({ relaySwitchAt: 5, relaySwitchBackBelow: 1 })[0] ?? "", /use 0 or less/);

  assert.equal(parseSettingText("relayEnabled", PLUGIN_SETTINGS.relayEnabled, "off"), false);
  assert.equal(parseSettingText("relayEnabled", PLUGIN_SETTINGS.relayEnabled, "Yes"), true);
  assert.throws(() => parseSettingText("relayEnabled", PLUGIN_SETTINGS.relayEnabled, "maybe"), /true or false/);
  assert.equal(parseSettingText("relaySwitchAt", PLUGIN_SETTINGS.relaySwitchAt, " 85 "), 85);
  assert.throws(() => parseSettingText("relaySwitchAt", PLUGIN_SETTINGS.relaySwitchAt, "lots"), /must be a number/);
  assert.equal(parseSettingText("boatPath", PLUGIN_SETTINGS.boatPath, ""), "");
});

test("the store: all or nothing, safe when the kv can't be read, and it tells listeners what changed", async () => {
  const kvRows = new Map<string, unknown>([[PLUGIN_SETTINGS_KEY, { relaySwitchAt: 80, relayEnabled: "yes", gone: 1 }]]);
  let kvBroken = true;
  const kvSets: unknown[] = [];
  const kv = {
    async get<T>(key: string) {
      if (kvBroken) throw new Error("database is locked");
      return kvRows.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      kvSets.push(value);
      kvRows.set(key, value);
    },
    async delete(key: string) {
      kvRows.delete(key);
    },
    async list() {
      return [...kvRows.keys()];
    },
  };
  let declared: Record<string, unknown> = Object.fromEntries(Object.entries(SETTINGS).map(([key, descriptor]) => [key, descriptor.default]));
  const handle = {
    async get() {
      return declared;
    },
    async experimental_set(values: Record<string, unknown>) {
      if (values.workers === "projects") throw new Error("bb refused it");
      declared = { ...declared, ...values };
      return declared;
    },
    onChange() {},
  } as unknown as Parameters<typeof createSettingsStore>[0];
  const store = createSettingsStore(handle, kv);
  const heard: string[][] = [];
  store.onChange((keys) => heard.push(keys));

  // Unreadable: defaults for now, and no write over values it couldn't see.
  assert.equal((await store.get()).relaySwitchAt, 90);
  await assert.rejects(store.set({ relayQuietMinutes: 5 }), /database is locked/);
  assert.deepEqual(kvSets, []);
  kvBroken = false;
  // Readable again: valid stored values count; invalid and unknown ones are dropped.
  assert.equal((await store.get()).relaySwitchAt, 80);
  assert.equal((await store.get()).relayEnabled, false);

  // bb refuses its part: the plugin's part isn't written either.
  await assert.rejects(store.set({ workers: "projects", relayEnabled: true }), /bb refused it/);
  assert.deepEqual(kvSets, []);
  // Problems are all collected before anything is written.
  await assert.rejects(store.set({ relayEnabled: "yes", maxActiveSandboxes: -1, nope: true }), (error: unknown) => {
    assert.ok(error instanceof SettingsError);
    assert.deepEqual(error.problems, ["relayEnabled must be true or false.", "maxActiveSandboxes: Use 0 or more.", 'There\'s no setting "nope".']);
    return true;
  });
  assert.deepEqual(kvSets, []);

  await store.set({ relayEnabled: true, workers: "all" });
  assert.deepEqual(kvRows.get(PLUGIN_SETTINGS_KEY), { relaySwitchAt: 80, relayEnabled: true });
  assert.equal(declared.workers, "all");
  assert.deepEqual(heard, [["relayEnabled"]]);
  await store.set({ relaySwitchAt: null });
  assert.deepEqual(kvRows.get(PLUGIN_SETTINGS_KEY), { relayEnabled: true });
  assert.deepEqual(heard.at(-1), ["relaySwitchAt"]);
  assert.equal(store.where("workers"), "bb");
  assert.equal(store.where("relayEnabled"), "plugin");
  assert.equal(store.where("pollIntervalSeconds"), null);
});

test("workers: the old pair maps to one value, and back to what each kind of repo gets", () => {
  assert.equal(workersFromLegacy("boat", "chat"), "boat");
  assert.equal(workersFromLegacy("boat", "boat"), "boat");
  assert.equal(workersFromLegacy("chat", "boat"), "projects");
  assert.equal(workersFromLegacy("chat", "chat"), "all");
  for (const workers of ["boat", "projects", "all"] as const) {
    const { workerMode, adhocWorkerMode } = runnersFor(workers);
    assert.equal(workersFromLegacy(workerMode, adhocWorkerMode), workers);
  }
  // The plan's cap (from boat) bounds the auto-stop; without one the setting stands.
  assert.equal(autoStopHours(4, 2), 2);
  assert.equal(autoStopHours(4, 3), 3);
  assert.equal(autoStopHours(4, null), 4);
  assert.equal(autoStopHours(0.1, null), 0.25);
});

test("bb boat config get|set|reset: one command for both places, with the same checks", async (t) => {
  const { bb, harness, cli } = await setup(t);
  const all = await cli("config", "get");
  assert.equal(all.exitCode, 0, all.stderr);
  assert.match(all.stdout, /^bb's settings list \(Settings → Plugins → Boat Cloud Agents\):\n {2}agents = "auto"\n {2}workers = "boat"/);
  assert.match(all.stdout, /\n\nUsage limits:\n {2}notifyNeedsYou = true\n {2}notifyReady = true\n {2}notifyProgress = false\n {2}autoFailover = true\n/);
  assert.match(
    all.stdout,
    /\n\nOrchestrators \(optional\):\n {2}relayPreferred = "claude"\n {2}orchestratorEffort = "high"\n {2}tasksBeforeAsking = 5\n {2}sidebarLayout = "sections"\n {2}orchestratorMachineType = "small"\n {2}cloudOrchestratorFullAccess = true\n/,
  );
  assert.match(all.stdout, /maxActiveSandboxes = 0 {2}\(default 3\)/);
  const json = JSON.parse((await cli("config", "get", "--json")).stdout) as { settings: { key: string; where: string; section: string | null }[] };
  assert.deepEqual(json.settings.slice(0, 10).map((row) => row.key), Object.keys(SETTINGS));
  assert.ok(json.settings.slice(10).every((row) => row.where === "plugin" && row.section !== null));
  assert.equal((await cli("config", "get", "relaySwitchAt")).stdout, "90\n");

  // The plugin's own: checked, saved in its kv, and the plugin uses it at once.
  const set = await cli("config", "set", "relaySwitchAt", "85");
  assert.equal(set.exitCode, 0, set.stderr);
  assert.equal(set.stdout, "Set relaySwitchAt = 85  (default 90)\n");
  assert.equal((await bb.storage.kv.get<Record<string, unknown>>(PLUGIN_SETTINGS_KEY))?.relaySwitchAt, 85);
  const relay = JSON.parse((await cli("relay", "status", "--json")).stdout) as { relay: { switchAtPercent: number } };
  assert.equal(relay.relay.switchAtPercent, 85);
  const again = await cli("config", "set", "relaySwitchAt", "85");
  assert.match(again.stdout, /\(unchanged\)/);

  const tooHigh = await cli("config", "set", "relaySwitchAt", "500");
  assert.notEqual(tooHigh.exitCode, 0);
  assert.match(tooHigh.stderr, /relaySwitchAt: Use 100 or less\./);
  const rule = await cli("config", "set", "relaySwitchBackBelow", "81");
  assert.notEqual(rule.exitCode, 0);
  assert.match(rule.stderr, /relaySwitchBackBelow \(81\) must be at least 5 below relaySwitchAt \(85\)/);
  assert.equal((await cli("config", "get", "relaySwitchBackBelow")).stdout, "50\n");
  const choice = await cli("config", "set", "sidebarLayout", "sideways");
  assert.match(choice.stderr, /sidebarLayout must be one of sections, pinned, plain/);
  // Effort for orchestrators: the four levels only.
  assert.equal((await cli("config", "set", "orchestratorEffort", "medium")).stdout, 'Set orchestratorEffort = "medium"  (default "high")\n');
  const max = await cli("config", "set", "orchestratorEffort", "max");
  assert.notEqual(max.exitCode, 0);
  assert.match(max.stderr, /orchestratorEffort must be one of low, medium, high, xhigh/);
  assert.equal((await cli("config", "get", "orchestratorEffort")).stdout, "medium\n");
  assert.equal((await cli("config", "reset", "orchestratorEffort")).stdout, 'Reset orchestratorEffort = "high"\n');
  assert.match((await cli("config", "set", "autoFailover", "off")).stdout, /^Set autoFailover = false {2}\(default true\)/);

  // bb's list goes through bb (its own checks too).
  const workers = await cli("config", "set", "workers", "projects");
  assert.equal(workers.exitCode, 0, workers.stderr);
  assert.equal((await cli("config", "get", "workers")).stdout, "projects\n");
  assert.ok(!Object.hasOwn((await bb.storage.kv.get<Record<string, unknown>>(PLUGIN_SETTINGS_KEY)) ?? {}, "workers"));
  assert.match((await cli("config", "set", "workers", "sometimes")).stderr, /workers must be one of boat, projects, all/);

  // Reset: back to the default, wherever it lives.
  assert.equal((await cli("config", "reset", "relaySwitchAt")).stdout, "Reset relaySwitchAt = 90\n");
  assert.ok(!Object.hasOwn((await bb.storage.kv.get<Record<string, unknown>>(PLUGIN_SETTINGS_KEY)) ?? {}, "relaySwitchAt"));
  assert.equal((await cli("config", "reset", "workers")).stdout, 'Reset workers = "boat"\n');

  // Unknown or removed keys say which ones exist.
  const unknown = await cli("config", "get", "pollIntervalSeconds");
  assert.notEqual(unknown.exitCode, 0);
  assert.match(unknown.stderr, /There's no setting "pollIntervalSeconds"/);
  assert.match(unknown.stderr, /bb boat config get/);
  void harness;
});

test("the settings RPCs: rows for every section, saving several at once (all or nothing), greyed out with one agent", async (t) => {
  const { harness } = await setup(t);
  const result = (await harness.callRpc("settings", null)) as SettingsResultDto;
  assert.deepEqual(result.sections.map((section) => section.title), ["Setup", "Usage limits", "Models", "Orchestrators (optional)", "Advanced"]);
  assert.equal(result.cliFound, true);
  assert.equal(result.onlyAgent, null);
  const row = (rows: SettingsResultDto, key: string) => rows.settings.find((entry) => entry.key === key)!;
  assert.deepEqual(
    { ...row(result, "relaySwitchAt") },
    {
      key: "relaySwitchAt",
      label: "Switch at (% of a usage limit)",
      description: "Keep it below 100, so paid extra usage isn't reached.",
      where: "plugin",
      section: "usage-limits",
      group: "switching",
      fold: "Fine-tune",
      type: "number",
      value: 90,
      default: 90,
      isDefault: true,
      options: null,
      min: 5,
      max: 100,
      integer: true,
      multiline: false,
      disabledReason: null,
    },
  );
  assert.deepEqual(row(result, "workers").options, [
    { value: "boat", label: "In boat (simplest)" },
    { value: "projects", label: "As chats for projects" },
    { value: "all", label: "As chats everywhere" },
  ]);
  assert.equal(row(result, "workers").where, "bb");
  assert.equal(row(result, "workerInstructions").multiline, true);

  // Both rows of the switching rule together: fine. One of them alone: refused, nothing saved.
  const saved = (await harness.callRpc("saveSettings", { values: { relaySwitchAt: 60, relaySwitchBackBelow: 40, workers: "all", relayEnabled: true } })) as SettingsResultDto;
  assert.equal(row(saved, "relaySwitchAt").value, 60);
  assert.equal(row(saved, "workers").value, "all");
  assert.equal(row(saved, "relayEnabled").isDefault, false);
  await assert.rejects(harness.callRpc("saveSettings", { values: { relaySwitchBackBelow: 58, pushNotifications: true } }), (error: unknown) => {
    const info = rpcErrorInfo(error);
    return info.code === "invalid_setting" && /relaySwitchBackBelow \(58\) must be at least 5 below relaySwitchAt \(60\)/.test(info.message);
  });
  await assert.rejects(harness.callRpc("saveSettings", { values: { relaySwitchAt: 70, nope: 1 } }), (error: unknown) => /There's no setting "nope"/.test(rpcErrorInfo(error).message));
  const after = (await harness.callRpc("settings", null)) as SettingsResultDto;
  assert.equal(row(after, "pushNotifications").value, false, "nothing from a refused save");
  assert.equal(row(after, "relaySwitchAt").value, 60);
  // null: back to the default.
  const reset = (await harness.callRpc("saveSettings", { values: { relaySwitchAt: null, relaySwitchBackBelow: null, workers: null } })) as SettingsResultDto;
  assert.equal(row(reset, "relaySwitchAt").value, 90);
  assert.equal(row(reset, "workers").value, "boat");

  // One agent: the switching rows say why they don't apply.
  await harness.setSettings({ agents: "claude" });
  const one = (await harness.callRpc("settings", null)) as SettingsResultDto;
  assert.equal(one.onlyAgent, "claude");
  assert.equal(row(one, "relayEnabled").disabledReason, "Needs both Claude and Codex");
  assert.equal(row(one, "autoFailover").disabledReason, "Needs both Claude and Codex");
  assert.equal(row(one, "avoidExtraUsage").disabledReason, null, "it still applies to one agent");
  // With one agent there's nothing to pick; the one agent runs every orchestrator. Effort still applies.
  assert.equal(row(one, "relayPreferred").disabledReason, "Needs both Claude and Codex");
  assert.equal(row(one, "relayPreferred").section, "orchestrators");
  assert.equal(row(one, "orchestratorEffort").disabledReason, null);
});

test("sizes for pickers follow the plan; a fresh install runs at most 3 sandboxes at once", async (t) => {
  const { harness, cli } = await setup(t, { maxActiveSandboxes: undefined });
  const sizes = (await harness.callRpc("sandboxSizes", null)) as {
    sizes: { type: string; label: string; detail: string; available: boolean; reason: string | null }[];
    taskDefault: string;
    chatDefault: string;
    autoStopCapHours: number | null;
    autoStopHours: number;
    plan: string | null;
    known: boolean;
  };
  assert.equal(sizes.known, true);
  assert.equal(sizes.plan, "Trial");
  assert.deepEqual(
    sizes.sizes.map((size) => [size.type, size.available, size.reason]),
    [
      ["small", true, null],
      ["default", true, null],
      ["large", false, "needs a paid plan"],
      ["xlarge", false, "needs the $100/month plan or higher"],
    ],
  );
  assert.deepEqual(sizes.sizes[0], { type: "small", label: "Small", detail: "2 vCPU, 4 GB · half rate", available: true, reason: null });
  assert.equal(sizes.taskDefault, "default");
  assert.equal(sizes.chatDefault, "small");
  // The trial's cap on the auto-stop, and the hours a sandbox gets under it.
  assert.equal(sizes.autoStopCapHours, 2);
  assert.equal((await cli("config", "set", "sandboxTtlHours", "6")).exitCode, 0);
  assert.equal(((await harness.callRpc("sandboxSizes", null)) as { autoStopHours: number }).autoStopHours, 2);

  assert.equal((await cli("config", "get", "maxActiveSandboxes")).stdout, "3\n");
  const overview = (await harness.callRpc("overview", null)) as { cap: number | null };
  // The trial plan allows 2, so the smaller one wins.
  assert.equal(overview.cap, 2);
  assert.equal((await cli("config", "set", "maxActiveSandboxes", "1")).exitCode, 0);
  assert.equal(((await harness.callRpc("overview", null)) as { cap: number | null }).cap, 1);
});

test("Stop idle sandboxes after: an hour by default, a plain description, and the docs agree", () => {
  const spec = SETTINGS.stopIdleAfterMinutes;
  assert.equal(spec.type, "number", "stored numbers and `bb plugin config boat set stopIdleAfterMinutes <n>` keep working");
  assert.equal(spec.default, 60);
  assert.match(spec.description, /^A sandbox whose agent has finished and is waiting for you stops after this long, to save sandbox hours\. Work still running, background jobs included, keeps it on\. Your next message starts it again; anything the agent kept in memory or \/tmp is lost\./);
  const docs = readFileSync(new URL("../docs/settings.md", import.meta.url), "utf8");
  assert.match(docs, /\| Stop idle sandboxes after \(min\) \| `stopIdleAfterMinutes` \| `60` \|/);
  assert.match(docs, /\| Orchestrators \| Tasks at once before asking \| `tasksBeforeAsking` \| `5`; 0 never asks \|/);
  for (const file of ["../README.md", "../docs/orchestrators.md", "../docs/marketplace/SUBMISSION.md", "../skills/boat/SKILL.md", "../skills/boat-orchestrator/SKILL.md"]) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /more than 3 tasks/, file);
  }
});
