import assert from "node:assert/strict";
import {test} from "node:test";
import {memoryStore} from "./fakes.ts";
import {MacLeaseLedger, type LegacyDeletedAdoptionEvidence} from "../src/mac-leases.ts";

function fixture() {
  const store=memoryStore(),ledger=store.macLeases,now=Date.now(),start=now-30_000,failed=start+4_000,end=failed+1_500;
  const input={id:"instabox:example-lease",provider:"instabox",machineId:"m_example",size:"m2",startedAt:new Date(start).toISOString(),paidUntil:new Date(start+86_400_000).toISOString(),minimumCost:10.8,hourPrice:0.45,currency:"USD",cpus:8,memoryMiB:12288};
  ledger.record(input);
  const db=(store as unknown as {db:()=>{prepare(sql:string):{run(...args:unknown[]):unknown};exec(sql:string):void}}).db();
  db.prepare("UPDATE mac_leases SET ended_at=?,end_reason='deleted',end_evidence='legacy',notice_at=?,notice_text='Historical discrepancy',release_at=NULL WHERE id=?").run(new Date(end).toISOString(),new Date(end).toISOString(),input.id);
  const original=ledger.rawList()[0]!;
  const current={...input,scheduledReleaseAt:input.paidUntil,physicalLeaseId:"example-lease"};
  const evidence:LegacyDeletedAdoptionEvidence={revision:ledger.revision(),taskId:"t_example",sourceTaskId:"t_source",failureCause:"lease_unknown",failedAt:new Date(failed).toISOString(),observedAt:new Date(now).toISOString(),expectedEndedAt:original.endedAt!,operatorProof:{ledgerId:input.id,leaseId:current.physicalLeaseId,sourceTaskId:"t_source",startedAt:input.startedAt,paidUntil:input.paidUntil,endedAt:original.endedAt!,failedAt:new Date(failed).toISOString(),noReleaseRequested:true}};
  return {store,ledger,db,input,original,current,evidence,now,start};
}

test("explicit legacy adoption preserves raw history and accounts one physical minimum across restart and termination",()=>{
  const f=fixture();f.ledger.attach(f.input.id,"t_example",4,8192);f.ledger.recordUnknownGithubExpiry(f.input.id);f.ledger.recordCredentialNotice(f.input.id,"Example credential reminder");
  const adopted=f.ledger.adoptLegacyDeleted(f.input.id,f.current,f.evidence)!;
  assert.equal(adopted.id,f.input.id);assert.equal(adopted.endedAt,null);assert.equal(adopted.releaseAt,f.input.paidUntil);
  assert.equal(f.ledger.held().length,1);assert.equal(f.ledger.list().length,1);assert.deepEqual(f.ledger.rawList(),[f.original]);
  assert.equal(f.ledger.between(0,Infinity,f.now).costs.USD,10.8);
  assert.ok(Math.abs(f.ledger.between(0,Infinity,f.start+25*3_600_000).costs.USD!-11.25)<1e-8);
  const audit=f.ledger.adoptions()[0]!;assert.deepEqual(audit.original,f.original);assert.deepEqual(audit.current,f.current);assert.equal(audit.evidence.taskId,"t_example");
  f.ledger.keep(f.input.id);assert.equal(f.ledger.held()[0]!.kept,true);f.ledger.schedule(f.input.id,f.input.paidUntil);f.ledger.warn(f.input.id,f.now,true,"Current adoption notice",true);f.ledger.clearNotice(f.input.id);f.ledger.observeDiscrepancy(f.input.id,"Current observation",f.now);
  assert.deepEqual(f.ledger.rawList(),[f.original],"all effective state updates leave original fields unchanged");
  const reopened=new MacLeaseLedger(()=>(f.store as unknown as {db:()=>never}).db());assert.equal(reopened.held()[0]!.id,f.input.id);
  reopened.end(f.input.id,"handed back",f.start+25*3_600_000);
  assert.equal(reopened.held().length,0);assert.deepEqual(reopened.rawList(),[f.original]);assert.equal(reopened.restoreCurrent(f.input,{revision:reopened.revision(),allowLegacy:true}),null);
  assert.equal(reopened.adoptLegacyDeleted(f.input.id,f.current,{...f.evidence,revision:reopened.revision()}),null);
  assert.equal(reopened.credentialNotices().length,1);assert.equal(reopened.tasks(f.input.id).length,1);
});

