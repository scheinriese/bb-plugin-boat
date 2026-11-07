// Automatic policy for passively registered native chats. Core keeps its machine.
import { z } from "zod";
import { NATIVE_REVIEW_METADATA, nativeReviewStateSchema, reviewerSchema, type NativeReviewState } from "../contract-review.ts";
import type { PullRequestFacts } from "../contract-merge.ts";
import { getPullRequest, pullRequestNumber } from "./github.ts";
import { assertBranch } from "./boat-api.ts";
import { parseReport } from "./briefs.ts";
import { nativeReviewConfigSchema, nativeReviewSourceSchema, reviewGeneration, completedTurnKey, type NativeReviewSource } from "./review-policy.ts";
import { TaskError } from "./service.ts";
import type { Runtime } from "./runtime.ts";
import type { Task } from "./store.ts";

const attemptSchema = z.object({ version: z.literal(1), turnKey: z.string(), reviewTaskId: z.string().nullable() });
const read = <T>(text: string | undefined, schema: z.ZodType<T>): T | null => {
  if (!text) return null;
  try { const parsed = schema.safeParse(JSON.parse(text)); return parsed.success ? parsed.data : null; } catch { return null; }
};
const nativeTask = (task: Task, runtime: Runtime) => task.role === "implement" && task.runner === "chat" && !task.ownsSandbox && !!task.threadId && runtime.service.store.latestEvent(task.id, "native-chat") !== null;
const changed = () => new TaskError("The completed implementation or its pull request changed. Request a fresh review.", "review_source_changed");

function sourceFacts(task: Task, facts: PullRequestFacts): void {
  if (!task.repo || !task.prUrl || facts.repo.toLowerCase() !== task.repo.toLowerCase() || facts.number !== pullRequestNumber(task.repo, task.prUrl) || facts.number !== pullRequestNumber(task.repo, facts.url) || facts.state !== "OPEN" || facts.head === facts.base) throw changed();
  // A verified PR (including a fork) is explicit source, never a default-base checkout.
  assertBranch(facts.headBranch, "pull request branch"); assertBranch(facts.baseBranch, "pull request base");
}
function sameFacts(facts: PullRequestFacts, source: NativeReviewSource): boolean {
  return facts.head === source.head && facts.base === source.base && facts.headBranch === source.headBranch && facts.baseBranch === source.baseBranch;
}

export interface NativeReviews {
  afterThreadSync(threadId: string): Promise<void>;
  /** The existing monitor calls this after its normal service poll. No new timer. */
  tick(): Promise<void>;
}

