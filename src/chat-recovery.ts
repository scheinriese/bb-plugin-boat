// Any chat on this bb, not only Boat task chats: a turn that failed with a
// provider Bad Request right after a steer (another agent's `bb thread tell`,
// the user's steer) gets one recovery message, a new turn that quotes the
// steers. Same rules as the task chat retry (src/steer-retry.ts); Boat task
// chats keep their own path in the service, with its orchestrator notices.
//
// Send now or never: the message goes out only onto a chat that still sits
// on that failure, as a turn that starts right away. If bb queues it instead
// (a turn or a hold got there first), it's taken back out at once and the
// recovery is skipped, so it can never run after newer work or a stop.
import type Database from "better-sqlite3";
import type { ChatState, SendResult } from "./chat.ts";
import {
  GOAL_RESUME_TEXT,
  goalBlockedSince,
  isRecoveryText,
  isSteerRetryText,
  readFailedTurn,
  readFailedTurnSettled,
  readGoal,
  readLatestTurn,
  recoveryPrompt,
  retriesAfterSteer,
  type FailedTurn,
  type ThreadGoal,
  type TurnEventRow,
} from "./steer-retry.ts";

/**
 * sent: the recovery went out and its turn runs. skipped: the chat moved on
 * (busy, newer input, queued by bb) before it could go out. unsent: the send
 * failed. settled: the recovery turn ended. resumed: then /goal resume went out.
 */
export type RecoveryState = "sent" | "skipped" | "unsent" | "settled" | "resumed";

export interface RecoveryRecord {
  turnKey: string;
  state: RecoveryState;
  at: string;
  /** The failed turn moved a Codex goal from active to blocked. */
  resumeGoal: boolean;
}

/** Durable once-per-failed-turn records, keyed by thread and turn, outside the task tables (src/chat-recovery-migrations.ts). */
export class ChatRecoveryStore {
  private readonly db: () => Database.Database;

  constructor(db: () => Database.Database) {
    this.db = db;
  }

  /** Claim a failed turn in `state`; false when it was claimed before (this run or an earlier one). */
  claim(threadId: string, turnKey: string, state: RecoveryState = "sent", options: { resumeGoal?: boolean; at?: Date } = {}): boolean {
    const result = this.db()
      .prepare(`INSERT OR IGNORE INTO chat_recoveries (thread_id, turn_key, state, at, resume_goal) VALUES (?, ?, ?, ?, ?)`)
      .run(threadId, turnKey, state, (options.at ?? new Date()).toISOString(), options.resumeGoal ? 1 : 0);
    return Number(result.changes) === 1;
  }

  has(threadId: string, turnKey: string): boolean {
    return this.db().prepare(`SELECT 1 FROM chat_recoveries WHERE thread_id = ? AND turn_key = ?`).get(threadId, turnKey) !== undefined;
  }

  mark(threadId: string, turnKey: string, state: RecoveryState): void {
    this.db().prepare(`UPDATE chat_recoveries SET state = ? WHERE thread_id = ? AND turn_key = ?`).run(state, threadId, turnKey);
  }

  /** Move a record on only from `from` (once: false when it isn't in that state any more). */
  advance(threadId: string, turnKey: string, from: RecoveryState, to: RecoveryState): boolean {
    const result = this.db().prepare(`UPDATE chat_recoveries SET state = ? WHERE thread_id = ? AND turn_key = ? AND state = ?`).run(to, threadId, turnKey, from);
    return Number(result.changes) === 1;
  }

  /** The thread's latest record. */
  latest(threadId: string): RecoveryRecord | null {
    const row = this.db()
      .prepare(`SELECT turn_key, state, at, resume_goal FROM chat_recoveries WHERE thread_id = ? ORDER BY at DESC, rowid DESC LIMIT 1`)
      .get(threadId) as { turn_key: string; state: RecoveryState; at: string; resume_goal: number } | undefined;
    return row === undefined ? null : { turnKey: row.turn_key, state: row.state, at: row.at, resumeGoal: Number(row.resume_goal) === 1 };
  }

