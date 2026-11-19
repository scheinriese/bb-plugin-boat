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
//    zombie;
// 5. the disk unreadable or stuck, or an npm zombie: stop it and start it
//    again. A plain stop first (a fresh snapshot), followed by its status and
//    never by a second stop; --force only when nothing there could be lost
//    (src/node-move.ts); otherwise the facts and the exact commands;
// 6. login message scripts off (src/login-scripts.ts);
// 7. bb older than the server, or broken: the safe update (src/bb-update.ts);
//    no download there: said, with the npm registry as a manual step only;
// 8. bb's service started or restarted, then `bb machine resume` when bb has
//    the machine suspended, and wait until it connects;
// 9. the chat: send its pending provider retry now, retry its failed turn, or
//    leave it when its queue is already sending.
// Nothing here kills processes by pattern (`pkill -f` can match its own
// command line). --dry-run only looks and prints the plan. A stop for safety
// ends with "Needs you" and the commands to run.
import { setTimeout as delay } from "node:timers/promises";
import { isOpen, type ThreadRow } from "./activity.ts";
import { ACTIVE_STATES, type BoatApi, type Limits, type Sandbox, type StopReport } from "./boat-api.ts";
import { BbUpdateHung, compareVersions, decideBbUpdate, inspectScript, isVersion, parseInspection, type BbInstall, type BbUpdatePlan, type HostPrep, type HostPrepResult } from "./bb-update.ts";
import type { MachineState } from "./chat.ts";
import { clockTime } from "./format.ts";
import type { QuietLogin } from "./login-scripts.ts";
import { forcedOutcome, moveDecision, moveFacts, refusalText, snapshotText, stopOutcome } from "./node-move.ts";
import { UNKNOWN, nothingSent, readStoppedTurn, type ResumeThreads } from "./paid-resume.ts";
import { isBusy } from "./relay.ts";
import { TRANSITIONAL_STATES, TaskError, resumable } from "./service.ts";
import type { Task } from "./store.ts";
import { DISK_CHECK_SCRIPT, classifyDiskCheck, cleanDetail, daemonRepairQuestion, parseDiskCheck, storageFailing, type DiskCheck, type WakeDiagnosis } from "./wake-diagnosis.ts";
import { WakeDeferred, type WakePacer, type WakePermit } from "./wake-pacer.ts";
import { waitStep, type WakeGuard } from "./wake-retry.ts";

/** boat's exec must answer within this after a resume… */
export const EXEC_WAIT_MS = 3 * 60_000;
/** …asked this often (also how often a machine's connection is looked at). */
export const POLL_MS = 10_000;
/** A sandbox starting or stopping on its own: waited for this long. */
export const TRANSITION_WAIT_MS = 2 * 60_000;
/** A disk still restoring normally ("hydration in progress"): looked at again for this long. */
export const DISK_WAIT_MS = 2 * 60_000;
/** A stop is followed (its status, never a second stop) for this long… */
export const STOP_WAIT_MS = 5 * 60_000;
/** …this often. */
export const STOP_POLL_MS = 10_000;
/** bb's machine must connect within this after its service restarts. */
export const CONNECT_WAIT_MS = 3 * 60_000;
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
  /** bb's machine on the sandbox (null: none, or bb doesn't know one). */
  hostId: string | null;
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
  /** awake: it's back; planned: a dry run's plan; needs-you: stopped (for safety, or nothing more it can do now). */
  outcome: "awake" | "planned" | "needs-you";
  /** The last look's problem and action (null: no look, e.g. a stopped sandbox in a dry run). */
  route: WakeRoute | null;
  findings: WakeFindings | null;
  steps: WakeStep[];
  needsYou: { reason: string; commands: string[]; retryAt: number | null } | null;
}

export interface WakeRequest {
  /** A sandbox id (bx_…), a task id (t_…) or a chat's thread id. */
  target: string;
  dryRun?: boolean;
  /** The user agreed to a paid extra start if no included start is left. */
  allowPaidStart?: boolean;
  signal?: AbortSignal;
}

