// Projects: settings, defaults for dispatches, and base-branch protection.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type Database from "better-sqlite3";
import { BOAT_GIT_ENV, BoatApi, chainedHook, invalidBranchNames, parseBranchList, prePushHook } from "../src/boat-api.ts";
import { BoatCli } from "../src/boat.ts";
import { localToOrchestratorProject, pushRefusal, type LocalProject } from "../src/local-projects.ts";
import { kickoffPrompt } from "../src/orchestrator.ts";
import {
  DEFAULT_PROTECTED_BRANCHES,
  ProjectStore,
  alwaysProtectedBranches,
  normalizeProject,
  parseOrchestratorProject,
  protectedBranches,
  toOrchestratorProject,
} from "../src/projects.ts";
import { TaskError } from "../src/service.ts";
import { TaskStore } from "../src/store.ts";
import { makeService } from "./fakes.ts";

function projectStore(): ProjectStore {
  const db = new DatabaseSync(":memory:");
  for (const statement of TaskStore.migrations()) db.exec(statement);
  return new ProjectStore(() => db as unknown as Database.Database);
}

test("a new store has no projects (nothing is seeded)", () => {
  const store = projectStore();
  assert.deepEqual(store.list(), []);
  assert.equal(store.find("web"), null);
});

test("projects are validated and normalized", () => {
  const project = normalizeProject({
    name: "Web app",
    repos: [{ repo: "https://github.com/acme/web.git", baseBranch: "develop" }],
    environment: " web ",
    snapshot: "",
    protocolPath: "docs/agents/orchestrator.md",
  });
  assert.equal(project.id, "web-app");
  assert.deepEqual(project.repos, [{ repo: "acme/web", baseBranch: "develop" }]);
  assert.equal(project.environment, "web");
  assert.equal(project.snapshot, null);
  assert.throws(() => normalizeProject({ name: "x", repos: [] }));
  assert.throws(() => normalizeProject({ name: "x", repos: [{ repo: "not a repo", baseBranch: "main" }] }));
  assert.throws(() => normalizeProject({ name: "x", repos: [{ repo: "a/b", baseBranch: "main" }, { repo: "A/B", baseBranch: "dev" }] }), /twice/);
  assert.throws(() => normalizeProject({ name: "x", repos: [{ repo: "a/b", baseBranch: "main" }], protocolPath: "../etc/passwd" }), /relative/);
  assert.throws(() => normalizeProject({ name: "x", repos: [{ repo: "a/b", baseBranch: "main" }], environment: "bad env" }));
});

test("saving keeps ids unique and finds projects by name or repo", () => {
  const store = projectStore();
  const first = store.save({ name: "Docs", repos: [{ repo: "acme/docs", baseBranch: "main" }] });
  const second = store.save({ name: "Docs", repos: [{ repo: "acme/docs2", baseBranch: "main" }] });
  assert.equal(first.id, "docs");
  assert.equal(second.id, "docs-2");
  const edited = store.save({ id: "docs", name: "Docs site", repos: [{ repo: "acme/docs", baseBranch: "trunk" }] });
  assert.equal(edited.id, "docs");
  assert.equal(edited.createdAt, first.createdAt);
  assert.equal(store.find("docs site")?.id, "docs");
  assert.equal(store.forRepo("ACME/docs")?.id, "docs");
});

test("base branches are always protected", () => {
  const project = toOrchestratorProject(
    normalizeProject({ name: "p", repos: [{ repo: "a/b", baseBranch: "release" }, { repo: "a/c", baseBranch: "trunk" }] }),
  );
  assert.deepEqual(DEFAULT_PROTECTED_BRANCHES, ["main", "master"]);
  assert.deepEqual(protectedBranches(project).sort(), ["main", "master", "release", "trunk"]);
  // The "Extra protected branches" setting adds to the defaults everywhere.
  assert.deepEqual(protectedBranches(project, [], alwaysProtectedBranches(["staging"])).sort(), ["main", "master", "release", "staging", "trunk"]);
  assert.deepEqual(alwaysProtectedBranches(["main", "staging"]), ["main", "master", "staging"]);
});

