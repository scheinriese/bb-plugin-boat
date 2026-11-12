// Any chat on this bb, not only Boat task chats: a turn that failed with a
// provider Bad Request right after a steer (another agent's `bb thread tell`,
// the user's steer) gets one recovery message, a new turn that quotes the
// steers. Same rules as the task chat retry (src/steer-retry.ts); Boat task
// chats keep their own path in the service, with its orchestrator notices.
import type Database from "better-sqlite3";
import type { ChatState } from "./chat.ts";
import {
  isRecoveryText,
  isSteerRetryText,
  movedOnSince,
  readFailedTurn,
  readFailedTurnSettled,
  readGoal,
  recoveryPrompt,
  retriesAfterSteer,
  type FailedTurn,
  type ThreadGoal,
  type TurnEventRow,
} from "./steer-retry.ts";

/** sent: the message went out. unsent: the send failed. dropped: refused at dispatch. settled: its turn ended. */
export type RecoveryState = "sent" | "unsent" | "dropped" | "settled";

/** Durable once-per-failed-turn records, keyed by thread and turn, outside the task tables (src/chat-recovery-migrations.ts). */
export class ChatRecoveryStore {
  private readonly db: () => Database.Database;

  constructor(db: () => Database.Database) {
    this.db = db;
  }

  /** Claim a failed turn; false when it was claimed before (this run or an earlier one). */
  claim(threadId: string, turnKey: string, at = new Date()): boolean {
    const result = this.db()
      .prepare(`INSERT OR IGNORE INTO chat_recoveries (thread_id, turn_key, state, at) VALUES (?, ?, 'sent', ?)`)
      .run(threadId, turnKey, at.toISOString());
    return Number(result.changes) === 1;
  }

  has(threadId: string, turnKey: string): boolean {
    return this.db().prepare(`SELECT 1 FROM chat_recoveries WHERE thread_id = ? AND turn_key = ?`).get(threadId, turnKey) !== undefined;
  }

  mark(threadId: string, turnKey: string, state: RecoveryState): void {
    this.db().prepare(`UPDATE chat_recoveries SET state = ? WHERE thread_id = ? AND turn_key = ?`).run(state, threadId, turnKey);
  }

  /** The thread's latest record. */
  latest(threadId: string): { turnKey: string; state: RecoveryState; at: string } | null {
    const row = this.db()
      .prepare(`SELECT turn_key, state, at FROM chat_recoveries WHERE thread_id = ? ORDER BY at DESC, rowid DESC LIMIT 1`)
      .get(threadId) as { turn_key: string; state: RecoveryState; at: string } | undefined;
    return row === undefined ? null : { turnKey: row.turn_key, state: row.state, at: row.at };
  }

