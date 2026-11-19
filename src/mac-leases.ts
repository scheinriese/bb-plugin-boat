// Provider-neutral lease billing: a fixed paid minimum, then an hourly rate
// prorated by elapsed time. The minimum end never advances locally.
import type Database from "better-sqlite3";
export const LEASE_DAY_MS = 24 * 60 * 60 * 1000;
// Existing migration indexes must stay stable.
export const MAC_LEASE_MIGRATIONS = [
  `CREATE TABLE mac_leases (id TEXT PRIMARY KEY, provider TEXT NOT NULL, machine_id TEXT NOT NULL, size TEXT NOT NULL, started_at TEXT NOT NULL, paid_until TEXT NOT NULL, day_price REAL NOT NULL, currency TEXT NOT NULL, cpus INTEGER NOT NULL, memory_mib INTEGER NOT NULL, ended_at TEXT, end_reason TEXT, warned_until TEXT)`,
  `CREATE UNIQUE INDEX mac_leases_held ON mac_leases(provider, machine_id) WHERE ended_at IS NULL`,
  `CREATE TABLE mac_lease_tasks (lease_id TEXT NOT NULL REFERENCES mac_leases(id), task_id TEXT NOT NULL, attached_at TEXT NOT NULL, cpus INTEGER NOT NULL, memory_mib INTEGER NOT NULL, PRIMARY KEY(lease_id, task_id))`,
];
export const MAC_LEASE_BILLING_MIGRATIONS = [
  `ALTER TABLE mac_leases ADD COLUMN hour_price REAL NOT NULL DEFAULT 0`,
  // The old schema only supported 24 h minima and extended paid_until by
  // whole days. Recover its original terms once; new records supply their own.
  `UPDATE mac_leases SET hour_price=day_price/24, paid_until=strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+24 hours')`,
  `ALTER TABLE mac_leases ADD COLUMN kept INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE mac_leases ADD COLUMN release_at TEXT`,
  `CREATE INDEX mac_lease_tasks_task ON mac_lease_tasks(task_id)`,
];
export interface MacLease {
  id: string; provider: string; machineId: string; size: string; startedAt: string; paidUntil: string;
  minimumCost: number; hourPrice: number; currency: string; cpus: number; memoryMiB: number;
  endedAt: string | null; endReason: "handed back" | "deleted" | "failed" | null; warnedUntil: string | null;
  kept: boolean; releaseAt: string | null;
}
export interface LeaseTask { leaseId: string; taskId: string; attachedAt: string; cpus: number; memoryMiB: number }
export interface MacLeaseSnapshot { leases: MacLease[]; tasks: LeaseTask[] }
const iso = (at: number) => new Date(at).toISOString();
const LEASE_COLUMNS = `id, provider, machine_id AS machineId, size, started_at AS startedAt, paid_until AS paidUntil, day_price AS minimumCost, hour_price AS hourPrice, currency, cpus, memory_mib AS memoryMiB, ended_at AS endedAt, end_reason AS endReason, warned_until AS warnedUntil, kept, release_at AS releaseAt`;
const TASK_COLUMNS = `lease_id AS leaseId, task_id AS taskId, attached_at AS attachedAt, cpus, memory_mib AS memoryMiB`;
export class MacLeaseLedger {
  private readonly db: () => Database.Database;
  constructor(db: () => Database.Database) { this.db = db; }
  private rows(sql: string, args: string[] = []): MacLease[] {
    return (this.db().prepare(sql).all(...args) as (Omit<MacLease,"kept"> & { kept: number })[]).map(row => ({ ...row, kept: row.kept === 1 }));
  }
  list(): MacLease[] { return this.rows(`SELECT ${LEASE_COLUMNS} FROM mac_leases ORDER BY started_at`); }
  held(machineId?: string): MacLease[] {
    return this.rows(`SELECT ${LEASE_COLUMNS} FROM mac_leases WHERE ended_at IS NULL${machineId === undefined ? "" : " AND machine_id=?"} ORDER BY started_at`, machineId === undefined ? [] : [machineId]);
  }
  record(lease: Omit<MacLease, "endedAt" | "endReason" | "warnedUntil" | "kept" | "releaseAt">): MacLease {
    const start = Date.parse(lease.startedAt), until = Date.parse(lease.paidUntil);
    if (!Number.isFinite(start) || !Number.isFinite(until) || until <= start || !Number.isFinite(lease.minimumCost) || lease.minimumCost < 0 || !Number.isFinite(lease.hourPrice) || lease.hourPrice < 0) throw new Error("Invalid Mac lease billing terms");
    this.db().prepare(`INSERT INTO mac_leases (id,provider,machine_id,size,started_at,paid_until,day_price,hour_price,currency,cpus,memory_mib)
      SELECT @id,@provider,@machineId,@size,@startedAt,@paidUntil,@minimumCost,@hourPrice,@currency,@cpus,@memoryMiB
      WHERE NOT EXISTS (SELECT 1 FROM mac_leases WHERE id=@id AND end_reason IS NOT NULL)
      ON CONFLICT(id) DO UPDATE SET machine_id=excluded.machine_id
      WHERE mac_leases.ended_at IS NULL AND mac_leases.end_reason IS NULL AND mac_leases.provider=excluded.provider AND mac_leases.started_at=excluded.started_at`).run({ id: lease.id, provider: lease.provider, machineId: lease.machineId, size: lease.size, startedAt: lease.startedAt, paidUntil: lease.paidUntil, minimumCost: lease.minimumCost, hourPrice: lease.hourPrice, currency: lease.currency, cpus: lease.cpus, memoryMiB: lease.memoryMiB });
    return this.rows(`SELECT ${LEASE_COLUMNS} FROM mac_leases WHERE id=?`, [lease.id])[0]!;
  }
  tasks(id: string): LeaseTask[] { return this.db().prepare(`SELECT ${TASK_COLUMNS} FROM mac_lease_tasks WHERE lease_id=? ORDER BY attached_at,task_id`).all(id) as LeaseTask[]; }
  /** Two reads per view, independent of task/lease count. No per-task queries. */
  snapshot(): MacLeaseSnapshot {
    return { leases: this.list(), tasks: this.db().prepare(`SELECT ${TASK_COLUMNS} FROM mac_lease_tasks ORDER BY attached_at,task_id`).all() as LeaseTask[] };
  }
  attach(id: string, taskId: string, cpus: number, memoryMiB: number, now = Date.now()): void {
    this.db().prepare(`INSERT OR IGNORE INTO mac_lease_tasks VALUES (?,?,?,?,?)`).run(id, taskId, iso(now), cpus, memoryMiB);
  }
  end(id: string, reason: NonNullable<MacLease["endReason"]>, now = Date.now()): void {
    this.db().prepare(`UPDATE mac_leases SET ended_at=?,end_reason=? WHERE id=? AND ended_at IS NULL`).run(iso(now), reason, id);
  }
  keep(id: string): void { this.db().prepare(`UPDATE mac_leases SET kept=1 WHERE id=? AND ended_at IS NULL`).run(id); }
  schedule(id: string, at: string | null): void { this.db().prepare(`UPDATE mac_leases SET release_at=? WHERE id=? AND ended_at IS NULL`).run(at,id); }
  warn(id: string): boolean {
    return this.db().prepare(`UPDATE mac_leases SET warned_until=paid_until WHERE id=? AND ended_at IS NULL AND warned_until IS NULL`).run(id).changes > 0;
  }
  reconcile(provider: string, machineIds: ReadonlySet<string>, now = Date.now()): void {
    for (const lease of this.held()) if (lease.provider === provider && !machineIds.has(lease.machineId)) {
      const scheduled = lease.releaseAt !== null && Date.parse(lease.releaseAt) <= now;
      this.end(lease.id, scheduled ? "handed back" : "deleted", scheduled ? Date.parse(lease.releaseAt!) : now);
    }
  }
  /** Billable time includes the entire committed minimum, even after an early
   * deletion. Allocate that minimum uniformly across its actual interval;
   * subsequent time uses the provider's hourPrice, with no rounding to days. */
  between(from: number, until: number, now = Date.now(), machineId?: string) {
    let leaseDays = 0; const costs: Record<string, number> = {};
    const overlap = (start: number, end: number) => Math.max(0, Math.min(end,until)-Math.max(start,from));
    for (const lease of this.list()) {
      if (machineId && lease.machineId !== machineId) continue;
      const start = Date.parse(lease.startedAt), minimumEnd = Date.parse(lease.paidUntil);
      const end = Math.max(minimumEnd, Math.min(now, lease.endedAt ? Date.parse(lease.endedAt) : now));
      const minimumMs = overlap(start,minimumEnd), extraMs = overlap(minimumEnd,end);
      leaseDays += (minimumMs+extraMs)/LEASE_DAY_MS;
      if (minimumMs || extraMs) costs[lease.currency] = (costs[lease.currency] ?? 0) + lease.minimumCost*minimumMs/(minimumEnd-start) + lease.hourPrice*extraMs/3_600_000;
    }
    return { leaseDays, costs };
  }
  summary(now = Date.now()) {
    const date = new Date(now), monthStart = Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1), monthEnd = Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1);
    // The month includes prepaid minimum time allocated to this month. Last
    // 30 days is a historical window ending now, excluding future paid time.
    return { month: this.between(monthStart,monthEnd,now), rolling30: this.between(now-30*LEASE_DAY_MS,now,now), held: this.held() };
  }
}
