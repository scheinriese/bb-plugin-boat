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
// - when the node keeps failing the same file (or boat refuses a plain stop
//   of it), Boat moves the sandbox to a new node, or asks first when unsaved
//   work could be lost (src/node-move.ts).
import { ACTIVE_STATES, type BoatApi } from "./boat-api.ts";
import { clockTime } from "./format.ts";
import type { TaskStore } from "./store.ts";
import { DISK_CHECK_SCRIPT, diagnoseWakeFailure, parseDiskCheck, retriesLater, wakeFailureMessage, type DiskCheckRunner, type RetriedKind, type WakeDiagnosis } from "./wake-diagnosis.ts";
import { WakeDeferred, type WakePacer, type WakePermit, type WakeWait } from "./wake-pacer.ts";
import {
  brokenSnapshotQuestion,
  forkCheck,
  moveDecision,
  moveQuestion,
  movingMessage,
  parseHydratorFailure,
  snapshotText,
  stuckOnNode,
  taskFacts,
  trackHydrator,
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
/** kv: the retry plans, by sandbox. */
export const WAKE_RETRIES_KEY = "wakeRetries";
/** Task event kind for a sandbox that didn't wake. */
export const WAKE_EVENT = "sandbox-wake";

/** The wait before Boat's retry after this many failures in a row: 2, 4, 8 … minutes, at most 30. */
export function retryDelayMs(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, Math.min(failures - 1, 20)));
}

export interface WakeRetry {
  sandboxId: string;
  hostId: string | null;
  /** The last failure's kind; "paced": no failure, the wake waits for a slot. */
  kind: RetriedKind | "paced";
  /** Failed wakes in a row (waits for a slot don't count). */
  failures: number;
  /** Boat wakes it again then (null: it gave up). */
  retryAt: number | null;
  /** boat.dev's words for the last failure. */
  detail: string | null;
  lastAt: number;
  /** When Boat last fired its retry (bb's resume then reports back here). */
  firedAt: number | null;
  /** The Needs you item made when Boat gave up. */
  decisionId: string | null;
  /** The same hydrator failure across Boat's looks (src/node-move.ts). */
  hydrator?: HydratorTrack | null;
  /**
   * Moving it to a new node: due (the monitor's pass does it), moved, asked
   * (under Needs you) or failed. resume: wake it after (false: it was a stop).
   */
  move?: { state: "due" | "moved" | "asked" | "failed"; at: number; resume: boolean } | null;
}

/** What the next failure leads to: Boat's retry later, or giving up. */
export function nextFailure(previous: WakeRetry | null, now: number): { failures: number; retryAt: number | null } {
  const failures = (previous?.failures ?? 0) + 1;
  return { failures, retryAt: failures >= GIVE_UP_AFTER ? null : now + retryDelayMs(failures) };
}

/** No resume before this (null: go ahead). After giving up, resumes stay RETRY_MAX_MS apart. */
export function holdUntil(entry: WakeRetry | null): number | null {
  if (entry === null) return null;
  return entry.retryAt ?? entry.lastAt + RETRY_MAX_MS;
}

/** Boat is about to move it: no resume until that's done. */
function moveDue(entry: WakeRetry | null): boolean {
  return entry?.move?.state === "due";
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
  /** Fire one due retry, when the pacer has a slot (the monitor's pass). Returns the sandbox, if any. */
  tick(): Promise<string | null>;
  /** Someone asked for this sandbox explicitly: its plan starts over. */
  forget(sandboxId: string): Promise<void>;
  /** The plan for a sandbox (null: none). */
  scheduled(sandboxId: string): Promise<WakeRetry | null>;
  /**
   * boat didn't stop the sandbox (it can't snapshot a disk it hasn't finished
   * restoring). With disk trouble there, Boat moves it off its node, or asks
   * first; returns whether it does.
   */
  stopRefused(sandboxId: string, hostId: string | null, signal?: AbortSignal): Promise<boolean>;
}

export interface WakeGuardDeps {
  pacer: WakePacer;
  kv: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };
  boat: Pick<BoatApi, "findInfo" | "exec"> & MoveBoat;
  store: Pick<TaskStore, "liveSandboxTasks" | "addEvent" | "addDecision" | "orchestrators">;
  /** The orchestrator chat that runs on this bb machine, if one does. */
  orchestratorOn?(hostId: string): Promise<string | null>;
  /** Have bb resume this machine (its provider's resume runs, through the guard). */
  resumeHost?(hostId: string): Promise<unknown>;
  changed?(taskIds: string[]): void;
  log?(line: string): void;
  now?(): number;
  /** Move a sandbox off a node that keeps failing its disk (absent: never); forkCheck: confirm the snapshot first (default on). */
  moves?: { forkCheck?: boolean };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The progress line while a wake waits for its slot. */
