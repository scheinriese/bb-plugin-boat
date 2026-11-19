// Move a sandbox off a boat.dev node that keeps failing its disk.
//
// Seen live: one sandbox's lazyfs failed the same object for a day
// (`HYDRATOR FAILED attempt 77 …: chunk 1 GET 0000.tar.zst: status code
// 503`, through that host's relay), and a plain `boat stop` was refused
// (boat won't snapshot a disk it hasn't finished restoring). A fork of the
// same sandbox restored fine on another node, and `boat stop --force`
// (keeps the last completed snapshot) and a resume brought the original
// back on a new node, readable, with bb reconnected. So, once Boat itself
// has seen the same failure for a while:
// 1. check the snapshot with a short-lived fork (`boat fork <id>
//    --no-snapshots --ttl 600 --wait`), read a few files there, delete it;
//    without a clear "it reads fine", nothing is forced;
// 2. stop the sandbox with a plain `boat stop` (a fresh snapshot, nothing
//    lost), follow that stop with `boat stop --status`, and force it only
//    once boat says it failed or the sandbox stayed up;
// 3. resume it: it lands on a new node.
// --force drops what was written since the last completed snapshot, so it
// runs on its own only when nothing there could be lost: no chat or task
// mid-turn, no background work, and no checkout in the sandbox with
// unpushed commits (any branch), changes (untracked too) or stashes.
// Otherwise the user decides (Needs you, with the commands and what's lost).
import { hasWork, isOpen, rowWork, turnRuns, type ThreadRow } from "./activity.ts";
import type { BoatApi, StopReport } from "./boat-api.ts";
import { clockTime } from "./format.ts";
import type { Task } from "./store.ts";
import { DISK_CHECK_SCRIPT, parseDiskCheck } from "./wake-diagnosis.ts";
import type { WakePacer } from "./wake-pacer.ts";

/** Boat has seen the same hydrator failure for longer than this… */
export const STUCK_AFTER_MS = 15 * 60_000;
/** …in at least this many of its own looks: the node won't get past it. */
export const STUCK_SEEN = 3;

