// Chats stopped at a usage limit continue on paid Claude once it's available
// (src/paid-resume.ts): which chats, how (a pending provider retry sent now, or
// core's retry of a skipped turn), and everything that holds a resume back.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { makeTurnFailedEvent } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import {
  BACKOFF_FIRST_MS,
  BACKOFF_MAX_MS,
  CLAUDE_CODE,
  UNKNOWN,
  WAKE_HOLD_MS,
  backoffMs,
  createPaidResumeTimer,
  DECISION_WAIT_MS,
  HEADLESS_RESUME_TEXT,
  PaidResumeStore,
  RESUME_CAP,
  RESUME_EVENT,
  RESUME_REASON,
  RESUME_STAGGER_MS,
  bbResumeThreads,
  classifyFailure,
  createPaidResume,
  mayBeLimitStop,
  parentNotice,
  readStoppedTurn,
  ResumeUnsupported,
  type MachineReader,
  type QueuedFacts,
  type ResumeThreads,
  type RetryDecision,
  type ThreadFacts,
} from "../src/paid-resume.ts";
import type { MachineState } from "../src/chat.ts";
import { BoatError } from "../src/boat.ts";
import { TaskError } from "../src/service.ts";
import { createWakeBudget } from "../src/wake-budget.ts";
import { PAID_USAGE_EVIDENCE_MS } from "../src/relay.ts";
import type { Quotas } from "../src/quota.ts";
import type { BoatSettings } from "../src/service.ts";
import type { TurnEventRow } from "../src/steer-retry.ts";
import { TaskStore, type Task } from "../src/store.ts";
import { createTestHost, defaultSettings } from "./fakes.ts";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const POOL_429 = "No Account Pooler account is currently eligible. Next account is expected to be available at 2026-11-20T09:00:00.000Z";

function settings(relay: Partial<BoatSettings["relay"]> = {}): BoatSettings {
  return defaultSettings({ relay: { enabled: false, preferred: "claude", switchAtPercent: 90, switchBackBelowPercent: 50, quietMinutes: 10, paidClaudeFallback: true, ...relay } });
}

/** Claude at its weekly limit, Codex at 99%, and a fresh "allowed" extra-usage reading. */
function usage(extra: Partial<{ allowed: boolean; status: "allowed" | "rejected"; observedAt: number }> = {}, blockedUntil?: number): Quotas {
  return new Map([
    ["claude", { provider: "claude", usedPercent: 100, resetsAt: null, window: "Weekly limit", extraUsage: { allowed: true, status: "allowed", observedAt: NOW - 60_000, pool: "on", ...extra }, ...(blockedUntil ? { blockedUntil } : {}) }],
    ["codex", { provider: "codex", usedPercent: 99, resetsAt: null, window: "Weekly limit" }],
  ]);
}

/** A chat's request and its failure, as bb logs them. */
function stoppedEvents(requestId: string, options: { root?: string; at?: number; category?: string | null; status?: number | null; message?: string; rateLimits?: { kind: string; status: string }; seq?: number } = {}): TurnEventRow[] {
  const seq = options.seq ?? 1;
  return [
    { seq, type: "client/turn/requested", data: { requestId, ...(options.root ? { retryOfRequestId: options.root, retryAttempt: 2 } : {}) } },
    ...(options.rateLimits ? [{ seq: seq + 1, type: "provider/rateLimits/updated", data: { rateLimits: options.rateLimits } }] : []),
    {
      seq: seq + 2,
      type: "provider/error",
      createdAt: options.at ?? NOW - 2 * 60_000,
      data: { errorInfo: { category: options.category === undefined ? "rate-limit" : options.category, httpStatusCode: options.status === undefined ? 429 : options.status, providerCode: null }, message: options.message ?? POOL_429 },
    },
  ];
}

class FakeThreads implements ResumeThreads {
  threads = new Map<string, ThreadFacts>();
  events = new Map<string, TurnEventRow[]>();
  rows: QueuedFacts[] = [];
  decisions = new Map<string, RetryDecision | typeof UNKNOWN>();
  /** Threads whose queue reads as UNKNOWN. */
  unknownQueues = new Set<string>();
  /** A send or retry of this thread throws this. */
  failures = new Map<string, Error>();
  sent: { threadId: string; queuedMessageId: string }[] = [];
  retried: { threadId: string; turnRequestId: string; reason: string }[] = [];
  told: { threadId: string; text: string }[] = [];
  /** Every attempt, in order (sends and retries, failed or not). */
  calls: string[] = [];
  eventReads: string[] = [];
  reads = 0;

  add(id: string, facts: Partial<ThreadFacts> = {}, events: TurnEventRow[] = stoppedEvents(`req_${id}`)): void {
    this.threads.set(id, { id, title: `Chat ${id}`, providerId: CLAUDE_CODE, status: "error", archived: false, projectId: "proj_personal", parentThreadId: null, environmentId: `env_${id}`, backgroundAgents: 0, ...facts });
    this.events.set(id, events);
  }
  async get(threadId: string) {
    this.reads++;
    return this.threads.get(threadId) ?? null;
  }
  async stopEvents(threadId: string) {
    this.eventReads.push(threadId);
    return this.events.get(threadId) ?? [];
  }
  async queued(threadId?: string) {
    if (threadId !== undefined && this.unknownQueues.has(threadId)) return UNKNOWN;
    return this.rows.filter((row) => threadId === undefined || row.threadId === threadId);
  }
  async sendQueued(threadId: string, queuedMessageId: string) {
    this.calls.push(threadId);
    const failure = this.failures.get(threadId);
    if (failure) throw failure;
    this.sent.push({ threadId, queuedMessageId });
    this.rows = this.rows.filter((row) => row.id !== queuedMessageId);
    this.threads.get(threadId)!.status = "active";
  }
  async retry(threadId: string, turnRequestId: string, reason: string) {
    this.calls.push(threadId);
    const failure = this.failures.get(threadId);
    if (failure) throw failure;
    this.retried.push({ threadId, turnRequestId, reason });
    this.threads.get(threadId)!.status = "active";
  }
  async decision(threadId: string) {
    return this.decisions.get(threadId) ?? null;
  }
  async tell(threadId: string, text: string) {
    this.told.push({ threadId, text });
  }
}

/** bb's machines and boat's sandboxes: every machine up unless a test says otherwise. */
class FakeMachines implements MachineReader {
  hosts = new Map<string, MachineState | null>();
  sandboxes = new Map<string, string | null>();
  async hostOf(environmentId: string) {
    return `host_${environmentId.replace(/^env_/, "")}`;
  }
  async host(hostId: string) {
    return this.hosts.has(hostId) ? this.hosts.get(hostId)! : { phase: "active", connected: true, message: null };
  }
  async sandbox(sandboxId: string) {
    return this.sandboxes.has(sandboxId) ? this.sandboxes.get(sandboxId)! : "running";
  }
}

/** kv in memory (the wake budget's). */
function memoryKv() {
  const values = new Map<string, unknown>();
  return {
    values,
    async get<T>(key: string) {
      return (values.get(key) as T | undefined) ?? null;
    },
    async set(key: string, value: unknown) {
      values.set(key, value);
    },
  };
}

