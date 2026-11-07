import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptNativeChat } from "../src/native-start.ts";
import { registerNativeReviews } from "../src/native-review.ts";
import { resolveReviewer, projectReviewInstructions, nativeReviewSourceSchema } from "../src/review-policy.ts";
import { NATIVE_REVIEW_METADATA, nativeReviewStateSchema, type Reviewer } from "../contract-review.ts";
import { composeProtocol } from "../src/protocol.ts";
import { makeService } from "./fakes.ts";
import type { Runtime } from "../src/runtime.ts";
import type { StartTaskInput } from "../src/service.ts";
import type { PullRequestFacts } from "../contract-merge.ts";
import type { Task } from "../src/store.ts";

const PR = "https://github.com/acme/demo/pull/12";
const facts: PullRequestFacts = { repo: "acme/demo", number: 12, url: PR, title: "Demo", head: "1".repeat(40), base: "2".repeat(40), headBranch: "boat/demo", baseBranch: "main", additions: 12, deletions: 3, commits: 1, state: "OPEN", draft: true, mergeable: "MERGEABLE", mergeState: "CLEAN", reviewDecision: "", checks: [], checksTruncated: false, mergeMethod: "merge" };
const report = "=== REPORT ===\nSTATUS: done\nVERDICT: approve\nSUMMARY: reviewed\nTESTS: checked\n=== END REPORT ===";
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw Error("Timed out"); await new Promise(resolve => setTimeout(resolve, 2)); } }

async function setup(options: { machine?: unknown; project?: Reviewer | null; realLaunch?: boolean; preflight?: () => Promise<void>; pullRequest?: string | null } = {}) {
  let project = options.project ?? null;
  const env = makeService({ chat: true, projectReviewer: () => project, preflight: options.preflight, repoWorkerMode: () => "boat" });
  const metadata = new Map<string, Record<string, unknown>>(); const disposals: (() => void)[] = [];
  const runtime = {
    service: env.service, projects: { forRepo: () => ({ id: "store", repos: [{ repo: "acme/demo", baseBranch: "main" }] }) }, isOrchestrator: async () => false, launchWaitMs: 5000, changed() {},
    bb: { pluginId: "boat", onDispose(callback: () => void) { disposals.push(callback); }, log: { warn() {} }, rpc: { experimental_invalidate() {} },
      experimental_machines: { getResource: async () => ({ sandboxId: "bx_native", reviewer: options.machine }) },
      sdk: {
        threads: { get: async () => ({ title: "Native", providerId: "claude-code", projectId: "proj_demo", environmentId: "env_core", parentThreadId: null }),
          updatePluginMetadata: async ({ threadId, set }: { threadId: string; set: Record<string, unknown> }) => { const value = { ...metadata.get(threadId), ...set }; metadata.set(threadId, value); return value; } },
        environments: { get: async () => ({ id: "env_core", path: "/work/core", hostId: "host_core" }) }, hosts: { get: async () => ({ id: "host_core", machineProviderId: "boat-sandbox" }) }, projects: { get: async () => ({ gitRemoteUrl: "https://github.com/acme/demo" }) },
      },
    },
  } as unknown as Runtime;
  await adoptNativeChat("thr_native", runtime);
  const taskId = env.store.byThread("thr_native")!.id;
  env.store.update(taskId, { status: "idle", finishedAt: new Date().toISOString(), promptId: "native-turn-1", result: "Implemented the drawer", prUrl: options.pullRequest === undefined ? PR : options.pullRequest });
  env.store.addEvent(taskId, "finished", "Turn finished");
  env.chat.states.set("thr_native", { status: "idle", archived: false, updatedAt: Date.now(), environmentId: "env_core", queued: 0, backgroundAgents: 0 });
  const launches: StartTaskInput[] = [];
  if (!options.realLaunch) env.service.launchTask = async (input) => {
    launches.push(input);
    const parent = env.store.get(taskId)!;
    const child = env.store.insert({ ...parent, id: `t_review_${launches.length}`, role: "review", title: "Review", status: "running", ownsSandbox: true, parentTaskId: taskId, provider: input.provider!, sandboxId: "bx_review", hostId: "host_review", environmentId: "env_review", threadId: "thr_review", promptId: "review-turn-1", result: null, finishedAt: null, createdAt: new Date().toISOString() });
    env.store.addEvent(child.id, "native-review-source", JSON.stringify(input.nativeReview!.source));
    await input.nativeReview!.beforeDispatch(child.id);
    return { task: child, pending: false };
  };
  let reads = 0;
  let factReader = async () => ({ ...facts });
  const start = () => registerNativeReviews(runtime, { facts: async () => { reads++; return factReader(); } });
  const state = () => nativeReviewStateSchema.parse(metadata.get("thr_native")?.[NATIVE_REVIEW_METADATA]);
  const noCoreMutations = () => {
    assert.deepEqual(env.chat.removed, []); assert.deepEqual(env.chat.detached, []); assert.deepEqual(env.chat.suspended, []);
    assert.ok(!env.chat.archived.includes("thr_native")); assert.ok(!env.chat.stopped.includes("thr_native"));
    assert.equal(env.store.get(taskId)!.ownsSandbox, false); assert.equal(env.store.get(taskId)!.hostId, "host_core"); assert.equal(env.store.get(taskId)!.sandboxId, "bx_native");
    assert.ok(!env.boat.calls.some(call => call.includes("bx_native")), env.boat.calls.join("\n"));
  };
  return { ...env, runtime, taskId, state, launches, start, metadata, disposals, noCoreMutations, setProject: (value: Reviewer | null) => { project = value; }, setFacts: (reader: () => Promise<PullRequestFacts>) => { factReader = reader; }, reads: () => reads };
}

