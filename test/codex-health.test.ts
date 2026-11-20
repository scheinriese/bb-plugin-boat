import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CODEX_HEALTH_SCRIPT, ensureCodexHealthy } from "../src/codex-health.ts";
import { makeService } from "./fakes.ts";

for (const platform of ["linux-x64", "darwin-arm64"]) for (const broken of [false, true]) test(`Codex shell checks and repairs the resolved prefix (${platform}, broken=${broken})`, async () => {
  const prefix = await mkdtemp(join(tmpdir(), 'codex-health-'));
  try {
    const root = join(prefix, 'lib/node_modules/@openai/codex');
    await mkdir(join(root, 'bin'), { recursive: true });
    await mkdir(join(prefix, 'bin'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.171.0' }));
    await writeFile(join(root, 'bin/codex.js'), `#!/bin/sh\nif [ -f '${prefix}/broken' ]; then echo 'Missing optional dependency @openai/codex-${platform}' >&2; exit 1; fi\necho codex-cli 0.171.0\n`, { mode: 0o755 });
    await symlink(join(root, 'bin/codex.js'), join(prefix, 'bin/codex'));
    if (broken) await writeFile(join(prefix, 'broken'), '');
    await writeFile(join(prefix, 'bin/npm'), `#!/bin/sh\nprintf '%s\\n' "$*" > '${prefix}/args'\nrm '${prefix}/broken'\n`, { mode: 0o755 });
    const output = execFileSync('sh', ['-c', CODEX_HEALTH_SCRIPT], { env: { ...process.env, PATH: `${prefix}/bin:${process.env.PATH}`, BB_CODEX_BRIDGE_APP_SERVER_COMMAND: join(prefix, 'bin/codex') }, encoding: 'utf8' });
    assert.equal(output.includes('BOAT_CODEX_REPAIRED'), broken);
    if (broken) {
      const { readFile } = await import('node:fs/promises');
      assert.equal((await readFile(join(prefix, 'args'), 'utf8')).trim(), `install -g --prefix ${prefix} @openai/codex@0.171.0 --include=optional`);
    }
  } finally { await rm(prefix, { recursive: true, force: true }); }
});

test('Claude skips the executor', async () => {
  await ensureCodexHealthy({ exec: async () => { throw new Error('unexpected'); } }, 'sb', 'claude', () => {});
});

for (const fails of [false, true]) test(`Codex chat waits for health check (failure=${fails})`, async () => {
  const env = makeService({ chat: true });
  const original = env.boat.exec.bind(env.boat);
  env.boat.exec = async (id, command, options) => command === CODEX_HEALTH_SCRIPT
    ? { exitCode: fails ? 1 : 0, stdout: 'BOAT_CODEX_REPAIRED', stderr: '' }
    : original(id, command, options);
  const launch = env.service.launchTask({ role: 'implement', title: 'Check install', brief: 'Check install', repo: 'acme/web', provider: 'codex', orchestratorThreadId: 'thr_orch', projectId: 'proj_personal' }, 5_000);
  if (fails) await assert.rejects(launch, /Codex health check or repair failed/);
  else await launch;
  assert.equal(env.chat.spawns.length, fails ? 0 : 1);
});
