// Waking a Boat sandbox machine without hammering boat.dev.
//
// Every machine wake (bb's resume of a Boat sandbox) goes through the guard:
// - it takes a slot from the account's wake pacer before boat resumes the
//   sandbox (at most 2 a minute; a pause after a failure);
// - a failure is diagnosed (wake-diagnosis.ts) and told in plain words, on
//   the machine and on the sandbox's tasks;
// - when boat.dev is still restoring the disk, refused the restore, or the
//   sandbox's SSH sessions never start, Boat retries itself later (2, 4, 8,
//   16 minutes); resumes before then fail at once without asking boat.dev.
//   After 5 failures it stops, and the orchestrator gets a Needs you item
//   naming the sandbox and boat.dev's error;
// - bb's daemon broken by an update: Needs you, with the repair by hand;
// - boat refusing the resume for the sandbox's size: Needs you, with the way
//   back by hand (src/disk-trim.ts); Boat never starts it on a larger size;
// - when Boat itself has seen the node fail the same file for a while (on
//   wakes, or on stops boat refused), it moves the sandbox to a new node, or
//   asks first when anything there could be lost (src/node-move.ts).
import type { ThreadRow } from "./activity.ts";
import { ACTIVE_STATES, type SandboxProvider, type StopReport } from "./providers/types.ts";
import { clockTime } from "./format.ts";
import type { TaskStore } from "./store.ts";
import { resizeRefused, tooLargeQuestion } from "./disk-trim.ts";
import { DISK_CHECK_SCRIPT, daemonRepairQuestion, diagnoseWakeFailure, parseDiskCheck, retriesLater, wakeFailureMessage, type DiskCheckRunner, type RetriedKind, type WakeDiagnosis } from "./wake-diagnosis.ts";
import { WakeDeferred, wakeIds, type WakePacer, type WakePermit, type WakeWait } from "./wake-pacer.ts";
import {
  brokenSnapshotQuestion,
  forcedOutcome,
  forkCheck,
  moveDecision,
  moveFacts,
  moveQuestion,
  movingMessage,
  parseHydratorFailure,
  refusalText,
  snapshotText,
  stopOutcome,
  stuckOnNode,
  trackHydrator,
  type ForkCheck,
  type HydratorTrack,
  type MoveBoat,
} from "./node-move.ts";

/** The first retry waits this long, doubling per failure in a row… */
export const RETRY_BASE_MS = 2 * 60_000;
/** …up to this (also how far apart resumes stay once Boat gave up). */
export const RETRY_MAX_MS = 30 * 60_000;
/** After this many failures in a row Boat stops retrying and asks the user. */
export const GIVE_UP_AFTER = 5;
/** A retry fired this recently isn't fired again (bb's resume reports back through the guard). */
const LEASE_MS = 10 * 60_000;
/** Plans untouched this long are dropped (the machine is gone, or woke some other way). */
const FORGET_AFTER_MS = 24 * 3_600_000;
/** A stop being followed is looked at this often (its status; never a new stop). */
export const STOP_POLL_MS = 30_000;
/** A stop still pending after this (the sandbox may be unreachable): forcing won't help, the user decides. */
export const STOP_WAIT_MS = 20 * 60_000;
/** A test fork that couldn't tell: tried again this much later, this many times, then the user decides. */
export const RECHECK_MS = 10 * 60_000;
export const FORK_TRIES = 2;
/** kv: the retry plans, by sandbox. */
export const WAKE_RETRIES_KEY = "wakeRetries";
/** kv: the hydrator failures Boat has seen, by sandbox (src/node-move.ts). */
export const NODE_TRACKS_KEY = "wakeNodeTracks";
/** Task event kind for a sandbox that didn't wake. */
export const WAKE_EVENT = "sandbox-wake";

/** The wait before Boat's retry after this many failures in a row: 2, 4, 8 … minutes, at most 30. */
export function retryDelayMs(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, Math.min(failures - 1, 20)));
}

/** Moving a sandbox off its node. */
export interface NodeMove {
  /**
   * due: the checks come next (the monitor's pass); stopping: a stop is
   * followed; moved; asked (under Needs you); failed.
   */
  state: "due" | "stopping" | "moved" | "asked" | "failed";
  /** When the move was planned (a pending stop is given up STOP_WAIT_MS after its start). */
  at: number;
  /** Wake it after (false: it came from a stop, it stays stopped). */
  resume: boolean;
  /** Not looked at again before this. */
  nextAt?: number;
  /** The stop being followed (boat's id for `boat stop --status`), and whether it's the forced one. */
  stopId?: string | null;
  forced?: boolean;
  stoppedAt?: number | null;
  /** A plain stop boat already answered (the provider's, before the move). */
  stop?: StopReport | null;
  /** When the sandbox was seen up after a stop boat said nothing more about. */
  sawUpAt?: number | null;
  /** Test forks that couldn't tell. */
  forkTries?: number;
  fork?: ForkCheck;
  snapshotAt?: string | null;
  /** The failure seen, for the message. */
  track?: HydratorTrack | null;
}

