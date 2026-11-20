import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeService } from "./fakes.ts";
import { toTaskDto } from "../src/rpc.ts";
import { taskDetailSchema, type TaskDetailDto } from "../contract.ts";
import type { OwnMacNotice } from "../contract-ownmac.ts";
import { closeTaskIsCancellation } from "../web/logic.ts";

const temporary = mkdtempSync(join(process.cwd(), ".pending-task-"));
after(() => rmSync(temporary, {recursive:true,force:true}));
const shim = resolve("test/fixtures/pending-task-sdk.tsx");
await build({entryPoints:["test/fixtures/pending-task-render.tsx"],outfile:join(temporary,"render.mjs"),bundle:true,jsx:"automatic",platform:"node",format:"esm",packages:"external",logLevel:"silent",loader:{".css":"empty"},plugins:[{name:"render-only-host",setup(builder){builder.onResolve({filter:/^@get-bb\/plugin-sdk\/app$/},args=>args.importer===shim?{path:args.path,external:true}:{path:shim});}}]});
const { renderPendingTask, renderLinkedRental } = await import(pathToFileURL(join(temporary,"render.mjs")).href) as {renderPendingTask(task:TaskDetailDto,notice:OwnMacNotice|null,panel?:boolean):string;renderLinkedRental(notice:OwnMacNotice,approving?:boolean,error?:string):string};

async function fixture() {
  const env = makeService();
  const original = await env.service.startTask({title:"Test the sample native app",role:"custom",brief:"Run the sample native checks.",repo:"acme/sample"});
  const task = taskDetailSchema.parse({...toTaskDto(original),status:"failed",phase:"waiting",macRentalPending:true,turns:0,sandboxId:null,threadId:null,conversationId:null,branch:"boat/fake-pending-branch",finishedAt:original.createdAt,
    publicStatus:{...env.service.publicStatus(original),status:"needs-you",label:"Waiting for your choice",needsYou:true},brief:original.brief,result:null,events:[],dashboardUrl:null,memory:null,shipApproval:null});
  const quote = {id:"fake-scaleway",provider:"scaleway",label:"Scaleway",model:"fake-m4",modelLabel:"Mac mini M4",minimumCost:5.28,minimumHours:24,hourPrice:.22,currency:"EUR",expiresAt:"2099-01-01T00:00:00Z"};
  const notice:OwnMacNotice = {taskId:task.id,title:task.title,alias:"",reason:"unavailable",offer:quote,offers:[quote],recommendedQuoteId:quote.id,recommendationReason:"Project preference: Scaleway.",canWaitForOwnMac:false};
  return {env,original,task,notice};
}
for (const panel of [false,true]) test(`${panel?"side panel":"task detail"} leads with actionable rental choices and explains its pending metadata`,async()=>{
  const {task,notice}=await fixture();
  const html=renderPendingTask(task,notice,panel);
  assert.ok(html.indexOf("Scaleway") < html.indexOf("Repository"),"choice appears before metadata");
  assert.match(html,/Waiting for your choice/);
  assert.match(html,/Not started/);
  assert.match(html,/Queued/);
  assert.match(html,/Cancel task/);
  assert.match(html,/The branch, task chat and pull request will appear after the task starts/);
  assert.doesNotMatch(html,/boat\/fake-pending-branch|Request review|Close task|never reached|finished |Committed change|>0 turns</);
  assert.doesNotMatch(html,/<dt[^>]*>[\s\S]*?(?:Pull request|Sandbox|Chat)<\/dt>/);
  assert.match(html,/Run the sample native checks/);
});
test("cancelling a pending rental uses cancellation semantics and leaves no completed task",async()=>{
  const {env,original,task}=await fixture();
  assert.equal(closeTaskIsCancellation(task),true);
  assert.equal(closeTaskIsCancellation({...task,macRentalPending:false,status:"idle"}),false);
  env.store.update(original.id,{status:"failed",sandboxId:null,turns:0});
  const result=await env.service.closeTask(original.id,{status:closeTaskIsCancellation(task)?"cancelled":"done"});
  assert.equal(result.task.status,"cancelled");
});

for (const panel of [false, true]) test(`${panel ? "side panel" : "task detail"} removes rental controls after cancellation`, async () => {
  const {task} = await fixture();
  const cancelled: TaskDetailDto = {...task,status:"cancelled",phase:"cancelled",macRentalPending:false,publicStatus:{status:"stopped",label:"Stopped",tone:"neutral",reason:null,needsYou:false,moving:false}};
  const html = renderPendingTask(cancelled, null, panel);
  assert.match(html, /Stopped/);
  assert.doesNotMatch(html, /Mac rental choice|Keep it queued|Wait for your Mac|Rent Scaleway Mac|Cancel task|Request review/);
});

for (const answer of ["rent","failed"] as const) test(`consumed ${answer} approval follows a failed linked task even while the original mutation is pending`, async()=>{
  const {notice}=await fixture();
  const linked:OwnMacNotice={...notice,answer,replacementId:"t_fake_linked",linkedTask:{taskId:"t_fake_linked",status:"failed",turns:0,error:"Instabox did not report the Mac lease; work cannot safely start.",machineId:"instabox_fake_allocated",lease:{provider:"instabox",model:"m2",minimumCost:10.8,hourPrice:.45,currency:"USD",paidUntil:"2030-01-02T12:00:00Z",releaseAt:"2030-01-02T12:00:00Z",endedAt:null}}};
  const html=renderLinkedRental(linked,true);
  for (const words of ["App task did not start","Approval received","Mac allocated","instabox_fake_allocated","did not report the Mac lease","Minimum committed","$10.80","Paid until","Scheduled for","Open existing task","View machine in Sandboxes","same Mac","No second rental is approved","Rental start progress","0 worker turns","Lease terms recorded","Recover on this Mac"]) assert.ok(html.includes(words),words);
  assert.match(html,/dateTime="2030-01-02T12:00:00Z"/i);
  assert.doesNotMatch(html,/Starting rental|Starting the task|Rent Scaleway Mac|Rent Instabox Mac|disabled=/);
});
test("linked allocation uncertainty is explicit without another rent action",async()=>{
  const {notice}=await fixture();
  const html=renderLinkedRental({...notice,answer:"rent",replacementId:"t_fake_missing"});
  assert.match(html,/task status unavailable/);
  assert.match(html,/Mac allocation unconfirmed/);
  assert.match(html,/rental may already be billing/);
  assert.doesNotMatch(html,/Starting rental|Rent Scaleway Mac/);
});

test("same-Mac recovery refusals remain visible on the consumed approval and cancelled tasks cannot recover",async()=>{
  const {notice}=await fixture();
  const linked:OwnMacNotice={...notice,answer:"failed",replacementId:"t_fake_linked",linkedTask:{taskId:"t_fake_linked",status:"failed",turns:0,machineId:"instabox_fake_allocated",error:"Lease admission failed"}};
  const html=renderLinkedRental(linked,false,"Recovery refused: the physical lease changed. No rental was started.");
  assert.match(html,/Recovery refused: the physical lease changed/);
  assert.doesNotMatch(html,/Rent Scaleway Mac|Starting rental/);
  const cancelled=renderLinkedRental({...linked,linkedTask:{...linked.linkedTask!,status:"cancelled"}});
  assert.doesNotMatch(cancelled,/Recover on this Mac/);
});