export interface SandboxWakeDeps {
  boat: Pick<BoatApi, "findInfo" | "exec" | "stop" | "stopStatus" | "limits" | "lastSnapshotAt">;
  /** Resume it within the slot limit with this wake slot (BoatService.bringUp). */
  bringUp(sandboxId: string, signal: AbortSignal, wake: { permit: WakePermit; paidStart: boolean }): Promise<unknown>;
  pacer: Pick<WakePacer, "acquire" | "nextWakeAt">;
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
    /** bb's machine on a sandbox, from the plugin's tasks (null: none known). */
    hostForSandbox?(sandboxId: string): string | null;
  };
  threads: Pick<ResumeThreads, "get" | "stopEvents" | "queued" | "sendQueued" | "retry">;
  machines: {
    /** The bb machine a workspace is on (null: none). */
    hostOf(environmentId: string): Promise<string | null>;
    /** The boat sandbox under a bb machine (null: it isn't a Boat sandbox machine). */
    sandboxOf(hostId: string): Promise<string | null>;
    /** The bb machine on a sandbox (null: none). */
    hostFor(sandboxId: string): Promise<string | null>;
    /** bb's record of a machine (null: bb doesn't know it). */
    host(hostId: string): Promise<MachineState | null>;
    /** `bb machine resume` (bb runs the provider's resume). */
    resume(hostId: string): Promise<unknown>;
    threadsOn(hostId: string): Promise<ThreadRow[]>;
  };
  now?(): number;
  sleep?(ms: number, signal?: AbortSignal): Promise<unknown>;
  log?(line: string): void;
  /** Tests: shorter waits. */
  timing?: Partial<{ execWaitMs: number; pollMs: number; transitionWaitMs: number; diskWaitMs: number; stopWaitMs: number; stopPollMs: number; connectWaitMs: number }>;
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

const EIO = /Input\/output error|\bEIO\b/i;
const DISK_WORDS = /Input\/output error|\bEIO\b|HYDRATOR FAILED|\[lazyfs\]|\bfuse_[a-z_]+/i;

// ---------------------------------------------------------------- the start limit

export type StartCheck =
  | { ok: true; paid: boolean; text: string }
  | { ok: false; code: "start_unknown" | "start_blocked" | "no_start" | "paid_start"; text: string; commands: string[] };

/**
 * Can boat start the sandbox now, and would that be a paid extra start?
 * A paid one only with allowPaidStart; boat's paid extra starts are never
 * turned on here. Unreadable limits can't rule a paid start out, so they
 * need allowPaidStart too.
 */
export function startCheck(limits: Limits | null, allowPaidStart: boolean): StartCheck {
  if (limits === null) {
    return allowPaidStart
      ? { ok: true, paid: true, text: "a boat start (Boat couldn't read your start limits; --allow-paid-start allows a paid one)" }
      : {
          ok: false,
          code: "start_unknown",
          text: "Boat couldn't read your boat start limits, so it can't tell whether this start would be a paid extra start.",
          commands: ["boat limits"],
        };
  }
  if (limits.checkoutRequired) return { ok: false, code: "start_blocked", text: "Your boat.dev account has no plan yet, so boat can't start sandboxes.", commands: ["boat billing plan 20"] };
  if (!limits.canStart) return { ok: false, code: "start_blocked", text: `boat won't start a sandbox right now${limits.blockedReason ? `: ${limits.blockedReason}` : ""}.`, commands: ["boat limits --all"] };
  const windows = (
    [
      ["today", limits.startsLeftToday],
      ["this hour", limits.startsLeftThisHour],
      ["this minute", limits.startsLeftThisMinute ?? null],
    ] as const
  )
    .filter(([, left]) => left === 0)
    .map(([name]) => name);
  const price = limits.nextStartDollars ?? null;
  const priced = price !== null && price > 0;
  if (windows.length === 0 && !priced) {
    const [left, per] = limits.startsLeftThisHour !== null ? [limits.startsLeftThisHour, "this hour"] : [limits.startsLeftToday, "today"];
    return { ok: true, paid: false, text: left === null ? "an included boat start" : `an included boat start (${left} left ${per})` };
  }
  const usedUp = windows.length > 0 ? `No included boat start is left ${windows.join(" or ")}` : "Your included boat starts are used up";
  if (limits.extraStartsEnabled !== true && !priced) {
    const back = windows.includes("today") ? "tomorrow" : windows.includes("this hour") ? "within the hour" : "in a minute";
    return { ok: false, code: "no_start", text: `${usedUp}, and boat's paid extra starts are off (Boat never turns them on), so boat can't start it now. Included starts come back ${back}.`, commands: ["boat limits"] };
  }
  const cost = priced ? ` (about $${price.toFixed(2)})` : "";
  if (!allowPaidStart) {
    return {
      ok: false,
      code: "paid_start",
      text: `${usedUp}, so this start would be a paid extra start${cost}. Run it again with --allow-paid-start once the user agrees, or wait for included starts to come back.`,
      commands: [],
    };
  }
  return { ok: true, paid: true, text: `a paid extra start${cost}, allowed with --allow-paid-start` };
}

