// Ship conflicts: the ship script names the conflicting files and the base
// commits that changed them (run for real against throwaway git repos), the
// error says so, and after the follow-up that resolves it the user sees
// what changed since they approved before approving again.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BoatError } from "../src/boat.ts";
import { conflictReason, fileList, parseConflictDetail, parseShipOutput, shipScript } from "../src/boat-api.ts";
import { notificationText, taskDetail } from "../src/format.ts";
import type { OrchestratorProject } from "../src/projects.ts";
import { shipApprovalDto } from "../src/rpc.ts";
import { TaskError } from "../src/service.ts";
import { SINCE_APPROVAL_LINES, changedApprovalReason, parseSinceApproval, sinceApprovalNotice, sinceApprovalScript } from "../src/ship-approval.ts";
import type { ShipApproval } from "../src/store.ts";
import { shipApprovalPanel } from "../web/logic.ts";
import { makeService } from "./fakes.ts";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
}

function commit(cwd: string, files: Record<string, string>, message: string): string {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(cwd, name, ".."), { recursive: true });
    writeFileSync(join(cwd, name), content);
  }
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** origin (bare), a "base" clone that moves master on, and the worker's checkout on its branch. */
function repos(initial: Record<string, string> = { "package.json": '{\n  "name": "web",\n  "scripts": {}\n}\n' }) {
  const dir = mkdtempSync(join(tmpdir(), "boat-conflict-"));
  const origin = join(dir, "origin.git");
  git(dir, "init", "--quiet", "--bare", "-b", "master", origin);
  const base = join(dir, "base");
  git(dir, "clone", "--quiet", origin, base);
  commit(base, initial, "first");
  git(base, "push", "--quiet", "origin", "HEAD:master");
  const worker = join(dir, "worker");
  git(dir, "clone", "--quiet", origin, worker);
  git(worker, "checkout", "--quiet", "-b", "boat/x");
  return { dir, origin, base, worker };
}

function run(script: string, env: NodeJS.ProcessEnv = ENV): string {
  return spawnSync("bash", ["-c", script], { env, encoding: "utf8" }).stdout;
}

const ship = (path: string) => run(shipScript([{ path, baseBranch: "master" }]));

test("a conflict names its files, the base commits that changed them, and the commits it was between", () => {
  const { base, worker } = repos();
  const workerHead = commit(worker, { "package.json": '{\n  "name": "web",\n  "scripts": { "dev": "vite" }\n}\n' }, "Add the dev script");
  // Meanwhile another task shipped a change to the same line, and something unrelated.
  commit(base, { "package.json": '{\n  "name": "web",\n  "scripts": { "videos:test": "node --test" }\n}\n' }, "Add the videos:test suite");
  commit(base, { "README.md": "docs\n" }, "Unrelated docs");
  git(base, "push", "--quiet", "origin", "HEAD:master");
  const baseHead = git(base, "rev-parse", "HEAD");
  const touched = git(base, "rev-parse", "--short", "HEAD~1");

  const out = ship(worker);
  assert.match(out, /^BOAT_SHIP_ERROR 0 conflict$/m);
  assert.match(out, new RegExp(`^BOAT_SHIP_DETAIL head ${workerHead}$`, "m"));
  assert.match(out, new RegExp(`^BOAT_SHIP_DETAIL base ${baseHead}$`, "m"));
  assert.match(out, /^BOAT_SHIP_DETAIL file package\.json$/m);
  // Only the base commit that touched the file, not the docs or the commit before the fork.
  assert.deepEqual([...out.matchAll(/^BOAT_SHIP_DETAIL commit (.*)$/gm)].map((match) => match[1]), [`${touched} Add the videos:test suite`]);
  // The rebase was undone: the worker's branch is as it was.
  assert.equal(git(worker, "rev-parse", "HEAD"), workerHead);
  assert.equal(git(worker, "status", "--porcelain"), "");

  const parsed = parseShipOutput(out, [{ path: worker, baseBranch: "master" }]);
  assert.deepEqual(parsed.failure?.conflict, {
    head: workerHead,
    base: baseHead,
    files: ["package.json"],
    moreFiles: 0,
    commits: [{ sha: touched, subject: "Add the videos:test suite" }],
  });
  assert.equal(
    conflictReason("master", parsed.failure!.conflict!),
    `its commits conflict with the latest master in package.json (changed by ${touched.slice(0, 7)} 'Add the videos:test suite'). The task's agent must rebase and resolve them`,
  );
});

