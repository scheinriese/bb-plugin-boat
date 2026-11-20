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
// boat may also refuse the resume for the sandbox's size: its data doesn't
// fit (src/disk-trim.ts).
import { clockTime } from "./format.ts";
import { DISK_TOO_LARGE, diskTooLarge, tooLargeMessage, type DiskTooLarge } from "./disk-trim.ts";

export type WakeFailureKind = "disk-restoring" | "restore-rate-limited" | "ssh-session-stuck" | "daemon-broken" | "disk-too-large" | "ssh-unreachable" | "other";

export interface WakeDiagnosis {
  kind: WakeFailureKind;
  /** boat.dev's own words for it, or what the check saw (one line, clipped). */
  detail: string | null;
  /** The sandbox was looked at through boat's exec API. */
  checked: boolean;
  /**
   * daemon-broken: bb's machine folder and daemon unit there (a best guess
   * when there are several: daemonRepairQuestion picks by host id), whether
   * an npm zombie remains, and every folder and unit seen.
   */
  daemon?: { dir: string | null; unit: string | null; zombie: boolean; dirs?: string[]; units?: string[] };
  /** disk-too-large: what boat said of the sandbox's data and its size. */
  size?: DiskTooLarge;
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
  if (DISK_TOO_LARGE.test(text)) return "disk-too-large";
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
  "daemon-broken": null,
  "disk-too-large": DISK_TOO_LARGE,
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
  // bb's auto-update: an npm install left as a zombie ("[npm install …] <defunct>", state Zl).
  '  case "$stat" in Z*) case "$args" in *npm*) echo "BOAT_ZOMBIE $pid $stat ${args:0:120}" ;; esac ;; esac',
  "done | head -n 40",
  // bb's daemon unit (a user unit) stuck stopping.
  "timeout 3 env XDG_RUNTIME_DIR=\"/run/user/$(id -u)\" systemctl --user list-units --all --no-legend --plain 'bb-host-daemon*' 2>/dev/null | head -n 5 | while read -r unit load active sub rest; do echo \"BOAT_UNIT $unit $active $sub\"; done",
  // bb's machine folders, and whether the daemon's installed entry point is there ("$B" keeps this text from matching the journal check).
  'B=bb-ap; for d in "$HOME"/.bb-machines/*/; do [ -d "$d" ] || continue; echo "BOAT_BB_DIR ${d%/}"; [ -d "${d}npm" ] && [ ! -e "${d}npm/bin/${B}p" ] && echo "BOAT_BB_MISSING ${d%/}"; done',
  "J=$( { timeout 4 journalctl -b --since '-30 min' -n 4000 -o cat --no-pager -q 2>/dev/null; timeout 4 sudo -n journalctl -b --since '-30 min' -n 4000 -o cat --no-pager -q 2>/dev/null; } )",
  // The daemon's own log only (a command someone ran can't pass for it).
  "K=$(timeout 4 env XDG_RUNTIME_DIR=\"/run/user/$(id -u)\" journalctl --user -u 'bb-host-daemon*' -b --since '-30 min' -n 400 -o cat --no-pager -q 2>/dev/null)",
  // lazyfs's own lines only: the patterns can't match their own text (the journal may log commands run).
  "H=$(printf '%s\\n' \"$J\" | grep -a -E '\\[lazyfs\\].*HYDRATOR FAILED attempt [0-9]' | tail -n 1 | cut -c1-600)",
  '[ -n "$H" ] && printf "BOAT_HYDRATOR %s\\n" "$H"',
  "P=$(printf '%s\\n' \"$J\" | grep -a -E '\\[SNAPSHOT-INC\\].*hydration in progress' | tail -n 1 | cut -c1-600)",
  '[ -n "$P" ] && printf "BOAT_HYDRATING %s\\n" "$P"',
  // The daemon failing to load after an update (the bracket keeps the pattern from matching its own text).
  "Q=$(printf '%s\\n' \"$K\" | grep -a -E 'MODULE_NOT_FOUN[D]|Cannot find modul[e]|npm/bin/bb-ap[p]' | tail -n 1 | cut -c1-400)",
  '[ -n "$Q" ] && printf "BOAT_BB_LOG %s\\n" "$Q"',
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
  /** bb's daemon after an update: an npm install zombie, its unit stuck deactivating, a module it can't load or its missing entry point. */
  daemon: { zombies: string[]; units: { unit: string; active: string; sub: string }[]; log: string | null; missing: string[]; dirs: string[] };
  /** The check ran to its end. */
  complete: boolean;
}

