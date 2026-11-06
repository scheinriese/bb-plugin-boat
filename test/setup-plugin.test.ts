// Setup checks, the test task, task sources and notices, through the whole
// plugin in bb's fake host with the scripted fake boat CLI.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rpcErrorInfo } from "../contract.ts";
import { MACHINE_PROVIDER_ID } from "../src/machine.ts";
import plugin from "../server.ts";
import { createTestHost } from "./fakes.ts";

const fakeBoat = fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url));
const REPORT = "Done.\n=== REPORT ===\nSTATUS: done\nPR: https://github.com/acme/web/pull/4\n=== END REPORT ===";

async function setup(t: { after(fn: () => unknown): void }, options: { settings?: Record<string, unknown>; boat?: Record<string, unknown>; boatPath?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "boat-setup-test-"));
  const statePath = join(dir, "state.json");
  process.env.FAKE_BOAT_STATE = statePath;
  writeFileSync(statePath, JSON.stringify({ sandboxes: {}, convos: {}, calls: [], next: 1, ...options.boat }));
  const { bb, harness } = await createTestHost({
    pluginId: "boat",
    settings: { boatPath: options.boatPath ?? fakeBoat, evidenceUploader: "", ...options.settings },
    agentSkillIds: ["boat", "boat-orchestrator"],
  });
  t.after(() => harness.lifecycle.dispose());
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({ id: threadId, environmentId: null, deletedAt: null, archivedAt: null, status: "idle" }));
  harness.sdk.stub("threads.send", async () => ({ ok: true, delivery: "sent" }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({ ok: true }));
  harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
  await plugin(bb);
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const patch = (changes: Record<string, unknown>) => writeFileSync(statePath, JSON.stringify({ ...state(), ...changes }));
  const finishAll = (reply: string) => {
    const current = state();
    for (const convo of Object.values(current.convos) as { running: boolean; reply: string | null; sandboxId: string }[]) {
      convo.running = false;
      convo.reply = reply;
      current.sandboxes[convo.sandboxId].state = "idle";
    }
    writeFileSync(statePath, JSON.stringify(current));
  };
  const created = () => state().calls.filter((call: string[]) => call[0] === "new");
  return { bb, harness, state, patch, finishAll, created };
}

test("bb boat doctor: the checklist, exit 1 when something required is missing, never a sandbox", async (t) => {
  const { harness, patch, created } = await setup(t);
  const ok = await harness.runCli(["doctor", "--json"]);
  assert.equal(ok.exitCode, 0, ok.stderr || ok.stdout);
  const report = JSON.parse(ok.stdout) as { ok: boolean; checks: { id: string; state: string }[] };
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((check) => check.id), ["cli", "signed-in", "plan", "agents", "environment", "boat-credentials", "github", "connect", "gh"]);

  patch({ signedOut: true });
  const out = await harness.runCli(["doctor"]);
  assert.equal(out.exitCode, 1);
  assert.match(out.stdout, /^Setup: 1 thing to fix \(Signed in to boat\.dev\)\./);
  assert.match(out.stdout, /✗ Signed in to boat\.dev: Not signed in yet\.\n {4}Sign in to boat\.dev: run this in a terminal, then check again\./);
  assert.match(out.stdout, /\$ boat onboard/);
  assert.equal(created().length, 0);
});

test("bb boat doctor warns about boat credentials in the environments workers use, and still passes", async (t) => {
  const { harness, patch, created } = await setup(t, { boat: { boatCredentials: true } });
  const added = await harness.runCli(["project", "add", "--name", "Storefront", "--repo", "acme/storefront@master", "--environment", "storefront"]);
  assert.equal(added.exitCode, 0, added.stderr);
  const out = await harness.runCli(["doctor"]);
  assert.equal(out.exitCode, 0, out.stderr || out.stdout);
  assert.match(out.stdout, /^Setup: ready, but check boat login in sandboxes\.\n/);
  assert.match(out.stdout, /\n! boat login in sandboxes: "base" \(your default\) and "storefront" pass boat credentials into sandboxes/);
  assert.match(out.stdout, /\n {4}\$ boat env set base --boat-credentials false && boat env set storefront --boat-credentials false\n/);
  // The page's summary says the same; work isn't blocked.
  const status = (await harness.callRpc("setup", { force: true })) as { ok: boolean; summary: string };
  assert.equal(status.ok, true);
  assert.equal(status.summary, "Setup: ready, but check boat login in sandboxes. Run `bb boat doctor`.");
  assert.doesNotMatch(out.stdout, /fake_value/);
  assert.equal(created().length, 0);

  // Turned off: quiet again.
  patch({ boatCredentials: false });
  const fixed = await harness.runCli(["doctor"]);
  assert.match(fixed.stdout, /^Setup: ready\.\n/);
  assert.match(fixed.stdout, /\n✓ boat login in sandboxes: Your tasks' environments don't pass boat credentials into sandboxes\.\n/);
});

