// Any chat on this bb (not a Boat task): one recovery message after a turn
// failed with a provider Bad Request right after a steer. Fakes only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type Database from "better-sqlite3";
import type { ChatState, SendResult } from "../src/chat.ts";
import { ChatRecoveryStore, createChatRecovery, type RecoveryThreads } from "../src/chat-recovery.ts";
import { TaskStore } from "../src/store.ts";
import { GOAL_RESUME_TEXT, RECOVERY_PREFIX, isRecoveryText, readGoal, recoveryPrompt, type TurnEventRow } from "../src/steer-retry.ts";
import { STEER_RETRY_HEADING } from "../src/steer-retry.ts";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/agent-steer-bad-request.json", import.meta.url), "utf8")) as { rows: TurnEventRow[]; goal: TurnEventRow[] };
const ROWS = FIXTURE.rows;
const GOAL = FIXTURE.goal;
const THREAD = "thr_local";
const TELL_1 = "[bb message from thread:thr_other] The schema change is merged.";
const TELL_2 = "[bb message from thread:thr_other] Please bump the client to 2.0 too.";

class FakeThreads implements RecoveryThreads {
  states = new Map<string, ChatState>();
  events = new Map<string, TurnEventRow[]>();
  goals = new Map<string, TurnEventRow[]>();
  sends: { threadId: string; text: string }[] = [];
  reads = 0;
  stateCalls = 0;
  sendError: Error | null = null;
  /** Runs before each event read / state read: the chat can change between them. */
  onRead: ((threadId: string, read: number) => void) | null = null;
  onState: ((threadId: string, call: number) => void) | null = null;

  /** bb queues sends instead of starting them (a turn or a hold got there first). */
  queueSends: { waitingOn: string } | null = null;
  withdrawn: { threadId: string; queuedMessageId: string }[] = [];
  withdrawResult: "removed" | "stuck" = "removed";

  failedThread(threadId = THREAD, rows = ROWS, goal: TurnEventRow[] = [], providerId = "codex") {
    this.states.set(threadId, { status: "error", updatedAt: Date.now(), archived: false, environmentId: null, queued: 0, backgroundAgents: 0, workflows: 0, providerId });
    this.events.set(threadId, rows);
    this.goals.set(threadId, goal);
  }
  async state(threadId: string) {
    this.stateCalls += 1;
    this.onState?.(threadId, this.stateCalls);
    const state = this.states.get(threadId);
    return state === undefined ? null : { ...state };
  }
  async turnEvents(threadId: string) {
    this.reads += 1;
    this.onRead?.(threadId, this.reads);
    return [...(this.events.get(threadId) ?? [])];
  }
  async goalEvents(threadId: string) {
    return [...(this.goals.get(threadId) ?? [])];
  }
  async send(threadId: string, text: string): Promise<SendResult> {
    if (this.sendError) throw this.sendError;
    this.sends.push({ threadId, text });
    if (this.queueSends) return { delivery: "queued", queuedMessageId: `qm_${this.sends.length}`, waitingOn: this.queueSends.waitingOn };
    const state = this.states.get(threadId);
    if (state) state.status = "active";
    return { delivery: "sent" };
  }
  async withdraw(threadId: string, queuedMessageId: string) {
    this.withdrawn.push({ threadId, queuedMessageId });
    return this.withdrawResult;
  }
  /** The recovery's turn ran and ended: the chat is idle again. */
  recoveryTurnEnded(threadId = THREAD, status: "completed" | "interrupted" = "completed", extra: TurnEventRow[] = []) {
    const rows = this.events.get(threadId) ?? [];
    const recovery = this.sends.find((send) => send.threadId === threadId && isRecoveryText(send.text))!.text;
    const turn = nextTurn(300, { status: "completed", opener: recovery }).map((row) => (row.type === "turn/completed" ? { ...row, data: { status } } : row));
    this.events.set(threadId, [...rows, ...turn, ...extra]);
    this.states.get(threadId)!.status = "idle";
  }
}

function database(): () => Database.Database {
  const db = new DatabaseSync(":memory:");
  for (const statement of TaskStore.migrations()) db.exec(statement);
  return () => db as unknown as Database.Database;
}

