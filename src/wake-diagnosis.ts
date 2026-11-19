// Why a sandbox didn't wake, in plain words.
//
// After a wake, boat.dev restores the sandbox's disk lazily: the sandbox runs
// at once and boat's lazyfs (a FUSE filesystem) fetches files from storage
// when first read; the journal says `[SNAPSHOT-INC] lazy volume hydration in
// progress`. Seen while that goes wrong:
// - the storage fails: `[lazyfs] [ERROR] HYDRATOR FAILED …: status code 503`,
//   and files not fetched yet fail with EIO ("Input/output error"):
//   ~/.profile, ~/.bashrc, ~/.ssh/authorized_keys. `boat ssh` can't add its
//   key, so bb's setup there fails (boat's exec API still runs commands);
// - a read waits on lazyfs for good: a process in D state, its kernel stack
//   in `fuse_*` (bb's daemon "did not start within 20 seconds");
// - sshd takes the key, then the session never starts: PAM's login message
//   (`run-parts /etc/update-motd.d`, 90-updates-available) hangs on files
//   not restored yet. Every SSH try leaves one more stuck session;
// - boat refuses the restore ("Please reduce your request rate"), or the
//   sandbox's SSH doesn't answer at all.
import { clockTime } from "./format.ts";

export type WakeFailureKind = "disk-restoring" | "restore-rate-limited" | "ssh-session-stuck" | "ssh-unreachable" | "other";

export interface WakeDiagnosis {
  kind: WakeFailureKind;
  /** boat.dev's own words for it, or what the check saw (one line, clipped). */
  detail: string | null;
  /** The sandbox was looked at through boat's exec API. */
  checked: boolean;
}

