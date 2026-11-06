// What closing, cancelling or shipping a task did to the task and its
// sandbox, in words: the CLI, the agent tools, the orchestrator notice and
// the page's toasts (through the RPC's keptBecause) all say the same thing.
// A kept sandbox says why, so "kept" never reads as "the task stays open".
import type { BoatService } from "./service.ts";
import { OPEN_STATUSES, type Task } from "./store.ts";

/** What happened to the task's sandbox (BoatService.closeTask). */
export type SandboxOutcome = "deleted" | "kept" | "gone" | "none";

function isOpen(task: Pick<Task, "status">): boolean {
  return OPEN_STATUSES.includes(task.status);
}

/** "task t_1", "tasks t_1 and t_2", "tasks t_1, t_2 and t_3". */
function taskList(ids: string[]): string {
  const shown = ids.length <= 3 ? ids : [...ids.slice(0, 2), `${ids.length - 2} more`];
  const last = shown.at(-1)!;
  return `${ids.length === 1 ? "task" : "tasks"} ${shown.length === 1 ? last : `${shown.slice(0, -1).join(", ")} and ${last}`}`;
}

/**
 * Why a closed task's sandbox was kept, read right after the close (null:
 * it wasn't, the task is still open, or there's no reason to name), in the
 * order closeTask decides: the keep the caller asked for, the setting,
 * other open tasks on it, a sandbox the plugin didn't create.
 */
export async function keptBecause(service: BoatService, task: Task, sandbox: SandboxOutcome, options: { asked?: boolean } = {}): Promise<string | null> {
  if (sandbox !== "kept" || isOpen(task) || task.sandboxId === null) return null;
  if (options.asked) return "you asked to keep it";
  if (!(await service.settings()).deleteSandboxOnClose) return "Delete sandboxes when tasks close is off";
  const others = new Set(service.store.liveSandboxTasks(task.sandboxId).map((other) => other.id));
  // Task chats share a sandbox through their bb machine.
  if (task.hostId !== null) {
    for (const other of service.store.list({ statuses: OPEN_STATUSES, limit: 1000 })) if (other.hostId === task.hostId) others.add(other.id);
  }
  others.delete(task.id);
  if (others.size > 0) return `${taskList([...others])} still ${others.size === 1 ? "uses" : "use"} it`;
  if (!service.store.pluginOwnsSandbox(task.sandboxId)) return "the plugin didn't create it";
  return null;
}

/**
 * One sentence: closed (or cancelled) with the sandbox deleted, kept (and
 * why) or already gone; or still open, only when the task really is.
 */
export function closeOutcomeText(task: Pick<Task, "id" | "status">, sandbox: SandboxOutcome, why: string | null): string {
  if (isOpen(task)) {
    return task.status === "running" || task.status === "starting"
      ? `Task ${task.id} stays open: a new turn started.`
      : `Task ${task.id} stays open, with its sandbox.`;
  }
  const closed = `Task ${task.id} is ${task.status === "cancelled" ? "cancelled" : "closed"}`;
  if (sandbox === "deleted") return `${closed}; its sandbox is deleted.`;
  if (sandbox === "gone") return `${closed}; its sandbox was already gone.`;
  if (sandbox === "kept") return `${closed}; its sandbox is kept${why ? `: ${why}` : ""}.`;
  return `${closed}.`;
}

/** keptBecause and closeOutcomeText together. */
export async function describeClose(
  service: BoatService,
  result: { task: Task; sandbox: SandboxOutcome },
  options: { asked?: boolean } = {},
): Promise<{ keptBecause: string | null; text: string }> {
  const why = await keptBecause(service, result.task, result.sandbox, options);
  return { keptBecause: why, text: closeOutcomeText(result.task, result.sandbox, why) };
}
