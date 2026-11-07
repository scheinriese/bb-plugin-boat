import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import type Database from "better-sqlite3";
import {createFakePluginHost} from "@get-bb/plugin-sdk/testing";
import {TaskStore, type Provider, type TaskStatus} from "../src/store.ts";
import {BoatService} from "../src/service.ts";
import type {BoatApi} from "../src/boat-api.ts";
import {StartQueueStore} from "../src/start-queue-store.ts";
import {createStartQueue} from "../src/start-queue.ts";
import {fidelityHandlers} from "../src/rpc-fidelity.ts";
import {sidebarState} from "../src/sidebar.ts";
import {sidebarRpcMethods} from "../contract-sidebar.ts";
import {FakeBoat,defaultSettings} from "./fakes.ts";

function setup(){
 const db=new DatabaseSync(":memory:");for(const sql of TaskStore.migrations())db.exec(sql);
 const database=()=>db as unknown as Database.Database;
 const store=new TaskStore(database), queued=new StartQueueStore(database),boat=new FakeBoat();
 const host=createFakePluginHost({pluginId:"boat"});host.bb.storage.database=database;
 host.harness.sdk.stub("threads.queue.list",async()=>[]);
 host.harness.sdk.stub("threads.get",async({threadId}:{threadId:string})=>({id:threadId,archivedAt:null,deletedAt:null}));
 const lifecycle=new AbortController();
 const service=new BoatService(boat as unknown as BoatApi,store,{settings:async()=>defaultSettings(),lifecycle:lifecycle.signal,changed(){},notify:async()=>{},log:{info(){},warn(){}}});
 const queue=createStartQueue({bb:host.bb,service,store:queued,changed(){},wake(){}});
 const handlers=fidelityHandlers({bb:host.bb,service,startQueue:queue});
 const enqueue=(title:string,provider?:Provider)=>queued.enqueue({title,brief:"Private implementation instructions must not be published.",role:"implement",provider,repo:"acme/storefront",orchestratorThreadId:"thr_source"},null,"Internal queue receipt", "2026-11-08T16:00:00Z");
 const task=(id:string,status:TaskStatus,threadId:string|null,provider:Provider="codex")=>db.prepare("insert into tasks(id,title,role,status,provider,brief,thread_id,created_at,updated_at) values(?,?,'implement',?,?,?,?,'2026-11-07T12:00:00Z','2026-11-07T12:00:00Z')").run(id,id,status,provider,"Private task brief",threadId);
 const attach=(id:string,taskId:string)=>db.prepare("update start_queue set state='started',revision=revision+1,task_id=? where id=?").run(taskId,id);
 const snapshot=()=>JSON.stringify({queue:db.prepare('select * from start_queue order by id').all(),tasks:db.prepare('select * from tasks order by id').all(),events:db.prepare('select * from task_events order by seq').all()});
 return {...host,db,store,queued,boat,service,queue,handlers,enqueue,task,attach,snapshot,async dispose(){lifecycle.abort();queue.dispose();await host.harness.lifecycle.dispose();db.close()}};
}

test("sidebar queue is additive, ordered, revisioned and publishes only display fields without writes",async t=>{
 const e=setup();t.after(()=>e.dispose());
 const a=e.enqueue("Second","claude"),b=e.enqueue("First");
 e.db.prepare("update start_queue set created_at='2026-11-07T10:00:00Z' where id=?").run(a.dto.id);
 e.db.prepare("update start_queue set created_at='2026-11-07T09:00:00Z' where id=?").run(b.dto.id);
 e.queued.transition(a.dto.id,0,["waiting"],"dispatching","Checking");
 const cancelled=e.enqueue("Cancelled");e.queued.transition(cancelled.dto.id,0,["waiting"],"cancelled","Cancelled");
 const failed=e.enqueue("Failed");e.queued.transition(failed.dto.id,0,["waiting"],"failed","Failed");
 const before=e.snapshot();const result=await e.handlers.sidebarState({version:1});
 assert.equal(sidebarRpcMethods.sidebarState.output.safeParse(sidebarState(e.service)).success,true,"older producer still validates without the optional field");
 assert.equal(sidebarRpcMethods.sidebarState.output.safeParse(result).success,true);
 assert.deepEqual(result.queuedStarts.map(q=>[q.title,q.state,q.provider]),[["First","waiting",null],["Second","dispatching","claude"]]);
 assert.deepEqual(Object.keys(result.queuedStarts[0]!).sort(),["createdAt","id","provider","resetsAt","revision","sourceThreadId","state","taskId","taskThreadId","title"].sort());
 assert.ok(result.queuedStarts.every(q=>q.sourceThreadId==="thr_source"&&q.taskId===null&&q.taskThreadId===null));
 assert.ok(!JSON.stringify(result).includes("Private"));assert.ok(!JSON.stringify(result).includes("Internal queue receipt"));
 assert.equal((await e.handlers.sidebarState({version:1})).revision,result.revision);
 e.queued.transition(b.dto.id,0,["waiting"],"cancelled","Cancelled");
 assert.notEqual((await e.handlers.sidebarState({version:1})).revision,result.revision);
 // Restore the one deliberate test mutation before checking producer read-only behavior.
 e.db.prepare("update start_queue set state='waiting',revision=0,updated_at=?,message=?,resets_at=? where id=?").run(b.dto.updatedAt,b.dto.message,b.dto.resetsAt,b.dto.id);
 assert.equal(e.snapshot(),before);assert.equal(e.boat.calls.length,0);
});

