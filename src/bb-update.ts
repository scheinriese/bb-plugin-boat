// Update bb on a woken sandbox safely, before bb's own setup runs there.
//
// Seen on 19 Nov: the sandboxes had bb-app 0.49.0 and the bb server 0.50.1.
// At boot, bb's service on the sandbox (`bb-app host-daemon --auto-update`, a
// systemd user unit `bb-host-daemon-<server>-<hostId>.service`) updated
// itself in place: it downloaded the server's build to
// `~/.bb-machines/<server>/host-package-download/bb-app.tgz` and ran `npm
// install -g --prefix ~/.bb-machines/<server>/npm` over the old install. With
// boat.dev still restoring the disk, that npm read old files that weren't
// there yet: it hung as a zombie (`[npm install …] <defunct>`, the unit stuck
// "deactivating" until the VM restarted), or it was cut off and left
// `npm/bin/bb-app` missing (`MODULE_NOT_FOUND`). bb's setup then said
// "Machine daemon did not start within 20 seconds". bb's own setup
// (install-machine.sh) installs the server's build in place the same way.
//
// What fixed it by hand, and what Boat does now, after the sandbox is up and
// before bb's setup (all over boat's exec API, a plain `bash -c`):
// 1. look (one capped exec): bb's data dir and unit, the installed version,
//    the bin, a download left in host-package-download, the unit's state, and
//    bb's own npm installs (a zombie, or one running right now, in any state:
//    bb's in-place update is never stopped half way; Boat waits for it, up to
//    3 minutes, and looks again);
// 2. the installed version differs from the server's (bb.sdk.system.version)
//    and the download is that version, or the install is broken: copy the
//    download to /tmp, stop the unit, `npm install -g` it into a fresh prefix
//    (`npm.new`, its own npm cache in /tmp: nothing of the old install is
//    read), check it, swap it in (`npm` → `npm.old-<version>-<time>`), write
//    bb's artifact digest (bb's setup then sees the identical build and
//    doesn't install again), start the unit again. At most 5 minutes, the
//    restart included; on any failure Boat checks the old install again: as it
//    was, it starts again; no longer complete, it goes aside for bb's setup.
//    Boat says which, then leaves it to bb's own setup and tries again later
//    (backoff);
// 3. no download of the server's version there (none, one that can't be read,
//    or another version): the same install, but from `bb-app@<the server's
//    version>` on the npm registry (registry.npmjs.org, never "latest"), as
//    it was done by hand. `npm pack` fetches it into /tmp before anything
//    stops, so a version the registry doesn't have, a registry it can't reach
//    or a timeout leaves bb as it was, and running. Its version is checked,
//    then come the same stop, fresh prefix, checks and swap. bb's artifact
//    digest isn't written: it's the hash of the server's own build, which
//    Boat can't make for one from npm, so the file stays as it was. bb's
//    setup sends that digest to the server: the same build as before keeps
//    the npm install (304); any other one (a stale digest, or none) has bb's
//    setup install the server's build in place over it, which then reads only
//    files Boat has just written. A broken install the fallback didn't
//    replace (npm failed before the stop, or a backoff holds it) is moved
//    aside, as before;
// 4. no download and the server's version unknown: nothing to install from
//    without the server's credentials, so bb's own update runs (a broken
//    install is moved aside first, so bb's setup installs into an empty
//    prefix).
//    The look that planned any of 2.-4. is a while old by the time anything
//    is stopped (a prefetch, and a copy or a fetch, ran since), and bb may
//    have repaired or updated its install meanwhile. So every destructive
//    step acts on a reading taken right before it, through one guard
//    (NOW_SCRIPT): the install script reads the old install again right
//    before the stop (already the server's version: nothing is stopped;
//    complete: that's what a failure keeps and starts again), and a set-aside
//    first looks again (bb's own update running is waited for, never stopped,
//    as in 1.) and checks once more right before its stop;
// 5. bb's own update hung there: Boat doesn't fight it, nothing is stopped or
//    installed, and the wake fails already diagnosed for the wake guard
//    (src/wake-retry.ts). A zombie npm install (seen twice, 5 s apart) only
//    goes with a VM restart: "daemon-broken", the repair under Needs you. Its
//    service stuck stopping, or an npm install whose read of the disk made no
//    progress: "disk-restoring", Boat's own retries later.
import { setTimeout as delay } from "node:timers/promises";
import type { SandboxProvider } from "./providers/types.ts";
import { clockTime } from "./format.ts";
import type { WakeDiagnosis } from "./wake-diagnosis.ts";

/** The whole install, at most (the exec waits a little longer). */
export const INSTALL_SECONDS = 300;
/** After a failed update, the next try waits this long, doubling… */
export const UPDATE_BACKOFF_MS = 30 * 60_000;
/** …up to this. */
export const UPDATE_BACKOFF_MAX_MS = 6 * 3_600_000;
/** A unit "deactivating" this long is held up (by a read waiting on the disk), not just stopping. */
export const STUCK_STOPPING_SECONDS = 30;
/** An npm install waiting on the disk (D state, no progress) this long: let boat.dev restore first. */
export const STUCK_READING_SECONDS = 120;
/** kv: failed updates, by sandbox. */
export const BB_UPDATES_KEY = "bbUpdates";
/** A backoff whose retry time passed this long ago is dropped: the sandbox is gone, or a later wake starts over. */
export const UPDATE_FORGET_MS = 24 * 3_600_000;
/** bb's own update running on the sandbox: Boat looks again this often… */
export const BUSY_POLL_MS = 10_000;
/** …and waits for it this long at most, then leaves it to Boat's wake retries. */
export const BUSY_WAIT_MS = 3 * 60_000;
/** The native add-ons bb's installer lets npm build (install-machine.sh). */
const ALLOW_SCRIPTS = "better-sqlite3,node-pty,@parcel/watcher";
/** Without a download of the server's build there, bb-app comes from here (npm's own registry, nothing else). */
export const NPM_REGISTRY = "https://registry.npmjs.org/";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** bb's unit name ends in the host id, as its installer writes it. */
export function hostSlug(hostId: string): string {
  return hostId.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/\./g, "-");
}

/** Reads "version" from a package.json (the top-level one: at most two spaces in). */
const VERSION_SED = `sed -n 's/^ \\{0,2\\}"version": *"\\([^"]*\\)".*/\\1/p'`;

/**
 * Shell helpers shared by the look and the install, after D (bb's data dir), U
 * (its unit) and PR (procfs) are set. `mine "<args>" <pid>`: an npm install of
 * bb's own, by its arguments (this data dir's install or download) or by the
 * unit it runs in. The patterns come from variables: this script's own command
 * line never matches.
 */
const OWN_NPM_SCRIPT = [
  'I="npm"" install"',
  `rc() { timeout 2 sed -n 's/^rchar: //p' "$PR/$1/io" 2>/dev/null; }`,
  'mine() { case "$1" in *"$D/npm"*|*"$D/host-package-download"*) return 0 ;; esac; [ -n "$U" ] && timeout 2 grep -qF -- "/$U" "$PR/$2/cgroup" 2>/dev/null; }',
];

/** B1: the pid of an npm install of bb's own running right now (empty: none), after OWN_NPM_SCRIPT. */
const OWN_NPM_RUNNING = 'B1=$(timeout 5 ps -eo pid=,stat=,args= 2>/dev/null | while read -r pid stat args; do case "$stat" in Z*) ;; *) case "$args" in *"$I"*) mine "$args" "$pid" && echo "$pid" ;; esac ;; esac; done | head -n 1)';

/**
 * The one guard every destructive step acts on: bb's install as
 * it is right now, after D and U are set. complete: its bin, package.json and
 * both entry files. serviceup: bb's unit is active. stillbroken: an install the
 * look found broken (K: by its files, or, K=service, only by a module it
 * couldn't load, where the files don't tell) still is.
 */
