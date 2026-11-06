// Model tiers and the orchestrator protocol.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EFFORT_VALUES, TIER_VALUES, tierMapSchema } from "../contract.ts";
import { AGENTS_PLACEHOLDER, DEFAULT_PROTOCOL, EVIDENCE_PLACEHOLDER, TIER_TABLE_PLACEHOLDER, WORKERS_PLACEHOLDER } from "../src/default-protocol.ts";
import { createRepoFileReader } from "../src/github.ts";
import { ORCHESTRATOR_INSTRUCTIONS, kickoffPrompt } from "../src/orchestrator.ts";
import type { OrchestratorProject } from "../src/projects.ts";
import { ProtocolStore, composeProtocol, loadProjectRules, renderSharedProtocol } from "../src/protocol.ts";
import { TaskError } from "../src/service.ts";
import { DEFAULT_TIERS, EFFORTS, TIERS, tierTable } from "../src/tiers.ts";
import { defaultSettings, makeService } from "./fakes.ts";

const REPORT = `Done.

=== REPORT ===
STATUS: done
PR: https://github.com/acme/web/pull/12
BRANCH: boat/x
SUMMARY: done
TESTS: ok
OPEN QUESTIONS: none
=== END REPORT ===`;

async function dispatch(env: ReturnType<typeof makeService>, overrides: Record<string, unknown> = {}) {
  const { task } = await env.service.launchTask(
    {
      title: "Add dark mode",
      role: "implement",
      brief: "Add a dark mode toggle.",
      repo: "acme/web",
      orchestratorThreadId: "thr_orch",
      ...overrides,
    },
    5_000,
  );
  return task;
}

// ------------------------------------------------------------------ tiers

test("the app's tier schema mirrors the server's", () => {
  assert.deepEqual([...TIER_VALUES], [...TIERS]);
  assert.deepEqual([...EFFORT_VALUES], [...EFFORTS]);
  assert.ok(tierMapSchema.safeParse(DEFAULT_TIERS).success);
});

test("the default tiers follow the protocol's model policy", () => {
  assert.deepEqual(DEFAULT_TIERS.light, { claude: { model: "claude-sonnet-5-5", effort: "high" }, codex: { model: "gpt-6.1-sol", effort: "medium" } });
  assert.deepEqual(DEFAULT_TIERS.review, { claude: { model: "claude-opus-5-5", effort: "high" }, codex: { model: "gpt-6.1-sol", effort: "high" } });
  assert.deepEqual(DEFAULT_TIERS.build, { claude: { model: "claude-opus-5-5", effort: "xhigh" }, codex: { model: "gpt-6.1-sol", effort: "xhigh" } });
  // Deep is Ultracode / Ultra in bb chats; boat conversations get max.
  assert.deepEqual(DEFAULT_TIERS.deep, { claude: { model: "claude-opus-5-5", effort: "ultracode" }, codex: { model: "gpt-6.1-sol", effort: "ultra" } });
  assert.deepEqual(DEFAULT_TIERS.frontier, { claude: { model: "claude-fable-5-1", effort: "xhigh" }, codex: { model: "gpt-6-astra", effort: "xhigh" } });
});

test("a tier picks model and effort, and the reason is logged per dispatch", async () => {
  const env = makeService();
  const task = await dispatch(env, { tier: "build", reason: "Normal feature work" });
  assert.equal(task.tier, "build");
  assert.equal(task.model, "opus-5-5");
  assert.equal(task.reasoningEffort, "xhigh");
  assert.equal(task.reason, "Normal feature work");
  assert.deepEqual(env.boat.prompts.at(-1)!.model, "opus-5-5");
  assert.deepEqual(env.boat.prompts.at(-1)!.effort, "xhigh");
  const dispatched = env.store.events(task.id).find((event) => event.kind === "dispatched");
  assert.equal(dispatched?.text, "Sent to claude · Build · opus-5-5 · xhigh — Normal feature work");
});

test("without a tier, implementers get Build and reviews get Review on the other agent", async () => {
  const env = makeService();
  const task = await dispatch(env);
  assert.equal(task.tier, "build");
  assert.equal(task.model, "opus-5-5");
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  const { task: review } = await env.service.launchTask(await env.service.reviewInput(task.id), 5_000);
  assert.equal(review.provider, "codex");
  assert.equal(review.tier, "review");
  assert.equal(review.model, "gpt-6.1-sol");
  assert.equal(review.reasoningEffort, "high");
});