test("started queue association uses real open tasks and verified chats; headless has no invented thread",async t=>{
 const e=setup();t.after(()=>e.dispose());
 const live=e.enqueue("Has chat","claude"),headless=e.enqueue("Headless"),missing=e.enqueue("Missing chat"),closed=e.enqueue("Closed"),gone=e.enqueue("Missing task");
 e.task("t_live","running","thr_live");e.task("t_headless","idle",null);e.task("t_missing","running","thr_missing");e.task("t_closed","done","thr_closed");
 for(const [q,id] of [[live,"t_live"],[headless,"t_headless"],[missing,"t_missing"],[closed,"t_closed"],[gone,"t_gone"]] as const)e.attach(q.dto.id,id);
 e.harness.sdk.stub("threads.get",async({threadId}:{threadId:string})=>{if(threadId==="thr_missing")throw Error("Not found");return {id:threadId,archivedAt:null,deletedAt:null}});
 const before=e.snapshot();const result=await e.handlers.sidebarState({version:1});
 const rows=new Map(result.queuedStarts.map(row=>[row.id,row]));
 assert.equal(rows.size,3);assert.equal(rows.get(live.dto.id)!.taskThreadId,"thr_live");assert.equal(rows.get(live.dto.id)!.provider,"codex","actual started provider supersedes requested Claude");
 assert.equal(rows.get(headless.dto.id)!.taskId,"t_headless");assert.equal(rows.get(headless.dto.id)!.taskThreadId,null);
 assert.equal(rows.get(missing.dto.id)!.taskId,"t_missing");assert.equal(rows.get(missing.dto.id)!.taskThreadId,null);
 assert.equal(rows.has(closed.dto.id),false);assert.equal(rows.has(gone.dto.id),false);
 assert.equal(result.threads.filter(row=>row.threadId==="thr_live").length,1,"association does not manufacture a second normal thread");
 assert.equal(e.snapshot(),before);assert.equal(e.boat.calls.length,0);
});

test("pending rows and older open receipts survive recent closed receipts; output and SDK fanout stay bounded",async t=>{
 const e=setup();t.after(()=>e.dispose());
 const pending=e.enqueue("Old waiting","claude"),open=e.enqueue("Old open");e.task("t_old","running","thr_old");e.attach(open.dto.id,"t_old");
 e.db.prepare("update start_queue set created_at='2020-01-01T00:00:00Z' where id in (?,?)").run(pending.dto.id,open.dto.id);
 e.task("t_closed","done",null);
 for(let i=0;i<220;i++){const q=e.enqueue("Closed "+i);e.attach(q.dto.id,"t_closed")}
 let result=await e.handlers.sidebarState({version:1});assert.deepEqual(new Set(result.queuedStarts.map(q=>q.id)),new Set([pending.dto.id,open.dto.id]));
 let active=0,maxActive=0;
 e.harness.sdk.stub("threads.get",async({threadId}:{threadId:string})=>{active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,1));active--;return {id:threadId,archivedAt:null,deletedAt:null}});
 for(let i=0;i<205;i++){const q=e.enqueue("Open "+i);const id="t_open_"+i;e.task(id,"running","thr_open_"+i);e.attach(q.dto.id,id)}
 const before=e.snapshot();result=await e.handlers.sidebarState({version:1});
 assert.equal(result.queuedStarts.length,200);assert.equal(result.truncated,true);assert.ok(result.queuedStarts.some(q=>q.id===pending.dto.id));assert.ok(maxActive<=4);
 assert.deepEqual(result.queuedStarts.map(q=>q.createdAt),result.queuedStarts.map(q=>q.createdAt).sort());
 assert.equal(e.snapshot(),before);assert.equal(e.boat.calls.length,0);
});

test("unreadable queue data leaves legacy sidebar threads usable without publishing internal failures",async t=>{
 const e=setup();t.after(()=>e.dispose());e.task("t_one","idle","thr_one");const bad=e.enqueue("Corrupt");
 e.db.prepare("update start_queue set input='invalid-private-input' where id=?").run(bad.dto.id);
 const result=await e.handlers.sidebarState({version:1});assert.equal(result.queuedStarts.length,0);assert.equal(result.truncated,true);assert.ok(result.threads.some(row=>row.threadId==="thr_one"));assert.ok(!JSON.stringify(result).includes("invalid-private-input"));
});