test("reviewer precedence preserves none and project instructions disable automatic only", () => {
  assert.deepEqual(resolveReviewer("none", "codex", "claude"), { reviewer: "none", source: "machine" });
  assert.deepEqual(resolveReviewer(null, "claude", "codex"), { reviewer: "claude", source: "project" });
  assert.deepEqual(resolveReviewer(undefined, null, "codex"), { reviewer: "codex", source: "global" });
  assert.match(projectReviewInstructions({ reviewer: "none" }), /Manual review remains available/);
  const protocol = composeProtocol("Always review every implementation", { name: "Demo", repos: [], reviewer: "none" } as never, null);
  assert.ok(protocol.indexOf("Automatic reviews are off") > protocol.indexOf("Always review"));
});

test("machine reviewer reaches native adoption and a real guarded request exactly once across duplicates/reload, with no core mutation", async () => {
  const env = await setup({ machine: "codex", project: "claude" });
  assert.equal(JSON.parse(env.store.latestEvent(env.taskId, "native-review-policy")!.text).machineReviewer, "codex");
  const controller = env.start(); await Promise.all([controller.afterThreadSync("thr_native"), controller.afterThreadSync("thr_native"), controller.tick()]);
  assert.equal(env.launches.length, 1); assert.equal(env.launches[0].provider, "codex"); assert.equal(env.launches[0].sandbox, "new"); assert.equal(env.launches[0].snapshot, "none");
  assert.ok(nativeReviewSourceSchema.safeParse(env.launches[0].nativeReview!.source).success);
  assert.equal(env.state().state, "reviewing"); assert.equal(env.state().source, "machine");
  await env.start().tick(); assert.equal(env.launches.length, 1); env.noCoreMutations(); assert.deepEqual(env.boat.calls, []);
});

for (const choice of ["machine", "project"] as const) test(`${choice} none disables automatic but manual review remains possible`, async () => {
  const env = await setup(choice === "machine" ? { machine: "none", project: "codex" } : { project: "none" });
  await env.start().tick(); assert.equal(env.state().state, "disabled"); assert.equal(env.launches.length, 0); assert.equal(env.reads(), 0);
  const manual = await env.service.reviewInput(env.taskId, { provider: "claude" }); assert.equal(manual.provider, "claude");
  assert.ok((await env.service.reviewInput(env.taskId)).provider); env.noCoreMutations();
});

test("nullable project inherits global; explicit project reviewer also controls delegated reviewInput", async () => {
  const env = await setup({ project: null }); await env.start().tick(); assert.equal(env.state().source, "global"); assert.equal(env.launches[0].provider, "codex");
  env.setProject("claude"); const parent = env.store.get(env.taskId)!; env.store.update(parent.id, { runner: "boat", ownsSandbox: true });
  const selected = await env.service.reviewInput(parent.id); assert.equal(selected.provider, "claude"); assert.equal(selected.flexibleAgent, false);
  assert.equal((await env.service.reviewInput(parent.id, { provider: "codex" })).provider, "codex");
});

for (const pr of [null, "https://github.com/other/repo/pull/12"]) test(`unknown or foreign PR waits honestly without touching the native checkout: ${pr}`, async () => {
  const env = await setup({ pullRequest: pr }); await env.start().tick(); assert.equal(env.state().state, "waiting"); assert.equal(env.launches.length, 0); assert.equal(env.reads(), 0); env.noCoreMutations();
  if (!pr) await assert.rejects(env.service.reviewInput(env.taskId), /report its pull request/);
});

