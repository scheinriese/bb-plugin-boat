import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { makeService } from "./fakes.ts";
import { strictTeamSpawn } from "./team-spawn.ts";
import { createTeamRuntime } from "../src/team/runtime.ts";
import type { Runtime } from "../src/runtime.ts";
import { TeamEngine } from "../src/team/engine.ts";
import { createTeamMirror } from "../src/team/mirror.ts";
import type { Receipt } from "../contract-team.ts";

async function setup(t: { after(fn: () => unknown): void }) {
  const env = makeService();
  const { bb, harness } = createFakePluginHost({ pluginId: "boat" });
  t.after(() => harness.lifecycle.dispose());
  const threads = new Map([
    [
      "chief",
      {
        id: "chief",
        projectId: "proj_personal",
        archivedAt: null as number | null,
      },
    ],
    [
      "old-lead",
      {
        id: "old-lead",
        projectId: "proj_web",
        archivedAt: null as number | null,
      },
    ],
    [
      "new-lead",
      {
        id: "new-lead",
        projectId: "proj_web",
        archivedAt: null as number | null,
      },
    ],
    [
      "adopted",
      {
        id: "adopted",
        projectId: "proj_design",
        archivedAt: null as number | null,
      },
    ],
  ]);
  const failing = new Set<string>();
  const sent: { threadId: string; input: { text: string }[] }[] = [];
  harness.sdk.stub("system.uiPreferences.list", async () => ({
    preferences: {},
  }));
  harness.sdk.stub(
    "threads.spawn",
    strictTeamSpawn(async () => ({ thread: threads.get("chief") })),
  );
  harness.sdk.stub("threads.get", async ({ threadId }) => {
    if (failing.has(threadId)) throw new Error("Temporary connection failure");
    if (!threads.has(threadId)) throw new Error("HTTP 404: not found");
    return threads.get(threadId)!;
  });
  harness.sdk.stub("threads.send", async (args) => {
    sent.push(args as never);
    return { delivery: "sent" };
  });
  const runtime = {
    bb,
    service: env.service,
    changed() {},
  } as unknown as Runtime;
  const team = createTeamRuntime(runtime);
  runtime.team = team;
  await harness.behavior.callRpc("teamSave", { enabled: true });
  env.store.addOrchestrator("old-lead", { id: "web", name: "Web" });
  await team.prepare();
  const member = () =>
    team.engine.store
      .list("member")
      .find((m) => m.homeThreadId === "old-lead")!;
  const assign = (title = "Check checkout") =>
    team.engine.assign(
      {
        assignee: member().id,
        mode: "work",
        title,
        brief: title,
        doneWhen: "Tests pass",
        parentId: null,
        dedupeKey: null,
        wallHours: 12,
      },
      "user",
      "chief",
    );
  return {
    ...env,
    harness,
    team,
    runtime,
    threads,
    failing,
    sent,
    member,
    assign,
  };
}

test("pause survives lookup failure, recovery and native archival; pending work waits for explicit resume", async (t) => {
  const e = await setup(t);
  const a = e.assign();
  e.team.engine.saveMember(e.member(), { status: "paused" });
  // Existing installs have paused records without the new additive fields.
  e.store.team
    .db()
    .prepare(
      "UPDATE team_records SET body=json_remove(body,'$.pauseRequested','$.availability') WHERE kind='member' AND id=?",
    )
    .run(e.member().id);
  e.failing.add("old-lead");
  await e.team.prepare();
  await e.team.flush();
  assert.equal(e.sent.length, 0, "lookup failure must not bypass the pause");
  assert.equal(e.member().status, "paused");
  // Reload engine/mirror state against the same persisted ledger, without caches.
  const loaded = new TeamEngine(e.store.team, () => {});
  const loadedMirror = createTeamMirror(e.runtime, loaded);
  await loadedMirror.sync(loaded.chief()!, loaded.store.list("member"));
  assert.equal(loaded.store.get("member", e.member().id).pauseRequested, true);
  e.failing.clear();
  await loadedMirror.sync(loaded.chief()!, loaded.store.list("member"));
  assert.equal(loaded.store.get("member", e.member().id).status, "paused");
  await e.team.settle();
  assert.equal(
    e.member().status,
    "paused",
    "lookup recovery is not user resume",
  );
  assert.equal(e.sent.length, 0);
  e.threads.get("old-lead")!.archivedAt = 1;
  await e.team.settle();
  assert.equal(e.sent.length, 0);
  e.threads.get("old-lead")!.archivedAt = null;
  await e.team.settle();
  assert.equal(
    e.member().status,
    "paused",
    "unarchive must retain explicit pause",
  );
  const receipt = e.team.engine.store
    .list("receipt")
    .find((r) => r.assignmentId === a.id)!;
  assert.equal(
    e.team.dispatch(
      makeMessageDispatchHookContext({
        thread: makeThreadResponse({ id: "old-lead" }),
        initiator: "agent",
        input: { text: receipt.text, blocks: [] },
      }),
    ).action,
    "wait",
  );
  await e.harness.behavior.callRpc("resumeTeamMember", {
    memberId: e.member().id,
  });
  await e.team.settle();
  await e.team.settle();
  assert.deepEqual(
    e.sent.map((r) => r.threadId),
    ["old-lead"],
  );
});

