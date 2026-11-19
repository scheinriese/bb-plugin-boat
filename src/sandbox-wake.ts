// `bb boat sandbox wake <sandbox | chat | task id>`: bring a stuck boat
// sandbox, and the chat on it, back in one go.
//
// boat.dev confirmed the cause of the 18–19 Nov incident: from 18 Nov 15:09
// UTC one of its storage locations refused almost all reads, so sandboxes
// resumed from a snapshot came up without all their files (hung commands,
// hydration under 100%, failed starts). Since 19 Nov 00:40 UTC boat.dev
// copies the affected files to a healthy location; older stopped sandboxes
// may still resume slowly. Its advice for a stuck sandbox: stop it and start
// it again. That's the first remedy here, before anything else.
//
// The sequence that worked by hand, composed from the existing modules:
// 1. resolve the id: a chat → its workspace → its bb machine → the sandbox;
//    a task → its sandbox;
// 2. stopped: resume it, with a slot from the wake pacer (src/wake-pacer.ts),
//    within boat's start limit (a paid extra start only with --allow-paid-start);
// 3. wait until boat's exec answers;
// 4. diagnose (src/wake-diagnosis.ts, src/bb-update.ts): the disk restoring
//    or failing, an SSH login that hangs, bb's daemon broken or old, an npm
//    zombie. A read waiting on the disk is waited for first;
// 5. the disk unreadable, reads still stuck after that wait, or an npm
//    zombie: stop it and start it again. A plain stop first (a fresh
//    snapshot), followed by its status and never by a second stop; --force
//    only when nothing there could be lost and a test fork from the same
//    snapshot reads fine on another node (src/node-move.ts, as PR #12's move);
//    otherwise the facts and the exact commands. Never under a running turn;
// 6. login message scripts off (src/login-scripts.ts);
// 7. bb older than the server, or broken: the safe update (src/bb-update.ts),
//    only on a machine that's neither connected nor suspended (bb's own
//    machine resume does the same update); without a download of the
//    server's version there, from the npm registry;
// 8. a suspended machine: only `bb machine resume` (the provider's resume
//    turns the login scripts off, updates bb and restarts it); a disconnected
//    one: bb's service restarted. Then wait until it connects;
// 9. the chat: send its pending provider retry now, retry its failed turn, or
//    leave it when its queue is already sending.
//
// One wake per sandbox at a time (in this plugin load, and a kv marker with a
// heartbeat across loads). A wake runs in the plugin's process, not under the
// caller's request: the CLI and the tool wait up to 90 seconds, then report
// what it did so far; `--status` shows it, and the chat that asked hears when
// it ends. Each run is bounded (about 25 minutes): no stop goes out without time
// left to start it again, and once a stop went out the start always follows.
// A run cut off between them (a reload) leaves a marker, and the monitor's
// pass starts the sandbox again.
//
// Nothing here kills processes by pattern (`pkill -f` can match its own
// command line). --dry-run only looks and prints the plan. A stop for safety
// ends with "Needs you" and the commands to run.
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isOpen, turnRuns, type ThreadRow } from "./activity.ts";
import { ACTIVE_STATES, type BoatApi, type Limits, type Sandbox, type StopReport } from "./boat-api.ts";
import { BbUpdateHung, compareVersions, decideBbUpdate, inspectScript, isVersion, parseInspection, type BbInstall, type BbUpdatePlan, type HostPrep, type HostPrepResult } from "./bb-update.ts";
import type { MachineState } from "./chat.ts";
import { clockTime } from "./format.ts";
import type { QuietLogin } from "./login-scripts.ts";
import { forcedOutcome, forkCheck, moveDecision, moveFacts, refusalText, snapshotText, stopOutcome } from "./node-move.ts";
import { UNKNOWN, nothingSent, readStoppedTurn, type ResumeThreads } from "./paid-resume.ts";
import { isBusy } from "./relay.ts";
import { TRANSITIONAL_STATES, TaskError, resumable } from "./service.ts";
import type { Task } from "./store.ts";
import { DISK_CHECK_SCRIPT, classifyDiskCheck, cleanDetail, daemonRepairQuestion, parseDiskCheck, storageFailing, type DiskCheck, type WakeDiagnosis } from "./wake-diagnosis.ts";
import { WAKE_BACKOFF_MAX_MS, WAKE_WINDOW_MS, WakeDeferred, type WakePacer, type WakePermit } from "./wake-pacer.ts";
import { waitStep, type WakeGuard } from "./wake-retry.ts";

/** boat's exec must answer within this after a resume… */
export const EXEC_WAIT_MS = 3 * 60_000;
/** …asked this often (also how often a machine's connection is looked at). */
export const POLL_MS = 10_000;
/** A sandbox starting or stopping on its own: waited for this long. */
export const TRANSITION_WAIT_MS = 2 * 60_000;
/** A disk still restoring (hydrating, or a read waiting on it): looked at again for this long. */
export const DISK_WAIT_MS = 2 * 60_000;
/** A stop is followed (its status, never a second stop) for this long… */
export const STOP_WAIT_MS = 5 * 60_000;
/** …this often. */
export const STOP_POLL_MS = 10_000;
/** bb's machine must connect within this after its service restarts. */
export const CONNECT_WAIT_MS = 3 * 60_000;
/** A whole wake, at most: waits are cut to fit, except finishing a start it began (the start after a stop, and the wait for exec after it). */
export const WAKE_MAX_MS = 25 * 60_000;
/** No stop (or test fork) goes out with less than this left: a stop's follow, a test fork, a forced stop and the start. */
export const RESTART_BUDGET_MS = 15 * 60_000;
/** The CLI and the tool wait this long for a wake, then report what it did so far (as `bb boat task start` does). */
export const FOREGROUND_WAIT_MS = 90_000;
/** After a stop, the start waits this long for a wake slot at most (the pacer's longest pause, and a window). */
export const RESTART_SLOT_WAIT_MS = WAKE_BACKOFF_MAX_MS + WAKE_WINDOW_MS;
/** A wake's kv marker is refreshed this often… */
export const HEARTBEAT_MS = 30_000;
/** …and one not refreshed for this long belongs to a run that's gone. */
export const STALE_MS = 3 * 60_000;
/** A sandbox a cut-off wake left stopped: started again at most this often. */
export const RECOVER_RETRY_MS = 5 * 60_000;
/** A sandbox a cut-off wake left stopped is started again on its own for this long; after that, a note on its tasks instead. */
export const RESTART_TTL_MS = 24 * 3_600_000;
/** Finished wakes are kept this long (for --status). */
export const MARKER_TTL_MS = 24 * 3_600_000;
/** kv: the wakes, by sandbox. */
export const WAKE_MARKERS_KEY = "sandboxWakes";
/** Shown on the retried turn (bb shows the reason verbatim). */
export const WAKE_RETRY_REASON = "Its machine is back: retried by bb boat sandbox wake";
/** The native add-ons bb's installer lets npm build (as src/bb-update.ts). */
const ALLOW_SCRIPTS = "better-sqlite3,node-pty,@parcel/watcher";

export type WakeTargetKind = "sandbox" | "task" | "thread";

export interface WakeTarget {
  kind: WakeTargetKind;
  /** The id as given. */
  input: string;
  sandboxId: string;
  /** bb's machine on the sandbox (null: none, bb doesn't know one, or the lookup failed: see hostLookupFailed). */
  hostId: string | null;
  /** Boat couldn't look bb's machine up (why): there may be one, with chats running. null: the lookup worked. */
  hostLookupFailed: string | null;
  /** The chats to retry once it's back. */
  threadIds: string[];
  /** The open tasks on the sandbox. */
  taskIds: string[];
  /** How the id led to the sandbox ("chat thr_a", "workspace env_1", "bb machine host_1", "sandbox bx_1"). */
  path: string[];
}

export type WakeStepId = "resolve" | "sandbox" | "start-limit" | "resume" | "exec" | "diagnose" | "restart" | "login-scripts" | "bb-update" | "bb-service" | "machine" | "chat";
/** info: a note (a wait, a finding); planned: what --dry-run would do. */
export type WakeStepStatus = "done" | "skipped" | "planned" | "failed" | "info" | "needs-you";

export interface WakeStep {
  step: WakeStepId;
  status: WakeStepStatus;
  text: string;
  /** When it happened (epoch ms). */
  at?: number;
}

/** The problem a look found, and the action it leads to. */
export type WakeProblem = "exec-unreachable" | "disk-unreadable" | "disk-stuck" | "npm-zombie" | "disk-restoring" | "ssh-login-hang" | "bb-broken" | "bb-old" | "none";
export type WakeAction = "stop-and-start" | "wait-for-disk" | "login-scripts" | "bb-update" | "none";

export interface BbLook {
  seen: BbInstall;
  plan: BbUpdatePlan;
  /** The bb version the server installs (null: unknown). */
  target: string | null;
}

/** What one look at the sandbox saw. */
export interface WakeFindings {
  /** boat's exec never answered: what it said last (null: it answered). */
  execFailed: string | null;
  /** The existing classification (kind "other": nothing wrong seen; null: no look). */
  diagnosis: WakeDiagnosis | null;
  disk: DiskCheck | null;
  /** bb's install (null: not looked at, or not readable). */
  bb: BbLook | null;
}

export interface WakeRoute {
  problem: WakeProblem;
  action: WakeAction;
  /** In plain words, for the output. */
  why: string;
}

export interface WakeReport {
  target: WakeTarget;
  dryRun: boolean;
  /**
   * awake: it's back; planned: a dry run's plan; needs-you: stopped (for
   * safety, or nothing more it can do now); running: it goes on (`--status`).
   */
  outcome: "awake" | "planned" | "needs-you" | "running";
  /** The last look's problem and action (null: no look, e.g. a stopped sandbox in a dry run). */
  route: WakeRoute | null;
  findings: WakeFindings | null;
  steps: WakeStep[];
  needsYou: { reason: string; commands: string[]; retryAt: number | null } | null;
  startedAt: number;
  finishedAt: number | null;
  /** running: the chat that gets a message when it ends (null: none). */
  tellsThreadId?: string | null;
}

export interface WakeRequest {
  /** A sandbox id (bx_…), a task id (t_…) or a chat's thread id. */
  target: string;
  dryRun?: boolean;
  /** The user agreed to a paid extra start if no included start is left. */
  allowPaidStart?: boolean;
  /** Wake it although its tasks are cancelled or closed (the user asked; their chats are still never retried). */
  forceWake?: boolean;
  /** A dry run's signal (a wake itself runs under the plugin's lifecycle, not the caller's request). */
  signal?: AbortSignal;
}

export interface WakeCall extends WakeRequest {
  /** Wait this long for the wake, then report it as running (default FOREGROUND_WAIT_MS). */
  waitMs?: number;
  /** The chat that asked: it hears when a wake outlives the wait. */
  threadId?: string | null;
}

/** A wake in kv: who runs it, a restart's stop that's out, and the finished report. */
export interface WakeMarker {
  /** The plugin load that runs it. */
  instance: string;
  startedAt: number;
  heartbeatAt: number;
  /** A stop went out and its start hasn't come back: the sandbox may be stopped with no resume under way. */
  restart: { at: number; paidStart: boolean; triedAt: number | null } | null;
  /** The finished report (null: it runs). */
  report: WakeReport | null;
}

type Kv = { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };

export interface SandboxWakeDeps {
  boat: Pick<BoatApi, "findInfo" | "exec" | "stop" | "stopStatus" | "limits" | "lastSnapshotAt" | "fork" | "delete">;
  /** Resume it within the slot limit with this wake slot (BoatService.bringUp). */
  bringUp(sandboxId: string, signal: AbortSignal, wake: { permit: WakePermit; paidStart: boolean }): Promise<unknown>;
  pacer: WakePacer;
  /** Boat's own wake retries and node moves (src/wake-retry.ts). */
  guard?: Pick<WakeGuard, "forget" | "moving">;
  /** Login message scripts off (src/login-scripts.ts). */
  quietLogins(sandboxId: string, signal?: AbortSignal): Promise<QuietLogin>;
  /** The safe bb update (src/bb-update.ts createBbUpdater). */
  updateBb: ((prep: HostPrep) => Promise<HostPrepResult>) & { forget?(sandboxId: string): Promise<void> };
  /** The bb version the server installs on its machines (null: unknown). */
  serverVersion(): Promise<string | null>;
  tasks: {
    /** A task by id or prefix (null: none). */
    resolve(idOrPrefix: string): Task | null;
    liveSandboxTasks(sandboxId: string): Task[];
    /** Every task that ran in the sandbox, closed ones included. */
    sandboxTasks(sandboxId: string): Task[];
    /** The Boat task a chat belongs to (the plugin's records, else the chat's metadata), whatever its state; null: none. */
    forThread(threadId: string): Promise<Task | null>;
    /** bb's machine on a sandbox, from the plugin's tasks (null: none known). */
    hostForSandbox?(sandboxId: string): string | null;
  };
  threads: Pick<ResumeThreads, "get" | "stopEvents" | "queued" | "sendQueued" | "retry"> & {
    /**
     * Cancel a pending provider retry (`bb provider-retry cancel`): its queued
     * row is withdrawn, confirmed by bb's queue ("stuck": it's still there).
     */
    cancelRetry(threadId: string, queuedMessageId: string): Promise<"removed" | "stuck">;
  };
  machines: {
    /** The bb machine a workspace is on (null: none). */
    hostOf(environmentId: string): Promise<string | null>;
    /** The boat sandbox under a bb machine (null: it isn't a Boat sandbox machine). */
    sandboxOf(hostId: string): Promise<string | null>;
    /** The bb machine on a sandbox (null: none). Throws when bb's machines couldn't all be read. */
    hostFor(sandboxId: string): Promise<string | null>;
    /** bb's record of a machine (null: bb doesn't know it; throws: couldn't read it). */
    host(hostId: string): Promise<MachineState | null>;
    /** `bb machine resume` (bb runs the provider's resume). */
    resume(hostId: string): Promise<unknown>;
    threadsOn(hostId: string): Promise<ThreadRow[]>;
  };
  /** The wakes' markers (absent: kept in memory only). */
  kv?: Kv;
  /** The plugin's lifetime: a wake runs under it, not under the caller's request. */
  lifecycle?: AbortSignal;
  /** Tell a chat (the one that asked, when a wake outlives its wait). */
  notify?(threadId: string, text: string): Promise<void>;
  /** Tell the sandbox's tasks (a sandbox a cut-off wake left stopped); closedToo: every task that ran there, closed ones included. */
  tell?(sandboxId: string, text: string, options?: { closedToo?: boolean }): void;
  now?(): number;
  sleep?(ms: number, signal?: AbortSignal): Promise<unknown>;
  log?(line: string): void;
  /** Tests: shorter waits. */
  timing?: Partial<{
    execWaitMs: number;
    pollMs: number;
    transitionWaitMs: number;
    diskWaitMs: number;
    stopWaitMs: number;
    stopPollMs: number;
    connectWaitMs: number;
    maxMs: number;
    restartBudgetMs: number;
    heartbeatMs: number;
  }>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(error: unknown): string {
  return cleanDetail(errorText(error).split("\n")[0] ?? "", 200);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** "/home/user/.bb-machines/acme" → "~/.bb-machines/acme". */
function shortHome(path: string): string {
  return path.replace(/^\/home\/[^/]+\//, "~/").replace(/^\/root\//, "~/");
}

function clip(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function minutes(ms: number): string {
  const count = Math.max(1, Math.round(ms / 60_000));
  return `${count} minute${count === 1 ? "" : "s"}`;
}

/** A Boat task that's over: cancelled, or closed as done. Its chats are never retried or woken for. */
function closed(task: Pick<Task, "status">): boolean {
  return task.status === "cancelled" || task.status === "done";
}

function closedText(task: Pick<Task, "id" | "status">): string {
  return `${task.id} ${task.status === "cancelled" ? "cancelled" : "closed"}`;
}

const EIO = /Input\/output error|\bEIO\b/i;
const DISK_WORDS = /Input\/output error|\bEIO\b|HYDRATOR FAILED|\[lazyfs\]|\bfuse_[a-z_]+/i;

// ---------------------------------------------------------------- the start limit

export type StartCheck =
  | { ok: true; paid: boolean; text: string }
  | { ok: false; code: "start_unknown" | "start_blocked" | "no_start" | "paid_start"; text: string; commands: string[] };

/**
 * Can boat start `needed` sandboxes now (a start, or a test fork and a start),
 * and could that be a paid extra start? A paid one only with allowPaidStart;
 * boat's paid extra starts are never turned on here. A start counts as
 * included only when boat's limits show it: its paid extra starts are off,
 * the next start is priced at 0, or starts are left today and this hour.
 * Anything less (unreadable or partial limits) could be paid, so it needs
 * allowPaidStart too.
 */
export function startCheck(limits: Limits | null, allowPaidStart: boolean, needed = 1): StartCheck {
  const these = needed === 1 ? "this start" : `these ${needed} starts (a test fork, then the start)`;
  if (limits === null) {
    return allowPaidStart
      ? { ok: true, paid: true, text: "a boat start (Boat couldn't read your start limits; --allow-paid-start allows a paid one)" }
      : { ok: false, code: "start_unknown", text: `Boat couldn't read your boat start limits, so it can't tell whether ${these} would be a paid extra start.`, commands: ["boat limits"] };
  }
  if (limits.checkoutRequired) return { ok: false, code: "start_blocked", text: "Your boat.dev account has no plan yet, so boat can't start sandboxes.", commands: ["boat billing plan 20"] };
  if (!limits.canStart) return { ok: false, code: "start_blocked", text: `boat won't start a sandbox right now${limits.blockedReason ? `: ${limits.blockedReason}` : ""}.`, commands: ["boat limits --all"] };
  if (limits.startsUnlimited === true) return { ok: true, paid: false, text: "an included boat start (your plan has no start limit)" };
  const day = limits.startsLeftToday;
  const hour = limits.startsLeftThisHour;
  const windows = (
    [
      ["today", day],
      ["this hour", hour],
      ["this minute", limits.startsLeftThisMinute ?? null],
    ] as const
  )
    .filter(([, left]) => left !== null && left < needed)
    .map(([name]) => name);
  const price = limits.nextStartDollars ?? null;
  const priced = price !== null && price > 0;
  const extraOff = limits.extraStartsEnabled === false;
  if (windows.length === 0 && !priced) {
    if (extraOff || price === 0 || (day !== null && hour !== null)) {
      const [left, per] = hour !== null ? [hour, "this hour"] : [day, "today"];
      const what = needed === 1 ? "an included boat start" : `${needed} included boat starts (a test fork, then the start)`;
      return { ok: true, paid: false, text: left === null ? what : `${what} (${left} left ${per})` };
    }
    // boat didn't say enough to rule a paid extra start out.
    if (!allowPaidStart) {
      return {
        ok: false,
        code: "start_unknown",
        text: `boat's limits don't show whether ${these} would be included, and its paid extra starts aren't known to be off, so it could be a paid extra start. Run it again with --allow-paid-start once the user agrees.`,
        commands: ["boat limits"],
      };
    }
    return { ok: true, paid: true, text: "a boat start that may be a paid extra start, allowed with --allow-paid-start" };
  }
  const usedUp = windows.length > 0 ? `${needed === 1 ? "No included boat start is" : `Fewer than ${needed} included boat starts are`} left ${windows.join(" or ")}` : "Your included boat starts are used up";
  if (extraOff && !priced) {
    const back = windows.includes("today") ? "tomorrow" : windows.includes("this hour") ? "within the hour" : "in a minute";
    return { ok: false, code: "no_start", text: `${usedUp}, and boat's paid extra starts are off (Boat never turns them on), so boat can't start it now. Included starts come back ${back}.`, commands: ["boat limits"] };
  }
  const cost = priced ? ` (about $${price.toFixed(2)})` : "";
  const may = !priced && limits.extraStartsEnabled !== true ? " may be" : " would be";
  if (!allowPaidStart) {
    return {
      ok: false,
      code: "paid_start",
      text: `${usedUp}, so ${these}${may} a paid extra start${cost}. Run it again with --allow-paid-start once the user agrees, or wait for included starts to come back.`,
      commands: [],
    };
  }
  return { ok: true, paid: true, text: `a paid extra start${cost}, allowed with --allow-paid-start` };
}

// ---------------------------------------------------------------- diagnosis → action

/**
 * The problem a look found and what to do about it. boat.dev's fix for a
 * stuck sandbox comes first: an unreadable disk, an exec that never answers,
 * and an npm zombie (only a VM restart clears it) lead to a stop and a start.
 * A disk still restoring, a read waiting on it included, is waited for
 * (`waited`: that wait is over): reads still stuck after it lead to a stop and
 * a start too; a disk only still hydrating, its files reading fine, goes on.
 */
export function routeWake(findings: WakeFindings, options: { waited?: boolean } = {}): WakeRoute {
  const waited = options.waited === true;
  if (findings.execFailed !== null) {
    return { problem: "exec-unreachable", action: "stop-and-start", why: `boat's exec doesn't answer (${findings.execFailed})` };
  }
  const diagnosis = findings.diagnosis;
  const disk = findings.disk;
  const bb = findings.bb;
  if (diagnosis?.kind === "disk-restoring") {
    if ((disk?.unreadable.length ?? 0) > 0 || (disk?.hydrator ?? null) !== null || storageFailing(diagnosis.detail)) {
      return { problem: "disk-unreadable", action: "stop-and-start", why: `boat.dev can't restore this sandbox's disk${diagnosis.detail ? ` (${diagnosis.detail})` : ""}` };
    }
    if ((disk?.fuseBlocked.length ?? 0) > 0) {
      const what = diagnosis.detail ?? `waiting on a file not restored yet: ${disk!.fuseBlocked.slice(0, 2).join(", ")}`;
      return waited
        ? { problem: "disk-stuck", action: "stop-and-start", why: `reads on this sandbox's disk are still stuck after the wait (${what})` }
        : { problem: "disk-stuck", action: "wait-for-disk", why: `a read on this sandbox's disk is waiting for boat.dev to restore it (${what})` };
    }
    return waited
      ? { problem: "disk-restoring", action: "none", why: `boat.dev is still restoring this sandbox's disk${diagnosis.detail ? ` (${diagnosis.detail})` : ""}, but its files read fine` }
      : { problem: "disk-restoring", action: "wait-for-disk", why: `boat.dev is still restoring this sandbox's disk${diagnosis.detail ? ` (${diagnosis.detail})` : ""}` };
  }
  if ((diagnosis?.kind === "daemon-broken" && diagnosis.daemon?.zombie === true) || bb?.plan.kind === "hung") {
    const detail = bb?.plan.kind === "hung" ? bb.plan.detail : diagnosis?.detail;
    return { problem: "npm-zombie", action: "stop-and-start", why: `bb's own update left an npm zombie${detail ? ` (${detail})` : ""}, and only a restart of the sandbox clears it` };
  }
  if (bb?.plan.kind === "waiting") {
    return waited
      ? { problem: "disk-stuck", action: "stop-and-start", why: `bb's own update is still stuck on the disk after the wait (${bb.plan.detail})` }
      : { problem: "disk-stuck", action: "wait-for-disk", why: `bb's own update is waiting on the disk (${bb.plan.detail})` };
  }
  if (diagnosis?.kind === "ssh-session-stuck") {
    return { problem: "ssh-login-hang", action: "login-scripts", why: `SSH logins hang (${diagnosis.detail ?? "its login message scripts"})` };
  }
  if (diagnosis?.kind === "daemon-broken" || (bb?.plan.kind === "update" && bb.plan.broken) || bb?.plan.kind === "set-aside") {
    const detail = bb?.plan.kind === "set-aside" ? bb.plan.why : diagnosis?.kind === "daemon-broken" ? diagnosis.detail : "its install is incomplete";
    return { problem: "bb-broken", action: "bb-update", why: `bb on this sandbox is broken${detail ? ` (${detail})` : ""}` };
  }
  if (bb?.plan.kind === "busy") return { problem: "bb-old", action: "bb-update", why: bb.plan.detail };
  const installed = bb !== null && isVersion(bb.seen.installed) ? bb.seen.installed : null;
  if (bb !== null && installed !== null && isVersion(bb.target) && compareVersions(installed, bb.target) < 0) {
    return { problem: "bb-old", action: "bb-update", why: `bb ${installed} on this sandbox is older than the server's ${bb.target}` };
  }
  return { problem: "none", action: "none", why: "nothing wrong seen" };
}

/** Commands to install bb from the npm registry by hand (Boat never does: it installs only the server's own download). */
export function npmRegistrySteps(sandboxId: string, dataDir: string, unit: string | null, version: string): string[] {
  const service = unit ?? "<bb's service: systemctl --user list-units 'bb-host-daemon*'>";
  return [
    `boat ssh ${sandboxId}`,
    `D=${shortHome(dataDir)}`,
    `npm_config_cache=/tmp/npmcache npm install -g --no-audit --no-fund --allow-scripts=${ALLOW_SCRIPTS} --prefix "$D/npm.new" bb-app@${version}`,
    `mv "$D/npm" "$D/npm.old" && mv "$D/npm.new" "$D/npm"`,
    `systemctl --user reset-failed ${service} && systemctl --user restart ${service}`,
  ];
}

/** Start (or restart) bb's service; prints one BOAT_UNIT line with its state after. */
export function serviceRestartScript(unit: string): string {
  return [
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    `U=${shellQuote(unit)}`,
    'timeout 10 systemctl --user reset-failed "$U" >/dev/null 2>&1',
    'timeout 60 systemctl --user restart "$U" >/dev/null 2>&1',
    'A=$(timeout 5 systemctl --user show "$U" --property=ActiveState --value 2>/dev/null)',
    'echo "BOAT_UNIT ${A:-unknown}"',
  ].join("\n");
}

/** A short line for the problem a look found. */
function findingText(route: WakeRoute): string {
  switch (route.problem) {
    case "none":
      return "The sandbox looks healthy: its disk reads fine and nothing hangs.";
    case "disk-restoring":
      return route.action === "none" ? `${capitalize(route.why)}: going on.` : `${capitalize(route.why)}; its files read fine so far.`;
    default:
      return `${capitalize(route.why)}.`;
  }
}

/** Sentence case, except for names written in lower case (boat, boat.dev, bb). */
function capitalize(text: string): string {
  if (/^(?:boat|bb)\b/.test(text)) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A start check's sentence after "but" ("No included…" → "no included…"; names stay as they are). */
function lower(text: string): string {
  return /^(?:No|Your|Fewer)\b/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/** The --dry-run line for bb's update. */
function bbPlanText(look: BbLook, sandboxId: string): string {
  const plan = look.plan;
  switch (plan.kind) {
    case "update":
      return `Update bb on the sandbox ${plan.from ? `from ${plan.from} ` : ""}to ${plan.to}: a fresh install from ${plan.npm ? "the npm registry (no download of it there)" : "the server's download there"}, swapped in, the old one kept.`;
    case "set-aside":
      return `bb's install is broken (${plan.why}) and there's no download to install from: move it aside so bb's setup installs it again.`;
    case "busy":
      return `Wait for bb's own update on the sandbox to finish (${plan.detail}).`;
    case "hung":
    case "waiting":
      return `bb's own update hangs there (${plan.detail}): stop and start the sandbox first.`;
    case "none":
      return noDownload(look) ? `${noDownloadText(look)} ${manualText(look, sandboxId)}` : `No bb update needed (${plan.why}).`;
  }
}

/** bb is older than the server, the server's build isn't downloaded there, and Boat won't install it from the npm registry either. */
function noDownload(look: BbLook): boolean {
  const installed = isVersion(look.seen.installed) ? look.seen.installed : null;
  const behind = installed !== null && isVersion(look.target) && compareVersions(installed, look.target) < 0;
  return look.seen.dataDir !== null && look.plan.kind !== "update" && (behind || look.plan.kind === "set-aside") && !(isVersion(look.seen.tgz) && look.seen.tgz === look.target);
}

function noDownloadText(look: BbLook): string {
  return `No download of bb${look.target ? ` ${look.target}` : ""} is on the sandbox, so Boat can't install the server's build there itself.`;
}

function manualText(look: BbLook, sandboxId: string): string {
  if (look.target === null || look.seen.dataDir === null) return "";
  return `To install it by hand from the npm registry instead (a manual step; Boat doesn't run it): ${npmRegistrySteps(sandboxId, look.seen.dataDir, look.seen.unit, look.target)
    .map((line) => `\`${line}\``)
    .join(", then ")}.`;
}

// ---------------------------------------------------------------- the run

/** The run stops here: the report says why and what to run. */
class WakeStop extends Error {
  readonly reason: string;
  readonly commands: string[];
  readonly retryAt: number | null;
  /** The step it stopped at (null: the last one). */
  readonly step: WakeStepId | null;
  constructor(reason: string, commands: string[], retryAt: number | null, step: WakeStepId | null) {
    super(reason);
    this.reason = reason;
    this.commands = commands;
    this.retryAt = retryAt;
    this.step = step;
  }
}

function stop(reason: string, commands: string[] = [], options: { retryAt?: number | null; step?: WakeStepId } = {}): never {
  throw new WakeStop(reason, commands, options.retryAt ?? null, options.step ?? null);
}

/** bb's machine as a wake sees it: none on the sandbox, unreadable, or bb's record. */
type MachineNow = { kind: "none" } | { kind: "unknown"; why: string } | { kind: "known"; state: MachineState | null };

/** It may run turns: connected and not suspended, or not readable (unknown counts as connected). */
function mayRun(machine: MachineNow): boolean {
  if (machine.kind === "none") return false;
  if (machine.kind === "unknown" || machine.state === null) return true;
  return machine.state.connected && machine.state.phase !== "suspended";
}

/** One wake running in this plugin load. */
interface Job {
  target: WakeTarget;
  startedAt: number;
  /** Live: steps, route and findings as they come. */
  state: { steps: WakeStep[]; route: WakeRoute | null; findings: WakeFindings | null };
  done: Promise<WakeReport>;
}

export interface SandboxWaker {
  /** One wake, waited for to its end (a second one for the same sandbox gets the first's progress). */
  run(request: WakeRequest): Promise<WakeReport>;
  /** A wake from the CLI or the tool: started (or joined), waited for up to `waitMs`, then reported as running. */
  wake(call: WakeCall): Promise<WakeReport>;
  /** The running or last wake of the sandbox behind an id (throws TaskError when there's none). */
  status(input: string): Promise<WakeReport>;
  /** Start again the sandboxes a cut-off wake left stopped (at load, and on the monitor's pass). Returns them. */
  recover(): Promise<string[]>;
  /** The id → sandbox, its bb machine and chats (throws TaskError when it finds none). */
  resolve(input: string): Promise<WakeTarget>;
}

export function createSandboxWaker(deps: SandboxWakeDeps): SandboxWaker {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }));
  const lifecycle = deps.lifecycle ?? new AbortController().signal;
  const instance = randomUUID();
  const timing = {
    execWaitMs: EXEC_WAIT_MS,
    pollMs: POLL_MS,
    transitionWaitMs: TRANSITION_WAIT_MS,
    diskWaitMs: DISK_WAIT_MS,
    stopWaitMs: STOP_WAIT_MS,
    stopPollMs: STOP_POLL_MS,
    connectWaitMs: CONNECT_WAIT_MS,
    maxMs: WAKE_MAX_MS,
    restartBudgetMs: RESTART_BUDGET_MS,
    heartbeatMs: HEARTBEAT_MS,
    ...deps.timing,
  };
  /** The per-sandbox lock: one wake at a time, in this plugin load. */
  const jobs = new Map<string, Job>();

  // The markers, saved whole in kv (in memory without one), one write at a time.
  let markerStore: Promise<Record<string, WakeMarker>> | null = null;
  let saving: Promise<void> = Promise.resolve();
  const memory = new Map<string, unknown>();
  const kv: Kv = deps.kv ?? { get: async <T>(key: string) => memory.get(key) as T | undefined, set: async (key, value) => void memory.set(key, value) };
  function markers(): Promise<Record<string, WakeMarker>> {
    markerStore ??= kv.get<Record<string, WakeMarker>>(WAKE_MARKERS_KEY).then(
      (raw) => (raw !== null && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {}),
      () => ({}),
    );
    return markerStore;
  }
  async function putMarker(sandboxId: string, change: (current: WakeMarker | null) => WakeMarker | null): Promise<void> {
    const all = await markers();
    const next = change(all[sandboxId] ?? null);
    if (next === null) delete all[sandboxId];
    else all[sandboxId] = next;
    for (const [id, marker] of Object.entries(all)) if (now() - (marker.heartbeatAt ?? 0) > MARKER_TTL_MS && marker.restart === null) delete all[id];
    const copy = { ...all };
    saving = saving.then(() => kv.set(WAKE_MARKERS_KEY, copy)).catch((error: unknown) => deps.log?.(`sandbox wake: couldn't save its markers (${errorText(error)})`));
    await saving;
  }

  /** bb's machine on a sandbox; a lookup that failed is kept apart from "none" (there may be one, running chats). */
  async function hostFor(sandboxId: string): Promise<{ hostId: string | null; failed: string | null }> {
    const known = deps.tasks.hostForSandbox?.(sandboxId) ?? null;
    if (known !== null) return { hostId: known, failed: null };
    try {
      return { hostId: await deps.machines.hostFor(sandboxId), failed: null };
    } catch (error) {
      return { hostId: null, failed: firstLine(error) || "bb didn't answer" };
    }
  }

  async function openThreads(hostId: string): Promise<string[]> {
    const rows = await deps.machines.threadsOn(hostId).catch(() => [] as ThreadRow[]);
    return rows.filter((row) => isOpen(row) && typeof row.id === "string").map((row) => row.id!);
  }

  async function resolve(input: string): Promise<WakeTarget> {
    const id = input.trim();
    if (id === "") throw new TaskError("Name the sandbox, chat or task to wake.", "missing_target", "bb boat sandbox wake <sandbox id | thread id | task id>");
    if (/^bx_[A-Za-z0-9]+$/.test(id)) {
      const { hostId, failed } = await hostFor(id);
      return {
        kind: "sandbox",
        input: id,
        sandboxId: id,
        hostId,
        hostLookupFailed: failed,
        threadIds: hostId === null ? [] : await openThreads(hostId),
        taskIds: deps.tasks.liveSandboxTasks(id).map((task) => task.id),
        path: [`sandbox ${id}`, ...(hostId === null ? [] : [`bb machine ${hostId}`])],
      };
    }
    const task = id.length >= 4 ? deps.tasks.resolve(id) : null;
    if (task !== null) {
      if (task.sandboxId === null) throw new TaskError(`Task ${task.id} has no sandbox yet.`, "no_sandbox", `Check it with \`bb boat task show ${task.id}\`.`);
      const found = task.hostId !== null ? { hostId: task.hostId, failed: null } : await hostFor(task.sandboxId);
      const hostId = found.hostId;
      const threadIds = [...new Set([task.threadId, ...(task.threadId === null && hostId !== null ? await openThreads(hostId) : [])].filter((entry): entry is string => typeof entry === "string"))];
      return {
        kind: "task",
        input: id,
        sandboxId: task.sandboxId,
        hostId,
        hostLookupFailed: found.failed,
        threadIds,
        taskIds: [...new Set([task.id, ...deps.tasks.liveSandboxTasks(task.sandboxId).map((entry) => entry.id)])],
        path: [`task ${task.id}`, ...(hostId === null ? [] : [`bb machine ${hostId}`]), `sandbox ${task.sandboxId}`],
      };
    }
    const thread = await deps.threads.get(id).catch(() => null);
    if (thread === null) {
      throw new TaskError(`No sandbox, task or chat "${id}".`, "wake_target_not_found", "Pass a sandbox id (bx_…), a task id (t_…) or a chat's thread id.");
    }
    if (thread.environmentId === null) throw new TaskError(`Chat ${id} has no workspace, so it doesn't run on a machine.`, "not_on_sandbox");
    const hostId = await deps.machines.hostOf(thread.environmentId);
    if (hostId === null) throw new TaskError(`Chat ${id}'s workspace isn't on a bb machine.`, "not_on_sandbox");
    const sandboxId = await deps.machines.sandboxOf(hostId);
    if (sandboxId === null) throw new TaskError(`Chat ${id} runs on bb machine ${hostId}, which isn't a Boat sandbox.`, "not_on_sandbox", "Only chats on a Boat sandbox machine can be woken this way.");
    return {
      kind: "thread",
      input: id,
      sandboxId,
      hostId,
      hostLookupFailed: null,
      threadIds: [id],
      taskIds: deps.tasks.liveSandboxTasks(sandboxId).map((entry) => entry.id),
      path: [`chat ${id}`, `workspace ${thread.environmentId}`, `bb machine ${hostId}`, `sandbox ${sandboxId}`],
    };
  }

  /** A running wake, as a report so far. */
  function snapshot(job: Job, extra?: string): WakeReport {
    const steps = [...job.state.steps];
    if (extra) steps.push({ step: "sandbox", status: "info", text: extra, at: now() });
    return { target: job.target, dryRun: false, outcome: "running", route: job.state.route, findings: job.state.findings, steps, needsYou: null, startedAt: job.startedAt, finishedAt: null };
  }

  function busyText(startedAt: number): string {
    return `A wake is already running for this sandbox (started ${clockTime(startedAt, now())}): this is how far it got.`;
  }

  /** The whole wake (or a dry run): one look after another, then the remedies. */
  async function execute(target: WakeTarget, request: WakeRequest, state: Job["state"], startedAt: number, signal: AbortSignal): Promise<WakeReport> {
    const dry = request.dryRun === true;
    const allowPaid = request.allowPaidStart === true;
    const id = target.sandboxId;
    const steps = state.steps;
    const say = (step: WakeStepId, status: WakeStepStatus, text: string) => {
      steps.push({ step, status, text, at: now() });
      deps.log?.(`sandbox wake ${id}: ${status}: ${text}`);
    };
    let restarted = false;
    /** Boat started the sandbox in this run (its disk is still being restored). */
    let woke = false;
    let forgotten = false;
    let quieted = false;
    // Run again with the same choice to wake closed work (a paid start is asked for each time).
    const again = `bb boat sandbox wake ${request.target.trim()}${request.forceWake === true ? " --force-wake" : ""}`;
    const deadline = startedAt + timing.maxMs;
    const left = () => deadline - now();
    /** A wait cut to the run's time left (a start after a stop isn't cut). */
    const within = (ms: number) => Math.max(0, Math.min(ms, left()));

    /**
     * Right before Boat's first change, once the checks passed (a run that stops
     * before keeps all this as it was): the chats of closed tasks on the machine
     * lose their pending provider retries first (bringing the machine back would
     * send them), then Boat's own retry plan and hydrator track start over, so
     * bb's machine resume isn't held back.
     */
    async function beforeActing(): Promise<void> {
      if (dry) return;
      if (!quieted) {
        quieted = true;
        await quietClosedChats();
      }
      if (forgotten) return;
      forgotten = true;
      await deps.guard?.forget(id).catch(() => undefined);
    }

    /**
     * Chats on the machine whose Boat task is cancelled or closed: their pending
     * provider retries are cancelled (a retry could push superseded work), their
     * other queued messages are left to the user and listed. One that can't be
     * cancelled stops the wake before the machine comes back.
     */
    async function quietClosedChats(): Promise<void> {
      const onMachine = target.hostId === null ? [] : await deps.machines.threadsOn(target.hostId).then((rows) => rows.filter((row) => isOpen(row) && typeof row.id === "string").map((row) => row.id!), () => null);
      if (onMachine === null) say("chat", "info", "Boat couldn't list the chats on bb's machine to check for closed tasks' queued retries; only the chats named here were checked.");
      for (const threadId of [...new Set([...target.threadIds, ...(onMachine ?? [])])]) {
        const task = await deps.tasks.forThread(threadId).catch(() => null);
        if (task === null || !closed(task)) continue;
        const name = `chat ${threadId}`;
        const over = `task ${task.id} is ${task.status === "cancelled" ? "cancelled" : "closed"}`;
        const rows = await deps.threads.queued(threadId).catch(() => UNKNOWN);
        if (rows === UNKNOWN) {
          if (!dry) stop(`Boat couldn't read the queue of ${name} (${over}), so it can't tell whether a provider retry would go out once the machine is back. Check it in bb (cancel a stale retry with \`bb provider-retry cancel ${threadId}\`), then wake the sandbox again.`, [`bb provider-retry cancel ${threadId}`, again], { step: "chat" });
          say("chat", "planned", `Check the queue of ${name} (${over}); Boat couldn't read it.`);
          continue;
        }
        for (const row of rows.filter((entry) => entry.retry)) {
          if (dry) {
            say("chat", "planned", `Cancel the pending provider retry of ${name}: ${over}.`);
            continue;
          }
          const result = await deps.threads.cancelRetry(threadId, row.id).catch((): "stuck" => "stuck");
          if (result !== "removed") {
            stop(`Boat couldn't cancel the pending provider retry of ${name} (${over}), and it would go out once the machine is back. Cancel it in bb, then wake the sandbox again.`, [`bb provider-retry cancel ${threadId}`, again], { step: "chat" });
          }
          say("chat", "done", `Cancelled the pending provider retry of ${name}: ${over}.`);
        }
        const others = rows.filter((entry) => !entry.retry).length;
        if (others > 0) say("chat", "info", `bb will still deliver ${others} queued message${others === 1 ? "" : "s"} to ${name} of closed task ${task.id}; cancel them in bb if they're stale.`);
      }
    }

    async function machineNow(): Promise<MachineNow> {
      // A lookup that failed isn't "no machine": there may be one, running chats.
      if (target.hostId === null) return target.hostLookupFailed !== null ? { kind: "unknown", why: target.hostLookupFailed } : { kind: "none" };
      try {
        return { kind: "known", state: await deps.machines.host(target.hostId) };
      } catch (error) {
        return { kind: "unknown", why: firstLine(error) };
      }
    }

    async function setRestart(paidStart: boolean): Promise<void> {
      if (dry) return;
      await putMarker(id, (current) => ({ ...(current ?? { instance, startedAt, report: null }), instance, heartbeatAt: now(), restart: { at: now(), paidStart, triedAt: null } }));
    }
    async function clearRestart(): Promise<void> {
      if (dry) return;
      await putMarker(id, (current) => (current === null ? null : { ...current, heartbeatAt: now(), restart: null }));
    }

    const lookupFailed = target.hostLookupFailed === null ? null : `Boat couldn't look up bb's machine on sandbox ${id} (${target.hostLookupFailed}), so it can't tell whether a chat runs there`;
    say(
      "resolve",
      "info",
      target.kind === "sandbox"
        ? target.hostId
          ? `bb machine ${target.hostId} runs on it.`
          : lookupFailed !== null
            ? `${lookupFailed}.`
            : "No bb machine runs on it."
        : `${capitalize(target.path.join(" → "))}.`,
    );
    /** Needs you: bb's machine there is unknown (it can't be brought back, nor its chats checked). */
    const machineUnknown = (): never =>
      stop(`Boat couldn't look up bb's machine on sandbox ${id} (${target.hostLookupFailed}), so it can't bring bb back there or check the chats on it. Try again in a minute, or wake it by a chat's id.`, [again], { step: "machine" });

    /** Closed work isn't woken for: a task cancelled or done, a chat of one, a sandbox with only those. */
    async function closedTarget(): Promise<string | null> {
      const why = "so Boat doesn't wake it: a chat there could go on with superseded work. Wake it anyway with --force-wake only if the user wants that.";
      if (target.kind === "task") {
        const task = deps.tasks.resolve(target.input);
        return task !== null && closed(task) ? `Task ${task.id} is ${task.status === "cancelled" ? "cancelled" : "closed"}, ${why}` : null;
      }
      if (target.kind === "thread") {
        const task = await deps.tasks.forThread(target.input).catch(() => null);
        return task !== null && closed(task) ? `Chat ${target.input} belongs to task ${task.id}, which is ${task.status === "cancelled" ? "cancelled" : "closed"}, ${why}` : null;
      }
      const all = deps.tasks.sandboxTasks(id);
      return all.length > 0 && all.every(closed) ? `Sandbox ${id}'s only ${all.length === 1 ? "task is" : "tasks are"} over (${all.map(closedText).join(", ")}), ${why}` : null;
    }


    /** Wait out a start or stop boat is doing on its own. */
    async function settled(sandbox: Sandbox): Promise<Sandbox> {
      const until = now() + within(timing.transitionWaitMs);
      let current = sandbox;
      while (TRANSITIONAL_STATES.has(current.state)) {
        if (dry) return current;
        if (now() >= until) stop(`Sandbox ${id} has been ${current.state} for more than ${minutes(timing.transitionWaitMs)}.`, [`boat info ${id}`, again]);
        await sleep(timing.pollMs, signal);
        const next = await deps.boat.findInfo(id, signal);
        if (next === null) stop(`Sandbox ${id} no longer exists on boat.dev.`);
        current = next;
      }
      return current;
    }

    /**
     * One boat start, within the start limit and with a wake slot (the pacer).
     * After a stop ("start-again") it isn't cut by the run's time, waits longer
     * for its slot, and a failure leaves the marker: the monitor's pass starts
     * the sandbox again.
     */
    async function start(how: "resume" | "start-again"): Promise<void> {
      const step: WakeStepId = how === "resume" ? "resume" : "restart";
      const check = startCheck(await deps.boat.limits(signal).catch(() => null), allowPaid);
      if (!check.ok) {
        if (how === "start-again" && !dry) stop(`Boat stopped sandbox ${id}, but can't start it again now: ${lower(check.text)} Boat starts it again once it can (every few minutes), or run \`bb boat sandbox resume ${id}\`.`, check.commands, { step: "start-limit" });
        stop(how === "resume" ? check.text : `The sandbox would be stopped, but Boat couldn't start it again: ${lower(check.text)}`, check.commands, { step: "start-limit" });
      }
      if (dry) {
        const at = await deps.pacer.nextWakeAt();
        say(step, "planned", `${how === "resume" ? "Resume it" : "Start it again"}: ${check.text}, with a wake slot ${at <= now() ? "free now" : `at ${clockTime(at, now())}`}.`);
        return;
      }
      await beforeActing();
      let permit: WakePermit;
      try {
        permit = await deps.pacer.acquire({ signal, ...(how === "start-again" ? { maxWaitMs: RESTART_SLOT_WAIT_MS } : {}), onWait: (until, reason) => say(step, "info", `${waitStep(until, reason, now())}.`) });
      } catch (error) {
        if (error instanceof WakeDeferred) {
          if (how === "start-again") stop(`Boat stopped sandbox ${id}, but no wake slot is free before ${clockTime(error.retryAt, now())}. Boat starts it again then.`, [`bb boat sandbox resume ${id}`], { retryAt: error.retryAt, step });
          stop(error.message, [again], { retryAt: error.retryAt, step });
        }
        throw error;
      }
      try {
        await deps.bringUp(id, signal, { permit, paidStart: check.paid });
        await permit.succeeded();
      } catch (error) {
        if (!signal.aborted) await permit.failed();
        signal.throwIfAborted();
        const verb = how === "resume" ? "resume" : "start";
        const later = how === "start-again" ? ` Boat stopped it for this wake and keeps trying to start it again (every few minutes); or run \`bb boat sandbox resume ${id}\`.` : "";
        // The plugin's own refusal (no room for another sandbox, its start limit): its words and hint.
        if (error instanceof TaskError) stop(`Boat couldn't ${verb} sandbox ${id}: ${error.message}${error.hint ? ` ${error.hint}` : ""}${later}`, [again]);
        stop(`boat couldn't ${verb} sandbox ${id}: ${firstLine(error)}.${later || " boat.dev may still be restoring older sandboxes slowly; try again in a few minutes."}`, [`boat info ${id}`, again]);
      }
      woke = true;
      if (how === "start-again") await clearRestart();
      say(step, "done", `${how === "resume" ? "Resumed the sandbox" : "Started it again"}, with ${check.text}.`);
    }

    /** Wait until boat's exec answers (null: it does; else what it said last). */
    async function execAnswers(): Promise<{ failed: string | null; disk: boolean }> {
      // A sandbox this wake just started gets the whole wait, whatever time is left (else it would read as stuck).
      const until = now() + (woke ? timing.execWaitMs : within(timing.execWaitMs));
      let last = "no answer";
      for (;;) {
        try {
          const result = await deps.boat.exec(id, "echo BOAT_EXEC_OK", { timeoutMs: 20_000, signal, login: false });
          if (result.stdout.includes("BOAT_EXEC_OK")) return { failed: null, disk: false };
          last = cleanDetail(result.stderr.split("\n")[0] || `exit code ${result.exitCode}`, 200);
        } catch (error) {
          signal.throwIfAborted();
          last = firstLine(error);
          if (EIO.test(last)) return { failed: last, disk: true };
        }
        if (dry || now() >= until) return { failed: last, disk: false };
        await sleep(timing.pollMs, signal);
      }
    }

    /** bb's install, read-only (null: not readable). */
    async function lookAtBb(): Promise<BbLook | null> {
      const version = await deps.serverVersion().catch(() => null);
      try {
        const seen = parseInspection((await deps.boat.exec(id, inspectScript(target.hostId), { timeoutMs: 60_000, signal, login: false })).stdout);
        return { seen, plan: decideBbUpdate(seen, isVersion(version) ? version : null), target: isVersion(version) ? version : null };
      } catch (error) {
        signal.throwIfAborted();
        deps.log?.(`sandbox wake ${id}: couldn't look at bb's install (${firstLine(error)})`);
        return null;
      }
    }

    /** One look (read-only): exec, the disk, and bb's install once the disk reads fine. */
    async function look(): Promise<WakeFindings> {
      const exec = await execAnswers();
      if (exec.failed !== null) {
        return exec.disk
          ? { execFailed: null, diagnosis: { kind: "disk-restoring", detail: exec.failed, checked: true }, disk: null, bb: null }
          : { execFailed: exec.failed, diagnosis: null, disk: null, bb: null };
      }
      let disk: DiskCheck | null = null;
      let diagnosis: WakeDiagnosis;
      try {
        disk = parseDiskCheck((await deps.boat.exec(id, DISK_CHECK_SCRIPT, { timeoutMs: 30_000, signal, login: false })).stdout);
        diagnosis = classifyDiskCheck(disk);
      } catch (error) {
        signal.throwIfAborted();
        const said = firstLine(error);
        // The look itself failed on the disk (EIO), or it hung on it (a timeout): stuck.
        if (DISK_WORDS.test(said)) diagnosis = { kind: "disk-restoring", detail: said, checked: true };
        else return { execFailed: `the disk check failed: ${said}`, diagnosis: null, disk: null, bb: null };
      }
      const partial: WakeFindings = { execFailed: null, diagnosis, disk, bb: null };
      // bb's install is read only once the disk reads fine (a look at it would wait on the disk too).
      const action = routeWake(partial).action;
      if (action === "stop-and-start" || action === "wait-for-disk") return partial;
      return { ...partial, bb: await lookAtBb() };
    }

    function tell(next: WakeFindings, options: { waited?: boolean } = {}): WakeRoute {
      state.findings = next;
      state.route = routeWake(next, options);
      say("diagnose", state.route.problem === "none" ? "done" : "info", findingText(state.route));
      return state.route;
    }

    /** Follow a stop by its status (never a second stop). */
    async function followStop(first: StopReport, forced: boolean): Promise<{ kind: "stopped" | "refused" | "pending"; said: string; stopId: string | null }> {
      const until = now() + timing.stopWaitMs;
      let report = first;
      let lookedAgain = false;
      for (;;) {
        const sandboxState = (await deps.boat.findInfo(id, signal).catch(() => null))?.state ?? null;
        const outcome = forced ? forcedOutcome(report, sandboxState) : stopOutcome(report, sandboxState);
        if (outcome === "stopped") return { kind: "stopped", said: "", stopId: report.stopId };
        if (outcome === "refused") {
          // The sandbox is up and boat said nothing against the stop: its status is read again before it counts as refused.
          const said = report.error || (report.status !== null && /^(fail|refus|error)/i.test(report.status));
          if (said || lookedAgain) return { kind: "refused", said: refusalText(report) || (report.status ? `the stop is ${report.status}` : `it's still ${sandboxState ?? "up"}`), stopId: report.stopId };
          lookedAgain = true;
        }
        if (now() >= until) return { kind: "pending", said: "", stopId: report.stopId };
        await sleep(timing.stopPollMs, signal);
        if (report.stopId !== null) {
          const stopId = report.stopId;
          report = { ...(await deps.boat.stopStatus(id, stopId, signal).catch((): StopReport => ({ status: null, stopId, forced: null }))), stopId };
        }
      }
    }

    /** What a stop would interrupt: a headless agent mid-turn, or a chat mid-turn on a machine that may be running turns. */
    function busyThere(machine: MachineNow, threads: ThreadRow[] | null): string[] {
      const live = mayRun(machine);
      const reasons = deps.tasks
        .liveSandboxTasks(id)
        .filter((task) => (task.status === "running" || task.status === "starting") && (task.runner === "boat" || live))
        .map((task) => `task ${task.id} is mid-turn`);
      if (live) {
        for (const row of threads ?? []) if (turnRuns(row) || (isOpen(row) && row.hasPendingInteraction === true)) reasons.push(`${row.title ? `the chat "${clip(row.title)}"` : "a chat there"} is mid-turn`);
        if (target.hostId === null && target.hostLookupFailed !== null) reasons.push(`Boat couldn't look up bb's machine there (${target.hostLookupFailed}), so it can't see whether a chat is mid-turn`);
        else if (threads === null && target.hostId !== null) reasons.push("Boat couldn't see whether a chat there is mid-turn");
      }
      return [...new Set(reasons)];
    }

    /** boat.dev's fix for a stuck sandbox: a stop and a start (the guarded path). */
    async function restart(why: string): Promise<void> {
      if (restarted) {
        stop(`${capitalize(why)}, still after a stop and a start. Leave it until boat.dev has recovered and try again later, or report it to boat.dev with the error above.`, [`boat stop ${id}`, again]);
      }
      // Nothing is stopped before Boat knows it can start it again, and has the time to.
      const check = startCheck(await deps.boat.limits(signal).catch(() => null), allowPaid);
      if (!check.ok) stop(`${capitalize(why)}. boat.dev's fix is to stop it and start it again, but ${lower(check.text)}`, check.commands, { step: "start-limit" });
      if (!dry && left() < timing.restartBudgetMs) {
        stop(`${capitalize(why)}. This wake has run for ${minutes(now() - startedAt)}, too long to stop the sandbox and still start it again within its limit of about ${minutes(timing.maxMs)}, so nothing was stopped.`, [again], { step: "restart" });
      }
      const facts = () => moveFacts(deps.boat, id, deps.tasks.liveSandboxTasks(id), target.hostId !== null ? () => deps.machines.threadsOn(target.hostId!) : null, signal);
      const first = await facts();
      // Even a plain stop interrupts what runs there. On a paused or disconnected machine nothing runs;
      // one Boat can't read may be running turns.
      const busy = busyThere(await machineNow(), first.threads);
      if (busy.length > 0) {
        const running = deps.tasks.liveSandboxTasks(id).filter((task) => task.status === "running" || task.status === "starting");
        // Only unknowns (Boat couldn't see the chats): nothing to finish or interrupt, just to look at again.
        const unknownOnly = busy.every((reason) => reason.startsWith("Boat couldn't"));
        stop(
          unknownOnly
            ? `${capitalize(why)}, but ${busy.join("; ")}. Nothing was stopped: try again in a minute, or wake it by a chat's id.`
            : `${capitalize(why)}, but ${busy.join("; ")}, and a stop would interrupt it. Let it finish or interrupt it, then wake the sandbox again.`,
          [...running.map((task) => `bb boat task interrupt ${task.id}`), again],
          { step: "restart" },
        );
      }
      const safe = moveDecision(first);
      if (dry) {
        say(
          "restart",
          "planned",
          `Stop it with a plain boat stop (a fresh snapshot, nothing lost), follow that stop, and start it again: boat.dev's fix for a stuck sandbox. ${
            safe.auto
              ? "If boat refuses the plain stop, check the snapshot with a test fork on another node first, and force the stop only if it reads fine there (nothing there could be lost)."
              : `If boat refuses the plain stop, Boat won't force it: ${safe.reasons.join("; ")}.`
          }`,
        );
        await start("start-again");
        return;
      }
      await beforeActing();
      // The why was just said (the look's line, or the update's).
      say("restart", "info", "Stopping it to start it again: boat.dev's fix for a stuck sandbox.");
      // Before the stop: a wake cut off from here leaves the sandbox to the monitor's pass, which starts it again.
      await setRestart(check.paid);
      let report: StopReport;
      try {
        report = await deps.boat.stop(id, signal);
      } catch (error) {
        signal.throwIfAborted();
        const said = firstLine(error);
        // boat saying it can't snapshot it is a refusal; anything else isn't known to be one.
        if (/snapshot|hydrat|refus|can(?:no|')t stop/i.test(said)) report = { status: "failing", stopId: null, forced: null, error: said };
        else {
          await clearRestart();
          stop(`boat's stop of sandbox ${id} failed: ${said}.`, [`boat info ${id}`, again]);
        }
      }
      let outcome = await followStop(report, false);
      let forced = false;
      if (outcome.kind === "refused") {
        // Still up: the force is decided now, and anything that rules it out leaves the sandbox running.
        await force(outcome.said);
        forced = true;
        let forcedReport: StopReport;
        try {
          forcedReport = await deps.boat.stop(id, signal, { force: true });
        } catch (error) {
          signal.throwIfAborted();
          await clearRestart();
          stop(`boat refused the forced stop of sandbox ${id} too (${firstLine(error)}).`, [`boat info ${id}`, again]);
        }
        outcome = await followStop(forcedReport, true);
      }
      if (outcome.kind !== "stopped") {
        // The stop may still end with the sandbox stopped: the marker stays, and the monitor's pass starts it again then.
        stop(
          `boat's ${forced ? "forced " : ""}stop of sandbox ${id} is still pending after ${minutes(timing.stopWaitMs)}. Check it by its status (not a second stop); once it's stopped, Boat starts it again on its own.`,
          [outcome.stopId !== null ? `boat stop ${id} --status ${outcome.stopId}` : `boat info ${id}`, again],
        );
      }
      restarted = true;
      say("restart", "done", forced ? "Stopped it with --force (it keeps its last completed snapshot, which a test fork read fine; nothing there was at risk)." : "Stopped it with a fresh snapshot.");
      await start("start-again");
    }

    /**
     * boat refused the plain stop, and the sandbox is still up. Force it only as
     * PR #12's move does: nothing there could be lost (looked at again now), time
     * and starts for a test fork and the start, and a test fork from the same
     * snapshot that reads fine on another node. Otherwise it stops here.
     */
    async function force(said: string): Promise<void> {
      const refused = `boat refused to stop sandbox ${id} with a fresh snapshot (${said})`;
      const giveUp = async (reason: string, commands: string[]): Promise<never> => {
        await clearRestart();
        stop(reason, commands, { step: "restart" });
      };
      const recheck = moveDecision(await moveFacts(deps.boat, id, deps.tasks.liveSandboxTasks(id), target.hostId !== null ? () => deps.machines.threadsOn(target.hostId!) : null, signal));
      const snapshotAt = await deps.boat.lastSnapshotAt(id, signal).catch(() => null);
      const keeps = `Forcing the stop keeps only ${snapshotText(snapshotAt, now())}, so what changed since is lost, files git ignores included.`;
      if (!recheck.auto) await giveUp(`${refused}. ${keeps} Boat won't force it because ${recheck.reasons.join("; ")}.`, [`boat stop ${id} --force`, again]);
      if (left() < timing.restartBudgetMs) await giveUp(`${refused}. This wake has run for ${minutes(now() - startedAt)}, too long for a test fork, a forced stop and a start within its limit of about ${minutes(timing.maxMs)}; the sandbox is still running.`, [again]);
      const two = startCheck(await deps.boat.limits(signal).catch(() => null), allowPaid, 2);
      if (!two.ok) await giveUp(`${refused}. Forcing it needs a test fork of its snapshot first and then a start, but ${lower(two.text)}`, [...two.commands, again]);
      // forkCheck takes its own wake slot without waiting: wait for one first.
      const slotBy = now() + 2 * WAKE_WINDOW_MS;
      while ((await deps.pacer.nextWakeAt()) > now() && now() < slotBy) await sleep(Math.min(timing.pollMs, Math.max(1, (await deps.pacer.nextWakeAt()) - now())), signal);
      say("restart", "info", `${capitalize(refused)}. Checking its snapshot with a test fork on another node before forcing the stop.`);
      const fork = await forkCheck(deps.boat, id, { pacer: deps.pacer, signal, log: (line) => deps.log?.(`sandbox wake ${id}: ${line}`) });
      signal.throwIfAborted();
      if (fork === "unreadable") {
        await giveUp(`${refused}, and a test fork from the same snapshot couldn't read its files either: forcing the stop would keep only that snapshot. Leave it and report it to boat.dev with the error above.`, [again]);
      }
      if (fork !== "healthy") {
        await giveUp(`${refused}, and Boat couldn't check its snapshot with a test fork, so it won't force the stop: without a clear "it reads fine", nothing is forced. ${keeps}`, [`boat stop ${id} --force`, again]);
      }
      say("restart", "info", "A test fork from the same snapshot restored fine on another node, and nothing there could be lost: forcing the stop.");
    }

    /** A disk still restoring (a read waiting on it included): looked at again for a while, then routed as waited. */
    async function waitForDisk(): Promise<WakeRoute> {
      const span = within(timing.diskWaitMs);
      const until = now() + span;
      say("diagnose", "info", `Waiting up to ${minutes(span)} for boat.dev to restore the disk.`);
      for (;;) {
        if (now() >= until) {
          // The wait is over: reads still stuck lead to a stop and a start; a disk only still hydrating goes on.
          return tell(state.findings ?? { execFailed: null, diagnosis: null, disk: null, bb: null }, { waited: true });
        }
        await sleep(Math.min(timing.pollMs, Math.max(1, until - now())), signal);
        const next = await look();
        if (routeWake(next).action !== "wait-for-disk") return tell(next);
        state.findings = next;
      }
    }

    /**
     * bb's update (src/bb-update.ts), when bb is installed there. It stops and
     * starts bb's service, so it runs only on a machine that's neither connected
     * (turns may run there; bb updates itself) nor suspended (bb's machine
     * resume runs the same update, before it starts bb). An unreadable machine
     * counts as connected; without a known machine only a broken install is
     * repaired. Returns whether it started bb's service itself.
     */
    async function updateBb(look: BbLook | null, last: WakeRoute, machine: MachineNow): Promise<boolean> {
      if (look === null) {
        say("bb-update", "skipped", target.hostId === null ? "No bb on this sandbox to update." : "Boat couldn't look at bb's install there; bb's own setup checks it.");
        return false;
      }
      if (look.seen.dataDir === null) {
        say("bb-update", "skipped", "bb isn't installed on this sandbox.");
        return false;
      }
      const suspended = machine.kind === "known" && machine.state?.phase === "suspended";
      if (suspended) {
        const needed = look.plan.kind === "update" || look.plan.kind === "set-aside" || noDownload(look);
        say("bb-update", needed ? (dry ? "planned" : "info") : "skipped", needed ? `${capitalize(last.problem === "bb-broken" || last.problem === "bb-old" ? last.why : "bb there needs an update")}: bb's machine resume updates it safely itself, before it starts bb.${noDownload(look) ? ` ${noDownloadText(look)} ${manualText(look, id)}` : ""}` : `No bb update needed (${look.plan.kind === "none" ? look.plan.why : "bb is up to date"}).`);
        return false;
      }
      if (mayRun(machine)) {
        const unread = machine.kind === "unknown" || (machine.kind === "known" && machine.state === null);
        say("bb-update", "skipped", unread ? "Boat couldn't read bb's machine, so it leaves bb's install alone (it may be running turns)." : "bb's machine is connected, so Boat leaves bb's install alone (bb updates itself).");
        return false;
      }
      if (machine.kind === "none" && last.problem !== "bb-broken") {
        say("bb-update", "skipped", "No bb machine is known on this sandbox, so Boat leaves bb's install there alone.");
        return false;
      }
      if (dry) {
        say("bb-update", look.plan.kind === "none" && !noDownload(look) ? "skipped" : "planned", bbPlanText(look, id));
        return false;
      }
      await beforeActing();
      // Asked for explicitly: an earlier failed update's wait starts over.
      await deps.updateBb.forget?.(id).catch(() => undefined);
      let result: HostPrepResult;
      try {
        result = await deps.updateBb({
          sandboxId: id,
          hostId: target.hostId,
          woke,
          signal,
          report: { step: (text) => say("bb-update", "info", `${text}.`), log: (text) => deps.log?.(`sandbox wake ${id}: ${text}`) },
        });
      } catch (error) {
        if (!(error instanceof BbUpdateHung)) throw error;
        const hung = error.wakeDiagnosis;
        if (hung.kind === "daemon-broken") {
          const repair = daemonRepairQuestion({ sandboxId: id, detail: hung.detail, daemon: hung.daemon, hostId: target.hostId });
          stop(`${error.message} ${repair.recommendation}`, repair.context.split("\n").slice(1));
        }
        stop(`${error.message} Wake it again in a few minutes.`, [again]);
      }
      switch (result.kind) {
        case "updated":
          say("bb-update", "done", `Updated bb on the sandbox from ${result.from ?? "a broken install"} to ${result.to}${result.npm ? ", installed from the npm registry" : ""}.`);
          return true;
        case "set-aside":
          say("bb-update", "done", "bb's install there was broken, so Boat moved it aside; bb's setup installs it again.");
          if (noDownload(look)) say("bb-update", "info", `${noDownloadText(look)} ${manualText(look, id)}`);
          return false;
        case "failed":
          say("bb-update", "failed", result.text);
          return false;
        case "held":
          say("bb-update", "skipped", `A bb update failed there recently; Boat tries again after ${clockTime(result.until, now())}.`);
          return false;
        case "none":
          if (noDownload(look)) say("bb-update", "info", `${noDownloadText(look)} ${manualText(look, id)}`);
          else say("bb-update", "skipped", `No bb update needed (${result.why || "bb is up to date"}).`);
          return false;
      }
    }

    /**
     * bb's machine back. Suspended: only `bb machine resume` (the provider's
     * resume turns the login scripts off, updates bb and restarts it).
     * Disconnected and not suspended: bb's service restarted. Then a wait
     * until it connects.
     */
    async function machineBack(look: BbLook | null, serviceStarted: boolean): Promise<void> {
      const hostId = target.hostId;
      if (hostId === null) {
        if (lookupFailed !== null) machineUnknown();
        say("machine", "skipped", "No bb machine runs on this sandbox.");
        return;
      }
      const machine = await machineNow();
      if (machine.kind === "known" && machine.state === null) {
        say("machine", "skipped", `bb doesn't know machine ${hostId} any more.`);
        return;
      }
      const host = machine.kind === "known" ? machine.state : null;
      if (host !== null && host.connected && host.phase !== "suspended") {
        say("machine", "done", `bb's machine ${hostId} is connected.`);
        return;
      }
      const unit = look?.seen.unit ?? null;
      const suspended = host?.phase === "suspended";
      if (dry) {
        if (suspended) say("machine", "planned", `Resume bb's machine (\`bb machine resume ${hostId}\`): bb's own resume turns off the login scripts, updates bb safely and starts it.`);
        else if (unit !== null) say("bb-service", "planned", `Restart bb's service on the sandbox (${unit}).`);
        say("machine", "planned", `Wait up to ${minutes(timing.connectWaitMs)} for bb's machine to connect.`);
        return;
      }
      if (suspended) {
        await beforeActing();
        try {
          await deps.machines.resume(hostId);
          say("machine", "done", `Asked bb to resume its machine (\`bb machine resume ${hostId}\`); bb's own resume starts bb there.`);
        } catch (error) {
          signal.throwIfAborted();
          stop(`bb couldn't resume its machine ${hostId}: ${firstLine(error)}.`, [`bb machine resume ${hostId}`]);
        }
      } else if (serviceStarted) say("bb-service", "skipped", "bb's update started bb's service again.");
      else if (unit === null) say("bb-service", "skipped", "Boat couldn't find bb's service on the sandbox; bb's own setup starts it.");
      else {
        await beforeActing();
        try {
          const said = /BOAT_UNIT (\S+)/.exec((await deps.boat.exec(id, serviceRestartScript(unit), { timeoutMs: 90_000, signal, login: false })).stdout)?.[1] ?? "unknown";
          const up = said === "active" || said === "activating";
          say("bb-service", up ? "done" : "failed", up ? `Restarted bb's service (${unit}).` : `bb's service (${unit}) is ${said} after a restart.`);
        } catch (error) {
          signal.throwIfAborted();
          say("bb-service", "failed", `Boat couldn't restart bb's service (${firstLine(error)}).`);
        }
      }
      const span = Math.max(timing.pollMs, within(timing.connectWaitMs));
      const until = now() + span;
      let last = host;
      for (;;) {
        last = (await deps.machines.host(hostId).catch(() => null)) ?? last;
        if (last !== null && last.connected && last.phase !== "suspended") {
          say("machine", "done", `bb's machine ${hostId} is connected again.`);
          return;
        }
        if (now() >= until) {
          stop(`bb's machine ${hostId} didn't connect within ${minutes(span)}${last?.message ? ` (bb says: ${clip(last.message, 200)})` : ""}.`, [
            `bb machine resume ${hostId}`,
            ...(unit === null ? [] : [`boat exec ${id} -- systemctl --user status ${unit}`]),
          ]);
        }
        await sleep(timing.pollMs, signal);
      }
    }

    /** One chat: what it needs now that its machine is back (null: nothing, it's fine). */
    async function retryChat(threadId: string): Promise<Omit<WakeStep, "step"> | null> {
      const thread = await deps.threads.get(threadId).catch(() => null);
      if (thread === null) return target.kind === "sandbox" ? null : { status: "skipped", text: `Chat ${threadId} is gone.` };
      if (thread.archived) return null;
      const name = `chat ${threadId}${thread.title ? ` ("${clip(thread.title)}")` : ""}`;
      // A chat of a task that's over is never retried: it could push superseded work.
      const task = await deps.tasks.forThread(threadId).catch(() => null);
      if (task !== null && closed(task)) {
        return { status: "skipped", text: `${capitalize(name)} belongs to task ${task.id}, which is ${task.status === "cancelled" ? "cancelled" : "closed"}: Boat doesn't retry it (it could push superseded work).` };
      }
      if (isBusy(thread.status)) return { status: "skipped", text: `${capitalize(name)} is running a turn.` };
      const rows = await deps.threads.queued(threadId).catch(() => UNKNOWN);
      if (rows === UNKNOWN) return { status: "skipped", text: `Boat couldn't read ${name}'s queue, so it left it alone.` };
      const pending = rows.find((row) => row.retry) ?? null;
      if (pending !== null && pending.sendAt !== null && pending.sendAt > now()) {
        if (dry) return { status: "planned", text: `Send ${name}'s pending provider retry now (it's due at ${clockTime(pending.sendAt, now())}).` };
        try {
          await deps.threads.sendQueued(threadId, pending.id);
          return { status: "done", text: `Sent ${name}'s pending provider retry now.` };
        } catch (error) {
          if (nothingSent(error)) return { status: "skipped", text: `${capitalize(name)}'s pending retry was gone already.` };
          return { status: "failed", text: `Boat couldn't send ${name}'s pending retry (${firstLine(error)}).` };
        }
      }
      if (rows.length > 0) {
        const count = `${rows.length} queued message${rows.length === 1 ? "" : "s"}`;
        return { status: "skipped", text: dry ? `${capitalize(name)}'s queue sends its ${count} once the machine is back.` : `${capitalize(name)}'s queue is sending its ${count} now.` };
      }
      if (thread.status !== "error") return null;
      const turn = readStoppedTurn(await deps.threads.stopEvents(threadId).catch(() => []));
      if (turn === null) return { status: "skipped", text: `${capitalize(name)} shows an error, but no failed turn to retry.` };
      if (turn.failure.kind === "usage-limit") return { status: "skipped", text: `${capitalize(name)} stopped at a usage limit: it continues at the reset, not here.` };
      if (dry) return { status: "planned", text: `Retry ${name}'s failed turn.` };
      try {
        await deps.threads.retry(threadId, turn.requestId, WAKE_RETRY_REASON);
        return { status: "done", text: `Retried ${name}'s failed turn.` };
      } catch (error) {
        if (nothingSent(error)) return { status: "skipped", text: `${capitalize(name)}'s failed turn moved on already.` };
        return { status: "failed", text: `Boat couldn't retry ${name}'s failed turn (${firstLine(error)}).` };
      }
    }

    async function retryChats(): Promise<void> {
      if (target.threadIds.length === 0) {
        const headless = target.taskIds.length > 0 && target.hostId === null;
        say("chat", "skipped", headless ? `No chat runs on this sandbox. A headless task continues with \`bb boat task followup ${target.taskIds[0]} --message …\`.` : "No chat runs on this sandbox.");
        return;
      }
      let fine = 0;
      for (const threadId of target.threadIds) {
        const outcome = await retryChat(threadId);
        if (outcome === null) fine++;
        else say("chat", outcome.status, outcome.text);
      }
      if (fine > 0) say("chat", "skipped", target.threadIds.length === 1 ? "The chat has nothing to retry." : `${fine} ${fine === 1 ? "chat has" : "chats have"} nothing to retry.`);
    }

    const report = (outcome: WakeReport["outcome"], needsYou: WakeReport["needsYou"]): WakeReport => ({
      target,
      dryRun: dry,
      outcome,
      route: state.route,
      findings: state.findings,
      steps: [...steps],
      needsYou,
      startedAt,
      finishedAt: now(),
    });

    try {
      if (request.forceWake !== true) {
        const over = await closedTarget();
        if (over !== null) stop(over, [`${again} --force-wake`], { step: "sandbox" });
      }
      let sandbox = await deps.boat.findInfo(id, signal);
      if (sandbox === null) stop(`Sandbox ${id} no longer exists on boat.dev.`, [], { step: "sandbox" });
      if ((await deps.guard?.moving(id).catch(() => false)) === true) {
        stop(`Boat is moving sandbox ${id} to a new boat.dev node (its node keeps failing its disk). Let that finish, then wake it.`, [`bb boat sandbox info ${id}`], { step: "sandbox" });
      }
      sandbox = await settled(sandbox);
      say("sandbox", "info", `It's ${sandbox.state}.`);
      if (!ACTIVE_STATES.has(sandbox.state)) {
        if (TRANSITIONAL_STATES.has(sandbox.state)) say("sandbox", "planned", `Wait until it's done ${sandbox.state}, then look at it.`);
        else if (resumable(sandbox)) await start("resume");
        else stop(`Sandbox ${id} is ${sandbox.state}${sandbox.error ? ` (${clip(sandbox.error, 200)})` : ""}, so boat can't resume it.`, [`boat info ${id}`], { step: "sandbox" });
      }

      if (dry && !ACTIVE_STATES.has(sandbox.state)) {
        // Nothing to look at before it runs: the rest of the plan, in general.
        say("diagnose", "planned", "Then wait until boat's exec answers and look at the disk, the SSH login and bb's install there. A read waiting on the disk: wait up to 2 minutes. A disk that's unreadable, reads still stuck after that, or an npm zombie: stop it and start it again.");
        say("login-scripts", "planned", "Turn off the login message scripts, if any are still on.");
        if (target.hostId !== null) say("machine", "planned", "Then bb's machine: resume it if it's suspended (bb's own resume updates bb safely and starts it), else restart bb's service, and wait until it connects.");
        else if (lookupFailed !== null) machineUnknown();
        await quietClosedChats();
        await retryChats();
        return report("planned", null);
      }

      // Look, wait for a disk still restoring, and first fix what a stop and a start fixes.
      let next = tell(await look());
      if (next.action === "wait-for-disk") {
        if (dry) say("diagnose", "planned", `Wait up to ${minutes(timing.diskWaitMs)} for boat.dev to restore the disk${next.problem === "disk-stuck" ? "; reads still stuck then: stop it and start it again" : ""}.`);
        else next = await waitForDisk();
      }
      if (next.action === "stop-and-start") {
        await restart(next.why);
        if (!dry) {
          next = tell(await look());
          if (next.action === "wait-for-disk") next = await waitForDisk();
          // Still unreadable or stuck: Needs you (restart() stops the second time).
          if (next.action === "stop-and-start") await restart(next.why);
        }
      }

      if (dry && next.action === "stop-and-start") {
        say("diagnose", "planned", "Then look at it again. Still unreadable or stuck after that: Needs you.");
        say("login-scripts", "planned", "Turn off the login message scripts, if any are still on.");
        if (target.hostId !== null) say("machine", "planned", "Then bb's machine: resume it if it's suspended (bb's own resume updates bb safely and starts it), else update bb if it's old or broken and restart bb's service, and wait until it connects.");
      } else {
        if (dry) say("login-scripts", "planned", next.problem === "ssh-login-hang" ? "Turn off the login message scripts: they hang SSH logins while the disk restores." : "Turn off the login message scripts, if any are still on.");
        else {
          await beforeActing();
          const quiet = await deps.quietLogins(id, signal);
          if (quiet === "disabled") say("login-scripts", "done", "Turned off the login message scripts.");
          else if (quiet === "failed") say("login-scripts", "failed", "Boat couldn't turn off the login message scripts (no sudo there?); bb's setup goes ahead.");
          else say("login-scripts", "skipped", "The login message scripts are off already.");
        }
        const bb = state.findings?.bb ?? (await lookAtBb());
        const serviceStarted = await updateBb(bb, next, await machineNow());
        await machineBack(bb, serviceStarted);
      }
      if (dry) await quietClosedChats();
      await retryChats();
      return report(dry ? "planned" : "awake", null);
    } catch (error) {
      if (error instanceof WakeStop) {
        say(error.step ?? steps.at(-1)?.step ?? "sandbox", "needs-you", error.reason);
        return report("needs-you", { reason: error.reason, commands: error.commands, retryAt: error.retryAt });
      }
      // Cut off (a reload) or an error Boat didn't expect: said, and a restart's marker stays for the monitor's pass.
      const reason = signal.aborted
        ? `The wake was cut off (the plugin stopped or reloaded) at: ${steps.at(-1)?.text ?? "the start"} If it had stopped the sandbox, Boat starts it again on its own.`
        : `The wake failed: ${firstLine(error)}`;
      say(steps.at(-1)?.step ?? "sandbox", "needs-you", reason);
      return report("needs-you", { reason, commands: [again], retryAt: null });
    }
  }

  /** A wake that isn't a dry run: the per-sandbox lock, its marker and heartbeat. */
  async function startJob(target: WakeTarget, request: WakeRequest): Promise<{ job: Job; joined: boolean } | { other: WakeMarker }> {
    const id = target.sandboxId;
    const running = jobs.get(id);
    if (running !== undefined) return { job: running, joined: true };
    // Another plugin load runs one (its heartbeat is fresh).
    const marker = (await markers())[id] ?? null;
    if (marker !== null && marker.report === null && marker.instance !== instance && now() - marker.heartbeatAt < STALE_MS) return { other: marker };
    // Checked again: two calls may have read the markers at once.
    const raced = jobs.get(id);
    if (raced !== undefined) return { job: raced, joined: true };
    const startedAt = now();
    const state: Job["state"] = { steps: [], route: null, findings: null };
    let release: (report: WakeReport) => void = () => undefined;
    const job: Job = { target, startedAt, state, done: new Promise<WakeReport>((resolve) => (release = resolve)) };
    jobs.set(id, job);
    void (async () => {
      let beat: ReturnType<typeof setInterval> | null = null;
      try {
        await putMarker(id, (current) => ({ instance, startedAt, heartbeatAt: now(), restart: current?.restart ?? null, report: null }));
        beat = setInterval(() => void putMarker(id, (current) => (current === null ? null : { ...current, heartbeatAt: now() })), timing.heartbeatMs);
        beat.unref?.();
        const report = await execute(target, { ...request, signal: undefined }, state, startedAt, lifecycle);
        if (beat !== null) clearInterval(beat);
        beat = null;
        await putMarker(id, (current) => ({ ...(current ?? { instance, startedAt, restart: null }), instance, heartbeatAt: now(), report }));
        release(report);
      } catch (error) {
        const report: WakeReport = { ...snapshot(job), outcome: "needs-you", finishedAt: now(), needsYou: { reason: `The wake failed: ${firstLine(error)}`, commands: [`bb boat sandbox wake ${id}`], retryAt: null } };
        release(report);
      } finally {
        if (beat !== null) clearInterval(beat);
        jobs.delete(id);
      }
    })();
    return { job, joined: false };
  }

  function otherText(marker: WakeMarker): string {
    return `A wake is already running for this sandbox in another load of the plugin (started ${clockTime(marker.startedAt, now())}). Check on it with \`bb boat sandbox wake --status\`.`;
  }

  async function run(request: WakeRequest): Promise<WakeReport> {
    const target = await resolve(request.target);
    if (request.dryRun === true) {
      const running = jobs.get(target.sandboxId);
      if (running !== undefined) return snapshot(running, `${busyText(running.startedAt)} A dry run doesn't look meanwhile.`);
      return execute(target, request, { steps: [], route: null, findings: null }, now(), request.signal ?? lifecycle);
    }
    const started = await startJob(target, request);
    if ("other" in started) return { target, dryRun: false, outcome: "running", route: null, findings: null, steps: [{ step: "sandbox", status: "info", text: otherText(started.other), at: now() }], needsYou: null, startedAt: started.other.startedAt, finishedAt: null };
    if (started.joined) return snapshot(started.job, busyText(started.job.startedAt));
    return started.job.done;
  }

  async function wake(call: WakeCall): Promise<WakeReport> {
    const target = await resolve(call.target);
    if (call.dryRun === true) return run(call);
    const started = await startJob(target, call);
    if ("other" in started) return { target, dryRun: false, outcome: "running", route: null, findings: null, steps: [{ step: "sandbox", status: "info", text: otherText(started.other), at: now() }], needsYou: null, startedAt: started.other.startedAt, finishedAt: null };
    const { job, joined } = started;
    const waitMs = Math.max(0, call.waitMs ?? FOREGROUND_WAIT_MS);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const waited = await Promise.race([
      job.done,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    if (timer !== null) clearTimeout(timer);
    if (waited !== null) return joined ? { ...waited, steps: [{ step: "sandbox", status: "info", text: busyText(job.startedAt), at: job.startedAt }, ...waited.steps] } : waited;
    // It goes on: the chat that asked hears how it ended.
    const threadId = call.threadId ?? null;
    if (threadId !== null && deps.notify !== undefined && !joined) {
      void job.done.then((report) => deps.notify!(threadId, finishedNotice(report))).catch((error: unknown) => deps.log?.(`sandbox wake ${target.sandboxId}: couldn't tell ${threadId} (${errorText(error)})`));
    }
    return { ...snapshot(job, joined ? busyText(job.startedAt) : undefined), tellsThreadId: !joined && deps.notify !== undefined ? threadId : null };
  }

  async function status(input: string): Promise<WakeReport> {
    const id = input.trim();
    const sandboxId = /^bx_[A-Za-z0-9]+$/.test(id) ? id : (await resolve(id)).sandboxId;
    const running = jobs.get(sandboxId);
    if (running !== undefined) return snapshot(running);
    const marker = (await markers())[sandboxId] ?? null;
    if (marker?.report) return marker.report;
    if (marker !== null && marker.instance !== instance && now() - marker.heartbeatAt < STALE_MS) {
      const target = await resolve(sandboxId).catch(() => null);
      if (target !== null) return { target, dryRun: false, outcome: "running", route: null, findings: null, steps: [{ step: "sandbox", status: "info", text: otherText(marker), at: now() }], needsYou: null, startedAt: marker.startedAt, finishedAt: null };
    }
    throw new TaskError(`No wake of sandbox ${sandboxId} ran recently.`, "no_wake", `Start one with \`bb boat sandbox wake ${id}\`.`);
  }

  let recovering: Promise<string[]> | null = null;
  async function recoverOnce(): Promise<string[]> {
    const started: string[] = [];
    for (const [sandboxId, marker] of Object.entries(await markers())) {
      if (marker.restart === null || jobs.has(sandboxId)) continue;
      // Another plugin load is still at it.
      if (marker.instance !== instance && now() - marker.heartbeatAt < STALE_MS && marker.report === null) continue;
      if (marker.restart.triedAt !== null && now() - marker.restart.triedAt < RECOVER_RETRY_MS) continue;
      const stoppedAt = marker.restart.at;
      // Not started again within a day, or its tasks are over: no more starts on its own, a note instead.
      const over = deps.tasks.sandboxTasks(sandboxId);
      const expired = now() - stoppedAt > RESTART_TTL_MS;
      if (expired || (over.length > 0 && over.every(closed))) {
        await putMarker(sandboxId, (current) => (current === null ? null : { ...current, restart: null }));
        const why = expired ? "couldn't start it again within a day" : `its tasks are over (${over.map(closedText).join(", ")})`;
        deps.log?.(`sandbox wake ${sandboxId}: a wake stopped it at ${new Date(stoppedAt).toISOString()} and ${why}; Boat no longer starts it on its own`);
        // On the record of every task that ran there, closed ones too (they may all be).
        deps.tell?.(sandboxId, `A wake stopped this sandbox at ${clockTime(stoppedAt, now())} and ${why}, so Boat no longer starts it on its own. Start it with \`bb boat sandbox wake ${sandboxId}\` when it's needed.`, { closedToo: true });
        continue;
      }
      const paidStart = marker.restart.paidStart;
      await putMarker(sandboxId, (current) => (current?.restart ? { ...current, restart: { ...current.restart, triedAt: now() } } : current));
      const sandbox = await deps.boat.findInfo(sandboxId, lifecycle).catch(() => undefined);
      if (sandbox === undefined || (sandbox !== null && TRANSITIONAL_STATES.has(sandbox.state))) continue;
      if (sandbox === null || ACTIVE_STATES.has(sandbox.state) || !resumable(sandbox)) {
        // Gone, up again (bb or someone resumed it), or not something boat resumes: nothing left to start.
        await putMarker(sandboxId, (current) => (current === null ? null : { ...current, restart: null }));
        continue;
      }
      const check = startCheck(await deps.boat.limits(lifecycle).catch(() => null), paidStart);
      if (!check.ok) {
        deps.log?.(`sandbox wake ${sandboxId}: a wake stopped it and couldn't start it again yet: ${check.text}`);
        continue;
      }
      let permit: WakePermit;
      try {
        permit = await deps.pacer.acquire({ signal: lifecycle, maxWaitMs: 0 });
      } catch {
        continue;
      }
      try {
        await deps.bringUp(sandboxId, lifecycle, { permit, paidStart: check.paid });
        await permit.succeeded();
      } catch (error) {
        if (!lifecycle.aborted) await permit.failed();
        deps.log?.(`sandbox wake ${sandboxId}: couldn't start it again after a cut-off wake (${firstLine(error)}); trying again later`);
        continue;
      }
      await putMarker(sandboxId, (current) => (current === null ? null : { ...current, restart: null }));
      started.push(sandboxId);
      deps.log?.(`sandbox wake ${sandboxId}: started it again; a wake had stopped it and was cut off before its start`);
      deps.tell?.(sandboxId, "A wake stopped this sandbox and was cut off before it started it again, so Boat started it again now.");
    }
    return started;
  }

  function recover(): Promise<string[]> {
    recovering ??= recoverOnce().finally(() => {
      recovering = null;
    });
    return recovering;
  }

  return { run, wake, status, recover, resolve };
}

// ---------------------------------------------------------------- output

const ICON: Record<WakeStepStatus, string> = { done: "✓", skipped: "–", planned: "→", failed: "✗", info: "·", "needs-you": "!" };

/** The message for the chat that asked, once a wake that outlived its wait ends. */
export function finishedNotice(report: WakeReport): string {
  const head = `[boat] The wake of sandbox ${report.target.sandboxId} (\`bb boat sandbox wake ${report.target.input}\`)`;
  if (report.outcome === "awake") return `${head} is done: it's back. \`bb boat sandbox wake ${report.target.sandboxId} --status\` shows every step.`;
  if (report.needsYou !== null) return `${head} stopped. Needs you: ${report.needsYou.reason}${report.needsYou.commands.length > 0 ? ` Commands: ${report.needsYou.commands.map((command) => `\`${command}\``).join(", ")}.` : ""}`;
  return `${head} ended: \`bb boat sandbox wake ${report.target.sandboxId} --status\` shows how.`;
}

/** The report as text (`bb boat sandbox wake`). */
export function wakeText(report: WakeReport): string {
  const lines: string[] = [];
  lines.push(
    report.dryRun
      ? `Dry run for sandbox ${report.target.sandboxId}: nothing was changed.`
      : report.outcome === "running"
        ? `Waking sandbox ${report.target.sandboxId} (still running; started ${clockTime(report.startedAt)}).`
        : `Waking sandbox ${report.target.sandboxId}.`,
  );
  // The needs-you line is printed once, at the end.
  for (const step of report.steps) if (step.status !== "needs-you" || report.needsYou === null) lines.push(`${ICON[step.status]} ${step.text}`);
  if (report.needsYou !== null) {
    lines.push("", `Needs you: ${report.needsYou.reason}`);
    for (const command of report.needsYou.commands) lines.push(`    $ ${command}`);
  } else if (report.outcome === "awake") {
    lines.push("", "It's back.");
  } else if (report.outcome === "planned") {
    lines.push("", `Run it without --dry-run to do this: bb boat sandbox wake ${report.target.input}`);
  } else if (report.outcome === "running") {
    lines.push("", `Still running. Check on it with \`bb boat sandbox wake ${report.target.sandboxId} --status\`${report.tellsThreadId ? "; this chat gets a [boat] message when it's done" : ""}.`);
  }
  return lines.join("\n");
}
