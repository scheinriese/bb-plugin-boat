// bb project sources: a task chat in a sandbox checkout outside Personal needs one for the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PERSONAL_PROJECT, createChatRunner } from "../src/chat.ts";
import { PROJECT_SOURCE_KEY_PREFIX, createProjectSources, type OwnProjectSource } from "../src/project-sources.ts";
import type { ChatSpawn } from "../src/chat.ts";
import { makeService } from "./fakes.ts";

const PROJECT = "proj_storefront";
/** The fake boat checks acme/web out here. */
const CHECKOUT = "/home/user/work/web";
/** The user's own computer's source: Boat never touches it. */
const LAPTOP = { id: "src_laptop", hostId: "host_laptop", path: "/home/dev/code/storefront", isDefault: true };

async function dispatch(env: ReturnType<typeof makeService>, overrides: Record<string, unknown> = {}) {
  const { task } = await env.service.launchTask(
    {
      title: "Add dark mode",
      role: "implement",
      brief: "Add a dark mode toggle.",
      repo: "acme/web",
      orchestratorThreadId: "thr_orch",
      projectId: PROJECT,
      ...overrides,
    },
    5_000,
  );
  return task;
}

function withLaptop(env: ReturnType<typeof makeService>) {
  env.chat.projectSources.set(PROJECT, [{ ...LAPTOP }]);
  return env;
}

const sourceIds = (env: ReturnType<typeof makeService>) => (env.chat.projectSources.get(PROJECT) ?? []).map((row) => row.id);
const events = (env: ReturnType<typeof makeService>, taskId: string, kind: string) =>
  env.store
    .events(taskId, 200)
    .filter((event) => event.kind === kind)
    .map((event) => event.text);

/** A bb with project pages, source calls and kv in memory. */
function fakeBb(sources: Record<string, { id: string; type?: string; hostId: string; path: string; isDefault?: boolean }[]>) {
  const calls: { method: string; args: unknown }[] = [];
  const kv = new Map<string, unknown>();
  let next = 0;
  const bb = {
    pluginId: "boat",
    storage: {
      kv: {
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
        delete: async (key: string) => void kv.delete(key),
        list: async (prefix = "") => [...kv.keys()].filter((key) => key.startsWith(prefix)),
      },
    },
    sdk: {
      projects: {
        get: async ({ projectId }: { projectId: string }) => {
          calls.push({ method: "projects.get", args: { projectId } });
          if (!(projectId in sources)) throw new Error("Project not found (404)");
          return { id: projectId, kind: "standard", sources: sources[projectId] };
        },
        sources: {
          add: async (args: { projectId: string; type: string; hostId: string; path: string }) => {
            calls.push({ method: "sources.add", args });
            const row = { id: `src_new${++next}`, projectId: args.projectId, type: "local_path", hostId: args.hostId, path: args.path, isDefault: false, createdAt: 1, updatedAt: 1 };
            sources[args.projectId]!.push(row);
            return row;
          },
          delete: async (args: { projectId: string; sourceId: string }) => {
            calls.push({ method: "sources.delete", args });
            const list = sources[args.projectId] ?? [];
            const index = list.findIndex((row) => row.id === args.sourceId);
            if (index < 0) throw new Error("Source not found (404)");
            list.splice(index, 1);
            return { ok: true };
          },
        },
      },
    },
  } as unknown as BbPluginApi;
  return { bb, calls, kv, sources };
}

test("the bb runner adds a local_path source for the machine's checkout, never as the default, and tracks it as Boat's", async () => {
  const { bb, calls, kv, sources } = fakeBb({ [PROJECT]: [{ ...LAPTOP, type: "local_path" }] });
  const runner = createChatRunner(bb);
  const made = await runner.ensureProjectSource({ taskId: "t_1", projectId: PROJECT, hostId: "host_9", path: CHECKOUT });
  assert.deepEqual(made, { sourceId: "src_new1", created: true, own: true });
  // Exactly bb's create request: no default flag (bb's schema is strict).
  assert.deepEqual(calls.find((call) => call.method === "sources.add")!.args, { projectId: PROJECT, type: "local_path", hostId: "host_9", path: CHECKOUT });
  assert.equal(sources[PROJECT]!.find((row) => row.id === "src_new1")!.isDefault, false);
  const own = (await runner.ownProjectSources()) as OwnProjectSource[];
  assert.equal(own.length, 1);
  assert.deepEqual({ ...own[0]!, createdAt: 0 }, { sourceId: "src_new1", projectId: PROJECT, hostId: "host_9", path: CHECKOUT, taskIds: ["t_1"], createdAt: 0 });
  assert.deepEqual([...kv.keys()], [`${PROJECT_SOURCE_KEY_PREFIX}src_new1`]);
});

