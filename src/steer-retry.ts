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

/** The whole text is a 400: "Bad Request", "400 Bad Request", "HTTP 400: Bad Request". */
const BAD_REQUEST = /^(?:(?:http\s*)?400\s*[:\-–]?\s*)?bad request\.?$/i;
/** A status line in front of the response body: "unexpected status 400 Bad Request: {…}". */
const STATUS_PREFIX = /^(?:unexpected status|http(?: status)?|status(?: code)?)?\s*400\s*(?:bad request)?\s*[:\-–]\s*/i;
/** Errors with their own paths (limits, auth, overloads, 5xx, tunnels, timeouts, context size). */
const OTHER_FAILURE =
  /usage.?limit|rate.?limit|quota|billing|credits?\b|unauthori[sz]ed|forbidden|\bauth(?:entication|orization)?\b|credential|api.?key|overloaded|tunnel|gateway|unavailable|internal server error|timed? ?out|\b(?:401|402|403|404|408|409|413|422|429|5\d\d)\b|context.?(?:window|length)|too many|too large/i;

/** `{"detail":"Bad Request"}` and its kin unwrap to their message; anything else stays as it is. */
function unwrap(text: string): string {
  let value = text.trim();
  for (let depth = 0; depth < 3 && value.startsWith("{"); depth++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return value;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return value;
    const body = parsed as { detail?: unknown; message?: unknown; error?: unknown };
    const error = body.error;
    const inner =
      typeof body.detail === "string" ? body.detail
      : typeof body.message === "string" ? body.message
      : typeof error === "string" ? error
      : error !== null && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message
      : null;
    if (inner === null) return value;
    value = inner.trim();
  }
  return value;
}

/** The text says exactly "Bad Request" (bare, with its 400, or as a JSON error body). */
export function isBadRequestText(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const value = text.trim();
  if (BAD_REQUEST.test(unwrap(value))) return true;
  // The body after a 400 status line must say Bad Request too.
  const prefix = STATUS_PREFIX.exec(value);
  return prefix !== null && BAD_REQUEST.test(unwrap(value.slice(prefix[0].length)));
}

/**
 * A provider 400 and nothing else: errorInfo says bad-request or HTTP 400, or
 * the provider classified nothing and the error text is exactly a Bad Request.
 * Other categories, other status codes, and texts that name a limit, auth,
 * an overload, a 5xx or a tunnel never match.
 */
export function isBadRequestFailure(facts: ErrorFacts): boolean {
  const category = facts.category ?? "unknown";
  const status = facts.httpStatusCode ?? null;
  if (category !== "bad-request" && category !== "unknown") return false;
  if (status !== null && status !== 400) return false;
  const texts = facts.texts.filter((text): text is string => typeof text === "string" && text.trim() !== "");
  if (texts.some((text) => !isBadRequestText(text) && OTHER_FAILURE.test(text))) return false;
  return category === "bad-request" || status === 400 || texts.some(isBadRequestText);
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
  /** The turn was interrupted. */
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
  return {
    key: turnId !== null ? `turn:${turnId}` : `event:${completed.id ?? completed.seq}`,
    steers,
    badRequest,
    newerMessage: later.some((row) => row.type === "client/turn/requested" || row.type === "turn/started"),
    interrupted: turn.some((row) => row.type === "system/thread/interrupted"),
  };
}

/** The failed turn qualifies for the automatic retry (the service still checks the task and its sandbox). */
export function retriesAfterSteer(turn: FailedTurn | null): turn is FailedTurn {
  return turn !== null && turn.badRequest && turn.steers.length > 0 && !turn.newerMessage && !turn.interrupted;
}

const STEER_LIMIT = 4000;

/** The follow-up that retries the turn: it restates the steer, which the failed turn may not have kept. */
export function steerRetryPrompt(steers: readonly string[]): string {
  const said = steers.filter((steer) => steer.trim() !== "");
  const quoted = said
    .map((steer) => (steer.length > STEER_LIMIT ? `${steer.slice(0, STEER_LIMIT)}…` : steer))
    .map((steer) => steer.split("\n").map((line) => `> ${line}`).join("\n"))
    .join("\n\n");
  return `# Automatic retry

Your last turn failed with a provider error (Bad Request) right after a steer, so the plugin retried it once. Continue where you left off, including what the steer asked for${said.length === 0 ? "." : `:\n\n${quoted}`}

End the way your brief asks, with its report block if it has one.
`;
}

/** Hidden task event: which failed turn was retried, and the retry's turn marker. */
export const AUTO_RETRY_RECORD = "auto-retry-turn";
/** Visible task event: the retry in the task's history. */
export const AUTO_RETRY_EVENT = "auto-retry";
export const AUTO_RETRY_TEXT = "Retried automatically after a provider error following a steer";

export interface AutoRetryRecord {
  /** The failed turn's key (FailedTurn.key). */
  failed: string;
  /** The retry turn's promptId marker. */
  promptId: string;
}

export function parseAutoRetryRecord(textValue: string | null | undefined): AutoRetryRecord | null {
  if (typeof textValue !== "string") return null;
  try {
    const parsed = JSON.parse(textValue) as { failed?: unknown; promptId?: unknown };
    return typeof parsed.failed === "string" && typeof parsed.promptId === "string" ? { failed: parsed.failed, promptId: parsed.promptId } : null;
  } catch {
    return null;
  }
}
