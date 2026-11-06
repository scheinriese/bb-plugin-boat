import assert from "node:assert/strict";
import { test } from "node:test";
import { BoatError } from "../src/boat.ts";
import { TaskError } from "../src/service.ts";
import { makeService } from "./fakes.ts";

const REPORT = `Implemented it.

=== REPORT ===
STATUS: done
PR: https://github.com/acme/web/pull/12
BRANCH: boat/x
SUMMARY: added the toggle
TESTS: pnpm test passed
OPEN QUESTIONS: none
=== END REPORT ===`;

async function implement(env: ReturnType<typeof makeService>, overrides: Record<string, unknown> = {}) {
  const { task } = await env.service.launchTask(
    {
      title: "Add dark mode",
      role: "implement",
      brief: "Add a dark mode toggle to settings.",
      repo: "https://github.com/acme/web",
      orchestratorThreadId: "thr_orch",
      ...overrides,
    },
    5_000,
  );
  return task;
}

test("an implementation task gets a sandbox, a branch, and a running agent", async () => {
  const env = makeService();
  const task = await implement(env);
  assert.equal(task.status, "running");
  assert.equal(task.repo, "acme/web");
  assert.match(task.branch ?? "", /^boat\/[0-9a-f]{8}-add-dark-mode$/);
  assert.equal(task.provider, "claude");
  assert.ok(task.sandboxId?.startsWith("bx_"));
  assert.ok(task.conversationId);
  assert.equal(task.turns, 1);
  assert.deepEqual(
    env.boat.calls.map((call) => call.split(" ")[0]),
    ["create", "prepare", "prompt"],
  );
  // Trial accounts cap the auto-stop at 2 hours.
  assert.match(env.boat.calls[0]!, /ttl=7200$/);
  // The conversation id is chosen before dispatch.
  assert.match(env.boat.calls[2]!, new RegExp(`${task.conversationId}$`));
});

test("task sandboxes stop within the auto-stop cap boat reports, and a plan without one gets the setting", async () => {
  // Hard stop after: 4 h (the fakes' setting).
  const capped = makeService();
  capped.boat.limitsValue = { ...capped.boat.limitsValue, autoStopCapHours: 3 };
  await implement(capped);
  assert.match(capped.boat.calls[0]!, /^create .* ttl=10800$/);

  const paid = makeService();
  paid.boat.limitsValue = { ...paid.boat.limitsValue, tier: "standard", maxActiveSandboxes: 100, autoStopCapHours: null };
  await implement(paid);
  assert.match(paid.boat.calls[0]!, /^create .* ttl=14400$/);

  // A resume uses the same cap.
  const sandboxId = [...paid.boat.sandboxes.keys()][0]!;
  await paid.boat.stop(sandboxId);
  paid.boat.limitsValue = { ...paid.boat.limitsValue, autoStopCapHours: 2 };
  await paid.service.sandboxAction(sandboxId, "resume", 7200);
  assert.ok(paid.boat.calls.includes(`resume ${sandboxId} ttl=7200`));
});

test("when boat limits can't be read, the setting is used and boat's refusal names the cap", async () => {
  const env = makeService();
  env.boat.limitsError = new BoatError("boat.dev didn't answer", { code: "boat_timeout" });
  env.boat.autoStopCapSeconds = 7200;
  const task = await implement(env);
  assert.equal(task.status, "running");
  assert.deepEqual(
    env.boat.calls.filter((call) => call.startsWith("create")),
    ["create default ttl=14400", "create default ttl=7200"],
  );
  // Resuming it again: the same fallback.
  await env.boat.stop(task.sandboxId!);
  await env.service.sandboxAction(task.sandboxId!, "resume", 14_400);
  assert.deepEqual(
    env.boat.calls.filter((call) => call.startsWith("resume")),
    [`resume ${task.sandboxId} ttl=14400`, `resume ${task.sandboxId} ttl=7200`],
  );
});

test("a finished turn is collected, the PR recorded, and the orchestrator notified once", async () => {
  const env = makeService();
  const task = await implement(env);
  await env.service.sweep();
  assert.equal(env.store.get(task.id)?.status, "running");
  assert.equal(env.notifications.length, 0);

  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  const done = env.store.get(task.id)!;
  assert.equal(done.status, "idle");
  assert.equal(done.prUrl, "https://github.com/acme/web/pull/12");
  assert.match(done.result ?? "", /STATUS: done/);
  assert.equal(env.notifications.length, 1);
  assert.equal(env.notifications[0]!.threadId, "thr_orch");
  assert.ok(done.notifiedAt);

  await env.service.sweep();
  assert.equal(env.notifications.length, 1, "no duplicate notification");
});

