// Continue as a chat: a headless task moves into a task chat on its own sandbox.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConnectStatus } from "../src/connect.ts";
import { notificationText } from "../src/format.ts";
import { TaskError, type StartTaskInput } from "../src/service.ts";
import type { Runner, Task } from "../src/store.ts";
import { makeService } from "./fakes.ts";

const READY: ConnectStatus = { state: "ready", fix: null };
const REPORT = `Done.

=== REPORT ===
STATUS: partial
PR: none
BRANCH: boat/x
SUMMARY: The header is fixed; the test is missing.
TESTS: ok
OPEN QUESTIONS: none
=== END REPORT ===`;

/** acme/web is in a project that runs tasks as chats. */
const projects = (repo: string): Runner | null => (repo === "acme/web" ? "chat" : null);

function env(options: { connect?: ConnectStatus | (() => ConnectStatus); chat?: boolean } = {}) {
  const made = makeService({
    chat: options.chat ?? true,
    settings: { workerMode: "chat", adhocWorkerMode: "boat" },
    connect: options.connect ?? READY,
    repoWorkerMode: projects,
  });
  made.boat.limitsValue.maxActiveSandboxes = 20;
  return made;
}
type Env = ReturnType<typeof env>;

/** A headless task whose first turn finished with a report. */
async function headless(made: Env, overrides: Partial<StartTaskInput> = {}): Promise<Task> {
  const { task } = await made.service.launchTask(
    {
      title: "Fix the header",
      role: "implement",
      brief: "Fix the header on phones.",
      repo: "acme/web",
      orchestratorThreadId: "thr_orch",
      tier: "build",
      runner: "boat",
      ...overrides,
    },
    5_000,
  );
  made.boat.finish(task.conversationId!, REPORT);
  await made.service.sweep();
  const done = made.store.get(task.id)!;
  assert.equal(done.status, "idle");
  return done;
}

const move = (made: Env, id: string, options: { confirmUntrusted?: string[] | null; via?: "page" | "cli"; waitMs?: number } = {}) =>
  made.service.continueAsChat(id, { confirmUntrusted: options.confirmUntrusted ?? null, via: options.via ?? "page", waitMs: options.waitMs ?? 5_000 });

async function refused(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<TaskError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof TaskError, String(error));
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(`${error.message} ${error.hint ?? ""}`, pattern);
    return error;
  }
  assert.fail(`expected ${code}`);
}

const moveEvents = (made: Env, id: string) =>
  made.store
    .events(id, 200)
    .filter((event) => ["chat-move", "machine", "bb-installed", "transcript", "chat", "chat-info", "moved-to-chat", "chat-move-failed"].includes(event.kind))
    .map((event) => event.kind);

/** Nothing of a chat was made. */
function nothingMade(made: Env) {
  assert.equal(made.chat.machines.length, 0);
  assert.equal(made.chat.files.length, 0);
  assert.equal(made.chat.spawns.length, 0);
}

/** The move failed and left a working headless task behind. */
async function stillHeadless(made: Env, before: Task) {
  const task = made.store.get(before.id)!;
  assert.equal(task.runner, "boat");
  assert.equal(task.status, before.status);
  assert.equal(task.threadId, null);
  assert.equal(made.store.events(task.id, 200).filter((event) => event.kind.startsWith("chat-move") || event.kind === "moved-to-chat").at(-1)?.kind, "chat-move-failed");
  assert.ok(!made.boat.calls.some((call) => call.startsWith("delete ")), made.boat.calls.join("\n"));
  const prompts = made.boat.prompts.length;
  await made.service.followup(task.id, "Add the missing test.");
  assert.equal(made.boat.prompts.length, prompts + 1, "a follow-up still goes to boat");
  assert.equal(made.chat.sends.length, 0);
}