test("the extra protected branches setting is a comma-separated list of branch names", () => {
  assert.deepEqual(parseBranchList(""), []);
  assert.deepEqual(parseBranchList(" release, develop ,release,, staging/eu "), ["release", "develop", "staging/eu"]);
  assert.deepEqual(parseBranchList("ok, bad name, ../x, -flag"), ["ok"]);
  assert.deepEqual(invalidBranchNames("ok, bad name, ../x, -flag"), ["bad name", "../x", "-flag"]);
  assert.deepEqual(invalidBranchNames("release, develop"), []);
});

test("the pre-push hook refuses protected branches and chains to the repo's own hook", () => {
  const dir = mkdtempSync(join(tmpdir(), "boat-hook-"));
  const hooks = join(dir, "boat-hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "protected"), "release\nmain\n");
  writeFileSync(join(hooks, "pre-push"), prePushHook(), { mode: 0o755 });
  // A repo whose own hooks live in .husky/_ (what `npm install` sets up).
  const repo = join(dir, "repo");
  spawnSync("git", ["init", "-q", "--template=", repo]);
  mkdirSync(join(repo, ".husky", "_"), { recursive: true });
  writeFileSync(join(repo, ".husky", "_", "pre-push"), "#!/bin/sh\ncat >/dev/null\necho HUSKY-RAN >&2\n", { mode: 0o755 });
  spawnSync("git", ["-C", repo, "config", "core.hooksPath", ".husky/_"]);
  // This checkout's own base, found at checkout time.
  writeFileSync(join(repo, ".git", "boat-protected"), "develop\n");
  const push = (remoteRef: string) =>
    spawnSync("sh", [join(hooks, "pre-push"), "origin", "https://github.com/a/b"], {
      cwd: repo,
      input: `refs/heads/x 111 ${remoteRef} 000\n`,
      encoding: "utf8",
      env: { ...process.env, BOAT_HOOKS_DIR: hooks },
    });
  const blocked = push("refs/heads/release");
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /not allowed.*draft pull request against release/);
  assert.doesNotMatch(blocked.stderr, /HUSKY-RAN/, "refused before the repo's hook runs");
  assert.equal(push("refs/heads/develop").status, 1, "this checkout's base is protected");
  // Another checkout (another task) can push "develop" if it isn't its base.
  const other = join(dir, "other");
  spawnSync("git", ["init", "-q", "--template=", other]);
  const otherPush = spawnSync("sh", [join(hooks, "pre-push"), "origin", "x"], {
    cwd: other,
    input: "refs/heads/x 111 refs/heads/develop 000\n",
    encoding: "utf8",
    env: { ...process.env, BOAT_HOOKS_DIR: hooks },
  });
  assert.equal(otherPush.status, 0, "per-checkout lists don't leak across tasks");
  const allowed = push("refs/heads/boat/1a2b-fix");
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stderr, /HUSKY-RAN/, "the repo's own pre-push still runs");
  // Pass-through hooks run the repo's hook of the same name.
  writeFileSync(join(repo, ".husky", "_", "pre-commit"), "#!/bin/sh\necho PRE-COMMIT-RAN\n", { mode: 0o755 });
  writeFileSync(join(hooks, "pre-commit"), chainedHook("pre-commit"), { mode: 0o755 });
  const chained = spawnSync("sh", [join(hooks, "pre-commit")], { cwd: repo, encoding: "utf8", env: { ...process.env, BOAT_HOOKS_DIR: hooks } });
  assert.match(chained.stdout, /PRE-COMMIT-RAN/);
});