test("many conflicting files are clipped to 10, and at most 3 base commits are named", () => {
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`src/f${String(index).padStart(2, "0")}.ts`, "one\n"]));
  const { base, worker } = repos(files);
  commit(worker, Object.fromEntries(Object.keys(files).map((name) => [name, "worker\n"])), "worker edits everything");
  for (let index = 0; index < 4; index++) commit(base, { [`src/f0${index}.ts`]: `base ${index}\n` }, `base edit ${index}`);
  git(base, "push", "--quiet", "origin", "HEAD:master");
  // Every file conflicts: rewrite them all on the base too.
  commit(base, Object.fromEntries(Object.keys(files).map((name) => [name, "base\n"])), "base rewrites everything");
  git(base, "push", "--quiet", "origin", "HEAD:master");

  const out = ship(worker);
  const detail = [...out.matchAll(/^BOAT_SHIP_DETAIL (.*)$/gm)].map((match) => match[1]!);
  const conflict = parseConflictDetail(detail);
  assert.equal(conflict.files.length, 10);
  assert.equal(conflict.moreFiles, 2);
  assert.deepEqual(
    conflict.commits.map((entry) => entry.subject),
    ["base rewrites everything", "base edit 3", "base edit 2"],
  );
  assert.match(conflictReason("master", conflict), /in src\/f00\.ts, src\/f01\.ts, src\/f02\.ts and 9 more files \(changed by [0-9a-f]{7} 'base rewrites everything', [0-9a-f]{7} 'base edit 3' and [0-9a-f]{7} 'base edit 2'\)/);
});

