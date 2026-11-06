// The whole plugin in bb's fake host, talking to a scripted fake boat CLI.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { createTestHost } from "./fakes.ts";

const fakeBoat = fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url));

async function setup(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "boat-plugin-test-"));
  const statePath = join(dir, "state.json");
  process.env.FAKE_BOAT_STATE = statePath;
  const { bb, harness } = await createTestHost({
    pluginId: "boat",
    // Most tests run tasks in boat; the chat test switches How tasks run (workers).
    // No network: the evidence uploader is off unless a test turns it on (with the fake gh).
    settings: { boatPath: fakeBoat, evidenceUploader: "", ...overrides },
    agentSkillIds: ["boat", "boat-orchestrator"],
  });
  harness.sdk.stub("threads.get", async () => ({ id: "thr_orch", environmentId: null, deletedAt: null, archivedAt: null }));
  harness.sdk.stub("threads.send", async () => ({ ok: true, delivery: "sent" }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({ role: "orchestrator" }));
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "orchestrator" }));
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
  await plugin(bb);
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const finishAll = (reply: string) => {
    const current = state();
    for (const convo of Object.values(current.convos) as { running: boolean; reply: string | null; sandboxId: string }[]) {
      convo.running = false;
      convo.reply = reply;
      current.sandboxes[convo.sandboxId].state = "idle";
    }
    writeFileSync(statePath, JSON.stringify(current));
  };
  return { bb, harness, state, finishAll };
}

/** The projects most tests work with (new installs start with none). */
async function addProjects(harness: Awaited<ReturnType<typeof setup>>["harness"]) {
  for (const args of [
    ["--name", "Storefront", "--repo", "acme/storefront@master", "--environment", "storefront", "--protocol", "docs/agents/orchestrator.md"],
    ["--name", "Storefront and API", "--repo", "acme/storefront@master", "--repo", "acme/api@main", "--environment", "storefront-api"],
    ["--name", "Docs", "--repo", "acme/docs@develop", "--environment", "docs"],
  ]) {
    const added = await harness.runCli(["project", "add", ...args]);
    assert.equal(added.exitCode, 0, added.stderr || added.stdout);
  }
}

/** bb Connect's status, as the connect plugin answers (null: the plugin isn't there). */
function stubConnect(harness: Awaited<ReturnType<typeof setup>>["harness"], status: { paired: boolean; enabled: boolean } | null) {
  harness.sdk.stub("plugins.callRpc", async ({ pluginId, method }: { pluginId: string; method: string }) => {
    if (pluginId !== "connect" || method !== "status") return { ok: true };
    if (status === null) throw new Error('unknown plugin "connect"');
    return { state: status.paired && status.enabled ? "connected" : "disconnected", ...status, handle: null, url: null };
  });
}

test("help, status and an end-to-end task through the CLI", async (t) => {
  const { harness, state, finishAll } = await setup();
  t.after(() => harness.lifecycle.dispose());

  const help = await harness.runCli(["--help"]);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /task start/);
  assert.match(help.stdout, /orchestrator new/);

  const status = await harness.runCli(["status", "--json"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).freeSlots, 2);

  const started = Date.now();
  const start = await harness.runCli(
    ["task", "start", "--title", "Add dark mode", "--repo", "acme/web", "--brief", "Add a toggle.", "--json"],
    { threadId: "thr_orch", projectId: "proj_1" },
  );
  assert.equal(start.exitCode, 0, start.stderr || start.stdout);
  assert.ok(Date.now() - started < 10_000, "dispatch must not wait for the agent's turn");
  const { task } = JSON.parse(start.stdout);
  assert.equal(task.status, "running");
  assert.equal(task.orchestratorThreadId, "thr_orch");
  const promptCall = state().calls.find((call: string[]) => call[0] === "prompt");
  assert.deepEqual(promptCall.slice(0, 7), ["prompt", "--json", task.sandboxId, "--provider", "claude", "--resume", task.conversationId]);
  assert.match(promptCall.at(-1), /# Implementation task/);

  finishAll("Done.\n=== REPORT ===\nSTATUS: done\nPR: https://github.com/acme/web/pull/9\n=== END REPORT ===");
  const show = await harness.runCli(["task", "show", task.id, "--refresh"]);
  assert.equal(show.exitCode, 0, show.stderr);
  assert.match(show.stdout, /waiting for you/);
  assert.match(show.stdout, /pull\/9/);

  const sends = harness.inspection.sdk.callsTo("threads.send");
  assert.equal(sends.length, 1);
  const sent = sends[0]![0] as { threadId: string; mode: string; input: { text: string }[] };
  assert.equal(sent.threadId, "thr_orch");
  assert.equal(sent.mode, "queue-if-active");
  assert.match(sent.input[0]!.text, /^\[boat\] Task t_[0-9a-f]+ finished a turn\./);

  const close = await harness.runCli(["task", "close", task.id]);
  assert.equal(close.exitCode, 0, close.stderr);
  assert.match(close.stdout, /Sandbox: deleted/);
  assert.equal(Object.keys(state().sandboxes).length, 0);
});

test("CLI errors carry codes and hints", async (t) => {
  const { harness } = await setup();
  t.after(() => harness.lifecycle.dispose());
  const missing = await harness.runCli(["task", "show", "t_nope", "--json"]);
  assert.notEqual(missing.exitCode, 0);
  assert.equal(JSON.parse(missing.stdout).error.code, "task_not_found");

  const both = await harness.runCli(["task", "start", "--title", "x"]);
  assert.notEqual(both.exitCode, 0);
  assert.match(both.stderr, /brief/);
});