test("continue as a chat: bb on the stopped sandbox, the conversation outside the repo, a chat with the same agent in the same checkout", async () => {
  const made = env();
  const task = await headless(made);
  made.boat.sandboxes.get(task.sandboxId!)!.state = "stopped";
  const { task: moved, pending } = await move(made, task.id);
  assert.equal(pending, false);

  // The sandbox came back up (and was kept up) before bb went on it, with the keep flag.
  assert.ok(made.boat.calls.some((call) => call.startsWith(`resume ${task.sandboxId}`)), made.boat.calls.join("\n"));
  assert.ok(made.boat.extended.some((entry) => entry.id === task.sandboxId));
  const machine = made.chat.machines[0]!;
  assert.equal(machine.keepSandbox, true);
  assert.match(machine.key, new RegExp(`^task-${task.id}-m`));

  // The conversation, outside the checkout.
  const file = made.chat.files[0]!;
  assert.equal(file.hostId, machine.hostId);
  assert.equal(file.path, `/home/user/.boat-tasks/${task.id}/conversation.md`);
  assert.ok(!file.path.startsWith(`${task.repoPath}/`));
  assert.match(file.content, /# Implementation task/);
  assert.match(file.content, /The header is fixed; the test is missing\./);

  // The chat: same agent, bb's model id, the task's checkout on the machine.
  const spawn = made.chat.spawns[0]!;
  assert.deepEqual(spawn.where, { kind: "machine", hostId: machine.hostId, path: task.repoPath });
  assert.equal(spawn.provider, "claude");
  assert.equal(spawn.model, "claude-opus-5-5");
  assert.equal(spawn.effort, "xhigh");
  assert.equal(spawn.parentThreadId, "thr_orch");
  assert.match(spawn.prompt, /Fix the header on phones\./);
  assert.match(spawn.prompt, /## Latest report\n[\s\S]*The header is fixed/);
  assert.match(spawn.prompt, new RegExp(`/home/user/\\.boat-tasks/${task.id}/conversation\\.md`));
  assert.match(spawn.prompt, /## Push rules\n- Never push to `main`/);
  assert.match(spawn.prompt, /```text\n=== REPORT ===/);
  assert.match(spawn.prompt, /Don't change, commit or push anything in this turn/);

  // The task is a chat task now; the old conversation stays readable.
  assert.equal(moved.runner, "chat");
  assert.equal(moved.status, "running");
  assert.equal(moved.hostId, machine.hostId);
  assert.equal(moved.threadId, spawn.threadId);
  assert.equal(moved.turns, task.turns + 1);
  assert.equal(moved.conversationId, task.conversationId);
  assert.equal(moved.model, "claude-opus-5-5");
  assert.deepEqual(moveEvents(made, task.id), ["chat-move", "machine", "bb-installed", "machine", "transcript", "chat", "chat-info", "moved-to-chat"]);
  assert.match(made.store.latestEvent(task.id, "moved-to-chat")!.text, /Moved to the task chat @thread:thr_w\d+ \(claude · Build · claude-opus-5-5 · xhigh\)/);
  // The keep flag is gone: closing the chat task deletes the sandbox like any task chat's.
  assert.deepEqual(made.chat.settled, [machine.key]);
  assert.equal(made.chat.kept.size, 0);
  assert.equal(made.service.isMovingToChat(task.id), false);
});

test("a Deep task gets Ultracode back, and its working mode is for after the read-up", async () => {
  const made = env();
  const task = await headless(made, { tier: "deep" });
  assert.equal(task.reasoningEffort, "max");
  await move(made, task.id);
  const spawn = made.chat.spawns[0]!;
  assert.equal(spawn.effort, "ultracode");
  assert.match(spawn.prompt, /## Working mode \(from the next message on\)/);
});

test("after the move it's a chat task: no boat polling, turn ends and notices as for chats, follow-ups and close go through bb", async () => {
  const made = env();
  const task = await headless(made);
  const { task: moved } = await move(made, task.id);
  let polled = 0;
  const events = made.boat.events.bind(made.boat);
  made.boat.events = async (...args: Parameters<typeof made.boat.events>) => {
    polled += 1;
    return events(...args);
  };
  const notices = made.notifications.length;
  await made.service.sweep(); // the read-up turn is busy
  made.chat.finish(moved.threadId!, REPORT);
  await made.service.sweep();
  assert.equal(polled, 0, "the boat conversation isn't polled any more");
  const read = made.store.get(task.id)!;
  assert.equal(read.status, "idle");
  assert.equal(made.notifications.length, notices + 1);
  const text = notificationText(made.notifications.at(-1)!.tasks, (id) => made.store.events(id, 30));
  assert.match(text, new RegExp(`The user moved this task into the task chat @thread:${moved.threadId}`));
  assert.match(text, /don't send follow-ups unless they ask/);

  await made.service.followup(task.id, "Now add the test.");
  assert.equal(made.chat.sends.at(-1)!.threadId, moved.threadId);
  assert.equal(made.boat.prompts.length, 1, "nothing more to boat");
  await made.service.sweep();
  made.chat.finish(moved.threadId!, REPORT);
  await made.service.sweep();
  await made.service.sweep();

  // Reviews of a trusted moved task follow it as chats.
  const { task: review } = await made.service.launchTask(await made.service.reviewInput(task.id, { sandbox: "new" }), 5_000);
  assert.equal(review.runner, "chat");
  await made.service.closeTask(review.id, { status: "done" });

  await made.service.closeTask(task.id, { status: "done" });
  assert.ok(made.chat.removed.includes(moved.hostId!));
  assert.ok(made.chat.archived.includes(moved.threadId!));
  assert.ok(!made.boat.calls.includes(`delete ${task.sandboxId}`), "bb deletes it through the machine");
});

test("a move from the CLI tells the orchestrator in other words", async () => {
  const made = env();
  const task = await headless(made);
  const { task: moved } = await move(made, task.id, { via: "cli" });
  await made.service.sweep();
  made.chat.finish(moved.threadId!, REPORT);
  await made.service.sweep();
  const text = notificationText(made.notifications.at(-1)!.tasks, (id) => made.store.events(id, 30));
  assert.match(text, /This task moved into the task chat @thread:\S+ \(from the CLI\)/);
});

test("bb already on the sandbox: a closed task chat's kept machine is reused (resumed through bb), and its sandbox kept during the move", async () => {
  const made = env();
  const { task: chatTask } = await made.service.launchTask({ title: "Chat", role: "implement", brief: "b", repo: "acme/web", orchestratorThreadId: null }, 5_000);
  assert.equal(chatTask.runner, "chat");
  const task = await headless(made, { sandbox: chatTask.sandboxId });
  await made.service.closeTask(chatTask.id, { status: "done", keepSandbox: true });
  const sandbox = made.boat.sandboxes.get(task.sandboxId!)!;
  sandbox.state = "stopped";
  made.chat.resumeMachine = async (hostId: string) => {
    made.chat.resumed.push(hostId);
    sandbox.state = "idle";
  };
  // A task on a sandbox it didn't create still counts: a plugin task created it.
  const { task: moved } = await move(made, task.id);
  assert.equal(made.chat.machines.length, 1, "no new machine");
  assert.deepEqual(made.chat.resumed, [chatTask.hostId]);
  assert.ok(!made.boat.calls.some((call) => call.startsWith(`resume ${task.sandboxId}`)));
  assert.equal(moved.hostId, chatTask.hostId);
  assert.match(made.store.latestEvent(task.id, "machine")!.text, /bb already runs on the sandbox/);
  assert.equal(made.store.latestEvent(task.id, "bb-installed"), null);
  // Kept for the move's length only.
  assert.deepEqual(made.chat.settled, [`task-${chatTask.id}`]);
  assert.equal(made.chat.kept.size, 0);
});

test("this task's own machine from a try cut short is reused, and settled once the move is done", async () => {
  const made = env();
  const task = await headless(made);
  made.chat.machines.push({ taskId: task.id, sandboxId: task.sandboxId!, hostId: "host_left", key: `task-${task.id}-m9`, keepSandbox: true });
  made.chat.kept.set(`task-${task.id}-m9`, task.sandboxId!);
  const { task: moved } = await move(made, task.id);
  assert.equal(moved.hostId, "host_left");
  assert.equal(made.chat.machines.length, 1);
  assert.deepEqual(made.chat.settled, [`task-${task.id}-m9`]);
});

test("refused before anything happens: the turn's running, starting, closed, a chat already, never dispatched", async () => {
  const made = env();
  const { task: running } = await made.service.launchTask(
    { title: "Running", role: "implement", brief: "b", repo: "acme/web", orchestratorThreadId: null, runner: "boat" },
    5_000,
  );
  await refused(move(made, running.id), "task_running", /Interrupt/);
  const idle = await headless(made);
  made.store.update(idle.id, { status: "starting" });
  await refused(move(made, idle.id), "task_starting");
  made.store.update(idle.id, { status: "idle", conversationId: null });
  await refused(move(made, idle.id), "task_not_dispatched");
  const closed = await headless(made);
  await made.service.closeTask(closed.id, { keepSandbox: true });
  await refused(move(made, closed.id), "task_closed");
  const { task: chatTask } = await made.service.launchTask({ title: "Chat", role: "implement", brief: "b", repo: "acme/web", orchestratorThreadId: null }, 5_000);
  await refused(move(made, chatTask.id), "already_chat");
  assert.equal(made.chat.files.length, 0);
  assert.equal(made.chat.machines.length, 1, "only the chat task's own");
});

test("refused: no chat runner, bb Connect off, an untrusted repo from the CLI", async () => {
  const none = env({ chat: false });
  await refused(move(none, (await headless(none)).id), "chat_unavailable");

  let connect: ConnectStatus = { state: "off", fix: null };
  const off = env({ connect: () => connect });
  const task = await headless(off);
  await refused(move(off, task.id), "connect_required", /bb account login[\s\S]*bb connect on/);
  nothingMade(off);
  connect = READY;

  const made = env();
  const outside = await headless(made, { repo: "acme/other" });
  const error = await refused(move(made, outside.id, { via: "cli" }), "untrusted_repo", /acme\/other isn't in one of your projects with Run tasks as chats on, so it can't continue as a task chat/);
  assert.match(error.hint ?? "", /Continue as a chat on the task's page/);
  assert.doesNotMatch(error.hint ?? "", /only the user/);
  await refused(move(made, outside.id, { confirmUntrusted: ["acme/else"] }), "untrusted_repo", /changed after the warning/);
  nothingMade(made);
  // The user's tick on the page.
  const { task: moved } = await move(made, outside.id, { confirmUntrusted: ["acme/other"] });
  assert.equal(moved.runner, "chat");
  assert.match(made.store.latestEvent(outside.id, "trust-confirmed")!.text, /Your projects don't run tasks on acme\/other as chats; moved to a task chat after the warning/);
});

test("refused: the sandbox is gone or broken, lent, shared, or runs someone else's bb", async () => {
  const made = env();
  const gone = await headless(made);
  made.boat.sandboxes.delete(gone.sandboxId!);
  await refused(move(made, gone.id), "sandbox_gone", /--context-from/);
  assert.equal(made.store.events(gone.id, 50).at(-1)!.kind, "chat-move-failed");

  const broken = await headless(made);
  made.boat.sandboxes.get(broken.sandboxId!)!.state = "error";
  await refused(move(made, broken.id), "sandbox_unavailable");

  // A sandbox the user made and lent to the task.
  const own = await made.boat.create({ name: "mine", type: "default" });
  const lent = await headless(made, { sandbox: own.id });
  await refused(move(made, lent.id), "sandbox_lent", /--chat --context-from/);

  const first = await headless(made);
  await headless(made, { sandbox: first.sandboxId, title: "Second" });
  await refused(move(made, first.id), "sandbox_shared", /Close it first/);

  const orchestrated = await headless(made);
  made.chat.machines.push({ taskId: "", sandboxId: orchestrated.sandboxId!, hostId: "host_orch", key: "orchestrator-1" });
  await refused(move(made, orchestrated.id), "sandbox_runs_bb");
  assert.equal(made.chat.files.length, 0);
  assert.equal(made.chat.spawns.length, 0);
});

test("refused: the headless conversation still runs in boat, an expired GitHub login, no room to resume", async () => {
  const made = env();
  const busy = await headless(made);
  made.boat.convos.get(busy.conversationId!)!.running = true;
  await refused(move(made, busy.id), "task_running", /still running in boat/);
  made.boat.convos.get(busy.conversationId!)!.running = false;

  made.boat.ghExpires = new Date(Date.now() + 60_000).toISOString();
  const expiring = await headless(made);
  made.boat.login = { valid: false, expiresAt: new Date(Date.now() - 60_000).toISOString() };
  await refused(move(made, expiring.id), "github_token_expired");
  made.boat.login = { valid: true, expiresAt: "2099-01-01T00:00:00.000Z" };

  const full = env();
  const stopped = await headless(full);
  full.boat.sandboxes.get(stopped.sandboxId!)!.state = "stopped";
  // The only slot is taken by a running task.
  full.boat.limitsValue.maxActiveSandboxes = 1;
  await full.service.launchTask({ title: "Busy", role: "implement", brief: "b", repo: "acme/web", orchestratorThreadId: null, runner: "boat" }, 5_000).catch(() => undefined);
  full.boat.sandboxes.set("bx_other", { ...full.boat.sandboxes.get(stopped.sandboxId!)!, id: "bx_other", state: "running" });
  await refused(move(full, stopped.id), "boat_at_capacity");
  nothingMade(full);
});

test("failures roll back: the task stays a working headless task, and the sandbox is never deleted", async () => {
  // boat's log can't be read.
  let made = env();
  let task = await headless(made);
  made.boat.events = async () => {
    throw new Error("boat events failed");
  };
  await assert.rejects(move(made, task.id), /boat events failed/);
  made.boat.events = (await import("./fakes.ts")).FakeBoat.prototype.events.bind(made.boat);
  nothingMade(made);
  await stillHeadless(made, task);

  // bb's install fails after it made the machine.
  made = env();
  task = await headless(made);
  made.chat.attachError = new Error("bootstrap failed");
  made.chat.attachLeftover = true;
  await assert.rejects(move(made, task.id), /bootstrap failed/);
  assert.equal(made.chat.detached.length, 1);
  assert.match(made.store.latestEvent(task.id, "chat-move-failed")!.text, /bootstrap failed\. The task stays headless\. The bb machine was removed again; the sandbox and its work stay\./);
  made.chat.attachError = null;
  await stillHeadless(made, task);
  // bb was there: no snapshot of it, and no untrusted repo in it.
  await refused(made.service.saveSnapshot(task.sandboxId!, "after"), "invalid_value", /runs bb/);
  await refused(
    made.service.launchTask({ title: "x", role: "implement", brief: "b", repo: "acme/other", orchestratorThreadId: null, sandbox: task.sandboxId }, 5_000),
    "untrusted_sandbox",
  );

  // Writing the file fails.
  made = env();
  task = await headless(made);
  made.chat.writeError = new Error("files.write failed");
  await assert.rejects(move(made, task.id), /files\.write failed/);
  assert.equal(made.chat.detached.length, 1);
  assert.equal(made.chat.spawns.length, 0);
  made.chat.writeError = null;
  await stillHeadless(made, task);

  // The chat doesn't start.
  made = env();
  task = await headless(made);
  made.chat.spawnError = new Error("spawn failed");
  await assert.rejects(move(made, task.id), /spawn failed/);
  assert.equal(made.chat.detached.length, 1);
  assert.equal(made.chat.files.length, 1);
  made.chat.spawnError = null;
  await stillHeadless(made, task);
});

test("closing the task during the move stops it: nothing moves, then the close goes on", async () => {
  const made = env();
  const task = await headless(made);
  let open: () => void = () => undefined;
  made.chat.attachGate = new Promise((resolve) => {
    open = resolve;
  });
  const moving = move(made, task.id).catch((error: unknown) => error);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(made.service.isMovingToChat(task.id), true);
  const closing = made.service.closeTask(task.id, { status: "done" });
  open();
  const error = await moving;
  assert.ok(error instanceof TaskError && error.code === "task_changed", String(error));
  const { task: closed, sandbox } = await closing;
  assert.equal(closed.status, "done");
  assert.equal(closed.runner, "boat");
  assert.equal(made.chat.detached.length, 1);
  assert.equal(made.chat.spawns.length, 0);
  // The close's own sandbox delete, after the move let go of it.
  assert.equal(sandbox, "deleted");
  assert.match(made.store.latestEvent(task.id, "chat-move-failed")!.text, /closed during the move/);
});

test("a move and follow-ups exclude each other; so do reviews, ships, sandbox actions and a second move", async () => {
  const made = env();
  const task = await headless(made);
  let open: () => void = () => undefined;
  made.chat.attachGate = new Promise((resolve) => {
    open = resolve;
  });
  const moving = move(made, task.id);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await refused(made.service.followup(task.id, "More."), "task_busy");
  await refused(made.service.reviewInput(task.id), "task_busy");
  await refused(made.service.shipTask(task.id, { approval: "ok" }), "task_busy");
  await refused(made.service.sandboxAction(task.sandboxId!, "delete", 0), "task_busy");
  await refused(move(made, task.id), "task_busy");
  const status = await made.service.continueAsChatStatus(task.id);
  assert.equal(status.moving, true);
  open();
  await moving;
  assert.equal(made.chat.machines.length, 1, "exactly one attach");
  await made.service.sweep();
  made.chat.finish(made.store.get(task.id)!.threadId!, REPORT);
  await made.service.sweep();
  await made.service.followup(task.id, "Now the test.");
  assert.equal(made.chat.sends.length, 1);

  // A follow-up being sent holds off a move.
  const other = await headless(made);
  let release: () => void = () => undefined;
  const prompt = made.boat.prompt.bind(made.boat);
  made.boat.prompt = async (...args: Parameters<typeof made.boat.prompt>) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return prompt(...args);
  };
  const sending = made.service.followup(other.id, "Go on.");
  await new Promise((resolve) => setTimeout(resolve, 10));
  await refused(move(made, other.id), "task_busy");
  release();
  await sending;
});

test("the page's status: offered, why not, the warning, bb already there, the sandbox stopped, the last failure", async () => {
  const made = env();
  const task = await headless(made);
  let status = await made.service.continueAsChatStatus(task.id);
  assert.deepEqual(
    { offered: status.offered, blocked: status.blocked, untrusted: status.untrusted, hasMachine: status.hasMachine, stopped: status.sandboxStopped, failure: status.lastFailure },
    { offered: true, blocked: null, untrusted: false, hasMachine: false, stopped: false, failure: null },
  );
  made.boat.sandboxes.get(task.sandboxId!)!.state = "stopped";
  assert.equal((await made.service.continueAsChatStatus(task.id)).sandboxStopped, true);
  made.chat.writeError = new Error("disk full");
  await move(made, task.id).catch(() => undefined);
  status = await made.service.continueAsChatStatus(task.id);
  assert.match(status.lastFailure ?? "", /^Couldn't continue as a chat: disk full\./);

  const outside = await headless(made, { repo: "acme/other" });
  status = await made.service.continueAsChatStatus(outside.id);
  assert.deepEqual([status.untrusted, status.untrustedRepos, status.blocked], [true, ["acme/other"], null]);

  const { task: running } = await made.service.launchTask({ title: "R", role: "implement", brief: "b", repo: "acme/web", orchestratorThreadId: null, runner: "boat" }, 5_000);
  assert.equal((await made.service.continueAsChatStatus(running.id)).blocked?.code, "task_running");
  const { task: chatTask } = await made.service.launchTask({ title: "C", role: "implement", brief: "b", repo: "acme/web", orchestratorThreadId: null }, 5_000);
  assert.equal((await made.service.continueAsChatStatus(chatTask.id)).offered, false);
  const off = env({ connect: { state: "off", fix: null } });
  assert.equal((await off.service.continueAsChatStatus((await headless(off)).id)).blocked?.code, "connect_required");
});

test("the page doesn't wait for the install: pending while the move runs", async () => {
  const made = env();
  const task = await headless(made);
  let open: () => void = () => undefined;
  made.chat.attachGate = new Promise((resolve) => {
    open = resolve;
  });
  const { task: now, pending } = await made.service.continueAsChat(task.id, { confirmUntrusted: null, via: "page", waitMs: 5_000, waitFor: "checks" });
  assert.equal(pending, true);
  assert.equal(now.runner, "boat");
  assert.equal(made.service.isMovingToChat(task.id), true);
  open();
  for (let i = 0; i < 50 && made.service.isMovingToChat(task.id); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(made.service.isMovingToChat(task.id), false);
  assert.equal(made.store.get(task.id)!.runner, "chat");
});

test("a failure after the caller stopped waiting reaches it (the CLI tells its chat)", async () => {
  const made = env();
  const task = await headless(made);
  let open: () => void = () => undefined;
  made.chat.attachGate = new Promise((resolve) => {
    open = resolve;
  });
  made.chat.attachError = new Error("bootstrap failed");
  const late: string[] = [];
  const { pending } = await made.service.continueAsChat(task.id, { confirmUntrusted: null, via: "cli", waitMs: 5, onLateFailure: (message) => late.push(message) });
  assert.equal(pending, true);
  open();
  for (let i = 0; i < 50 && late.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(late, ["bootstrap failed"]);
});

test("bb restarted mid-move: the sweep removes this task's machine and says so; a close does too", async () => {
  const made = env();
  const task = await headless(made);
  // What a move cut short by a restart leaves: its start in history, and a machine.
  made.store.addEvent(task.id, "chat-move", "Moving to a task chat (asked on the Cloud agents page)");
  made.chat.machines.push({ taskId: task.id, sandboxId: task.sandboxId!, hostId: "host_left", key: `task-${task.id}-m3`, keepSandbox: true });
  await made.service.sweep();
  assert.deepEqual(made.chat.detached, [{ hostId: "host_left", key: `task-${task.id}-m3` }]);
  assert.match(made.store.latestEvent(task.id, "chat-move-failed")!.text, /bb restarted during the move/);
  await made.service.sweep();
  assert.equal(made.store.events(task.id, 200).filter((event) => event.kind === "chat-move-failed").length, 1, "once");

  const other = await headless(made);
  made.store.addEvent(other.id, "chat-move", "Moving to a task chat (from the CLI)");
  made.chat.machines.push({ taskId: other.id, sandboxId: other.sandboxId!, hostId: "host_left2", key: `task-${other.id}-m4`, keepSandbox: true });
  await made.service.closeTask(other.id, { status: "done" });
  assert.ok(made.chat.detached.some((entry) => entry.hostId === "host_left2"));
});

test("a moved task's later handovers still point at its old conversation, and a leaked keep flag is cleared on close", async () => {
  const made = env();
  const task = await headless(made);
  const { task: moved } = await move(made, task.id);
  await made.service.sweep();
  made.chat.finish(moved.threadId!, REPORT);
  await made.service.sweep();
  await made.service.followup(task.id, "Codex, take it from here.", { provider: "codex" });
  const handover = made.chat.spawns.at(-1)!;
  assert.equal(handover.provider, "codex");
  assert.match(handover.prompt, new RegExp(`/home/user/\\.boat-tasks/${task.id}/conversation\\.md`));
  // A restart between the switch and the settle left the flag: the close clears it before removing the machine.
  made.chat.kept.set(made.chat.machines[0]!.key, task.sandboxId!);
  await made.service.closeTask(task.id, { status: "done" });
  assert.equal(made.chat.kept.size, 0);
  assert.ok(made.chat.removed.includes(moved.hostId!));
});

test("a kept sandbox loses the moved task's old conversation when the task closes", async () => {
  const made = env();
  const task = await headless(made);
  await move(made, task.id);
  await made.service.closeTask(task.id, { status: "done", keepSandbox: true });
  assert.ok(made.boat.execs.some((entry) => entry.script === `rm -rf '/home/user/.boat-tasks/${task.id}'`), JSON.stringify(made.boat.execs));
});

test("two moves at once: exactly one runs; something else holding the sandbox (a ship, a wake) holds the move off", async () => {
  const made = env();
  const task = await headless(made);
  const results = await Promise.allSettled([move(made, task.id), move(made, task.id)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.equal((failed.reason as TaskError).code, "task_busy");
  assert.equal(made.chat.machines.length, 1);
  assert.equal(made.chat.spawns.length, 1);

  const other = await headless(made);
  // What shipTask, a preview wake or a follow-up do while they work.
  const release = (made.service as unknown as { claim(sandboxId: string): () => void }).claim(other.sandboxId!);
  await refused(move(made, other.id), "task_busy", /Something is using the task's sandbox/);
  assert.equal((await made.service.continueAsChatStatus(other.id)).blocked?.code, "task_busy");
  release();
  assert.equal((await move(made, other.id)).task.runner, "chat");
});
