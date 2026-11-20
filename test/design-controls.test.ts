import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { toTaskDto } from "../src/rpc.ts";
import { taskSchema, type TaskDto } from "../contract.ts";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerStartQueueRpc } from "../src/start-queue-rpc.ts";
import type { Runtime } from "../src/runtime.ts";
import { makeService } from "./fakes.ts";

const temporary = mkdtempSync(join(process.cwd(), ".design-controls-"));
after(() => rmSync(temporary, { recursive: true, force: true }));
const shim = resolve("test/fixtures/design-control-sdk.ts");
await build({
  entryPoints: ["test/fixtures/design-control-render.tsx"], outfile: join(temporary, "render.mjs"),
  bundle: true, jsx: "automatic", platform: "node", format: "esm", packages: "external", logLevel: "silent",
  plugins: [{ name: "render-only-host", setup(builder) {
    builder.onResolve({ filter: /^@get-bb\/plugin-sdk\/app$/ }, args => args.importer === shim ? { path: args.path, external: true } : { path: shim });
  } }],
});
const { renderTaskControl, renderRoutingControl } = await import(pathToFileURL(join(temporary, "render.mjs")).href) as { renderTaskControl(task: TaskDto): string; renderRoutingControl(props: {retained:boolean; closed?:boolean; busy?:boolean; onClear(): void}): string };

// Fake headless provider only: no real rentals, credentials, settings or paid calls.
test("owner controls clear one task preference/permission without interrupting it or changing unrelated tasks", async t => {
  const env = makeService();
  const { bb, harness } = createFakePluginHost({pluginId:"boat"});
  t.after(()=>harness.lifecycle.dispose());
  registerStartQueueRpc({ bb, service:env.service, startQueue:{}, launchWaitMs:0, changed(){} } as unknown as Runtime);
  const input = { title:"Fake design",role:"custom" as const,brief:"Inspect fake styles.",repo:null };
  const approved = (await env.service.launchTask(input,5000)).task;
  const other = (await env.service.launchTask({...input,title:"Unrelated fake work"},5000)).task;
  env.store.update(approved.id,{purpose:"design",designClaudePreference:true,claudePaidContinuation:true});
  const before=env.store.get(approved.id)!;
  const calls=env.boat.calls.length;
  assert.deepEqual(await harness.callRpc("clearDesignClaudePreference",{id:approved.id}),{ok:true});
  const cleared=env.store.get(approved.id)!;
  assert.equal(cleared.designClaudePreference,false);
  assert.equal(cleared.claudePaidContinuation,false);
  assert.equal(cleared.claudePaidContinuationRevoked,true);
  assert.equal(cleared.claudeNormalRouting,true);
  assert.equal(cleared.status,before.status);
  assert.equal(cleared.promptId,before.promptId);
  assert.equal(env.boat.calls.length,calls);
  assert.equal(env.store.get(other.id)!.claudePaidContinuationRevoked,false);
  assert.deepEqual(await harness.callRpc("revokeClaudePaidContinuation",{id:other.id}),{ok:true});
  assert.equal(env.store.get(other.id)!.claudePaidContinuationRevoked,false,"unapproved work is not pinned or changed by revoke");
  assert.ok(env.store.latestEvent(approved.id,"design-routing-normal"));
});


for (const purpose of [null, "design"] as const) test(`revoked ${purpose ?? "custom"} tasks without a saved design preference expose routing release and its persisted state`, async t => {
  const env = makeService();
  const { bb, harness } = createFakePluginHost({pluginId:"boat"});
  t.after(()=>harness.lifecycle.dispose());
  registerStartQueueRpc({ bb, service:env.service, startQueue:{}, launchWaitMs:0, changed(){} } as unknown as Runtime);
  const task = (await env.service.launchTask({title:"Fake custom exploration",role:"custom",brief:"Inspect fake spacing.",repo:null},5000)).task;
  env.store.update(task.id,{purpose,claudePaidContinuation:true});
  await harness.callRpc("revokeClaudePaidContinuation",{id:task.id});
  const revoked = env.store.get(task.id)!;
  assert.equal(revoked.purpose,purpose);
  assert.equal(revoked.designClaudePreference,false);
  const html = renderTaskControl(toTaskDto(revoked));
  assert.match(html,/Claude paid continuation revoked/);
  assert.match(html,/Return to normal routing/);
  assert.match(html,/Claude routing retained/);
  assert.equal((html.match(/Return to normal routing/g) ?? []).length,1);
  assert.doesNotMatch(html,/Revoke Claude paid continuation<\/button>/);
  const calls = env.boat.calls.length;
  assert.deepEqual(await harness.callRpc("clearDesignClaudePreference",{id:task.id}),{ok:true});
  const reloaded = makeService({reuse:{store:env.store,boat:env.boat}});
  const released = reloaded.store.get(task.id)!;
  assert.equal(released.claudeNormalRouting,true);
  assert.equal(released.claudePaidContinuation,false);
  assert.equal(released.claudePaidContinuationRevoked,true,"routing release does not restore payment permission");
  assert.equal(released.status,revoked.status);
  assert.equal(released.promptId,revoked.promptId);
  assert.equal(env.boat.calls.length,calls,"the action does not interrupt or send work");
  const releasedDto = taskSchema.parse(toTaskDto(released));
  assert.equal(releasedDto.claudeNormalRouting,true,"the native task DTO preserves the routing release");
  const releasedHtml = renderTaskControl(releasedDto);
  assert.match(releasedHtml,/Normal routing restored/);
  assert.match(releasedHtml,/Claude paid continuation revoked/);
  assert.doesNotMatch(releasedHtml,/Return to normal routing/);
});

test("the shared routing control reports state and disables release while busy or closed", () => {
  const busy = renderRoutingControl({retained:true,busy:true,onClear(){}});
  assert.match(busy,/Claude routing retained/);
  assert.match(busy,/<button[^>]*disabled[^>]*>Return to normal routing<\/button>/);
  const closed = renderRoutingControl({retained:true,closed:true,onClear(){}});
  assert.match(closed,/Closed tasks do not continue automatically/);
  assert.doesNotMatch(closed,/Return to normal routing/);
  const released = renderRoutingControl({retained:false,onClear(){}});
  assert.match(released,/Normal routing restored/);
  assert.match(released,/Revoked paid continuation and automatic paid recovery stay disabled/);
  assert.doesNotMatch(released,/Return to normal routing/);
});

test("active custom consent exposes routing release separately from payment revocation", async () => {
  const env = makeService();
  const task = (await env.service.launchTask({title:"Fake active scope",role:"custom",brief:"Inspect fake layout.",repo:null},5000)).task;
  env.store.update(task.id,{claudePaidContinuation:true});
  const html = renderTaskControl(toTaskDto(env.store.get(task.id)!));
  assert.match(html,/Claude routing retained/);
  assert.match(html,/Return to normal routing/);
  assert.match(html,/Revoke Claude paid continuation/);
});
