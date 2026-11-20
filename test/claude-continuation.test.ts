import assert from "node:assert/strict";
import { test } from "node:test";
import type { Quotas } from "../src/quota.ts";
import type { StartTaskInput } from "../src/service.ts";
import { TaskError } from "../src/service.ts";
import type { Task } from "../src/store.ts";
import { makeService } from "./fakes.ts";

const REPORT = "Completed.\n=== REPORT ===\nSTATUS: done\nPR: https://github.com/acme/web/pull/12\nSUMMARY: Updated the layout\n=== END REPORT ===";
const quotas = (): Quotas => new Map([
  ["claude", { provider: "claude", usedPercent: 95, resetsAt: null, window: "Weekly limit", paidAttemptAllowed: true, extraUsage: { allowed: false, status: "rejected", observedAt: 0 } }],
  ["codex", { provider: "codex", usedPercent: 20, resetsAt: null, window: "Weekly limit" }],
]);

/** Internal capability issued by the queue only after the native owner interaction. */
function approvedInput(overrides: Partial<StartTaskInput> = {}): StartTaskInput {
  return {
    title: "Design the settings panel", role: "custom", brief: "Design the settings panel. Do not use paid usage.", repo: "acme/web", provider: "claude", flexibleAgent: false,
    orchestratorThreadId: "thr_orchestrator",
    queuedStart: { taskId: "t_fake_approved", paidApproved: true, claudePaidContinuation: true, beforeInsert: async () => undefined, insert: (_task, save) => save() },
    ...overrides,
  };
}

async function finish(env: ReturnType<typeof makeService>, task: Task, error?: string) {
  await env.service.sweep(); // observe the native turn before completing it
  if (task.runner === "chat") env.chat.finish(task.threadId!, error ?? REPORT, error ? "error" : "idle");
  else env.boat.finish(task.conversationId!, error ? "" : REPORT, error ? "failed" : "finished", error);
  await env.service.sweep();
}

for (const asChat of [false, true]) {
  const mode = asChat ? "native" : "headless";
  test(`${mode} scoped followups and steers keep Claude with included Codex available; permission survives reload`, async () => {
    const usage = quotas();
    const env = makeService({ chat: asChat, quotas: usage, settings: { workerMode: asChat ? "chat" : "boat" } });
    const { task } = await env.service.launchTask(approvedInput(), 5000);
    assert.equal(task.provider, "claude");
    assert.equal(task.claudePaidContinuation, true);
    const prompt = asChat ? env.chat.spawns[0]!.prompt : env.boat.prompts[0]!.text;
    assert.match(prompt, /Do not use paid usage/);
    assert.match(prompt, /supersedes only an earlier no-paid-usage instruction/);
    await env.service.followup(task.id, "Keep the panel compact.", { steer: true });
    await finish(env, task);
    assert.equal(env.store.get(task.id)!.status, "idle");
    const reloaded = makeService({ chat: asChat, quotas: usage, settings: { workerMode: asChat ? "chat" : "boat", relay: { enabled: true, preferred: "claude", switchAtPercent: 90, switchBackBelowPercent: 50, quietMinutes: 10, paidClaudeFallback: true } }, reuse: { store: env.store, boat: env.boat, ...(asChat ? { chat: env.chat } : {}) } });
    const next = await reloaded.service.followup(task.id, "Add the empty state.");
    assert.equal(next.provider, "claude");
    assert.equal(next.claudePaidContinuation, true);
    assert.equal(next.sandboxId, task.sandboxId);
    assert.equal(next.threadId, task.threadId);
    const text = asChat ? env.chat.sends.at(-1)!.text : env.boat.prompts.at(-1)!.text;
    assert.match(text, /This task alone may continue on Claude/);
    assert.equal(asChat ? env.chat.spawns.length : env.boat.convos.size, 1);
  });

  test(`${mode} scoped usage and billing refusals preserve the task without automatic Codex handoff`, async () => {
    for (const error of ["Claude usage limit reached", "Provider billing refused: credit balance exhausted", "Authentication failed"]) {
      const env = makeService({ chat: asChat, quotas: quotas(), settings: { workerMode: asChat ? "chat" : "boat" } });
      const { task } = await env.service.launchTask(approvedInput(), 5000);
      await finish(env, task, error);
      const failed = env.store.get(task.id)!;
      assert.equal(failed.provider, "claude", error);
      assert.equal(failed.status, "failed", error);
      assert.equal(failed.sandboxId, task.sandboxId);
      assert.ok(env.boat.sandboxes.has(task.sandboxId!));
      assert.equal(asChat ? env.chat.spawns.length : env.boat.prompts.length, 1);
      assert.equal(env.store.events(task.id).some((event) => event.kind === "failover"), false);
    }
  });

  test(`${mode} scoped followup rejects route blockers and explicit other-provider changes`, async () => {
    const usage = quotas();
    const env = makeService({ chat: asChat, quotas: usage, settings: { workerMode: asChat ? "chat" : "boat" } });
    const { task } = await env.service.launchTask(approvedInput(), 5000);
    await finish(env, task);
    await assert.rejects(env.service.followup(task.id, "Continue", { provider: "codex" }), (error: unknown) => error instanceof TaskError && error.code === "claude_continuation_provider");
    usage.get("claude")!.paidAttemptAllowed = false;
    await assert.rejects(env.service.followup(task.id, "Continue"), /route or login is unavailable/);
    assert.equal(env.store.get(task.id)!.status, "idle");
    assert.equal(asChat ? env.chat.sends.length : env.boat.prompts.length - 1, 0);
  });
}

