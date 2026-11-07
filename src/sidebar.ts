import { resetWaitText, type PausedReset } from "./sidebar-reset.ts";
import { createHash } from "node:crypto";
import type { SidebarThreadDto } from "../contract-sidebar.ts";
import type { BoatService } from "./service.ts";
import { parseReport } from "./briefs.ts";

/** Public DTO only. No sandbox IDs, repo paths, settings, credentials or report bodies. */
export function sidebarState(service: Pick<BoatService, "store" | "publicStatus">, pausedResets: ReadonlyMap<string, PausedReset> = new Map(), timezoneOffsetMinutes?: number) {
  const open = service.store.list({ statuses: ["starting", "running", "idle", "failed"], limit: 1000 });
  const closed = service.store.list({ statuses: ["done", "cancelled"], limit: 1000 });
  const tasks = [...open, ...closed];
  const statuses = new Map(tasks.map((task) => [task.id, service.publicStatus(task)]));
  const decisions = service.store.decisions({ statuses: ["open"], limit: 1000 });
  const threads: SidebarThreadDto[] = [];
  for (const task of tasks) {
    if (!task.threadId) continue;
    const state = statuses.get(task.id)!;
    const parent = task.role === "review" && task.parentTaskId ? service.store.get(task.parentTaskId)?.threadId ?? task.orchestratorThreadId : task.orchestratorThreadId;
    const secondLine = state.status === "needs-you" || state.status === "broken"
      ? { text: state.status === "needs-you" ? decisions.find((decision) => decision.taskIds.includes(task.id))?.shortLabel ?? state.reason ?? state.label : `Stopped · ${(state.reason ?? task.error ?? "something went wrong").toLowerCase()}`, tone: state.status === "needs-you" ? "attention" as const : "danger" as const }
      : state.status === "ready" ? { text: task.prUrl ? `PR #${task.prUrl.match(/\/pull\/(\d+)/)?.[1] ?? ""} · ready to merge` : "Ready to ship to main", tone: "success" as const } : null;
    threads.push({ threadId: task.threadId, role: task.role === "review" ? "review" : "task", status: state.status,
      provider: task.provider, moving: state.moving, secondLine, parentThreadId: parent,
      createdFor: service.store.latestEvent(task.id, "native-chat") === null ? "you" : null,
      listedIn: service.store.latestEvent(task.id, "native-chat") === null ? parent : null, rollup: null,
      hidden: task.status === "done" || task.status === "cancelled" || (task.role === "review" && task.status === "idle" && parseReport(task.result ?? "").verdict !== null), updatedAt: task.updatedAt });
  }
  const now = new Date(); const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const orchestrators = service.store.orchestrators();
  const known = new Set(orchestrators.map((entry) => entry.threadId));
  const parents = new Map(orchestrators.map((entry) => [entry.threadId, entry]));
  for (const task of tasks) if (task.orchestratorThreadId && !parents.has(task.orchestratorThreadId)) parents.set(task.orchestratorThreadId, { threadId: task.orchestratorThreadId, createdAt: task.createdAt, projectId: null, projectName: null });
  for (const orchestrator of parents.values()) {
    const children = tasks.filter((task) => task.orchestratorThreadId === orchestrator.threadId && task.role !== "review");
    const rows = children.map((task) => statuses.get(task.id)!);
    const openDecisions = decisions.filter((decision) => decision.orchestratorThreadId === orchestrator.threadId);
    const decisionTasks = new Set(openDecisions.flatMap((decision) => decision.taskIds));
    const rollup = {
      needsYou: openDecisions.length + children.filter((task) => statuses.get(task.id)!.status === "needs-you" && !decisionTasks.has(task.id)).length,
      stopped: rows.filter((state) => state.status === "broken").length,
      ready: rows.filter((state) => state.status === "ready").length,
      working: rows.filter((state) => state.status === "working" || state.status === "review").length,
      shippedToday: service.store.shippedCount(orchestrator.threadId, midnight.toISOString(), new Date(now.getTime() + 1).toISOString()),
    };
    const status = rollup.needsYou ? "needs-you" : rollup.stopped ? "broken" : rollup.ready ? "ready" : rollup.working ? "working" : "stopped";
    const summary = [rollup.needsYou ? `${rollup.needsYou} need you` : "", rollup.stopped ? `${rollup.stopped} stopped` : "", rollup.ready ? `${rollup.ready} ready` : "", rollup.working ? `${rollup.working} working` : ""].filter(Boolean).join(" · ");
    threads.push({ threadId: orchestrator.threadId, role: known.has(orchestrator.threadId) ? "orchestrator" : "chat", status, provider: null,
      secondLine: summary && ["needs-you", "broken", "ready"].includes(status) ? { text: summary, tone: status === "needs-you" ? "attention" : status === "broken" ? "danger" : "success" } : null,
      parentThreadId: null, moving: rollup.working > 0, createdFor: null, listedIn: null, rollup, hidden: false, updatedAt: children.reduce((at, task) => task.updatedAt > at ? task.updatedAt : at, orchestrator.createdAt) });
  }
  for (const row of threads) {
    const reset = pausedResets.get(row.threadId);
    if (!reset || reset.sendAt <= Date.now() || row.hidden || row.moving || ["needs-you", "broken", "ready", "shipped"].includes(row.status)) continue;
    row.status = "waiting-reset";
    row.moving = false;
    row.secondLine = { text: resetWaitText(reset.sendAt, timezoneOffsetMinutes), tone: "neutral" };
    if (reset.updatedAt > Date.parse(row.updatedAt)) row.updatedAt = new Date(reset.updatedAt).toISOString();
  }
  const bounded = threads.slice(0, 2000);
  return { version: 1 as const, revision: createHash("sha256").update(JSON.stringify(bounded)).digest("hex").slice(0, 24), threads: bounded, truncated: threads.length > 2000 || open.length === 1000 || closed.length === 1000 };
}
