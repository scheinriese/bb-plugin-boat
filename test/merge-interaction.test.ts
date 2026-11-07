import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createMergeInteractions } from "../src/merge-interaction.ts";
import type { Task } from "../src/store.ts";
import type { PullRequestFacts } from "../contract-merge.ts";
import { makeService } from "./fakes.ts";

export const factsFixture = (): PullRequestFacts => ({ repo: "demo/storefront", number: 482, url: "https://github.com/demo/storefront/pull/482", title: "Cart drawer",
  head: "1".repeat(40), base: "2".repeat(40), headBranch: "boat/cart", baseBranch: "main", additions: 214, deletions: 61, commits: 6,
  state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeState: "CLEAN", reviewDecision: "APPROVED", checks: [{ name: "148 tests pass", state: "SUCCESS", url: null }], checksTruncated: false, mergeMethod: "merge" });
function fixture() {
  const { bb, harness } = createFakePluginHost({ pluginId: "boat" });
  let task = { id: "t_cart", title: "Cart drawer", status: "idle", role: "implement", delivery: "pr", repo: "demo/storefront", prUrl: "https://github.com/demo/storefront/pull/482",
    branch: "boat/cart", baseBranch: "main", turns: 1, threadId: "thr_task", sandboxId: "bx_fake", readyAt: "2026-11-07T00:00:00Z" } as Task;
  let facts = factsFixture();
  let review = "Review t_review: approve";
  let merged = 0;
  let wait: Promise<void> | null = null;
  let before: (() => void) | null = null;
  const events: { kind: string; text: string }[] = [];
  const controller = createMergeInteractions({ getTask: () => task, latestReview: () => review,
    facts: async () => { if (wait) await wait; return structuredClone(facts); },
    requestInput: (request, options) => bb.ui.requestInput(request, options),
    merge: async (_id, _facts, _signal, guard) => { before?.(); await guard(task); merged++; },
    record: (_id, kind, text) => { events.push({ kind, text }); }, report: async () => {}, changed: () => {},
  });
  return { controller, harness, events, get merged() { return merged; },
    get task() { return task; }, set task(t: Task) { task = t; }, get facts() { return facts; }, set facts(f: PullRequestFacts) { facts = f; },
    set review(value: string) { review = value; }, set wait(value: Promise<void>) { wait = value; }, set before(value: () => void) { before = value; },
    async pending() { await new Promise<void>((resolve) => setImmediate(resolve)); return harness.inspection.pendingInteractions[0]!; },
    async answer(value: unknown) { const pending = await this.pending(); harness.behavior.submitInteraction(pending.id, value as never); await controller.settled(); },
  };
}
test("merge RPC controller returns promptly, deduplicates and cancels without merging", async (t) => {
  const f = fixture(); t.after(() => f.harness.lifecycle.dispose());
  let release!: () => void; f.wait = new Promise((resolve) => { release = resolve; });
  const request = f.controller.request({ id: "t_cart", from: "page" });
  assert.equal(request.pending, true); assert.equal(request.threadId, "thr_task");
  assert.deepEqual(f.controller.request({ id: "t_cart" }), { ...request, duplicate: true });
  assert.equal(f.merged, 0); release();
  const pending = await f.pending(); assert.equal(pending.rendererId, "merge-pull-request");
  f.harness.behavior.cancelInteraction(pending.id); await f.controller.settled();
  assert.equal(f.merged, 0); assert.equal(f.events.at(-1)?.kind, "merge-cancelled");
});
test("only matching explicit merge choice grants approval, notes never do", async (t) => {
  for (const kind of ["merge", "not-yet", "note-only", "stale-id"]) {
    const f = fixture(); t.after(() => f.harness.lifecycle.dispose()); const request = f.controller.request({ id: "t_cart" });
    await f.answer(kind === "note-only" ? { note: "merge approved" } : { requestId: kind === "stale-id" ? "old" : request.requestId, choice: kind === "not-yet" ? "not-yet" : "merge", note: "merge approved" });
    assert.equal(f.merged, kind === "merge" ? 1 : 0, kind);
  }
});
test("task, HEAD, base, branches, reviews and checks changed after confirmation fail closed", async (t) => {
  const cases: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => { f.task = { ...f.task, turns: 2 }; }, (f) => { f.task = { ...f.task, sandboxId: "bx_other" }; },
    (f) => { f.facts = { ...f.facts, head: "3".repeat(40) }; }, (f) => { f.facts = { ...f.facts, base: "4".repeat(40) }; },
    (f) => { f.facts = { ...f.facts, baseBranch: "release" }; }, (f) => { f.review = "new local review"; },
    (f) => { f.facts = { ...f.facts, reviewDecision: "CHANGES_REQUESTED" }; }, (f) => { f.facts = { ...f.facts, checks: [{ name: "Tests", state: "FAILURE", url: null }] }; },
  ];
  for (const change of cases) {
    const f = fixture(); t.after(() => f.harness.lifecycle.dispose()); const request = f.controller.request({ id: "t_cart" });
    await f.pending(); f.before = () => change(f);
    await f.answer({ requestId: request.requestId, choice: "merge", note: "" });
    assert.equal(f.merged, 0); assert.equal(f.events.at(-1)?.kind, "merge-request-failed");
  }
});
test("blocked/draft/unknown/truncated checks cannot even open a confirmation", async (t) => {
  for (const patch of [{ draft: true }, { state: "MERGED" }, { mergeState: "BLOCKED" }, { mergeable: "UNKNOWN" }, { checksTruncated: true }, { mergeMethod: null }, { checks: [{ name: "Tests", state: "IN_PROGRESS", url: null }] }]) {
    const f = fixture(); t.after(() => f.harness.lifecycle.dispose()); f.facts = { ...f.facts, ...patch } as PullRequestFacts;
    f.controller.request({ id: "t_cart" }); await f.controller.settled(); assert.equal(f.harness.inspection.pendingInteractions.length, 0); assert.equal(f.merged, 0);
  }
});
test("reload cancels pending merge, and later requests fail", async (t) => {
  const f = fixture(); t.after(() => f.harness.lifecycle.dispose()); f.controller.request({ id: "t_cart" }); await f.pending();
  f.controller.dispose(); await f.controller.settled(); assert.equal(f.merged, 0); assert.throws(() => f.controller.request({ id: "t_cart" }), /reloads/);
});
test("real service merge claim retains sandbox, rejects running work, releases on failure", async () => {
  const env = makeService();
  const { task } = await env.service.launchTask({ title: "Cart", role: "implement", brief: "Demo", repo: "demo/storefront" }, 5_000);
  env.boat.finish(task.conversationId!, "Done"); await env.service.sweep();
  env.store.update(task.id, { status: "idle", delivery: "pr", prUrl: "https://github.com/demo/storefront/pull/482" });
  await assert.rejects(() => env.service.withMergeClaim(task.id, async (current) => { assert.equal(env.service.holdsSandbox(current.sandboxId!), true); throw new Error("demo failure"); }), /demo failure/);
  assert.equal(env.service.holdsSandbox(task.sandboxId!), false); assert.equal(env.store.get(task.id)?.status, "idle");
  env.store.update(task.id, { status: "running" }); await assert.rejects(() => env.service.withMergeClaim(task.id, async () => {}), /ready before merging/);
  assert.ok(!env.boat.calls.some((call) => call.startsWith("delete ")));
});