function setup(options: { enabled?: boolean; taskThreads?: string[]; db?: () => Database.Database; threads?: FakeThreads } = {}) {
  const threads = options.threads ?? new FakeThreads();
  const db = options.db ?? database();
  const store = new ChatRecoveryStore(db);
  const guards = new TaskStore(db);
  const logs: { level: "info" | "warn"; line: string }[] = [];
  let enabled = options.enabled ?? true;
  const recovery = createChatRecovery({
    enabled: async () => enabled,
    isTaskThread: (threadId) => (options.taskThreads ?? []).includes(threadId),
    threads,
    store,
    guards,
    log: { info: (line) => void logs.push({ level: "info", line }), warn: (line) => void logs.push({ level: "warn", line }) },
    signal: new AbortController().signal,
    timing: { rereads: 2, rereadMs: 1 },
  });
  return { recovery, threads, store, guards, logs, db, setEnabled: (value: boolean) => void (enabled = value) };
}

/** A later turn: its opening message (by default the plugin's recovery), maybe a steer, then how it ended. */
function nextTurn(seq: number, options: { status: "failed" | "completed"; opener?: string; steer?: string; error?: string }): TurnEventRow[] {
  const scope = { kind: "turn", turnId: `turn_${seq}` };
  const rows: TurnEventRow[] = [
    { id: `evt_${seq}`, seq, type: "client/turn/requested", scope: { kind: "thread" }, data: { requestId: `req_${seq}`, target: { kind: "new-turn" }, source: "tell", input: [{ type: "text", text: options.opener ?? recoveryPrompt([TELL_1, TELL_2], null) }] } },
    { id: `evt_${seq + 1}`, seq: seq + 1, type: "turn/input/accepted", scope, data: { clientRequestId: `req_${seq}`, scope } },
    { id: `evt_${seq + 2}`, seq: seq + 2, type: "turn/started", scope, data: {} },
  ];
  if (options.steer) {
    rows.push(
      { id: `evt_${seq + 3}`, seq: seq + 3, type: "client/turn/requested", scope: { kind: "thread" }, data: { requestId: `req_${seq + 3}`, target: { kind: "steer", expectedTurnId: scope.turnId }, source: "tell", initiator: "agent", input: [{ type: "text", text: options.steer }] } },
      { id: `evt_${seq + 4}`, seq: seq + 4, type: "turn/input/accepted", scope, data: { clientRequestId: `req_${seq + 3}`, scope } },
    );
  }
  if (options.status === "failed") {
    rows.push({ id: `evt_${seq + 5}`, seq: seq + 5, type: "provider/error", scope, data: { message: options.error ?? '{"detail":"Bad Request"}', willRetry: false, errorInfo: { category: "unknown", providerCode: "other", httpStatusCode: null } } });
  }
  rows.push({ id: `evt_${seq + 6}`, seq: seq + 6, type: "turn/completed", scope, data: { status: options.status, ...(options.status === "failed" ? { error: { message: options.error ?? '{"detail":"Bad Request"}' } } : {}) } });
  return rows;
}

test("a chat that isn't a Boat task recovers once after an agent's steers and a Bad Request", async () => {
  const env = setup();
  env.threads.failedThread(THREAD, ROWS, GOAL);
  // thread.failed and turn.failed arrive together: one message.
  const outcomes = await Promise.all([env.recovery.failed(THREAD), env.recovery.failed(THREAD)]);
  assert.deepEqual(outcomes.sort(), ["busy", "recovered"]);
  assert.equal(env.threads.sends.length, 1);
  const { text } = env.threads.sends[0]!;
  assert.ok(text.startsWith(`${RECOVERY_PREFIX} 2 messages arrived. Continue where you left off.`));
  assert.ok(isRecoveryText(text));
  // Both steers, quoted.
  assert.match(text, /The messages were:\n\n> \[bb message from thread:thr_other\] The schema change is merged\.\n\n> \[bb message from thread:thr_other\] Please bump the client to 2\.0 too\./);
  // The open goal, restated (bb has no way for a plugin to resume it).
  assert.match(text, /Your goal is still open: “Migrate the API to v2”\. Keep working toward it\./);
  // The log names the thread and the reason, never the messages.
  const line = env.logs.find((entry) => entry.level === "info")!.line;
  assert.match(line, /^chat recovery thr_local: sent one recovery message, the turn failed with a provider Bad Request right after 2 steers \(turn turn:turn_g\); goal blocked; \/goal resume follows the recovery turn$/);
  assert.ok(!env.logs.some((entry) => entry.line.includes("schema") || entry.line.includes("bump")));

  // Seen again later (the sweep of another event): claimed already.
  env.threads.states.get(THREAD)!.status = "error";
  assert.equal(await env.recovery.failed(THREAD), "claimed");
  assert.equal(env.threads.sends.length, 1);
});