  /** Recoveries sent to the thread since `since` (a cap for a night of unattended chats). */
  sentSince(threadId: string, since: Date): number {
    const row = this.db()
      .prepare(`SELECT COUNT(*) AS count FROM chat_recoveries WHERE thread_id = ? AND state IN ('sent', 'settled', 'resumed') AND at >= ?`)
      .get(threadId, since.toISOString()) as { count: number };
    return Number(row.count);
  }
}

/** What the recovery reads and sends, for any thread on this bb. */
export interface RecoveryThreads {
  /** null: the thread no longer exists. */
  state(threadId: string): Promise<ChatState | null>;
  /** The thread's lifecycle events (src/steer-retry.ts TURN_EVENT_TYPES). */
  turnEvents(threadId: string): Promise<TurnEventRow[]>;
  /** The thread's goal events (GOAL_EVENT_TYPES). */
  goalEvents(threadId: string): Promise<TurnEventRow[]>;
  /** Start a new turn with this message (queued when bb can't start it now); never a steer. */
  send(threadId: string, text: string): Promise<SendResult>;
  /** Take a queued message back out before it runs. */
  withdraw(threadId: string, queuedMessageId: string): Promise<void>;
}

export interface ChatRecoveryDeps {
  /** The setting "Recover any chat after a steer Bad Request". */
  enabled(): Promise<boolean>;
  /** A Boat task's chat: the service's own retry handles it. */
  isTaskThread(threadId: string): boolean;
  threads: RecoveryThreads;
  store: ChatRecoveryStore;
  log: { info(line: string): void; warn(line: string): void };
  signal: AbortSignal;
  /** Tests: how often and how far apart a failure is read again (ms). */
  timing?: { rereads?: number; rereadMs?: number };
}

/** Why a failure got no recovery (or "recovered"). */
export type RecoveryOutcome =
  | "recovered"
  | "off"
  | "task"
  | "busy"
  | "gone"
  | "not-failed"
  | "unreadable"
  | "no-failed-turn"
  | "own-turn"
  | "claimed"
  | "not-this-case"
  | "capped"
  | "moved-on"
  | "skipped"
  | "unsent";

/** At most this many recoveries per thread an hour: a backstop against a loop no rule foresaw. */
const HOURLY_CAP = 3;
/** bb's provider id for Codex: only Codex reads `/goal resume` as a command (bb's codex-provider docs). */
const CODEX = "codex";

