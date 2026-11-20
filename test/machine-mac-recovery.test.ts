import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import { registerSandboxMachine, keepSandboxKey } from "../src/providers/machine.ts";
import { INSTABOX_MACHINE } from "../src/providers/instabox/provider.ts";
import { unavailableProvider } from "../src/providers/registry.ts";
import type { SandboxInfo } from "../src/providers/types.ts";
import { defaultSettings } from "./fakes.ts";

type Registration = {
  create(args: unknown): Promise<{status:string;message?:string;resource?:unknown}>;
  resume(args: unknown): Promise<unknown>;
  suspend(args: unknown): Promise<unknown>;
  remove(args: unknown): Promise<{status:string}>;
  reconcileCleanup(args: unknown): Promise<{status:string}>;
};
function fixture() {
  const calls:string[] = [], kv = new Map<string,unknown>(); let definition!:Registration, failBootstrap=false;
  let bootstrapStep: ((executor: MachineExecutor) => Promise<void>) | undefined, prepareStep: (() => Promise<void>) | undefined;
  const lease = {model:"m2",leaseId:"example-lease",startedAt:new Date(Date.now()-1000).toISOString(),chargeUntil:new Date(Date.now()+86_399_000).toISOString(),minimumCost:10.8,hourPrice:0.45,cpus:8,memoryMiB:12288};
  let current:SandboxInfo|null = {id:"m_example",name:"example",state:"idle",health:"ok",url:null,desktopUrl:null,environment:null,createdAt:lease.startedAt,archiveAfter:null,stoppedAt:null,setupStatus:null,error:null,system:"macos",mac:lease,scheduledReleaseAt:lease.chargeUntil};
  const provider = {...unavailableProvider("instabox"),machine:INSTABOX_MACHINE,idPattern:/^m_/,executor:()=>({exec:async()=>{calls.push("exec");return {exitCode:0};}}),findInfo:async()=>{calls.push("get");return current;},delete:async()=>{calls.push("delete");},stop:async()=>{calls.push("stop");throw Error("unexpected stop");},machineHooks:()=>({beforeBootstrap:async()=>{await prepareStep?.();},bootstrapFailed:async()=>{calls.push("credential-cleanup");}})};
  const bb = {experimental_machines:{register:(value:Registration)=>{definition=value;},bootstrap:async({executor}:{executor:MachineExecutor})=>{calls.push("bootstrap");if(failBootstrap)throw Error("fake bootstrap failure");await bootstrapStep?.(executor);return {hostId:"host_example"};}},experimental_environments:{register(){}},storage:{kv:{get:async(key:string)=>kv.get(key),set:async(key:string,value:unknown)=>{kv.set(key,value);},delete:async(key:string)=>{kv.delete(key);}}}} as unknown as BbPluginApi;
  registerSandboxMachine(bb,provider,{service:{createSandbox:async()=>{calls.push("create");throw Error("unexpected create");},bringUp:async()=>{calls.push("resume");throw Error("unexpected wake");}},settings:async()=>defaultSettings(),availability:async()=>({status:"available"})});
  const key="task-example-recovery",signal=new AbortController().signal,report={step(){},log(){}};
  const args={key,inputs:{sandboxId:"m_example",taskId:"t_example",keepSandbox:true,recoveryLease:{...lease,scheduledReleaseAt:lease.chargeUntil}},checkpoint:async()=>{},signal,report};
  return {definition,calls,args,lease,key,signal,report,kv,patch:(patch:Partial<SandboxInfo>)=>{current={...current!,...patch};},gone:()=>{current=null;},fail:()=>{failBootstrap=true;},onBootstrap:(step:typeof bootstrapStep)=>{bootstrapStep=step;},onPrepare:(step:typeof prepareStep)=>{prepareStep=step;}};
}

