import type { RunsOnDto } from "../contract-providers.ts";
import type { MacLeaseLedger } from "./mac-leases.ts";
import type { Task } from "./store.ts";
export const leaseEnd = (until: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(until)).replace(",", "") + " UTC";
export const leaseMoney = (amount: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
export function macRunsOn(ledger: MacLeaseLedger, machineId: string | null, tasks: readonly Task[], taskId?: string): RunsOnDto | null {
  if (!machineId) return null;
  const lease = taskId ? ledger.list().find(l => ledger.tasks(l.id).some(t => t.taskId === taskId)) ?? ledger.held(machineId)[0] : ledger.held(machineId)[0];
  if (!lease) return null;
  const attached = ledger.tasks(lease.id);
  const others = tasks.filter(t => t.id !== taskId && t.sandboxId === machineId && t.status !== "done" && t.status !== "cancelled");
  const shared = taskId !== undefined && attached.findIndex(t => t.taskId === taskId) > 0;
  return { provider: lease.provider, label: lease.provider === "scaleway" ? "Scaleway" : "Instabox", os: "macos", machine: `Mac ${lease.size.toUpperCase().replace("PRO", " Pro")}`,
    note: lease.endedAt ? `lease ended ${leaseEnd(lease.endedAt)}` : `${taskId ? shared ? "same lease, ends" : "lease ends" : "leased until"} ${leaseEnd(lease.paidUntil)}`,
    leaseCost: `${leaseMoney(lease.dayPrice,lease.currency)} a day`, sharedTasks: others.length,
    detail: taskId ? (others.length ? `Shares the lease with ${others.map(t => t.title).join(", ")}` : null) : `24 h lease · ${leaseMoney(lease.dayPrice,lease.currency)}` };
}