test("reviews use the other model and a fresh sandbox when a slot is free", async () => {
  const env = makeService();
  const task = await implement(env);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();

  const input = await env.service.reviewInput(task.id);
  assert.equal(input.provider, "codex");
  assert.equal(input.pr, "https://github.com/acme/web/pull/12");
  const { task: review } = await env.service.launchTask(input, 5_000);
  assert.equal(review.role, "review");
  assert.equal(review.parentTaskId, task.id);
  assert.notEqual(review.sandboxId, task.sandboxId);
  assert.equal(review.orchestratorThreadId, "thr_orch");
  assert.ok(env.boat.calls.some((call) => call.startsWith(`prepare ${review.sandboxId} acme/web pull-request`)));
});

test("with no free slot, a review shares the implementer's sandbox without re-checking out", async () => {
  const env = makeService({ settings: { maxActiveSandboxes: 1 } });
  const task = await implement(env);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  const callsBefore = env.boat.calls.length;

  const { task: review } = await env.service.launchTask(await env.service.reviewInput(task.id), 5_000);
  assert.equal(review.sandboxId, task.sandboxId);
  assert.equal(review.ownsSandbox, false);
  const newCalls = env.boat.calls.slice(callsBefore);
  assert.ok(!newCalls.some((call) => call.startsWith("prepare")), "no checkout in a shared sandbox");
  assert.ok(!newCalls.some((call) => call.startsWith("create")));
});

test("a full account stops an idle task sandbox to make room", async () => {
  const env = makeService({ settings: { maxActiveSandboxes: 1 } });
  const first = await implement(env);
  env.boat.finish(first.conversationId!, REPORT);
  await env.service.sweep();

  const second = await implement(env, { title: "Fix login" });
  assert.equal(second.status, "running");
  assert.ok(env.boat.calls.includes(`stop ${first.sandboxId}`));
  assert.notEqual(second.sandboxId, first.sandboxId);
});

test("a full account with busy agents refuses with a helpful error", async () => {
  const env = makeService({ settings: { maxActiveSandboxes: 1 } });
  await implement(env);
  await assert.rejects(
    implement(env, { title: "Second" }),
    (error: unknown) => error instanceof TaskError && error.code === "boat_at_capacity" && /bb boat task close/.test(error.hint ?? ""),
  );
  // The failed attempt is recorded, not left "starting".
  const failed = env.store.list({ statuses: ["failed"] });
  assert.equal(failed.length, 1);
});

test("follow-ups continue the same conversation and resume a stopped sandbox", async () => {
  const env = makeService();
  const task = await implement(env);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  await env.boat.stop(task.sandboxId!);

  const next = await env.service.followup(task.id, "Rename the toggle.", { provider: "codex" });
  assert.equal(next.status, "running");
  assert.equal(next.turns, 2);
  assert.equal(next.provider, "codex");
  assert.equal(next.conversationId, task.conversationId);
  assert.ok(env.boat.calls.some((call) => call.startsWith(`resume ${task.sandboxId}`)));
  assert.ok(env.boat.calls.at(-1)!.endsWith(`codex ${task.conversationId}`));
});

test("follow-ups to a running task need --steer", async () => {
  const env = makeService();
  const task = await implement(env);
  await assert.rejects(env.service.followup(task.id, "faster"), (error: unknown) => error instanceof TaskError && error.code === "task_running");
  await env.service.followup(task.id, "faster", { steer: true });
  assert.ok(env.boat.calls.some((call) => call === `steer ${task.conversationId} faster`));
});

test("a usage-limit failure hands the conversation to the other agent", async () => {
  const env = makeService();
  const task = await implement(env);
  env.boat.finish(task.conversationId!, "", "failed", "Claude usage limit reached, resets at 5pm");
  await env.service.sweep();
  const switched = env.store.get(task.id)!;
  assert.equal(switched.status, "running");
  assert.equal(switched.provider, "codex");
  assert.equal(env.notifications.length, 0);
  assert.equal(env.store.events(task.id).at(-1)?.kind, "failover");

  // A second limit on the same turn is reported instead of looping.
  env.boat.finish(task.conversationId!, "", "failed", "rate limit");
  await env.service.sweep();
  assert.equal(env.store.get(task.id)!.status, "failed");
  assert.equal(env.notifications.length, 1);
});

test("failover can be turned off", async () => {
  const env = makeService({ settings: { autoFailover: false } });
  const task = await implement(env);
  env.boat.finish(task.conversationId!, "", "failed", "usage limit reached");
  await env.service.sweep();
  assert.equal(env.store.get(task.id)!.status, "failed");
});

