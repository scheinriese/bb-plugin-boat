// The account's wake pacer, the one limiter for every wake: at most 2 sandbox wakes a minute, a doubling
// pause after a failed one, and the hold on the wakes the plugin starts on its own (take).
import assert from "node:assert/strict";
import { test } from "node:test";
import { WAKE_FAILURE_HOLD_MS, WakeDeferred, WakePacer, kvWakeStorage, wakeIds, type WakePacerState } from "../src/wake-pacer.ts";

/** A clock that moves only when the pacer sleeps (or the test says so). */
function clock(start = Date.parse("2026-11-19T00:00:00Z")) {
  let at = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => at,
    advance(ms: number) { at += ms; },
    async sleep(ms: number, signal?: AbortSignal) { signal?.throwIfAborted(); sleeps.push(ms); at += ms; },
  };
}

function memoryKv() {
  const values = new Map<string, unknown>();
  return {
    values,
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async set(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async delete(key: string) { values.delete(key); },
  };
}

test("two wakes go at once; a third within the minute waits for the first one's slot", async () => {
  const time = clock();
  const pacer = new WakePacer({ now: time.now, sleep: time.sleep });
  const start = time.now();
  await pacer.acquire();
  time.advance(10_000);
  await pacer.acquire();
  assert.deepEqual(time.sleeps, [], "the first two don't wait");
  const waits: { until: number; reason: string }[] = [];
  time.advance(5_000);
  await pacer.acquire({ onWait: (until, reason) => waits.push({ until, reason }) });
  // The first wake's slot comes back a minute after it was taken.
  assert.equal(time.now(), start + 60_000);
  assert.deepEqual(time.sleeps, [45_000]);
  assert.deepEqual(waits, [{ until: start + 60_000, reason: "rate" }]);
  // Never more than 2 in any minute.
  const taken = (await pacer.snapshot()).taken;
  assert.deepEqual(taken, [start + 10_000, start + 60_000]);
});

test("a slot further away than the caller waits is a WakeDeferred with when to try again", async () => {
  const time = clock();
  const pacer = new WakePacer({ now: time.now, sleep: time.sleep });
  await pacer.acquire();
  await pacer.acquire();
  await assert.rejects(pacer.acquire({ maxWaitMs: 30_000 }), (error: unknown) => {
    assert.ok(error instanceof WakeDeferred);
    assert.equal(error.code, "wake_deferred");
    assert.equal(error.reason, "rate");
    assert.equal(error.retryAt, time.now() + 60_000);
    assert.match(error.message, /Boat wakes at most 2 sandboxes a minute and others are waking now\. Try again at 00:01 UTC\./);
    return true;
  });
  assert.deepEqual(time.sleeps, [], "it never fires early, nor waits in vain");
});

test("after a failed wake the next one waits, doubling per failure in a row; a success starts over", async () => {
  const time = clock();
  const pacer = new WakePacer({ now: time.now, sleep: time.sleep });
  const first = await pacer.acquire();
  await first.failed();
  assert.equal((await pacer.snapshot()).failures, 1);
  assert.equal(await pacer.nextWakeAt(), time.now() + 30_000);
  const reasons: string[] = [];
  const second = await pacer.acquire({ onWait: (_until, reason) => reasons.push(reason) });
  assert.deepEqual(time.sleeps, [30_000]);
  assert.deepEqual(reasons, ["backoff"]);
  await second.failed();
  // 60 seconds now, then 2, 4 … minutes, at most 10.
  assert.equal(await pacer.nextWakeAt(), time.now() + 60_000);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map((n) => pacer.backoffMs(n)), [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  // A permit settles once: a late second report changes nothing.
  await second.failed();
  assert.equal((await pacer.snapshot()).failures, 2);
  time.advance(60_000);
  const third = await pacer.acquire();
  await third.succeeded();
  assert.equal((await pacer.snapshot()).failures, 0);
  const fourth = await pacer.acquire({ maxWaitMs: 120_000 });
  await fourth.failed();
  assert.equal((await pacer.snapshot()).blockedUntil, time.now() + 30_000, "back to the first pause");
});

test("a wait respects the abort signal", async () => {
  let at = 0;
  const pacer = new WakePacer({
    now: () => at,
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        setTimeout(() => { at += ms; resolve(undefined); }, 10_000).unref();
      }),
  });
  await pacer.acquire();
  await pacer.acquire();
  const controller = new AbortController();
  const waiting = pacer.acquire({ signal: controller.signal });
  controller.abort(new Error("the machine's resume was cancelled"));
  await assert.rejects(waiting, /the machine's resume was cancelled/);
  assert.equal((await pacer.snapshot()).taken.length, 2, "a cancelled wait takes no slot");
});

test("concurrent wakes never share a slot", async () => {
  const time = clock();
  const pacer = new WakePacer({ now: time.now, sleep: time.sleep, maxWaitMs: 0 });
  const results = await Promise.allSettled([pacer.acquire(), pacer.acquire(), pacer.acquire(), pacer.acquire()]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled", "rejected", "rejected"]);
});

test("the bucket is saved: a reload of the plugin keeps the pace and the pause", async () => {
  const time = clock();
  const kv = memoryKv();
  const pacer = new WakePacer({ now: time.now, sleep: time.sleep, storage: kvWakeStorage(kv) });
  await pacer.acquire();
  await (await pacer.acquire()).failed();
  const saved = kv.values.get("wakePacer") as WakePacerState;
  assert.equal(saved.taken.length, 2);
  assert.equal(saved.failures, 1);
  const reloaded = new WakePacer({ now: time.now, sleep: time.sleep, storage: kvWakeStorage(kv) });
  assert.equal(await reloaded.nextWakeAt(), time.now() + 60_000, "both slots of this minute are still taken");
  // A broken saved value starts fresh instead of failing every wake.
  kv.values.set("wakePacer", { taken: "nope", failures: -3 });
  const fresh = new WakePacer({ now: time.now, sleep: time.sleep, storage: kvWakeStorage(kv) });
  assert.equal(await fresh.nextWakeAt(), time.now());
});

test("failures in a row are forgotten once the last pause ended long ago: one old bad wake doesn't give the next the longest pause", async () => {
  const time = clock();
  const pacer = new WakePacer({ now: time.now, sleep: time.sleep });
  for (let index = 0; index < 5; index++) {
    const permit = await pacer.acquire({ maxWaitMs: 60 * 60_000 });
    await permit.failed();
  }
  assert.equal((await pacer.snapshot()).failures, 5);
  // A day later, one more bad sandbox: the first pause again, not 10 minutes.
  time.advance(24 * 3_600_000);
  assert.equal(await pacer.nextWakeAt(), time.now(), "no pause left");
  const late = await pacer.acquire();
  await late.failed();
  const state = await pacer.snapshot();
  assert.equal(state.failures, 1);
  assert.equal(state.blockedUntil, time.now() + 30_000);
  // Within the decay window, failures still add up.
  time.advance(31_000);
  await (await pacer.acquire()).failed();
  assert.equal((await pacer.snapshot()).failures, 2);
});

test("each real wake uses one slot: a boat resume uses the slot take() claimed for its machine", async () => {
  const time = clock();
  const pacer = new WakePacer({ now: time.now, sleep: time.sleep });
  const start = time.now();
  // The watchdog and the paid resume each start a wake through bb: the minute's two slots.
  const watchdog = await pacer.take(wakeIds({ sandboxId: "s1", hostId: "h1" }));
  time.advance(5_000);
  const paid = await pacer.take(["sandbox:s2"]);
  assert.ok(watchdog !== null && paid !== null);
  assert.equal(await pacer.take(["sandbox:s3"]), null, "none left this minute");
  // bb resumes those machines: each boat resume uses its claimed slot at once, adding none.
  time.advance(2_000);
  await pacer.acquire({ ids: ["sandbox:s1", "host:h1"] });
  await pacer.acquire({ ids: ["sandbox:s2"] });
  assert.deepEqual(time.sleeps, []);
  const used = await pacer.snapshot();
  assert.deepEqual(used.taken, [start + 7_000, start + 7_000], "counted from when the wakes started");
  assert.deepEqual(used.claims, []);
  // A second resume of the same machine is a new wake: it waits for a slot, as ever.
  await pacer.acquire({ ids: ["host:h1"] });
  assert.deepEqual(time.sleeps, [60_000]);
  // Giving back a slot its wake used gives nothing back.
  await watchdog.release();
  assert.deepEqual((await pacer.snapshot()).taken, [start + 67_000]);
});

test("a claimed slot nobody used goes back at once with release, or with its slot a minute later", async () => {
  const time = clock();
  const pacer = new WakePacer({ now: time.now, sleep: time.sleep });
  const start = time.now();
  const never = await pacer.take(["host:a"]);
  const later = await pacer.take(["host:b"]);
  assert.equal(await pacer.nextWakeAt(), start + 60_000);
  // The resume never got to boat (bb refused it, or the sandbox was up): its slot is free again.
  await never!.release();
  await never!.release();
  assert.equal(await pacer.nextWakeAt(), start);
  assert.deepEqual((await pacer.snapshot()).taken, [start]);
  // b's machine woke some other way: the claim goes with its slot, and a later resume of it takes a new one.
  time.advance(60_000);
  await pacer.acquire({ ids: ["host:b"] });
  assert.deepEqual(await pacer.snapshot(), { taken: [start + 60_000], failures: 0, blockedUntil: 0, heldUntil: 0, claims: [] });
  await later!.release();
  assert.deepEqual((await pacer.snapshot()).taken, [start + 60_000], "a claim gone with its slot gives back nothing");
});

test("a claimed slot still waits out a pause after a failed wake, then goes without a second slot", async () => {
  const time = clock();
  const pacer = new WakePacer({ now: time.now, sleep: time.sleep });
  const start = time.now();
  await pacer.take(["host:h1"]);
  // Another wake failed in between: wake-ups pause 30 seconds.
  await (await pacer.acquire()).failed();
  const reasons: string[] = [];
  await pacer.acquire({ ids: ["host:h1"], onWait: (_until, reason) => reasons.push(reason) });
  assert.deepEqual(time.sleeps, [30_000]);
  assert.deepEqual(reasons, ["backoff"]);
  assert.deepEqual((await pacer.snapshot()).taken, [start, start + 30_000]);
});

test("takes and acquires at once never share a slot", async () => {
  const time = clock();
  const pacer = new WakePacer({ now: time.now, sleep: time.sleep, maxWaitMs: 0 });
  const results = await Promise.allSettled([pacer.take(), pacer.acquire(), pacer.take(), pacer.acquire()]);
  assert.deepEqual(
    results.map((result) => (result.status === "rejected" ? "deferred" : result.value === null ? "no" : "slot")),
    ["slot", "slot", "no", "deferred"],
  );
  assert.equal((await pacer.snapshot()).taken.length, 2);
});

test("the hold stops take, never a boat resume someone asks for; a failed boat resume pauses take too", async () => {
  const time = clock();
  const pacer = new WakePacer({ now: time.now, sleep: time.sleep });
  const start = time.now();
  await pacer.hold();
  assert.equal(await pacer.take(), null);
  assert.equal(await pacer.pausedUntil(), start + WAKE_FAILURE_HOLD_MS);
  assert.equal(await pacer.nextWakeAt({ held: true }), start + WAKE_FAILURE_HOLD_MS);
  await (await pacer.acquire()).succeeded();
  assert.deepEqual(time.sleeps, [], "a boat resume isn't held");
  time.advance(WAKE_FAILURE_HOLD_MS);
  // Past the hold: a pause after a failed boat resume holds take for its 30 seconds.
  await (await pacer.acquire()).failed();
  assert.equal(await pacer.take(), null);
  assert.equal(await pacer.pausedUntil(), time.now() + 30_000);
  time.advance(30_000);
  assert.notEqual(await pacer.take(), null);
});

test("one saved state: a restart keeps the pace, the pause, the hold and a claimed slot", async () => {
  const time = clock();
  const kv = memoryKv();
  const pacer = new WakePacer({ now: time.now, sleep: time.sleep, storage: kvWakeStorage(kv) });
  const start = time.now();
  // The watchdog claims a slot for h1; someone's boat resume fails; a wake the paid resume made fails.
  await pacer.take(wakeIds({ sandboxId: "s1", hostId: "h1" }));
  await (await pacer.acquire()).failed();
  await pacer.hold();
  assert.deepEqual([...kv.values.keys()], ["wakePacer"], "one key");
  const saved = kv.values.get("wakePacer") as WakePacerState;
  assert.deepEqual(saved, { taken: [start, start], failures: 1, blockedUntil: start + 30_000, heldUntil: start + WAKE_FAILURE_HOLD_MS, claims: [{ at: start, ids: ["sandbox:s1", "host:h1"] }] });

  const restarted = new WakePacer({ now: time.now, sleep: time.sleep, storage: kvWakeStorage(kv) });
  assert.equal(await restarted.nextWakeAt(), start + 60_000, "both slots of this minute are still taken");
  assert.equal(await restarted.heldUntil(), start + WAKE_FAILURE_HOLD_MS);
  assert.equal(await restarted.pausedUntil(), start + WAKE_FAILURE_HOLD_MS);
  assert.equal(await restarted.take(), null);
  // h1's boat resume after the restart still uses its claimed slot (after the pause), not a third one.
  await restarted.acquire({ ids: ["host:h1"] });
  assert.deepEqual(time.sleeps, [30_000]);
  assert.deepEqual((await restarted.snapshot()).taken, [start, start + 30_000]);
  assert.deepEqual((await restarted.snapshot()).claims, []);
  // And the failures in a row carry on.
  await (await restarted.acquire({ maxWaitMs: 5 * 60_000 })).failed();
  assert.equal((await restarted.snapshot()).failures, 2);
});

test("a clock that moves on while the saved state is read: take and acquire go by the time after the read", async () => {
  const time = clock();
  const kv = memoryKv();
  const start = time.now();
  const first = new WakePacer({ now: time.now, sleep: time.sleep, storage: kvWakeStorage(kv) });
  assert.notEqual(await first.take(), null);
  assert.notEqual(await first.take(), null);
  // A restart whose read of the saved state takes a minute (a slow kv, a busy machine).
  const slowly = (ms: number) => ({
    load: async () => {
      time.advance(ms);
      return kv.get<unknown>("wakePacer");
    },
    save: (state: WakePacerState) => kv.set("wakePacer", state),
  });
  const restarted = new WakePacer({ now: time.now, sleep: time.sleep, storage: slowly(60_000) });
  // By the end of the read both slots are back: a take that went by the time before it would say no.
  const claim = await restarted.take();
  assert.notEqual(claim, null);
  assert.equal(time.now(), start + 60_000);
  assert.deepEqual((await restarted.snapshot()).claims.map((entry) => entry.at), [start + 60_000], "the slot is taken at the time after the read");
  // The same for acquire (both slots taken again, a minute's read), and a free pacer never looks taken to a
  // caller that compares with its own clock afterwards.
  assert.notEqual(await restarted.take(), null);
  const again = new WakePacer({ now: time.now, sleep: time.sleep, storage: slowly(60_000) });
  await again.acquire({ maxWaitMs: 0 });
  assert.deepEqual((await again.snapshot()).taken, [start + 120_000]);
  assert.ok((await new WakePacer({ now: time.now, storage: slowly(5) }).nextWakeAt()) <= time.now());
});

test("the old wake budget's hold is taken over once, and its key goes", async () => {
  const time = clock();
  const kv = memoryKv();
  kv.values.set("wakeBudget", { tokens: 0.5, at: time.now() - 1_000, heldUntil: time.now() + 10 * 60_000 });
  const pacer = new WakePacer({ now: time.now, sleep: time.sleep, storage: kvWakeStorage(kv) });
  assert.equal(await pacer.heldUntil(), time.now() + 10 * 60_000);
  assert.equal(await pacer.take(), null);
  assert.equal(await pacer.nextWakeAt(), time.now(), "a boat resume isn't held");
  assert.equal(kv.values.has("wakeBudget"), false);
  assert.equal((kv.values.get("wakePacer") as WakePacerState).heldUntil, time.now() + 10 * 60_000);
  // A budget's key without a hold just goes.
  kv.values.set("wakeBudget", { tokens: 2, at: time.now() });
  const reloaded = new WakePacer({ now: time.now, sleep: time.sleep, storage: kvWakeStorage(kv) });
  assert.equal(await reloaded.heldUntil(), time.now() + 10 * 60_000);
  assert.equal(kv.values.has("wakeBudget"), false);
});
