import { readPausedResets, type PausedReset } from "./sidebar-reset.ts";
import type { Runtime } from "./runtime.ts";
import type { FidelityUsageDto } from "../contract-fidelity.ts";
import { usageWindows } from "./usage.ts";
import { sidebarState } from "./sidebar.ts";
import { createHash } from "node:crypto";
import type { SidebarQueuedStartDto } from "../contract-sidebar.ts";
import type { QueuedStartDto } from "../contract-start-queue.ts";
import { StartQueueStore } from "./start-queue-store.ts";

/** Additive handlers; no sandbox lifecycle, billing, or shipping mutations. */
export function fidelityHandlers(runtime: Pick<Runtime, "service"> & Partial<Pick<Runtime, "bb" | "startQueue">>) {
  const { service } = runtime;
  let pausedCache: { at: number; value: Promise<Map<string, PausedReset>> } | null = null;
  const cache = new Map<string, { at: number; value: Promise<FidelityUsageDto> }>();
  async function readQueuedStarts(): Promise<{ rows: SidebarQueuedStartDto[]; truncated: boolean }> {
    if (!runtime.startQueue) return { rows: [], truncated: false };
    let truncated = false;
    let pending: QueuedStartDto[] = [], started: QueuedStartDto[] = [];
    try { pending = runtime.startQueue.list().filter(row => row.state === "waiting" || row.state === "dispatching"); }
    catch { truncated = true; }
    try {
      if (runtime.bb) {
        const db = runtime.bb.storage.database();
        // Closed receipts cannot crowd an older open request out of the list.
        // These are own-plugin, read-only registry queries; no transition occurs.
        const keys = db.prepare("SELECT q.id FROM start_queue q JOIN tasks t ON t.id=q.task_id WHERE q.state='started' AND t.status NOT IN ('done','cancelled') ORDER BY q.created_at DESC,q.id LIMIT 201").all() as { id: string }[];
        if (keys.length > 200) truncated = true;
        const store = new StartQueueStore(() => db);
        for (const key of keys.slice(0, 200)) {
          try { const row = store.get(key.id); if (row) started.push(row.dto); }
          catch { truncated = true; }
        }
      } else started = runtime.startQueue.list(true).filter(row => row.state === "started");
    } catch { truncated = true; }
    const known = new Set(pending.map(row => row.id));
    const candidates = [...pending, ...started.filter(row => !known.has(row.id))];
    if (candidates.length > 200) truncated = true;
    // Pending entries take capacity before started receipts, then request order
    // is restored for the consumer. No actual chat is duplicated or invented.
    const selected = candidates.slice(0, 200).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const rows: (SidebarQueuedStartDto | null)[] = Array(selected.length).fill(null);
    const signal = AbortSignal.timeout(4000);
    let cursor = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (cursor < selected.length) {
        const index = cursor++, entry = selected[index]!;
        const task = entry.state === "started" && entry.taskId ? service.store.get(entry.taskId) : null;
        if (entry.state === "started" && (!task || task.status === "done" || task.status === "cancelled")) continue;
        let taskThreadId: string | null = null;
        if (task?.threadId && runtime.bb) {
          try {
            const thread = await runtime.bb.sdk.threads.get({ threadId: task.threadId, signal });
            if (thread.id === task.threadId && thread.archivedAt == null && thread.deletedAt == null) taskThreadId = task.threadId;
          } catch { /* Actual headless/unknown chat keeps a task detail fallback. */ }
        }
        rows[index] = { id: entry.id, revision: entry.revision, title: entry.title, sourceThreadId: entry.threadId,
          provider: task?.provider ?? entry.requestedProvider, resetsAt: entry.resetsAt, createdAt: entry.createdAt,
          state: entry.state as SidebarQueuedStartDto["state"], taskId: task?.id ?? null, taskThreadId };
      }
    }));
    return { rows: rows.filter((row): row is SidebarQueuedStartDto => row !== null), truncated };
  }
  async function readUsage(input: { taskId?: string; timezoneOffsetMinutes: number }): Promise<FidelityUsageDto> {
    const signal = AbortSignal.timeout(20_000);
    const now = new Date(); const windows = usageWindows(now, input.timezoneOffsetMinutes);
    const missing: FidelityUsageDto["missing"] = [];
    const plan = await service.boat.usagePlan(signal).catch(() => null);
    if (!plan) missing.push({ metric: "plan", capability: "boat limits --json: planIncluded.vmHoursRemaining, vmHours and periodEnd" });
    if (plan) for (const field of ["hoursRemaining", "hoursTotal", "resetsAt"] as const) if (plan[field] === null) missing.push({ metric: `plan.${field}`, capability: "boat limits --json: planIncluded.vmHoursRemaining, vmHours and periodEnd" });
    let listed = true;
    const all = await service.boat.list({ all: true, signal }).catch(() => { listed = false; return []; });
    const sandboxes = all.slice(0, 100);
    async function aggregate(window: { since: string; until: string }) {
      const values: (Awaited<ReturnType<typeof service.boat.usage>> & { sandboxId: string })[] = [];
      let index = 0; let complete = listed && all.length <= 100;
      // Bound subprocess fanout independently of the account's sandbox count.
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (index < sandboxes.length) {
          const sandbox = sandboxes[index++]!;
          const usage = await service.boat.usage(sandbox.id, window, signal).catch(() => null);
          if (!usage || usage.hours === null || usage.dollars === null) complete = false;
          if (usage) values.push({ sandboxId: sandbox.id, ...usage });
        }
      }));
      return { ...window, hours: complete ? values.reduce((sum, entry) => sum + (entry.hours ?? 0), 0) : null,
        dollars: complete ? values.reduce((sum, entry) => sum + (entry.dollars ?? 0), 0) : null, complete, sandboxCount: sandboxes.length, sandboxes: values.map(({ sandboxId, hours, dollars }) => ({ sandboxId, hours, dollars })) };
    }
    const [day, week] = await Promise.all([aggregate(windows.day), aggregate(windows.week)]);
    for (const [metric, value] of [["day", day], ["week", week]] as const) if (!value.complete) missing.push({ metric, capability: "Complete boat list --all plus boat usage ID --since/--until (seconds and dollars), bounded to 100 sandboxes" });
    let task: FidelityUsageDto["task"] = null;
    if (input.taskId) {
      const stored = service.store.resolve(input.taskId);
      if (stored?.sandboxId) {
        const usage = await service.boat.usage(stored.sandboxId, { since: stored.createdAt, until: stored.finishedAt ?? now.toISOString() }, signal).catch(() => null);
        if (usage) task = { taskId: stored.id, sandboxId: stored.sandboxId, attribution: "sandbox-window", ...usage };
      }
      if (!task) missing.push({ metric: "task", capability: "A registered task with sandboxId and boat usage ID for its start/end window; shared sandboxes include overlapping reviews" });
    }
    return { plan, day, week, task, sandboxes: week.sandboxes, missing, checkedAt: now.toISOString() };
  }
  return {
    history: (input: Parameters<typeof service.store.history>[0]) => service.store.history(input),
    fidelityUsage: (input: { taskId?: string; timezoneOffsetMinutes: number }) => {
      const key = `${input.taskId ?? ""}:${input.timezoneOffsetMinutes}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < 60_000) return hit.value;
      if (cache.size >= 16) cache.delete(cache.keys().next().value!);
      const value = readUsage(input); cache.set(key, { at: Date.now(), value }); return value;
    },
    sidebarState: async (input: { version: 1; timezoneOffsetMinutes?: number }) => {
      if (runtime.bb && (!pausedCache || Date.now() - pausedCache.at > 15_000)) pausedCache = { at: Date.now(), value: readPausedResets(runtime.bb) };
      const base = sidebarState(service, runtime.bb ? await pausedCache!.value : new Map(), input.timezoneOffsetMinutes);
      const queued = await readQueuedStarts();
      return { ...base, queuedStarts: queued.rows, truncated: base.truncated || queued.truncated,
        revision: createHash("sha256").update(JSON.stringify([base.revision, queued.rows])).digest("hex").slice(0, 24) };
    },
  };
}
