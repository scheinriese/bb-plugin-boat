// The account's wake pacer: at most 2 sandbox wakes a minute, a doubling pause after a failed one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { WakeDeferred, WakePacer, kvWakeStorage, type WakePacerState } from "../src/wake-pacer.ts";

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
  return { values, async get<T>(key: string) { return values.get(key) as T | undefined; }, async set(key: string, value: unknown) { values.set(key, structuredClone(value)); } };
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