test("the pre-push hook lets pushes to a folder in the sandbox through, and checks everything else", () => {
  const dir = mkdtempSync(join(tmpdir(), "boat-hook-local-"));
  const hooks = join(dir, "boat-hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "protected"), "main\nmaster\n");
  writeFileSync(join(hooks, "pre-push"), prePushHook(), { mode: 0o755 });
  const repo = join(dir, "repo");
  spawnSync("git", ["init", "-q", "--template=", repo]);
  mkdirSync(join(repo, ".git", "hooks"));
  writeFileSync(join(repo, ".git", "hooks", "pre-push"), "#!/bin/sh\ncat >/dev/null\necho REPO-HOOK-RAN >&2\n", { mode: 0o755 });
  const hook = (url: string, remoteRef = "refs/heads/master") =>
    spawnSync("sh", [join(hooks, "pre-push"), "origin", url], {
      cwd: repo,
      input: `refs/heads/x 111 ${remoteRef} 000\n`,
      encoding: "utf8",
      env: { ...process.env, BOAT_HOOKS_DIR: hooks },
    });
  for (const url of ["/tmp/remote.git", "../remote.git", "remote.git", "file:///tmp/remote.git", "/tmp/odd:name.git"]) {
    const pushed = hook(url);
    assert.equal(pushed.status, 0, `${url}: ${pushed.stderr}`);
    assert.match(pushed.stderr, /REPO-HOOK-RAN/, `${url}: the repo's own pre-push still runs`);
  }
  for (const url of [
    "https://github.com/acme/web.git",
    "ssh://git@github.com/acme/web.git",
    "git@github.com:acme/web.git",
    "github.com:acme/web",
    "ext::sh -c x",
    "",
  ]) {
    const pushed = hook(url);
    assert.equal(pushed.status, 1, `${url || "(empty)"} is checked`);
    assert.match(pushed.stderr, /not allowed/);
  }

  // A project that ships after approval: GitHub refused, a local folder fine.
  writeFileSync(join(repo, ".git", "boat-no-push"), "");
  assert.match(hook("https://github.com/acme/web.git", "refs/heads/boat/1-x").stderr, /ships after the user approves/);
  assert.equal(hook("https://github.com/acme/web.git", "refs/heads/boat/1-x").status, 1);
  assert.equal(hook("/tmp/remote.git", "refs/heads/master").status, 0);

  // End to end, the way a repo's own test does it: git with the sandbox's
  // hooks path pushes HEAD:master to a temporary bare repo.
  const remote = join(dir, "remote.git");
  spawnSync("git", ["init", "-q", "--bare", "--template=", remote]);
  const work = join(dir, "work");
  spawnSync("git", ["init", "-q", "--template=", work]);
  const gitEnv = { ...process.env, ...BOAT_GIT_ENV, GIT_CONFIG_VALUE_0: hooks, BOAT_HOOKS_DIR: hooks };
  const git = (...args: string[]) => spawnSync("git", ["-C", work, ...args], { encoding: "utf8", env: gitEnv });
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x");
  git("remote", "add", "origin", remote);
  const local = git("push", "-q", "origin", "HEAD:master");
  assert.equal(local.status, 0, local.stderr);
  assert.equal(spawnSync("git", ["-C", remote, "rev-parse", "--verify", "-q", "master"]).status, 0, "the push landed");
  // Same branch through a transport that isn't a folder path (git's ext::
  // runs receive-pack locally, so no network): refused, nothing lands.
  const remote2 = join(dir, "remote2.git");
  spawnSync("git", ["init", "-q", "--bare", "--template=", remote2]);
  const other = git("-c", "protocol.ext.allow=always", "push", "-q", `ext::git %s ${remote2}`, "HEAD:master");
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /boat: pushing to master is not allowed/);
  assert.notEqual(spawnSync("git", ["-C", remote2, "rev-parse", "--verify", "-q", "master"]).status, 0, "nothing landed");
});

test("sandboxes the plugin creates point git at the plugin's hooks", async () => {
  const env = makeService();
  await env.service.launchTask({ title: "x", role: "implement", brief: "b", repo: "acme/web" }, 5_000);
  assert.deepEqual(env.boat.created[0]!.env, BOAT_GIT_ENV);
  assert.equal(BOAT_GIT_ENV.GIT_CONFIG_KEY_0, "core.hooksPath");
});

