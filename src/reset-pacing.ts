// Usage-limit resets without a wake storm.
//
// At a usage limit's reset, bb's built-in provider-retry plugin retries every
// chat the limit stopped within the same minute (15–45 s after the reset).
// On 19 Nov that woke many boat sandboxes at once, and boat.dev's storage
// couldn't keep up restoring their disks. What Boat does, where bb lets a
// plugin decide:
//
// - bb 0.49 asks the plugin that sent a failed turn before it schedules a
//   retry: RPC `provider-retry.v1.consent` (5 s; a missing, failing or slow
//   answer counts as "allow"). For a subscription-limit retry ("Rate
//   limited", waiting for a reset) of a chat Boat runs (a task's chat or
//   review, an orchestrator), Boat declines. The answer is a lookup, nothing
//   more. Once provider retry has recorded the decline (`decision.get` says
//   `declined-by-sender`), Boat queues the same retry itself with bb's core
//   `threads.retry`, for the time provider retry had planned: one per
//   stopped turn. A chat Boat already resumed after a reset is left to
//   provider retry the next time.
// - bb 0.50 dropped that question (get-bb/bb#7717): provider retry owns
//   every failed turn and asks nobody. The consent handler stays registered
//   for 0.49, and is never called on 0.50.
// - On every version, a usage-limit retry that would wake a Boat sandbox
//   passes the `message.dispatch` hook, which bb runs before it resumes the
//   machine: the first goes at once, each next one waits for its own slot
//   30 s after the one before (the wake pacer's 2 a minute, and never before
//   the pacer's next free wake), with the time on the queued row. bb keeps
//   owning the retry; Boat only spreads the wakes out. The pacer still
//   guards the wake itself (src/wake-pacer.ts, src/wake-retry.ts).
import type { defineRpcContract as DefineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { clockTime } from "./format.ts";
import { MACHINE_PROVIDER_ID } from "./providers/boat/provider.ts";
import { WAKES_PER_WINDOW, WAKE_WINDOW_MS } from "./wake-pacer.ts";

const defineRpcContract = ((contract: unknown) => contract) as typeof DefineRpcContract;

/** bb 0.49's provider-retry asks the sending plugin this (plugins/provider-retry/src/retry-contract.ts). */
export const RETRY_CONSENT_METHOD = "provider-retry.v1.consent";
export const retryConsentSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("allow") }), z.object({ kind: z.literal("decline"), reason: z.string().min(1) })]);
export type RetryConsent = z.infer<typeof retryConsentSchema>;
export const retryConsentInputSchema = z.object({
  threadId: z.string().min(1),
  requestId: z.string().min(1),
  /** "Rate limited", "Provider overloaded" or "Provider unavailable" in bb 0.49. */
  reason: z.string(),
  /** When provider retry would send the retry (epoch ms). */
  sendAt: z.number(),
});
export type RetryConsentInput = z.infer<typeof retryConsentInputSchema>;
export const retryConsentContract = defineRpcContract({
  [RETRY_CONSENT_METHOD]: { input: retryConsentInputSchema, output: retryConsentSchema },
});

/** provider retry's reason for a usage-limit retry. */
export const LIMIT_RETRY_REASON = "Rate limited";
/** The reason on the retries Boat queues itself after declining. */
export const BOAT_RESET_REASON = "Usage limit reset";
/** Only a retry this far out waits for a reset (a sooner one: another account is ready now). */
export const DECLINE_AFTER_MS = 5 * 60_000;
/** A chat Boat resumed after a reset this recently is left to provider retry. */
export const RESUMED_MEMORY_MS = 12 * 3_600_000;
/** How long Boat waits for provider retry's decision on a failure. */
export const DECISION_WAIT_MS = 60_000;
const DECISION_POLL_MS = 5_000;
/** Waits before Boat's second and third try at queueing the retry (bb restarting, a dropped connection). */
const RETRY_WAITS_MS = [5_000, 30_000];
/** bb refusing the retry for good: the chat moved on, or the thread is gone. */
const REFUSED_FOR_GOOD = /\b409\b|\b404\b|no_failed_turn|not[ _-]?found|conflict|archived|deleted/i;
/** One wake slot: the pacer's rate (2 a minute). */
export const RESET_GAP_MS = Math.round(WAKE_WINDOW_MS / WAKES_PER_WINDOW);
/** A machine's slot stays this long after it came, so its other retries go at once too. */
export const SLOT_KEPT_MS = 15 * 60_000;
/** bb 0.49 asks Boat (consent) right after a failure; Boat waits this long for that question (0.50 never asks). */
export const CONSENT_WAIT_MS = 10_000;
const CONSENT_POLL_MS = 1_000;
/** kv: the stopped turns Boat resumed itself, and when. */
export const RESET_RESUMES_KEY = "resetResumes";

