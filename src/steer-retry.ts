// A task chat's turn that failed with a provider "Bad Request" right after a
// steer gets one automatic retry: a follow-up that restates the steer. This
// module only reads bb's thread lifecycle events; the service acts on it.

/** bb's thread events the reading needs (bb.sdk.threads.events.list `types`). */
export const TURN_EVENT_TYPES = [
  "client/turn/requested",
  "turn/input/accepted",
  "turn/started",
  "turn/completed",
  "provider/error",
  "system/thread/interrupted",
] as const;

/** A thread event row as bb lists it (only the fields read here). */
export interface TurnEventRow {
  id?: string;
  seq: number;
  type: string;
  createdAt?: number;
  scope?: { kind?: string; turnId?: string } | null;
  data?: Record<string, unknown> | null;
}

/** What a failure says about itself. */
export interface ErrorFacts {
  /** provider/error errorInfo.category (null: none reported). */
  category?: string | null;
  /** provider/error errorInfo.httpStatusCode (null: none reported). */
  httpStatusCode?: number | null;
  /** The error's own words: provider/error message and detail, turn/completed error. */
  texts: readonly (string | null | undefined)[];
}

/** The whole text is the bare HTTP reason phrase. */
const BARE_BAD_REQUEST = /^bad request$/i;
/** Errors with their own paths (limits, auth, overloads, 5xx, tunnels, timeouts, context size). */
const OTHER_FAILURE =
  /usage.?limit|rate.?limit|quota|billing|credits?\b|unauthori[sz]ed|forbidden|\bauth(?:entication|orization)?\b|credential|api.?key|overloaded|tunnel|gateway|unavailable|internal server error|timed? ?out|\b(?:401|402|403|404|408|409|413|422|429|5\d\d)\b|context.?(?:window|length)|too many|too large/i;