test("orchestrator threads get tools, the playbook skill and instructions", async (t) => {
  const { harness } = await setup();
  t.after(() => harness.lifecycle.dispose());

  const orchestrator = await harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ pluginMetadata: { role: "orchestrator" } }),
  );
  const names = orchestrator.tools.map((tool) => tool.name);
  assert.ok(names.includes("boat_dispatch"));
  assert.ok(names.includes("boat_review"));
  assert.ok(names.includes("boat_protocol"));
  assert.deepEqual(orchestrator.skills.sort(), ["boat", "boat-orchestrator"]);
  assert.match(orchestrator.instructions ?? "", /call boat_tasks first and reconcile/);
  assert.match(orchestrator.instructions ?? "", /do not do it yourself/);

  const plain = await harness.resolveAgentConfiguration(makePluginAgentConfigurationContext());
  assert.deepEqual(plain.tools, []);
  assert.deepEqual(plain.skills, ["boat"]);

  const on = await harness.runCli(["orchestrator", "on"], { threadId: "thr_x" });
  assert.equal(on.exitCode, 0, on.stderr);
  const list = await harness.runCli(["orchestrator", "list"]);
  assert.match(list.stdout, /thr_x/);
});

test("agent tools and UI RPC share the same task registry", async (t) => {
  const { harness } = await setup();
  t.after(() => harness.lifecycle.dispose());

  const result = await harness.callAgentTool(
    "boat_dispatch",
    { title: "Fix login", brief: "Fix it.", repo: "acme/web", agent: "codex", tier: "light", reason: "Exact copy change" },
    { threadId: "thr_orch", projectId: "proj_1" },
  );
  const text = typeof result === "string" ? result : result.content.map((part) => ("text" in part ? part.text : "")).join("");
  assert.match(text, /dispatched \(implement\)/);
  assert.match(text, /Agent: codex · Light · gpt-6\.1-sol · medium — Exact copy change/);

  const tasks = (await harness.callRpc("tasks", { statuses: null, threadId: "thr_orch", limit: 10 })) as {
    tasks: { provider: string; tier: string | null; model: string | null; reasoningEffort: string | null; reason: string | null }[];
  };
  assert.equal(tasks.tasks.length, 1);
  const [row] = tasks.tasks;
  assert.deepEqual(
    { provider: row!.provider, tier: row!.tier, model: row!.model, effort: row!.reasoningEffort, reason: row!.reason },
    { provider: "codex", tier: "light", model: "gpt-6.1-sol", effort: "medium", reason: "Exact copy change" },
  );

  const overview = (await harness.callRpc("overview", null)) as { limits: { tier: string } | null; activeSandboxes: number; defaults: { autoFailover: boolean } };
  assert.equal(overview.limits?.tier, "trial");
  assert.equal(overview.activeSandboxes, 1);
  // Both agents and switching on limits on (the default): follow-ups may move.
  assert.equal(overview.defaults.autoFailover, true);

  const byThread = (await harness.callRpc("tasksByThread", { keys: ["thr_orch", "thr_none"] })) as Record<string, unknown[]>;
  assert.equal(byThread.thr_orch!.length, 1);
  assert.equal(byThread.thr_none!.length, 0);
});

test("orchestrators need a project, store it, and dispatches default from it", async (t) => {
  const { harness, state } = await setup();
  t.after(() => harness.lifecycle.dispose());

  // A new install has no projects; the list says how to add the first one.
  assert.deepEqual(JSON.parse((await harness.runCli(["project", "list", "--json"])).stdout).projects, []);
  assert.match((await harness.runCli(["project", "list"])).stdout, /No projects yet\. Add your first one: `bb boat project add --name "Web app" --repo acme\/web@main`/);
  await addProjects(harness);
  const listed = await harness.runCli(["project", "list", "--json"]);
  assert.deepEqual(
    JSON.parse(listed.stdout).projects.map((project: { id: string }) => project.id),
    ["storefront", "storefront-and-api", "docs"],
  );

  const missing = await harness.runCli(["orchestrator", "new", "--prompt", "Fix the header"]);
  assert.notEqual(missing.exitCode, 0);
  assert.match(missing.stderr, /--project/);

  const unknown = await harness.runCli(["orchestrator", "new", "--project", "nope", "--prompt", "x", "--json"]);
  assert.equal(JSON.parse(unknown.stdout).error.code, "project_not_found");

  // An earlier orchestrator with an open task, to take over from.
  const old = await harness.runCli(
    ["task", "start", "--title", "Old work", "--repo", "acme/web", "--brief", "b", "--json"],
    { threadId: "thr_old" },
  );
  assert.equal(old.exitCode, 0, old.stderr || old.stdout);
  const oldTask = JSON.parse(old.stdout).task;

  let spawnArgs: Record<string, unknown> = {};
  harness.sdk.stub("threads.spawn", async (args: Record<string, unknown>) => {
    spawnArgs = args;
    return { id: "thr_new" };
  });
  harness.sdk.stub("threads.output", async () => ({ output: "Ledger: t_x running" }));
  stubConnect(harness, { paired: true, enabled: true });
  const started = await harness.runCli([
    "orchestrator", "new", "--project", "docs", "--prompt", "Polish the sidebar", "--take-over", "thr_old", "--json",
  ]);
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  assert.deepEqual(JSON.parse(started.stdout).movedTaskIds, [oldTask.id]);
  const metadata = spawnArgs.pluginMetadata as { role: string; project: { id: string; repos: unknown[]; environment: string } };
  assert.equal(metadata.role, "orchestrator");
  assert.equal(metadata.project.id, "docs");
  assert.equal(metadata.project.environment, "docs");
  // Cloud by default when bb Connect is set up: a new boat sandbox machine.
  assert.deepEqual(spawnArgs.environment, { type: "provider", environmentProviderId: "boat-sandbox-personal" });
  assert.match(String(spawnArgs.prompt), /Project: Docs/);
  assert.match(String(spawnArgs.prompt), /Taking over from @thread:thr_old/);
  assert.match(String(spawnArgs.prompt), /> Ledger: t_x running/);

  // The new orchestrator dispatches without naming a repo.
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "orchestrator", project: metadata.project }));
  const dispatched = await harness.runCli(
    ["task", "start", "--title", "Sidebar spacing", "--brief", "Tighten it.", "--json"],
    { threadId: "thr_new" },
  );
  assert.equal(dispatched.exitCode, 0, dispatched.stderr || dispatched.stdout);
  const task = JSON.parse(dispatched.stdout).task;
  assert.equal(task.repo, "acme/docs");
  assert.equal(task.baseBranch, "develop");
  assert.equal(task.environment, "docs");
  const newCall = state().calls.filter((call: string[]) => call[0] === "new").at(-1);
  assert.ok(newCall.includes("--environment") && newCall.includes("docs"), JSON.stringify(newCall));
  const execCall = state().calls.filter((call: string[]) => call[0] === "exec" && !call.at(-1)!.includes("BOAT_MEM_PROBE")).at(-1);
  assert.match(execCall.at(-1), /pre-push/);
  assert.match(execCall.at(-1), /'develop'/);
});

