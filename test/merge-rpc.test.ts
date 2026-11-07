import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { makeService } from "./fakes.ts";
import { registerMergeRpc } from "../src/merge.ts";
import type { Runtime } from "../src/runtime.ts";

for (const state of ["MERGED", "QUEUED", "UNKNOWN"] as const) test(`confirmed merge RPC records ${state.toLowerCase()} accurately and retains sandbox`, async (t) => {
  const env = makeService(); const { bb, harness } = createFakePluginHost({ pluginId: "boat" });
  const dir = mkdtempSync(join(tmpdir(), "boat-merge-rpc-")); const fake = join(dir, "gh"); const count = join(dir, "count");
  const before = process.env.BOAT_PLUGIN_GH;
  const pr = { number: 482, url: "https://github.com/demo/storefront/pull/482", title: "Cart drawer", headRefOid: "1".repeat(40), baseRefOid: "2".repeat(40), headRefName: "boat/cart", baseRefName: "main", additions: 214, deletions: 61, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", commits: { totalCount: 6, nodes: [] } };
  writeFileSync(fake, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='api'){const path=${JSON.stringify(count)};const n=fs.existsSync(path)?Number(fs.readFileSync(path))+1:1;fs.writeFileSync(path,String(n));if(n>=3&&${JSON.stringify(state)}==='UNKNOWN')process.exit(1);const pr=${JSON.stringify(pr)};if(n>=3&&${JSON.stringify(state)}==='MERGED')pr.state='MERGED';process.stdout.write(JSON.stringify({data:{repository:{mergeCommitAllowed:true,pullRequest:pr}}}));}`, { mode: 0o700 });
  process.env.BOAT_PLUGIN_GH = fake;
  t.after(async () => { await harness.lifecycle.dispose(); if (before === undefined) delete process.env.BOAT_PLUGIN_GH; else process.env.BOAT_PLUGIN_GH = before; rmSync(dir, { recursive: true, force: true }); });
  const { task } = await env.service.launchTask({ title: "Cart", role: "implement", brief: "Demo", repo: "demo/storefront", orchestratorThreadId: "thr_parent" }, 5_000);
  env.boat.finish(task.conversationId!, "Done"); await env.service.sweep();
  env.store.update(task.id, { status: "idle", delivery: "pr", prUrl: pr.url, threadId: "thr_task", branch: "boat/cart", baseBranch: "main" });
  registerMergeRpc({ bb, service: env.service, changed() {}, tellOrchestrator: async () => {} } as unknown as Runtime);
  const request = await harness.behavior.callRpc("requestMerge", { id: task.id }) as { requestId: string; pending: boolean };
  assert.equal(request.pending, true);
  async function until(check: () => boolean) { const until = Date.now() + 5_000; while (!check()) { if (Date.now() > until) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 5)); } }
  await until(() => harness.inspection.pendingInteractions.length === 1);
  harness.behavior.submitInteraction(harness.inspection.pendingInteractions[0].id, { requestId: request.requestId, choice: "merge", note: "Reviewed" });
  const event = state === "MERGED" ? "merged" : state === "QUEUED" ? "merge-queued" : "merge-request-failed";
  await until(() => env.store.latestEvent(task.id, event) !== null && !env.service.holdsSandbox(task.sandboxId!));
  assert.equal(env.store.get(task.id)?.status, state === "MERGED" ? "done" : "idle");
  assert.equal(env.store.latestEvent(task.id, "merged") !== null, state === "MERGED");
  assert.ok(env.store.latestEvent(task.id, "merge-submitted"));
  assert.ok(!env.boat.calls.some((call) => call.startsWith("delete "))); assert.equal(env.boat.ships.length, 0);
  if (state === "UNKNOWN") assert.match(env.store.latestEvent(task.id, event)!.text, /final status couldn't be verified/);
});
