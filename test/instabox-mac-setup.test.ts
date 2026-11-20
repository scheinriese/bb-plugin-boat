import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createCredentialSource } from "../src/credentials.ts";
import { MAC_BOOTSTRAP } from "../src/providers/mac-bootstrap.ts";
import { createInstaboxProvider } from "../src/providers/instabox/provider.ts";
import { InstaboxCli } from "../src/providers/instabox/cli.ts";
import { InstaboxRest } from "../src/providers/instabox/api.ts";
import { prepareRepo } from "../src/sandbox-repos.ts";
import { memoryStore } from "./fakes.ts";
// @ts-expect-error plain JavaScript fixture
import { startFakeInstaboxApi } from "../src/providers/instabox/fixtures/fake-api.mjs";

const cliPath = fileURLToPath(new URL("../src/providers/instabox/fixtures/fake-instabox.mjs", import.meta.url));
async function fixture(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), "instabox-mac-setup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, "state.json"), store = memoryStore();
  const key = randomBytes(24).toString("hex"), token = randomBytes(24).toString("hex");
  const startedAt = new Date(Date.now() - 60_000).toISOString(), paidUntil = new Date(Date.now() + 23 * 3600_000).toISOString();
  const machine = { id: "m_fakemac", name: "bb-existing-mac", state: "running", template: { id: "macos" }, model: "m2", spec: { vcpus: 8, memMiB: 16384 }, metadata: { "created-by": "bb-boat" }, runtime: { ready: true }, lease: { id: "fake-lease", startedAt, chargeUntil: paidUntil, hourUSD: 0.45 }, deleteAt: paidUntil, envNames: [] };
  writeFileSync(statePath, JSON.stringify({ machines: { [machine.id]: machine } }));
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const patch = (data: Record<string, unknown>) => writeFileSync(statePath, JSON.stringify({ ...state(), ...data }));
  process.env.FAKE_INSTABOX_STATE = statePath;
  process.env.FAKE_INSTABOX_KEY = key;
  const api = await startFakeInstaboxApi({ statePath, key });
  t.after(() => api.close());
  const rest = new InstaboxRest({ key: async () => key, baseUrl: () => api.url });
  const cli = new InstaboxCli(async () => cliPath, async () => key);
  let route = true;
  const credentials = createCredentialSource({ githubToken: async () => token, agentAvailable: async () => route, fetch: async () => new Response(JSON.stringify({ permissions: { push: true, pull: true } }), { headers: { "github-authentication-token-expiration": new Date(Date.now() + 86400_000).toISOString() } }) });
  const provider = createInstaboxProvider(cli, rest, { ledger: store.macLeases, credentials });
  await provider.info(machine.id); // Register this already paid physical lease.
  return { dir, store, machine, state, patch, api, rest, cli, credentials, provider, token, key, setRoute: (value: boolean) => { route = value; } };
}

test("an existing Instabox Mac prepares its repository through private managed credentials, without Linux Secrets", async t => {
  const env = await fixture(t);
  // The provider contract that rejected the old beforeRepo implementation.
  await assert.rejects(env.cli.run(["secrets", "select", env.machine.id, "--secrets", "all", "--json"]), { code: "bad_request" });
  const callsBefore = env.state().calls.length;
  await env.provider.assertTaskReady!({ agent: "codex", runner: "chat", repos: ["acme/web"], sandboxId: env.machine.id });
  const prepared = await prepareRepo(env.provider, env.machine.id, "acme/web", { kind: "default-branch" });
  assert.equal(prepared.canPush, true);
  assert.match(prepared.path, /fake-mac-home\/work\/web$/);
  const calls: string[] = env.state().calls.slice(callsBefore);
  assert.equal(calls.some(call => call.startsWith("secrets ")), false);
  assert.equal(calls.some(call => /^(create|start|resume|stop|rm) /.test(call)), false);
  assert.equal(env.state().machines[env.machine.id].deleteAt, env.machine.deleteAt);
  assert.equal(env.store.macLeases.list().length, 1);
  assert.equal(env.store.macLeases.held()[0]!.releaseAt, env.machine.deleteAt);
  assert.equal(env.store.macLeases.hasGithubDeliveryRecord(env.store.macLeases.held()[0]!.id), true);
  const requests = env.api.received.filter((entry: any) => entry.path.endsWith("/exec"));
  assert.ok(requests.some((entry: any) => entry.body.cmd.includes("gh auth login") && entry.body.stdin === `[${env.token.length + 1} chars]`));
  assert.ok(requests.every((entry: any) => entry.body.noHistory === true));
  assert.ok(requests.every((entry: any) => !entry.body.cmd.includes("systemctl") && !entry.body.cmd.includes("loginctl")));
  assert.ok(!JSON.stringify([env.state(), env.api.received]).includes(env.token));
  assert.ok(!JSON.stringify([env.state(), env.api.received]).includes(env.key));
});

