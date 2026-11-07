import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBoard, isReady, resolveTaskStatus, reviewState } from "../src/board.ts";
import { notificationText, taskMarker, tasksMarker } from "../src/format.ts";
import { toTaskDto } from "../src/rpc.ts";
import type { Task } from "../src/store.ts";
import { makeService } from "./fakes.ts";

const REPORT = "=== REPORT ===\nSTATUS: done\nPR: https://github.com/acme/web/pull/12\n=== END REPORT ===";
const REVIEW = "=== REVIEW ===\nVERDICT: approve\n=== END REVIEW ===";
const idle = { status: "idle", role: "implement", error: null, readyAt: null } as const;

test("public statuses separate lifecycle, owner decisions, and neutral interruptions", () => {
  assert.equal(resolveTaskStatus({ ...idle, status: "starting" }).status, "working");
  assert.equal(resolveTaskStatus({ ...idle, status: "running" }).moving, true);
  assert.equal(resolveTaskStatus(idle).needsYou, false, "idle does not fabricate an owner decision");
  assert.equal(resolveTaskStatus(idle, { needsYou: true, reason: "Pick a rate limit" }).label, "Needs you");
  assert.equal(resolveTaskStatus(idle, { ready: true }).status, "ready");
  assert.equal(resolveTaskStatus({ ...idle, status: "done", error: "old error" }).status, "shipped");
  assert.equal(resolveTaskStatus({ ...idle, status: "cancelled" }).status, "stopped");
  assert.deepEqual(resolveTaskStatus(idle, { sandboxState: "stopped" }), {
    status: "stopped", label: "Stopped", tone: "neutral", reason: "Resumes on the next message.", needsYou: false, moving: false,
  });
  assert.equal(resolveTaskStatus({ ...idle, error: "The turn was interrupted." }).status, "stopped");
  const reset = resolveTaskStatus({ ...idle, status: "failed", error: "Usage limit reached. Wait for reset." });
  assert.equal(reset.status, "waiting-reset");
  assert.equal(reset.tone, "neutral");
  assert.equal(reset.needsYou, false);
  const broken = resolveTaskStatus({ ...idle, error: "Out of memory" }, { recoveryCostsMore: true });
  assert.equal(broken.status, "broken");
  assert.equal(broken.tone, "danger");
  assert.equal(broken.needsYou, true);
  assert.equal(resolveTaskStatus({ ...idle, status: "running", error: "old usage limit" }).status, "working");
});

test("active reviews win over old ready marks and stay neutral with motion", () => {
  const status = resolveTaskStatus({ ...idle, readyAt: "2026-11-07" }, { reviewOpen: true, ready: true });
  assert.equal(status.status, "review");
  assert.equal(status.moving, true);
  assert.equal(status.needsYou, false);
  assert.equal(resolveTaskStatus({ ...idle, role: "review", status: "running" }).status, "review");
});

async function start(env: ReturnType<typeof makeService>, extra: Record<string, unknown> = {}) {
  return (await env.service.launchTask({ title: "Fix the cart", role: "implement", brief: "Fix it.", repo: "acme/web", orchestratorThreadId: "thr_source", ...extra }, 5_000)).task;
}

test("ordinary task chats nest at their source; running reviews nest under their task", async () => {
  const env = makeService({ chat: true });
  const task = await start(env);
  assert.equal(env.chat.spawns[0]!.parentThreadId, "thr_source");
  assert.match(env.chat.spawns[0]!.prompt, new RegExp(`::boat-task\\{id="${task.id}"\\}`));
  await env.service.sweep();
  env.chat.finish(task.threadId!, REPORT);
  await env.service.sweep();
  const review = (await env.service.launchTask(await env.service.reviewInput(task.id, { sandbox: "same" }), 5_000)).task;
  const spawn = env.chat.spawns.at(-1)!;
  assert.equal(spawn.parentThreadId, task.threadId);
  assert.equal(spawn.title, "Codex reviewing…");
  assert.equal(env.service.publicStatus(env.store.get(task.id)!).status, "review");
  env.service.markReady(task.id, "An old ready mark");
  const latest = (entry: Task) => reviewState(env.store.latestEvent(entry.id, "review")?.text);
  assert.equal(isReady(env.store.get(task.id)!, env.store.list(), latest), false);
  assert.equal(env.service.publicStatus(env.store.get(review.id)!).status, "review");
});