test("ordinary approval flags, a later task and a review never inherit scoped payment permission", async () => {
  const env = makeService({ quotas: quotas() });
  const { task } = await env.service.launchTask(approvedInput(), 5000);
  await finish(env, task);
  const reviewInput = await env.service.reviewInput(task.id);
  assert.equal(reviewInput.queuedStart, undefined);
  const review = await env.service.startTask(reviewInput);
  assert.equal(review.claudePaidContinuation, false);
  assert.equal(review.claudePaidContinuationRevoked, false);
  const other = await env.service.startTask({ title: "Another task", role: "implement", brief: "Fix the sidebar", repo: "acme/web", provider: "codex", userApproved: true });
  assert.equal(other.claudePaidContinuation, false);
});

test("scoped consent never bypasses project policy and a design preference keeps Claude after payment revocation", async () => {
  const env = makeService({ quotas: quotas(), projects: [{ id: "web", name: "Web", repos: [{ repo: "acme/web" }], machineType: null, neverPaidClaude: true }] });
  await assert.rejects(env.service.launchTask(approvedInput(), 5000), /project that permits it/);
  assert.equal(env.boat.created.length, 0);

  env.setProjects([]);
  const { task } = await env.service.launchTask(approvedInput(), 5000);
  env.store.update(task.id, { claudePaidContinuation: false, claudePaidContinuationRevoked: true, designClaudePreference: true });
  await finish(env, task, "Claude usage limit reached");
  assert.equal(env.store.get(task.id)!.provider, "claude");
  assert.equal(env.store.get(task.id)!.status, "failed");
  assert.equal(env.boat.prompts.length, 1);
});

test("design preference is explicit and uses Claude without granting paid consent", async () => {
  const usage = quotas();
  usage.get("claude")!.usedPercent = 10;
  const env = makeService({ quotas: usage, settings: { implementProvider: "codex", preferClaudeForDesign: true, avoidExtraUsage: false } });
  const design = await env.service.startTask({ title: "Settings layout", role: "custom", purpose: "design", brief: "Design the settings layout", repo: "acme/web" });
  assert.equal(design.provider, "claude");
  assert.equal(design.purpose, "design");
  assert.equal(design.designClaudePreference, true);
  assert.equal(design.claudePaidContinuation, false);
  await finish(env, design);
  usage.get("claude")!.usedPercent = 95;
  await assert.rejects(env.service.followup(design.id, "Polish the layout"), /near its usage limit/);
  assert.equal(env.store.get(design.id)!.provider, "claude");
  await assert.rejects(env.service.startTask({ title: "Another design", role: "custom", purpose: "design", brief: "Design the header", repo: "acme/web" }), /near its usage limit/);
  const ordinary = await env.service.startTask({ title: "Fix a design test", role: "implement", brief: "Fix a test about design", repo: "acme/web" });
  assert.equal(ordinary.provider, "codex");
  assert.equal(ordinary.designClaudePreference, false);
  const explicit = await env.service.startTask({ title: "Explicit agent", role: "custom", purpose: "design", brief: "Design the footer", repo: "acme/web", provider: "codex" });
  assert.equal(explicit.provider, "codex");
  assert.equal(explicit.designClaudePreference, false);
});