test("a goal thread logs where the goal stands once the recovery turn ends", async () => {
  const env = setup();
  env.threads.failedThread(THREAD, ROWS, GOAL);
  assert.equal(await env.recovery.failed(THREAD), "recovered");
  // The recovery turn got the goal going again by itself: no /goal resume needed.
  env.threads.recoveryTurnEnded();
  env.threads.goals.set(THREAD, [...GOAL, { id: "evt_340", seq: 340, type: "thread/goal/updated", data: { objective: "Migrate the API to v2", status: "active" } }]);
  await env.recovery.idle(THREAD);
  assert.ok(env.logs.some((entry) => /^chat recovery thr_local: the recovery turn completed; goal active \(turn turn:turn_g\)$/.test(entry.line)));
  assert.match(env.logs.at(-1)!.line, /no \/goal resume, the goal is active/);
  assert.equal(env.threads.sends.length, 1);
  // Once per recovery.
  await env.recovery.idle(THREAD);
  assert.equal(env.logs.filter((entry) => entry.line.includes("the recovery turn completed")).length, 1);

  // Codex's own goal state counts too; a paused or finished goal isn't urged on.
  assert.deepEqual(readGoal([{ id: "e", seq: 1, type: "thread/extensionState/updated", data: { kind: "provider-codex/goal", payload: { objective: "Ship it", status: "blocked" } } }]), { objective: "Ship it", status: "blocked" });
  assert.equal(readGoal([...GOAL, { id: "e", seq: 300, type: "thread/goal/cleared", data: {} }]), null);
  assert.doesNotMatch(recoveryPrompt([TELL_1], { objective: "Ship it", status: "paused" }), /goal/);
  assert.doesNotMatch(recoveryPrompt([TELL_1], { objective: "Ship it", status: "complete" }), /goal/);
  // One message reads in the singular; long ones are bounded.
  assert.match(recoveryPrompt([TELL_1], null), /right after a message arrived\. Continue where you left off\.\n\nThe message was:\n\n> /);
  const long = recoveryPrompt(["x".repeat(5000), "y".repeat(5000), "z".repeat(5000), "w".repeat(5000)], null);
  assert.ok(long.length < 7000);
  assert.match(long, /\(\d more not repeated here\.\)/);
});

test("the setting turns it off", async () => {
  const env = setup({ enabled: false });
  env.threads.failedThread();
  assert.equal(await env.recovery.failed(THREAD), "off");
  assert.equal(env.threads.reads, 0);
  assert.equal(env.threads.sends.length, 0);
  env.setEnabled(true);
  assert.equal(await env.recovery.failed(THREAD), "recovered");
});

test("no recovery when a newer message reached the chat or one is queued", async () => {
  const env = setup();
  env.threads.failedThread(THREAD, [...ROWS, { id: "evt_230", seq: 230, type: "client/turn/requested", data: { requestId: "req_next", target: { kind: "new-turn" }, input: [{ type: "text", text: "Status?" }] } }]);
  assert.equal(await env.recovery.failed(THREAD), "not-this-case");
  env.threads.failedThread("thr_queued");
  env.threads.states.get("thr_queued")!.queued = 1;
  assert.equal(await env.recovery.failed("thr_queued"), "busy");
  assert.equal(env.threads.sends.length, 0);
});

