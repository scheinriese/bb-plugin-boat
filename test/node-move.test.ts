// Moving a sandbox off a boat.dev node that keeps failing its disk: when, whether on its own, and what the user is told.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lastCompletedSnapshot } from "../src/boat-api.ts";
import {
  STUCK_AFTER_MS,
  brokenSnapshotQuestion,
  forkCheck,
  gitStateScript,
  moveDecision,
  moveQuestion,
  parseGitState,
  parseHydratorFailure,
  stuckOnNode,
  trackHydrator,
  type MoveTaskFacts,
} from "../src/node-move.ts";
import { FakeBoat } from "./fakes.ts";

const LINE = "HYDRATOR FAILED attempt 77 (mount stays up, on-demand serving continues, retrying …): decode/feed: chunk 1 GET 0000.tar.zst: status code 503";

test("lazyfs's failure line: its attempt count and the object it fails", () => {
  assert.deepEqual(parseHydratorFailure(LINE), { attempt: 77, object: "chunk 1 GET 0000.tar.zst" });
  assert.deepEqual(parseHydratorFailure("HYDRATOR FAILED: status code 503"), { attempt: null, object: null });
  assert.equal(parseHydratorFailure("~/.profile: Input/output error"), null);
  assert.equal(parseHydratorFailure(null), null);
});

test("stuck on its node: the same object failing for more than 15 minutes, or 5 attempts or more", () => {
  const t0 = Date.parse("2026-11-19T00:00:00Z");
  const early = trackHydrator(null, { attempt: 2, object: "chunk 1 GET 0000.tar.zst" }, t0);
  assert.equal(stuckOnNode(early, t0), false);
  const later = trackHydrator(early, { attempt: 3, object: "chunk 1 GET 0000.tar.zst" }, t0 + 10 * 60_000);
  assert.equal(later.firstAt, t0);
  assert.equal(stuckOnNode(later, t0 + 10 * 60_000), false);
  assert.equal(stuckOnNode(later, t0 + STUCK_AFTER_MS + 1), true, "the same failure for more than 15 minutes");
  // lazyfs had already tried it 77 times: stuck at the first look.
  assert.equal(stuckOnNode(trackHydrator(null, parseHydratorFailure(LINE)!, t0), t0), true);
  // Another object: a new episode (the node got past the first).
  const other = trackHydrator(later, { attempt: 1, object: "chunk 2 GET 0001.tar.zst" }, t0 + 12 * 60_000);
  assert.deepEqual(other, { object: "chunk 2 GET 0001.tar.zst", firstAt: t0 + 12 * 60_000, attempts: 1, seen: 1 });
  assert.equal(stuckOnNode(other, t0 + 20 * 60_000), false);
  // No counter in the line: 5 of Boat's own looks count the same.
  let track = trackHydrator(null, { attempt: null, object: null }, t0);
  for (let look = 1; look < 5; look++) track = trackHydrator(track, { attempt: null, object: null }, t0 + look * 60_000);
  assert.equal(stuckOnNode(track, t0 + 5 * 60_000), true);
  assert.equal(stuckOnNode(null, t0), false);
});

const facts = (overrides: Partial<MoveTaskFacts> = {}): MoveTaskFacts => ({ id: "t_1", title: "Cart spacing", status: "idle", unpushed: 0, dirty: false, unshipped: null, ...overrides });

test("on its own only when nothing unsaved could be lost; else the reasons", () => {
  // An orchestrator's or a plain bb machine's sandbox: no Boat task there.
  assert.deepEqual(moveDecision([]), { auto: true, reasons: [] });
  assert.deepEqual(moveDecision([facts()]), { auto: true, reasons: [] });
  assert.deepEqual(moveDecision([facts({ status: "running" })]).reasons, ["task t_1 is mid-turn"]);
  assert.deepEqual(moveDecision([facts({ status: "starting" })]).auto, false);
  assert.deepEqual(moveDecision([facts({ unpushed: 2 })]).reasons, ["task t_1 has 2 unpushed commits"]);
  assert.deepEqual(moveDecision([facts({ dirty: true })]).reasons, ["task t_1 has changes that aren't committed"]);
  assert.deepEqual(moveDecision([facts({ unpushed: null, dirty: null })]).reasons, ["Boat couldn't check task t_1's branch"]);
  assert.deepEqual(moveDecision([facts({ unshipped: 1 })]).reasons, ["task t_1 has 1 commit not shipped yet"]);
  const two = moveDecision([facts(), facts({ id: "t_2", status: "running", unpushed: 1 })]);
  assert.equal(two.auto, false);
  assert.deepEqual(two.reasons, ["task t_2 is mid-turn", "task t_2 has 1 unpushed commit"]);
});