/** The text is exactly a bare Bad Request: `Bad Request`, or the body `{"detail":"Bad Request"}`. */
export function isBadRequestText(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const value = text.trim();
  if (BARE_BAD_REQUEST.test(value)) return true;
  if (!value.startsWith("{")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const body = parsed as Record<string, unknown>;
  return Object.keys(body).length === 1 && typeof body.detail === "string" && BARE_BAD_REQUEST.test(body.detail.trim());
}

/**
 * A provider 400 and nothing else: an explicit HTTP 400, or error text that
 * is exactly a bare Bad Request. A bad-request or unknown category alone is
 * not enough; other categories, other status codes, and texts that name a
 * limit, auth, an overload, a 5xx, a tunnel or context size never match.
 */
export function isBadRequestFailure(facts: ErrorFacts): boolean {
  const category = facts.category ?? "unknown";
  const status = facts.httpStatusCode ?? null;
  if (category !== "bad-request" && category !== "unknown") return false;
  if (status !== null && status !== 400) return false;
  const texts = facts.texts.filter((text): text is string => typeof text === "string" && text.trim() !== "");
  if (texts.some((text) => !isBadRequestText(text) && OTHER_FAILURE.test(text))) return false;
  return status === 400 || texts.some(isBadRequestText);
}

/** The chat's latest turn, when it failed. */
export interface FailedTurn {
  /** The failed turn, for the once-only record. */
  key: string;
  /** How the turn ended (readLatestTurn; readFailedTurn only returns failed ones). */
  status: string;
  /** The seq the turn's events start after (the previous turn/completed, or 0). */
  startSeq: number;
  /** Text of each steer the turn accepted, in order ("" for one without text). */
  steers: string[];
  /** Text of the input that started the turn (null: its request isn't in the turn). */
  opener: string | null;
  /** The failure was a provider Bad Request. */
  badRequest: boolean;
  /** A message reached the chat after the failure (a new request or turn). */
  newerMessage: boolean;
  /** A turn started or took input after the failure. */
  laterTurn: boolean;
  /** The turn was interrupted, or the chat was after the failure. */
  interrupted: boolean;
}

function data(row: TurnEventRow): Record<string, unknown> {
  return row.data !== null && typeof row.data === "object" ? row.data : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function inputText(input: unknown): string {
  if (!Array.isArray(input)) return "";
  return input
    .map((block) => (block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text" ? text((block as { text?: unknown }).text) : null))
    .filter((value): value is string => value !== null && value.trim() !== "")
    .join("\n\n")
    .trim();
}

/**
 * Read the chat's latest turn from its lifecycle events (any order; other
 * event types are ignored). Null when the latest completed turn didn't fail.
 *
 * A steer is an accepted `client/turn/requested` that targeted the running
 * turn: `target.kind` "steer", or "auto" when it wasn't the input that
 * started the turn. Its `turn/input/accepted` must fall inside the turn,
 * and bb's own system notices (`systemMessageKind`) don't count.
 */
export function readFailedTurn(rows: readonly TurnEventRow[]): FailedTurn | null {
  const turn = readLatestTurn(rows);
  return turn !== null && turn.status === "failed" ? turn : null;
}

/** The chat's latest completed turn, however it ended (same reading as readFailedTurn). */
export function readLatestTurn(rows: readonly TurnEventRow[]): FailedTurn | null {
  const known = new Set<string>(TURN_EVENT_TYPES);
  const events = rows.filter((row) => typeof row.seq === "number" && known.has(row.type)).sort((a, b) => a.seq - b.seq);
  let end = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]!.type === "turn/completed") {
      end = index;
      break;
    }
  }
  if (end === -1) return null;
  const completed = events[end]!;
  const status = text(data(completed).status) ?? "unknown";
  let start = -1;
  for (let index = end - 1; index >= 0; index--) {
    if (events[index]!.type === "turn/completed") {
      start = index;
      break;
    }
  }
  const turn = events.slice(start + 1, end + 1);
  const requests = new Map<string, { target: string | null; text: string; notice: boolean }>();
  for (const row of turn) {
    if (row.type !== "client/turn/requested") continue;
    const values = data(row);
    const id = text(values.requestId);
    if (id === null) continue;
    const target = values.target !== null && typeof values.target === "object" ? text((values.target as { kind?: unknown }).kind) : null;
    // bb's own notices (a child's outcome, a tool result) steer turns too; nobody asked for those.
    const kind = text(values.systemMessageKind);
    requests.set(id, { target, text: inputText(values.input), notice: kind !== null && kind !== "unlabeled" });
  }
  const steers: string[] = [];
  let first = true;
  let opener: string | null = null;
  for (const row of turn) {
    if (row.type !== "turn/input/accepted") continue;
    const request = requests.get(text(data(row).clientRequestId) ?? "");
    const opens = first;
    first = false;
    if (request === undefined) continue;
    if (opens && request.target !== "steer") opener = request.text;
    if (request.notice) continue;
    if (request.target === "steer" || (request.target === "auto" && !opens)) steers.push(request.text);
  }
  const failure = turn.filter((row) => row.type === "provider/error" && data(row).willRetry !== true).at(-1);
  const failureData = failure === undefined ? {} : data(failure);
  const info = failureData.errorInfo !== null && typeof failureData.errorInfo === "object" ? (failureData.errorInfo as Record<string, unknown>) : {};
  const completedError = data(completed).error;
  const badRequest = isBadRequestFailure({
    category: text(info.category),
    httpStatusCode: typeof info.httpStatusCode === "number" ? info.httpStatusCode : null,
    texts: [
      text(failureData.message),
      text(failureData.detail),
      completedError !== null && typeof completedError === "object" ? text((completedError as { message?: unknown }).message) : null,
    ],
  });
  const later = events.slice(end + 1);
  const turnId = completed.scope?.kind === "turn" && typeof completed.scope.turnId === "string" ? completed.scope.turnId : null;
  const laterTurn = later.some((row) => row.type === "turn/started" || row.type === "turn/input/accepted");
  return {
    key: turnId !== null ? `turn:${turnId}` : `event:${completed.id ?? completed.seq}`,
    status,
    startSeq: start === -1 ? 0 : events[start]!.seq,
    steers,
    opener,
    badRequest,
    newerMessage: laterTurn || later.some((row) => row.type === "client/turn/requested"),
    laterTurn,
    // A stop after the failure (the user, the orchestrator, boat_interrupt) vetoes a retry too.
    interrupted: [...turn, ...later].some((row) => row.type === "system/thread/interrupted"),
  };
}

/**
 * Read the chat's failed turn, again a few times a moment apart when the log
 * doesn't show it yet: bb may report a failure before its turn/completed is
 * logged. A read that throws ends it (the caller treats that as unreadable).
 */
export async function readFailedTurnSettled(
  read: () => Promise<readonly TurnEventRow[]>,
  options: { rereads: number; rereadMs: number; signal: AbortSignal },
): Promise<FailedTurn | null> {
  for (let attempt = 0; ; attempt++) {
    const turn = readFailedTurn(await read());
    // No failed turn, or one older than a turn the log already shows: the failure may not be logged yet.
    if ((turn !== null && !turn.newerMessage) || attempt >= options.rereads || options.signal.aborted) return turn;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, options.rereadMs);
      function done() {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", done);
        resolve();
      }
      options.signal.addEventListener("abort", done, { once: true });
    });
  }
}


