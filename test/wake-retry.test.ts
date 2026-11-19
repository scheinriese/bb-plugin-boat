// Boat's own later wake of a sandbox boat.dev couldn't restore, and the hand-over to Needs you.
import assert from "node:assert/strict";
import { test } from "node:test";
import { WakePacer } from "../src/wake-pacer.ts";
import { GIVE_UP_AFTER, RETRY_MAX_MS, WAKE_EVENT, createWakeGuard, nextFailure, retryDelayMs, type MachineWake } from "../src/wake-retry.ts";
import type { ThreadRow } from "../src/activity.ts";
import { makeService } from "./fakes.ts";

const HYDRATOR = "ascii-agents-server[812]: [lazyfs] [ERROR] HYDRATOR FAILED attempt 32 (mount stays up, on-demand serving continues, retrying …): decode/feed: chunk 1 GET 0000.tar.zst: status code 503";
const KEY_STEP = "Machine bootstrap command failed: grep: /home/user/.ssh/authorized_keys: Input/output error";
const RATE = "Resume failed: Failed to restore snapshot: Please reduce your request rate.";

test("the retry schedule: 2, 4, 8, 16 minutes, at most 30, and Boat gives up at the 5th failure", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 12].map((failures) => retryDelayMs(failures) / 60_000), [2, 4, 8, 16, 30, 30, 30]);
  const now = 1_000_000;
  let previous = null as ReturnType<typeof nextFailure> & { [key: string]: unknown } | null;
  const plan: (number | null)[] = [];
  for (let index = 0; index < GIVE_UP_AFTER; index++) {
    const next = nextFailure(previous as never, now);
    plan.push(next.retryAt === null ? null : (next.retryAt - now) / 60_000);
    previous = { ...next } as never;
  }
  assert.deepEqual(plan, [2, 4, 8, 16, null]);
});

async function env(options: { maxWaitMs?: number; moves?: { forkCheck?: boolean }; threads?: boolean; storageMs?: number } = {}) {
  const fake = makeService();
  const { task } = await fake.service.launchTask({ title: "Cart spacing", role: "implement", brief: "Fix the spacing." }, 5_000);
  fake.store.addOrchestrator("thr_orch");
  fake.store.update(task.id, { orchestratorThreadId: "thr_orch" });
  const sandboxId = fake.store.get(task.id)!.sandboxId!;
  let at = Date.parse("2026-11-19T01:00:00Z");
  const pacer = new WakePacer({ now: () => at, sleep: async (ms) => { at += ms; }, ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }) });
  const kv = new Map<string, unknown>();
  const resumed: string[] = [];
  const logs: string[] = [];
  // What the check over boat's exec API finds there.
  let check = `BOAT_HYDRATOR ${HYDRATOR}\nBOAT_DISK fail .profile Input/output error\nBOAT_DISK_END\n`;
  // The sandbox's git checkouts (the move's scan), and what a test fork reads.
  let scan = "BOAT_GIT_SCAN_END\n";
  let fork = "BOAT_DISK ok .profile\nBOAT_DISK ok .bashrc\nBOAT_DISK_END\n";
  // bb's chats on the machine.
  let threads: ThreadRow[] = [{ id: "thr_orch", title: "Orchestrator", status: "idle" }];
  fake.boat.execResult = (script) => {
    const on = fake.boat.execs.at(-1)!.sandboxId;
    const stdout = script.includes("BOAT_GIT_SCAN_END") ? scan : on.startsWith("bx_fork") ? fork : check;
    return { exitCode: 0, stdout, stderr: "" };
  };
  const makeGuard = () => createWakeGuard({
    pacer,
    // storageMs: the clock moves on while the guard reads and writes its plans (a real kv takes a moment).
    kv: { async get<T>(key: string) { at += options.storageMs ?? 0; return kv.get(key) as T | undefined; }, async set(key: string, value: unknown) { at += options.storageMs ?? 0; kv.set(key, structuredClone(value)); } },
    boat: fake.boat as never,
    store: fake.store,
    resumeHost: async (hostId) => { resumed.push(hostId); },
    ...(options.threads === false ? {} : { threadsOn: async () => threads }),
    now: () => at,
    log: (line) => logs.push(line),
    ...(options.moves ? { moves: options.moves } : {}),
  });
  const guard = makeGuard();
  const steps: string[] = [];
  const wake = (): MachineWake => ({ sandboxId, hostId: "host_orch1", signal: new AbortController().signal, report: { step: (text) => steps.push(text), log: () => undefined } });
  return {
    ...fake, task, sandboxId, pacer, guard, makeGuard, kv, resumed, logs, steps, wake, now: () => at, advance(ms: number) { at += ms; },
    setCheck(text: string) { check = text; }, setScan(text: string) { scan = text; }, setFork(text: string) { fork = text; }, setThreads(rows: ThreadRow[]) { threads = rows; },
    /** One pass of the monitor, and the move step it started. */
    async pass() {
      const sandbox = await guard.tick();
      await guard.idle();
      return sandbox;
    },
  };
}