test("a second failure, in the recovery's own turn, gets no second recovery", async () => {
  const env = setup();
  env.threads.failedThread();
  assert.equal(await env.recovery.failed(THREAD), "recovered");
  // The recovery's turn takes another agent message and fails the same way.
  env.threads.failedThread(THREAD, [...ROWS, ...nextTurn(300, { status: "failed", steer: "[bb message from thread:thr_other] One more thing." })]);
  assert.equal(await env.recovery.failed(THREAD), "own-turn");
  assert.equal(env.threads.sends.length, 1);
  assert.match(env.logs.at(-1)!.line, /not recovering again, the failed turn was the recovery/);
  // A Boat task chat's retry message counts as the plugin's own too.
  const task = setup();
  task.threads.failedThread(THREAD, [...ROWS, ...nextTurn(300, { status: "failed", opener: `${STEER_RETRY_HEADING}\n\nYour last turn failed`, steer: "More." })]);
  assert.equal(await task.recovery.failed(THREAD), "own-turn");
  // A later, unrelated failure after a steer is a new case.
  const later = setup();
  later.threads.failedThread(THREAD, [...ROWS, ...nextTurn(300, { status: "completed" }), ...nextTurn(400, { status: "failed", opener: "Next step, please.", steer: "And the docs." })]);
  assert.equal(await later.recovery.failed(THREAD), "recovered");
});

test("archived, deleted, stopped or interrupted chats, and Boat task chats, are left alone", async () => {
  const env = setup({ taskThreads: ["thr_task"] });
  env.threads.failedThread("thr_archived");
  env.threads.states.get("thr_archived")!.archived = true;
  assert.equal(await env.recovery.failed("thr_archived"), "gone");
  assert.equal(await env.recovery.failed("thr_deleted"), "gone");
  // A user's stop leaves the thread idle.
  env.threads.failedThread("thr_stopped");
  env.threads.states.get("thr_stopped")!.status = "idle";
  assert.equal(await env.recovery.failed("thr_stopped"), "not-failed");
  // An interrupt logged after the failure.
  env.threads.failedThread("thr_halted", [...ROWS, { id: "evt_225", seq: 225, type: "system/thread/interrupted", data: { reason: "manual-stop" } }]);
  assert.equal(await env.recovery.failed("thr_halted"), "not-this-case");
  // Boat task chats have their own retry.
  env.threads.failedThread("thr_task");
  assert.equal(await env.recovery.failed("thr_task"), "task");
  assert.equal(env.threads.sends.length, 0);
});

test("other errors get no recovery", async () => {
  const env = setup();
  for (const [threadId, error] of [["thr_limit", "You've hit your usage limit."], ["thr_auth", "Unauthorized"], ["thr_5xx", "502 Bad Gateway"], ["thr_400ish", "400 Bad Request"]] as const) {
    const rows = ROWS.map((row) =>
      row.type === "provider/error" ? { ...row, data: { ...row.data, message: error, detail: error } }
      : row.type === "turn/completed" ? { ...row, data: { ...row.data, error: { message: error } } }
      : row);
    env.threads.failedThread(threadId, rows);
    assert.equal(await env.recovery.failed(threadId), "not-this-case", threadId);
  }
  assert.equal(env.threads.sends.length, 0);
});

test("the once-per-turn record survives a plugin reload", async () => {
  const first = setup();
  first.threads.failedThread();
  assert.equal(await first.recovery.failed(THREAD), "recovered");
  first.threads.states.get(THREAD)!.status = "error"; // bb hasn't started the turn yet
  const reloaded = setup({ db: first.db, threads: first.threads });
  assert.equal(await reloaded.recovery.failed(THREAD), "claimed");
  assert.equal(first.threads.sends.length, 1);
});

test("a failure not in the event log yet is read again, a bounded number of times", async () => {
  const unlogged = ROWS.filter((row) => row.type !== "turn/completed" && row.type !== "provider/error");
  const env = setup();
  env.threads.failedThread(THREAD, unlogged);
  env.threads.onRead = (threadId, read) => {
    if (read === 2) env.threads.events.set(threadId, ROWS);
  };
  assert.equal(await env.recovery.failed(THREAD), "recovered");
  assert.equal(env.threads.reads, 3, "two to find it, one right before the send");
  const never = setup();
  never.threads.failedThread(THREAD, unlogged);
  assert.equal(await never.recovery.failed(THREAD), "no-failed-turn");
  assert.equal(never.threads.reads, 3);
});