/** The failed turn qualifies for the automatic retry (the service still checks the task and its sandbox). */
export function retriesAfterSteer(turn: FailedTurn | null): turn is FailedTurn {
  return turn !== null && turn.badRequest && turn.steers.length > 0 && !turn.newerMessage && !turn.interrupted;
}

const STEER_LIMIT = 4000;
/** The retry follow-up's first line: how the loop guards know it. */
export const STEER_RETRY_HEADING = "# Automatic retry";

/** The message is the plugin's automatic retry follow-up. */
export function isSteerRetryText(text: string | null | undefined): boolean {
  return typeof text === "string" && text.trimStart().startsWith(`${STEER_RETRY_HEADING}\n`);
}

/** The follow-up that retries the turn: it restates the steer, which the failed turn may not have kept. */
export function steerRetryPrompt(steers: readonly string[]): string {
  const said = steers.filter((steer) => steer.trim() !== "");
  const quoted = said
    .map((steer) => (steer.length > STEER_LIMIT ? `${steer.slice(0, STEER_LIMIT)}…` : steer))
    .map((steer) => steer.split("\n").map((line) => `> ${line}`).join("\n"))
    .join("\n\n");
  return `${STEER_RETRY_HEADING}

Your last turn failed with a provider error (Bad Request) right after a steer, so the plugin retried it once. Continue where you left off, including what the steer asked for${said.length === 0 ? "." : `:\n\n${quoted}`}

End the way your brief asks, with its report block if it has one.
`;
}

/** Hidden task event: which failed turn was retried, and the retry's turn marker. */
export const AUTO_RETRY_RECORD = "auto-retry-turn";
/** Visible task event: the retry in the task's history. */
export const AUTO_RETRY_EVENT = "auto-retry";
export const AUTO_RETRY_TEXT = "Retried automatically after a provider error following a steer";

/** Visible task event: the retry was skipped, the chat moved on (a turn, a queued message, a hold) before it could be sent. */
export const AUTO_RETRY_SKIPPED_EVENT = "auto-retry-skipped";
export const AUTO_RETRY_SKIPPED_TEXT = "Skipped the automatic retry: the chat moved on before it could be sent";
/** Visible task event: an interrupt the plugin sent (boat_interrupt, the page); it vetoes a retry. */
export const INTERRUPT_REQUESTED_EVENT = "interrupt-requested";

export interface AutoRetryRecord {
  /** The failed turn's key (FailedTurn.key). */
  failed: string;
  /** The retry turn's promptId marker. */
  promptId: string;
  /** Skipped: the chat moved on before the retry could be sent (the failed turn is never retried). */
  dropped: boolean;
}

