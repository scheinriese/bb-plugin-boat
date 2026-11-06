// Ship conflicts: the ship script names the conflicting files and the base
// commits that changed them (run for real against throwaway git repos), the
// error says so, and the user's OK from before the follow-up that resolves
// it doesn't count for the commits after it.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BoatError } from "../src/boat.ts";
import { conflictReason, fileList, parseConflictDetail, parseShipOutput, shipScript } from "../src/boat-api.ts";
import type { OrchestratorProject } from "../src/projects.ts";
import { TaskError } from "../src/service.ts";
import { changedApprovalReason, changedSinceApproval } from "../src/ship-approval.ts";
import type { ShipApproval } from "../src/store.ts";
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

const ship = (path: string) => spawnSync("bash", ["-c", shipScript([{ path, baseBranch: "master" }])], { env: ENV, encoding: "utf8" }).stdout;

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

test("the second approval's reason names the conflict", () => {
  assert.equal(
    changedApprovalReason(approvalRecord()),
    "the work changed after the user approved it (a follow-up resolved a conflict in package.json); show the user what changed and ask them to approve again",
  );
  assert.match(changedApprovalReason(approvalRecord({ files: [] })), /a conflict in the rebase onto master\)/);
  assert.equal(changedSinceApproval({ turns: 1, shipApproval: approvalRecord() }), false);
  assert.equal(changedSinceApproval({ turns: 2, shipApproval: approvalRecord() }), true);
  assert.equal(changedSinceApproval({ turns: 2, shipApproval: null }), false);
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

test("a ship conflict keeps what was approved; shipping or closing clears it", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 10;
  const { task } = await env.service.launchTask({ title: "Dev script", role: "implement", brief: "Do it.", repo: "acme/storefront", orchestratorThreadId: "thr_orch", project: STOREFRONT }, 5_000);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  const path = env.store.get(task.id)!.repoPath!;
  const realShip = env.boat.ship.bind(env.boat);
  env.boat.ship = async () => {
    throw conflictError(path);
  };
  await assert.rejects(env.service.shipTask(task.id, { approval: "by the user in chat" }), (error: unknown) => {
    assert.ok(error instanceof TaskError);
    assert.equal(error.code, "ship_conflict");
    assert.match(error.message, /in package\.json \(changed by 1a2b3c4 'Add the videos:test suite'\)/);
    return true;
  });
  const current = env.store.get(task.id)!;
  assert.equal(current.status, "idle", "the task stays open for the follow-up");
  assert.deepEqual(
    { turns: current.shipApproval?.turns, head: current.shipApproval?.head, base: current.shipApproval?.base, files: current.shipApproval?.files },
    { turns: 1, head: HEAD, base: BASE, files: ["package.json"] },
  );
  assert.match(env.store.latestEvent(task.id, "ship-conflict")!.text, /conflict with the latest master in package\.json/);
  // Shipped: the record goes.
  env.boat.ship = realShip;
  await env.service.shipTask(task.id, { approval: "test", keepOpen: true });
  assert.equal(env.store.get(task.id)!.shipApproval, null);
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