function task(overrides: Partial<Task>): Task {
  return {
    id: "t_1", title: "Fix login", compactTitle: null, role: "implement", status: "failed", orchestratorThreadId: null, projectId: null, repo: "acme/web", repoPath: null,
    branch: null, baseBranch: "main", sandboxId: "sbx_1", conversationId: "conv_1", promptId: "p_1", provider: "claude", model: null, reasoningEffort: null, tier: null, reason: null,
    runner: "chat", threadId: null, hostId: null, environmentId: null, readyAt: null, readyNote: null, delivery: "pr", boatProject: null, environment: null, snapshot: null, extraRepos: [],
    brief: "Do it.", parentTaskId: null, prUrl: null, result: null, error: null, turns: 1, ownsSandbox: true, createdAt: "2026-11-18T10:00:00Z", updatedAt: "2026-11-18T10:00:00Z",
    finishedAt: "2026-11-18T11:00:00Z", notifiedAt: null, unshipped: null, shipApproval: null, ...overrides,
  };
}

function setup(options: { tasks?: Task[]; projects?: { id: string; name: string; localBbProjectId?: string | null; neverPaidClaude?: boolean }[]; orchestrators?: { threadId: string; projectId: string | null }[]; held?: Record<string, string>; cap?: number; kv?: ReturnType<typeof memoryKv> } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const statement of TaskStore.migrations()) db.exec(statement);
  const store = new PaidResumeStore(() => db as unknown as Database.Database);
  const threads = new FakeThreads();
  const machines = new FakeMachines();
  const tasks = options.tasks ?? [];
  const events: { taskId: string; kind: string; text: string }[] = [];
  const followups: { taskId: string; text: string }[] = [];
  const sleeps: number[] = [];
  const errors: string[] = [];
  /** A headless follow-up of this task throws this. */
  const followupFailures = new Map<string, Error>();
  let clock = NOW;
  const kv = options.kv ?? memoryKv();
  const wakes = createWakeBudget(kv, { now: () => clock });
  const resume = createPaidResume({
    threads,
    store,
    machines,
    wakes,
    tasks: {
      byThread: (threadId) => tasks.find((entry) => entry.threadId === threadId || entry.id === `chat-of-${threadId}`) ?? null,
      failedHeadless: () => tasks.filter((entry) => entry.runner === "boat" && entry.status === "failed"),
      addEvent: (taskId, kind, text) => void events.push({ taskId, kind, text }),
      continueHeadless: async (taskId, text) => {
        followups.push({ taskId, text });
        const failure = followupFailures.get(taskId);
        if (failure) throw failure;
        const entry = tasks.find((candidate) => candidate.id === taskId)!;
        entry.status = "running";
        entry.turns += 1;
      },
    },
    projects: () => options.projects ?? [],
    orchestrators: () => options.orchestrators ?? [],
    held: async (threadId) => options.held?.[threadId] ?? null,
    log: { info: () => undefined, warn: () => undefined, error: (line) => void errors.push(line) },
    sleep: async (ms) => void sleeps.push(ms),
    now: () => clock,
    ...(options.cap ? { timing: { cap: options.cap } } : {}),
  });
  return { resume, store, threads, machines, tasks, events, followups, followupFailures, sleeps, errors, kv, now: () => clock, advance: (ms: number) => void (clock += ms) };
}

/** A reading taken just now on the test's clock (an older one is stale: no paid Claude). */
function fresh(env: { now(): number }): Quotas {
  return usage({ observedAt: env.now() - 1_000 });
}

/** A chat stopped at a limit that provider-retry skipped (beyond its maximum wait): core retry continues it. */
function skippedStop(env: ReturnType<typeof setup>, id: string, facts: Partial<ThreadFacts> = {}, at = NOW - 120_000): void {
  env.threads.add(id, facts);
  env.threads.decisions.set(id, { requestId: `req_${id}`, kind: "decline", reason: "beyond-maximum-wait" });
  env.store.recordStop(id, `req_${id}`, new Date(at));
}

test("a pending provider retry waiting for the reset is sent now on paid Claude", async () => {
  const env = setup({ tasks: [task({ id: "t_web", threadId: "thr_task" })] });
  env.threads.add("thr_task");
  env.threads.rows.push({ id: "q_retry", threadId: "thr_task", retry: true, sendAt: NOW + 20 * 3_600_000 });
  assert.equal(await env.resume.stopped("thr_task", "req_thr_task"), true);

  const report = await env.resume.pass(usage(), settings());
  assert.deepEqual(env.threads.sent, [{ threadId: "thr_task", queuedMessageId: "q_retry" }]);
  assert.deepEqual(env.threads.retried, []);
  assert.deepEqual(report.resumed.map((work) => [work.threadId, work.how]), [["thr_task", "pending-retry"]]);
  assert.match(report.resumed[0]!.reason, /^on paid Claude: sent its pending provider retry now/);
  // The task's history says so; the stop is settled.
  assert.deepEqual(env.events.map((event) => [event.taskId, event.kind]), [["t_web", RESUME_EVENT]]);
  assert.deepEqual(env.store.stops(), []);
  assert.equal(env.resume.recent(), 1);

  // A pending retry with no recorded stop is found through bb's queue too.
  env.threads.add("thr_other");
  env.threads.rows.push({ id: "q_other", threadId: "thr_other", retry: true, sendAt: NOW + 3_600_000 });
  await env.resume.pass(usage(), settings());
  assert.deepEqual(env.threads.sent.at(-1), { threadId: "thr_other", queuedMessageId: "q_other" });
  // A retry due within minutes is left to run on its own.
  env.threads.add("thr_soon");
  env.threads.rows.push({ id: "q_soon", threadId: "thr_soon", retry: true, sendAt: NOW + 5 * 60_000 });
  const soon = await env.resume.pass(usage(), settings());
  assert.deepEqual(soon.skipped, [{ id: "thr_soon", reason: "its provider retry goes out soon anyway" }]);
});

test("a turn provider retry skipped (beyond its maximum wait, or no decision) is retried with core retry", async () => {
  const env = setup();
  env.threads.add("thr_skipped");
  env.threads.decisions.set("thr_skipped", { requestId: "req_thr_skipped", kind: "decline", reason: "beyond-maximum-wait" });
  await env.resume.stopped("thr_skipped", "req_thr_skipped");
  // Just failed, provider-retry hasn't said anything yet: wait for it.
  env.threads.add("thr_fresh", {}, stoppedEvents("req_fresh", { at: NOW - 10_000 }));
  await env.resume.stopped("thr_fresh", "req_fresh");

  const first = await env.resume.pass(usage(), settings());
  assert.deepEqual(env.threads.retried, [{ threadId: "thr_skipped", turnRequestId: "req_thr_skipped", reason: RESUME_REASON }]);
  assert.match(first.resumed[0]!.reason, /retried the stopped turn \(provider retry skipped it: beyond-maximum-wait\)/);
  assert.deepEqual(first.skipped, [{ id: "thr_fresh", reason: "waiting for provider retry's decision" }]);

  // A minute on and still no decision (provider-retry off or silent): core retry.
  env.advance(DECISION_WAIT_MS);
  const second = await env.resume.pass(usage(), settings());
  assert.deepEqual(env.threads.retried.at(-1), { threadId: "thr_fresh", turnRequestId: "req_fresh", reason: RESUME_REASON });
  assert.match(second.resumed[0]!.reason, /no provider retry pending/);

  // A retry provider-retry scheduled whose row is gone was cancelled by someone: left alone.
  env.threads.add("thr_cancelled");
  env.threads.decisions.set("thr_cancelled", { requestId: "req_thr_cancelled", kind: "retry", reason: "Rate limited" });
  await env.resume.stopped("thr_cancelled", "req_thr_cancelled");
  const third = await env.resume.pass(usage(), settings());
  assert.deepEqual(third.skipped, [{ id: "thr_cancelled", reason: "its provider retry was cancelled" }]);
  // A decision for an older request doesn't count: the wait applies.
  env.threads.add("thr_old_decision", {}, stoppedEvents("req_new", { at: NOW + DECISION_WAIT_MS - 1_000 }));
  env.threads.decisions.set("thr_old_decision", { requestId: "req_older", kind: "decline", reason: "beyond-maximum-wait" });
  await env.resume.stopped("thr_old_decision", "req_new");
  assert.deepEqual((await env.resume.pass(usage(), settings())).skipped, [{ id: "thr_old_decision", reason: "waiting for provider retry's decision" }]);
});