test("unknown active recipients hold pending work, including after explicit resume while still offline", async (t) => {
  const e = await setup(t);
  e.assign();
  e.failing.add("old-lead");
  await e.team.settle();
  assert.equal(e.sent.length, 0);
  e.team.engine.saveMember(e.member(), { status: "paused" });
  await e.harness.behavior.callRpc("resumeTeamMember", {
    memberId: e.member().id,
  });
  await e.team.flush();
  assert.equal(e.sent.length, 0);
  e.failing.clear();
  await e.team.settle();
  assert.equal(e.sent.length, 1);
});

test("lead replacement reconciles only pending receipts with the assignment, including repair of a prior partial migration", async (t) => {
  const e = await setup(t);
  const a = e.assign();
  const pending = e.team.engine.store.list("receipt")[0];
  const historical: Receipt[] = [
    "accepted",
    "uncertain",
    "sending",
    "failed",
  ].map((state, i) => ({
    ...pending,
    id: `r_history${i}`,
    nonce: `n_history${i}`,
    state: state as Receipt["state"],
  }));
  for (const receipt of historical) e.team.engine.store.put("receipt", receipt);
  e.store.addOrchestrator("new-lead", { id: "web", name: "Web" });
  e.store.team
    .db()
    .prepare(
      "UPDATE orchestrators SET created_at='2099-01-01T00:00:00Z' WHERE thread_id='new-lead'",
    )
    .run();
  await e.team.prepare();
  const current = e.team.engine.store.get("assignment", a.id);
  assert.equal(current.threadId, "new-lead");
  assert.deepEqual(e.team.engine.store.get("receipt", pending.id), {
    ...pending,
    threadId: "new-lead",
    updatedAt: e.team.engine.store.get("receipt", pending.id).updatedAt,
  });
  for (const receipt of historical)
    assert.deepEqual(e.team.engine.store.get("receipt", receipt.id), receipt);
  // Simulate a record stranded by the previous version after assignment migration.
  e.team.engine.store.put("receipt", { ...pending, threadId: "old-lead" }, 0);
  await e.team.prepare();
  assert.equal(
    e.team.engine.store.get("receipt", pending.id).threadId,
    "new-lead",
  );
  await Promise.all([e.team.flush(), e.team.flush()]);
  await e.team.settle();
  assert.deepEqual(
    e.sent.map((r) => r.threadId),
    ["new-lead"],
  );
  assert.ok(e.sent[0].input[0].text.includes(pending.nonce));
  assert.equal(
    e.team.engine.store.get("assignment", a.id).assignee,
    current.assignee,
  );
});