const NOW_SCRIPT = [
  'complete() { P="$D/npm/lib/node_modules/bb-app"; [ -e "$D/npm/bin/bb-app" ] && [ -e "$P/package.json" ] && [ -e "$P/dist/bb-app.js" ] && [ -e "$P/host-daemon/dist/daemon-bundle.mjs" ]; }',
  'serviceup() { [ -n "$U" ] && [ "$(timeout 5 systemctl --user show "$U" --property=ActiveState --value 2>/dev/null)" = active ]; }',
  'stillbroken() { if [ "$K" = service ]; then ! serviceup; else ! complete; fi; }',
];

/** How the look found an install broken: by its files, or only by a module it couldn't load (MODULE_NOT_FOUND). */
export type BrokenBy = "files" | "service";
export function brokenBy(seen: BbInstall): BrokenBy {
  return seen.bin !== "ok" || seen.lacks.length > 0 || seen.installed === "none" ? "files" : "service";
}

/**
 * Look at bb's install on the sandbox. Plain `bash -c`; every read is capped,
 * and a read that fails says "unreadable", never "missing". The patterns are
 * built from variables so this script's own command line never matches.
 */
export function inspectScript(hostId: string | null, options: { proc?: string; sampleSeconds?: number } = {}): string {
  return [
    `H=${shellQuote(hostId === null ? "" : hostSlug(hostId))}`,
    `PR=${shellQuote(options.proc ?? "/proc")}`,
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    "say() { printf 'BOAT_BB %s\\n' \"$*\"; }",
    `ver() { timeout 5 ${VERSION_SED} "$1" 2>/dev/null | head -n 1; }`,
    "F=",
    'for f in "$HOME"/.config/systemd/user/bb-host-daemon-*.service; do',
    '  [ -f "$f" ] || continue',
    '  [ -n "$H" ] && case "${f##*/}" in *"-$H.service") F=$f ;; esac',
    "done",
    'if [ -z "$F" ]; then set -- "$HOME"/.config/systemd/user/bb-host-daemon-*.service; [ $# -eq 1 ] && [ -f "$1" ] && F=$1; fi',
    "U= D= N=",
    'if [ -n "$F" ]; then',
    "  U=${F##*/}",
    '  C=$(timeout 5 cat -- "$F" 2>/dev/null)',
    `  D=$(printf '%s\\n' "$C" | sed -n 's/^Environment="BB_DATA_DIR=\\(.*\\)"$/\\1/p' | head -n 1)`,
    `  N=$(printf '%s\\n' "$C" | sed -n 's/^ExecStart="\\([^"]*\\)".*/\\1/p' | head -n 1)`,
    "fi",
    'if [ -z "$D" ]; then set -- "$HOME"/.bb-machines/*/; [ $# -eq 1 ] && [ -d "$1" ] && D=${1%/}; fi',
    'if [ -z "$D" ] || [ ! -d "$D" ]; then say none; say end; exit 0; fi',
    'say dir "$D"',
    'say unit "${U:--}"',
    'say node "${N:--}"',
    'P="$D/npm/lib/node_modules/bb-app"',
    'if [ -e "$P/package.json" ]; then V=$(ver "$P/package.json"); say installed "${V:-unreadable}"; else say installed none; fi',
    'B="$D/npm/bin/bb-app"',
    'if [ -e "$B" ]; then say bin ok; elif [ -L "$B" ]; then say bin dangling; else say bin missing; fi',
    'if [ -d "$P" ]; then for m in dist/bb-app.js host-daemon/dist/daemon-bundle.mjs; do [ -e "$P/$m" ] || say lacks "$m"; done; fi',
    'T="$D/host-package-download/bb-app.tgz"',
    `if [ -f "$T" ]; then TV=$(timeout 30 tar -xzOf "$T" package/package.json 2>/dev/null | ${VERSION_SED} | head -n 1); say tgz "\${TV:-unreadable}"; else say tgz none; fi`,
    'if [ -n "$U" ] && command -v systemctl >/dev/null 2>&1; then',
    `  S=$(timeout 5 systemctl --user show "$U" --property=ActiveState --property=SubState --property=Result --property=NRestarts --property=StateChangeTimestampMonotonic 2>/dev/null | tr '\\n' ' ')`,
    '  say state "${S:-unknown}"',
    "  UP=$(cut -d. -f1 /proc/uptime 2>/dev/null)",
    '  say uptime "${UP:-0}"',
    // This boot only: a line from before a restart or a fix says nothing about the install now.
    '  J=$(timeout 5 journalctl --user -b -u "$U" -n 100 --no-pager -o cat -q 2>/dev/null)',
    "  M1=MODULE_NOT; M2=\"Cannot find\"",
    '  case "$J" in *"${M1}_FOUND"*|*"$M2 module"*) say modulenotfound ;; esac',
    "fi",
    // bb's own npm installs, looked at twice 5 s apart: a zombie nobody reaps; a live one (any
    // state: bb's in-place update running right now, never to be stopped half way); and of
    // those, one whose read of the disk made no progress (D, rchar unchanged).
    ...OWN_NPM_SCRIPT,
    "Z0=$(timeout 5 ps -eo pid=,stat=,etimes=,args= 2>/dev/null | while read -r pid stat age args; do",
    `  case "$stat" in Z*) case "$args" in *"[$I"*) echo "Z $pid $age" ;; esac ;; *) case "$args" in *"$I"*) mine "$args" "$pid" && echo "L $pid $age $(rc "$pid")" ;; esac ;; esac`,
    "done | head -n 10)",
    'if [ -n "$Z0" ]; then',
    `  sleep ${Math.max(0, options.sampleSeconds ?? 5)}`,
    "  while read -r k pid age io; do",
    `    S=$(timeout 2 sed -n 's/^State:[[:space:]]*\\(.\\).*/\\1/p' "$PR/$pid/status" 2>/dev/null)`,
    '    [ "$k" = Z ] && [ "$S" = Z ] && say zombie "$pid" "$age"',
    '    if [ "$k" = L ] && [ -n "$S" ] && [ "$S" != Z ] && [ "$S" != X ]; then',
    `      if [ "$S" = D ] && [ -n "$io" ] && [ "$(rc "$pid")" = "$io" ]; then say blocked "$pid" "$age"; else say live "$pid" "$age"; fi`,
    "    fi",
    "  done <<EOF_BOAT",
    "$Z0",
    "EOF_BOAT",
    "fi",
    "say end",
  ].join("\n");
}

export interface BbInstall {
  /** The look ran to its end. */
  complete: boolean;
  /** bb's data dir (~/.bb-machines/<server>); null: bb isn't installed there (yet). */
  dataDir: string | null;
  /** bb's systemd user unit (null: none found). */
  unit: string | null;
  /** The node binary bb's unit runs (null: unknown). */
  node: string | null;
  /** The installed bb-app version, "none" (not installed) or "unreadable". */
  installed: string;
  bin: "ok" | "missing" | "dangling";
  /** Files of the installed package that are gone. */
  lacks: string[];
  /** The version of a download left in host-package-download, "none" or "unreadable". */
  tgz: string;
  /** The unit, as systemd says (null: unknown). */
  state: { active: string; sub: string; result: string; restarts: number; sinceSeconds: number | null } | null;
  /** The unit's journal says MODULE_NOT_FOUND. */
  moduleNotFound: boolean;
  /** Zombie npm processes ("pid age"). */
  zombies: string[];
  /** npm installs stuck reading the disk (D state, "pid age"). */
  blocked: string[];
  /** bb's own npm installs running right now, making progress ("pid age"). */
  live: string[];
}

