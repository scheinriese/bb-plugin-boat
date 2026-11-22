import type { SandboxInventoryDto, SandboxMacLeaseDto } from "../contract-sandboxes.ts";
import { machinePower } from "../sandbox-power.ts";
import type { MacLeaseSnapshot } from "./mac-leases.ts";
import type { SandboxInfo, SandboxProvider } from "./providers/types.ts";

export const INVENTORY_ROWS_PER_PROVIDER = 200;
export const INVENTORY_LEASE_ROWS = 200;

/** Resolve only within the caller's deadline, including adapters that miss abort. */
export function inventoryRead<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error("Inventory read deadline reached"));
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    read.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** One supported list read per enabled provider; errors never become empty success. */
export async function readSandboxInventory(
  providers: readonly Pick<SandboxProvider, "id" | "list">[],
  options: { all: boolean; signal?: AbortSignal },
  now: () => number = Date.now,
): Promise<{ sandboxes: (SandboxInfo & { provider: string })[]; inventory: SandboxInventoryDto }> {
  const deadline = AbortSignal.timeout(15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const settled = await Promise.allSettled(providers.map(async provider => {
    const rows = await inventoryRead(provider.list({ ...options, signal }), signal);
    // A malformed provider implementation is a failed read, not a zero.
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== "string" || !row.id || typeof row.state !== "string")) throw new Error("Invalid inventory");
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("Invalid inventory");
    return { rows, observedAt: new Date(now()).toISOString() };
  }));
  const sandboxes: (SandboxInfo & { provider: string })[] = [];
  const reads: SandboxInventoryDto["providers"] = settled.map((result, index) => {
    const id = providers[index]!.id;
    if (result.status === "rejected") return { id, status: "unavailable", observedAt: null, poweredOn: null, unknown: null, truncated: false };
    const { rows, observedAt } = result.value;
    const truncated = rows.length > INVENTORY_ROWS_PER_PROVIDER;
    const bounded = rows.slice(0, INVENTORY_ROWS_PER_PROVIDER);
    sandboxes.push(...bounded.map(row => ({ ...row, provider: id })));
    const unknown = bounded.filter(row => machinePower(row.state) === "unknown").length;
    return { id, status: "fresh", observedAt, poweredOn: truncated || unknown ? null : bounded.filter(row => machinePower(row.state) === "on").length, unknown, truncated };
  });
  return { sandboxes, inventory: { providers: reads, truncated: reads.some(read => read.truncated) } };
}

/** Only public machine/task references and lease facts; no raw ledger rows or notices. */
export function sandboxMacLeases(snapshot: MacLeaseSnapshot): { macLeases: SandboxMacLeaseDto[]; macLeasesTruncated: boolean } {
  const rows = [...snapshot.leases].sort((a, b) => Number(Boolean(a.endedAt)) - Number(Boolean(b.endedAt)) || b.startedAt.localeCompare(a.startedAt));
  return {
    macLeasesTruncated: rows.length > INVENTORY_LEASE_ROWS,
    macLeases: rows.slice(0, INVENTORY_LEASE_ROWS).map(lease => ({
      provider: lease.provider, machineId: lease.machineId, size: lease.size,
      state: !lease.endedAt ? "held" : lease.endEvidence === "confirmed" && (lease.endReason === "handed back" || lease.endReason === "deleted") ? "returned" : "ended-unverified",
      startedAt: lease.startedAt, paidUntil: lease.paidUntil, endedAt: lease.endedAt,
      endReason: lease.endReason, endEvidence: lease.endEvidence ?? "legacy",
      minimumCost: lease.minimumCost, hourPrice: lease.hourPrice, currency: lease.currency,
      kept: lease.kept, releaseAt: lease.releaseAt,
      taskIds: snapshot.tasks.filter(task => task.leaseId === lease.id).slice(0, 20).map(task => task.taskId),
    })),
  };
}