test("nothing resumes on a stale, rejected or held reading, or with the setting or the fallback off", async () => {
  const env = setup();
  env.threads.add("thr_a");
  env.threads.decisions.set("thr_a", { requestId: "req_thr_a", kind: "decline", reason: "beyond-maximum-wait" });
  await env.resume.stopped("thr_a", "req_thr_a");
  const before = env.threads.reads;
  const none = async (quotas: Quotas, current = settings()) => {
    const report = await env.resume.pass(quotas, current);
    assert.deepEqual(report.resumed, []);
  };
  await none(usage({ observedAt: NOW - PAID_USAGE_EVIDENCE_MS - 1 }));
  await none(usage({ allowed: false, status: "rejected", observedAt: NOW - 1_000 }));
  await none(usage({}, NOW + 3_600_000));
  // Codex still has included room: not paid Claude's turn.
  const room = usage();
  room.set("codex", { provider: "codex", usedPercent: 40, resetsAt: null, window: "Weekly limit" });
  await none(room);
  await none(usage(), settings({ resumeStoppedChats: false }));
  await none(usage(), settings({ paidClaudeFallback: false }));
  await none(usage(), { ...settings(), notConnectedAgents: ["claude"] });
  // None of these even looked at a chat.
  assert.equal(env.threads.reads, before);
  assert.deepEqual(env.threads.retried, []);
  // The same chat continues once the reading allows it.
  await env.resume.pass(usage(), settings());
  assert.equal(env.threads.retried.length, 1);
});

test("only Claude chats stopped at a usage limit, idle or in error and not archived, continue", async () => {
  const env = setup({
    tasks: [task({ id: "t_moved", threadId: "thr_new_chat" }), task({ id: "chat-of-thr_old_chat", threadId: "thr_new_chat2" })],
    held: { thr_handover: "being handed over to another agent", thr_former: "a former orchestrator (another chat took over)" },
  });
  const declined = (id: string) => env.threads.decisions.set(id, { requestId: `req_${id}`, kind: "decline", reason: "not-retryable" });
  const cases: [string, Partial<ThreadFacts>, TurnEventRow[] | undefined, string][] = [
    ["thr_auth", {}, stoppedEvents("req_thr_auth", { category: "unauthorized", status: 401, message: "Invalid API key" }), "it stopped on an authentication failure"],
    ["thr_spend", {}, stoppedEvents("req_thr_spend", { message: "You're out of extra usage. Your spend limit was reached." }), "it stopped on a credit or spend limit"],
    ["thr_credits", {}, stoppedEvents("req_thr_credits", { rateLimits: { kind: "spend-control", status: "blocked" } }), "it stopped on a credit or spend limit"],
    ["thr_overloaded", {}, stoppedEvents("req_thr_overloaded", { category: "overloaded", status: 529, message: "Overloaded" }), "it stopped on a overloaded failure"],
    ["thr_codex", { providerId: "codex" }, undefined, "not a Claude Code chat"],
    ["thr_archived", { archived: true }, undefined, "archived"],
    ["thr_running", { status: "active" }, undefined, "a turn is running"],
    ["thr_background", { status: "idle", backgroundAgents: 1 }, undefined, "a turn is running"],
    ["thr_idle", { status: "idle" }, undefined, "it isn't stopped"],
    ["thr_old_chat", {}, undefined, "an earlier chat of task chat-of-thr_old_chat"],
    ["thr_handover", {}, undefined, "being handed over to another agent"],
    ["thr_former", {}, undefined, "a former orchestrator (another chat took over)"],
  ];
  for (const [id, facts, events] of cases) {
    env.threads.add(id, facts, events);
    declined(id);
    env.store.recordStop(id, `req_${id}`, new Date(NOW - 120_000));
  }
  // A queued message waits for its turn: no resume ahead of it.
  env.threads.add("thr_queued");
  declined("thr_queued");
  env.store.recordStop("thr_queued", "req_thr_queued", new Date(NOW - 120_000));
  env.threads.rows.push({ id: "q_user", threadId: "thr_queued", retry: false, sendAt: null });

  const report = await env.resume.pass(usage(), settings());
  assert.deepEqual(report.resumed, []);
  assert.deepEqual(env.threads.retried, []);
  const reasons = new Map(report.skipped.map((entry) => [entry.id, entry.reason]));
  for (const [id, , , reason] of cases) assert.equal(reasons.get(id), reason, id);
  assert.equal(reasons.get("thr_queued"), "a message is queued");
  // Settled stops are forgotten; the queued and held ones are looked at again.
  assert.deepEqual(env.store.stops().map((stop) => stop.threadId).sort(), ["thr_former", "thr_handover", "thr_queued"]);
  // A Codex chat's failure isn't even recorded.
  assert.equal(await env.resume.stopped("thr_codex", "req"), false);
});

test("a project that never continues on paid Claude keeps its chats and tasks on included usage", async () => {
  const env = setup({
    projects: [
      { id: "web", name: "Web app", localBbProjectId: "proj_web", neverPaidClaude: true },
      { id: "docs", name: "Docs", localBbProjectId: null, neverPaidClaude: true },
      { id: "api", name: "API", localBbProjectId: "proj_api" },
    ],
    orchestrators: [{ threadId: "thr_orch_docs", projectId: "docs" }],
    tasks: [task({ id: "t_docs", threadId: "thr_docs_task", boatProject: "docs" })],
  });
  const add = (id: string, facts: Partial<ThreadFacts>) => {
    env.threads.add(id, facts);
    env.threads.decisions.set(id, { requestId: `req_${id}`, kind: "decline", reason: "beyond-maximum-wait" });
    env.store.recordStop(id, `req_${id}`, new Date(NOW - 120_000));
  };
  add("thr_in_web", { projectId: "proj_web" });
  add("thr_docs_task", {});
  add("thr_orch_docs", {});
  add("thr_in_api", { projectId: "proj_api" });
  const report = await env.resume.pass(usage(), settings());
  assert.deepEqual(report.resumed.map((work) => work.threadId), ["thr_in_api"]);
  assert.deepEqual(
    report.skipped.map((entry) => [entry.id, entry.reason]),
    [
      ["thr_in_web", "project Web app never continues on paid Claude"],
      ["thr_docs_task", "project Docs never continues on paid Claude"],
      ["thr_orch_docs", "project Docs never continues on paid Claude"],
    ],
  );
  // They stay candidates: turning the opt-out off later lets them continue.
  assert.equal(env.store.stops().length, 3);
});

