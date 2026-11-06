// What a new orchestrator chat starts with (src/orchestrator-agent.ts):
// agent, model and effort, from the dialog, the CLI, a take-over and the
// dialog's own read of it. Claude ↔ Codex successors are in relay.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import plugin from "../server.ts";
import { TAGS, type OrchestratorChoicesDto } from "../contract.ts";
import { orchestratorRpcMethods } from "../contract-orchestrator.ts";
import {
  agentUnavailable,
  choiceSummary,
  defaultOrchestratorAgent,
  orchestratorAgentChoice,
  orchestratorChoices,
  orchestratorPicks,
  parseOrchestratorPicks,
  type OrchestratorSettings,
} from "../src/orchestrator-agent.ts";
import { DEFAULT_TIERS } from "../src/tiers.ts";
import { createTestHost, defaultSettings } from "./fakes.ts";

const fakeBoat = fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url));

// ------------------------------------------------------------------ the rules

const both = (overrides: Partial<OrchestratorSettings> = {}): OrchestratorSettings => {
  const settings = defaultSettings({ relay: { enabled: false, preferred: "claude", switchAtPercent: 90, switchBackBelowPercent: 50, quietMinutes: 10 } });
  return { ...settings, ...overrides };
};
const preferring = (preferred: "claude" | "codex", overrides: Partial<OrchestratorSettings> = {}) =>
  both({ relay: { ...both().relay, preferred }, ...overrides });

test("the default agent: Agent for orchestrators while it's connected, else the one that is", () => {
  assert.equal(defaultOrchestratorAgent(both()), "claude");
  assert.equal(defaultOrchestratorAgent(preferring("codex")), "codex");
  // One agent (Coding agents, or Auto-detect finding one): that one, whatever the setting says.
  assert.equal(defaultOrchestratorAgent(preferring("claude", { agents: "codex", agentsSetting: "codex" })), "codex");
  assert.equal(defaultOrchestratorAgent(preferring("codex", { agents: "claude", agentsSetting: "auto" })), "claude");
  // boat.dev can't be read now and last said the main agent was missing: the other one.
  assert.equal(defaultOrchestratorAgent(preferring("codex", { agentsSetting: "auto", notConnectedAgents: ["codex"] })), "claude");
  // Both reported missing: still the setting (nothing better to pick).
  assert.equal(defaultOrchestratorAgent(preferring("codex", { agentsSetting: "auto", notConnectedAgents: ["claude", "codex"] })), "codex");

  assert.equal(agentUnavailable(both(), "codex"), null);
  assert.equal(agentUnavailable(both({ agents: "claude", agentsSetting: "claude" }), "codex"), "Coding agents is set to Only Claude");
  assert.equal(agentUnavailable(both({ agents: "claude", agentsSetting: "auto" }), "codex"), "Not connected in boat.dev");
  assert.equal(agentUnavailable(both({ agents: "claude", agentsSetting: "auto" }), "claude"), null);
  assert.equal(agentUnavailable(both({ agentsSetting: "auto", notConnectedAgents: ["codex"] }), "codex"), "boat.dev last reported it as not connected");
});