test("Mac enrollment prepares tools without credential stdin or Linux service setup", async t => {
  const env = await fixture(t);
  await env.provider.machineHooks!({ debug() {}, warn() {} }).beforeBootstrap!(env.machine.id);
  assert.equal(env.api.received.length, 1);
  assert.equal(env.api.received[0].body.noHistory, true);
  assert.equal(env.api.received[0].body.stdin, undefined);
  assert.ok(env.api.received[0].body.cmd.includes(".local/bin"));
  assert.ok(!env.api.received[0].body.cmd.includes("systemctl"));
  assert.equal(env.store.macLeases.hasGithubDeliveryRecord(env.store.macLeases.held()[0]!.id), false);
});

test("Mac credentials require a verified native route and refuse the provider's headless runner", async t => {
  const env = await fixture(t);
  env.setRoute(false);
  await assert.rejects(env.provider.assertTaskReady!({ agent: "codex", repos: [], sandboxId: env.machine.id, runner: "chat" }), { code: "task_credentials_missing" });
  await assert.rejects(env.provider.assertTaskReady!({ agent: "codex", repos: [], system: "macos", runner: "boat" }), { code: "chat_required" });
  await assert.rejects(env.provider.prompt({ sandboxId: env.machine.id, prompt: "Check tools", provider: "codex", model: null, conversationId: null }), { code: "chat_required" });
  assert.equal(env.api.received.length, 0);
});

test("failed delivery is recorded before stdin, retained for continuation, and explicit release verifies cleanup", async t => {
  const env = await fixture(t), lease = env.store.macLeases.held()[0]!;
  env.patch({ execExitCode: 1 });
  await assert.rejects(env.provider.beforeRepo!(env.machine.id), { code: "bootstrap_failed" });
  assert.equal(env.store.macLeases.hasGithubDeliveryRecord(lease.id), false);
  env.patch({ execExitCode: 0 });
  const execStream = env.rest.execStream.bind(env.rest);
  env.rest.execStream = async (...args) => {
    if (args[1].cmd.includes("gh auth login")) {
      assert.equal(env.store.macLeases.hasGithubDeliveryRecord(lease.id), true);
      return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
    }
    return execStream(...args);
  };
  await assert.rejects(env.provider.beforeRepo!(env.machine.id), { code: "task_credentials_missing" });
  assert.equal(env.store.macLeases.held()[0]!.releaseAt, lease.releaseAt);
  env.rest.execStream = execStream;
  // A fresh plugin process uses the durable attempt record for cleanup.
  const fresh = createInstaboxProvider(env.cli, env.rest, { ledger: env.store.macLeases, credentials: env.credentials });
  env.patch({ execExitCode: 1 });
  await assert.rejects(fresh.scheduleLeaseRelease!(env.machine.id, lease.paidUntil), { code: "credential_cleanup_failed" });
  assert.equal(env.state().calls.some((call: string) => call.startsWith("rm ")), false);
  assert.equal(env.store.macLeases.credentialNotices().length, 1);
  env.patch({ execExitCode: 0 });
  await fresh.scheduleLeaseRelease!(env.machine.id, lease.paidUntil);
  assert.equal(env.state().calls.filter((call: string) => call.startsWith("rm ")).length, 1);
});

test("a lease change during token validation refuses delivery before stdin", async t => {
  const env = await fixture(t);
  const ensure = env.credentials.ensureGithub;
  env.credentials.ensureGithub = async (id, executor, signal, force, beforeDelivery) => ensure(id, executor, signal, force, async expiry => {
    env.store.macLeases.end(env.store.macLeases.held()[0]!.id, "handed back");
    await beforeDelivery!(expiry);
  });
  await assert.rejects(env.provider.beforeRepo!(env.machine.id), { code: "lease_unknown" });
  assert.equal(env.api.received.some((entry: any) => entry.body?.cmd.includes("gh auth login")), false);
});

for (const change of ["terms", "expired", "stopped"] as const) test(`Mac setup refuses ${change} before guest tooling or credentials`, async t => {
  const env = await fixture(t), data = env.state();
  if (change === "terms") data.machines[env.machine.id].lease.hourUSD = 0.9;
  if (change === "expired") data.machines[env.machine.id].deleteAt = new Date(Date.now() - 1000).toISOString();
  if (change === "stopped") data.machines[env.machine.id].state = "stopped";
  env.patch(data);
  await assert.rejects(env.provider.beforeRepo!(env.machine.id));
  assert.equal(env.api.received.length, 0);
});

test("Mac bootstrap upgrades Node before 22.19 and accepts supported Node without downloads", t => {
  const dir = mkdtempSync(join(tmpdir(), "fake-mac-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = (name: string, source: string) => { const path = join(dir, name); writeFileSync(path, source); chmodSync(path, 0o755); };
  fake("node", `#!${process.execPath}\nObject.defineProperty(process.versions, "node", { value: process.env.FAKE_NODE_VERSION }); eval(process.argv[3]);\n`);
  fake("curl", "#!/bin/sh\nexit 29\n");
  for (const name of ["gh", "claude", "codex", "git"]) fake(name, "#!/bin/sh\nexit 0\n");
  for (const [version, status] of [["22.18.0", 29], ["22.19.0", 0], ["24.0.0", 0]] as const) {
    const result = spawnSync("bash", ["-c", MAC_BOOTSTRAP], { env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}`, FAKE_NODE_VERSION: version }, encoding: "utf8" });
    assert.equal(result.status, status, result.stderr);
  }
});