test("headless Boat tasks continue only with the headless opt-in, and once per stopped turn", async () => {
  const headless = task({ id: "t_headless", runner: "boat", orchestratorThreadId: "thr_orch", error: "Claude AI usage limit reached|1763600000", turns: 3 });
  const spent = task({ id: "t_spent", runner: "boat", error: "You're out of extra usage" });
  const codex = task({ id: "t_codex", runner: "boat", provider: "codex", error: "You've hit your usage limit" });
  // Stopped weeks ago and never closed: not picked up again out of the blue.
  const stale = task({ id: "t_stale", runner: "boat", error: "Claude AI usage limit reached", finishedAt: "2026-10-01T00:00:00Z" });
  const env = setup({ tasks: [headless, spent, codex, stale], orchestrators: [{ threadId: "thr_orch", projectId: null }] });
  env.threads.add("thr_orch", { status: "idle" }, []);

  // Without the opt-in, a start would wait too: nothing.
  assert.deepEqual((await env.resume.pass(usage(), settings())).resumed, []);
  assert.deepEqual(env.followups, []);

  const report = await env.resume.pass(usage(), settings({ paidClaudeHeadless: true }));
  assert.deepEqual(env.followups, [{ taskId: "t_headless", text: HEADLESS_RESUME_TEXT }]);
  assert.deepEqual(report.resumed.map((work) => [work.taskId, work.how]), [["t_headless", "follow-up"]]);
  assert.deepEqual(env.events.map((event) => [event.taskId, event.kind]), [["t_headless", RESUME_EVENT]]);
  // Its orchestrator hears about it.
  assert.equal(env.threads.told.length, 1);
  assert.match(env.threads.told[0]!.text, /task t_headless \(Fix login\)/);

  // The resumed turn hits a limit again: never a second time.
  headless.status = "failed";
  assert.deepEqual((await env.resume.pass(usage(), settings({ paidClaudeHeadless: true }))).resumed, []);
  assert.equal(env.followups.length, 1);
});

test("one resume per stopped turn: a resumed turn that fails again stays stopped", async () => {
  const env = setup();
  env.threads.add("thr_loop");
  env.threads.decisions.set("thr_loop", { requestId: "req_first", kind: "decline", reason: "beyond-maximum-wait" });
  env.threads.events.set("thr_loop", stoppedEvents("req_first"));
  await env.resume.stopped("thr_loop", "req_first");
  await env.resume.pass(usage(), settings());
  assert.equal(env.threads.retried.length, 1);

  // The retry (same chain: retryOfRequestId) hits a limit again, and provider-retry skips it again.
  env.threads.threads.get("thr_loop")!.status = "error";
  env.threads.events.set("thr_loop", [...stoppedEvents("req_first"), ...stoppedEvents("req_retry", { root: "req_first", seq: 10 })]);
  env.threads.decisions.set("thr_loop", { requestId: "req_retry", kind: "decline", reason: "beyond-maximum-wait" });
  await env.resume.stopped("thr_loop", "req_retry");
  const again = await env.resume.pass(usage(), settings());
  assert.deepEqual(again.resumed, []);
  assert.deepEqual(again.skipped, [{ id: "thr_loop", reason: "this stopped turn was continued once already" }]);
  assert.equal(env.threads.retried.length, 1);

  // A new message of the user's that stops at a limit is a new stopped turn.
  env.threads.events.set("thr_loop", stoppedEvents("req_user", { seq: 20 }));
  env.threads.decisions.set("thr_loop", { requestId: "req_user", kind: "decline", reason: "beyond-maximum-wait" });
  await env.resume.stopped("thr_loop", "req_user");
  await env.resume.pass(usage(), settings());
  assert.deepEqual(env.threads.retried.at(-1), { threadId: "thr_loop", turnRequestId: "req_user", reason: RESUME_REASON });
});

test("each pass resumes at most ten chats, a few seconds apart; the rest go next pass", async () => {
  const env = setup();
  for (let index = 0; index < 12; index++) {
    const id = `thr_${String(index).padStart(2, "0")}`;
    env.threads.add(id);
    env.threads.decisions.set(id, { requestId: `req_${id}`, kind: "decline", reason: "beyond-maximum-wait" });
    env.store.recordStop(id, `req_${id}`, new Date(NOW - 600_000 + index));
  }
  const first = await env.resume.pass(usage(), settings());
  assert.equal(RESUME_CAP, 10);
  assert.equal(first.resumed.length, RESUME_CAP);
  // Oldest stops first.
  assert.deepEqual(first.resumed.map((work) => work.threadId).slice(0, 2), ["thr_00", "thr_01"]);
  assert.deepEqual(first.deferred, ["thr_10", "thr_11"]);
  assert.deepEqual(env.sleeps, Array(RESUME_CAP - 1).fill(RESUME_STAGGER_MS));
  const second = await env.resume.pass(usage(), settings());
  assert.deepEqual(second.resumed.map((work) => work.threadId), ["thr_10", "thr_11"]);
  assert.equal(env.threads.retried.length, 12);
});

test("a Boat orchestrator hears once per pass which of its workers continue", async () => {
  const env = setup({
    orchestrators: [{ threadId: "thr_orch", projectId: null }],
    tasks: [task({ id: "t_1", threadId: "thr_w1", orchestratorThreadId: "thr_orch", title: "Header" })],
  });
  env.threads.add("thr_orch", { status: "idle" }, []);
  const stop = (id: string, facts: Partial<ThreadFacts>) => {
    env.threads.add(id, facts);
    env.threads.decisions.set(id, { requestId: `req_${id}`, kind: "decline", reason: "beyond-maximum-wait" });
    env.store.recordStop(id, `req_${id}`, new Date(NOW - 120_000));
  };
  stop("thr_w1", { title: "Header" });
  stop("thr_w2", { parentThreadId: "thr_orch", title: "Footer" });
  stop("thr_w3", { parentThreadId: "thr_orch", title: null });
  stop("thr_loose", { parentThreadId: "thr_someone" });
  const report = await env.resume.pass(usage(), settings());
  assert.equal(report.resumed.length, 4);
  assert.deepEqual(report.told, ["thr_orch"]);
  assert.deepEqual(env.threads.told, [
    {
      threadId: "thr_orch",
      text: "[boat] Paid Claude is available, so 3 workers that stopped at a usage limit continue on it: @thread:thr_w1 (Header), @thread:thr_w2 (Footer), @thread:thr_w3. Claude's billing limits apply. Each stopped turn is continued once.",
    },
  ]);
  // An orchestrator that is stopped itself (and wasn't continued) gets no new turn from a notice.
  const quiet = setup({ orchestrators: [{ threadId: "thr_down", projectId: null }] });
  quiet.threads.add("thr_down", { status: "error" }, stoppedEvents("req_down", { category: "unauthorized", status: 401 }));
  quiet.threads.add("thr_kid", { parentThreadId: "thr_down" });
  quiet.threads.decisions.set("thr_kid", { requestId: "req_thr_kid", kind: "decline", reason: "beyond-maximum-wait" });
  quiet.store.recordStop("thr_kid", "req_thr_kid", new Date(NOW - 120_000));
  assert.equal((await quiet.resume.pass(usage(), settings())).resumed.length, 1);
  assert.deepEqual(quiet.threads.told, []);
  assert.equal(parentNotice([{ threadId: null, taskId: "t_9", title: "Docs" }]), "[boat] Paid Claude is available, so 1 worker that stopped at a usage limit continues on it: task t_9 (Docs). Claude's billing limits apply. Each stopped turn is continued once.");
});

