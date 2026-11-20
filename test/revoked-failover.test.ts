import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { Quotas } from "../src/quota.ts";
import type { Runtime } from "../src/runtime.ts";
import type { StartTaskInput } from "../src/service.ts";
import { registerStartQueueRpc } from "../src/start-queue-rpc.ts";
import { makeService } from "./fakes.ts";

const usage = (): Quotas => new Map([
  ["claude", { provider: "claude", usedPercent: 95, resetsAt: null, window: "Weekly limit", paidAttemptAllowed: true }],
  ["codex", { provider: "codex", usedPercent: 20, resetsAt: null, window: "Weekly limit" }],
]);

// The queue supplies this internal capability only after native owner consent.
const approved: StartTaskInput = {
  title: "Fake designer", role: "custom", brief: "Design a fake settings panel.", repo: "acme/web", provider: "claude",
  queuedStart: { taskId: "t_fake_designer", paidApproved: true, claudePaidContinuation: true, beforeInsert: async () => undefined, insert: (_task, save) => save() },
};

for (const asChat of [false, true]) {
  const mode = asChat ? "native" : "headless";
  for (const reload of [false, true]) {
    test(`${mode} revoking a running custom task without Design metadata prevents automatic provider substitution${reload ? " after reload" : ""}`, async t => {
      const quotas = usage();
      const options = { chat: asChat, quotas, settings: { workerMode: asChat ? "chat" as const : "boat" as const } };
      const env = makeService(options);
      const { bb, harness } = createFakePluginHost({ pluginId: "boat" });
      t.after(() => harness.lifecycle.dispose());
      registerStartQueueRpc({ bb, service: env.service, startQueue: {}, launchWaitMs: 0, changed() {} } as unknown as Runtime);
      const { task } = await env.service.launchTask(approved, 5000);
      assert.equal(task.role, "custom");
      assert.equal(task.purpose, null);
      assert.equal(task.designClaudePreference, false);
      await harness.callRpc("revokeClaudePaidContinuation", { id: task.id });
      assert.equal(env.store.get(task.id)!.claudePaidContinuation, false);
      assert.equal(env.store.get(task.id)!.claudePaidContinuationRevoked, true);
      assert.equal(env.store.get(task.id)!.claudeNormalRouting, false);
      const service = reload ? makeService({ ...options, reuse: { store: env.store, boat: env.boat, ...(asChat ? { chat: env.chat } : {}) } }).service : env.service;
      await service.sweep(); // Observe the native running turn before its failure.
      if (asChat) env.chat.finish(task.threadId!, "Claude usage limit reached", "error");
      else env.boat.finish(task.conversationId!, "", "failed", "Claude usage limit reached");
      await service.sweep();
      const failed = env.store.get(task.id)!;
      assert.equal(failed.provider, "claude", "revoking payment does not authorize a Codex turn");
      assert.equal(failed.status, "failed");
      assert.equal(failed.sandboxId, task.sandboxId);
      assert.equal(asChat ? env.chat.spawns.length : env.boat.prompts.length, 1, "no automatic provider turn is sent");
      assert.equal(env.store.events(task.id).some(event => event.kind === "failover"), false);
    });
  }

  test(`${mode} explicitly returning a revoked custom task to normal routing permits ordinary failover after reload`, async t => {
    const quotas = usage();
    const options = { chat: asChat, quotas, settings: { workerMode: asChat ? "chat" as const : "boat" as const } };
    const env = makeService(options);
    const { bb, harness } = createFakePluginHost({ pluginId: "boat" });
    t.after(() => harness.lifecycle.dispose());
    registerStartQueueRpc({ bb, service: env.service, startQueue: {}, launchWaitMs: 0, changed() {} } as unknown as Runtime);
    const { task } = await env.service.launchTask(approved, 5000);
    await harness.callRpc("revokeClaudePaidContinuation", { id: task.id });
    await harness.callRpc("clearDesignClaudePreference", { id: task.id });
    const reloaded = makeService({ ...options, reuse: { store: env.store, boat: env.boat, ...(asChat ? { chat: env.chat } : {}) } });
    assert.equal(reloaded.store.get(task.id)!.claudeNormalRouting, true);
    assert.equal(reloaded.store.get(task.id)!.claudePaidContinuation, false);
    assert.equal(reloaded.store.get(task.id)!.claudePaidContinuationRevoked, true, "normal routing does not restore payment permission");
    await reloaded.service.sweep();
    if (asChat) env.chat.finish(task.threadId!, "Claude usage limit reached", "error");
    else env.boat.finish(task.conversationId!, "", "failed", "Claude usage limit reached");
    await reloaded.service.sweep();
    const continued = env.store.get(task.id)!;
    assert.equal(continued.provider, "codex");
    assert.equal(continued.status, "running");
    assert.equal(continued.sandboxId, task.sandboxId);
    assert.equal(asChat ? env.chat.spawns.length : env.boat.prompts.length, 2);
    assert.ok(env.store.latestEvent(task.id, "failover"));
  });
}

for (const asChat of [false, true]) {
  test(`${asChat ? "native" : "headless"} payment-only revocation retains included Claude for default followups and permits an explicit manual switch`, async t => {
    const quotas = usage();
    const env = makeService({ chat: asChat, quotas, settings: { workerMode: asChat ? "chat" : "boat" } });
    const { bb, harness } = createFakePluginHost({ pluginId: "boat" });
    t.after(() => harness.lifecycle.dispose());
    registerStartQueueRpc({ bb, service: env.service, startQueue: {}, launchWaitMs: 0, changed() {} } as unknown as Runtime);
    const { task } = await env.service.launchTask(approved, 5000);
    await harness.callRpc("revokeClaudePaidContinuation", { id: task.id });
    const finish = async () => {
      const current = env.store.get(task.id)!;
      await env.service.sweep();
      const report = `Fake turn ${current.turns} completed.\n=== REPORT ===\nSTATUS: done\nSUMMARY: Fake completion\n=== END REPORT ===`;
      if (asChat) env.chat.finish(current.threadId!, report, "idle");
      else env.boat.finish(current.conversationId!, report, "finished");
      await env.service.sweep();
    };
    await finish();
    quotas.get("claude")!.usedPercent = 10;
    const next = await env.service.followup(task.id, "Continue this design on its selected provider.");
    assert.equal(next.provider, "claude");
    assert.equal(next.claudePaidContinuation, false);
    assert.equal(next.claudePaidContinuationRevoked, true);
    await finish();
    quotas.get("claude")!.usedPercent = 95;
    const sent = asChat ? env.chat.sends.length : env.boat.prompts.length;
    await assert.rejects(env.service.followup(task.id, "Continue with included usage only."), /near its usage limit/);
    assert.equal(env.store.get(task.id)!.provider, "claude");
    assert.equal(asChat ? env.chat.sends.length : env.boat.prompts.length, sent);
    const switched = await env.service.followup(task.id, "Use Codex for the next turn.", { provider: "codex" });
    assert.equal(switched.provider, "codex", "an explicit manual provider choice remains supported");
    assert.equal(switched.claudePaidContinuation, false);
  });
}
