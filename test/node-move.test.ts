// Moving a sandbox off a boat.dev node that keeps failing its disk: when, whether on its own, and what the user is told.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lastCompletedSnapshot, stopReport } from "../src/boat-api.ts";
import {
  CHECKOUTS_SCRIPT,
  STUCK_AFTER_MS,
  brokenSnapshotQuestion,
  forcedOutcome,
  forkCheck,
  gitStateScript,
  moveDecision,
  moveQuestion,
  parseCheckouts,
  parseGitState,
  parseHydratorFailure,
  stopOutcome,
  stuckOnNode,
  trackHydrator,
  type MoveFacts,
} from "../src/node-move.ts";
import { FakeBoat } from "./fakes.ts";

const LINE = "HYDRATOR FAILED attempt 77 (mount stays up, on-demand serving continues, retrying …): decode/feed: chunk 1 GET 0000.tar.zst: status code 503";

test("lazyfs's failure line: its attempt count and the object it fails", () => {
  assert.deepEqual(parseHydratorFailure(LINE), { attempt: 77, object: "chunk 1 GET 0000.tar.zst" });
  assert.deepEqual(parseHydratorFailure("HYDRATOR FAILED: status code 503"), { attempt: null, object: null });
  assert.equal(parseHydratorFailure("~/.profile: Input/output error"), null);
  assert.equal(parseHydratorFailure(null), null);
});

test("stuck on its node only from Boat's own looks: the same object at least 3 times, over more than 15 minutes", () => {
  const t0 = Date.parse("2026-11-19T00:00:00Z");
  // lazyfs's own counter doesn't count: "attempt 77" (or the incident's 32) on the first look isn't stuck.
  const first = trackHydrator(null, parseHydratorFailure(LINE)!, t0);
  assert.equal(stuckOnNode(first, t0), false);
  assert.equal(stuckOnNode(trackHydrator(null, { attempt: 32, object: "chunk 1 GET 0000.tar.zst" }, t0), t0 + STUCK_AFTER_MS + 1), false, "one look, however old");
  const second = trackHydrator(first, parseHydratorFailure(LINE)!, t0 + 2 * 60_000);
  const third = trackHydrator(second, parseHydratorFailure(LINE)!, t0 + 6 * 60_000);
  assert.equal(third.seen, 3);
  assert.equal(third.firstAt, t0);
  assert.equal(stuckOnNode(third, t0 + 6 * 60_000), false, "3 looks, but only 6 minutes");
  assert.equal(stuckOnNode(third, t0 + STUCK_AFTER_MS), false, "not more than 15 minutes yet");
  assert.equal(stuckOnNode(third, t0 + STUCK_AFTER_MS + 1), true);
  // Two looks over an hour: not enough looks.
  assert.equal(stuckOnNode(second, t0 + 60 * 60_000), false);
  // Another object: a new episode (the node got past the first).
  const other = trackHydrator(third, { attempt: 1, object: "chunk 2 GET 0001.tar.zst" }, t0 + 20 * 60_000);
  assert.deepEqual(other, { object: "chunk 2 GET 0001.tar.zst", firstAt: t0 + 20 * 60_000, attempts: 1, seen: 1 });
  assert.equal(stuckOnNode(other, t0 + 40 * 60_000), false);
  assert.equal(stuckOnNode(null, t0), false);
});

const safe = (overrides: Partial<MoveFacts> = {}): MoveFacts => ({ tasks: [], checkouts: { checkouts: [], complete: true }, threads: [], ...overrides });
const task = { id: "t_1", title: "Cart spacing", status: "idle", repoPath: "/home/user/work/web", unshipped: null };
const at = (path: string, git: { unpushed: number; dirty: boolean; stashes: number } | null = { unpushed: 0, dirty: false, stashes: 0 }) => ({ path, git });

