import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerStartQueueRpc } from "../src/start-queue-rpc.ts";
import type { Runtime } from "../src/runtime.ts";
import { makeService } from "./fakes.ts";

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
  assert.equal(cleared.status,before.status);
  assert.equal(cleared.promptId,before.promptId);
  assert.equal(env.boat.calls.length,calls);
  assert.equal(env.store.get(other.id)!.claudePaidContinuationRevoked,false);
  assert.deepEqual(await harness.callRpc("revokeClaudePaidContinuation",{id:other.id}),{ok:true});
  assert.equal(env.store.get(other.id)!.claudePaidContinuationRevoked,false,"unapproved work is not pinned or changed by revoke");
  assert.ok(env.store.latestEvent(approved.id,"design-routing-normal"));
});
