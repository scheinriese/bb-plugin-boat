// The sandbox keeper: boat's auto-stop doesn't see a bb chat working, so the
// plugin keeps a sandbox on while a chat's turn runs there, and only then.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BoatApi, Sandbox } from "../src/boat-api.ts";
import { KEPT_ON_EVENT, createSandboxKeeper, threadWorking } from "../src/keeper.ts";
import { MACHINE_PROVIDER_ID } from "../src/machine.ts";
import { FakeBoat, defaultSettings, makeService, memoryStore } from "./fakes.ts";

const MINUTE = 60_000;

interface Machine {
  hostId: string;
  sandboxId: string;
  /** The chats on it, as bb lists them (an Error: bb can't list them). */
  threads: () => Record<string, unknown>[] | Error;
  phase?: string;
}

/** bb's side: Boat sandbox machines and the chats on them. */
function fakeBb(machines: () => Machine[]) {
  const suspended: string[] = [];
  const bb = {
    sdk: {
      hosts: {
        list: async () =>
          machines().map((machine) => ({ id: machine.hostId, machineProviderId: MACHINE_PROVIDER_ID, lifecycle: { phase: machine.phase ?? "active", suspendedAt: null } })),
        experimental_suspend: async ({ hostId }: { hostId: string }) => void suspended.push(hostId),
      },
      threads: {
        list: async ({ hostId }: { hostId: string }) => {
          const threads = machines().find((machine) => machine.hostId === hostId)?.threads() ?? [];
          if (threads instanceof Error) throw threads;
          return threads;
        },
      },
    },
    experimental_machines: {
      getResource: async (hostId: string) => {
        const machine = machines().find((entry) => entry.hostId === hostId);
        return machine ? { sandboxId: machine.sandboxId, key: `k-${hostId}` } : null;
      },
    },
  } as unknown as BbPluginApi;
  return { bb, suspended };
}

/** A clock the test moves. */
function clock(start = Date.parse("2026-11-06T10:00:00.000Z")) {
  let at = start;
  return { now: () => at, advance: (ms: number) => void (at += ms) };
}

/** boat's own answer to an extend: the remaining time is set from now. */
function extendsLikeBoat(boat: FakeBoat, now: () => number) {
  const extend = boat.extend.bind(boat);
  boat.extend = async (id, args) => {
    const result = await extend(id, args);
    const sandbox = boat.sandboxes.get(id);
    if (sandbox) sandbox.archiveAfter = new Date(now() + Number(args[args.indexOf("--ttl") + 1]) * 1000).toISOString();
    return result;
  };
}

/** A task chat on its own machine, with its turn running, and a keeper over it. */
async function taskChat(settings = defaultSettings({ workerMode: "chat" })) {
  const env = makeService({ chat: true, settings });
  const { task } = await env.service.launchTask(
    { title: "Add dark mode", role: "implement", brief: "Add a dark mode toggle.", repo: "acme/web", orchestratorThreadId: "thr_orch", projectId: "proj_personal" },
    5_000,
  );
  assert.equal(task.runner, "chat");
  assert.equal(task.status, "running");
  // The monitor sees the chat busy (a finished turn then counts at once).
  await env.service.sweep();
  const time = clock();
  const sandbox = env.boat.sandboxes.get(task.sandboxId!)!;
  // A chat working reads idle to boat.
  sandbox.state = "idle";
  sandbox.archiveAfter = new Date(time.now() + 10 * MINUTE).toISOString();
  const chatRows = () =>
    env.chat.spawns
      .filter((spawn) => spawn.where.kind === "machine" && spawn.where.hostId === task.hostId)
      .map((spawn) => {
        const state = env.chat.states.get(spawn.threadId)!;
        return { id: spawn.threadId, status: state.status, archivedAt: state.archived ? 1 : null, queuedWork: "none", activity: { activeBackgroundAgentCount: state.backgroundAgents } };
      });
  let threads: () => Record<string, unknown>[] | Error = chatRows;
  const { bb, suspended } = fakeBb(() =>
    env.chat.machines.filter((machine) => !env.chat.removed.includes(machine.hostId)).map((machine) => ({ hostId: machine.hostId, sandboxId: machine.sandboxId, threads: () => threads() })),
  );
  const warnings: string[] = [];
  const changed: string[][] = [];
  const keeper = () =>
    createSandboxKeeper(bb, {
      boat: env.boat as unknown as BoatApi,
      store: env.store,
      settings: async () => settings,
      signal: new AbortController().signal,
      log: (line) => warnings.push(line),
      changed: (ids) => changed.push(ids),
      now: time.now,
    });
  return {
    ...env,
    task,
    sandbox,
    time,
    suspended,
    warnings,
    changed,
    keeper,
    /** What bb reports for the machine's chats from now on. */
    setThreads(next: () => Record<string, unknown>[] | Error) {
      threads = next;
    },
    notes: () => env.store.events(task.id, 200).filter((event) => event.kind === KEPT_ON_EVENT),
  };
}

