import assert from "node:assert/strict";
import { test } from "node:test";
import { readSavedSnapshots } from "../src/rpc-snapshots.ts";
import type { BoatService } from "../src/service.ts";
import { BoatApi } from "../src/providers/boat/api.ts";
import type { BoatCli } from "../src/providers/boat/cli.ts";
import { createInstaboxProvider } from "../src/providers/instabox/provider.ts";
import type { InstaboxCli } from "../src/providers/instabox/cli.ts";
import type { InstaboxRest } from "../src/providers/instabox/api.ts";

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

test("malformed boat snapshot inventory cannot become a complete empty reading", async () => {
  for (const raw of [{}, { named: {} }, { named: [null] }, { named: [{ status: "ready" }] }, { named: [{ name: " " }] }, { named: [{ name: "demo" }, null] }]) {
    const adapter = new BoatApi({ json: async () => raw } as unknown as BoatCli);
    const result = await readSavedSnapshots({ snapshots: async () => { const reading = await adapter.snapshots(); return { ...reading, snapshots: reading.snapshots.map(row => ({ ...row, provider: "boat" })), failed: [] }; } }, now);
    assert.equal(result.complete, false);
    assert.equal(result.observedAt, null);
    assert.match(result.error ?? "", /unavailable/);
  }
  const empty = new BoatApi({ json: async () => ({ named: [] }) } as unknown as BoatCli);
  assert.deepEqual((await empty.snapshots()).snapshots, []);
  const valid = new BoatApi({ json: async () => ({ named: [{ name: "demo", status: "ready" }] }) } as unknown as BoatCli);
  assert.equal((await valid.snapshots()).snapshots[0]?.name, "demo");
});

test("malformed Instabox snapshot inventory cannot become a complete empty reading", async () => {
  for (const value of [{}, { snapshots: {} }, [null], [{ status: "ready" }], [{ name: " " }], [{ name: "demo" }, null]]) {
    const adapter = createInstaboxProvider({ run: async () => ({ value }) } as unknown as InstaboxCli, {} as InstaboxRest);
    const result = await readSavedSnapshots({ snapshots: async () => { const reading = await adapter.snapshots(); return { ...reading, snapshots: reading.snapshots.map(row => ({ ...row, provider: "instabox" })), failed: [] }; } }, now);
    assert.equal(result.complete, false);
    assert.equal(result.observedAt, null);
    assert.match(result.error ?? "", /unavailable/);
  }
  for (const value of [[], { snapshots: [] }]) {
    const empty = createInstaboxProvider({ run: async () => ({ value }) } as unknown as InstaboxCli, {} as InstaboxRest);
    assert.deepEqual((await empty.snapshots()).snapshots, []);
  }
  const valid = createInstaboxProvider({ run: async () => ({ value: [{ name: "demo", status: "ready" }] }) } as unknown as InstaboxCli, {} as InstaboxRest);
  assert.equal((await valid.snapshots()).snapshots[0]?.name, "demo");
});
