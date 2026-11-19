import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type Database from "better-sqlite3";
import { MacLeaseLedger, LEASE_DAY_MS } from "../src/mac-leases.ts";
import { TaskStore } from "../src/store.ts";
import { macRunsOn } from "../src/mac-lease-view.ts";
const at = Date.parse("2026-11-01T00:00:00Z");
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const sql of TaskStore.migrations()) db.exec(sql);
  const ledger = new MacLeaseLedger(() => db as unknown as Database.Database);
  return { ledger, db };
}
function record(ledger: MacLeaseLedger, start = at) {
  return ledger.record({ id:"instabox:1", provider:"instabox", machineId:"m_1",size:"m2",startedAt:new Date(start).toISOString(),paidUntil:new Date(start+LEASE_DAY_MS).toISOString(),dayPrice:10.8,currency:"USD",cpus:8,memoryMiB:16384 });
}
test("lease windows use UTC calendar months and a separate rolling 30 days, counting simultaneous leases separately", () => {
  const {ledger} = fixture();
  const start = at-LEASE_DAY_MS;
  const lease = record(ledger,start);
  ledger.renew(lease.id, at+2*LEASE_DAY_MS);
  ledger.record({...lease,id:"instabox:2",machineId:"m_2",startedAt:new Date(at).toISOString()});
  const summary = ledger.summary(at+2*LEASE_DAY_MS);
  assert.equal(summary.month.leaseDays,6);
  assert.equal(summary.rolling30.leaseDays,7);
  assert.ok(Math.abs(summary.month.costs.USD!-64.8)<1e-8);
  ledger.attach(lease.id,"t_1",4,8192); ledger.attach(lease.id,"t_2",4,8192);
  assert.equal(ledger.summary(at+2*LEASE_DAY_MS).month.leaseDays,6,"sharing never duplicates cost");
  assert.equal(ledger.between(at-32*LEASE_DAY_MS, at-31*LEASE_DAY_MS,at).leaseDays,0);
});
test("renewal catches up missed windows exactly once; restart reconcile closes only missing provider machines", () => {
  const {ledger,db}=fixture(); const lease=record(ledger);
  ledger.attach(lease.id,"t_1",4,8192,at);
  const restarted=new MacLeaseLedger(() => db as unknown as Database.Database);
  restarted.reconcile("instabox",new Set(["m_1"]),at+3*LEASE_DAY_MS);
  restarted.reconcile("instabox",new Set(["m_1"]),at+3*LEASE_DAY_MS);
  assert.equal(Date.parse(restarted.held()[0]!.paidUntil),at+4*LEASE_DAY_MS);
  assert.equal(restarted.tasks(lease.id).length,1);
  assert.equal(restarted.warn(lease.id,restarted.held()[0]!.paidUntil),true);
  assert.equal(ledger.warn(lease.id,restarted.held()[0]!.paidUntil),false);
  restarted.reconcile("boat",new Set(),at+3*LEASE_DAY_MS);
  assert.equal(restarted.held().length,1);
  restarted.reconcile("instabox",new Set(),at+3*LEASE_DAY_MS);
  assert.equal(ledger.held().length,0);
  assert.equal(ledger.list()[0]!.endReason,"deleted");
});
test("ended leases stop accumulating days, with per-currency totals", () => {
  const {ledger}=fixture(); const lease=record(ledger);
  ledger.end(lease.id,"handed back",at+23.5*3600000);
  assert.deepEqual(ledger.summary(at+40*LEASE_DAY_MS).rolling30,{leaseDays:0,costs:{}});
  assert.equal(ledger.summary(at+3*LEASE_DAY_MS).month.leaseDays,1);
});
test("task lines distinguish the second task on a lease and sandbox prices come from the ledger", () => {
  const {ledger}=fixture(); const lease=record(ledger);
  ledger.attach(lease.id,"t_1",4,8192,at);ledger.attach(lease.id,"t_2",4,8192,at+1);
  const task=macRunsOn(ledger,"m_1",[],"t_2")!;
  assert.match(task.note!,/^same lease, ends Mon 00:00 UTC$/);
  assert.equal(task.machine,"Mac M2");
  assert.equal(macRunsOn(ledger,"m_1",[])?.detail,"24 h lease · $10.80");
});

test("replacing a deleted VM on the same physical lease keeps one charge history", () => {
  const {ledger}=fixture(); const lease=record(ledger);
  ledger.attach(lease.id,"t_1",4,8192,at);
  ledger.end(lease.id,"deleted",at+3600000);
  ledger.record({...lease,machineId:"m_2"});
  assert.equal(ledger.held()[0]?.machineId,"m_2");
  assert.equal(ledger.summary(at+2*3600000).month.leaseDays,1);
  assert.equal(ledger.tasks(lease.id).length,1);
});