test("a model configured in the settings is still used when no tier is given", async () => {
  const env = makeService({ settings: { implementModel: "opus-5", reasoningEffort: "high" } });
  const task = await dispatch(env);
  assert.equal(task.tier, null);
  assert.equal(task.model, "opus-5");
  assert.equal(task.reasoningEffort, "high");
  // An explicit tier still wins over the settings.
  const tiered = await dispatch(env, { tier: "light", title: "Rename a prop" });
  assert.equal(tiered.model, "claude-sonnet-5-5");
});

test("effort and model can be overridden within a tier (re-running a script: Light at medium)", async () => {
  const env = makeService();
  const run = await dispatch(env, { tier: "light", reasoningEffort: "medium", reason: "Re-run the build script" });
  assert.equal(run.model, "claude-sonnet-5-5");
  assert.equal(run.reasoningEffort, "medium");
  const successor = await dispatch(env, { tier: "build", model: "opus-5-6", title: "Use a newer model" });
  assert.equal(successor.tier, "build");
  assert.equal(successor.model, "opus-5-6");
  assert.equal(successor.reasoningEffort, "xhigh");
});

test("tiers come from the settings table", async () => {
  const env = makeService({
    settings: { modelTiers: { ...DEFAULT_TIERS, build: { claude: { model: "opus-6", effort: "high" }, codex: { model: "gpt-7", effort: "high" } } } },
  });
  const task = await dispatch(env, { tier: "build" });
  assert.equal(task.model, "opus-6");
  assert.equal(task.reasoningEffort, "high");
});

test("Frontier at max effort needs the user's approval", async () => {
  const env = makeService();
  await assert.rejects(
    dispatch(env, { tier: "frontier", reasoningEffort: "max" }),
    (error: unknown) => error instanceof TaskError && error.code === "frontier_needs_approval",
  );
  // Picking the frontier model by hand doesn't get around it.
  await assert.rejects(
    dispatch(env, { tier: "deep", model: "claude-fable-5-1" }),
    (error: unknown) => error instanceof TaskError && error.code === "frontier_needs_approval",
  );
  // Frontier at its default (xhigh) is fine; max with approval is logged.
  const xhigh = await dispatch(env, { tier: "frontier", reason: "Deep fell short twice" });
  assert.equal(xhigh.model, "claude-fable-5-1");
  assert.equal(xhigh.reasoningEffort, "xhigh");
  const approved = await dispatch(env, { tier: "frontier", reasoningEffort: "max", userApproved: true, title: "Approved max" });
  assert.equal(approved.reasoningEffort, "max");
  assert.ok(env.store.events(approved.id).some((event) => event.kind === "approval"));
});

