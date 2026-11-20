import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { createCredentialSource, createAgentRouteCheck, GITHUB_LOGIN_SCRIPT, CREDENTIAL_CLEANUP_SCRIPT } from "../src/credentials.ts";

const token = "fake_rented_machine_token";
const now = Date.parse("2030-01-01T00:00:00Z");
function fixture() {
  let clock = now, expires = now + 90 * 86400_000, configured: string | null = token, route = true, denied = false;
  const requests: string[] = [], spawns: Parameters<MachineExecutor["exec"]>[0][] = [];
  const source = createCredentialSource({
    githubToken: async () => configured, now: () => clock, agentAvailable: async () => route,
    fetch: (async (url, options) => {
      requests.push(String(url));
      assert.equal(new Headers(options?.headers).get("Authorization"), `Bearer ${token}`);
      assert.equal(options?.redirect, "error");
      return new Response(JSON.stringify({ permissions: { push: !denied, pull: true } }), { headers: { "github-authentication-token-expiration": new Date(expires).toISOString() } });
    }) as typeof fetch,
  });
  const executor: MachineExecutor = { exec: async request => { spawns.push(request); return { exitCode: 0 }; } };
  return { source, executor, spawns, requests, clock: (n: number) => { clock = n; }, expiry: (n: number) => { expires = n; }, missing: () => { configured = null; }, routeOff: () => { route = false; }, denied: () => { denied = true; } };
}
test("delivery uses only private stdin; every recorded spawn has secret-free argv and discarded output", async () => {
  const f = fixture();
  await f.source.assertReady("codex", ["acme/web"]);
  const expiry = await f.source.ensureGithub("mac", f.executor);
  assert.equal(expiry, new Date(now + 90 * 86400_000).toISOString());
  assert.equal(f.spawns[0]!.stdin, `${token}\n`);
  assert.deepEqual(f.spawns[0]!.command, ["bash", "-c", GITHUB_LOGIN_SCRIPT]);
  await f.source.cleanup("mac", f.executor);
  for (const recorded of f.spawns) {
    assert.ok(!JSON.stringify({ ...recorded, stdin: undefined }).includes(token));
    assert.equal(recorded.onOutput(token), undefined);
  }
  assert.ok(!JSON.stringify(f.requests).includes(token));
});
test("expiry is recorded, delivery is cached, and a replacement is re-delivered before expiry", async () => {
  const f = fixture(); f.expiry(now + 3600_000);
  assert.equal(await f.source.ensureGithub("mac", f.executor), new Date(now + 3600_000).toISOString());
  await f.source.ensureGithub("mac", f.executor); assert.equal(f.spawns.length, 1);
  f.clock(now + 20 * 60_000); f.expiry(now + 90 * 86400_000);
  await f.source.ensureGithub("mac", f.executor); assert.equal(f.spawns.length, 2);
  await f.source.cleanup("mac", f.executor);
  await f.source.ensureGithub("mac", f.executor); assert.equal(f.spawns.length, 4, "cleanup invalidates the delivery cache");
});
test("preflight refuses missing, expiring, inaccessible and unrouted credentials without execution", async () => {
  for (const kind of ["missing", "expired", "denied", "route"] as const) {
    const f = fixture();
    if (kind === "missing") f.missing();
    if (kind === "expired") f.expiry(now + 10_000);
    if (kind === "denied") f.denied();
    if (kind === "route") f.routeOff();
    await assert.rejects(f.source.assertReady("codex", ["acme/web"]), { code: "task_credentials_missing" });
    assert.equal(f.spawns.length, 0);
  }
});
test("secret-store, HTTP, body, and executor failures never appear in errors; partial delivery is cleaned", async () => {
  for (const stage of ["store", "http", "body", "exec"] as const) {
    const recorded: string[] = [];
    const source = createCredentialSource({
      githubToken: async () => { if (stage === "store") throw new Error(token); return token; }, agentAvailable: async () => true, now: () => now,
      fetch: (async () => {
        if (stage === "http") throw new Error(token);
        return new Response(stage === "body" ? token : "{}", { headers: { "github-authentication-token-expiration": new Date(now + 86400_000).toISOString() }, status: stage === "body" ? 403 : 200 });
      }) as typeof fetch,
    });
    const executor: MachineExecutor = { exec: async request => { recorded.push(JSON.stringify(request.command)); if (request.command.includes(GITHUB_LOGIN_SCRIPT)) throw new Error(token); return { exitCode: 0 }; } };
    await assert.rejects(source.ensureGithub("mac", executor), error => { assert.ok(!String(error).includes(token)); return true; });
    assert.ok(!JSON.stringify(recorded).includes(token));
    if (stage === "exec") assert.ok(recorded.some(line => line.includes("auth logout")));
  }
});
test("cleanup fails closed and sanitizes transport errors", async () => {
  await assert.rejects(fixture().source.cleanup("mac", { exec: async () => { throw new Error(token); } }), error => {
    assert.equal((error as { code: string }).code, "credential_cleanup_failed"); assert.ok(!String(error).includes(token)); return true;
  });
});
test("real shell delivery creates only mode 0600 credential files and logout removes them", async t => {
  const dir = await mkdtemp(join(tmpdir(), "credential-test-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin"); await mkdir(bin);
  await writeFile(join(bin, "gh"), `#!/bin/bash
case "$1 $2" in
  'auth login') cat > "$HOME/.config/gh/hosts.yml"; cat "$HOME/.config/gh/hosts.yml" >&2 ;;
  'auth setup-git') printf configured > "$HOME/.config/gh/config.yml" ;;
  'auth logout') printf logout > "$HOME/logout" ;;
esac
`, { mode: 0o755 });
  for (const agent of ["claude", "codex"]) await writeFile(join(bin, agent), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const spawns: { command: string[]; output: string }[] = [];
  const executor: MachineExecutor = { exec: request => new Promise(resolve => {
    const child = spawn(request.command[0]!, request.command.slice(1), { env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}` }, stdio: "pipe" });
    const recorded = { command: request.command, output: "" }; spawns.push(recorded);
    child.stdout.on("data", chunk => { recorded.output += chunk; }); child.stderr.on("data", chunk => { recorded.output += chunk; });
    child.on("close", code => resolve({ exitCode: code ?? 1 })); child.stdin.end(request.stdin);
  }) };
  const f = fixture(); await f.source.ensureGithub("mac", executor);
  assert.equal((await stat(join(dir, ".config/gh/hosts.yml"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, ".config/gh/config.yml"))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(dir, ".config/gh/hosts.yml"), "utf8")).trim(), token);
  await mkdir(join(dir, ".codex")); await writeFile(join(dir, ".codex/auth.json"), "fake_agent_login");
  await f.source.cleanup("mac", executor);
  assert.equal(await readFile(join(dir, "logout"), "utf8"), "logout");
  await assert.rejects(access(join(dir, ".config/gh"))); await assert.rejects(access(join(dir, ".codex/auth.json")));
  assert.ok(!JSON.stringify(spawns).includes(token), "grep every real recorded spawn and output");
});
test("remote agent gate only reads status and requires the selected ready route plus Connect", async () => {
  let state = "ready", routing = true, accepting = true, account = "ready", parent = false;
  const calls: string[] = [];
  const check = createAgentRouteCheck({ sdk: { plugins: { callRpc: async (input: { method: string }) => {
    calls.push(input.method);
    return { accepting, routing: { claude: false, codex: routing }, accounts: [{ provider: "codex", enabled: true, status: account }], parent: parent ? { mode: "proxy", availability: { claude: false, codex: true } } : null };
  } } } } as never, async () => ({ state, fix: null }) as never);
  assert.equal(await check("codex"), true); assert.equal(await check("claude"), false);
  account = "error"; assert.equal(await check("codex"), false);
  parent = true; assert.equal(await check("codex"), true);
  accepting = false; assert.equal(await check("codex"), false); accepting = true;
  routing = false; assert.equal(await check("codex"), false); routing = true;
  state = "off"; assert.equal(await check("codex"), false);
  assert.deepEqual(new Set(calls), new Set(["status.get"]));
});

test("delivery refuses symlinked credential paths before handing stdin to gh", async t => {
  const dir = await mkdtemp(join(tmpdir(), "credential-symlink-test-")); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "shared")); await symlink(join(dir,"shared"), join(dir,".config"));
  const recorded: string[] = [];
  const executor: MachineExecutor = { exec: request => new Promise(resolve => {
    const child = spawn(request.command[0]!, request.command.slice(1), { env: { ...process.env, HOME: dir }, stdio: "pipe" });
    child.stdout.on("data", chunk => recorded.push(String(chunk))); child.stderr.on("data", chunk => recorded.push(String(chunk)));
    child.stdin.on("error",()=>{}); child.stdin.end(request.stdin); child.on("close", code => resolve({exitCode:code ?? 1}));
  }) };
  await assert.rejects(fixture().source.ensureGithub("mac",executor), {code:"credential_cleanup_failed"});
  await assert.rejects(access(join(dir,"shared/gh")));
  assert.ok(!JSON.stringify(recorded).includes(token));
});
