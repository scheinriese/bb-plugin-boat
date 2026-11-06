// What Close, Cancel and Ship say they did: closed with the sandbox deleted,
// closed with it kept (and why), or still open only when the task really is.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import plugin from "../server.ts";
import { closeOutcomeText, describeClose } from "../src/close-outcome.ts";
import type { OrchestratorProject } from "../src/projects.ts";
import { closeToast, keptSentence, shipOutcome } from "../web/logic.ts";
import { createTestHost, makeService } from "./fakes.ts";

const REPORT = `Done.
=== REPORT ===
STATUS: done
PR: none
BRANCH: boat/x
SUMMARY: Sticky header.
TESTS: ok
OPEN QUESTIONS: none
=== END REPORT ===`;

const STOREFRONT: OrchestratorProject = {
  id: "storefront",
  name: "Storefront",
  repos: [{ repo: "acme/storefront", baseBranch: "master" }],
  environment: "storefront",
  snapshot: null,
  protocolPath: null,
  workerMode: "boat",
  delivery: "push",
  source: "boat",
  protectedBranches: [],
  instructions: "",
  bbProjectId: null,
};

const brief = (overrides: Record<string, unknown> = {}) => ({
  title: "Sticky header",
  role: "implement" as const,
  brief: "Do it.",
  repo: "acme/storefront",
  orchestratorThreadId: "thr_orch",
  ...overrides,
});

/** A finished implementation turn. */
async function finished(env: ReturnType<typeof makeService>, overrides: Record<string, unknown> = {}) {
  const { task } = await env.service.launchTask(brief(overrides), 5_000);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  return env.store.get(task.id)!;
}

test("Ship closes the task; its review, still open in the same sandbox, keeps the sandbox, and every message says so", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 10;
  const task = await finished(env, { project: STOREFRONT });
  // Work that ships after approval is reviewed where the commits are.
  const { task: review } = await env.service.launchTask(await env.service.reviewInput(task.id), 5_000);
  assert.equal(review.sandboxId, task.sandboxId);

  const result = await env.service.shipTask(task.id, { approval: "test" });
  assert.equal(result.task.status, "done");
  assert.equal(result.sandbox, "kept");
  const outcome = await describeClose(env.service, result);
  assert.equal(outcome.keptBecause, `task ${review.id} still uses it`);
  assert.equal(outcome.text, `Task ${task.id} is closed; its sandbox is kept: task ${review.id} still uses it.`);
  assert.doesNotMatch(outcome.text, /stays open/);
  // The page's toast.
  assert.equal(shipOutcome({ status: result.task.status, sandbox: result.sandbox, keptBecause: outcome.keptBecause }), `The task is closed; its sandbox is kept: task ${review.id} still uses it.`);

  // Once the review is closed too, the sandbox goes.
  env.boat.finish(review.conversationId!, "Looks good.\n=== REPORT ===\nVERDICT: approve\n=== END REPORT ===");
  await env.service.sweep();
  const closed = await env.service.closeTask(review.id);
  assert.equal(closed.sandbox, "deleted");
  assert.equal((await describeClose(env.service, closed)).text, `Task ${review.id} is closed; its sandbox is deleted.`);
});

test("Ship that keeps the task open, or that a new turn interrupts, says the task stays open", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 10;
  const task = await finished(env, { project: STOREFRONT });
  const kept = await env.service.shipTask(task.id, { approval: "test", keepOpen: true });
  assert.equal(kept.task.status, "idle");
  const outcome = await describeClose(env.service, kept);
  assert.equal(outcome.keptBecause, null);
  assert.equal(outcome.text, `Task ${task.id} stays open, with its sandbox.`);
  assert.equal(shipOutcome({ status: "idle", sandbox: "kept", keptBecause: null }), "The task stays open.");
  assert.equal(closeOutcomeText({ id: task.id, status: "running" }, "kept", null), `Task ${task.id} stays open: a new turn started.`);
  assert.equal(shipOutcome({ status: "running", sandbox: "kept", keptBecause: null }), "The task stays open: a new turn started.");
});

test("Close and Cancel: deleted, kept as asked, kept by the setting, a sandbox the plugin didn't create, already gone", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 10;

  const plain = await finished(env);
  const deleted = await env.service.closeTask(plain.id);
  assert.equal((await describeClose(env.service, deleted)).text, `Task ${plain.id} is closed; its sandbox is deleted.`);

  const { task: running } = await env.service.launchTask(brief(), 5_000);
  const cancelled = await env.service.closeTask(running.id, { status: "cancelled" });
  assert.equal((await describeClose(env.service, cancelled)).text, `Task ${running.id} is cancelled; its sandbox is deleted.`);

  const asked = await finished(env);
  const keptAsked = await env.service.closeTask(asked.id, { keepSandbox: true });
  assert.equal((await describeClose(env.service, keptAsked, { asked: true })).text, `Task ${asked.id} is closed; its sandbox is kept: you asked to keep it.`);

  env.setSettings({ deleteSandboxOnClose: false });
  const bySetting = await finished(env);
  const keptBySetting = await env.service.closeTask(bySetting.id);
  assert.equal(
    (await describeClose(env.service, keptBySetting)).text,
    `Task ${bySetting.id} is closed; its sandbox is kept: Delete sandboxes when tasks close is off.`,
  );
  env.setSettings({ deleteSandboxOnClose: true });

  // A sandbox you made and lent to a task is never deleted.
  const yours = await env.boat.create({ name: "mine", type: "default" });
  const lent = await finished(env, { sandbox: yours.id });
  assert.equal(lent.ownsSandbox, false);
  const keptYours = await env.service.closeTask(lent.id);
  assert.equal((await describeClose(env.service, keptYours)).text, `Task ${lent.id} is closed; its sandbox is kept: the plugin didn't create it.`);

  // Already gone, and no sandbox at all.
  assert.equal(closeOutcomeText({ id: "t_1", status: "done" }, "gone", null), "Task t_1 is closed; its sandbox was already gone.");
  assert.equal(closeOutcomeText({ id: "t_1", status: "done" }, "none", null), "Task t_1 is closed.");
});