test("model and effort: the Build preset's model for the agent and Effort for orchestrators; what a caller names wins", () => {
  const settings = both();
  assert.deepEqual(orchestratorAgentChoice(settings, "high"), { providerId: "claude-code", provider: "claude", model: "claude-opus-5-5", effort: "high" });
  assert.deepEqual(orchestratorAgentChoice(preferring("codex"), "medium"), { providerId: "codex", provider: "codex", model: "gpt-6.1-sol", effort: "medium" });
  // The table in Settings → Models decides the model (boat's opus-… becomes bb's claude-opus-…).
  const tiers = { ...DEFAULT_TIERS, build: { claude: { model: "opus-5-6", effort: "xhigh" as const }, codex: { model: "gpt-6.2", effort: "high" as const } } };
  assert.equal(orchestratorAgentChoice(both({ modelTiers: tiers }), "high").model, "claude-opus-5-6");
  assert.equal(orchestratorAgentChoice(both({ modelTiers: tiers }), "high", { providerId: "codex" }).model, "gpt-6.2");
  // Not the preset's effort: an orchestrator coordinates.
  assert.equal(orchestratorAgentChoice(settings, "low").effort, "low");

  // Named agent: bb's id or the plugin's name, and it wins over one agent too.
  assert.equal(orchestratorAgentChoice(settings, "high", { providerId: "codex" }).model, "gpt-6.1-sol");
  assert.equal(orchestratorAgentChoice(settings, "high", { providerId: "claude" }).providerId, "claude-code");
  assert.equal(orchestratorAgentChoice(both({ agents: "claude", agentsSetting: "claude" }), "high", { providerId: "codex" }).providerId, "codex");
  // A named model brings its agent along, and keeps the effort setting.
  assert.deepEqual(orchestratorAgentChoice(settings, "high", { model: "gpt-6-astra" }), { providerId: "codex", provider: "codex", model: "gpt-6-astra", effort: "high" });
  assert.deepEqual(orchestratorAgentChoice(preferring("codex"), "high", { model: "claude-fable-5-1" }).providerId, "claude-code");
  // boat's id for a Claude model (what `bb boat task start --model` takes) becomes bb's.
  assert.deepEqual(orchestratorAgentChoice(preferring("codex"), "high", { model: "opus-5-5" }), { providerId: "claude-code", provider: "claude", model: "claude-opus-5-5", effort: "high" });
  assert.equal(orchestratorAgentChoice(settings, "high", { providerId: "claude", model: "fable-5-1" }).model, "claude-fable-5-1");
  // A model id that doesn't say: the default agent.
  assert.equal(orchestratorAgentChoice(settings, "high", { model: "house-model" }).providerId, "claude-code");
  // Named effort wins.
  assert.equal(orchestratorAgentChoice(settings, "high", { effort: "xhigh" }).effort, "xhigh");
  // Empty text is nothing named.
  assert.deepEqual(orchestratorAgentChoice(settings, "high", { providerId: " ", model: "", effort: "" }), orchestratorAgentChoice(settings, "high"));
  // Another bb agent: only what was named (no Claude or Codex model, no level it may not have).
  assert.deepEqual(orchestratorAgentChoice(settings, "high", { providerId: "pi" }), { providerId: "pi", provider: null, model: null, effort: null });
  assert.deepEqual(orchestratorAgentChoice(settings, "high", { providerId: "pi", model: "pi-large", effort: "low" }), { providerId: "pi", provider: null, model: "pi-large", effort: "low" });

  assert.equal(choiceSummary(orchestratorAgentChoice(settings, "high")), "Claude Code · claude-opus-5-5 · high effort");
});

test("picks: only what differs from the settings stays with an orchestrator, by agent for a model", () => {
  const settings = both();
  const picks = (effortSetting: string, request: Parameters<typeof orchestratorAgentChoice>[2]) =>
    orchestratorPicks(settings, effortSetting, orchestratorAgentChoice(settings, effortSetting, request));
  // The defaults, or a pick that matches them: it follows the settings.
  assert.equal(picks("high", {}), null);
  assert.equal(picks("high", { providerId: "codex", effort: "high", model: "gpt-6.1-sol" }), null);
  assert.equal(picks("high", { model: "opus-5-5" }), null);
  // An effort other than the setting's, a model other than the agent's Build model.
  assert.deepEqual(picks("high", { effort: "low" }), { effort: "low" });
  assert.deepEqual(picks("high", { model: "fable-5-1", effort: "xhigh" }), { effort: "xhigh", models: { claude: "claude-fable-5-1" } });
  assert.deepEqual(picks("medium", { model: "gpt-6-astra" }), { models: { codex: "gpt-6-astra" } });
  // Another bb agent: switching never moves it, so nothing to keep.
  assert.equal(picks("high", { providerId: "pi", effort: "low" }), null);

  // What's read back is checked: anything else is dropped.
  assert.deepEqual(parseOrchestratorPicks({ effort: "low", models: { claude: "claude-fable-5-1", codex: "gpt-6-astra" } }), {
    effort: "low",
    models: { claude: "claude-fable-5-1", codex: "gpt-6-astra" },
  });
  assert.deepEqual(parseOrchestratorPicks({ effort: "max", models: { claude: "", pi: "pi-large", codex: 4 } }), {});
  assert.deepEqual(parseOrchestratorPicks(null), {});
  assert.deepEqual(parseOrchestratorPicks("low"), {});
  assert.equal(choiceSummary(orchestratorAgentChoice(settings, "high", { providerId: "pi" })), "pi");
});

