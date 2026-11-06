// Moving a task's sandbox to another size: refusals before anything
// changes, the stop and `boat resume --type`, task chats' machines, the
// follow-up with the new size, and every way it can fail.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BoatError } from "../src/boat.ts";
import { encodeData } from "../src/memory.ts";
import type { ResizeRequest } from "../src/sandbox-size.ts";
import { TaskError } from "../src/service.ts";
import { makeService } from "./fakes.ts";

const REPORT = `Done.

=== REPORT ===
STATUS: done
PR: https://github.com/acme/web/pull/12
BRANCH: boat/x
SUMMARY: done
TESTS: ok
OPEN QUESTIONS: none
=== END REPORT ===`;

const TRIAL = [
  { type: "small", available: true, reason: null },
  { type: "default", available: true, reason: null },
  { type: "large", available: false, reason: "not during the free trial; the first payment unlocks it" },
  { type: "xlarge", available: false, reason: "needs the $100/month plan or higher" },
];

type Env = ReturnType<typeof makeService>;

async function start(env: Env, overrides: Record<string, unknown> = {}) {
  const { task } = await env.service.launchTask(
    { title: "Add dark mode", role: "implement", brief: "Add a dark mode toggle.", repo: "acme/web", orchestratorThreadId: "thr_orch", projectId: "proj_personal", ...overrides },
    5_000,
  );
  return task;
}

/** A task whose first turn finished (idle, between turns). */
async function idleTask(env: Env, overrides: Record<string, unknown> = {}) {
  const task = await start(env, overrides);
  if (task.runner === "chat") {
    env.chat.finish(task.threadId!, REPORT);
    await env.service.syncChatThread(task.threadId!, { kind: "idle", text: REPORT, at: Date.now() });
  } else {
    env.boat.finish(task.conversationId!, REPORT);
    await env.service.sweep();
  }
  await env.service.sizes.settled();
  const now = env.store.get(task.id)!;
  assert.equal(now.status, "idle");
  return now;
}

function request(taskId: string, overrides: Partial<ResizeRequest> = {}): ResizeRequest {
  return { taskId, type: "large", message: "Continue where you left off.", userApproved: true, notifyThreadId: null, waitMs: 5_000, by: "page", ...overrides };
}