/** bb's daemon broke during an update (what the check saw says so). */
export function daemonBroken(check: DiskCheck): boolean {
  const daemon = check.daemon;
  // A unit only "deactivating" isn't enough: npm blocked on a disk still restoring looks the same, and waiting fixes that.
  return daemon.zombies.length > 0 || daemon.log !== null || daemon.missing.length > 0;
}

/** "acme.example.com" → "acme-example-com", as bb names its units. */
function dashed(text: string): string {
  return text.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The daemon unit and machine folder of this bb machine: its unit is
 * bb-host-daemon-<server with dashes>-<host id>.service, the server being
 * the folder's name under ~/.bb-machines. Without a match, the only one there
 * is, else none (the repair text says how to find it).
 */
export function pickDaemon(daemon: { dirs: readonly string[]; units: readonly string[] }, hostId: string | null): { dir: string | null; unit: string | null } {
  const server = (dir: string) => dashed(dir.replace(/\/+$/, "").split("/").at(-1) ?? "");
  const dirOf = (unit: string) => daemon.dirs.find((dir) => unit.startsWith(`bb-host-daemon-${server(dir)}-`)) ?? (daemon.dirs.length === 1 ? daemon.dirs[0]! : null);
  if (hostId) {
    const hosts = [...new Set([hostId, dashed(hostId)])];
    for (const dir of daemon.dirs) {
      const unit = daemon.units.find((name) => hosts.some((host) => name === `bb-host-daemon-${server(dir)}-${host}.service`));
      if (unit !== undefined) return { dir, unit };
    }
    const byHost = daemon.units.filter((name) => hosts.some((host) => name.endsWith(`-${host}.service`)));
    if (byHost.length === 1) return { dir: dirOf(byHost[0]!), unit: byHost[0]! };
  }
  if (daemon.units.length === 1) return { dir: dirOf(daemon.units[0]!), unit: daemon.units[0]! };
  return { dir: daemon.dirs.length === 1 ? daemon.dirs[0]! : null, unit: null };
}

export function parseDiskCheck(stdout: string): DiskCheck {
  const check: DiskCheck = { unreadable: [], hydrator: null, hydrating: null, fuseBlocked: [], motdHung: [], daemon: { zombies: [], units: [], log: null, missing: [], dirs: [] }, complete: /^BOAT_DISK_END$/m.test(stdout) };
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
    const zombie = /^BOAT_ZOMBIE (\d+) (\S+) (.*)$/.exec(line);
    if (zombie !== null) check.daemon.zombies.push(cleanDetail(`${zombie[3]} (pid ${zombie[1]}, ${zombie[2]})`, 160));
    const unit = /^BOAT_UNIT (\S+) (\S+) (\S+)$/.exec(line);
    if (unit !== null) check.daemon.units.push({ unit: unit[1]!, active: unit[2]!, sub: unit[3]! });
    const log = /^BOAT_BB_LOG (.+)$/.exec(line);
    if (log !== null) check.daemon.log = cleanDetail(log[1]!, 200);
    const missing = /^BOAT_BB_MISSING (.+)$/.exec(line);
    if (missing !== null) check.daemon.missing.push(missing[1]!);
    const dir = /^BOAT_BB_DIR (.+)$/.exec(line);
    if (dir !== null) check.daemon.dirs.push(dir[1]!);
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
  // Refused for its size: nothing runs there to look at.
  const size = diskTooLarge(error);
  if (size !== null) return { kind: "disk-too-large", detail: size.detail, checked: false, size };
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
  return classifyDiskCheck(parseDiskCheck(result.stdout), fromText);
}

/**
 * What a look at the sandbox (DISK_CHECK_SCRIPT) shows, given what the
 * error's text said (`fromText`; kind "other" when there's no error, as for
 * `bb boat sandbox wake`). Kind "other" back: nothing wrong was seen.
 */
export function classifyDiskCheck(seen: DiskCheck, fromText: WakeDiagnosis = { kind: "other", detail: null, checked: false }): WakeDiagnosis {
  const textDetail = fromText.kind === "disk-restoring" ? fromText.detail : null;
  if (seen.hydrator !== null || seen.unreadable.length > 0) {
    return { kind: "disk-restoring", detail: seen.hydrator ?? textDetail ?? `${seen.unreadable.map((file) => `~/${file}`).join(", ")}: Input/output error`, checked: true };
  }
  if (seen.motdHung.length > 0) {
    return { kind: "ssh-session-stuck", detail: `login message script hangs: ${seen.motdHung[0]}`, checked: true };
  }
  // A read waiting on lazyfs: the disk is still restoring, and waiting fixes it (before a broken daemon:
  // an npm install blocked on it leaves its unit "deactivating" without anything broken).
  if (seen.fuseBlocked.length > 0) {
    return { kind: "disk-restoring", detail: textDetail ?? `waiting on a file not restored yet: ${seen.fuseBlocked.slice(0, 2).join(", ")}`, checked: true };
  }
  // bb's daemon broke during an update: retrying won't fix it, a repair by hand does.
  if (daemonBroken(seen)) {
    const daemon = seen.daemon;
    const what = [
      ...daemon.zombies.slice(0, 1).map((zombie) => `npm install left a zombie: ${zombie}`),
      ...daemon.units.filter((unit) => unit.active === "deactivating").slice(0, 1).map((unit) => `${unit.unit} is stuck deactivating`),
      ...daemon.missing.slice(0, 1).map((dir) => `${shortHome(dir)}/npm/bin/bb-app is missing`),
      ...(daemon.log === null ? [] : [daemon.log]),
    ];
    const dirs = [...new Set([...daemon.missing, ...daemon.dirs])];
    const units = daemon.units.map((unit) => unit.unit);
    const guess = pickDaemon({ dirs, units }, null);
    return {
      kind: "daemon-broken",
      detail: cleanDetail(what.join("; "), 300),
      checked: true,
      daemon: { dir: guess.dir ?? daemon.missing[0] ?? null, unit: guess.unit, zombie: daemon.zombies.length > 0, dirs, units },
    };
  }
  if (seen.hydrating !== null || fromText.kind === "disk-restoring") {
    return { kind: "disk-restoring", detail: textDetail ?? seen.hydrating, checked: true };
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
  const next = when ? `Harbormaster will retry at ${when}; pressing Resume earlier won't help.` : "Try again in a few minutes.";
  const why = storageFailing(diagnosis.detail) ? "its storage is returning errors" : "files bb needs there aren't readable yet";
  switch (diagnosis.kind) {
    case "disk-restoring":
      if (gaveUp !== null) return `boat.dev still couldn't restore this sandbox's disk after ${gaveUp} tries (${why}), so Harbormaster stopped retrying on its own. It's under Needs you.${resumeLater}`;
      return `boat.dev is still restoring this sandbox's disk (${why}). ${next}`;
    case "restore-rate-limited":
      if (gaveUp !== null) return `boat.dev still refused to restore this sandbox after ${gaveUp} tries ("Please reduce your request rate"), so Harbormaster stopped retrying on its own. It's under Needs you.${resumeLater}`;
      return `boat.dev is restoring too many sandboxes at once and asked Harbormaster to slow down. ${next}`;
    case "ssh-session-stuck":
      if (gaveUp !== null) return `The sandbox still took Harbormaster's SSH login without starting the session after ${gaveUp} tries (its login message scripts hang while boat.dev restores the disk), so Harbormaster stopped retrying on its own. It's under Needs you.${resumeLater}`;
      return `The sandbox took Harbormaster's SSH login, but the session never started: its login message scripts hang while boat.dev restores the disk. Harbormaster turns them off before each try. ${next}`;
    case "daemon-broken":
      return `bb's daemon on this sandbox broke during an update${diagnosis.detail ? ` (${diagnosis.detail})` : ""}, so bb can't start there. It needs a repair by hand; the steps are under Needs you.`;
    case "disk-too-large":
      return tooLargeMessage(diagnosis.size ?? null);
    case "ssh-unreachable":
      return `Harbormaster couldn't reach the sandbox over SSH to restart bb there${diagnosis.detail ? ` (${diagnosis.detail})` : ""}. Press Resume to try again; if it keeps failing, check the sandbox on boat.dev.`;
    case "other":
      return original;
  }
}

/** Kinds Boat retries on its own, later and with backoff. */
export type RetriedKind = "disk-restoring" | "restore-rate-limited" | "ssh-session-stuck";
export function retriesLater(kind: WakeFailureKind): kind is RetriedKind {
  return kind === "disk-restoring" || kind === "restore-rate-limited" || kind === "ssh-session-stuck";
}

/** "/home/user/.bb-machines/acme" → "~/.bb-machines/acme". */
function shortHome(path: string): string {
  return path.replace(/^\/home\/[^/]+\//, "~/").replace(/^\/root\//, "~/");
}

/**
 * Needs you: repair bb's daemon by hand after a broken update (automatic
 * repair is out of scope: it depends on bb's own layout). Reinstall the
 * package bb downloaded into a fresh folder, swap it in, restart the unit.
 */
export function daemonRepairQuestion(input: { sandboxId: string; detail: string | null; daemon: WakeDiagnosis["daemon"]; hostId?: string | null }) {
  // This machine's own unit and folder (a sandbox can be enrolled with more than one bb server).
  const picked = input.daemon?.units || input.daemon?.dirs ? pickDaemon({ dirs: input.daemon.dirs ?? [], units: input.daemon.units ?? [] }, input.hostId ?? null) : { dir: null, unit: null };
  const chosenDir = picked.dir ?? input.daemon?.dir ?? null;
  const chosenUnit = picked.unit ?? (input.hostId ? null : (input.daemon?.unit ?? null));
  const dir = chosenDir ? shortHome(chosenDir) : "~/.bb-machines/<server>";
  const unit = chosenUnit ?? `<this machine's unit, bb-host-daemon-<server>-${input.hostId ?? "<host id>"}.service: systemctl --user list-units 'bb-host-daemon*'>`;
  const steps = [
    `D=${dir}`,
    `cp "$D/host-package-download/bb-app.tgz" /tmp/bb-app.tgz`,
    `npm_config_cache=/tmp/npmcache npm install -g --no-audit --no-fund --allow-scripts=@parcel/watcher,node-pty --prefix "$D/npm.new" /tmp/bb-app.tgz`,
    `mv "$D/npm" "$D/npm.old" && mv "$D/npm.new" "$D/npm"`,
    `systemctl --user reset-failed ${unit} && systemctl --user start ${unit}`,
  ];
  return {
    question: `bb's daemon on sandbox ${input.sandboxId} broke during an update, so bb can't start there. Repair it by hand?`,
    recommendation: `In the sandbox (\`boat ssh ${input.sandboxId}\`, or \`boat exec ${input.sandboxId}\`), reinstall bb's downloaded package into a fresh folder, swap it in and restart the unit (the commands are below). Then resume the sandbox. ${input.daemon?.zombie ? "An npm install zombie is left there: it goes only with a VM restart (`boat recover " + input.sandboxId + "`) or a move to a new node." : "If an npm install zombie stays (`ps` shows <defunct>), it needs a VM restart (`boat recover " + input.sandboxId + "`) or a move to a new node."}`,
    options: ["I'll repair it", "Leave it for now"],
    context: `What the check saw: ${input.detail ?? "(no details)"}.\n${steps.join("\n")}`,
    shortLabel: "bb's daemon needs a repair",
  };
}
