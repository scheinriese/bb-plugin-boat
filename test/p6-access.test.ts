// P6: repo access checked inside the sandbox before dispatching, expired
// GitHub logins caught before follow-ups, and environment secret NAMES only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import plugin from "../server.ts";
import { createTestHost } from "./fakes.ts";
import { GITHUB_ACCESS_SNIPPET, parseGithubAccess } from "../src/boat-api.ts";
import { BoatError } from "../src/boat.ts";

const fakeBoat = fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url));

async function setup(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), "boat-p6-test-"));
  const statePath = join(dir, "state.json");
  process.env.FAKE_BOAT_STATE = statePath;
  const { bb, harness } = await createTestHost({
    pluginId: "boat",
    settings: { boatPath: fakeBoat, evidenceUploader: "" },
    agentSkillIds: ["boat", "boat-orchestrator"],
  });
  t.after(() => harness.lifecycle.dispose());
  harness.sdk.stub("threads.get", async () => ({ id: "thr_orch", environmentId: null, deletedAt: null, archivedAt: null }));
  harness.sdk.stub("threads.send", async () => ({ ok: true, delivery: "sent" }));
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "orchestrator" }));
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
  await plugin(bb);
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const edit = (change: (current: Record<string, any>) => void) => {
    const current = existsState(statePath) ? state() : { sandboxes: {}, convos: {}, calls: [], next: 1 };
    change(current);
    writeFileSync(statePath, JSON.stringify(current));
  };
  return { harness, state, edit };
}