async function refused(promise: Promise<unknown>, code: string, message?: RegExp): Promise<TaskError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof TaskError, String(error));
    assert.equal(error.code, code, error.message);
    if (message) assert.match(error.message, message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

const history = (env: Env, taskId: string) => env.store.events(taskId, 1000).filter((event) => event.kind === "sandbox-size").map((event) => event.text);
const stopsAndResumes = (env: Env) => env.boat.calls.filter((call) => call.startsWith("stop") || call.startsWith("resume"));
// Private state the tests look at directly.
const claims = (env: Env) => (env.service as unknown as { claims: Map<string, number> }).claims;

test("refusals come before anything changes", async () => {
  const env = makeService({ settings: { reviewSandbox: "same" } });
  const task = await idleTask(env);
  const sandboxId = task.sandboxId!;

  // A running turn: its own, or another task's on the same sandbox.
  await env.service.followup(task.id, "More.");
  await refused(env.service.sizes.resize(request(task.id)), "sandbox_busy", /is still running/);
  env.boat.finish(env.store.get(task.id)!.conversationId!, REPORT);
  await env.service.sweep();
  await env.service.sizes.settled();
  const review = (await env.service.launchTask(await env.service.reviewInput(task.id), 5_000)).task;
  await refused(env.service.sizes.resize(request(task.id)), "sandbox_busy", new RegExp(`Task ${review.id} \\(“Review: Add dark mode”\\) is still running on this sandbox`));
  env.boat.finish(review.conversationId!, "=== REVIEW ===\nVERDICT: approve\n=== END REVIEW ===");
  await env.service.sweep();
  await env.service.sizes.settled();

  // A wake or ship holding the sandbox.
  const release = (env.service as unknown as { claim(id: string): () => void }).claim(sandboxId);
  await refused(env.service.sizes.resize(request(task.id)), "sandbox_busy", /in use right now/);
  release();

  await refused(env.service.sizes.resize(request(task.id, { type: "default" })), "same_size", /already Default/);
  await refused(env.service.sizes.resize(request(task.id, { type: "xlarge", userApproved: false })), "size_needs_approval");
  env.setPlan(TRIAL);
  await refused(env.service.sizes.resize(request(task.id)), "size_not_on_plan", /doesn't include Large sandboxes: not during the free trial; the first payment unlocks it\./);
  env.setPlan(null);
  // No starts left: a stopped sandbox couldn't come back.
  env.boat.limitsValue = { ...env.boat.limitsValue, startsLeftToday: 0 };
  await refused(env.service.sizes.resize(request(task.id)), "boat_start_limit");
  // One left, for a shrink boat may refuse: not worth a stopped sandbox.
  env.boat.limitsValue = { ...env.boat.limitsValue, startsLeftToday: 1 };
  await refused(env.service.sizes.resize(request(task.id, { type: "small" })), "boat_start_limit", /last boat start/);
  env.boat.limitsValue = { ...env.boat.limitsValue, startsLeftToday: 75 };

  env.store.update(task.id, { status: "starting" });
  await refused(env.service.sizes.resize(request(task.id)), "task_starting");
  env.store.update(task.id, { status: "idle", conversationId: null });
  await refused(env.service.sizes.resize(request(task.id)), "task_not_dispatched");
  env.store.update(task.id, { conversationId: task.conversationId });
  env.boat.sandboxes.delete(sandboxId);
  await refused(env.service.sizes.resize(request(task.id)), "sandbox_gone");
  env.store.update(task.id, { status: "done" });
  await refused(env.service.sizes.resize(request(task.id)), "task_closed");

  // A sandbox the user lent isn't the plugin's to stop.
  const lent = makeService();
  lent.boat.addSandbox("bx_mine", "default");
  const borrowed = await idleTask(lent, { sandbox: "bx_mine" });
  await refused(lent.service.sizes.resize(request(borrowed.id)), "invalid_value", /isn't one the plugin created/);

  assert.deepEqual(stopsAndResumes(env), []);
  assert.deepEqual(stopsAndResumes(lent), []);
  assert.equal(claims(env).size, 0);
});

test("a busy chat on the machine, and two moves at once", async () => {
  const env = makeService({ chat: true, linkedMachines: true });
  const task = await idleTask(env);
  env.chat.busyMachines.add(task.hostId!);
  await refused(env.service.sizes.resize(request(task.id)), "sandbox_busy", /A chat on this sandbox is still working/);
  env.chat.busyMachines.clear();

  // The second is refused: the first registered before anything awaited.
  const first = env.service.sizes.resize(request(task.id, { message: null }));
  await refused(env.service.sizes.resize(request(task.id, { message: null })), "sandbox_resizing", /already moving to Large/);
  await first;
});

test("the dialog's facts: who else is on the sandbox, its previews, the next size, what blocks it", async () => {
  const env = makeService({ settings: { reviewSandbox: "same" } });
  const task = await idleTask(env);
  const review = (await env.service.launchTask(await env.service.reviewInput(task.id), 5_000)).task;
  env.store.upsertPreview({ taskId: task.id, sandboxId: task.sandboxId!, port: 5173, path: "/", command: "npm run dev", url: "https://x.on.boat.dev", title: "x", health: "up" });
  let info = await env.service.sizes.info(task.id);
  assert.deepEqual(info.others, [{ id: review.id, title: "Review: Add dark mode", status: "running" }]);
  assert.equal(info.previews, 1);
  assert.equal(info.suggested, "large");
  assert.equal(info.blocker?.code, "sandbox_busy");
  assert.deepEqual(info.current, { type: "default", label: "Default", summary: "4 vCPU, 8 GB" });
  env.boat.finish(review.conversationId!, "=== REVIEW ===\nVERDICT: approve\n=== END REVIEW ===");
  await env.service.sweep();
  await env.service.sizes.settled();
  info = await env.service.sizes.info(task.id);
  assert.equal(info.blocker, null);
  assert.equal(info.startsLeft, 25);
  env.setPlan(TRIAL);
  assert.equal((await env.service.sizes.info(task.id)).suggested, null);
});

test("a headless task's sandbox moves: stop, resume --type, every task told, then the follow-up with the new size", async () => {
  const env = makeService({ settings: { reviewSandbox: "same" } });
  const task = await idleTask(env);
  const review = (await env.service.launchTask(await env.service.reviewInput(task.id), 5_000)).task;
  env.boat.finish(review.conversationId!, "=== REVIEW ===\nVERDICT: approve\n=== END REVIEW ===");
  await env.service.sweep();
  await env.service.sizes.settled();
  env.store.upsertPreview({ taskId: task.id, sandboxId: task.sandboxId!, port: 5173, path: "/", command: "npm run dev", url: "https://x.on.boat.dev", title: "x", health: "up" });
  const sandboxId = task.sandboxId!;

  const result = await env.service.sizes.resize(request(task.id));
  assert.equal(result.pending, false);
  assert.equal(result.sent, true);
  assert.deepEqual(result.moved.sort(), [task.id, review.id].sort());
  assert.deepEqual(stopsAndResumes(env), [`stop ${sandboxId}`, `resume ${sandboxId} ttl=7200 type=large`]);
  assert.deepEqual(history(env, task.id).slice(-2), ["Moving the sandbox from Default to Large", "The sandbox is now Large (8 vCPU, 16 GB); it was Default. Its preview stopped; Wake starts it again."]);
  assert.deepEqual(history(env, review.id).slice(-2), [`Moving the sandbox from Default to Large for task ${task.id}`, "The sandbox is now Large (8 vCPU, 16 GB); it was Default. Its preview stopped; Wake starts it again."]);
  assert.equal(env.service.sizes.knownSize(env.store.get(task.id)!)?.type, "large");
  assert.equal(env.store.previews({ taskId: task.id })[0]!.health, "unknown");
  const prompt = env.boat.prompts.at(-1)!.text;
  assert.match(prompt, /## Sandbox\nThe sandbox moved to a larger machine: it's now Large, 8 CPUs and 16 GB of memory\./);
  const moved = env.store.get(task.id)!;
  assert.equal(moved.status, "running");
  assert.equal(moved.turns, task.turns + 1);
  assert.equal(claims(env).size, 0);
  // The user moved it from the page: the orchestrator hears about it.
  assert.ok(env.told.some((entry) => entry.threadId === "thr_orch" && /\[boat\] Sandbox .* is now Large \(8 vCPU, 16 GB\); it was Default\. The user moved it/.test(entry.text)));

  // The review moved along: its next follow-up says so once.
  await env.service.followup(review.id, "Look again.");
  assert.match(env.boat.prompts.at(-1)!.text, /## Sandbox\nThe sandbox moved to a larger machine/);
  env.boat.finish(env.store.get(review.id)!.conversationId!, "=== REVIEW ===\nVERDICT: approve\n=== END REVIEW ===");
  await env.service.sweep();
  await env.service.sizes.settled();
  await env.service.followup(review.id, "And once more.");
  assert.doesNotMatch(env.boat.prompts.at(-1)!.text, /## Sandbox/);
});

test("only the size: no follow-up, and the idle timer starts again", async () => {
  const env = makeService({ settings: { stopIdleAfterMinutes: 30 } });
  const task = await idleTask(env);
  // Long idle before the move.
  const db = (env.store as unknown as { db: () => { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db();
  db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 3_600_000).toISOString(), task.id);
  const prompts = env.boat.prompts.length;
  const result = await env.service.sizes.resize(request(task.id, { message: null }));
  assert.equal(result.sent, false);
  assert.equal(env.boat.prompts.length, prompts);
  assert.equal(env.store.get(task.id)!.status, "idle");
  await env.service.sweep();
  assert.equal(env.boat.sandboxes.get(task.sandboxId!)!.state, "idle", "not stopped as idle right after the move");
});

test("a task chat's machine: suspended and resumed through bb, then the chat gets the follow-up once bb reconnects", async () => {
  const env = makeService({ chat: true, linkedMachines: true });
  const task = await idleTask(env);
  env.chat.reconnectAfterPolls = 3;
  const result = await env.service.sizes.resize(request(task.id));
  assert.equal(result.sent, true);
  assert.deepEqual(env.chat.suspended, [task.hostId]);
  assert.deepEqual(env.chat.resumed, [task.hostId]);
  assert.ok(env.boat.calls.includes(`resume ${task.sandboxId} ttl=7200 type=large`));
  const sent = env.chat.sends.at(-1)!;
  assert.equal(sent.threadId, task.threadId);
  assert.match(sent.text, /^# Follow-up from the orchestrator\n\nContinue where you left off\.\n\n## Sandbox\nThe sandbox moved to a larger machine: it's now Large/);
  assert.equal(env.store.get(task.id)!.status, "running");
});

test("boat refuses the new size: back on the old one, no follow-up, a clear note", async () => {
  const env = makeService();
  const task = await idleTask(env);
  env.boat.resumeError = (type) => (type ? new BoatError("Shrinking is refused if the data does not fit", { code: "invalid_request" }) : null);
  const error = await refused(env.service.sizes.resize(request(task.id, { type: "small" })), "resize_failed");
  assert.match(error.message, /^Couldn't move the sandbox to Small: Shrinking is refused if the data does not fit\. It's back on Default\. The follow-up wasn't sent\.$/);
  assert.deepEqual(stopsAndResumes(env), [`stop ${task.sandboxId}`, `resume ${task.sandboxId} ttl=7200 type=small`, `resume ${task.sandboxId} ttl=7200`]);
  assert.equal(history(env, task.id).at(-1), "Couldn't move the sandbox to Small: Shrinking is refused if the data does not fit. It's back on Default.");
  const now = env.store.get(task.id)!;
  assert.equal(now.status, "idle");
  assert.equal(now.turns, task.turns);
  const view = (await env.service.sizes.view(now))!;
  assert.equal(view.resize?.state, "failed");
  assert.match(view.resize!.error!, /It's back on Default/);
  assert.equal(env.boat.sandboxes.get(task.sandboxId!)!.machineType, "default");
});

test("when the old size won't start either, it stays stopped and the next follow-up starts it", async () => {
  const env = makeService();
  const task = await idleTask(env);
  env.boat.resumeError = () => new BoatError("no machines available", { code: "no_capacity" });
  const error = await refused(env.service.sizes.resize(request(task.id)), "resize_failed");
  assert.match(error.message, /It's stopped; the next follow-up starts it again\./);
  env.boat.resumeError = () => null;
  await env.service.followup(task.id, "Try again.");
  assert.equal(env.boat.calls.filter((call) => call.startsWith("resume")).at(-1), `resume ${task.sandboxId} ttl=7200`);
  assert.equal(env.store.get(task.id)!.status, "running");
});

test("bb doesn't reconnect: the new size is recorded, the message isn't sent", async () => {
  const env = makeService({ chat: true, linkedMachines: true, sizeTiming: { reconnectMs: 20 } });
  const task = await idleTask(env);
  env.chat.neverReconnect = true;
  const sends = env.chat.sends.length;
  const error = await refused(env.service.sizes.resize(request(task.id)), "resize_failed");
  assert.match(error.message, /^The sandbox is Large now, but bb didn't reconnect to it within 5 minutes\. Your message wasn't sent: open the task chat, or send it again\.$/);
  assert.equal(env.chat.sends.length, sends);
  assert.equal(env.service.sizes.knownSize(task)?.type, "large");
});

test("a move that fails after the caller stopped waiting is told to the task's chat", async () => {
  const env = makeService();
  const task = await idleTask(env);
  env.boat.resumeError = (type) => (type ? new BoatError("large isn't available right now", { code: "no_capacity" }) : null);
  let open: () => void = () => undefined;
  env.boat.resumeGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const result = await env.service.sizes.resize(request(task.id, { waitMs: 0, by: "tool", userApproved: true, notifyThreadId: "thr_orch" }));
  assert.equal(result.pending, true);
  open();
  env.boat.resumeGate = null;
  await env.service.sizes.settled();
  const told = env.told.find((entry) => entry.threadId === "thr_orch" && entry.text.startsWith(`[boat] Task ${task.id}: Couldn't move the sandbox to Large`));
  assert.ok(told, JSON.stringify(env.told));
  assert.match(told.text, /The follow-up wasn't sent\. Send it again, with or without sandbox_size\.$/);
});

test("nothing else touches a sandbox while it moves; the move's own follow-up goes through", async () => {
  const env = makeService();
  const task = await idleTask(env);
  env.store.update(task.id, { delivery: "push" });
  let open: () => void = () => undefined;
  // The move waits at its size check, after the resume.
  env.boat.probeGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const moving = env.service.sizes.resize(request(task.id, { waitMs: 0 }));
  assert.equal((await moving).pending, true);
  await refused(env.service.followup(task.id, "Hello"), "sandbox_resizing", /moving to Large right now/);
  await refused(env.service.followup(task.id, "Upload them", { evidenceOnly: true }), "sandbox_resizing");
  await refused(env.service.closeTask(task.id), "sandbox_resizing");
  await refused(env.service.shipTask(task.id, { approval: "by the user" }), "sandbox_resizing");
  await refused(env.service.sandboxAction(task.sandboxId!, "stop", 0), "sandbox_resizing");
  await refused(env.service.launchTask({ title: "Other", role: "custom", brief: "x", sandbox: task.sandboxId }, 5_000), "sandbox_resizing");
  const view = (await env.service.sizes.view(env.store.get(task.id)!))!;
  assert.equal(view.resize?.state, "running");
  assert.equal(view.resize?.withMessage, true);
  assert.equal(view.canResize, false);
  open();
  env.boat.probeGate = null;
  await env.service.sizes.settled();
  assert.equal(env.store.get(task.id)!.status, "running");
  assert.match(env.boat.prompts.at(-1)!.text, /Continue where you left off\./);
});

test("a move the plugin lost on a reload reads as not finished right away", async () => {
  const env = makeService();
  const task = await idleTask(env);
  env.store.addEvent(task.id, "memory-data", encodeData({ type: "resize", sandboxId: task.sandboxId!, from: "default", to: "large", state: "started", error: null, byTask: task.id, at: Date.now() / 1000 }));
  const view = (await env.service.sizes.view(env.store.get(task.id)!))!;
  assert.equal(view.resize?.state, "failed");
  assert.match(view.resize!.error!, /^The move to Large didn't finish \(the plugin restarted\)\./);
  // And it blocks nothing.
  await env.service.followup(task.id, "Go on.");
});

test("orchestrators move up only, Large after a memory finding, XLarge and other chats' sandboxes with the user's OK", async () => {
  const env = makeService();
  const task = await idleTask(env);
  const tool = (overrides: Partial<ResizeRequest> = {}) => request(task.id, { by: "tool", userApproved: false, notifyThreadId: "thr_orch", ...overrides });
  await refused(env.service.sizes.resize(tool()), "size_needs_approval", /latest turn didn't run out of memory/);
  await refused(env.service.sizes.resize(tool({ type: "small" })), "invalid_value", /only move a sandbox to a larger size/);
  await refused(env.service.sizes.resize(tool({ type: "xlarge" })), "size_needs_approval", /XLarge sandbox needs the user's OK/);
  // After an out-of-memory finding in its latest turn: Large without asking.
  env.store.addEvent(
    task.id,
    "memory-data",
    encodeData({ type: "oom", turn: task.turns, sandboxId: task.sandboxId!, machineType: "default", kills: [], count: 1, source: "journal", certain: true, cause: true, counterKey: null, message: "x", next: "large", nextAllowed: true, nextReason: null, at: 1 }),
  );
  // Another chat's task on the sandbox: its work would stop too.
  env.store.update(task.id, {});
  const other = await env.service.launchTask({ title: "Other", role: "custom", brief: "x", sandbox: task.sandboxId, orchestratorThreadId: "thr_other" }, 5_000);
  env.boat.finish(other.task.conversationId!, REPORT);
  await env.service.sweep();
  await env.service.sizes.settled();
  await refused(env.service.sizes.resize(tool()), "size_needs_approval", /from another chat also uses this sandbox/);
  await env.service.closeTask(other.task.id, { keepSandbox: true });
  const result = await env.service.sizes.resize(tool());
  assert.equal(result.to, "large");
  assert.equal(result.sent, true);
});