test("reading a stopped turn: the failed request, its chain, a door rejection, and what isn't a usage limit", () => {
  const read = readStoppedTurn(stoppedEvents("req_2", { root: "req_1" }));
  assert.deepEqual(read, { requestId: "req_2", rootRequestId: "req_1", failedAt: NOW - 120_000, failure: { kind: "usage-limit" } });
  // A provider error bb retries itself doesn't count; one before the request doesn't either.
  const earlier: TurnEventRow[] = [
    { seq: 1, type: "provider/error", data: { errorInfo: { category: "rate-limit", httpStatusCode: 429 }, message: "old" } },
    { seq: 2, type: "client/turn/requested", data: { requestId: "req_x" } },
    { seq: 3, type: "provider/error", data: { errorInfo: { category: "overloaded", httpStatusCode: 529 }, message: "busy", willRetry: true } },
  ];
  assert.deepEqual(readStoppedTurn(earlier)?.failure, { kind: "other", why: "no provider error" });
  // Refused at the door, as bb maps it.
  const door: TurnEventRow[] = [
    { seq: 1, type: "client/turn/requested", data: { requestId: "req_d" } },
    { seq: 2, type: "client/turn/rejected", createdAt: NOW, data: { requestId: "req_d", reason: "rate_limited", message: "Rate limited" } },
  ];
  assert.deepEqual(readStoppedTurn(door), { requestId: "req_d", rootRequestId: "req_d", failedAt: NOW, failure: { kind: "usage-limit" } });
  assert.equal(readStoppedTurn([]), null);
  // The classification on its own.
  const facts = { category: "rate-limit", httpStatusCode: 429, rateLimits: null, texts: [POOL_429] };
  assert.deepEqual(classifyFailure(facts), { kind: "usage-limit" });
  assert.deepEqual(classifyFailure({ ...facts, category: null, httpStatusCode: 429 }), { kind: "usage-limit" });
  assert.equal(classifyFailure({ ...facts, category: "billing" }).kind, "other");
  assert.equal(classifyFailure({ ...facts, texts: ["Your credit balance is too low"] }).kind, "other");
  assert.equal(classifyFailure({ ...facts, rateLimits: { kind: "credits", status: "blocked" } }).kind, "other");
  // A subscription window that's blocked is exactly the case.
  assert.equal(classifyFailure({ ...facts, rateLimits: { kind: "subscription-window", status: "blocked" } }).kind, "usage-limit");
  assert.equal(mayBeLimitStop({ errorInfo: { category: "rate-limit", httpStatusCode: null } }), true);
  assert.equal(mayBeLimitStop({ errorInfo: { category: "overloaded", httpStatusCode: 529 } }), false);
});