test("a task chat's sandbox is kept on near boat's auto-stop while its turn runs, with one note a turn", async () => {
  const env = await taskChat();
  const keep = env.keeper();
  const updatedAt = env.store.get(env.task.id)!.updatedAt;

  // 40 minutes left: nothing to do yet.
  env.sandbox.archiveAfter = new Date(env.time.now() + 40 * MINUTE).toISOString();
  await keep();
  assert.deepEqual(env.boat.extended, []);

  // 10 minutes left: Hard stop after (4 h) within the trial's cap (2 h, from boat limits).
  env.sandbox.archiveAfter = new Date(env.time.now() + 10 * MINUTE).toISOString();
  await keep();
  assert.deepEqual(env.boat.extended, [{ id: env.sandbox.id, args: ["--ttl", "7200"] }]);
  assert.deepEqual(
    env.notes().map((event) => event.text),
    ["Kept the sandbox on while the agent works (2 more hours)."],
  );
  assert.deepEqual(env.changed, [[env.task.id]]);
  // The note doesn't count as activity: the idle stop's clock is untouched.
  assert.equal(env.store.get(env.task.id)!.updatedAt, updatedAt);

  // boat's list may still show the old deadline: no second extend inside the window.
  env.time.advance(MINUTE);
  await keep();
  await keep();
  assert.equal(env.boat.extended.length, 1);

  // Near the new deadline, with the turn still running: extended again, but no second note this turn.
  env.time.advance(100 * MINUTE);
  await keep();
  assert.equal(env.boat.extended.length, 2);
  assert.equal(env.notes().length, 1);

  // The turn ends; a later turn gets its own note.
  env.chat.finish(env.task.threadId!, "Done.");
  await env.service.sweep();
  assert.equal(env.store.get(env.task.id)!.status, "idle");
  await env.service.followup(env.task.id, "One more thing.");
  await env.service.sweep();
  assert.equal(env.store.get(env.task.id)!.status, "running");
  env.time.advance(100 * MINUTE);
  await keep();
  assert.equal(env.boat.extended.length, 3);
  assert.equal(env.notes().length, 2);
  assert.deepEqual(env.warnings, []);
});

test("a sandbox whose turns are over is never extended: bb suspends it, and the idle stop works as before", async (t) => {
  const env = await taskChat();
  env.chat.finish(env.task.threadId!, "Done.");
  await env.service.sweep();
  assert.equal(env.store.get(env.task.id)!.status, "idle");

  // Far from the deadline: nothing.
  env.sandbox.archiveAfter = new Date(env.time.now() + 60 * MINUTE).toISOString();
  await env.keeper()();
  assert.deepEqual(env.boat.extended, []);
  assert.deepEqual(env.suspended, []);

  // Near it, idle: no extend; bb suspends the machine (it resumes on the next message).
  env.sandbox.archiveAfter = new Date(env.time.now() + 10 * MINUTE).toISOString();
  await env.keeper()();
  assert.deepEqual(env.boat.extended, []);
  assert.deepEqual(env.suspended, [env.task.hostId]);
  assert.equal(env.notes().length, 0);

  // The plugin's own idle stop (Stop idle sandboxes after, 30 min) still suspends it once it has waited.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 31 * MINUTE });
  try {
    await env.service.sweep();
  } finally {
    t.mock.timers.reset();
  }
  assert.deepEqual(env.chat.suspended, [env.task.hostId]);
});

