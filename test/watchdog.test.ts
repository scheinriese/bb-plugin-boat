// The watchdog: bb's record of Boat sandbox machines kept true to boat, a
// chat waiting on a stopped machine resumed, one [boat] notice per incident
// (and none for a normal stop), and the note a worker gets after a stop
// that cut off its background work.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { BbPluginApi, PluginKvStorage } from "@get-bb/plugin-sdk";
import { makeMessageDispatchHookContext, makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import type { BoatApi } from "../src/boat-api.ts";
import { RESUME_NOTE_PREFIX, WATCHDOG_PREFIX } from "../src/format.ts";
import { KEEP_LIMIT_MS } from "../src/activity.ts";
import { createWatchdog, resumeNoteKey, type QueuedRow, type WatchdogDeps } from "../src/watchdog.ts";
import { createTestHost, makeService } from "./fakes.ts";

const MINUTE = 60_000;

function memoryKv(): PluginKvStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    set: async (key, value) => void data.set(key, structuredClone(value)),
    delete: async (key) => void data.delete(key),
    list: async (prefix = "") => [...data.keys()].filter((key) => key.startsWith(prefix)),
  };
}

interface FakeHost {
  id: string;
  status: "connected" | "disconnected";
  lastSeenAt: number | null;
  lifecycle: { phase: string; suspendedAt: number | null };
}

/** A task chat on its Boat sandbox machine, bb's view of it, and a watchdog over both. */
async function world(options: { resumeFails?: boolean } = {}) {
  let at = Date.parse("2026-11-06T10:00:00.000Z");
  const now = () => at;
  const env = makeService({ chat: true });
  const { task } = await env.service.launchTask(
    { title: "Deep refactor", role: "implement", brief: "Refactor it.", repo: "acme/web", orchestratorThreadId: "thr_orch", projectId: "proj_personal" },
    5_000,
  );
  const sandbox = env.boat.sandboxes.get(task.sandboxId!)!;
  sandbox.state = "idle";
  const host: FakeHost = { id: task.hostId!, status: "connected", lastSeenAt: at, lifecycle: { phase: "active", suspendedAt: null } };
  let row: Record<string, unknown> = { id: task.threadId, status: "idle", queuedWork: "none", activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeWorkflowCount: 0 } };
  const queued = new Map<string, QueuedRow[]>();
  const events = new Map<string, { createdAt: number }[]>();
  const calls = { suspend: [] as string[], resume: [] as string[], updates: [] as { queuedMessageId: string; input: unknown[] }[] };
  let failSuspend: () => boolean = () => false;
  const bb = {
    pluginId: "boat",
    sdk: {
      hosts: {
        list: async () => [{ ...host, machineProviderId: "boat-sandbox" }],
        get: async () => ({ ...host, machineProviderId: "boat-sandbox" }),
        experimental_suspend: async ({ hostId }: { hostId: string }) => {
          calls.suspend.push(hostId);
          if (failSuspend()) throw new Error("the machine's daemon is gone");
          host.lifecycle = { phase: "suspended", suspendedAt: at };
          host.status = "disconnected";
        },
        experimental_resume: async ({ hostId }: { hostId: string }) => {
          calls.resume.push(hostId);
          if (options.resumeFails) throw new Error("boat start limit reached");
        },
      },
      threads: {
        list: async (args: { hostId?: string; threadIds?: string[] }) => (args.hostId === host.id || args.threadIds?.includes(task.threadId!) ? [row] : []),
        queuedMessages: {
          list: async ({ threadId }: { threadId: string }) => queued.get(threadId) ?? [],
          update: async (args: { queuedMessageId: string; input: unknown[] }) => void calls.updates.push(args),
        },
        events: { list: async ({ threadId }: { threadId: string }) => events.get(threadId) ?? [] },
      },
    },
    experimental_machines: { getResource: async () => ({ sandboxId: sandbox.id, key: `task-${task.id}` }) },
  } as unknown as BbPluginApi;
  const kv = memoryKv();
  const told: { threadId: string; text: string }[] = [];
  const pushed: string[] = [];
  let handingOver = false;
  const watchdog = (extra: Partial<WatchdogDeps> = {}) =>
    createWatchdog(bb, {
      boat: env.boat as unknown as BoatApi,
      store: env.store,
      kv,
      tell: async (threadId, text) => void told.push({ threadId, text }),
      deferred: async () => handingOver,
      notifyUser: async (_title, body) => void pushed.push(body),
      log: () => undefined,
      now,
      ...extra,
    });
  return {
    env,
    task,
    sandbox,
    host,
    queued,
    events,
    calls,
    kv,
    told,
    pushed,
    watchdog,
    advance: (ms: number) => void (at += ms),
    now,
    setRow: (next: Record<string, unknown>) => void (row = { ...row, ...next }),
    handover: (on: boolean) => void (handingOver = on),
    setFailSuspend: (fails: () => boolean) => void (failSuspend = fails),
    /** boat stops the sandbox behind bb's back (its auto-stop): bb loses the daemon, keeps the machine active. */
    boatStops() {
      sandbox.state = "stopped";
      host.status = "disconnected";
      host.lastSeenAt = at;
    },
  };
}

