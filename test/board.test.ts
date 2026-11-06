// The orchestrator overview: decisions, ready marks and the grouping.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBoard, phaseOf, reviewState } from "../src/board.ts";
import { TaskError } from "../src/service.ts";
import type { Task } from "../src/store.ts";
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

async function dispatch(env: ReturnType<typeof makeService>, overrides: Record<string, unknown> = {}) {
  const { task } = await env.service.launchTask(
    { title: "Header", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch", ...overrides },
    5_000,
  );
  return task;
}

test("review events read as a review state", () => {
  assert.equal(reviewState("Review t_1 started (codex · Review · gpt-6.1-sol · high)"), "reviewing");
  assert.equal(reviewState("Review t_1: approve"), "approve");
  assert.equal(reviewState("Review t_1: changes-requested"), "changes-requested");
  assert.equal(reviewState(null), null);
});

test("the board groups tasks the way the user thinks about them", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 10;
  const approved = await dispatch(env, { title: "Approved" });
  const marked = await dispatch(env, { title: "Marked ready", role: "custom" });
  const waiting = await dispatch(env, { title: "Waiting" });
  const working = await dispatch(env, { title: "Working" });
  const failing = await dispatch(env, { title: "Failing" });
  const closed = await dispatch(env, { title: "Closed" });
  for (const task of [approved, marked, waiting, failing, closed]) env.boat.finish(task.conversationId!, REPORT);
  env.boat.finish(failing.conversationId!, "", "failed", "boom");
  await env.service.sweep();
  env.store.addEvent(approved.id, "review", "Review t_r: approve");
  env.service.markReady(marked.id, "Check the new spacing");
  await env.service.closeTask(closed.id);
  const decision = env.store.addDecision({ orchestratorThreadId: "thr_orch", question: "Variant A or B?", recommendation: "B, calmer", options: ["A", "B"], taskIds: [] });

  const tasks = env.store.list({ limit: 100 });
  const latest = (task: Task) => reviewState(env.store.latestEvent(task.id, "review")?.text);
  const board = buildBoard({ tasks, decisions: env.store.decisions(), latestVerdict: latest });
  assert.deepEqual(board.needsYou.map((entry) => entry.id), [decision.id]);
  assert.deepEqual(board.ready.map((task) => task.title).sort(), ["Approved", "Marked ready"]);
  // Failed first, then working, then waiting on the orchestrator.
  assert.deepEqual(board.running.map((task) => task.title), ["Failing", "Working", "Waiting"]);
  assert.deepEqual(board.done.map((task) => task.title), ["Closed"]);
  assert.equal(phaseOf(env.store.get(working.id)!, false), "working");
  assert.equal(phaseOf(env.store.get(waiting.id)!, false), "waiting");
});

test("a review still running keeps the work out of Ready, and a new turn clears a ready mark", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 10;
  const task = await dispatch(env);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  env.store.addEvent(task.id, "review", "Review t_old: approve");
  const { task: review } = await env.service.launchTask(await env.service.reviewInput(task.id), 5_000);
  const latest = (entry: Task) => reviewState(env.store.latestEvent(entry.id, "review")?.text);
  const tasks = () => env.store.list({ limit: 100 });
  assert.equal(buildBoard({ tasks: tasks(), decisions: [], latestVerdict: latest }).ready.length, 0);
  void review;

  env.service.markReady(task.id, "Look at the header");
  assert.equal(env.store.get(task.id)!.readyNote, "Look at the header");
  await env.service.followup(task.id, "One more fix.");
  const after = env.store.get(task.id)!;
  assert.equal(after.readyAt, null);
  assert.equal(after.readyNote, null);
  // Only a finished turn can be ready.
  assert.throws(() => env.service.markReady(task.id, "x"), (error: unknown) => error instanceof TaskError && error.code === "task_not_idle");
});

test("decisions open, answer and move with a take-over", () => {
  const env = makeService();
  const decision = env.store.addDecision({ orchestratorThreadId: "thr_a", question: "Ship?", recommendation: "Yes", options: [], taskIds: ["t_1"] });
  assert.equal(decision.status, "open");
  env.store.reassignOpenDecisions("thr_a", "thr_b");
  assert.equal(env.store.decisions({ orchestratorThreadId: "thr_b", statuses: ["open"] }).length, 1);
  assert.equal(env.store.resolveDecision(decision.id, "answered", "Yes")?.status, "answered");
  // Closing twice does nothing.
  assert.equal(env.store.resolveDecision(decision.id, "withdrawn", null), null);
});