test("closing deletes an owned sandbox but keeps a shared one", async () => {
  const env = makeService({ settings: { maxActiveSandboxes: 1 } });
  const task = await implement(env);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  const { task: review } = await env.service.launchTask(await env.service.reviewInput(task.id), 5_000);
  env.boat.finish(review.conversationId!, "=== REVIEW ===\nVERDICT: approve\n=== END REVIEW ===");
  await env.service.sweep();

  const closedReview = await env.service.closeTask(review.id);
  assert.equal(closedReview.sandbox, "kept", "the implementer still uses it");
  const closed = await env.service.closeTask(task.id);
  assert.equal(closed.sandbox, "deleted");
  assert.equal(closed.task.status, "done");
  assert.ok(env.boat.calls.includes(`delete ${task.sandboxId}`));
});

test("cancelling a running task interrupts its turn", async () => {
  const env = makeService();
  const task = await implement(env);
  const { task: cancelled } = await env.service.closeTask(task.id, { status: "cancelled", keepSandbox: true });
  assert.equal(cancelled.status, "cancelled");
  assert.ok(env.boat.calls.includes(`interrupt ${task.conversationId}`));
  assert.ok(!env.boat.calls.some((call) => call.startsWith("delete")));
});

test("setup failures mark the task failed and clean up the new sandbox", async () => {
  const env = makeService();
  env.boat.prepareError = new BoatError("Preparing acme/web failed: repository not found", { code: "repo_setup_failed" });
  await assert.rejects(implement(env), /repository not found/);
  const [failed] = env.store.list({ statuses: ["failed"] });
  assert.match(failed!.error ?? "", /repository not found/);
  assert.equal(env.boat.sandboxes.size, 0);
});

test("slow dispatches return 'starting' and report a later failure to the thread", async () => {
  const env = makeService();
  const original = env.boat.prepareRepo.bind(env.boat);
  env.boat.prepareRepo = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    throw new BoatError("clone timed out", { code: "boat_timeout" });
    return original(...args);
  };
  const { task, pending } = await env.service.launchTask(
    { title: "Slow", role: "implement", brief: "b", repo: "acme/web", orchestratorThreadId: "thr_orch" },
    10,
  );
  assert.equal(pending, true);
  assert.equal(task.status, "starting");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(env.store.get(task.id)!.status, "failed");
  assert.equal(env.notifications.length, 1);
  assert.equal(env.notifications[0]!.tasks[0]!.id, task.id);
});

test("vanished sandboxes fail their running tasks", async () => {
  const env = makeService();
  const task = await implement(env);
  env.boat.sandboxes.delete(task.sandboxId!);
  await env.service.sweep();
  const failed = env.store.get(task.id)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /disappeared/);
  assert.equal(env.notifications.length, 1);
});

test("idle sandboxes are stopped after the configured time", async () => {
  const env = makeService({ settings: { stopIdleAfterMinutes: 1 } });
  const task = await implement(env);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  assert.ok(!env.boat.calls.includes(`stop ${task.sandboxId}`));

  env.store.update(task.id, {});
  const db = env.store as unknown as { db: () => { prepare(sql: string): { run(...args: unknown[]): void } } };
  db.db().prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 5 * 60_000).toISOString(), task.id);
  await env.service.sweep();
  assert.ok(env.boat.calls.includes(`stop ${task.sandboxId}`));
});

test("context from other tasks is folded into a brief", async () => {
  const env = makeService();
  const task = await implement(env);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  const block = env.service.contextBlock([task.id.slice(0, 5)]);
  assert.match(block, /Context from related tasks/);
  assert.match(block, /pull\/12/);
  assert.throws(() => env.service.contextBlock(["t_nope"]), TaskError);
});

// ---- regressions from code review ----------------------------------------

test("closing never deletes a sandbox the user created and lent to a task", async () => {
  const env = makeService();
  const mine = await env.boat.create({ name: "my own box", type: "default" });
  const task = await implement(env, { sandbox: mine.id });
  assert.equal(task.ownsSandbox, false);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  const { sandbox } = await env.service.closeTask(task.id);
  assert.equal(sandbox, "kept");
  assert.ok(env.boat.sandboxes.has(mine.id));
});

test("switching agent on a follow-up does not carry the old provider's model", async () => {
  const env = makeService({ settings: { implementModel: "opus-5-5", reviewModel: "gpt-6.1-sol" } });
  const task = await implement(env);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  const calls: { provider: string; model?: string | null }[] = [];
  const original = env.boat.prompt.bind(env.boat);
  env.boat.prompt = async (options) => {
    calls.push({ provider: options.provider, model: options.model });
    return original(options);
  };
  await env.service.followup(task.id, "Continue.", { provider: "codex" });
  assert.deepEqual(calls, [{ provider: "codex", model: "gpt-6.1-sol" }]);
});