test("bb's side: decision.get through callRpc, a pending row sent with mode auto, core retry by turn", async () => {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  let decision: unknown = { requestId: "req_1", observedAt: NOW, availability: { kind: "blocked", retryAt: NOW + 86_400_000 }, decision: { kind: "decline", reason: "beyond-maximum-wait" } };
  let rpcFails = false;
  let queuedReply: unknown = [];
  const bb = {
    sdk: {
      plugins: {
        callRpc: async (args: Record<string, unknown>) => {
          calls.push({ method: "plugins.callRpc", args });
          if (rpcFails) throw new Error("unknown_method: decision.get");
          return decision;
        },
      },
      threads: {
        get: async (args: Record<string, unknown>) => {
          calls.push({ method: "threads.get", args });
          return { id: args.threadId, title: "", titleFallback: "Fix login", providerId: CLAUDE_CODE, status: "error", archivedAt: null, deletedAt: null, projectId: "proj_web", parentThreadId: "thr_orch", environmentId: "env_a" };
        },
        events: { list: async (args: Record<string, unknown>) => (calls.push({ method: "threads.events.list", args }), stoppedEvents("req_1")) },
        queue: { list: async (args: Record<string, unknown>) => (calls.push({ method: "threads.queue.list", args }), [{ id: "q_1", threadId: "thr_a", payload: { kind: "retry", attempt: 2, reason: "Rate limited", retryOfTurnRequestId: "req_1" }, sendAt: NOW + 1 }, { id: "q_2", threadId: "thr_b", payload: { kind: "inline" }, sendAt: null }]) },
        queuedMessages: {
          list: async (args: Record<string, unknown>) => (calls.push({ method: "threads.queuedMessages.list", args }), queuedReply),
          send: async (args: Record<string, unknown>) => (calls.push({ method: "threads.queuedMessages.send", args }), { ok: true, delivery: "sent" }),
        },
        retry: async (args: Record<string, unknown>) => (calls.push({ method: "threads.retry", args }), { ok: true, delivery: "sent", attempt: 2, turnRequestId: "req_2" }),
      },
    },
  };
  const errors: string[] = [];
  const threads = bbResumeThreads(bb as never, async () => undefined, { error: (line) => void errors.push(line) });
  assert.deepEqual(await threads.decision("thr_a"), { requestId: "req_1", kind: "decline", reason: "beyond-maximum-wait" });
  const rpc = calls.find((call) => call.method === "plugins.callRpc")!.args;
  assert.equal(rpc.pluginId, "provider-retry");
  assert.equal(rpc.method, "decision.get");
  assert.deepEqual(rpc.input, { threadId: "thr_a" });
  // Only a parsed null means "no decision".
  decision = null;
  assert.equal(await threads.decision("thr_a"), null);
  // Another shape (another bb version) or a call that fails: unknown, never "no decision".
  decision = { unexpected: true };
  assert.equal(await threads.decision("thr_a"), UNKNOWN);
  assert.match(errors.at(-1)!, /decision\.get answered in a shape this version doesn't know \(keys unexpected\)/);
  rpcFails = true;
  assert.equal(await threads.decision("thr_a"), UNKNOWN);
  rpcFails = false;
  // A queue reply in an unknown shape, or with a row it can't read, hides nothing: unknown.
  queuedReply = { rows: [] };
  assert.equal(await threads.queued("thr_a"), UNKNOWN);
  assert.match(errors.at(-1)!, /threads\.queuedMessages\.list answered in a shape this version doesn't know/);
  queuedReply = [{ threadId: "thr_a", payload: { kind: "retry" } }];
  assert.equal(await threads.queued("thr_a"), UNKNOWN);
  queuedReply = { queuedMessages: [{ id: "q_9", payload: { kind: "retry" }, sendAt: null }, { id: "q_10" }] };
  assert.deepEqual(await threads.queued("thr_a"), [{ id: "q_9", threadId: "thr_a", retry: true, sendAt: null }, { id: "q_10", threadId: "thr_a", retry: false, sendAt: null }]);
  queuedReply = [];

  assert.deepEqual(await threads.get("thr_a"), { id: "thr_a", title: "Fix login", providerId: CLAUDE_CODE, status: "error", archived: false, projectId: "proj_web", parentThreadId: "thr_orch", environmentId: "env_a", backgroundAgents: 0 });
  assert.deepEqual(await threads.queued(), [{ id: "q_1", threadId: "thr_a", retry: true, sendAt: NOW + 1 }, { id: "q_2", threadId: "thr_b", retry: false, sendAt: null }]);
  assert.deepEqual(calls.find((call) => call.method === "threads.queue.list")!.args, {});
  await threads.queued("thr_a");
  assert.deepEqual(calls.find((call) => call.method === "threads.queuedMessages.list")!.args, { threadId: "thr_a" });
  await threads.sendQueued("thr_a", "q_1");
  assert.deepEqual(calls.find((call) => call.method === "threads.queuedMessages.send")!.args, { threadId: "thr_a", queuedMessageId: "q_1", mode: "auto" });
  await threads.retry("thr_a", "req_1", RESUME_REASON);
  assert.deepEqual(calls.find((call) => call.method === "threads.retry")!.args, { threadId: "thr_a", turnRequestId: "req_1", reason: RESUME_REASON });
  assert.equal((await threads.stopEvents("thr_a")).length, 2);
  // An older bb without these calls: nothing is sent, and the attempt says why.
  const older = bbResumeThreads({ sdk: { threads: { queuedMessages: {} } } } as never, async () => undefined);
  await assert.rejects(older.retry("thr_a", "req_1", RESUME_REASON), ResumeUnsupported);
  await assert.rejects(older.sendQueued("thr_a", "q_1"), ResumeUnsupported);
  const list = calls.find((call) => call.method === "threads.events.list")!.args;
  assert.equal(list.order, "desc");
  assert.ok((list.types as string[]).includes("provider/error") && (list.types as string[]).includes("client/turn/rejected"));
});

/** The fake boat CLI keeps its state in a fresh temp file. */
function fakeBoatState(): void {
  process.env.FAKE_BOAT_STATE = join(mkdtempSync(join(tmpdir(), "boat-paid-resume-")), "state.json");
}

test("the plugin: a chat stopped at a Pooler 429 continues on paid Claude at the relay check, once", async (t) => {
  fakeBoatState();
  const { bb, harness } = await createTestHost({
    pluginId: "boat",
    settings: { boatPath: fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url)), evidenceUploader: "", paidClaudeFallback: true },
  });
  t.after(() => harness.lifecycle.dispose());
  const thread = { id: "thr_chat", title: "Refactor", providerId: CLAUDE_CODE, status: "error", archivedAt: null, deletedAt: null, projectId: "proj_personal", parentThreadId: null, environmentId: "env_chat" };
  // Its workspace is on this computer, which is up.
  harness.sdk.stub("environments.get", async () => ({ id: "env_chat", hostId: "host_local" }));
  harness.sdk.stub("hosts.get", async () => ({ id: "host_local", status: "connected", machineProviderId: null, lifecycle: { phase: "active", suspendedAt: null, message: null } }));
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => (threadId === thread.id ? thread : { id: threadId, archivedAt: null, deletedAt: null }));
  harness.sdk.stub("threads.events.list", async () => stoppedEvents("req_chat", { at: Date.now() - 120_000 }));
  harness.sdk.stub("threads.queuedMessages.list", async () => []);
  harness.sdk.stub("threads.queue.list", async () => []);
  harness.sdk.stub("threads.retry", async () => {
    thread.status = "active";
    return { ok: true, delivery: "sent", attempt: 2, turnRequestId: "req_chat_2" };
  });
  harness.sdk.stub("plugins.callRpc", async ({ pluginId, method, input }: { pluginId: string; method: string; input: { resourceId?: string; threadId?: string } }) => {
    if (pluginId === "provider-retry" && method === "decision.get") return { requestId: "req_chat", observedAt: Date.now(), availability: { kind: "blocked", retryAt: Date.now() + 40 * 3_600_000 }, decision: { kind: "decline", reason: "beyond-maximum-wait" } };
    if (pluginId !== "account-pool") throw new Error("not installed");
    if (method === "status.get") return { routing: { claude: true, codex: true }, accounts: [{ id: "c", provider: "claude", status: "ready", extraUsage: { status: "allowed", observedAt: Date.now() } }, { id: "x", provider: "codex", status: "ready" }] };
    if (method.endsWith("listResources")) return { resources: [{ id: "c", providerId: "claude-code" }, { id: "x", providerId: "codex" }] };
    return { usage: { status: "ok", windows: [{ label: "Weekly limit", usedPercent: input.resourceId === "c" ? 100 : 99, resetsAt: "2026-11-24T00:00:00Z", model: null }] } };
  });
  await plugin(bb);
  // bb reports the failed turn (the stop is remembered; the follow-up check waits a moment).
  await harness.emitThreadEvent("turn.failed", makeTurnFailedEvent({ threadId: "thr_chat", requestId: "req_chat", errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null } }));

  const check = await harness.runCli(["relay", "check", "--json"]);
  assert.equal(check.exitCode, 0, check.stderr);
  const { actions } = JSON.parse(check.stdout) as { actions: { kind: string; threadId: string; reason: string }[] };
  assert.deepEqual(actions.map((action) => [action.kind, action.threadId]), [["resumed", "thr_chat"]]);
  assert.match(actions[0]!.reason, /beyond-maximum-wait/);
  assert.deepEqual(harness.inspection.sdk.callsTo("threads.retry").map((call) => call[0]), [{ threadId: "thr_chat", turnRequestId: "req_chat", reason: RESUME_REASON }]);
  const text = await harness.runCli(["relay", "check"]);
  assert.equal(text.stdout.trim(), "Nothing to switch.");
  assert.equal(harness.inspection.sdk.callsTo("threads.retry").length, 1);
  // The usage view says so.
  const view = (await harness.callRpc("usage", null)) as { resumedOnPaid?: number };
  assert.equal(view.resumedOnPaid, 1);
});

test("a project's Never continue on paid Claude: set with bb boat project set, kept when left out, shown in the list", async (t) => {
  fakeBoatState();
  const { bb, harness } = await createTestHost({
    pluginId: "boat",
    settings: { boatPath: fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url)), evidenceUploader: "" },
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  assert.equal((await harness.runCli(["project", "add", "--name", "Web app", "--repo", "acme/web@main"])).exitCode, 0);
  const project = async () => ((await harness.callRpc("projects", null)) as { projects: { id: string; neverPaidClaude?: boolean }[] }).projects[0]!;
  // Off by default, and not even written down (older backups stay the same).
  assert.equal("neverPaidClaude" in (await project()), false);
  const never = await harness.runCli(["project", "set", "web-app", "--paid-claude", "never"]);
  assert.equal(never.exitCode, 0, never.stderr);
  assert.match(never.stdout, /never continues on paid Claude/);
  assert.equal((await project()).neverPaidClaude, true);
  // Another change leaves it as it is.
  assert.equal((await harness.runCli(["project", "set", "web-app", "--delivery", "push"])).exitCode, 0);
  assert.equal((await project()).neverPaidClaude, true);
  assert.equal((await harness.runCli(["project", "set", "web-app", "--paid-claude", "allow"])).exitCode, 0);
  assert.equal("neverPaidClaude" in (await project()), false);
  const invalid = await harness.runCli(["project", "set", "web-app", "--paid-claude", "sometimes"]);
  assert.notEqual(invalid.exitCode, 0);
  assert.match(invalid.stderr, /allow|never/);
});

