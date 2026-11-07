// Entry points outside the Cloud agents page (web/entry-points.tsx): their
// pure logic (web/entry-logic.ts) and the RPC behind them (threadRoles,
// bbProjectRepo, setOrchestrator with a project, Ship from a task chat).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SandboxSizeDto, TaskDto, ThreadRoleDto } from "../contract.ts";
import plugin from "../server.ts";
import { TaskStore, type Task } from "../src/store.ts";
import {
  CLOUD_AGENT_PREFIX,
  coordinateAction,
  coordinateProject,
  prefixDraft,
  reviewFromChat,
  shipFromChat,
  sizeChipState,
  unprefixDraft,
} from "../web/entry-logic.ts";
import { createTestHost } from "./fakes.ts";

// ------------------------------------------------------------------ logic

test("Send to a cloud agent puts the instruction first and moves mention pills along", () => {
  const mention = { from: 6, to: 12, label: "@notes", kind: "path" as const, path: "notes.md", source: "workspace" as const, entryKind: "file" as const };
  const draft = { text: "Check @notes for the bug", mentions: [mention] };
  const sent = prefixDraft(draft, CLOUD_AGENT_PREFIX);
  assert.equal(sent.text, `${CLOUD_AGENT_PREFIX}Check @notes for the bug`);
  assert.equal(sent.text.slice(sent.mentions[0]!.from, sent.mentions[0]!.to), "@notes");
  assert.equal(sent.mentions[0]!.path, "notes.md", "the pill keeps what it points at");
  assert.match(CLOUD_AGENT_PREFIX, /cloud agent/);
  assert.match(CLOUD_AGENT_PREFIX, /`bb boat task start`/);

  // A send that didn't go out gets its draft back as it was.
  assert.deepEqual(unprefixDraft(sent, CLOUD_AGENT_PREFIX), { text: draft.text, mentions: [mention] });
  assert.equal(unprefixDraft(draft, CLOUD_AGENT_PREFIX), null);
});

const task = (patch: Partial<TaskDto> = {}): TaskDto =>
  ({ id: "t_1", title: "Header", role: "implement", status: "idle", canShip: false, delivery: "pr", ...patch }) as TaskDto;
const taskRole = (patch: Partial<TaskDto> = {}): ThreadRoleDto => ({ kind: "task", task: task(patch) });

test("header actions: Ship when the task can ship, Request review on open tasks, nothing on other chats", () => {
  assert.equal(shipFromChat(taskRole({ canShip: true }))?.id, "t_1");
  assert.equal(shipFromChat(taskRole({ canShip: false })), null);
  assert.equal(shipFromChat({ kind: "orchestrator" }), null);
  assert.equal(shipFromChat(undefined), null);

  assert.deepEqual(reviewFromChat(taskRole())?.disabled, false);
  assert.equal(reviewFromChat(taskRole({ status: "running" }))?.disabled, true, "disabled while the agent works, as on the task page");
  assert.equal(reviewFromChat(taskRole({ status: "starting" }))?.disabled, true);
  assert.equal(reviewFromChat(taskRole({ role: "review" })), null, "a review isn't reviewed");
  assert.equal(reviewFromChat(taskRole({ status: "done" })), null);
  assert.equal(reviewFromChat(taskRole({ status: "cancelled" })), null);
  assert.equal(reviewFromChat({ kind: "chat" }), null);
});

test("thread menu: plain chats can coordinate, orchestrators can stop, task chats get neither", () => {
  assert.equal(coordinateAction({ kind: "chat" }, false), "coordinate");
  assert.equal(coordinateAction({ kind: "chat" }, true), null, "not from an archived chat");
  assert.equal(coordinateAction({ kind: "orchestrator" }, false), "stop");
  assert.equal(coordinateAction(taskRole(), false), null);
  assert.equal(coordinateAction(undefined, false), null, "nothing while the role loads");
});

