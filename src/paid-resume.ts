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
//
// Safety: one resume per thread and stopped turn, a few seconds between
// resumes, at most RESUME_CAP per pass (the rest wait for the next pass), and
// nothing while the reading is stale, Claude is on hold or extra usage is
// rejected (all part of the shared check).
import type Database from "better-sqlite3";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { USAGE_LIMIT_TEXT } from "./limits.ts";
import type { BoatProject } from "./projects.ts";
import type { Quotas } from "./quota.ts";
import { isBusy, subscriptionRoom, type SubscriptionRoom } from "./relay.ts";
import type { BoatSettings } from "./service.ts";
import type { TurnEventRow } from "./steer-retry.ts";
import type { Task } from "./store.ts";

/** At most this many resumes per pass; the rest wait for the next one. */
export const RESUME_CAP = 10;
/** Pause between two resumes, so a pool of chats doesn't wake at once. */
export const RESUME_STAGGER_MS = 3_000;
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

/** Stops seen (bb's turn.failed) and the resumes made, once per stopped turn (src/paid-resume-migrations.ts). */
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

  claimed(threadId: string, turnKey: string): boolean {
    return this.db().prepare(`SELECT 1 FROM paid_resumes WHERE thread_id = ? AND turn_key = ?`).get(threadId, turnKey) !== undefined;
  }

  /** Claim a stopped turn; false when it was resumed (or tried) before. */
  claim(threadId: string, turnKey: string, how: ResumeHow, at = new Date()): boolean {
    const result = this.db()
      .prepare(`INSERT OR IGNORE INTO paid_resumes (thread_id, turn_key, how, state, at) VALUES (?, ?, ?, 'claimed', ?)`)
      .run(threadId, turnKey, how, at.toISOString());
    return Number(result.changes) === 1;
  }

  /** Forget a claim whose resume provably didn't go out. */
  release(threadId: string, turnKey: string): void {
    this.db().prepare(`DELETE FROM paid_resumes WHERE thread_id = ? AND turn_key = ?`).run(threadId, turnKey);
  }

  mark(threadId: string, turnKey: string, state: "resumed" | "unsent"): void {
    this.db().prepare(`UPDATE paid_resumes SET state = ? WHERE thread_id = ? AND turn_key = ?`).run(state, threadId, turnKey);
  }

  /** Resumes that went out since `since`. */
  resumedSince(since: Date): number {
    const row = this.db().prepare(`SELECT COUNT(*) AS count FROM paid_resumes WHERE state = 'resumed' AND at >= ?`).get(since.toISOString()) as { count: number };
    return Number(row.count);
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
  /** Queued rows of one thread, or of every thread. */
  queued(threadId?: string): Promise<QueuedFacts[]>;
  /** Send a queued row now (`bb provider-retry retry`). */
  sendQueued(threadId: string, queuedMessageId: string): Promise<void>;
  /** Re-submit the failed turn now (`bb thread retry`). */
  retry(threadId: string, turnRequestId: string, reason: string): Promise<void>;
  /** null: no decision, or provider-retry doesn't answer. */
  decision(threadId: string): Promise<RetryDecision | null>;
  /** One message to a chat (queued behind a running turn). */
  tell(threadId: string, text: string): Promise<void>;
}