test("the bb runner reuses a matching source: the user's stays theirs, Boat's gains the task", async () => {
  const { bb, calls } = fakeBb({ [PROJECT]: [{ ...LAPTOP, type: "local_path" }, { id: "src_user", type: "local_path", hostId: "host_9", path: `${CHECKOUT}/`, isDefault: false }] });
  const sources = createProjectSources(bb);
  // The user's own source for this machine and checkout (a trailing slash is the same path).
  assert.deepEqual(await sources.ensure({ taskId: "t_1", projectId: PROJECT, hostId: "host_9", path: CHECKOUT }), { sourceId: "src_user", created: false, own: false });
  assert.deepEqual(await sources.own(), []);
  // Another path on the same machine gets its own source; a second task there reuses it.
  const first = await sources.ensure({ taskId: "t_2", projectId: PROJECT, hostId: "host_9", path: "/home/user/work/t_2/web" });
  const second = await sources.ensure({ taskId: "t_3", projectId: PROJECT, hostId: "host_9", path: "/home/user/work/t_2/web" });
  assert.equal(first.created, true);
  assert.deepEqual(second, { sourceId: first.sourceId, created: false, own: true });
  assert.deepEqual((await sources.own()).map((row) => row.taskIds), [["t_2", "t_3"]]);
  assert.equal(calls.filter((call) => call.method === "sources.add").length, 1);
});

test("the bb runner deletes only sources Boat added: never the user's, and one bb already dropped just leaves the registry", async () => {
  const { bb, calls, sources } = fakeBb({ [PROJECT]: [{ ...LAPTOP, type: "local_path" }], proj_docs: [] });
  const runner = createChatRunner(bb);
  const ours = await runner.ensureProjectSource({ taskId: "t_1", projectId: PROJECT, hostId: "host_9", path: CHECKOUT });
  // Not in Boat's registry: bb isn't even asked.
  assert.equal(await runner.removeProjectSource(LAPTOP.id), false);
  assert.ok(!calls.some((call) => call.method === "sources.delete"));
  assert.equal(await runner.removeProjectSource(ours.sourceId), true);
  assert.deepEqual(calls.filter((call) => call.method === "sources.delete").map((call) => call.args), [{ projectId: PROJECT, sourceId: ours.sourceId }]);
  assert.deepEqual(sources[PROJECT]!.map((row) => row.id), [LAPTOP.id]);
  assert.deepEqual(await runner.ownProjectSources(), []);
  // Gone already (bb removed it with its machine, or the project): forgotten without a delete.
  const gone = await runner.ensureProjectSource({ taskId: "t_2", projectId: "proj_docs", hostId: "host_9", path: CHECKOUT });
  sources.proj_docs!.length = 0;
  assert.equal(await runner.removeProjectSource(gone.sourceId), true);
  const later = await runner.ensureProjectSource({ taskId: "t_3", projectId: "proj_docs", hostId: "host_9", path: CHECKOUT });
  delete sources.proj_docs;
  assert.equal(await runner.removeProjectSource(later.sourceId), true);
  assert.equal(calls.filter((call) => call.method === "sources.delete").length, 1);
  assert.deepEqual(await runner.ownProjectSources(), []);
});

test("a task chat outside Personal adds a source for its sandbox's checkout, then opens in its project", async () => {
  const env = withLaptop(makeService({ chat: true }));
  const sourcesAtSpawn: string[][] = [];
  const spawn = env.chat.spawn.bind(env.chat);
  env.chat.spawn = async (args: ChatSpawn) => {
    sourcesAtSpawn.push(sourceIds(env));
    return spawn(args);
  };
  const task = await dispatch(env);
  assert.equal(task.status, "running");
  assert.deepEqual(
    env.chat.sourceCalls.map((call) => call.method),
    ["ensure", "add"],
  );
  assert.deepEqual(env.chat.sourceCalls[1], { method: "add", projectId: PROJECT, hostId: "host_1", path: CHECKOUT, sourceId: "src_1" });
  // The source was there before the chat opened.
  assert.deepEqual(sourcesAtSpawn, [[LAPTOP.id, "src_1"]]);
  const chat = env.chat.spawns[0]!;
  assert.equal(chat.projectId, PROJECT);
  assert.deepEqual(chat.where, { kind: "machine", hostId: "host_1", path: CHECKOUT });
  assert.equal(chat.parentThreadId, "thr_orch");
  // Recorded on the task, and as Boat's, for this task.
  assert.deepEqual(events(env, task.id, "project-source"), [`Added the sandbox's checkout to bb project ${PROJECT} (source src_1)`]);
  assert.deepEqual(env.chat.ownSources.get("src_1")!.taskIds, [task.id]);
  assert.equal(env.chat.projectSources.get(PROJECT)!.find((row) => row.id === "src_1")!.isDefault, false);
  assert.deepEqual(events(env, task.id, "project-fallback"), []);
});