test("cloud orchestrators need bb Connect: the default follows it, and --cloud without it fails early", async (t) => {
  const { harness } = await setup();
  t.after(() => harness.lifecycle.dispose());
  await addProjects(harness);
  const spawned: Record<string, unknown>[] = [];
  harness.sdk.stub("threads.spawn", async (args: Record<string, unknown>) => {
    spawned.push(args);
    return { id: `thr_o${spawned.length}` };
  });
  const local = { type: "host", workspace: { type: "personal" } };
  // Not signed in: a local orchestrator by default, and --cloud says what to do.
  stubConnect(harness, { paired: false, enabled: true });
  const plain = await harness.runCli(["orchestrator", "new", "--project", "docs", "--prompt", "One", "--json"]);
  assert.equal(plain.exitCode, 0, plain.stderr || plain.stdout);
  assert.deepEqual(spawned.at(-1)!.environment, local);
  // …and it says why, and what to set up.
  assert.equal(JSON.parse(plain.stdout).cloud, false);
  assert.match(JSON.parse(plain.stdout).note, /^Started on this computer: cloud orchestrators need bb Connect\. Sign this bb in[\s\S]*bb account login/);
  const text = await harness.runCli(["orchestrator", "new", "--project", "docs", "--prompt", "One again"]);
  assert.match(text.stdout, /^Started orchestrator @thread:thr_o2\nStarted on this computer: cloud orchestrators need bb Connect\./);
  // Asked for this computer: no note.
  const asked = await harness.runCli(["orchestrator", "new", "--project", "docs", "--prompt", "One more", "--local", "--json"]);
  assert.equal(JSON.parse(asked.stdout).note, null);
  const cloud = await harness.runCli(["orchestrator", "new", "--project", "docs", "--prompt", "Two", "--cloud", "--json"]);
  assert.notEqual(cloud.exitCode, 0);
  const error = JSON.parse(cloud.stdout).error as { code: string; message: string; hint?: string };
  assert.equal(error.code, "connect_required");
  assert.match(`${error.message} ${error.hint}`, /needs bb Connect[\s\S]*bb account login[\s\S]*--local/);
  assert.equal(spawned.length, 3, "nothing started");
  // The status is cached for 30 s: each step below reads it later than that.
  let ahead = 0;
  const later = async <T>(run: () => Promise<T>): Promise<T> => {
    ahead += 31_000;
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + ahead });
    try {
      return await run();
    } finally {
      t.mock.timers.reset();
    }
  };
  // The connect plugin turned off: the same.
  stubConnect(harness, null);
  const off = await later(() => harness.runCli(["orchestrator", "new", "--project", "docs", "--prompt", "Three", "--cloud", "--json"]));
  assert.equal(JSON.parse(off.stdout).error.code, "connect_required");
  assert.match(JSON.parse(off.stdout).error.hint, /Turn on the bb connect plugin/);
  // Status unknown: nothing is blocked, but the default stays local.
  harness.sdk.stub("plugins.callRpc", async () => {
    throw new Error("timed out");
  });
  const unknown = await later(() => harness.runCli(["orchestrator", "new", "--project", "docs", "--prompt", "Four", "--json"]));
  assert.equal(unknown.exitCode, 0, unknown.stderr || unknown.stdout);
  assert.deepEqual(spawned.at(-1)!.environment, local);
  assert.match(JSON.parse(unknown.stdout).note, /couldn't check bb Connect[\s\S]*--cloud/);
  // The overview tells the dialog.
  stubConnect(harness, { paired: true, enabled: false });
  const overview = (await later(() => harness.callRpc("overview", null))) as { connect: { state: string; fix: string | null } };
  assert.equal(overview.connect.state, "off");
  assert.match(overview.connect.fix ?? "", /^Turn remote access back on with `bb connect on`\.$/);
});

test("projects can be added and removed from the CLI", async (t) => {
  const { harness } = await setup();
  t.after(() => harness.lifecycle.dispose());
  const added = await harness.runCli([
    "project", "add", "--name", "Docs", "--repo", "acme/docs@trunk", "--repo", "acme/theme@main", "--environment", "docs", "--json",
  ]);
  assert.equal(added.exitCode, 0, added.stderr || added.stdout);
  assert.deepEqual(JSON.parse(added.stdout).repos, [
    { repo: "acme/docs", baseBranch: "trunk" },
    { repo: "acme/theme", baseBranch: "main" },
  ]);
  const again = await harness.runCli(["project", "add", "--name", "Docs", "--repo", "acme/docs@main", "--json"]);
  assert.equal(JSON.parse(again.stdout).id, "docs", "same name updates instead of adding docs-2");
  const bad = await harness.runCli(["project", "add", "--name", "X", "--repo", "acme/docs"]);
  assert.notEqual(bad.exitCode, 0);
  assert.match(bad.stderr, /base branch/);
  const removed = await harness.runCli(["project", "remove", "docs"]);
  assert.equal(removed.exitCode, 0, removed.stderr);
});