test("a message or an interrupt that arrives during the check stops the recovery", async () => {
  // The second state read is the re-check right before the claim.
  const env = setup();
  env.threads.failedThread();
  env.threads.onState = (threadId, call) => {
    if (call === 2) env.threads.states.get(threadId)!.status = "active";
  };
  assert.equal(await env.recovery.failed(THREAD), "busy");
  const interrupted = setup();
  interrupted.threads.failedThread();
  interrupted.threads.onState = (threadId, call) => {
    if (call === 2) interrupted.threads.events.set(threadId, [...ROWS, { id: "evt_225", seq: 225, type: "system/thread/interrupted", data: {} }]);
  };
  assert.equal(await interrupted.recovery.failed(THREAD), "moved-on");
  assert.equal(env.threads.sends.length + interrupted.threads.sends.length, 0);
  // Both are recorded as skipped: nothing can fire later from them.
  assert.equal(env.store.latest(THREAD)?.state, "skipped");
  assert.equal(interrupted.store.latest(THREAD)?.state, "skipped");
  env.threads.onState = null;
  env.threads.states.get(THREAD)!.status = "error";
  assert.equal(await env.recovery.failed(THREAD), "claimed");
  assert.equal(env.threads.sends.length, 0);
});

test("another turn's idle event never settles the recovery or sends /goal resume (review 2, finding 1)", async () => {
  const env = setup();
  env.threads.failedThread(THREAD, ROWS, GOAL);
  assert.equal(await env.recovery.failed(THREAD), "recovered");
  // An unrelated turn ends (say the recovery lost a race we didn't see): its idle leaves the record alone.
  env.threads.events.set(THREAD, [...ROWS, ...nextTurn(300, { status: "completed", opener: "Status?" })]);
  env.threads.states.get(THREAD)!.status = "idle";
  await env.recovery.idle(THREAD);
  assert.equal(env.store.latest(THREAD)?.state, "sent");
  assert.equal(env.threads.sends.length, 1, "no /goal resume");
  assert.ok(!env.logs.some((entry) => /the recovery turn (completed|interrupted|failed)|\/goal resume,|sent \/goal resume/.test(entry.line)));
});

test("a recovery bb queues instead of starting is withdrawn at once, so it never joins newer input (review 2, finding 2)", async () => {
  // A hold (another plugin's policy) or a turn that won the race: bb answers queued.
  for (const waitingOn of ["plugin", "thread-busy"]) {
    const env = setup();
    env.threads.failedThread();
    env.threads.queueSends = { waitingOn };
    assert.equal(await env.recovery.failed(THREAD), "skipped", waitingOn);
    assert.deepEqual(env.threads.withdrawn, [{ threadId: THREAD, queuedMessageId: "qm_1" }], waitingOn);
    assert.equal(env.store.latest(THREAD)?.state, "skipped");
    assert.match(env.logs.at(-1)!.line, new RegExp(`skipped the recovery message, bb queued it \\(${waitingOn}\\) and it was withdrawn`));
    // Never again for that failed turn, and nothing of it waits in bb's queue to be grouped with a later message.
    env.threads.queueSends = null;
    env.threads.states.get(THREAD)!.status = "error";
    assert.equal(await env.recovery.failed(THREAD), "claimed");
    assert.equal(env.threads.sends.length, 1);
  }
});

test("a queued recovery bb won't let go of stays guarded and is skipped, with a warning", async () => {
  const env = setup();
  env.threads.failedThread();
  env.threads.queueSends = { waitingOn: "plugin" };
  env.threads.withdrawResult = "stuck";
  assert.equal(await env.recovery.failed(THREAD), "skipped");
  assert.equal(env.store.latest(THREAD)?.state, "skipped");
  assert.equal(env.guards.guardedQueuedMessage(["qm_1"]), "qm_1");
  assert.ok(env.logs.some((entry) => entry.level === "warn" && entry.line === "chat recovery thr_local: couldn't remove the queued recovery message qm_1 (turn turn:turn_g); it stays refused if bb ever dispatches it"));
  // Removed for sure: no guard left.
  const removed = setup();
  removed.threads.failedThread();
  removed.threads.queueSends = { waitingOn: "plugin" };
  assert.equal(await removed.recovery.failed(THREAD), "skipped");
  assert.equal(removed.guards.guardedQueuedMessage(["qm_1"]), null);
});