export function registerNativeReviews(runtime: Runtime, options: { facts?: typeof getPullRequest } = {}): NativeReviews {
  const { bb, service } = runtime; const store = service.store;
  const factsFor = options.facts ?? getPullRequest;
  const lifecycle = new AbortController();
  const active = new Map<string, Promise<void>>();
  const pending = new Set<string>();
  const published = new Map<string, string>();
  const retryAfter = new Map<string, number>();
  bb.onDispose(() => { lifecycle.abort(); pending.clear(); });

  async function publish(task: Task, value: Omit<NativeReviewState, "version" | "taskId">): Promise<void> {
    if (lifecycle.signal.aborted || !task.threadId) return;
    const state = nativeReviewStateSchema.parse({ version: 1, taskId: task.id, ...value });
    const text = JSON.stringify(state);
    if (store.latestEvent(task.id, "native-review-state")?.text !== text) {
      store.addEvent(task.id, "native-review-state", text); runtime.changed();
    }
    if (published.get(task.id) === text) return;
    try {
      await bb.sdk.threads.updatePluginMetadata({ threadId: task.threadId, pluginId: bb.pluginId, set: { [NATIVE_REVIEW_METADATA]: state } });
      if (!lifecycle.signal.aborted) { published.set(task.id, text); if (published.size > 1024) published.delete(published.keys().next().value!); }
    } catch (error) { if (!lifecycle.signal.aborted) bb.log.warn(`native review metadata ${task.id}: ${String(error)}`); }
  }

  async function capturePolicy(task: Task): Promise<void> {
    if (store.latestEvent(task.id, "native-review-policy") || !task.hostId) return;
    // Legacy registrations are adopted only on a real thread event, not retroactively by tick.
    const resource = await bb.experimental_machines.getResource(task.hostId) as { sandboxId?: unknown; reviewer?: unknown } | null;
    if (lifecycle.signal.aborted || resource?.sandboxId !== task.sandboxId) return;
    const reviewer = reviewerSchema.safeParse(resource.reviewer);
    store.addEvent(task.id, "native-review-policy", JSON.stringify({ version: 1, machineReviewer: reviewer.success ? reviewer.data : null, valid: resource.reviewer == null || reviewer.success }));
  }

  function childFor(task: Task, turnKey: string, exceptId?: string): Task | null {
    const children = store.list({ parentTaskId: task.id, limit: 1000 }).filter((entry) => entry.role === "review" && entry.id !== exceptId);
    const bound = children.find((child) => read(store.latestEvent(child.id, "native-review-source")?.text, nativeReviewSourceSchema)?.turnKey === turnKey);
    if (bound) return bound;
    // A manually started review already covering this completion prevents duplicates.
    return children.find((child) => child.status === "starting" || child.status === "running" ||
      (!read(store.latestEvent(child.id, "native-review-source")?.text, nativeReviewSourceSchema) && !!task.finishedAt && child.createdAt >= task.finishedAt)) ?? null;
  }

  async function run(id: string): Promise<void> {
    const task = store.get(id);
    if (!task || !nativeTask(task, runtime) || lifecycle.signal.aborted || ["done", "cancelled"].includes(task.status)) return;
    const config = read(store.latestEvent(id, "native-review-policy")?.text, nativeReviewConfigSchema);
    if (!config) return;
    const policy = await service.reviewPolicy(task, config.machineReviewer);
    if (lifecycle.signal.aborted) return;
    const finished = store.latestEvent(id, "finished");
    const key = finished && task.finishedAt ? completedTurnKey(task, finished.at) : null;
    const state = { ...policy, turnKey: key, reviewTaskId: null as string | null };
    if (!config.valid) { await publish(task, { ...state, state: "failed", message: "The saved reviewer is invalid. Choose a valid reviewer for a new task, or request a manual review." }); return; }
    if (policy.reviewer === "none") { await publish(task, { ...state, state: "disabled", message: "Automatic review is off. You can still request a manual review." }); return; }
    if (task.status !== "idle" || !finished || !key || !/^Turn finished\b/.test(finished.text)) {
      await publish(task, { ...state, state: "waiting", message: "Waiting for a completed implementation turn." }); return;
    }
    const existing = childFor(task, key);
    if (existing) {
      const binding = read(store.latestEvent(existing.id, "native-review-source")?.text, nativeReviewSourceSchema);
      if (binding && binding.turnKey !== key) {
        await publish(task, { ...state, reviewTaskId: existing.id, state: "waiting", message: "An earlier review is still running. This new turn has not been reviewed yet." }); return;
      }
      const verdict = store.latestEvent(id, "review")?.text;
      const stale = verdict === `Review ${existing.id}: outdated`;
      const ended = ["idle", "done", "failed", "cancelled"].includes(existing.status);
      const reviewed = ended && !!parseReport(existing.result ?? "").verdict;
      await publish(task, { ...state, reviewTaskId: existing.id, state: stale ? "outdated" : reviewed ? "reviewed" : ended ? "failed" : "reviewing",
        message: stale ? "The implementation changed since this review. Request a fresh review." : reviewed ? `${existing.provider === "codex" ? "Codex" : "Claude"} reviewed this turn.` : ended ? "The review ended without a verified verdict. You can request a manual review." : `${existing.provider === "codex" ? "Codex" : "Claude"} is reviewing this turn.` });
      return;
    }
    const attempt = read(store.latestEvent(id, "native-review-attempt")?.text, attemptSchema);
    if (attempt?.turnKey === key) {
      await publish(task, { ...state, state: "failed", message: "This turn's automatic review was already requested. You can request a manual review." }); return;
    }
    if (!task.repo || !task.prUrl) { await publish(task, { ...state, state: "waiting", message: "Waiting for the agent to report a GitHub pull request; the native branch is not known yet." }); return; }
    const generation = reviewGeneration(task);
    const waitKey = `${key}:${JSON.stringify(policy)}:${task.prUrl}`;
    const now = Date.now();
    for (const [entry, at] of retryAfter) if (at <= now) retryAfter.delete(entry);
    if ((retryAfter.get(waitKey) ?? 0) > now) return;
    retryAfter.set(waitKey, now + 30_000);
    if (retryAfter.size > 256) retryAfter.delete(retryAfter.keys().next().value!);
    let source: NativeReviewSource | null = null;
    try {
      pullRequestNumber(task.repo, task.prUrl);
      if (!(await service.nativeReviewIdle(task))) throw new TaskError("Waiting until the task, queued messages and background work are idle.", "review_waiting");
      const facts = await factsFor(task.repo, task.prUrl, lifecycle.signal);
      lifecycle.signal.throwIfAborted(); sourceFacts(task, facts);
      const current = store.get(id);
      if (!current || reviewGeneration(current) !== generation) throw changed();
      // Registry facts only: do not inspect, prepare or switch core's checkout.
      const ready = store.transition(id, ["idle"], { branch: facts.headBranch, baseBranch: facts.baseBranch }, { promptId: task.promptId });
      if (!ready) throw changed();
      source = { taskId: id, generation: reviewGeneration(ready), turnKey: key, reviewer: policy.reviewer, repo: ready.repo!, prUrl: ready.prUrl!, head: facts.head, base: facts.base, headBranch: facts.headBranch, baseBranch: facts.baseBranch };
      const binding = source;
      const guard = async (reviewTaskId?: string) => {
        lifecycle.signal.throwIfAborted();
        const latest = store.get(id);
        if (!latest || reviewGeneration(latest) !== binding.generation || !(await service.nativeReviewIdle(latest))) throw changed();
        if (childFor(latest, key, reviewTaskId)) throw new TaskError("Another review already covers this turn.", "review_already_started");
        const currentPolicy = await service.reviewPolicy(latest, config.machineReviewer);
        if (JSON.stringify(currentPolicy) !== JSON.stringify(policy)) throw changed();
        const fresh = await factsFor(binding.repo, binding.prUrl, lifecycle.signal);
        sourceFacts(latest, fresh);
        const end = store.get(id);
        if (!sameFacts(fresh, binding) || !end || reviewGeneration(end) !== binding.generation) throw changed();
        lifecycle.signal.throwIfAborted();
      };
      await guard();
      const input = await service.reviewInput(id, { provider: policy.reviewer, automatic: true, sandbox: "new", signal: lifecycle.signal,
        brief: `Review the implementation of "${ready.title}" in ${binding.prUrl}. Review exactly HEAD ${binding.head} against base ${binding.base} (${binding.baseBranch}), on ${binding.headBranch}. Do not change files or switch the checkout to another branch. Focus on correctness, regressions, tests and the original task.` });
      const afterInput = store.get(id);
      if (!afterInput || reviewGeneration(afterInput) !== binding.generation) throw changed();
      if (childFor(afterInput, key)) { pending.add(id); return; }
      // Persist the once-only claim before any asynchronous dispatch or provider start.
      store.addEvent(id, "native-review-attempt", JSON.stringify({ version: 1, turnKey: key, reviewTaskId: null }));
      await publish(ready, { ...state, state: "starting", message: `${policy.reviewer === "codex" ? "Codex" : "Claude"} review requested.` });
      lifecycle.signal.throwIfAborted();
      const result = await service.launchTask({ ...input, sandbox: "new", snapshot: "none", nativeReview: { source: binding, signal: lifecycle.signal, beforeDispatch: guard } }, runtime.launchWaitMs);
      if (lifecycle.signal.aborted) return;
      store.addEvent(id, "native-review-result", JSON.stringify({ version: 1, turnKey: key, reviewTaskId: result.task.id }));
      await publish(store.get(id) ?? ready, { ...state, reviewTaskId: result.task.id, state: "reviewing", message: `${result.task.provider === "codex" ? "Codex" : "Claude"} is reviewing this turn.` });
    } catch (error) {
      if (lifecycle.signal.aborted) return;
      const latest = store.get(id);
      if (!latest || (source ? reviewGeneration(latest) !== source.generation : reviewGeneration(latest) !== generation)) return;
      const attempted = read(store.latestEvent(id, "native-review-attempt")?.text, attemptSchema)?.turnKey === key;
      await publish(latest, { ...state, state: attempted ? "failed" : "waiting", message: `${attempted ? "Automatic review could not start. You can request a manual review." : "Automatic review is waiting."} ${String(error instanceof Error ? error.message : error).slice(0, 300)}` });
    }
  }

  function process(id: string): Promise<void> {
    const running = active.get(id);
    if (running) { pending.add(id); return running; }
    const work = run(id).catch((error) => { if (!lifecycle.signal.aborted) bb.log.warn(`native review ${id}: ${String(error)}`); }).finally(() => {
      active.delete(id);
      if (pending.delete(id) && !lifecycle.signal.aborted) void process(id);
    });
    active.set(id, work); return work;
  }
  return {
    async afterThreadSync(threadId) {
      const task = store.byThread(threadId);
      if (!task || lifecycle.signal.aborted) return;
      if (nativeTask(task, runtime)) { await capturePolicy(task); await process(task.id); }
      else if (task.role === "review" && task.parentTaskId) await process(task.parentTaskId);
    },
    async tick() {
      for (const task of store.list({ statuses: ["idle", "running", "failed"], limit: 1000 })) {
        if (lifecycle.signal.aborted) return;
        if (nativeTask(task, runtime) && store.latestEvent(task.id, "native-review-policy")) await process(task.id);
      }
    },
  };
}
