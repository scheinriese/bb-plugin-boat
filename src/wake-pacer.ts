// Gentle sandbox wake-ups: at most 2 boat resumes a minute, account-wide,
// and a doubling pause after a wake fails.
//
// boat.dev restores a woken sandbox's disk lazily from storage. Waking many
// at once (a usage limit's reset retrying every chat stopped at it) can
// overload that storage: boat answers "Please reduce your request rate",
// or the disk keeps failing to hydrate (HYDRATOR FAILED … status code 503).
//
// Standalone on purpose (no boat or bb imports): every wake path shares one
// pacer, and other modules (paid resumes) can adopt it as is.
//
//   const permit = await pacer.acquire({ signal, onWait });
//   try { await wake(); await permit.succeeded(); }
//   catch (error) { await permit.failed(); throw error; }
import { setTimeout as delay } from "node:timers/promises";

/** At most this many wakes in any WAKE_WINDOW_MS (a token comes back a window after it was spent). */
export const WAKES_PER_WINDOW = 2;
export const WAKE_WINDOW_MS = 60_000;
/** After a failed wake, the next waits this long, doubling for each failure in a row… */
export const WAKE_BACKOFF_BASE_MS = 30_000;
/** …up to this. */
export const WAKE_BACKOFF_MAX_MS = 10 * 60_000;
/** acquire waits at most this long; a later slot throws WakeDeferred instead. */
export const WAKE_MAX_WAIT_MS = 2 * 60_000;

/** What the pacer saves (plain JSON). */
export interface WakePacerState {
  /** When the recent wakes started (epoch ms), oldest first. */
  taken: number[];
  /** Failed wakes in a row. */
  failures: number;
  /** No wake before this (epoch ms; 0: none). */
  blockedUntil: number;
}

export interface WakePacerStorage {
  load(): Promise<unknown>;
  save(state: WakePacerState): Promise<void>;
}

/** Save the pacer in a key-value store (bb's plugin kv). */
export function kvWakeStorage(kv: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> }, key = "wakePacer"): WakePacerStorage {
  return { load: () => kv.get<unknown>(key), save: (state) => kv.set(key, state) };
}

/** Why a wake has to wait. */
export type WakeWait = "rate" | "backoff";

/** "01:52 UTC". */
function utcClock(at: number): string {
  return `${new Date(at).toISOString().slice(11, 16)} UTC`;
}

/** The next wake slot is further away than the caller wants to wait: try again at retryAt. */
export class WakeDeferred extends Error {
  readonly code = "wake_deferred";
  readonly retryAt: number;
  readonly reason: WakeWait;
  constructor(retryAt: number, reason: WakeWait, perWindow = WAKES_PER_WINDOW) {
    super(
      reason === "backoff"
        ? `boat.dev failed to wake a sandbox just now, so Boat pauses wake-ups until ${utcClock(retryAt)}. Try again then.`
        : `Boat wakes at most ${perWindow} sandboxes a minute and others are waking now. Try again at ${utcClock(retryAt)}.`,
    );
    this.name = "WakeDeferred";
    this.retryAt = retryAt;
    this.reason = reason;
  }
}

/** One wake's slot. Settle it once (later calls are ignored); unsettled, it only used up its slot. */
export interface WakePermit {
  /** The wake worked: failures in a row start over. */
  succeeded(): Promise<void>;
  /** The wake failed: the next one waits (WAKE_BACKOFF_BASE_MS, doubling). */
  failed(): Promise<void>;
}

export interface WakePacerOptions {
  perWindow?: number;
  windowMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxWaitMs?: number;
  storage?: WakePacerStorage;
  now?: () => number;
  /** Wait (rejects when the signal aborts). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
  log?: (line: string) => void;
}

export interface AcquireOptions {
  signal?: AbortSignal;
  /** Wait at most this long (default: the pacer's maxWaitMs). */
  maxWaitMs?: number;
  /** Told once per new wait: when the wake may go, and why it waits. */
  onWait?: (until: number, reason: WakeWait) => void;
}

function cleanState(raw: unknown): WakePacerState {
  const value = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const finite = (entry: unknown): entry is number => typeof entry === "number" && Number.isFinite(entry);
  return {
    taken: Array.isArray(value.taken) ? value.taken.filter(finite).sort((a, b) => a - b) : [],
    failures: finite(value.failures) && value.failures > 0 ? Math.floor(value.failures) : 0,
    blockedUntil: finite(value.blockedUntil) ? value.blockedUntil : 0,
  };
}