test("another chat can join a worker's workspace from bb's composer, or by being opened there", async () => {
  const env = makeService({ chat: true });
  const task = await dispatch(env);
  await env.service.sweep();
  const request = {
    providerId: "codex",
    model: "gpt-6-astra",
    reasoningLevel: "ultra",
    permissionMode: "full",
    input: [{ type: "text", text: "Try a second approach.", mentions: [] }],
  };
  const threadId = await env.service.openWorkspaceChat(task.id, request);
  const composed = env.chat.composed.at(-1)!;
  assert.equal(composed.threadId, threadId);
  assert.deepEqual(composed.request, request);
  assert.equal(composed.parentThreadId, "thr_orch");
  assert.equal(composed.environmentId, env.store.get(task.id)!.environmentId);
  // Part of the task: archived with it, and its agent and model are known.
  assert.ok(env.store.chatThreads(task.id).includes(threadId));
  assert.equal(env.store.byThread(threadId)?.id, task.id);
  assert.deepEqual(env.service.chatInfo(task.id).get(threadId), { provider: "codex", model: "gpt-6-astra", effort: "ultra" });

  // A chat opened in the workspace with bb's own "+" is adopted under the orchestrator.
  const environmentId = env.store.get(task.id)!.environmentId!;
  assert.equal(await env.service.adoptWorkspaceChat({ id: "thr_native", environmentId, providerId: "claude-code", parentThreadId: null }), true);
  assert.deepEqual(env.chat.adopted, [{ threadId: "thr_native", parentThreadId: "thr_orch" }]);
  assert.ok(env.store.chatThreads(task.id).includes("thr_native"));
  // Not twice, and not for other workspaces.
  assert.equal(await env.service.adoptWorkspaceChat({ id: "thr_native", environmentId, providerId: "claude-code", parentThreadId: "thr_orch" }), false);
  assert.equal(await env.service.adoptWorkspaceChat({ id: "thr_x", environmentId: "env_other", providerId: "codex", parentThreadId: null }), false);

  // Chats in the workspace (not the worker's own) get the workspace as instructions.
  const instructions = env.service.workspaceInstructions(environmentId, "thr_native")!;
  assert.match(instructions, new RegExp(`workspace of the boat task ${task.id} "Header"`));
  assert.match(instructions, /The checkout is at \/home\/user\/work\/[\w/]*web, on the branch boat\//);
  assert.equal(env.service.workspaceInstructions(environmentId, task.threadId!), null);

  // Closed tasks don't take new chats.
  await env.service.closeTask(task.id);
  await assert.rejects(env.service.openWorkspaceChat(task.id, request), (error: unknown) => error instanceof TaskError && error.code === "task_closed");
});

test("a finished turn of a task from a plain chat (not an orchestrator) is ready for the user", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 10;
  const fromOrchestrator = await dispatch(env, { title: "Orchestrated" });
  const fromChat = await dispatch(env, { title: "From a chat", orchestratorThreadId: "thr_chat" });
  for (const task of [fromOrchestrator, fromChat]) env.boat.finish(task.conversationId!, REPORT.replace("PR: https://github.com/acme/web/pull/12\n", ""));
  await env.service.sweep();
  env.store.addOrchestrator("thr_orch");
  const { current } = env.store.orchestratorThreadIds();
  const board = buildBoard({
    tasks: env.store.list({ limit: 100 }),
    decisions: [],
    latestVerdict: () => null,
    isOrchestrator: (threadId) => current.has(threadId),
  });
  assert.deepEqual(board.ready.map((task) => task.title), ["From a chat"]);
  assert.deepEqual(board.running.map((task) => task.title), ["Orchestrated"]);
});

test("an orchestrator that stops being one is remembered as a former one", () => {
  const env = makeService();
  env.store.addOrchestrator("thr_a", { id: "web", name: "Web app" });
  env.store.addOrchestrator("thr_b");
  env.store.removeOrchestrator("thr_a");
  assert.deepEqual(env.store.orchestrators().map((row) => row.threadId), ["thr_b"]);
  const sets = env.store.orchestratorThreadIds();
  assert.deepEqual([...sets.current], ["thr_b"]);
  assert.deepEqual([...sets.former], ["thr_a"]);
  // Turned on again: current again.
  env.store.addOrchestrator("thr_a");
  assert.ok(env.store.orchestratorThreadIds().current.has("thr_a"));
  assert.equal(env.store.orchestrators().find((row) => row.threadId === "thr_a")?.projectName, "Web app");
  // The newest repo check, for the setup checks.
  assert.equal(env.store.latestRepoAccess(), null);
  env.store.setRepoAccess("acme/web", "write", null);
  assert.equal(env.store.latestRepoAccess()?.access, "write");
});