// ---------------------------------------------------------------- diagnosis → action

/**
 * The problem a look found and what to do about it. boat.dev's fix for a
 * stuck sandbox comes first: an unreadable or stuck disk, an exec that never
 * answers, and an npm zombie (only a VM restart clears it) all lead to a stop
 * and a start. A disk still restoring normally is waited for.
 */
export function routeWake(findings: WakeFindings): WakeRoute {
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
      return { problem: "disk-stuck", action: "stop-and-start", why: `reads on this sandbox's disk are stuck (${diagnosis.detail ?? disk!.fuseBlocked.slice(0, 2).join(", ")})` };
    }
    return { problem: "disk-restoring", action: "wait-for-disk", why: `boat.dev is still restoring this sandbox's disk${diagnosis.detail ? ` (${diagnosis.detail})` : ""}` };
  }
  if ((diagnosis?.kind === "daemon-broken" && diagnosis.daemon?.zombie === true) || bb?.plan.kind === "hung") {
    const detail = bb?.plan.kind === "hung" ? bb.plan.detail : diagnosis?.detail;
    return { problem: "npm-zombie", action: "stop-and-start", why: `bb's own update left an npm zombie${detail ? ` (${detail})` : ""}, and only a restart of the sandbox clears it` };
  }
  if (bb?.plan.kind === "waiting") {
    return { problem: "disk-stuck", action: "stop-and-start", why: `bb's own update is stuck on the disk (${bb.plan.detail})` };
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
      return `${capitalize(route.why)}; its files read fine so far.`;
    default:
      return `${capitalize(route.why)}.`;
  }
}