export interface HydratorFailure {
  /** lazyfs's own attempt counter (null: not given). Told, never decided on. */
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
  /** The highest attempt count lazyfs gave (for the message only). */
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

/**
 * Stuck on its node: Boat's own looks saw the same object fail at least
 * STUCK_SEEN times, over more than 15 minutes. lazyfs's counter doesn't
 * count: an account-wide storage outage shows high counts everywhere, and
 * moving sandboxes then only adds load.
 */
export function stuckOnNode(track: HydratorTrack | null | undefined, now: number): boolean {
  if (!track) return false;
  return track.seen >= STUCK_SEEN && now - track.firstAt > STUCK_AFTER_MS;
}

/** One git checkout's work that a forced stop could lose (null fields: couldn't tell). */
export interface GitState {
  /** Commits on no origin branch, on any local branch or HEAD. */
  unpushed: number;
  /** Changes not committed, untracked files included. */
  dirty: boolean;
  stashes: number;
}

/** The git checks for the checkout in "$d" (a shell snippet: one BOAT_GIT… line). */
function gitCheck(prefix: string): string {
  return [
    'H=HEAD; timeout 5 git -C "$d" rev-parse -q --verify HEAD >/dev/null 2>&1 || H=',
    'if D=$(timeout 10 git -C "$d" status --porcelain 2>/dev/null) && U=$(timeout 10 git -C "$d" rev-list --count $H --branches --not --remotes=origin 2>/dev/null) && T=$(timeout 5 git -C "$d" stash list 2>/dev/null); then',
    '  X=0; [ -n "$D" ] && X=1; S=$(printf "%s" "$T" | grep -c .)',
    `  echo "${prefix} ahead=$U dirty=$X stash=$S$SUFFIX"`,
    `else echo "${prefix} unknown$SUFFIX"; fi`,
  ].join("\n");
}

/** In one task's checkout, no network (no fetch). */
export function gitStateScript(repoPath: string): string {
  const path = `'${repoPath.replace(/'/g, `'\\''`)}'`;
  return [`d=${path}; SUFFIX=`, '[ -d "$d" ] || { echo "BOAT_GIT none"; exit 0; }', gitCheck("BOAT_GIT")].join("\n");
}

/** null: couldn't tell; "none": no checkout there (nothing of git's to lose). */
export function parseGitState(stdout: string): GitState | "none" | null {
  if (/^BOAT_GIT none$/m.test(stdout)) return "none";
  const match = /^BOAT_GIT ahead=(\d+) dirty=([01]) stash=(\d+)$/m.exec(stdout);
  return match === null ? null : { unpushed: Number(match[1]), dirty: match[2] === "1", stashes: Number(match[3]) };
}

/**
 * Every git checkout in the sandbox's home (tasks' and bb's workspaces and
 * worktrees, a chat's clone): at most 40, 7 levels deep, without package and
 * tool caches. A scan that couldn't finish says so: then nothing counts as safe.
 */
export const CHECKOUTS_SCRIPT = [
  "L=$(timeout 15 find \"$HOME\" -maxdepth 7 \\( -name node_modules -o -name .cache -o -name .npm -o -name .nvm -o -name .cargo -o -name .rustup \\) -prune -o -name .git -prune -print 2>/dev/null); R=$?",
  '[ "$R" = 0 ] || echo "BOAT_GIT_SCAN_INCOMPLETE $R"',
  'N=$(printf "%s\\n" "$L" | grep -c .)',
  '[ "$N" -le 40 ] || echo "BOAT_GIT_SCAN_INCOMPLETE $N checkouts"',
  'printf "%s\\n" "$L" | grep . | head -n 40 | while IFS= read -r g; do',
  '  d=${g%/.git}; SUFFIX=" $d"',
  gitCheck("BOAT_GIT_AT").replace(/^/gm, "  "),
  "done",
  "echo BOAT_GIT_SCAN_END",
].join("\n");

export interface Checkout {
  path: string;
  /** null: git couldn't tell. */
  git: GitState | null;
}

export function parseCheckouts(stdout: string): { checkouts: Checkout[]; complete: boolean } {
  const checkouts: Checkout[] = [];
  for (const line of stdout.split("\n")) {
    const known = /^BOAT_GIT_AT ahead=(\d+) dirty=([01]) stash=(\d+) (.+)$/.exec(line);
    if (known !== null) checkouts.push({ path: known[4]!, git: { unpushed: Number(known[1]), dirty: known[2] === "1", stashes: Number(known[3]) } });
    const unknown = /^BOAT_GIT_AT unknown (.+)$/.exec(line);
    if (unknown !== null) checkouts.push({ path: unknown[1]!, git: null });
  }
  return { checkouts, complete: /^BOAT_GIT_SCAN_END$/m.test(stdout) && !/^BOAT_GIT_SCAN_INCOMPLETE/m.test(stdout) };
}

/** A Boat task on the sandbox, as far as a forced stop could lose its work. */
export interface MoveTaskFacts {
  id: string;
  title: string;
  status: string;
  /** Its checkout (null: none known; the sandbox's scan covers it). */
  repoPath: string | null;
  /** push delivery: commits not shipped yet, as the plugin last counted them. */
  unshipped: number | null;
}

export interface MoveFacts {
  tasks: MoveTaskFacts[];
  /** The sandbox's checkouts (null: the scan failed). */
  checkouts: { checkouts: Checkout[]; complete: boolean } | null;
  /** bb's chats on the machine (null: couldn't tell). */
  threads: ThreadRow[] | null;
}

/** "/home/user/work/web" → "~/work/web". */
function shortPath(path: string): string {
  return path.replace(/^\/home\/[^/]+\//, "~/").replace(/^\/root\//, "~/");
}

function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Is it safe to drop what was written since the last snapshot? The reasons it isn't. */
export function moveDecision(facts: MoveFacts): { auto: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const owners = new Map(facts.tasks.filter((task) => task.repoPath !== null).map((task) => [task.repoPath!.replace(/\/+$/, ""), task]));
  for (const task of facts.tasks) {
    if (task.status === "running" || task.status === "starting") reasons.push(`task ${task.id} is mid-turn`);
    if ((task.unshipped ?? 0) > 0) reasons.push(`task ${task.id} has ${task.unshipped} commit${task.unshipped === 1 ? "" : "s"} not shipped yet`);
  }
  if (facts.threads === null) reasons.push("Boat couldn't see which chats run there");
  else {
    for (const row of facts.threads) {
      if (!isOpen(row)) continue;
      const name = row.title ? `the chat "${clip(row.title)}"` : "a chat there";
      if (turnRuns(row) || row.hasPendingInteraction === true) reasons.push(`${name} is mid-turn`);
      else if (hasWork(rowWork(row))) reasons.push(`${name} has background work running`);
    }
  }
  if (facts.checkouts === null || !facts.checkouts.complete) reasons.push("Boat couldn't check every git checkout in the sandbox");
  for (const checkout of facts.checkouts?.checkouts ?? []) {
    const task = owners.get(checkout.path.replace(/\/+$/, ""));
    const name = task ? `task ${task.id}` : shortPath(checkout.path);
    if (checkout.git === null) {
      reasons.push(`Boat couldn't check ${task ? `${name}'s branch` : name}`);
      continue;
    }
    if (checkout.git.unpushed > 0) reasons.push(`${name} has ${checkout.git.unpushed} unpushed commit${checkout.git.unpushed === 1 ? "" : "s"}`);
    if (checkout.git.dirty) reasons.push(`${name} has changes that aren't committed`);
    if (checkout.git.stashes > 0) reasons.push(`${name} has ${checkout.git.stashes} stash${checkout.git.stashes === 1 ? "" : "es"}`);
  }
  // A task's checkout the scan didn't reach (outside the home folder, too deep).
  const scanned = new Set((facts.checkouts?.checkouts ?? []).map((checkout) => checkout.path.replace(/\/+$/, "")));
  for (const [path, task] of owners) if (facts.checkouts !== null && !scanned.has(path)) reasons.push(`Boat couldn't check task ${task.id}'s branch`);
  return { auto: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** The facts for moveDecision: the live tasks from the plugin's records, the checkouts and chats from the sandbox and bb. */
export async function moveFacts(
  boat: Pick<BoatApi, "exec">,
  sandboxId: string,
  tasks: readonly Task[],
  threads: (() => Promise<ThreadRow[]>) | null,
  signal?: AbortSignal,
): Promise<MoveFacts> {
  let checkouts: MoveFacts["checkouts"] = null;
  try {
    checkouts = parseCheckouts((await boat.exec(sandboxId, CHECKOUTS_SCRIPT, { timeoutMs: 120_000, signal, login: false })).stdout);
  } catch {
    checkouts = null;
  }
  let rows: ThreadRow[] | null = null;
  if (threads !== null) {
    try {
      rows = await threads();
    } catch {
      rows = null;
    }
  }
  return {
    tasks: tasks.map((task) => ({ id: task.id, title: task.title, status: task.status, repoPath: task.repoPath, unshipped: task.delivery === "push" ? task.unshipped : null })),
    checkouts,
    threads: rows,
  };
}

/** What a test fork says about the snapshot: it restores and reads fine, it doesn't, or couldn't tell. */
export type ForkCheck = "healthy" | "unreadable" | "unknown" | "skipped";

export type MoveBoat = Pick<BoatApi, "exec" | "fork" | "delete" | "stop" | "stopStatus" | "lastSnapshotAt">;

/**
 * Restore the sandbox's latest snapshot on another node (a fork that's never
 * snapshotted and lives 10 minutes at most), read a few files there, then
 * delete the fork. A fork that can't be made says nothing about the
 * snapshot ("unknown"). A fork whose `boat fork --wait` timed out or was
 * aborted before boat named it can't be deleted here: its --ttl ends it.
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

const STOPPED = new Set(["stopped", "archived"]);
const UP = new Set(["provisioned", "cloning", "ready", "idle", "running"]);

/**
 * Where a stop stands, from boat's report of it and the sandbox's state:
 * stopped; refused (boat said it failed, or the sandbox is up and boat says
 * nothing more); pending (boat still works on it: wait and ask its status
 * again, never stop again); superseded (another stop replaced it).
 */
export function stopOutcome(report: StopReport, state: string | null): "stopped" | "refused" | "pending" | "superseded" {
  const status = report.status?.toLowerCase() ?? null;
  if (state !== null && STOPPED.has(state)) return "stopped";
  if (status !== null && /^(fail|refus|error)/.test(status)) return "refused";
  if (status === "superseded") return "superseded";
  if (status === "pending" || status === "running" || status === "in_progress") return "pending";
  // Completed, or nothing said: the sandbox's state tells.
  if (state !== null && UP.has(state)) return "refused";
  return "pending";
}

/** A forced stop: done, or boat handed back a stop still pending (forced false). */
export function forcedOutcome(report: StopReport, state: string | null): "stopped" | "pending" {
  if (state !== null && STOPPED.has(state)) return "stopped";
  return "pending";
}

/** The commands that move it by hand. */
export function moveCommands(sandboxId: string): string {
  return `\`boat stop ${sandboxId}\` (if boat refuses it, \`boat stop ${sandboxId} --force\`), then \`bb boat sandbox resume ${sandboxId}\``;
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
      return " Boat couldn't check the snapshot with a test fork.";
    case "unreadable":
      return " A test fork from the same snapshot couldn't read its files either.";
    case "skipped":
      return "";
  }
}

/** The machine's message while Boat moves it (or asks first). */
export function movingMessage(track: HydratorTrack | null | undefined, now: number): string {
  const how = track ? ` (Boat saw the same file fail ${track.seen} times since ${clockTime(track.firstAt, now)})` : "";
  return `boat.dev keeps failing to restore this sandbox's disk on the node it runs on${how}. Boat moves it to a new node if nothing there could be lost, else asks you first under Needs you.`;
}

/** Needs you: move it by hand, and what that loses. */
export function moveQuestion(input: { sandboxId: string; snapshotAt: string | null; reasons: readonly string[]; detail: string | null; fork: ForkCheck; now: number }) {
  const since = snapshotText(input.snapshotAt, input.now);
  return {
    question: `Sandbox ${input.sandboxId} is stuck on a boat.dev node that keeps failing its disk. Move it to a new node? If boat can't take a fresh snapshot, that loses what changed there since ${since}.`,
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
