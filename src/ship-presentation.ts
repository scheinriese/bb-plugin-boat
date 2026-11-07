// Presentation facts only. Approval/claim policy stays in ship-interaction/service.
import type { Runtime } from "./runtime.ts";
import type { Task } from "./store.ts";
import { reviewState } from "./board.ts";

export async function shipPresentation(runtime: Runtime, task: Task) {
  const settings = await runtime.service.settings();
  const project = task.boatProject ? runtime.projects?.get(task.boatProject) : null;
  const events = runtime.service.store.events(task.id, 200);
  const review = runtime.service.store.latestEvent(task.id, "review");
  const match = review && /^Review (\S+): approve$/.exec(review.text);
  const reviewer = match ? runtime.service.store.get(match[1]) : null;
  const rounds = new Set(events.filter((event) => event.kind === "review").flatMap((event) => {
    const id = /^Review (\S+) (?:started|:)/.exec(event.text)?.[1] ?? /^Review (\S+):/.exec(event.text)?.[1];
    return id ? [id] : [];
  })).size;
  return {
    projectName: project?.name ?? null,
    closesSandbox: settings.deleteSandboxOnClose,
    ...(reviewState(review?.text) === "approve" && reviewer ? {
      reviewText: `${reviewer.provider === "codex" ? "Codex" : "Claude"} approved${rounds > 0 ? `, review ${rounds}` : ""}`,
    } : {}),
    // Existing agent prose is not independent command/HEAD-bound test evidence.
  };
}