const RATE_LIMITED = /reduce your request rate|too many requests|\brate[- ]limit(?:ed)?\b|\bslow ?down\b|status(?: code)?:? 429\b/i;
const HYDRATOR = /HYDRATOR FAILED|\[lazyfs\]|hydration in progress|\[SNAPSHOT-INC\]/i;
const EIO = /Input\/output error|\bEIO\b/i;
/** A kernel stack or wait channel of a read stuck on FUSE (boat's lazyfs). */
const FUSE_WAIT = /\bfuse_[a-z_]+|request_wait_answer/i;
const DISK = new RegExp(`${HYDRATOR.source}|${EIO.source}|${FUSE_WAIT.source}`, "i");
/** boat.dev's storage is failing (not just still restoring). */
const STORAGE_ERRORS = /HYDRATOR FAILED|Input\/output error|\bEIO\b|status code 5\d\d/i;
const MOTD = /update-motd/i;
const RESTORE = /(?:fail(?:ed|ure)? to|could ?n[o']t) restore|restore (?:failed|error)|resume failed/i;
const SSH = /not responding|exit status 255|ssh: connect to host|connection (?:refused|timed out|reset|closed)|kex_exchange_identification|ssh_exchange_identification|permission denied \(publickey|no route to host|host key verification failed|broken pipe/i;
/** Something waited and gave up (a session that never started, a daemon that never came up). */
const STALLED = /timed? ?out|timeout|did not start within|didn't start within/i;

/** What an error's text alone says (no look at the sandbox). */
export function classifyWakeText(text: string): WakeFailureKind {
  // The hydrator's own words first: its storage error may read like a rate limit (S3's SlowDown).
  if (HYDRATOR.test(text)) return "disk-restoring";
  if (RATE_LIMITED.test(text)) return "restore-rate-limited";
  if (EIO.test(text) || FUSE_WAIT.test(text)) return "disk-restoring";
  if (MOTD.test(text)) return "ssh-session-stuck";
  if (SSH.test(text)) return "ssh-unreachable";
  return "other";
}

/** Worth a look through boat's exec API: the disk, or a stuck login, may be what failed. */
export function needsDiskCheck(text: string): boolean {
  const kind = classifyWakeText(text);
  return kind === "disk-restoring" || kind === "ssh-unreachable" || kind === "ssh-session-stuck" || (kind === "other" && (RESTORE.test(text) || STALLED.test(text)));
}

const PATTERN: Record<WakeFailureKind, RegExp | null> = {
  "restore-rate-limited": RATE_LIMITED,
  "disk-restoring": DISK,
  "ssh-session-stuck": MOTD,
  "ssh-unreachable": SSH,
  other: RESTORE,
};

/** One line of boat.dev's words, without query strings (signed URLs) and clipped. */
export function cleanDetail(line: string, max = 300): string {
  const clean = line
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** The line of an error's text that shows its kind. */
export function wakeDetail(text: string, kind: WakeFailureKind): string | null {
  const pattern = PATTERN[kind];
  if (pattern === null) return null;
  const line = text.split("\n").find((entry) => pattern.test(entry));
  if (line === undefined) return null;
  // From lazyfs's own words on, when the line has them (journal prefixes say nothing).
  const own = [/HYDRATOR FAILED/i, /\[SNAPSHOT-INC\]/i, /\[lazyfs\]/i].map((mark) => line.search(mark)).find((at) => at >= 0) ?? -1;
  return cleanDetail(own > 0 ? line.slice(own) : line);
}

/** boat.dev's storage returns errors (not only still restoring). */
export function storageFailing(detail: string | null): boolean {
  return detail !== null && STORAGE_ERRORS.test(detail);
}

/**
 * The check, through boat's exec API (no SSH; run it with a plain `bash -c`,
 * not a login shell). Every step is capped; it stays well under boat exec's
 * timeout:
 * - processes stuck in D state, with their wait channel and the fuse_*
 *   frames of their kernel stack (sudo, when it's allowed);
 * - login message scripts running 20 seconds or more (an SSH session that
 *   never starts). "$M" keeps this script's own text from matching;
 * - the newest lazyfs lines in the journal: a hydrator failure (boat.dev's
 *   error) and "hydration in progress";
 * - one byte of files every sandbox has (EIO: not restored, storage failing).
 */
export const DISK_CHECK_SCRIPT = [
  // First what never reads the lazy disk (a stuck read below can't hide it).
  "M=update-motd",
  "timeout 5 ps -eo pid=,stat=,etimes=,wchan:40=,args= 2>/dev/null | head -n 2000 | while read -r pid stat age wchan args; do",
  '  case "$stat" in D*) S=$(timeout 2 sudo -n cat "/proc/$pid/stack" 2>/dev/null | grep -o \'fuse_[a-z_]*\' | head -n 4 | tr \'\\n\' \' \'); echo "BOAT_DSTATE $pid $wchan ${S:--} ${args:0:120}" ;; esac',
  '  case "$args" in "run-parts "*"$M"*|*"/$M.d/"*) [ "${age:-0}" -ge 20 ] 2>/dev/null && echo "BOAT_MOTD_HUNG $pid $age ${args:0:120}" ;; esac',
  "done | head -n 40",
  "J=$( { timeout 4 journalctl -b --since '-30 min' -n 4000 -o cat --no-pager -q 2>/dev/null; timeout 4 sudo -n journalctl -b --since '-30 min' -n 4000 -o cat --no-pager -q 2>/dev/null; } )",
  // lazyfs's own lines only: the patterns can't match their own text (the journal may log commands run).
  "H=$(printf '%s\\n' \"$J\" | grep -a -E '\\[lazyfs\\].*HYDRATOR FAILED attempt [0-9]' | tail -n 1 | cut -c1-600)",
  '[ -n "$H" ] && printf "BOAT_HYDRATOR %s\\n" "$H"',
  "P=$(printf '%s\\n' \"$J\" | grep -a -E '\\[SNAPSHOT-INC\\].*hydration in progress' | tail -n 1 | cut -c1-600)",
  '[ -n "$P" ] && printf "BOAT_HYDRATING %s\\n" "$P"',
  "for f in .profile .bashrc .ssh/authorized_keys; do",
  '  [ -e "$HOME/$f" ] || continue',
  '  if E=$(timeout -k 1 5 head -c 1 -- "$HOME/$f" 2>&1 >/dev/null); then echo "BOAT_DISK ok $f"; else echo "BOAT_DISK fail $f ${E:-no answer}"; fi',
  "done",
  "echo BOAT_DISK_END",
].join("\n");

export interface DiskCheck {
  /** Home files that failed with EIO. */
  unreadable: string[];
  /** The newest hydrator failure in the journal. */
  hydrator: string | null;
  /** The newest "hydration in progress" line in the journal. */
  hydrating: string | null;
  /** Processes stuck reading from lazyfs (D state in fuse_*), as "pid program (wait)". */
  fuseBlocked: string[];
  /** Login message scripts that hang (an SSH session that never starts). */
  motdHung: string[];
  /** The check ran to its end. */
  complete: boolean;
}

export function parseDiskCheck(stdout: string): DiskCheck {
  const check: DiskCheck = { unreadable: [], hydrator: null, hydrating: null, fuseBlocked: [], motdHung: [], complete: /^BOAT_DISK_END$/m.test(stdout) };
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const read = /^BOAT_DISK fail (\S+) (.*)$/.exec(line);
    if (read !== null && EIO.test(read[2]!)) check.unreadable.push(read[1]!);
    const failed = /^BOAT_HYDRATOR (.+)$/.exec(line);
    if (failed !== null) check.hydrator = wakeDetail(failed[1]!, "disk-restoring") ?? cleanDetail(failed[1]!);
    const hydrating = /^BOAT_HYDRATING (.+)$/.exec(line);
    if (hydrating !== null) check.hydrating = wakeDetail(hydrating[1]!, "disk-restoring") ?? cleanDetail(hydrating[1]!);
    const blocked = /^BOAT_DSTATE (\d+) (\S+) (.*)$/.exec(line);
    if (blocked !== null) {
      const [, pid, wchan, rest] = blocked;
      const frames = rest!.match(/\bfuse_[a-z_]+/g) ?? [];
      if (FUSE_WAIT.test(wchan!) || frames.length > 0) {
        const program = rest!.replace(/^(?:(?:fuse_[a-z_]+|-)\s+)*/, "").split(/\s+/)[0] ?? "?";
        check.fuseBlocked.push(`${pid} ${program.slice(program.lastIndexOf("/") + 1)} (${frames[0] ?? wchan})`);
      }
    }
    const hung = /^BOAT_MOTD_HUNG (\d+) (\d+) (.*)$/.exec(line);
    if (hung !== null) check.motdHung.push(cleanDetail(`${hung[3]} (${hung[2]}s)`, 160));
  }
  return check;
}

/** Runs DISK_CHECK_SCRIPT in the sandbox (null: it isn't running, so nothing to look at). */
export type DiskCheckRunner = () => Promise<{ stdout: string; stderr: string } | null>;

/**
 * Classify a failed wake: from the error's text, and, for a restore error,
 * EIO, an SSH failure or something that never started, from a look at the
 * sandbox. Storage errors win (they explain the rest), then a login that
 * hangs, then a disk still being restored. A failed look keeps the text's verdict.
 */
export async function diagnoseWakeFailure(error: unknown, check: DiskCheckRunner | null): Promise<WakeDiagnosis> {
  const text = error instanceof Error ? error.message : String(error);
  const kind = classifyWakeText(text);
  const fromText: WakeDiagnosis = { kind, detail: wakeDetail(text, kind), checked: false };
  if (check === null || !needsDiskCheck(text)) return fromText;
  let result: { stdout: string; stderr: string } | null;
  try {
    result = await check();
  } catch (failure) {
    // The look itself hit EIO (the login shell reads ~/.profile): that's the disk.
    const said = failure instanceof Error ? failure.message : String(failure);
    if (DISK.test(said)) return { kind: "disk-restoring", detail: fromText.kind === "disk-restoring" ? fromText.detail : wakeDetail(said, "disk-restoring"), checked: true };
    return fromText;
  }
  if (result === null) return fromText;
  const seen = parseDiskCheck(result.stdout);
  const textDetail = fromText.kind === "disk-restoring" ? fromText.detail : null;
  if (seen.hydrator !== null || seen.unreadable.length > 0) {
    return { kind: "disk-restoring", detail: seen.hydrator ?? textDetail ?? `${seen.unreadable.map((file) => `~/${file}`).join(", ")}: Input/output error`, checked: true };
  }
  if (seen.motdHung.length > 0) {
    return { kind: "ssh-session-stuck", detail: `login message script hangs: ${seen.motdHung[0]}`, checked: true };
  }
  if (seen.fuseBlocked.length > 0 || seen.hydrating !== null || fromText.kind === "disk-restoring") {
    const blocked = seen.fuseBlocked.length > 0 ? `waiting on a file not restored yet: ${seen.fuseBlocked.slice(0, 2).join(", ")}` : null;
    return { kind: "disk-restoring", detail: textDetail ?? blocked ?? seen.hydrating, checked: true };
  }
  return { ...fromText, checked: true };
}

/** What happens next, for the message. */
export interface WakePlan {
  /** Boat tries again then (null: it doesn't on its own). */
  retryAt: number | null;
  /**
   * Boat stopped retrying after this many failures (it's under Needs you);
   * a resume goes ahead again after resumeAfter.
   */
  gaveUpAfter?: number | null;
  resumeAfter?: number | null;
  sandboxId?: string;
  now?: number;
}

/**
 * The machine's failure message: what boat.dev is doing, and what Boat does
 * about it. Other failures keep their own text.
 */
export function wakeFailureMessage(diagnosis: WakeDiagnosis, plan: WakePlan, original: string): string {
  const when = plan.retryAt === null ? null : clockTime(plan.retryAt, plan.now);
  const gaveUp = plan.gaveUpAfter ?? null;
  const resumeLater = plan.resumeAfter ? ` Press Resume after ${clockTime(plan.resumeAfter, plan.now)}${plan.sandboxId ? `, or try now with \`bb boat sandbox resume ${plan.sandboxId}\`` : ""}.` : "";
  const next = when ? `Boat will retry at ${when}; pressing Resume earlier won't help.` : "Try again in a few minutes.";
  const why = storageFailing(diagnosis.detail) ? "its storage is returning errors" : "files bb needs there aren't readable yet";
  switch (diagnosis.kind) {
    case "disk-restoring":
      if (gaveUp !== null) return `boat.dev still couldn't restore this sandbox's disk after ${gaveUp} tries (${why}), so Boat stopped retrying on its own. It's under Needs you.${resumeLater}`;
      return `boat.dev is still restoring this sandbox's disk (${why}). ${next}`;
    case "restore-rate-limited":
      if (gaveUp !== null) return `boat.dev still refused to restore this sandbox after ${gaveUp} tries ("Please reduce your request rate"), so Boat stopped retrying on its own. It's under Needs you.${resumeLater}`;
      return `boat.dev is restoring too many sandboxes at once and asked Boat to slow down. ${next}`;
    case "ssh-session-stuck":
      if (gaveUp !== null) return `The sandbox still took Boat's SSH login without starting the session after ${gaveUp} tries (its login message scripts hang while boat.dev restores the disk), so Boat stopped retrying on its own. It's under Needs you.${resumeLater}`;
      return `The sandbox took Boat's SSH login, but the session never started: its login message scripts hang while boat.dev restores the disk. Boat turns them off before each try. ${next}`;
    case "ssh-unreachable":
      return `Boat couldn't reach the sandbox over SSH to restart bb there${diagnosis.detail ? ` (${diagnosis.detail})` : ""}. Press Resume to try again; if it keeps failing, check the sandbox on boat.dev.`;
    case "other":
      return original;
  }
}

/** Kinds Boat retries on its own, later and with backoff. */
export type RetriedKind = "disk-restoring" | "restore-rate-limited" | "ssh-session-stuck";
export function retriesLater(kind: WakeFailureKind): kind is RetriedKind {
  return kind === "disk-restoring" || kind === "restore-rate-limited" || kind === "ssh-session-stuck";
}