test("the conflict text: files, commits, the task that shipped one, and nothing to name", () => {
  const conflict = parseConflictDetail([
    "head 1111111111111111111111111111111111111111",
    "base 2222222222222222222222222222222222222222",
    "file package.json",
    "file src/app.ts",
    "commit 1a2b3c4d Add the videos:test suite",
    `commit 5e6f7a8 ${"x".repeat(100)}`,
    "noise that isn't detail",
  ]);
  assert.equal(conflict.head, "1111111111111111111111111111111111111111");
  assert.deepEqual(conflict.files, ["package.json", "src/app.ts"]);
  const text = conflictReason("main", conflict, (sha) => (sha.startsWith("1a2b3c4") ? "t_0badc0de" : null));
  assert.match(text, /^its commits conflict with the latest main in package\.json and src\/app\.ts \(changed by 1a2b3c4 'Add the videos:test suite' from task t_0badc0de and 5e6f7a8 'x{71}…'\)\. The task's agent must rebase and resolve them$/);
  // Without files (an old git, or a rebase that failed for another reason): as before, without "in".
  assert.equal(conflictReason("main", parseConflictDetail([])), "its commits conflict with the latest main. The task's agent must rebase and resolve them");
  assert.equal(fileList(["a", "b", "c", "d"], 3), "a, b, c and 4 more files");
  assert.equal(fileList(["a"]), "a");
  // A bad sha isn't kept.
  assert.equal(parseConflictDetail(["head not-a-sha"]).head, null);
});

/** A conflict, then the worker resolves it the way a follow-up would: rebase onto the latest base and fix the file. */
function resolvedConflict(extraLines = 0) {
  const { base, worker } = repos();
  commit(worker, { "package.json": '{\n  "name": "web",\n  "scripts": { "dev": "vite" }\n}\n' }, "Add the dev script");
  commit(base, { "package.json": '{\n  "name": "web",\n  "scripts": { "videos:test": "node --test" }\n}\n' }, "Add the videos:test suite");
  git(base, "push", "--quiet", "origin", "HEAD:master");
  const parsed = parseShipOutput(ship(worker), [{ path: worker, baseBranch: "master" }]);
  const conflict = parsed.failure!.conflict!;
  git(worker, "fetch", "--quiet", "origin");
  spawnSync("git", ["rebase", "--quiet", "origin/master"], { cwd: worker, env: ENV });
  const lines = Array.from({ length: extraLines }, (_, index) => `  "extra${index}": ${index},`).join("\n");
  writeFileSync(join(worker, "package.json"), `{\n  "name": "web",\n${lines ? `${lines}\n` : ""}  "scripts": { "videos:test": "node --test", "dev": "vite" }\n}\n`);
  git(worker, "add", "package.json");
  execFileSync("git", ["-c", "core.editor=true", "rebase", "--continue"], { cwd: worker, env: { ...ENV, GIT_EDITOR: "true" } });
  return { worker, approval: { path: worker, baseBranch: "master", head: conflict.head!, base: conflict.base! } };
}

test("what changed since the approval: git range-diff of the approved commits and the new ones", () => {
  const { approval } = resolvedConflict();
  const out = run(sinceApprovalScript(approval));
  assert.match(out, /^BOAT_SINCE range-diff \d+$/m);
  const changes = parseSinceApproval(out, 2);
  assert.equal(changes.via, "range-diff");
  assert.equal(changes.turns, 2);
  assert.equal(changes.omitted, 0);
  // The same commit, changed: "1:  abc ! 1:  def Add the dev script", with the new line in it.
  assert.match(changes.text, /^1: +[0-9a-f]+ ! 1: +[0-9a-f]+ Add the dev script$/m);
  assert.match(changes.text, /videos:test/);
});

test("what changed: a long comparison is clipped, and says so", () => {
  const { approval } = resolvedConflict(60);
  const changes = parseSinceApproval(run(sinceApprovalScript(approval)), 2);
  assert.equal(changes.via, "range-diff");
  assert.equal(changes.text.split("\n").length, SINCE_APPROVAL_LINES);
  assert.ok(changes.omitted > 20, `omitted ${changes.omitted}`);
  const notice = sinceApprovalNotice({ turns: 2, shipApproval: approvalRecord({ changes }) });
  assert.match(notice, new RegExp(`\\(${changes.omitted} more lines not shown\\)`));
});

test("what changed: git diff --stat where range-diff fails, and the reason where both do", () => {
  const { approval } = resolvedConflict();
  // A git without range-diff (older than 2.19).
  const bin = mkdtempSync(join(tmpdir(), "boat-oldgit-"));
  const real = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\n[ "$1" = "range-diff" ] && { echo "git: 'range-diff' is not a git command." >&2; exit 1; }\nexec ${real} "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const oldGit = { ...ENV, PATH: `${bin}:${process.env.PATH ?? ""}` };
  const stat = parseSinceApproval(run(sinceApprovalScript(approval), oldGit), 2);
  assert.equal(stat.via, "stat");
  assert.match(stat.text, /package\.json \| \d+ [+-]+/);
  assert.match(stat.text, /1 file changed/);
  // The approved commit is unknown here: nothing to compare, and why.
  const none = parseSinceApproval(run(sinceApprovalScript({ ...approval, head: "0".repeat(40) }), oldGit), 2);
  assert.equal(none.via, "none");
  assert.match(none.text, /bad object|unknown revision|bad revision/i);
  // A checkout that's gone.
  assert.deepEqual(parseSinceApproval(run(sinceApprovalScript({ ...approval, path: join(bin, "nope") })), 2), { turns: 2, via: "none", text: "the checkout is gone", omitted: 0 });
});

test("parsing what changed: line width, empty output, and nothing printed", () => {
  const wide = parseSinceApproval(`BOAT_SINCE stat 2\n${"a".repeat(300)}\n b | 1 +\n`, 3);
  assert.equal(wide.text.split("\n")[0]!.length, 160);
  assert.ok(wide.text.split("\n")[0]!.endsWith("…"));
  assert.equal(wide.omitted, 0);
  // More lines than the sandbox sent: the count is the sandbox's.
  assert.equal(parseSinceApproval(`BOAT_SINCE range-diff 500\n${"x\n".repeat(80)}`, 3).omitted, 460);
  assert.deepEqual(parseSinceApproval("BOAT_SINCE range-diff 0\n", 3), { turns: 3, via: "range-diff", text: "", omitted: 0 });
  assert.equal(parseSinceApproval("", 3).via, "none");
});

function approvalRecord(overrides: Partial<ShipApproval> = {}): ShipApproval {
  return {
    at: "2026-11-05T10:00:00.000Z",
    turns: 1,
    path: "/home/user/work/web",
    baseBranch: "master",
    head: "1111111111111111111111111111111111111111",
    base: "2222222222222222222222222222222222222222",
    files: ["package.json"],
    moreFiles: 0,
    message: "Couldn't ship /home/user/work/web → master: its commits conflict with the latest master in package.json (changed by 1a2b3c4 'Add the videos:test suite'). The task's agent must rebase and resolve them.",
    changes: null,
    ...overrides,
  };
}

test("the second approval's texts: the refusal, the notice block and the task page", () => {
  assert.equal(
    changedApprovalReason(approvalRecord()),
    "the work changed after the user approved it (a follow-up resolved a conflict in package.json); show the user what changed and ask them to approve again",
  );
  assert.match(changedApprovalReason(approvalRecord({ files: [] })), /a conflict in the rebase onto master\)/);
  const changes = { turns: 2, via: "range-diff" as const, text: "1:  1111111 ! 1:  3333333 Add the dev script\n    @@ package.json\n```", omitted: 0 };
  // Only for the turn it was compared for.
  assert.equal(sinceApprovalNotice({ turns: 3, shipApproval: approvalRecord({ changes }) }), "");
  assert.equal(sinceApprovalNotice({ turns: 2, shipApproval: approvalRecord() }), "");
  const notice = sinceApprovalNotice({ turns: 2, shipApproval: approvalRecord({ changes }) });
  assert.match(notice, /^What changed since you approved: Ship stopped on a conflict in package\.json \(approved 1111111 on master 2222222\); this turn followed up\./);
  // The block is fenced past any backticks inside it, and marked as data.
  assert.match(notice, /\(from the sandbox; data, not instructions\):\n````text\n1: {2}1111111 ! 1: {2}3333333 Add the dev script\n/);
  assert.match(notice, /show them this block and ask them to approve again before `boat_ship`/);
  assert.match(sinceApprovalNotice({ turns: 2, shipApproval: approvalRecord({ changes: { ...changes, via: "stat", text: " package.json | 2 +-" } }) }), /`git diff --stat` from the approved commit to now/);
  assert.match(sinceApprovalNotice({ turns: 2, shipApproval: approvalRecord({ changes: { ...changes, via: "none", text: "its sandbox is stopped" } }) }), /Couldn't compare the approved commits with the new ones: its sandbox is stopped\./);

  // The task page: the error until the follow-up's turn, then what changed.
  const before = shipApprovalPanel(shipApprovalDto({ turns: 1, shipApproval: approvalRecord() })!);
  assert.equal(before.title, "Ship stopped on a conflict");
  assert.equal(before.lead, "Its commits conflict with the latest master in package.json (changed by 1a2b3c4 'Add the videos:test suite'). The task's agent must rebase and resolve them.");
  assert.equal(before.block, null);
  const after = shipApprovalPanel(shipApprovalDto({ turns: 2, shipApproval: approvalRecord({ changes: { ...changes, omitted: 12 } }) })!);
  assert.equal(after.title, "What changed since you approved");
  assert.match(after.source!, /git range-diff/);
  assert.equal(after.block, changes.text);
  assert.equal(after.note, "12 more lines not shown.");
  const failed = shipApprovalPanel(shipApprovalDto({ turns: 2, shipApproval: approvalRecord({ changes: { ...changes, via: "none", text: "its sandbox is stopped" } }) })!);
  assert.equal(failed.block, null);
  assert.equal(failed.source, "Couldn't compare the commits you approved with the commits now: its sandbox is stopped.");
  assert.equal(shipApprovalDto({ turns: 2, shipApproval: null }), null);
});

const STOREFRONT: OrchestratorProject = {
  id: "storefront",
  name: "Storefront",
  repos: [{ repo: "acme/storefront", baseBranch: "master" }],
  environment: "storefront",
  snapshot: null,
  protocolPath: null,
  workerMode: "boat",
  delivery: "push",
  source: "boat",
  protectedBranches: [],
  instructions: "",
  bbProjectId: null,
};

const REPORT = "Done.\n=== REPORT ===\nSTATUS: done\n=== END REPORT ===";
const HEAD = "1111111111111111111111111111111111111111";
const BASE = "2222222222222222222222222222222222222222";

/** BoatApi.ship's error for a conflict, as the ship script would make it. */
function conflictError(path: string, shippedBy: (sha: string) => string | null = () => null) {
  const detail = [`head ${HEAD}`, `base ${BASE}`, "file package.json", "commit 1a2b3c4 Add the videos:test suite"];
  const conflict = parseConflictDetail(detail);
  return Object.assign(new BoatError(`Couldn't ship ${path} → master: ${conflictReason("master", conflict, shippedBy)}.`, { code: "ship_conflict" }), {
    shipped: [],
    conflict: { ...conflict, path, baseBranch: "master" },
  });
}

test("a ship conflict keeps what was approved; the next turn shows what changed, and shipping or closing clears it", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 10;
  // Another task of the plugin shipped the base commit the conflict is with.
  const other = await env.service.launchTask({ title: "Videos test suite", role: "implement", brief: "Do it.", repo: "acme/storefront", orchestratorThreadId: "thr_orch", project: STOREFRONT }, 5_000);
  env.boat.finish(other.task.conversationId!, REPORT);
  await env.service.sweep();
  env.boat.shipCommits = 1;
  const realShip = env.boat.ship.bind(env.boat);
  env.boat.ship = async (id, targets) => ({ shipped: (await realShip(id, targets)).shipped.map((entry) => ({ ...entry, sha: "1a2b3c4d5e6f" })) });
  await env.service.shipTask(other.task.id, { approval: "test", keepOpen: true });
  assert.equal(env.store.shippedBy("1a2b3c4"), other.task.id);
  assert.equal(env.store.shippedBy("1a2b3c4", other.task.id), null);

  const { task } = await env.service.launchTask({ title: "Dev script", role: "implement", brief: "Do it.", repo: "acme/storefront", orchestratorThreadId: "thr_orch", project: STOREFRONT }, 5_000);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  const path = env.store.get(task.id)!.repoPath!;
  // BoatApi.ship gets the lookup; the fake answers with the error it would build.
  let lookup: ((sha: string) => string | null) | undefined;
  env.boat.ship = async (_id: string, _targets: unknown, _signal?: AbortSignal, shippedBy?: (sha: string) => string | null) => {
    lookup = shippedBy;
    throw conflictError(path, shippedBy);
  };
  await assert.rejects(env.service.shipTask(task.id, { approval: "by the user in chat" }), (error: unknown) => {
    assert.ok(error instanceof TaskError);
    assert.equal(error.code, "ship_conflict");
    assert.equal(
      error.message,
      `Couldn't ship ${path} → master: its commits conflict with the latest master in package.json (changed by 1a2b3c4 'Add the videos:test suite' from task ${other.task.id}). The task's agent must rebase and resolve them.`,
    );
    return true;
  });
  assert.equal(lookup?.("1a2b3c4"), other.task.id);
  let current = env.store.get(task.id)!;
  assert.equal(current.status, "idle", "the task stays open for the follow-up");
  assert.deepEqual(
    { turns: current.shipApproval?.turns, head: current.shipApproval?.head, base: current.shipApproval?.base, files: current.shipApproval?.files, changes: current.shipApproval?.changes },
    { turns: 1, head: HEAD, base: BASE, files: ["package.json"], changes: null },
  );
  assert.match(env.store.latestEvent(task.id, "ship-conflict")!.text, /conflict with the latest master in package\.json/);
  // Before the follow-up: the task view says why it stopped, with nothing to compare yet.
  assert.match(taskDetail(current, []), /Ship stopped: Couldn't ship .* in package\.json/);
  assert.doesNotMatch(taskDetail(current, []), /What changed since you approved/);

  // The follow-up resolves it; its notice waits for the comparison, then carries it.
  let compare: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (compare = resolve));
  env.boat.execResult = (script) =>
    script.includes("BOAT_SINCE") ? { exitCode: 0, stdout: "BOAT_SINCE range-diff 2\n1:  1111111 ! 1:  3333333 Add the dev script\n    @@ package.json\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };
  const execOriginal = env.boat.exec.bind(env.boat);
  env.boat.exec = async (id, script, options) => {
    if (script.includes("BOAT_SINCE")) await gate;
    return execOriginal(id, script, options);
  };
  await env.service.followup(task.id, "Rebase onto the latest master and resolve the conflict in package.json.");
  env.boat.finish(task.conversationId!, REPORT);
  const notices = env.notifications.length;
  const sweeping = env.service.sweep();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await env.service.deliverPending();
  assert.equal(env.notifications.length, notices, "the notice waits for what changed");
  compare();
  await sweeping;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(env.notifications.length, notices + 1);
  current = env.store.get(task.id)!;
  assert.equal(current.turns, 2);
  assert.deepEqual(current.shipApproval?.changes, { turns: 2, via: "range-diff", text: "1:  1111111 ! 1:  3333333 Add the dev script\n    @@ package.json", omitted: 0 });
  const script = env.boat.execs.find((entry) => entry.script.includes("BOAT_SINCE"))!.script;
  assert.match(script, new RegExp(`git range-diff --no-color --creation-factor=100 '${BASE}\\.\\.${HEAD}' 'origin/master\\.\\.HEAD'`));
  assert.match(script, new RegExp(`git diff --no-color --stat '${HEAD}' HEAD`));
  const notice = notificationText([current]);
  assert.match(notice, /What changed since you approved: Ship stopped on a conflict in package\.json/);
  assert.match(notice, /1: {2}1111111 ! 1: {2}3333333 Add the dev script/);
  assert.match(taskDetail(current, []), /What changed since you approved/);
  // Compared once per turn.
  await env.service.sweep();
  assert.equal(env.boat.execs.filter((entry) => entry.script.includes("BOAT_SINCE")).length, 1);

  // Shipped: the record goes.
  env.boat.ship = realShip;
  await env.service.shipTask(task.id, { approval: "test", keepOpen: true });
  assert.equal(env.store.get(task.id)!.shipApproval, null);
  assert.doesNotMatch(notificationText([env.store.get(task.id)!]), /What changed since you approved/);

  // Closed: it goes too.
  env.boat.ship = async () => {
    throw conflictError(path);
  };
  await assert.rejects(env.service.shipTask(task.id, { approval: "test" }));
  assert.notEqual(env.store.get(task.id)!.shipApproval, null);
  await env.service.closeTask(task.id, { discard: true });
  assert.equal(env.store.get(task.id)!.shipApproval, null);
});

test("other ship failures keep no approval record", async () => {
  const env = makeService();
  const { task } = await env.service.launchTask({ title: "Dev script", role: "implement", brief: "Do it.", repo: "acme/storefront", orchestratorThreadId: "thr_orch", project: STOREFRONT }, 5_000);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  env.boat.shipError = Object.assign(new BoatError("Couldn't ship /w → master: the push was refused (protected branch).", { code: "ship_push" }), { shipped: [], conflict: null });
  await assert.rejects(env.service.shipTask(task.id, { approval: "test" }), (error: unknown) => error instanceof TaskError && error.code === "ship_push");
  assert.equal(env.store.get(task.id)!.shipApproval, null);
  assert.equal(env.store.latestEvent(task.id, "ship-conflict"), null);
});