function existsState(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

test("the access check's shell, run for real against a fake gh", () => {
  const dir = mkdtempSync(join(tmpdir(), "boat-gh-"));
  const gh = join(dir, "gh");
  const run = (behaviour: string) => {
    writeFileSync(gh, `#!/bin/sh\n${behaviour}\n`);
    chmodSync(gh, 0o755);
    return execFileSync("bash", ["-c", `REPO=acme/web\n${GITHUB_ACCESS_SNIPPET}`], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  };
  // Can push; the token's expiry comes from GitHub's header.
  const ok = run(`case "$*" in *"-i user"*) printf 'HTTP/2.0 200 OK\\r\\nGithub-Authentication-Token-Expiration: 2026-11-06 04:49:57 UTC\\r\\n\\r\\n{}' ;; *) echo 'true true' ;; esac`);
  assert.match(ok, /^BOAT_ACCESS ok push=true$/m);
  assert.deepEqual(parseGithubAccess(ok, "acme/web"), { canPush: true, githubExpiresAt: "2026-11-06T04:49:57.000Z" });
  // Read only.
  assert.equal(parseGithubAccess(run("echo 'false true'"), "acme/web").canPush, false);
  // Not visible to boat's GitHub App: exactly what to fix.
  const none = run(`echo 'gh: Not Found (HTTP 404)' >&2; exit 1`);
  assert.match(none, /^BOAT_ACCESS none$/m);
  assert.throws(() => parseGithubAccess(none, "acme/web"), (error: unknown) => error instanceof BoatError && error.code === "repo_access" && /Connect GitHub on boat\.dev → Environment and give boat access to acme\/web/.test(error.message));
  // An expired login.
  const expired = run(`echo 'gh: Bad credentials (HTTP 401)' >&2; exit 1`);
  assert.throws(() => parseGithubAccess(expired, "acme/web"), (error: unknown) => error instanceof BoatError && error.code === "github_token_expired");
});

test("dispatch stops with what to fix when boat can't see the repo, can't push, or the login expired", async (t) => {
  const { harness, edit } = await setup(t);
  edit((current) => {
    current.access = { "acme/private": "none", "acme/readonly": "ok false", "acme/stale": "expired" };
  });
  const start = (repo: string, role = "implement") =>
    harness.runCli(["task", "start", "--title", "x", "--repo", repo, "--role", role, "--brief", "Do it.", "--json"], { threadId: "thr_orch" });
  const output = (result: { stdout: string; stderr: string }) => `${result.stdout}${result.stderr}`;
  assert.match(output(await start("acme/private")), /give boat access to acme\/private/);
  assert.match(output(await start("acme/readonly")), /can read acme\/readonly but not push to it/);
  assert.match(output(await start("acme/stale")), /GitHub login has expired \(boat's GitHub tokens last about 8 hours\)/);
  // A review only reads: read-only access is enough.
  const review = await start("acme/readonly", "review");
  assert.equal(JSON.parse(review.stdout).task.status, "running");

  // bb boat status shows it per project, and the environment's secret NAMES only.
  const added = await harness.runCli(["project", "add", "--name", "Storefront", "--repo", "acme/storefront@master", "--environment", "storefront"]);
  assert.equal(added.exitCode, 0, added.stderr);
  const status = await harness.runCli(["status"]);
  assert.match(status.stdout, /Access:\n- Storefront: environment storefront: 2 secrets \(EXAMPLE_ACCOUNT_ID, EXAMPLE_SECRET_KEY\), files \.env\.local/);
  assert.match(status.stdout, /acme\/storefront: write in the environment \(not checked in a sandbox yet\)/);
  const json = await harness.runCli(["status", "--json"]);
  for (const text of [status.stdout, json.stdout]) {
    assert.doesNotMatch(text, /fake_value/);
  }
  const rpc = (await harness.callRpc("projectAccess", { projectId: "storefront" })) as { secretNames: string[] };
  assert.deepEqual(rpc.secretNames, ["EXAMPLE_ACCOUNT_ID", "EXAMPLE_SECRET_KEY"]);
  assert.doesNotMatch(JSON.stringify(rpc), /fake_value/);
});

test("a project's access names boat credentials and real AI keys; quiet with them off and the proxy on", async (t) => {
  type Access = { passSandboxCredentials: boolean | null; passAgentsCredentials: boolean | null; aiProxy: boolean | null; aiProxyPrice: string | null };
  // boat credentials off, the AI proxy on: nothing to warn about.
  const quiet = await setup(t);
  await quiet.harness.runCli(["project", "add", "--name", "Storefront", "--repo", "acme/storefront@master", "--environment", "storefront"]);
  const calm = (await quiet.harness.callRpc("projectAccess", { projectId: "storefront" })) as Access;
  assert.deepEqual({ ...calm }, { ...calm, passSandboxCredentials: false, passAgentsCredentials: true, aiProxy: true });
  const calmStatus = await quiet.harness.runCli(["status"]);
  assert.match(calmStatus.stdout, /- Storefront: environment storefront: 2 secrets/);
  assert.doesNotMatch(calmStatus.stdout, /boat credentials are passed in|real AI keys/);

  // Both passed in.
  const loud = await setup(t);
  loud.edit((current) => {
    current.boatCredentials = true;
    current.aiProxy = false;
  });
  await loud.harness.runCli(["project", "add", "--name", "Storefront", "--repo", "acme/storefront@master", "--environment", "storefront"]);
  const access = (await loud.harness.callRpc("projectAccess", { projectId: "storefront" })) as Access;
  assert.equal(access.passSandboxCredentials, true);
  assert.equal(access.aiProxy, false);
  assert.equal(access.aiProxyPrice, "about $1 a day plus $1 per 1,000 requests");
  const status = await loud.harness.runCli(["status"]);
  assert.match(status.stdout, /; boat credentials are passed in: workers can start, stop and delete any of your sandboxes; real AI keys are passed in \(`boat ai proxy on` passes placeholders: a paid add-on, about \$1 a day plus \$1 per 1,000 requests\)\n/);
  assert.doesNotMatch(status.stdout, /fake_value/);
});

test("a follow-up on a sandbox whose GitHub login expired is stopped with what to do", async (t) => {
  const { harness, edit, state } = await setup(t);
  edit((current) => {
    current.ghExpires = "2020-01-01 00:00:00 UTC";
  });
  const started = await harness.runCli(["task", "start", "--title", "x", "--repo", "acme/web", "--brief", "Do it.", "--json"], { threadId: "thr_orch" });
  const { task } = JSON.parse(started.stdout) as { task: { id: string } };
  edit((current) => {
    for (const convo of Object.values(current.convos) as { running: boolean; reply: string | null; sandboxId: string }[]) {
      convo.running = false;
      convo.reply = "Done.\n=== REPORT ===\nSTATUS: done\n=== END REPORT ===";
      current.sandboxes[convo.sandboxId].state = "idle";
    }
    current.loginExpired = true;
  });
  await harness.runCli(["task", "show", task.id, "--refresh"]);
  const followup = await harness.runCli(["task", "followup", task.id, "--message", "Fix the nit."], { threadId: "thr_orch" });
  assert.notEqual(followup.exitCode, 0);
  assert.match(`${followup.stdout}${followup.stderr}`, /expired GitHub login \(boat's GitHub tokens last about 8 hours[\s\S]*boat env upgrade/);
  // boat refreshed it: the follow-up goes through.
  edit((current) => {
    current.loginExpired = false;
  });
  const retried = await harness.runCli(["task", "followup", task.id, "--message", "Fix the nit."], { threadId: "thr_orch" });
  assert.equal(retried.exitCode, 0, retried.stderr || retried.stdout);
  void state;
});

test("task followup needs a message, except --evidence-only", async (t) => {
  const { harness, edit } = await setup(t);
  const started = await harness.runCli(["task", "start", "--title", "x", "--repo", "acme/web", "--brief", "Do it.", "--json"], { threadId: "thr_orch" });
  const { task } = JSON.parse(started.stdout) as { task: { id: string } };
  edit((current) => {
    for (const convo of Object.values(current.convos) as { running: boolean; reply: string | null; sandboxId: string }[]) {
      convo.running = false;
      convo.reply = "Done.\n=== REPORT ===\nSTATUS: done\n=== END REPORT ===";
      current.sandboxes[convo.sandboxId].state = "idle";
    }
  });
  await harness.runCli(["task", "show", task.id, "--refresh"]);
  const bare = await harness.runCli(["task", "followup", task.id], { threadId: "thr_orch" });
  assert.notEqual(bare.exitCode, 0);
  assert.match(`${bare.stdout}${bare.stderr}`, /--message/);
  // It gets past the options: this sandbox has no uploader (uploads are off).
  const evidence = await harness.runCli(["task", "followup", task.id, "--evidence-only", "--json"], { threadId: "thr_orch" });
  assert.notEqual(evidence.exitCode, 0);
  assert.equal(JSON.parse(evidence.stdout).error.code, "evidence_unavailable");
});