export interface WakeRetry {
  sandboxId: string;
  hostId: string | null;
  /** The last failure's kind; "paced": no failure, the wake waits for a slot. */
  kind: RetriedKind | "paced" | ByHandKind;
  /** Failed wakes in a row (waits for a slot don't count). */
  failures: number;
  /** Boat wakes it again then (null: it gave up, or it doesn't on its own). */
  retryAt: number | null;
  /** boat.dev's words for the last failure. */
  detail: string | null;
  lastAt: number;
  /** When Boat last fired its retry (bb's resume then reports back here). */
  firedAt: number | null;
  /** The Needs you item made for it (once a plan). */
  decisionId: string | null;
  move?: NodeMove | null;
}

/** Failures fixed by hand (Needs you once): Boat neither retries nor holds resumes. */
type ByHandKind = "daemon-broken" | "disk-too-large";
function byHand(kind: WakeRetry["kind"] | WakeDiagnosis["kind"]): kind is ByHandKind {
  return kind === "daemon-broken" || kind === "disk-too-large";
}

/** What the next failure leads to: Boat's retry later, or giving up. */
export function nextFailure(previous: WakeRetry | null, now: number): { failures: number; retryAt: number | null } {
  const failures = (previous?.failures ?? 0) + 1;
  return { failures, retryAt: failures >= GIVE_UP_AFTER ? null : now + retryDelayMs(failures) };
}

/** Boat is moving it: no resume until that's done. */
function moving(entry: WakeRetry | null): boolean {
  return entry?.move?.state === "due" || entry?.move?.state === "stopping";
}

/** No resume before this (null: go ahead). After giving up, resumes stay RETRY_MAX_MS apart. A fix by hand (a broken daemon, a sandbox too large) holds nothing. */
export function holdUntil(entry: WakeRetry | null): number | null {
  if (entry === null || byHand(entry.kind)) return null;
  return entry.retryAt ?? entry.lastAt + RETRY_MAX_MS;
}

export interface MachineWake {
  sandboxId: string;
  /** bb's machine (null: unknown, Boat can't fire its own retry). */
  hostId: string | null;
  signal: AbortSignal;
  report: { step(text: string): void; log(text: string): void };
}

export interface WakeGuard {
  readonly pacer: WakePacer;
  /**
   * One machine wake. `run` resumes the sandbox (taking a pacer slot through
   * `permit` only when it really wakes it) and restarts bb there. Throws an
   * Error with the plain-words message when it fails.
   */
  machine<T>(wake: MachineWake, run: (permit: () => Promise<WakePermit>) => Promise<T>): Promise<T>;
  /** One step of a move, or one due retry, when the pacer has a slot (the monitor's pass). Returns the sandbox, if any. */
  tick(): Promise<string | null>;
  /** Someone asked for this sandbox explicitly: its plan starts over. */
  forget(sandboxId: string): Promise<void>;
  /** The plan for a sandbox (null: none). */
  scheduled(sandboxId: string): Promise<WakeRetry | null>;
  /** The hydrator failure Boat has been seeing there (null: none). */
  track(sandboxId: string): Promise<HydratorTrack | null>;
  /**
   * boat didn't stop the sandbox (`stop`: what boat said of that stop). Once
   * Boat has seen its node fail the same file for a while, it moves it (the
   * checks first), or asks; returns whether it does. Otherwise the stop only
   * backs off.
   */
  stopRefused(sandboxId: string, hostId: string | null, stop?: StopReport | null, signal?: AbortSignal): Promise<boolean>;
  /** Resolves once the move steps started so far are done (tests). */
  idle(): Promise<void>;
  /** Boat is moving this sandbox (its move is due or its stop is followed): no work is sent there meanwhile. */
  moving(sandboxId: string): Promise<boolean>;
}

export interface WakeGuardDeps {
  pacer: WakePacer;
  kv: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };
  /** The sandbox provider (boat.dev; the key keeps its old name). */
  boat: Pick<SandboxProvider, "findInfo" | "exec"> & MoveBoat;
  store: Pick<TaskStore, "liveSandboxTasks" | "addEvent" | "addDecision" | "orchestrators">;
  /** The orchestrator chat that runs on this bb machine, if one does. */
  orchestratorOn?(hostId: string): Promise<string | null>;
  /** bb's chats on this machine (a move checks none is mid-turn; absent: unknown, so a move asks). */
  threadsOn?(hostId: string): Promise<ThreadRow[]>;
  /** Have bb resume this machine (its provider's resume runs, through the guard). */
  resumeHost?(hostId: string): Promise<unknown>;
  changed?(taskIds: string[]): void;
  log?(line: string): void;
  now?(): number;
  /** Move a sandbox off a node that keeps failing its disk (absent: never). forkCheck false: never forces on its own (it always asks). */
  moves?: { forkCheck?: boolean };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The diagnosis a failure carries itself (`wakeDiagnosis`), if any. */