for (const scenario of ["stopped","expired","changed lease","changed price","changed release","gone"] as const) test(`recovery enrollment refuses ${scenario} without waking or replacing a Mac`,async()=>{
  const f=fixture();
  if(scenario==="stopped")f.patch({state:"stopped"});
  if(scenario==="expired")f.patch({scheduledReleaseAt:new Date(Date.now()-1000).toISOString()});
  if(scenario==="changed lease")f.patch({mac:{...f.lease,leaseId:"new-lease"}});
  if(scenario==="changed price")f.patch({mac:{...f.lease,hourPrice:0.9}});
  if(scenario==="changed release")f.patch({scheduledReleaseAt:new Date(Date.now()+3_600_000).toISOString()});
  if(scenario==="gone")f.gone();
  const result=await f.definition.create(f.args);
  assert.equal(result.status,"failed");assert.match(result.message!,/recovery enrollment refused/);
  assert.deepEqual(f.calls,["get"]);
  assert.equal(f.kv.get(keepSandboxKey(f.key)),"m_example");
  assert.equal((await f.definition.reconcileCleanup({key:f.key})).status,"removed");
  assert.ok(!f.calls.includes("delete"));
});

test("failed recovery enrollment preserves the physical machine and credentials through core cleanup",async()=>{
  const f=fixture();f.fail();
  const result=await f.definition.create(f.args);assert.equal(result.status,"failed");
  assert.equal((await f.definition.reconcileCleanup({key:f.key})).status,"removed");
  assert.ok(!f.calls.some(call=>["create","resume","delete","credential-cleanup"].includes(call)));
});

test("recovered machine retains its no-wake lease binding during later core resume",async()=>{
  const f=fixture();const result=await f.definition.create(f.args);assert.equal(result.status,"created",result.message);
  f.patch({state:"stopped",mac:undefined});
  await assert.rejects(f.definition.resume({resource:result.resource,signal:f.signal,report:f.report}),/recovery enrollment refused/);
  assert.equal((await f.definition.remove({resource:result.resource})).status,"removed");
  assert.ok(!f.calls.some(call=>["create","resume","delete","credential-cleanup"].includes(call)));
});


test("core suspension cannot stop a recovered physical lease or change its release plan",async()=>{
  const f=fixture();const result=await f.definition.create(f.args);assert.equal(result.status,"created",result.message);
  await assert.rejects(f.definition.suspend({resource:result.resource,signal:f.signal,hostId:"host_example"}),/existing provider release plan/);
  assert.ok(!f.calls.includes("stop"));
});

test("recovery rechecks the original lease after prerequisite setup before enrollment",async()=>{
  const f=fixture();
  f.onPrepare(async()=>{f.patch({mac:{...f.lease,leaseId:"replacement-fake-lease"}});});
  const result=await f.definition.create(f.args);
  assert.equal(result.status,"failed");assert.match(result.message!,/recovery enrollment refused/);
  assert.ok(!f.calls.includes("bootstrap"));
  assert.equal((await f.definition.reconcileCleanup({key:f.key})).status,"removed");
  assert.ok(!f.calls.some(call=>["create","resume","delete","credential-cleanup"].includes(call)));
});

for(const scenario of ["changed lease","expired release","changed schedule"] as const) test(`recovery refuses ${scenario} between bootstrap commands on create and resume`,async()=>{
  for(const mode of ["create","resume"] as const){
    const f=fixture();
    const resource=mode==="resume" ? (await f.definition.create(f.args)).resource : undefined;
    f.onBootstrap(async executor=>{
      const request={command:["true"],stdin:"",timeoutMs:1000,signal:f.signal,onOutput() {}};
      await executor.exec(request);
      if(scenario==="changed lease")f.patch({mac:{...f.lease,leaseId:"replacement-fake-lease"}});
      if(scenario==="expired release")f.patch({scheduledReleaseAt:new Date(Date.now()-1000).toISOString()});
      if(scenario==="changed schedule")f.patch({scheduledReleaseAt:new Date(Date.now()+3600_000).toISOString()});
      await executor.exec(request);
    });
    if(mode==="create"){
      const result=await f.definition.create(f.args);
      assert.equal(result.status,"failed");assert.match(result.message!,/recovery enrollment refused/);
    }else await assert.rejects(f.definition.resume({resource,signal:f.signal,report:f.report}),/recovery enrollment refused/);
    assert.equal(f.calls.filter(call=>call==="exec").length,1,"the second command never reaches the changed allocation");
    assert.equal((await f.definition.reconcileCleanup({key:f.key})).status,"removed");
    assert.ok(!f.calls.some(call=>["create","resume","delete","credential-cleanup"].includes(call)));
  }
});