test("dispatches default to the orchestrator's project", async () => {
  const env = makeService();
  const project = toOrchestratorProject(
    normalizeProject({
      id: "storefront-api",
      name: "Storefront and API",
      repos: [
        { repo: "acme/storefront", baseBranch: "master" },
        { repo: "acme/api", baseBranch: "main" },
      ],
      environment: "storefront-api",
    }),
  );
  const { task } = await env.service.launchTask(
    { title: "New checkout page", role: "implement", brief: "Do it.", project, orchestratorThreadId: "thr_o" },
    5_000,
  );
  assert.equal(task.repo, "acme/storefront");
  assert.equal(task.baseBranch, "master");
  assert.equal(task.environment, "storefront-api");
  assert.equal(task.boatProject, "storefront-api");
  assert.deepEqual(task.extraRepos, [{ repo: "acme/api", baseBranch: "main", path: "/home/user/work/api" }]);
  assert.equal(env.boat.created[0]!.environment, "storefront-api");

  const [main, extra] = env.boat.prepared;
  assert.equal(main!.repo, "acme/storefront");
  assert.deepEqual(main!.checkout, { kind: "new-branch", branch: task.branch, base: "master" });
  assert.equal(extra!.repo, "acme/api");
  assert.deepEqual(extra!.checkout, { kind: "default-branch", base: "main" });
  for (const entry of env.boat.prepared) {
    assert.deepEqual([...(entry.options.protect ?? [])].sort(), ["main", "master"]);
    assert.deepEqual([...(entry.options.alwaysProtect ?? [])].sort(), ["main", "master"]);
    assert.equal(entry.options.workDir, task.id);
  }

  const prompt = env.boat.calls.find((call) => call.startsWith("prompt"));
  assert.ok(prompt);
});

test("a worker with a project never gets an empty workspace", async () => {
  const env = makeService();
  const project = toOrchestratorProject(
    normalizeProject({ name: "Docs site", repos: [{ repo: "acme/docs", baseBranch: "develop" }], environment: "docs" }),
  );
  let sent = "";
  const original = env.boat.prompt.bind(env.boat);
  env.boat.prompt = async (options) => {
    sent = options.prompt;
    return original(options);
  };
  await env.service.launchTask({ title: "Polish sidebar", role: "custom", brief: "b", project }, 5_000);
  assert.doesNotMatch(sent, /No repository was prepared/);
  assert.match(sent, /acme\/docs/);
  assert.match(sent, /Never push to `main`, `master`, `develop`/);
  assert.match(sent, /draft pull request against `develop`/);
  // Custom work gets its own branch too.
  assert.equal(env.boat.prepared[0]!.checkout.kind, "new-branch");
});

test("workers can't be pointed at a base branch", async () => {
  const env = makeService();
  const project = toOrchestratorProject(normalizeProject({ name: "Docs site", repos: [{ repo: "acme/docs", baseBranch: "develop" }] }));
  for (const branch of ["develop", "main", "master"]) {
    await assert.rejects(
      env.service.launchTask({ title: "x", role: "implement", brief: "b", project, branch }, 5_000),
      (error: unknown) => error instanceof TaskError && error.code === "invalid_branch",
      branch,
    );
  }
  assert.equal(env.boat.sandboxes.size, 0);
});

test("an explicit repo picks its own base branch from the project", async () => {
  const env = makeService();
  const project = toOrchestratorProject(
    normalizeProject({
      name: "Storefront and API",
      repos: [
        { repo: "acme/storefront", baseBranch: "master" },
        { repo: "acme/api", baseBranch: "main" },
      ],
    }),
  );
  const { task } = await env.service.launchTask({ title: "API fix", role: "implement", brief: "b", project, repo: "acme/api" }, 5_000);
  assert.equal(task.baseBranch, "main");
  assert.deepEqual(
    task.extraRepos.map(({ repo, baseBranch }) => ({ repo, baseBranch })),
    [{ repo: "acme/storefront", baseBranch: "master" }],
    "the other project repos come along",
  );
});