const size = (type: SandboxSizeDto["type"], available = true, reason: string | null = null): SandboxSizeDto => ({
  type,
  label: { small: "Small", default: "Default", large: "Large", xlarge: "XLarge" }[type],
  detail: "",
  available,
  reason,
});
const SIZES = [size("small"), size("default"), size("large", false, "needs a paid plan"), size("xlarge", false, null)];

test("the size chip reports the picked size, else lets the setting decide; sizes off the plan block the send", () => {
  // Nothing picked yet: {} (Size for chats on a Boat sandbox applies at creation), shown as that size.
  assert.deepEqual(sizeChipState(null, SIZES, "small"), { type: "small", picked: false, adopted: false, change: { status: "ready", value: {} } });
  assert.deepEqual(sizeChipState({}, SIZES, "default").type, "default");
  // Picked.
  assert.deepEqual(sizeChipState({ type: "default" }, SIZES, "small").change, { status: "ready", value: { type: "default" } });
  // A size the plan can't use (boat's reason, else a plain one).
  assert.deepEqual(sizeChipState({ type: "large" }, SIZES, "small").change, { status: "blocked", reason: "Large: needs a paid plan" });
  assert.deepEqual(sizeChipState({ type: "xlarge" }, SIZES, "small").change, { status: "blocked", reason: "XLarge isn't on your boat plan" });
  assert.equal(sizeChipState(null, SIZES, "large").change.status, "blocked", "the default itself can be off the plan");
  // boat couldn't be read: every size is allowed.
  assert.deepEqual(sizeChipState({ type: "xlarge" }, null, "small").change, { status: "ready", value: { type: "xlarge" } });
  // Junk is ignored; a prepared sandbox (a task chat's machine) keeps its inputs and has no size to pick.
  assert.deepEqual(sizeChipState({ type: "huge" }, SIZES, "small").change, { status: "ready", value: {} });
  assert.deepEqual(sizeChipState("small", SIZES, "small").change, { status: "ready", value: {} });
  const adopted = sizeChipState({ sandboxId: "bx_1", taskId: "t_1", extra: 1 }, SIZES, "small");
  assert.equal(adopted.adopted, true);
  assert.deepEqual(adopted.change, { status: "ready", value: { sandboxId: "bx_1", taskId: "t_1" } });
});

test("the project a chat coordinates: its own repo's, the only one, else the newest orchestrator's", () => {
  const projects = [{ id: "web" }, { id: "api" }];
  const orchestrators = [
    { projectId: "web", createdAt: "2026-11-01T00:00:00Z" },
    { projectId: "api", createdAt: "2026-11-03T00:00:00Z" },
    { projectId: "gone", createdAt: "2026-11-05T00:00:00Z" },
  ];
  assert.equal(coordinateProject({ matchId: "web", projects, orchestrators }), "web");
  assert.equal(coordinateProject({ matchId: null, projects, orchestrators }), "api");
  assert.equal(coordinateProject({ matchId: "gone", projects, orchestrators: [] }), null);
  assert.equal(coordinateProject({ matchId: null, projects: [{ id: "only" }], orchestrators }), "only");
  assert.equal(coordinateProject({ matchId: null, projects: [], orchestrators }), null);
});

// ------------------------------------------------------------------ RPC

