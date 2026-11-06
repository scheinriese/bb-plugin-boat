// Regressions from the P6 review.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GITHUB_ACCESS_SNIPPET, envNames, parseGithubAccess } from "../src/boat-api.ts";
import { BoatError } from "../src/boat.ts";
import type { OrchestratorProject } from "../src/projects.ts";
import { TaskError } from "../src/service.ts";
import { makeService } from "./fakes.ts";

const REPORT = "Done.\n=== REPORT ===\nSTATUS: done\n=== END REPORT ===";

test("secret names never pick up pieces of a value", () => {
  // Fake values; the key markers are split so secret scanners don't flag the file.
  const begin = "-----BEGIN " + "PRIVATE KEY-----";
  const end = "-----END " + "PRIVATE KEY-----";
  const contents = [
    "export API_KEY=example-value",
    `PRIVATE_KEY="${begin}`,
    "fake-key-body-not-base64",
    "password=example-password",
    `${end}"`,
    "SINGLE='first line",
    "TOKEN=not-a-name",
    "'",
    "# COMMENTED=x",
    "WINDOWS=crlf\r",
    'ESCAPED="a \\" quote',
    'STILL_VALUE=x"',
    "AFTER=1",
  ].join("\n");
  assert.deepEqual(envNames(contents), ["API_KEY", "PRIVATE_KEY", "SINGLE", "WINDOWS", "ESCAPED", "AFTER"]);
});

test("GitHub's answers each get the right advice", () => {
  const dir = mkdtempSync(join(tmpdir(), "boat-gh-"));
  const gh = join(dir, "gh");
  const run = (stderr: string) => {
    writeFileSync(gh, `#!/bin/sh\ncase "$*" in *"-i user"*) exit 1 ;; esac\necho '${stderr}' >&2\nexit 1\n`);
    chmodSync(gh, 0o755);
    return execFileSync("bash", ["-c", `REPO=acme/web\n${GITHUB_ACCESS_SNIPPET}`], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  };
  // A rate limit isn't a missing install: the clone goes ahead.
  assert.deepEqual(parseGithubAccess(run("gh: API rate limit exceeded for installation (HTTP 403)"), "acme/web"), { canPush: null, githubExpiresAt: null });
  // SAML: GitHub's own words.
  assert.throws(
    () => parseGithubAccess(run("gh: Resource protected by organization SAML enforcement. (HTTP 403)"), "acme/web"),
    (error: unknown) => error instanceof BoatError && /GitHub refused boat's access to acme\/web: gh: Resource protected by organization SAML enforcement/.test(error.message),
  );
  // Not found: install the app, or check the name.
  assert.throws(() => parseGithubAccess(run("gh: Not Found (HTTP 404)"), "acme/web"), /Connect GitHub on boat\.dev → Environment and give boat access to acme\/web .*on acme\), or check the repo name/);
  // No login at all.
  assert.throws(
    () => parseGithubAccess(run("To get started with GitHub CLI, please run:  gh auth login"), "acme/web", "web"),
    /no GitHub login\. Connect GitHub on boat\.dev → Environment and give boat access to this repo \(or turn off "Safe for third parties" for `web`\)/,
  );
  // Expired: the environment is named.
  assert.throws(() => parseGithubAccess(run("gh: Bad credentials (HTTP 401)"), "acme/web", "web"), /boat env upgrade web/);
});

const PROJECT: OrchestratorProject = {
  id: "web",
  name: "Web",
  repos: [{ repo: "acme/web", baseBranch: "main" }],
  environment: "web",
  snapshot: null,
  protocolPath: null,
  workerMode: "boat",
  delivery: "pr",
  source: "boat",
  protectedBranches: [],
  instructions: "",
  bbProjectId: null,
};