test("on its own only when nothing there could be lost: chats, tasks and every checkout", () => {
  // An orchestrator's or plain bb machine's sandbox counts only once its chats and checkouts are known to be clean.
  assert.deepEqual(moveDecision(safe()), { auto: true, reasons: [] });
  assert.deepEqual(moveDecision(safe({ threads: null })).reasons, ["Boat couldn't see which chats run there"]);
  assert.deepEqual(moveDecision(safe({ threads: [{ id: "thr_o", title: "Orchestrator", status: "active" }] })).reasons, ['the chat "Orchestrator" is mid-turn']);
  assert.deepEqual(moveDecision(safe({ threads: [{ id: "thr_o", status: "pending" }] })).reasons, ["a chat there is mid-turn"]);
  assert.deepEqual(moveDecision(safe({ threads: [{ id: "thr_o", status: "idle", hasPendingInteraction: true }] })).reasons, ["a chat there is mid-turn"]);
  assert.deepEqual(moveDecision(safe({ threads: [{ id: "thr_o", status: "idle", activity: { activeBackgroundCommandCount: 1 } }] })).reasons, ["a chat there has background work running"]);
  // A message only waiting for the machine lives in bb's queue, not on the sandbox.
  assert.equal(moveDecision(safe({ threads: [{ id: "thr_o", status: "idle", queuedWork: "waiting" }] })).auto, true);
  assert.equal(moveDecision(safe({ threads: [{ id: "thr_x", status: "active", archivedAt: 1 }] })).auto, true, "archived chats don't count");
  // Checkouts: unpushed commits on any branch, changes (untracked too), stashes, or a scan that couldn't finish.
  assert.deepEqual(moveDecision(safe({ checkouts: null })).reasons, ["Boat couldn't check every git checkout in the sandbox"]);
  assert.deepEqual(moveDecision(safe({ checkouts: { checkouts: [], complete: false } })).reasons, ["Boat couldn't check every git checkout in the sandbox"]);
  assert.deepEqual(
    moveDecision(safe({ checkouts: { checkouts: [at("/home/user/.bb-machines/acme/workspaces/w1/web", { unpushed: 2, dirty: true, stashes: 1 }), at("/home/user/notes", null)], complete: true } })).reasons,
    ["~/.bb-machines/acme/workspaces/w1/web has 2 unpushed commits", "~/.bb-machines/acme/workspaces/w1/web has changes that aren't committed", "~/.bb-machines/acme/workspaces/w1/web has 1 stash", "Boat couldn't check ~/notes"],
  );
  // Tasks: named by their checkout; mid-turn; unshipped work; a checkout the scan didn't reach.
  assert.deepEqual(moveDecision(safe({ tasks: [task], checkouts: { checkouts: [at(task.repoPath)], complete: true } })), { auto: true, reasons: [] });
  assert.deepEqual(moveDecision(safe({ tasks: [task], checkouts: { checkouts: [at(task.repoPath, { unpushed: 1, dirty: false, stashes: 0 })], complete: true } })).reasons, ["task t_1 has 1 unpushed commit"]);
  assert.deepEqual(moveDecision(safe({ tasks: [{ ...task, status: "running" }], checkouts: { checkouts: [at(task.repoPath)], complete: true } })).reasons, ["task t_1 is mid-turn"]);
  assert.deepEqual(moveDecision(safe({ tasks: [{ ...task, unshipped: 3 }], checkouts: { checkouts: [at(task.repoPath)], complete: true } })).reasons, ["task t_1 has 3 commits not shipped yet"]);
  assert.deepEqual(moveDecision(safe({ tasks: [task] })).reasons, ["Boat couldn't check task t_1's branch"]);
  assert.deepEqual(moveDecision(safe({ tasks: [{ ...task, repoPath: null }] })), { auto: true, reasons: [] }, "no checkout of its own: the scan covers its workspace");
});