test("an agent override picks that provider's model, not the role's", async () => {
  const env = makeService({ settings: { implementProvider: "codex", implementModel: "gpt-6.1-sol", reviewProvider: "claude", reviewModel: "opus-5-5" } });
  const task = await implement(env, { provider: "claude" });
  assert.equal(task.provider, "claude");
  assert.match(env.boat.calls.find((call) => call.startsWith("prompt"))!, / claude /);
  assert.equal(env.store.get(task.id)!.model, "opus-5-5");
});

test("closing a task while it is still being dispatched cancels the dispatch", async () => {
  const env = makeService();
  let releasePrepare!: () => void;
  const original = env.boat.prepareRepo.bind(env.boat);
  env.boat.prepareRepo = async (...args) => {
    await new Promise<void>((resolve) => (releasePrepare = resolve));
    return original(...args);
  };
  const { task, pending } = await env.service.launchTask(
    { title: "Slow", role: "implement", brief: "b", repo: "acme/web", orchestratorThreadId: "thr_orch" },
    50,
  );
  assert.equal(pending, true);
  const { task: closed } = await env.service.closeTask(task.id);
  assert.equal(closed.status, "cancelled");
  releasePrepare();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(env.store.get(task.id)!.status, "cancelled");
  assert.ok(!env.boat.calls.some((call) => call.startsWith("prompt")), "no agent was started");
  assert.equal(env.boat.sandboxes.size, 0, "the new sandbox was cleaned up");
  assert.equal(env.notifications.length, 0);
});

test("a sweep never reopens a task that was closed meanwhile", async () => {
  const env = makeService();
  const task = await implement(env);
  env.boat.finish(task.conversationId!, REPORT);
  const original = env.boat.events.bind(env.boat);
  env.boat.events = async (...args) => {
    // The orchestrator closes the task while the sweep reads its events.
    await env.service.closeTask(task.id, { keepSandbox: true });
    return original(...args);
  };
  await env.service.sweep();
  // Closed while its turn still counted as running → cancelled, and it stays closed.
  assert.equal(env.store.get(task.id)!.status, "cancelled");
  assert.equal(env.notifications.length, 0);
});

test("parallel dispatches on a full account stop one sandbox, not two", async () => {
  const env = makeService({ settings: { maxActiveSandboxes: 1 } });
  const first = await implement(env);
  env.boat.finish(first.conversationId!, REPORT);
  await env.service.sweep();
  const results = await Promise.allSettled([implement(env, { title: "A" }), implement(env, { title: "B" })]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(env.boat.calls.filter((call) => call.startsWith("stop")).length, 1);
  assert.equal([...env.boat.sandboxes.values()].filter((sandbox) => sandbox.state !== "stopped").length, 1);
});

test("a notification that fails to send is retried on the next sweep", async () => {
  const env = makeService();
  const task = await implement(env);
  env.boat.finish(task.conversationId!, REPORT);
  const service = env.service as unknown as { hooks: { notify: (n: unknown) => Promise<void> } };
  const realNotify = service.hooks.notify;
  service.hooks.notify = async () => {
    throw new Error("bb is restarting");
  };
  await env.service.sweep();
  assert.equal(env.store.get(task.id)!.notifiedAt, null);
  service.hooks.notify = realNotify;
  await env.service.sweep();
  assert.equal(env.notifications.length, 1);
  assert.ok(env.store.get(task.id)!.notifiedAt);
});

test("a follow-up to a task still being dispatched says to wait", async () => {
  const env = makeService();
  const original = env.boat.prepareRepo.bind(env.boat);
  env.boat.prepareRepo = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return original(...args);
  };
  const { task } = await env.service.launchTask({ title: "Slow", role: "implement", brief: "b", repo: "acme/web" }, 10);
  await assert.rejects(env.service.followup(task.id, "hi"), (error: unknown) => error instanceof TaskError && error.code === "task_starting");
  await new Promise((resolve) => setTimeout(resolve, 150));
});

test("implementers may not work directly on the base branch", async () => {
  const env = makeService();
  await assert.rejects(
    implement(env, { branch: "main", baseBranch: "main" }),
    (error: unknown) => error instanceof TaskError && error.code === "invalid_branch",
  );
  assert.equal(env.boat.sandboxes.size, 0, "rejected before any sandbox was created");
});

test("empty or tiny task ids never match a task", async () => {
  const env = makeService();
  await implement(env);
  for (const ref of ["", " ", "t", "t_"]) {
    assert.throws(() => env.service.mustGet(ref), TaskError, JSON.stringify(ref));
  }
});

test("each task checks out into its own folder", async () => {
  const env = makeService();
  const calls: unknown[][] = [];
  const original = env.boat.prepareRepo.bind(env.boat);
  env.boat.prepareRepo = async (...args) => {
    calls.push(args);
    return original(...args);
  };
  const task = await implement(env);
  assert.equal((calls[0]![3] as { workDir?: string }).workDir, task.id);
});
