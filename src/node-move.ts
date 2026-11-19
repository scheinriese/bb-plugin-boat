// Move a sandbox off a boat.dev node that keeps failing its disk.
//
// Seen live: one sandbox's lazyfs failed the same object for a day
// (`HYDRATOR FAILED attempt 77 …: chunk 1 GET 0000.tar.zst: status code
// 503`, through that host's relay), and a plain `boat stop` was refused
// (boat won't snapshot a disk it hasn't finished restoring). A fork of the
// same sandbox restored fine on another node, and `boat stop --force`
// (keeps the last completed snapshot) and a resume brought the original
// back on a new node, readable, with bb reconnected. So when that happens:
// 1. check the snapshot with a short-lived fork (`boat fork <id>
//    --no-snapshots --ttl 600 --wait`), read a few files there, delete it;
// 2. force-stop the sandbox, then resume it: it lands on a new node.
// --force drops what was written since the last completed snapshot, so it
// runs on its own only for an orchestrator's or a plain bb machine's
// sandbox, or when no task there is mid-turn or has work that isn't pushed;
// otherwise the user decides (Needs you, with the commands and what's lost).
import type { BoatApi } from "./boat-api.ts";
import { clockTime } from "./format.ts";
import type { Task } from "./store.ts";
import { DISK_CHECK_SCRIPT, parseDiskCheck } from "./wake-diagnosis.ts";
import type { WakePacer } from "./wake-pacer.ts";

/** The same hydrator failure this long: the node won't get past it. */
export const STUCK_AFTER_MS = 15 * 60_000;
/** …or this many attempts on the same object. */
export const STUCK_ATTEMPTS = 5;

export interface HydratorFailure {
  /** lazyfs's own attempt counter (null: not given). */
  attempt: number | null;
  /** What it fails to fetch ("chunk 1 GET 0000.tar.zst"; null: not given). */
  object: string | null;
}

/** lazyfs's failure line: "HYDRATOR FAILED attempt 77 (…): decode/feed: chunk 1 GET 0000.tar.zst: status code 503". */
export function parseHydratorFailure(detail: string | null): HydratorFailure | null {
  if (detail === null || !/HYDRATOR FAILED/i.test(detail)) return null;
  const attempt = /HYDRATOR FAILED attempt (\d+)/i.exec(detail)?.[1];
  const object = /\b(chunk \d+ GET [^\s:]+)/i.exec(detail)?.[1] ?? /\bGET ([^\s:]+)/i.exec(detail)?.[1] ?? null;
  return { attempt: attempt === undefined ? null : Number(attempt), object };
}

/** The same failure, followed across Boat's looks at it. */
export interface HydratorTrack {
  object: string | null;
  /** When Boat first saw it fail on this object. */
  firstAt: number;
  /** The highest attempt count lazyfs gave. */
  attempts: number;
  /** How many of Boat's looks saw it. */
  seen: number;
}

export function trackHydrator(previous: HydratorTrack | null | undefined, failure: HydratorFailure, now: number): HydratorTrack {
  if (previous && previous.object === failure.object) {
    return { object: previous.object, firstAt: previous.firstAt, attempts: Math.max(previous.attempts, failure.attempt ?? 0), seen: previous.seen + 1 };
  }
  return { object: failure.object, firstAt: now, attempts: failure.attempt ?? 0, seen: 1 };
}

/** The node keeps failing the same object: more than 15 minutes, or 5 attempts or more. */
export function stuckOnNode(track: HydratorTrack | null | undefined, now: number): boolean {
  if (!track) return false;
  return now - track.firstAt > STUCK_AFTER_MS || Math.max(track.attempts, track.seen) >= STUCK_ATTEMPTS;
}

/** A task's checkout, as far as a force stop could lose it. */
export interface MoveTaskFacts {
  id: string;
  title: string;
  status: string;
  /** Commits on no origin branch (null: couldn't tell). */
  unpushed: number | null;
  /** Changes not committed (null: couldn't tell). */
  dirty: boolean | null;
  /** push delivery: commits not shipped yet, as the plugin last counted them. */
  unshipped: number | null;
}