test("two tasks still on the sandbox are both named", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 10;
  const task = await finished(env, { project: STOREFRONT });
  const first = await env.service.launchTask({ ...brief({ title: "Also this" }), sandbox: task.sandboxId }, 5_000);
  const second = await env.service.launchTask({ ...brief({ title: "And this" }), sandbox: task.sandboxId }, 5_000);
  const closed = await env.service.closeTask(task.id, { discard: true });
  assert.equal(closed.sandbox, "kept");
  assert.equal((await describeClose(env.service, closed)).keptBecause, `tasks ${first.task.id} and ${second.task.id} still use it`);
});

test("the page's Close toast says why a sandbox was kept", () => {
  assert.deepEqual(closeToast({ taskId: "t_1", cancelled: false, sandbox: "kept", keptBecause: "task t_2 still uses it" }), {
    title: "Closed t_1 · sandbox kept",
    description: "Task t_2 still uses it.",
  });
  assert.deepEqual(closeToast({ taskId: "t_1", cancelled: true, sandbox: "deleted", keptBecause: null }), { title: "Cancelled t_1 · sandbox deleted", description: null });
  assert.deepEqual(closeToast({ taskId: "t_1", cancelled: false, sandbox: "none", keptBecause: null }), { title: "Closed t_1", description: null });
  assert.equal(keptSentence("Delete sandboxes when tasks close is off"), "Delete sandboxes when tasks close is off.");
  assert.equal(keptSentence(null), null);
  assert.equal(shipOutcome({ status: "done", sandbox: "deleted", keptBecause: null }), "The task is closed and its sandbox deleted.");
});

test("the CLI and the agent tool say a shipped task closed and why its sandbox stayed", async (t) => {
  const fakeBoat = fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "boat-close-test-"));
  const statePath = join(dir, "state.json");
  process.env.FAKE_BOAT_STATE = statePath;
  const { bb, harness } = await createTestHost({ pluginId: "boat", settings: { boatPath: fakeBoat, evidenceUploader: "" }, agentSkillIds: ["boat", "boat-orchestrator"] });
  t.after(async () => {
    await harness.lifecycle.dispose();
  });
  harness.sdk.stub("threads.get", async () => ({ id: "thr_orch", environmentId: null, deletedAt: null, archivedAt: null }));
  harness.sdk.stub("threads.send", async () => ({ ok: true, delivery: "sent" }));
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "orchestrator" }));
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
  await plugin(bb);
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const finishAll = () => {
    const current = state();
    for (const convo of Object.values(current.convos) as { running: boolean; reply: string | null; sandboxId: string }[]) {
      convo.running = false;
      convo.reply = REPORT;
      current.sandboxes[convo.sandboxId].state = "idle";
    }
    writeFileSync(statePath, JSON.stringify(current));
  };

  assert.equal((await harness.runCli(["project", "add", "--name", "Storefront", "--repo", "acme/storefront@master"])).exitCode, 0);
  assert.equal((await harness.runCli(["project", "set", "storefront", "--delivery", "push"])).exitCode, 0);
  const started = await harness.runCli(["task", "start", "--project", "storefront", "--title", "Sticky header", "--brief", "Do it.", "--json"], { threadId: "thr_orch" });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  const { task } = JSON.parse(started.stdout) as { task: { id: string } };
  finishAll();
  await harness.runCli(["task", "show", task.id, "--refresh"]);
  const reviewed = await harness.runCli(["task", "review", task.id, "--json"], { threadId: "thr_orch" });
  assert.equal(reviewed.exitCode, 0, reviewed.stderr || reviewed.stdout);
  const review = (JSON.parse(reviewed.stdout) as { task: { id: string } }).task;

  // The user approves in the orchestrator chat.
  harness.sdk.stub("threads.conversationOutline", async () => ({
    items: [
      { id: "m1", role: "user", preview: `[boat] Task ${task.id} finished a turn.`, attachmentSummary: null },
      { id: "m2", role: "user", preview: "Ship it", attachmentSummary: null },
    ],
    maxSeq: 2,
  }));
  const shipped = await harness.runCli(["task", "ship", task.id], { threadId: "thr_orch" });
  assert.equal(shipped.exitCode, 0, shipped.stderr || shipped.stdout);
  assert.match(shipped.stdout, new RegExp(`Task ${task.id} is closed; its sandbox is kept: task ${review.id} still uses it\\.`));
  assert.doesNotMatch(shipped.stdout, /stays open/);

  // The review closes through the agent tool: now the sandbox goes.
  const closed = await harness.callAgentTool("boat_close", { task_id: review.id }, { threadId: "thr_orch" });
  assert.match(JSON.stringify(closed), new RegExp(`Task ${review.id} is closed; its sandbox is deleted\\.`));
});