export interface PaidResumeDeps {
  threads: ResumeThreads;
  store: PaidResumeStore;
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
  log: { info(line: string): void; warn(line: string): void };
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
  /** Candidates left for the next pass (the cap). */
  deferred: string[];
  /** Orchestrators told (one message each). */
  told: string[];
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

type Plan =
  | { how: "pending-retry"; queuedMessageId: string; turn: StoppedTurn }
  | { how: "retry"; turn: StoppedTurn; detail: string };

export function createPaidResume(deps: PaidResumeDeps) {
  const now = () => deps.now?.() ?? Date.now();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cap = deps.timing?.cap ?? RESUME_CAP;
  const staggerMs = deps.timing?.staggerMs ?? RESUME_STAGGER_MS;
  const decisionWaitMs = deps.timing?.decisionWaitMs ?? DECISION_WAIT_MS;
  // Parents seen in a pass (a chat's bb parent; a headless task's orchestrator).
  const parents = new Map<string, string>();
  const headlessParents = new Map<string, string>();

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

  async function plan(threadId: string, stopAt: number | null, at: number): Promise<{ plan: Plan; thread: ThreadFacts; task: Task | null } | { skip: string; drop: boolean }> {
    const thread = await deps.threads.get(threadId);
    if (thread === null) return { skip: "gone", drop: true };
    if (thread.archived) return { skip: "archived", drop: true };
    if (thread.providerId !== CLAUDE_CODE) return { skip: "not a Claude Code chat", drop: true };
    if (isBusy(thread.status) || thread.backgroundAgents > 0) return { skip: "a turn is running", drop: true };
    const rows = await deps.threads.queued(threadId);
    const pending = rows.find((row) => row.retry) ?? null;
    if (rows.some((row) => row !== pending)) return { skip: "a message is queued", drop: false };
    if (thread.status !== "error" && pending === null) return { skip: "it isn't stopped", drop: true };
    const turn = readStoppedTurn(await deps.threads.stopEvents(threadId));
    if (turn === null) return { skip: "no failed turn", drop: true };
    if (turn.failure.kind !== "usage-limit") return { skip: `it stopped on ${turn.failure.why}`, drop: true };
    if (deps.store.claimed(threadId, turn.rootRequestId)) return { skip: "this stopped turn was continued once already", drop: true };
    const task = deps.tasks.byThread(threadId);
    // An older chat of a task (a hand-over left it): never two agents in one checkout.
    if (task !== null && task.threadId !== threadId) return { skip: `an earlier chat of task ${task.id}`, drop: true };
    const project = optOut(thread, task);
    if (project !== null) return { skip: `project ${project} never continues on paid Claude`, drop: false };
    // Two orchestrators must never act at once.
    const held = (await deps.held?.(threadId)) ?? null;
    if (held !== null) return { skip: held, drop: false };
    if (pending !== null) {
      if (pending.sendAt !== null && pending.sendAt - at <= PENDING_SOON_MS) return { skip: "its provider retry goes out soon anyway", drop: false };
      return { plan: { how: "pending-retry", queuedMessageId: pending.id, turn }, thread, task };
    }
    const decision = await deps.threads.decision(threadId).catch(() => null);
    if (decision !== null && decision.requestId === turn.requestId) {
      // A retry was scheduled for this failure and its row is gone: someone cancelled it.
      if (decision.kind === "retry") return { skip: "its provider retry was cancelled", drop: true };
      return { plan: { how: "retry", turn, detail: `provider retry skipped it: ${decision.reason}` }, thread, task };
    }
    const failedAt = turn.failedAt ?? stopAt;
    if (failedAt === null || at - failedAt < decisionWaitMs) return { skip: "waiting for provider retry's decision", drop: false };
    return { plan: { how: "retry", turn, detail: "no provider retry pending" }, thread, task };
  }

  async function resumeChat(threadId: string, step: { plan: Plan; thread: ThreadFacts; task: Task | null }): Promise<ResumedWork | string> {
    const { plan: chosen, thread, task } = step;
    const key = chosen.turn.rootRequestId;
    if (!deps.store.claim(threadId, key, chosen.how)) return "this stopped turn was continued once already";
    try {
      if (chosen.how === "pending-retry") await deps.threads.sendQueued(threadId, chosen.queuedMessageId);
      else await deps.threads.retry(threadId, chosen.turn.requestId, RESUME_REASON);
    } catch (error) {
      // Claimed either way: a resume that may have gone out is never repeated.
      deps.store.mark(threadId, key, "unsent");
      deps.log.warn(`paid resume ${threadId}: couldn't continue it: ${message(error)}`);
      return `couldn't continue it: ${message(error)}`;
    }
    deps.store.mark(threadId, key, "resumed");
    deps.store.dropStop(threadId);
    const reason = chosen.how === "pending-retry" ? "sent its pending provider retry now" : `retried the stopped turn (${chosen.detail})`;
    if (task !== null) deps.tasks.addEvent(task.id, RESUME_EVENT, `Continued on paid Claude after a usage limit: ${reason}.`);
    return { threadId, taskId: task?.id ?? null, title: thread.title ?? task?.title ?? null, how: chosen.how, reason: `on paid Claude: ${reason}` };
  }

  async function resumeHeadless(task: Task): Promise<ResumedWork | string> {
    const key = `turn:${task.turns}`;
    const id = `task:${task.id}`;
    if (!deps.store.claim(id, key, "follow-up")) return "this stopped turn was continued once already";
    try {
      await deps.tasks.continueHeadless(task.id, HEADLESS_RESUME_TEXT);
    } catch (error) {
      // The service refused before sending (a TaskError has a code): it may be tried again later.
      if (typeof (error as { code?: unknown } | null)?.code === "string") deps.store.release(id, key);
      else deps.store.mark(id, key, "unsent");
      deps.log.warn(`paid resume ${task.id}: couldn't continue it: ${message(error)}`);
      return `couldn't continue it: ${message(error)}`;
    }
    deps.store.mark(id, key, "resumed");
    deps.tasks.addEvent(task.id, RESUME_EVENT, "Continued on paid Claude after a usage limit: sent a follow-up to the headless task.");
    return { threadId: null, taskId: task.id, title: task.title, how: "follow-up", reason: "on paid Claude: sent the headless task a follow-up" };
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

  /** One pass: resume what stopped at a limit when paid Claude is available. */
  async function pass(quotas: Quotas, settings: BoatSettings): Promise<ResumeReport> {
    const report: ResumeReport = { resumed: [], skipped: [], deferred: [], told: [] };
    if (!resumeEnabled(settings)) return report;
    const at = now();
    const chatRoom: SubscriptionRoom = subscriptionRoom("claude", quotas, settings, { runner: "chat", now: at });
    const headlessRoom: SubscriptionRoom = subscriptionRoom("claude", quotas, settings, { runner: "boat", now: at });
    if (chatRoom !== "paid" && headlessRoom !== "paid") return report;
    parents.clear();
    headlessParents.clear();

    // Candidates: stops bb reported, then every chat with a pending provider retry.
    const stops = new Map<string, number>();
    for (const stop of deps.store.stops()) {
      if (!Number.isFinite(stop.at) || at - stop.at > STOP_TTL_MS) deps.store.dropStop(stop.threadId);
      else stops.set(stop.threadId, stop.at);
    }
    const pendingRows = await deps.threads.queued().catch((error: unknown) => {
      deps.log.warn(`paid resume: couldn't list queued retries: ${message(error)}`);
      return [] as QueuedFacts[];
    });
    const ids = [...stops.keys()];
    for (const row of pendingRows) if (row.retry && !ids.includes(row.threadId)) ids.push(row.threadId);

    const act = async (id: string, run: () => Promise<ResumedWork | string>) => {
      if (report.resumed.length > 0) await sleep(staggerMs);
      const outcome = await run();
      if (typeof outcome === "string") report.skipped.push({ id, reason: outcome });
      else report.resumed.push(outcome);
    };

    if (chatRoom === "paid") {
      for (const threadId of ids) {
        if (report.resumed.length >= cap) {
          report.deferred.push(threadId);
          continue;
        }
        let step: Awaited<ReturnType<typeof plan>>;
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
        if (step.thread.parentThreadId !== null) parents.set(threadId, step.thread.parentThreadId);
        await act(threadId, () => resumeChat(threadId, step));
      }
    }

    if (headlessRoom === "paid") {
      for (const task of headlessCandidates(at)) {
        const id = `task:${task.id}`;
        // The resumed turn stopped again: never a second time.
        if (deps.store.claimed(id, `turn:${task.turns}`) || deps.store.claimed(id, `turn:${task.turns - 1}`)) continue;
        if (report.resumed.length >= cap) {
          report.deferred.push(id);
          continue;
        }
        const project = optOut(null, task);
        if (project !== null) {
          report.skipped.push({ id, reason: `project ${project} never continues on paid Claude` });
          continue;
        }
        if (task.orchestratorThreadId !== null) headlessParents.set(task.id, task.orchestratorThreadId);
        await act(id, () => resumeHeadless(task));
      }
    }

    if (report.deferred.length > 0) deps.log.info(`paid resume: ${report.deferred.length} more stopped ${report.deferred.length === 1 ? "chat waits" : "chats wait"} for the next pass (at most ${cap} a pass): ${report.deferred.join(", ")}`);
    if (report.resumed.length > 0) await tellParents(report.resumed, report);
    return report;
  }

  return {
    pass,
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

// ---------------------------------------------------------------- bb

const decisionSchema = z
  .object({
    requestId: z.string(),
    decision: z.object({ kind: z.enum(["retry", "decline"]), reason: z.string() }).passthrough(),
  })
  .passthrough()
  .nullable();

function rowsOf(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  const value = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)[key] ?? (raw as Record<string, unknown>).items : null;
  return Array.isArray(value) ? value : [];
}

function queuedFacts(raw: unknown): QueuedFacts | null {
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as { id?: unknown; threadId?: unknown; sendAt?: unknown; payload?: { kind?: unknown } | null };
  if (typeof row.id !== "string" || typeof row.threadId !== "string") return null;
  return { id: row.id, threadId: row.threadId, retry: row.payload?.kind === "retry", sendAt: typeof row.sendAt === "number" ? row.sendAt : null };
}

/** The reads and writes above, through bb's SDK (shapes as in bb 0.50.1). */
export function bbResumeThreads(bb: BbPluginApi, tell: (threadId: string, text: string) => Promise<void>): ResumeThreads {
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
        archived: Boolean(thread.archivedAt),
        projectId: typeof thread.projectId === "string" ? thread.projectId : null,
        parentThreadId: typeof thread.parentThreadId === "string" ? thread.parentThreadId : null,
        backgroundAgents: typeof thread.activeBackgroundAgentCount === "number" ? thread.activeBackgroundAgentCount : 0,
      };
    },
    async stopEvents(threadId) {
      const raw = (await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "100", types: [...STOP_EVENT_TYPES] } as never)) as unknown;
      return rowsOf(raw, "events").filter(
        (row): row is TurnEventRow => row !== null && typeof row === "object" && Number.isSafeInteger((row as TurnEventRow).seq) && typeof (row as TurnEventRow).type === "string",
      );
    },
    async queued(threadId) {
      const raw = threadId === undefined ? await bb.sdk.threads.queue.list({}) : await bb.sdk.threads.queuedMessages.list({ threadId });
      return rowsOf(raw, "queuedMessages").flatMap((row) => {
        const facts = queuedFacts(row);
        return facts === null ? [] : [facts];
      });
    },
    async sendQueued(threadId, queuedMessageId) {
      await bb.sdk.threads.queuedMessages.send({ threadId, queuedMessageId, mode: "auto" });
    },
    async retry(threadId, turnRequestId, reason) {
      await bb.sdk.threads.retry({ threadId, turnRequestId, reason });
    },
    async decision(threadId) {
      const raw = await bb.sdk.plugins.callRpc({
        pluginId: "provider-retry",
        method: "decision.get",
        input: { threadId },
        outputSchema: decisionSchema,
        signal: AbortSignal.timeout(5_000),
      } as never);
      const parsed = decisionSchema.safeParse(raw);
      if (!parsed.success || parsed.data === null) return null;
      return { requestId: parsed.data.requestId, kind: parsed.data.decision.kind, reason: parsed.data.decision.reason };
    },
    tell,
  };
}