test("reviews inherit the implementer's project setup", async () => {
  const env = makeService();
  const project = toOrchestratorProject(
    normalizeProject({ name: "P", repos: [{ repo: "acme/web", baseBranch: "develop" }, { repo: "acme/lib", baseBranch: "main" }], environment: "web" }),
  );
  const { task } = await env.service.launchTask({ title: "Feature", role: "implement", brief: "b", project }, 5_000);
  env.boat.finish(task.conversationId!, "=== REPORT ===\nSTATUS: done\nPR: https://github.com/acme/web/pull/3\n=== END REPORT ===");
  await env.service.sweep();
  const { task: review } = await env.service.launchTask(await env.service.reviewInput(task.id), 5_000);
  assert.equal(review.environment, "web");
  assert.equal(review.baseBranch, "develop");
  assert.equal(review.boatProject, task.boatProject);
  assert.deepEqual(review.extraRepos, task.extraRepos);
});

test("metadata projects are validated (any agent can write metadata)", () => {
  const good = { id: "p", name: "P", repos: [{ repo: "acme/web", baseBranch: "main" }], environment: null, snapshot: null, protocolPath: null, source: "boat", bbProjectId: null };
  assert.equal(parseOrchestratorProject(good)?.repos[0]?.repo, "acme/web");
  assert.equal(parseOrchestratorProject({ ...good, repos: [{ repo: "acme/web", baseBranch: "$(rm -rf /)" }] }), null);
  assert.equal(parseOrchestratorProject({ ...good, repos: [] }), null);
  assert.equal(parseOrchestratorProject("nope"), null);
});

test("a local project uses its checked-out branch as the base", () => {
  const store = projectStore();
  store.save({ id: "docs", name: "Docs site", repos: [{ repo: "acme/docs", baseBranch: "develop" }], environment: "docs" });
  const local: LocalProject = {
    bbProjectId: "proj_1",
    name: "docs-dev",
    repo: "acme/docs",
    branch: "my-feature",
    unpushed: 0,
    branchMissingRemotely: false,
    path: "/home/me/docs",
    matchesProjectId: "docs",
    problem: null,
  };
  const project = localToOrchestratorProject(local, store);
  assert.deepEqual(project.repos, [{ repo: "acme/docs", baseBranch: "my-feature" }]);
  assert.equal(project.environment, "docs", "reuses the matching project's environment");
  assert.equal(project.source, "local");
  assert.equal(project.id, "local:proj_1");
});

test("the kickoff names the project and puts take-over notes after it", () => {
  const project = toOrchestratorProject(
    normalizeProject({ name: "Storefront", repos: [{ repo: "acme/storefront", baseBranch: "master" }], environment: "storefront" }),
  );
  const prompt = kickoffPrompt({ project, prompt: "Fix the header.", takeOverSection: "## Taking over from @thread:thr_old" });
  assert.match(prompt, /Project: Storefront\n- Main repo: acme\/storefront \(base branch master\)\n- boat environment: storefront/);
  assert.ok(prompt.indexOf("Taking over") < prompt.indexOf("Request:\nFix the header."));
});

test("a project whose boat environment doesn't exist fails with a fix, before any sandbox", async () => {
  const env = makeService();
  env.boat.environmentNames = ["base"];
  const project = toOrchestratorProject(
    normalizeProject({ name: "Docs site", repos: [{ repo: "acme/docs", baseBranch: "develop" }], environment: "docs" }),
  );
  await assert.rejects(
    env.service.launchTask({ title: "x", role: "implement", brief: "b", project }, 5_000),
    (error: unknown) =>
      error instanceof TaskError && error.code === "environment_missing" && /boat env new docs/.test(error.hint ?? ""),
  );
  assert.equal(env.boat.sandboxes.size, 0);
});

test("a fresh sandbox of its own reuses the environment's checkout", async () => {
  const env = makeService();
  const project = toOrchestratorProject(
    normalizeProject({ name: "Storefront", repos: [{ repo: "acme/storefront", baseBranch: "master" }], environment: "storefront" }),
  );
  await env.service.launchTask({ title: "x", role: "implement", brief: "b", project }, 5_000);
  assert.equal(env.boat.prepared[0]!.options.useEnvironmentCheckout, true);
  const mine = await env.boat.create({ name: "mine", type: "default" });
  await env.service.launchTask({ title: "y", role: "implement", brief: "b", project, sandbox: mine.id }, 5_000);
  assert.equal(env.boat.prepared.at(-1)!.options.useEnvironmentCheckout, false, "never in a shared or borrowed sandbox");
});