export function parseAutoRetryRecord(textValue: string | null | undefined): AutoRetryRecord | null {
  if (typeof textValue !== "string") return null;
  try {
    const parsed = JSON.parse(textValue) as { failed?: unknown; promptId?: unknown; dropped?: unknown };
    return typeof parsed.failed === "string" && typeof parsed.promptId === "string"
      ? { failed: parsed.failed, promptId: parsed.promptId, dropped: parsed.dropped === true }
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- any chat on this bb

/** The recovery message's first words: how the loop guard knows it. */
export const RECOVERY_PREFIX = "[boat] Your last turn failed with a provider error (Bad Request) right after";
const RECOVERY_STEER_LIMIT = 2000;
const RECOVERY_TOTAL_LIMIT = 6000;

/** The message is the plugin's recovery message for a chat. */
export function isRecoveryText(text: string | null | undefined): boolean {
  return typeof text === "string" && text.trimStart().startsWith(RECOVERY_PREFIX);
}

/** A thread's goal as its events last said (thread/goal/updated, or Codex's extension state). */
export interface ThreadGoal {
  objective: string | null;
  status: string;
}

/** bb's thread events that carry a goal. */
export const GOAL_EVENT_TYPES = ["thread/goal/updated", "thread/goal/cleared", "thread/extensionState/updated"] as const;

/** The thread's latest goal (null: none, or cleared). Codex's `provider-codex/goal` state counts when it names a status. */
export function readGoal(rows: readonly TurnEventRow[]): ThreadGoal | null {
  const events = [...rows].filter((row) => typeof row.seq === "number").sort((a, b) => b.seq - a.seq);
  for (const row of events) {
    const values = data(row);
    if (row.type === "thread/goal/cleared") return null;
    if (row.type === "thread/goal/updated" && typeof values.status === "string") return { objective: text(values.objective), status: values.status };
    if (row.type === "thread/extensionState/updated" && values.kind === "provider-codex/goal") {
      const payload = values.payload !== null && typeof values.payload === "object" && !Array.isArray(values.payload) ? (values.payload as Record<string, unknown>) : null;
      const goal = payload?.goal !== null && typeof payload?.goal === "object" && !Array.isArray(payload?.goal) ? (payload.goal as Record<string, unknown>) : payload;
      if (goal === null || goal === undefined) return null;
      if (typeof goal.status === "string") return { objective: text(goal.objective), status: goal.status };
    }
  }
  return null;
}

/** The thread's goal statuses in order (a cleared goal reads "cleared"). */
function goalHistory(rows: readonly TurnEventRow[]): { seq: number; status: string }[] {
  const history: { seq: number; status: string }[] = [];
  for (const row of [...rows].filter((entry) => typeof entry.seq === "number").sort((a, b) => a.seq - b.seq)) {
    const values = data(row);
    if (row.type === "thread/goal/cleared") history.push({ seq: row.seq, status: "cleared" });
    else if (row.type === "thread/goal/updated" && typeof values.status === "string") history.push({ seq: row.seq, status: values.status });
    else if (row.type === "thread/extensionState/updated" && values.kind === "provider-codex/goal") {
      const goal = readGoal([row]);
      history.push({ seq: row.seq, status: goal?.status ?? "cleared" });
    }
  }
  return history;
}

/**
 * The goal went from active to blocked during (or right after) the turn whose
 * events start after `startSeq`, and is still blocked. The blocked stretch
 * begins at the first blocked snapshot after the last other status: repeated
 * blocked snapshots (usage, state updates) never move that beginning.
 */
export function goalBlockedSince(rows: readonly TurnEventRow[], startSeq: number): boolean {
  const history = goalHistory(rows);
  if (history.at(-1)?.status !== "blocked") return false;
  let first = history.length - 1;
  while (first > 0 && history[first - 1]!.status === "blocked") first -= 1;
  // Blocked from the first snapshot on, or after something other than active (paused, cleared): not this failure's doing.
  if (first === 0 || history[first - 1]!.status !== "active") return false;
  return history[first]!.seq > startSeq;
}

/** Codex's command that makes a paused, blocked or usage-limited goal active again and starts a turn on it. */
export const GOAL_RESUME_TEXT = "/goal resume";

/** Goal statuses the recovery message asks the agent to keep working toward. */
const OPEN_GOALS = new Set(["active", "blocked"]);

/**
 * The message that recovers any chat: a new turn (never a steer) that says
 * what happened and quotes every steer the failed turn took, bounded in length.
 */
export function recoveryPrompt(steers: readonly string[], goal: ThreadGoal | null): string {
  const said = steers.filter((steer) => steer.trim() !== "");
  const quoted: string[] = [];
  let used = 0;
  for (const steer of said) {
    const clipped = steer.length > RECOVERY_STEER_LIMIT ? `${steer.slice(0, RECOVERY_STEER_LIMIT)}…` : steer;
    if (quoted.length > 0 && used + clipped.length > RECOVERY_TOTAL_LIMIT) break;
    used += clipped.length;
    quoted.push(clipped.split("\n").map((line) => `> ${line}`).join("\n"));
  }
  const left = said.length - quoted.length;
  const lines = [
    `${RECOVERY_PREFIX} ${said.length > 1 ? `${said.length} messages` : "a message"} arrived. Continue where you left off.`,
  ];
  if (quoted.length > 0) lines.push(`${said.length > 1 ? "The messages were" : "The message was"}:\n\n${quoted.join("\n\n")}${left > 0 ? `\n\n(${left} more not repeated here.)` : ""}`);
  if (goal !== null && OPEN_GOALS.has(goal.status)) {
    lines.push(goal.objective ? `Your goal is still open: “${goal.objective.slice(0, 500)}”. Keep working toward it.` : "Your goal is still open. Keep working toward it.");
  }
  return `${lines.join("\n\n")}\n`;
}