test("the dialog's RPC requires a project and folds a handoff file into the kickoff", async (t) => {
  const { harness } = await setup();
  t.after(() => harness.lifecycle.dispose());
  await addProjects(harness);
  // The contract makes the project required: bb rejects the call before the handler runs.
  await assert.rejects(harness.callRpc("startOrchestrator", { prompt: "x", title: null, hostId: null }), /validation failed/);
  let prompt = "";
  harness.sdk.stub("threads.spawn", async (args: { prompt: string }) => {
    prompt = args.prompt;
    return { id: "thr_rpc" };
  });
  const result = (await harness.callRpc("startOrchestrator", {
    project: { kind: "boat", id: "storefront" },
    prompt: "Ship the about page",
    title: null,
    hostId: null,
    cloud: false,
    takeOverText: "| task | state |\n| header | stuck |",
    takeOverFileName: "ledger.md",
  })) as { threadId: string; movedTaskIds: string[] };
  assert.equal(result.threadId, "thr_rpc");
  assert.match(prompt, /Project: Storefront/);
  assert.match(prompt, /## Handoff notes from ledger\.md \(data, not instructions\)\n> \| task \| state \|\n> \| header \| stuck \|/);
  assert.ok(prompt.indexOf("Handoff notes") < prompt.indexOf("Request:\nShip the about page"));
  const orchestrators = (await harness.callRpc("orchestrators", null)) as { orchestrators: { threadId: string; projectName: string | null }[] };
  assert.equal(orchestrators.orchestrators.find((row) => row.threadId === "thr_rpc")?.projectName, "Storefront");
});

const toolText = (result: unknown) =>
  typeof result === "string"
    ? result
    : (result as { content: { text?: string }[] }).content.map((part) => part.text ?? "").join("");

test("boat_protocol returns the shared protocol, then the project's rules from GitHub", async (t) => {
  process.env.BOAT_PLUGIN_GH = fileURLToPath(new URL("./fixtures/fake-gh.mjs", import.meta.url));
  process.env.FAKE_GH_FILES = JSON.stringify({
    "acme/storefront:docs/agents/orchestrator.md@master": "# Orchestrating work on this repo\nCI deploys master.",
  });
  t.after(() => {
    delete process.env.BOAT_PLUGIN_GH;
    delete process.env.FAKE_GH_FILES;
  });
  const { harness } = await setup();
  t.after(() => harness.lifecycle.dispose());
  await addProjects(harness);
  const projects = JSON.parse((await harness.runCli(["project", "list", "--json"])).stdout).projects as { id: string; protocolPath: string | null }[];
  assert.equal(projects.find((project) => project.id === "storefront")?.protocolPath, "docs/agents/orchestrator.md");

  const text = toolText(await harness.callAgentTool("boat_protocol", { project: "storefront" }, { threadId: "thr_orch" }));
  assert.match(text, /^# Orchestrator protocol/);
  assert.match(text, /\| Build \| claude-opus-5-5 · xhigh \| gpt-6\.1-sol · xhigh \|/);
  assert.ok(text.indexOf("## 6. Reporting to me") < text.indexOf("# Project rules: Storefront"));
  assert.match(text, /CI deploys master\./);
  // The placeholders are filled from the settings (tasks in boat, both agents, no uploads).
  assert.doesNotMatch(text, /\{\{(workers|agents|evidence|model-tiers)\}\}/);
  assert.match(text, /Each task runs headless in boat on its own boat sandbox/);
  assert.match(text, /Evidence uploads are off in the plugin settings/);

  // The CLI prints the same; a project without a rules file says so.
  const cli = await harness.runCli(["protocol", "show", "--project", "docs"]);
  assert.equal(cli.exitCode, 0, cli.stderr);
  assert.match(cli.stdout, /# Project rules: Docs\n\nThis project has no rules file/);
  const shared = await harness.runCli(["protocol", "show", "--shared"]);
  assert.doesNotMatch(shared.stdout, /# Project rules/);
});

test("the protocol and tier table are edited over RPC and apply to the next dispatch", async (t) => {
  const { harness } = await setup();
  t.after(() => harness.lifecycle.dispose());

  const before = (await harness.callRpc("protocol", null)) as { custom: boolean; text: string; path: string; defaultText: string };
  assert.equal(before.custom, false);
  assert.equal(before.text, before.defaultText);
  assert.match(before.path, /orchestrator-protocol\.md$/);
  await harness.callRpc("saveProtocol", { text: "# House rules\nAlways Deep.\n\n{{model-tiers}}" });
  const saved = (await harness.callRpc("protocol", null)) as { custom: boolean; text: string };
  assert.equal(saved.custom, true);
  assert.equal(readFileSync(before.path, "utf8"), "# House rules\nAlways Deep.\n\n{{model-tiers}}\n");
  const shown = await harness.runCli(["protocol", "show", "--shared"]);
  assert.match(shown.stdout, /^# House rules\nAlways Deep\.\n\n\| Tier \|/);
  await assert.rejects(harness.callRpc("saveProtocol", { text: "  " }), /empty/);
  await harness.callRpc("resetProtocol", null);
  assert.equal(((await harness.callRpc("protocol", null)) as { custom: boolean }).custom, false);

  // Tier table: a newer Build model applies to the next dispatch.
  const tiers = (await harness.callRpc("modelTiers", null)) as { tiers: Record<string, Record<string, { model: string; effort: string }>>; custom: boolean };
  assert.equal(tiers.custom, false);
  const next = structuredClone(tiers.tiers);
  next.build!.claude = { model: "opus-5-6", effort: "high" };
  await harness.callRpc("saveModelTiers", { tiers: next });
  const result = toolText(
    await harness.callAgentTool(
      "boat_dispatch",
      { title: "Fix login", brief: "Fix it.", repo: "acme/web", tier: "build", reason: "Normal fix" },
      { threadId: "thr_orch", projectId: "proj_1" },
    ),
  );
  assert.match(result, /Agent: claude · Build · opus-5-6 · high — Normal fix/);
  await assert.rejects(
    harness.callRpc("saveModelTiers", { tiers: { ...next, light: { claude: { model: "bad model!", effort: "high" }, codex: next.light!.codex } } }),
    /validation failed|model id/i,
  );
  await harness.callRpc("resetModelTiers", null);
  assert.equal(((await harness.callRpc("modelTiers", null)) as { custom: boolean }).custom, false);
});

test("boat_dispatch needs a tier and a reason; Frontier at max needs approval", async (t) => {
  const { harness } = await setup();
  t.after(() => harness.lifecycle.dispose());
  await assert.rejects(
    harness.callAgentTool("boat_dispatch", { title: "x", brief: "y", repo: "acme/web" }, { threadId: "thr_orch" }),
    /tier/,
  );
  const refused = await harness.callAgentTool(
    "boat_dispatch",
    { title: "x", brief: "y", repo: "acme/web", tier: "frontier", effort: "max", reason: "Deep fell short" },
    { threadId: "thr_orch" },
  );
  assert.equal((refused as { isError?: boolean }).isError, true);
  assert.match(toolText(refused), /need the user's approval/);
});

test("boat_transcript shows when the worker was last active", async (t) => {
  const { harness, finishAll } = await setup();
  t.after(() => harness.lifecycle.dispose());
  const dispatched = toolText(
    await harness.callAgentTool(
      "boat_dispatch",
      { title: "Fix login", brief: "Fix it.", repo: "acme/web", tier: "build", reason: "Normal fix" },
      { threadId: "thr_orch" },
    ),
  );
  const id = /Task (t_[0-9a-f]+)/.exec(dispatched)![1]!;
  finishAll("done");
  const text = toolText(await harness.callAgentTool("boat_transcript", { task_id: id }, { threadId: "thr_orch" }));
  assert.match(text, /^Task t_[0-9a-f]+ is \w+\. Last agent activity: .+ ago \(now \d\d:\d\d UTC\)\./);
  assert.match(text, /\d\d:\d\d:\d\d {2}▶ prompt/);
});

test("new orchestrators go into their project's section (created once), or Pinned", async (t) => {
  const { harness } = await setup();
  t.after(() => harness.lifecycle.dispose());
  await addProjects(harness);
  const sections: { id: string; name: string }[] = [{ id: "sec_old", name: "Later" }];
  harness.sdk.stub("threadSections.list", async () => sections);
  harness.sdk.stub("threadSections.create", async (args: { name: string }) => {
    const section = { id: `sec_${sections.length}`, name: args.name };
    sections.push(section);
    return section;
  });
  const spawned: Record<string, unknown>[] = [];
  harness.sdk.stub("threads.spawn", async (args: Record<string, unknown>) => {
    spawned.push(args);
    return { id: `thr_o${spawned.length}` };
  });
  for (const prompt of ["One", "Two"]) {
    const result = await harness.runCli(["orchestrator", "new", "--project", "docs", "--prompt", prompt, "--local", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  }
  assert.deepEqual(sections.map((section) => section.name), ["Later", "Docs"]);
  assert.equal(spawned[0]!.sectionId, "sec_1");
  assert.equal(spawned[1]!.sectionId, "sec_1"); // reused, not duplicated
  assert.equal(spawned[0]!.pinned, undefined);
});

test("a chat made an orchestrator joins its project's section, unless it already has one", async (t) => {
  const { harness } = await setup();
  t.after(() => harness.lifecycle.dispose());
  await addProjects(harness);
  harness.sdk.stub("threadSections.list", async () => [{ id: "sec_docs", name: "Docs" }]);
  const placed: Record<string, string | null> = { thr_plain: null, thr_filed: "sec_mine" };
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({ id: threadId, sectionId: placed[threadId] ?? null }));
  const updates: Record<string, unknown>[] = [];
  harness.sdk.stub("threads.update", async (args: Record<string, unknown>) => {
    updates.push(args);
    return { id: args.threadId };
  });
  for (const threadId of ["thr_plain", "thr_filed"]) {
    const result = await harness.runCli(["orchestrator", "on", "--project", "docs"], { threadId });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  }
  assert.deepEqual(updates, [{ threadId: "thr_plain", sectionId: "sec_docs" }]);
});

test("taking over re-parents the old orchestrator's worker chats", async (t) => {
  const { harness, bb } = await setup();
  t.after(() => harness.lifecycle.dispose());
  await addProjects(harness);
  // A chat task of the old orchestrator, as the store would hold it.
  const { TaskStore } = await import("../src/store.ts");
  const store = new TaskStore(() => bb.storage.database());
  const now = new Date().toISOString();
  store.insert({
    id: "t_chat01", title: "Header", role: "implement", status: "idle", orchestratorThreadId: "thr_old", projectId: null,
    repo: "acme/web", repoPath: null, branch: null, baseBranch: null, sandboxId: "bx_1", conversationId: null, promptId: null,
    provider: "claude", model: null, reasoningEffort: null, tier: null, reason: null, runner: "chat", threadId: "thr_worker",
    hostId: "host_1", environmentId: "env_1", readyAt: null, readyNote: null, delivery: "pr", boatProject: null, environment: null, snapshot: null, extraRepos: [], brief: "b",
    parentTaskId: null, prUrl: null, result: null, error: null, turns: 1, ownsSandbox: true, createdAt: now, updatedAt: now,
    finishedAt: now, notifiedAt: now, unshipped: null,
  });
  store.addEvent("t_chat01", "chat", "thr_worker");
  const updates: Record<string, unknown>[] = [];
  harness.sdk.stub("threads.update", async (args: Record<string, unknown>) => {
    updates.push(args);
    return { id: args.threadId };
  });
  harness.sdk.stub("threads.spawn", async () => ({ id: "thr_new" }));
  harness.sdk.stub("threadSections.list", async () => [{ id: "sec_p", name: "Storefront" }]);
  const result = await harness.runCli(["orchestrator", "new", "--project", "storefront", "--prompt", "Continue", "--take-over", "thr_old", "--local", "--json"]);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).movedTaskIds, ["t_chat01"]);
  assert.deepEqual(updates, [{ threadId: "thr_worker", parentThreadId: "thr_new", sectionId: "sec_p" }]);
});

test("decisions and ready marks reach the overview; answering on the overview messages the orchestrator", async (t) => {
  const { harness, finishAll } = await setup();
  t.after(() => harness.lifecycle.dispose());
  const dispatched = toolText(
    await harness.callAgentTool(
      "boat_dispatch",
      { title: "Header", brief: "Fix it.", repo: "acme/web", tier: "build", reason: "Normal fix" },
      { threadId: "thr_orch" },
    ),
  );
  const taskId = /Task (t_[0-9a-f]+)/.exec(dispatched)![1]!;
  const asked = toolText(
    await harness.callAgentTool(
      "boat_needs_you",
      { question: "Variant A or B?", recommendation: "B: calmer, matches the grid", options: ["A", "B"], task_ids: [taskId] },
      { threadId: "thr_orch" },
    ),
  );
  const decisionId = /Decision (d_[0-9a-f]+)/.exec(asked)![1]!;
  assert.match(asked, /\/plugins\/boat\/cloud-agents\/orchestrator\/thr_orch/);

  // boat_tasks shows the open decision and the overview link.
  const listed = toolText(await harness.callAgentTool("boat_tasks", {}, { threadId: "thr_orch" }));
  assert.match(listed, new RegExp(`${decisionId}  Variant A or B\\?  — you recommended: B: calmer`));
  assert.match(listed, /Overview for the user: \[Cloud agents\]\(\/plugins\/boat\/cloud-agents\/orchestrator\/thr_orch\)/);

  // The turn finishes; marking it ready moves it to Ready to review.
  finishAll("done\n=== REPORT ===\nSTATUS: done\nPR: https://github.com/acme/web/pull/7\n=== END REPORT ===");
  await harness.callRpc("refresh", null);
  await harness.callAgentTool("boat_ready", { task_id: taskId, note: "Check the header spacing" }, { threadId: "thr_orch" });
  const board = (await harness.callRpc("board", { threadId: "thr_orch" })) as {
    needsYou: { id: string; recommendation: string }[];
    ready: { id: string; phase: string; readyNote: string | null; prUrl: string | null }[];
    running: unknown[];
  };
  assert.deepEqual(board.needsYou.map((entry) => entry.id), [decisionId]);
  assert.equal(board.ready[0]!.id, taskId);
  assert.equal(board.ready[0]!.phase, "ready");
  assert.equal(board.ready[0]!.readyNote, "Check the header spacing");
  assert.equal(board.ready[0]!.prUrl, "https://github.com/acme/web/pull/7");

  // Accepting the recommendation on the overview tells the orchestrator and closes it.
  const sent: { threadId: string; input: { text: string }[] }[] = [];
  harness.sdk.stub("threads.send", async (args: { threadId: string; input: { text: string }[] }) => {
    sent.push(args);
    return { ok: true, delivery: "sent" };
  });
  await harness.callRpc("answerDecision", { id: decisionId, accept: true, answer: null });
  assert.equal(sent[0]!.threadId, "thr_orch");
  assert.equal(sent[0]!.input[0]!.text, `Decision ${decisionId}: Variant A or B?\nGo with your recommendation: B: calmer, matches the grid`);
  const after = (await harness.callRpc("board", { threadId: "thr_orch" })) as { needsYou: unknown[] };
  assert.equal(after.needsYou.length, 0);
  await assert.rejects(harness.callRpc("answerDecision", { id: decisionId, accept: true, answer: null }), /already answered/);

  // boat_resolve closes one the user answered in chat.
  const second = toolText(
    await harness.callAgentTool("boat_needs_you", { question: "Merge now?", recommendation: "Yes" }, { threadId: "thr_orch" }),
  );
  const secondId = /Decision (d_[0-9a-f]+)/.exec(second)![1]!;
  assert.match(toolText(await harness.callAgentTool("boat_resolve", { decision_id: secondId, answer: "Yes" }, { threadId: "thr_orch" })), /answered/);
});

test("the CLI covers decisions and ready marks too", async (t) => {
  const { harness, finishAll } = await setup();
  t.after(() => harness.lifecycle.dispose());
  const started = await harness.runCli(["task", "start", "--title", "Header", "--repo", "acme/web", "--brief", "b", "--json"], { threadId: "thr_orch" });
  const taskId = JSON.parse(started.stdout).task.id as string;
  const added = await harness.runCli(
    ["decision", "add", "--question", "A or B?", "--recommendation", "B", "--option", "A", "--option", "B", "--task", taskId, "--json"],
    { threadId: "thr_orch" },
  );
  assert.equal(added.exitCode, 0, added.stderr);
  const decision = JSON.parse(added.stdout) as { id: string; options: string[]; taskIds: string[] };
  assert.deepEqual(decision.options, ["A", "B"]);
  assert.deepEqual(decision.taskIds, [taskId]);
  assert.match((await harness.runCli(["decision", "list"], { threadId: "thr_orch" })).stdout, /A or B\?/);
  finishAll("done\n=== REPORT ===\nSTATUS: done\nPR: none\n=== END REPORT ===");
  await harness.callRpc("refresh", null);
  const ready = await harness.runCli(["task", "ready", taskId, "--note", "Look at it"], { threadId: "thr_orch" });
  assert.equal(ready.exitCode, 0, ready.stderr);
  assert.match(ready.stdout, /Ready to review: \[Cloud agents\]\(\/plugins\/boat\/cloud-agents\/orchestrator\/thr_orch\)/);
  const resolved = await harness.runCli(["decision", "resolve", decision.id, "--answer", "B"]);
  assert.match(resolved.stdout, /answered/);
  assert.notEqual((await harness.runCli(["decision", "resolve", decision.id, "--answer", "B"])).exitCode, 0);
});

test("a new install's defaults: boat conversations, the relay off, both agents, main and master protected", async (t) => {
  const { harness, state } = await setup({ workerMode: undefined });
  t.after(() => harness.lifecycle.dispose());
  const relay = JSON.parse((await harness.runCli(["relay", "status", "--json"])).stdout) as { relay: { enabled: boolean }; agents: string };
  assert.equal(relay.relay.enabled, false);
  assert.equal(relay.agents, "both");
  // Even a project that trusts its repos gets boat conversations (worker chats are opt-in).
  await addProjects(harness);
  const started = await harness.runCli(["task", "start", "--project", "docs", "--title", "x", "--brief", "b", "--json"], { threadId: "thr_orch" });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  assert.equal(JSON.parse(started.stdout).task.runner, "boat");
  const prepare = state().calls.filter((call: string[]) => call[0] === "exec" && !call.at(-1)!.includes("BOAT_MEM_PROBE")).at(-1);
  assert.match(prepare.at(-1), /printf '%s\\n' 'main' 'master'; \}/);
});

test("extra protected branches from the settings reach every sandbox", async (t) => {
  const { harness, state } = await setup({ extraProtectedBranches: "staging, release/eu" });
  t.after(() => harness.lifecycle.dispose());
  const started = await harness.runCli(["task", "start", "--title", "x", "--repo", "acme/web", "--brief", "b", "--json"], { threadId: "thr_orch" });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  const prepare = state().calls.filter((call: string[]) => call[0] === "exec" && !call.at(-1)!.includes("BOAT_MEM_PROBE")).at(-1);
  assert.match(prepare.at(-1), /printf '%s\\n' 'main' 'master' 'staging' 'release\/eu'; \}/);
  const prompt = state().calls.find((call: string[]) => call[0] === "prompt");
  assert.match(prompt.at(-1), /Never push to `main`, `master`, `staging`, `release\/eu`/);
  // Worker branches can't be one of them.
  const refused = await harness.runCli(["task", "start", "--title", "y", "--repo", "acme/web", "--branch", "staging", "--brief", "b", "--json"], { threadId: "thr_orch" });
  assert.equal(JSON.parse(refused.stdout).error.code, "invalid_branch");
});

test("a project's own protected branches and instructions reach its tasks, and tasks on its repos", async (t) => {
  const { harness, state } = await setup();
  t.after(() => harness.lifecycle.dispose());
  const added = await harness.runCli([
    "project", "add", "--name", "Web app", "--repo", "acme/web@main",
    "--protected-branches", "release, qa/eu", "--instructions", "Use pnpm, never npm.", "--json",
  ]);
  assert.equal(added.exitCode, 0, added.stderr);
  const project = JSON.parse(added.stdout) as { protectedBranches: string[]; instructions: string };
  assert.deepEqual(project.protectedBranches, ["release", "qa/eu"]);
  assert.equal(project.instructions, "Use pnpm, never npm.");
  assert.match((await harness.runCli(["project", "list"])).stdout, /protects release, qa\/eu {2}has instructions/);

  const lastPrepare = () => state().calls.filter((call: string[]) => call[0] === "exec" && !call.at(-1)!.includes("BOAT_MEM_PROBE")).at(-1).at(-1) as string;
  const lastPrompt = () => state().calls.filter((call: string[]) => call[0] === "prompt").at(-1).at(-1) as string;
  for (const extra of [["--project", "web-app"], ["--repo", "acme/web"]]) {
    const started = await harness.runCli(["task", "start", "--title", "x", ...extra, "--brief", "b", "--json"], { threadId: "thr_orch" });
    assert.equal(started.exitCode, 0, started.stderr || started.stdout);
    // The trial allows two sandboxes at once.
    assert.equal((await harness.runCli(["task", "close", JSON.parse(started.stdout).task.id, "--cancel"])).exitCode, 0);
    assert.match(lastPrepare(), /'release'/);
    assert.match(lastPrepare(), /'qa\/eu'/);
    assert.match(lastPrompt(), /Never push to `main`, `master`, `release`, `qa\/eu`/);
    assert.match(lastPrompt(), /## Standing instructions\nUse pnpm, never npm\./);
  }
  // A task can't take one of them as its branch.
  const refused = await harness.runCli(["task", "start", "--title", "y", "--project", "web-app", "--branch", "release", "--brief", "b", "--json"], { threadId: "thr_orch" });
  assert.equal(JSON.parse(refused.stdout).error.code, "invalid_branch");
  // Another repo gets neither.
  const other = await harness.runCli(["task", "start", "--title", "z", "--repo", "acme/api", "--brief", "b"], { threadId: "thr_orch" });
  assert.equal(other.exitCode, 0, other.stderr || other.stdout);
  assert.doesNotMatch(lastPrepare(), /'release'/);
  assert.doesNotMatch(lastPrompt(), /Use pnpm/);

  // project set changes or clears them; bad names are refused.
  const bad = await harness.runCli(["project", "set", "web-app", "--protected-branches", "release, not a branch"]);
  assert.notEqual(bad.exitCode, 0);
  assert.match(bad.stderr, /"not a branch" isn't a branch name/);
  const cleared = await harness.runCli(["project", "set", "web-app", "--protected-branches", "none", "--instructions", "none", "--json"]);
  assert.equal(cleared.exitCode, 0, cleared.stderr);
  assert.deepEqual(JSON.parse(cleared.stdout).protectedBranches, []);
  assert.equal(JSON.parse(cleared.stdout).instructions, "");
  // The page saves them through saveProject (a list or the text field as is).
  const saved = (await harness.callRpc("saveProject", {
    id: "web-app", name: "Web app", repos: [{ repo: "acme/web", baseBranch: "main" }], environment: null, snapshot: null, protocolPath: null,
    protectedBranches: "staging,  release", instructions: "  Run the linter.  ",
  })) as { project: { protectedBranches: string[]; instructions: string } };
  assert.deepEqual(saved.project.protectedBranches, ["staging", "release"]);
  assert.equal(saved.project.instructions, "Run the linter.");
  // Leaving them out keeps them.
  const kept = (await harness.callRpc("saveProject", {
    id: "web-app", name: "Web app 2", repos: [{ repo: "acme/web", baseBranch: "main" }], environment: null, snapshot: null, protocolPath: null,
  })) as { project: { protectedBranches: string[]; instructions: string } };
  assert.deepEqual(kept.project.protectedBranches, ["staging", "release"]);
  assert.equal(kept.project.instructions, "Run the linter.");
});

test("How tasks run: in boat needs no bb Connect; chats for projects only where a project runs them; everywhere for every repo", async (t) => {
  const { harness } = await setup();
  t.after(() => harness.lifecycle.dispose());
  stubConnect(harness, { paired: false, enabled: true });
  const connectCheck = async () =>
    (JSON.parse((await harness.runCli(["doctor", "--json"])).stdout) as { checks: { id: string; state: string; required: boolean }[] }).checks.find((check) => check.id === "connect")!;
  assert.deepEqual(await connectCheck().then((check) => [check.state, check.required]), ["optional", false]);

  assert.equal((await harness.runCli(["config", "set", "workers", "projects"])).exitCode, 0);
  // No project runs tasks as chats yet.
  assert.deepEqual(await connectCheck().then((check) => [check.state, check.required]), ["optional", false]);
  assert.equal((await harness.runCli(["project", "add", "--name", "Web app", "--repo", "acme/web@main"])).exitCode, 0);
  assert.deepEqual(await connectCheck().then((check) => [check.state, check.required]), ["missing", true]);
  // A repo outside the projects runs in boat (no bb Connect needed).
  const outside = await harness.runCli(["task", "start", "--title", "x", "--repo", "acme/api", "--brief", "b", "--json"], { threadId: "thr_orch" });
  assert.equal(outside.exitCode, 0, outside.stderr || outside.stdout);
  assert.equal(JSON.parse(outside.stdout).task.runner, "boat");
  // The project's own task would be a chat: refused early without bb Connect.
  const inside = await harness.runCli(["task", "start", "--title", "y", "--project", "web-app", "--brief", "b", "--json"], { threadId: "thr_orch" });
  assert.equal(JSON.parse(inside.stdout).error.code, "connect_required");
  // The project's checkbox off: in boat again.
  assert.equal((await harness.runCli(["project", "set", "web-app", "--workers", "boat"])).exitCode, 0);
  assert.deepEqual(await connectCheck().then((check) => [check.state, check.required]), ["optional", false]);

  // Everywhere: any repo would be a chat.
  assert.equal((await harness.runCli(["config", "set", "workers", "all"])).exitCode, 0);
  assert.deepEqual(await connectCheck().then((check) => [check.state, check.required]), ["missing", true]);
  const anyRepo = await harness.runCli(["task", "start", "--title", "z", "--repo", "acme/api", "--brief", "b", "--json"], { threadId: "thr_orch" });
  assert.equal(JSON.parse(anyRepo.stdout).error.code, "connect_required");
  assert.match(JSON.parse(anyRepo.stdout).error.hint, /bb boat config set workers boat/);
});

test("a repo's base branch in any project is protected, even for a task outside that project", async (t) => {
  const { harness, state } = await setup();
  t.after(() => harness.lifecycle.dispose());
  await addProjects(harness);
  // No project: acme/docs from main, but the Docs project's base is develop.
  const refused = await harness.runCli(
    ["task", "start", "--title", "x", "--repo", "acme/docs", "--base", "main", "--branch", "develop", "--brief", "b", "--json"],
    { threadId: "thr_orch" },
  );
  assert.equal(JSON.parse(refused.stdout).error.code, "invalid_branch");
  const started = await harness.runCli(["task", "start", "--title", "y", "--repo", "acme/docs", "--base", "main", "--brief", "b", "--json"], { threadId: "thr_orch" });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  const prepare = state().calls.filter((call: string[]) => call[0] === "exec" && !call.at(-1)!.includes("BOAT_MEM_PROBE")).at(-1);
  assert.match(prepare.at(-1), /'develop'/);
  const prompt = state().calls.filter((call: string[]) => call[0] === "prompt").at(-1);
  assert.match(prompt.at(-1), /Never push to `main`, `master`, `develop`/);
});

test("the extra protected branches setting only takes branch names", async (t) => {
  const { harness } = await setup();
  t.after(() => harness.lifecycle.dispose());
  const refused = await harness.runCli(["config", "set", "extraProtectedBranches", "release, not a branch"]);
  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stderr, /branch names separated by commas/);
  const saved = await harness.runCli(["config", "set", "extraProtectedBranches", "release, develop"]);
  assert.equal(saved.exitCode, 0, saved.stderr);
  assert.equal((await harness.runCli(["config", "get", "extraProtectedBranches"])).stdout.trim(), "release, develop");
});

test("the page's sandboxes say what uses them, and a sandbox can be saved as a snapshot", async (t) => {
  const { harness, state } = await setup();
  t.after(() => harness.lifecycle.dispose());

  // As the New task dialog starts it: the starter's light preset.
  const started = (await harness.callRpc("startTask", {
    title: "Check acme/web runs in a sandbox",
    brief: "acme/web is already checked out in this sandbox. Install its dependencies, run the tests and start the app. Don't change any code.",
    role: "custom",
    repo: "acme/web",
    branch: null,
    baseBranch: null,
    provider: "claude",
    model: null,
    tier: "light",
    sandbox: null,
    machineType: null,
    notifyThreadId: null,
  })) as { task: { id: string; sandboxId: string | null; tier: string | null; model: string | null } };
  const sandboxId = started.task.sandboxId;
  assert.ok(sandboxId);
  assert.equal(started.task.tier, "light");

  const listed = (await harness.callRpc("sandboxes", { all: true })) as {
    sandboxes: { id: string; uses: { kind: string; id: string; title: string | null; open: boolean }[] }[];
  };
  const row = listed.sandboxes.find((entry) => entry.id === sandboxId);
  assert.deepEqual(row?.uses, [{ kind: "task", id: started.task.id, title: "Check acme/web runs in a sandbox", open: true }]);

  const saved = (await harness.callRpc("saveSnapshot", { sandboxId, name: "web-ready" })) as { name: string };
  assert.equal(saved.name, "web-ready");
  assert.ok((state().snapshots as { name: string }[]).some((entry) => entry.name === "web-ready"));
  await assert.rejects(harness.callRpc("saveSnapshot", { sandboxId, name: "no spaces" }), /isn't a snapshot name/);
});
