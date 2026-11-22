import assert from "node:assert/strict";
import { test } from "node:test";
import { readSavedSnapshots } from "../src/rpc-snapshots.ts";
import type { BoatService } from "../src/service.ts";

const snapshot = { name: "demo-linux", provider: "boat", sourceSandboxId: "bx_demo", sizeBytes: 4096, createdAt: "2026-11-01T00:00:00Z", status: "ready", type: "small" };
const now = () => Date.parse("2026-11-12T09:00:00Z");
const service = (result: Awaited<ReturnType<BoatService["snapshots"]>>) => ({ snapshots: async () => result });

test("saved snapshots retain successful rows on partial failure without claiming an empty or complete inventory", async () => {
  const reading = await readSavedSnapshots(service({ snapshots: [snapshot], included: 10, used: 1,
    failed: [{ provider: "instabox", error: "untrusted provider diagnostic" }] }), now);
  assert.equal(reading.snapshots.length, 1);
  assert.equal(reading.snapshots[0]?.status, "ready", "provider ready remains a status, never restore-tested evidence");
  assert.equal(reading.complete, false);
  assert.deepEqual(reading.failedProviders, ["instabox"]);
  assert.equal(reading.observedAt, "2026-11-12T09:00:00.000Z");
  assert.match(reading.error ?? "", /could not be checked/);
  assert.doesNotMatch(JSON.stringify(reading), /untrusted provider diagnostic|sourceSandboxId|bx_demo/);
});

test("complete empty snapshots and unavailable snapshots remain distinguishable", async () => {
  const empty = await readSavedSnapshots(service({ snapshots: [], included: null, used: null, failed: [] }), now);
  const unavailable = await readSavedSnapshots({ snapshots: async () => { throw new Error("untrusted diagnostic"); } }, now);
  assert.equal(empty.complete, true);
  assert.equal(empty.error, null);
  assert.ok(empty.observedAt);
  assert.equal(unavailable.complete, false);
  assert.equal(unavailable.observedAt, null);
  assert.match(unavailable.error ?? "", /unavailable/);
  assert.doesNotMatch(JSON.stringify(unavailable), /untrusted diagnostic/);
});

test("snapshot projection is bounded and cannot claim a truncated inventory is complete", async () => {
  const reading = await readSavedSnapshots(service({ snapshots: Array.from({ length: 1001 }, (_, index) => ({ ...snapshot, name: `demo-${index}` })), included: null, used: null, failed: [] }), now);
  assert.equal(reading.snapshots.length, 1000);
  assert.equal(reading.complete, false);
  assert.match(reading.error ?? "", /incomplete/);
});