/** Sentence case, except for names written in lower case (boat, boat.dev, bb). */
function capitalize(text: string): string {
  if (/^(?:boat|bb)\b/.test(text)) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The --dry-run line for bb's update. */
function bbPlanText(look: BbLook, sandboxId: string): string {
  const plan = look.plan;
  switch (plan.kind) {
    case "update":
      return `Update bb on the sandbox ${plan.from ? `from ${plan.from} ` : ""}to ${plan.to}: a fresh install from the server's download there, swapped in, the old one kept.`;
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

/** bb is older than the server and the server's build isn't downloaded there. */
function noDownload(look: BbLook): boolean {
  const installed = isVersion(look.seen.installed) ? look.seen.installed : null;
  const behind = installed !== null && isVersion(look.target) && compareVersions(installed, look.target) < 0;
  return look.seen.dataDir !== null && (behind || look.plan.kind === "set-aside") && !(isVersion(look.seen.tgz) && look.seen.tgz === look.target);
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

export interface SandboxWaker {
  run(request: WakeRequest): Promise<WakeReport>;
  /** The id → sandbox, its bb machine and chats (throws TaskError when it finds none). */
  resolve(input: string, signal?: AbortSignal): Promise<WakeTarget>;
}

export function createSandboxWaker(deps: SandboxWakeDeps): SandboxWaker {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }));
  const timing = {
    execWaitMs: EXEC_WAIT_MS,
    pollMs: POLL_MS,
    transitionWaitMs: TRANSITION_WAIT_MS,
    diskWaitMs: DISK_WAIT_MS,
    stopWaitMs: STOP_WAIT_MS,
    stopPollMs: STOP_POLL_MS,
    connectWaitMs: CONNECT_WAIT_MS,
    ...deps.timing,
  };

  async function hostFor(sandboxId: string): Promise<string | null> {
    return deps.tasks.hostForSandbox?.(sandboxId) ?? (await deps.machines.hostFor(sandboxId).catch(() => null));
  }

  async function openThreads(hostId: string): Promise<string[]> {
    const rows = await deps.machines.threadsOn(hostId).catch(() => [] as ThreadRow[]);
    return rows.filter((row) => isOpen(row) && typeof row.id === "string").map((row) => row.id!);
  }

  async function resolve(input: string): Promise<WakeTarget> {
    const id = input.trim();
    if (id === "") throw new TaskError("Name the sandbox, chat or task to wake.", "missing_target", "bb boat sandbox wake <sandbox id | thread id | task id>");
    if (/^bx_[A-Za-z0-9]+$/.test(id)) {
      const hostId = await hostFor(id);
      return {
        kind: "sandbox",
        input: id,
        sandboxId: id,
        hostId,
        threadIds: hostId === null ? [] : await openThreads(hostId),
        taskIds: deps.tasks.liveSandboxTasks(id).map((task) => task.id),
        path: [`sandbox ${id}`, ...(hostId === null ? [] : [`bb machine ${hostId}`])],
      };
    }
    const task = id.length >= 4 ? deps.tasks.resolve(id) : null;
    if (task !== null) {
      if (task.sandboxId === null) throw new TaskError(`Task ${task.id} has no sandbox yet.`, "no_sandbox", `Check it with \`bb boat task show ${task.id}\`.`);
      const hostId = task.hostId ?? (await hostFor(task.sandboxId));
      const threadIds = [...new Set([task.threadId, ...(task.threadId === null && hostId !== null ? await openThreads(hostId) : [])].filter((entry): entry is string => typeof entry === "string"))];
      return {
        kind: "task",
        input: id,
        sandboxId: task.sandboxId,
        hostId,
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
      threadIds: [id],
      taskIds: deps.tasks.liveSandboxTasks(sandboxId).map((entry) => entry.id),
      path: [`chat ${id}`, `workspace ${thread.environmentId}`, `bb machine ${hostId}`, `sandbox ${sandboxId}`],
    };
  }

  async function run(request: WakeRequest): Promise<WakeReport> {
    const signal = request.signal ?? new AbortController().signal;
    const dry = request.dryRun === true;
    const allowPaid = request.allowPaidStart === true;
    const target = await resolve(request.target);
    const id = target.sandboxId;
    const steps: WakeStep[] = [];
    const say = (step: WakeStepId, status: WakeStepStatus, text: string) => {
      steps.push({ step, status, text });
      deps.log?.(`sandbox wake ${id}: ${status}: ${text}`);
    };
    let findings: WakeFindings | null = null;
    let route: WakeRoute | null = null;
    let restarted = false;
    /** Boat started the sandbox in this run (its disk is still being restored). */
    let woke = false;
    const again = `bb boat sandbox wake ${request.target.trim()}`;
    /** The last look (a function: the closures below set it). */
    const latest = (): WakeFindings | null => findings;

    say("resolve", "info", target.kind === "sandbox" ? (target.hostId ? `bb machine ${target.hostId} runs on it.` : "No bb machine runs on it.") : `${capitalize(target.path.join(" → "))}.`);

    /** Wait out a start or stop boat is doing on its own. */
    async function settled(sandbox: Sandbox): Promise<Sandbox> {
      const deadline = now() + timing.transitionWaitMs;
      let current = sandbox;
      while (TRANSITIONAL_STATES.has(current.state)) {
        if (dry) return current;
        if (now() >= deadline) stop(`Sandbox ${id} has been ${current.state} for more than ${Math.round(timing.transitionWaitMs / 60_000)} minutes.`, [`boat info ${id}`, again]);
        await sleep(timing.pollMs, signal);
        const next = await deps.boat.findInfo(id, signal);
        if (next === null) stop(`Sandbox ${id} no longer exists on boat.dev.`);
        current = next;
      }
      return current;
    }

    /** One boat start, within the start limit and with a wake slot (the pacer). */
    async function start(how: "resume" | "start-again"): Promise<void> {
      const step: WakeStepId = how === "resume" ? "resume" : "restart";
      const check = startCheck(await deps.boat.limits(signal).catch(() => null), allowPaid);
      if (!check.ok) stop(how === "resume" ? check.text : `The sandbox is stopped, but Boat can't start it again: ${check.text}`, check.commands, { step: "start-limit" });
      if (dry) {
        const at = await deps.pacer.nextWakeAt();
        say(step, "planned", `${how === "resume" ? "Resume it" : "Start it again"}: ${check.text}, with a wake slot ${at <= now() ? "free now" : `at ${clockTime(at, now())}`}.`);
        return;
      }
      let permit: WakePermit;
      try {
        permit = await deps.pacer.acquire({ signal, onWait: (until, reason) => say(step, "info", `${waitStep(until, reason, now())}.`) });
      } catch (error) {
        if (error instanceof WakeDeferred) stop(error.message, [again], { retryAt: error.retryAt, step });
        throw error;
      }
      try {
        await deps.bringUp(id, signal, { permit, paidStart: check.paid });
        await permit.succeeded();
      } catch (error) {
        if (!signal.aborted) await permit.failed();
        signal.throwIfAborted();
        const verb = how === "resume" ? "resume" : "start";
        // The plugin's own refusal (no room for another sandbox, its start limit): its words and hint.
        if (error instanceof TaskError) stop(`Boat couldn't ${verb} sandbox ${id}: ${error.message}${error.hint ? ` ${error.hint}` : ""}`, [again]);
        stop(`boat couldn't ${verb} sandbox ${id}: ${firstLine(error)}. boat.dev may still be restoring older sandboxes slowly; try again in a few minutes.`, [`boat info ${id}`, again]);
      }
      woke = true;
      say(step, "done", `${how === "resume" ? "Resumed the sandbox" : "Started it again"}, with ${check.text}.`);
    }

    /** Wait until boat's exec answers (null: it does; else what it said last). */
    async function execAnswers(): Promise<{ failed: string | null; disk: boolean }> {
      const deadline = now() + timing.execWaitMs;
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
        if (dry || now() >= deadline) return { failed: last, disk: false };
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
      if (routeWake(partial).action === "stop-and-start") return partial;
      return { ...partial, bb: await lookAtBb() };
    }

    function tell(next: WakeFindings): WakeRoute {
      findings = next;
      route = routeWake(next);
      say("diagnose", route.problem === "none" ? "done" : "info", findingText(route));
      return route;
    }

    /** Follow a stop by its status (never a second stop). */
    async function followStop(first: StopReport, forced: boolean): Promise<{ kind: "stopped" | "refused" | "pending"; said: string; stopId: string | null }> {
      const deadline = now() + timing.stopWaitMs;
      let report = first;
      let lookedAgain = false;
      for (;;) {
        const state = (await deps.boat.findInfo(id, signal).catch(() => null))?.state ?? null;
        const outcome = forced ? forcedOutcome(report, state) : stopOutcome(report, state);
        if (outcome === "stopped") return { kind: "stopped", said: "", stopId: report.stopId };
        if (outcome === "refused") {
          // The sandbox is up and boat said nothing against the stop: its status is read again before it counts as refused.
          const said = report.error || (report.status !== null && /^(fail|refus|error)/i.test(report.status));
          if (said || lookedAgain) return { kind: "refused", said: refusalText(report) || (report.status ? `the stop is ${report.status}` : `it's still ${state ?? "up"}`), stopId: report.stopId };
          lookedAgain = true;
        }
        if (now() >= deadline) return { kind: "pending", said: "", stopId: report.stopId };
        await sleep(timing.stopPollMs, signal);
        if (report.stopId !== null) {
          const stopId = report.stopId;
          report = { ...(await deps.boat.stopStatus(id, stopId, signal).catch((): StopReport => ({ status: null, stopId, forced: null }))), stopId };
        }
      }
    }

    /** boat.dev's fix for a stuck sandbox: a stop and a start (the guarded path). */
    async function restart(why: string): Promise<void> {
      if (restarted) {
        stop(`${capitalize(why)}, still after a stop and a start. Leave it stopped until boat.dev has recovered and try again later, or report it to boat.dev with the error above.`, [`boat stop ${id}`, again]);
      }
      // Nothing is stopped before Boat knows it can start it again.
      const check = startCheck(await deps.boat.limits(signal).catch(() => null), allowPaid);
      if (!check.ok) stop(`${capitalize(why)}. boat.dev's fix is to stop it and start it again, but ${check.text.charAt(0).toLowerCase()}${check.text.slice(1)}`, check.commands, { step: "start-limit" });
      const facts = () => moveFacts(deps.boat, id, deps.tasks.liveSandboxTasks(id), target.hostId !== null ? () => deps.machines.threadsOn(target.hostId!) : null, signal);
      const safe = moveDecision(await facts());
      if (dry) {
        say(
          "restart",
          "planned",
          `Stop it with a plain boat stop (a fresh snapshot, nothing lost), follow that stop, and start it again: boat.dev's fix for a stuck sandbox. ${
            safe.auto ? "If boat refuses the plain stop, force it: nothing there could be lost." : `If boat refuses the plain stop, Boat won't force it: ${safe.reasons.join("; ")}.`
          }`,
        );
        await start("start-again");
        return;
      }
      // The why was just said (the look's line, or the update's).
      say("restart", "info", "Stopping it to start it again: boat.dev's fix for a stuck sandbox.");
      let report: StopReport;
      try {
        report = await deps.boat.stop(id, signal);
      } catch (error) {
        signal.throwIfAborted();
        const said = firstLine(error);
        // boat saying it can't snapshot it is a refusal; anything else isn't known to be one.
        if (/snapshot|hydrat|refus|can(?:no|')t stop/i.test(said)) report = { status: "failing", stopId: null, forced: null, error: said };
        else stop(`boat's stop of sandbox ${id} failed: ${said}.`, [`boat info ${id}`, again]);
      }
      let outcome = await followStop(report, false);
      let forced = false;
      if (outcome.kind === "refused") {
        // The sandbox stayed up meanwhile: look again that nothing there would be lost now.
        const recheck = moveDecision(await facts());
        if (!recheck.auto) {
          const snapshotAt = await deps.boat.lastSnapshotAt(id, signal).catch(() => null);
          stop(
            `boat refused to stop sandbox ${id} with a fresh snapshot (${outcome.said}). Forcing the stop keeps only ${snapshotText(snapshotAt, now())}, so what changed since is lost, files git ignores included. Boat won't force it because ${recheck.reasons.join("; ")}.`,
            [`boat stop ${id} --force`, again],
          );
        }
        say("restart", "info", `boat refused the plain stop (${outcome.said}); nothing there could be lost, so Boat forces it.`);
        let forcedReport: StopReport;
        try {
          forcedReport = await deps.boat.stop(id, signal, { force: true });
        } catch (error) {
          signal.throwIfAborted();
          stop(`boat refused the forced stop of sandbox ${id} too (${firstLine(error)}).`, [`boat info ${id}`, again]);
        }
        forced = true;
        outcome = await followStop(forcedReport, true);
      }
      if (outcome.kind !== "stopped") {
        stop(
          `boat's ${forced ? "forced " : ""}stop of sandbox ${id} is still pending after ${Math.round(timing.stopWaitMs / 60_000)} minutes. Check it by its status (not a second stop), then wake it again.`,
          [outcome.stopId !== null ? `boat stop ${id} --status ${outcome.stopId}` : `boat info ${id}`, again],
        );
      }
      restarted = true;
      say("restart", "done", forced ? "Stopped it with --force (it keeps its last completed snapshot; nothing there was at risk)." : "Stopped it with a fresh snapshot.");
      await start("start-again");
    }

    /** A disk still restoring normally: looked at again for a while. */
    async function waitForDisk(): Promise<WakeRoute> {
      const deadline = now() + timing.diskWaitMs;
      say("diagnose", "info", `Waiting up to ${Math.round(timing.diskWaitMs / 60_000)} minutes for boat.dev to finish restoring the disk.`);
      for (;;) {
        await sleep(timing.pollMs, signal);
        const next = await look();
        const nextRoute = routeWake(next);
        if (nextRoute.action !== "wait-for-disk" || now() >= deadline) {
          findings = next;
          route = nextRoute;
          if (nextRoute.action === "wait-for-disk") say("diagnose", "info", "boat.dev is still restoring the disk, but its files read fine: going on.");
          else say("diagnose", nextRoute.problem === "none" ? "done" : "info", findingText(nextRoute));
          return nextRoute;
        }
      }
    }

    /**
     * bb's update (src/bb-update.ts), when bb is installed there. It stops bb's
     * service for the install, so never under a connected machine (turns may run
     * there; bb's own update handles it), nor without a known machine unless the
     * install is broken. Returns whether it started bb's service itself.
     */
    async function updateBb(look: BbLook | null, last: WakeRoute): Promise<boolean> {
      if (look === null) {
        say("bb-update", "skipped", target.hostId === null ? "No bb on this sandbox to update." : "Boat couldn't look at bb's install there; bb's own setup checks it.");
        return false;
      }
      if (look.seen.dataDir === null) {
        say("bb-update", "skipped", "bb isn't installed on this sandbox.");
        return false;
      }
      const host = target.hostId === null ? null : await deps.machines.host(target.hostId).catch(() => null);
      if (host?.connected === true && host.phase !== "suspended") {
        say("bb-update", "skipped", "bb's machine is connected, so Boat leaves bb's install alone (bb updates itself).");
        return false;
      }
      if (target.hostId === null && last.problem !== "bb-broken") {
        say("bb-update", "skipped", "No bb machine is known on this sandbox, so Boat leaves bb's install there alone.");
        return false;
      }
      if (dry) {
        say("bb-update", look.plan.kind === "none" && !noDownload(look) ? "skipped" : "planned", bbPlanText(look, id));
        return false;
      }
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
          say("bb-update", "done", `Updated bb on the sandbox from ${result.from ?? "a broken install"} to ${result.to}.`);
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

    /** bb's service, then `bb machine resume` when bb has the machine suspended, and its connection. */
    async function machineBack(look: BbLook | null, serviceStarted: boolean): Promise<void> {
      const hostId = target.hostId;
      if (hostId === null) {
        say("machine", "skipped", "No bb machine runs on this sandbox.");
        return;
      }
      let host = await deps.machines.host(hostId).catch(() => null);
      if (host === null) {
        say("machine", "skipped", `bb doesn't know machine ${hostId} any more.`);
        return;
      }
      if (host.connected && host.phase !== "suspended") {
        say("machine", "done", `bb's machine ${hostId} is connected.`);
        return;
      }
      const unit = look?.seen.unit ?? null;
      if (dry) {
        if (unit !== null) say("bb-service", "planned", `Restart bb's service on the sandbox (${unit}).`);
        if (host.phase === "suspended") say("machine", "planned", `Resume bb's machine (\`bb machine resume ${hostId}\`).`);
        say("machine", "planned", `Wait up to ${Math.round(timing.connectWaitMs / 60_000)} minutes for bb's machine to connect.`);
        return;
      }
      if (serviceStarted) say("bb-service", "skipped", "bb's update started bb's service again.");
      else if (unit === null) say("bb-service", "skipped", "Boat couldn't find bb's service on the sandbox; bb's own setup starts it.");
      else {
        try {
          const said = /BOAT_UNIT (\S+)/.exec((await deps.boat.exec(id, serviceRestartScript(unit), { timeoutMs: 90_000, signal, login: false })).stdout)?.[1] ?? "unknown";
          say("bb-service", said === "active" || said === "activating" ? "done" : "failed", said === "active" || said === "activating" ? `Restarted bb's service (${unit}).` : `bb's service (${unit}) is ${said} after a restart.`);
        } catch (error) {
          signal.throwIfAborted();
          say("bb-service", "failed", `Boat couldn't restart bb's service (${firstLine(error)}).`);
        }
      }
      host = (await deps.machines.host(hostId).catch(() => null)) ?? host;
      if (host.phase === "suspended") {
        try {
          await deps.machines.resume(hostId);
          say("machine", "done", `Asked bb to resume its machine (\`bb machine resume ${hostId}\`).`);
        } catch (error) {
          signal.throwIfAborted();
          stop(`bb couldn't resume its machine ${hostId}: ${firstLine(error)}.`, [`bb machine resume ${hostId}`]);
        }
      }
      const deadline = now() + timing.connectWaitMs;
      for (;;) {
        host = (await deps.machines.host(hostId).catch(() => null)) ?? host;
        if (host.connected && host.phase !== "suspended") {
          say("machine", "done", `bb's machine ${hostId} is connected again.`);
          return;
        }
        if (now() >= deadline) {
          stop(`bb's machine ${hostId} didn't connect within ${Math.round(timing.connectWaitMs / 60_000)} minutes${host.message ? ` (bb says: ${clip(host.message, 200)})` : ""}.`, [
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

    const report = (outcome: WakeReport["outcome"], needsYou: WakeReport["needsYou"]): WakeReport => ({ target, dryRun: dry, outcome, route, findings, steps, needsYou });

    try {
      let sandbox = await deps.boat.findInfo(id, signal);
      if (sandbox === null) stop(`Sandbox ${id} no longer exists on boat.dev.`, [], { step: "sandbox" });
      if ((await deps.guard?.moving(id).catch(() => false)) === true) {
        stop(`Boat is moving sandbox ${id} to a new boat.dev node (its node keeps failing its disk). Let that finish, then wake it.`, [`bb boat sandbox info ${id}`], { step: "sandbox" });
      }
      // Asked for explicitly: Boat's own retry plan for it starts over (else bb's machine resume would be held back by it).
      if (!dry) await deps.guard?.forget(id).catch(() => undefined);
      sandbox = await settled(sandbox);
      say("sandbox", "info", `It's ${sandbox.state}.`);
      if (!ACTIVE_STATES.has(sandbox.state)) {
        if (TRANSITIONAL_STATES.has(sandbox.state)) say("sandbox", "planned", `Wait until it's done ${sandbox.state}, then look at it.`);
        else if (resumable(sandbox)) await start("resume");
        else stop(`Sandbox ${id} is ${sandbox.state}${sandbox.error ? ` (${clip(sandbox.error, 200)})` : ""}, so boat can't resume it.`, [`boat info ${id}`], { step: "sandbox" });
      }

      if (dry && !ACTIVE_STATES.has(sandbox.state)) {
        // Nothing to look at before it runs: the rest of the plan, in general.
        say("diagnose", "planned", "Then wait until boat's exec answers and look at the disk, the SSH login and bb's install there. A disk that's unreadable or stuck, or an npm zombie: stop it and start it again.");
        say("login-scripts", "planned", "Turn off the login message scripts, if any are still on.");
        if (target.hostId !== null) {
          say("bb-update", "planned", "Update bb there if it's older than the server or broken (from the server's download on the sandbox).");
          say("machine", "planned", "Restart bb's service, resume bb's machine if it's suspended, and wait until it connects.");
        }
        await retryChats();
        return report("planned", null);
      }

      // Look, and first fix what a stop and a start fixes.
      let next = tell(await look());
      if (next.action === "wait-for-disk" && !dry) next = await waitForDisk();
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
        if (target.hostId !== null) {
          say("bb-update", "planned", "Update bb there if it's older than the server or broken.");
          say("machine", "planned", "Restart bb's service, resume bb's machine if it's suspended, and wait until it connects.");
        }
      } else {
        if (dry) say("login-scripts", "planned", next.problem === "ssh-login-hang" ? "Turn off the login message scripts: they hang SSH logins while the disk restores." : "Turn off the login message scripts, if any are still on.");
        else {
          const quiet = await deps.quietLogins(id, signal);
          if (quiet === "disabled") say("login-scripts", "done", "Turned off the login message scripts.");
          else if (quiet === "failed") say("login-scripts", "failed", "Boat couldn't turn off the login message scripts (no sudo there?); bb's setup goes ahead.");
          else say("login-scripts", "skipped", "The login message scripts are off already.");
        }
        const bb = latest()?.bb ?? (await lookAtBb());
        const serviceStarted = await updateBb(bb, next);
        await machineBack(bb, serviceStarted);
      }
      await retryChats();
      return report(dry ? "planned" : "awake", null);
    } catch (error) {
      if (!(error instanceof WakeStop)) throw error;
      say(error.step ?? steps.at(-1)?.step ?? "sandbox", "needs-you", error.reason);
      return report("needs-you", { reason: error.reason, commands: error.commands, retryAt: error.retryAt });
    }
  }

  return { run, resolve: (input) => resolve(input) };
}

// ---------------------------------------------------------------- output

const ICON: Record<WakeStepStatus, string> = { done: "✓", skipped: "–", planned: "→", failed: "✗", info: "·", "needs-you": "!" };

/** The report as text (`bb boat sandbox wake`). */
export function wakeText(report: WakeReport): string {
  const lines: string[] = [];
  lines.push(report.dryRun ? `Dry run for sandbox ${report.target.sandboxId}: nothing was changed.` : `Waking sandbox ${report.target.sandboxId}.`);
  // The needs-you line is printed once, at the end.
  for (const step of report.steps) if (step.status !== "needs-you" || report.needsYou === null) lines.push(`${ICON[step.status]} ${step.text}`);
  if (report.needsYou !== null) {
    lines.push("", `Needs you: ${report.needsYou.reason}`);
    for (const command of report.needsYou.commands) lines.push(`    $ ${command}`);
  } else if (report.outcome === "awake") {
    lines.push("", "It's back.");
  } else if (report.outcome === "planned") {
    lines.push("", `Run it without --dry-run to do this: bb boat sandbox wake ${report.target.input}`);
  }
  return lines.join("\n");
}
