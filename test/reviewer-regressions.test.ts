// Regression checks from the Codex review of PR #6 (t_b13aa57b), kept as tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NO_WORK, withoutServers } from '../src/activity.ts';
import { busyProcesses, parseProcessSample } from '../src/boat-api.ts';
import { createWatchdog } from '../src/watchdog.ts';
import { makeService } from './fakes.ts';
const REPORT = 'Done.\n\n=== REPORT ===\nSTATUS: done\nPR: none\nBRANCH: boat/x\nSUMMARY: done\nTESTS: ok\nOPEN QUESTIONS: none\n=== END REPORT ===';
const brief = { title: 'Benchmarks', role: 'implement' as const, brief: 'Run benchmarks.', repo: 'acme/web', orchestratorThreadId: 'thr_orch' };
async function finished() {
  const env = makeService({ settings: { maxActiveSandboxes: 1 } });
  const { task } = await env.service.launchTask(brief, 5000);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  env.boat.processSamples.set(task.sandboxId!, { live: true, sampledAt: null, processes: [{ pid: 42, command: 'cargo bench', cpuPercent: 99, memoryMb: null, commandId: null }] });
  return { env, task };
}
test('live boat ps fixture excludes bb node infrastructure', () => {
  const sample = parseProcessSample([{live: true, processes: [
    {command: '/var/lib/ascii-lazy-bin/ascii-lazyfs', commandId: null, cpuPercent: 33.8, memoryMB: 1188.6, parentPid: 1, pid: 17949, startedAt: '2026-11-06T10:00:00Z', user: 'root'},
    {command: '/usr/bin/node /opt/bb-app/host-daemon/main.mjs', commandId: null, cpuPercent: 35, memoryMB: 200, parentPid: 1, pid: 17950, startedAt: '2026-11-06T10:00:00Z', user: 'user'},
    {command: '/usr/bin/node /opt/bb-app/bb-provider-bridge-worker.mjs', commandId: null, cpuPercent: 25, memoryMB: 200, parentPid: 17950, pid: 17951, startedAt: '2026-11-06T10:00:00Z', user: 'user'}
  ]}]);
  assert.deepEqual(busyProcesses(sample), []);
});
test('making room preserves confirmed headless computing work', async () => {
  const { env, task } = await finished();
  await env.service.processesBusy(task.sandboxId!, Date.now() - 6 * 60000);
  assert.equal(await env.service.processesBusy(task.sandboxId!), 'busy');
  await env.service.launchTask({ ...brief, title: 'Second' }, 5000).catch(() => undefined);
  assert.equal(env.boat.calls.includes(`stop ${task.sandboxId}`), false);
});
test('unexpected headless stop emits notice and arms resume note', async () => {
  const { env, task } = await finished();
  const data = new Map(); const told: string[] = [];
  let at = Date.now();
  const dog = createWatchdog({sdk: {hosts: {list: async () => []}}} as any, {
    boat: env.boat as any, store: env.store,
    kv: {get: async (key: string) => data.get(key), set: async (key: string, value: any) => {data.set(key,value)}, delete: async (key: string) => {data.delete(key)}, list: async () => [...data.keys()]} as any,
    tell: async (_id, text) => {told.push(text)}, log: () => {}, now: () => at
  });
  await dog.tick();
  env.boat.sandboxes.get(task.sandboxId!)!.state = 'stopped';
  at += 60000;
  await dog.tick();
  assert.equal(told.length, 1);
  assert.ok(await dog.noteFor(task.id));
});
test('a second headless interruption arms a new resume note', async () => {
  const { env, task } = await finished();
  const data = new Map(); let at = Date.now();
  const dog = createWatchdog({sdk: {hosts: {list: async () => []}}} as any, {
    boat: env.boat as any, store: env.store,
    kv: {get: async (key: string) => data.get(key), set: async (key: string, value: any) => {data.set(key,value)}, delete: async (key: string) => {data.delete(key)}, list: async () => [...data.keys()]} as any,
    tell: async () => {}, log: () => {}, now: () => at
  });
  await dog.headlessStopped({sandboxId: task.sandboxId!, stoppedAt: at, how: 'idle-stop'});
  assert.ok(await dog.noteFor(task.id));
  await dog.noteSent(task.id);
  assert.equal(await dog.noteFor(task.id), null);
  at += 24 * 3600000;
  await dog.headlessStopped({sandboxId: task.sandboxId!, stoppedAt: at, how: 'idle-stop'});
  assert.ok(await dog.noteFor(task.id));
});

// Re-review of PR #6 (t_7f5d8623): two reproduced regressions.
const buildBrief = { title: 'Build', role: 'implement' as const, brief: 'Build it.', repo: 'acme/web', orchestratorThreadId: 'thr_orch' };
test('a finite Vite build remains protected from idle suspension', async () => {
  const env = makeService({ chat: true, settings: { stopIdleAfterMinutes: 1 } });
  const { task } = await env.service.launchTask({ ...buildBrief, projectId: 'proj_personal' }, 5000);
  await env.service.sweep(); env.chat.finish(task.threadId!, REPORT); await env.service.sweep();
  const bb = { sdk: { threads: { timeline: async () => ({ activeBackgroundCommands: [{ description: 'Build the Vite production bundle', summary: null, taskStatus: 'running' }] }) } } } as any;
  const rows = await withoutServers(bb, [{ id: task.threadId!, status: 'idle', activity: { activeBackgroundCommandCount: 1 } }]);
  env.chat.activities.set(task.hostId!, { background: { ...NO_WORK, commands: rows[0]!.activity!.activeBackgroundCommandCount! } });
  const real = Date.now; Date.now = () => real() + 5 * 60000;
  try { await env.service.sweep(); } finally { Date.now = real; }
  assert.deepEqual(env.chat.suspended, []);
});
test('a headless build under a bb workspace is not evicted', async () => {
  const env = makeService({ settings: { maxActiveSandboxes: 1 } });
  const { task } = await env.service.launchTask(buildBrief, 5000);
  env.boat.finish(task.conversationId!, REPORT); await env.service.sweep();
  const sample = { live: true, sampledAt: null, processes: [{ pid: 42, command: '/usr/bin/node /home/user/.bb-machines/acme.example/plugins/environment-personal-workspace/host-data/workspaces/task/node_modules/typescript/bin/tsc -b', cpuPercent: 99, memoryMb: 100, commandId: null }] };
  env.boat.processSamples.set(task.sandboxId!, sample);
  await env.service.processesBusy(task.sandboxId!, Date.now() - 6 * 60000);
  await env.service.launchTask({ ...buildBrief, title: 'Second' }, 5000).catch(() => undefined);
  assert.equal(env.boat.calls.includes(`stop ${task.sandboxId}`), false);
});