test("a disk still restoring: Boat retries later, refuses earlier resumes without asking boat.dev, then hands over to Needs you", async () => {
  const e = await env();
  let runs = 0;
  const failing = async (permit: () => Promise<unknown>) => { runs += 1; await permit(); throw new Error(KEY_STEP); };
  const delays = [2, 4, 8, 16];
  for (const [index, minutes] of delays.entries()) {
    const start = e.now();
    await assert.rejects(e.guard.machine(e.wake(), failing), (error: Error) => {
      assert.equal(error.message, `boat.dev is still restoring this sandbox's disk (its storage is returning errors). Boat will retry at ${new Date(start + minutes * 60_000).toISOString().slice(11, 16)} UTC; pressing Resume earlier won't help.`);
      return true;
    });
    const plan = (await e.guard.scheduled(e.sandboxId))!;
    assert.equal(plan.failures, index + 1);
    assert.equal(plan.retryAt, start + minutes * 60_000);
    assert.equal(plan.kind, "disk-restoring");
    assert.match(plan.detail!, /^HYDRATOR FAILED attempt 32/);
    // Pressing Resume before then: refused at once, boat.dev isn't asked.
    const before = runs;
    const execs = e.boat.execs.length;
    await assert.rejects(e.guard.machine(e.wake(), failing), /pressing Resume earlier won't help/);
    assert.equal(runs, before);
    assert.equal(e.boat.execs.length, execs);
    e.advance(minutes * 60_000);
  }
  // The 5th failure: Boat stops, and the orchestrator gets a Needs you item naming the sandbox and boat.dev's error.
  await assert.rejects(e.guard.machine(e.wake(), failing), (error: Error) => {
    assert.match(error.message, /^boat\.dev still couldn't restore this sandbox's disk after 5 tries \(its storage is returning errors\), so Boat stopped retrying on its own\. It's under Needs you\. Press Resume after \d\d:\d\d UTC, or try now with `bb boat sandbox resume bx_\w+`\.$/);
    return true;
  });
  const plan = (await e.guard.scheduled(e.sandboxId))!;
  assert.equal(plan.retryAt, null);
  const decisions = e.store.decisions({ statuses: ["open"] });
  assert.equal(decisions.length, 1);
  const decision = decisions[0]!;
  assert.equal(decision.orchestratorThreadId, "thr_orch");
  assert.ok(decision.question.includes(e.sandboxId), decision.question);
  assert.match(decision.question, /didn't wake after 5 tries: boat\.dev couldn't restore its disk/);
  assert.match(decision.context ?? "", /boat\.dev said: HYDRATOR FAILED attempt 32 .*status code 503/);
  assert.deepEqual(decision.taskIds, [e.task.id]);
  assert.equal(decision.shortLabel, "Sandbox won't wake");
  // Every failure is on the task, in the same plain words.
  const events = e.store.events(e.task.id, 200).filter((event) => event.kind === WAKE_EVENT);
  assert.equal(events.length, 5);
  assert.match(events[0]!.text, /^boat\.dev is still restoring this sandbox's disk/);
  // Boat's own retries stop: nothing is due; a resume waits RETRY_MAX_MS after the last failure.
  assert.equal(await e.guard.tick(), null);
  await assert.rejects(e.guard.machine(e.wake(), failing), /stopped retrying on its own/);
  e.advance(RETRY_MAX_MS);
  await assert.rejects(e.guard.machine(e.wake(), failing), /after 6 tries/);
  assert.equal(e.store.decisions({ statuses: ["open"] }).length, 1, "one Needs you item per episode");
  // An explicit resume starts over.
  await e.guard.forget(e.sandboxId);
  assert.equal(await e.guard.scheduled(e.sandboxId), null);
});

test("a wake that works ends the plan, and resets the account's pause", async () => {
  const e = await env();
  await assert.rejects(e.guard.machine(e.wake(), async (permit) => { await permit(); throw new Error(RATE); }), /asked Boat to slow down\. Boat will retry at 01:02 UTC/);
  assert.equal((await e.pacer.snapshot()).failures, 1, "a failed wake pauses the next one account-wide");
  assert.equal((await e.guard.scheduled(e.sandboxId))!.kind, "restore-rate-limited");
  e.advance(2 * 60_000);
  assert.equal(await e.guard.machine(e.wake(), async (permit) => { await permit(); return "up"; }), "up");
  assert.equal(await e.guard.scheduled(e.sandboxId), null);
  assert.equal((await e.pacer.snapshot()).failures, 0);
});

test("the monitor's pass fires a due retry through bb: once, one a pass, only with a free wake slot", async () => {
  const e = await env();
  await assert.rejects(e.guard.machine(e.wake(), async (permit) => { await permit(); throw new Error(KEY_STEP); }));
  assert.equal(await e.guard.tick(), null, "not due yet");
  e.advance(2 * 60_000);
  // Both of this minute's slots in use elsewhere: it waits for the next pass.
  await e.pacer.acquire();
  await e.pacer.acquire();
  assert.equal(await e.guard.tick(), null);
  e.advance(60_000);
  assert.equal(await e.guard.tick(), e.sandboxId);
  assert.deepEqual(e.resumed, ["host_orch1"]);
  assert.equal(await e.guard.tick(), null, "not fired again while bb's resume is out");
});

test("the monitor's pass fires a due retry even when time moves on while it reads its plans", async () => {
  // A free pacer answers "now" by its own clock, a little after the pass began.
  const e = await env({ storageMs: 3 });
  await assert.rejects(e.guard.machine(e.wake(), async (permit) => { await permit(); throw new Error(KEY_STEP); }));
  e.advance(2 * 60_000);
  // After a restart: the first pass reads its plans from storage, and the clock moves on meanwhile.
  const restarted = e.makeGuard();
  assert.equal(await restarted.tick(), e.sandboxId);
  assert.deepEqual(e.resumed, ["host_orch1"]);
});

test("a due node move starts even when time moves on while the pass reads its plans", async () => {
  const e = await env({ moves: {}, storageMs: 3 });
  e.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  const orch = e.boat.addSandbox("bx_orchbox", "small", "idle");
  await failUntilStuck(e, { ...e.wake(), sandboxId: orch.id, hostId: "host_orch" });
  // After a restart the first pass reads its plans from storage first.
  const restarted = e.makeGuard();
  assert.equal(await restarted.tick(), orch.id);
  await restarted.idle();
  assert.equal(e.boat.forks.length, 1, "the move's test fork ran");
});

test("too many wakes at once: the third is told when Boat wakes it, and Boat does", async () => {
  const e = await env({ maxWaitMs: 0 });
  await e.pacer.acquire();
  await e.pacer.acquire();
  await assert.rejects(e.guard.machine(e.wake(), async (permit) => { await permit(); return "up"; }), (error: Error) => {
    assert.equal(error.message, "Boat wakes at most 2 sandboxes a minute and others are waking now. Boat will wake this one at 01:01 UTC.");
    return true;
  });
  const plan = (await e.guard.scheduled(e.sandboxId))!;
  assert.equal(plan.kind, "paced");
  assert.equal(plan.failures, 0, "waiting for a slot isn't a failure");
  e.advance(60_000);
  assert.equal(await e.guard.tick(), e.sandboxId);
  assert.equal(await e.guard.machine(e.wake(), async (permit) => { await permit(); return "up"; }), "up");
  assert.equal(await e.guard.scheduled(e.sandboxId), null);
});

test("a stuck SSH login and a daemon stuck on the disk are retried later; other failures keep their words", async () => {
  const e = await env();
  e.setCheck("BOAT_MOTD_HUNG 3101 183 /bin/sh /etc/update-motd.d/90-updates-available\nBOAT_DISK ok .profile\nBOAT_DISK_END\n");
  await assert.rejects(e.guard.machine(e.wake(), async () => { throw new Error("Machine bootstrap command failed: Timeout, server 203.0.113.7 not responding … ssh … exit status 255"); }), /session never started: its login message scripts hang/);
  assert.equal((await e.guard.scheduled(e.sandboxId))!.kind, "ssh-session-stuck");
  e.advance(2 * 60_000);
  e.setCheck("BOAT_DSTATE 4242 request_wait_answer fuse_simple_request fuse_send_open fuse_file_open  node host-daemon/main.js\nBOAT_DISK_END\n");
  await assert.rejects(e.guard.machine(e.wake(), async () => { throw new Error("Machine daemon did not start within 20 seconds"); }), /boat\.dev is still restoring this sandbox's disk \(files bb needs there aren't readable yet\)\. Boat will retry at/);
  const plan = (await e.guard.scheduled(e.sandboxId))!;
  assert.equal(plan.kind, "disk-restoring");
  assert.equal(plan.failures, 2);
  // Not boat.dev's: bb's own words, and the plan ends.
  e.advance(4 * 60_000);
  await assert.rejects(e.guard.machine(e.wake(), async () => { throw new Error("npm error code E401"); }), /^Error: npm error code E401$/);
  assert.equal(await e.guard.scheduled(e.sandboxId), null);
  // SSH that doesn't answer (nothing wrong on the disk): told plainly, no plan.
  e.setCheck("BOAT_DISK ok .profile\nBOAT_DISK_END\n");
  await assert.rejects(e.guard.machine(e.wake(), async () => { throw new Error("ssh: connect to host 203.0.113.7 port 22: Connection refused"); }), /^Error: Boat couldn't reach the sandbox over SSH to restart bb there/);
  assert.equal(await e.guard.scheduled(e.sandboxId), null);
});

test("a cancelled wake records nothing", async () => {
  const e = await env();
  const controller = new AbortController();
  await assert.rejects(e.guard.machine({ ...e.wake(), signal: controller.signal }, async () => { controller.abort(); throw new Error(KEY_STEP); }));
  assert.equal(await e.guard.scheduled(e.sandboxId), null);
  assert.equal(e.store.events(e.task.id, 200).filter((event) => event.kind === WAKE_EVENT).length, 0);
});

const STUCK = "ascii-agents-server[812]: [lazyfs] [ERROR] HYDRATOR FAILED attempt 77 (mount stays up, on-demand serving continues, retrying …): decode/feed: chunk 1 GET 0000.tar.zst: status code 503";

/** Wakes failing on the same file until Boat's own looks call the node stuck: the 5th failure, 30 minutes on. */
async function failUntilStuck(e: Awaited<ReturnType<typeof env>>, wake: MachineWake): Promise<Error> {
  for (let index = 0; ; index++) {
    let thrown: Error | null = null;
    await e.guard.machine(wake, async () => { throw new Error(KEY_STEP); }).catch((error: Error) => { thrown = error; });
    const plan = (await e.guard.scheduled(wake.sandboxId))!;
    if (plan.move?.state === "due") return thrown!;
    assert.ok(index < 6, "never called stuck");
    e.advance(plan.retryAt! - e.now());
  }
}

test("lazyfs's own count moves nothing: the incident's first look is a normal retry; Boat's own looks over 15 minutes are what count", async () => {
  const e = await env({ moves: {} });
  e.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  await assert.rejects(e.guard.machine(e.wake(), async () => { throw new Error(KEY_STEP); }), /Boat will retry at 01:02 UTC/);
  assert.equal((await e.guard.scheduled(e.sandboxId))!.move ?? null, null, "attempt 77 on the first look isn't stuck");
  assert.deepEqual(await e.guard.track(e.sandboxId), { object: "chunk 1 GET 0000.tar.zst", firstAt: e.now(), attempts: 77, seen: 1 });
  e.advance(2 * 60_000);
  const error = await failUntilStuck(e, e.wake());
  assert.equal(error.message, "boat.dev keeps failing to restore this sandbox's disk on the node it runs on (Boat saw the same file fail 5 times since 01:00 UTC). Boat moves it to a new node if nothing there could be lost, else asks you first under Needs you.");
  assert.equal(e.now(), Date.parse("2026-11-19T01:30:00Z"), "the 5th failure, 30 minutes after the first");
});

test("an orchestrator's sandbox with no chat at work and clean checkouts: a test fork, a plain stop (nothing lost), a wake on a new node", async () => {
  const e = await env({ moves: {} });
  e.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  const orch = e.boat.addSandbox("bx_orchbox", "small", "idle");
  const wake = { ...e.wake(), sandboxId: orch.id, hostId: "host_orch" };
  await failUntilStuck(e, wake);
  // Resumes wait for the move.
  let runs = 0;
  await assert.rejects(e.guard.machine(wake, async () => { runs += 1; }), /Boat moves it to a new node if nothing there could be lost/);
  assert.equal(runs, 0);
  assert.equal(await e.pass(), orch.id);
  assert.deepEqual(e.boat.forks.map((fork) => [fork.from, fork.noSnapshots, fork.ttlSeconds]), [[orch.id, true, 600]]);
  assert.ok(e.boat.calls.includes(`delete ${e.boat.forks[0]!.id}`), "the test fork is gone");
  assert.ok(e.boat.calls.includes(`stop ${orch.id}`), "a plain stop first");
  assert.ok(!e.boat.calls.some((call) => call.includes("--force")), "it took a fresh snapshot: nothing forced");
  const plan = (await e.guard.scheduled(orch.id))!;
  assert.equal(plan.move!.state, "moved");
  assert.equal(plan.failures, 0);
  assert.equal(plan.retryAt, e.now());
  assert.equal(await e.guard.track(orch.id), null);
  // Boat's retry wakes it (on a new node) at once.
  assert.equal(await e.guard.tick(), orch.id);
  assert.deepEqual(e.resumed, ["host_orch"]);
  assert.equal(await e.guard.machine(wake, async () => "up"), "up");
  assert.equal(await e.guard.scheduled(orch.id), null);
});

test("boat refuses the plain stop: then --force, keeping the last completed snapshot", async () => {
  const e = await env({ moves: {} });
  e.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  const orch = e.boat.addSandbox("bx_orchbox", "small", "idle");
  e.boat.stopBehavior = "refused";
  await failUntilStuck(e, { ...e.wake(), sandboxId: orch.id, hostId: "host_orch" });
  await e.pass();
  assert.deepEqual(e.boat.calls.filter((call) => call.startsWith(`stop ${orch.id}`)), [`stop ${orch.id}`, `stop ${orch.id} --force`]);
  assert.equal(orch.state, "stopped");
  assert.equal((await e.guard.scheduled(orch.id))!.move!.state, "moved");
});

test("a pending stop is followed with its status, never stopped again, and forced only once boat says it failed", async () => {
  const e = await env({ moves: {} });
  e.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  const orch = e.boat.addSandbox("bx_orchbox", "small", "idle");
  e.boat.stopBehavior = "pending";
  e.boat.forceWhilePending = true;
  await failUntilStuck(e, { ...e.wake(), sandboxId: orch.id, hostId: "host_orch" });
  await e.pass();
  let plan = (await e.guard.scheduled(orch.id))!;
  assert.equal(plan.move!.state, "stopping");
  assert.equal(plan.move!.stopId, "stop_1");
  // Not looked at again before its next poll.
  assert.equal(await e.pass(), null);
  e.advance(30_000);
  await e.pass();
  assert.ok(e.boat.calls.includes(`stop ${orch.id} --status stop_1`));
  assert.equal((await e.guard.scheduled(orch.id))!.move!.state, "stopping", "still pending: it waits");
  e.boat.stopStatuses.set("stop_1", "failing");
  e.advance(30_000);
  await e.pass();
  assert.deepEqual(e.boat.calls.filter((call) => call.startsWith(`stop ${orch.id}`) && !call.includes("--status")), [`stop ${orch.id}`, `stop ${orch.id} --force`], "one plain stop, then the forced one");
  plan = (await e.guard.scheduled(orch.id))!;
  assert.equal(plan.move!.state, "moved");
});

test("a stop pending for 20 minutes goes to the user: forcing it would only hand it back", async () => {
  const e = await env({ moves: {} });
  e.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  const orch = e.boat.addSandbox("bx_orchbox", "small", "idle");
  e.boat.stopBehavior = "pending";
  await failUntilStuck(e, { ...e.wake(), sandboxId: orch.id, hostId: "host_orch" });
  await e.pass();
  for (let minute = 0; minute < 21; minute++) {
    e.advance(60_000);
    await e.pass();
  }
  assert.equal((await e.guard.scheduled(orch.id))!.move!.state, "asked");
  assert.ok(!e.boat.calls.some((call) => call.includes("--force")));
  assert.equal(e.boat.calls.filter((call) => call === `stop ${orch.id}`).length, 1);
  assert.match(e.store.decisions({ statuses: ["open"] })[0]!.recommendation, /because boat's stop has been pending since 01:30 UTC \(the sandbox may be unreachable\)/);
});

test("a stop boat says nothing about, with the sandbox still up, is looked at once more before forcing", async () => {
  const e = await env({ moves: {} });
  e.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  const orch = e.boat.addSandbox("bx_orchbox", "small", "idle");
  e.boat.stopBehavior = "quiet";
  await failUntilStuck(e, { ...e.wake(), sandboxId: orch.id, hostId: "host_orch" });
  await e.pass();
  assert.equal((await e.guard.scheduled(orch.id))!.move!.state, "stopping");
  assert.ok(!e.boat.calls.some((call) => call.includes("--force")));
  e.advance(30_000);
  await e.pass();
  assert.ok(e.boat.calls.includes(`stop ${orch.id} --force`));
  assert.equal(e.boat.calls.filter((call) => call === `stop ${orch.id}`).length, 1, "never stopped again to see");
});

test("no Boat task there, but a chat mid-turn, a checkout with work, or chats Boat can't see: Needs you, nothing stopped", async () => {
  for (const [label, setup] of [
    ["a chat mid-turn", (e: Awaited<ReturnType<typeof env>>) => e.setThreads([{ id: "thr_orch", title: "Orchestrator", status: "active" }])],
    ["an untracked file", (e: Awaited<ReturnType<typeof env>>) => e.setScan("BOAT_GIT_AT ahead=0 dirty=1 stash=0 /home/user/notes\nBOAT_GIT_SCAN_END\n")],
    ["a scan cut short", (e: Awaited<ReturnType<typeof env>>) => e.setScan("BOAT_GIT_SCAN_INCOMPLETE 124\nBOAT_GIT_SCAN_END\n")],
  ] as const) {
    const e = await env({ moves: {} });
    e.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
    setup(e);
    const orch = e.boat.addSandbox("bx_orchbox", "small", "idle");
    await failUntilStuck(e, { ...e.wake(), sandboxId: orch.id, hostId: "host_orch" });
    await e.pass();
    assert.equal((await e.guard.scheduled(orch.id))!.move!.state, "asked", label);
    assert.ok(!e.boat.calls.some((call) => call.startsWith(`stop ${orch.id}`)), label);
  }
  const blind = await env({ moves: {}, threads: false });
  blind.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  const orch = blind.boat.addSandbox("bx_orchbox", "small", "idle");
  await failUntilStuck(blind, { ...blind.wake(), sandboxId: orch.id, hostId: "host_orch" });
  await blind.pass();
  assert.equal((await blind.guard.scheduled(orch.id))!.move!.state, "asked");
  assert.match(blind.store.decisions({ statuses: ["open"] })[0]!.recommendation, /because Boat couldn't see which chats run there/);
});

test("a task with unpushed commits: Boat asks first, with the exact commands and what would be lost", async () => {
  const e = await env({ moves: {} });
  e.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  e.store.update(e.task.id, { status: "idle", repoPath: "/home/user/work/web" });
  e.setScan("BOAT_GIT_AT ahead=2 dirty=0 stash=0 /home/user/work/web\nBOAT_GIT_SCAN_END\n");
  await failUntilStuck(e, e.wake());
  await e.pass();
  const plan = (await e.guard.scheduled(e.sandboxId))!;
  assert.equal(plan.move!.state, "asked");
  assert.equal(plan.retryAt, null, "no more automatic wakes: they can't get past the node");
  assert.ok(!e.boat.calls.some((call) => call.startsWith(`stop ${e.sandboxId}`)), "nothing is stopped without the user");
  const decision = e.store.decisions({ statuses: ["open"] }).find((entry) => entry.shortLabel === "Sandbox stuck on a node")!;
  assert.equal(decision.orchestratorThreadId, "thr_orch");
  assert.equal(decision.question, `Sandbox ${e.sandboxId} is stuck on a boat.dev node that keeps failing its disk. Move it to a new node? If boat can't take a fresh snapshot, that loses what changed there since 00:41 UTC (its last completed snapshot), files git ignores (a local .env, build output) included.`);
  assert.equal(decision.recommendation, `Move it if nothing written since then matters: run \`boat stop ${e.sandboxId}\` (if boat refuses it, \`boat stop ${e.sandboxId} --force\`), then \`bb boat sandbox resume ${e.sandboxId}\`. Boat didn't do it itself because task ${e.task.id} has 2 unpushed commits. Otherwise wait for boat.dev to recover.`);
  assert.match(decision.context ?? "", /HYDRATOR FAILED attempt 77 .*status code 503\. A test fork from the same snapshot restored fine on another node\.$/);
  assert.match(e.store.events(e.task.id, 50).filter((event) => event.kind === WAKE_EVENT).at(-1)!.text, /could lose what changed since 00:41 UTC \(its last completed snapshot\), and task t_\w+ has 2 unpushed commits, so it's under Needs you\.$/);
  await assert.rejects(e.guard.machine(e.wake(), async () => "up"), /could lose unsaved work, so it's under Needs you/);
});

test("a task mid-turn is asked about; a clean, idle one is moved", async () => {
  const busy = await env({ moves: {} });
  busy.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  // launchTask left it running.
  await failUntilStuck(busy, busy.wake());
  await busy.pass();
  assert.equal((await busy.guard.scheduled(busy.sandboxId))!.move!.state, "asked");
  assert.match(busy.store.decisions({ statuses: ["open"] }).at(0)!.recommendation, /because task t_\w+ is mid-turn/);
  const idle = await env({ moves: {} });
  idle.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  idle.store.update(idle.task.id, { status: "idle", repoPath: "/home/user/work/web" });
  idle.setScan("BOAT_GIT_AT ahead=0 dirty=0 stash=0 /home/user/work/web\nBOAT_GIT_SCAN_END\n");
  await failUntilStuck(idle, idle.wake());
  await idle.pass();
  assert.equal((await idle.guard.scheduled(idle.sandboxId))!.move!.state, "moved");
  assert.match(idle.store.events(idle.task.id, 50).filter((event) => event.kind === WAKE_EVENT).at(-1)!.text, /^boat\.dev stopped this sandbox with a fresh snapshot, so nothing was lost\. Boat resumes it now on a new boat\.dev node\. A test fork had restored fine\.$/);
});

test("a test fork that couldn't tell: tried again later, then the user decides; nothing is forced", async () => {
  const e = await env({ moves: {} });
  e.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  const orch = e.boat.addSandbox("bx_orchbox", "small", "idle");
  e.boat.forkError = new Error("no_ready_machine");
  await failUntilStuck(e, { ...e.wake(), sandboxId: orch.id, hostId: "host_orch" });
  await e.pass();
  let plan = (await e.guard.scheduled(orch.id))!;
  assert.equal(plan.move!.state, "due");
  assert.equal(plan.move!.forkTries, 1);
  assert.equal(plan.move!.nextAt, e.now() + 10 * 60_000);
  e.advance(10 * 60_000);
  await e.pass();
  plan = (await e.guard.scheduled(orch.id))!;
  assert.equal(plan.move!.state, "asked");
  assert.ok(!e.boat.calls.some((call) => call.startsWith(`stop ${orch.id}`)));
  assert.match(e.store.decisions({ statuses: ["open"] })[0]!.recommendation, /because Boat couldn't check the snapshot with a test fork/);
});

test("the snapshot itself doesn't restore: nothing stopped, and Needs you says so", async () => {
  const e = await env({ moves: {} });
  e.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  const orch = e.boat.addSandbox("bx_orchbox", "small", "idle");
  e.setFork(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK fail .profile Input/output error\nBOAT_DISK_END\n`);
  await failUntilStuck(e, { ...e.wake(), sandboxId: orch.id, hostId: "host_orch" });
  await e.pass();
  assert.equal((await e.guard.scheduled(orch.id))!.move!.state, "asked");
  assert.ok(!e.boat.calls.some((call) => call.startsWith(`stop ${orch.id}`)));
  assert.ok(e.boat.calls.includes(`delete ${e.boat.forks[0]!.id}`));
  assert.equal(e.store.decisions({ statuses: ["open"] })[0]!.shortLabel, "Sandbox won't restore");
});

test("a refused stop moves it only once Boat has seen the same hydrator failure for a while; a disk only restoring backs off", async () => {
  const e = await env({ moves: {} });
  const orch = e.boat.addSandbox("bx_orchbox", "small", "idle");
  // Normal restoring after a wake: "hydration in progress", a read waiting on lazyfs.
  e.setCheck("BOAT_HYDRATING [SNAPSHOT-INC] lazy volume hydration in progress\nBOAT_DSTATE 4242 request_wait_answer fuse_file_open node x\nBOAT_DISK ok .profile\nBOAT_DISK_END\n");
  assert.equal(await e.guard.stopRefused(orch.id, "host_orch"), false);
  assert.equal(await e.guard.scheduled(orch.id), null);
  assert.equal(await e.guard.track(orch.id), null);
  // A real hydrator failure: seen once, then more, over more than 15 minutes.
  e.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  assert.equal(await e.guard.stopRefused(orch.id, "host_orch"), false);
  e.advance(8 * 60_000);
  assert.equal(await e.guard.stopRefused(orch.id, "host_orch"), false);
  assert.equal(await e.guard.scheduled(orch.id), null, "watching it holds no resume");
  e.advance(8 * 60_000);
  assert.equal(await e.guard.stopRefused(orch.id, "host_orch", { status: "failing", stopId: "stop_7", forced: null }), true);
  const plan = (await e.guard.scheduled(orch.id))!;
  assert.equal(plan.move!.state, "due");
  assert.equal(plan.move!.resume, false);
  assert.deepEqual(plan.move!.stop, { status: "failing", stopId: "stop_7", forced: null });
  // The checks, then the forced stop (boat already refused the plain one); it stays stopped.
  await e.pass();
  assert.deepEqual(e.boat.calls.filter((call) => call.startsWith(`stop ${orch.id}`)), [`stop ${orch.id} --force`]);
  assert.equal(orch.state, "stopped");
  assert.equal(await e.guard.scheduled(orch.id), null);
});

test("bb's daemon broken by an update: its own kind, Needs you with the repair by hand, no retries and no hold", async () => {
  const e = await env({ moves: {} });
  e.setCheck([
    "BOAT_ZOMBIE 5150 Zl [npm install -g] <defunct>",
    "BOAT_UNIT bb-host-daemon-acme.service deactivating stop-sigterm",
    "BOAT_BB_DIR /home/user/.bb-machines/acme",
    "BOAT_BB_MISSING /home/user/.bb-machines/acme",
    "BOAT_BB_LOG Error: Cannot find module '/home/user/.bb-machines/acme/npm/lib/node_modules/bb-app/dist/bb-host-daemon.js' code: 'MODULE_NOT_FOUND'",
    "BOAT_DISK ok .profile",
    "BOAT_DISK_END",
  ].join("\n"));
  await assert.rejects(e.guard.machine(e.wake(), async () => { throw new Error("Machine daemon did not start within 20 seconds"); }), (error: Error) => {
    assert.match(error.message, /^bb's daemon on this sandbox broke during an update \(npm install left a zombie: \[npm install -g\] <defunct> \(pid 5150, Zl\); bb-host-daemon-acme\.service is stuck deactivating; ~\/\.bb-machines\/acme\/npm\/bin\/bb-app is missing; .*MODULE_NOT_FOUND.*\), so bb can't start there\. It needs a repair by hand; the steps are under Needs you\.$/);
    return true;
  });
  const decision = e.store.decisions({ statuses: ["open"] })[0]!;
  assert.equal(decision.shortLabel, "bb's daemon needs a repair");
  assert.match(decision.recommendation, /An npm install zombie is left there: it goes only with a VM restart \(`boat recover bx_\w+`\) or a move to a new node\./);
  const steps = decision.context!.split("\n").slice(1);
  assert.deepEqual(steps, [
    "D=~/.bb-machines/acme",
    'cp "$D/host-package-download/bb-app.tgz" /tmp/bb-app.tgz',
    'npm_config_cache=/tmp/npmcache npm install -g --no-audit --no-fund --allow-scripts=@parcel/watcher,node-pty --prefix "$D/npm.new" /tmp/bb-app.tgz',
    'mv "$D/npm" "$D/npm.old" && mv "$D/npm.new" "$D/npm"',
    "systemctl --user reset-failed bb-host-daemon-acme.service && systemctl --user start bb-host-daemon-acme.service",
  ]);
  const plan = (await e.guard.scheduled(e.sandboxId))!;
  assert.equal(plan.kind, "daemon-broken");
  assert.equal(plan.retryAt, null);
  assert.equal(await e.guard.tick(), null, "no retry of its own");
  // Repaired by hand: the next resume goes ahead at once (nothing held), and no second item.
  assert.equal(await e.guard.machine(e.wake(), async () => "up"), "up");
  assert.equal(e.store.decisions({ statuses: ["open"] }).length, 1);
});

test("checked again right before --force: a turn that started while the stop was pending means Needs you, not a forced stop", async () => {
  const e = await env({ moves: {} });
  e.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  const orch = e.boat.addSandbox("bx_orchbox", "small", "idle");
  e.boat.stopBehavior = "pending";
  await failUntilStuck(e, { ...e.wake(), sandboxId: orch.id, hostId: "host_orch" });
  await e.pass();
  assert.equal((await e.guard.scheduled(orch.id))!.move!.state, "stopping");
  assert.equal(await e.guard.moving(orch.id), true, "Boat's own dispatches wait meanwhile");
  // The sandbox is up while boat works on the stop: a turn starts there, then boat gives up on the stop.
  e.setThreads([{ id: "thr_orch", title: "Orchestrator", status: "active" }]);
  e.boat.stopStatuses.set("stop_1", "failing");
  e.advance(30_000);
  await e.pass();
  assert.equal((await e.guard.scheduled(orch.id))!.move!.state, "asked");
  assert.ok(!e.boat.calls.some((call) => call.includes("--force")));
  assert.equal(await e.guard.moving(orch.id), false);
  assert.match(e.store.decisions({ statuses: ["open"] })[0]!.recommendation, /because the chat "Orchestrator" is mid-turn\./);
});

test("a stop boat refuses with its own words: forced at once when still safe, quoted when it goes to the user", async () => {
  const safe = await env({ moves: {} });
  safe.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  const box = safe.boat.addSandbox("bx_orchbox", "small", "idle");
  safe.boat.stopBehavior = "error";
  await failUntilStuck(safe, { ...safe.wake(), sandboxId: box.id, hostId: "host_orch" });
  await safe.pass();
  // No 20-minute wait for a stop boat already refused.
  assert.deepEqual(safe.boat.calls.filter((call) => call.startsWith(`stop ${box.id}`)), [`stop ${box.id}`, `stop ${box.id} --force`]);
  assert.equal((await safe.guard.scheduled(box.id))!.move!.state, "moved");
  const risky = await env({ moves: {} });
  risky.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  const other = risky.boat.addSandbox("bx_orchbox", "small", "idle");
  risky.boat.stopBehavior = "error";
  await failUntilStuck(risky, { ...risky.wake(), sandboxId: other.id, hostId: "host_orch" });
  // Clean when the move starts; a file appears before Boat would force.
  const exec = risky.boat.exec.bind(risky.boat);
  let scans = 0;
  risky.boat.exec = async (sandboxId, script, options) => {
    if (script.includes("BOAT_GIT_SCAN_END")) {
      scans += 1;
      risky.setScan(scans === 1 ? "BOAT_GIT_SCAN_END\n" : "BOAT_GIT_AT ahead=0 dirty=1 stash=0 /home/user/notes\nBOAT_GIT_SCAN_END\n");
    }
    return exec(sandboxId, script, options);
  };
  await risky.pass();
  assert.equal(scans, 2, "the facts are read again before forcing");
  assert.ok(!risky.boat.calls.some((call) => call.includes("--force")));
  const decision = risky.store.decisions({ statuses: ["open"] })[0]!;
  assert.match(decision.recommendation, /because boat refused the plain stop \(boat said: "Final snapshot failed; stop aborted to protect unsaved data \(lazy volume not fully hydrated\)"\); ~\/notes has changes that aren't committed\./);
});

test("the repair names this machine's own daemon unit when the sandbox has several", async () => {
  const e = await env({ moves: {} });
  e.setCheck([
    "BOAT_UNIT bb-host-daemon-other-example-host_zz9.service active running",
    "BOAT_UNIT bb-host-daemon-bb-example-com-host_orch1.service deactivating stop-sigterm",
    "BOAT_BB_DIR /home/user/.bb-machines/other.example",
    "BOAT_BB_DIR /home/user/.bb-machines/bb.example.com",
    "BOAT_BB_MISSING /home/user/.bb-machines/bb.example.com",
    "BOAT_DISK_END",
  ].join("\n"));
  await assert.rejects(e.guard.machine(e.wake(), async () => { throw new Error("Machine daemon did not start within 20 seconds"); }), /bb's daemon on this sandbox broke during an update/);
  const steps = e.store.decisions({ statuses: ["open"] })[0]!.context!.split("\n").slice(1);
  assert.equal(steps[0], "D=~/.bb-machines/bb.example.com");
  assert.equal(steps.at(-1), "systemctl --user reset-failed bb-host-daemon-bb-example-com-host_orch1.service && systemctl --user start bb-host-daemon-bb-example-com-host_orch1.service");
});