export const DECLINE_REASON = "Harbormaster resumes its own chats after a usage limit resets, paced so their sandboxes don't all wake at once";

/** The parts of bb's turn.failed event this reads. */
export interface LimitFailure {
  threadId?: unknown;
  requestId?: unknown;
  errorInfo?: { category?: string | null; httpStatusCode?: number | null } | null;
  rateLimits?: { status?: string | null; windows?: { status?: string | null; resetsAtMs?: number | null }[] | null } | null;
}

/** The parts of a message.dispatch hook's context this reads. */
export interface ResetDispatch {
  host: { id?: string; machineProviderId?: string | null; lifecycle?: { phase?: string } | null } | null;
  queuedMessages: readonly { id: string; payload?: { kind?: string; reason?: string } | null }[];
}

/** A wait decision for the message.dispatch hook. */
export type ResetWait = { action: "wait"; reason: string; sendAt: number };

/** A failure provider retry treats as a rate limit (it then looks for a reset). */
export function isLimitFailure(event: LimitFailure): boolean {
  return event.errorInfo?.category === "rate-limit" || event.errorInfo?.httpStatusCode === 429;
}

/** The reset a limit failure reported (the last blocked window's), or null. */
export function failureResetAt(event: LimitFailure): number | null {
  const windows = event.rateLimits?.windows ?? [];
  const blocked = windows.filter((window) => window.status === "blocked");
  const resets = (blocked.length > 0 ? blocked : windows).map((window) => window.resetsAtMs).filter((at): at is number => typeof at === "number" && Number.isFinite(at));
  return resets.length === 0 ? null : Math.max(...resets);
}

/** provider retry's recorded decision (`decision.get`), as far as Boat reads it. */
export function parseDecision(raw: unknown): { requestId: string; kind: string; reason: string | null } | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as { requestId?: unknown; decision?: { kind?: unknown; reason?: unknown } | null };
  if (typeof value.requestId !== "string" || typeof value.decision?.kind !== "string") return null;
  return { requestId: value.requestId, kind: value.decision.kind, reason: typeof value.decision.reason === "string" ? value.decision.reason : null };
}

/**
 * Wake slots for reset retries, 30 s apart: one per machine (every retry for it goes in its
 * slot), kept across re-attempts and for a while after it passed.
 */
export class ResetLane {
  private readonly slots = new Map<string, number>();
  private last = Number.NEGATIVE_INFINITY;
  private readonly gapMs: number;
  constructor(gapMs = RESET_GAP_MS) {
    this.gapMs = gapMs;
  }

  /** This machine's slot: kept when it has one, else the next free one (never before earliest). */
  slot(key: string, now: number, earliest = now): number {
    // A slot long past: the machine woke then; a new reset gets a new slot.
    for (const [other, at] of this.slots) if (at < now - SLOT_KEPT_MS) this.slots.delete(other);
    const kept = this.slots.get(key);
    if (kept !== undefined) return kept;
    const at = Math.max(now, earliest, this.last + this.gapMs);
    this.slots.set(key, at);
    this.last = at;
    return at;
  }
}