for(const scenario of ["confirmed end","handed back","before failure","late end","wrong lease","changed terms","changed schedule","changed microseconds","stale read","owner release","missing attestation","kept work"] as const)test(`explicit adoption refuses ${scenario} without changing original or accounting`,()=>{
  const f=fixture();let current=f.current,evidence=f.evidence;
  if(scenario==="confirmed end")f.db.prepare("UPDATE mac_leases SET end_evidence='confirmed'").run();
  if(scenario==="handed back")f.db.prepare("UPDATE mac_leases SET end_reason='handed back'").run();
  if(scenario==="before failure")evidence={...evidence,failedAt:new Date(Date.parse(f.original.endedAt!)+1000).toISOString()};
  if(scenario==="late end"){const later=new Date(Date.parse(f.original.endedAt!)+20_000).toISOString();f.db.prepare("UPDATE mac_leases SET ended_at=?").run(later);evidence={...evidence,expectedEndedAt:later};}
  if(scenario==="wrong lease")current={...current,physicalLeaseId:"different-lease"};
  if(scenario==="changed terms")current={...current,hourPrice:0.9};
  if(scenario==="changed schedule")current={...current,scheduledReleaseAt:new Date(f.start+3_600_000).toISOString()};
  if(scenario==="changed microseconds")current={...current,startedAt:current.startedAt.replace("Z","999Z")};
  if(scenario==="stale read")evidence={...evidence,revision:evidence.revision-1};
  if(scenario==="missing attestation")evidence={...evidence,operatorProof:{...evidence.operatorProof,noReleaseRequested:false as unknown as true}};
  if(scenario==="kept work")f.db.prepare("UPDATE mac_leases SET kept=1").run();
  if(scenario==="owner release"){f.ledger.recordReleaseIntent(f.input.machineId,"delete");evidence={...evidence,revision:f.ledger.revision()};}
  evidence={...evidence,operatorProof:{...evidence.operatorProof,failedAt:evidence.failedAt,endedAt:evidence.expectedEndedAt}};
  const raw=f.ledger.rawList();assert.equal(f.ledger.adoptLegacyDeleted(f.input.id,current,evidence),null);assert.deepEqual(f.ledger.rawList(),raw);assert.equal(f.ledger.held().length,0);assert.deepEqual(f.ledger.adoptions(),[]);
});

test("adoption and synchronous task admission roll back together on refusal or exception",()=>{
  const f=fixture();f.db.exec("CREATE TABLE admission_probe (id TEXT)");
  assert.equal(f.ledger.adoptLegacyDeleted(f.input.id,f.current,{...f.evidence,admit:()=>{f.db.prepare("INSERT INTO admission_probe VALUES ('example')").run();return false;}}),null);
  assert.deepEqual(f.ledger.adoptions(),[]);assert.equal(f.ledger.held().length,0);assert.deepEqual(f.ledger.rawList(),[f.original]);
  assert.throws(()=>f.ledger.adoptLegacyDeleted(f.input.id,f.current,{...f.evidence,admit:()=>{throw Error("fake admission changed");}}),/admission changed/);
  assert.deepEqual(f.ledger.adoptions(),[]);assert.deepEqual(f.ledger.rawList(),[f.original]);
});

test("a new raw active row cannot overlap the adopted same-machine physical lease",()=>{
  const f=fixture();assert.ok(f.ledger.adoptLegacyDeleted(f.input.id,f.current,f.evidence));
  assert.throws(()=>f.ledger.record({...f.input,id:"instabox:new-lease"}),/active physical lease/);
  assert.equal(f.ledger.list().length,1);assert.deepEqual(f.ledger.rawList(),[f.original]);
});
