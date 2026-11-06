// Work a chat leaves running after its turn (background commands, bb
// workflows, background agents, child chats) counts as work: the idle stop
// and "Make room at your sandbox limit" leave its sandbox on.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { KEEP_LIMIT_MS, NO_WORK, describeWork, isServerCommand, readMachineActivity, rowWork, type ThreadRow } from "../src/activity.ts";
import { busyProcesses, isInfrastructure, parseProcessSample } from "../src/boat-api.ts";
import { createChatRunner } from "../src/chat.ts";
import { makeService } from "./fakes.ts";

const MINUTE = 60_000;

const REPORT = `Done.

=== REPORT ===
STATUS: done
PR: https://github.com/acme/web/pull/12
BRANCH: boat/x
SUMMARY: done
TESTS: ok
OPEN QUESTIONS: none
=== END REPORT ===`;

async function chatTask(env: ReturnType<typeof makeService>, title = "Add dark mode") {
  const { task } = await env.service.launchTask(
    { title, role: "implement", brief: "Add a dark mode toggle.", repo: "acme/web", orchestratorThreadId: "thr_orch", projectId: "proj_personal" },
    5_000,
  );
  await env.service.sweep();
  env.chat.finish(task.threadId!, REPORT);
  await env.service.sweep();
  return env.store.get(task.id)!;
}

/** Run with the clock moved on (Date.now only). */
async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

test("what bb counts after a turn: background agents, commands and bb workflows, said plainly", () => {
  const row: ThreadRow = { id: "thr_1", status: "idle", activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 2, activeWorkflowCount: 1 } };
  assert.deepEqual(rowWork(row), { agents: 0, commands: 2, workflows: 1, children: 0 });
  assert.equal(describeWork(rowWork(row)), "a bb workflow and 2 background commands");
  assert.equal(describeWork({ agents: 1, commands: 1, workflows: 0, children: 3 }), "a background command, a background agent and 3 child chats");
  assert.equal(describeWork(NO_WORK), "");
  // An archived chat runs nothing.
  assert.deepEqual(rowWork({ ...row, archivedAt: 1 }), NO_WORK);
});

test("bb's runner reads the list rows' fields: queued work and the activity counts, child chats elsewhere", async () => {
  const lists: unknown[] = [];
  const rows: Record<string, ThreadRow[]> = {
    host_1: [{ id: "thr_worker", status: "idle", queuedWork: "none", activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeWorkflowCount: 1 } }],
    host_2: [{ id: "thr_orch", status: "idle", queuedWork: "none", activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeWorkflowCount: 0 } }],
  };
  const children: Record<string, ThreadRow[]> = {
    // A subagent chat on this bb machine works; a task chat on a Boat sandbox and the plugin's own don't count.
    thr_orch: [
      { id: "thr_sub", status: "active", environmentHostId: "host_local", originPluginId: null },
      { id: "thr_task", status: "active", environmentHostId: "host_1", originPluginId: null },
      { id: "thr_mine", status: "active", environmentHostId: "host_local", originPluginId: "boat" },
      // One waiting on the user's approval doesn't keep its parent's sandbox on either.
      { id: "thr_asks", status: "active", hasPendingInteraction: true, environmentHostId: "host_local", originPluginId: null },
    ],
  };
  const bb = {
    pluginId: "boat",
    sdk: {
      hosts: { list: async () => [{ id: "host_1", machineProviderId: "boat-sandbox" }, { id: "host_2", machineProviderId: "boat-sandbox" }, { id: "host_local", machineProviderId: null }] },
      threads: {
        list: async (args: { hostId?: string; parentThreadId?: string; threadIds?: string[] }) => {
          lists.push(args);
          if (args.hostId) return rows[args.hostId] ?? [];
          if (args.parentThreadId) return children[args.parentThreadId] ?? [];
          if (args.threadIds) return Object.values(rows).flat().filter((row) => args.threadIds!.includes(row.id!));
          return [];
        },
        // The thread page: background agents only, no workflows.
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", queuedMessageCount: 0, activeBackgroundAgentCount: 0 }),
      },
    },
  } as unknown as BbPluginApi;
  const runner = createChatRunner(bb);

  // The workflow keeps the worker's machine busy (the old code read get-only fields there and saw nothing).
  assert.equal(await runner.machineBusy("host_1"), true);
  const worker = await runner.machineActivity("host_1");
  assert.equal(worker.background.workflows, 1);
  assert.equal(worker.turns, false);
  // The orchestrator's machine: only the subagent chat on this bb machine counts.
  const orchestrator = await runner.machineActivity("host_2");
  assert.deepEqual(orchestrator.children.map((row) => row.id), ["thr_sub"]);
  assert.equal(orchestrator.background.children, 1);
  // The thread page doesn't say a workflow runs; the list row does.
  const state = await runner.state("thr_worker");
  assert.equal(state?.workflows, 1);
  assert.ok(lists.some((args) => JSON.stringify(args).includes('"threadIds":["thr_worker"]')));
});