test("a chat that only reads idle still counts: background agents and queued work keep the sandbox on, an archived chat doesn't", async () => {
  assert.equal(threadWorking({ status: "idle", activity: { activeBackgroundAgentCount: 1 } }), true);
  assert.equal(threadWorking({ status: "idle", queuedWork: "waiting" }), true);
  assert.equal(threadWorking({ status: "stopping" }), true);
  assert.equal(threadWorking({ status: "active", archivedAt: 5 }), false);
  assert.equal(threadWorking({ status: "error" }), false);
  assert.equal(threadWorking({ status: "idle", queuedWork: "none", activity: { activeBackgroundAgentCount: 0 } }), false);

  // The task's turn ended, but a workflow it started still runs in its chat.
  const env = await taskChat();
  env.chat.finish(env.task.threadId!, "Done.");
  await env.service.sweep();
  env.chat.states.get(env.task.threadId!)!.backgroundAgents = 2;
  await env.keeper()();
  assert.equal(env.boat.extended.length, 1);
  assert.deepEqual(env.suspended, []);
  assert.equal(env.notes().length, 1, "the task's chat works: its history says why the sandbox stayed on");
});

test("the extend stays within the plan's cap, and within what boat accepts when its limits can't be read", async () => {
  // The plan's cap (3 h) under Hard stop after (4 h).
  const capped = await taskChat();
  capped.boat.limitsValue = { ...capped.boat.limitsValue, autoStopCapHours: 3 };
  await capped.keeper()();
  assert.deepEqual(capped.boat.extended.at(-1)!.args, ["--ttl", "10800"]);

  // No cap: Hard stop after (1.5 h here).
  const uncapped = await taskChat(defaultSettings({ workerMode: "chat", sandboxTtlHours: 1.5 }));
  uncapped.boat.limitsValue = { ...uncapped.boat.limitsValue, autoStopCapHours: null };
  await uncapped.keeper()();
  assert.deepEqual(uncapped.boat.extended.at(-1)!.args, ["--ttl", "5400"]);
  assert.match(uncapped.notes()[0]!.text, /\(1\.5 more hours\)/);

  // boat can't be read: the setting first, then the cap boat names when it refuses.
  const unread = await taskChat();
  unread.boat.limitsError = new Error("boat.dev didn't answer");
  unread.boat.autoStopCapSeconds = 7200;
  await unread.keeper()();
  assert.deepEqual(unread.boat.extended.at(-1)!.args, ["--ttl", "7200"]);
  assert.match(unread.notes()[0]!.text, /\(2 more hours\)/);

  // A short Hard stop (30 min): extended at half of it, so one extend isn't followed by another.
  const short = await taskChat(defaultSettings({ workerMode: "chat", sandboxTtlHours: 0.25 }));
  extendsLikeBoat(short.boat, short.time.now);
  const keep = short.keeper();
  short.sandbox.archiveAfter = new Date(short.time.now() + 20 * MINUTE).toISOString();
  await keep();
  assert.equal(short.boat.extended.length, 0, "20 of 30 minutes left");
  short.time.advance(6 * MINUTE);
  await keep();
  assert.deepEqual(short.boat.extended.map((entry) => entry.args), [["--ttl", "1800"]]);
  for (let minute = 0; minute < 10; minute += 1) {
    short.time.advance(MINUTE);
    await keep();
  }
  assert.equal(short.boat.extended.length, 1);
  assert.match(short.notes()[0]!.text, /\(30 more minutes\)/);
});

