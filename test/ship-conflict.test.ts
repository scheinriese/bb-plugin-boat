// Ship conflicts: the ship script names the conflicting files and the base
// commits that changed them (run for real against throwaway git repos), and
// the error says so.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { conflictReason, fileList, parseConflictDetail, parseShipOutput, shipScript } from "../src/boat-api.ts";

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
