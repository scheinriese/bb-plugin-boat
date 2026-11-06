// The orchestrator overview: everything grouped the way the user thinks
// about it. Needs you (decisions), Ready to review, Running, Done.
import type { Decision, Task } from "./store.ts";

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
  if (task.status !== "idle") return false;
  if (task.readyAt !== null) return true;
  // Started by hand or from a plain chat: a finished turn waits on the user.
  if (task.orchestratorThreadId === null || !isOrchestrator(task.orchestratorThreadId)) return true;
  if (task.role !== "implement" || task.prUrl === null) return false;
  const reviewOpen = tasks.some(
    (other) => other.parentTaskId === task.id && other.role === "review" && (other.status === "running" || other.status === "starting"),
  );
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
  const open = input.tasks.filter((task) => task.status !== "done" && task.status !== "cancelled");
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