test("/goal resume never follows for a goal already blocked before the failed turn, however often the snapshot repeats", async () => {
  // A finished turn ends at seq 150, so the failed turn starts after it.
  const rows = [...nextTurn(144, { status: "completed", opener: "Earlier work" }), ...ROWS];
  const goal = (seq: number, status: string) => ({ id: `g_${seq}`, seq, type: "thread/goal/updated", data: { objective: "Migrate the API to v2", status } });
  const before = setup();
  before.threads.failedThread(THREAD, rows, [goal(100, "active"), goal(140, "blocked"), goal(224, "blocked")]);
  assert.equal(await before.recovery.failed(THREAD), "recovered");
  before.threads.recoveryTurnEnded();
  await before.recovery.idle(THREAD);
  assert.equal(before.threads.sends.length, 1, "only the recovery");
  // Blocked by this failure, then repeated: resumed once.
  const during = setup();
  during.threads.failedThread(THREAD, rows, [goal(100, "active"), goal(160, "blocked"), goal(224, "blocked")]);
  assert.equal(await during.recovery.failed(THREAD), "recovered");
  during.threads.recoveryTurnEnded();
  await during.recovery.idle(THREAD);
  assert.equal(during.threads.sends.at(-1)!.text, GOAL_RESUME_TEXT);
  assert.equal(during.threads.sends.length, 2);
});

test("a chat busy at send time skips the recovery for good", async () => {
  const env = setup();
  env.threads.failedThread();
  // The final look right before the send finds a turn running (another agent's message).
  env.threads.onState = (threadId, call) => {
    if (call === 2) {
      env.threads.states.get(threadId)!.status = "active";
      env.threads.states.get(threadId)!.queued = 1;
    }
  };
  assert.equal(await env.recovery.failed(THREAD), "busy");
  assert.equal(env.threads.sends.length, 0);
  assert.equal(env.store.latest(THREAD)?.state, "skipped");
  assert.match(env.logs.at(-1)!.line, /skipped, the chat moved on before the recovery could be sent/);
});

test("/goal resume follows a completed recovery turn once, on Codex, when the failure blocked the goal", async () => {
  // The failed turn moved the goal from active to blocked (the fixture), and it's still blocked after the recovery turn.
  const env = setup();
  env.threads.failedThread(THREAD, ROWS, GOAL);
  assert.equal(await env.recovery.failed(THREAD), "recovered");
  assert.match(env.logs.at(-1)!.line, /; \/goal resume follows the recovery turn$/);
  env.threads.recoveryTurnEnded();
  await env.recovery.idle(THREAD);
  assert.equal(env.threads.sends.length, 2);
  assert.equal(env.threads.sends[1]!.text, GOAL_RESUME_TEXT);
  assert.equal(env.store.latest(THREAD)?.state, "resumed");
  assert.match(env.logs.at(-1)!.line, /^chat recovery thr_local: sent \/goal resume, the failed turn had blocked the goal \(turn turn:turn_g\)$/);
  // Once only.
  env.threads.states.get(THREAD)!.status = "idle";
  await env.recovery.idle(THREAD);
  assert.equal(env.threads.sends.length, 2);
  // The resume's own turn failing after a steer is part of the recovery: no second one.
  env.threads.failedThread(THREAD, [...env.threads.events.get(THREAD)!, ...nextTurn(400, { status: "failed", opener: GOAL_RESUME_TEXT, steer: "One more." })], GOAL);
  assert.equal(await env.recovery.failed(THREAD), "own-turn");

  // Not on Codex: `/goal resume` would be a plain prompt there.
  const claude = setup();
  claude.threads.failedThread(THREAD, ROWS, GOAL, "claude-code");
  assert.equal(await claude.recovery.failed(THREAD), "recovered");
  claude.threads.recoveryTurnEnded();
  await claude.recovery.idle(THREAD);
  assert.equal(claude.threads.sends.length, 1);
  // A goal that was already blocked before the failed turn: not this failure's doing.
  const old = setup();
  old.threads.failedThread(THREAD, ROWS, [{ id: "g1", seq: 100, type: "thread/goal/updated", data: { objective: "Ship", status: "blocked" } }]);
  assert.equal(await old.recovery.failed(THREAD), "recovered");
  old.threads.recoveryTurnEnded();
  await old.recovery.idle(THREAD);
  assert.equal(old.threads.sends.length, 1);
  // The user stopped the recovery turn, or a message came in after it: no resume.
  for (const [label, status, extra] of [
    ["stopped", "interrupted", []],
    ["newer message", "completed", [{ id: "evt_390", seq: 390, type: "client/turn/requested", data: { requestId: "req_user", target: { kind: "new-turn" }, input: [] } }]],
  ] as const) {
    const env2 = setup();
    env2.threads.failedThread(THREAD, ROWS, GOAL);
    assert.equal(await env2.recovery.failed(THREAD), "recovered");
    env2.threads.recoveryTurnEnded(THREAD, status, [...extra]);
    await env2.recovery.idle(THREAD);
    assert.equal(env2.threads.sends.length, 1, label);
    assert.match(env2.logs.at(-1)!.line, /no \/goal resume/, label);
  }
  // bb queues the resume: withdrawn, not left to run later.
  const queued = setup();
  queued.threads.failedThread(THREAD, ROWS, GOAL);
  assert.equal(await queued.recovery.failed(THREAD), "recovered");
  queued.threads.recoveryTurnEnded();
  queued.threads.queueSends = { waitingOn: "plugin" };
  await queued.recovery.idle(THREAD);
  assert.deepEqual(queued.threads.withdrawn, [{ threadId: THREAD, queuedMessageId: "qm_2" }]);
  // The setting off by then: no resume.
  const off = setup();
  off.threads.failedThread(THREAD, ROWS, GOAL);
  assert.equal(await off.recovery.failed(THREAD), "recovered");
  off.threads.recoveryTurnEnded();
  off.setEnabled(false);
  await off.recovery.idle(THREAD);
  assert.equal(off.threads.sends.length, 1);
});