export interface ResetPacingDeps {
  /** A chat Boat runs: a task's chat or review, or an orchestrator. Synchronous: the consent answer is a lookup. */
  isBoatChat(threadId: string): boolean;
  /** provider retry's recorded decision for a thread (`decision.get`). */
  decision(threadId: string): Promise<unknown>;
  /** bb's core retry of a failed turn (bb.sdk.threads.retry). */
  retry(args: { threadId: string; turnRequestId: string; sendAt: number; reason: string }): Promise<unknown>;
  /** Whether the thread has a retry queued (null: couldn't tell). For when provider retry recorded no decision. */
  queuedRetry?(threadId: string): Promise<boolean | null>;
  kv: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };
  /**
   * When the next sandbox wake may start: the shared wake pacer, and any other
   * wake budget or hold the plugin keeps (the latest of them counts).
   */
  nextWakeAt?(): Promise<number>;
  log?(line: string): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export interface ResetPacing {
  /** Load which chats Boat already resumed (before the first consent answer). */
  load(): Promise<void>;
  /** bb 0.49's consent question. Fast, and it changes nothing outside this process. */
  consent(input: RetryConsentInput): RetryConsent;
  /** bb's turn.failed: queue the retry Boat declined, once provider retry recorded the decline. */
  failed(event: LimitFailure): Promise<"queued" | "skipped">;
  /** The message.dispatch hook: a reset retry that would wake a Boat sandbox waits for its slot (null: go ahead). */
  dispatch(context: ResetDispatch): Promise<ResetWait | null>;
}

interface Saved {
  /** Stopped turns (request ids) Boat resumed, and when. */
  handled: Record<string, number>;
  /** Chats Boat resumed, and when. */
  resumed: Record<string, number>;
}