test("adopting a chief chat persists its actual project, refreshes moves, and rejects archived/invalid adoption before mutation", async (t) => {
  const e = await setup(t);
  await e.harness.behavior.callRpc("teamSave", {
    enabled: true,
    homeThreadId: "adopted",
  });
  assert.equal(e.team.engine.chief()?.projectId, "proj_design");
  assert.equal(e.team.engine.sidebar()?.lead?.bbProjectId, "proj_design");
  e.threads.get("adopted")!.projectId = "proj_design_moved";
  await e.team.prepare();
  assert.equal(e.team.engine.sidebar()?.lead?.bbProjectId, "proj_design_moved");
  const before = e.team.engine.chief();
  e.threads.get("new-lead")!.archivedAt = 1;
  await assert.rejects(
    () =>
      e.harness.behavior.callRpc("teamSave", {
        enabled: true,
        homeThreadId: "new-lead",
        name: "Renamed",
      }),
    /archived|available/i,
  );
  e.threads.get("new-lead")!.archivedAt = null;
  e.threads.get("new-lead")!.projectId = "personal";
  await assert.rejects(
    () =>
      e.harness.behavior.callRpc("teamSave", {
        enabled: true,
        homeThreadId: "new-lead",
      }),
    /project/i,
  );
  assert.deepEqual(e.team.engine.chief(), before);
  // Compatibility: a generated home still starts in canonical Personal.
  await e.harness.behavior.callRpc("teamSave", {
    enabled: true,
    homeThreadId: "chief",
  });
  assert.equal(e.team.engine.sidebar()?.lead?.bbProjectId, "proj_personal");
});

test("assignment and pending receipt migration roll back together and retry once", async (t) => {
  const e = await setup(t);
  const a = e.assign();
  const receipt = e.team.engine.store.list("receipt")[0];
  e.store.addOrchestrator("new-lead", { id: "web", name: "Web" });
  e.store.team
    .db()
    .prepare(
      "UPDATE orchestrators SET created_at='2099-01-01T00:00:00Z' WHERE thread_id='new-lead'",
    )
    .run();
  const put = e.team.engine.store.put.bind(e.team.engine.store);
  e.team.engine.store.put = (kind, record, expected) => {
    if (
      kind === "receipt" &&
      "threadId" in record &&
      record.threadId === "new-lead"
    )
      throw new Error("Interrupted outbox migration");
    return put(kind, record, expected);
  };
  await e.team.prepare();
  assert.deepEqual(e.team.engine.store.get("assignment", a.id), a);
  assert.deepEqual(e.team.engine.store.get("receipt", receipt.id), receipt);
  assert.equal(e.sent.length, 0);
  e.team.engine.store.put = put;
  await e.team.prepare();
  await e.team.flush();
  await e.team.settle();
  assert.equal(
    e.team.engine.store.get("assignment", a.id).threadId,
    "new-lead",
  );
  assert.equal(
    e.team.engine.store.get("receipt", receipt.id).nonce,
    receipt.nonce,
  );
  assert.deepEqual(
    e.sent.map((r) => r.threadId),
    ["new-lead"],
  );
});

test("a pause applied while native verification is in flight prevents the send claim", async (t) => {
  const e = await setup(t);
  e.assign();
  let checked!: () => void, release!: () => void;
  const verifying = new Promise<void>((resolve) => {
    checked = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lookups = 0;
  e.harness.sdk.stub("threads.get", async ({ threadId }) => {
    const response = { ...e.threads.get(threadId)! };
    if (threadId === "old-lead" && ++lookups === 2) {
      checked();
      await held;
    }
    return response;
  });
  const flushing = e.team.flush();
  await verifying;
  e.team.engine.saveMember(e.member(), { status: "paused" });
  release();
  await flushing;
  assert.equal(e.sent.length, 0);
  assert.equal(e.team.engine.store.list("receipt")[0].state, "pending");
  await e.harness.behavior.callRpc("resumeTeamMember", {
    memberId: e.member().id,
  });
  await e.team.flush();
  assert.equal(e.sent.length, 1);
});

test("a recipient migrated while native verification is in flight is sent only to the new lead", async (t) => {
  const e = await setup(t);
  e.assign();
  let checked!: () => void, release!: () => void;
  const verifying = new Promise<void>((resolve) => {
    checked = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lookups = 0;
  e.harness.sdk.stub("threads.get", async ({ threadId }) => {
    const response = { ...e.threads.get(threadId)! };
    if (threadId === "old-lead" && ++lookups === 2) {
      checked();
      await held;
    }
    return response;
  });
  const flushing = e.team.flush();
  await verifying;
  e.store.addOrchestrator("new-lead", { id: "web", name: "Web" });
  e.store.team
    .db()
    .prepare(
      "UPDATE orchestrators SET created_at='2099-01-01T00:00:00Z' WHERE thread_id='new-lead'",
    )
    .run();
  await e.team.prepare();
  release();
  await flushing;
  assert.equal(e.sent.length, 0);
  await e.team.flush();
  await e.team.flush();
  assert.deepEqual(
    e.sent.map((r) => r.threadId),
    ["new-lead"],
  );
});