test("closing or archiving approved work permanently closes its scoped payment permission", async () => {
  for (const archived of [false, true]) {
    const env = makeService({ chat: true, quotas: quotas(), settings: { workerMode: "chat", deleteSandboxOnClose: false } });
    const { task } = await env.service.launchTask(approvedInput(), 5000);
    if (archived) {
      env.chat.states.get(task.threadId!)!.archived = true;
      await env.service.sweep();
    } else await env.service.closeTask(task.id, { status: "cancelled", keepSandbox: true });
    const closed = env.store.get(task.id)!;
    assert.equal(closed.claudePaidContinuation, false);
    assert.equal(closed.claudePaidContinuationRevoked, true);
  }
});

test("revocation during an initial scoped headless dispatch allocates no provider turn and preserves its workspace", async () => {
  const env = makeService({ quotas: quotas() });
  const originalPrepare = env.boat.prepareRepo.bind(env.boat);
  env.boat.prepareRepo = async (...args: Parameters<typeof originalPrepare>) => {
    const prepared = await originalPrepare(...args);
    env.store.update("t_fake_approved", { claudePaidContinuation: false, claudePaidContinuationRevoked: true });
    return prepared;
  };
  await assert.rejects(env.service.launchTask(approvedInput(), 5000), /permission changed/);
  const failed = env.store.get("t_fake_approved")!;
  assert.equal(failed.status, "failed");
  assert.equal(env.boat.prompts.length, 0);
  assert.ok(env.boat.sandboxes.has(failed.sandboxId!));
  assert.match(env.store.latestEvent(failed.id, "claude-continuation-stopped")!.text, /workspace are preserved/);
});

test("returning a native task to normal routing permits an explicit provider switch after revocation", async () => {
  const env = makeService({ chat: true, quotas: quotas(), settings: { workerMode: "chat" } });
  const { task } = await env.service.launchTask(approvedInput(), 5000);
  await finish(env, task);
  // The supported owner action clears the preference and closes its scoped permission.
  env.store.update(task.id, { designClaudePreference: false, claudePaidContinuation: false, claudePaidContinuationRevoked: true });
  const next = await env.service.followup(task.id, "Continue normally on Codex", { provider: "codex" });
  assert.equal(next.provider, "codex");
  assert.equal(next.claudePaidContinuation, false);
  assert.equal(next.claudePaidContinuationRevoked, true);
  assert.notEqual(next.threadId, task.threadId);
  assert.equal(env.chat.spawns.at(-1)!.provider, "codex");
});

test("revocation or project opt-out during headless-to-chat setup prevents the read-up provider turn", async () => {
  for (const change of ["revoke", "project"] as const) {
    const env = makeService({ chat: true, quotas: quotas(), settings: { workerMode: "chat" }, connect: { state: "ready", fix: null }, repoWorkerMode: () => "chat" });
    const { task } = await env.service.launchTask(approvedInput({ runner: "boat" }), 5000);
    await finish(env, task);
    const attach = env.chat.attachMachine.bind(env.chat);
    env.chat.attachMachine = async (...args: Parameters<typeof attach>) => {
      const result = await attach(...args);
      if (change === "revoke") env.store.update(task.id, { claudePaidContinuation: false, claudePaidContinuationRevoked: true });
      else env.setProjects([{ id: "web", name: "Web", repos: [{ repo: "acme/web" }], machineType: null, neverPaidClaude: true }]);
      return result;
    };
    await assert.rejects(env.service.continueAsChat(task.id, { confirmUntrusted: null, via: "page", waitMs: 5000 }));
    assert.equal(env.chat.spawns.length, 0, change);
    assert.equal(env.store.get(task.id)!.runner, "boat", change);
    assert.ok(env.boat.sandboxes.has(task.sandboxId!), change);
  }
});
