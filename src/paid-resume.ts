// Chats that stopped at a usage limit continue on paid Claude once Boat's
// automatic paid Claude fallback is available: the same check a start makes
// (relay.ts subscriptionRoom, so automaticPaidClaude: the fallback on, a fresh
// "allowed" extra-usage reading, both agents at Switch at, no hold from a
// refused turn). Any Claude Code chat on this bb, not only Boat tasks; headless
// Boat tasks too, with the headless opt-in.
//
// What bb offers (read from bb 0.50.1: its built-in provider-retry plugin and core):
// - provider-retry queues a retry of a failed turn as an ordinary queued row
//   (payload.kind "retry"). `bb provider-retry retry` sends it now with
//   threads.queuedMessages.send({ mode: "auto" }); so does this.
// - Its RPC decision.get { threadId } is the last decision it recorded for the
//   thread's failed request: retry (with sendAt) or decline (beyond-maximum-wait,
//   not-resettable, …). A plugin that re-runs failed work waits up to a minute
//   for that decision, then re-runs only when no retry is queued.
// - With no pending row, core's threads.retry({ threadId, turnRequestId, reason })
//   (`bb thread retry`) re-submits the failed turn. It needs the thread in error.
// - A retry's request keeps the first request of its chain (retryOfRequestId), so
//   "one resume per stopped turn" holds across retries that fail again.
// A reply this bb doesn't answer the way 0.50.1 does reads as "unknown": the
// chat is skipped, never retried on a guess.
//
// Pacing: a burst of wakes overloads boat.dev (its start limit, its snapshot
// storage). Every attempt counts toward RESUME_CAP and waits RESUME_STAGGER_MS
// after the last one; a failure ends the pass and backs off (5 min, doubling to
// an hour, kept across restarts). A machine that is starting, stopping or
// failed is left alone (only that one: an old failure on one machine never
// holds the others); waking a suspended one takes a token from the wake
// budget the watchdog shares (src/wake-budget.ts: 2 a minute). A wake this
// plugin made that failed, at once or found failed when a later pass looks
// at the machines it woke, holds every wake (the budget's hold, which the
// watchdog's failed resumes set too). One headless follow-up a pass.
import type Database from "better-sqlite3";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ACTIVE_STATES } from "./boat-api.ts";
import type { MachineState } from "./chat.ts";
import { USAGE_LIMIT_TEXT } from "./limits.ts";
import type { BoatProject } from "./projects.ts";
import type { Quotas } from "./quota.ts";
import { isBusy, subscriptionRoom, type SubscriptionRoom } from "./relay.ts";
import { TaskError, type BoatSettings } from "./service.ts";
import type { TurnEventRow } from "./steer-retry.ts";
import type { Task } from "./store.ts";
import { WAKE_FAILURE_HOLD_MS, type WakeBudget } from "./wake-budget.ts";

/** At most this many attempts per pass (failed ones count too); the rest wait for the next pass. */
export const RESUME_CAP = 10;
/** Pause before every attempt after the first, so a pool of chats doesn't wake at once. */
export const RESUME_STAGGER_MS = 3_000;
/** At most this many headless follow-ups a pass (each may resume a sandbox, waiting up to two minutes). */
export const HEADLESS_PER_PASS = 1;
/** Tries per stopped turn: a failure that may have reached nothing is tried again after the backoff. */
export const MAX_ATTEMPTS = 3;
/** After a failed attempt the pass waits this long, doubling with each failure in a row… */
export const BACKOFF_FIRST_MS = 5 * 60_000;
/** …up to this. */
export const BACKOFF_MAX_MS = 60 * 60_000;
/**
 * After a wake fails, no machine is woken for this long (the budget's hold).
 * The machines a pass woke are looked at again for this long.
 */
export const WAKE_HOLD_MS = WAKE_FAILURE_HOLD_MS;
/** A chat's try still "claimed" after this long was cut off (a restart): it counts, and may go again. */
export const CLAIM_TTL_MS = 10 * 60_000;
/** provider-retry records its decision right after a failure: wait this long for it before a core retry. */
export const DECISION_WAIT_MS = 60_000;
/** A pending provider retry due this soon is left alone: it may still run on included usage. */
export const PENDING_SOON_MS = 10 * 60_000;
/** A stop older than this is forgotten. */
export const STOP_TTL_MS = 7 * 86_400_000;
/** The usage view counts resumes this recent. */
export const RECENT_RESUMES_MS = 86_400_000;
/** bb's agent provider id for Claude Code. */
export const CLAUDE_CODE = "claude-code";
/** Shown on the retry's queued row (bb shows the reason verbatim). */
export const RESUME_REASON = "Paid Claude is available: continuing after a usage limit";
/** The follow-up a headless task gets. */
export const HEADLESS_RESUME_TEXT =
  "[boat] Your last turn stopped at a Claude usage limit. Paid Claude extra usage is available now: continue where you stopped.";
/** The task event kind (task history and `bb boat task show`). */
export const RESUME_EVENT = "paid-resume";
/** A reply bb gave in a shape this version doesn't know (nothing is guessed from it). */
export const UNKNOWN = "unknown" as const;

// ---------------------------------------------------------------- the failure

/** What a failed request says about itself. */
export interface FailureFacts {
  /** provider/error errorInfo.category, or the rejection's reason as bb maps it. */
  category: string | null;
  httpStatusCode: number | null;
  /** The chat provider's latest rate-limit snapshot. */
  rateLimits: { kind: string | null; status: string | null } | null;
  /** The failure's own words: provider/error message, a rejection's message. */
  texts: readonly (string | null | undefined)[];
}

export type FailureKind = { kind: "usage-limit" } | { kind: "other"; why: string };

/** Refusals that a wait or a paid turn doesn't fix: credits, a spend cap, extra usage off or used up, billing. */
const REFUSED_TEXT =
  /out of credits|credit balance|out of extra usage|extra usage (?:is )?(?:not enabled|disabled|off|unavailable|rejected)|spend(?:ing)?[ -]?(?:limit|cap|control)|billing|budget/i;
const REFUSED_CATEGORIES: Record<string, string> = {
  unauthorized: "an authentication failure",
  billing: "a billing refusal",
  "budget-exceeded": "a spend limit",
  policy: "a policy refusal",
};

/**
 * A subscription or usage-limit 429, and not a refusal provider-retry never
 * retries either (authentication, credits, a spend limit).
 */
export function classifyFailure(facts: FailureFacts): FailureKind {
  const refused = facts.category === null ? undefined : REFUSED_CATEGORIES[facts.category];
  if (refused !== undefined) return { kind: "other", why: refused };
  const texts = facts.texts.filter((text): text is string => typeof text === "string" && text.trim() !== "");
  if (texts.some((text) => REFUSED_TEXT.test(text))) return { kind: "other", why: "a credit or spend limit" };
  const limits = facts.rateLimits;
  if (limits?.status === "blocked" && (limits.kind === "credits" || limits.kind === "spend-control")) return { kind: "other", why: "a credit or spend limit" };
  if (facts.category !== "rate-limit" && facts.httpStatusCode !== 429) return { kind: "other", why: facts.category ? `a ${facts.category} failure` : "an error that isn't a usage limit" };
  return { kind: "usage-limit" };
}