test("a project snapshot starts worker sandboxes from it", async () => {
  const env = makeService();
  const project = toOrchestratorProject(
    normalizeProject({ name: "P", repos: [{ repo: "acme/web", baseBranch: "main" }], snapshot: "web-deps" }),
  );
  const { task } = await env.service.launchTask({ title: "x", role: "implement", brief: "b", project }, 5_000);
  assert.equal(env.boat.created[0]!.from, "web-deps");
  // The history says so (a live check could only tell from the plugin's store).
  assert.ok(env.store.events(task.id, 50).some((event) => event.kind === "sandbox" && / from snapshot web-deps$/.test(event.text)));
});

test("Push branch first only pushes the branch the dialog showed, never a base", () => {
  const local: LocalProject = {
    bbProjectId: "proj_1",
    name: "x",
    repo: "acme/web",
    branch: "feature",
    unpushed: 2,
    branchMissingRemotely: false,
    path: "/tmp/x",
    matchesProjectId: null,
    problem: null,
  };
  assert.equal(pushRefusal(local, "feature", protectedBranches(null)), null);
  assert.match(pushRefusal(local, "other", protectedBranches(null)) ?? "", /on feature now, not other/);
  assert.match(pushRefusal({ ...local, branch: "main" }, "main", protectedBranches(null)) ?? "", /base branch/);
  assert.match(
    pushRefusal({ ...local, branch: "release" }, "release", protectedBranches({ repos: [{ repo: "acme/web", baseBranch: "release" }] })) ?? "",
    /base branch/,
  );
  // An extra protected branch from the settings counts too.
  assert.match(pushRefusal({ ...local, branch: "staging" }, "staging", protectedBranches(null, [], alwaysProtectedBranches(["staging"]))) ?? "", /base branch/);
});

test("extra protected branches reach the hook lists, the brief and the branch check", async () => {
  const env = makeService({ settings: { extraProtectedBranches: ["staging", "release/eu"] } });
  const project = toOrchestratorProject(normalizeProject({ name: "Web app", repos: [{ repo: "acme/web", baseBranch: "develop" }] }));
  let sent = "";
  const original = env.boat.prompt.bind(env.boat);
  env.boat.prompt = async (options) => {
    sent = options.prompt;
    return original(options);
  };
  await env.service.launchTask({ title: "x", role: "implement", brief: "b", project }, 5_000);
  const prepared = env.boat.prepared[0]!;
  assert.deepEqual([...(prepared.options.alwaysProtect ?? [])].sort(), ["main", "master", "release/eu", "staging"]);
  assert.deepEqual([...(prepared.options.protect ?? [])].sort(), ["develop", "main", "master", "release/eu", "staging"]);
  assert.match(sent, /Never push to `main`, `master`, `staging`, `release\/eu`, `develop`/);
  await assert.rejects(
    env.service.launchTask({ title: "y", role: "implement", brief: "b", project, branch: "staging" }, 5_000),
    (error: unknown) => error instanceof TaskError && error.code === "invalid_branch",
  );
});

