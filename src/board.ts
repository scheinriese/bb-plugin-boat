// The orchestrator overview: everything grouped the way the user thinks
// about it. Needs you (decisions), Ready to review, Running, Done.
import type { Decision, Task } from "./store.ts";
import { parseReport } from "./briefs.ts";

/** Public vocabulary. Persisted task/phase values remain lifecycle details. */
export const PUBLIC_STATUSES = ["working", "review", "ready", "shipped", "needs-you", "broken", "stopped", "waiting-reset"] as const;
export type PublicStatus = (typeof PUBLIC_STATUSES)[number];
export interface TaskPublicStatus {
  status: PublicStatus;
  label: string;
  tone: "neutral" | "attention" | "positive" | "danger";
  reason: string | null;
  needsYou: boolean;
  moving: boolean;
}
export interface StatusContext {
  ready?: boolean;
  latestReview?: string | null;
  reviewOpen?: boolean;
  /** An actual unresolved owner decision; idle alone never means needs you. */
  needsYou?: boolean;
  reason?: string | null;
  sandboxState?: string | null;
  waitingReset?: boolean;
  /** A confirmed current-turn OOM cause, not an old memory warning. */
  outOfMemory?: boolean;
  /** The suggested recovery costs more, so a broken task also needs the owner. */
  recoveryCostsMore?: boolean;
}

/** The same resolver is usable by server DTOs, cards, pages and sidebar rows. */
export function resolveTaskStatus(
  task: Pick<Task, "status" | "role" | "error" | "readyAt">,
  context: StatusContext = {},
): TaskPublicStatus {
  const state = (status: PublicStatus, label: string, tone: TaskPublicStatus["tone"], reason: string | null = null, needsYou = false, moving = false): TaskPublicStatus =>
    ({ status, label, tone, reason, needsYou, moving });
  if (task.status === "done" && task.role === "review") return state("review", "Review complete", "neutral", "The review is closed.");
  if (task.status === "done") return state("shipped", "Shipped", "positive");
  if (task.status === "cancelled") return state("stopped", "Stopped", "neutral");
  const error = task.error?.trim() || null;
  const busy = task.status === "running" || task.status === "starting";
  // Old errors and old OOM findings must not interrupt a new running turn.
  if (!busy && (context.waitingReset || (error !== null && /usage.?limit|rate.?limit|quota|wait(?:ing)? for.*reset|hit.*limit/i.test(error)))) {
    return state("waiting-reset", "Waiting for reset", "neutral", context.reason ?? error);
  }
  const interrupted = error !== null && /^(?:The )?turn was interrupted[.\s]*$/i.test(error);
  if (!busy && (context.outOfMemory || task.status === "failed" || (error !== null && !interrupted))) {
    return state("broken", "Broken", "danger", context.reason ?? error ?? "The task stopped with an error.", context.needsYou === true || context.recoveryCostsMore === true);
  }
  if (context.needsYou) return state("needs-you", "Needs you", "attention", context.reason ?? null, true);
  const reviewing = context.reviewOpen ?? context.latestReview === "reviewing";
  if (reviewing || (task.role === "review" && busy)) {
    return state("review", "Review", "neutral", context.reason ?? null, false, busy || reviewing);
  }
  // A neutral idle stop preserves an approved change; errors and explicit interrupts still win.
  const approvedChange = task.readyAt !== null || context.latestReview === "approve";
  if (!busy && !interrupted && approvedChange && (context.ready ?? approvedChange)) return state("ready", "Ready", "positive", context.reason ?? null);
  if (!busy && (interrupted || /^(?:stopped|suspended|suspending|exited)$/i.test(context.sandboxState ?? ""))) {
    return state("stopped", "Stopped", "neutral", context.reason ?? "Resumes on the next message.");
  }
  if (!busy && (context.ready ?? task.readyAt !== null)) return state("ready", "Ready", "positive", context.reason ?? null);
  return state("working", "Working", "neutral", context.reason ?? (busy ? null : "Waiting for the next step."), false, busy);
}

