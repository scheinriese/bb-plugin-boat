import assert from "node:assert/strict";
import { test } from "node:test";
import { adoptNativeChat } from "../src/native-start.ts";
import type { Runtime } from "../src/runtime.ts";
import { resolveTaskStatus } from "../src/board.ts";
import { makeService } from "./fakes.ts";

async function adopted() {
  const env = makeService({ chat: true });
  const runtime = {
    service: env.service, isOrchestrator: async () => false, projects: { forRepo: () => null },
    bb: {
      sdk: {
        threads: { get: async () => ({ title: "Native work", providerId: "codex", projectId: "proj_demo", environmentId: "env_demo", parentThreadId: null }) },
        environments: { get: async () => ({ id: "env_demo", path: "/work/demo", hostId: "host_shared" }) },
        hosts: { get: async () => ({ id: "host_shared", machineProviderId: "boat-sandbox" }) },
        projects: { get: async () => ({ gitRemoteUrl: "https://github.com/acme/demo" }) },
      },
      experimental_machines: { getResource: async () => ({ sandboxId: "bx_native" }) },
      rpc: { experimental_invalidate: () => undefined },
    },
  } as unknown as Runtime;
  await adoptNativeChat("thr_native", runtime);
  const task = env.store.byThread("thr_native")!;
  env.store.update(task.id, { status: "idle" });
  return { ...env, task: env.store.get(task.id)! };
}

test("closing a native registry task preserves the core-owned chat and host", async () => {
  const env = await adopted();
  env.chat.busyMachines.add("host_shared");
  const closed = await env.service.closeTask(env.task.id);
  assert.equal(closed.sandbox, "kept");
  assert.deepEqual(env.chat.archived, []);
  assert.deepEqual(env.chat.removed, []);
  assert.deepEqual(env.boat.calls, []);
  assert.equal(env.service.publicStatus(closed.task).status, "stopped");
  assert.equal(env.service.publicStatus(closed.task).tone, "neutral");
  assert.equal(env.service.publicStatus(closed.task).reason, "Closed without shipping.");
  env.store.addEvent(closed.task.id, "shipped", "Shipped after approval");
  assert.equal(env.service.publicStatus(closed.task).status, "shipped");
});

test("an archive event for a native chat never deletes its core machine", async () => {
  const env = await adopted();
  env.chat.states.set("thr_native", { status: "idle", archived: true, updatedAt: Date.now(), environmentId: "env_demo", queued: 0, backgroundAgents: 0 });
  await env.service.syncChatThread("thr_native", { kind: "archived" });
  assert.deepEqual(env.chat.removed, []);
  assert.equal(env.store.get(env.task.id)!.status, "cancelled");
});

test("an owned task cannot remove a host with other busy work or unknown activity", async () => {
  for (const unknown of [false, true]) {
    const env = await adopted();
    env.store.update(env.task.id, { ownsSandbox: true });
    if (unknown) env.chat.activities.set("host_shared", new Error("Host unavailable"));
    else env.chat.busyMachines.add("host_shared");
    const closed = await env.service.closeTask(env.task.id);
    assert.equal(closed.sandbox, "kept");
    assert.deepEqual(env.chat.removed, []);
  }
});

test("a closed review never claims its changes shipped", () => {
  const state = resolveTaskStatus({ status: "done", role: "review", error: null, readyAt: null });
  assert.equal(state.status, "review");
  assert.equal(state.label, "Review complete");
  assert.equal(state.tone, "neutral");
  assert.equal(state.moving, false);
});
