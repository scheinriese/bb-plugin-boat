import type { Runtime } from "./runtime.ts";
import type { Task } from "./store.ts";
import type { ProjectSnapshotCheckDto } from "../contract-projects.ts";
import { parseReport } from "./briefs.ts";
import { TaskError } from "./service.ts";
import { toOrchestratorProject } from "./projects.ts";

export function snapshotCheckView(runtime: Pick<Runtime, "service">, task: Task): ProjectSnapshotCheckDto {
  const savedEvent = runtime.service.store.latestEvent(task.id, "snapshot-saved");
  const saved = !!savedEvent && Date.parse(savedEvent.at) >= Date.parse(task.finishedAt ?? task.createdAt);
  const running = task.status === "starting" || task.status === "running";
  const success = task.status === "idle" && !!task.sandboxId && parseReport(task.result ?? "").status === "done";
  return { taskId: task.id, title: task.title, sandboxId: task.sandboxId, createdAt: task.createdAt, stage: running ? "checking" : saved ? "saved" : success ? "ready" : "failed", error: running || success || saved ? null : task.error || "The repo check did not confirm that setup passed. Open the task to inspect its report." };
}
export function projectSnapshotHandlers(runtime: Pick<Runtime, "service" | "projects" | "launchWaitMs" | "wake" | "changed">) {
  const starting = new Map<string, Promise<ProjectSnapshotCheckDto>>();
  return {
    projectSnapshotCheck: ({ projectId }: { projectId: string }) => { const task = runtime.service.store.latestProjectSnapshotCheck(projectId); return task ? snapshotCheckView(runtime, task) : null; },
    startProjectSnapshot: ({ projectId }: { projectId: string }): Promise<ProjectSnapshotCheckDto> => {
      const pending = starting.get(projectId); if (pending) return pending;
      const operation = (async () => {
        const project = runtime.projects.get(projectId); if (!project) throw new TaskError("This project no longer exists.", "project_not_found");
        const old = runtime.service.store.latestProjectSnapshotCheck(projectId);
        if (old && ["starting", "running"].includes(old.status)) return snapshotCheckView(runtime, old);
        const repo = project.repos[0]!;
        const { task } = await runtime.service.launchTask({ title: `Check ${project.name} for a snapshot`, role: "custom", tier: "light", reason: `Project snapshot check: ${projectId}`, project: toOrchestratorProject(project), repo: repo.repo, baseBranch: repo.baseBranch, runner: "boat", sandbox: "new", snapshot: "none", evidence: false, measureMemory: true, userApproved: true,
          brief: `${repo.repo} is already checked out in this sandbox. Install its dependencies, run the tests and start the app. Don't change any code, and don't commit or push anything.\n\nReport what worked, what failed, and what the boat environment is missing (packages, variables, secret files).\n\nThis is a fresh headless project snapshot check. Do not install or authenticate bb. End with STATUS: done only when setup and checks passed; otherwise STATUS: blocked.` }, runtime.launchWaitMs);
        runtime.wake(); runtime.changed(); return snapshotCheckView(runtime, task);
      })();
      starting.set(projectId, operation); void operation.finally(() => { if (starting.get(projectId) === operation) starting.delete(projectId); }).catch(() => {}); return operation;
    },
  };
}
