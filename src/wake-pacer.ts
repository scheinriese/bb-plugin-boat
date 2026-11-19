// Gentle sandbox wake-ups: one limiter for every wake, account-wide.
//
// boat.dev restores a woken sandbox's disk lazily from storage. Waking many
// at once (a usage limit's reset retrying every chat stopped at it) can
// overload that storage: boat answers "Please reduce your request rate",
// or the disk keeps failing to hydrate (HYDRATOR FAILED … status code 503).
//
// - At most 2 wakes a minute (a slot comes back a minute after it was taken).
// - After a failed wake, a pause before the next: 30 s, doubling to 10
//   minutes, forgotten once the last pause ended 15 minutes ago.
// - The hold: after a wake the plugin started on its own failed (the paid
//   resume's, at once or found failed later), the plugin starts no wake on
//   its own (take) for 15 minutes. A wake someone asks for isn't held.
//
// Every boat resume takes its slot with acquire, waiting for it. A wake the
// plugin starts on its own through bb (the watchdog's resume of a machine,
// the paid resume) asks first with take, which never waits: a slot now, or
// none. That slot is claimed for the machine (host:<id>, sandbox:<id>), and
// the boat resume that follows (acquire with one of those ids) uses it
// instead of a second one, so each real wake counts once. A claim nobody
// used goes with its slot a minute later, or at once with release().
//
// Standalone on purpose (no boat or bb imports): every wake path shares one
// pacer, saved in one place.
//
//   const permit = await pacer.acquire({ signal, onWait, ids });
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
/**
 * Failures in a row are forgotten once the last pause ended this long ago:
 * one old bad wake doesn't give the next, days later, the longest pause.
 */
export const WAKE_FAILURES_DECAY_MS = 15 * 60_000;
/** After a wake the plugin started on its own failed, it starts none on its own (take) for this long. */
export const WAKE_FAILURE_HOLD_MS = 15 * 60_000;
/** kv: the pacer's saved state. */
export const WAKE_PACER_KEY = "wakePacer";
/** kv: the wake budget's state from before it was part of the pacer (its hold is carried over, then it goes). */
export const LEGACY_WAKE_BUDGET_KEY = "wakeBudget";

/** A slot take() handed out, claimed for the boat resume of these machines. */
export interface WakeClaimState {
  /** When the slot was taken (epoch ms; its entry in `taken`). */
  at: number;
  /** host:<id>, sandbox:<id>. */
  ids: string[];
}

/** What the pacer saves (plain JSON). */
export interface WakePacerState {
  /** When the recent wakes started (epoch ms), oldest first. A claimed slot is one of them. */
  taken: number[];
  /** Failed wakes in a row. */
  failures: number;
  /** No wake before this (epoch ms; 0: none). */
  blockedUntil: number;
  /** The plugin starts no wake on its own (take) before this (epoch ms; 0: none). */
  heldUntil: number;
  /** Slots take() handed out that no boat resume has used yet, oldest first. */
  claims: WakeClaimState[];
}

export interface WakePacerStorage {
  load(): Promise<unknown>;
  save(state: WakePacerState): Promise<void>;
}

interface Kv {
  get<T>(key: string): Promise<T | undefined | null>;
  set(key: string, value: unknown): Promise<void>;
  delete?(key: string): Promise<unknown>;
}

/**
 * Save the pacer in a key-value store (bb's plugin kv). The first load takes
 * over a hold the wake budget saved before it was part of the pacer, and
 * deletes the budget's key.
 */
export function kvWakeStorage(kv: Kv, key = WAKE_PACER_KEY): WakePacerStorage {
  return {
    async load() {
      const saved = await kv.get<unknown>(key);
      const legacy = await kv.get<unknown>(LEGACY_WAKE_BUDGET_KEY).catch(() => undefined);
      if (legacy === undefined || legacy === null) return saved;
      const held = Number((legacy as { heldUntil?: unknown }).heldUntil);
      const state = cleanState(saved);
      state.heldUntil = Math.max(state.heldUntil, Number.isFinite(held) ? held : 0);
      try {
        await kv.set(key, state);
        await kv.delete?.(LEGACY_WAKE_BUDGET_KEY);
      } catch {
        // The budget's key stays: the next load takes it over again.
      }
      return state;
    },
    save: (state) => kv.set(key, state),
  };
}

