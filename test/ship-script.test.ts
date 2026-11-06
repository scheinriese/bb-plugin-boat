// The ship step's script, run for real against throwaway git repos: commits
// land on the base branch updated to its latest state, never forced; dirty
// checkouts and conflicts stop it before anything is pushed.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { shipScript } from "../src/boat-api.ts";

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

/** origin (bare), a "base" clone that moves master on, and the worker's checkout on its branch. */
function repos() {
  const dir = mkdtempSync(join(tmpdir(), "boat-ship-"));
  const origin = join(dir, "origin.git");
  git(dir, "init", "--quiet", "--bare", "-b", "master", origin);
  const base = join(dir, "base");
  git(dir, "clone", "--quiet", origin, base);
  writeFileSync(join(base, "a.txt"), "one\n");
  git(base, "add", ".");
  git(base, "commit", "--quiet", "-m", "first");
  git(base, "push", "--quiet", "origin", "HEAD:master");
  const worker = join(dir, "worker");
  git(dir, "clone", "--quiet", origin, worker);
  git(worker, "checkout", "--quiet", "-b", "boat/x");
  return { dir, origin, base, worker };
}

function ship(path: string) {
  const result = spawnSync("bash", ["-c", shipScript([{ path, baseBranch: "master" }])], { env: ENV, encoding: "utf8" });
  return result.stdout;
}

test("approved commits land on top of the latest base branch", () => {
  const { origin, base, worker } = repos();
  writeFileSync(join(worker, "b.txt"), "the worker's change\n");
  git(worker, "add", ".");
  git(worker, "commit", "--quiet", "-m", "worker change");
  // Meanwhile master moved on.
  writeFileSync(join(base, "c.txt"), "someone else's change\n");
  git(base, "add", ".");
  git(base, "commit", "--quiet", "-m", "other change");
  git(base, "push", "--quiet", "origin", "HEAD:master");

  const out = ship(worker);
  assert.match(out, /^BOAT_SHIPPED 0 [0-9a-f]{40} 1$/m);
  assert.match(out, /BOAT_SHIP_DONE/);
  // Linear history: the worker's commit on top of the other one; nothing was lost.
  assert.deepEqual(git(origin, "log", "--format=%s", "master").split("\n"), ["worker change", "other change", "first"]);
});

test("uncommitted changes, conflicts and nothing-to-ship push nothing", () => {
  // Dirty.
  const dirty = repos();
  writeFileSync(join(dirty.worker, "a.txt"), "edited but not committed\n");
  assert.match(ship(dirty.worker), /^BOAT_SHIP_ERROR 0 dirty$/m);
  assert.equal(git(dirty.origin, "log", "--format=%s", "master"), "first");
  // A new file the worker never added counts too, and is named.
  const untracked = repos();
  writeFileSync(join(untracked.worker, "b.txt"), "x\n");
  git(untracked.worker, "add", "b.txt");
  git(untracked.worker, "commit", "--quiet", "-m", "worker change");
  writeFileSync(join(untracked.worker, "forgotten.ts"), "export const x = 1;\n");
  const untrackedOut = ship(untracked.worker);
  assert.match(untrackedOut, /^BOAT_SHIP_ERROR 0 dirty$/m);
  assert.match(untrackedOut, /^BOAT_SHIP_DETAIL \?\? forgotten\.ts$/m);
  assert.equal(git(untracked.origin, "log", "--format=%s", "master"), "first");

  // Conflict: both change the same line.
  const conflict = repos();
  writeFileSync(join(conflict.worker, "a.txt"), "worker's version\n");
  git(conflict.worker, "commit", "--quiet", "-am", "worker edit");
  writeFileSync(join(conflict.base, "a.txt"), "base's version\n");
  git(conflict.base, "commit", "--quiet", "-am", "base edit");
  git(conflict.base, "push", "--quiet", "origin", "HEAD:master");
  const before = git(conflict.worker, "rev-parse", "HEAD");
  assert.match(ship(conflict.worker), /^BOAT_SHIP_ERROR 0 conflict$/m);
  assert.deepEqual(git(conflict.origin, "log", "--format=%s", "master").split("\n"), ["base edit", "first"]);
  // The worker's branch is as it was (the rebase was undone).
  assert.equal(git(conflict.worker, "rev-parse", "HEAD"), before);
  assert.equal(git(conflict.worker, "status", "--porcelain"), "");

  // Nothing ahead of master.
  const empty = repos();
  const out = ship(empty.worker);
  assert.doesNotMatch(out, /BOAT_SHIPPED/);
  assert.match(out, /BOAT_SHIP_DONE/);
});

test("a base branch that can't be fast-forwarded is never forced", () => {
  const { origin, base, worker } = repos();
  writeFileSync(join(worker, "b.txt"), "x\n");
  git(worker, "add", ".");
  git(worker, "commit", "--quiet", "-m", "worker change");
  // A pre-receive hook on origin rejects everything: the push fails, and it's reported.
  writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\necho 'protected branch'\nexit 1\n", { mode: 0o755 });
  const out = ship(worker);
  assert.match(out, /^BOAT_SHIP_ERROR 0 push$/m);
  // git's own words come back for the error message.
  assert.match(out, /^BOAT_SHIP_DETAIL .*protected branch/m);
  assert.equal(git(origin, "log", "--format=%s", "master"), "first");
  void base;
});