const pad = (index: number) => String(index).padStart(2, "0");

test("a failed resume ends the pass: every attempt counts and waits its turn, the pass backs off, and a stopped turn gets three tries", async () => {
  const env = setup();
  for (let index = 0; index < 25; index++) skippedStop(env, `thr_${pad(index)}`, {}, NOW - 600_000 + index);
  const overloaded = new Error("503 Failed to restore snapshot: Please reduce your request rate");
  for (const id of env.threads.threads.keys()) env.threads.failures.set(id, overloaded);

  // boat.dev struggles: one attempt, then the pass stops and backs off (not 25 attempts in a row).
  const first = await env.resume.pass(fresh(env), settings());
  assert.equal(first.attempts, 1);
  assert.deepEqual(env.threads.calls, ["thr_00"]);
  assert.equal(first.deferred.length, 24);
  assert.equal(first.backoffUntil, NOW + BACKOFF_FIRST_MS);
  assert.deepEqual(env.store.backoff(), { until: NOW + BACKOFF_FIRST_MS, failures: 1 });
  // The failed try didn't use the stopped turn up, and its stop stays.
  assert.equal(env.store.settled("thr_00", "req_thr_00"), false);
  assert.equal(env.store.stops().length, 25);

  // Nothing during the backoff (it's in the store, so a restart keeps it).
  env.advance(BACKOFF_FIRST_MS - 1);
  assert.equal((await env.resume.pass(fresh(env), settings())).attempts, 0);
  env.advance(1);
  await env.resume.pass(fresh(env), settings());
  // Doubled: ten minutes after the second failure.
  assert.deepEqual(env.store.backoff(), { until: NOW + BACKOFF_FIRST_MS + 2 * BACKOFF_FIRST_MS, failures: 2 });
  env.advance(2 * BACKOFF_FIRST_MS);
  await env.resume.pass(fresh(env), settings());
  assert.equal(env.store.backoff()?.failures, 3);
  // Three tries of the same stopped turn: it's settled, and the next chat gets its turn.
  assert.deepEqual(env.threads.calls, ["thr_00", "thr_00", "thr_00"]);
  assert.equal(env.store.settled("thr_00", "req_thr_00"), true);
  env.advance(4 * BACKOFF_FIRST_MS);
  await env.resume.pass(fresh(env), settings());
  assert.equal(env.threads.calls.at(-1), "thr_01");
  assert.equal(backoffMs(20), BACKOFF_MAX_MS);

  // boat.dev is fine again: ten attempts a pass, three seconds apart, and the backoff is cleared.
  env.threads.failures.clear();
  env.advance(BACKOFF_MAX_MS);
  const sleepsBefore = env.sleeps.length;
  const recovered = await env.resume.pass(fresh(env), settings());
  assert.equal(recovered.attempts, RESUME_CAP);
  assert.deepEqual(recovered.resumed.map((work) => work.threadId).slice(0, 2), ["thr_01", "thr_02"]);
  assert.deepEqual(env.sleeps.slice(sleepsBefore), Array(RESUME_CAP - 1).fill(RESUME_STAGGER_MS));
  assert.equal(env.store.backoff(), null);
});

test("a resume bb refuses because the turn moved on (409) or is gone (404) gives its try back and doesn't stop the pass", async () => {
  const env = setup();
  skippedStop(env, "thr_moved", {}, NOW - 300_000);
  skippedStop(env, "thr_gone", {}, NOW - 200_000);
  skippedStop(env, "thr_ok", {}, NOW - 100_000);
  env.threads.failures.set("thr_moved", Object.assign(new Error("Turn req_thr_moved is not the failed turn on thread thr_moved"), { status: 409, code: "no_failed_turn" }));
  env.threads.failures.set("thr_gone", new Error("404 thread not found"));
  const report = await env.resume.pass(usage(), settings());
  // Every attempt counted and waited its turn; nothing backed off.
  assert.equal(report.attempts, 3);
  assert.deepEqual(env.sleeps, [RESUME_STAGGER_MS, RESUME_STAGGER_MS]);
  assert.deepEqual(report.resumed.map((work) => work.threadId), ["thr_ok"]);
  assert.equal(env.store.backoff(), null);
  assert.equal(env.store.attempts("thr_moved", "req_thr_moved"), 0);
  assert.equal(env.store.attempts("thr_gone", "req_thr_gone"), 0);
});

test("a headless follow-up is tried again only when it provably sent nothing", async () => {
  const limit = "Claude AI usage limit reached|1763600000";
  const atBoat = task({ id: "t_boat", runner: "boat", error: limit, sandboxId: "sbx_up", finishedAt: "2026-11-18T09:00:00Z" });
  const restore = task({ id: "t_restore", runner: "boat", error: limit, sandboxId: "sbx_stopped", finishedAt: "2026-11-18T10:00:00Z" });
  const refused = task({ id: "t_refused", runner: "boat", error: limit, sandboxId: "sbx_up2", finishedAt: "2026-11-18T11:00:00Z" });
  const env = setup({ tasks: [atBoat, restore, refused] });
  const paid = settings({ paidClaudeHeadless: true });
  env.machines.sandboxes.set("sbx_stopped", "stopped");

  // A boat error with its sandbox up: the prompt may have reached the agent, so never a second follow-up.
  env.followupFailures.set("t_boat", new BoatError("boat prompt timed out", { code: "timeout" }));
  const first = await env.resume.pass(fresh(env), paid);
  // One headless follow-up a pass.
  assert.equal(first.attempts, 1);
  assert.deepEqual(env.followups.map((entry) => entry.taskId), ["t_boat"]);
  assert.equal(env.store.settled("task:t_boat", "turn:1"), true);
  assert.equal(env.store.backoff()?.failures, 1);

  // Its sandbox couldn't be restored (still stopped): nothing reached it, tried again after the backoff.
  env.advance(BACKOFF_FIRST_MS);
  env.followupFailures.set("t_restore", new BoatError("Failed to restore snapshot: Please reduce your request rate"));
  await env.resume.pass(fresh(env), paid);
  assert.deepEqual(env.followups.map((entry) => entry.taskId), ["t_boat", "t_restore"]);
  assert.equal(env.store.settled("task:t_restore", "turn:1"), false);
  // A wake that failed holds further wakes as well.
  assert.ok(env.store.wakeHold() > NOW + BACKOFF_FIRST_MS);

  // The service's own admission check refused it: nothing went out, so no try is used and nothing backs off.
  env.advance(WAKE_HOLD_MS);
  env.followupFailures.set("t_restore", new TaskError("Claude is near its usage limit. This work will wait for a reset.", "agents_at_limit"));
  const refusedPass = await env.resume.pass(fresh(env), paid);
  assert.equal(env.followups.at(-1)!.taskId, "t_restore");
  assert.equal(env.store.attempts("task:t_restore", "turn:1"), 1);
  assert.equal(refusedPass.backoffUntil, null);
  // Now it goes through.
  env.followupFailures.clear();
  env.advance(60_000);
  await env.resume.pass(fresh(env), paid);
  assert.equal(restore.status, "running");
  assert.equal(env.store.attempts("task:t_restore", "turn:1"), 2);
  // The boat error's task was never sent a second follow-up.
  assert.equal(env.followups.filter((entry) => entry.taskId === "t_boat").length, 1);
});

