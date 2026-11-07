// The UI asks for a decision here; BoatService remains the only shipping path.
import { randomUUID } from "node:crypto";
import type { PluginInteractionRequest, PluginInteractionResult } from "@get-bb/plugin-sdk";
import { SHIP_RENDERER_ID, shipChoiceSchema, type ShipForm } from "../contract-ship.ts";
import { shellQuote } from "./boat-api.ts";
import { reviewState } from "./board.ts";
import { currentChanges } from "./ship-approval.ts";
import { TaskError } from "./service.ts";
import type { Task } from "./store.ts";

export interface ShipTarget { path: string; baseBranch: string }
export interface ShipSnapshot { head: string; base: string; branch: string; commits: number }

/** Read-only: no fetch, checkout, rebase or write. Dirty work cannot be approved. */
export function shipSnapshotScript(targets: readonly ShipTarget[]): string {
  return `set -eu\nexport GIT_TERMINAL_PROMPT=0\n${targets.map((target, index) => `cd ${shellQuote(target.path)}
HEAD_SHA=$(git rev-parse --verify HEAD)
BASE_SHA=$(git rev-parse --verify ${shellQuote(`origin/${target.baseBranch}`)})
BRANCH=$(git symbolic-ref --short HEAD)
DIRTY=$(git status --porcelain)
[ -z "$DIRTY" ] || exit 3
COUNT=$(git rev-list --count "$BASE_SHA..$HEAD_SHA")
printf 'BOAT_SHIP_SNAPSHOT ${index} %s %s %s %s\\n' "$HEAD_SHA" "$BASE_SHA" "$BRANCH" "$COUNT"`).join("\n")}\n`;
}

export function parseShipSnapshot(stdout: string, count: number): ShipSnapshot[] {
  const rows = stdout.trim().split("\n");
  if (rows.length !== count) throw new TaskError("Couldn't check the commits to ship. Resume the sandbox and try again.", "ship_check_failed");
  return rows.map((line, index) => {
    const match = /^BOAT_SHIP_SNAPSHOT (\d+) ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) (\S+) (\d+)$/.exec(line);
    if (!match || Number(match[1]) !== index || !Number.isSafeInteger(Number(match[5]))) {
      throw new TaskError("Couldn't check the commits to ship. Try again after the task finishes.", "ship_check_failed");
    }
    return { head: match[2], base: match[3], branch: match[4], commits: Number(match[5]) };
  });
}

export function taskShipTargets(task: Task): ShipTarget[] {
  return task.repoPath === null || task.baseBranch === null ? [] : [
    { path: task.repoPath, baseBranch: task.baseBranch },
    ...task.extraRepos.filter((repo): repo is { repo: string; baseBranch: string; path: string } => typeof repo.path === "string")
      .map(({ path, baseBranch }) => ({ path, baseBranch })),
  ];
}

/** Excludes incidental monitor timestamps; includes every approval-relevant field. */
export function shipGeneration(task: Task): string {
  return JSON.stringify([task.status, task.turns, task.promptId, task.finishedAt, task.sandboxId, task.threadId,
    task.delivery, task.role, task.repo, task.branch, task.baseBranch, taskShipTargets(task), task.shipApproval]);
}

export interface ShipInteractionDeps {
  getTask(id: string): Task;
  latestReview(id: string): string | null;
  snapshot(task: Task, targets: ShipTarget[], signal: AbortSignal): Promise<ShipSnapshot[]>;
  requestInput(request: PluginInteractionRequest, options: { signal: AbortSignal }): Promise<PluginInteractionResult>;
  ship(id: string, options: { keepOpen: boolean; approval: string; signal: AbortSignal; beforeShip(task: Task, targets: ShipTarget[]): Promise<void> }): Promise<void>;
  record(taskId: string, kind: string, text: string): void;
  changed(): void;
  report(threadId: string, text: string): Promise<void>;
}

function assertShippable(task: Task): void {
  if (task.delivery !== "push" || task.role === "review" || taskShipTargets(task).length === 0 || task.sandboxId === null) {
    throw new TaskError("This task has no work to ship to its base branch.", "not_shippable");
  }
  if (task.status !== "idle") throw new TaskError("Wait for the task to finish its turn before shipping.", "task_running");
}

