import assert from "node:assert/strict";
import { test } from "node:test";
import { createInstaboxProvider } from "../src/providers/instabox/provider.ts";
import type { InstaboxCli, JsonRecord } from "../src/providers/instabox/cli.ts";
import type { InstaboxRest } from "../src/providers/instabox/api.ts";
import { memoryStore } from "./fakes.ts";

const start = "2026-11-05T12:00:00.123456Z", until = "2026-11-06T12:00:00.123456Z";
function machine(id = "m_example", leaseId: string | number = "71"): JsonRecord {
  return { id, name: "bb-example", state: "running", template: { id: "macos" }, model: "m2", spec: {vcpus: 8, memMiB: 12288}, runtime: {ready: true}, metadata: {"created-by": "bb-boat", "boat-mac-model": "m2"}, lease: {id: leaseId, startedAt: start, chargeUntil: until, hourUSD: 0.45}, deleteAt: until };
}
function fixture() {
  const store = memoryStore(); let current = machine(), listed: JsonRecord[] = [current];
  const calls: string[] = [];
  const cli = {
    json: async (args: string[]) => {calls.push(args.join(" ")); return {machine: structuredClone(current)};},
    run: async (args: string[]) => {calls.push(args.join(" ")); return {value: structuredClone(listed)};},
  } as unknown as InstaboxCli;
  const provider = createInstaboxProvider(cli, {} as InstaboxRest, {ledger: store.macLeases});
  return {store, provider, calls, setCurrent: (value: JsonRecord) => {current = value;}, setList: (value: JsonRecord[]) => {listed = value;}};
}

test("real-shaped numeric-string lease and microsecond timestamps register through authoritative get", async () => {
  const f = fixture(); const info = await f.provider.info("m_example");
  assert.equal(info.mac?.leaseId, "71"); assert.equal(info.mac?.memoryMiB, 12288);
  assert.equal(f.store.macLeases.held().length, 1);
  const lease = f.store.macLeases.held()[0]!;
  assert.equal(lease.startedAt, start); assert.equal(lease.paidUntil, until);
  assert.ok(Math.abs(lease.minimumCost - 10.8) < 1e-8);
  assert.equal(lease.releaseAt, until);
  assert.deepEqual(f.calls, ["get m_example --json"], "a read never starts or extends a physical lease");
});

test("a stale stopped list cannot end a newly allocated lease", async () => {
  const f = fixture(); await f.provider.list({all: true});
  const old = {...machine(), state: "stopped", lease: undefined, updatedAt: "2026-11-04T12:00:00.000Z"};
  f.setList([old]); await f.provider.list({all: true});
  assert.equal(f.store.macLeases.held().length, 1);
  assert.equal(f.store.macLeases.list()[0]!.endedAt, null);
});

test("per-machine lease identity prevents collisions across identical provider lease IDs", async () => {
  const f = fixture(); f.setList([machine("m_one"), machine("m_two")]); await f.provider.list({all:true});
  assert.deepEqual(f.store.macLeases.held().map(lease => lease.machineId).sort(), ["m_one", "m_two"]);
  assert.equal(f.store.macLeases.summary(Date.parse(start)).month.costs.USD, 21.6);
});

test("fresh get repairs a list-inferred end, while an explicit physical end stays terminal", async () => {
  const f = fixture(); await f.provider.list({all:true});
  const lease = f.store.macLeases.held()[0]!;
  f.store.macLeases.reconcile("instabox", new Set(), Date.parse(start) + 1000);
  assert.equal(f.store.macLeases.held().length, 0);
  await f.provider.info("m_example");
  assert.equal(f.store.macLeases.held().length, 1);
  assert.equal(f.store.macLeases.list().length, 1, "repair cannot charge a second minimum");
  f.store.macLeases.end(lease.id, "handed back", Date.parse(until));
  await f.provider.info("m_example");
  assert.equal(f.store.macLeases.held().length, 0);
});

test("a get started before physical termination cannot revive an inferred end", async () => {
  const f = fixture(); await f.provider.list({all:true});
  const lease = f.store.macLeases.held()[0]!;
  f.store.macLeases.reconcile("instabox", new Set(), Date.parse(start) + 1000);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;}), pending = new Promise<void>(resolve => {entered = resolve;});
  const ledger = f.store.macLeases;
  const cli = {json: async () => {entered(); await gate; return {machine: machine()};}} as unknown as InstaboxCli;
  const provider = createInstaboxProvider(cli, {} as InstaboxRest, {ledger});
  const read = provider.info("m_example"); await pending;
  // An explicit end upgrades inference to a confirmed tombstone even when
  // inference had already removed the lease from held().
  ledger.end(lease.id, "deleted", Date.parse(start) + 2000);
  release(); await read;
  assert.equal(ledger.held().length, 0);
});

