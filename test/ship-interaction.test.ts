import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { JsonValue } from "@get-bb/plugin-sdk";
import { createShipInteractions, parseShipSnapshot, shipSnapshotScript, type ShipSnapshot } from "../src/ship-interaction.ts";
import type { Task } from "../src/store.ts";
import { makeService } from "./fakes.ts";
import { registerShipRpc } from "../src/rpc.ts";
import type { Runtime } from "../src/runtime.ts";

function fixture() {
  const { bb, harness } = createFakePluginHost({ pluginId: "boat" });
  let task = {
    id: "t_ship", title: "Cart drawer", status: "idle", turns: 1, promptId: "p_1", finishedAt: "2026-11-07T00:00:00Z",
    threadId: "thr_task", orchestratorThreadId: "thr_parent", sandboxId: "bx_fake", role: "implement", delivery: "push",
    repoPath: "/fake/cart", repo: "demo/cart", baseBranch: "main", branch: "boat/cart", extraRepos: [], shipApproval: null,
  } as unknown as Task;
  let snapshots: ShipSnapshot[] = [{ head: "1".repeat(40), base: "2".repeat(40), branch: "boat/cart", commits: 6 }];
  let review: string | null = "Review t_review: approve";
  const events: { kind: string; text: string }[] = [];
  const reports: string[] = [];
  let shipped = 0;
  let snapshotCalls = 0;
  let beforeGuard: (() => void) | null = null;
  let snapshotWait: Promise<void> | null = null;
  const controller = createShipInteractions({
    getTask: () => task,
    latestReview: () => review,
    snapshot: async () => { snapshotCalls++; if (snapshotWait) await snapshotWait; return structuredClone(snapshots); },
    requestInput: (request, options) => bb.ui.requestInput(request, options),
    ship: async (_id, options) => { beforeGuard?.(); await options.beforeShip(task, [{ path: task.repoPath!, baseBranch: task.baseBranch! }]); shipped++; },
    record: (_id, kind, text) => { events.push({ kind, text }); },
    report: async (_thread, text) => { reports.push(text); },
    changed: () => {},
  });
  return {
    controller, harness, events, reports,
    get task() { return task; }, set task(value: Task) { task = value; },
    get snapshots() { return snapshots; }, set snapshots(value: ShipSnapshot[]) { snapshots = value; },
    set review(value: string | null) { review = value; },
    set beforeGuard(value: (() => void) | null) { beforeGuard = value; },
    set snapshotWait(value: Promise<void> | null) { snapshotWait = value; },
    get shipped() { return shipped; }, get snapshotCalls() { return snapshotCalls; },
    async pending() { await new Promise<void>((resolve) => setImmediate(resolve)); return harness.inspection.pendingInteractions[0]!; },
    async answer(requestId: string, choice: "ship" | "not-yet", note = "") {
      const pending = await this.pending();
      harness.behavior.submitInteraction(pending.id, { requestId, choice, note });
      await controller.settled();
    },
  };
}

test("request returns while checks and form are pending; duplicates reuse the task chat form", async (t) => {
  const f = fixture(); t.after(() => f.harness.lifecycle.dispose());
  let release!: () => void;
  f.snapshotWait = new Promise<void>((resolve) => { release = resolve; });
  const first = f.controller.request({ id: f.task.id, from: "page" });
  assert.equal(first.pending, true);
  assert.equal(first.threadId, "thr_task", "page entry still asks in the task chat");
  assert.deepEqual(f.controller.request({ id: f.task.id }), { ...first, duplicate: true });
  assert.equal(f.shipped, 0);
  release();
  const pending = await f.pending();
  assert.equal(pending.rendererId, "ship-to-main");
  assert.equal(f.harness.inspection.pendingInteractions.length, 1);
  const payload = pending.payload as { checks: { text: string }[]; commits: number };
  assert.equal(payload.commits, 6);
  assert.ok(payload.checks.some((row) => row.text === "Tests not independently checked"));
  f.harness.behavior.cancelInteraction(pending.id);
  await f.controller.settled();
  assert.equal(f.shipped, 0);
  assert.equal(f.events.at(-1)?.kind, "ship-cancelled");
});

