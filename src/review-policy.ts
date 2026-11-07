import { z } from "zod";
import { createHash } from "node:crypto";
import { reviewerSchema, type Reviewer } from "../contract-review.ts";
import type { Provider, Task } from "./store.ts";

/** null/absent inherit; none is an explicit automatic-review choice. */
export function resolveReviewer(machine: Reviewer | null | undefined, project: Reviewer | null | undefined, global: Provider): { reviewer: Reviewer; source: "machine" | "project" | "global" } {
  return machine != null ? { reviewer: machine, source: "machine" }
    : project != null ? { reviewer: project, source: "project" }
    : { reviewer: global, source: "global" };
}
export const nativeReviewConfigSchema = z.object({ version: z.literal(1), machineReviewer: reviewerSchema.nullable(), valid: z.boolean().default(true) });
export const nativeReviewSourceSchema = z.object({
  taskId: z.string(), generation: z.string().regex(/^[a-f0-9]{64}$/), turnKey: z.string().max(1000),
  reviewer: z.enum(["codex", "claude"]), repo: z.string(), prUrl: z.string().url(), headBranch: z.string(), baseBranch: z.string(), base: z.string().regex(/^[a-f0-9]{40,64}$/), head: z.string().regex(/^[a-f0-9]{40,64}$/),
});
export type NativeReviewSource = z.infer<typeof nativeReviewSourceSchema>;

/** Excludes notification timestamps; includes every source fact used by a review. */
export function reviewGeneration(task: Task): string {
  return createHash("sha256").update(JSON.stringify([task.id, task.role, task.runner, task.ownsSandbox, task.sandboxId, task.hostId, task.environmentId, task.delivery, task.status, task.promptId, task.turns, task.finishedAt, task.repo, task.prUrl, task.branch, task.baseBranch, task.result])).digest("hex");
}
export function completedTurnKey(task: Task, finishedAt: string): string {
  return JSON.stringify([task.id, task.promptId, task.turns, task.finishedAt, finishedAt]);
}

/** Project-specific policy takes precedence over generic automatic-review advice. */
export function projectReviewInstructions(project: { reviewer?: Reviewer | null } | null): string {
  if (project?.reviewer === "none") return "Automatic reviews are off for this project. Do not start a review merely because an implementation finishes, even if the shared protocol normally requests one. Manual review remains available when the user asks.";
  if (project?.reviewer === "codex" || project?.reviewer === "claude") {
    const agent = project.reviewer === "codex" ? "Codex" : "Claude";
    return `This project's default reviewer is ${agent}; boat_review without an explicit agent applies that choice. For a task registered as native-chat, Boat requests its selected automatic review after a completed turn and a reported pull request; check the task's history and avoid duplicating it. A user-requested manual review can choose another agent.`;
  }
  return "For a task registered as native-chat, Boat manages its saved automatic-review policy after a completed turn and a reported pull request. Check its history and do not duplicate that automatic request; user-requested manual review remains available.";
}
