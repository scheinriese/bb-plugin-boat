import { randomUUID } from "node:crypto";
import type { PluginInteractionRequest, PluginInteractionResult } from "@get-bb/plugin-sdk";
import { MERGE_RENDERER_ID, mergeChoiceSchema, type PullRequestFacts } from "../contract-merge.ts";
import { reviewState } from "./board.ts";
import { TaskError } from "./service.ts";
import type { Task } from "./store.ts";

export function mergeGeneration(task: Task): string {
  return JSON.stringify([task.id, task.status, task.turns, task.promptId, task.finishedAt, task.threadId, task.sandboxId,
    task.role, task.delivery, task.repo, task.prUrl, task.branch, task.baseBranch, task.readyAt]);
}
export function assertMergeableTask(task: Task): void {
  if (task.delivery !== "pr" || task.role === "review" || !task.prUrl || !task.repo) throw new TaskError("This task has no pull request to merge.", "not_mergeable");
  if (task.status !== "idle") throw new TaskError("Wait for the task to finish before merging its pull request.", "task_running");
}
export function assertMergeable(facts: PullRequestFacts): void {
  if (facts.state !== "OPEN" || facts.draft || facts.mergeable !== "MERGEABLE" || facts.mergeState !== "CLEAN" || facts.mergeMethod === null || facts.checksTruncated ||
    ["CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(facts.reviewDecision) || facts.checks.some((check) => !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.state))) {
    throw new TaskError("This pull request isn't ready to merge. Check its reviews, checks and branch rules on GitHub, then try again.", "merge_blocked");
  }
}
export interface MergeInteractionDeps {
  getTask(id: string): Task;
  latestReview(id: string): string | null;
  facts(task: Task, signal: AbortSignal): Promise<PullRequestFacts>;
  requestInput(request: PluginInteractionRequest, options: { signal: AbortSignal }): Promise<PluginInteractionResult>;
  merge(id: string, facts: PullRequestFacts, signal: AbortSignal, guard: (task: Task) => Promise<void>): Promise<void>;
  record(id: string, kind: string, text: string): void;
  changed(): void;
  report(threadId: string, text: string): Promise<void>;
}
export function createMergeInteractions(deps: MergeInteractionDeps) {
  const active = new Map<string, { requestId: string; threadId: string; done: Promise<void> }>();
  const lifecycle = new AbortController();
  const stale = () => { throw new TaskError("The work or pull request changed while this confirmation was open. Check the latest changes and request merging again.", "merge_approval_stale"); };
  async function run(task: Task, requestId: string, threadId: string) {
    const signal = lifecycle.signal;
    const generation = mergeGeneration(task);
    const review = deps.latestReview(task.id);
    if (["changes-requested", "outdated", "reviewing"].includes(reviewState(review) ?? "")) throw new TaskError("Finish the task's review before merging its pull request.", "merge_blocked");
    const facts = await deps.facts(task, signal);
    if (signal.aborted) return;
    assertMergeable(facts);
    if (facts.headBranch !== task.branch || facts.baseBranch !== task.baseBranch) throw new TaskError("The pull request branches no longer match this task.", "merge_approval_stale");
    if (mergeGeneration(deps.getTask(task.id)) !== generation) stale();
    const answer = await deps.requestInput({ threadId, rendererId: MERGE_RENDERER_ID, title: `Merge PR #${facts.number}?`,
      payload: { requestId, taskId: task.id, title: task.title, facts }, timeoutMs: 10 * 60_000,
      presentation: { label: { pending: `Merge PR #${facts.number}?`, completed: "Merge choice received" }, icon: { glyph: "GitMerge" } },
      describeSubmission(value) { const choice = mergeChoiceSchema.safeParse(value); return { title: choice.success && choice.data.requestId === requestId ? choice.data.choice === "merge" ? `Requested merge of PR #${facts.number}` : "Not yet" : "Merge choice rejected" }; },
    }, { signal });
    if (signal.aborted) return;
    if (answer.outcome === "cancelled") { deps.record(task.id, "merge-cancelled", "Merge confirmation cancelled; no pull request merged"); return; }
    const parsed = mergeChoiceSchema.safeParse(answer.value);
    if (!parsed.success || parsed.data.requestId !== requestId) throw new TaskError("Merge choice was invalid. Request merging again.", "merge_choice_invalid");
    if (parsed.data.choice === "not-yet") { deps.record(task.id, "merge-deferred", `Not yet; no pull request merged${parsed.data.note ? `\nNote: ${parsed.data.note}` : ""}`); return; }
    await deps.merge(task.id, facts, signal, async (current) => {
      if (signal.aborted) throw new TaskError("Merge confirmation was cancelled.", "merge_cancelled");
      assertMergeableTask(current);
      if (mergeGeneration(current) !== generation || deps.latestReview(task.id) !== review) stale();
      const now = await deps.facts(current, signal);
      assertMergeable(now);
      // Base movement, checks, branch rules and review changes also require a fresh confirmation.
      if (JSON.stringify(now) !== JSON.stringify(facts) || mergeGeneration(deps.getTask(task.id)) !== generation || deps.latestReview(task.id) !== review) stale();
      if (signal.aborted) throw new TaskError("Merge confirmation was cancelled.", "merge_cancelled");
    });
    if (parsed.data.note) deps.record(task.id, "merge-note", parsed.data.note);
  }
  return {
    request(input: { id: string; from?: "chat" | "page" }) {
      if (lifecycle.signal.aborted) throw new TaskError("Merging is unavailable while the plugin reloads.", "merge_cancelled");
      const task = deps.getTask(input.id);
      const existing = active.get(task.id);
      if (existing) return { pending: true as const, requestId: existing.requestId, threadId: existing.threadId, duplicate: true };
      assertMergeableTask(task);
      const threadId = task.threadId ?? task.orchestratorThreadId;
      if (!threadId) throw new TaskError("Open a task chat before requesting a merge.", "merge_thread_required");
      const requestId = randomUUID();
      const entry = { requestId, threadId, done: Promise.resolve() };
      active.set(task.id, entry);
      entry.done = Promise.resolve().then(() => run(task, requestId, threadId)).catch(async (error: unknown) => {
        if (lifecycle.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Couldn't merge. Request merging again.";
        deps.record(task.id, "merge-request-failed", message);
        await deps.report(threadId, `[boat] Merge stopped: ${message}`).catch(() => undefined);
      }).finally(() => { active.delete(task.id); deps.changed(); });
      deps.changed();
      return { pending: true as const, requestId, threadId, duplicate: false };
    },
    async settled() { await Promise.all([...active.values()].map((entry) => entry.done)); },
    dispose() { lifecycle.abort(); },
  };
}