test("a send that fails is logged and not retried in a loop; an hourly cap backs it all up", async () => {
  const env = setup();
  env.threads.failedThread();
  env.threads.sendError = new Error("bb refused the message");
  assert.equal(await env.recovery.failed(THREAD), "unsent");
  assert.match(env.logs.at(-1)!.line, /^chat recovery thr_local: couldn't send the recovery message \(turn turn:turn_g\): bb refused the message$/);
  env.threads.sendError = null;
  assert.equal(await env.recovery.failed(THREAD), "claimed");
  // Three recoveries this hour already: the fourth waits.
  const capped = setup();
  for (const key of ["turn:a", "turn:b", "turn:c"]) capped.store.claim(THREAD, key);
  capped.threads.failedThread();
  assert.equal(await capped.recovery.failed(THREAD), "capped");
  assert.equal(capped.threads.sends.length, 0);
});

// ---------------------------------------------------------------- through the plugin

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function pluginHost(t: { after(fn: () => unknown): void }, settings: Record<string, unknown> = {}) {
  const { default: plugin } = await import("../server.ts");
  const { createTestHost } = await import("./fakes.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  process.env.FAKE_BOAT_STATE = join(mkdtempSync(join(tmpdir(), "boat-recovery-")), "state.json");
  const fakeBoat = fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url));
  const { bb, harness } = await createTestHost({ pluginId: "boat", settings: { boatPath: fakeBoat, evidenceUploader: "", ...settings }, agentSkillIds: ["boat", "boat-orchestrator"] });
  t.after(() => harness.lifecycle.dispose());
  const { makeThreadResponse } = await import("@get-bb/plugin-sdk/testing");
  const sends: Record<string, unknown>[] = [];
  let rows = ROWS;
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "error", providerId: "codex" }));
  harness.sdk.stub("threads.list", async () => ({ threads: [] }));
  harness.sdk.stub("threads.events.list", async ({ types }: { types?: string[] }) => [...(types?.includes("turn/completed") ? rows : GOAL)].reverse());
  let queue: { kind: string } | null = null;
  const deleted: Record<string, unknown>[] = [];
  harness.sdk.stub("threads.send", async (args: Record<string, unknown>) => {
    sends.push(args);
    if (queue === null) return { ok: true, delivery: "sent" };
    queuedIds.add(`qm_${sends.length}`);
    return { ok: true, delivery: "queued", queuedMessage: { id: `qm_${sends.length}`, waitingOn: queue } };
  });
  let deleteFails = false;
  let onDelete: ((args: Record<string, unknown>) => Promise<void>) | null = null;
  const queuedIds = new Set<string>();
  harness.sdk.stub("threads.queuedMessages.delete", async (args: Record<string, unknown>) => {
    deleted.push(args);
    if (onDelete) await onDelete(args);
    if (deleteFails) throw new Error("bb didn't answer");
    queuedIds.delete(String(args.queuedMessageId));
    return { ok: true };
  });
  harness.sdk.stub("threads.queuedMessages.list", async () => [...queuedIds].map((id) => ({ id })));
  await plugin(bb);
  return {
    bb, harness, sends, deleted, makeThreadResponse,
    setRows: (next: TurnEventRow[]) => void (rows = next),
    queueSends: (next: { kind: string } | null) => void (queue = next),
    failDeletes: () => void (deleteFails = true),
    onDelete: (handler: (args: Record<string, unknown>) => Promise<void>) => void (onDelete = handler),
    queued: queuedIds,
  };
}

