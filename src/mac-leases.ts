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
export const MAC_CREDENTIAL_EXPIRIES_MIGRATION = `CREATE TABLE mac_credential_expiries (lease_id TEXT PRIMARY KEY REFERENCES mac_leases(id), expires_at TEXT, unknown_expiry INTEGER NOT NULL DEFAULT 0)`;
export const MAC_LEASE_END_EVIDENCE_MIGRATION = `ALTER TABLE mac_leases ADD COLUMN end_evidence TEXT NOT NULL DEFAULT 'legacy'`;
export const MAC_LEASE_ADOPTIONS_MIGRATION = `CREATE TABLE mac_lease_adoptions (lease_id TEXT PRIMARY KEY REFERENCES mac_leases(id), original TEXT NOT NULL, observed TEXT NOT NULL, evidence TEXT NOT NULL, adopted_at TEXT NOT NULL, current_ended_at TEXT, current_end_reason TEXT, current_end_evidence TEXT NOT NULL DEFAULT 'confirmed', current_notice_at TEXT, current_notice_text TEXT, current_kept INTEGER NOT NULL DEFAULT 0, current_release_at TEXT)`;
export const MAC_RELEASE_INTENTS_MIGRATION = `CREATE TABLE mac_release_intents (id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL)`;
export interface LegacyDeletedAdoptionProof { ledgerId:string; leaseId:string; sourceTaskId:string; startedAt:string; paidUntil:string; endedAt:string; failedAt:string; noReleaseRequested:true }
export interface LegacyDeletedAdoptionEvidence { revision: number; taskId: string; sourceTaskId: string; failureCause: "lease_unknown"; failedAt: string; observedAt: string; expectedEndedAt: string; operatorProof:LegacyDeletedAdoptionProof }
export interface MacLeaseAdoption { leaseId: string; original: MacLease; current: LeaseInput & {scheduledReleaseAt:string|null;physicalLeaseId:string}; evidence: LegacyDeletedAdoptionEvidence; adoptedAt: string; endedAt: string | null }
export interface MacCredentialNotice { id: string; provider: string; machineId: string; at: string; text: string; expiresAt: string | null }
export type MacWorkOutcome = "clean" | "shipped" | "discarded" | "unshipped" | "unknown";
export interface MacLease {
  id: string; provider: string; machineId: string; size: string; startedAt: string; paidUntil: string;
  billingIncrementSeconds?: number;
  minimumCost: number; hourPrice: number; currency: string; cpus: number; memoryMiB: number;
  endedAt: string | null; endReason: "handed back" | "deleted" | "failed" | null; noticeAt: string | null; noticeText: string | null;
  kept: boolean; releaseAt: string | null;
  endEvidence?: "legacy" | "inferred" | "confirmed";
}
export interface LeaseTask { leaseId: string; taskId: string; attachedAt: string; cpus: number; memoryMiB: number; workOutcome: MacWorkOutcome | null; workTurns: number | null }
export interface MacLeaseSnapshot { leases: MacLease[]; tasks: LeaseTask[] }
const iso = (at: number) => new Date(at).toISOString();
const RAW_LEASE_COLUMNS = `id, provider, machine_id AS machineId, size, started_at AS startedAt, paid_until AS paidUntil, minimum_cost AS minimumCost, hour_price AS hourPrice, currency, cpus, memory_mib AS memoryMiB, ended_at AS endedAt, end_reason AS endReason, notice_at AS noticeAt, notice_text AS noticeText, kept, release_at AS releaseAt, billing_increment_seconds AS billingIncrementSeconds, end_evidence AS endEvidence`;
const EFFECTIVE_FROM = `mac_leases LEFT JOIN mac_lease_adoptions adoption ON adoption.lease_id=mac_leases.id`;
const effective = (column: string) => `CASE WHEN adoption.lease_id IS NULL THEN ${column} ELSE adoption.current_${column} END`;
const LEASE_COLUMNS = RAW_LEASE_COLUMNS.replace(/\b(ended_at|end_reason|end_evidence|notice_at|notice_text|kept|release_at)\b/g, column => `${effective(column)}${column==="kept" ? " AS kept" : ""}`);
const EFFECTIVE_END = effective("ended_at");
const TASK_COLUMNS = `lease_id AS leaseId, task_id AS taskId, attached_at AS attachedAt, cpus, memory_mib AS memoryMiB, work_outcome AS workOutcome, work_turns AS workTurns`;
type LeaseInput = Omit<MacLease, "endedAt" | "endReason" | "noticeAt" | "noticeText" | "kept" | "releaseAt">;
export function validateMacLeaseTerms(lease: LeaseInput): void {
  const start = Date.parse(lease.startedAt), until = Date.parse(lease.paidUntil);
  if (!Number.isFinite(start) || !Number.isFinite(until) || until <= start || !Number.isFinite(lease.minimumCost) || lease.minimumCost < 0 || !Number.isFinite(lease.hourPrice) || lease.hourPrice < 0) throw new Error("Invalid Mac lease billing terms");
  const increment = lease.billingIncrementSeconds ?? 1;
  if (!Number.isInteger(increment) || increment < 1) throw new Error("Invalid Mac lease billing increment");
}
export class MacLeaseLedger {
  private readonly db: () => Database.Database;
  private observationRevision = 0;
  /** Fence reads dispatched before a local physical lease transition. */
  revision(): number { return this.observationRevision; }
  constructor(db: () => Database.Database) { this.db = db; }
  private rows(sql: string, args: string[] = []): MacLease[] {
    return (this.db().prepare(sql).all(...args) as (Omit<MacLease,"kept"> & { kept: number })[]).map(row => ({ ...row, kept: row.kept === 1 }));
  }
  rawList(): MacLease[] { return this.rows(`SELECT ${RAW_LEASE_COLUMNS} FROM mac_leases ORDER BY started_at`); }
  list(): MacLease[] { return this.rows(`SELECT ${LEASE_COLUMNS} FROM ${EFFECTIVE_FROM} ORDER BY started_at`); }
  adoptions(): MacLeaseAdoption[] {
    return (this.db().prepare(`SELECT lease_id AS leaseId,original,observed,evidence,adopted_at AS adoptedAt,current_ended_at AS endedAt FROM mac_lease_adoptions ORDER BY adopted_at`).all() as {leaseId:string;original:string;observed:string;evidence:string;adoptedAt:string;endedAt:string|null}[]).map(row=>({...row,original:JSON.parse(row.original) as MacLease,current:JSON.parse(row.observed) as LeaseInput & {scheduledReleaseAt:string|null;physicalLeaseId:string},evidence:JSON.parse(row.evidence) as LegacyDeletedAdoptionEvidence}));
  }
  /** Mutable state belongs to the overlay after explicit adoption. The raw
   * historical tombstone and its notice/release fields are never overwritten. */
  private state(id: string): {table:string;key:string;prefix:string} {
    return this.db().prepare(`SELECT 1 FROM mac_lease_adoptions WHERE lease_id=?`).get(id) ? {table:"mac_lease_adoptions",key:"lease_id",prefix:"current_"} : {table:"mac_leases",key:"id",prefix:""};
  }
  recordReleaseIntent(machineId: string, action: "stop" | "delete", now=Date.now()): void {
    if (!machineId || !["stop","delete"].includes(action)) throw new Error("Invalid Mac release intent");
    this.db().prepare(`INSERT INTO mac_release_intents (machine_id,action,at) VALUES (?,?,?)`).run(machineId,action,iso(now));
    this.observationRevision++;
  }
  releaseIntent(machineId: string): {action:"stop"|"delete";at:string}|null {
    return this.db().prepare(`SELECT action,at FROM mac_release_intents WHERE machine_id=? ORDER BY id DESC LIMIT 1`).get(machineId) as {action:"stop"|"delete";at:string}|undefined ?? null;
  }
  adoptLegacyDeleted(id: string, current: LeaseInput & {scheduledReleaseAt:string|null;physicalLeaseId:string}, evidence: LegacyDeletedAdoptionEvidence & {admit?:()=>boolean}): MacLease | null {
    if (evidence.revision !== this.observationRevision || evidence.failureCause !== "lease_unknown" || !evidence.taskId || !evidence.sourceTaskId || this.adoptions().some(row=>row.leaseId===id)) return null;
    validateMacLeaseTerms(current);
    const original = this.rawList().find(row=>row.id===id);
    if (!original || this.releaseIntent(original.machineId) || original.endEvidence!=="legacy" || original.endReason!=="deleted" || original.kept || !original.endedAt || original.endedAt!==evidence.expectedEndedAt || original.provider!=="instabox") return null;
    const proof=evidence.operatorProof;
    if (!proof || proof.noReleaseRequested!==true || proof.ledgerId!==id || proof.leaseId!==current.physicalLeaseId || proof.sourceTaskId!==evidence.sourceTaskId || proof.startedAt!==original.startedAt || proof.paidUntil!==original.paidUntil || proof.endedAt!==original.endedAt || proof.failedAt!==evidence.failedAt) return null;
    const start=Date.parse(original.startedAt), end=Date.parse(original.endedAt), paid=Date.parse(original.paidUntil), failed=Date.parse(evidence.failedAt), observed=Date.parse(evidence.observedAt);
    if (![start,end,paid,failed,observed].every(Number.isFinite) || failed<start || end<=failed || end-failed>10_000 || end>=paid || observed<end || observed>=paid || Math.abs(Date.now()-observed)>60_000) return null;
    const same=original.id===current.id && original.provider===current.provider && original.machineId===current.machineId && original.size===current.size && original.startedAt===current.startedAt && original.paidUntil===current.paidUntil && original.currency===current.currency && Math.abs(original.minimumCost-current.minimumCost)<1e-8 && Math.abs(original.hourPrice-current.hourPrice)<1e-8 && original.cpus===current.cpus && original.memoryMiB===current.memoryMiB && (original.billingIncrementSeconds ?? 1)===(current.billingIncrementSeconds ?? 1);
    if (!same || id!==`instabox:${current.physicalLeaseId}` || current.scheduledReleaseAt===null || current.scheduledReleaseAt!==original.paidUntil) return null;
    if (this.list().some(row=>row.id!==id && row.provider===original.provider && row.machineId===original.machineId && (!row.endedAt || Date.parse(row.startedAt)>=start))) return null;
    const notice=`Explicit recovery adopted the same provider-confirmed physical Mac lease after a legacy local deletion record. Original history is retained; no additional minimum was accepted. Recorded minimum ${original.currency} ${original.minimumCost.toFixed(2)}, paid until ${original.paidUntil}; provider scheduled release ${current.scheduledReleaseAt}. Historical deletion provenance remains unknown.`;
    const {admit,...audit}=evidence;
    this.db().exec("SAVEPOINT legacy_mac_adoption");
    try {
      this.db().prepare(`INSERT INTO mac_lease_adoptions (lease_id,original,observed,evidence,adopted_at,current_notice_at,current_notice_text,current_kept,current_release_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(id,JSON.stringify(original),JSON.stringify(current),JSON.stringify(audit),evidence.observedAt,evidence.observedAt,notice,original.kept?1:0,current.scheduledReleaseAt);
      if (admit && !admit()) { this.db().exec("ROLLBACK TO legacy_mac_adoption");this.db().exec("RELEASE legacy_mac_adoption");return null; }
      this.db().exec("RELEASE legacy_mac_adoption");
      this.observationRevision++;
      return this.held(original.machineId).find(row=>row.id===id)!;
    } catch (error) { this.db().exec("ROLLBACK TO legacy_mac_adoption");this.db().exec("RELEASE legacy_mac_adoption");throw error; }
  }
  held(machineId?: string): MacLease[] {
    return this.rows(`SELECT ${LEASE_COLUMNS} FROM ${EFFECTIVE_FROM} WHERE ${EFFECTIVE_END} IS NULL${machineId === undefined ? "" : " AND machine_id=?"} ORDER BY started_at`, machineId === undefined ? [] : [machineId]);
  }
  record(lease: Omit<MacLease, "endedAt" | "endReason" | "noticeAt" | "noticeText" | "kept" | "releaseAt">): MacLease {
    validateMacLeaseTerms(lease);
    const start = Date.parse(lease.startedAt), increment = lease.billingIncrementSeconds ?? 1;
    const existing = this.list().find(row => row.id === lease.id);
    if (existing && !existing.endedAt && (existing.machineId !== lease.machineId || existing.provider !== lease.provider || Date.parse(existing.startedAt) !== start)) throw new Error("Mac lease identity conflicts with another machine or physical lease");
    if (!existing && this.held(lease.machineId).some(row=>row.provider===lease.provider)) throw new Error("Mac already has an active physical lease");
    this.db().prepare(`INSERT INTO mac_leases (id,provider,machine_id,size,started_at,paid_until,minimum_cost,hour_price,currency,cpus,memory_mib,billing_increment_seconds)
      SELECT @id,@provider,@machineId,@size,@startedAt,@paidUntil,@minimumCost,@hourPrice,@currency,@cpus,@memoryMiB,@increment
      WHERE NOT EXISTS (SELECT 1 FROM mac_leases WHERE id=@id AND end_reason IS NOT NULL)
      ON CONFLICT(id) DO NOTHING`).run({ id: lease.id, provider: lease.provider, machineId: lease.machineId, size: lease.size, startedAt: lease.startedAt, paidUntil: lease.paidUntil, minimumCost: lease.minimumCost, hourPrice: lease.hourPrice, currency: lease.currency, cpus: lease.cpus, memoryMiB: lease.memoryMiB, increment });
    if (!existing) this.observationRevision++;
    return this.rows(`SELECT ${LEASE_COLUMNS} FROM ${EFFECTIVE_FROM} WHERE id=?`, [lease.id])[0]!;
  }
  /** An authoritative get may correct only an inferred end. A legacy end is
   * repairable only when its timestamp predates this physical allocation.
   * Keep the original row, attachments, minimum, credentials and release plan. */
  restoreCurrent(lease: Omit<MacLease, "endedAt" | "endReason" | "noticeAt" | "noticeText" | "kept" | "releaseAt">, observation: {revision: number; allowLegacy?: boolean}): MacLease | null {
    if (observation.revision !== this.observationRevision) return null;
    validateMacLeaseTerms(lease);
    const history = this.list();
    if (history.some(row => row.id !== lease.id && row.provider === lease.provider && row.machineId === lease.machineId && Date.parse(row.startedAt) >= Date.parse(lease.startedAt))) return null;
    const existing = history.find(row => row.id === lease.id);
    if (!existing) return this.record(lease);
    const same = existing.provider === lease.provider && existing.machineId === lease.machineId && existing.size === lease.size && Date.parse(existing.startedAt) === Date.parse(lease.startedAt) && Date.parse(existing.paidUntil) === Date.parse(lease.paidUntil) && existing.currency === lease.currency && Math.abs(existing.minimumCost - lease.minimumCost) < 1e-8 && Math.abs(existing.hourPrice - lease.hourPrice) < 1e-8 && existing.cpus === lease.cpus && existing.memoryMiB === lease.memoryMiB;
    if (!same) return null;
    if (!existing.endedAt) return existing;
    const impossibleLegacyEnd = observation.allowLegacy && existing.endEvidence === "legacy" && Date.parse(existing.endedAt) < Date.parse(existing.startedAt);
    if (existing.endEvidence !== "inferred" && !impossibleLegacyEnd) return null;
    const {table,key,prefix:p}=this.state(lease.id);
    this.db().prepare(`UPDATE ${table} SET ${p}ended_at=NULL,${p}end_reason=NULL,${p}end_evidence='legacy',${p}notice_text=NULL WHERE ${key}=?`).run(lease.id);
    this.observationRevision++;
    return this.list().find(row => row.id === lease.id)!;
  }
  observeCurrent(lease: LeaseInput, revision: number): MacLease | null {
    if (revision !== this.observationRevision) return null;
    validateMacLeaseTerms(lease);
    const history = this.list().filter(row => row.machineId === lease.machineId && row.provider === lease.provider && row.id !== lease.id);
    if (history.some(row => Date.parse(row.startedAt) >= Date.parse(lease.startedAt))) return null;
    const held = history.filter(row => !row.endedAt);
    const priorRevision = this.observationRevision;
    this.db().exec("SAVEPOINT current_mac_lease");
    try {
      for (const old of held) this.end(old.id, "handed back", Date.parse(lease.startedAt));
      const current = this.restoreCurrent(lease, {revision: this.observationRevision});
      if (!current) { this.db().exec("ROLLBACK TO current_mac_lease"); this.observationRevision = priorRevision; }
      this.db().exec("RELEASE current_mac_lease");
      return current;
    } catch (error) {
      this.db().exec("ROLLBACK TO current_mac_lease"); this.db().exec("RELEASE current_mac_lease"); this.observationRevision = priorRevision;
      throw error;
    }
  }
  /** A current provider lease contradicts a terminal local row. Surface the
   * discrepancy without claiming either billing stopped or a safe revival. */
  observeDiscrepancy(id: string, text: string, now = Date.now()): void {
    const {table,key,prefix:p}=this.state(id);
    this.db().prepare(`UPDATE ${table} SET ${p}notice_at=?,${p}notice_text=? WHERE ${key}=?`).run(iso(now),text,id);
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
  end(id: string, reason: NonNullable<MacLease["endReason"]>, now = Date.now(), evidence: "confirmed" | "inferred" = "confirmed"): void {
    const {table,key,prefix:p}=this.state(id);
    if (this.db().prepare(`UPDATE ${table} SET ${p}ended_at=?,${p}end_reason=?,${p}end_evidence=?,${p}notice_text=NULL WHERE ${key}=? AND (${p}ended_at IS NULL OR (${p}end_evidence='inferred' AND ?='confirmed'))`).run(iso(now), reason, evidence, id, evidence).changes) this.observationRevision++;
  }
  clearNotice(id: string): boolean { const {table,key,prefix:p}=this.state(id);return this.db().prepare(`UPDATE ${table} SET ${p}notice_text=NULL WHERE ${key}=? AND ${p}notice_text IS NOT NULL`).run(id).changes>0; }
  keep(id: string): void { const {table,key,prefix:p}=this.state(id);this.db().prepare(`UPDATE ${table} SET ${p}kept=1 WHERE ${key}=? AND ${p}ended_at IS NULL`).run(id); }
  schedule(id: string, at: string | null): void { const {table,key,prefix:p}=this.state(id);this.db().prepare(`UPDATE ${table} SET ${p}release_at=? WHERE ${key}=? AND ${p}ended_at IS NULL`).run(at,id); }
  /** A minimum-end heads-up, then at most one reminder per 24 h. Persist
   * before delivery so a restart cannot duplicate the same reminder. */
  warn(id: string, now = Date.now(), repeat = false, pageText: string | null = null, immediate = false): boolean {
    const {table,key,prefix:p}=this.state(id);
    if (pageText !== null) this.db().prepare(`UPDATE ${table} SET ${p}notice_text=? WHERE ${key}=? AND ${p}ended_at IS NULL`).run(pageText,id);
    return this.db().prepare(`UPDATE ${table} SET ${p}notice_at=?,${p}notice_text=COALESCE(?,${p}notice_text) WHERE ${key}=? AND ${p}ended_at IS NULL AND (?=1 OR ${p}notice_at IS NULL OR (?=1 AND ${p}notice_at<=?))`).run(iso(now),pageText,id,immediate ? 1 : 0,repeat ? 1 : 0,iso(now-LEASE_DAY_MS)).changes > 0;
  }
  /** Record before stdin can reach a machine, including uncertain deliveries.
   * Rotation cannot shorten the lifetime of an older potentially exposed token. */
  recordGithubDelivery(id: string, expiresAt: string): void {
    if (!Number.isFinite(Date.parse(expiresAt))) throw new Error("Invalid GitHub token expiry");
    this.db().prepare(`INSERT INTO mac_credential_expiries (lease_id,expires_at) VALUES (?,?) ON CONFLICT(lease_id) DO UPDATE SET expires_at=MAX(COALESCE(expires_at,excluded.expires_at),excluded.expires_at)`).run(id,iso(Date.parse(expiresAt)));
  }
  hasGithubDeliveryRecord(id: string): boolean { return Boolean(this.db().prepare(`SELECT 1 FROM mac_credential_expiries WHERE lease_id=?`).get(id)); }
  recordUnknownGithubExpiry(id: string): void {
    this.db().prepare(`INSERT INTO mac_credential_expiries (lease_id,unknown_expiry) VALUES (?,1) ON CONFLICT(lease_id) DO UPDATE SET unknown_expiry=1`).run(id);
  }
  /** Independent of lease state: compute release and settings writes cannot clear it. */
  recordCredentialNotice(id: string, text: string, now = Date.now()): void {
    this.db().prepare(`INSERT INTO mac_credential_notices (lease_id,created_at,text) VALUES (?,?,?) ON CONFLICT(lease_id) DO UPDATE SET text=excluded.text`).run(id,iso(now),text);
  }
  credentialNotices(now = Date.now()): MacCredentialNotice[] {
    // Ignore the retired dismissed_at field, including reminders dismissed by
    // older versions. Only recorded expiry can make an exposure reminder safe.
    return this.db().prepare(`SELECT 'token-revocation:' || n.lease_id AS id,l.provider,l.machine_id AS machineId,n.created_at AS at,n.text,CASE WHEN e.unknown_expiry=1 THEN NULL ELSE e.expires_at END AS expiresAt FROM mac_credential_notices n JOIN mac_leases l ON l.id=n.lease_id LEFT JOIN mac_credential_expiries e ON e.lease_id=n.lease_id WHERE e.unknown_expiry=1 OR e.expires_at IS NULL OR e.expires_at>? ORDER BY n.created_at,n.lease_id`).all(iso(now)) as MacCredentialNotice[];
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
      this.end(lease.id, scheduled ? "handed back" : "deleted", scheduled ? Date.parse(lease.releaseAt!) : now, "inferred");
    }
  }
  /** Billable time includes the entire committed minimum, even after an early
   * deletion. Allocate that minimum uniformly across its actual interval;
   * subsequent time uses the provider's hourPrice, with no rounding to days. */
  between(from: number, until: number, now = Date.now(), machineId?: string, provider?: string, currency?: string) {
    let leaseDays = 0; const costs: Record<string, number> = {};
    const overlap = (start: number, end: number) => Math.max(0, Math.min(end,until)-Math.max(start,from));
    for (const lease of this.list()) {
      if (machineId && lease.machineId !== machineId) continue;
      if (provider && lease.provider !== provider) continue;
      if (currency && lease.currency !== currency) continue;
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