function diagnosedBy(error: unknown): WakeDiagnosis | null {
  const given = error !== null && typeof error === "object" ? (error as { wakeDiagnosis?: unknown }).wakeDiagnosis : undefined;
  return given !== null && typeof given === "object" && typeof (given as WakeDiagnosis).kind === "string" ? (given as WakeDiagnosis) : null;
}

/** The progress line while a wake waits for its slot. */
export function waitStep(until: number, reason: WakeWait, now = Date.now()): string {
  return reason === "backoff"
    ? `Waiting until ${clockTime(until, now)}: a sandbox didn't wake just now, so Boat pauses wake-ups briefly`
    : `Waiting until ${clockTime(until, now)}: Boat wakes at most 2 sandboxes a minute`;
}

/** The message for a resume refused before Boat's own retry (or while it moves the sandbox). */
export function heldMessage(entry: WakeRetry, now: number): string {
  if (moving(entry)) return movingMessage(entry.move?.track, now);
  if (entry.move?.state === "asked") return `boat.dev keeps failing to restore this sandbox's disk on the node it runs on. Moving it to a new node could lose unsaved work, so it's under Needs you.`;
  if (entry.kind === "paced") return `Boat wakes at most 2 sandboxes a minute and others are waking now. Boat will wake this one at ${clockTime(entry.retryAt ?? now, now)}.`;
  const diagnosis: WakeDiagnosis = { kind: entry.kind, detail: entry.detail, checked: false };
  return entry.retryAt === null
    ? wakeFailureMessage(diagnosis, { retryAt: null, gaveUpAfter: entry.failures, resumeAfter: holdUntil(entry), sandboxId: entry.sandboxId, now }, "")
    : wakeFailureMessage(diagnosis, { retryAt: entry.retryAt, now }, "");
}