test("Not yet with an approval-sounding note never ships and permits a fresh request", async (t) => {
  const f = fixture(); t.after(() => f.harness.lifecycle.dispose());
  const first = f.controller.request({ id: f.task.id });
  await f.answer(first.requestId, "not-yet", "Ship it, approved");
  assert.equal(f.shipped, 0);
  assert.match(f.events.at(-1)!.text, /Ship it, approved/);
  const next = f.controller.request({ id: f.task.id });
  assert.notEqual(next.requestId, first.requestId);
  f.harness.behavior.cancelInteraction((await f.pending()).id);
  await f.controller.settled();
});

test("an explicit matching Ship choice runs the existing guarded shipping path once", async (t) => {
  const f = fixture(); t.after(() => f.harness.lifecycle.dispose());
  const request = f.controller.request({ id: f.task.id, keepOpen: true });
  await f.answer(request.requestId, "ship", "Looks good");
  assert.equal(f.shipped, 1);
  assert.equal(f.snapshotCalls, 2, "checks again inside the service claim");
  assert.equal(f.events.at(-1)?.kind, "ship-note");
});

test("a note alone and a reply for an older form never grant approval", async (t) => {
  for (const value of [{ note: "Ship to main" }, { requestId: "old-form", choice: "ship", note: "" }] as JsonValue[]) {
    const f = fixture(); t.after(() => f.harness.lifecycle.dispose());
    f.controller.request({ id: f.task.id });
    f.harness.behavior.submitInteraction((await f.pending()).id, value);
    await f.controller.settled();
    assert.equal(f.shipped, 0);
    assert.equal(f.events.at(-1)?.kind, "ship-request-failed");
  }
});

test("new work while waiting invalidates approval, even when a later turn is idle", async (t) => {
  const f = fixture(); t.after(() => f.harness.lifecycle.dispose());
  const request = f.controller.request({ id: f.task.id });
  await f.pending();
  f.task = { ...f.task, turns: 2, promptId: "p_2" };
  await f.answer(request.requestId, "ship");
  assert.equal(f.shipped, 0);
  assert.match(f.reports[0], /work changed/);
});

test("new commits, turns and review changes under the ship claim cannot ship", async (t) => {
  for (const mutation of ["head", "turn", "review"]) {
    const f = fixture(); t.after(() => f.harness.lifecycle.dispose());
    const request = f.controller.request({ id: f.task.id });
    await f.pending();
    f.beforeGuard = () => {
      if (mutation === "head") f.snapshots = [{ ...f.snapshots[0], head: "3".repeat(40) }];
      else if (mutation === "turn") f.task = { ...f.task, turns: 2 };
      else f.review = "Review t_new: changes-requested";
    };
    await f.answer(request.requestId, "ship");
    assert.equal(f.shipped, 0, mutation);
    assert.match(f.events.at(-1)!.text, /work changed/, mutation);
  }
});

test("disposal cancels a pending form and never ships", async (t) => {
  const f = fixture(); t.after(() => f.harness.lifecycle.dispose());
  f.controller.request({ id: f.task.id });
  await f.pending();
  f.controller.dispose();
  await f.controller.settled();
  assert.equal(f.shipped, 0);
  assert.equal(f.harness.inspection.pendingInteractions.length, 0);
});

test("fallback chat, absent chat, closed task and shared sandbox requests are handled", async (t) => {
  const f = fixture(); t.after(() => f.harness.lifecycle.dispose());
  f.task = { ...f.task, threadId: null };
  assert.equal(f.controller.request({ id: f.task.id }).threadId, "thr_parent");
  const original = f.task;
  f.task = { ...f.task, id: "t_other" };
  assert.throws(() => f.controller.request({ id: "t_other" }), /Another shipping confirmation/);
  f.task = original;
  f.harness.behavior.cancelInteraction((await f.pending()).id);
  await f.controller.settled();
  f.task = { ...f.task, orchestratorThreadId: null };
  assert.throws(() => f.controller.request({ id: f.task.id }), /Open a task chat/);
  f.task = { ...f.task, status: "done" };
  assert.throws(() => f.controller.request({ id: f.task.id }), /Wait for the task/);
});