export function createResetPacing(deps: ResetPacingDeps): ResetPacing {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const lane = new ResetLane();
  const saved: Saved = { handled: {}, resumed: {} };
  /** What Boat declined (request id → the thread and provider retry's planned time). */
  const declined = new Map<string, { threadId: string; sendAt: number; at: number }>();
  /** Every consent question Boat answered, by request (only bb 0.49 asks). */
  const answered = new Map<string, number>();
  /** Failures being followed right now. */
  const following = new Set<string>();
  let loading: Promise<void> | null = null;

  function prune(at: number): void {
    for (const [key, when] of Object.entries(saved.handled)) if (at - when > 7 * 24 * 3_600_000) delete saved.handled[key];
    for (const [key, when] of Object.entries(saved.resumed)) if (at - when > RESUMED_MEMORY_MS) delete saved.resumed[key];
    for (const [key, entry] of declined) if (at - entry.at > 10 * 60_000) declined.delete(key);
    for (const [key, when] of answered) if (at - when > 10 * 60_000) answered.delete(key);
  }

  function load(): Promise<void> {
    loading ??= deps.kv.get<Saved>(RESET_RESUMES_KEY).then(
      (raw) => {
        if (raw === null || typeof raw !== "object") return;
        for (const key of ["handled", "resumed"] as const) {
          const entries = (raw as Partial<Saved>)[key];
          if (entries === null || typeof entries !== "object") continue;
          for (const [id, at] of Object.entries(entries)) if (typeof at === "number" && Number.isFinite(at)) saved[key][id] ??= at;
        }
      },
      () => undefined,
    );
    return loading;
  }

  async function save(): Promise<void> {
    prune(now());
    await deps.kv.set(RESET_RESUMES_KEY, { handled: { ...saved.handled }, resumed: { ...saved.resumed } }).catch((error: unknown) => log(`reset resumes: couldn't save (${error instanceof Error ? error.message : String(error)})`));
  }

  return {
    load,

    consent(input) {
      const at = now();
      answered.set(input.requestId, at);
      if (answered.size > 1_000) prune(at);
      if (input.reason !== LIMIT_RETRY_REASON || input.sendAt - at < DECLINE_AFTER_MS) return { kind: "allow" };
      if (!deps.isBoatChat(input.threadId)) return { kind: "allow" };
      // Resumed once already: the next time is provider retry's (one Boat resume per stopped turn).
      const resumedAt = saved.resumed[input.threadId];
      if (resumedAt !== undefined && at - resumedAt < RESUMED_MEMORY_MS) return { kind: "allow" };
      declined.set(input.requestId, { threadId: input.threadId, sendAt: input.sendAt, at });
      return { kind: "decline", reason: DECLINE_REASON };
    },

    async failed(event) {
      const threadId = typeof event.threadId === "string" ? event.threadId : null;
      const requestId = typeof event.requestId === "string" ? event.requestId : null;
      if (threadId === null || requestId === null || !isLimitFailure(event) || !deps.isBoatChat(threadId)) return "skipped";
      await load();
      if (saved.handled[requestId] !== undefined || following.has(requestId)) return "skipped";
      following.add(requestId);
      try {
        // Only a retry Boat itself declined is Boat's to resume. bb 0.49 asks right after the
        // failure; bb 0.50 never asks, so nothing more is read there (no decision.get polls).
        const asked = now() + CONSENT_WAIT_MS;
        while (!answered.has(requestId) && now() < asked) await sleep(CONSENT_POLL_MS);
        if (!declined.has(requestId)) return "skipped";
        // provider retry records its decision after asking: follow it for a minute.
        const deadline = now() + DECISION_WAIT_MS;
        let decision: ReturnType<typeof parseDecision> = null;
        for (;;) {
          decision = parseDecision(await deps.decision(threadId).catch(() => null));
          if (decision?.requestId === requestId || now() >= deadline) break;
          await sleep(DECISION_POLL_MS);
        }
        if (decision?.requestId !== requestId) {
          // Boat declined, but provider retry recorded nothing readable: bb's queue tells whether it retries anyway.
          const queued = deps.queuedRetry === undefined ? null : await deps.queuedRetry(threadId).catch(() => null);
          if (queued !== false) {
            log(`reset resume ${threadId}: provider retry recorded no decision within a minute${queued ? " and a retry is queued" : ", and Harbormaster couldn't read bb's queue"}; leaving the chat as it is`);
            return "skipped";
          }
        } else if (decision.kind !== "decline" || decision.reason !== "declined-by-sender") {
          // Only what Boat itself declined (an "allow" bb counted after a slow answer is provider retry's).
          return "skipped";
        }
        const resetAt = failureResetAt(event);
        const sendAt = declined.get(requestId)?.sendAt ?? (resetAt === null ? null : resetAt + 15_000);
        if (sendAt === null) {
          log(`reset resume ${threadId}: no reset time for the declined retry; leaving the chat as it is`);
          return "skipped";
        }
        // Remembered once bb has it (or refused it for good); a passing failure is tried again.
        const settle = async () => {
          const at = now();
          saved.handled[requestId] = at;
          saved.resumed[threadId] = at;
          declined.delete(requestId);
          await save();
        };
        for (let attempt = 0; ; attempt++) {
          const at = now();
          try {
            await deps.retry({ threadId, turnRequestId: requestId, sendAt: Math.max(sendAt, at), reason: BOAT_RESET_REASON });
            await settle();
            log(`reset resume ${threadId}: queued the stopped turn for ${new Date(Math.max(sendAt, at)).toISOString()} (paced when it wakes a sandbox)`);
            return "queued";
          } catch (error) {
            const said = error instanceof Error ? error.message : String(error);
            const wait = RETRY_WAITS_MS[attempt];
            if (REFUSED_FOR_GOOD.test(said) || wait === undefined) {
              // The chat moved on, or it's gone: not again. Out of tries: said loudly.
              if (REFUSED_FOR_GOOD.test(said)) await settle();
              log(`reset resume ${threadId}: bb refused the retry (${said})${REFUSED_FOR_GOOD.test(said) ? "" : `; after ${attempt + 1} tries the chat stays stopped until someone continues it`}`);
              return "skipped";
            }
            await sleep(wait);
          }
        }
      } finally {
        following.delete(requestId);
      }
    },

    async dispatch(context) {
      const host = context.host;
      if (host?.machineProviderId !== MACHINE_PROVIDER_ID || host.lifecycle?.phase !== "suspended") return null;
      const rows = context.queuedMessages;
      if (rows.length === 0 || !rows.every((row) => row.payload?.kind === "retry" && (row.payload.reason === LIMIT_RETRY_REASON || row.payload.reason === BOAT_RESET_REASON))) return null;
      // One slot per machine: its first retry wakes it, the others for it go with that one.
      const key = host.id ?? rows[0]!.id;
      const at = now();
      const earliest = deps.nextWakeAt === undefined ? at : await deps.nextWakeAt().catch(() => at);
      const slot = lane.slot(key, at, earliest);
      if (slot <= at + 1_000) return null;
      return { action: "wait", reason: `Harbormaster wakes at most ${WAKES_PER_WINDOW} sandboxes a minute after a usage limit resets; this chat goes on at ${clockTime(slot, at)}.`, sendAt: slot };
    },
  };
}
