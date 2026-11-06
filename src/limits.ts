// Agents that hit a usage limit, learned from bb's failure events. A limit is
// account-wide: once any chat on Claude (or Codex) fails on one, that agent
// counts as full until the window resets, whatever the usage readings say.
// This is what keeps the relay from moving work onto an agent that's out,
// even when no usage source knows that agent.
import type { Provider } from "./store.ts";

/** Without a reset time, a limit is assumed to last this long (a session window). */
export const DEFAULT_LIMIT_MS = 5 * 60 * 60_000;

/** A failed turn's text that means a subscription limit (not a passing overload, which bb retries). */
export const USAGE_LIMIT_TEXT =
  /usage limit|limit reached|hit your (usage )?limit|limit will reset|out of (extra )?usage|out of credits|(weekly|5-hour|session) limit/i;

export const PROVIDER_OF_ID: Record<string, Provider> = { "claude-code": "claude", codex: "codex" };

export type LimitFlags = Partial<Record<Provider, number>>;

interface KvStore {
  get<T>(key: string): Promise<T | undefined | null>;
  set(key: string, value: unknown): Promise<void>;
}

const KEY = "relay:limited";

export interface LimitTracker {
  /** Agents marked as at their limit, with when that ends (epoch ms). */
  active(now?: number): Promise<LimitFlags>;
  /** Mark an agent as limited until a time (keeps the later of two marks). */
  record(provider: Provider, until: number): Promise<void>;
}

export function createLimitTracker(kv: KvStore): LimitTracker {
  let cache: LimitFlags | null = null;
  async function load(): Promise<LimitFlags> {
    if (cache === null) cache = ((await kv.get<LimitFlags>(KEY).catch(() => null)) ?? {}) as LimitFlags;
    return cache;
  }
  return {
    async active(now = Date.now()) {
      const flags = await load();
      const live: LimitFlags = {};
      for (const [provider, until] of Object.entries(flags) as [Provider, number][]) if (until > now) live[provider] = until;
      return live;
    },
    async record(provider, until) {
      const flags = { ...(await load()) };
      if ((flags[provider] ?? 0) >= until) return;
      flags[provider] = until;
      cache = flags;
      await kv.set(KEY, flags).catch(() => undefined);
    },
  };
}

/** The parts of bb's turn.failed event the tracker reads. */
export interface TurnFailure {
  errorInfo?: { category?: string | null } | null;
  rateLimits?: {
    kind?: string | null;
    status?: string | null;
    providerId?: string | null;
    windows?: { status?: string | null; resetsAtMs?: number | null }[] | null;
  } | null;
}

/**
 * When a failed turn was a subscription limit, the time it lifts (epoch ms);
 * null when the failure was something else (an overload, a disconnect).
 */
export function limitFromTurnFailure(event: TurnFailure, now = Date.now()): number | null {
  const limits = event.rateLimits ?? null;
  const blocked =
    limits !== null &&
    limits.status === "blocked" &&
    (limits.kind === "subscription-window" || limits.kind === "credits" || limits.kind === "spend-control");
  const billing = event.errorInfo?.category === "billing";
  if (!blocked && !billing) return null;
  const resets = (limits?.windows ?? [])
    .filter((window) => window.status === "blocked" && typeof window.resetsAtMs === "number" && window.resetsAtMs > now)
    .map((window) => window.resetsAtMs as number);
  return resets.length > 0 ? Math.max(...resets) : now + DEFAULT_LIMIT_MS;
}

/** thread.failed only carries the error text: a limit when it says so. */
export function limitFromErrorText(error: string | null | undefined, now = Date.now()): number | null {
  return error && USAGE_LIMIT_TEXT.test(error) ? now + DEFAULT_LIMIT_MS : null;
}
