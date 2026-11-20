// Provider-neutral lease billing: a fixed paid minimum, then an hourly rate
// prorated by elapsed time, or rounded to the provider billing increment.
// The minimum end never advances locally.
import type Database from "better-sqlite3";
export const LEASE_DAY_MS = 24 * 60 * 60 * 1000;
// Base schema from Instabox Mac leases. Append upgrades in TaskStore.migrations
// after the existing task-system migration to preserve its ordering.
export const MAC_LEASE_MIGRATIONS = [
  `CREATE TABLE mac_leases (id TEXT PRIMARY KEY, provider TEXT NOT NULL, machine_id TEXT NOT NULL, size TEXT NOT NULL, started_at TEXT NOT NULL, paid_until TEXT NOT NULL, minimum_cost REAL NOT NULL, hour_price REAL NOT NULL, currency TEXT NOT NULL, cpus INTEGER NOT NULL, memory_mib INTEGER NOT NULL, ended_at TEXT, end_reason TEXT, notice_at TEXT, notice_text TEXT, kept INTEGER NOT NULL DEFAULT 0, release_at TEXT)`,
  `CREATE UNIQUE INDEX mac_leases_held ON mac_leases(provider, machine_id) WHERE ended_at IS NULL`,
  `CREATE TABLE mac_lease_tasks (lease_id TEXT NOT NULL REFERENCES mac_leases(id), task_id TEXT NOT NULL, attached_at TEXT NOT NULL, cpus INTEGER NOT NULL, memory_mib INTEGER NOT NULL, work_outcome TEXT, work_turns INTEGER, PRIMARY KEY(lease_id, task_id))`,
  `CREATE INDEX mac_lease_tasks_task ON mac_lease_tasks(task_id)`,
];
// Appended separately in TaskStore.migrations so prior migration indexes stay stable.
export const MAC_CREDENTIAL_NOTICES_MIGRATION = `CREATE TABLE mac_credential_notices (lease_id TEXT PRIMARY KEY REFERENCES mac_leases(id), created_at TEXT NOT NULL, text TEXT NOT NULL, dismissed_at TEXT)`;
export interface MacCredentialNotice { id: string; provider: string; machineId: string; at: string; text: string }
export type MacWorkOutcome = "clean" | "shipped" | "discarded" | "unshipped" | "unknown";
export interface MacLease {
  id: string; provider: string; machineId: string; size: string; startedAt: string; paidUntil: string;
  billingIncrementSeconds?: number;
  minimumCost: number; hourPrice: number; currency: string; cpus: number; memoryMiB: number;
  endedAt: string | null; endReason: "handed back" | "deleted" | "failed" | null; noticeAt: string | null; noticeText: string | null;
  kept: boolean; releaseAt: string | null;
}
export interface LeaseTask { leaseId: string; taskId: string; attachedAt: string; cpus: number; memoryMiB: number; workOutcome: MacWorkOutcome | null; workTurns: number | null }
export interface MacLeaseSnapshot { leases: MacLease[]; tasks: LeaseTask[] }
const iso = (at: number) => new Date(at).toISOString();
const LEASE_COLUMNS = `id, provider, machine_id AS machineId, size, started_at AS startedAt, paid_until AS paidUntil, minimum_cost AS minimumCost, hour_price AS hourPrice, currency, cpus, memory_mib AS memoryMiB, ended_at AS endedAt, end_reason AS endReason, notice_at AS noticeAt, notice_text AS noticeText, kept, release_at AS releaseAt, billing_increment_seconds AS billingIncrementSeconds`;
const TASK_COLUMNS = `lease_id AS leaseId, task_id AS taskId, attached_at AS attachedAt, cpus, memory_mib AS memoryMiB, work_outcome AS workOutcome, work_turns AS workTurns`;
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
  record(lease: Omit<MacLease, "endedAt" | "endReason" | "noticeAt" | "noticeText" | "kept" | "releaseAt">): MacLease {
    const start = Date.parse(lease.startedAt), until = Date.parse(lease.paidUntil);
    if (!Number.isFinite(start) || !Number.isFinite(until) || until <= start || !Number.isFinite(lease.minimumCost) || lease.minimumCost < 0 || !Number.isFinite(lease.hourPrice) || lease.hourPrice < 0) throw new Error("Invalid Mac lease billing terms");
    const increment = lease.billingIncrementSeconds ?? 1;
    if (!Number.isInteger(increment) || increment < 1) throw new Error("Invalid Mac lease billing increment");
    this.db().prepare(`INSERT INTO mac_leases (id,provider,machine_id,size,started_at,paid_until,minimum_cost,hour_price,currency,cpus,memory_mib,billing_increment_seconds)
      SELECT @id,@provider,@machineId,@size,@startedAt,@paidUntil,@minimumCost,@hourPrice,@currency,@cpus,@memoryMiB,@increment
      WHERE NOT EXISTS (SELECT 1 FROM mac_leases WHERE id=@id AND end_reason IS NOT NULL)
      ON CONFLICT(id) DO UPDATE SET machine_id=excluded.machine_id
      WHERE mac_leases.ended_at IS NULL AND mac_leases.end_reason IS NULL AND mac_leases.provider=excluded.provider AND mac_leases.started_at=excluded.started_at`).run({ id: lease.id, provider: lease.provider, machineId: lease.machineId, size: lease.size, startedAt: lease.startedAt, paidUntil: lease.paidUntil, minimumCost: lease.minimumCost, hourPrice: lease.hourPrice, currency: lease.currency, cpus: lease.cpus, memoryMiB: lease.memoryMiB, increment });
    return this.rows(`SELECT ${LEASE_COLUMNS} FROM mac_leases WHERE id=?`, [lease.id])[0]!;
  }
  tasks(id: string): LeaseTask[] { return this.db().prepare(`SELECT ${TASK_COLUMNS} FROM mac_lease_tasks WHERE lease_id=? ORDER BY attached_at,task_id`).all(id) as LeaseTask[]; }
  /** Two reads per view, independent of task/lease count. No per-task queries. */
  snapshot(): MacLeaseSnapshot {
    return { leases: this.list(), tasks: this.db().prepare(`SELECT ${TASK_COLUMNS} FROM mac_lease_tasks ORDER BY attached_at,task_id`).all() as LeaseTask[] };
  }
  attach(id: string, taskId: string, cpus: number, memoryMiB: number, now = Date.now()): void {
    this.db().prepare(`INSERT OR IGNORE INTO mac_lease_tasks (lease_id,task_id,attached_at,cpus,memory_mib) VALUES (?,?,?,?,?)`).run(id, taskId, iso(now), cpus, memoryMiB);
  }
  resolveTask(leaseId: string, taskId: string, outcome: MacWorkOutcome, turns: number): void {
    this.db().prepare(`UPDATE mac_lease_tasks SET work_outcome=?,work_turns=? WHERE lease_id=? AND task_id=?`).run(outcome,turns,leaseId,taskId);
  }
  end(id: string, reason: NonNullable<MacLease["endReason"]>, now = Date.now()): void {
    this.db().prepare(`UPDATE mac_leases SET ended_at=?,end_reason=?,notice_text=NULL WHERE id=? AND ended_at IS NULL`).run(iso(now), reason, id);
  }
  clearNotice(id: string): boolean { return this.db().prepare(`UPDATE mac_leases SET notice_text=NULL WHERE id=? AND notice_text IS NOT NULL`).run(id).changes>0; }
  keep(id: string): void { this.db().prepare(`UPDATE mac_leases SET kept=1 WHERE id=? AND ended_at IS NULL`).run(id); }
  schedule(id: string, at: string | null): void { this.db().prepare(`UPDATE mac_leases SET release_at=? WHERE id=? AND ended_at IS NULL`).run(at,id); }
  /** A minimum-end heads-up, then at most one reminder per 24 h. Persist
   * before delivery so a restart cannot duplicate the same reminder. */
  warn(id: string, now = Date.now(), repeat = false, pageText: string | null = null, immediate = false): boolean {
    if (pageText !== null) this.db().prepare(`UPDATE mac_leases SET notice_text=? WHERE id=? AND ended_at IS NULL`).run(pageText,id);
    return this.db().prepare(`UPDATE mac_leases SET notice_at=?,notice_text=COALESCE(?,notice_text) WHERE id=? AND ended_at IS NULL AND (?=1 OR notice_at IS NULL OR (?=1 AND notice_at<=?))`).run(iso(now),pageText,id,immediate ? 1 : 0,repeat ? 1 : 0,iso(now-LEASE_DAY_MS)).changes > 0;
  }
  /** Independent of lease state: ending/reconciling compute must not dismiss a token reminder. */
  recordCredentialNotice(id: string, text: string, now = Date.now()): void {
    this.db().prepare(`INSERT INTO mac_credential_notices (lease_id,created_at,text) VALUES (?,?,?) ON CONFLICT(lease_id) DO UPDATE SET text=excluded.text,dismissed_at=NULL`).run(id,iso(now),text);
  }
  credentialNotices(): MacCredentialNotice[] {
    return this.db().prepare(`SELECT 'token-revocation:' || n.lease_id AS id,l.provider,l.machine_id AS machineId,n.created_at AS at,n.text FROM mac_credential_notices n JOIN mac_leases l ON l.id=n.lease_id WHERE n.dismissed_at IS NULL ORDER BY n.created_at,n.lease_id`).all() as MacCredentialNotice[];
  }
  dismissCredentialNotice(id: string, now = Date.now()): boolean {
    if (!id.startsWith("token-revocation:")) return false;
    const leaseId = id.slice("token-revocation:".length);
    return this.db().prepare(`UPDATE mac_credential_notices SET dismissed_at=? WHERE lease_id=? AND dismissed_at IS NULL`).run(iso(now),leaseId).changes > 0;
  }
  private billableEnd(lease: MacLease, now: number): number {
    const minimumEnd = Date.parse(lease.paidUntil);
    const elapsedEnd = Math.max(minimumEnd, Math.min(now, lease.endedAt ? Date.parse(lease.endedAt) : now));
    const incrementMs = (lease.billingIncrementSeconds ?? 1)*1000;
    return incrementMs > 1000 ? minimumEnd + Math.ceil((elapsedEnd-minimumEnd)/incrementMs)*incrementMs : elapsedEnd;
  }
  cost(lease: MacLease, now = Date.now()): number {
    return lease.minimumCost + lease.hourPrice*(this.billableEnd(lease,now)-Date.parse(lease.paidUntil))/3_600_000;
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
  between(from: number, until: number, now = Date.now(), machineId?: string, provider?: string) {
    let leaseDays = 0; const costs: Record<string, number> = {};
    const overlap = (start: number, end: number) => Math.max(0, Math.min(end,until)-Math.max(start,from));
    for (const lease of this.list()) {
      if (machineId && lease.machineId !== machineId) continue;
      if (provider && lease.provider !== provider) continue;
      const start = Date.parse(lease.startedAt), minimumEnd = Date.parse(lease.paidUntil);
      const end = this.billableEnd(lease,now);
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
    const providers = [...new Set(this.list().filter(lease => Date.parse(lease.startedAt)<monthEnd && Math.max(Date.parse(lease.paidUntil),lease.endedAt ? Date.parse(lease.endedAt) : now)>monthStart).map(lease=>lease.provider))];
    return { month: this.between(monthStart,monthEnd,now), rolling30: this.between(now-30*LEASE_DAY_MS,now,now), held: this.held(), providers };
  }
}