export function waitStep(until: number, reason: WakeWait, now = Date.now()): string {
  return reason === "backoff"
    ? `Waiting until ${clockTime(until, now)}: a sandbox didn't wake just now, so Boat pauses wake-ups briefly`
    : `Waiting until ${clockTime(until, now)}: Boat wakes at most 2 sandboxes a minute`;
}

/** The message for a resume refused before Boat's own retry. */
export function heldMessage(entry: WakeRetry, now: number): string {
  if (moveDue(entry)) return movingMessage(entry.hydrator, now);
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
  let plans: Promise<Record<string, WakeRetry>> | null = null;
  let saving: Promise<void> = Promise.resolve();
  /** Retries fired whose resume hasn't come back yet. */
  const firing = new Set<string>();

  function load(): Promise<Record<string, WakeRetry>> {
    plans ??= deps.kv.get<Record<string, WakeRetry>>(WAKE_RETRIES_KEY).then(
      (raw) => (raw !== null && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {}),
      () => ({}),
    );
    return plans;
  }

  async function save(): Promise<void> {
    const copy = { ...(await load()) };
    saving = saving.then(() => deps.kv.set(WAKE_RETRIES_KEY, copy)).catch((error: unknown) => log(`wake retries: couldn't save (${errorText(error)})`));
    return saving;
  }

  async function update(sandboxId: string, entry: WakeRetry | null): Promise<void> {
    const all = await load();
    if (entry === null) delete all[sandboxId];
    else all[sandboxId] = entry;
    await save();
  }

  /** Look at the disk through boat's exec API, only while the sandbox runs (exec must never wake it). */
  function diskCheck(sandboxId: string, signal: AbortSignal): DiskCheckRunner {
    return async () => {
      const sandbox = await deps.boat.findInfo(sandboxId, signal);
      if (sandbox === null || !ACTIVE_STATES.has(sandbox.state)) return null;
      const result = await deps.boat.exec(sandboxId, DISK_CHECK_SCRIPT, { timeoutMs: 30_000, signal, login: false });
      return { stdout: result.stdout, stderr: result.stderr };
    };
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

  /**
   * Move it off its node (the monitor's pass, in the background): check the
   * tasks there and the snapshot, then force-stop it (Boat's own retry then
   * resumes it on a new node), or ask first.
   */
  async function runMove(entry: WakeRetry): Promise<void> {
    const signal = undefined;
    const tasks = deps.store.liveSandboxTasks(entry.sandboxId);
    const decision = moveDecision(await taskFacts(deps.boat, entry.sandboxId, tasks, signal));
    const fork = deps.moves?.forkCheck === false ? "skipped" : await forkCheck(deps.boat, entry.sandboxId, { pacer: deps.pacer, log });
    const snapshotAt = await deps.boat.lastSnapshotAt(entry.sandboxId, signal).catch(() => null);
    const at = now();
    const stays = (state: "asked" | "failed", decisionId: string | null, retryAt: number | null): WakeRetry => ({ ...entry, move: { state, at, resume: entry.move?.resume ?? true }, retryAt, lastAt: at, firedAt: null, decisionId: decisionId ?? entry.decisionId });
    if (fork === "unreadable") {
      const decisionId = await ask(entry, brokenSnapshotQuestion({ sandboxId: entry.sandboxId, detail: entry.detail }));
      await update(entry.sandboxId, stays("asked", decisionId, null));
      tellTasks(entry.sandboxId, "boat.dev can't restore this sandbox's disk, on its node or on a new one (a test fork couldn't read its files either). It's under Needs you.");
      return;
    }
    if (!decision.auto) {
      const decisionId = await ask(entry, moveQuestion({ sandboxId: entry.sandboxId, snapshotAt, reasons: decision.reasons, detail: entry.detail, fork, now: at }));
      await update(entry.sandboxId, stays("asked", decisionId, null));
      tellTasks(entry.sandboxId, `boat.dev keeps failing to restore this sandbox's disk on the node it runs on. Moving it to a new node would lose what changed since ${snapshotText(snapshotAt, at)}, and ${decision.reasons.join("; ")}, so it's under Needs you.`);
      return;
    }
    try {
      await deps.boat.stop(entry.sandboxId, signal, { force: true });
    } catch (error) {
      log(`node move: force stop ${entry.sandboxId}: ${errorText(error)}`);
      await update(entry.sandboxId, stays("failed", null, entry.move?.resume === false ? null : at + retryDelayMs(Math.max(1, entry.failures))));
      tellTasks(entry.sandboxId, `Boat couldn't move this sandbox to a new boat.dev node: boat refused the forced stop (${errorText(error).split("\n")[0]}).`);
      return;
    }
    log(`node move: force-stopped ${entry.sandboxId} (snapshot ${snapshotAt ?? "unknown"}, test fork ${fork})`);
    if (entry.move?.resume === false) {
      // It was a stop: it's stopped now; its next wake lands on a new node.
      await update(entry.sandboxId, null);
      tellTasks(entry.sandboxId, `boat couldn't snapshot this sandbox's disk, so Boat stopped it keeping its last completed snapshot (${snapshotText(snapshotAt, at)}). Its next wake starts it on a new boat.dev node.`);
      return;
    }
    // A new node gets a fresh start: Boat's retry resumes it at once.
    await update(entry.sandboxId, { ...entry, move: { state: "moved", at, resume: true }, hydrator: null, failures: 0, retryAt: at, lastAt: at, firedAt: null });
    tellTasks(entry.sandboxId, `Boat moved this sandbox to a new boat.dev node: it stopped it keeping its last completed snapshot (${snapshotText(snapshotAt, at)}) and resumes it now.${fork === "healthy" ? " A test fork had restored fine." : ""}`);
  }

  return {
    pacer: deps.pacer,

    async machine(wake, run) {
      const entry = (await load())[wake.sandboxId] ?? null;
      const hold = holdUntil(entry);
      // Before Boat's own retry (or while it moves the sandbox): boat.dev isn't asked again.
      if (entry !== null && ((hold !== null && hold > now()) || moveDue(entry))) throw new Error(heldMessage(entry, now()));
      let permit: WakePermit | null = null;
      const take = async () => {
        permit ??= await deps.pacer.acquire({ signal: wake.signal, onWait: (until, reason) => wake.report.step(waitStep(until, reason, now())) });
        return permit;
      };
      try {
        const result = await run(take);
        await (permit as WakePermit | null)?.succeeded();
        firing.delete(wake.sandboxId);
        if (entry !== null) await update(wake.sandboxId, null);
        return result;
      } catch (error) {
        firing.delete(wake.sandboxId);
        if (wake.signal.aborted) throw error;
        const at = now();
        if (error instanceof WakeDeferred) {
          // Boat gave up on it: a wait for a slot doesn't start its retries again.
          if (entry !== null && entry.retryAt === null) throw new Error(heldMessage({ ...entry, kind: "paced", retryAt: error.retryAt }, at));
          // Too many wakes at once: Boat wakes this one itself when its turn comes.
          const next: WakeRetry = { ...(entry ?? { sandboxId: wake.sandboxId, kind: "paced", failures: 0, detail: null, decisionId: null }), hostId: wake.hostId ?? entry?.hostId ?? null, retryAt: error.retryAt, lastAt: at, firedAt: null };
          await update(wake.sandboxId, next);
          throw new Error(heldMessage({ ...next, kind: "paced" }, at));
        }
        const diagnosis = await diagnoseWakeFailure(error, diskCheck(wake.sandboxId, wake.signal));
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
        const failure = parseHydratorFailure(diagnosis.detail);
        const hydrator = failure === null ? (entry?.hydrator ?? null) : trackHydrator(entry?.hydrator, failure, at);
        // The node keeps failing the same file: move it to a new one (once a plan).
        if (deps.moves !== undefined && diagnosis.kind === "disk-restoring" && !entry?.move && stuckOnNode(hydrator, at)) {
          const moving: WakeRetry = { sandboxId: wake.sandboxId, hostId: wake.hostId ?? entry?.hostId ?? null, kind: "disk-restoring", failures, retryAt: null, detail: diagnosis.detail, lastAt: at, firedAt: null, decisionId: entry?.decisionId ?? null, hydrator, move: { state: "due", at, resume: true } };
          await update(wake.sandboxId, moving);
          const text = movingMessage(hydrator, at);
          tellTasks(wake.sandboxId, text);
          log(`wake ${wake.sandboxId}: stuck on its node (${hydrator?.object ?? "?"}, ${hydrator?.attempts ?? 0} attempts); moving it`);
          throw new Error(text);
        }
        const next: WakeRetry = {
          sandboxId: wake.sandboxId,
          hostId: wake.hostId ?? entry?.hostId ?? null,
          kind: diagnosis.kind,
          failures,
          retryAt,
          detail: diagnosis.detail,
          lastAt: at,
          firedAt: null,
          decisionId: entry?.decisionId ?? null,
          hydrator,
          move: entry?.move ?? null,
        };
        if (retryAt === null && next.decisionId === null) next.decisionId = await needsYou(next, diagnosis);
        await update(wake.sandboxId, next);
        const text =
          retryAt === null
            ? wakeFailureMessage(diagnosis, { retryAt: null, gaveUpAfter: failures, resumeAfter: holdUntil(next), sandboxId: wake.sandboxId, now: at }, errorText(error))
            : wakeFailureMessage(diagnosis, { retryAt, now: at }, errorText(error));
        tellTasks(wake.sandboxId, text);
        log(`wake ${wake.sandboxId}: ${diagnosis.kind} (failure ${failures})${diagnosis.detail ? `: ${diagnosis.detail}` : ""}`);
        throw new Error(text);
      }
    },

    async tick() {
      const at = now();
      const all = await load();
      let changed = false;
      for (const [sandboxId, entry] of Object.entries(all)) {
        if (at - entry.lastAt > FORGET_AFTER_MS) {
          delete all[sandboxId];
          changed = true;
        }
      }
      if (changed) await save();
      // A move first (in the background: a test fork and a forced stop take a while), with a wake slot free.
      const moving = deps.moves === undefined ? undefined : Object.values(all).find((entry) => moveDue(entry) && !firing.has(entry.sandboxId));
      if (moving !== undefined) {
        if ((await deps.pacer.nextWakeAt()) > at) return null;
        firing.add(moving.sandboxId);
        log(`node move: moving ${moving.sandboxId} off its node`);
        void runMove(moving)
          .catch((error: unknown) => log(`node move: ${moving.sandboxId}: ${errorText(error)}`))
          .finally(() => firing.delete(moving.sandboxId));
        return moving.sandboxId;
      }
      if (deps.resumeHost === undefined) return null;
      const due = Object.values(all)
        .filter((entry) => entry.retryAt !== null && entry.retryAt <= at && entry.hostId !== null && !firing.has(entry.sandboxId) && (entry.firedAt === null || at - entry.firedAt >= LEASE_MS))
        .sort((a, b) => a.retryAt! - b.retryAt!);
      const first = due[0];
      // One a pass, and only with a wake slot free: the pacer would only make it wait.
      if (first === undefined || (await deps.pacer.nextWakeAt()) > at) return null;
      all[first.sandboxId] = { ...first, firedAt: at };
      await save();
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
      if ((await load())[sandboxId] === undefined) return;
      await update(sandboxId, null);
    },

    async scheduled(sandboxId) {
      return (await load())[sandboxId] ?? null;
    },

    async stopRefused(sandboxId, hostId, signal) {
      if (deps.moves === undefined) return false;
      const entry = (await load())[sandboxId] ?? null;
      if (moveDue(entry)) return true;
      if (entry?.move) return false;
      let seen: ReturnType<typeof parseDiskCheck> | null = null;
      try {
        const result = await diskCheck(sandboxId, signal ?? new AbortController().signal)();
        seen = result === null ? null : parseDiskCheck(result.stdout);
      } catch (error) {
        log(`stop of ${sandboxId} refused; couldn't look at its disk: ${errorText(error)}`);
      }
      const trouble = seen !== null && (seen.hydrator !== null || seen.unreadable.length > 0 || seen.fuseBlocked.length > 0 || seen.hydrating !== null);
      if (!trouble) return false;
      const at = now();
      const detail = seen!.hydrator ?? seen!.hydrating ?? entry?.detail ?? null;
      const failure = parseHydratorFailure(detail);
      await update(sandboxId, {
        sandboxId,
        hostId: hostId ?? entry?.hostId ?? null,
        kind: "disk-restoring",
        failures: entry?.failures ?? 0,
        retryAt: null,
        detail,
        lastAt: at,
        firedAt: null,
        decisionId: entry?.decisionId ?? null,
        hydrator: failure === null ? (entry?.hydrator ?? null) : trackHydrator(entry?.hydrator, failure, at),
        move: { state: "due", at, resume: false },
      });
      log(`stop of ${sandboxId} refused with its disk not restored; moving it off its node`);
      return true;
    },
  };
}

/** No pacing, plans or diagnosis: the machine wakes as it always did (tests, and before the guard exists). */
export const directWakes: Pick<WakeGuard, "machine"> = {
  machine: (_wake, run) => run(async () => ({ succeeded: async () => undefined, failed: async () => undefined })),
};