test("a project's protected branches and instructions: in its tasks' hook lists and briefs, and in its reviews'", async () => {
  const env = makeService({ settings: { workerInstructions: "Keep commits small." } });
  // Reviews have no project of their own: the plugin looks it up by the implementer's.
  (env.service as unknown as { hooks: { projectInstructions: (id: string | null, repo: string | null) => string[] } }).hooks.projectInstructions = (id) =>
    id === "web" ? ["Use pnpm."] : [];
  const project = toOrchestratorProject(
    normalizeProject({ id: "web", name: "Web app", repos: [{ repo: "acme/web", baseBranch: "main" }], protectedBranches: "release", instructions: " Use pnpm. " }),
  );
  assert.deepEqual(project.protectedBranches, ["release"]);
  const sent: string[] = [];
  const original = env.boat.prompt.bind(env.boat);
  env.boat.prompt = async (options) => {
    sent.push(options.prompt);
    return original(options);
  };
  const { task } = await env.service.launchTask({ title: "x", role: "implement", brief: "b", project }, 5_000);
  assert.ok(env.boat.prepared[0]!.options.protect?.includes("release"));
  assert.match(sent[0]!, /Never push to `main`, `master`, `release`/);
  assert.match(sent[0]!, /## Standing instructions\nKeep commits small\.\n\nUse pnpm\./);
  env.boat.finish(task.conversationId!, "=== REPORT ===\nSTATUS: done\nPR: https://github.com/acme/web/pull/3\n=== END REPORT ===");
  await env.service.sweep();
  await env.service.launchTask(await env.service.reviewInput(task.id, { sandbox: "new" }), 5_000);
  assert.match(sent.at(-1)!, /Use pnpm\./);
});

test("older orchestrator metadata has no protected branches or instructions; bad names are dropped", () => {
  const old = { id: "p", name: "P", repos: [{ repo: "acme/web", baseBranch: "main" }], environment: null, snapshot: null, protocolPath: null, source: "boat", bbProjectId: null };
  const parsed = parseOrchestratorProject(old)!;
  assert.deepEqual(parsed.protectedBranches, []);
  assert.equal(parsed.instructions, "");
  assert.deepEqual(parseOrchestratorProject({ ...old, protectedBranches: ["release", "not a branch"], instructions: "x" })?.protectedBranches, ["release"]);
  assert.throws(() => normalizeProject({ name: "P", repos: [{ repo: "acme/web", baseBranch: "main" }], protectedBranches: ["ok", "-bad"] }), /"-bad" isn't a branch name/);
  assert.deepEqual(normalizeProject({ name: "P", repos: [{ repo: "acme/web", baseBranch: "main" }] }).protectedBranches, []);
  assert.equal(normalizeProject({ name: "P", repos: [{ repo: "acme/web", baseBranch: "main" }] }).instructions, "");
});

test("the sandbox-wide protected list is main, master and the extra branches", async () => {
  const scripts: string[] = [];
  class CapturingApi extends BoatApi {
    override async exec(_id: string, command: string) {
      scripts.push(command);
      return { exitCode: 0, stdout: "BOAT_ACCESS ok push=true\nBOAT_SETUP path=/home/user/work/web branch=feature base=main\n", stderr: "" };
    }
  }
  const api = new CapturingApi(new BoatCli(async () => null));
  await api.prepareRepo("bx_1", "acme/web", { kind: "new-branch", branch: "feature", base: "main" }, { protect: ["main"], alwaysProtect: ["main", "master", "staging"] });
  assert.match(scripts[0]!, /printf '%s\\n' 'main' 'master' 'staging'; \} \| grep -v '\^\$' \| sort -u > "\$HOOKS\/protected\.new"/);
  // Without the option: only the defaults.
  await api.prepareRepo("bx_1", "acme/web", { kind: "default-branch", base: "main" });
  assert.match(scripts[1]!, /printf '%s\\n' 'main' 'master'; \}/);
});

test("a project's sandbox size: kept, cleared, unchanged when omitted, checked; older projects have none", () => {
  const store = projectStore();
  const saved = store.save({ name: "Web app", repos: [{ repo: "acme/web", baseBranch: "main" }], machineType: "large" });
  assert.equal(saved.machineType, "large");
  // Omitted: unchanged.
  assert.equal(store.save({ id: saved.id, name: "Web app", repos: saved.repos, instructions: "x" }).machineType, "large");
  // null: back to the setting.
  assert.equal(store.save({ id: saved.id, name: "Web app", repos: saved.repos, machineType: null }).machineType, null);
  assert.throws(() => normalizeProject({ name: "x", repos: [{ repo: "a/b", baseBranch: "main" }], machineType: "huge" as never }));
  // Saved before the field existed.
  const legacy = normalizeProject({ name: "Old", repos: [{ repo: "a/b", baseBranch: "main" }] }) as unknown as Record<string, unknown>;
  delete legacy.machineType;
  const db = new DatabaseSync(":memory:");
  for (const statement of TaskStore.migrations()) db.exec(statement);
  db.prepare("INSERT INTO projects (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)").run("old", JSON.stringify(legacy), "x", "x");
  assert.equal(new ProjectStore(() => db as unknown as Database.Database).get("old")?.machineType, null);
});