test("legacy recovery refuses an ambiguous end and repairs only an impossible pre-allocation end", async () => {
  const f = fixture(); await f.provider.list({all:true});
  const lease = f.store.macLeases.held()[0]!;
  f.store.macLeases.end(lease.id, "deleted", Date.parse(start) + 1000, "inferred");
  // Simulate the migration's unknown provenance for an old installation.
  const db = (f.store as unknown as {db: () => {prepare(sql: string): {run(...args: unknown[]): unknown}}}).db();
  db.prepare("UPDATE mac_leases SET end_evidence='legacy' WHERE id=?").run(lease.id);
  const {instaboxLeaseInput} = await import("../src/providers/instabox/provider.ts");
  const input = instaboxLeaseInput(f.store.macLeases, await f.provider.info("m_example"))!;
  assert.equal(f.store.macLeases.restoreCurrent(input, {revision: f.store.macLeases.revision(), allowLegacy: true}), null);
  assert.equal(f.store.macLeases.held().length, 0);
  assert.match(f.store.macLeases.list()[0]!.noticeText!, /currently reports.*active.*Billing may continue/);
  db.prepare("UPDATE mac_leases SET ended_at=? WHERE id=?").run("2026-11-04T12:00:00.000Z", lease.id);
  assert.ok(f.store.macLeases.restoreCurrent(input, {revision: f.store.macLeases.revision(), allowLegacy: true}));
  assert.equal(f.store.macLeases.list().length, 1);
});

test("an incomplete create envelope is resolved by get of the allocated machine without another create", async () => {
  const store = memoryStore(), calls: string[][] = [];
  const cli = {json: async (args: string[]) => {
    calls.push(args);
    if (args[0] === "usage") return {org: {tier:"pro"}};
    if (args[0] === "templates") return {templates: [{id:"macos",os:"macos",creatable:true,models:[{name:"m2",defaultSpec:{vcpus:8,memMiB:12288},minimumLease:{hours:24,hourUSD:0.45,minimumUSD:10.8}}]}]};
    if (args[0] === "create") return {machine: {...machine(), lease: undefined}};
    if (args[0] === "get") return {machine: machine()};
    assert.fail(`Unexpected fake operation ${args[0]}`);
  }} as unknown as InstaboxCli;
  const provider = createInstaboxProvider(cli, {} as InstaboxRest, {ledger:store.macLeases});
  const sandbox = await provider.create({name:"example",type:"default",system:"macos",ttlSeconds:3600,gitGuard:true});
  assert.equal(sandbox.id,"m_example"); assert.equal(store.macLeases.held().length,1);
  assert.equal(calls.filter(args => args[0] === "create").length,1);
  assert.equal(calls.filter(args => args[0] === "get").length,1);
  assert.ok(calls.every(args => !["start", "resume", "rm", "stop"].includes(args[0]!)));
});

test("an older stopped get finishing after a newer active get cannot end the lease", async () => {
  const f = fixture(); await f.provider.list({all:true});
  let release!: () => void, entered!: () => void, reads = 0;
  const gate = new Promise<void>(resolve => {release = resolve;}), pending = new Promise<void>(resolve => {entered = resolve;});
  const cli = {json: async () => {
    if (++reads === 1) {entered(); await gate; return {machine: {...machine(), state:"stopped",lease:undefined,updatedAt:"2026-11-05T12:01:00.000Z"}};}
    return {machine: machine()};
  }} as unknown as InstaboxCli;
  const provider = createInstaboxProvider(cli, {} as InstaboxRest, {ledger:f.store.macLeases});
  const old = provider.info("m_example"); await pending;
  await provider.info("m_example"); release(); await old;
  assert.equal(f.store.macLeases.held().length,1);
});

test("invalid newer physical terms cannot end or partially replace a valid held lease", async () => {
  const f = fixture(); await f.provider.list({all:true});
  const original = f.store.macLeases.held()[0]!;
  f.setCurrent({...machine("m_example", "72"), lease:{id:"72",startedAt:"2026-11-05T13:00:00.000Z",chargeUntil:"2026-11-05T12:00:00.000Z",hourUSD:0.45}});
  await assert.rejects(f.provider.info("m_example"), /Invalid Mac lease billing terms/);
  assert.deepEqual(f.store.macLeases.held(),[original]);
});
