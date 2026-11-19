import type { RunsOnDto } from "../contract-providers.ts";
import type { MacLeaseLedger, MacLeaseSnapshot } from "./mac-leases.ts";
import type { Task } from "./store.ts";
import { PROVIDER_NAMES } from "./providers/types.ts";
export const leaseMoney = (amount: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
/** Build lookup maps once per RPC; formatting each task performs no SQL. */
export function macRunsOnBatch(snapshot: MacLeaseSnapshot, tasks: readonly Task[]) {
  const held = new Map(snapshot.leases.filter(l => !l.endedAt).map(l => [l.machineId,l]));
  const leases = new Map(snapshot.leases.map(l => [l.id,l]));
  const byTask = new Map(snapshot.tasks.map(t => [t.taskId,t.leaseId]));
  const firstTask = new Map<string,string>();
  for (const task of snapshot.tasks) if (!firstTask.has(task.leaseId)) firstTask.set(task.leaseId,task.taskId);
  const openByMachine = new Map<string,Task[]>();
  for (const task of tasks) if (task.sandboxId && task.status !== "done" && task.status !== "cancelled") openByMachine.set(task.sandboxId,[...(openByMachine.get(task.sandboxId) ?? []),task]);
  return (machineId: string | null, taskId?: string): RunsOnDto | null => {
    if (!machineId) return null;
    const lease = (taskId ? leases.get(byTask.get(taskId) ?? "") : null) ?? held.get(machineId);
    if (!lease) return null;
    const others = (openByMachine.get(machineId) ?? []).filter(t => t.id !== taskId);
    const minimumHours = (Date.parse(lease.paidUntil)-Date.parse(lease.startedAt))/3_600_000;
    return { provider: lease.provider, label: PROVIDER_NAMES[lease.provider as keyof typeof PROVIDER_NAMES] ?? lease.provider, os: "macos", machine: `Mac ${lease.size.toUpperCase().replace("PRO", " Pro")}`,
      // Times are structured so the browser formats them in the owner's zone.
      note: null, lease: { paidUntil: lease.paidUntil, endedAt: lease.endedAt, shared: taskId !== undefined && firstTask.get(lease.id) !== taskId, kept: lease.kept, releaseAt: lease.releaseAt },
      leaseCost: `${leaseMoney(lease.hourPrice,lease.currency)}/h after ${minimumHours} h minimum`, sharedTasks: others.length,
      detail: taskId ? (others.length ? `Shares the lease with ${others.map(t => t.title).join(", ")}` : null) : `${minimumHours} h minimum · ${leaseMoney(lease.minimumCost,lease.currency)}` };
  };
}
/** Single-item callers may opt in; collection RPCs always share a batch. */
export function macRunsOn(ledger: MacLeaseLedger, machineId: string | null, tasks: readonly Task[], taskId?: string): RunsOnDto | null {
  return macRunsOnBatch(ledger.snapshot(),tasks)(machineId,taskId);
}