test("machines: one starting, stopping, failed or offline is left alone; waking one takes one of two wakes a minute", async () => {
  const env = setup({ tasks: [task({ id: "t_chat", threadId: "thr_sbx_error", sandboxId: "sbx_err" })] });
  const phase = (id: string, state: Partial<MachineState>) => env.machines.hosts.set(`host_${id}`, { phase: "active", connected: true, message: null, ...state });
  for (const id of ["thr_resuming", "thr_suspending", "thr_creating", "thr_offline", "thr_up", "thr_sleep1", "thr_sleep2", "thr_sleep3"]) skippedStop(env, id);
  phase("thr_resuming", { phase: "resuming", connected: false });
  phase("thr_suspending", { phase: "suspending", connected: false });
  phase("thr_creating", { phase: "creating", connected: false });
  phase("thr_offline", { connected: false });
  for (const id of ["thr_sleep1", "thr_sleep2", "thr_sleep3"]) phase(id, { phase: "suspended", connected: false });

  const first = await env.resume.pass(usage(), settings());
  const reasons = new Map(first.skipped.map((entry) => [entry.id, entry.reason]));
  assert.equal(reasons.get("thr_resuming"), "its machine is resuming");
  assert.equal(reasons.get("thr_suspending"), "its machine is suspending");
  assert.equal(reasons.get("thr_creating"), "its machine is creating");
  assert.equal(reasons.get("thr_offline"), "its machine is offline");
  // Two of the three sleeping machines are woken; the third waits for a wake.
  assert.deepEqual(first.resumed.map((work) => work.threadId).sort(), ["thr_sleep1", "thr_sleep2", "thr_up"]);
  assert.equal(reasons.get("thr_sleep3"), "waiting for a wake (at most 2 a minute)");
  assert.deepEqual(first.deferred, ["thr_sleep3"]);
  // Machines on the move keep their stop for a later look.
  assert.deepEqual(env.store.stops().map((stop) => stop.threadId).sort(), ["thr_creating", "thr_offline", "thr_resuming", "thr_sleep3", "thr_suspending"]);

  // The budget is in kv: a restart (a new budget on the same kv) has no wake to give yet…
  assert.equal(await createWakeBudget(env.kv, { now: () => NOW }).take(), false);
  // …and half a minute later there is one.
  env.advance(30_000);
  const second = await env.resume.pass(usage(), settings());
  assert.deepEqual(second.resumed.map((work) => work.threadId), ["thr_sleep3"]);

  // A task chat whose sandbox is in error: left alone, and no machine is woken for a while.
  skippedStop(env, "thr_sbx_error");
  env.machines.sandboxes.set("sbx_err", "error");
  skippedStop(env, "thr_sleep4");
  phase("thr_sleep4", { phase: "suspended", connected: false });
  skippedStop(env, "thr_failed_resume");
  phase("thr_failed_resume", { phase: "suspended", connected: false, message: "Machine resume failed: EIO" });
  env.advance(120_000);
  const third = await env.resume.pass(usage(), settings());
  const later = new Map(third.skipped.map((entry) => [entry.id, entry.reason]));
  assert.equal(later.get("thr_sbx_error"), "its sandbox is error");
  assert.equal(later.get("thr_failed_resume"), "its machine failed: Machine resume failed: EIO");
  assert.equal(later.get("thr_sleep4"), "machines aren't woken for now (one failed to start)");
  assert.equal(env.store.wakeHold(), NOW + 150_000 + WAKE_HOLD_MS);
  assert.deepEqual(third.resumed, []);
});

test("the wake budget: two a minute, one at a time, kept across a restart", async () => {
  const kv = memoryKv();
  let clock = NOW;
  const budget = createWakeBudget(kv, { now: () => clock });
  // The watchdog and the paid resume ask at once: two wakes, no more.
  assert.deepEqual(await Promise.all([budget.take(), budget.take(), budget.take()]), [true, true, false]);
  clock += 29_000;
  assert.equal(await budget.take(), false);
  clock += 1_000;
  assert.equal(await budget.take(), true);
  // A restart can't refill it.
  assert.equal(await createWakeBudget(kv, { now: () => clock }).take(), false);
  // An hour idle refills it to two, not more.
  clock += 3_600_000;
  const restarted = createWakeBudget(kv, { now: () => clock });
  assert.deepEqual([await restarted.take(), await restarted.take(), await restarted.take()], [true, true, false]);
});

test("a reply bb gives in another shape is never taken as no decision or an empty queue", async () => {
  const env = setup();
  skippedStop(env, "thr_no_answer");
  env.threads.decisions.set("thr_no_answer", UNKNOWN);
  skippedStop(env, "thr_queue_shape");
  env.threads.unknownQueues.add("thr_queue_shape");
  // Even well past the decision wait: provider-retry may still have a retry scheduled.
  env.advance(10 * DECISION_WAIT_MS);
  const report = await env.resume.pass(fresh(env), settings());
  assert.deepEqual(env.threads.calls, []);
  assert.deepEqual(report.skipped, [
    { id: "thr_no_answer", reason: "provider retry's decision couldn't be read" },
    { id: "thr_queue_shape", reason: "bb's queue for it couldn't be read" },
  ]);
  // Both stay candidates, with their stopped turn untouched.
  assert.deepEqual(env.store.stops().map((stop) => stop.threadId), ["thr_no_answer", "thr_queue_shape"]);
  assert.equal(env.store.attempts("thr_no_answer", "req_thr_no_answer"), 0);
});

test("opted-out and held chats are set aside before their events are read", async () => {
  const env = setup({ projects: [{ id: "web", name: "Web app", localBbProjectId: "proj_web", neverPaidClaude: true }], held: { thr_held: "being handed over to another agent" } });
  skippedStop(env, "thr_out", { projectId: "proj_web" });
  skippedStop(env, "thr_held");
  skippedStop(env, "thr_in");
  await env.resume.pass(usage(), settings());
  assert.deepEqual(env.threads.eventReads, ["thr_in"]);
});

test("one pass at a time, and a burst of stops makes one check", async () => {
  const env = setup();
  skippedStop(env, "thr_a");
  skippedStop(env, "thr_b");
  const [one, two] = await Promise.all([env.resume.pass(usage(), settings()), env.resume.pass(usage(), settings())]);
  assert.equal(one, two);
  assert.deepEqual(env.threads.calls, ["thr_a", "thr_b"]);

  const controller = new AbortController();
  let runs = 0;
  const timer = createPaidResumeTimer(async () => void (runs += 1), { intervalMs: 60_000, delayMs: 20, signal: controller.signal });
  for (let index = 0; index < 5; index++) timer.soon();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(runs, 1);
  controller.abort();
});