/** The ids a wake of this machine is claimed by (the paid resume's and the watchdog's form). */
export function wakeIds(machine: { sandboxId?: string | null; hostId?: string | null }): string[] {
  return [...(machine.sandboxId ? [`sandbox:${machine.sandboxId}`] : []), ...(machine.hostId ? [`host:${machine.hostId}`] : [])];
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

/** A slot take() handed out. The boat resume of its machines uses it (acquire with their ids). */
export interface WakeClaim {
  /** The wake never got to a boat resume (the call failed first, or the machine was up): its slot is free again. A used one stays. */
  release(): Promise<void>;
}

/**
 * The wakes the plugin starts on its own through bb (src/paid-resume.ts).
 * Only a wake it made itself that failed sets the hold: never a failure a
 * machine still shows from long ago.
 */
export type OwnWakes = Pick<WakePacer, "take" | "hold" | "heldUntil">;

export interface WakePacerOptions {
  perWindow?: number;
  windowMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxWaitMs?: number;
  decayMs?: number;
  holdMs?: number;
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
  /** The machines this wake is for (host:<id>, sandbox:<id>): a slot take() claimed for one of them is used instead of a new one. */
  ids?: readonly string[];
}

function cleanState(raw: unknown): WakePacerState {
  const value = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const finite = (entry: unknown): entry is number => typeof entry === "number" && Number.isFinite(entry);
  const claims = Array.isArray(value.claims) ? value.claims : [];
  return {
    taken: Array.isArray(value.taken) ? value.taken.filter(finite).sort((a, b) => a - b) : [],
    failures: finite(value.failures) && value.failures > 0 ? Math.floor(value.failures) : 0,
    blockedUntil: finite(value.blockedUntil) ? value.blockedUntil : 0,
    heldUntil: finite(value.heldUntil) ? value.heldUntil : 0,
    claims: claims
      .filter((claim): claim is { at: number; ids: unknown[] } => claim !== null && typeof claim === "object" && finite((claim as { at?: unknown }).at) && Array.isArray((claim as { ids?: unknown }).ids))
      .map((claim) => ({ at: claim.at, ids: claim.ids.filter((id): id is string => typeof id === "string") }))
      .sort((a, b) => a.at - b.at),
  };
}

function copyState(state: WakePacerState): WakePacerState {
  return { taken: [...state.taken], failures: state.failures, blockedUntil: state.blockedUntil, heldUntil: state.heldUntil, claims: state.claims.map((claim) => ({ at: claim.at, ids: [...claim.ids] })) };
}

export class WakePacer {
  readonly perWindow: number;
  readonly windowMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxWaitMs: number;
  private readonly decayMs: number;
  private readonly holdMs: number;
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
    this.decayMs = options.decayMs ?? WAKE_FAILURES_DECAY_MS;
    this.holdMs = options.holdMs ?? WAKE_FAILURE_HOLD_MS;
    this.storage = options.storage ?? null;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.log = options.log ?? (() => undefined);
  }

  /**
   * Take a wake slot: at once when one is free, else wait for it (up to
   * maxWaitMs, respecting the signal). A slot further out throws WakeDeferred.
   * A slot take() claimed for one of `ids` is used instead: it counts already,
   * so only a pause after a failed wake is waited out.
   */
  async acquire(options: AcquireOptions = {}): Promise<WakePermit> {
    const deadline = this.now() + (options.maxWaitMs ?? this.maxWaitMs);
    let told = -1;
    for (;;) {
      options.signal?.throwIfAborted();
      const state = await this.state();
      // No await between the check and the take: concurrent callers can't share a slot.
      const now = this.now();
      const free = this.slot(state, now);
      const claim = this.claimFor(state, options.ids);
      const at = claim === undefined ? free.at : Math.max(now, state.blockedUntil);
      const reason = claim === undefined ? free.reason : "backoff";
      if (at <= now) {
        if (claim === undefined) state.taken.push(now);
        else this.use(state, claim, now);
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

  /**
   * A wake the plugin starts on its own through bb (the watchdog's resume, the
   * paid resume): a slot now, or null while none is free, a pause after a
   * failed wake runs, or the hold. Never waits. The slot is claimed for `ids`
   * (host:<id>, sandbox:<id>): the boat resume that follows uses it.
   */
  async take(ids: readonly string[] = []): Promise<WakeClaim | null> {
    const state = await this.state();
    // The time after the read, no await between: a read that took a while can't make a free slot look taken.
    const now = this.now();
    if (this.slot(state, now, true).at > now) return null;
    const claim: WakeClaimState = { at: now, ids: [...new Set(ids)] };
    state.taken.push(now);
    state.claims.push(claim);
    // Saved before the wake: a restart right after can't hand the slot out twice.
    await this.save(state);
    return this.claimHandle(claim);
  }

  /**
   * A wake the plugin started on its own failed (at once, or found failed
   * later): take() gives no slot for WAKE_FAILURE_HOLD_MS. A hold only moves on.
   */
  async hold(): Promise<void> {
    const state = await this.state();
    state.heldUntil = Math.max(state.heldUntil, this.now() + this.holdMs);
    await this.save(state);
  }

  /** take() gives no slot before this (epoch ms; 0: never held). */
  async heldUntil(): Promise<number> {
    return (await this.state()).heldUntil;
  }

  /** No wake the plugin starts on its own before this: the hold, or the pause after a failed wake, whichever ends later. */
  async pausedUntil(): Promise<number> {
    const state = await this.state();
    return Math.max(state.heldUntil, state.blockedUntil);
  }

  /** When the next wake may start (now or later). `held`: a wake take() gives, so the hold counts too. */
  async nextWakeAt(options: { held?: boolean } = {}): Promise<number> {
    const state = await this.state();
    // The time after the read, as in take and acquire: an earlier one would drop a slot taken during a slow read.
    const now = this.now();
    return this.slot(state, now, options.held === true).at;
  }

  /** A copy of what the pacer holds (for tests and status lines). */
  async snapshot(): Promise<WakePacerState> {
    return copyState(await this.state());
  }

  /** The pause after this many failed wakes in a row. */
  backoffMs(failures: number): number {
    if (failures <= 0) return 0;
    return Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.min(failures - 1, 30));
  }

  /** Failures in a row whose last pause ended long ago are forgotten. */
  private decay(state: WakePacerState, now: number): void {
    if (state.failures > 0 && now - state.blockedUntil > this.decayMs) state.failures = 0;
  }

  private slot(state: WakePacerState, now: number, held = false): { at: number; reason: WakeWait } {
    this.decay(state, now);
    // Forget wakes out of the window (and impossible ones from a clock change); a claim goes with its slot.
    const recent = (at: number) => at > now - this.windowMs && at <= now + this.windowMs;
    state.taken = state.taken.filter(recent);
    state.claims = state.claims.filter((claim) => recent(claim.at));
    const rateAt = state.taken.length < this.perWindow ? now : state.taken[state.taken.length - this.perWindow]! + this.windowMs;
    const pauseAt = held ? Math.max(state.blockedUntil, state.heldUntil) : state.blockedUntil;
    const at = Math.max(now, rateAt, pauseAt);
    return { at, reason: pauseAt > now && pauseAt >= rateAt ? "backoff" : "rate" };
  }

  /** The oldest claim for one of these machines. */
  private claimFor(state: WakePacerState, ids: readonly string[] | undefined): WakeClaimState | undefined {
    if (ids === undefined || ids.length === 0) return undefined;
    return state.claims.find((claim) => claim.ids.some((id) => ids.includes(id)));
  }

  /** The claimed slot is this wake's: it starts now (its entry moves on, never adding one). */
  private use(state: WakePacerState, claim: WakeClaimState, now: number): void {
    this.drop(state, claim);
    state.taken.push(now);
    state.taken.sort((a, b) => a - b);
  }

  /** The claim and its slot go. */
  private drop(state: WakePacerState, claim: WakeClaimState): void {
    state.claims = state.claims.filter((entry) => entry !== claim);
    const index = state.taken.indexOf(claim.at);
    if (index >= 0) state.taken.splice(index, 1);
  }

  private claimHandle(claim: WakeClaimState): WakeClaim {
    return {
      release: async () => {
        const state = await this.state();
        // Used by its wake, or gone with its slot: nothing to give back.
        if (!state.claims.includes(claim)) return;
        this.drop(state, claim);
        await this.save(state);
      },
    };
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
        this.decay(state, this.now());
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
    const copy = copyState(state);
    this.saving = this.saving.then(() => storage.save(copy)).catch((error: unknown) => {
      this.log(`wake pacer: couldn't save its state (${error instanceof Error ? error.message : String(error)})`);
    });
    return this.saving;
  }
}