const WORKFLOW = { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeWorkflowCount: 1 };

test("boat's own stop of an idle machine is brought in line with bb, quietly", async () => {
  const w = await world();
  const dog = w.watchdog();
  await dog.tick();
  w.boatStops();
  w.advance(MINUTE);
  await dog.tick();
  // bb now has it suspended, so it resumes it on the next message instead of waiting for good.
  assert.deepEqual(w.calls.suspend, [w.host.id]);
  assert.equal(w.told.length, 0);
  assert.match(w.env.store.events(w.task.id, 50).map((event) => event.text).join("\n"), /boat stopped the sandbox .*suspended its bb machine to match/);
  w.advance(MINUTE);
  await dog.tick();
  assert.deepEqual(w.calls.suspend, [w.host.id], "once");
});

test("a stop under background work: one notice naming it, and a note for the worker; never twice, not after a restart", async () => {
  const w = await world();
  const dog = w.watchdog();
  w.setRow({ activity: WORKFLOW });
  await dog.tick();
  w.boatStops();
  w.advance(MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 1);
  const [notice] = w.told;
  assert.equal(notice!.threadId, "thr_orch");
  assert.ok(notice!.text.startsWith(WATCHDOG_PREFIX), notice!.text);
  assert.match(notice!.text, new RegExp(`Task ${w.task.id}'s sandbox \\(${w.sandbox.id}, "Deep refactor"\\) stopped at 10:00 UTC while work was running in the background \\(a bb workflow\\)`));
  assert.match(notice!.text, /boat stopped it \(its auto-stop, a crash or the boat\.dev dashboard\), not bb\. The plugin suspended its bb machine to match/);
  const note = await dog.noteFor(w.task.id);
  assert.ok(note?.startsWith(`${RESUME_NOTE_PREFIX} at 10:00 UTC while work was running in the background (a bb workflow)`), note ?? "");
  assert.match(note!, /background jobs and anything in \/tmp were lost\. Rerun what you still need now/);

  w.advance(MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 1, "no second notice");
  // The plugin restarts; bb still has the machine as active (say the suspend didn't stick).
  w.host.lifecycle = { phase: "active", suspendedAt: null };
  await w.watchdog().tick();
  assert.equal(w.told.length, 1, "the same incident after a restart");
});

test("the plugin's own idle stop with nothing in the background says nothing", async () => {
  const w = await world();
  const dog = w.watchdog();
  await dog.tick();
  // The idle stop suspended it through bb.
  w.host.lifecycle = { phase: "suspended", suspendedAt: w.now() };
  w.host.status = "disconnected";
  w.sandbox.state = "stopped";
  w.advance(MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 0);
  assert.deepEqual(w.calls.suspend, []);
  assert.equal(await dog.noteFor(w.task.id), null);
});