test("what the dialog is told: both agents with their models, which can start, the defaults, and whether switching moves it back", () => {
  assert.deepEqual(orchestratorChoices(both(), "high"), {
    agents: [
      { provider: "claude", model: "claude-opus-5-5", available: true, reason: null },
      { provider: "codex", model: "gpt-6.1-sol", available: true, reason: null },
    ],
    provider: "claude",
    mainAgent: "claude",
    effort: "high",
    switching: false,
  } satisfies OrchestratorChoicesDto);
  const one = orchestratorChoices(preferring("claude", { agents: "codex", agentsSetting: "auto" }), "medium");
  assert.equal(one.provider, "codex");
  assert.equal(one.mainAgent, "claude");
  assert.equal(one.effort, "medium");
  assert.deepEqual(one.agents.map((agent) => [agent.provider, agent.available, agent.reason]), [["claude", false, "Not connected in boat.dev"], ["codex", true, null]]);
  // The dialog refetches when settings, model presets or the agents boat.dev reports change.
  assert.deepEqual(orchestratorRpcMethods.orchestratorChoices.tags(), [TAGS.settings, TAGS.protocol, TAGS.setup]);
  // Switching only runs with both agents.
  assert.equal(orchestratorChoices(both({ relay: { ...both().relay, enabled: true } }), "high").switching, true);
  assert.equal(orchestratorChoices(both({ relay: { ...both().relay, enabled: true }, agents: "claude", agentsSetting: "claude" }), "high").switching, false);
});

// ------------------------------------------------------------------ the whole plugin

async function setup(t: { after(fn: () => unknown): void }, settings: Record<string, unknown> = {}) {
  const statePath = join(mkdtempSync(join(tmpdir(), "boat-orchestrator-start-")), "state.json");
  process.env.FAKE_BOAT_STATE = statePath;
  const { bb, harness } = await createTestHost({ pluginId: "boat", settings: { boatPath: fakeBoat, evidenceUploader: "", ...settings }, agentSkillIds: ["boat", "boat-orchestrator"] });
  t.after(() => harness.lifecycle.dispose());
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({ id: threadId, environmentId: null, deletedAt: null, archivedAt: null, status: "idle" }));
  harness.sdk.stub("threads.send", async () => ({ ok: true, delivery: "sent" }));
  harness.sdk.stub("threads.output", async () => ({ output: "Ledger: the header PR is open." }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({ ok: true }));
  harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
  const spawns: Record<string, unknown>[] = [];
  harness.sdk.stub("threads.spawn", async (args: Record<string, unknown>) => {
    spawns.push(args);
    return { id: `thr_o${spawns.length}` };
  });
  await plugin(bb);
  const added = await harness.runCli(["project", "add", "--name", "Storefront", "--repo", "acme/storefront@main", "--environment", "storefront"]);
  assert.equal(added.exitCode, 0, added.stderr);
  /** Patch the fake boat account (agents connected in boat.dev). */
  const patchBoat = (changes: Record<string, unknown>) => {
    const current = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { sandboxes: {}, convos: {}, calls: [], next: 1 };
    writeFileSync(statePath, JSON.stringify({ ...current, ...changes }));
  };
  const cli = (...args: string[]) => harness.runCli(args);
  const last = () => {
    const spawn = spawns.at(-1)!;
    return { providerId: spawn.providerId, model: spawn.model, reasoningLevel: spawn.reasoningLevel };
  };
  return { harness, spawns, cli, last, patchBoat };
}

