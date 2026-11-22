import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { SandboxDto, TaskDto } from "../contract.ts";
import { pendingTaskSample } from "./fixtures/pending-task-data.ts";

const temporary = mkdtempSync(join(process.cwd(), ".provider-polish-"));
after(() => rmSync(temporary, {recursive:true,force:true}));
const shim = resolve("test/fixtures/sandbox-failure-sdk.tsx");
await build({
  entryPoints:["test/fixtures/sandbox-failure-render.tsx"], outfile:join(temporary,"render.mjs"),
  bundle:true, jsx:"automatic", platform:"node", format:"esm", packages:"external", logLevel:"silent",
  plugins:[{name:"render-only-host",setup(builder) {
    builder.onResolve({filter:/^@get-bb\/plugin-sdk\/app$/}, args => args.importer === shim ? {path:args.path,external:true} : {path:shim});
  }}],
});
const { renderSandboxFailure } = await import(pathToFileURL(join(temporary,"render.mjs")).href) as {
  renderSandboxFailure(sandbox:SandboxDto,task:TaskDto):string;
};

function row(power: SandboxDto["power"], reason: string | null, legacy = false) {
  const task: TaskDto = {...pendingTaskSample,id:"t_fake_failure",title:"Synthetic task",sandboxId:"bx_fake_failure",macRentalPending:false,
    status:reason ? "failed" : "idle",error:legacy ? reason : null,
    publicStatus:legacy ? undefined : {status:reason ? "broken" : "stopped",label:reason ? "Broken" : "Stopped",reason,needsYou:false,tone:reason ? "danger" : "neutral",moving:false}};
  const sandbox: SandboxDto = {id:"bx_fake_failure",name:"Synthetic machine",state:power === "off" ? "stopped" : power === "on" ? "idle" : "error",power,
    health:"ok",url:null,createdAt:null,archiveAfter:null,machineType:"default",dashboardUrl:null,sshCommand:"",taskIds:[task.id],
    uses:[{kind:"task",id:task.id,title:task.title,open:true}],runsOn:{provider:"boat",label:"boat.dev",os:"linux",machine:"Default",note:null,detail:null}};
  const html = renderSandboxFailure(sandbox,task);
  const affected = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)?.find(row => row.includes(">Synthetic task</button>"));
  assert.ok(affected,"the actual SandboxTable renders the linked task row");
  return affected;
}

test("stopped guest retains recorded OOM beside guest power and existing recovery actions", () => {
  const html = row("off","Out of memory");
  assert.match(html,/Guest stopped/);
  assert.match(html,/Out of memory/);
  assert.match(html,/aria-label="Delete Synthetic task"/);
  assert.match(html,/aria-label="Resume Synthetic task"/);
});

test("unknown guest power retains its recorded failure without claiming it stopped", () => {
  const html = row("unknown","Worker process exited unexpectedly");
  assert.match(html,/Guest power unknown/);
  assert.match(html,/Worker process exited unexpectedly/);
  assert.doesNotMatch(html,/Guest stopped/);
});

test("normal stopped guest remains understandable without an invented failure", () => {
  const html = row("off",null);
  assert.match(html,/Guest stopped/);
  assert.doesNotMatch(html,/Out of memory|Sandbox error|Worker process exited/);
  assert.match(html,/aria-label="Resume Synthetic task"/);
});

test("powered-on guest retains a legacy recorded failure as escaped text, independently of liveness", () => {
  const html = row("on","Worker <script>unsafe()</script> failed & stopped",true);
  assert.match(html,/Guest on/);
  assert.match(html,/Worker &lt;script&gt;unsafe\(\)&lt;\/script&gt; failed &amp; stopped/);
  assert.doesNotMatch(html,/<script>|Guest stopped/);
});
