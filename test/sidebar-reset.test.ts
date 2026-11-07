import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readPausedResets, resetWaitText } from "../src/sidebar-reset.ts";
import { sidebarState } from "../src/sidebar.ts";
import { makeService } from "./fakes.ts";
test("reset clock uses JS timezone offset sign, with no inferred quota timestamp", () => {
  const at = Date.parse("2026-11-08T15:00:00Z");
  assert.equal(resetWaitText(at, -60), "Waits for reset · 4:00 pm");
  assert.equal(resetWaitText(at, 0), "Waits for reset · 3:00 pm");
});
test("only a live scheduled provider subscription retry on an idle/error thread supplies a reset", async () => {
  const now = Date.now();
  const base = {
    threadId: "thr_ok",
    originPluginId: "provider-retry",
    payload: { kind: "retry", reason: "Rate limited" },
    state: "scheduled",
    sendAt: now + 60000,
    updatedAt: now,
  };
  const rows = [
    base,
    { ...base, threadId: "thr_busy" },
    { ...base, threadId: "thr_old", sendAt: now - 1 },
    { ...base, threadId: "thr_other", originPluginId: "another-plugin" },
    {
      ...base,
      threadId: "thr_overload",
      payload: { kind: "retry", reason: "Provider overloaded" },
    },
    { ...base, threadId: "thr_claimed", state: "claimed" },
  ];
  const bb = {
    sdk: {
      threads: {
        queue: { list: async () => rows },
        get: async ({ threadId }: { threadId: string }) => ({
          status: threadId === "thr_busy" ? "active" : "error",
          archivedAt: null,
          deletedAt: null,
        }),
      },
    },
  } as unknown as Pick<BbPluginApi, "sdk">;
  const map = await readPausedResets(bb, now);
  assert.deepEqual([...map.keys()], ["thr_ok"]);
});
test("unknown native state and queue failures remain quiet", async () => {
  const bb = {
    sdk: {
      threads: {
        queue: {
          list: async () => {
            throw new Error("private detail");
          },
        },
      },
    },
  } as unknown as Pick<BbPluginApi, "sdk">;
  assert.equal((await readPausedResets(bb)).size, 0);
});
test("paused line does not override moving work or attention", () => {
  const env = makeService();
  env.service.store.addOrchestrator("thr_paused", null);
  const at = Date.now() + 60000;
  const wait = new Map([["thr_paused", { sendAt: at, updatedAt: Date.now() }]]);
  const state = sidebarState(env.service, wait, 0);
  assert.equal(
    state.threads.find((row) => row.threadId === "thr_paused")!.status,
    "waiting-reset",
  );
  env.service.store.addDecision({
    orchestratorThreadId: "thr_paused",
    question: "Choose",
    recommendation: "A",
    options: ["A"],
    taskIds: [],
  });
  const attention = sidebarState(env.service, wait, 0).threads.find(
    (row) => row.threadId === "thr_paused",
  )!;
  assert.equal(attention.status, "needs-you");
  assert.doesNotMatch(attention.secondLine?.text ?? "", /reset/);
});

test("running task and aggregate preserve movement despite an older pending reset", async () => {
  const env = makeService({ chat: true });
  const task = (
    await env.service.launchTask(
      {
        title: "Fix cart",
        role: "implement",
        brief: "Fix it.",
        repo: "acme/web",
        orchestratorThreadId: "thr_parent",
      },
      5000,
    )
  ).task;
  const at = Date.now() + 60000;
  const wait = new Map([
    [task.threadId!, { sendAt: at, updatedAt: Date.now() }],
    ["thr_parent", { sendAt: at, updatedAt: Date.now() }],
  ]);
  const actual = env.service.publicStatus.bind(env.service);
  env.service.publicStatus = (entry, context) =>
    entry.id === task.id
      ? {
          status: "working",
          label: "Working",
          tone: "neutral",
          reason: null,
          needsYou: false,
          moving: true,
        }
      : actual(entry, context);
  const state = sidebarState(env.service, wait, -60);
  for (const id of [task.threadId, "thr_parent"]) {
    const row = state.threads.find((row) => row.threadId === id)!;
    assert.equal(row.status, "working");
    assert.equal(row.moving, true);
    assert.equal(row.secondLine, null);
  }
});