const NEW = ["orchestrator", "new", "--project", "storefront", "--prompt", "Ship the about page", "--local"];

test("bb boat orchestrator new: the settings by default, and says what it started", async (t) => {
  const { cli, last, harness } = await setup(t);
  const text = await cli(...NEW);
  assert.equal(text.exitCode, 0, text.stderr || text.stdout);
  assert.deepEqual(last(), { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" });
  assert.equal(text.stdout, "Started orchestrator @thread:thr_o1\nAgent: Claude Code · claude-opus-5-5 · high effort\n");

  // Agent and Effort for orchestrators.
  assert.equal((await cli("config", "set", "relayPreferred", "codex")).exitCode, 0);
  assert.equal((await cli("config", "set", "orchestratorEffort", "medium")).exitCode, 0);
  const json = JSON.parse((await cli(...NEW, "--json")).stdout) as { agent: unknown };
  assert.deepEqual(last(), { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "medium" });
  assert.deepEqual(json.agent, { providerId: "codex", provider: "codex", model: "gpt-6.1-sol", effort: "medium" });

  // The Build preset in Settings → Models is the model (its effort isn't: that's for tasks).
  const tiers = { ...DEFAULT_TIERS, build: { claude: { model: "claude-opus-5-6", effort: "max" }, codex: { model: "gpt-6.2", effort: "max" } } };
  await harness.callRpc("saveModelTiers", { tiers });
  assert.equal((await cli(...NEW)).exitCode, 0);
  assert.deepEqual(last(), { providerId: "codex", model: "gpt-6.2", reasoningLevel: "medium" });
  assert.equal(((await harness.callRpc("orchestratorChoices", null)) as OrchestratorChoicesDto).agents[0]!.model, "claude-opus-5-6");
});

test("bb boat orchestrator new: --provider, --model and --effort win over the settings", async (t) => {
  const { cli, last } = await setup(t, { orchestratorEffort: "medium" });
  const run = async (...flags: string[]) => {
    const result = await cli(...NEW, ...flags);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    return last();
  };
  assert.deepEqual(await run("--provider", "codex", "--effort", "low"), { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "low" });
  assert.deepEqual(await run("--provider", "claude"), { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "medium" });
  assert.deepEqual(await run("--provider", "claude-code", "--model", "claude-fable-5-1"), { providerId: "claude-code", model: "claude-fable-5-1", reasoningLevel: "medium" });
  // A model alone brings its agent.
  assert.deepEqual(await run("--model", "gpt-6-astra"), { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "medium" });
  // boat's id for a Claude model (as `task start --model` takes it) reaches bb as bb's id.
  assert.deepEqual(await run("--model", "opus-5-5"), { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "medium" });
  assert.deepEqual(await run("--reasoning-effort", "xhigh"), { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "xhigh" });
  // Another bb agent gets only what was named.
  assert.deepEqual(await run("--provider", "pi"), { providerId: "pi", model: undefined, reasoningLevel: undefined });
  // Levels outside the setting's are refused before anything starts.
  const max = await cli(...NEW, "--effort", "max");
  assert.notEqual(max.exitCode, 0);
  assert.match(max.stderr, /effort/);
});

test("one agent: new orchestrators start on it, whatever Agent for orchestrators says; an explicit --provider still wins", async (t) => {
  const { cli, last, harness } = await setup(t, { agents: "codex", relayPreferred: "claude" });
  assert.equal((await cli(...NEW)).exitCode, 0);
  assert.deepEqual(last(), { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high" });
  assert.equal((await cli(...NEW, "--provider", "claude-code")).exitCode, 0);
  assert.equal(last().providerId, "claude-code");
  // The dialog is told: Claude greyed out with the reason, Codex picked.
  const choices = (await harness.callRpc("orchestratorChoices", null)) as OrchestratorChoicesDto;
  assert.equal(choices.provider, "codex");
  assert.equal(choices.mainAgent, "claude");
  assert.deepEqual(choices.agents.map((agent) => [agent.provider, agent.available, agent.reason]), [["claude", false, "Coding agents is set to Only Codex"], ["codex", true, null]]);
});

test("Auto-detect with only Claude connected in boat.dev: Claude, and the dialog says why Codex isn't offered", async (t) => {
  const { cli, last, harness, patchBoat } = await setup(t, { agents: "auto", relayPreferred: "codex" });
  patchBoat({ connected: ["claude-subscription"] });
  await harness.callRpc("setup", { force: true });
  assert.equal((await cli(...NEW)).exitCode, 0);
  assert.deepEqual(last(), { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" });
  const choices = (await harness.callRpc("orchestratorChoices", null)) as OrchestratorChoicesDto;
  assert.equal(choices.provider, "claude");
  assert.deepEqual(choices.agents.find((agent) => agent.provider === "codex"), { provider: "codex", model: "gpt-6.1-sol", available: false, reason: "Not connected in boat.dev" });
});

test("the dialog's RPC: the settings by default, its agent and effort picks when given, and the same for a take-over", async (t) => {
  const { harness, last, spawns, cli } = await setup(t, { relayEnabled: true });
  const base = { project: { kind: "boat", id: "storefront" }, prompt: "Ship it", title: null, hostId: null, cloud: false };
  const choices = (await harness.callRpc("orchestratorChoices", null)) as OrchestratorChoicesDto;
  assert.deepEqual(choices, {
    agents: [
      { provider: "claude", model: "claude-opus-5-5", available: true, reason: null },
      { provider: "codex", model: "gpt-6.1-sol", available: true, reason: null },
    ],
    provider: "claude",
    mainAgent: "claude",
    effort: "high",
    switching: true,
  });
  const picks = () => (spawns.at(-1)!.pluginMetadata as { picks?: unknown }).picks;
  await harness.callRpc("startOrchestrator", base);
  assert.deepEqual(last(), { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" });
  assert.equal(picks(), undefined);
  // The dialog sends what it shows; only an effort other than the setting's stays with it (for switching).
  await harness.callRpc("startOrchestrator", { ...base, provider: "claude", effort: "high" });
  assert.equal(picks(), undefined);
  await harness.callRpc("startOrchestrator", { ...base, provider: "codex", effort: "xhigh" });
  assert.deepEqual(last(), { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "xhigh" });
  assert.deepEqual(picks(), { effort: "xhigh" });
  // Only the four levels.
  await assert.rejects(harness.callRpc("startOrchestrator", { ...base, effort: "max" }), /validation failed/);

  // Take over from a previous orchestrator: the same choice as a new one.
  assert.equal((await cli("config", "set", "orchestratorEffort", "low")).exitCode, 0);
  await harness.callRpc("startOrchestrator", { ...base, takeOverThreadId: "thr_o1" });
  assert.deepEqual(last(), { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "low" });
  assert.match(String(spawns.at(-1)!.prompt), /## Taking over from @thread:thr_o1/);
  await harness.callRpc("startOrchestrator", { ...base, takeOverThreadId: "thr_o2", provider: "codex", effort: "medium" });
  assert.deepEqual(last(), { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "medium" });

  // A settings change reaches the dialog.
  assert.equal(((await harness.callRpc("orchestratorChoices", null)) as OrchestratorChoicesDto).effort, "low");
});

test("Coordinate from this chat starts nothing and leaves the chat's model alone", async (t) => {
  const { harness, spawns } = await setup(t);
  await harness.callRpc("setOrchestrator", { threadId: "thr_chat", on: true, project: { kind: "boat", id: "storefront" } });
  assert.equal(spawns.length, 0);
  const updates = harness.inspection.sdk.callsTo("threads.update").map((call) => call[0] as Record<string, unknown>);
  assert.ok(updates.every((update) => !("model" in update) && !("providerId" in update) && !("reasoningLevel" in update)));
});
