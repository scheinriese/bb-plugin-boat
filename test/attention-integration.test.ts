import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import plugin from "../server.ts";
import { TaskStore } from "../src/store.ts";
import { createTestHost, makeService } from "./fakes.ts";

test("explicit tools trigger device pushes without another task turn or monitor cycle", async (t) => {
  process.env.FAKE_BOAT_STATE = join(mkdtempSync(join(tmpdir(), "boat-attention-")), "state.json");
  const { bb, harness } = await createTestHost({ pluginId: "boat", settings: { boatPath: fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url)), agents: "both", evidenceUploader: "", pushNotifications: true }, agentSkillIds: ["boat", "boat-orchestrator"] });
  t.after(() => harness.lifecycle.dispose());
  const notices: { title: string; threadId: string }[] = [];
  harness.sdk.stub("plugins.callRpc", async ({ pluginId, method, input }: { pluginId: string; method: string; input: { title: string; threadId: string } }) => {
    assert.equal(pluginId, "push-notifications");
    assert.equal(method, "notifications.send");
    notices.push(input);
    return { ok: true, channels: ["web"] };
  });
  await plugin(bb);
  const store = new TaskStore(() => bb.storage.database());
  store.addOrchestrator("thr_source");
  const fake = makeService();
  const task = (await fake.service.launchTask({ title: "Cart spacing", role: "implement", brief: "Fix the spacing." }, 5_000)).task;
  store.insert({ ...task, status: "idle", sandboxId: null, threadId: "thr_task", orchestratorThreadId: "thr_source", error: null });
  await harness.behavior.callAgentTool("boat_needs_you", { question: "Pick a rate limit?", recommendation: "60 per minute" }, { threadId: "thr_source" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(notices.map((notice) => notice.threadId), ["thr_source"]);
  await harness.behavior.callAgentTool("boat_ready", { task_id: task.id, note: "Check the cart spacing" }, { threadId: "thr_source" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(notices.map((notice) => notice.title), ["Needs you: Pick a rate limit?", "Ready: Cart spacing"]);
  await harness.behavior.callAgentTool("boat_ready", { task_id: task.id, note: "Same work, clearer note" }, { threadId: "thr_source" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(notices.length, 2);
  assert.equal(harness.inspection.sdk.callsTo("threads.send").length, 0);
});