export function parseInspection(stdout: string): BbInstall {
  const seen: BbInstall = { complete: false, dataDir: null, unit: null, node: null, installed: "none", bin: "missing", lacks: [], tgz: "none", state: null, moduleNotFound: false, zombies: [], blocked: [], live: [] };
  let uptime: number | null = null;
  let stateText: string | null = null;
  for (const raw of stdout.split("\n")) {
    const match = /^BOAT_BB (\S+) ?(.*)$/.exec(raw.trim());
    if (match === null) continue;
    const [, key, rest = ""] = match;
    const value = rest.trim();
    switch (key) {
      case "end":
        seen.complete = true;
        break;
      case "dir":
        seen.dataDir = value || null;
        break;
      case "unit":
        seen.unit = value === "-" || value === "" ? null : value;
        break;
      case "node":
        seen.node = value === "-" || value === "" ? null : value;
        break;
      case "installed":
        seen.installed = value || "unreadable";
        break;
      case "bin":
        seen.bin = value === "ok" || value === "dangling" ? value : "missing";
        break;
      case "lacks":
        if (value) seen.lacks.push(value);
        break;
      case "tgz":
        seen.tgz = value || "unreadable";
        break;
      case "state":
        stateText = value;
        break;
      case "uptime":
        uptime = Number.parseInt(value, 10);
        break;
      case "modulenotfound":
        seen.moduleNotFound = true;
        break;
      case "zombie":
        seen.zombies.push(value);
        break;
      case "blocked":
        seen.blocked.push(value);
        break;
      case "live":
        seen.live.push(value);
        break;
    }
  }
  if (stateText !== null && stateText !== "unknown") {
    const field = (name: string) => new RegExp(`(?:^|\\s)${name}=(\\S*)`).exec(stateText!)?.[1] ?? "";
    const changedUs = Number(field("StateChangeTimestampMonotonic"));
    seen.state = {
      active: field("ActiveState") || "unknown",
      sub: field("SubState"),
      result: field("Result"),
      restarts: Number(field("NRestarts")) || 0,
      sinceSeconds: uptime !== null && Number.isFinite(uptime) && Number.isFinite(changedUs) && changedUs > 0 ? Math.max(0, uptime - Math.floor(changedUs / 1_000_000)) : null,
    };
  }
  return seen;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export function isVersion(value: string | null | undefined): value is string {
  return typeof value === "string" && VERSION.test(value);
}

/** Semver order: <0 when a is older than b (pre-releases sort before their release). */
export function compareVersions(a: string, b: string): number {
  const split = (value: string) => {
    const at = value.indexOf("-");
    return { main: (at < 0 ? value : value.slice(0, at)).split(".").map((part) => Number.parseInt(part, 10) || 0), pre: at < 0 ? "" : value.slice(at + 1) };
  };
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < 3; index++) {
    const diff = (left.main[index] ?? 0) - (right.main[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === "") return 1;
  if (right.pre === "") return -1;
  const leftParts = left.pre.split(".");
  const rightParts = right.pre.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const l = leftParts[index];
    const r = rightParts[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l) ? Number(l) : null;
    const rn = /^\d+$/.test(r) ? Number(r) : null;
    if (ln !== null && rn !== null && ln !== rn) return ln - rn;
    if (ln === null || rn === null) {
      if (ln !== null) return -1;
      if (rn !== null) return 1;
      if (l !== r) return l < r ? -1 : 1;
    }
  }
  return 0;
}

export type BbUpdatePlan =
  /** Nothing for Boat to do; bb's own setup goes ahead. */
  | { kind: "none"; why: string }
  /** Install the download into a fresh prefix and swap it in. npm: no download of that version there, so bb-app@<to> from the npm registry. */
  | { kind: "update"; to: string; from: string | null; broken: boolean; npm?: true }
  /** Broken, and nothing to install from: move it aside so bb's setup installs into an empty prefix. */
  | { kind: "set-aside"; why: string }
  /** bb's own update hangs there: a zombie npm install (only a VM restart clears it). */
  | { kind: "hung"; detail: string }
  /** bb's own update waits on the disk (its service stuck stopping, a read with no progress): later. */
  | { kind: "waiting"; detail: string }
  /** bb's own update runs right now: never stopped half way; Boat waits for it, then looks again. */
  | { kind: "busy"; detail: string };

/** Why the install is broken (null: it isn't, as far as Boat can tell). */
export function brokenInstall(seen: BbInstall): string | null {
  if (seen.bin === "dangling") return "npm/bin/bb-app points at nothing";
  if (seen.bin === "missing") return seen.installed === "none" ? "bb-app isn't installed" : "npm/bin/bb-app is missing";
  if (seen.lacks.length > 0) return `bb-app's ${seen.lacks[0]} is missing`;
  if (seen.installed === "none") return "bb-app isn't installed";
  // The service fails to start on a missing module (an install cut off half way).
  if (seen.moduleNotFound && seen.state !== null && seen.state.active !== "active") return "bb's service fails with MODULE_NOT_FOUND";
  return null;
}

/**
 * What to do about bb's install. target: the version the bb server installs
 * on its machines (null: unknown, then the download's own version counts).
 * Without a download of the server's version there, that exact version comes
 * from the npm registry; never without a known server version ("latest").
 */
export function decideBbUpdate(seen: BbInstall, target: string | null): BbUpdatePlan {
  if (!seen.complete) return { kind: "none", why: "Boat couldn't finish looking at bb's install" };
  if (seen.dataDir === null) return { kind: "none", why: "bb isn't installed there yet" };
  if (seen.zombies.length > 0) return { kind: "hung", detail: `npm install left a zombie: pid ${seen.zombies[0]!.split(" ")[0]}` };
  const reading = seen.blocked.map((entry) => entry.split(" ").map(Number)).find(([, age]) => (age ?? 0) >= STUCK_READING_SECONDS);
  if (reading !== undefined) return { kind: "waiting", detail: `bb's npm install is waiting on a file not restored yet (pid ${reading[0]}, ${reading[1]}s)` };
  const running = [...seen.live, ...seen.blocked][0];
  if (running !== undefined) return { kind: "busy", detail: `bb's own update is running: npm install, pid ${running.split(" ")[0]}` };
  if (seen.state?.active === "deactivating" && (seen.state.sinceSeconds ?? 0) >= STUCK_STOPPING_SECONDS) return { kind: "waiting", detail: `bb's service has been stopping for ${seen.state.sinceSeconds}s, waiting on the disk` };
  const download = isVersion(seen.tgz) ? seen.tgz : null;
  const server = isVersion(target) ? target : null;
  const goal = server ?? download;
  const broken = brokenInstall(seen);
  const from = isVersion(seen.installed) ? seen.installed : null;
  if (broken !== null) {
    if (download !== null && download === goal) return { kind: "update", to: download, from, broken: true };
    if (server !== null) return { kind: "update", to: server, from, broken: true, npm: true };
    return { kind: "set-aside", why: broken };
  }
  if (seen.installed === "unreadable") return { kind: "none", why: "the installed version isn't readable yet" };
  if (goal === null) return { kind: "none", why: "Boat couldn't tell which bb the server needs" };
  if (from === goal) return { kind: "none", why: `bb ${goal} is installed` };
  if (from !== null && compareVersions(from, goal) > 0) return { kind: "none", why: `bb ${from} is newer than the server's ${goal}; bb's setup decides` };
  // The goal is the server's version here (a download's own would match it): from the npm registry.
  if (download !== goal) return { kind: "update", to: goal, from, broken: false, npm: true };
  return { kind: "update", to: goal, from, broken: false };
}

/**
 * bb-app at exactly the server's version, from the npm registry into the work
 * dir as $W/bb-app.tgz, before anything stops (nothing runs: --ignore-scripts).
 * A version it doesn't have, a registry it can't reach or a timeout fails here,
 * with bb as it was.
 */
const REGISTRY_FETCH = [
  'mkdir -- "$W/pack" || fail workdir',
  `npm_config_cache="$W/cache" npm_config_update_notifier=false timeout -k 10 "$(cap 120)" npm pack --ignore-scripts --registry=${NPM_REGISTRY} --pack-destination "$W/pack" "bb-app@$V" >"$W/pack.log" 2>&1`,
  "RC=$?",
  `if [ "$RC" -ne 0 ]; then if [ "$RC" -eq 124 ] || [ "$RC" -eq 137 ]; then C=timeout; else C=$(grep -o -m 1 -E "npm (ERR!|error) code [A-Z0-9_]+" "$W/pack.log" | awk '{print $NF}'); fi; fail registry "\${C:-exit-$RC}"; fi`,
  'set -- "$W/pack"/*.tgz',
  '{ [ $# -eq 1 ] && [ -f "$1" ] && mv -- "$1" "$W/bb-app.tgz"; } || fail registry no-package',
  `GOT=$(timeout "$(cap 60)" tar -xzOf "$W/bb-app.tgz" package/package.json 2>/dev/null | ${VERSION_SED} | head -n 1)`,
  '[ "$GOT" = "$V" ] || fail fetched "${GOT:-unreadable}"',
];

/**
 * The fresh-prefix install and swap. Plain `bash -c`, at most INSTALL_SECONDS
 * in all; prints one BOAT_BBUP line. On any failure the old install stays and
 * bb's unit starts again. npm: no download of the version there, so it comes
 * from the npm registry (REGISTRY_FETCH) and bb's artifact digest is left as
 * it was; the rest is the same, line for line.
 */
export function installScript(input: { dataDir: string; unit: string | null; node: string | null; version: string; from?: string | null; broken?: boolean; brokenBy?: BrokenBy; seconds?: number; proc?: string; npm?: boolean }): string {
  // An exact version only: never a range, a tag or "latest".
  if (input.npm && !isVersion(input.version)) throw new Error(`not a bb version: ${input.version}`);
  return [
    `D=${shellQuote(input.dataDir)}`,
    `U=${shellQuote(input.unit ?? "")}`,
    `N=${shellQuote(input.node ?? "")}`,
    `V=${shellQuote(input.version)}`,
    // The installed version, as the look read it (read again right before the stop).
    `O=${shellQuote(input.from && isVersion(input.from) ? input.from : "broken")}`,
    // The look found the old install broken already.
    `B0=${input.broken ? 1 : 0}`,
    // How (the look's reading; it's refreshed right before the stop).
    `K=${input.broken ? (input.brokenBy ?? "files") : ""}`,
    `L=${Math.max(10, Math.round(input.seconds ?? INSTALL_SECONDS))}`,
    `PR=${shellQuote(input.proc ?? "/proc")}`,
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    "say() { printf 'BOAT_BBUP %s\\n' \"$*\"; }",
    "S0=$(date +%s)",
    // A step's time limit: at most n seconds, and never past the whole limit less RES, which
    // starting bb's service again (40 s), npm's kill grace (10 s) and the last checks take.
    "RES=70",
    'cap() { R=$((L - RES - ($(date +%s) - S0))); [ "$R" -lt 1 ] && R=1; [ "$1" -lt "$R" ] && R=$1; echo "$R"; }',
    `ver() { timeout 5 ${VERSION_SED} "$1" 2>/dev/null | head -n 1; }`,
    'started() { [ -n "$U" ] || return 0; timeout 10 systemctl --user reset-failed "$U" >/dev/null 2>&1; timeout 30 systemctl --user start "$U" >/dev/null 2>&1; }',
    ...OWN_NPM_SCRIPT,
    ...NOW_SCRIPT,
    // The old install now: intact (its bin, its daemon, the version the look read), broken, or
    // unknown (not readable yet: boat.dev is still restoring it).
    'oldstate() { P="$D/npm/lib/node_modules/bb-app"; [ "$B0" = 1 ] && { echo broken; return; }; { [ -e "$D/npm/bin/bb-app" ] && [ -e "$P/host-daemon/dist/daemon-bundle.mjs" ] && [ -e "$P/package.json" ]; } || { echo broken; return; }; X=$(ver "$P/package.json"); if [ -z "$X" ]; then echo unknown; elif [ "$X" = "$O" ]; then echo intact; else echo broken; fi; }',
    // A failure says what became of the old install. Once Boat has stopped bb's service, a broken
    // one goes aside (bb's setup then installs into an empty prefix); an intact one runs again.
    "STOPPED=0",
    'fail() { S=$(oldstate); if [ "$STOPPED" = 1 ]; then if [ "$S" = broken ] && { [ -e "$D/npm" ] || [ -L "$D/npm" ]; } && mv -- "$D/npm" "$D/npm.broken-$(date +%s)" 2>/dev/null; then rm -f -- "$D/host-artifact.sha256"; S=set-aside; else started; fi; fi; echo "BOAT_BBOLD $S"; say fail "$@"; exit 0; }',
    'T="$D/host-package-download/bb-app.tgz"',
    'W=$(mktemp -d "${TMPDIR:-/tmp}/boat-bb-update.XXXXXX") || fail workdir',
    "trap 'rm -rf -- \"$W\"' EXIT",
    // The node and npm bb's service runs on.
    'if [ -n "$N" ] && [ -x "$N" ]; then PATH="${N%/*}:$PATH"; export PATH; fi',
    "command -v npm >/dev/null 2>&1 || fail no-npm",
    ...(input.npm
      ? REGISTRY_FETCH
      : [
          // A copy first: bb's service deletes its download when its own update ends.
          'timeout "$(cap 120)" cp -- "$T" "$W/bb-app.tgz" 2>/dev/null || fail copy',
          'timeout "$(cap 60)" gzip -t -- "$W/bb-app.tgz" 2>/dev/null || fail corrupt',
          `GOT=$(timeout "$(cap 60)" tar -xzOf "$W/bb-app.tgz" package/package.json 2>/dev/null | ${VERSION_SED} | head -n 1)`,
          '[ "$GOT" = "$V" ] || fail version "${GOT:-unreadable}"',
        ]),
    // A half-made install from an earlier try: renamed aside (no reads), deleted later.
    'if [ -e "$D/npm.new" ] || [ -L "$D/npm.new" ]; then mv -- "$D/npm.new" "$D/npm.trash-$(date +%s)-$$" || fail leftover; fi',
    // bb's own update started since the look (even during the copy and checks above): never
    // stopped half way (Boat waits, then looks again). Right before the stop, nothing between.
    OWN_NPM_RUNNING,
    '[ -n "$B1" ] && { say busy "$B1"; exit 0; }',
    // The look is a while old (a prefetch, and the copy or the fetch ran since, and bb's setup or
    // its own update may have repaired or updated the install meanwhile). The old install as it is
    // now, right before the stop, is what a failure rolls back to (oldstate): complete with a
    // readable version, it's kept and started again; already the server's version, nothing is
    // stopped or installed.
    'X=$(ver "$D/npm/lib/node_modules/bb-app/package.json"); case "$X" in *[!0-9A-Za-z.-]*) X= ;; esac',
    'if [ -n "$X" ] && complete && { [ "$B0" = 0 ] || ! stillbroken; }; then [ "$B0" = 1 ] && echo "BOAT_BBNOW repaired"; B0=0; O=$X; elif ! complete; then B0=1; K=files; fi',
    '[ "$B0" = 0 ] && [ "$O" = "$V" ] && { say current "$V"; exit 0; }',
    // Stop bb's service.
    'if [ -n "$U" ]; then',
    '  timeout "$(cap 45)" systemctl --user stop "$U" >/dev/null 2>&1',
    '  A=$(timeout 5 systemctl --user show "$U" --property=ActiveState --value 2>/dev/null)',
    '  case "$A" in deactivating) echo "BOAT_BBOLD unknown"; say stuck deactivating; exit 0 ;; active|activating|reloading) fail stop "$A" ;; esac',
    "fi",
    "STOPPED=1",
    // A fresh prefix and its own cache: nothing of the old install is read.
    `npm_config_cache="$W/cache" npm_config_update_notifier=false timeout -k 10 "$(cap 230)" nice -n 10 npm install -g --no-audit --no-fund --allow-scripts=${ALLOW_SCRIPTS}${input.npm ? ` --registry=${NPM_REGISTRY}` : ""} --prefix "$D/npm.new" "$W/bb-app.tgz" >"$W/npm.log" 2>&1`,
    "RC=$?",
    'if [ "$RC" -ne 0 ]; then',
    '  if [ "$RC" -eq 124 ] || [ "$RC" -eq 137 ]; then C=timeout; else C=$(grep -o -m 1 -E "npm (ERR!|error) code [A-Z0-9_]+" "$W/npm.log" | awk \'{print $NF}\'); fi',
    '  timeout 20 rm -rf -- "$D/npm.new"; fail npm "${C:-exit-$RC}"',
    "fi",
    'NV=$(ver "$D/npm.new/lib/node_modules/bb-app/package.json")',
    // From the registry: another version than the server's is never swapped in.
    ...(input.npm ? ['if [ -n "$NV" ] && [ "$NV" != "$V" ]; then timeout 20 rm -rf -- "$D/npm.new"; fail installed "$NV"; fi'] : []),
    'if [ ! -e "$D/npm.new/bin/bb-app" ] || [ "$NV" != "$V" ]; then timeout 20 rm -rf -- "$D/npm.new"; fail verify; fi',
    // The native add-ons load, as bb's installer checks them.
    `if ! timeout "$(cap 60)" node -e 'const r=process.argv[1];require(r+"/node_modules/node-pty");require(r+"/node_modules/@parcel/watcher")' "$D/npm.new/lib/node_modules/bb-app" >/dev/null 2>&1; then timeout 20 rm -rf -- "$D/npm.new"; fail native; fi`,
    // The swap: the old install stays next to it.
    'OLD="$D/npm.old-$O-$(date +%s)"',
    'if [ -e "$D/npm" ] || [ -L "$D/npm" ]; then mv -- "$D/npm" "$OLD" || { timeout 20 rm -rf -- "$D/npm.new"; fail swap; }; fi',
    'if ! mv -- "$D/npm.new" "$D/npm"; then [ -e "$OLD" ] && mv -- "$OLD" "$D/npm"; timeout 20 rm -rf -- "$D/npm.new"; fail swap; fi',
    // bb's setup compares this digest with the server's build: the same one isn't installed again.
    // Not for a build from npm: it isn't the server's, so the digest file stays as it was.
    ...(input.npm
      ? []
      : [
          'H=$(timeout "$(cap 60)" sha256sum -- "$W/bb-app.tgz" 2>/dev/null | cut -c1-64)',
          'case "$H" in *[!0-9a-f]*|"") rm -f -- "$D/host-artifact.sha256" ;; *) [ ${#H} -eq 64 ] && (umask 077 && printf \'%s\\n\' "$H" >"$D/host-artifact.sha256.boat" && mv -f -- "$D/host-artifact.sha256.boat" "$D/host-artifact.sha256") ;; esac',
        ]),
    "started",
    'A=$( [ -n "$U" ] && timeout 5 systemctl --user show "$U" --property=ActiveState --value 2>/dev/null)',
    'say done "$V" "${A:-unknown}"',
    // Then, with bb running again: the leftover download, older swapped-out installs and
    // half-made ones go, in the background (a read stuck on the disk holds up nothing).
    `G=$(for o in "$D"/npm.old-* "$D"/npm.trash-*; do [ -e "$o" ] && [ "$o" != "$OLD" ] && printf '%s\\n' "$o"; done)`,
    `{ printf '%s\\n' "$T"; [ -n "$G" ] && printf '%s\\n' "$G"; } | setsid nohup nice -n 19 timeout -k 5 600 xargs -r -d '\\n' rm -rf -- >/dev/null 2>&1 &`,
    "exit 0",
  ].join("\n");
}

/**
 * Broken, nothing to install from: move it aside (bb's setup then installs into an empty prefix).
 * recheck (Boat always passes it: its look is a while old): right before the stop the script looks again
 * (NOW_SCRIPT) and leaves it alone when bb's own npm install runs ("busy") or the install isn't
 * broken any more ("intact": its files complete, or, broken only by a module it couldn't load,
 * its service running).
 */
export function setAsideScript(input: { dataDir: string; unit: string | null; recheck?: BrokenBy; proc?: string }): string {
  const recheck = input.recheck
    ? [
        `K=${input.recheck}`,
        `PR=${shellQuote(input.proc ?? "/proc")}`,
        ...OWN_NPM_SCRIPT,
        ...NOW_SCRIPT,
        OWN_NPM_RUNNING,
        '[ -n "$B1" ] && { echo "BOAT_BBFIX busy $B1"; exit 0; }',
        'stillbroken || { echo "BOAT_BBFIX intact"; exit 0; }',
      ]
    : [];
  return [
    `D=${shellQuote(input.dataDir)}`,
    `U=${shellQuote(input.unit ?? "")}`,
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    '[ -e "$D/npm" ] || [ -L "$D/npm" ] || { echo "BOAT_BBFIX none"; exit 0; }',
    ...recheck,
    '[ -n "$U" ] && timeout 30 systemctl --user stop "$U" >/dev/null 2>&1',
    'if mv -- "$D/npm" "$D/npm.broken-$(date +%s)"; then rm -f -- "$D/host-artifact.sha256"; echo "BOAT_BBFIX moved"; else [ -n "$U" ] && timeout 30 systemctl --user start "$U" >/dev/null 2>&1; echo "BOAT_BBFIX failed"; fi',
  ].join("\n");
}

/** The old install after a failed one: as it was, broken (and moved aside), or not readable yet. */
export type OldInstall = "intact" | "broken" | "set-aside" | "unknown" | "repaired" | "busy";

export type InstallResult =
  | { kind: "done"; version: string; unit: string | null }
  | { kind: "stuck"; detail: string }
  /** bb's own update started since the look: nothing was touched. */
  | { kind: "busy"; pid: string | null }
  /** Right before the stop, the install there was the server's version already (bb installed it meanwhile): nothing touched. */
  | { kind: "current"; version: string }
  | { kind: "fail"; reason: string; detail: string | null; old: OldInstall | null };

export function parseInstall(stdout: string): InstallResult {
  const line = stdout.split("\n").map((entry) => entry.trim()).reverse().find((entry) => entry.startsWith("BOAT_BBUP "));
  const read = /^BOAT_BBOLD (intact|broken|set-aside|unknown)$/m.exec(stdout)?.[1] as OldInstall | undefined;
  // The install the look found broken was complete again right before the stop, and kept.
  const said = read === "intact" && /^BOAT_BBNOW repaired$/m.test(stdout) ? "repaired" : read;
  if (line === undefined) return { kind: "fail", reason: "no-answer", detail: null, old: said ?? null };
  const [, kind, ...rest] = line.split(/\s+/);
  if (kind === "done") return { kind: "done", version: rest[0] ?? "", unit: rest[1] ?? null };
  if (kind === "stuck") return { kind: "stuck", detail: rest.join(" ") || "deactivating" };
  if (kind === "busy") return { kind: "busy", pid: rest[0] ?? null };
  if (kind === "current") return { kind: "current", version: rest[0] ?? "" };
  return { kind: "fail", reason: rest[0] ?? "unknown", detail: rest.slice(1).join(" ") || null, old: said ?? null };
}

/** npm's codes for a registry it can't reach. */
const UNREACHABLE = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN"]);

/** A failed fetch from the npm registry, in plain words (version: the one asked for). */
function registryText(detail: string | null, version: string | undefined): string {
  const bbApp = version ? `bb-app ${version}` : "that version of bb-app";
  if (detail === "timeout") return `fetching ${bbApp} from the npm registry took longer than 2 minutes`;
  if (detail === "ETARGET" || detail === "E404") return `the npm registry doesn't have ${bbApp} (${detail})`;
  if (detail !== null && UNREACHABLE.has(detail)) return `the npm registry couldn't be reached (${detail})`;
  if (detail === "no-package") return `npm fetched nothing for ${bbApp} from the npm registry`;
  return `fetching ${bbApp} from the npm registry failed (${detail ?? "no error code"})`;
}

/** A failed install, in plain words (version: the one it was installing). */
export function installFailureText(result: Extract<InstallResult, { kind: "fail" }>, version?: string): string {
  switch (result.reason) {
    case "registry":
      return registryText(result.detail, version);
    case "fetched":
      return `the npm registry sent bb-app ${result.detail ?? "of another version"}`;
    case "installed":
      return `npm installed bb-app ${result.detail ?? "of another version"} instead`;
    case "copy":
      return "bb's download on the sandbox couldn't be read";
    case "corrupt":
      return "bb's download on the sandbox is incomplete";
    case "version":
      return `bb's download on the sandbox is ${result.detail ?? "another version"}`;
    case "no-npm":
      return "npm wasn't found next to bb's node";
    case "stop":
      return `bb's service didn't stop (it's ${result.detail ?? "still running"})`;
    case "npm":
      return result.detail === "timeout" ? "npm install took longer than 4 minutes" : `npm install failed (${result.detail ?? "no error code"})`;
    case "verify":
      return "the new install was incomplete";
    case "native":
      return "the new install's native add-ons didn't load";
    case "swap":
      return "Boat couldn't swap the new install in";
    case "leftover":
      return "a half-made install from an earlier try couldn't be moved aside";
    case "exec":
      return `boat's exec failed (${result.detail ?? "no details"})`;
    case "no-answer":
      return "the install didn't finish";
    default:
      return result.detail ? `${result.reason}: ${result.detail}` : result.reason;
  }
}

/**
 * bb's own update hung on the sandbox: the wake fails with this, already
 * diagnosed for the wake guard (src/wake-retry.ts reads `wakeDiagnosis`).
 */
export class BbUpdateHung extends Error {
  readonly code = "bb_update_hung";
  readonly wakeDiagnosis: WakeDiagnosis;
  constructor(diagnosis: WakeDiagnosis) {
    super(
      diagnosis.kind === "daemon-broken"
        ? `bb's own update hangs on this sandbox (${diagnosis.detail ?? "an npm install zombie"}); only a restart of the sandbox clears it.`
        : `bb's own update on this sandbox is waiting on its disk, which boat.dev is still restoring (${diagnosis.detail ?? "no details"}).`,
    );
    this.name = "BbUpdateHung";
    this.wakeDiagnosis = diagnosis;
  }
}

/** What the guard learns from a hung update: daemon-broken (a zombie) or disk-restoring. */
export function hungDiagnosis(seen: BbInstall, plan: Extract<BbUpdatePlan, { kind: "hung" | "waiting" }>): WakeDiagnosis {
  if (plan.kind === "waiting") return { kind: "disk-restoring", detail: plan.detail, checked: true };
  return { kind: "daemon-broken", detail: plan.detail, checked: true, daemon: { dir: seen.dataDir, unit: seen.unit, zombie: true, dirs: seen.dataDir === null ? [] : [seen.dataDir], units: seen.unit === null ? [] : [seen.unit] } };
}

export interface UpdateBackoff {
  failures: number;
  retryAt: number;
  detail: string;
  at: number;
}

/** The wait before the next try after this many failed updates in a row: 30 minutes, doubling, at most 6 hours. */
export function updateBackoffMs(failures: number): number {
  return Math.min(UPDATE_BACKOFF_MAX_MS, UPDATE_BACKOFF_MS * 2 ** Math.max(0, Math.min(failures - 1, 20)));
}

/** What the step before bb's setup did. */
export type HostPrepResult =
  /** npm: from the npm registry (no download of it there). */
  | { kind: "updated"; from: string | null; to: string; npm?: true }
  | { kind: "failed"; text: string }
  | { kind: "held"; until: number }
  | { kind: "set-aside" }
  | { kind: "none"; why: string };

export interface HostPrep {
  sandboxId: string;
  hostId: string | null;
  /** Boat woke the sandbox just now (its disk is still being restored): read bb's files first. */
  woke: boolean;
  signal: AbortSignal;
  report: { step(text: string): void; log(text: string): void };
}

export interface PrefetchRequest {
  dataDir: string | null;
  node: string | null;
  /** bb's install is about to be replaced: don't read the old one. */
  skipInstall: boolean;
}

export interface BbUpdaterDeps {
  /** The sandbox provider (boat.dev; the key keeps its old name). */
  boat: Pick<SandboxProvider, "exec">;
  kv: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };
  /** The bb version the server installs on its machines (null: unknown). */
  serverVersion(): Promise<string | null>;
  /** Read bb's files so boat.dev restores them before bb starts (src/bb-prefetch.ts); never throws. */
  prefetch?(sandboxId: string, request: PrefetchRequest, signal: AbortSignal): Promise<unknown>;
  /** Tell the sandbox's tasks. */
  tell?(sandboxId: string, text: string): void;
  /** Problems (a failed update, a stuck one). */
  log?(line: string): void;
  /** What it did (an update, nothing to do). */
  info?(line: string): void;
  now?(): number;
  /** Wait (rejects when the signal aborts). */
  sleep?(ms: number, signal: AbortSignal): Promise<unknown>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The step between the sandbox being up and bb's setup there. Throws BbUpdateHung only (and the wake's own abort). */
