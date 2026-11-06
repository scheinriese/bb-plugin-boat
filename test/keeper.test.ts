// The sandbox keeper: boat's auto-stop doesn't see a bb chat working, so the
// plugin keeps a sandbox on while a chat's turn runs there, and only then.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BoatApi, Sandbox } from "../src/boat-api.ts";
import { BLOCKED_GRACE_MS, KEEP_LIMIT_MS, KEPT_ON_EVENT, STOPPING_GRACE_MS, createSandboxKeeper, threadWorking, type KeeperDeps } from "../src/keeper.ts";
import { MACHINE_PROVIDER_ID } from "../src/machine.ts";
import { FakeBoat, defaultSettings, makeService, memoryStore } from "./fakes.ts";

const MINUTE = 60_000;

interface Machine {
  hostId: string;
  sandboxId: string;
  /** The chats on it, as bb lists them (an Error: bb can't list them). */
  threads: () => Record<string, unknown>[] | Error;
  phase?: string;
  /** bb's connection to its daemon (default connected). */
  status?: string;
  /** Child chats of its chats, by parent id, as bb lists them. */
  children?: Record<string, Record<string, unknown>[]>;
}

/** bb's side: Boat sandbox machines and the chats on them. */
function fakeBb(machines: () => Machine[]) {
  const suspended: string[] = [];
  const bb = {
    pluginId: "boat",
    sdk: {
      hosts: {
        list: async () =>
          machines().map((machine) => ({
            id: machine.hostId,
            machineProviderId: MACHINE_PROVIDER_ID,
            status: machine.status ?? "connected",
            lifecycle: { phase: machine.phase ?? "active", suspendedAt: null },
          })),
        experimental_suspend: async ({ hostId }: { hostId: string }) => void suspended.push(hostId),
      },
      threads: {
        list: async ({ hostId, parentThreadId }: { hostId?: string; parentThreadId?: string }) => {
          if (parentThreadId !== undefined) return machines().flatMap((machine) => machine.children?.[parentThreadId] ?? []);
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
  const keeper = (extra: Partial<KeeperDeps> = {}) =>
    createSandboxKeeper(bb, {
      boat: env.boat as unknown as BoatApi,
      store: env.store,
      settings: async () => settings,
      signal: new AbortController().signal,
      log: (line) => warnings.push(line),
      changed: (ids) => changed.push(ids),
      now: time.now,
      ...extra,
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

test("a chat that only reads idle still counts when background agents work there; an archived chat doesn't", async () => {
  assert.equal(threadWorking({ status: "idle", activity: { activeBackgroundAgentCount: 1 } }), true);
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

test("waiting isn't working: a chat waiting for a slot, for a retry, on the user (past a grace), or for its machine isn't kept on", async () => {
  // Waiting for a slot under bb's limits, or a queued message (a retry at a usage limit's reset).
  assert.equal(threadWorking({ status: "pending" }), false);
  assert.equal(threadWorking({ status: "idle", queuedWork: "waiting" }), false);
  // A turn under way, with a message queued behind it: working.
  assert.equal(threadWorking({ status: "active", queuedWork: "waiting" }), true);
  // Blocked on the user: working for a grace, then not.
  assert.equal(threadWorking({ status: "active", hasPendingInteraction: true }), true);
  assert.equal(threadWorking({ status: "active", hasPendingInteraction: true }, BLOCKED_GRACE_MS + 1), false);
  // A stop that hangs.
  assert.equal(threadWorking({ status: "stopping" }, STOPPING_GRACE_MS + 1), false);
  // Its machine is gone (bb's daemon there died) or not up: nothing there makes progress.
  assert.equal(threadWorking({ status: "active", runtime: { displayStatus: "waiting-for-host" } }), false);
  assert.equal(threadWorking({ status: "active", runtimeStatus: "provisioning" }), false);
  assert.equal(threadWorking({ status: "idle", runtime: { displayStatus: "waiting-for-host" }, activity: { activeBackgroundAgentCount: 1 } }), false);

  // The task's record says its turn runs (it mirrors bb's busy states), but bb lists the chat waiting.
  for (const row of [
    { status: "pending", queuedWork: "none" },
    { status: "idle", queuedWork: "waiting" },
    { status: "active", runtime: { displayStatus: "waiting-for-host" } },
  ]) {
    const env = await taskChat();
    assert.equal(env.store.get(env.task.id)!.status, "running");
    env.setThreads(() => [{ id: env.task.threadId, ...row }]);
    await env.keeper()();
    assert.deepEqual(env.boat.extended, [], JSON.stringify(row));
    // bb suspends the machine (a dead daemon is skipped) and resumes it on the next message.
    assert.deepEqual(env.suspended, [env.task.hostId], JSON.stringify(row));
    assert.equal(env.notes().length, 0);
  }
});

test("a chat waiting on the user, or stuck stopping, gets one more extend at most", async () => {
  for (const row of [{ status: "active", hasPendingInteraction: true }, { status: "stopping" }]) {
    const env = await taskChat();
    extendsLikeBoat(env.boat, env.time.now);
    env.setThreads(() => [{ id: env.task.threadId, ...row }]);
    const keep = env.keeper();
    await keep();
    assert.equal(env.boat.extended.length, 1, JSON.stringify(row));
    // Near the new deadline it still waits: no second extend; bb suspends it instead.
    env.time.advance(100 * MINUTE);
    await keep();
    assert.equal(env.boat.extended.length, 1, JSON.stringify(row));
    assert.deepEqual(env.suspended, [env.task.hostId], JSON.stringify(row));
  }

  // The user answers in time: the turn goes on, and so does the keeper.
  const env = await taskChat();
  extendsLikeBoat(env.boat, env.time.now);
  let blocked = true;
  env.setThreads(() => [{ id: env.task.threadId, status: "active", hasPendingInteraction: blocked }]);
  const keep = env.keeper();
  await keep();
  blocked = false;
  env.time.advance(100 * MINUTE);
  await keep();
  assert.equal(env.boat.extended.length, 2);
  assert.deepEqual(env.suspended, []);
});

test("a turn is kept on for 12 hours at most; then boat's stop comes, and the next turn starts over", async () => {
  const env = await taskChat();
  extendsLikeBoat(env.boat, env.time.now);
  const infos: string[] = [];
  const keep = env.keeper({ info: (line) => infos.push(line) });
  const start = env.time.now();
  while (env.suspended.length === 0 && env.time.now() - start < KEEP_LIMIT_MS + 4 * 60 * MINUTE) {
    await keep();
    env.time.advance(5 * MINUTE);
  }
  // Hard stop after within the trial's cap (2 h), extended about every 95 minutes while under 12 hours;
  // the last extends only reach to the 12 hours (half an hour at least), never 2 hours past them.
  assert.ok(env.boat.extended.length >= 8 && env.boat.extended.length <= 12, String(env.boat.extended.length));
  assert.ok(Date.parse(env.sandbox.archiveAfter!) <= start + KEEP_LIMIT_MS + 35 * MINUTE, env.sandbox.archiveAfter!);
  assert.ok(env.boat.extended.at(-1)!.args[1] !== "7200", "the last extend is cut to what's left");
  assert.ok(env.time.now() - start >= KEEP_LIMIT_MS);
  // Not extended again: near its deadline bb suspends it (it resumes on the next message).
  assert.deepEqual(env.suspended, [env.task.hostId]);
  assert.deepEqual(
    env.notes().map((event) => event.text),
    ["Kept the sandbox on while the agent works (2 more hours).", "Stopped keeping the sandbox on after 12 hours. bb suspends it before its auto-stop; the next message resumes it."],
  );
  assert.ok(infos.some((line) => /stopped keeping .* on after 12 hours/.test(line)));

  // A new turn (the chat's next message) is kept on again.
  env.chat.finish(env.task.threadId!, "Done.");
  await env.service.sweep();
  await env.service.followup(env.task.id, "One more thing.");
  await env.service.sweep();
  env.sandbox.archiveAfter = new Date(env.time.now() + 10 * MINUTE).toISOString();
  env.time.advance(MINUTE);
  const before = env.boat.extended.length;
  await keep();
  assert.equal(env.boat.extended.length, before + 1);
  assert.equal(env.boat.extended.at(-1)!.args[1], "7200", "a new turn gets the full Hard stop after again");
});

test("a machine isn't suspended under other work: a headless agent, a headless turn, a ship or wake in flight, a live preview", async () => {
  const env = await taskChat();
  env.chat.finish(env.task.threadId!, "Done.");
  await env.service.sweep();
  assert.equal(env.store.get(env.task.id)!.status, "idle");

  // boat says an agent of its own works there (a headless review in the same sandbox).
  env.sandbox.state = "running";
  await env.keeper()();
  assert.deepEqual(env.suspended, []);
  env.sandbox.state = "idle";

  // The plugin has a headless turn running there (boat's list may lag).
  const implementer = env.store.get(env.task.id)!;
  env.store.insert({ ...implementer, id: "t_review", role: "review", runner: "boat", status: "running", parentTaskId: implementer.id, threadId: null, hostId: null });
  await env.keeper()();
  assert.deepEqual(env.suspended, []);
  env.store.update("t_review", { status: "idle" });

  // A ship, dispatch or wake holds the sandbox right now.
  await env.keeper({ held: (id) => id === env.sandbox.id })();
  assert.deepEqual(env.suspended, []);

  // A live preview the user hasn't looked at yet.
  const preview = env.store.upsertPreview({
    taskId: env.task.id,
    sandboxId: env.sandbox.id,
    port: 3000,
    path: "/",
    command: null,
    url: "https://acme.example/preview",
    title: "Acme web",
    health: "up",
  });
  await env.keeper()();
  assert.deepEqual(env.suspended, []);
  assert.deepEqual(env.boat.extended, [], "none of these is a chat at work");

  // None of them any more: bb suspends it.
  env.store.upsertPreview({ taskId: preview.taskId, sandboxId: preview.sandboxId, port: preview.port, path: preview.path, command: null, url: preview.url, title: preview.title, health: "down" });
  await env.keeper()();
  assert.deepEqual(env.suspended, [env.task.hostId]);
});

test("the keeper's note doesn't hide a failover: a turn handed over once fails on a second usage limit", async () => {
  const env = await taskChat();
  env.chat.finish(env.task.threadId!, "Claude usage limit reached, resets at 5pm", "error");
  await env.service.sweep();
  const switched = env.store.get(env.task.id)!;
  assert.equal(switched.status, "running");
  assert.equal(switched.provider, "codex");
  assert.equal(env.store.events(env.task.id, 1).at(-1)!.kind, "failover");

  // Codex works on near the deadline: kept on, without a note after the failover.
  await env.keeper()();
  assert.equal(env.boat.extended.length, 1);
  assert.equal(env.notes().length, 0);
  assert.equal(env.store.events(env.task.id, 1).at(-1)!.kind, "failover");

  // Codex hits its limit too: one switch per turn, so the task fails.
  await env.service.sweep();
  env.chat.finish(switched.threadId!, "Codex usage limit reached, resets at 6pm", "error");
  await env.service.sweep();
  assert.equal(env.store.get(env.task.id)!.status, "failed");
  assert.equal(env.store.events(env.task.id, 200).filter((event) => event.kind === "failover").length, 1);
});

// ------------------------------------------------------- background work (0.1.2)

/** A cloud orchestrator's machine near boat's deadline, with whatever its chat runs. */
function orchestratorMachine(row: () => Record<string, unknown>, extra: Partial<Machine> = {}) {
  const time = clock();
  const boat = new FakeBoat();
  const store = memoryStore();
  const machine = { hostId: "host_orch", sandboxId: "", threads: () => [row()], ...extra } as Machine;
  const { bb, suspended } = fakeBb(() => [machine]);
  return {
    time,
    boat,
    store,
    machine,
    suspended,
    async start() {
      const sandbox = await boat.create({ name: "bb machine orch", type: "small", ttlSeconds: 7200 });
      machine.sandboxId = sandbox.id;
      sandbox.archiveAfter = new Date(time.now() + 10 * MINUTE).toISOString();
      return sandbox;
    },
    keeper: (deps: Partial<KeeperDeps> = {}) =>
      createSandboxKeeper(bb, { boat: boat as unknown as BoatApi, store, settings: async () => defaultSettings(), signal: new AbortController().signal, log: () => undefined, now: time.now, ...deps }),
  };
}

test("background commands and bb workflows keep a chat's sandbox on after its turn, like background agents", async () => {
  assert.equal(threadWorking({ status: "idle", activity: { activeBackgroundCommandCount: 1 } }), true);
  assert.equal(threadWorking({ status: "idle", activity: { activeWorkflowCount: 1 } }), true);
  // Its machine is down: nothing of it runs.
  assert.equal(threadWorking({ status: "idle", runtime: { displayStatus: "waiting-for-host" }, activity: { activeBackgroundCommandCount: 1 } }), false);

  for (const activity of [{ activeBackgroundCommandCount: 1 }, { activeWorkflowCount: 1 }]) {
    const env = orchestratorMachine(() => ({ id: "thr_orch", status: "idle", queuedWork: "none", activity }));
    const sandbox = await env.start();
    await env.keeper()();
    assert.deepEqual(env.boat.extended, [{ id: sandbox.id, args: ["--ttl", "7200"] }], JSON.stringify(activity));
    assert.deepEqual(env.suspended, []);
  }
});

test("a child chat working elsewhere keeps its parent's sandbox on; one on another Boat sandbox doesn't", async () => {
  const idle = () => ({ id: "thr_orch", status: "idle", queuedWork: "none", activity: { activeBackgroundAgentCount: 0 } });
  const elsewhere = orchestratorMachine(idle, { children: { thr_orch: [{ id: "thr_sub", status: "active", environmentHostId: "host_laptop" }] } });
  const sandbox = await elsewhere.start();
  await elsewhere.keeper()();
  assert.deepEqual(elsewhere.boat.extended, [{ id: sandbox.id, args: ["--ttl", "7200"] }]);

  // A task chat in its own Boat sandbox (that one is kept on for itself), or the plugin's own: suspended as before.
  const boatChild = orchestratorMachine(idle, {
    children: { thr_orch: [{ id: "thr_task", status: "active", environmentHostId: "host_orch" }, { id: "thr_mine", status: "active", environmentHostId: "host_laptop", originPluginId: "boat" }] },
  });
  await boatChild.start();
  await boatChild.keeper()();
  assert.deepEqual(boatChild.boat.extended, []);
  assert.deepEqual(boatChild.suspended, ["host_orch"]);
});

test("a machine bb has lost the connection to is never suspended on that (a daemon restart, a blip)", async () => {
  const env = orchestratorMachine(() => ({ id: "thr_orch", status: "idle", runtime: { displayStatus: "waiting-for-host" } }), { status: "disconnected" });
  await env.start();
  await env.keeper()();
  assert.deepEqual(env.suspended, []);
  assert.deepEqual(env.boat.extended, []);
});

test("right before boat's stop the keeper suspends through bb even with a live preview, and extends for a dispatch in flight", async () => {
  const env = await taskChat();
  env.chat.finish(env.task.threadId!, "Done.");
  await env.service.sweep();
  env.store.upsertPreview({ taskId: env.task.id, sandboxId: env.sandbox.id, port: 3000, path: "/", command: null, url: "https://acme.example/preview", title: "Acme web", health: "up" });
  // Ten minutes out: the preview keeps it on for now.
  await env.keeper()();
  assert.deepEqual(env.suspended, []);
  // Four minutes out: boat would stop it behind bb's back; through bb the next message brings it back.
  env.sandbox.archiveAfter = new Date(env.time.now() + 4 * MINUTE).toISOString();
  await env.keeper()();
  assert.deepEqual(env.suspended, [env.task.hostId]);

  // A ship, dispatch or wake holding the sandbox at that moment is work: extended instead.
  const held = await taskChat();
  held.chat.finish(held.task.threadId!, "Done.");
  await held.service.sweep();
  held.sandbox.archiveAfter = new Date(held.time.now() + 4 * MINUTE).toISOString();
  await held.keeper({ held: (id) => id === held.sandbox.id })();
  assert.deepEqual(held.suspended, []);
  assert.equal(held.boat.extended.length, 1);
});

test("a headless sandbox whose finished agent left processes computing is kept on; otherwise boat stops it as before", async () => {
  const env = makeService({ settings: defaultSettings() });
  const { task } = await env.service.launchTask({ title: "Benchmarks", role: "implement", brief: "Run them.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
  env.boat.finish(task.conversationId!, "Done.\n\n=== REPORT ===\nSTATUS: done\nPR: none\nBRANCH: boat/x\nSUMMARY: ran them\nTESTS: ok\nOPEN QUESTIONS: none\n=== END REPORT ===");
  await env.service.sweep();
  assert.equal(env.store.get(task.id)!.status, "idle");
  const time = clock();
  const sandbox = env.boat.sandboxes.get(task.sandboxId!)!;
  sandbox.archiveAfter = new Date(time.now() + 10 * MINUTE).toISOString();
  const { bb } = fakeBb(() => []);
  let computing: "busy" | "maybe" | "no" = "no";
  const keeper = () =>
    createSandboxKeeper(bb, {
      boat: env.boat as unknown as BoatApi,
      store: env.store,
      settings: async () => defaultSettings(),
      signal: new AbortController().signal,
      log: () => undefined,
      now: time.now,
      computing: async () => computing,
    });
  await keeper()();
  assert.deepEqual(env.boat.extended, []);
  computing = "maybe";
  await keeper()();
  assert.deepEqual(env.boat.extended, [{ id: sandbox.id, args: ["--ttl", "7200"] }]);
  assert.match(env.store.events(task.id, 50).find((event) => event.kind === KEPT_ON_EVENT)!.text, /while processes the agent started are still running/);
});