/** One pending request per task and sandbox, including checks and the ship itself. */
export function createShipInteractions(deps: ShipInteractionDeps) {
  const active = new Map<string, { taskId: string; requestId: string; threadId: string; done: Promise<void> }>();
  const lifecycle = new AbortController();
  function stale(): never {
    throw new TaskError("The work changed while this confirmation was open. Check the latest changes and request shipping again.", "ship_approval_stale");
  }
  async function run(task: Task, requestId: string, threadId: string, keepOpen: boolean) {
    const signal = lifecycle.signal;
    const generation = shipGeneration(task);
    const targets = taskShipTargets(task);
    const snapshot = await deps.snapshot(task, targets, signal);
    if (signal.aborted) return;
    if (shipGeneration(deps.getTask(task.id)) !== generation) stale();
    const commits = snapshot.reduce((sum, repo) => sum + repo.commits, 0);
    if (commits === 0) throw new TaskError("There are no commits to ship. Ask the task to commit its changes first.", "nothing_to_ship");
    const review = deps.latestReview(task.id);
    const verdict = reviewState(review);
    const changes = currentChanges(task);
    const payload: ShipForm = {
      requestId, taskId: task.id, title: task.title, baseBranch: task.baseBranch!, keepOpen,
      commits, repositories: targets.length,
      checks: [
        { text: verdict === "approve" ? `Review approved · ${review}` : verdict ? `Review: ${verdict}` : "No recorded review approval", tone: verdict === "approve" ? "ready" : "caution" },
        { text: "Working tree clean", tone: "ready" },
        { text: "Tests not independently checked", tone: "neutral" },
        { text: "Rebase and push checks run when shipping", tone: "neutral" },
      ],
      changedSinceApproval: changes ? `${changes.text}${changes.omitted ? `\n${changes.omitted} more lines not shown` : ""}` : null,
    };
    const answer = await deps.requestInput({
      threadId, rendererId: SHIP_RENDERER_ID, title: `Ship to ${task.baseBranch}?`, payload,
      timeoutMs: 10 * 60_000,
      presentation: { label: { pending: `Ship to ${task.baseBranch}?`, completed: "Shipping choice received" }, icon: { glyph: "GitMerge" } },
      describeSubmission(value) {
        const parsed = shipChoiceSchema.safeParse(value);
        if (!parsed.success || parsed.data.requestId !== requestId) return { title: "Shipping choice rejected" };
        return { title: parsed.data.choice === "ship" ? `Requested ship to ${task.baseBranch}` : "Not yet", detail: parsed.data.note || undefined };
      },
    }, { signal });
    if (signal.aborted) return;
    if (answer.outcome === "cancelled") {
      deps.record(task.id, "ship-cancelled", "Shipping confirmation cancelled; no work shipped");
      return;
    }
    const parsed = shipChoiceSchema.safeParse(answer.value);
    if (!parsed.success || parsed.data.requestId !== requestId) throw new TaskError("Shipping choice was invalid. Request shipping again.", "ship_choice_invalid");
    const { choice, note } = parsed.data;
    // Free text never grants approval, even when it contains "ship" or "approved".
    if (choice === "not-yet") {
      deps.record(task.id, "ship-deferred", `Not yet; no work shipped${note ? `\nNote: ${note}` : ""}`);
      return;
    }
    if (shipGeneration(deps.getTask(task.id)) !== generation || deps.latestReview(task.id) !== review) stale();
    await deps.ship(task.id, {
      keepOpen, signal, approval: `by the user in the in-thread confirmation ${requestId}`,
      async beforeShip(current, actualTargets) {
        if (signal.aborted) throw new TaskError("Shipping confirmation was cancelled.", "ship_cancelled");
        if (shipGeneration(current) !== generation || deps.latestReview(task.id) !== review || JSON.stringify(actualTargets) !== JSON.stringify(targets)) stale();
        const now = await deps.snapshot(current, actualTargets, signal);
        if (JSON.stringify(now) !== JSON.stringify(snapshot) || shipGeneration(deps.getTask(task.id)) !== generation) stale();
      },
    });
    if (note) deps.record(task.id, "ship-note", note);
  }
  return {
    request(input: { id: string; keepOpen?: boolean; from?: "page" | "chat" }) {
      if (lifecycle.signal.aborted) throw new TaskError("Shipping is unavailable while the plugin reloads.", "ship_cancelled");
      const task = deps.getTask(input.id);
      const key = task.sandboxId ?? task.id;
      const existing = [...active.values()].find((entry) => entry.taskId === task.id) ?? active.get(key);
      if (existing) {
        if (existing.taskId !== task.id) throw new TaskError("Another shipping confirmation is open for this sandbox. Finish or cancel it first.", "ship_pending");
        return { pending: true as const, requestId: existing.requestId, threadId: existing.threadId, duplicate: true };
      }
      assertShippable(task);
      const threadId = task.threadId ?? task.orchestratorThreadId;
      if (!threadId) throw new TaskError("Open a task chat before requesting shipping.", "ship_thread_required");
      const requestId = randomUUID();
      const entry = { taskId: task.id, requestId, threadId, done: Promise.resolve() };
      active.set(key, entry);
      // Detach from the RPC signal: completing the RPC must not dismiss the form.
      entry.done = Promise.resolve().then(() => run(task, requestId, threadId, input.keepOpen === true)).catch(async (error: unknown) => {
        if (lifecycle.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Couldn't ship. Request shipping again.";
        deps.record(task.id, "ship-request-failed", message);
        await deps.report(threadId, `[boat] Shipping stopped: ${message}`).catch(() => undefined);
      }).finally(() => { active.delete(key); deps.changed(); });
      deps.changed();
      return { pending: true as const, requestId, threadId, duplicate: false };
    },
    async settled() { await Promise.all([...active.values()].map((entry) => entry.done)); },
    dispose() { lifecycle.abort(); },
  };
}