test("queued/background native work and an interrupted completion never request review", async () => {
  for (const reason of ["queue", "background", "interrupted"] as const) {
    const env = await setup();
    if (reason === "queue") env.chat.states.get("thr_native")!.queued = 1;
    if (reason === "background") env.chat.states.get("thr_native")!.backgroundAgents = 1;
    if (reason === "interrupted") env.store.addEvent(env.taskId, "finished", "Turn ended without a new message");
    await env.start().tick(); assert.equal(env.state().state, "waiting"); assert.equal(env.launches.length, 0); assert.equal(env.reads(), 0); env.noCoreMutations();
  }
});

test("a changed PR HEAD is rejected before a once-only dispatch claim", async () => {
  const env = await setup(); let n = 0; env.setFacts(async () => ({ ...facts, head: ++n > 1 ? "3".repeat(40) : facts.head }));
  await env.start().tick(); assert.equal(env.launches.length, 0); assert.equal(env.store.latestEvent(env.taskId, "native-review-attempt"), null); assert.equal(env.state().state, "waiting"); env.noCoreMutations();
});

test("real service preflight rejects a new implementation generation before any sandbox/provider start", async () => {
  const held = gate(); let entered = false; const env = await setup({ realLaunch: true, preflight: async () => { entered = true; await held.promise; } });
  const request = env.start().tick(); await until(() => entered);
  env.store.update(env.taskId, { status: "running", promptId: "native-turn-2", turns: 2, finishedAt: null });
  held.release(); await request;
  assert.equal(env.store.list({ parentTaskId: env.taskId }).length, 0); assert.equal(env.chat.spawns.length, 0); assert.deepEqual(env.boat.calls, []); env.noCoreMutations();
});

test("disposal during real service preflight never creates a sandbox or starts a provider", async () => {
  const held = gate(); let entered = false; const env = await setup({ realLaunch: true, preflight: async () => { entered = true; await held.promise; } });
  const request = env.start().tick(); await until(() => entered); for (const dispose of env.disposals) dispose(); held.release(); await request;
  assert.deepEqual(env.boat.calls, []); assert.equal(env.chat.spawns.length, 0); assert.equal(env.store.list({ parentTaskId: env.taskId }).length, 0); env.noCoreMutations();
});

test("failed dispatch stays once-only after reload; native branch is never prepared", async () => {
  const env = await setup(); let calls = 0; env.service.launchTask = async () => { calls++; throw Error("Fake provider unavailable"); };
  await env.start().tick(); assert.equal(env.state().state, "failed"); await env.start().tick(); assert.equal(calls, 1); assert.equal(env.reads(), 2); env.noCoreMutations();
});

test("a late native automatic verdict is outdated after a new turn and never mutates core host", async () => {
  const env = await setup(); await env.start().tick(); const review = env.store.list({ parentTaskId: env.taskId })[0];
  env.store.update(env.taskId, { status: "running", turns: 2, promptId: "native-turn-2", finishedAt: null });
  env.chat.states.set(review.threadId!, { status: "idle", archived: false, updatedAt: Date.now(), environmentId: "env_review", queued: 0, backgroundAgents: 0 });
  await env.service.syncChatThread(review.threadId!, { kind: "idle", at: Date.now(), text: report });
  assert.equal(env.store.latestEvent(env.taskId, "review")!.text, `Review ${review.id}: outdated`); env.noCoreMutations();
});

test("native verdict publication checks the recorded GitHub HEAD through fake gh only", async t => {
  const env = await setup(); await env.start().tick(); const review = env.store.list({ parentTaskId: env.taskId })[0];
  const dir = mkdtempSync(join(tmpdir(), "boat-native-review-")); const gh = join(dir, "gh"); const previous = process.env.BOAT_PLUGIN_GH;
  const raw = { ...facts, headRefOid: "3".repeat(40), baseRefOid: facts.base, headRefName: facts.headBranch, baseRefName: facts.baseBranch, isDraft: true, mergeStateStatus: "CLEAN", commits: { totalCount: 1, nodes: [] } };
  writeFileSync(gh, `#!${process.execPath}\nif(process.argv[2]!=='api'||process.argv[3]!=='graphql')process.exit(42);process.stdout.write(JSON.stringify({data:{repository:{mergeCommitAllowed:true,pullRequest:${JSON.stringify(raw)}}}}));`, { mode: 0o700 }); process.env.BOAT_PLUGIN_GH = gh;
  t.after(() => { if (previous === undefined) delete process.env.BOAT_PLUGIN_GH; else process.env.BOAT_PLUGIN_GH = previous; rmSync(dir, { recursive: true, force: true }); });
  env.chat.states.set(review.threadId!, { status: "idle", archived: false, updatedAt: Date.now(), environmentId: "env_review", queued: 0, backgroundAgents: 0 });
  await env.service.syncChatThread(review.threadId!, { kind: "idle", at: Date.now(), text: report });
  assert.equal(env.store.latestEvent(env.taskId, "review")!.text, `Review ${review.id}: outdated`); env.noCoreMutations();
});

