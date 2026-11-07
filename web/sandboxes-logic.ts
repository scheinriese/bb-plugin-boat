import type { SandboxDto, TaskDto } from "../contract.ts";

/** Idle stop is neutral; only a recorded cause belongs in the exceptions list. */
export function sandboxFailure(sandbox: SandboxDto, tasks: readonly TaskDto[]): { task: TaskDto | null; reason: string } | null {
  const task = tasks.find((entry) => entry.sandboxId === sandbox.id && (entry.publicStatus?.status === "broken" || (!entry.publicStatus && entry.status === "failed" && !!entry.error)));
  if (task) return { task, reason: task.publicStatus?.reason || task.error || "Task stopped with an error" };
  if (sandbox.state === "error") return { task: null, reason: "Sandbox error" };
  if (sandbox.health && !["ok", "healthy", "unknown"].includes(sandbox.health)) return { task: null, reason: `Sandbox health: ${sandbox.health}` };
  return null;
}

/** A live chat using a kept sandbox takes precedence over an old closed task. */
export function sandboxPrimaryTask(sandbox: SandboxDto, tasks: readonly TaskDto[]): TaskDto | null {
  const use = sandbox.uses.find((item) => item.open);
  if (use) return tasks.find((task) => use.kind === "task" ? task.id === use.id : task.threadId === use.id) ?? null;
  return tasks.find((task) => task.sandboxId === sandbox.id && task.status !== "done" && task.status !== "cancelled")
    ?? tasks.find((task) => task.sandboxId === sandbox.id) ?? null;
}
