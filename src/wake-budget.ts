// How often the plugin may wake a machine on its own (resume a suspended bb
// machine, or a stopped boat sandbox): a token bucket kept in kv, so neither a
// restart nor an extra pass resets it. The watchdog and the paid Claude
// resume share one, so together they never wake more than this a minute: a
// burst of wakes is what overloads boat.dev's snapshot storage. A wake that
// fails (at once, or found failed later) holds every wake for a while.
//
// Every boat resume itself takes a slot from the sandbox wake pacer
// (src/wake-pacer.ts: 2 a minute account-wide, a pause after a failed wake).
// This budget only decides whether the watchdog or the paid resume starts a
// wake at all, so it also says no while the pacer has no slot free now
// (pacer.nextWakeAt, which takes nothing: a slot taken here too would count
// each wake twice). The interface is kept small for a later unification with
// the pacer: take ≈ acquire without waiting (false instead of WakeDeferred),
// failed ≈ permit.failed, also for a failure found after the wake.

/** Wakes a minute, at most. */
export const WAKES_PER_MINUTE = 2;
/** After a wake fails, no machine is woken for this long. */
export const WAKE_FAILURE_HOLD_MS = 15 * 60_000;
export const WAKE_BUDGET_KEY = "wakeBudget";

interface KvStore {
  get<T>(key: string): Promise<T | undefined | null>;
  set(key: string, value: unknown): Promise<void>;
}

export interface WakeBudget {
  /** Take one wake if there's one left now and wakes aren't held (true), else false. */
  take(): Promise<boolean>;
  /** A wake failed (the call, or the machine found failed to start later): hold every wake. */
  failed(): Promise<void>;
  /** Wakes are held until then (epoch ms; 0: not held). */
  heldUntil(): Promise<number>;
}

interface Bucket {
  tokens: number;
  at: number;
  /** No wake before this (epoch ms; absent or 0: none). */
  heldUntil?: number;
}

/** What the budget reads from the sandbox wake pacer (src/wake-pacer.ts WakePacer). */
export interface WakeSlots {
  /** When the next wake may start (now or later); reads only. */
  nextWakeAt(): Promise<number>;
}

export function createWakeBudget(kv: KvStore, options: { perMinute?: number; holdMs?: number; now?: () => number; pacer?: WakeSlots } = {}): WakeBudget {
  const perMinute = options.perMinute ?? WAKES_PER_MINUTE;
  const holdMs = options.holdMs ?? WAKE_FAILURE_HOLD_MS;
  const now = options.now ?? (() => Date.now());
  const refillMs = 60_000 / perMinute;
  let chain: Promise<unknown> = Promise.resolve();

  async function load(): Promise<Required<Bucket>> {
    const raw = (await kv.get<Bucket>(WAKE_BUDGET_KEY).catch(() => null)) as Bucket | null | undefined;
    const heldUntil = raw && Number.isFinite(raw.heldUntil) ? Number(raw.heldUntil) : 0;
    if (raw && Number.isFinite(raw.tokens) && Number.isFinite(raw.at)) return { tokens: Math.max(0, Math.min(perMinute, raw.tokens)), at: raw.at, heldUntil };
    return { tokens: perMinute, at: now(), heldUntil };
  }

  /** The bucket refilled to now. */
  async function current(): Promise<Required<Bucket>> {
    const at = now();
    const bucket = await load();
    // A clock that went back refills nothing.
    return { tokens: Math.min(perMinute, bucket.tokens + Math.max(0, at - bucket.at) / refillMs), at, heldUntil: bucket.heldUntil };
  }

  async function take(): Promise<boolean> {
    const bucket = await current();
    // The pacer has no slot free now (two wakes this minute, or its pause after a failed one): not now either.
    const pacerBusy = options.pacer !== undefined && (await options.pacer.nextWakeAt()) > bucket.at;
    if (pacerBusy || bucket.heldUntil > bucket.at || bucket.tokens < 1) {
      await kv.set(WAKE_BUDGET_KEY, bucket).catch(() => undefined);
      return false;
    }
    // Saved before the wake: a crash right after can't hand the token out twice.
    await kv.set(WAKE_BUDGET_KEY, { ...bucket, tokens: bucket.tokens - 1 });
    return true;
  }

  async function failed(): Promise<void> {
    const bucket = await current();
    await kv.set(WAKE_BUDGET_KEY, { ...bucket, heldUntil: Math.max(bucket.heldUntil, bucket.at + holdMs) });
  }

  // One at a time, so two callers can't both spend the last token.
  function serial<T>(run: () => Promise<T>, fallback: T): Promise<T> {
    const next = chain.then(run, run);
    chain = next.catch(() => undefined);
    return next.catch(() => fallback);
  }

  return {
    take: () => serial(take, false),
    failed: () => serial(failed, undefined),
    heldUntil: async () => (await load()).heldUntil,
  };
}