test("Deep workers are told to explore with subagents and check independently", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 10;
  await dispatch(env, { tier: "deep" });
  // Claude: Ultracode's core, asked for directly (boat ignores the keyword), and wait within the turn.
  assert.match(env.boat.prompts.at(-1)!.text, /## Working mode\nThis is Deep work, run the way Ultracode would: use the Workflow tool/);
  assert.match(env.boat.prompts.at(-1)!.text, /wait for every workflow to finish/);
  await dispatch(env, { tier: "deep", provider: "codex", title: "Codex deep" });
  assert.match(env.boat.prompts.at(-1)!.text, /## Working mode\nThis is Deep work: the result gains/);
  assert.doesNotMatch(env.boat.prompts.at(-1)!.text, /Workflow tool/);
  await dispatch(env, { tier: "build", title: "Plain" });
  assert.doesNotMatch(env.boat.prompts.at(-1)!.text, /## Working mode/);
});

test("follow-ups keep the tier on the other agent, and can escalate it", async () => {
  const env = makeService();
  const task = await dispatch(env, { tier: "build", reason: "Feature" });
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();

  // Switching agent keeps the tier: Build on Codex.
  const switched = await env.service.followup(task.id, "Continue on Codex.", { provider: "codex" });
  assert.equal(switched.provider, "codex");
  assert.equal(switched.tier, "build");
  assert.equal(switched.model, "gpt-6.1-sol");
  assert.equal(switched.reasoningEffort, "xhigh");
  assert.equal(env.boat.prompts.at(-1)!.effort, "xhigh");
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();

  // Escalating to Deep changes model, effort and reason, and adds the working mode.
  const deep = await env.service.followup(task.id, "Still flaky; dig deeper.", { tier: "deep", reason: "Build attempt failed" });
  assert.equal(deep.tier, "deep");
  assert.equal(deep.reasoningEffort, "max");
  assert.equal(deep.reason, "Build attempt failed");
  assert.match(env.boat.prompts.at(-1)!.text, /This is Deep work: the result gains/);
  assert.ok(env.store.events(task.id).some((event) => event.kind === "model" && /Deep · gpt-6\.1-sol · max — Build attempt failed/.test(event.text)));
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();

  // Same agent and tier: the task keeps what it ran with.
  const same = await env.service.followup(task.id, "One more thing.");
  assert.equal(same.model, "gpt-6.1-sol");
  assert.equal(same.reasoningEffort, "max");
  assert.equal(same.reason, "Build attempt failed");
});

test("a usage-limit handover keeps the tier on the other agent", async () => {
  const env = makeService();
  const task = await dispatch(env, { tier: "review", role: "custom", title: "Audit" });
  env.boat.finish(task.conversationId!, "", "failed", "Claude usage limit reached, resets at 5pm");
  await env.service.sweep();
  const switched = env.store.get(task.id)!;
  assert.equal(switched.provider, "codex");
  assert.equal(switched.model, "gpt-6.1-sol");
  assert.equal(switched.reasoningEffort, "high");
  assert.equal(env.boat.prompts.at(-1)!.effort, "high");
  assert.match(env.store.events(task.id).at(-1)!.text, /continued with codex · Review · gpt-6\.1-sol · high/);
});

// --------------------------------------------------------------- protocol

const PROJECT: OrchestratorProject = {
  id: "storefront",
  name: "Storefront",
  repos: [{ repo: "acme/storefront", baseBranch: "master" }],
  environment: "storefront",
  snapshot: null,
  delivery: "pr",
  protocolPath: "docs/agents/orchestrator.md",
  workerMode: "chat",
  source: "boat",
  protectedBranches: [],
  instructions: "",
  bbProjectId: null,
};

test("the built-in protocol is adapted to boat: tools, tiers, reconcile on wake", () => {
  assert.ok(DEFAULT_PROTOCOL.includes(TIER_TABLE_PLACEHOLDER));
  for (const tool of ["boat_dispatch", "boat_followup", "boat_review", "boat_tasks"]) assert.ok(DEFAULT_PROTOCOL.includes(tool), tool);
  assert.match(DEFAULT_PROTOCOL, /Call `boat_tasks` and reconcile every open task/);
  assert.match(DEFAULT_PROTOCOL, /Light with `effort: "medium"`/);
  assert.doesNotMatch(DEFAULT_PROTOCOL, /conductor (session|workspace)|ledger\.md|--message-id/);
});

test("the built-in protocol is generic: no personal setup, setting-dependent facts are placeholders", () => {
  // The owner-specific effort guidance (a media pipeline) is gone.
  assert.doesNotMatch(DEFAULT_PROTOCOL, /pipeline|intake|receipts|re-crops/i);
  for (const placeholder of [WORKERS_PLACEHOLDER, AGENTS_PLACEHOLDER, EVIDENCE_PLACEHOLDER]) assert.ok(DEFAULT_PROTOCOL.includes(placeholder), placeholder);
  // Facts that depend on the settings aren't stated as fixed.
  assert.doesNotMatch(DEFAULT_PROTOCOL, /Claude is the default agent|regular bb chat on its own boat sandbox|links last 7 days/);
});

test("placeholders follow the settings: workers, agents, the relay and evidence uploads", () => {
  const render = (overrides: Parameters<typeof defaultSettings>[0]) => renderSharedProtocol(DEFAULT_PROTOCOL, DEFAULT_TIERS, defaultSettings(overrides));
  // Worker chats, both agents, the relay on, uploads on.
  const full = render({ workerMode: "chat", adhocWorkerMode: "boat", relay: { ...defaultSettings().relay, enabled: true }, evidenceUploader: "builtin" });
  assert.doesNotMatch(full, /\{\{[a-z-]+\}\}/);
  assert.match(full, /in projects that run tasks as chats, as a regular bb chat nested under your chat in the sidebar/);
  // As chats everywhere: only projects set to boat run headless.
  assert.match(render({ workerMode: "chat", adhocWorkerMode: "chat" }), /Each task runs on its own boat sandbox as a regular bb chat[^.]*\), except in projects set to run tasks in boat/);
  assert.match(full, /- Claude is the default agent\. A dispatch without `agent` starts on an agent with room: near Claude's limit it goes to Codex/);
  assert.match(full, /Claude and Codex are both near their limits/);
  assert.match(full, /handed to the other agent automatically/);
  assert.match(full, /You can be moved too/);
  assert.match(full, /evidence-upload --link <key>/);
  // Boat conversations, Codex as the default, relay off, no failover, paid extra usage allowed.
  const plain = render({ workerMode: "boat", implementProvider: "codex", relay: { ...defaultSettings().relay, enabled: false }, autoFailover: false, avoidExtraUsage: false });
  assert.match(plain, /Each task runs headless in boat on its own boat sandbox/);
  assert.match(plain, /- Codex is the default agent; a dispatch without `agent` uses it\./);
  assert.match(plain, /Paid extra usage is allowed/);
  assert.match(plain, /A task that hits its limit mid-turn stops/);
  assert.doesNotMatch(plain, /You can be moved too/);
  assert.match(plain, /Evidence uploads are off in the plugin settings/);
  assert.doesNotMatch(plain, /evidence-upload --link/);
  // Only Claude: no relay, no switching, reviews on Claude too.
  const single = render({ agents: "claude", relay: { ...defaultSettings().relay, enabled: true } });
  assert.match(single, /Only Claude is set up, so every task and review runs on Claude/);
  assert.match(single, /`agents_at_limit`, Claude is near its usage limit/);
  assert.doesNotMatch(single, /You can be moved too|handed to the other agent automatically/);
  // Without settings: general wording, nothing left unfilled.
  const general = renderSharedProtocol(DEFAULT_PROTOCOL, DEFAULT_TIERS);
  assert.doesNotMatch(general, /\{\{[a-z-]+\}\}/);
  assert.match(general, /depending on the plugin settings and the project/);
});

test("a custom protocol keeps working: its placeholders are filled, the others left alone", () => {
  const custom = renderSharedProtocol("# Mine\n\n{{agents}}\n\n{{model-tiers}}\n\n{{unknown}}\n", DEFAULT_TIERS, defaultSettings({ agents: "codex" }));
  assert.match(custom, /^# Mine\n\n- Only Codex is set up/);
  assert.match(custom, /\| Deep \| claude-opus-5-5 · ultracode \| gpt-6\.1-sol · ultra \|/);
  assert.match(custom, /\{\{unknown\}\}/);
  // Without any placeholder: unchanged, plus the tier table at the end.
  const bare = renderSharedProtocol("# Rules only\n", DEFAULT_TIERS, defaultSettings());
  assert.ok(bare.startsWith("# Rules only\n\n## Model presets (from the plugin settings)"));
});

test("the shared protocol gets the current tier table", () => {
  const rendered = renderSharedProtocol(DEFAULT_PROTOCOL, DEFAULT_TIERS);
  assert.ok(!rendered.includes(TIER_TABLE_PLACEHOLDER));
  assert.match(rendered, /\| Deep \| claude-opus-5-5 · ultracode \| gpt-6\.1-sol · ultra \|/);
  // A custom protocol without the placeholder still gets the table, at the end.
  const custom = renderSharedProtocol("# My rules\n", DEFAULT_TIERS);
  assert.ok(custom.startsWith("# My rules"));
  assert.ok(custom.trimEnd().endsWith(tierTable(DEFAULT_TIERS)));
});

test("the protocol is a file: built-in until saved, reset deletes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "boat-protocol-"));
  const store = new ProtocolStore(join(dir, "sub", "orchestrator-protocol.md"));
  assert.equal(store.read().custom, false);
  assert.equal(store.read().text, DEFAULT_PROTOCOL);
  const long = `# Mine\n${"x".repeat(20_000)}`;
  const saved = store.save(long);
  assert.equal(saved.custom, true);
  assert.equal(readFileSync(saved.path, "utf8"), `${long}\n`);
  assert.ok(saved.updatedAt);
  // Edited in an editor: read back as is.
  writeFileSync(saved.path, "# Edited elsewhere\n");
  assert.equal(store.read().text, "# Edited elsewhere\n");
  assert.throws(() => store.save("   "), /empty/);
  assert.throws(() => store.save("x".repeat(100_001)), /longer than/);
  assert.equal(store.reset().custom, false);
});

test("project rules come after the shared protocol", async () => {
  const reads: string[] = [];
  const rules = await loadProjectRules(PROJECT, async (repo, path, ref) => {
    reads.push(`${repo}:${path}@${ref}`);
    return "# Orchestrating work on this repo\nRules.";
  });
  assert.deepEqual(reads, ["acme/storefront:docs/agents/orchestrator.md@master"]);
  const text = composeProtocol("# Orchestrator protocol\nShared.", PROJECT, rules);
  assert.ok(text.indexOf("Shared.") < text.indexOf("# Project rules: Storefront"));
  assert.ok(text.indexOf("# Project rules: Storefront") < text.indexOf("# Orchestrating work on this repo"));
  assert.match(text, /Tasks still follow the repo's AGENTS\.md/);

  // Unreadable: say so, with the command to read it by hand.
  const failed = await loadProjectRules(PROJECT, async () => {
    throw new Error("HTTP 404");
  });
  const fallback = composeProtocol("Shared.", PROJECT, failed);
  assert.match(fallback, /Couldn't read `docs\/agents\/orchestrator\.md` from acme\/storefront \(master\): HTTP 404/);
  assert.match(fallback, /gh api -H "Accept: application\/vnd\.github\.raw" "repos\/acme\/storefront\/contents\/docs\/agents\/orchestrator\.md\?ref=master"/);

  // No rules file, or no project.
  assert.equal(await loadProjectRules({ ...PROJECT, protocolPath: null }, async () => "never"), null);
  assert.match(composeProtocol("Shared.", { ...PROJECT, protocolPath: null }, null), /has no rules file in its repo/);
  assert.match(composeProtocol("Shared.", null, null), /This chat has no project/);
});

test("repo files are read with gh (raw), with the path encoded", async () => {
  const fakeGh = new URL("./fixtures/fake-gh.mjs", import.meta.url).pathname;
  process.env.BOAT_PLUGIN_GH = fakeGh;
  process.env.FAKE_GH_FILES = JSON.stringify({ "acme/web:docs/agents/my rules.md@feature/x": "rules!" });
  try {
    const read = createRepoFileReader();
    assert.equal(await read("acme/web", "docs/agents/my rules.md", "feature/x"), "rules!");
    await assert.rejects(read("acme/web", "missing.md", "main"), /Not Found/);
    // Seen live: a signed-out gh read as "…:  To authenticate, please run `gh auth login`."
    process.env.FAKE_GH_SIGNED_OUT = "1";
    await assert.rejects(createRepoFileReader()("acme/web", "docs/agents/my rules.md", "feature/x"), (error: Error) => {
      assert.equal(error.message, "the GitHub CLI (gh) on the bb server's machine isn't signed in (run `gh auth login` there)");
      return true;
    });
  } finally {
    delete process.env.BOAT_PLUGIN_GH;
    delete process.env.FAKE_GH_FILES;
    delete process.env.FAKE_GH_SIGNED_OUT;
  }
});

test("orchestrators load the protocol first and reconcile on every wake", () => {
  assert.ok(ORCHESTRATOR_INSTRUCTIONS.length < 2500);
  assert.match(ORCHESTRATOR_INSTRUCTIONS, /call boat_protocol/);
  assert.match(ORCHESTRATOR_INSTRUCTIONS, /On every wake .* call boat_tasks first and reconcile every open task/);
  assert.match(kickoffPrompt({ project: PROJECT, prompt: "Ship it" }), /^You are a boat orchestrator for this chat\. First call boat_protocol/);
});

// ------------------------------------------------------- review fixes

test("an approved Frontier-at-max task keeps its approval on plain follow-ups", async () => {
  const env = makeService();
  const task = await dispatch(env, { tier: "frontier", reasoningEffort: "max", userApproved: true, reason: "Deep fell short" });
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  const next = await env.service.followup(task.id, "Fix the blocking issues.");
  assert.equal(next.reasoningEffort, "max");
  assert.equal(env.boat.prompts.at(-1)!.effort, "max");

  // Raising another task to Frontier·max on a follow-up still needs a new OK, and it's logged.
  const other = await dispatch(env, { tier: "deep", title: "Deep first" });
  env.boat.finish(other.conversationId!, REPORT);
  await env.service.sweep();
  await assert.rejects(
    env.service.followup(other.id, "Try Frontier.", { tier: "frontier", effort: "max" }),
    (error: unknown) => error instanceof TaskError && error.code === "frontier_needs_approval",
  );
  await env.service.followup(other.id, "Try Frontier.", { tier: "frontier", effort: "max", userApproved: true });
  assert.ok(env.store.events(other.id).some((event) => event.kind === "approval" && /follow-up/.test(event.text)));
});

test("a steer can't change tier, agent, model or effort", async () => {
  const env = makeService();
  const task = await dispatch(env, { tier: "build" });
  await assert.rejects(
    env.service.followup(task.id, "dig deeper", { steer: true, tier: "deep" }),
    (error: unknown) => error instanceof TaskError && error.code === "steer_cannot_change" && /model preset/.test(error.message),
  );
  await assert.rejects(
    env.service.followup(task.id, "switch", { steer: true, provider: "codex" }),
    (error: unknown) => error instanceof TaskError && /agent/.test(error.message),
  );
  // A plain steer still works, and the task keeps its tier.
  await env.service.followup(task.id, "focus on the header", { steer: true });
  assert.equal(env.store.get(task.id)!.tier, "build");
});

test("reviews are recorded on the implementer, so reconciling doesn't start a second one", async () => {
  const env = makeService();
  const task = await dispatch(env);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  const { task: review } = await env.service.launchTask(await env.service.reviewInput(task.id), 5_000);
  assert.match(env.store.latestEvent(task.id, "review")!.text, new RegExp(`Review ${review.id} started \\(codex · Review · gpt-6\\.1-sol · high\\)`));
  env.boat.finish(review.conversationId!, "Looks good.\n=== REVIEW ===\nVERDICT: approve\n=== END REVIEW ===");
  await env.service.sweep();
  assert.equal(env.store.latestEvent(task.id, "review")!.text, `Review ${review.id}: approve`);
  const { taskTable } = await import("../src/format.ts");
  const table = taskTable([env.store.get(task.id)!, env.store.get(review.id)!], (t) =>
    t.role === "implement" ? (env.store.latestEvent(t.id, "review")?.text ?? null) : null,
  );
  assert.match(table, new RegExp(`Review ${review.id}: approve`));
  assert.match(table, new RegExp(`reviews ${task.id}`));
});

test("a [boat] notice says when a turn was handed over on a usage limit", async () => {
  const env = makeService();
  const task = await dispatch(env, { tier: "build" });
  env.boat.finish(task.conversationId!, "", "failed", "Claude usage limit reached");
  await env.service.sweep();
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  const { notificationText } = await import("../src/format.ts");
  const text = notificationText([env.store.get(task.id)!], (id) => env.store.events(id, 30));
  assert.match(text, /Handed over on a usage limit: claude hit a usage limit; continued with codex/);
  assert.match(text, /`bb boat task list --mine`/);
});

test("the built-in protocol speaks the glossary: tasks, agents and model presets", () => {
  const rendered = renderSharedProtocol(DEFAULT_PROTOCOL, DEFAULT_TIERS, defaultSettings({ relay: { ...defaultSettings().relay, enabled: true } }));
  assert.doesNotMatch(rendered, /\bworkers?\b|implementer|\bslots?\b|boat conversation|\brelay on\b|Model tiers/i);
});
