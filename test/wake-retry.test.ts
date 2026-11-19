// Boat's own later wake of a sandbox boat.dev couldn't restore, and the hand-over to Needs you.
import assert from "node:assert/strict";
import { test } from "node:test";
import { WakePacer } from "../src/wake-pacer.ts";
import { GIVE_UP_AFTER, RETRY_MAX_MS, WAKE_EVENT, createWakeGuard, nextFailure, retryDelayMs, type MachineWake } from "../src/wake-retry.ts";
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

async function env(options: { maxWaitMs?: number; moves?: { forkCheck?: boolean } } = {}) {
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
  // A task's branch (the move's check), and what a test fork reads.
  let git = "BOAT_GIT ahead=0 dirty=0\n";
  let fork = "BOAT_DISK ok .profile\nBOAT_DISK ok .bashrc\nBOAT_DISK_END\n";
  fake.boat.execResult = (script) => {
    const on = fake.boat.execs.at(-1)!.sandboxId;
    const stdout = script.includes("BOAT_GIT") ? git : on.startsWith("bx_fork") ? fork : check;
    return { exitCode: 0, stdout, stderr: "" };
  };
  const guard = createWakeGuard({
    pacer,
    kv: { async get<T>(key: string) { return kv.get(key) as T | undefined; }, async set(key: string, value: unknown) { kv.set(key, structuredClone(value)); } },
    boat: fake.boat as never,
    store: fake.store,
    resumeHost: async (hostId) => { resumed.push(hostId); },
    now: () => at,
    log: (line) => logs.push(line),
    ...(options.moves ? { moves: options.moves } : {}),
  });
  const steps: string[] = [];
  const wake = (): MachineWake => ({ sandboxId, hostId: "host_orch1", signal: new AbortController().signal, report: { step: (text) => steps.push(text), log: () => undefined } });
  return {
    ...fake, task, sandboxId, pacer, guard, kv, resumed, logs, steps, wake, now: () => at, advance(ms: number) { at += ms; },
    setCheck(text: string) { check = text; }, setGit(text: string) { git = text; }, setFork(text: string) { fork = text; },
    /** The move runs in the background: wait until it's past "due". */
    async moved(sandboxId: string) {
      for (let round = 0; round < 500; round++) {
        if ((await guard.scheduled(sandboxId))?.move?.state !== "due") return guard.scheduled(sandboxId);
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error("the move never finished");
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

test("a node that keeps failing the same file: Boat moves an orchestrator's sandbox itself, after a test fork, then wakes it", async () => {
  const e = await env({ moves: {} });
  e.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  const orch = e.boat.addSandbox("bx_orchbox", "small", "idle");
  const wake = { ...e.wake(), sandboxId: orch.id, hostId: "host_orch" };
  await assert.rejects(e.guard.machine(wake, async () => { throw new Error(KEY_STEP); }), (error: Error) => {
    assert.equal(error.message, "boat.dev keeps failing to restore this sandbox's disk on the node it runs on (the same file failed 77 times since 01:00 UTC). Boat moves it to a new node now, or asks you first under Needs you if unsaved work could be lost.");
    return true;
  });
  assert.equal((await e.guard.scheduled(orch.id))!.move!.state, "due");
  // Resumes wait for the move.
  let runs = 0;
  await assert.rejects(e.guard.machine(wake, async () => { runs += 1; }), /Boat moves it to a new node now/);
  assert.equal(runs, 0);
  assert.equal(await e.guard.tick(), orch.id);
  const plan = (await e.moved(orch.id))!;
  // The snapshot restored fine elsewhere: force-stopped, keeping the last completed snapshot.
  assert.deepEqual(e.boat.forks.map((fork) => [fork.from, fork.noSnapshots, fork.ttlSeconds]), [[orch.id, true, 600]]);
  assert.ok(e.boat.calls.includes(`delete ${e.boat.forks[0]!.id}`), "the test fork is gone");
  assert.ok(e.boat.calls.includes(`stop ${orch.id} --force`));
  assert.equal(orch.state, "stopped");
  assert.equal(plan.move!.state, "moved");
  assert.equal(plan.failures, 0);
  assert.equal(plan.hydrator, null);
  assert.equal(plan.retryAt, e.now());
  // Boat's retry wakes it (on a new node) at once.
  assert.equal(await e.guard.tick(), orch.id);
  assert.deepEqual(e.resumed, ["host_orch"]);
  assert.equal(await e.guard.machine(wake, async () => "up"), "up");
  assert.equal(await e.guard.scheduled(orch.id), null);
});

test("a task with unpushed commits: Boat asks first, with the exact commands and what would be lost", async () => {
  const e = await env({ moves: {} });
  e.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  e.store.update(e.task.id, { status: "idle", repoPath: "/home/user/work/web" });
  e.setGit("BOAT_GIT ahead=2 dirty=0\n");
  await assert.rejects(e.guard.machine(e.wake(), async () => { throw new Error(KEY_STEP); }), /Boat moves it to a new node now, or asks you first/);
  await e.guard.tick();
  const plan = (await e.moved(e.sandboxId))!;
  assert.equal(plan.move!.state, "asked");
  assert.equal(plan.retryAt, null, "no more automatic wakes: they can't get past the node");
  assert.ok(!e.boat.calls.some((call) => call.includes("--force")), "nothing is dropped without the user");
  const decision = e.store.decisions({ statuses: ["open"] })[0]!;
  assert.equal(decision.orchestratorThreadId, "thr_orch");
  assert.equal(decision.question, `Sandbox ${e.sandboxId} is stuck on a boat.dev node that keeps failing its disk. Move it to a new node? That loses what changed there since 00:41 UTC (its last completed snapshot).`);
  assert.equal(decision.recommendation, `Move it if nothing written since then matters: run \`boat stop ${e.sandboxId} --force\`, then \`bb boat sandbox resume ${e.sandboxId}\`. Boat didn't do it itself because task ${e.task.id} has 2 unpushed commits. Otherwise wait for boat.dev to recover.`);
  assert.match(decision.context ?? "", /HYDRATOR FAILED attempt 77 .*status code 503\. A test fork from the same snapshot restored fine on another node\.$/);
  assert.equal(decision.shortLabel, "Sandbox stuck on a node");
  assert.match(e.store.events(e.task.id, 50).filter((event) => event.kind === WAKE_EVENT).at(-1)!.text, /would lose what changed since 00:41 UTC \(its last completed snapshot\), and task t_\w+ has 2 unpushed commits, so it's under Needs you\.$/);
  await assert.rejects(e.guard.machine(e.wake(), async () => "up"), /could lose unsaved work, so it's under Needs you/);
});

test("a task mid-turn is asked about too; a clean, idle one is moved", async () => {
  const busy = await env({ moves: { forkCheck: false } });
  busy.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  // launchTask left it running.
  await assert.rejects(busy.guard.machine(busy.wake(), async () => { throw new Error(KEY_STEP); }));
  await busy.guard.tick();
  assert.equal((await busy.moved(busy.sandboxId))!.move!.state, "asked");
  assert.match(busy.store.decisions({ statuses: ["open"] })[0]!.recommendation, /because task t_\w+ is mid-turn\./);
  assert.equal(busy.boat.forks.length, 0, "no test fork when it's turned off");
  const idle = await env({ moves: { forkCheck: false } });
  idle.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  idle.store.update(idle.task.id, { status: "idle", repoPath: "/home/user/work/web" });
  await assert.rejects(idle.guard.machine(idle.wake(), async () => { throw new Error(KEY_STEP); }));
  await idle.guard.tick();
  assert.equal((await idle.moved(idle.sandboxId))!.move!.state, "moved");
  assert.ok(idle.boat.calls.includes(`stop ${idle.sandboxId} --force`));
  assert.match(idle.store.events(idle.task.id, 50).filter((event) => event.kind === WAKE_EVENT).at(-1)!.text, /^Boat moved this sandbox to a new boat\.dev node: it stopped it keeping its last completed snapshot \(00:41 UTC/);
});

test("the snapshot itself doesn't restore: no forced stop, and Needs you says so", async () => {
  const e = await env({ moves: {} });
  e.setCheck(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK_END\n`);
  e.store.update(e.task.id, { status: "idle" });
  e.setFork(`BOAT_HYDRATOR ${STUCK}\nBOAT_DISK fail .profile Input/output error\nBOAT_DISK_END\n`);
  await assert.rejects(e.guard.machine(e.wake(), async () => { throw new Error(KEY_STEP); }));
  await e.guard.tick();
  assert.equal((await e.moved(e.sandboxId))!.move!.state, "asked");
  assert.ok(!e.boat.calls.some((call) => call.includes("--force")));
  assert.ok(e.boat.calls.includes(`delete ${e.boat.forks[0]!.id}`));
  assert.equal(e.store.decisions({ statuses: ["open"] })[0]!.shortLabel, "Sandbox won't restore");
});

test("not stuck yet (a few attempts, a few minutes): the normal retries, no move", async () => {
  const e = await env({ moves: {} });
  e.setCheck(`BOAT_HYDRATOR ${STUCK.replace("attempt 77", "attempt 2")}\nBOAT_DISK_END\n`);
  await assert.rejects(e.guard.machine(e.wake(), async () => { throw new Error(KEY_STEP); }), /Boat will retry at 01:02 UTC/);
  const plan = (await e.guard.scheduled(e.sandboxId))!;
  assert.equal(plan.move ?? null, null);
  assert.deepEqual(plan.hydrator, { object: "chunk 1 GET 0000.tar.zst", firstAt: e.now(), attempts: 2, seen: 1 });
  // 16 minutes later the same chunk still fails: now it moves.
  e.advance(16 * 60_000);
  await assert.rejects(e.guard.machine(e.wake(), async () => { throw new Error(KEY_STEP); }), /on the node it runs on \(the same file failed 2 times since 01:00 UTC\)/);
  assert.equal((await e.guard.scheduled(e.sandboxId))!.move!.state, "due");
});