test("boat credentials boat doesn't report: the doctor and the access line say they couldn't tell, never off", async (t) => {
  const { harness } = await setup(t, { boat: { boatCredentials: "unreported" } });
  await harness.runCli(["project", "add", "--name", "Storefront", "--repo", "acme/storefront@master", "--environment", "storefront"]);
  const out = await harness.runCli(["doctor"]);
  assert.equal(out.exitCode, 0, out.stderr || out.stdout);
  assert.match(out.stdout, /\n\? boat login in sandboxes: Couldn't tell whether "base" \(your default\) and "storefront" pass boat credentials into sandboxes\.\n/);
  assert.doesNotMatch(out.stdout, /don't pass boat credentials/);
  const status = await harness.runCli(["status"]);
  assert.match(status.stdout, /- Storefront: environment storefront: [^\n]*; couldn't tell whether boat credentials are passed in\n/);
  const access = (await harness.callRpc("projectAccess", { projectId: "storefront" })) as { passSandboxCredentials: boolean | null };
  assert.equal(access.passSandboxCredentials, null);
});

test("bb boat status starts with the setup line and skips empty headings", async (t) => {
  const { harness, patch } = await setup(t);
  const status = await harness.runCli(["status"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.match(status.stdout, /^Setup: ready\.\nboat: trial · 0\/2 sandboxes active/);
  assert.doesNotMatch(status.stdout, /Access:/);
  assert.equal(JSON.parse((await harness.runCli(["status", "--json"])).stdout).setup.ok, true);

  // Signed out: still answers, with what to do.
  patch({ signedOut: true });
  const out = await harness.runCli(["status"]);
  assert.equal(out.exitCode, 0, out.stderr);
  assert.match(out.stdout, /^Setup: 1 thing to fix \(Signed in to boat\.dev\)\. Run `bb boat doctor`\.\nboat: You're not signed in to boat\.dev\./);
});

test("a broken setup fails before any sandbox is created, with the fix", async (t) => {
  const { harness, patch, created } = await setup(t);
  patch({ signedOut: true });
  const signedOut = await harness.runCli(["task", "start", "--title", "Fix", "--repo", "acme/web", "--brief", "Do it.", "--json"], { threadId: "thr_chat" });
  assert.notEqual(signedOut.exitCode, 0);
  const error = JSON.parse(signedOut.stdout).error as { code: string; message: string; hint: string };
  assert.equal(error.code, "setup_required");
  assert.equal(error.message, "You're not signed in to boat.dev.");
  assert.match(error.hint, /^Sign in to boat\.dev: run `boat onboard` in a terminal\. Run `bb boat doctor` to see every check\.$/);

  patch({ signedOut: false, checkoutRequired: true });
  const noPlan = await harness.runCli(["task", "start", "--title", "Fix", "--repo", "acme/web", "--brief", "Do it.", "--json"]);
  assert.equal(JSON.parse(noPlan.stdout).error.code, "setup_required");
  assert.match(JSON.parse(noPlan.stdout).error.hint, /boat billing plan 20/);
  const sandbox = await harness.runCli(["sandbox", "new", "--json"]);
  assert.equal(JSON.parse(sandbox.stdout).error.code, "setup_required");

  // Only Claude in boat.dev: a task named for Codex fails early.
  patch({ checkoutRequired: false, connected: ["claude-subscription"] });
  const codex = await harness.runCli(["task", "start", "--title", "Fix", "--repo", "acme/web", "--brief", "Do it.", "--agent", "codex", "--json"]);
  const codexError = JSON.parse(codex.stdout).error as { code: string; message: string; hint: string };
  assert.equal(codexError.code, "setup_required");
  assert.equal(codexError.message, "Codex isn't connected in boat.dev (only Claude is).");
  assert.equal(created().length, 0, "no start was spent");

  // The page gets the same refusal, with its parts.
  patch({ connected: ["claude-subscription", "chatgpt-subscription"], signedOut: true });
  await harness.callRpc("setup", { force: true });
  const failure = await harness
    .callRpc("startTask", {
      title: "Fix", brief: "Do it.", role: "implement", repo: "acme/web", branch: null, baseBranch: null, provider: null, model: null, sandbox: null, machineType: null, notifyThreadId: null,
    })
    .then(() => null, (rejected: unknown) => rejected);
  const info = rpcErrorInfo(failure);
  assert.equal(info.code, "setup_required");
  assert.equal(info.message, "You're not signed in to boat.dev.");
  assert.equal(info.hint, "Sign in to boat.dev: run `boat onboard` in a terminal. Run `bb boat doctor` to see every check.");
  assert.match((failure as Error).message, /^You're not signed in to boat\.dev\. Sign in to boat\.dev/, "older screens still get the hint");
  assert.equal(created().length, 0);
});

test("Auto-detect follows boat.dev: one connected agent runs everything", async (t) => {
  const { harness, finishAll } = await setup(t, { boat: { connected: ["claude-subscription"] } });
  const overview = (await harness.callRpc("overview", null)) as { defaults: { onlyAgent: string | null; reviewProvider: string; autoFailover: boolean } };
  assert.equal(overview.defaults.onlyAgent, "claude");
  assert.equal(overview.defaults.reviewProvider, "claude");
  // The reply box offers "Agent with room" only when a follow-up can move to the other agent.
  assert.equal(overview.defaults.autoFailover, false);
  const started = await harness.runCli(["task", "start", "--title", "Fix", "--repo", "acme/web", "--brief", "Do it.", "--json"], { threadId: "thr_chat" });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  const task = JSON.parse(started.stdout).task as { id: string; provider: string };
  assert.equal(task.provider, "claude");
  finishAll(REPORT);
  await harness.runCli(["task", "show", task.id, "--refresh"]);
  // The review would be Codex's; with only Claude, Claude reviews.
  const review = await harness.runCli(["task", "review", task.id, "--json"], { threadId: "thr_chat" });
  assert.equal(review.exitCode, 0, review.stderr || review.stdout);
  assert.equal(JSON.parse(review.stdout).task.provider, "claude");

  // A hand-picked "both" disagrees with boat: a warning, fixed with one click.
  await harness.setSettings({ agents: "both" });
  const before = (await harness.callRpc("setup", { force: false })) as { ok: boolean; checks: { id: string; state: string; fix?: { action?: string } }[]; agents: { setting: string } };
  const agents = before.checks.find((check) => check.id === "agents")!;
  assert.equal(agents.state, "warning");
  assert.equal(agents.fix?.action, "use-detected-agents");
  const after = (await harness.callRpc("applySetupFix", { action: "use-detected-agents" })) as { agents: { setting: string; effective: string } };
  assert.deepEqual(after.agents, { setting: "auto", detected: ["claude"], effective: "claude" });
});

test("the test task: no repo, headless, small, and it tells the chat that started it", async (t) => {
  const { harness, state, created } = await setup(t, { settings: { workers: "all" } });
  harness.sdk.stub("plugins.callRpc", async () => ({ paired: true, enabled: true }));
  const started = await harness.runCli(["task", "start", "--test", "--json"], { threadId: "thr_chat" });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  const task = JSON.parse(started.stdout).task as { title: string; repo: string | null; runner: string; role: string; orchestratorThreadId: string };
  assert.equal(task.title, "Test task");
  assert.equal(task.repo, null);
  assert.equal(task.runner, "boat", "headless even with task chats on");
  assert.equal(task.role, "custom");
  assert.equal(task.orchestratorThreadId, "thr_chat");
  const newCall = created().at(-1) as string[];
  assert.equal(newCall[newCall.indexOf("--type") + 1], "small");
  assert.ok(!state().calls.some((call: string[]) => call[0] === "exec" && /gh repo clone/.test(call.at(-1) ?? "")), "nothing is cloned");
  const prompt = state().calls.find((call: string[]) => call[0] === "prompt") as string[];
  assert.match(prompt.at(-1)!, /Report the output of `uname -a`, `node --version`, `git --version`/);

  const mixed = await harness.runCli(["task", "start", "--test", "--repo", "acme/web"]);
  assert.notEqual(mixed.exitCode, 0);
  assert.match(mixed.stderr, /--test starts a fixed test task; drop --repo/);
  const noTitle = await harness.runCli(["task", "start", "--brief", "x"]);
  assert.match(noTitle.stderr, /A task needs --title/);

  // From the page: nobody to notify, it shows on the board.
  const fromPage = (await harness.callRpc("startTestTask", { notifyThreadId: null, provider: null })) as { task: { title: string; source: { kind: string } } };
  assert.equal(fromPage.task.title, "Test task");
  assert.deepEqual(fromPage.task.source, { kind: "page", threadId: null, title: null });
});

test("without the CLI, the plugin says how to install it and to reload", async (t) => {
  const { harness } = await setup(t, { boatPath: "/nonexistent/boat" });
  const message = harness.inspection.needsConfigurationMessages.at(-1) ?? "";
  assert.match(message, /curl -fsSL https:\/\/boat\.dev\/install \| sh/);
  assert.match(message, /reload the plugin \(`bb plugin reload boat`\)/);
  assert.match(message, /boat CLI location/);
  assert.doesNotMatch(message, /boatPath/);
  const doctor = await harness.runCli(["doctor", "--json"]);
  assert.equal(doctor.exitCode, 1);
  assert.equal((JSON.parse(doctor.stdout) as { checks: { id: string; state: string }[] }).checks[0]!.state, "missing");
});

test("the Boat sandbox machine needs a signed-in boat, an agent login and bb Connect", async (t) => {
  const { harness, patch } = await setup(t);
  harness.sdk.stub("plugins.callRpc", async () => ({ paired: true, enabled: true }));
  const machine = harness.inspection.registrations.machineProviders.get("boat-sandbox")!;
  assert.deepEqual(await machine.availability!(), { status: "available" });
  patch({ signedOut: true });
  await harness.callRpc("setup", { force: true });
  const out = await machine.availability!();
  assert.equal(out.status, "setup-required");
  assert.match((out as { message: string }).message, /boat onboard/);
});

test("the page's refresh reads boat.dev again for the checklist; the machine picker never waits on boat", async (t) => {
  const { harness, patch, state } = await setup(t);
  harness.sdk.stub("plugins.callRpc", async () => ({ paired: true, enabled: true }));
  assert.equal(((await harness.callRpc("setup", { force: false })) as { ok: boolean }).ok, true);
  patch({ signedOut: true });
  // Cached: still the old answer.
  assert.equal(((await harness.callRpc("setup", { force: false })) as { ok: boolean }).ok, true);
  await harness.callRpc("refresh", null);
  assert.equal(((await harness.callRpc("setup", { force: false })) as { ok: boolean }).ok, false);
  // With a reading in hand, the Boat sandbox option answers without running boat.
  const machine = harness.inspection.registrations.machineProviders.get("boat-sandbox")!;
  const calls = state().calls.length;
  assert.equal((await machine.availability!()).status, "setup-required");
  assert.equal(state().calls.length, calls);
});

test("task sources: only real orchestrators count; plain-chat and page tasks are ready once a turn ends", async (t) => {
  const { harness, finishAll } = await setup(t, { boat: { maxActive: 5 } });
  harness.sdk.stub("threads.list", async ({ threadIds }: { threadIds?: string[] }) =>
    (threadIds ?? []).map((id) => ({ id, title: id === "thr_orch" ? "Web orchestrator" : id === "thr_chat" ? "Fix the login" : null })),
  );
  await harness.runCli(["orchestrator", "on"], { threadId: "thr_orch" });
  const start = async (threadId: string | null) => {
    const result = await harness.runCli(
      ["task", "start", "--title", `From ${threadId ?? "page"}`, "--repo", "acme/web", "--brief", "Do it.", ...(threadId ? [] : ["--no-notify"]), "--json"],
      threadId ? { threadId } : {},
    );
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout).task as { id: string };
  };
  const fromOrchestrator = await start("thr_orch");
  const fromChat = await start("thr_chat");
  const fromPage = await start(null);
  finishAll(REPORT);
  await harness.runCli(["task", "show", fromPage.id, "--refresh"]);

  type Row = { id: string; phase: string; source: { kind: string; threadId: string | null; title: string | null } };
  const board = (await harness.callRpc("board", { threadId: null })) as { ready: Row[]; running: Row[] };
  const ready = new Map(board.ready.map((task) => [task.id, task]));
  const running = new Map(board.running.map((task) => [task.id, task]));
  // The orchestrator reviews its own task: it waits on it.
  assert.equal(running.get(fromOrchestrator.id)?.phase, "waiting");
  assert.deepEqual(running.get(fromOrchestrator.id)?.source, { kind: "orchestrator", threadId: "thr_orch", title: "Web orchestrator" });
  // A plain chat's and the page's tasks are ready for the user (and count in the badge).
  assert.equal(ready.get(fromChat.id)?.phase, "ready");
  assert.deepEqual(ready.get(fromChat.id)?.source, { kind: "chat", threadId: "thr_chat", title: "Fix the login" });
  assert.deepEqual(ready.get(fromPage.id)?.source, { kind: "page", threadId: null, title: null });
  const tasks = (await harness.callRpc("tasks", { statuses: null, threadId: null, limit: 50 })) as { tasks: Row[] };
  assert.equal(tasks.tasks.find((task) => task.id === fromChat.id)?.phase, "ready");

  // Only real orchestrators are listed.
  const listed = (await harness.callRpc("orchestrators", null)) as { orchestrators: { threadId: string }[] };
  assert.deepEqual(listed.orchestrators.map((row) => row.threadId), ["thr_orch"]);

  // An orchestrator turned off stays known: its tasks still read as an orchestrator's, but now wait on the user.
  await harness.runCli(["orchestrator", "off"], { threadId: "thr_orch" });
  const after = (await harness.callRpc("board", { threadId: null })) as { ready: Row[] };
  const former = after.ready.find((task) => task.id === fromOrchestrator.id);
  assert.equal(former?.source.kind, "orchestrator");
  assert.equal(((await harness.callRpc("orchestrators", null)) as { orchestrators: unknown[] }).orchestrators.length, 0);
});

test("a notice waits while the chat is busy, and a task closed meanwhile gets none", async (t) => {
  const { harness, finishAll } = await setup(t);
  let status = "active";
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({ id: threadId, environmentId: null, deletedAt: null, archivedAt: null, status }));
  const started = async (title: string) => {
    const result = await harness.runCli(["task", "start", "--title", title, "--repo", "acme/web", "--brief", "Do it.", "--json"], { threadId: "thr_chat" });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout).task as { id: string };
  };
  const closed = await started("Closed early");
  const kept = await started("Kept open");
  finishAll(REPORT);
  await harness.callRpc("refresh", null);
  const notices = () =>
    harness.inspection.sdk
      .callsTo("threads.send")
      .map((call) => (call[0] as { input: { text: string }[] }).input[0]!.text)
      .filter((text) => text.startsWith("[boat]"));
  assert.equal(notices().length, 0, "the chat is mid-turn");

  // The chat closes one of them in that same turn.
  const close = await harness.runCli(["task", "close", closed.id], { threadId: "thr_chat" });
  assert.equal(close.exitCode, 0, close.stderr);

  // The turn ends: one notice, only for the task still open.
  status = "idle";
  await harness.emitThreadEvent("thread.idle", { thread: { id: "thr_chat", updatedAt: Date.now() }, lastAssistantText: "ok" } as never);
  await harness.callRpc("refresh", null);
  assert.equal(notices().length, 1);
  assert.match(notices()[0]!, new RegExp(`^\\[boat\\] Task ${kept.id} finished a turn\\.`));
  assert.doesNotMatch(notices()[0]!, new RegExp(closed.id));
});

test("cloud orchestrators start in Full Access (a setting); local ones keep the default mode", async (t) => {
  const { harness } = await setup(t);
  harness.sdk.stub("plugins.callRpc", async () => ({ paired: true, enabled: true }));
  const spawned: Record<string, unknown>[] = [];
  harness.sdk.stub("threads.spawn", async (args: Record<string, unknown>) => {
    spawned.push(args);
    return { id: `thr_o${spawned.length}` };
  });
  const added = await harness.runCli(["project", "add", "--name", "Web app", "--repo", "acme/web@main"]);
  assert.equal(added.exitCode, 0, added.stderr);
  const start = (cloud: boolean) =>
    harness.callRpc("startOrchestrator", { project: { kind: "boat", id: "web-app" }, prompt: "Ship the header", title: null, hostId: null, cloud });
  await start(true);
  assert.equal(spawned.at(-1)!.permissionMode, "full");
  await start(false);
  assert.equal(spawned.at(-1)!.permissionMode, undefined);
  // On a host that is a Boat sandbox machine: full access too; on another machine: not.
  harness.sdk.stub("hosts.list", async () => [
    { id: "h_boat", machineProviderId: MACHINE_PROVIDER_ID },
    { id: "h_mac", machineProviderId: null },
  ]);
  const onHost = (hostId: string) =>
    harness.callRpc("startOrchestrator", { project: { kind: "boat", id: "web-app" }, prompt: "Ship the header", title: null, hostId, cloud: false });
  await onHost("h_boat");
  assert.equal(spawned.at(-1)!.permissionMode, "full");
  await onHost("h_mac");
  assert.equal(spawned.at(-1)!.permissionMode, undefined);
  // A plugin setting (Settings → Orchestrators), set from the CLI.
  const off = await harness.runCli(["config", "set", "cloudOrchestratorFullAccess", "false"]);
  assert.equal(off.exitCode, 0, off.stderr);
  await start(true);
  assert.equal(spawned.at(-1)!.permissionMode, undefined);
  // Orchestrators are told to use the tools, not the bb CLI.
  assert.match(String(spawned.at(-1)!.prompt), /Use the boat_\* tools, not the `bb boat` CLI/);
});