/** The step before bb's setup, and a way to forget a sandbox that's gone. */
export interface BbUpdater {
  (prep: HostPrep): Promise<HostPrepResult>;
  /** The sandbox is gone (its machine removed): its backoff goes. */
  forget(sandboxId: string): Promise<void>;
}

/** The step between the sandbox being up and bb's setup there. Throws BbUpdateHung only (and the wake's own abort). */
export function createBbUpdater(deps: BbUpdaterDeps): BbUpdater {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const info = deps.info ?? log;
  const sleep = deps.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  let backoffs: Promise<Record<string, UpdateBackoff>> | null = null;
  let version: { value: string | null; at: number } | null = null;

  function loadBackoffs(): Promise<Record<string, UpdateBackoff>> {
    backoffs ??= deps.kv.get<Record<string, UpdateBackoff>>(BB_UPDATES_KEY).then(
      (raw) => (raw !== null && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {}),
      () => ({}),
    );
    return backoffs;
  }
  /** Save one sandbox's backoff (null: none), dropping every one long past its retry time. */
  async function saveBackoff(sandboxId: string, entry: UpdateBackoff | null): Promise<void> {
    const all = await loadBackoffs();
    let changed = false;
    for (const [id, old] of Object.entries(all)) {
      if (id !== sandboxId && !(Number.isFinite(old?.retryAt) && now() - old.retryAt < UPDATE_FORGET_MS)) {
        delete all[id];
        changed = true;
      }
    }
    if (entry === null) {
      if (all[sandboxId] !== undefined) {
        delete all[sandboxId];
        changed = true;
      }
    } else {
      all[sandboxId] = entry;
      changed = true;
    }
    if (!changed) return;
    await deps.kv.set(BB_UPDATES_KEY, { ...all }).catch((error: unknown) => log(`bb update: couldn't save its backoff (${errorText(error)})`));
  }

  /** The server's version, read at most every 10 minutes; never throws. */
  async function target(): Promise<string | null> {
    if (version !== null && now() - version.at < 10 * 60_000) return version.value;
    const value = await deps.serverVersion().then((read) => (isVersion(read) ? read : null), () => null);
    version = { value, at: now() };
    return value;
  }

  async function inspect(prep: HostPrep): Promise<BbInstall | null> {
    try {
      const result = await deps.boat.exec(prep.sandboxId, inspectScript(prep.hostId), { timeoutMs: 60_000, signal: prep.signal, login: false });
      return parseInspection(result.stdout);
    } catch (error) {
      prep.signal.throwIfAborted();
      log(`bb update ${prep.sandboxId}: couldn't look at bb's install (${errorText(error)})`);
      return null;
    }
  }

  async function prefetch(prep: HostPrep, seen: BbInstall | null, plan: BbUpdatePlan | null): Promise<void> {
    if (!prep.woke || deps.prefetch === undefined) return;
    prep.report.step("Reading bb's files on the sandbox, so boat.dev restores them before bb starts");
    // The install about to be replaced isn't read. One from the npm registry may not come (a version
    // it doesn't have, no connection, a backoff): an intact install is still read, as without it.
    const replaced = plan?.kind === "set-aside" || (plan?.kind === "update" && (plan.npm !== true || plan.broken));
    await deps.prefetch(prep.sandboxId, { dataDir: seen?.dataDir ?? null, node: seen?.node ?? null, skipInstall: replaced }, prep.signal).catch(() => undefined);
  }

  /**
   * bb's own update runs on the sandbox right now: never stopped half way. Look again every
   * 10 s until it's done; after 3 minutes it's left to Boat's wake retries (it's waiting on the disk).
   */
  async function waitForOwnUpdate(prep: HostPrep, goal: string | null, detail: string): Promise<{ seen: BbInstall | null; plan: BbUpdatePlan | null }> {
    const deadline = now() + BUSY_WAIT_MS;
    prep.report.step(`Waiting for bb's own update on the sandbox to finish (${detail.replace(/^bb's own update is running: /, "")})`);
    info(`bb update ${prep.sandboxId}: ${detail}; waiting for it`);
    for (;;) {
      await sleep(BUSY_POLL_MS, prep.signal);
      const seen = await inspect(prep);
      const plan = seen === null ? null : decideBbUpdate(seen, goal);
      if (plan?.kind !== "busy") return { seen, plan };
      if (now() >= deadline) return { seen, plan: { kind: "waiting", detail: `${plan.detail}, for more than ${Math.round(BUSY_WAIT_MS / 60_000)} minutes` } };
    }
  }

  /**
   * Every set-aside of a broken install, on readings taken right before it: a new look (bb's own
   * update running is waited for, as before the install, up to 3 minutes), then the guarded
   * set-aside script, which checks once more right before the stop. The look that planned it is a
   * while old by now (a prefetch, or a fetch from the npm registry, ran since), and bb may have
   * repaired the install meanwhile, or be updating it. goal: the server's version (null: unknown).
   */
  async function setAsideIfStillBroken(prep: HostPrep, goal: string | null): Promise<
    | { kind: "set-aside"; why: string }
    | { kind: "repaired" | "busy" | "kept" }
    | { kind: "hung"; seen: BbInstall; plan: Extract<BbUpdatePlan, { kind: "hung" | "waiting" }> }
  > {
    let seen = await inspect(prep);
    let plan = seen === null ? null : decideBbUpdate(seen, goal);
    if (plan?.kind === "busy") ({ seen, plan } = await waitForOwnUpdate(prep, goal, plan.detail));
    // Not readable as a whole: nothing is moved on a guess.
    if (seen === null || plan === null || !seen.complete || seen.dataDir === null) return { kind: "kept" };
    if (plan.kind === "hung" || plan.kind === "waiting") return { kind: "hung", seen, plan };
    if (plan.kind === "busy") return { kind: "busy" };
    const why = brokenInstall(seen);
    if (why === null) return { kind: "repaired" };
    const moved = await setAside(prep, seen, why, brokenBy(seen));
    return moved === true ? { kind: "set-aside", why } : moved === false ? { kind: "kept" } : { kind: moved };
  }

  /** What became of the old install, in words (the end of a failure's text). */
  function oldText(result: Extract<InstallResult, { kind: "fail" }>, plan: Extract<BbUpdatePlan, { kind: "update" }>): string {
    switch (result.old) {
      case "set-aside":
        return plan.broken
          ? "bb's install there was already broken, so Boat moved it aside and bb's own setup installs it again."
          : "The bb that was there isn't complete any more, so Boat moved it aside and bb's own setup installs it again.";
      case "broken":
        return "The bb that was there isn't complete; bb's own setup installs it again.";
      case "unknown":
        return "Boat couldn't check the bb that was there (its files aren't readable yet); bb's own setup goes ahead.";
      case "intact":
        return "It kept the bb that was there, and bb's own setup goes ahead.";
      case "repaired":
        return "Meanwhile bb's install there became complete again, so Boat kept it; bb's own setup goes ahead.";
      case "busy":
        return "bb's own update was running there, so Boat left its install alone.";
      default:
        return "bb's own setup goes ahead and checks the bb that's there.";
    }
  }

  /**
   * Move a broken install aside, so bb's setup installs into an empty prefix: true when it was.
   * The script looks again right before the stop (recheck); "repaired" or "busy" when it left it alone.
   */
  async function setAside(prep: HostPrep, seen: BbInstall, why: string, recheck: BrokenBy): Promise<boolean | "repaired" | "busy"> {
    try {
      const said = (await deps.boat.exec(prep.sandboxId, setAsideScript({ dataDir: seen.dataDir!, unit: seen.unit, recheck }), { timeoutMs: 60_000, signal: prep.signal, login: false })).stdout;
      if (/BOAT_BBFIX moved/.test(said)) {
        info(`bb update ${prep.sandboxId}: broken install (${why}) moved aside`);
        return true;
      }
      if (/BOAT_BBFIX intact/.test(said)) return "repaired";
      if (/BOAT_BBFIX busy/.test(said)) return "busy";
    } catch (error) {
      prep.signal.throwIfAborted();
      log(`bb update ${prep.sandboxId}: couldn't move the broken install aside (${errorText(error)})`);
    }
    return false;
  }

  const setAsideText = (why: string) => `bb's install on the sandbox was broken (${why}); Boat moved it aside so bb's setup installs it again`;

  /**
   * A broken install goes aside for bb's setup, if it still is (setAsideIfStillBroken). "busy": bb's
   * own update started right before the stop, Boat waits for it, then looks again (prepare). kept:
   * the answer when nothing could be checked, so nothing was moved.
   */
  async function setAsideStep(prep: HostPrep, goal: string | null, kept: HostPrepResult): Promise<HostPrepResult | "busy"> {
    const aside = await setAsideIfStillBroken(prep, goal);
    switch (aside.kind) {
      case "set-aside":
        prep.report.log(setAsideText(aside.why));
        return { kind: "set-aside" };
      case "repaired":
        prep.report.log("bb's install on the sandbox is complete again (bb repaired it meanwhile); Boat left it as it is");
        info(`bb update ${prep.sandboxId}: the broken install is complete again; left as it is`);
        return { kind: "none", why: "bb's install there is complete again" };
      case "busy":
        return "busy";
      case "hung":
        throw new BbUpdateHung(hungDiagnosis(aside.seen, aside.plan));
      case "kept":
        return kept;
    }
  }

  async function install(prep: HostPrep, seen: BbInstall, plan: Extract<BbUpdatePlan, { kind: "update" }>): Promise<HostPrepResult | "busy"> {
    const held = (await loadBackoffs())[prep.sandboxId];
    if (held !== undefined && held.retryAt > now()) {
      info(`bb update ${prep.sandboxId}: held until ${new Date(held.retryAt).toISOString()} after ${held.failures} failure(s) (${held.detail}); bb's own setup goes ahead`);
      // Nothing from the npm registry this time: a broken install still goes aside, as it did
      // without it, if it still is broken (the prefetch ran since the look).
      if (plan.npm && plan.broken) return setAsideStep(prep, plan.to, { kind: "held", until: held.retryAt });
      return { kind: "held", until: held.retryAt };
    }
    prep.report.step(`Updating bb on the sandbox to ${plan.to}${plan.npm ? " from the npm registry" : ""}: a fresh install next to the old one`);
    let result: InstallResult;
    try {
      const script = installScript({ dataDir: seen.dataDir!, unit: seen.unit, node: seen.node, version: plan.to, from: plan.from, broken: plan.broken, brokenBy: plan.broken ? brokenBy(seen) : undefined, npm: plan.npm });
      result = parseInstall((await deps.boat.exec(prep.sandboxId, script, { timeoutMs: (INSTALL_SECONDS + 60) * 1000, signal: prep.signal, login: false })).stdout);
    } catch (error) {
      prep.signal.throwIfAborted();
      result = { kind: "fail", reason: "exec", detail: errorText(error).split("\n")[0]!.slice(0, 200), old: null };
    }
    if (result.kind === "busy") return "busy";
    // bb's service didn't stop: its own update waits on the disk. Nothing installed; Boat's retries later.
    if (result.kind === "stuck") throw new BbUpdateHung({ kind: "disk-restoring", detail: "bb's service won't stop: its own update is waiting on a file not restored yet", checked: true });
    // Right before the stop, bb there was the server's version already (bb installed it meanwhile).
    if (result.kind === "current") {
      await saveBackoff(prep.sandboxId, null);
      prep.report.log(`bb ${plan.to} is already on the sandbox (bb installed it meanwhile); Boat left it as it is`);
      info(`bb update ${prep.sandboxId}: bb ${plan.to} installed meanwhile; nothing stopped or installed`);
      return { kind: "none", why: `bb ${plan.to} is installed` };
    }
    if (result.kind === "done") {
      await saveBackoff(prep.sandboxId, null);
      const what = `Updated bb on the sandbox from ${plan.from ?? (plan.broken ? "a broken install" : "an unknown version")} to ${plan.to}${plan.npm ? ", installed from the npm registry" : ""}`;
      prep.report.log(what);
      info(`bb update ${prep.sandboxId}: ${what.toLowerCase()} (fresh prefix, old one kept)`);
      return plan.npm ? { kind: "updated", from: plan.from, to: plan.to, npm: true } : { kind: "updated", from: plan.from, to: plan.to };
    }
    // From the npm registry, failed with an install the look found broken still in place (the
    // registry failed before bb's service stopped): it goes aside, as it did without the fallback,
    // but only if it still is broken (setAsideIfStillBroken).
    let hang: Extract<Awaited<ReturnType<typeof setAsideIfStillBroken>>, { kind: "hung" }> | null = null;
    if (plan.npm && plan.broken && result.old === "broken") {
      const aside = await setAsideIfStillBroken(prep, plan.to);
      if (aside.kind === "set-aside") result = { ...result, old: "set-aside" };
      else if (aside.kind === "repaired" || aside.kind === "busy") result = { ...result, old: aside.kind };
      else if (aside.kind === "hung") {
        result = { ...result, old: "busy" };
        hang = aside;
      }
    }
    const at = now();
    const failures = ((await loadBackoffs())[prep.sandboxId]?.failures ?? 0) + 1;
    const retryAt = at + updateBackoffMs(failures);
    const why = installFailureText(result, plan.to);
    await saveBackoff(prep.sandboxId, { failures, retryAt, detail: why, at });
    // Lost track of the script (boat's exec failed or cut it off): it may have swapped already.
    const unsure = result.reason === "exec" || result.reason === "no-answer";
    const text = unsure
      ? `Boat couldn't tell whether bb's update on this sandbox to ${plan.to} finished: ${why}. bb's own setup goes ahead and checks it. Boat tries the update again after ${clockTime(retryAt, at)} if it's still needed.`
      : `Boat couldn't update bb on this sandbox to ${plan.to}: ${why}. ${oldText(result, plan)} Boat tries the update again after ${clockTime(retryAt, at)}.`;
    prep.report.log(text);
    deps.tell?.(prep.sandboxId, text);
    log(`bb update ${prep.sandboxId}: bb-update-failed (${result.reason}${result.detail ? ` ${result.detail}` : ""}, old install ${result.old ?? "unknown"}, failure ${failures})`);
    // bb's own update still runs (or hangs) after the wait: bb's setup doesn't run into it either.
    if (hang !== null) throw new BbUpdateHung(hungDiagnosis(hang.seen, hang.plan));
    return { kind: "failed", text };
  }

  const prepare = async (prep: HostPrep): Promise<HostPrepResult> => {
    const goal = await target();
    let seen = await inspect(prep);
    let plan = seen === null ? null : decideBbUpdate(seen, goal);
    // Two rounds at most: bb's own update may start between the look and Boat's install.
    for (let round = 0; ; round++) {
      if (plan?.kind === "busy") ({ seen, plan } = await waitForOwnUpdate(prep, goal, plan.detail));
      // bb's own update hung there: not fought (no stop, no install), the guard decides.
      if (seen !== null && (plan?.kind === "hung" || plan?.kind === "waiting" || plan?.kind === "busy")) {
        const hung = plan.kind === "busy" ? { kind: "waiting" as const, detail: plan.detail } : plan;
        log(`bb update ${prep.sandboxId}: bb's own update ${hung.kind === "hung" ? "hangs" : "waits on the disk"} (${hung.detail}); leaving it to the wake guard`);
        throw new BbUpdateHung(hungDiagnosis(seen, hung));
      }
      if (round === 0) await prefetch(prep, seen, plan);
      if (seen === null || plan === null) return { kind: "none", why: "Boat couldn't look at bb's install" };
      // A broken install with nothing to install from (the server's version unknown) goes aside,
      // if it still is broken: the prefetch ran since the look.
      if (plan.kind === "update" || plan.kind === "set-aside") {
        const done = plan.kind === "update" ? await install(prep, seen, plan) : await setAsideStep(prep, goal, { kind: "none", why: plan.why });
        if (done !== "busy") return done;
        const detail = `bb's own update is running: it started while Boat was about to ${plan.kind === "update" ? "install" : "move its broken install aside"}`;
        // Twice in a row: Boat's wake retries take it from here.
        if (round >= 1) throw new BbUpdateHung(hungDiagnosis(seen, { kind: "waiting", detail }));
        plan = { kind: "busy", detail };
        continue;
      }
      break;
    }
    if (plan.kind === "none") info(`bb update ${prep.sandboxId}: nothing to do (${plan.why})`);
    return { kind: "none", why: plan.kind === "none" ? plan.why : "" };
  };

  return Object.assign(prepare, {
    async forget(sandboxId: string) {
      await saveBackoff(sandboxId, null);
    },
  });
}
