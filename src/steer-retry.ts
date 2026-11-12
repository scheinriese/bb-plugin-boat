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
  /** Text of each steer the turn accepted, in order ("" for one without text). */
  steers: string[];
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
  if (data(completed).status !== "failed") return null;
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
  for (const row of turn) {
    if (row.type !== "turn/input/accepted") continue;
    const request = requests.get(text(data(row).clientRequestId) ?? "");
    const opener = first;
    first = false;
    if (request === undefined) continue;
    if (request.notice) continue;
    if (request.target === "steer" || (request.target === "auto" && !opener)) steers.push(request.text);
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
    steers,
    badRequest,
    newerMessage: laterTurn || later.some((row) => row.type === "client/turn/requested"),
    laterTurn,
    // A stop after the failure (the user, the orchestrator, boat_interrupt) vetoes a retry too.
    interrupted: [...turn, ...later].some((row) => row.type === "system/thread/interrupted"),
  };
}

/**
 * The chat moved on from the failed turn `key`: it's no longer the latest
 * completed turn, or a turn started, took input or was interrupted since.
 * Only what can't be the retry's own dispatch counts (not its request).
 */
export function movedOnSince(rows: readonly TurnEventRow[], key: string): boolean {
  const turn = readFailedTurn(rows);
  return turn === null || turn.key !== key || turn.laterTurn || turn.interrupted;
}

/** The failed turn qualifies for the automatic retry (the service still checks the task and its sandbox). */
export function retriesAfterSteer(turn: FailedTurn | null): turn is FailedTurn {
  return turn !== null && turn.badRequest && turn.steers.length > 0 && !turn.newerMessage && !turn.interrupted;
}

const STEER_LIMIT = 4000;
/** The retry follow-up's first line: how the dispatch hook knows it. */
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

/** Visible task event: the retry was refused at dispatch, the chat had moved on. */
export const AUTO_RETRY_SKIPPED_EVENT = "auto-retry-skipped";
export const AUTO_RETRY_SKIPPED_TEXT = "Skipped the automatic retry: the chat moved on before it was sent";
/** Visible task event: an interrupt the plugin sent (boat_interrupt, the page); it vetoes a retry. */
export const INTERRUPT_REQUESTED_EVENT = "interrupt-requested";

export interface AutoRetryRecord {
  /** The failed turn's key (FailedTurn.key). */
  failed: string;
  /** The retry turn's promptId marker. */
  promptId: string;
  /** Refused at dispatch: the turn isn't a retry after all (the failed turn stays retried). */
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
