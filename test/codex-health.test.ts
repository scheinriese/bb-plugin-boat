import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CODEX_HEALTH_SCRIPT, ensureCodexHealthy, createCodexHealthCheck } from "../src/codex-health.ts";
import { makeService } from "./fakes.ts";

for (const platform of ["linux-x64", "darwin-arm64"]) for (const mode of ["healthy", "repair", "sudo", "recheck-fails"]) test(`Codex shell checks the resolved prefix (${platform}, ${mode})`, { skip: mode === "sudo" && process.getuid?.() === 0 }, async () => {
  const broken = mode !== "healthy";
  const prefix = await mkdtemp(join(realpathSync(tmpdir()), 'codex-health-'));
  try {
    const root = join(prefix, 'lib/node_modules/@openai/codex');
    await mkdir(join(root, 'bin'), { recursive: true });
    await mkdir(join(prefix, 'bin'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.171.0' }));
    await writeFile(join(root, 'bin/codex.js'), `#!/bin/sh\nif [ -f '${prefix}/broken' ]; then echo 'Missing optional dependency @openai/codex-${platform}' >&2; exit 1; fi\necho codex-cli 0.171.0\n`, { mode: 0o755 });
    await symlink(join(root, 'bin/codex.js'), join(prefix, 'bin/codex'));
    if (broken) await writeFile(join(prefix, 'broken'), '');
    await writeFile(join(prefix, 'bin/npm'), `#!/bin/sh\nprintf '%s\\n' "$*" > '${prefix}/args'\nrm '${prefix}/broken'\n`, { mode: 0o755 });
    await writeFile(join(prefix, 'bin/sudo'), `#!/bin/sh\nprintf '%s\\n' "$*" > '${prefix}/sudo-args'\n[ "$1" = -n ] || exit 1\nshift\nexec "$@"\n`, { mode: 0o755 });
    if (mode === "sudo") await chmod(root, 0o555);
    if (mode === "recheck-fails") await writeFile(join(prefix, 'bin/npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const run = () => execFileSync('sh', ['-c', CODEX_HEALTH_SCRIPT], { env: { ...process.env, PATH: `${prefix}/bin:${process.env.PATH}`, BB_CODEX_BRIDGE_APP_SERVER_COMMAND: join(prefix, 'bin/codex') }, encoding: 'utf8' });
    if (mode === "recheck-fails") {
      assert.throws(run, (error: any) => {
        assert.match(error.stdout, /BOAT_CODEX_REPAIRING/);
        assert.match(error.stderr, /Missing optional dependency/);
        assert.doesNotMatch(error.stdout, /BOAT_CODEX_REPAIRED/);
        return true;
      });
      return;
    }
    const output = run();
    assert.equal(output.includes('BOAT_CODEX_REPAIRED'), broken);
    if (mode === "sudo") assert.equal((await readFile(join(prefix, 'sudo-args'), 'utf8')).trim(), `-n ${prefix}/bin/npm install -g --prefix ${prefix} @openai/codex@0.171.0 --include=optional`);
    if (broken) {
      const { readFile } = await import('node:fs/promises');
      assert.equal((await readFile(join(prefix, 'args'), 'utf8')).trim(), `install -g --prefix ${prefix} @openai/codex@0.171.0 --include=optional`);
    }
  } finally { await chmod(join(prefix, 'lib/node_modules/@openai/codex'), 0o755).catch(() => {}); await rm(prefix, { recursive: true, force: true }); }
});

test('Claude skips the executor', async () => {
  await ensureCodexHealthy({ exec: async () => { throw new Error('unexpected'); } }, 'sb', 'claude', () => {});
});

for (const fails of [false, true]) test(`Codex chat waits for health check (failure=${fails})`, async () => {
  const env = makeService({ chat: true });
  const original = env.boat.exec.bind(env.boat);
  env.boat.exec = async (id, command, options) => command === CODEX_HEALTH_SCRIPT
    ? { exitCode: fails ? 1 : 0, stdout: fails ? 'BOAT_CODEX_REPAIRING' : 'BOAT_CODEX_REPAIRED', stderr: '' }
    : original(id, command, options);
  const launch = env.service.launchTask({ role: 'implement', title: 'Check install', brief: 'Check install', repo: 'acme/web', provider: 'codex', orchestratorThreadId: 'thr_orch', projectId: 'proj_personal' }, 5_000);
  if (fails) await assert.rejects(launch, /Codex repair failed/);
  else await launch;
  assert.equal(env.chat.spawns.length, fails ? 0 : 1);
});


test('health errors retain a bounded stderr tail and distinguish repair failures', async () => {
  for (const repair of [false, true]) await assert.rejects(
    ensureCodexHealthy({ exec: async () => ({ exitCode: 1, stdout: repair ? 'BOAT_CODEX_REPAIRING' : '', stderr: 'x'.repeat(3_000) + ' final cause' }) }, 'sb', 'codex', () => {}),
    (error: any) => {
      assert.equal(error.code, repair ? 'codex_repair_failed' : 'codex_health_failed');
      assert.match(error.message, /final cause$/);
      assert.ok(error.message.length < 2_100);
      assert.ok(error.hint);
      return true;
    },
  );
});

test('successful checks are cached per machine; failed and cancelled checks are retried', async () => {
  const check = createCodexHealthCheck();
  let calls = 0;
  const provider = { exec: async (_id: string, _script: string, options?: { signal?: AbortSignal }) => {
    calls++;
    options?.signal?.throwIfAborted();
    return { exitCode: 0, stdout: '', stderr: '' };
  } };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(check(provider, 'sb', 'codex', () => {}, controller.signal));
  await check(provider, 'sb', 'codex', () => {});
  await check(provider, 'sb', 'codex', () => {});
  await check(provider, 'other', 'codex', () => {});
  assert.equal(calls, 2);
});

test('in-flight checks receive dispatch cancellation and do not cache it', async () => {
  const check = createCodexHealthCheck();
  const controller = new AbortController();
  let calls = 0;
  const provider = { exec: async (_id: string, _script: string, options?: { signal?: AbortSignal }) => {
    calls++;
    if (calls === 1) {
      assert.equal(options?.signal, controller.signal);
      controller.abort();
      options?.signal?.throwIfAborted();
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  } };
  await assert.rejects(check(provider, 'sb', 'codex', () => {}, controller.signal));
  await check(provider, 'sb', 'codex', () => {});
  assert.equal(calls, 2);
});

test('failed checks are retried instead of cached', async () => {
  const check = createCodexHealthCheck();
  let calls = 0;
  const provider = { exec: async () => ({ exitCode: ++calls === 1 ? 1 : 0, stdout: '', stderr: 'version failed' }) };
  await assert.rejects(check(provider, 'sb', 'codex', () => {}), /version failed/);
  await check(provider, 'sb', 'codex', () => {});
  await check(provider, 'sb', 'codex', () => {});
  assert.equal(calls, 2);
});