export function createWakeGuard(deps: WakeGuardDeps): WakeGuard {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  /** Retries fired, or moves under way, that haven't come back yet. */
  const firing = new Set<string>();
  /** Move steps running in the background. */
  const steps = new Set<Promise<void>>();

  /** A record of entries by sandbox, saved whole in kv. */
  function record<T extends { lastAt?: number; firstAt?: number }>(key: string) {
    let loaded: Promise<Record<string, T>> | null = null;
    let saving: Promise<void> = Promise.resolve();
    const load = () => {
      loaded ??= deps.kv.get<Record<string, T>>(key).then((raw) => (raw !== null && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {}), () => ({}));
      return loaded;
    };
    const save = async () => {
      const copy = { ...(await load()) };
      saving = saving.then(() => deps.kv.set(key, copy)).catch((error: unknown) => log(`wake retries: couldn't save ${key} (${errorText(error)})`));
      return saving;
    };
    return {
      load,
      save,
      async get(id: string): Promise<T | null> {
        return (await load())[id] ?? null;
      },
      async put(id: string, entry: T | null): Promise<void> {
        const all = await load();
        if (entry === null) delete all[id];
        else all[id] = entry;
        await save();
      },
    };
  }
  const plans = record<WakeRetry>(WAKE_RETRIES_KEY);
  const tracks = record<HydratorTrack>(NODE_TRACKS_KEY);
  const update = (sandboxId: string, entry: WakeRetry | null) => plans.put(sandboxId, entry);

  /** Look at the disk through boat's exec API, only while the sandbox runs (exec must never wake it). */
  function diskCheck(sandboxId: string, signal: AbortSignal): DiskCheckRunner {
    return async () => {
      const sandbox = await deps.boat.findInfo(sandboxId, signal);
      if (sandbox === null || !ACTIVE_STATES.has(sandbox.state)) return null;
      const result = await deps.boat.exec(sandboxId, DISK_CHECK_SCRIPT, { timeoutMs: 30_000, signal, login: false });
      return { stdout: result.stdout, stderr: result.stderr };
    };
  }

  /** One more look that saw this hydrator failure (null: it didn't). Returns the track. */
  async function observe(sandboxId: string, detail: string | null, at: number): Promise<HydratorTrack | null> {
    const failure = parseHydratorFailure(detail);
    if (failure === null) return tracks.get(sandboxId);
    const next = trackHydrator(await tracks.get(sandboxId), failure, at);
    await tracks.put(sandboxId, next);
    return next;
  }

  /** The text on every live task in the sandbox. */
  function tellTasks(sandboxId: string, text: string): void {
    const tasks = deps.store.liveSandboxTasks(sandboxId);
    for (const task of tasks) deps.store.addEvent(task.id, WAKE_EVENT, text);
    if (tasks.length > 0) deps.changed?.(tasks.map((task) => task.id));
  }

  /** Who hears of it: the tasks' orchestrator, the one on this machine, else the newest one. */
  async function orchestratorFor(sandboxId: string, hostId: string | null): Promise<{ threadId: string | null; taskIds: string[] }> {
    const tasks = deps.store.liveSandboxTasks(sandboxId);
    const taskIds = tasks.map((task) => task.id);
    const owner = tasks.find((task) => task.orchestratorThreadId !== null)?.orchestratorThreadId ?? null;
    if (owner !== null) return { threadId: owner, taskIds };
    const onMachine = hostId === null || deps.orchestratorOn === undefined ? null : await deps.orchestratorOn(hostId).catch(() => null);
    return { threadId: onMachine ?? deps.store.orchestrators()[0]?.threadId ?? null, taskIds };
  }

  /** A Needs you item for the orchestrator that should hear of this sandbox (null: there's none). */
  async function ask(entry: WakeRetry, fields: { question: string; recommendation: string; options: string[]; context: string; shortLabel: string }): Promise<string | null> {
    const { threadId, taskIds } = await orchestratorFor(entry.sandboxId, entry.hostId);
    if (threadId === null) {
      log(`wake retries: ${entry.sandboxId}: no orchestrator to ask: ${fields.question}`);
      return null;
    }
    const decision = deps.store.addDecision({ orchestratorThreadId: threadId, taskIds, ...fields });
    deps.changed?.(taskIds);
    return decision.id;
  }

  function needsYou(entry: WakeRetry, diagnosis: WakeDiagnosis): Promise<string | null> {
    const what =
      diagnosis.kind === "restore-rate-limited"
        ? "boat.dev refused to restore it (\"Please reduce your request rate\")"
        : diagnosis.kind === "ssh-session-stuck"
          ? "its SSH sessions never start (login scripts hang while boat.dev restores the disk)"
          : "boat.dev couldn't restore its disk";
    return ask(entry, {
      question: `Sandbox ${entry.sandboxId} didn't wake after ${entry.failures} tries: ${what}. Try again, or leave it stopped for now?`,
      recommendation: `Leave it until boat.dev has recovered, then resume it (\`bb boat sandbox resume ${entry.sandboxId}\`). If it still fails, report the error to boat.dev.`,
      options: ["Try again now", "Leave it for now"],
      context: `boat.dev said: ${diagnosis.detail ?? "(no details)"}`,
      shortLabel: "Sandbox won't wake",
    });
  }

  /** The move ends with the user deciding: no more automatic wakes or stops. */
  async function askMove(entry: WakeRetry, fields: Parameters<typeof ask>[1], taskText: string): Promise<void> {
    const decisionId = await ask(entry, fields);
    const at = now();
    await update(entry.sandboxId, { ...entry, move: { ...entry.move!, state: "asked", nextAt: undefined }, retryAt: null, lastAt: at, firedAt: null, decisionId: decisionId ?? entry.decisionId });
    tellTasks(entry.sandboxId, taskText);
  }

  /** Stopped: wake it on a new node (or, from a stop, leave it stopped). */
  async function moved(entry: WakeRetry, lost: boolean): Promise<void> {
    const at = now();
    const move = entry.move!;
    await tracks.put(entry.sandboxId, null);
    const stopped = lost
      ? `boat.dev couldn't take a fresh snapshot of this sandbox, so Boat stopped it keeping its last completed snapshot (${snapshotText(move.snapshotAt ?? null, at)}); files written after it, files git ignores included, aren't kept.`
      : "boat.dev stopped this sandbox with a fresh snapshot, so nothing was lost.";
    log(`node move: ${entry.sandboxId} stopped (${lost ? "forced" : "plain"})`);
    if (!move.resume) {
      await update(entry.sandboxId, null);
      tellTasks(entry.sandboxId, `${stopped} Its next wake starts it on a new boat.dev node.`);
      return;
    }
    // A new node gets a fresh start: Boat's retry resumes it at once.
    await update(entry.sandboxId, { ...entry, move: { ...move, state: "moved", nextAt: undefined }, failures: 0, retryAt: at, lastAt: at, firedAt: null });
    tellTasks(entry.sandboxId, `${stopped} Boat resumes it now on a new boat.dev node.${move.fork === "healthy" ? " A test fork had restored fine." : ""}`);
  }

  /** Follow a stop: stopped, force it once boat refused, wait while it's pending (never a new plain stop). */
  async function followStop(entry: WakeRetry, report: StopReport): Promise<void> {
    const move = entry.move!;
    const at = now();
    const state = (await deps.boat.findInfo(entry.sandboxId).catch(() => null))?.state ?? null;
    let outcome = move.forced === true ? forcedOutcome(report, state) : stopOutcome(report, state);
    // Up, and boat said nothing more of the stop: look once more before calling it refused.
    if (outcome === "refused" && move.forced !== true && !report.error && report.status === null && report.stopId === null) {
      if (move.sawUpAt == null || at - move.sawUpAt < STOP_POLL_MS) {
        await update(entry.sandboxId, { ...entry, move: { ...move, state: "stopping", sawUpAt: move.sawUpAt ?? at, nextAt: at + STOP_POLL_MS }, lastAt: at });
        return;
      }
    }
    if (outcome === "stopped") return moved(entry, move.forced === true);
    if (outcome === "refused" && move.forced !== true) {
      // boat refused the plain stop: now --force (keeps the last completed snapshot). The
      // stop may have been pending a while, with the sandbox up: look again that nothing
      // there would be lost now (a turn may have started meanwhile).
      const said = refusalText(report);
      const hostId = entry.hostId;
      const recheck = moveDecision(await moveFacts(deps.boat, entry.sandboxId, deps.store.liveSandboxTasks(entry.sandboxId), hostId !== null && deps.threadsOn ? () => deps.threadsOn!(hostId) : null));
      if (!recheck.auto) {
        const reasons = [...(said ? [`boat refused the plain stop (${said})`] : []), ...recheck.reasons];
        log(`node move: ${entry.sandboxId}: not forcing, ${recheck.reasons.join("; ")}`);
        return askMove(
          entry,
          moveQuestion({ sandboxId: entry.sandboxId, snapshotAt: move.snapshotAt ?? null, reasons, detail: entry.detail, fork: move.fork ?? "skipped", now: at }),
          `boat refused to stop this sandbox with a fresh snapshot${said ? ` (${said})` : ""}, and forcing it now could lose work: ${recheck.reasons.join("; ")}. It's under Needs you.`,
        );
      }
      let forced: StopReport;
      try {
        forced = await deps.boat.stop(entry.sandboxId, undefined, { force: true });
      } catch (error) {
        log(`node move: force stop ${entry.sandboxId}: ${errorText(error)}`);
        return askMove(entry, moveQuestion({ sandboxId: entry.sandboxId, snapshotAt: move.snapshotAt ?? null, reasons: [...(said ? [`boat refused the plain stop (${said})`] : []), `boat refused the forced stop too (${errorText(error).split("\n")[0]})`], detail: entry.detail, fork: move.fork ?? "skipped", now: at }), `Boat couldn't move this sandbox to a new boat.dev node: boat refused the forced stop (${errorText(error).split("\n")[0]}). It's under Needs you.`);
      }
      const after = (await deps.boat.findInfo(entry.sandboxId).catch(() => null))?.state ?? null;
      const next: WakeRetry = { ...entry, move: { ...move, state: "stopping", forced: true, stopId: forced.stopId ?? move.stopId ?? null, nextAt: at + STOP_POLL_MS }, lastAt: at };
      if (forcedOutcome(forced, after) === "stopped") return moved(next, true);
      await update(entry.sandboxId, next);
      return;
    }
    // Pending (or superseded): wait, then let the user decide; forcing a pending stop only hands it back.
    if (at - (move.stoppedAt ?? move.at) > STOP_WAIT_MS) {
      return askMove(
        entry,
        moveQuestion({ sandboxId: entry.sandboxId, snapshotAt: move.snapshotAt ?? null, reasons: [`boat's stop has been pending since ${clockTime(move.stoppedAt ?? move.at, at)} (the sandbox may be unreachable)`], detail: entry.detail, fork: move.fork ?? "skipped", now: at }),
        `boat's stop of this sandbox has been pending for ${Math.round((at - (move.stoppedAt ?? move.at)) / 60_000)} minutes, so Boat leaves the move to you. It's under Needs you.`,
      );
    }
    await update(entry.sandboxId, { ...entry, move: { ...move, state: "stopping", stopId: report.stopId ?? move.stopId ?? null, nextAt: at + STOP_POLL_MS }, lastAt: at });
  }

  /**
   * One step of a move (the monitor's pass, in the background). due: is
   * anything there at risk (tasks, chats, every checkout), and does the
   * snapshot read fine on another node; then a plain stop. stopping: follow it.
   */
  async function runMove(entry: WakeRetry): Promise<void> {
    const move = entry.move!;
    const id = entry.sandboxId;
    if (move.state === "stopping") {
      const report = move.stopId ? await deps.boat.stopStatus(id, move.stopId).catch((): StopReport => ({ status: null, stopId: move.stopId ?? null, forced: null })) : { status: null, stopId: null, forced: null };
      return followStop(entry, report);
    }
    const hostId = entry.hostId;
    const facts = await moveFacts(deps.boat, id, deps.store.liveSandboxTasks(id), hostId !== null && deps.threadsOn ? () => deps.threadsOn!(hostId) : null);
    const decision = moveDecision(facts);
    const fork: ForkCheck = deps.moves?.forkCheck === false ? "skipped" : await forkCheck(deps.boat, id, { pacer: deps.pacer, log });
    const snapshotAt = await deps.boat.lastSnapshotAt(id).catch(() => null);
    const at = now();
    const checked: WakeRetry = { ...entry, move: { ...move, fork, snapshotAt } };
    if (fork === "unreadable") {
      return askMove(checked, brokenSnapshotQuestion({ sandboxId: id, detail: entry.detail }), "boat.dev can't restore this sandbox's disk, on its node or on a new one (a test fork couldn't read its files either). It's under Needs you.");
    }
    const reasons = [...decision.reasons];
    if (fork !== "healthy") {
      // The snapshot isn't known to read fine: nothing is forced. A fork that couldn't tell is tried again, then the user decides.
      const tries = (move.forkTries ?? 0) + 1;
      if (fork === "unknown" && decision.auto && tries < FORK_TRIES) {
        log(`node move: ${id}: the test fork couldn't tell; again at ${clockTime(at + RECHECK_MS, at)}`);
        await update(id, { ...checked, move: { ...checked.move!, forkTries: tries, nextAt: at + RECHECK_MS }, lastAt: at });
        return;
      }
      reasons.push(fork === "skipped" ? "Boat doesn't check snapshots with a test fork here" : "Boat couldn't check the snapshot with a test fork");
    }
    if (reasons.length > 0) {
      return askMove(
        checked,
        moveQuestion({ sandboxId: id, snapshotAt, reasons, detail: entry.detail, fork, now: at }),
        `boat.dev keeps failing to restore this sandbox's disk on the node it runs on. Moving it could lose what changed since ${snapshotText(snapshotAt, at)}, and ${reasons.join("; ")}, so it's under Needs you.`,
      );
    }
    // Safe, and the snapshot reads fine elsewhere: a plain stop first (or follow the one boat already answered).
    let report: StopReport;
    if (move.stop) report = move.stop;
    else {
      try {
        report = await deps.boat.stop(id);
      } catch (error) {
        const said = errorText(error).split("\n")[0]!;
        // boat saying it can't snapshot it is a refusal; anything else isn't known to be one.
        if (/snapshot|hydrat|refus|can(?:no|')t stop/i.test(said)) report = { status: "failing", stopId: null, forced: null };
        else return askMove(checked, moveQuestion({ sandboxId: id, snapshotAt, reasons: [`boat's stop failed (${said})`], detail: entry.detail, fork, now: at }), `Boat couldn't stop this sandbox to move it (${said}). It's under Needs you.`);
      }
    }
    const stopping: WakeRetry = { ...checked, move: { ...checked.move!, state: "stopping", stopId: report.stopId, stoppedAt: at }, lastAt: at };
    return followStop(stopping, report);
  }

  /** Plan a move once Boat's own looks say the node is stuck. */
  function planMove(entry: WakeRetry | null, base: Omit<WakeRetry, "move">, track: HydratorTrack | null, resume: boolean, stop: StopReport | null, at: number): WakeRetry {
    return { ...base, retryAt: null, firedAt: null, decisionId: entry?.decisionId ?? base.decisionId, move: { state: "due", at, resume, stop, sawUpAt: stop !== null && stop.status === null && stop.stopId === null ? at : null, track } };
  }

  return {
    pacer: deps.pacer,

    async machine(wake, run) {
      const entry = await plans.get(wake.sandboxId);
      const hold = holdUntil(entry);
      // Before Boat's own retry (or while it moves the sandbox): boat.dev isn't asked again.
      if (entry !== null && ((hold !== null && hold > now()) || moving(entry))) throw new Error(heldMessage(entry, now()));
      let permit: WakePermit | null = null;
      const take = async () => {
        // A slot the watchdog or the paid resume claimed for this machine is this wake's (it counts once).
        permit ??= await deps.pacer.acquire({ signal: wake.signal, ids: wakeIds(wake), onWait: (until, reason) => wake.report.step(waitStep(until, reason, now())) });
        return permit;
      };
      try {
        const result = await run(take);
        await (permit as WakePermit | null)?.succeeded();
        firing.delete(wake.sandboxId);
        if (entry !== null) await update(wake.sandboxId, null);
        await tracks.put(wake.sandboxId, null);
        return result;
      } catch (error) {
        firing.delete(wake.sandboxId);
        if (wake.signal.aborted) throw error;
        const at = now();
        if (error instanceof WakeDeferred) {
          // Boat gave up on it: a wait for a slot doesn't start its retries again.
          if (entry !== null && entry.retryAt === null && !byHand(entry.kind)) throw new Error(heldMessage({ ...entry, kind: "paced", retryAt: error.retryAt }, at));
          // Too many wakes at once: Boat wakes this one itself when its turn comes.
          const next: WakeRetry = { ...(entry ?? { sandboxId: wake.sandboxId, kind: "paced", failures: 0, detail: null, decisionId: null }), hostId: wake.hostId ?? entry?.hostId ?? null, retryAt: error.retryAt, lastAt: at, firedAt: null };
          await update(wake.sandboxId, next);
          throw new Error(heldMessage({ ...next, kind: "paced" }, at));
        }
        // A failure can come already diagnosed (bb's own update hung there: src/bb-update.ts).
        const diagnosis = diagnosedBy(error) ?? (await diagnoseWakeFailure(error, diskCheck(wake.sandboxId, wake.signal)));
        const hostId = wake.hostId ?? entry?.hostId ?? null;
        // A resize boat refused onto the smaller size: the resize says so and rolls back (src/sandbox-size.ts).
        if (diagnosis.kind === "disk-too-large" && resizeRefused(error)) {
          if (entry !== null) await update(wake.sandboxId, null);
          throw error;
        }
        if (byHand(diagnosis.kind)) {
          // A fix by hand: Needs you once, no retries, nothing held. Too large: never a larger size on its own (it costs more);
          // without a size in boat's words, it was asked for its own (no resize here).
          const kind = diagnosis.kind;
          const next: WakeRetry = { sandboxId: wake.sandboxId, hostId, kind, failures: (entry?.failures ?? 0) + 1, retryAt: null, detail: diagnosis.detail, lastAt: at, firedAt: null, decisionId: entry?.kind === kind ? entry.decisionId : null };
          if (next.decisionId === null) {
            next.decisionId = await ask(
              next,
              kind === "daemon-broken"
                ? daemonRepairQuestion({ sandboxId: wake.sandboxId, detail: diagnosis.detail, daemon: diagnosis.daemon, hostId })
                : tooLargeQuestion({ sandboxId: wake.sandboxId, size: diagnosis.size ?? null, type: diagnosis.size?.type ?? (await deps.boat.findInfo(wake.sandboxId).catch(() => null))?.machineType ?? null }),
            );
          }
          await update(wake.sandboxId, next);
          const text = wakeFailureMessage(diagnosis, { retryAt: null, now: at }, errorText(error));
          tellTasks(wake.sandboxId, text);
          log(`wake ${wake.sandboxId}: ${kind}: ${diagnosis.detail ?? ""}`);
          throw new Error(text);
        }
        // Not boat.dev's restore any more: Boat's retry plan for it ends.
        if (!retriesLater(diagnosis.kind) && entry !== null) await update(wake.sandboxId, null);
        if (diagnosis.kind === "other") throw error;
        await (permit as WakePermit | null)?.failed();
        if (!retriesLater(diagnosis.kind)) {
          const text = wakeFailureMessage(diagnosis, { retryAt: null, now: at }, errorText(error));
          tellTasks(wake.sandboxId, text);
          log(`wake ${wake.sandboxId}: ${diagnosis.kind}${diagnosis.detail ? `: ${diagnosis.detail}` : ""}`);
          throw new Error(text);
        }
        const { failures, retryAt } = nextFailure(entry, at);
        const track = diagnosis.kind === "disk-restoring" ? await observe(wake.sandboxId, diagnosis.detail, at) : null;
        const base: WakeRetry = { sandboxId: wake.sandboxId, hostId, kind: diagnosis.kind, failures, retryAt, detail: diagnosis.detail, lastAt: at, firedAt: null, decisionId: entry?.decisionId ?? null, move: entry?.move ?? null };
        // Boat has seen the node fail the same file for a while: move it to a new one (once a plan).
        if (deps.moves !== undefined && diagnosis.kind === "disk-restoring" && !entry?.move && stuckOnNode(track, at)) {
          await update(wake.sandboxId, planMove(entry, base, track, true, null, at));
          const text = movingMessage(track, at);
          tellTasks(wake.sandboxId, text);
          log(`wake ${wake.sandboxId}: stuck on its node (${track?.object ?? "?"}, seen ${track?.seen ?? 0} times); moving it`);
          throw new Error(text);
        }
        if (retryAt === null && base.decisionId === null) base.decisionId = await needsYou(base, diagnosis);
        await update(wake.sandboxId, base);
        const text =
          retryAt === null
            ? wakeFailureMessage(diagnosis, { retryAt: null, gaveUpAfter: failures, resumeAfter: holdUntil(base), sandboxId: wake.sandboxId, now: at }, errorText(error))
            : wakeFailureMessage(diagnosis, { retryAt, now: at }, errorText(error));
        tellTasks(wake.sandboxId, text);
        log(`wake ${wake.sandboxId}: ${diagnosis.kind} (failure ${failures})${diagnosis.detail ? `: ${diagnosis.detail}` : ""}`);
        throw new Error(text);
      }
    },

    async tick() {
      const at = now();
      const all = await plans.load();
      let changed = false;
      for (const [sandboxId, entry] of Object.entries(all)) {
        if (at - entry.lastAt > FORGET_AFTER_MS) {
          delete all[sandboxId];
          changed = true;
        }
      }
      if (changed) await plans.save();
      const seen = await tracks.load();
      let stale = false;
      for (const [sandboxId, track] of Object.entries(seen)) {
        if (at - track.firstAt > FORGET_AFTER_MS) {
          delete seen[sandboxId];
          stale = true;
        }
      }
      if (stale) await tracks.save();
      // A move first (in the background: a test fork and a stop take a while), with a wake slot free.
      const step = deps.moves === undefined ? undefined : Object.values(all).find((entry) => moving(entry) && !firing.has(entry.sandboxId) && (entry.move?.nextAt ?? 0) <= at);
      if (step !== undefined) {
        // Against the time after the read: a free pacer answers with its own clock, later than `at` after the loads above.
        if (step.move!.state === "due" && (await deps.pacer.nextWakeAt()) > now()) return null;
        firing.add(step.sandboxId);
        log(`node move: ${step.sandboxId}: ${step.move!.state === "due" ? "checking before moving it off its node" : "following its stop"}`);
        const running: Promise<void> = runMove(step)
          .catch((error: unknown) => log(`node move: ${step.sandboxId}: ${errorText(error)}`))
          .finally(() => {
            firing.delete(step.sandboxId);
            steps.delete(running);
          });
        steps.add(running);
        return step.sandboxId;
      }
      if (deps.resumeHost === undefined) return null;
      const due = Object.values(all)
        .filter((entry) => entry.retryAt !== null && entry.retryAt <= at && entry.hostId !== null && !firing.has(entry.sandboxId) && (entry.firedAt === null || at - entry.firedAt >= LEASE_MS))
        .sort((a, b) => a.retryAt! - b.retryAt!);
      const first = due[0];
      // One a pass, and only with a wake slot free: the pacer would only make it wait (checked against the time now, as above).
      if (first === undefined || (await deps.pacer.nextWakeAt()) > now()) return null;
      all[first.sandboxId] = { ...first, firedAt: at };
      await plans.save();
      firing.add(first.sandboxId);
      log(`wake retries: resuming ${first.sandboxId} (${first.kind}, after ${first.failures} failure${first.failures === 1 ? "" : "s"})`);
      void deps.resumeHost(first.hostId!).then(
        () => firing.delete(first.sandboxId),
        async (error: unknown) => {
          firing.delete(first.sandboxId);
          log(`wake retries: resume ${first.sandboxId}: ${errorText(error)}`);
          // The machine is gone: nothing left to wake.
          if (/not[ _]?found|404|no such host|unknown host/i.test(errorText(error))) await update(first.sandboxId, null);
        },
      );
      return first.sandboxId;
    },

    async forget(sandboxId) {
      if ((await plans.get(sandboxId)) !== null) await update(sandboxId, null);
      if ((await tracks.get(sandboxId)) !== null) await tracks.put(sandboxId, null);
    },

    scheduled: (sandboxId) => plans.get(sandboxId),
    moving: async (sandboxId) => moving(await plans.get(sandboxId)),
    async idle() {
      await Promise.allSettled([...steps]);
    },
    track: (sandboxId) => tracks.get(sandboxId),

    async stopRefused(sandboxId, hostId, stop, signal) {
      if (deps.moves === undefined) return false;
      const entry = await plans.get(sandboxId);
      if (moving(entry)) return true;
      if (entry?.move) return false;
      let detail: string | null = null;
      try {
        const result = await diskCheck(sandboxId, signal ?? new AbortController().signal)();
        detail = result === null ? null : parseDiskCheck(result.stdout).hydrator;
      } catch (error) {
        log(`stop of ${sandboxId} refused; couldn't look at its disk: ${errorText(error)}`);
      }
      // Only a hydrator failure Boat has seen for a while moves it: a disk still restoring
      // normally ("hydration in progress", a read waiting on lazyfs) only backs the stop off.
      if (detail === null) return false;
      const at = now();
      const track = await observe(sandboxId, detail, at);
      if (!stuckOnNode(track, at)) return false;
      const base: WakeRetry = { sandboxId, hostId: hostId ?? entry?.hostId ?? null, kind: "disk-restoring", failures: entry?.failures ?? 0, retryAt: null, detail, lastAt: at, firedAt: null, decisionId: entry?.decisionId ?? null };
      await update(sandboxId, planMove(entry, base, track, false, stop ?? { status: null, stopId: null, forced: null }, at));
      log(`stop of ${sandboxId} refused, its node failing the same file (seen ${track?.seen ?? 0} times); moving it off its node`);
      return true;
    },
  };
}

/** No pacing, plans or diagnosis: the machine wakes as it always did (tests, and before the guard exists). */
export const directWakes: Pick<WakeGuard, "machine"> = {
  machine: (_wake, run) => run(async () => ({ succeeded: async () => undefined, failed: async () => undefined })),
};