test("a task chat whose bb workflow still runs keeps its turn open: no 'finished' report yet", async () => {
  const env = makeService({ chat: true });
  const { task } = await env.service.launchTask(
    { title: "Deep refactor", role: "implement", brief: "Refactor it.", repo: "acme/web", orchestratorThreadId: "thr_orch", projectId: "proj_personal" },
    5_000,
  );
  await env.service.sweep();
  env.chat.finish(task.threadId!, REPORT);
  env.chat.states.get(task.threadId!)!.workflows = 1;
  await env.service.sweep();
  assert.equal(env.store.get(task.id)!.status, "running");
  assert.deepEqual(env.notifications, []);
  env.chat.states.get(task.threadId!)!.workflows = 0;
  await env.service.sweep();
  assert.equal(env.store.get(task.id)!.status, "idle");
});

test("the idle stop leaves a machine on while background work runs there, and stops it once it's done", async () => {
  const env = makeService({ chat: true, settings: { stopIdleAfterMinutes: 1 } });
  const task = await chatTask(env);
  env.chat.activities.set(task.hostId!, { background: { ...NO_WORK, commands: 1 } });
  await later(5 * MINUTE, () => env.service.sweep());
  assert.deepEqual(env.chat.suspended, []);
  assert.ok(!env.store.events(task.id, 50).some((event) => event.kind === "sandbox-stopped"));
  // The command ended: the next pass suspends it, as a normal idle stop.
  env.chat.activities.delete(task.hostId!);
  await later(6 * MINUTE, () => env.service.sweep());
  assert.deepEqual(env.chat.suspended, [task.hostId]);
  assert.match(env.store.events(task.id, 50).find((event) => event.kind === "sandbox-stopped")!.text, /after 1 idle minutes/);
  // The watchdog hears it was a planned stop, with nothing in the background.
  assert.deepEqual(env.planned, [{ hostId: task.hostId, underWork: false }]);
});

test("background work keeps a machine on at most 12 hours from when the idle stop first saw it", async () => {
  const env = makeService({ chat: true, settings: { stopIdleAfterMinutes: 1 } });
  const task = await chatTask(env);
  env.chat.activities.set(task.hostId!, { background: { ...NO_WORK, workflows: 1 } });
  await later(5 * MINUTE, () => env.service.sweep());
  await later(5 * MINUTE + KEEP_LIMIT_MS - MINUTE, () => env.service.sweep());
  assert.deepEqual(env.chat.suspended, []);
  await later(5 * MINUTE + KEEP_LIMIT_MS + MINUTE, () => env.service.sweep());
  assert.deepEqual(env.chat.suspended, [task.hostId]);
  assert.match(env.store.events(task.id, 50).find((event) => event.kind === "sandbox-stopped")!.text, /a bb workflow had been running in the background for 12 hours/);
  assert.deepEqual(env.planned, [{ hostId: task.hostId, underWork: true }]);
});