test("a failed extend is retried after a pause, not on every pass", async () => {
  const env = await taskChat();
  const keep = env.keeper();
  const extend = env.boat.extend.bind(env.boat);
  let failures = 1;
  let tries = 0;
  env.boat.extend = async (id, args) => {
    tries += 1;
    if (failures-- > 0) throw new Error("boat.dev didn't answer");
    return extend(id, args);
  };
  await keep();
  await keep();
  assert.equal(tries, 1);
  assert.equal(env.warnings.length, 1);
  assert.match(env.warnings[0]!, /didn't answer/);
  env.time.advance(3 * MINUTE);
  await keep();
  assert.equal(tries, 2);
  assert.equal(env.boat.extended.length, 1);
});

test("a running task chat counts even when bb lists no chats there; bb not answering about chats is no reason to suspend", async () => {
  const env = await taskChat();
  // bb lists no chats on the machine, but the task's turn runs (the plugin's record).
  env.setThreads(() => []);
  await env.keeper()();
  assert.equal(env.boat.extended.length, 1);

  // An idle machine whose chats bb can't list: neither extended nor suspended.
  const idle = await taskChat();
  idle.chat.finish(idle.task.threadId!, "Done.");
  await idle.service.sweep();
  idle.setThreads(() => new Error("bb is restarting"));
  await idle.keeper()();
  assert.deepEqual(idle.boat.extended, []);
  assert.deepEqual(idle.suspended, []);
});

test("chats on a Boat sandbox without a task (a cloud orchestrator) are kept on too, and suspended once idle", async () => {
  const time = clock();
  const boat = new FakeBoat();
  const store = memoryStore();
  const sandbox: Sandbox = await boat.create({ name: "bb machine orch", type: "small", ttlSeconds: 7200 });
  sandbox.archiveAfter = new Date(time.now() + 5 * MINUTE).toISOString();
  let status = "active";
  const { bb, suspended } = fakeBb(() => [{ hostId: "host_orch", sandboxId: sandbox.id, threads: () => [{ id: "thr_orch", status }] }]);
  const changed: string[][] = [];
  const keeper = () =>
    createSandboxKeeper(bb, {
      boat: boat as unknown as BoatApi,
      store,
      settings: async () => defaultSettings(),
      signal: new AbortController().signal,
      log: () => undefined,
      changed: (ids) => changed.push(ids),
      now: time.now,
    });
  await keeper()();
  assert.deepEqual(boat.extended, [{ id: sandbox.id, args: ["--ttl", "7200"] }]);
  assert.deepEqual(changed, [], "no task to note it on");
  assert.deepEqual(suspended, []);

  status = "idle";
  await keeper()();
  assert.equal(boat.extended.length, 1);
  assert.deepEqual(suspended, ["host_orch"]);
});

test("the keeper leaves alone: a sandbox moving to a chat, a machine bb has down, and headless tasks (boat sees those)", async () => {
  const time = clock();
  const boat = new FakeBoat();
  const store = memoryStore();
  const sandbox = await boat.create({ name: "worker", type: "small", ttlSeconds: 7200 });
  sandbox.archiveAfter = new Date(time.now() + 5 * MINUTE).toISOString();
  let phase = "active";
  const { bb, suspended } = fakeBb(() => [{ hostId: "host_1", sandboxId: sandbox.id, threads: () => [{ id: "thr_1", status: "active" }], phase }]);
  const deps = { boat: boat as unknown as BoatApi, store, settings: async () => defaultSettings(), signal: new AbortController().signal, log: () => undefined, now: time.now };
  await createSandboxKeeper(bb, { ...deps, skip: (id) => id === sandbox.id })();
  assert.deepEqual(boat.extended, []);
  assert.deepEqual(suspended, []);
  phase = "suspending";
  await createSandboxKeeper(bb, deps)();
  assert.deepEqual(boat.extended, []);

  // A headless task's turn: boat keeps its own agents' sandboxes on.
  const env = makeService();
  const { task } = await env.service.launchTask({ title: "Fix it", role: "implement", brief: "Fix it.", repo: "acme/web" }, 5_000);
  assert.equal(task.runner, "boat");
  assert.equal(task.status, "running");
  env.boat.sandboxes.get(task.sandboxId!)!.archiveAfter = new Date(Date.now() + 5 * MINUTE).toISOString();
  await createSandboxKeeper(fakeBb(() => []).bb, { ...deps, boat: env.boat as unknown as BoatApi, store: env.store, now: undefined })();
  assert.deepEqual(env.boat.extended, []);
});
