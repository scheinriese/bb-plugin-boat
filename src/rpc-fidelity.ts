import type { Runtime } from "./runtime.ts";
import type { FidelityUsageDto } from "../contract-fidelity.ts";
import { usageWindows } from "./usage.ts";
import { sidebarState } from "./sidebar.ts";

/** Additive handlers; no sandbox lifecycle, billing, or shipping mutations. */
export function fidelityHandlers(runtime: Pick<Runtime, "service">) {
  const { service } = runtime;
  const cache = new Map<string, { at: number; value: Promise<FidelityUsageDto> }>();
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
    sidebarState: (_input: { version: 1 }) => sidebarState(service),
  };
}