test("read-only access stops implementers, not reviews or custom work that doesn't ship", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 10;
  env.boat.canPush["acme/web"] = false;
  const base = { title: "x", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch", project: PROJECT };
  await assert.rejects(
    env.service.launchTask({ ...base, role: "implement" }, 5_000),
    (error: unknown) => error instanceof TaskError && error.code === "repo_read_only" && /Your GitHub account needs write access to acme\/web/.test(error.hint ?? ""),
  );
  const custom = await env.service.launchTask({ ...base, role: "custom" }, 5_000);
  assert.equal(custom.task.status, "running");
  // In a project that ships after approval, custom work ships too: it needs to push.
  await assert.rejects(env.service.launchTask({ ...base, role: "custom", project: { ...PROJECT, delivery: "push" } }, 5_000), (error: unknown) => error instanceof TaskError && error.code === "repo_read_only");
});

test("a chat worker's sleeping machine is woken to check an expired login before the follow-up", async () => {
  const env = makeService({ chat: true });
  env.boat.ghExpires = "2020-01-01T00:00:00.000Z";
  const { task } = await env.service.launchTask(
    { title: "x", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch", project: { ...PROJECT, workerMode: "chat" } },
    5_000,
  );
  await env.service.sweep();
  env.chat.finish(env.store.get(task.id)!.threadId!, REPORT);
  await env.service.sweep();
  // The machine went to sleep; bb wakes it on resume.
  const sandboxId = env.store.get(task.id)!.sandboxId!;
  await env.boat.stop(sandboxId);
  const resume = env.chat.resumeMachine.bind(env.chat);
  env.chat.resumeMachine = async (hostId: string) => {
    await resume(hostId);
    env.boat.sandboxes.get(sandboxId)!.state = "idle";
  };
  env.boat.login = { valid: false, expiresAt: null };
  await assert.rejects(env.service.followup(task.id, "Fix it."), (error: unknown) => error instanceof TaskError && error.code === "github_token_expired" && /boat env upgrade web/.test(error.hint ?? ""));
  assert.equal(env.boat.loginChecks.length, 1);
  assert.ok(env.chat.resumed.length > 0);
  // Refreshed meanwhile: the follow-up goes out.
  env.boat.login = { valid: true, expiresAt: "2099-01-01T00:00:00.000Z" };
  const sent = await env.service.followup(task.id, "Fix it.");
  assert.equal(sent.status, "running");
});

test("a review in the implementer's sandbox inherits its token expiry; a ship hint keeps the work", async () => {
  const env = makeService();
  env.boat.limitsValue.maxActiveSandboxes = 10;
  env.boat.ghExpires = "2020-01-01T00:00:00.000Z";
  const project = { ...PROJECT, delivery: "push" as const };
  const { task } = await env.service.launchTask({ title: "x", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch", project }, 5_000);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  env.boat.login = { valid: false, expiresAt: null };
  await assert.rejects(
    env.service.shipTask(task.id, { approval: "test" }),
    (error: unknown) =>
      error instanceof TaskError && error.code === "github_token_expired" && /can't push the approved work/.test(error.message) && /Don't close this task or delete its sandbox/.test(error.hint ?? ""),
  );
  // The review shares the sandbox (push work); a PR-project review would need GitHub.
  const pr = makeService();
  pr.boat.limitsValue.maxActiveSandboxes = 10;
  pr.boat.ghExpires = "2020-01-01T00:00:00.000Z";
  const impl = await pr.service.launchTask({ title: "x", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch", project: PROJECT }, 5_000);
  pr.boat.finish(impl.task.conversationId!, REPORT);
  await pr.service.sweep();
  const { task: review } = await pr.service.launchTask({ ...(await pr.service.reviewInput(impl.task.id)), sandbox: "same" }, 5_000);
  pr.boat.finish(review.conversationId!, "=== REVIEW ===\nVERDICT: approve\n=== END REVIEW ===");
  await pr.service.sweep();
  pr.boat.login = { valid: false, expiresAt: null };
  await assert.rejects(pr.service.followup(review.id, "Check again."), (error: unknown) => error instanceof TaskError && error.code === "github_token_expired");
});

test("a project without an environment shows boat's default one", async () => {
  const env = makeService();
  const access = await env.service.projectAccess({ repos: PROJECT.repos, environment: null });
  assert.equal(access.environment, "base");
  assert.deepEqual(access.secretNames, ["A_KEY"]);
});