test("the branch check, run here with git on a throwaway repo: unpushed commits and uncommitted changes, no network", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "boat-move-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  git(dir, "init", "--bare", "-q", origin);
  git(dir, "clone", "-q", origin, work);
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-q", "-m", "one");
  git(work, "push", "-q", "origin", "HEAD:main");
  const state = (path: string) => parseGitState(execFileSync("bash", ["-c", gitStateScript(path)], { encoding: "utf8" }));
  assert.deepEqual(state(work), { unpushed: 0, dirty: false });
  writeFileSync(join(work, "a.txt"), "two\n");
  assert.deepEqual(state(work), { unpushed: 0, dirty: true });
  git(work, "commit", "-q", "-am", "two");
  git(work, "checkout", "-q", "-b", "boat/t_1");
  writeFileSync(join(work, "b.txt"), "three\n");
  git(work, "add", "b.txt");
  git(work, "commit", "-q", "-m", "three");
  assert.deepEqual(state(work), { unpushed: 2, dirty: false });
  git(work, "push", "-q", "origin", "boat/t_1");
  assert.deepEqual(state(work), { unpushed: 0, dirty: false }, "pushed to its branch: nothing to lose");
  assert.equal(state(join(dir, "missing")), "none");
  assert.equal(parseGitState("bash: git: Input/output error"), null);
  // A path with a quote stays one argument.
  assert.match(gitStateScript("/home/user/work/it's"), /^cd '\/home\/user\/work\/it'\\''s'/);
});

test("Needs you says the exact commands, what would be lost, and why Boat didn't do it", () => {
  const now = Date.parse("2026-11-19T02:00:00Z");
  const asked = moveQuestion({ sandboxId: "bx_demo1", snapshotAt: "2026-11-19T00:41:00.000Z", reasons: ["task t_1 has 2 unpushed commits"], detail: LINE, fork: "healthy", now });
  assert.equal(asked.question, "Sandbox bx_demo1 is stuck on a boat.dev node that keeps failing its disk. Move it to a new node? That loses what changed there since 00:41 UTC (its last completed snapshot).");
  assert.equal(asked.recommendation, "Move it if nothing written since then matters: run `boat stop bx_demo1 --force`, then `bb boat sandbox resume bx_demo1`. Boat didn't do it itself because task t_1 has 2 unpushed commits. Otherwise wait for boat.dev to recover.");
  assert.equal(asked.context, `boat.dev said: ${LINE}. A test fork from the same snapshot restored fine on another node.`);
  assert.deepEqual(asked.options, ["Move it now", "Wait for boat.dev"]);
  assert.match(moveQuestion({ sandboxId: "bx_demo1", snapshotAt: null, reasons: ["task t_1 is mid-turn"], detail: null, fork: "unknown", now }).question, /since its last completed snapshot \(boat didn't say when\)\.$/);
  const broken = brokenSnapshotQuestion({ sandboxId: "bx_demo1", detail: LINE });
  assert.match(broken.question, /doesn't restore, on its node or on a new one/);
  assert.match(broken.recommendation, /Don't force-stop it/);
});

test("the test fork: never snapshotted, 10 minutes at most, read, then deleted whatever it found", async () => {
  const boat = new FakeBoat();
  const source = boat.addSandbox("bx_src", "default", "idle");
  let forkSays = "BOAT_DISK ok .profile\nBOAT_DISK ok .bashrc\nBOAT_DISK_END\n";
  boat.execResult = () => ({ exitCode: 0, stdout: forkSays, stderr: "" });
  assert.equal(await forkCheck(boat as never, source.id), "healthy");
  assert.deepEqual(boat.forks.map((fork) => ({ noSnapshots: fork.noSnapshots, ttlSeconds: fork.ttlSeconds })), [{ noSnapshots: true, ttlSeconds: 600 }]);
  assert.ok(boat.calls.includes(`delete ${boat.forks[0]!.id}`));
  assert.equal(boat.execs.at(-1)!.sandboxId, boat.forks[0]!.id, "the read check runs on the fork");
  forkSays = `BOAT_HYDRATOR ${LINE}\nBOAT_DISK fail .profile Input/output error\nBOAT_DISK_END\n`;
  assert.equal(await forkCheck(boat as never, source.id), "unreadable");
  assert.ok(boat.calls.includes(`delete ${boat.forks[1]!.id}`));
  boat.forkError = Object.assign(new Error("All 2 sandboxes your limit allows are in use"), { forkId: null });
  assert.equal(await forkCheck(boat as never, source.id), "unknown");
  assert.equal(boat.sandboxes.size, 1, "no fork left behind");
});

test("the last completed snapshot from boat snapshots <id>, whatever list it comes in", () => {
  assert.equal(lastCompletedSnapshot([{ snapshots: [
    { id: "s1", status: "completed", completedAt: "2026-11-19T00:41:00Z" },
    { id: "s2", status: "failed", completedAt: "2026-11-19T01:30:00Z" },
    { id: "s3", status: "pending", createdAt: "2026-11-19T01:40:00Z" },
    { id: "s0", status: "completed", completedAt: "2026-11-18T22:00:00Z" },
  ] }]), "2026-11-19T00:41:00.000Z");
  assert.equal(lastCompletedSnapshot([{ id: "s1", createdAt: "2026-11-19T00:41:00Z" }, { id: "s2", createdAt: "2026-11-19T00:12:00Z" }]), "2026-11-19T00:41:00.000Z");
  assert.equal(lastCompletedSnapshot([{ items: [] }]), null);
});