test("new sandboxes take their project's size; an explicit size wins; reviews and repo matches follow it", async () => {
  const projects = [{ id: "web", name: "Web app", repos: [{ repo: "acme/web" }], machineType: "large" as const }];
  const env = makeService({ projects });
  env.boat.limitsValue = { ...env.boat.limitsValue, maxActiveSandboxes: 10 };
  const project = { ...toOrchestratorProject(normalizeProject({ id: "web", name: "Web app", repos: [{ repo: "acme/web", baseBranch: "main" }] })) };
  const { task } = await env.service.launchTask({ title: "A", role: "implement", brief: "x", project }, 5_000);
  assert.equal(env.boat.created[0]!.type, "large");
  assert.ok(env.store.events(task.id).some((event) => event.kind === "sandbox-size" && event.text === "Large sandbox, from project Web app"));

  await env.service.launchTask({ title: "B", role: "implement", brief: "x", project, machineType: "small" }, 5_000);
  assert.equal(env.boat.created[1]!.type, "small");

  // A review in a new sandbox: the project's size.
  env.boat.finish(task.conversationId!, "=== REPORT ===\nSTATUS: done\n=== END REPORT ===");
  await env.service.sweep();
  env.setSettings({ reviewSandbox: "new" });
  await env.service.launchTask(await env.service.reviewInput(task.id), 5_000);
  assert.equal(env.boat.created[2]!.type, "large");

  // No project given, but its main repo: that project.
  await env.service.launchTask({ title: "C", role: "implement", brief: "x", repo: "acme/web" }, 5_000);
  assert.equal(env.boat.created[3]!.type, "large");
  // A repo no project has as its main one: the setting.
  await env.service.launchTask({ title: "D", role: "implement", brief: "x", repo: "acme/other" }, 5_000);
  assert.equal(env.boat.created[4]!.type, "default");
});

test("a size the plan doesn't have: refused when asked for, the setting with a note when it's the project's", async () => {
  const trial = [
    { type: "small", available: true, reason: null },
    { type: "default", available: true, reason: null },
    { type: "large", available: false, reason: "not during the free trial; the first payment unlocks it" },
    { type: "xlarge", available: false, reason: "needs the $100/month plan or higher" },
  ];
  const env = makeService({ plan: trial, projects: [{ id: "web", name: "Web app", repos: [{ repo: "acme/web" }], machineType: "large" }] });
  const { task } = await env.service.launchTask({ title: "A", role: "implement", brief: "x", repo: "acme/web" }, 5_000);
  assert.equal(env.boat.created[0]!.type, "default");
  assert.ok(
    env.store
      .events(task.id)
      .some((event) => event.text === "Web app uses Large sandboxes, but your boat plan doesn't include Large (not during the free trial; the first payment unlocks it). This sandbox is Default."),
  );
  await assert.rejects(
    env.service.launchTask({ title: "B", role: "implement", brief: "x", repo: "acme/web", machineType: "large" }, 5_000),
    (error: unknown) => error instanceof TaskError && error.code === "size_not_on_plan" && /doesn't include Large sandboxes/.test(error.message),
  );
  assert.equal(env.boat.created.length, 1, "nothing started for the refused one");
  assert.equal(env.store.list({ limit: 10 }).length, 1, "no task record either");
});

test("a review in a new sandbox gets at least its task's current size", async () => {
  const env = makeService({ settings: { reviewSandbox: "new" } });
  const { task } = await env.service.launchTask({ title: "A", role: "implement", brief: "x", repo: "acme/web", machineType: "large" }, 5_000);
  env.boat.finish(task.conversationId!, "=== REPORT ===\nSTATUS: done\n=== END REPORT ===");
  await env.service.sweep();
  const review = await env.service.launchTask(await env.service.reviewInput(task.id), 5_000);
  assert.equal(env.boat.created[1]!.type, "large");
  assert.ok(env.store.events(review.task.id).some((event) => event.text === `Large sandbox, like task ${task.id}'s`));
});