test("the plugin's own stop right after background work ended says nothing; one at its limit says so", async () => {
  const w = await world();
  const dog = w.watchdog();
  w.setRow({ activity: WORKFLOW });
  await dog.tick();
  // The workflow ends; the idle stop suspends the machine before the watchdog looks again.
  w.setRow({ activity: { ...WORKFLOW, activeWorkflowCount: 0 } });
  dog.planned(w.host.id, false);
  w.host.lifecycle = { phase: "suspended", suspendedAt: w.now() };
  w.host.status = "disconnected";
  w.sandbox.state = "stopped";
  w.advance(MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 0);

  const capped = await world();
  const watch = capped.watchdog();
  capped.setRow({ activity: WORKFLOW });
  await watch.tick();
  watch.planned(capped.host.id, true);
  capped.host.lifecycle = { phase: "suspended", suspendedAt: capped.now() };
  capped.host.status = "disconnected";
  capped.sandbox.state = "stopped";
  capped.advance(MINUTE);
  await watch.tick();
  assert.equal(capped.told.length, 1);
  assert.match(capped.told[0]!.text, /The plugin suspended it: that's the most it keeps a sandbox on for background work\./);
});

test("a stop at the 12-hour limit for background work says it may have been stuck, without 'rerun it now'", async () => {
  const w = await world();
  const dog = w.watchdog();
  w.setRow({ activity: { ...WORKFLOW, activeWorkflowCount: 0, activeBackgroundCommandCount: 1 } });
  await dog.tick();
  w.advance(KEEP_LIMIT_MS);
  await dog.tick();
  // The idle stop (or the keeper) suspends it at its limit.
  w.host.lifecycle = { phase: "suspended", suspendedAt: w.now() };
  w.host.status = "disconnected";
  w.sandbox.state = "stopped";
  w.advance(MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 1);
  assert.match(w.told[0]!.text, /while work was running in the background \(a background command\)\. bb suspended the machine\./);
  assert.match(w.told[0]!.text, /It had run 12 hours, the most the plugin keeps a sandbox on for background work, so it may have been stuck/);
  const note = (await dog.noteFor(w.task.id))!;
  assert.match(note, /Restart a job only if you still need it/);
  assert.doesNotMatch(note, /Rerun what you still need now/);
});

test("a message waiting for a stopped machine resumes it; the orchestrator hears after 3 minutes, once", async () => {
  const w = await world();
  const dog = w.watchdog();
  w.host.lifecycle = { phase: "suspended", suspendedAt: w.now() };
  w.host.status = "disconnected";
  w.sandbox.state = "stopped";
  w.setRow({ queuedWork: "waiting" });
  w.queued.set(w.task.threadId!, [{ id: "q1", threadId: w.task.threadId!, content: [{ type: "text", text: "Status?" }], createdAt: w.now(), updatedAt: w.now(), state: "waiting", waitingOn: { kind: "host-offline" } }]);
  await dog.tick();
  assert.deepEqual(w.calls.resume, [], "bb gets a moment to resume it itself");
  w.advance(MINUTE);
  await dog.tick();
  assert.deepEqual(w.calls.resume, [w.host.id]);
  assert.equal(w.told.length, 0);
  w.advance(3 * MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 1);
  assert.match(w.told[0]!.text, new RegExp(`^\\[boat\\] Watchdog: Messages to task ${w.task.id} \\("Deep refactor"\\) have waited 4 minutes for its machine: sandbox ${w.sandbox.id} is stopped\\. The plugin resumed it`));
  assert.deepEqual(w.calls.resume, [w.host.id], "not again within its back-off");
  w.advance(10 * MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 1, "one notice per wait");
});

test("a failed resume is said as such", async () => {
  const w = await world({ resumeFails: true });
  const dog = w.watchdog();
  w.host.lifecycle = { phase: "suspended", suspendedAt: w.now() };
  w.host.status = "disconnected";
  w.sandbox.state = "stopped";
  w.setRow({ queuedWork: "waiting" });
  w.queued.set(w.task.threadId!, [{ id: "q1", threadId: w.task.threadId!, content: [], createdAt: w.now(), updatedAt: w.now(), state: "waiting", waitingOn: { kind: "provisioning" } }]);
  await dog.tick();
  w.advance(4 * MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 1);
  assert.match(w.told[0]!.text, /The plugin tried to resume it and couldn't: boat start limit reached\./);
});

test("messages held for later on purpose don't wake a machine: a retry at a limit's reset, a slot, an answer", async () => {
  const w = await world();
  const dog = w.watchdog();
  w.host.lifecycle = { phase: "suspended", suspendedAt: w.now() };
  w.host.status = "disconnected";
  w.sandbox.state = "stopped";
  w.setRow({ queuedWork: "waiting" });
  w.queued.set(w.task.threadId!, [
    { id: "q1", threadId: w.task.threadId!, content: [], createdAt: w.now(), updatedAt: w.now(), state: "scheduled", waitingOn: { kind: "time" }, sendAt: w.now() + 4 * 3_600_000 },
    { id: "q2", threadId: w.task.threadId!, content: [], createdAt: w.now(), updatedAt: w.now(), state: "waiting", waitingOn: { kind: "plugin" } },
  ]);
  for (let step = 0; step < 4; step += 1) {
    w.advance(2 * MINUTE);
    await dog.tick();
  }
  assert.deepEqual(w.calls.resume, []);
  assert.equal(w.told.length, 0);
});

test("an orchestrator's follow-up waiting on a stopped worker machine resumes it; the watchdog's own notices don't", async () => {
  const w = await world();
  const dog = w.watchdog();
  w.host.lifecycle = { phase: "suspended", suspendedAt: w.now() };
  w.host.status = "disconnected";
  w.sandbox.state = "stopped";
  w.setRow({ queuedWork: "waiting" });
  const followup = { id: "q1", threadId: w.task.threadId!, content: [{ type: "text", text: "Follow-up from the orchestrator" }], createdAt: w.now(), updatedAt: w.now(), state: "waiting", waitingOn: { kind: "host-offline" }, originPluginId: "boat" };
  w.queued.set(w.task.threadId!, [followup]);
  await dog.tick();
  w.advance(MINUTE);
  await dog.tick();
  assert.deepEqual(w.calls.resume, [w.host.id]);

  const own = await world();
  const watch = own.watchdog();
  own.host.lifecycle = { phase: "suspended", suspendedAt: own.now() };
  own.host.status = "disconnected";
  own.sandbox.state = "stopped";
  own.setRow({ queuedWork: "waiting" });
  own.queued.set(own.task.threadId!, [{ ...followup, threadId: own.task.threadId!, content: [{ type: "text", text: "[boat] Watchdog: Your own sandbox stopped" }] }]);
  await watch.tick();
  own.advance(5 * MINUTE);
  await watch.tick();
  assert.deepEqual(own.calls.resume, []);
  assert.equal(own.told.length, 0);
});

test("a message scheduled for later waits from when it came due, and bb gets its moment to resume the machine", async () => {
  const w = await world();
  const dog = w.watchdog();
  const created = w.now();
  // Due 4 hours after it was written (a retry at a limit's reset); it comes due now.
  w.advance(4 * 3_600_000);
  w.host.lifecycle = { phase: "suspended", suspendedAt: created };
  w.host.status = "disconnected";
  w.sandbox.state = "stopped";
  w.setRow({ queuedWork: "waiting" });
  w.queued.set(w.task.threadId!, [{ id: "q1", threadId: w.task.threadId!, content: [], createdAt: created, sendAt: w.now(), updatedAt: w.now(), state: "waiting", waitingOn: { kind: "provisioning" } }]);
  await dog.tick();
  assert.deepEqual(w.calls.resume, [], "bb gets 45 seconds to resume it itself");
  assert.equal(w.told.length, 0, "it hasn't waited 4 hours");
});

test("a failed suspend is tried again, but reported and noted once", async () => {
  const w = await world();
  let fail = true;
  const dog = w.watchdog();
  w.setRow({ activity: WORKFLOW });
  await dog.tick();
  w.boatStops();
  // The first suspend fails; bb keeps listing the machine's (stale) workflow.
  w.setFailSuspend(() => fail);
  w.advance(MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 1);
  // The worker takes the note.
  await dog.queued({ id: "q1", threadId: w.task.threadId!, content: [{ type: "text", text: "Hi" }], updatedAt: 1, editable: true });
  assert.equal(await dog.noteFor(w.task.id), null);
  fail = false;
  w.advance(5 * MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 1, "no second notice");
  assert.equal(await dog.noteFor(w.task.id), null, "the note isn't armed again");
  assert.equal(w.env.store.events(w.task.id, 50).filter((event) => event.text.startsWith("The sandbox stopped while")).length, 1);
});

test("while bb resumes the machine itself, the notice waits 10 minutes", async () => {
  const w = await world();
  const dog = w.watchdog();
  w.host.lifecycle = { phase: "resuming", suspendedAt: null };
  w.host.status = "disconnected";
  w.sandbox.state = "stopped";
  w.setRow({ queuedWork: "waiting" });
  w.queued.set(w.task.threadId!, [{ id: "q1", threadId: w.task.threadId!, content: [], createdAt: w.now(), updatedAt: w.now(), state: "waiting", waitingOn: { kind: "host-offline" } }]);
  w.advance(5 * MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 0);
  assert.deepEqual(w.calls.resume, [], "bb is at it");
  w.advance(6 * MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 1);
  assert.match(w.told[0]!.text, /sandbox \S+ is starting up\. bb is resuming it itself/);
});

test("notices wait while their orchestrator is handed over, then go out once", async () => {
  const w = await world();
  const dog = w.watchdog();
  w.setRow({ activity: WORKFLOW });
  await dog.tick();
  w.handover(true);
  w.boatStops();
  w.advance(MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 0);
  w.handover(false);
  w.advance(MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 1);
  w.advance(MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 1);
});

test("a turn quiet for 30 minutes: one notice; none while it waits on the user or on background work", async () => {
  const w = await world();
  const dog = w.watchdog();
  w.setRow({ status: "active" });
  w.events.set(w.task.threadId!, [{ createdAt: w.now() }]);
  await dog.tick();
  w.advance(20 * MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 0);
  w.advance(11 * MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 1);
  assert.match(w.told[0]!.text, new RegExp(`^\\[boat\\] Watchdog: Task ${w.task.id}'s turn \\("Deep refactor"\\) has shown no new activity for 31 minutes \\(last at 10:00 UTC\\); it may be stuck\\. The plugin left it running\\.`));
  w.advance(30 * MINUTE);
  await dog.tick();
  assert.equal(w.told.length, 1, "once per turn");

  for (const quiet of [{ hasPendingInteraction: true }, { activity: WORKFLOW }]) {
    const other = await world();
    const watch = other.watchdog();
    other.setRow({ status: "active", ...quiet });
    other.events.set(other.task.threadId!, [{ createdAt: other.now() }]);
    await watch.tick();
    other.advance(31 * MINUTE);
    await watch.tick();
    assert.deepEqual(other.told, [], JSON.stringify(quiet));
  }
});

test("the note goes in front of a message queued for the worker, for the agent only, once", async () => {
  const w = await world();
  await w.kv.set(resumeNoteKey(w.task.id), { taskId: w.task.id, threadId: w.task.threadId, text: `${RESUME_NOTE_PREFIX} at 10:00 UTC while work was running in the background.` });
  const dog = w.watchdog();
  await dog.load();
  const row: QueuedRow = { id: "q7", threadId: w.task.threadId!, content: [{ type: "text", text: "Did the migration finish?", mentions: [] }], updatedAt: 5, editable: true, state: "waiting", waitingOn: { kind: "host-offline" } };
  await dog.queued(row);
  assert.equal(w.calls.updates.length, 1);
  const [first, second] = w.calls.updates[0]!.input as { text: string; visibility?: string }[];
  assert.ok(first!.text.startsWith(RESUME_NOTE_PREFIX));
  assert.equal(first!.visibility, "agent-only");
  assert.equal(second!.text, "Did the migration finish?");
  assert.equal(await dog.noteFor(w.task.id), null);
  assert.ok(w.env.store.events(w.task.id, 50).some((event) => event.text.includes("Told the agent (before the next message)")));
  await dog.queued({ ...row, id: "q8" });
  assert.equal(w.calls.updates.length, 1, "once");
});

test("a closed task's note is dropped", async () => {
  const w = await world();
  await w.kv.set(resumeNoteKey(w.task.id), { taskId: w.task.id, threadId: w.task.threadId, text: `${RESUME_NOTE_PREFIX} at 10:00 UTC.` });
  const dog = w.watchdog();
  await dog.load();
  w.env.store.update(w.task.id, { status: "done" });
  await dog.tick();
  assert.equal(w.kv.data.has(resumeNoteKey(w.task.id)), false);
  assert.deepEqual(dog.dispatch({ threadId: w.task.threadId!, attempt: "start-turn", text: "Hi", queued: [], originPluginId: null }), { action: "proceed" });
});

test("the dispatch hook holds a message straight to the worker once (so the note can go first), and nothing else", async () => {
  const w = await world();
  const dog = w.watchdog();
  const plain = { threadId: w.task.threadId!, attempt: "start-turn", text: "Hi", queued: [], originPluginId: null };
  // No note: every message goes ahead, at once.
  assert.deepEqual(dog.dispatch(plain), { action: "proceed" });
  await w.kv.set(resumeNoteKey(w.task.id), { taskId: w.task.id, threadId: w.task.threadId, text: `${RESUME_NOTE_PREFIX} at 10:00 UTC.` });
  await dog.load();
  assert.deepEqual(dog.dispatch({ ...plain, threadId: "thr_other" }), { action: "proceed" });
  assert.deepEqual(dog.dispatch({ ...plain, attempt: "join-turn" }), { action: "proceed" });
  assert.deepEqual(dog.dispatch({ ...plain, originPluginId: "boat" }), { action: "proceed" }, "the plugin's follow-ups carry it themselves");
  const held = dog.dispatch(plain);
  assert.equal(held.action, "wait");
  assert.equal((held as { sendAt: number }).sendAt, w.now() + 10_000);
  assert.deepEqual(dog.dispatch(plain), { action: "proceed" }, "never twice");
});

test("in the plugin: the dispatch hook answers at once, and a message queued for an offline machine is handled", async (t) => {
  process.env.FAKE_BOAT_STATE = join(mkdtempSync(join(tmpdir(), "boat-watchdog-")), "state.json");
  const { bb, harness } = await createTestHost({
    pluginId: "boat",
    settings: { boatPath: fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url)), evidenceUploader: "" },
    agentSkillIds: ["boat", "boat-orchestrator"],
  });
  t.after(() => harness.lifecycle.dispose());
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
  await plugin(bb);
  const hook = harness.inspection.registrations.hooks["message.dispatch"];
  assert.ok(hook !== null, "registered");
  // No pending note anywhere: every message goes ahead, without waiting on anything.
  const decision = hook(makeMessageDispatchHookContext());
  assert.deepEqual(decision instanceof Promise ? await decision : decision, { action: "proceed" });
  const queued = await harness.emitThreadEvent("message.queued", { entry: makeQueueEntry({ waitingOn: { kind: "host-offline", hostName: "Boat bx_1 (abc123)" } }) });
  assert.deepEqual(queued.errors, []);
});

