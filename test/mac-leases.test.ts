import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type Database from "better-sqlite3";
import { MacLeaseLedger, LEASE_DAY_MS, MAC_LEASE_BILLING_MIGRATIONS } from "../src/mac-leases.ts";
import { TaskStore } from "../src/store.ts";
import { macRunsOnBatch } from "../src/mac-lease-view.ts";
import { runsOnNote } from "../web/providers-logic.ts";
import { formatLeaseDays } from "../web/mac-usage-logic.ts";
import { maintainLeasesAndKeepAwake } from "../src/lease-maintenance.ts";
const at = Date.parse("2026-11-01T00:00:00Z"), hour = 3600000;
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const sql of TaskStore.migrations()) db.exec(sql);
  const ledger = new MacLeaseLedger(() => db as unknown as Database.Database);
  return { ledger, db };
}
function record(ledger: MacLeaseLedger, start = at) {
  return ledger.record({ id:"instabox:1", provider:"instabox", machineId:"m_1",size:"m2",startedAt:new Date(start).toISOString(),paidUntil:new Date(start+LEASE_DAY_MS).toISOString(),minimumCost:10.8,hourPrice:0.45,currency:"USD",cpus:8,memoryMiB:16384 });
}
function near(actual: number, expected: number) { assert.ok(Math.abs(actual-expected)<1e-8, `${actual} != ${expected}`); }
test("billing is the entire minimum plus per-second elapsed time, never another started day", () => {
  const {ledger}=fixture(); const lease=record(ledger);
  near(ledger.between(at,Infinity,at+hour).costs.USD!,10.8);
  const after=ledger.between(at,Infinity,at+25*hour+30*1000);
  near(after.costs.USD!,10.8+0.45*(1+1/120));
  near(after.leaseDays,(25+1/120)/24);
  ledger.end(lease.id,"deleted",at+25*hour+30*1000);
  assert.deepEqual(ledger.between(at,Infinity,at+90*LEASE_DAY_MS),after);
});
test("fractional lease-days and costs split across calendar months and rolling 30 days", () => {
  const {ledger}=fixture();record(ledger,at-12*hour);
  const now=at+13*hour;
  const october=ledger.between(at-LEASE_DAY_MS,at,now), november=ledger.summary(now).month;
  near(october.leaseDays,0.5);near(october.costs.USD!,5.4);
  near(november.leaseDays,13/24);near(november.costs.USD!,5.85);
  near(ledger.summary(now).rolling30.leaseDays,25/24);
  near(ledger.summary(now).rolling30.costs.USD!,11.25);
  const later=ledger.summary(at+40*LEASE_DAY_MS).rolling30;
  near(later.leaseDays,30);near(later.costs.USD!,30*24*0.45);
});
test("early deletion keeps the minimum and provider-specific minimum/rate/currency work without 24-hour assumptions", () => {
  const {ledger}=fixture(); const lease=record(ledger);ledger.end(lease.id,"handed back",at+hour);
  near(ledger.summary(at+3*LEASE_DAY_MS).month.costs.USD!,10.8);
  ledger.record({...lease,id:"other:1",machineId:"other_1",provider:"other",paidUntil:new Date(at+48*hour).toISOString(),minimumCost:20,hourPrice:2,currency:"EUR"});
  const total=ledger.between(at,Infinity,at+48*hour+30*1000);
  near(total.costs.EUR!,20+2/120);
  near(total.leaseDays,1+2+30*1000/LEASE_DAY_MS);
});
test("restart reconcile never extends paid time and warning is once per minimum", () => {
  const {ledger,db}=fixture(); const lease=record(ledger);ledger.attach(lease.id,"t_1",4,8192,at);
  const restarted=new MacLeaseLedger(() => db as unknown as Database.Database);
  restarted.reconcile("instabox",new Set(["m_1"]),at+3*LEASE_DAY_MS);
  assert.equal(restarted.held()[0]!.paidUntil,lease.paidUntil);
  assert.equal(restarted.warn(lease.id),true);assert.equal(ledger.warn(lease.id),false);
  restarted.reconcile("boat",new Set(),at+3*LEASE_DAY_MS);assert.equal(ledger.held().length,1);
  restarted.reconcile("instabox",new Set(),at+3*LEASE_DAY_MS);assert.equal(ledger.list()[0]!.endReason,"deleted");
});
test("stale record cannot reopen an ended lease or erase an explicit keep", () => {
  const {ledger}=fixture(); const lease=record(ledger);ledger.keep(lease.id);ledger.record(lease);
  assert.equal(ledger.held()[0]!.kept,true);
  ledger.end(lease.id,"handed back",at+LEASE_DAY_MS);ledger.record({...lease,machineId:"m_2"});
  assert.equal(ledger.held().length,0);assert.equal(ledger.list()[0]!.machineId,"m_1");
  assert.equal(ledger.list()[0]!.endReason,"handed back");
  ledger.record({...lease,id:"instabox:2",startedAt:new Date(at+hour).toISOString(),paidUntil:new Date(at+25*hour).toISOString()});
  ledger.record(lease); // A stale ended identity must not conflict with the newer held lease.
  assert.equal(ledger.held()[0]!.id,"instabox:2");
});
test("scheduled release is durable and missing machines end at the scheduled instant", () => {
  const {ledger,db}=fixture();const lease=record(ledger);ledger.schedule(lease.id,lease.paidUntil);
  const restarted=new MacLeaseLedger(() => db as unknown as Database.Database);
  restarted.reconcile("instabox",new Set(),at+2*LEASE_DAY_MS);
  assert.equal(ledger.list()[0]!.endedAt,lease.paidUntil);
  near(ledger.between(at,Infinity,at+2*LEASE_DAY_MS).costs.USD!,10.8);
});
test("legacy migrations recover original minimum and hourly rate without moving existing migration indexes", () => {
  const db=new DatabaseSync(":memory:");
  const all=TaskStore.migrations();for(const sql of all.slice(0,-MAC_LEASE_BILLING_MIGRATIONS.length))db.exec(sql);
  db.prepare("INSERT INTO mac_leases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run("instabox:1","instabox","m_1","m2",new Date(at).toISOString(),new Date(at+3*LEASE_DAY_MS).toISOString(),10.8,"USD",8,16384,null,null,null);
  for(const sql of MAC_LEASE_BILLING_MIGRATIONS)db.exec(sql);
  const ledger=new MacLeaseLedger(()=>db as unknown as Database.Database);
  assert.equal(ledger.held()[0]!.paidUntil,new Date(at+LEASE_DAY_MS).toISOString());near(ledger.held()[0]!.hourPrice,0.45);
  assert.equal((db.prepare("PRAGMA index_info(mac_lease_tasks_task)").get() as {name:string}).name,"task_id");
});
test("Mac lines batch their reads and format local instants with singular lease-day", () => {
  const {ledger,db}=fixture(); const lease=record(ledger);
  ledger.attach(lease.id,"t_1",4,8192,at);ledger.attach(lease.id,"t_2",4,8192,at+1);
  let reads=0;const counting={prepare:(sql:string)=>{reads++;return db.prepare(sql)}} as unknown as Database.Database;
  const view=macRunsOnBatch(new MacLeaseLedger(()=>counting).snapshot(),[]);
  for(let i=0;i<50;i++)view("m_1","t_2");assert.equal(reads,2);
  const task=view("m_1","t_2")!;assert.equal(task.lease?.shared,true);
  assert.match(runsOnNote(task,at,"en-GB","America/Los_Angeles")!,/same lease, paid until Sun 16:00/);
  assert.match(runsOnNote(task,at,"en-GB","Asia/Tokyo")!,/Mon 09:00/);
  assert.equal(formatLeaseDays(1,"en-US"),"1 lease-day");assert.equal(formatLeaseDays(1.0001,"en-US"),"1 lease-day");assert.equal(formatLeaseDays(1.25,"en-US"),"1.25 lease-days");
});
test("Mac maintenance failure never skips Linux keep-awake, and no leases skips the Mac pass",async()=>{
  let mac=0,awake=0;const warnings:string[]=[];
  const deps={hasMacLeases:()=>true,mac:async()=>{mac++;throw new Error("provider down")},keepAwake:async()=>{awake++},warn:(line:string)=>{warnings.push(line)}};
  await maintainLeasesAndKeepAwake(deps);assert.equal(mac,1);assert.equal(awake,1);assert.equal(warnings.length,1);
  await maintainLeasesAndKeepAwake({...deps,hasMacLeases:()=>false});assert.equal(mac,1);assert.equal(awake,2);
});

test("hand-back uses each held lease's provider and its own minimum, with a wait fallback for providers without scheduling",async()=>{
  const {BoatService}=await import("../src/service.ts"),{FakeBoat,defaultSettings,memoryStore}=await import("./fakes.ts");
  const {createBoatProvider}=await import("../src/providers/boat/provider.ts");
  const {createProviderRegistry,unavailableProvider}=await import("../src/providers/registry.ts");
  const store=memoryStore();let deleted=0,listed=0;
  const machine={id:"other_1",state:"idle"} as import("../src/providers/types.ts").SandboxInfo;
  const other={...unavailableProvider("other"),list:async()=>{listed++;return [machine]},findInfo:async()=>machine,delete:async()=>{deleted++}};
  const provider=createBoatProvider(new FakeBoat() as unknown as import("../src/providers/boat/api.ts").BoatApi);
  const service=new BoatService(createProviderRegistry([provider,other]),store,{settings:async()=>defaultSettings(),lifecycle:new AbortController().signal,changed:()=>{},notify:async()=>{},log:{info:()=>{},warn:()=>{}}});
  await service.processMacLeases(at);assert.equal(listed,0);
  store.macLeases.record({id:"other:1",provider:"other",machineId:machine.id,size:"m4",startedAt:new Date(at).toISOString(),paidUntil:new Date(at+12*hour).toISOString(),minimumCost:7,hourPrice:0.8,currency:"EUR",cpus:8,memoryMiB:16384});
  await service.processMacLeases(at+11.75*hour);assert.equal(deleted,0);
  await service.processMacLeases(at+12*hour+1);assert.equal(deleted,1);
  assert.equal(store.macLeases.list()[0]!.endReason,"handed back");
});

test("Scaleway bills its minimum plus begun hours, split across UTC months with no new day charge",()=>{
  const {ledger}=fixture();const start=Date.UTC(2026,10,30,12),minimumEnd=start+LEASE_DAY_MS;
  const lease=ledger.record({id:"scaleway:1",provider:"scaleway",machineId:"scw_1",size:"M1-M",startedAt:new Date(start).toISOString(),paidUntil:new Date(minimumEnd).toISOString(),minimumCost:2.64,hourPrice:0.11,billingIncrementSeconds:3600,currency:"EUR",cpus:8,memoryMiB:8192});
  near(ledger.between(start,Infinity,start+hour).costs.EUR!,2.64);
  near(ledger.between(start,Infinity,minimumEnd).costs.EUR!,2.64);
  near(ledger.between(start,Infinity,minimumEnd+1).costs.EUR!,2.75);
  near(ledger.between(start,Infinity,minimumEnd+hour).costs.EUR!,2.75);
  near(ledger.between(start,Infinity,minimumEnd+hour+1).costs.EUR!,2.86);
  const boundary=Date.UTC(2026,11,1);
  near(ledger.between(start,boundary,minimumEnd+hour/2).costs.EUR!,1.32);
  near(ledger.between(boundary,Infinity,minimumEnd+hour/2).costs.EUR!,1.43);
  near(ledger.between(boundary,Infinity,minimumEnd+hour/2).leaseDays,13/24);
  ledger.end(lease.id,"handed back",minimumEnd+hour/2);
  near(ledger.between(start,Infinity,minimumEnd+20*LEASE_DAY_MS).costs.EUR!,2.75);
  assert.equal(ledger.list()[0]!.paidUntil,lease.paidUntil);
});
