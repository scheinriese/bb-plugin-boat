// Persisted Mac day windows. These are conservative cost estimates: Instabox's
// current docs bill per second after the first 24 h, rather than selling renewals.
import type Database from "better-sqlite3";
export const LEASE_DAY_MS = 24 * 60 * 60 * 1000;
export const MAC_LEASE_MIGRATIONS = [
  `CREATE TABLE mac_leases (id TEXT PRIMARY KEY, provider TEXT NOT NULL, machine_id TEXT NOT NULL, size TEXT NOT NULL, started_at TEXT NOT NULL, paid_until TEXT NOT NULL, day_price REAL NOT NULL, currency TEXT NOT NULL, cpus INTEGER NOT NULL, memory_mib INTEGER NOT NULL, ended_at TEXT, end_reason TEXT, warned_until TEXT)`,
  `CREATE UNIQUE INDEX mac_leases_held ON mac_leases(provider, machine_id) WHERE ended_at IS NULL`,
  `CREATE TABLE mac_lease_tasks (lease_id TEXT NOT NULL REFERENCES mac_leases(id), task_id TEXT NOT NULL, attached_at TEXT NOT NULL, cpus INTEGER NOT NULL, memory_mib INTEGER NOT NULL, PRIMARY KEY(lease_id, task_id))`,
];
export interface MacLease {
  id: string; provider: string; machineId: string; size: string; startedAt: string; paidUntil: string;
  dayPrice: number; currency: string; cpus: number; memoryMiB: number;
  endedAt: string | null; endReason: "handed back" | "deleted" | "failed" | null; warnedUntil: string | null;
}
export interface LeaseTask { taskId: string; attachedAt: string; cpus: number; memoryMiB: number }
const iso = (at: number) => new Date(at).toISOString();
export class MacLeaseLedger {
  private readonly db: () => Database.Database;
  constructor(db: () => Database.Database) { this.db = db; }
  list(): MacLease[] {
    return (this.db().prepare(`SELECT id, provider, machine_id AS machineId, size, started_at AS startedAt, paid_until AS paidUntil, day_price AS dayPrice, currency, cpus, memory_mib AS memoryMiB, ended_at AS endedAt, end_reason AS endReason, warned_until AS warnedUntil FROM mac_leases ORDER BY started_at`).all() as MacLease[]);
  }
  held(machineId?: string): MacLease[] { return this.list().filter(l => !l.endedAt && (machineId === undefined || l.machineId === machineId)); }
  record(lease: Omit<MacLease, "endedAt" | "endReason" | "warnedUntil">): MacLease {
    this.db().prepare(`INSERT OR IGNORE INTO mac_leases VALUES (@id,@provider,@machineId,@size,@startedAt,@paidUntil,@dayPrice,@currency,@cpus,@memoryMiB,NULL,NULL,NULL)
      ON CONFLICT(id) DO UPDATE SET machine_id=excluded.machine_id, ended_at=NULL, end_reason=NULL
      WHERE mac_leases.provider=excluded.provider AND mac_leases.started_at=excluded.started_at`).run({ id: lease.id, provider: lease.provider, machineId: lease.machineId, size: lease.size, startedAt: lease.startedAt, paidUntil: lease.paidUntil, dayPrice: lease.dayPrice, currency: lease.currency, cpus: lease.cpus, memoryMiB: lease.memoryMiB });
    return this.held(lease.machineId)[0] ?? this.list().find(l => l.id === lease.id)!;
  }
  tasks(id: string): LeaseTask[] { return this.db().prepare(`SELECT task_id AS taskId, attached_at AS attachedAt, cpus, memory_mib AS memoryMiB FROM mac_lease_tasks WHERE lease_id=? ORDER BY attached_at,task_id`).all(id) as LeaseTask[]; }
  attach(id: string, taskId: string, cpus: number, memoryMiB: number, now = Date.now()): void {
    this.db().prepare(`INSERT OR IGNORE INTO mac_lease_tasks VALUES (?,?,?,?,?)`).run(id, taskId, iso(now), cpus, memoryMiB);
  }
  end(id: string, reason: NonNullable<MacLease["endReason"]>, now = Date.now()): void {
    this.db().prepare(`UPDATE mac_leases SET ended_at=?,end_reason=? WHERE id=? AND (ended_at IS NULL OR ?='handed back')`).run(iso(now), reason, id, reason);
  }
  renew(id: string, now = Date.now()): void {
    const lease = this.held().find(l => l.id === id);
    if (!lease || now < Date.parse(lease.paidUntil)) return;
    const until = Date.parse(lease.paidUntil);
    this.db().prepare(`UPDATE mac_leases SET paid_until=? WHERE id=? AND ended_at IS NULL`).run(iso(until + (Math.floor((now-until)/LEASE_DAY_MS)+1)*LEASE_DAY_MS), id);
  }
  warn(id: string, until: string): boolean {
    return this.db().prepare(`UPDATE mac_leases SET warned_until=? WHERE id=? AND ended_at IS NULL AND (warned_until IS NULL OR warned_until<>?)`).run(until,id,until).changes > 0;
  }
  reconcile(provider: string, machineIds: ReadonlySet<string>, now = Date.now()): void {
    for (const lease of this.held()) if (lease.provider === provider) {
      if (!machineIds.has(lease.machineId)) this.end(lease.id, "deleted", now);
      else this.renew(lease.id, now);
    }
  }
  /** Charge each started 24 h window to its start's month. Never multiply by task count. */
  between(from: number, until: number, now = Date.now(), machineId?: string) {
    let leaseDays = 0; const costs: Record<string, number> = {};
    for (const lease of this.list()) {
      if (machineId && lease.machineId !== machineId) continue;
      const end = Math.min(until, now + 1, lease.endedAt ? Date.parse(lease.endedAt) : Infinity);
      for (let day = Date.parse(lease.startedAt); day < end; day += LEASE_DAY_MS) if (day >= from) {
        leaseDays++; costs[lease.currency] = (costs[lease.currency] ?? 0) + lease.dayPrice;
      }
    }
    return { leaseDays, costs };
  }
  summary(now = Date.now()) {
    const date = new Date(now);
    return { month: this.between(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1),now+1,now), rolling30: this.between(now-30*LEASE_DAY_MS,now+1,now), held: this.held() };
  }
}