test("review verdict archives and stops only the reviewer, persists a task marker, and retries safely", async () => {
  const env = makeService({ chat: true });
  const task = await start(env);
  await env.service.sweep();
  env.chat.finish(task.threadId!, REPORT);
  await env.service.sweep();
  const review = (await env.service.launchTask(await env.service.reviewInput(task.id, { sandbox: "same" }), 5_000)).task;
  await env.service.sweep();
  const archive = env.chat.archive.bind(env.chat);
  let attempts = 0;
  env.chat.archive = async (id) => {
    if (attempts++ === 0) throw new Error("temporarily offline");
    return archive(id);
  };
  env.chat.finish(review.threadId!, REVIEW);
  await env.service.sweep();
  assert.equal(env.store.latestEvent(task.id, "review-card")!.text, `${taskMarker("review", review.id)}\napprove`);
  await env.service.sweep();
  await env.service.sweep();
  assert.deepEqual(env.chat.archived, [review.threadId]);
  assert.deepEqual(env.chat.stopped, [review.threadId]);
  assert.equal(env.store.get(review.id)!.status, "idle", "archive does not cancel a completed review");
  assert.equal(env.store.get(task.id)!.status, "idle");
  assert.equal(env.store.events(task.id).filter((entry) => entry.kind === "review-card").length, 1);
  assert.equal(env.chat.removed.length, 0, "the implementer's shared machine stays intact");
  assert.equal(env.chat.sends.length, 0, "recording a verdict starts no task turn");
  const board = buildBoard({ tasks: env.store.list(), decisions: [], latestVerdict: (entry) => reviewState(env.store.latestEvent(entry.id, "review")?.text) });
  assert.deepEqual(board.ready.map((entry) => entry.id), [task.id]);
  assert.equal(board.running.length, 0, "completed reviewers leave the active board");
});

test("headless trust stays headless and markers expose true persisted review data", async () => {
  const env = makeService({ chat: true, settings: { workerMode: "boat" } });
  const task = await start(env);
  assert.equal(task.runner, "boat");
  assert.equal(env.chat.machines.length, 0);
  assert.equal(env.chat.spawns.length, 0);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  const review = (await env.service.launchTask(await env.service.reviewInput(task.id), 5_000)).task;
  env.boat.finish(review.conversationId!, REVIEW);
  await env.service.sweep();
  const finished = env.store.get(review.id)!;
  assert.match(notificationText([finished]), new RegExp(`::boat-review\\{id="${review.id}"\\}`));
  assert.equal(env.store.latestEvent(task.id, "review-card")!.text, `${taskMarker("review", review.id)}\napprove`);
  assert.equal(tasksMarker("thr_source"), '::boat-tasks{thread="thr_source"}');
  assert.equal(toTaskDto(env.store.get(task.id)!, { ready: true }).publicStatus!.status, "ready");
});

test("observed idle stops and resets never fabricate needs-you; explicit decisions do", async () => {
  const env = makeService();
  const task = await start(env);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  await env.service.sandboxAction(task.sandboxId!, "stop", 0);
  assert.equal(env.service.publicStatus(env.store.get(task.id)!).status, "stopped");
  assert.equal(env.service.publicStatus(env.store.get(task.id)!).needsYou, false);
  env.store.addDecision({ orchestratorThreadId: "thr_source", question: "Pick one", recommendation: "A", options: ["A", "B"], taskIds: [task.id] });
  assert.equal(env.service.publicStatus(env.store.get(task.id)!).status, "needs-you");
  env.store.update(task.id, { status: "failed", error: "Usage limit reached" });
  assert.equal(env.service.publicStatus(env.store.get(task.id)!).status, "waiting-reset");
});

test("ship guard runs before the push and can reject without losing sandbox work", async () => {
  const env = makeService();
  const task = await start(env);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  env.store.update(task.id, { delivery: "push" });
  await assert.rejects(env.service.shipTask(task.id, {
    approval: "approved old head",
    beforeShip: async (current, targets) => {
      assert.equal(current.id, task.id);
      assert.equal(targets[0]!.path, current.repoPath);
      assert.equal(env.boat.ships.length, 0);
      throw new Error("approval is stale");
    },
  }), /approval is stale/);
  assert.equal(env.boat.ships.length, 0);
  assert.equal(env.store.get(task.id)!.status, "idle");
  assert.equal(env.boat.sandboxes.has(task.sandboxId!), true);
});
