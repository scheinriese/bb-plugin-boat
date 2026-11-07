import { createHash } from "node:crypto";
import type { SidebarThreadDto } from "../contract-sidebar.ts";
import type { BoatService } from "./service.ts";
import { parseReport } from "./briefs.ts";

/** Public DTO only. No sandbox IDs, repo paths, settings, credentials or report bodies. */
export function sidebarState(service: Pick<BoatService, "store" | "publicStatus">) {
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
      ? { text: state.reason ?? state.label, tone: state.status === "needs-you" ? "attention" as const : "danger" as const }
      : state.status === "ready" ? { text: task.prUrl ? `Ready · PR #${task.prUrl.match(/\/pull\/(\d+)/)?.[1] ?? ""}` : "Ready · ship to main", tone: "success" as const } : null;
    threads.push({ threadId: task.threadId, role: task.role === "review" ? "review" : "task", status: state.status,
      provider: task.provider, secondLine, parentThreadId: parent,
      createdFor: service.store.latestEvent(task.id, "native-chat") === null ? "you" : null,
      listedIn: service.store.latestEvent(task.id, "native-chat") === null ? parent : null, rollup: null,
      hidden: task.status === "done" || task.status === "cancelled" || (task.role === "review" && task.status === "idle" && parseReport(task.result ?? "").verdict !== null), updatedAt: task.updatedAt });
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const orchestrator of service.store.orchestrators()) {
    const children = tasks.filter((task) => task.orchestratorThreadId === orchestrator.threadId && task.role !== "review");
    const rows = children.map((task) => statuses.get(task.id)!);
    const rollup = {
      needsYou: decisions.filter((decision) => decision.orchestratorThreadId === orchestrator.threadId).length,
      stopped: rows.filter((state) => state.status === "broken").length,
      ready: rows.filter((state) => state.status === "ready").length,
      working: rows.filter((state) => state.status === "working" || state.status === "review").length,
      shippedToday: children.filter((task) => task.status === "done" && task.finishedAt?.startsWith(today)).length,
    };
    const status = rollup.needsYou ? "needs-you" : rollup.stopped ? "broken" : rollup.ready ? "ready" : rollup.working ? "working" : "stopped";
    const summary = [rollup.needsYou ? `${rollup.needsYou} need you` : "", rollup.stopped ? `${rollup.stopped} stopped` : "", rollup.ready ? `${rollup.ready} ready` : "", rollup.working ? `${rollup.working} working` : ""].filter(Boolean).join(" · ");
    threads.push({ threadId: orchestrator.threadId, role: "orchestrator", status, provider: null,
      secondLine: summary && ["needs-you", "broken", "ready"].includes(status) ? { text: summary, tone: status === "needs-you" ? "attention" : status === "broken" ? "danger" : "success" } : null,
      parentThreadId: null, createdFor: null, listedIn: null, rollup, hidden: false, updatedAt: children.reduce((at, task) => task.updatedAt > at ? task.updatedAt : at, orchestrator.createdAt) });
  }
  const bounded = threads.slice(0, 2000);
  return { version: 1 as const, revision: createHash("sha256").update(JSON.stringify(bounded)).digest("hex").slice(0, 24), threads: bounded, truncated: threads.length > 2000 || open.length === 1000 || closed.length === 1000 };
}