test("when bb can't say what runs on a machine, the idle stop doesn't stop it on a guess", async () => {
  const env = makeService({ chat: true, settings: { stopIdleAfterMinutes: 1 } });
  const task = await chatTask(env);
  env.chat.activities.set(task.hostId!, new Error("bb is restarting"));
  await later(5 * MINUTE, () => env.service.sweep());
  assert.deepEqual(env.chat.suspended, []);
  assert.ok(env.warnings.some((line) => line.includes("bb is restarting")));
});

test("making room at the sandbox limit never stops a machine with background work", async () => {
  const env = makeService({ chat: true, settings: { maxActiveSandboxes: 1 } });
  const first = await chatTask(env, "First");
  env.chat.activities.set(first.hostId!, { background: { ...NO_WORK, commands: 1 } });
  await assert.rejects(
    env.service.launchTask({ title: "Second", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch", projectId: "proj_personal" }, 5_000),
    /All 1 sandboxes your limit allows are in use/,
  );
  assert.deepEqual(env.chat.suspended, []);
  // Without it, the waiting one makes room as before.
  env.chat.activities.delete(first.hostId!);
  await env.service.launchTask({ title: "Second", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch", projectId: "proj_personal" }, 5_000);
  assert.deepEqual(env.chat.suspended, [first.hostId]);
});

test("boat ps: only processes computing in a live sample count, never boat's or bb's own", () => {
  const sample = parseProcessSample([
    {
      live: true,
      sampledAt: "2026-11-06T10:00:00Z",
      processes: [
        { pid: 10, command: "/usr/bin/node /work/node_modules/.bin/vitest run", cpuPercent: 97.5, memoryMB: 800 },
        { pid: 11, command: "npm run dev", cpuPercent: 0.3 },
        { pid: 12, command: "/opt/ascii/ascii-agent serve", cpuPercent: 60 },
        { pid: 13, command: "/home/user/.bb/bb-host-daemon", cpuPercent: 40 },
      ],
    },
  ]);
  assert.deepEqual(busyProcesses(sample).map((entry) => entry.pid), [10]);
  // A stopped sandbox's stored sample counts for nothing.
  assert.deepEqual(busyProcesses({ ...sample, live: false }), []);
  // One record per process works too.
  assert.equal(parseProcessSample([{ pid: 1, command: "make", cpuPercent: 99 }]).processes.length, 1);
});

test("a headless sandbox whose finished agent left a build computing isn't idle-stopped while it computes", async () => {
  const env = makeService({ settings: { stopIdleAfterMinutes: 1 } });
  const { task } = await env.service.launchTask({ title: "Benchmarks", role: "implement", brief: "Run them.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  const busy = { live: true, sampledAt: null, processes: [{ pid: 42, command: "cargo bench", cpuPercent: 99, memoryMb: null, commandId: null }] };
  env.boat.processSamples.set(task.sandboxId!, busy);
  const stops = () => env.boat.calls.filter((call) => call === `stop ${task.sandboxId}`).length;
  // A first busy reading holds the stop until the next one decides.
  await later(5 * MINUTE, () => env.service.sweep());
  assert.equal(stops(), 0);
  // Five minutes later the same program is busy again (another pid: a build's compiler processes come and go).
  env.boat.processSamples.set(task.sandboxId!, { ...busy, processes: [{ ...busy.processes[0]!, pid: 43 }] });
  await later(11 * MINUTE, () => env.service.sweep());
  await later(17 * MINUTE, () => env.service.sweep());
  assert.equal(stops(), 0, "kept on while it computes");
  assert.deepEqual(env.planned, []);
  // It finished: the next reading lets the idle stop go ahead.
  env.boat.processSamples.set(task.sandboxId!, { ...busy, processes: [] });
  await later(23 * MINUTE, () => env.service.sweep());
  assert.equal(stops(), 1);
});

test("a first busy reading that isn't confirmed doesn't keep a sandbox on", async () => {
  const env = makeService({ settings: { stopIdleAfterMinutes: 1 } });
  const { task } = await env.service.launchTask({ title: "Blip", role: "implement", brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  env.boat.processSamples.set(task.sandboxId!, { live: true, sampledAt: null, processes: [{ pid: 7, command: "node build.js", cpuPercent: 80, memoryMb: null, commandId: null }] });
  await later(5 * MINUTE, () => env.service.sweep());
  env.boat.processSamples.set(task.sandboxId!, { live: true, sampledAt: null, processes: [] });
  await later(11 * MINUTE, () => env.service.sweep());
  assert.deepEqual(env.boat.calls.filter((call) => call === `stop ${task.sandboxId}`), [`stop ${task.sandboxId}`]);
});

test("background work after a new turn starts its 12 hours over", async () => {
  const env = makeService({ chat: true, settings: { stopIdleAfterMinutes: 1 } });
  const task = await chatTask(env);
  env.chat.activities.set(task.hostId!, { background: { ...NO_WORK, commands: 1 } });
  await later(5 * MINUTE, () => env.service.sweep());
  // A follow-up: a new turn runs, ends 13 hours later, and leaves new background work.
  await later(6 * MINUTE, async () => {
    await env.service.followup(task.id, "One more thing.");
    await env.service.sweep();
  });
  await later(13 * 3_600_000, async () => {
    env.chat.finish(task.threadId!, REPORT);
    await env.service.sweep();
  });
  await later(13 * 3_600_000 + 5 * MINUTE, () => env.service.sweep());
  assert.deepEqual(env.chat.suspended, [], "an hour-old job isn't at the 12-hour limit");
});

test("the idle stop at the 12-hour limit for a headless sandbox still computing says so, and tells the watchdog", async () => {
  const env = makeService({ settings: { stopIdleAfterMinutes: 1 } });
  const { task } = await env.service.launchTask({ title: "Soak test", role: "implement", brief: "Run it.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  env.boat.processSamples.set(task.sandboxId!, { live: true, sampledAt: null, processes: [{ pid: 9, command: "node soak.js", cpuPercent: 90, memoryMb: null, commandId: null }] });
  // The monitor looks every few minutes; it keeps finding the job busy.
  for (let at = 5 * MINUTE; at <= 11 * MINUTE + KEEP_LIMIT_MS + 10 * MINUTE; at += 10 * MINUTE) {
    await later(at, () => env.service.sweep());
    if (env.boat.calls.includes(`stop ${task.sandboxId}`)) break;
  }
  assert.ok(env.boat.calls.includes(`stop ${task.sandboxId}`));
  assert.match(env.store.events(task.id, 50).find((event) => event.kind === "sandbox-stopped")!.text, /had been computing for 12 hours/);
  assert.deepEqual(env.computingStopped, [task.sandboxId]);
});

test("boat ps, as boat prints it: bb's daemon and workers and boat's own processes aren't work; the task's node build is", () => {
  const sample = parseProcessSample([
    {
      live: true,
      processes: [
        { command: "/var/lib/ascii-lazy-bin/ascii-lazyfs", commandId: null, cpuPercent: 33.8, memoryMB: 1188.6, parentPid: 1, pid: 17949, startedAt: "2026-11-06T10:00:00Z", user: "root" },
        { command: "/usr/bin/node /home/user/.bb-machines/acme.example/npm/lib/node_modules/bb-app/host-daemon/dist/daemon-bundle.mjs", commandId: null, cpuPercent: 41, memoryMB: 310, parentPid: 1, pid: 200, startedAt: "2026-11-06T10:00:00Z", user: "user" },
        { command: "node /home/user/.bb-machines/acme.example/npm/lib/node_modules/bb-app/host-daemon/dist/bb-provider-bridge-worker.mjs", commandId: null, cpuPercent: 27, memoryMB: 120, parentPid: 200, pid: 201, startedAt: "2026-11-06T10:00:00Z", user: "user" },
        { command: "node /opt/bb-app/host-daemon/dist/bb-plugin-host-worker.mjs", commandId: null, cpuPercent: 22, memoryMB: 90, parentPid: 200, pid: 202, startedAt: "2026-11-06T10:00:00Z", user: "user" },
        { command: "/usr/bin/node /home/user/work/acme/web/node_modules/.bin/tsc -b", commandId: null, cpuPercent: 98, memoryMB: 700, parentPid: 300, pid: 301, startedAt: "2026-11-06T10:05:00Z", user: "user" },
        { command: "cargo build --release", commandId: "cmd_1", cpuPercent: 3, memoryMB: 80, parentPid: 300, pid: 302, startedAt: "2026-11-06T10:05:00Z", user: "user" },
      ],
    },
  ]);
  assert.equal(sample.processes[0]!.user, "root");
  assert.equal(sample.processes[1]!.parentPid, 1);
  assert.equal(sample.processes[4]!.startedAt, "2026-11-06T10:05:00Z");
  assert.deepEqual(busyProcesses(sample).map((entry) => entry.pid), [301]);
  assert.equal(isInfrastructure({ command: "/usr/bin/node /work/server/bb-app/notes.mjs" }), false, "a repo's own file named like bb's isn't bb");
});

test("the idle stop tells the watchdog when it stops a headless sandbox with nothing computing", async () => {
  const env = makeService({ settings: { stopIdleAfterMinutes: 1 } });
  const { task } = await env.service.launchTask({ title: "Docs", role: "implement", brief: "Write them.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  await later(5 * MINUTE, () => env.service.sweep());
  assert.ok(env.boat.calls.includes(`stop ${task.sandboxId}`));
  assert.deepEqual(env.plannedSandboxStops, [task.sandboxId]);
});

test("servers started in the background are told from finite jobs by bb's description of them", () => {
  for (const text of [
    "Start the Vite dev server",
    "Run dev server on port 5173",
    "npm run dev -- --host 0.0.0.0 --port 4321",
    "pnpm preview",
    "Start the API server",
    "python3 -m http.server 8000",
    "Launch the preview",
    "npx vite --host",
    "Run tsc in watch mode",
    "jest --watch",
    "rails server -b 0.0.0.0",
    "serve -s dist",
  ]) {
    assert.equal(isServerCommand(text), true, text);
  }
  for (const text of ["Run the full test suite", "cargo bench", "Run server tests", "npm run build", "vite build", "Run vitest", "Build the site", "pytest -x tests/server", "Wait for the migration to finish"]) {
    assert.equal(isServerCommand(text), false, text);
  }
});

test("a dev server left running in the background isn't background work; a test run next to it is", async () => {
  const commands: Record<string, { description: string; summary: string | null; taskStatus: string }[]> = {
    thr_worker: [
      { description: "Start the Vite dev server", summary: null, taskStatus: "running" },
      { description: "Run the full test suite", summary: null, taskStatus: "running" },
    ],
    thr_preview: [{ description: "npm run dev -- --port 4321", summary: "Serving on :4321", taskStatus: "running" }],
  };
  const rows: Record<string, ThreadRow[]> = {
    host_1: [{ id: "thr_worker", status: "idle", queuedWork: "none", activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 2, activeWorkflowCount: 0 } }],
    host_2: [{ id: "thr_preview", status: "idle", queuedWork: "none", activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 1, activeWorkflowCount: 0 } }],
  };
  const bb = {
    pluginId: "boat",
    sdk: {
      hosts: { list: async () => [] },
      threads: {
        list: async (args: { hostId?: string }) => (args.hostId ? (rows[args.hostId] ?? []) : []),
        timeline: async ({ threadId }: { threadId: string }) => ({ activeBackgroundCommands: commands[threadId] ?? [] }),
      },
    },
  } as unknown as BbPluginApi;
  assert.equal((await readMachineActivity(bb, "host_1")).background.commands, 1);
  // Only a dev server: nothing in the background keeps the machine on (a live preview does, under its own rules).
  assert.deepEqual((await readMachineActivity(bb, "host_2")).background, NO_WORK);
});
