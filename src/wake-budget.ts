// How often the plugin may wake a machine on its own (resume a suspended bb
// machine, or a stopped boat sandbox): a token bucket kept in kv, so neither a
// restart nor an extra pass resets it. The watchdog and the paid Claude
// resume share one, so together they never wake more than this a minute: a
// burst of wakes is what overloads boat.dev's snapshot storage.

/** Wakes a minute, at most. */
export const WAKES_PER_MINUTE = 2;
export const WAKE_BUDGET_KEY = "wakeBudget";

interface KvStore {
  get<T>(key: string): Promise<T | undefined | null>;
  set(key: string, value: unknown): Promise<void>;
}

export interface WakeBudget {
  /** Take one wake if there's one left now (true), else false. */
  take(): Promise<boolean>;
}

interface Bucket {
  tokens: number;
  at: number;
}

export function createWakeBudget(kv: KvStore, options: { perMinute?: number; now?: () => number } = {}): WakeBudget {
  const perMinute = options.perMinute ?? WAKES_PER_MINUTE;
  const now = options.now ?? (() => Date.now());
  const refillMs = 60_000 / perMinute;
  let chain: Promise<unknown> = Promise.resolve();

  async function load(): Promise<Bucket> {
    const raw = (await kv.get<Bucket>(WAKE_BUDGET_KEY).catch(() => null)) as Bucket | null | undefined;
    if (raw && Number.isFinite(raw.tokens) && Number.isFinite(raw.at)) return { tokens: Math.max(0, Math.min(perMinute, raw.tokens)), at: raw.at };
    return { tokens: perMinute, at: now() };
  }

  async function take(): Promise<boolean> {
    const at = now();
    const bucket = await load();
    // A clock that went back refills nothing.
    const tokens = Math.min(perMinute, bucket.tokens + Math.max(0, at - bucket.at) / refillMs);
    if (tokens < 1) {
      await kv.set(WAKE_BUDGET_KEY, { tokens, at } satisfies Bucket).catch(() => undefined);
      return false;
    }
    // Saved before the wake: a crash right after can't hand the token out twice.
    await kv.set(WAKE_BUDGET_KEY, { tokens: tokens - 1, at } satisfies Bucket);
    return true;
  }

  return {
    take() {
      // One at a time, so two callers can't both spend the last token.
      const next = chain.then(take, take);
      chain = next.catch(() => undefined);
      return next.catch(() => false);
    },
  };
}
