import assert from "node:assert/strict";
import { test } from "node:test";
import { makeService } from "./fakes.ts";
import { ownMacTaskNotice } from "../src/ownmac-notices.ts";

async function fixture() {
  const env=makeService();
  const original=await env.service.startTask({title:"Check the sample native app",role:"custom",brief:"Run fake native checks"});
  const source=env.store.update(original.id,{status:"failed",turns:0,sandboxId:null,hostId:null})!;
  const linked=env.store.insert({...source,id:"t_fake_linked",sandboxId:"instabox_fake_allocated",sandboxProvider:"instabox",threadId:null,environmentId:null,repoPath:null,error:"Instabox did not report the Mac lease; work cannot safely start."});
  const quote={id:"fake-quote",provider:"instabox",label:"Instabox",model:"m2",modelLabel:"Mac M2",minimumCost:10.8,hourPrice:.45,minimumHours:24,currency:"USD",expiresAt:"2099-01-01T00:00:00Z"};
  env.store.addOwnMacEvent(source.id,"ownmac-rental-offer","Fake quote",quote);
  env.store.addOwnMacEvent(source.id,"ownmac-rental-answer","Fake approval consumed",{answer:"rent",replacementId:linked.id});
  return {...env,source,linked};
}

test("a consumed rental card follows the failed linked task instead of claiming it is still starting",async()=>{
  const {store,source,linked}=await fixture();
  const notice=ownMacTaskNotice(store,source)!;
  assert.equal(notice.linkedTask?.status,"failed");
  assert.equal(notice.linkedTask?.taskId,linked.id);
  assert.equal(notice.linkedTask?.machineId,linked.sandboxId);
  assert.match(notice.linkedTask?.error ?? "",/did not report the Mac lease/);
});

test("the original approval exposes recorded minimum and handback without claiming an ended ledger proves billing ended",async()=>{
  const {store,source,linked}=await fixture();
  const lease=store.macLeases.record({id:"instabox:fake-lease",provider:"instabox",machineId:linked.sandboxId!,size:"m2",startedAt:"2030-01-01T12:00:00Z",paidUntil:"2030-01-02T12:00:00Z",minimumCost:10.8,hourPrice:.45,currency:"USD",cpus:8,memoryMiB:12288});
  store.macLeases.schedule(lease.id,lease.paidUntil);
  store.macLeases.end(lease.id,"deleted",Date.parse("2030-01-01T12:01:00Z"));
  const notice=ownMacTaskNotice(store,source)!;
  assert.deepEqual(notice.linkedTask?.lease,{provider:"instabox",model:"m2",minimumCost:10.8,hourPrice:.45,currency:"USD",paidUntil:"2030-01-02T12:00:00Z",releaseAt:"2030-01-02T12:00:00Z",endedAt:"2030-01-01T12:01:00.000Z"});
  assert.equal(notice.answer,"rent","native approval remains consumed");
  assert.equal(notice.replacementId,linked.id);
});

test("a failed linked task cannot borrow a later physical lease's billing terms",async()=>{
  const {store,source,linked}=await fixture();
  const old={id:`instabox:${linked.sandboxId}:fake-old:${Date.parse("2030-01-01T12:00:00Z")}`,provider:"instabox",machineId:linked.sandboxId!,size:"m2",startedAt:"2030-01-01T12:00:00Z",paidUntil:"2030-01-02T12:00:00Z",minimumCost:10.8,hourPrice:.45,currency:"USD",cpus:8,memoryMiB:12288};
  store.macLeases.record(old);store.macLeases.end(old.id,"handed back",Date.parse(old.paidUntil));
  store.macLeases.record({...old,id:`instabox:${linked.sandboxId}:fake-new:${Date.parse("2030-01-03T12:00:00Z")}`,startedAt:"2030-01-03T12:00:00Z",paidUntil:"2030-01-04T12:00:00Z",minimumCost:20,hourPrice:1});
  store.addOwnMacEvent(linked.id,"ownmac-allocation","Fake physical allocation",{machineId:linked.sandboxId,provider:"instabox",leaseId:"fake-old"});
  const notice=ownMacTaskNotice(store,source)!;
  assert.equal(notice.linkedTask?.lease?.minimumCost,10.8);
  assert.equal(notice.linkedTask?.lease?.paidUntil,old.paidUntil);
  store.addOwnMacEvent(linked.id,"ownmac-allocation","Precise physical allocation",{machineId:linked.sandboxId,provider:"instabox",leaseId:"fake-old",startedAt:old.startedAt,ledgerLeaseId:old.id});
  assert.equal(ownMacTaskNotice(store,source)!.linkedTask?.lease?.paidUntil,old.paidUntil);
  store.addOwnMacEvent(linked.id,"ownmac-allocation","Unknown precise identity must not fall back",{machineId:linked.sandboxId,provider:"instabox",ledgerLeaseId:"instabox:missing-physical-lease"});
  assert.equal(ownMacTaskNotice(store,source)!.linkedTask?.lease,undefined);
  store.addOwnMacEvent(linked.id,"ownmac-allocation","Legacy allocation lacks physical identity",{machineId:linked.sandboxId,provider:"instabox"});
  assert.equal(ownMacTaskNotice(store,source)!.linkedTask?.lease,undefined,"ambiguous history must remain unconfirmed");
});