test("the git checks, run here on throwaway repos: untracked files, commits on any local branch and stashes count; no network", (t) => {
  const home = mkdtempSync(join(tmpdir(), "boat-move-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const origin = join(home, "origin.git");
  mkdirSync(origin);
  git(origin, "init", "--bare", "-q");
  const repo = (path: string) => {
    const dir = join(home, path);
    mkdirSync(dir, { recursive: true });
    git(home, "clone", "-q", origin, dir);
    const file = path.replace(/\W/g, "_");
    writeFileSync(join(dir, file), "one\n");
    git(dir, "add", file);
    git(dir, "commit", "-q", "-m", file);
    git(dir, "push", "-q", "origin", `HEAD:refs/heads/${file}`);
    return { dir, file };
  };
  const clean = repo("work/clean");
  const untracked = repo("work/untracked");
  writeFileSync(join(untracked.dir, "new.txt"), "new\n");
  const branch = repo("work/branch");
  git(branch.dir, "checkout", "-q", "-b", "local-only");
  writeFileSync(join(branch.dir, "b.txt"), "b\n");
  git(branch.dir, "add", "b.txt");
  git(branch.dir, "commit", "-q", "-m", "b");
  git(branch.dir, "checkout", "-q", "-");
  const stash = repo("work/stash");
  writeFileSync(join(stash.dir, stash.file), "changed\n");
  git(stash.dir, "stash", "-q");
  repo("work/app/node_modules/dep");
  const scan = parseCheckouts(execFileSync("bash", ["-c", CHECKOUTS_SCRIPT], { encoding: "utf8", env: { ...process.env, HOME: home } }));
  assert.equal(scan.complete, true);
  const byPath = new Map(scan.checkouts.map((checkout) => [checkout.path.slice(home.length + 1), checkout.git]));
  assert.deepEqual(Object.fromEntries(byPath), {
    "work/clean": { unpushed: 0, dirty: false, stashes: 0 },
    "work/untracked": { unpushed: 0, dirty: true, stashes: 0 },
    "work/branch": { unpushed: 1, dirty: false, stashes: 0 },
    "work/stash": { unpushed: 0, dirty: false, stashes: 1 },
  }, "package folders aren't scanned");
  const one = (dir: string) => parseGitState(execFileSync("bash", ["-c", gitStateScript(dir)], { encoding: "utf8" }));
  assert.deepEqual(one(clean.dir), { unpushed: 0, dirty: false, stashes: 0 });
  assert.deepEqual(one(untracked.dir), { unpushed: 0, dirty: true, stashes: 0 });
  assert.deepEqual(one(branch.dir), { unpushed: 1, dirty: false, stashes: 0 });
  assert.deepEqual(one(stash.dir), { unpushed: 0, dirty: false, stashes: 1 });
  assert.equal(one(join(home, "missing")), "none");
  assert.equal(parseGitState("bash: git: Input/output error"), null);
  assert.match(gitStateScript("/home/user/work/it's"), /^d='\/home\/user\/work\/it'\\''s'/);
  // A scan cut short doesn't count as complete.
  assert.equal(parseCheckouts("BOAT_GIT_SCAN_INCOMPLETE 124\nBOAT_GIT_SCAN_END\n").complete, false);
  assert.equal(parseCheckouts("BOAT_GIT_AT ahead=0 dirty=0 stash=0 /home/user/a b\n").complete, false);
  assert.deepEqual(parseCheckouts("BOAT_GIT_AT unknown /home/user/a b\nBOAT_GIT_SCAN_END\n").checkouts, [{ path: "/home/user/a b", git: null }]);
});

test("a stop is followed by what boat says of it: forced only once boat refused it, never while it's pending", () => {
  const report = (status: string | null, stopId: string | null = "stop_1", forced: boolean | null = null) => ({ status, stopId, forced });
  assert.equal(stopOutcome(report("completed"), "stopped"), "stopped");
  assert.equal(stopOutcome(report(null, null), "archived"), "stopped");
  assert.equal(stopOutcome(report("failing"), "idle"), "refused");
  assert.equal(stopOutcome(report("failed"), "idle"), "refused");
  assert.equal(stopOutcome(report("pending"), "idle"), "pending", "boat still works on it (the sandbox may be unreachable)");
  assert.equal(stopOutcome(report("pending"), "stopping"), "pending");
  assert.equal(stopOutcome(report("superseded"), "idle"), "superseded");
  assert.equal(stopOutcome(report(null, null), "idle"), "refused", "nothing said and still up: what boat did live");
  assert.equal(stopOutcome(report(null, null), "stopping"), "pending");
  assert.equal(stopOutcome(report("completed"), "idle"), "refused", "completed but up");
  // A forced stop boat handed back while pending (forced false): still waiting.
  assert.equal(forcedOutcome(report("pending", "stop_1", false), "idle"), "pending");
  assert.equal(forcedOutcome(report("completed", "stop_2", true), "stopped"), "stopped");
  // boat's JSON, read loosely.
  assert.deepEqual(stopReport([{ event: "stop", stop: { id: "stop_9", status: "pending" } }]), { status: "pending", stopId: "stop_9", forced: null });
  assert.deepEqual(stopReport([{ stopId: "stop_3", status: "pending", forced: false }]), { status: "pending", stopId: "stop_3", forced: false });
  assert.deepEqual(stopReport([]), { status: null, stopId: null, forced: null });
});

test("Needs you says the exact commands, what would be lost, and why Boat didn't do it", () => {
  const now = Date.parse("2026-11-19T02:00:00Z");
  const asked = moveQuestion({ sandboxId: "bx_demo1", snapshotAt: "2026-11-19T00:41:00.000Z", reasons: ["task t_1 has 2 unpushed commits"], detail: LINE, fork: "healthy", now });
  assert.equal(asked.question, "Sandbox bx_demo1 is stuck on a boat.dev node that keeps failing its disk. Move it to a new node? If boat can't take a fresh snapshot, that loses what changed there since 00:41 UTC (its last completed snapshot).");
  assert.equal(asked.recommendation, "Move it if nothing written since then matters: run `boat stop bx_demo1` (if boat refuses it, `boat stop bx_demo1 --force`), then `bb boat sandbox resume bx_demo1`. Boat didn't do it itself because task t_1 has 2 unpushed commits. Otherwise wait for boat.dev to recover.");
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
  forkSays = "BOAT_DISK ok .profile\n";
  assert.equal(await forkCheck(boat as never, source.id), "unknown", "a check that didn't finish can't tell");
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
