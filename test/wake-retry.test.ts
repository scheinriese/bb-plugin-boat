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

async function env(options: { maxWaitMs?: number } = {}) {
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
  fake.boat.execResult = () => ({ exitCode: 0, stdout: check, stderr: "" });
  const guard = createWakeGuard({
    pacer,
    kv: { async get<T>(key: string) { return kv.get(key) as T | undefined; }, async set(key: string, value: unknown) { kv.set(key, structuredClone(value)); } },
    boat: fake.boat as never,
    store: fake.store,
    resumeHost: async (hostId) => { resumed.push(hostId); },
    now: () => at,
    log: (line) => logs.push(line),
  });
  const steps: string[] = [];
  const wake = (): MachineWake => ({ sandboxId, hostId: "host_orch1", signal: new AbortController().signal, report: { step: (text) => steps.push(text), log: () => undefined } });
  return { ...fake, task, sandboxId, pacer, guard, kv, resumed, logs, steps, wake, now: () => at, advance(ms: number) { at += ms; }, setCheck(text: string) { check = text; } };
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