/** Is it safe to drop what was written since the last snapshot? The reasons it isn't. */
export function moveDecision(tasks: readonly MoveTaskFacts[]): { auto: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const task of tasks) {
    const name = `task ${task.id}`;
    if (task.status === "running" || task.status === "starting") reasons.push(`${name} is mid-turn`);
    if ((task.unshipped ?? 0) > 0) reasons.push(`${name} has ${task.unshipped} commit${task.unshipped === 1 ? "" : "s"} not shipped yet`);
    if (task.unpushed === null || task.dirty === null) reasons.push(`Boat couldn't check ${name}'s branch`);
    else {
      if (task.unpushed > 0) reasons.push(`${name} has ${task.unpushed} unpushed commit${task.unpushed === 1 ? "" : "s"}`);
      if (task.dirty) reasons.push(`${name} has changes that aren't committed`);
    }
  }
  return { auto: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** In a task's checkout: commits on no origin branch and uncommitted changes. No network (no fetch). */
export function gitStateScript(repoPath: string): string {
  const path = `'${repoPath.replace(/'/g, `'\\''`)}'`;
  return [
    `cd ${path} 2>/dev/null || { echo "BOAT_GIT none"; exit 0; }`,
    'D=$(timeout 10 git status --porcelain --untracked-files=no 2>/dev/null) || { echo "BOAT_GIT unknown"; exit 0; }',
    'U=$(timeout 10 git rev-list --count HEAD --not --remotes=origin 2>/dev/null) || { echo "BOAT_GIT unknown"; exit 0; }',
    'if [ -n "$D" ]; then echo "BOAT_GIT ahead=$U dirty=1"; else echo "BOAT_GIT ahead=$U dirty=0"; fi',
  ].join("\n");
}

/** null: couldn't tell; "none": no checkout there (nothing to lose). */
export function parseGitState(stdout: string): { unpushed: number; dirty: boolean } | "none" | null {
  if (/^BOAT_GIT none$/m.test(stdout)) return "none";
  const match = /^BOAT_GIT ahead=(\d+) dirty=([01])$/m.exec(stdout);
  return match === null ? null : { unpushed: Number(match[1]), dirty: match[2] === "1" };
}

/** What a test fork says about the snapshot: it restores and reads fine, it doesn't, or couldn't tell. */
export type ForkCheck = "healthy" | "unreadable" | "unknown" | "skipped";

export type MoveBoat = Pick<BoatApi, "exec" | "fork" | "delete" | "stop" | "lastSnapshotAt">;

/** The facts the decision needs: each live task's state and, from the sandbox, its branch. */
export async function taskFacts(boat: Pick<BoatApi, "exec">, sandboxId: string, tasks: readonly Task[], signal?: AbortSignal): Promise<MoveTaskFacts[]> {
  const facts: MoveTaskFacts[] = [];
  for (const task of tasks) {
    let git: ReturnType<typeof parseGitState> = null;
    if (task.repoPath === null) git = "none";
    else {
      try {
        git = parseGitState((await boat.exec(sandboxId, gitStateScript(task.repoPath), { timeoutMs: 30_000, signal, login: false })).stdout);
      } catch {
        git = null;
      }
    }
    facts.push({
      id: task.id,
      title: task.title,
      status: task.status,
      unpushed: git === "none" ? 0 : (git?.unpushed ?? null),
      dirty: git === "none" ? false : (git?.dirty ?? null),
      unshipped: task.delivery === "push" ? task.unshipped : null,
    });
  }
  return facts;
}

/**
 * Restore the sandbox's latest snapshot on another node (a fork that's never
 * snapshotted and lives 10 minutes at most), read a few files there, then
 * delete the fork. A fork that can't be made says nothing about the snapshot.
 */
export async function forkCheck(boat: MoveBoat, sandboxId: string, options: { pacer?: WakePacer; signal?: AbortSignal; log?: (line: string) => void } = {}): Promise<ForkCheck> {
  let forkId: string | null = null;
  try {
    const permit = await options.pacer?.acquire({ signal: options.signal, maxWaitMs: 0 });
    try {
      forkId = (await boat.fork(sandboxId, { noSnapshots: true, ttlSeconds: 600, signal: options.signal })).id;
      await permit?.succeeded();
    } catch (error) {
      // Started but failed: delete what boat made.
      forkId = (error as { forkId?: string | null }).forkId ?? null;
      await permit?.failed();
      throw error;
    }
    const seen = parseDiskCheck((await boat.exec(forkId, DISK_CHECK_SCRIPT, { timeoutMs: 30_000, signal: options.signal, login: false })).stdout);
    if (!seen.complete) return "unknown";
    return seen.unreadable.length === 0 && seen.hydrator === null ? "healthy" : "unreadable";
  } catch (error) {
    options.log?.(`node move: test fork of ${sandboxId}: ${error instanceof Error ? error.message : String(error)}`);
    return "unknown";
  } finally {
    if (forkId !== null) await boat.delete(forkId).catch((error: unknown) => options.log?.(`node move: delete test fork ${forkId}: ${error instanceof Error ? error.message : String(error)}`));
  }
}

/** The commands that move it by hand. */
export function moveCommands(sandboxId: string): string {
  return `\`boat stop ${sandboxId} --force\`, then \`bb boat sandbox resume ${sandboxId}\``;
}

/** "00:41 UTC (its last completed snapshot)", or what's known of it. */
export function snapshotText(snapshotAt: string | null, now: number): string {
  const at = snapshotAt === null ? NaN : Date.parse(snapshotAt);
  return Number.isFinite(at) ? `${clockTime(at, now)} (its last completed snapshot)` : "its last completed snapshot (boat didn't say when)";
}

export function forkText(check: ForkCheck): string {
  switch (check) {
    case "healthy":
      return " A test fork from the same snapshot restored fine on another node.";
    case "unknown":
      return " Boat couldn't make a test fork to check the snapshot.";
    case "unreadable":
      return " A test fork from the same snapshot couldn't read its files either.";
    case "skipped":
      return "";
  }
}

/** The machine's message while Boat moves it (or asks first). */
export function movingMessage(track: HydratorTrack | null | undefined, now: number): string {
  const how = track && track.attempts > 0 ? ` (the same file failed ${track.attempts} times since ${clockTime(track.firstAt, now)})` : "";
  return `boat.dev keeps failing to restore this sandbox's disk on the node it runs on${how}. Boat moves it to a new node now, or asks you first under Needs you if unsaved work could be lost.`;
}

/** Needs you: move it by hand, and what that loses. */
export function moveQuestion(input: { sandboxId: string; snapshotAt: string | null; reasons: readonly string[]; detail: string | null; fork: ForkCheck; now: number }) {
  const since = snapshotText(input.snapshotAt, input.now);
  return {
    question: `Sandbox ${input.sandboxId} is stuck on a boat.dev node that keeps failing its disk. Move it to a new node? That loses what changed there since ${since}.`,
    recommendation: `Move it if nothing written since then matters: run ${moveCommands(input.sandboxId)}. Boat didn't do it itself because ${input.reasons.join("; ")}. Otherwise wait for boat.dev to recover.`,
    options: ["Move it now", "Wait for boat.dev"],
    context: `boat.dev said: ${input.detail ?? "(no details)"}.${forkText(input.fork)}`,
    shortLabel: "Sandbox stuck on a node",
  };
}

/** Needs you: the snapshot itself doesn't restore, so a move wouldn't help. */
export function brokenSnapshotQuestion(input: { sandboxId: string; detail: string | null }) {
  return {
    question: `Sandbox ${input.sandboxId}'s disk doesn't restore, on its node or on a new one (a test fork couldn't read its files either). What now?`,
    recommendation: `Leave it and report it to boat.dev with the error below. Don't force-stop it: that keeps only the snapshot that doesn't restore.`,
    options: ["Report it to boat.dev", "Leave it for now"],
    context: `boat.dev said: ${input.detail ?? "(no details)"}.`,
    shortLabel: "Sandbox won't restore",
  };
}
