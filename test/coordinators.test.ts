import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeActivity, nativeCoordinators, type CoordinationThread } from "../web/coordinators-logic.ts";

function thread(id: string, parentThreadId: string | null = null, patch: Partial<CoordinationThread> = {}): CoordinationThread {
  return { id, parentThreadId, displayTitle: id, projectId: "project", providerId: "codex", status: "idle", runtimeStatus: "idle", queuedWork: "none", hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, goals: 0, planMode: 0 }, isHidden: false, isArchived: false, createdAt: 1, ...patch };
}
const none = new Set<string>();

test("a manually created coordinator is discovered without Boat registration or a title convention", () => {
  const input = [thread("strategy", null, { displayTitle: "Research strategy" }), thread("scan", "strategy", { runtimeStatus: "active", status: "active" })];
  const original = structuredClone(input);
  const groups = nativeCoordinators(input, none, none);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].thread.id, "strategy");
  assert.deepEqual(groups[0].children.map(t => t.id), ["scan"]);
  assert.equal(groups[0].counts.working, 1);
  assert.deepEqual(input, original, "discovery never changes thread state or instructions");
});

test("nested native delegation is shown once under its visible coordinator", () => {
  const groups = nativeCoordinators([thread("root"), thread("research", "root"), thread("a", "research"), thread("b", "research"), thread("other")], none, none);
  assert.deepEqual(groups.map(g => g.thread.id), ["root"]);
  assert.deepEqual(groups[0].children.map(t => t.id), ["research", "a", "b"]);
  assert.equal(groups[0].counts.idle, 3, "idle native chats are not labelled ready");
});

test("standalone chats and coordinators with only archived or hidden children stay out", () => {
  assert.deepEqual(nativeCoordinators([thread("root"), thread("closed", "root", { isArchived: true }), thread("helper", "root", { isHidden: true }), thread("alone")], none, none), []);
  assert.deepEqual(nativeCoordinators([thread("root", null, { isArchived: true }), thread("child", "root")], none, none), []);
});

test("Boat workers and their native subchats are not rediscovered as native task groups", () => {
  const groups = nativeCoordinators([thread("operator"), thread("boat-worker", "operator"), thread("tool-helper", "boat-worker"), thread("research", "operator")], new Set(["boat-worker"]), new Set(["operator"]));
  assert.deepEqual(groups.map(g => [g.thread.id, g.children.map(t => t.id)]), [["operator", ["research"]]]);
  assert.deepEqual(nativeCoordinators([thread("operator"), thread("boat-worker", "operator")], new Set(["boat-worker"]), new Set(["operator"])), []);
});

test("a registered orchestrator inside a native hierarchy remains its own boundary", () => {
  const groups = nativeCoordinators([thread("native-root"), thread("registered", "native-root"), thread("child", "registered")], none, new Set(["registered"]));
  assert.deepEqual(groups.map(g => [g.thread.id, g.children.map(t => t.id)]), [["registered", ["child"]]]);
});

test("archiving and activity changes update the overview from the current public state", () => {
  const root = thread("root");
  const active = thread("child", "root", { status: "active", runtimeStatus: "active" });
  assert.equal(nativeCoordinators([root, active], none, none)[0].counts.working, 1);
  assert.equal(nativeCoordinators([root, { ...active, status: "idle", runtimeStatus: "idle" }], none, none)[0].counts.working, 0);
  assert.deepEqual(nativeCoordinators([root, { ...active, isArchived: true }], none, none), []);
});

test("native attention uses actual input requests; unread and idle do not imply a decision or approval", () => {
  assert.equal(nativeActivity(thread("idle")), "idle");
  assert.equal(nativeActivity(thread("input", null, { hasPendingInteraction: true, status: "active", runtimeStatus: "active" })), "needs-you");
  assert.equal(nativeActivity(thread("error", null, { status: "error", runtimeStatus: "error" })), "error");
  assert.equal(nativeActivity(thread("queued-error", null, { queuedWork: "failed" })), "error");
});

test("runtime waits, queued work and live background work retain distinct native states", () => {
  for (const runtimeStatus of ["pending", "waiting-for-host"] as const) assert.equal(nativeActivity(thread("wait", null, { runtimeStatus })), "waiting");
  assert.equal(nativeActivity(thread("queue", null, { queuedWork: "waiting" })), "waiting");
  for (const runtimeStatus of ["starting", "active", "stopping", "provisioning"] as const) assert.equal(nativeActivity(thread("busy", null, { runtimeStatus })), "working");
  const background = thread("background"); background.activity.backgroundAgents = 1;
  assert.equal(nativeActivity(background), "working");
  assert.equal(nativeActivity(thread("stopped")), "idle", "a manually stopped thread without live work stays quiet");
});

test("cycles and duplicate input cannot duplicate descendants or hang discovery", () => {
  const child = thread("child", "root");
  const groups = nativeCoordinators([thread("root"), child, child, thread("a", "b"), thread("b", "a")], none, none);
  assert.deepEqual(groups.map(g => [g.thread.id, g.children.map(t => t.id)]), [["root", ["child"]]]);
});