test("after a suspend through bb, an orchestrator on that machine hears of it once the machine is up again (the notice doesn't wake it)", async () => {
  const w = await world();
  w.env.store.addOrchestrator("thr_cloud");
  w.setRow({ id: "thr_cloud", activity: WORKFLOW });
  const dog = w.watchdog();
  await dog.tick();
  // Someone suspends the machine from bb's menu while the workflow runs.
  w.host.lifecycle = { phase: "suspended", suspendedAt: w.now() };
  w.host.status = "disconnected";
  w.sandbox.state = "stopped";
  w.advance(MINUTE);
  await dog.tick();
  assert.deepEqual(w.told.map((entry) => entry.threadId), ["thr_orch"], "the task's orchestrator hears now; the one on the machine doesn't yet");
  // The next message resumes it: then the orchestrator there hears of it.
  w.host.lifecycle = { phase: "active", suspendedAt: null };
  w.host.status = "connected";
  w.sandbox.state = "idle";
  w.setRow({ activity: { ...WORKFLOW, activeWorkflowCount: 0 } });
  w.advance(MINUTE);
  await dog.tick();
  assert.deepEqual(w.told.map((entry) => entry.threadId), ["thr_orch", "thr_cloud"]);
  assert.match(w.told[1]!.text, /^\[boat\] Watchdog: Your own sandbox/);
});