test("fake service dispatch verifies the new review checkout HEAD and never executes in core's sandbox", async () => {
  const env = await setup({ realLaunch: true }); const exec = env.boat.exec.bind(env.boat);
  env.boat.exec = async (id, command, options) => command.includes("BOAT_NATIVE_REVIEW_HEAD")
    ? { exitCode: 0, stdout: `BOAT_NATIVE_REVIEW_HEAD ${facts.head}\n`, stderr: "" } : exec(id, command, options);
  await env.start().tick(); const review = env.store.list({ parentTaskId: env.taskId })[0];
  assert.ok(review); assert.equal(review.role, "review"); assert.equal(review.status, "running"); assert.equal(review.ownsSandbox, true); assert.notEqual(review.sandboxId, "bx_native");
  assert.match(review.brief, new RegExp(`HEAD ${facts.head}`)); assert.ok(env.boat.calls.some(call => call.startsWith("prepare "))); env.noCoreMutations();
});

test("a mismatched new review checkout cannot start even a fake provider", async () => {
  const env = await setup({ realLaunch: true }); const exec = env.boat.exec.bind(env.boat);
  env.boat.exec = async (id, command, options) => command.includes("BOAT_NATIVE_REVIEW_HEAD")
    ? { exitCode: 0, stdout: `BOAT_NATIVE_REVIEW_HEAD ${"3".repeat(40)}\n`, stderr: "" } : exec(id, command, options);
  await env.start().tick(); assert.ok(!env.boat.calls.some(call => call.startsWith("prompt "))); assert.equal(env.state().state, "failed"); env.noCoreMutations();
});

test("a new completed turn waits for an older running review, then requests exactly one fresh review", async () => {
  const env = await setup(); const controller = env.start(); await controller.tick(); const first = env.store.list({ parentTaskId: env.taskId })[0];
  const task = env.store.get(env.taskId)!; env.store.update(task.id, { turns: task.turns + 1, promptId: "native-turn-2", result: "New changes", finishedAt: new Date().toISOString() }); env.store.addEvent(task.id, "finished", "Turn finished");
  await controller.tick(); assert.equal(env.launches.length, 1); assert.equal(env.state().state, "waiting"); assert.match(env.state().message, /new turn has not been reviewed/);
  env.store.update(first.id, { status: "idle", result: report }); env.store.addEvent(task.id, "review", `Review ${first.id}: outdated`);
  env.setFacts(async () => ({ ...facts, head: "3".repeat(40) })); await controller.tick(); await controller.tick(); assert.equal(env.launches.length, 2);
  assert.notEqual(env.launches[0].nativeReview!.source.turnKey, env.launches[1].nativeReview!.source.turnKey); env.noCoreMutations();
});

test("an existing manual review covering this turn prevents an automatic duplicate", async () => {
  const env = await setup(); const parent = env.store.get(env.taskId)!;
  env.store.insert({ ...parent, id: "t_manual_review", parentTaskId: parent.id, role: "review", ownsSandbox: true, status: "running", createdAt: new Date().toISOString(), threadId: "thr_manual", sandboxId: "bx_manual", hostId: "host_manual" });
  await env.start().tick(); assert.equal(env.launches.length, 0); assert.equal(env.state().reviewTaskId, "t_manual_review"); assert.equal(env.state().state, "reviewing"); env.noCoreMutations();
});

test("invalid saved machine policy fails safely without inheriting a provider", async () => {
  const env = await setup({ machine: "invalid" }); await env.start().tick(); assert.equal(env.state().state, "failed"); assert.match(env.state().message, /saved reviewer is invalid/); assert.equal(env.launches.length, 0); assert.equal(env.reads(), 0); env.noCoreMutations();
});

test("a selected reviewer unavailable under the existing agent guard never starts on another provider", async () => {
  const env = await setup({ realLaunch: true, machine: "codex" }); env.setSettings({ agents: "claude" });
  await env.start().tick(); assert.equal(env.state().state, "failed"); assert.deepEqual(env.boat.calls, []); assert.equal(env.chat.spawns.length, 0); env.noCoreMutations();
});