const fakeBoat = fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url));

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "boat-entry-test-"));
  const statePath = join(dir, "state.json");
  process.env.FAKE_BOAT_STATE = statePath;
  const { bb, harness } = await createTestHost({ pluginId: "boat", settings: { boatPath: fakeBoat, evidenceUploader: "" } });
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({ id: threadId, environmentId: null, deletedAt: null, archivedAt: null }));
  harness.sdk.stub("threads.send", async () => ({ ok: true, delivery: "sent" }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
  await plugin(bb);
  const store = new TaskStore(() => bb.storage.database());
  for (const args of [
    ["--name", "Storefront", "--repo", "acme/storefront@master", "--delivery", "push"],
    ["--name", "Storefront and API", "--repo", "acme/web@main", "--repo", "acme/api@main"],
  ]) {
    const added = await harness.runCli(["project", "add", ...args]);
    assert.equal(added.exitCode, 0, added.stderr || added.stdout);
  }
  return { harness, store, statePath };
}

/** A task chat's task, as the store holds one (task chats need bb Connect, which tests don't have). */
function chatTask(store: TaskStore, patch: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  const row: Task = {
    id: "t_chat01", title: "Header", role: "implement", status: "idle", orchestratorThreadId: "thr_plain", projectId: "storefront",
    repo: "acme/storefront", repoPath: "/home/user/work/storefront", branch: "boat/t_chat01-header", baseBranch: "master", sandboxId: "bx_test1",
    conversationId: null, promptId: null, provider: "claude", model: null, reasoningEffort: null, tier: null, reason: null, runner: "chat",
    threadId: "thr_worker", hostId: "host_1", environmentId: "env_1", readyAt: null, readyNote: null, delivery: "push", boatProject: null,
    environment: null, snapshot: null, extraRepos: [], brief: "b", parentTaskId: null, prUrl: null, result: null, error: null, turns: 1,
    ownsSandbox: true, createdAt: now, updatedAt: now, finishedAt: now, notifiedAt: now, unshipped: null, shipApproval: null,
    ...patch,
  };
  store.insert(row);
  store.addEvent(row.id, "chat", row.threadId!);
  return row;
}

type Roles = Record<string, ThreadRoleDto>;

test("threadRoles tells task chats, orchestrators and plain chats apart", async (t) => {
  const { harness, store } = await setup();
  t.after(() => harness.lifecycle.dispose());
  chatTask(store);
  // A second chat in the task's workspace (New chat in the strip) is a task chat too.
  store.addEvent("t_chat01", "chat-extra", "thr_second");
  await harness.callRpc("setOrchestrator", { threadId: "thr_orch", on: true });

  const roles = (await harness.callRpc("threadRoles", { keys: ["thr_worker", "thr_second", "thr_orch", "thr_plain", "thr_unknown"] })) as Roles;
  assert.equal(roles.thr_worker?.kind, "task");
  assert.equal(roles.thr_worker?.kind === "task" && roles.thr_worker.task.id, "t_chat01");
  assert.equal(roles.thr_worker?.kind === "task" && roles.thr_worker.task.canShip, true);
  assert.equal(roles.thr_second?.kind, "task");
  assert.deepEqual(roles.thr_orch, { kind: "orchestrator" });
  assert.deepEqual(roles.thr_plain, { kind: "chat" }, "a chat that only started a task is a plain chat");
  assert.deepEqual(roles.thr_unknown, { kind: "chat" });
});

test("setOrchestrator: a chat coordinates a project, task chats can't, and it can stop", async (t) => {
  const { harness, store } = await setup();
  t.after(() => harness.lifecycle.dispose());
  chatTask(store);

  await harness.callRpc("setOrchestrator", { threadId: "thr_plain", on: true, project: { kind: "boat", id: "storefront" } });
  const listed = (await harness.callRpc("orchestrators", null)) as { orchestrators: { threadId: string; projectName: string | null }[] };
  assert.equal(listed.orchestrators.find((entry) => entry.threadId === "thr_plain")?.projectName, "Storefront");
  const metadata = harness.inspection.sdk.callsTo("threads.updatePluginMetadata").map((call) => call[0] as { threadId: string; set?: { role?: string; project?: { name?: string } } });
  assert.equal(metadata.at(-1)?.set?.role, "orchestrator");
  assert.equal(metadata.at(-1)?.set?.project?.name, "Storefront");
  // Its task now waits on it, so the chat isn't a plain chat any more.
  assert.deepEqual(((await harness.callRpc("threadRoles", { keys: ["thr_plain"] })) as Roles).thr_plain, { kind: "orchestrator" });

  await assert.rejects(harness.callRpc("setOrchestrator", { threadId: "thr_x", on: true, project: { kind: "boat", id: "nope" } }), /No project "nope"/);
  await assert.rejects(harness.callRpc("setOrchestrator", { threadId: "thr_worker", on: true }), /runs a task/);

  await harness.callRpc("setOrchestrator", { threadId: "thr_plain", on: false });
  const after = (await harness.callRpc("orchestrators", null)) as { orchestrators: { threadId: string }[] };
  assert.equal(after.orchestrators.some((entry) => entry.threadId === "thr_plain"), false);
  assert.deepEqual(((await harness.callRpc("threadRoles", { keys: ["thr_plain"] })) as Roles).thr_plain, { kind: "chat" });
});

test("bbProjectRepo finds a bb project's repo and the project that has it", async (t) => {
  const { harness } = await setup();
  t.after(() => harness.lifecycle.dispose());
  harness.sdk.stub("projects.list", async () => [
    { id: "proj_store", name: "Storefront", gitRemoteUrl: "git@github.com:acme/storefront.git" },
    { id: "proj_api", name: "API", gitRemoteUrl: "https://github.com/acme/api.git" },
    { id: "proj_other", name: "Other", gitRemoteUrl: "https://github.com/acme/other" },
    { id: "proj_personal", name: "Personal", gitRemoteUrl: null },
  ]);
  const repo = (bbProjectId: string) => harness.callRpc("bbProjectRepo", { bbProjectId });
  assert.deepEqual(await repo("proj_store"), { repo: "acme/storefront", projectId: "storefront" });
  assert.deepEqual(await repo("proj_api"), { repo: "acme/api", projectId: "storefront-and-api" }, "a project's second repo counts too");
  assert.deepEqual(await repo("proj_other"), { repo: "acme/other", projectId: null });
  assert.deepEqual(await repo("proj_personal"), { repo: null, projectId: null });
  assert.deepEqual(await repo("proj_missing"), { repo: null, projectId: null });
});

test("the old Ship RPC cannot bypass the in-thread confirmation", async (t) => {
  const { harness, store, statePath } = await setup();
  t.after(() => harness.lifecycle.dispose());
  // The task's sandbox, as boat knows it.
  const state = (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { sandboxes: {}, convos: {}, calls: [], next: 2 }) as {
    sandboxes: Record<string, unknown>;
  };
  state.sandboxes.bx_test1 = { id: "bx_test1", name: "t_chat01", state: "idle", health: "ok", createdAt: new Date().toISOString() };
  writeFileSync(statePath, JSON.stringify(state));
  chatTask(store);

  await assert.rejects(harness.callRpc("shipTask", { id: "t_chat01", from: "chat" }), /confirm it in the task chat/);
  assert.equal(store.latestEvent("t_chat01", "shipped"), null);
  assert.equal(store.get("t_chat01")?.status, "idle");
});

test("native size changes preserve snapshots and prepared sandbox keep flags", () => {
  assert.deepEqual(sizeChipState({ type: "default", snapshot: "repo-base" }, SIZES, "small").change, { status: "ready", value: { type: "default", snapshot: "repo-base" } });
  assert.deepEqual(sizeChipState({ sandboxId: "bx_ready", taskId: "t_1234", keepSandbox: true }, SIZES, "small").change, { status: "ready", value: { sandboxId: "bx_ready", taskId: "t_1234", keepSandbox: true } });
});

test("native size changes preserve only validated explicit reviewer policy", () => {
  assert.deepEqual(sizeChipState({type:"default",reviewer:"none",snapshot:"repo-base"}, SIZES,"small").change,{status:"ready",value:{type:"default",reviewer:"none",snapshot:"repo-base"}});
  assert.deepEqual(sizeChipState({type:"default",reviewer:"untrusted"}, SIZES,"small").change,{status:"ready",value:{type:"default"}});
});