/** Completed reviews live in their task's history, rather than the active board. */
export function completedReview(task: Task): boolean {
  return task.role === "review" && task.status === "idle" && parseReport(task.result ?? "").verdict !== null;
}

/** The latest review event of an implementation → "reviewing", "approve", "changes-requested", … */
export function reviewState(eventText: string | null | undefined): string | null {
  if (!eventText) return null;
  if (/^Changed since/.test(eventText)) return "outdated";
  if (/ started /.test(eventText)) return "reviewing";
  return /: ([a-z][a-z-]*)$/.exec(eventText)?.[1] ?? null;
}

/** One word for where a task stands, for the status pill. */
export type Phase = "starting" | "working" | "waiting" | "failed" | "ready" | "done" | "cancelled";

export interface Board {
  needsYou: Decision[];
  ready: Task[];
  running: Task[];
  done: Task[];
}

export interface BoardInput {
  tasks: Task[];
  decisions: Decision[];
  /** The latest review verdict of an implementation ("approve", …), if any. */
  latestVerdict: (task: Task) => string | null;
  /** Done/cancelled tasks to show (most recent first). */
  doneLimit?: number;
  /** Is this chat a real orchestrator (started or turned on as one)? Default: every dispatching chat is. */
  isOrchestrator?: (threadId: string) => boolean;
}

/**
 * Ready to review: the orchestrator marked it (boat_ready), or an implementer
 * with a pull request whose latest review approved and no review is still open.
 * A task started from the page or from a plain chat (not an orchestrator) is
 * ready once its turn finished: nobody else reviews it.
 */
export function isReady(
  task: Task,
  tasks: readonly Task[],
  latestVerdict: (task: Task) => string | null,
  isOrchestrator: (threadId: string) => boolean = () => true,
): boolean {
  if (task.status !== "idle" || task.role === "review" || task.error !== null) return false;
  const reviewOpen = tasks.some(
    (other) => other.parentTaskId === task.id && other.role === "review" && (other.status === "running" || other.status === "starting"),
  );
  if (reviewOpen) return false;
  if (task.readyAt !== null) return true;
  // Started by hand or from a plain chat: a finished turn waits on the user.
  if (task.orchestratorThreadId === null || !isOrchestrator(task.orchestratorThreadId)) return true;
  if (task.role !== "implement" || task.prUrl === null) return false;
  return !reviewOpen && latestVerdict(task) === "approve";
}

export function phaseOf(task: Task, ready: boolean): Phase {
  if (task.status === "done") return "done";
  if (task.status === "cancelled") return "cancelled";
  if (task.status === "failed") return "failed";
  if (task.status === "starting") return "starting";
  if (task.status === "running") return "working";
  return ready ? "ready" : "waiting";
}

export function buildBoard(input: BoardInput): Board {
  const open = input.tasks.filter((task) => task.status !== "done" && task.status !== "cancelled" && !completedReview(task));
  const ready: Task[] = [];
  const running: Task[] = [];
  for (const task of open) (isReady(task, input.tasks, input.latestVerdict, input.isOrchestrator) ? ready : running).push(task);
  const done = input.tasks
    .filter((task) => task.status === "done" || task.status === "cancelled")
    .sort((a, b) => (b.finishedAt ?? b.updatedAt).localeCompare(a.finishedAt ?? a.updatedAt))
    .slice(0, input.doneLimit ?? 20);
  return {
    needsYou: input.decisions.filter((decision) => decision.status === "open"),
    ready,
    // Failed first, then working, then waiting on the orchestrator.
    running: running.sort((a, b) => order(a) - order(b) || b.updatedAt.localeCompare(a.updatedAt)),
    done,
  };
}

function order(task: Task): number {
  return task.status === "failed" ? 0 : task.status === "running" || task.status === "starting" ? 1 : 2;
}