/** A headless task's error text: a usage limit, not a refusal. */
export function headlessUsageLimit(text: string | null | undefined): boolean {
  if (!text) return false;
  return !REFUSED_TEXT.test(text) && (USAGE_LIMIT_TEXT.test(text) || /\b429\b|rate[ -]?limit/i.test(text));
}

/** bb's thread events the reading needs (bb.sdk.threads.events.list `types`). */
export const STOP_EVENT_TYPES = [
  "client/turn/requested",
  "client/thread/start",
  "client/turn/start",
  "client/turn/rejected",
  "provider/error",
  "provider/rateLimits/updated",
] as const;
const REQUEST_TYPES = new Set(["client/turn/requested", "client/thread/start", "client/turn/start"]);

/** The chat's latest request and how it failed. */
export interface StoppedTurn {
  /** The failed attempt: threads.retry's turnRequestId. */
  requestId: string;
  /** The request its retry chain started from: one resume per stopped turn. */
  rootRequestId: string;
  /** When it failed (epoch ms; null: unknown). */
  failedAt: number | null;
  failure: FailureKind;
}

function data(row: TurnEventRow): Record<string, unknown> {
  return row.data !== null && typeof row.data === "object" ? row.data : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Read the latest request and its failure the way bb's turn.failed does: the
 * last request event, the provider/error after it (else a door rejection of
 * it), and the provider's latest rate-limit snapshot. Null: no request.
 */
export function readStoppedTurn(rows: readonly TurnEventRow[]): StoppedTurn | null {
  const events = rows.filter((row) => Number.isSafeInteger(row.seq)).sort((a, b) => a.seq - b.seq);
  const request = events.filter((row) => REQUEST_TYPES.has(row.type) && text(data(row).requestId) !== null).at(-1);
  if (request === undefined) return null;
  const requestId = text(data(request).requestId)!;
  const rootRequestId = text(data(request).retryOfRequestId) ?? requestId;
  const after = events.filter((row) => row.seq > request.seq);
  const error = after.filter((row) => row.type === "provider/error" && data(row).willRetry !== true).at(-1);
  const rejected = after.find((row) => row.type === "client/turn/rejected" && data(row).requestId === requestId);
  const limitsRow = events.filter((row) => row.type === "provider/rateLimits/updated").at(-1);
  const limits = limitsRow === undefined ? null : data(limitsRow).rateLimits;
  const rateLimits =
    limits !== null && typeof limits === "object"
      ? { kind: text((limits as { kind?: unknown }).kind), status: text((limits as { status?: unknown }).status) }
      : null;
  const failed = error ?? rejected;
  if (failed === undefined) return { requestId, rootRequestId, failedAt: null, failure: { kind: "other", why: "no provider error" } };
  const info = error !== undefined && data(error).errorInfo !== null && typeof data(error).errorInfo === "object" ? (data(error).errorInfo as Record<string, unknown>) : {};
  const reason = rejected === undefined ? null : text(data(rejected).reason);
  // bb's own mapping of a door rejection (doorRejectionErrorInfo).
  const category = text(info.category) ?? (reason === "rate_limited" ? "rate-limit" : reason === "auth_required" ? "unauthorized" : null);
  const failure = classifyFailure({
    category,
    httpStatusCode: typeof info.httpStatusCode === "number" ? info.httpStatusCode : null,
    rateLimits,
    texts: [error === undefined ? null : text(data(error).message), rejected === undefined ? null : text(data(rejected).message)],
  });
  return { requestId, rootRequestId, failedAt: typeof failed.createdAt === "number" ? failed.createdAt : null, failure };
}


// ---------------------------------------------------------------- records

export type ResumeHow = "pending-retry" | "retry" | "follow-up";

/** The pass's backoff after a failure: not before `until`, after `failures` in a row. */
export interface Backoff {
  until: number;
  failures: number;
}

/** Stops seen (bb's turn.failed), the resumes tried once per stopped turn, and the pass's pacing (src/paid-resume-migrations.ts). */
export class PaidResumeStore {
  private readonly db: () => Database.Database;

  constructor(db: () => Database.Database) {
    this.db = db;
  }

  /** A Claude Code chat's turn failed on a rate limit (the latest failure wins). */
  recordStop(threadId: string, requestId: string | null, at = new Date()): void {
    this.db()
      .prepare(`INSERT INTO paid_resume_stops (thread_id, request_id, at) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET request_id = excluded.request_id, at = excluded.at`)
      .run(threadId, requestId, at.toISOString());
  }

  /** Stops, oldest first. */
  stops(): { threadId: string; requestId: string | null; at: number }[] {
    return (this.db().prepare(`SELECT thread_id, request_id, at FROM paid_resume_stops ORDER BY at, rowid`).all() as Record<string, unknown>[]).map((row) => ({
      threadId: String(row.thread_id),
      requestId: row.request_id === null || row.request_id === undefined ? null : String(row.request_id),
      at: Date.parse(String(row.at)),
    }));
  }

  dropStop(threadId: string): void {
    this.db().prepare(`DELETE FROM paid_resume_stops WHERE thread_id = ?`).run(threadId);
  }

  /**
   * This stopped turn is done with: continued, being tried, or out of tries.
   * A failed try with tries left isn't (it goes again after the backoff), nor,
   * with `claimedBefore`, a try still "claimed" from before then (a restart
   * cut it off; only for chats, where bb refuses a retry that already went out).
   * With `requestId` (a chat's current failed request), either goes again only
   * while the request it tried is still the failed one: a newer failed request
   * in the same chain means the try went out and that turn stopped again.
   */
  settled(threadId: string, turnKey: string, options: { claimedBefore?: Date; requestId?: string } = {}): boolean {
    const row = this.row(threadId, turnKey);
    if (row === undefined) return false;
    const again = row.state === "unsent" || (row.state === "claimed" && options.claimedBefore !== undefined && row.at < options.claimedBefore.toISOString());
    return !(again && sameRequest(row, options.requestId) && Number(row.attempts) < MAX_ATTEMPTS);
  }

  /** Claim a stopped turn for one try (`claimedBefore`, `requestId` as in settled); false when it's settled. */
  claim(threadId: string, turnKey: string, how: ResumeHow, at = new Date(), options: { claimedBefore?: Date; requestId?: string } = {}): boolean {
    const requestId = options.requestId ?? null;
    const inserted = this.db()
      .prepare(`INSERT OR IGNORE INTO paid_resumes (thread_id, turn_key, how, state, at, attempts, request_id) VALUES (?, ?, ?, 'claimed', ?, 1, ?)`)
      .run(threadId, turnKey, how, at.toISOString(), requestId);
    if (Number(inserted.changes) === 1) return true;
    // ISO times in one format compare as text. Without claimedBefore, no "claimed" row matches ('' sorts first).
    const again = this.db()
      .prepare(
        `UPDATE paid_resumes SET state = 'claimed', how = ?, at = ?, attempts = attempts + 1, request_id = COALESCE(?, request_id)
         WHERE thread_id = ? AND turn_key = ? AND (state = 'unsent' OR (state = 'claimed' AND at < ?)) AND attempts < ?
           AND (? IS NULL OR request_id IS NULL OR request_id = ?)`,
      )
      .run(how, at.toISOString(), requestId, threadId, turnKey, options.claimedBefore?.toISOString() ?? "", MAX_ATTEMPTS, requestId, requestId);
    return Number(again.changes) === 1;
  }

  /** A try of this stopped turn is "claimed" (going on, or cut off by a restart) with tries left, for this request. */
  inFlight(threadId: string, turnKey: string, requestId?: string): boolean {
    const row = this.row(threadId, turnKey);
    return row !== undefined && row.state === "claimed" && sameRequest(row, requestId) && Number(row.attempts) < MAX_ATTEMPTS;
  }

  private row(threadId: string, turnKey: string): { state: string; attempts: number; at: string; request_id: string | null } | undefined {
    return this.db().prepare(`SELECT state, attempts, at, request_id FROM paid_resumes WHERE thread_id = ? AND turn_key = ?`).get(threadId, turnKey) as
      | { state: string; attempts: number; at: string; request_id: string | null }
      | undefined;
  }

  /** How many tries this stopped turn had (0: none). */
  attempts(threadId: string, turnKey: string): number {
    const row = this.db().prepare(`SELECT attempts FROM paid_resumes WHERE thread_id = ? AND turn_key = ?`).get(threadId, turnKey) as { attempts: number } | undefined;
    return row === undefined ? 0 : Number(row.attempts);
  }

  /** Forget a try that provably sent nothing (it doesn't count). */
  release(threadId: string, turnKey: string): void {
    const row = this.db().prepare(`SELECT attempts FROM paid_resumes WHERE thread_id = ? AND turn_key = ?`).get(threadId, turnKey) as { attempts: number } | undefined;
    if (row === undefined) return;
    if (Number(row.attempts) <= 1) this.db().prepare(`DELETE FROM paid_resumes WHERE thread_id = ? AND turn_key = ?`).run(threadId, turnKey);
    else this.db().prepare(`UPDATE paid_resumes SET state = 'unsent', attempts = attempts - 1 WHERE thread_id = ? AND turn_key = ?`).run(threadId, turnKey);
  }

  mark(threadId: string, turnKey: string, state: "resumed" | "unsent"): void {
    this.db().prepare(`UPDATE paid_resumes SET state = ? WHERE thread_id = ? AND turn_key = ?`).run(state, threadId, turnKey);
  }

  /** No more tries: whether it reached the agent can't be told. */
  exhaust(threadId: string, turnKey: string): void {
    this.db().prepare(`UPDATE paid_resumes SET state = 'unsent', attempts = ? WHERE thread_id = ? AND turn_key = ?`).run(MAX_ATTEMPTS, threadId, turnKey);
  }

  /** Resumes that went out since `since`. */
  resumedSince(since: Date): number {
    const row = this.db().prepare(`SELECT COUNT(*) AS count FROM paid_resumes WHERE state = 'resumed' AND at >= ?`).get(since.toISOString()) as { count: number };
    return Number(row.count);
  }

  private read<T>(key: string): T | null {
    const row = this.db().prepare(`SELECT value FROM paid_resume_state WHERE key = ?`).get(key) as { value: string } | undefined;
    if (row === undefined) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  private write(key: string, value: unknown): void {
    if (value === null) this.db().prepare(`DELETE FROM paid_resume_state WHERE key = ?`).run(key);
    else this.db().prepare(`INSERT INTO paid_resume_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
  }

  backoff(): Backoff | null {
    const value = this.read<Backoff>("backoff");
    return value !== null && Number.isFinite(value.until) && Number.isFinite(value.failures) ? value : null;
  }

  setBackoff(value: Backoff | null): void {
    this.write("backoff", value);
  }

  /** Machines the paid resume woke (host:<id>, sandbox:<id>), and when: older than `since` are forgotten. */
  noteWoke(ids: readonly string[], at: number, since: number): void {
    const woke = Object.fromEntries(Object.entries(this.read<Record<string, number>>("woke") ?? {}).filter(([, when]) => Number.isFinite(when) && when >= since));
    for (const id of ids) woke[id] = at;
    this.write("woke", Object.keys(woke).length > 0 ? woke : null);
  }

  /** The machines the paid resume woke since `since` (older ones are forgotten). */
  woken(since: number): string[] {
    const all = this.read<Record<string, number>>("woke") ?? {};
    const live = Object.fromEntries(Object.entries(all).filter(([, when]) => Number.isFinite(when) && when >= since));
    if (Object.keys(live).length !== Object.keys(all).length) this.write("woke", Object.keys(live).length > 0 ? live : null);
    return Object.keys(live);
  }

  /** Done looking at a machine the paid resume woke. */
  dropWoke(id: string): void {
    const woke = this.read<Record<string, number>>("woke") ?? {};
    if (!(id in woke)) return;
    delete woke[id];
    this.write("woke", Object.keys(woke).length > 0 ? woke : null);
  }
}

/** A try for this request (or no request to compare: headless tasks, rows from before request ids were kept). */
function sameRequest(row: { request_id: string | null }, requestId: string | undefined): boolean {
  return requestId === undefined || row.request_id === null || row.request_id === requestId;
}

/** The wait after `failures` failed passes in a row. */
export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1));
}

// ---------------------------------------------------------------- machines

/**
 * Where a resume would run: up (it runs at once), asleep (the resume wakes a
 * suspended machine or a stopped sandbox), or not now (starting, stopping,
 * failed, offline or unknown). A skip concerns that one machine only.
 */
export type MachineCheck =
  | { state: "up" }
  /** `ids`: the machines a resume wakes (host:<id>, sandbox:<id>). */
  | { state: "asleep"; ids?: string[] }
  /** `failure`: it shows a failed start (perhaps old); `id`: which machine. */
  | { state: "skip"; why: string; failure?: boolean; id?: string };

/** bb's machine record (hosts.get). */
export function hostCheck(machine: MachineState | null, id?: string): MachineCheck {
  const check = hostState(machine);
  return withId(check, id);
}

function withId(check: MachineCheck, id: string | undefined): MachineCheck {
  if (id === undefined || check.state === "up") return check;
  return check.state === "asleep" ? { state: "asleep", ids: [id] } : { ...check, id };
}

function hostState(machine: MachineState | null): MachineCheck {
  if (machine === null) return { state: "skip", why: "bb doesn't know its machine" };
  const { phase } = machine;
  if ((phase === "active" || phase === null) && machine.connected) return { state: "up" };
  // bb clears the message on a good suspend; one left there is a failed resume or suspend. It stays
  // until the machine starts again, so it says nothing about now: only this machine is left alone.
  if (phase === "suspended") return machine.message === null ? { state: "asleep" } : { state: "skip", why: `its machine failed: ${machine.message}`, failure: true };
  if (phase === "active") return { state: "skip", why: "its machine is offline" };
  return { state: "skip", why: `its machine is ${phase ?? "in an unknown state"}` };
}

/** A boat sandbox's state (null: gone). */
export function sandboxCheck(state: string | null, id?: string): MachineCheck {
  if (state === null) return withId({ state: "skip", why: "its sandbox is gone" }, id);
  if (ACTIVE_STATES.has(state)) return { state: "up" };
  if (state === "stopped" || state === "archived") return withId({ state: "asleep" }, id);
  return withId({ state: "skip", why: `its sandbox is ${state}`, failure: state === "error" || state === "failed" }, id);
}

/** Several checks of one resume: the worst wins (skip, then asleep, then up). */
export function worstCheck(checks: readonly MachineCheck[]): MachineCheck {
  const skip = checks.find((check) => check.state === "skip");
  if (skip !== undefined) return skip;
  const asleep = checks.filter((check): check is Extract<MachineCheck, { state: "asleep" }> => check.state === "asleep");
  if (asleep.length === 0) return { state: "up" };
  const ids = asleep.flatMap((check) => check.ids ?? []);
  return ids.length > 0 ? { state: "asleep", ids } : { state: "asleep" };
}

/** What the machine check reads. */
export interface MachineReader {
  /** The bb machine a workspace is on (null: none known). */
  hostOf(environmentId: string): Promise<string | null>;
  /** bb's record of a machine (null: bb doesn't know it). */
  host(hostId: string): Promise<MachineState | null>;
  /** A boat sandbox's state (null: gone). */
  sandbox(sandboxId: string): Promise<string | null>;
}

/** The machine a chat's or a headless task's resume runs on. A read that fails skips it. */
export async function readMachine(reader: MachineReader, thread: Pick<ThreadFacts, "environmentId"> | null, task: Pick<Task, "runner" | "hostId" | "sandboxId"> | null): Promise<MachineCheck> {
  try {
    const checks: MachineCheck[] = [];
    if (task?.sandboxId) checks.push(sandboxCheck(await reader.sandbox(task.sandboxId), `sandbox:${task.sandboxId}`));
    if (task?.runner !== "boat") {
      const hostId = task?.hostId ?? (thread?.environmentId ? await reader.hostOf(thread.environmentId) : null);
      checks.push(hostId === null ? { state: "skip", why: "its machine is unknown" } : hostCheck(await reader.host(hostId), `host:${hostId}`));
    }
    return worstCheck(checks);
  } catch (error) {
    return { state: "skip", why: `couldn't read its machine: ${message(error)}` };
  }
}

// ---------------------------------------------------------------- what it reads and does

/** A bb thread, as far as a resume needs it. */
export interface ThreadFacts {
  id: string;
  title: string | null;
  providerId: string | null;
  /** bb thread status: idle, active, starting, pending, stopping, error. */
  status: string;
  archived: boolean;
  /** bb project. */
  projectId: string | null;
  parentThreadId: string | null;
  /** The workspace (its machine is checked before a resume). */
  environmentId: string | null;
  /** Background agents still running. */
  backgroundAgents: number;
}

/** A queued row of a thread. */
export interface QueuedFacts {
  id: string;
  threadId: string;
  /** A provider retry (payload.kind "retry"). */
  retry: boolean;
  /** When it goes out on its own (epoch ms; null: when the thread can take it). */
  sendAt: number | null;
}

/** provider-retry's last decision for a thread (decision.get). */
export interface RetryDecision {
  requestId: string;
  kind: "retry" | "decline";
  reason: string;
}

export interface ResumeThreads {
  /** null: gone. */
  get(threadId: string): Promise<ThreadFacts | null>;
  /** The thread's latest STOP_EVENT_TYPES events. */
  stopEvents(threadId: string): Promise<TurnEventRow[]>;
  /** Queued rows of one thread, or of every thread; UNKNOWN: bb answered in a shape this version doesn't know. */
  queued(threadId?: string): Promise<QueuedFacts[] | typeof UNKNOWN>;
  /** Send a queued row now (`bb provider-retry retry`). */
  sendQueued(threadId: string, queuedMessageId: string): Promise<void>;
  /** Re-submit the failed turn now (`bb thread retry`). */
  retry(threadId: string, turnRequestId: string, reason: string): Promise<void>;
  /** null: provider-retry has no decision for the thread. UNKNOWN: it couldn't be asked, or answered in another shape. */
  decision(threadId: string): Promise<RetryDecision | null | typeof UNKNOWN>;
  /** One message to a chat (queued behind a running turn). */
  tell(threadId: string, text: string): Promise<void>;
}

export interface PaidResumeDeps {
  threads: ResumeThreads;
  store: PaidResumeStore;
  machines: MachineReader;
  /** Wakes of suspended machines and stopped sandboxes, shared with the watchdog. */
  wakes: WakeBudget;
  tasks: {
    /** The Boat task this chat belongs to (any chat it used), or null. */
    byThread(threadId: string): Task | null;
    /** Failed headless tasks (runner boat). */
    failedHeadless(): Task[];
    addEvent(taskId: string, kind: string, text: string): void;
    /** A follow-up to a headless task; its own subscription check runs again. */
    continueHeadless(taskId: string, text: string): Promise<void>;
  };
  projects(): readonly Pick<BoatProject, "id" | "name" | "localBbProjectId" | "neverPaidClaude">[];
  /** Current orchestrators and their Boat project. */
  orchestrators(): readonly { threadId: string; projectId: string | null }[];
  /**
   * Why this chat must not continue on its own (an orchestrator the relay is
   * handing over, or one that was taken over), or null.
   */
  held?(threadId: string): Promise<string | null>;
  /** `error`: bb answered in a shape this version doesn't know. */
  log: { info(line: string): void; warn(line: string): void; error?(line: string): void };
  sleep?(ms: number): Promise<void>;
  now?(): number;
  /** Tests: smaller numbers. */
  timing?: { cap?: number; staggerMs?: number; decisionWaitMs?: number };
}

/** One chat or headless task that continues on paid Claude. */
export interface ResumedWork {
  /** The chat (null: a headless task). */
  threadId: string | null;
  taskId: string | null;
  title: string | null;
  how: ResumeHow;
  /** For the relay's notes. */
  reason: string;
}

export interface ResumeReport {
  resumed: ResumedWork[];
  /** Candidates not resumed, and why. */
  skipped: { id: string; reason: string }[];
  /** Candidates left for the next pass (the cap, a failure, the wake budget). */
  deferred: string[];
  /** Orchestrators told (one message each). */
  told: string[];
  /** Attempts made (resumed or not). */
  attempts: number;
  /** The pass stopped at a failure: no attempt before this (epoch ms). */
  backoffUntil: number | null;
}

/** The setting is on, and only counts with the paid fallback on. */
export function resumeEnabled(settings: Pick<BoatSettings, "relay">): boolean {
  return settings.relay.paidClaudeFallback === true && settings.relay.resumeStoppedChats !== false;
}

/** The orchestrator's one message for a pass. */
export function parentNotice(work: readonly Pick<ResumedWork, "threadId" | "taskId" | "title">[]): string {
  const names = work.map((entry) => {
    const title = entry.title ? ` (${entry.title.replace(/\s+/g, " ").slice(0, 80)})` : "";
    return entry.threadId !== null ? `@thread:${entry.threadId}${title}` : `task ${entry.taskId}${title}`;
  });
  const count = work.length === 1 ? "1 worker" : `${work.length} workers`;
  return `[boat] Paid Claude is available, so ${count} that stopped at a usage limit ${work.length === 1 ? "continues" : "continue"} on it: ${names.join(", ")}. Claude's billing limits apply. Each stopped turn is continued once.`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A call this bb doesn't have (an older SDK): nothing was sent. */
export class ResumeUnsupported extends Error {
  readonly code = "unsupported";
}

/**
 * bb refused the call, so nothing went out: the thread or row is gone (404),
 * or the turn moved on (409, no_failed_turn).
 */
export function nothingSent(error: unknown): boolean {
  const facts = (error ?? {}) as { status?: unknown; statusCode?: unknown; code?: unknown };
  if (facts.status === 404 || facts.status === 409 || facts.statusCode === 404 || facts.statusCode === 409) return true;
  if (facts.code === "not_found" || facts.code === "conflict" || facts.code === "no_failed_turn") return true;
  return /\b(?:404|409)\b|not[ _]found|no_failed_turn/i.test(message(error));
}

/** A follow-up the service refused before sending anything: it may be tried again later. */
const ADMISSION_REFUSALS = new Set(["agents_at_limit", "task_busy", "task_running", "task_starting", "task_closed"]);

type Plan =
  | { how: "pending-retry"; queuedMessageId: string; turn: StoppedTurn }
  | { how: "retry"; turn: StoppedTurn; detail: string };

/** What one attempt did: went out, sent nothing (claim given back), or failed (the pass stops). */
type Attempt = { kind: "resumed"; work: ResumedWork } | { kind: "released"; reason: string } | { kind: "failed"; reason: string; wake: boolean };

export function createPaidResume(deps: PaidResumeDeps) {
  const now = () => deps.now?.() ?? Date.now();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cap = deps.timing?.cap ?? RESUME_CAP;
  const staggerMs = deps.timing?.staggerMs ?? RESUME_STAGGER_MS;
  const decisionWaitMs = deps.timing?.decisionWaitMs ?? DECISION_WAIT_MS;
  const logError = (line: string) => (deps.log.error ?? deps.log.warn)(line);
  // Parents seen in a pass (a chat's bb parent; a headless task's orchestrator).
  const parents = new Map<string, string>();
  const headlessParents = new Map<string, string>();
  // One pass at a time: a second caller gets the running one's report.
  let running: Promise<ResumeReport> | null = null;

  /** The project that keeps this chat or task on included usage, if any. */
  function optOut(thread: ThreadFacts | null, task: Task | null): string | null {
    const never = deps.projects().filter((project) => project.neverPaidClaude === true);
    if (never.length === 0) return null;
    const ids = new Set<string>();
    for (const id of [task?.boatProject, task?.projectId]) if (id) ids.add(id);
    const threadIds = [thread?.id, task?.orchestratorThreadId].filter((id): id is string => typeof id === "string");
    for (const row of deps.orchestrators()) if (row.projectId !== null && threadIds.includes(row.threadId)) ids.add(row.projectId);
    const hit = never.find(
      (project) =>
        ids.has(project.id) ||
        (project.localBbProjectId != null && (ids.has(`local:${project.localBbProjectId}`) || thread?.projectId === project.localBbProjectId)),
    );
    return hit?.name ?? null;
  }

  type Step = { plan: Plan; thread: ThreadFacts; task: Task | null } | { skip: string; drop: boolean };

  /** Whether this chat continues, and how. Cheap checks first: only a real candidate's events are read. */
  async function plan(threadId: string, stopAt: number | null, at: number): Promise<Step> {
    const thread = await deps.threads.get(threadId);
    if (thread === null) return { skip: "gone", drop: true };
    if (thread.archived) return { skip: "archived", drop: true };
    if (thread.providerId !== CLAUDE_CODE) return { skip: "not a Claude Code chat", drop: true };
    if (isBusy(thread.status) || thread.backgroundAgents > 0) return { skip: "a turn is running", drop: true };
    const task = deps.tasks.byThread(threadId);
    // An older chat of a task (a hand-over left it): never two agents in one checkout.
    if (task !== null && task.threadId !== threadId) return { skip: `an earlier chat of task ${task.id}`, drop: true };
    const project = optOut(thread, task);
    if (project !== null) return { skip: `project ${project} never continues on paid Claude`, drop: false };
    // Two orchestrators must never act at once.
    const held = (await deps.held?.(threadId)) ?? null;
    if (held !== null) return { skip: held, drop: false };
    const rows = await deps.threads.queued(threadId);
    if (rows === UNKNOWN) return { skip: "bb's queue for it couldn't be read", drop: false };
    const pending = rows.find((row) => row.retry) ?? null;
    if (rows.some((row) => row !== pending)) return { skip: "a message is queued", drop: false };
    if (thread.status !== "error" && pending === null) return { skip: "it isn't stopped", drop: true };
    const turn = readStoppedTurn(await deps.threads.stopEvents(threadId));
    if (turn === null) return { skip: "no failed turn", drop: true };
    if (turn.failure.kind !== "usage-limit") return { skip: `it stopped on ${turn.failure.why}`, drop: true };
    if (deps.store.settled(threadId, turn.rootRequestId, { claimedBefore: new Date(at - CLAIM_TTL_MS), requestId: turn.requestId })) {
      // A try still "claimed" for this request (a restart may have cut it off) keeps its stop: after CLAIM_TTL_MS it may go again.
      const inFlight = deps.store.inFlight(threadId, turn.rootRequestId, turn.requestId);
      return { skip: inFlight ? "a try of it is under way" : "this stopped turn was continued once already", drop: !inFlight };
    }
    if (pending !== null) {
      if (pending.sendAt !== null && pending.sendAt - at <= PENDING_SOON_MS) return { skip: "its provider retry goes out soon anyway", drop: false };
      return { plan: { how: "pending-retry", queuedMessageId: pending.id, turn }, thread, task };
    }
    const decision = await deps.threads.decision(threadId);
    // provider-retry couldn't be asked: it may still have a retry scheduled, so no guess.
    if (decision === UNKNOWN) return { skip: "provider retry's decision couldn't be read", drop: false };
    if (decision !== null && decision.requestId === turn.requestId) {
      // A retry was scheduled for this failure and its row is gone: someone cancelled it.
      if (decision.kind === "retry") return { skip: "its provider retry was cancelled", drop: true };
      return { plan: { how: "retry", turn, detail: `provider retry skipped it: ${decision.reason}` }, thread, task };
    }
    const failedAt = turn.failedAt ?? stopAt;
    if (failedAt === null || at - failedAt < decisionWaitMs) return { skip: "waiting for provider retry's decision", drop: false };
    return { plan: { how: "retry", turn, detail: "no provider retry pending" }, thread, task };
  }

  async function resumeChat(threadId: string, step: { plan: Plan; thread: ThreadFacts; task: Task | null }, wake: boolean): Promise<Attempt> {
    const { plan: chosen, thread, task } = step;
    const key = chosen.turn.rootRequestId;
    // A chat's try left "claimed" by a restart may go again: bb refuses a retry that already went out (409, 404).
    if (!deps.store.claim(threadId, key, chosen.how, new Date(now()), { claimedBefore: new Date(now() - CLAIM_TTL_MS), requestId: chosen.turn.requestId })) return { kind: "released", reason: "this stopped turn was continued once already" };
    try {
      if (chosen.how === "pending-retry") await deps.threads.sendQueued(threadId, chosen.queuedMessageId);
      else await deps.threads.retry(threadId, chosen.turn.requestId, RESUME_REASON);
    } catch (error) {
      const reason = `couldn't continue it: ${message(error)}`;
      if (error instanceof ResumeUnsupported) {
        deps.store.release(threadId, key);
        logError(`paid resume ${threadId}: ${message(error)}`);
        return { kind: "failed", reason, wake: false };
      }
      // Gone, or the turn moved on: nothing went out, and nothing is wrong with bb or boat.dev.
      if (nothingSent(error)) {
        deps.store.release(threadId, key);
        return { kind: "released", reason };
      }
      // Tried again after the backoff, while tries are left (bb's state keeps a retry from running twice).
      deps.store.mark(threadId, key, "unsent");
      deps.log.warn(`paid resume ${threadId}: ${reason} (try ${deps.store.attempts(threadId, key)} of ${MAX_ATTEMPTS})`);
      return { kind: "failed", reason, wake };
    }
    deps.store.mark(threadId, key, "resumed");
    deps.store.dropStop(threadId);
    const reason = chosen.how === "pending-retry" ? "sent its pending provider retry now" : `retried the stopped turn (${chosen.detail})`;
    if (task !== null) deps.tasks.addEvent(task.id, RESUME_EVENT, `Continued on paid Claude after a usage limit: ${reason}.`);
    return { kind: "resumed", work: { threadId, taskId: task?.id ?? null, title: thread.title ?? task?.title ?? null, how: chosen.how, reason: `on paid Claude: ${reason}` } };
  }

  async function resumeHeadless(task: Task, wake: boolean): Promise<Attempt> {
    const key = `turn:${task.turns}`;
    const id = `task:${task.id}`;
    if (!deps.store.claim(id, key, "follow-up")) return { kind: "released", reason: "this stopped turn was continued once already" };
    try {
      await deps.tasks.continueHeadless(task.id, HEADLESS_RESUME_TEXT);
    } catch (error) {
      const reason = `couldn't continue it: ${message(error)}`;
      // The service refused before sending anything (its own admission check): it may go later.
      if (error instanceof TaskError && ADMISSION_REFUSALS.has(error.code)) {
        deps.store.release(id, key);
        return { kind: "released", reason };
      }
      // Anything else (a boat error, a timeout) may have come after boat took the prompt. With the
      // sandbox up, a second follow-up could be a second message to the agent: no more tries.
      const after = await readMachine(deps.machines, null, task);
      deps.store.mark(id, key, "unsent");
      if (after.state === "up") deps.store.exhaust(id, key);
      deps.log.warn(`paid resume ${task.id}: ${reason}${after.state === "up" ? " (not tried again: it may have reached the agent)" : ""}`);
      return { kind: "failed", reason, wake };
    }
    deps.store.mark(id, key, "resumed");
    deps.tasks.addEvent(task.id, RESUME_EVENT, "Continued on paid Claude after a usage limit: sent a follow-up to the headless task.");
    return { kind: "resumed", work: { threadId: null, taskId: task.id, title: task.title, how: "follow-up", reason: "on paid Claude: sent the headless task a follow-up" } };
  }

  /** Headless tasks that stopped at a Claude usage limit in the last STOP_TTL_MS (like chats), oldest first. */
  function headlessCandidates(at: number): Task[] {
    return deps.tasks
      .failedHeadless()
      .filter((task) => {
        const stoppedAt = Date.parse(task.finishedAt ?? "");
        return task.runner === "boat" && task.provider === "claude" && task.status === "failed" && headlessUsageLimit(task.error) && Number.isFinite(stoppedAt) && at - stoppedAt <= STOP_TTL_MS;
      })
      .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
  }

  /** Tell each orchestrator once which of its workers continue. */
  async function tellParents(resumed: readonly ResumedWork[], report: ResumeReport): Promise<void> {
    const orchestrators = new Set(deps.orchestrators().map((row) => row.threadId));
    const resumedThreads = new Set(resumed.map((work) => work.threadId).filter((id): id is string => id !== null));
    const byParent = new Map<string, ResumedWork[]>();
    for (const work of resumed) {
      // A task reports to its orchestrator; another chat to its bb parent.
      const parent =
        work.threadId === null
          ? (headlessParents.get(work.taskId ?? "") ?? null)
          : (deps.tasks.byThread(work.threadId)?.orchestratorThreadId ?? parents.get(work.threadId) ?? null);
      if (parent === null || !orchestrators.has(parent) || parent === work.threadId) continue;
      byParent.set(parent, [...(byParent.get(parent) ?? []), work]);
    }
    for (const [parent, work] of byParent) {
      const thread = await deps.threads.get(parent).catch(() => null);
      // Never start a turn on an orchestrator that is itself stopped and wasn't continued.
      if (thread === null || thread.archived || (thread.status === "error" && !resumedThreads.has(parent))) continue;
      try {
        await deps.threads.tell(parent, parentNotice(work));
        report.told.push(parent);
      } catch (error) {
        deps.log.warn(`paid resume: couldn't tell ${parent}: ${message(error)}`);
      }
    }
  }

  /**
   * The machines the paid resume woke in the last WAKE_HOLD_MS, read again
   * directly (their chats may not be candidates any more: a retry bb took,
   * then a resume that failed later). Failed to start: hold every wake, done
   * with it. Up: done with it. Still on the way (or unreadable): look again.
   */
  async function checkWoken(at: number): Promise<void> {
    for (const id of deps.store.woken(at - WAKE_HOLD_MS)) {
      let check: MachineCheck;
      try {
        if (id.startsWith("host:")) check = hostCheck(await deps.machines.host(id.slice("host:".length)));
        else if (id.startsWith("sandbox:")) check = sandboxCheck(await deps.machines.sandbox(id.slice("sandbox:".length)));
        else {
          deps.store.dropWoke(id);
          continue;
        }
      } catch {
        continue;
      }
      if (check.state === "up") deps.store.dropWoke(id);
      else if (check.state === "skip" && check.failure) {
        deps.log.warn(`paid resume: a machine it woke failed to start (${id}: ${check.why}); no machine is woken for a while`);
        await deps.wakes.failed();
        deps.store.dropWoke(id);
      }
    }
  }

  /** One pass: resume what stopped at a limit when paid Claude is available. */
  async function runPass(quotas: Quotas, settings: BoatSettings): Promise<ResumeReport> {
    const report: ResumeReport = { resumed: [], skipped: [], deferred: [], told: [], attempts: 0, backoffUntil: null };
    if (!resumeEnabled(settings)) return report;
    const at = now();
    const chatRoom: SubscriptionRoom = subscriptionRoom("claude", quotas, settings, { runner: "chat", now: at });
    const headlessRoom: SubscriptionRoom = subscriptionRoom("claude", quotas, settings, { runner: "boat", now: at });
    if (chatRoom !== "paid" && headlessRoom !== "paid") return report;
    // A failure ended an earlier pass: nothing until its backoff is over.
    const backoff = deps.store.backoff();
    if (backoff !== null && backoff.until > at) {
      report.backoffUntil = backoff.until;
      return report;
    }
    parents.clear();
    headlessParents.clear();

    // Candidates: stops bb reported, then every chat with a pending provider retry.
    const stops = new Map<string, number>();
    for (const stop of deps.store.stops()) {
      if (!Number.isFinite(stop.at) || at - stop.at > STOP_TTL_MS) deps.store.dropStop(stop.threadId);
      else stops.set(stop.threadId, stop.at);
    }
    const pendingRows = chatRoom === "paid" ? await deps.threads.queued().catch((error: unknown) => {
      deps.log.warn(`paid resume: couldn't list queued retries: ${message(error)}`);
      return [] as QueuedFacts[];
    }) : [];
    if (pendingRows === UNKNOWN) logError("paid resume: bb's queue (threads.queue.list) answered in a shape this version doesn't know; only recorded stops are checked");
    const ids = [...stops.keys()];
    for (const row of pendingRows === UNKNOWN ? [] : pendingRows) if (row.retry && !ids.includes(row.threadId)) ids.push(row.threadId);

    let stopped = false;
    // The machines earlier passes woke, before anything is woken now: one that failed to start holds every wake.
    await checkWoken(at);
    let wakesHeld = (await deps.wakes.heldUntil()) > at;
    /** The machine check before an attempt: up goes; asleep goes with a wake (if one is left); else why not. */
    const ready = async (check: MachineCheck): Promise<{ go: true; wake: boolean } | { go: false; reason: string; defer: boolean }> => {
      // A failure a machine shows may be days old (bb keeps it until the machine starts again): only this machine is left alone.
      if (check.state === "skip") return { go: false, reason: check.why, defer: false };
      if (check.state === "up") return { go: true, wake: false };
      if (wakesHeld) return { go: false, reason: "machines aren't woken for now (a wake failed)", defer: true };
      if (!(await deps.wakes.take())) return { go: false, reason: "waiting for a wake (at most 2 a minute)", defer: true };
      deps.store.noteWoke(check.ids ?? [], at, at - WAKE_HOLD_MS);
      return { go: true, wake: true };
    };
    const attempt = async (id: string, run: () => Promise<Attempt>) => {
      if (report.attempts > 0) await sleep(staggerMs);
      report.attempts += 1;
      const outcome = await run();
      if (outcome.kind === "resumed") {
        report.resumed.push(outcome.work);
        if (deps.store.backoff() !== null) deps.store.setBackoff(null);
        return;
      }
      report.skipped.push({ id, reason: outcome.reason });
      if (outcome.kind === "failed") {
        // Stop at the first failure and back off: boat.dev or bb may be overloaded.
        const failures = (deps.store.backoff()?.failures ?? 0) + 1;
        const until = now() + backoffMs(failures);
        deps.store.setBackoff({ until, failures });
        if (outcome.wake) {
          await deps.wakes.failed();
          wakesHeld = true;
        }
        report.backoffUntil = until;
        stopped = true;
      }
    };

    if (chatRoom === "paid") {
      for (const threadId of ids) {
        if (stopped || report.attempts >= cap) {
          report.deferred.push(threadId);
          continue;
        }
        let step: Step;
        try {
          step = await plan(threadId, stops.get(threadId) ?? null, at);
        } catch (error) {
          report.skipped.push({ id: threadId, reason: `couldn't read it: ${message(error)}` });
          continue;
        }
        if ("skip" in step) {
          if (step.drop) deps.store.dropStop(threadId);
          report.skipped.push({ id: threadId, reason: step.skip });
          continue;
        }
        const go = await ready(await readMachine(deps.machines, step.thread, step.task));
        if (!go.go) {
          report.skipped.push({ id: threadId, reason: go.reason });
          if (go.defer) report.deferred.push(threadId);
          continue;
        }
        if (step.thread.parentThreadId !== null) parents.set(threadId, step.thread.parentThreadId);
        await attempt(threadId, () => resumeChat(threadId, step, go.wake));
      }
    }

    if (headlessRoom === "paid") {
      let headless = 0;
      for (const task of headlessCandidates(at)) {
        const id = `task:${task.id}`;
        // The resumed turn stopped again: never a second time.
        if (deps.store.settled(id, `turn:${task.turns}`) || deps.store.settled(id, `turn:${task.turns - 1}`)) continue;
        if (stopped || report.attempts >= cap || headless >= HEADLESS_PER_PASS) {
          report.deferred.push(id);
          continue;
        }
        const project = optOut(null, task);
        if (project !== null) {
          report.skipped.push({ id, reason: `project ${project} never continues on paid Claude` });
          continue;
        }
        const go = await ready(await readMachine(deps.machines, null, task));
        if (!go.go) {
          report.skipped.push({ id, reason: go.reason });
          if (go.defer) report.deferred.push(id);
          continue;
        }
        if (task.orchestratorThreadId !== null) headlessParents.set(task.id, task.orchestratorThreadId);
        headless += 1;
        await attempt(id, () => resumeHeadless(task, go.wake));
      }
    }

    if (report.deferred.length > 0) deps.log.info(`paid resume: ${report.deferred.length} more stopped ${report.deferred.length === 1 ? "chat waits" : "chats wait"} for a later pass${stopped ? " (stopped at a failure; backing off)" : ""}: ${report.deferred.join(", ")}`);
    if (report.resumed.length > 0) await tellParents(report.resumed, report);
    return report;
  }

  return {
    /** One pass (one at a time: a call while one runs gets that one's report). */
    pass(quotas: Quotas, settings: BoatSettings): Promise<ResumeReport> {
      running ??= runPass(quotas, settings).finally(() => {
        running = null;
      });
      return running;
    },
    /**
     * bb reported a failed turn that may be a usage limit: remember the chat
     * when it's Claude Code. True when it was recorded.
     */
    async stopped(threadId: string, requestId: string | null): Promise<boolean> {
      const thread = await deps.threads.get(threadId).catch(() => null);
      if (thread === null || thread.archived || thread.providerId !== CLAUDE_CODE) return false;
      deps.store.recordStop(threadId, requestId, new Date(now()));
      return true;
    },
    /** Resumes in the last day (the usage view's count). */
    recent(): number {
      return deps.store.resumedSince(new Date(now() - RECENT_RESUMES_MS));
    },
  };
}

export type PaidResume = ReturnType<typeof createPaidResume>;

/** The parts of bb's turn.failed event a stop needs. */
export interface TurnFailedPayload {
  threadId?: unknown;
  requestId?: unknown;
  errorInfo?: { category?: string | null; httpStatusCode?: number | null } | null;
}

/** A failure worth remembering as a possible usage-limit stop (the pass reads it properly). */
export function mayBeLimitStop(event: TurnFailedPayload): boolean {
  return event.errorInfo?.category === "rate-limit" || event.errorInfo?.httpStatusCode === 429;
}

/**
 * Run `run` at most once at a time, every `intervalMs`, and once soon after
 * `soon()`: any number of calls within `delayMs` make one run (a burst of
 * stops is one check, not one pass each). Stops with `signal`.
 */
export function createPaidResumeTimer(run: () => Promise<unknown>, options: { intervalMs: number; delayMs: number; signal: AbortSignal; onError?(error: unknown): void }) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dueAt = Number.POSITIVE_INFINITY;
  let busy = false;
  const schedule = (ms: number) => {
    if (options.signal.aborted) return;
    const at = Date.now() + ms;
    if (timer !== null && dueAt <= at) return;
    if (timer !== null) clearTimeout(timer);
    dueAt = at;
    timer = setTimeout(fire, ms);
    (timer as { unref?: () => void }).unref?.();
  };
  const fire = async () => {
    timer = null;
    dueAt = Number.POSITIVE_INFINITY;
    if (options.signal.aborted) return;
    if (busy) return schedule(options.intervalMs);
    busy = true;
    try {
      await run();
    } catch (error) {
      options.onError?.(error);
    } finally {
      busy = false;
      schedule(options.intervalMs);
    }
  };
  options.signal.addEventListener("abort", () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }, { once: true });
  return {
    start: () => schedule(options.intervalMs),
    /** A chat stopped at a limit: check soon (calls in a burst make one check). */
    soon: () => schedule(options.delayMs),
  };
}

// ---------------------------------------------------------------- bb

const decisionSchema = z
  .object({
    requestId: z.string(),
    decision: z.object({ kind: z.enum(["retry", "decline"]), reason: z.string() }).passthrough(),
  })
  .passthrough()
  .nullable();

/** The rows of a list reply: an array, or { key | items: array }; null: another shape. */
function rowsOf(raw: unknown, key: string): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (raw === null || typeof raw !== "object") return null;
  const value = (raw as Record<string, unknown>)[key] ?? (raw as Record<string, unknown>).items;
  return Array.isArray(value) ? value : null;
}

/** A queued row; null when it isn't one this version can read (then the whole list is unknown). */
function queuedFacts(raw: unknown, threadId: string | undefined): QueuedFacts | null {
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as { id?: unknown; threadId?: unknown; sendAt?: unknown; payload?: { kind?: unknown } | null };
  const thread = typeof row.threadId === "string" ? row.threadId : threadId;
  if (typeof row.id !== "string" || thread === undefined) return null;
  // A row without a payload kind counts as a message of its own: it holds a resume back.
  return { id: row.id, threadId: thread, retry: row.payload?.kind === "retry", sendAt: typeof row.sendAt === "number" ? row.sendAt : null };
}

/** The reads and writes above, through bb's SDK (shapes as in bb 0.50.1; others read as UNKNOWN). */
export function bbResumeThreads(bb: BbPluginApi, tell: (threadId: string, text: string) => Promise<void>, log?: { error(line: string): void }): ResumeThreads {
  const unknownShape = (what: string, raw: unknown) => {
    log?.error(`paid resume: ${what} answered in a shape this version doesn't know (${typeof raw === "object" && raw !== null ? `keys ${Object.keys(raw).slice(0, 8).join(", ") || "none"}` : typeof raw}); skipped`);
    return UNKNOWN;
  };
  return {
    async get(threadId) {
      let raw: unknown;
      try {
        raw = await bb.sdk.threads.get({ threadId });
      } catch (error) {
        if (/not[ _]found|404/i.test(message(error))) return null;
        throw error;
      }
      const thread = ((raw as { thread?: unknown } | null)?.thread ?? raw) as Record<string, unknown> | null;
      if (thread === null || typeof thread !== "object" || thread.deletedAt) return null;
      const title = typeof thread.title === "string" && thread.title ? thread.title : typeof thread.titleFallback === "string" ? thread.titleFallback : null;
      return {
        id: threadId,
        title,
        providerId: typeof thread.providerId === "string" ? thread.providerId : null,
        status: typeof thread.status === "string" ? thread.status : "idle",
        // Older bb versions may only say archived: true.
        archived: Boolean(thread.archivedAt) || thread.archived === true,
        projectId: typeof thread.projectId === "string" ? thread.projectId : null,
        parentThreadId: typeof thread.parentThreadId === "string" ? thread.parentThreadId : null,
        environmentId: typeof thread.environmentId === "string" ? thread.environmentId : null,
        backgroundAgents: typeof thread.activeBackgroundAgentCount === "number" ? thread.activeBackgroundAgentCount : 0,
      };
    },
    async stopEvents(threadId) {
      const raw = (await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "100", types: [...STOP_EVENT_TYPES] } as never)) as unknown;
      return (rowsOf(raw, "events") ?? []).filter(
        (row): row is TurnEventRow => row !== null && typeof row === "object" && Number.isSafeInteger((row as TurnEventRow).seq) && typeof (row as TurnEventRow).type === "string",
      );
    },
    async queued(threadId) {
      const raw = threadId === undefined ? await bb.sdk.threads.queue.list({}) : await bb.sdk.threads.queuedMessages.list({ threadId });
      const rows = rowsOf(raw, "queuedMessages");
      if (rows === null) return unknownShape(threadId === undefined ? "threads.queue.list" : "threads.queuedMessages.list", raw);
      const facts: QueuedFacts[] = [];
      for (const row of rows) {
        const fact = queuedFacts(row, threadId);
        // One row that can't be read could be a retry or a user's message: the whole list is unknown.
        if (fact === null) return unknownShape(threadId === undefined ? "threads.queue.list" : "threads.queuedMessages.list", row);
        facts.push(fact);
      }
      return facts;
    },
    async sendQueued(threadId, queuedMessageId) {
      if (typeof bb.sdk.threads.queuedMessages?.send !== "function") throw new ResumeUnsupported("This bb can't send a queued message now (threads.queuedMessages.send).");
      await bb.sdk.threads.queuedMessages.send({ threadId, queuedMessageId, mode: "auto" });
    },
    async retry(threadId, turnRequestId, reason) {
      if (typeof bb.sdk.threads.retry !== "function") throw new ResumeUnsupported("This bb can't retry a failed turn (threads.retry).");
      await bb.sdk.threads.retry({ threadId, turnRequestId, reason });
    },
    async decision(threadId) {
      let raw: unknown;
      try {
        raw = await bb.sdk.plugins.callRpc({
          pluginId: "provider-retry",
          method: "decision.get",
          input: { threadId },
          // Checked below, so an unknown shape is told apart from "no decision".
          outputSchema: z.unknown(),
          signal: AbortSignal.timeout(5_000),
        } as never);
      } catch {
        // Not installed, off, an unknown method or a timeout: provider-retry may still have a retry scheduled.
        return UNKNOWN;
      }
      const parsed = decisionSchema.safeParse(raw);
      if (!parsed.success) return unknownShape("provider-retry's decision.get", raw);
      if (parsed.data === null) return null;
      return { requestId: parsed.data.requestId, kind: parsed.data.decision.kind, reason: parsed.data.decision.reason };
    },
    tell,
  };
}

/** The machine reads above, through bb's SDK and the boat CLI. */
export function bbMachineReader(bb: BbPluginApi, machineState: (hostId: string) => Promise<MachineState | null>, sandboxState: (sandboxId: string) => Promise<string | null>): MachineReader {
  return {
    async hostOf(environmentId) {
      const raw = (await bb.sdk.environments.get({ environmentId })) as { hostId?: string | null; environment?: { hostId?: string | null } } | null;
      return raw?.hostId ?? raw?.environment?.hostId ?? null;
    },
    host: machineState,
    sandbox: sandboxState,
  };
}