/** Why the chat can't take a message now (null: it can): gone, busy, or not on a failure (stopped by the user). */
function blocked(state: ChatState | null, expect: "error" | "idle"): "gone" | "busy" | "not-failed" | null {
  if (state === null || state.archived) return "gone";
  if (state.queued > 0 || state.backgroundAgents > 0 || (state.workflows ?? 0) > 0) return "busy";
  if (state.status === expect) return null;
  // A user's stop leaves the thread idle (or stopping): not a failure to recover.
  return state.status === "idle" ? "not-failed" : "busy";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createChatRecovery(deps: ChatRecoveryDeps) {
  const checking = new Set<string>();

  async function settledTurn(threadId: string): Promise<FailedTurn | null> {
    return readFailedTurnSettled(() => deps.threads.turnEvents(threadId), {
      rereads: deps.timing?.rereads ?? 2,
      rereadMs: deps.timing?.rereadMs ?? 1_500,
      signal: deps.signal,
    });
  }

  async function goalRows(threadId: string): Promise<TurnEventRow[]> {
    return deps.threads.goalEvents(threadId).catch(() => []);
  }

  /**
   * Send `text` as a turn that starts now, or not at all: a message bb queued
   * is withdrawn at once. "sent", "queued" (withdrawn), or "failed".
   */
  async function sendNow(threadId: string, text: string, what: string, turnKey: string): Promise<"sent" | "queued" | "failed"> {
    let result: SendResult;
    try {
      result = await deps.threads.send(threadId, text);
    } catch (error) {
      deps.log.warn(`chat recovery ${threadId}: couldn't send the ${what} (turn ${turnKey}): ${message(error)}`);
      return "failed";
    }
    if (result.delivery === "sent") return "sent";
    if (result.queuedMessageId !== null) {
      try {
        await deps.threads.withdraw(threadId, result.queuedMessageId);
      } catch (error) {
        // Already on its way: it runs now.
        deps.log.warn(`chat recovery ${threadId}: couldn't withdraw the queued ${what} (turn ${turnKey}): ${message(error)}`);
        return "sent";
      }
    }
    deps.log.info(`chat recovery ${threadId}: skipped the ${what}, bb queued it (${result.waitingOn ?? "waiting"}) and it was withdrawn (turn ${turnKey})`);
    return "queued";
  }

  async function check(threadId: string): Promise<RecoveryOutcome> {
    if (!(await deps.enabled().catch(() => false))) return "off";
    if (deps.isTaskThread(threadId)) return "task";
    const first = blocked(await deps.threads.state(threadId).catch(() => null), "error");
    if (first !== null) return first;
    let turn: FailedTurn | null;
    try {
      turn = await settledTurn(threadId);
    } catch (error) {
      deps.log.warn(`chat recovery ${threadId}: can't read the thread's events: ${message(error)}`);
      return "unreadable";
    }
    if (turn === null) return "no-failed-turn";
    // The failed turn was itself a recovery, its /goal resume, or a task retry: no loop.
    const resumeTurn = turn.opener?.trim() === GOAL_RESUME_TEXT && deps.store.latest(threadId)?.state === "resumed";
    if (isRecoveryText(turn.opener) || isSteerRetryText(turn.opener) || resumeTurn) {
      deps.log.info(`chat recovery ${threadId}: not recovering again, the failed turn was the recovery (turn ${turn.key})`);
      return "own-turn";
    }
    if (deps.store.has(threadId, turn.key)) return "claimed";
    if (!retriesAfterSteer(turn)) return "not-this-case";
    if (deps.store.sentSince(threadId, new Date(Date.now() - 3_600_000)) >= HOURLY_CAP) {
      deps.log.warn(`chat recovery ${threadId}: skipped, ${HOURLY_CAP} recoveries in the last hour already (turn ${turn.key})`);
      return "capped";
    }
    const goals = await goalRows(threadId);
    const goal: ThreadGoal | null = readGoal(goals);
    // Send now or never: look again right before the send; anything newer skips it for good.
    const state = await deps.threads.state(threadId).catch(() => null);
    const again = blocked(state, "error");
    let latest: FailedTurn | null = null;
    if (again === null) {
      try {
        latest = readFailedTurn(await deps.threads.turnEvents(threadId));
      } catch {
        return "unreadable";
      }
    }
    if (again !== null || latest === null || latest.key !== turn.key || !retriesAfterSteer(latest)) {
      // Something else keeps the chat going, or it was stopped or archived.
      if (deps.store.claim(threadId, turn.key, "skipped")) {
        deps.log.info(`chat recovery ${threadId}: skipped, the chat moved on before the recovery could be sent (turn ${turn.key})`);
      }
      return again === "gone" ? "gone" : again === "busy" ? "busy" : "moved-on";
    }
    // Resume the goal after the recovery turn when the failure is what blocked it (Codex only).
    const resumeGoal = state?.providerId === CODEX && goalBlockedSince(goals, turn.startSeq);
    // Claimed in one statement, with no await between it and the send.
    if (!deps.store.claim(threadId, turn.key, "sent", { resumeGoal })) return "claimed";
    const sent = await sendNow(threadId, recoveryPrompt(latest.steers, goal), "recovery message", turn.key);
    if (sent === "failed") {
      deps.store.mark(threadId, turn.key, "unsent");
      return "unsent";
    }
    if (sent === "queued") {
      deps.store.mark(threadId, turn.key, "skipped");
      return "skipped";
    }
    deps.log.info(
      `chat recovery ${threadId}: sent one recovery message, the turn failed with a provider Bad Request right after ${latest.steers.length} steer${latest.steers.length === 1 ? "" : "s"} (turn ${turn.key})${goal ? `; goal ${goal.status}` : ""}${resumeGoal ? "; /goal resume follows the recovery turn" : ""}`,
    );
    return "recovered";
  }

  /** After the recovery turn: /goal resume once, under the same guards (Codex goal blocked by the failure). */
  async function resumeGoal(threadId: string, record: RecoveryRecord, ended: FailedTurn): Promise<void> {
    if (!record.resumeGoal) return;
    const skip = (why: string) => deps.log.info(`chat recovery ${threadId}: no /goal resume, ${why} (turn ${record.turnKey})`);
    if (ended.status !== "completed") return skip(`the recovery turn ${ended.status}`);
    if (ended.newerMessage || ended.interrupted) return skip("the chat moved on");
    if (!(await deps.enabled().catch(() => false))) return skip("the setting is off");
    const goal = readGoal(await goalRows(threadId));
    if (goal?.status !== "blocked") return skip(goal ? `the goal is ${goal.status}` : "the goal is gone");
    const state = await deps.threads.state(threadId).catch(() => null);
    const busy = blocked(state, "idle");
    if (busy !== null) return skip(busy === "gone" ? "the chat is gone" : "the chat is busy");
    if (state?.providerId !== CODEX) return skip("the chat isn't on Codex");
    let latest: FailedTurn | null;
    try {
      latest = readLatestTurn(await deps.threads.turnEvents(threadId));
    } catch {
      return skip("its events can't be read");
    }
    if (latest === null || latest.key !== ended.key || latest.newerMessage || latest.interrupted) return skip("the chat moved on");
    // Once: only from settled.
    if (!deps.store.advance(threadId, record.turnKey, "settled", "resumed")) return;
    const sent = await sendNow(threadId, GOAL_RESUME_TEXT, "/goal resume", record.turnKey);
    if (sent === "sent") deps.log.info(`chat recovery ${threadId}: sent /goal resume, the failed turn had blocked the goal (turn ${record.turnKey})`);
  }

  return {
    /** A thread's turn failed (thread.failed, turn.failed): recover it once when the rules say so. */
    async failed(threadId: string): Promise<RecoveryOutcome> {
      if (checking.has(threadId)) return "busy";
      checking.add(threadId);
      try {
        return await check(threadId);
      } finally {
        checking.delete(threadId);
      }
    },

    /**
     * A thread went idle: when the turn that ended is the recovery's own (it
     * opened with the recovery message), log it, and resume a goal the
     * failure blocked. Any other turn's end leaves the record alone.
     */
    async idle(threadId: string): Promise<void> {
      const record = deps.store.latest(threadId);
      if (record === null || record.state !== "sent") return;
      if (checking.has(threadId)) return;
      checking.add(threadId);
      try {
        let ended: FailedTurn | null;
        try {
          ended = readLatestTurn(await deps.threads.turnEvents(threadId));
        } catch {
          return;
        }
        if (ended === null || !isRecoveryText(ended.opener)) return;
        if (!deps.store.advance(threadId, record.turnKey, "sent", "settled")) return;
        const goal = readGoal(await goalRows(threadId));
        deps.log.info(`chat recovery ${threadId}: the recovery turn ${ended.status}${goal ? `; goal ${goal.status}` : ""} (turn ${record.turnKey})`);
        await resumeGoal(threadId, record, ended);
      } finally {
        checking.delete(threadId);
      }
    },
  };
}

export type ChatRecovery = ReturnType<typeof createChatRecovery>;