export class WakePacer {
  readonly perWindow: number;
  readonly windowMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxWaitMs: number;
  private readonly storage: WakePacerStorage | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<unknown>;
  private readonly log: (line: string) => void;
  private loaded: Promise<WakePacerState> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(options: WakePacerOptions = {}) {
    this.perWindow = Math.max(1, options.perWindow ?? WAKES_PER_WINDOW);
    this.windowMs = options.windowMs ?? WAKE_WINDOW_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? WAKE_BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? WAKE_BACKOFF_MAX_MS;
    this.maxWaitMs = options.maxWaitMs ?? WAKE_MAX_WAIT_MS;
    this.storage = options.storage ?? null;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.log = options.log ?? (() => undefined);
  }

  /**
   * Take a wake slot: at once when one is free, else wait for it (up to
   * maxWaitMs, respecting the signal). A slot further out throws WakeDeferred.
   */
  async acquire(options: AcquireOptions = {}): Promise<WakePermit> {
    const deadline = this.now() + (options.maxWaitMs ?? this.maxWaitMs);
    let told = -1;
    for (;;) {
      options.signal?.throwIfAborted();
      const state = await this.state();
      // No await between the check and the take: concurrent callers can't share a slot.
      const now = this.now();
      const { at, reason } = this.slot(state, now);
      if (at <= now) {
        state.taken.push(now);
        await this.save(state);
        return this.permit();
      }
      if (at > deadline) throw new WakeDeferred(at, reason, this.perWindow);
      if (at !== told) {
        told = at;
        options.onWait?.(at, reason);
      }
      try {
        await this.sleep(at - now, options.signal);
      } catch (error) {
        options.signal?.throwIfAborted();
        throw error;
      }
    }
  }

  /** When the next wake may start (now or later). */
  async nextWakeAt(): Promise<number> {
    const now = this.now();
    return this.slot(await this.state(), now).at;
  }

  /** A copy of what the pacer holds (for tests and status lines). */
  async snapshot(): Promise<WakePacerState> {
    const state = await this.state();
    return { taken: [...state.taken], failures: state.failures, blockedUntil: state.blockedUntil };
  }

  /** The pause after this many failed wakes in a row. */
  backoffMs(failures: number): number {
    if (failures <= 0) return 0;
    return Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.min(failures - 1, 30));
  }

  private slot(state: WakePacerState, now: number): { at: number; reason: WakeWait } {
    // Forget wakes out of the window (and impossible ones from a clock change).
    state.taken = state.taken.filter((at) => at > now - this.windowMs && at <= now + this.windowMs);
    const rateAt = state.taken.length < this.perWindow ? now : state.taken[state.taken.length - this.perWindow]! + this.windowMs;
    const at = Math.max(now, rateAt, state.blockedUntil);
    return { at, reason: state.blockedUntil > now && state.blockedUntil >= rateAt ? "backoff" : "rate" };
  }

  private permit(): WakePermit {
    let settled = false;
    const settle = async (ok: boolean) => {
      if (settled) return;
      settled = true;
      const state = await this.state();
      if (ok) {
        state.failures = 0;
      } else {
        state.failures += 1;
        state.blockedUntil = Math.max(state.blockedUntil, this.now() + this.backoffMs(state.failures));
      }
      await this.save(state);
    };
    return { succeeded: () => settle(true), failed: () => settle(false) };
  }

  private state(): Promise<WakePacerState> {
    this.loaded ??= (this.storage?.load() ?? Promise.resolve(undefined)).then(cleanState, (error: unknown) => {
      this.log(`wake pacer: couldn't read its saved state (${error instanceof Error ? error.message : String(error)}); starting fresh`);
      return cleanState(undefined);
    });
    return this.loaded;
  }

  private save(state: WakePacerState): Promise<void> {
    const storage = this.storage;
    if (storage === null) return Promise.resolve();
    const copy = { taken: [...state.taken], failures: state.failures, blockedUntil: state.blockedUntil };
    this.saving = this.saving.then(() => storage.save(copy)).catch((error: unknown) => {
      this.log(`wake pacer: couldn't save its state (${error instanceof Error ? error.message : String(error)})`);
    });
    return this.saving;
  }
}