  /** Recoveries sent to the thread since `since` (a cap for a night of unattended chats). */
  sentSince(threadId: string, since: Date): number {
    const row = this.db()
      .prepare(`SELECT COUNT(*) AS count FROM chat_recoveries WHERE thread_id = ? AND state IN ('sent', 'settled') AND at >= ?`)
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
  /** A new turn, or queued behind a running one; never a steer. */
  send(threadId: string, text: string): Promise<void>;
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
  | "unsent";

/** At most this many recoveries per thread an hour: a backstop against a loop no rule foresaw. */
const HOURLY_CAP = 3;

/** The thread's chat state allows a recovery: still failed, nothing queued or running. */
function settledFailure(state: ChatState | null): "gone" | "busy" | "not-failed" | null {
  if (state === null || state.archived) return "gone";
  if (state.queued > 0 || state.backgroundAgents > 0 || (state.workflows ?? 0) > 0) return "busy";
  // A user's stop leaves the thread idle (or stopping): not a failure to recover.
  if (state.status !== "error") return state.status === "idle" ? "not-failed" : "busy";
  return null;
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

  async function goalOf(threadId: string): Promise<ThreadGoal | null> {
    return readGoal(await deps.threads.goalEvents(threadId).catch(() => []));
  }

  async function check(threadId: string): Promise<RecoveryOutcome> {
    if (!(await deps.enabled().catch(() => false))) return "off";
    if (deps.isTaskThread(threadId)) return "task";
    const first = settledFailure(await deps.threads.state(threadId).catch(() => null));
    if (first !== null) return first;
    let turn: FailedTurn | null;
    try {
      turn = await settledTurn(threadId);
    } catch (error) {
      deps.log.warn(`chat recovery ${threadId}: can't read the thread's events: ${error instanceof Error ? error.message : String(error)}`);
      return "unreadable";
    }
    if (turn === null) return "no-failed-turn";
    // The failed turn was itself a recovery (or a task retry): no loop.
    if (isRecoveryText(turn.opener) || isSteerRetryText(turn.opener)) {
      deps.log.info(`chat recovery ${threadId}: not recovering again, the failed turn was the recovery (turn ${turn.key})`);
      return "own-turn";
    }
    if (deps.store.has(threadId, turn.key)) return "claimed";
    if (!retriesAfterSteer(turn)) return "not-this-case";
    if (deps.store.sentSince(threadId, new Date(Date.now() - 3_600_000)) >= HOURLY_CAP) {
      deps.log.warn(`chat recovery ${threadId}: skipped, ${HOURLY_CAP} recoveries in the last hour already (turn ${turn.key})`);
      return "capped";
    }
    const goal = await goalOf(threadId);
    // A message, an interrupt or an archive may have come in meanwhile: look again right before the claim.
    const again = settledFailure(await deps.threads.state(threadId).catch(() => null));
    if (again !== null) return again === "not-failed" ? "moved-on" : again;
    let latest: FailedTurn | null;
    try {
      latest = readFailedTurn(await deps.threads.turnEvents(threadId));
    } catch {
      return "unreadable";
    }
    if (latest === null || latest.key !== turn.key || !retriesAfterSteer(latest)) return "moved-on";
    // Claimed in one statement, with no await between it and the send.
    if (!deps.store.claim(threadId, turn.key)) return "claimed";
    try {
      await deps.threads.send(threadId, recoveryPrompt(latest.steers, goal));
    } catch (error) {
      deps.store.mark(threadId, turn.key, "unsent");
      deps.log.warn(`chat recovery ${threadId}: couldn't send the recovery message (turn ${turn.key}): ${error instanceof Error ? error.message : String(error)}`);
      return "unsent";
    }
    deps.log.info(
      `chat recovery ${threadId}: sent one recovery message, the turn failed with a provider Bad Request right after ${latest.steers.length} steer${latest.steers.length === 1 ? "" : "s"} (turn ${turn.key})${goal ? `; goal ${goal.status}` : ""}`,
    );
    return "recovered";
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

    /** A thread went idle: after a recovery turn, log where its goal stands (whether it resumed). */
    async idle(threadId: string): Promise<void> {
      const latest = deps.store.latest(threadId);
      if (latest === null || latest.state !== "sent") return;
      deps.store.mark(threadId, latest.turnKey, "settled");
      const goal = await goalOf(threadId);
      deps.log.info(`chat recovery ${threadId}: the recovery turn ended${goal ? `; goal ${goal.status}` : ""} (turn ${latest.turnKey})`);
    },

    /**
     * message.dispatch for the recovery message: refused when it waited in
     * the queue behind a turn that started after the failure, or after an
     * interrupt (core has no conditional send). Null: proceed.
     */
    async dispatch(input: { threadId: string; text: string; fromPlugin: boolean; queuedRows: number }): Promise<{ action: "reject"; message: string } | null> {
      if (!input.fromPlugin || input.queuedRows > 1 || !isRecoveryText(input.text)) return null;
      const latest = deps.store.latest(input.threadId);
      if (latest === null || latest.state !== "sent") return null;
      let rows: TurnEventRow[];
      try {
        rows = await deps.threads.turnEvents(input.threadId);
      } catch {
        return null;
      }
      if (!movedOnSince(rows, latest.turnKey)) return null;
      deps.store.mark(input.threadId, latest.turnKey, "dropped");
      deps.log.info(`chat recovery ${input.threadId}: refused the queued recovery message, the chat moved on first (turn ${latest.turnKey})`);
      return { action: "reject", message: "Boat skipped its recovery message: this chat moved on before it was sent." };
    },
  };
}

export type ChatRecovery = ReturnType<typeof createChatRecovery>;