test("the plugin recovers a chat from bb's thread.failed with a new turn, never a steer, once", async (t) => {
  const host = await pluginHost(t);
  await host.harness.emitThreadEvent("thread.failed", { thread: host.makeThreadResponse({ id: THREAD, status: "error", providerId: "codex" }), error: '{"detail":"Bad Request"}' });
  await until(() => host.sends.length > 0);
  const send = host.sends[0]!;
  assert.equal(send.threadId, THREAD);
  assert.equal(send.mode, "queue-if-active");
  assert.equal(send.originPluginId, "boat");
  assert.ok(isRecoveryText((send.input as { text: string }[])[0]!.text));
  assert.deepEqual(host.deleted, []);
  // turn.failed for the same failure: still one message.
  const { makeTurnFailedEvent } = await import("@get-bb/plugin-sdk/testing");
  await host.harness.emitThreadEvent("turn.failed", makeTurnFailedEvent({ threadId: THREAD }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(host.sends.length, 1);
});

test("through the plugin, a recovery bb queues is deleted from bb's queue at once", async (t) => {
  const host = await pluginHost(t);
  host.queueSends({ kind: "plugin" });
  await host.harness.emitThreadEvent("thread.failed", { thread: host.makeThreadResponse({ id: THREAD, status: "error", providerId: "codex" }), error: '{"detail":"Bad Request"}' });
  await until(() => host.deleted.length > 0);
  assert.deepEqual(host.deleted, [{ threadId: THREAD, queuedMessageId: "qm_1" }]);
  assert.equal(host.sends.length, 1);
});

test("through the plugin, a queued recovery bb won't delete is refused at dispatch, by its exact id", async (t) => {
  const host = await pluginHost(t);
  const { makeMessageDispatchHookContext } = await import("@get-bb/plugin-sdk/testing");
  const dispatch = host.harness.inspection.registrations.hooks["message.dispatch"]!;
  const drain = (id: string) => dispatch(makeMessageDispatchHookContext({ thread: { id: THREAD }, input: { text: "x" }, queuedMessages: [{ id }] })) as Promise<{ action: string; message?: string }>;
  // Core drains the row while the first delete is still in flight: the guard is already on it.
  const early: { action: string }[] = [];
  host.onDelete(async (args) => {
    if (early.length === 0) early.push(await drain(String(args.queuedMessageId)));
  });
  host.failDeletes();
  host.queueSends({ kind: "plugin" });
  await host.harness.emitThreadEvent("thread.failed", { thread: host.makeThreadResponse({ id: THREAD, status: "error", providerId: "codex" }), error: '{"detail":"Bad Request"}' });
  await until(() => host.deleted.length >= 3, 5_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(early[0]?.action, "reject", "refused before the delete landed");
  // Every delete failed and bb still lists it: refused whenever it dispatches, and only that row.
  assert.ok(host.queued.has("qm_1"));
  const refused = await drain("qm_1");
  assert.equal(refused.action, "reject");
  assert.match(refused.message!, /Boat withdrew this automatic message/);
  assert.notEqual((await drain("qm_someone_else")).action, "reject");
});

test("with the setting off, the plugin leaves other chats alone", async (t) => {
  const host = await pluginHost(t, { recoverChatsAfterSteer: false });
  await host.harness.emitThreadEvent("thread.failed", { thread: host.makeThreadResponse({ id: THREAD, status: "error" }), error: '{"detail":"Bad Request"}' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(host.sends.length, 0);
});
