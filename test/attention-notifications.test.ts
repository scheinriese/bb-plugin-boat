import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { createAttentionNotifications, type AttentionNotice } from "../src/attention-notifications.ts";
import { resolveTaskStatus } from "../src/board.ts";
import type { Decision, Task } from "../src/store.ts";

function fixture() {
  const data = new Map<string, unknown>();
  const kv: PluginKvStorage = { get: async <T>(key: string) => data.get(key) as T | undefined, set: async (key, value) => { data.set(key, value); }, delete: async (key) => { data.delete(key); }, list: async () => [...data.keys()] };
  const task = { id: "t_1", title: "Fix the cart", role: "implement", status: "idle", error: null, readyAt: "2026-11-07", readyNote: "Check the cart", prUrl: null, threadId: "thr_task", orchestratorThreadId: "thr_source", turns: 1, promptId: "p_1", finishedAt: "2026-11-07" } as Task;
  const decision = { id: "d_1", status: "open", question: "Pick a rate limit", recommendation: "Use 60 per minute", orchestratorThreadId: "thr_source", options: [], taskIds: [], answer: null, createdAt: "2026-11-07", resolvedAt: null } as Decision;
  const state = { enabled: false, stopped: false, tasks: [task], decisions: [decision] };
  const sent: AttentionNotice[] = [];
  const failures: unknown[] = [];
  const deps = { kv, enabled: async () => state.enabled, stopped: () => state.stopped, tasks: () => state.tasks, decisions: () => state.decisions, status: (task: Task) => resolveTaskStatus(task, { ready: task.readyAt !== null }), send: async (notice: AttentionNotice) => { sent.push(notice); }, failed: (error: unknown) => { failures.push(error); } };
  return { state, data, sent, failures, deps, task, decision };
}

test("explicit decisions and ready work honor the setting, deep-link their chats, and dedupe across reloads", async () => {
  const env = fixture();
  const notifier = createAttentionNotifications(env.deps);
  await notifier.flush();
  assert.equal(env.sent.length, 0);
  env.state.enabled = true;
  await Promise.all([notifier.flush(), notifier.flush()]);
  assert.deepEqual(env.sent.map((notice) => [notice.title, notice.threadId]), [["Needs you: Pick a rate limit", "thr_source"], ["Ready: Fix the cart", "thr_task"]]);
  env.task.readyAt = "2026-11-08"; // explicit markReady after a turn's ready push
  env.task.readyNote = "A clearer note";
  await notifier.flush();
  await createAttentionNotifications(env.deps).flush();
  assert.equal(env.sent.length, 2, "turn completion and markReady share the same generation");
  env.task.turns += 1;
  env.task.promptId = "p_2";
  await notifier.flush();
  assert.equal(env.sent.length, 3, "new work can become ready again");
});

test("failed delivery remains pending and retries after a later tick", async () => {
  const env = fixture();
  env.state.enabled = true;
  env.state.decisions = [];
  let attempts = 0;
  const notifier = createAttentionNotifications({ ...env.deps, send: async (notice) => { if (++attempts === 1) throw new Error("no channel accepted it"); env.sent.push(notice); } });
  await notifier.flush();
  assert.equal(env.data.has("attention:ready:t_1"), false);
  assert.equal(env.failures.length, 1);
  await notifier.flush();
  assert.equal(env.sent.length, 1);
  assert.equal(env.data.get("attention:ready:t_1"), "1:p_1");
});

test("needs-you and ready category preferences filter independently without acknowledging skipped work", async () => {
  const env = fixture();
  let ready = false;
  let needsYou = true;
  const notifier = createAttentionNotifications({ ...env.deps, enabled: async (kind) => kind === undefined || (kind === "ready" ? ready : needsYou) });
  await notifier.flush();
  assert.deepEqual(env.sent.map((notice) => notice.title), ["Needs you: Pick a rate limit"]);
  assert.equal(env.data.has("attention:ready:t_1"), false);
  ready = true;
  needsYou = false;
  await notifier.flush();
  assert.deepEqual(env.sent.map((notice) => notice.title), ["Needs you: Pick a rate limit", "Ready: Fix the cart"]);
});

test("changes while delivery runs are drained without duplicate ready notices", async () => {
  const env = fixture();
  env.state.enabled = true;
  env.state.decisions = [];
  let release!: () => void;
  let sending!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { sending = resolve; });
  const notifier = createAttentionNotifications({ ...env.deps, send: async (notice) => { sending(); await gate; env.sent.push(notice); } });
  const first = notifier.flush();
  await started;
  env.state.decisions = [env.decision];
  const second = notifier.flush();
  release();
  await Promise.all([first, second]);
  assert.equal(env.sent.length, 2);
  assert.equal(env.sent.filter((notice) => notice.title.startsWith("Ready:")).length, 1);
});

test("progress, reset waits, closed decisions, and missing chat links produce no push", async () => {
  const env = fixture();
  env.state.enabled = true;
  env.decision.status = "answered";
  env.task.status = "failed";
  env.task.error = "Usage limit reached; waiting for reset";
  const notifier = createAttentionNotifications(env.deps);
  await notifier.flush();
  env.task.status = "running";
  await notifier.flush();
  env.task.status = "idle";
  env.task.error = null;
  env.task.threadId = null;
  env.task.orchestratorThreadId = null;
  await notifier.flush();
  assert.equal(env.sent.length, 0);
});

test("an undeliverable decision does not starve ready work in another chat", async () => {
  const env = fixture();
  env.state.enabled = true;
  const notifier = createAttentionNotifications({ ...env.deps, send: async (notice) => { if (notice.threadId === "thr_source") throw new Error("thread not found"); env.sent.push(notice); } });
  await notifier.flush();
  assert.equal(env.failures.length, 1);
  assert.deepEqual(env.sent.map((notice) => notice.threadId), ["thr_task"]);
  assert.equal(env.data.has("attention:decision:d_1"), false);
});

test("a confirmed needs-you recovery pushes once and an explicit task decision prevents a duplicate", async () => {
  const env = fixture();
  env.state.enabled = true;
  env.task.status = "failed";
  env.task.error = "Out of memory";
  const status = (task: Task) => resolveTaskStatus(task, { recoveryCostsMore: true });
  env.decision.taskIds = [env.task.id];
  const notifier = createAttentionNotifications({ ...env.deps, status });
  await notifier.flush();
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0]!.threadId, "thr_source");
  env.state.decisions = [];
  await notifier.flush();
  await notifier.flush();
  assert.equal(env.sent.length, 2);
  assert.equal(env.sent[1]!.title, "Needs you: Fix the cart");
});