test("snapshot script is read-only, requires a clean tree, and parses each repository", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "boat-ship-snapshot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
  git("init", "--quiet", "--initial-branch=work");
  writeFileSync(join(dir, "cart.txt"), "base\n");
  git("add", "."); git("-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", "commit", "--quiet", "-m", "Base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(dir, "cart.txt"), "new\n");
  git("add", "."); git("-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", "commit", "--quiet", "-m", "Change");
  const script = shipSnapshotScript([{ path: dir, baseBranch: "main" }]);
  const run = () => spawnSync("bash", ["-c", script], { encoding: "utf8" });
  const before = git("rev-parse", "HEAD");
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const snapshots = parseShipSnapshot(result.stdout, 1);
  assert.equal(snapshots[0].head, before);
  assert.equal(snapshots[0].commits, 1);
  assert.equal(git("rev-parse", "HEAD"), before);
  writeFileSync(join(dir, "new.txt"), "untracked\n");
  assert.equal(run().status, 3, "untracked work cannot be silently approved");
  assert.throws(() => parseShipSnapshot("", 1), /Couldn't check/);
  assert.throws(() => parseShipSnapshot(result.stdout, 2), /Couldn't check/);
});

test("requestShip RPC returns before a user answer and cancellation never calls BoatApi.ship", async (t) => {
  const env = makeService();
  const { bb, harness } = createFakePluginHost({ pluginId: "boat" });
  t.after(() => harness.lifecycle.dispose());
  const { task } = await env.service.launchTask({ title: "Cart", role: "implement", brief: "Do it.", repo: "demo/cart", orchestratorThreadId: "thr_demo" }, 5_000);
  env.boat.finish(task.conversationId!, "Done.");
  await env.service.sweep();
  env.store.update(task.id, { delivery: "push", status: "idle", turns: 1 });
  env.boat.execResult = () => ({ exitCode: 0, stdout: `BOAT_SHIP_SNAPSHOT 0 ${"1".repeat(40)} ${"2".repeat(40)} work 1\n`, stderr: "" });
  registerShipRpc({ bb, service: env.service, changed() {}, tellOrchestrator: async () => {} } as unknown as Runtime);
  const result = await harness.behavior.callRpc("requestShip", { id: task.id }) as { pending: boolean };
  assert.equal(result.pending, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.inspection.pendingInteractions.length, 1);
  harness.behavior.cancelInteraction(harness.inspection.pendingInteractions[0].id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(env.store.latestEvent(task.id, "shipped"), null);
  assert.equal(env.boat.ships.length, 0);
});

test("real service integration rejects changed commits at its beforeShip boundary", async (t) => {
  const env = makeService();
  const { bb, harness } = createFakePluginHost({ pluginId: "boat" });
  t.after(() => harness.lifecycle.dispose());
  const { task } = await env.service.launchTask({ title: "Cart", role: "implement", brief: "Do it.", repo: "demo/cart", orchestratorThreadId: "thr_demo" }, 5_000);
  env.boat.finish(task.conversationId!, "Done.");
  await env.service.sweep();
  env.store.update(task.id, { delivery: "push", status: "idle", turns: 1 });
  let head = "1".repeat(40);
  env.boat.execResult = () => ({ exitCode: 0, stdout: `BOAT_SHIP_SNAPSHOT 0 ${head} ${"2".repeat(40)} work 1\n`, stderr: "" });
  registerShipRpc({ bb, service: env.service, changed() {}, tellOrchestrator: async () => {} } as unknown as Runtime);
  const request = await harness.behavior.callRpc("requestShip", { id: task.id, keepOpen: true }) as { requestId: string };
  await new Promise<void>((resolve) => setImmediate(resolve));
  head = "3".repeat(40);
  harness.behavior.submitInteraction(harness.inspection.pendingInteractions[0].id, { requestId: request.requestId, choice: "ship", note: "" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(env.boat.ships.length, 0, "service does not reach BoatApi.ship");
  assert.match(env.store.latestEvent(task.id, "ship-request-failed")?.text ?? "", /work changed/);
});