test("an existing source for the checkout is reused, and closing leaves it (Boat didn't add it)", async () => {
  const env = withLaptop(makeService({ chat: true }));
  env.chat.projectSources.get(PROJECT)!.push({ id: "src_user", hostId: "host_1", path: CHECKOUT, isDefault: false });
  const task = await dispatch(env);
  assert.deepEqual(
    env.chat.sourceCalls.map((call) => call.method),
    ["ensure"],
  );
  assert.equal(env.chat.spawns[0]!.projectId, PROJECT);
  assert.deepEqual(events(env, task.id, "project-source"), [`bb project ${PROJECT} already has the sandbox's checkout (source src_user, not added by Boat: it stays)`]);
  await env.service.closeTask(task.id, { discard: true });
  assert.ok(!env.chat.sourceCalls.some((call) => call.method === "delete"));
  assert.deepEqual(sourceIds(env), [LAPTOP.id, "src_user"]);
});

test("when adding the source fails, the chat opens in Personal under its orchestrator, and the task says why", async () => {
  const env = withLaptop(makeService({ chat: true }));
  env.chat.sourceAddError = new Error("Host is not connected (503)");
  const task = await dispatch(env);
  // The task runs; only the chat's project changed.
  assert.equal(task.status, "running");
  assert.equal(task.projectId, PROJECT);
  assert.equal(env.chat.spawns.length, 1);
  const chat = env.chat.spawns[0]!;
  assert.equal(chat.projectId, PERSONAL_PROJECT);
  assert.equal(chat.parentThreadId, "thr_orch");
  assert.deepEqual(chat.where, { kind: "machine", hostId: "host_1", path: CHECKOUT });
  const [why] = events(env, task.id, "project-fallback");
  assert.equal(why, `Couldn't add the sandbox's checkout to bb project ${PROJECT}: Host is not connected (503). Opened the chat in Personal instead, still under its orchestrator.`);
  assert.ok(env.warnings.some((line) => line.includes("Host is not connected")));
  assert.deepEqual(sourceIds(env), [LAPTOP.id]);
  // Later chats in its workspace open where the workspace is.
  const extra = await env.service.openWorkspaceChat(task.id, { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high", permissionMode: "full", input: [] });
  assert.equal(env.chat.composed.find((entry) => entry.threadId === extra)!.projectId, PERSONAL_PROJECT);
});

test("bb refusing the chat for want of a source still falls back to Personal", async () => {
  const env = makeService({ chat: true });
  const spawn = env.chat.spawn.bind(env.chat);
  let refusals = 0;
  env.chat.spawn = async (args: ChatSpawn) => {
    if (args.projectId === PROJECT && refusals++ === 0) throw new Error("No project source configured for this host (409)");
    return spawn(args);
  };
  const task = await dispatch(env);
  assert.equal(task.status, "running");
  assert.equal(env.chat.spawns.length, 1);
  assert.equal(env.chat.spawns[0]!.projectId, PERSONAL_PROJECT);
  assert.match(events(env, task.id, "project-fallback")[0]!, /^bb refused the chat in project proj_storefront: No project source configured for this host \(409\)\. Opened the chat in Personal instead/);
});

test("other spawn errors still fail the dispatch, and the source Boat added goes with the machine", async () => {
  const env = withLaptop(makeService({ chat: true }));
  env.chat.spawnError = new Error("provider unavailable");
  await assert.rejects(dispatch(env), /provider unavailable/);
  const [task] = env.store.list({ limit: 10 });
  assert.equal(task!.status, "failed");
  assert.deepEqual(env.chat.removed, ["host_1"]);
  assert.deepEqual(sourceIds(env), [LAPTOP.id]);
  assert.equal(env.chat.ownSources.size, 0);
  assert.deepEqual(events(env, task!.id, "project-fallback"), []);
});

test("closing a task removes only the source Boat added for it, never the user's", async () => {
  const env = withLaptop(makeService({ chat: true }));
  const task = await dispatch(env);
  assert.deepEqual(sourceIds(env), [LAPTOP.id, "src_1"]);
  const closed = await env.service.closeTask(task.id, { discard: true });
  assert.equal(closed.sandbox, "deleted");
  assert.deepEqual(
    env.chat.sourceCalls.filter((call) => call.method === "delete"),
    [{ method: "delete", projectId: PROJECT, sourceId: "src_1" }],
  );
  assert.deepEqual(sourceIds(env), [LAPTOP.id]);
  assert.equal(env.chat.ownSources.size, 0);
  assert.deepEqual(events(env, task.id, "project-source").at(-1), `Removed the sandbox's checkout from bb project ${PROJECT} (source src_1)`);
});

test("closing with the sandbox kept still removes Boat's source; one another open task uses stays", async () => {
  const env = withLaptop(makeService({ chat: true }));
  const task = await dispatch(env);
  const other = await dispatch(env, { title: "Add a footer", repo: "acme/web" });
  const ours = env.chat.ownSources.get("src_1")!;
  // Both use src_1 (as if the second task's chat reused it).
  ours.taskIds.push(other.id);
  await env.service.closeTask(task.id, { discard: true, keepSandbox: true });
  assert.ok(env.chat.ownSources.has("src_1"), "another open task uses it");
  const second = env.chat.ownSources.get("src_2")!;
  assert.deepEqual(second.taskIds, [other.id]);
  await env.service.closeTask(other.id, { discard: true, keepSandbox: true });
  assert.equal(env.chat.ownSources.size, 0);
  assert.deepEqual(sourceIds(env), [LAPTOP.id]);
});

test("an archived task chat cancels its task and removes Boat's source", async () => {
  const env = withLaptop(makeService({ chat: true }));
  const task = await dispatch(env);
  env.chat.states.get(task.threadId!)!.archived = true;
  await env.service.sweep();
  assert.equal(env.store.get(task.id)!.status, "cancelled");
  assert.deepEqual(sourceIds(env), [LAPTOP.id]);
});

test("the sweep removes Boat's sources whose machine is gone or that no open task uses, and keeps the rest", async () => {
  const env = withLaptop(makeService({ chat: true }));
  const live = await dispatch(env);
  const lost = await dispatch(env, { title: "Add a footer" });
  // Left from before a restart: its task is gone.
  env.chat.projectSources.get(PROJECT)!.push({ id: "src_old", hostId: "host_old", path: "/home/user/work/old", isDefault: false });
  env.chat.ownSources.set("src_old", { sourceId: "src_old", projectId: PROJECT, hostId: "host_old", path: "/home/user/work/old", taskIds: ["t_gone"], createdAt: 1 });
  // bb no longer knows the second task's machine.
  env.chat.forgottenHosts.add(lost.hostId!);
  // The plugin after a reload: the first sweep looks.
  const reloaded = makeService({ chat: true, reuse: { store: env.store, chat: env.chat, boat: env.boat } });
  await reloaded.service.sweep();
  assert.deepEqual(sourceIds(env), [LAPTOP.id, "src_1"]);
  assert.deepEqual([...env.chat.ownSources.keys()], ["src_1"]);
  assert.deepEqual(env.chat.ownSources.get("src_1")!.taskIds, [live.id]);
  assert.ok(!env.chat.sourceCalls.some((call) => call.method === "delete" && call.sourceId === LAPTOP.id));
  // Nothing left to do: a direct sweep removes nothing more.
  assert.equal(await reloaded.service.sweepProjectSources(), 0);
});

test("a failed delete is left for the sweep", async () => {
  const env = withLaptop(makeService({ chat: true }));
  const task = await dispatch(env);
  env.chat.sourceDeleteError = new Error("bb is restarting (503)");
  await env.service.closeTask(task.id, { discard: true });
  assert.ok(env.chat.ownSources.has("src_1"));
  assert.equal(env.store.get(task.id)!.status, "cancelled");
  env.chat.sourceDeleteError = null;
  assert.equal(await env.service.sweepProjectSources(), 1);
  assert.deepEqual(sourceIds(env), [LAPTOP.id]);
});

test("Personal task chats are unchanged: no source, a personal workspace on the machine", async () => {
  for (const projectId of [PERSONAL_PROJECT, null]) {
    const env = makeService({ chat: true });
    const task = await dispatch(env, { projectId });
    assert.equal(task.status, "running");
    assert.deepEqual(env.chat.sourceCalls, []);
    assert.equal(env.chat.spawns[0]!.projectId, projectId);
    assert.deepEqual(env.chat.spawns[0]!.where, { kind: "machine", hostId: "host_1", path: CHECKOUT });
    assert.deepEqual(events(env, task.id, "project-source"), []);
    assert.deepEqual(events(env, task.id, "project-fallback"), []);
    await env.service.closeTask(task.id, { discard: true });
    assert.deepEqual(env.chat.sourceCalls, []);
  }
});

const FINISHED = "Done.\n\n=== REPORT ===\nSTATUS: done\nPR: none\nBRANCH: boat/x\nSUMMARY: done\nTESTS: ok\nOPEN QUESTIONS: none\n=== END REPORT ===";

/** A review of the task in its shared workspace (reviewSandbox "same"). */
async function reviewOf(env: ReturnType<typeof makeService>, taskId: string) {
  await env.service.sweep();
  env.chat.finish(env.store.get(taskId)!.threadId!, FINISHED);
  await env.service.sweep();
  await env.service.deliverPending();
  const { task: review } = await env.service.launchTask({ ...(await env.service.reviewInput(taskId)), projectId: PROJECT }, 5_000);
  return { review, spawn: env.chat.spawns.find((entry) => entry.taskId === review.id)! };
}

test("a review in the shared workspace stays in the project, or in Personal after its task's fallback", async () => {
  const shared = withLaptop(makeService({ chat: true, settings: { reviewSandbox: "same" } }));
  const task = await dispatch(shared);
  const { review, spawn } = await reviewOf(shared, task.id);
  assert.equal(spawn.where.kind, "environment");
  assert.equal(spawn.projectId, PROJECT);
  // It joins the existing workspace: no source of its own.
  assert.equal(shared.chat.sourceCalls.filter((call) => call.method === "ensure").length, 1);
  assert.deepEqual(events(shared, review.id, "project-fallback"), []);

  const env = withLaptop(makeService({ chat: true, settings: { reviewSandbox: "same" } }));
  env.chat.sourceAddError = new Error("Host is not connected (503)");
  const fellBack = await dispatch(env);
  env.chat.sourceAddError = null;
  const after = await reviewOf(env, fellBack.id);
  assert.equal(after.spawn.where.kind, "environment");
  assert.equal(after.spawn.projectId, PERSONAL_PROJECT);
  // Nested as before (under the task's chat), whatever the project.
  assert.equal(after.spawn.parentThreadId, env.store.get(fellBack.id)!.threadId);
  assert.equal(spawn.parentThreadId, shared.store.get(task.id)!.threadId);
  assert.deepEqual(events(env, after.review.id, "project-fallback"), [`Opened the chat in Personal, like task ${fellBack.id}'s chat whose workspace it shares.`]);
});

/** A headless task in the project whose first turn finished ("Continue as a chat" can move it). */
async function headless() {
  const made = withLaptop(
    makeService({
      chat: true,
      settings: { workerMode: "chat", adhocWorkerMode: "boat" },
      connect: { state: "ready", fix: null },
      repoWorkerMode: (repo) => (repo === "acme/web" ? "chat" : null),
    }),
  );
  made.boat.limitsValue.maxActiveSandboxes = 20;
  const { task } = await made.service.launchTask(
    { title: "Fix the header", role: "implement", brief: "Fix the header on phones.", repo: "acme/web", orchestratorThreadId: "thr_orch", tier: "build", runner: "boat", projectId: PROJECT },
    5_000,
  );
  made.boat.finish(task.conversationId!, FINISHED);
  await made.service.sweep();
  return { made, task: made.store.get(task.id)! };
}

test("continuing a headless task as a chat adds the source first; a move that fails takes it back", async () => {
  const { made, task } = await headless();
  const { task: moved } = await made.service.continueAsChat(task.id, { confirmUntrusted: null, via: "page", waitMs: 5_000 });
  assert.equal(moved.runner, "chat");
  const spawn = made.chat.spawns[0]!;
  assert.equal(spawn.projectId, PROJECT);
  assert.deepEqual(spawn.where, { kind: "machine", hostId: moved.hostId, path: task.repoPath });
  assert.deepEqual(made.chat.ownSources.get("src_1")!.taskIds, [task.id]);

  const failing = await headless();
  failing.made.chat.spawnError = new Error("provider unavailable");
  await assert.rejects(failing.made.service.continueAsChat(failing.task.id, { confirmUntrusted: null, via: "page", waitMs: 5_000 }), /provider unavailable/);
  assert.equal(failing.made.store.get(failing.task.id)!.runner, "boat");
  // The task stays headless: Boat's source goes, the user's stays.
  assert.equal(failing.made.chat.ownSources.size, 0);
  assert.deepEqual(sourceIds(failing.made), [LAPTOP.id]);
});
