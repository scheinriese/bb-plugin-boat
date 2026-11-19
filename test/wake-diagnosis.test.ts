// Why a sandbox didn't wake: boat.dev's real error texts, the check over boat's exec API, the plain message.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISK_CHECK_SCRIPT,
  classifyWakeText,
  daemonBroken,
  daemonRepairQuestion,
  pickDaemon,
  diagnoseWakeFailure,
  needsDiskCheck,
  parseDiskCheck,
  retriesLater,
  wakeFailureMessage,
  type DiskCheckRunner,
} from "../src/wake-diagnosis.ts";

// As boat.dev and bb wrote them (the IP is a documentation address).
const HYDRATOR = "Nov 19 00:01:12 box ascii-agents-server[812]: [lazyfs] [ERROR] HYDRATOR FAILED attempt 32 (mount stays up, on-demand serving continues, retrying …): decode/feed: chunk 1 GET 0000.tar.zst: status code 503";
const HYDRATING = "Nov 19 00:01:05 box ascii-agents-server[812]: [SNAPSHOT-INC] lazy volume hydration in progress";
const RATE = "Resume failed: Failed to restore snapshot: Please reduce your request rate.";
const UNREACHABLE = "Machine bootstrap command failed: Timeout, server 203.0.113.7 not responding … ssh … exit status 255";
const KEY_STEP = "Machine bootstrap command failed: sudo -n /bin/bash -c grep -qxF … >> authorized_keys; chmod …\ngrep: /home/user/.ssh/authorized_keys: Input/output error";
const DAEMON = "Machine daemon did not start within 20 seconds";
const FUSE_STACK = "request_wait_answer → fuse_simple_request → fuse_send_open → fuse_file_open";

test("each failure kind from boat.dev's own words", () => {
  assert.equal(classifyWakeText(HYDRATOR), "disk-restoring");
  assert.equal(classifyWakeText("cat: /home/user/.profile: Input/output error"), "disk-restoring");
  assert.equal(classifyWakeText(KEY_STEP), "disk-restoring");
  assert.equal(classifyWakeText(HYDRATING), "disk-restoring");
  assert.equal(classifyWakeText(FUSE_STACK), "disk-restoring");
  assert.equal(classifyWakeText(RATE), "restore-rate-limited");
  assert.equal(classifyWakeText(`Sandbox bx_abc is error (${RATE}).`), "restore-rate-limited");
  assert.equal(classifyWakeText(UNREACHABLE), "ssh-unreachable");
  assert.equal(classifyWakeText("run-parts --lsbsysinit /etc/update-motd.d hung"), "ssh-session-stuck");
  assert.equal(classifyWakeText(DAEMON), "other");
  assert.equal(classifyWakeText("npm error code E404"), "other");
  // Which ones are worth a look at the sandbox.
  assert.equal(needsDiskCheck(DAEMON), true, "something that never started may be a read stuck on the disk");
  assert.equal(needsDiskCheck(UNREACHABLE), true);
  assert.equal(needsDiskCheck(RATE), false, "a refused restore: nothing runs there to look at");
  assert.equal(needsDiskCheck("npm error code E404"), false);
  assert.deepEqual(["disk-restoring", "restore-rate-limited", "ssh-session-stuck", "ssh-unreachable", "other"].map((kind) => retriesLater(kind as never)), [true, true, true, false, false]);
});

/** What DISK_CHECK_SCRIPT prints in a sandbox like the ones seen live. */
function checkOutput(parts: { hydrator?: boolean; hydrating?: boolean; eio?: boolean; fuse?: boolean; motd?: boolean } = {}): string {
  return [
    ...(parts.fuse ? ["BOAT_DSTATE 4242 request_wait_answer fuse_simple_request fuse_send_open fuse_file_open  node /home/user/.bb-machines/acme/bb-app/host-daemon/main.js"] : []),
    "BOAT_DSTATE 77 io_schedule - jbd2/vda1-8",
    ...(parts.motd ? ["BOAT_MOTD_HUNG 3101 183 /bin/sh /etc/update-motd.d/90-updates-available"] : []),
    ...(parts.hydrator ? [`BOAT_HYDRATOR ${HYDRATOR}`] : []),
    ...(parts.hydrating ? [`BOAT_HYDRATING ${HYDRATING}`] : []),
    parts.eio ? "BOAT_DISK fail .profile head: error reading '/home/user/.profile': Input/output error" : "BOAT_DISK ok .profile",
    "BOAT_DISK ok .bashrc",
    "BOAT_DISK_END",
  ].join("\n");
}

function runner(stdout: string, calls: string[] = []): DiskCheckRunner {
  return async () => {
    calls.push("check");
    return { stdout, stderr: "" };
  };
}

test("the check's output: EIO reads, lazyfs lines, reads stuck in FUSE and hung login scripts", () => {
  const seen = parseDiskCheck(checkOutput({ hydrator: true, hydrating: true, eio: true, fuse: true, motd: true }));
  assert.deepEqual(seen.unreadable, [".profile"]);
  assert.equal(seen.hydrator, "HYDRATOR FAILED attempt 32 (mount stays up, on-demand serving continues, retrying …): decode/feed: chunk 1 GET 0000.tar.zst: status code 503");
  assert.equal(seen.hydrating, "[SNAPSHOT-INC] lazy volume hydration in progress");
  assert.deepEqual(seen.fuseBlocked, ["4242 node (fuse_simple_request)"], "a process waiting on other I/O isn't counted");
  assert.deepEqual(seen.motdHung, ["/bin/sh /etc/update-motd.d/90-updates-available (183s)"]);
  assert.equal(seen.complete, true);
  assert.equal(parseDiskCheck("BOAT_DISK fail .ssh/authorized_keys Permission denied").unreadable.length, 0, "only EIO counts");
});

test("a daemon that didn't start is disk-restoring when a read is stuck in FUSE or the disk is still hydrating", async () => {
  const stuck = await diagnoseWakeFailure(new Error(DAEMON), runner(checkOutput({ fuse: true })));
  assert.equal(stuck.kind, "disk-restoring");
  assert.equal(stuck.checked, true);
  assert.match(stuck.detail!, /waiting on a file not restored yet: 4242 node \(fuse_simple_request\)/);
  const hydrating = await diagnoseWakeFailure(new Error(DAEMON), runner(checkOutput({ hydrating: true })));
  assert.equal(hydrating.kind, "disk-restoring");
  assert.equal(hydrating.detail, "[SNAPSHOT-INC] lazy volume hydration in progress");
  // Nothing of the kind: it stays bb's own failure, told in bb's words.
  assert.equal((await diagnoseWakeFailure(new Error(DAEMON), runner(checkOutput()))).kind, "other");
});

test("an SSH failure is a stuck session when login scripts hang, the disk when storage fails, else unreachable", async () => {
  const motd = await diagnoseWakeFailure(new Error(UNREACHABLE), runner(checkOutput({ motd: true, hydrating: true })));
  assert.equal(motd.kind, "ssh-session-stuck");
  assert.match(motd.detail!, /90-updates-available/);
  // Storage errors explain the rest: they win.
  const failing = await diagnoseWakeFailure(new Error(UNREACHABLE), runner(checkOutput({ motd: true, hydrator: true })));
  assert.equal(failing.kind, "disk-restoring");
  assert.match(failing.detail!, /^HYDRATOR FAILED attempt 32/);
  const eio = await diagnoseWakeFailure(new Error(UNREACHABLE), runner(checkOutput({ eio: true })));
  assert.equal(eio.kind, "disk-restoring");
  assert.equal(eio.detail, "~/.profile: Input/output error");
  const clean = await diagnoseWakeFailure(new Error(UNREACHABLE), runner(checkOutput()));
  assert.deepEqual(clean, { kind: "ssh-unreachable", detail: "Machine bootstrap command failed: Timeout, server 203.0.113.7 not responding … ssh … exit status 255", checked: true });
});

test("the key step's EIO is the disk, with boat.dev's error from the journal; a stopped sandbox isn't looked at", async () => {
  const keyStep = await diagnoseWakeFailure(new Error(KEY_STEP), runner(checkOutput({ hydrator: true, eio: true })));
  assert.equal(keyStep.kind, "disk-restoring");
  assert.match(keyStep.detail!, /status code 503$/);
  // Not running (the check returns null): the text's verdict.
  const notRunning = await diagnoseWakeFailure(new Error(KEY_STEP), async () => null);
  assert.deepEqual(notRunning, { kind: "disk-restoring", detail: "grep: /home/user/.ssh/authorized_keys: Input/output error", checked: false });
  // The look itself hit EIO: that's the disk too.
  const failedLook = await diagnoseWakeFailure(new Error(UNREACHABLE), async () => { throw new Error("bash: /home/user/.profile: Input/output error"); });
  assert.equal(failedLook.kind, "disk-restoring");
  // A refused restore needs no look at all.
  const calls: string[] = [];
  const rate = await diagnoseWakeFailure(new Error(RATE), runner(checkOutput(), calls));
  assert.equal(rate.kind, "restore-rate-limited");
  assert.deepEqual(calls, []);
});

test("the machine's message says what boat.dev is doing and when Boat retries", () => {
  const now = Date.parse("2026-11-19T01:48:00Z");
  const retryAt = Date.parse("2026-11-19T01:52:00Z");
  assert.equal(
    wakeFailureMessage({ kind: "disk-restoring", detail: "HYDRATOR FAILED attempt 32 …: status code 503", checked: true }, { retryAt, now }, "raw"),
    "boat.dev is still restoring this sandbox's disk (its storage is returning errors). Boat will retry at 01:52 UTC; pressing Resume earlier won't help.",
  );
  assert.equal(
    wakeFailureMessage({ kind: "disk-restoring", detail: "waiting on a file not restored yet: 4242 node (fuse_file_open)", checked: true }, { retryAt, now }, "raw"),
    "boat.dev is still restoring this sandbox's disk (files bb needs there aren't readable yet). Boat will retry at 01:52 UTC; pressing Resume earlier won't help.",
  );
  assert.equal(
    wakeFailureMessage({ kind: "restore-rate-limited", detail: RATE, checked: false }, { retryAt, now }, "raw"),
    "boat.dev is restoring too many sandboxes at once and asked Boat to slow down. Boat will retry at 01:52 UTC; pressing Resume earlier won't help.",
  );
  assert.equal(
    wakeFailureMessage({ kind: "ssh-session-stuck", detail: null, checked: true }, { retryAt, now }, "raw"),
    "The sandbox took Boat's SSH login, but the session never started: its login message scripts hang while boat.dev restores the disk. Boat turns them off before each try. Boat will retry at 01:52 UTC; pressing Resume earlier won't help.",
  );
  assert.equal(
    wakeFailureMessage({ kind: "disk-restoring", detail: "HYDRATOR FAILED …: status code 503", checked: true }, { retryAt: null, gaveUpAfter: 5, resumeAfter: Date.parse("2026-11-19T02:22:00Z"), sandboxId: "bx_demo1", now }, "raw"),
    "boat.dev still couldn't restore this sandbox's disk after 5 tries (its storage is returning errors), so Boat stopped retrying on its own. It's under Needs you. Press Resume after 02:22 UTC, or try now with `bb boat sandbox resume bx_demo1`.",
  );
  assert.match(wakeFailureMessage({ kind: "ssh-unreachable", detail: "exit status 255", checked: true }, { retryAt: null, now }, "raw"), /^Boat couldn't reach the sandbox over SSH to restart bb there \(exit status 255\)\. Press Resume to try again/);
  assert.equal(wakeFailureMessage({ kind: "other", detail: null, checked: false }, { retryAt: null, now }, "npm error code E404"), "npm error code E404");
});

test("the check's journal patterns find lazyfs's lines but never the check's own text", () => {
  const patterns = [...DISK_CHECK_SCRIPT.matchAll(/grep -a -E '([^']+)'/g)].map((match) => new RegExp(match[1]!));
  assert.equal(patterns.length, 3);
  assert.ok(patterns[0]!.test(HYDRATOR));
  assert.ok(patterns[1]!.test(HYDRATING));
  assert.ok(patterns[2]!.test("Error: Cannot find module '/home/user/.bb-machines/acme/npm/lib/node_modules/bb-app/dist/bb.js'"));
  assert.ok(patterns[2]!.test("code: 'MODULE_NOT_FOUND'"));
  assert.ok(patterns[2]!.test("bash: /home/user/.bb-machines/acme/npm/bin/bb-app: No such file or directory"));
  // boat's journal can log the commands run in the sandbox, this one too.
  for (const line of DISK_CHECK_SCRIPT.split("\n")) for (const pattern of patterns) assert.ok(!pattern.test(line), line);
  // The login-script test can't match the check's own shell either.
  assert.ok(!DISK_CHECK_SCRIPT.includes("/update-motd.d/"));
});

test("bb's daemon broken by an auto-update: an npm zombie, its unit stuck deactivating, a module it can't load or its missing entry point", async () => {
  const seen = parseDiskCheck([
    "BOAT_ZOMBIE 5150 Zl [npm install -g] <defunct>",
    "BOAT_UNIT bb-host-daemon-acme.service deactivating stop-sigterm",
    "BOAT_BB_DIR /home/user/.bb-machines/acme",
    "BOAT_BB_MISSING /home/user/.bb-machines/acme",
    "BOAT_BB_LOG code: 'MODULE_NOT_FOUND'",
    "BOAT_DISK_END",
  ].join("\n"));
  assert.deepEqual(seen.daemon, {
    zombies: ["[npm install -g] <defunct> (pid 5150, Zl)"],
    units: [{ unit: "bb-host-daemon-acme.service", active: "deactivating", sub: "stop-sigterm" }],
    log: "code: 'MODULE_NOT_FOUND'",
    missing: ["/home/user/.bb-machines/acme"],
    dirs: ["/home/user/.bb-machines/acme"],
  });
  assert.equal(daemonBroken(seen), true);
  // A zombie, the missing entry point or a module it can't load is each enough.
  for (const line of ["BOAT_ZOMBIE 77 Z [npm install] <defunct>", "BOAT_BB_MISSING /home/user/.bb-machines/x", "BOAT_BB_LOG Error: Cannot find module 'x'"]) {
    assert.equal(daemonBroken(parseDiskCheck(`${line}\nBOAT_DISK_END`)), true, line);
  }
  // A unit only "deactivating" isn't: npm blocked on a disk still restoring looks the same, and waiting fixes it.
  assert.equal(daemonBroken(parseDiskCheck("BOAT_UNIT bb-host-daemon-x.service deactivating stop\nBOAT_DISK_END")), false);
  assert.equal(daemonBroken(parseDiskCheck("BOAT_UNIT bb-host-daemon-x.service active running\nBOAT_BB_DIR /home/user/.bb-machines/x\nBOAT_DISK_END")), false);
  assert.equal((await diagnoseWakeFailure(new Error(DAEMON), runner("BOAT_UNIT bb-host-daemon-acme.service deactivating stop-sigterm\nBOAT_DISK_END\n"))).kind, "other");
  // "did not start within 20 seconds" plus a module it can't load: daemon-broken, with where to repair it.
  const diagnosis = await diagnoseWakeFailure(new Error(DAEMON), runner("BOAT_UNIT bb-host-daemon-acme-host_1.service deactivating stop-sigterm\nBOAT_BB_DIR /home/user/.bb-machines/acme\nBOAT_BB_LOG code: 'MODULE_NOT_FOUND'\nBOAT_DISK_END\n"));
  assert.equal(diagnosis.kind, "daemon-broken");
  assert.deepEqual(diagnosis.daemon, { dir: "/home/user/.bb-machines/acme", unit: "bb-host-daemon-acme-host_1.service", zombie: false, dirs: ["/home/user/.bb-machines/acme"], units: ["bb-host-daemon-acme-host_1.service"] });
  // A read waiting on lazyfs comes first: npm blocked on a disk still restoring is waited out, not repaired.
  assert.equal((await diagnoseWakeFailure(new Error(DAEMON), runner("BOAT_DSTATE 4242 request_wait_answer fuse_file_open  node npm\nBOAT_ZOMBIE 5150 Zl [npm install -g] <defunct>\nBOAT_DISK_END\n"))).kind, "disk-restoring");
  assert.equal(retriesLater("daemon-broken"), false, "a repair by hand, not a retry");
  // Storage failing comes first: the daemon can't load files that don't restore.
  assert.equal((await diagnoseWakeFailure(new Error(DAEMON), runner(`BOAT_HYDRATOR ${HYDRATOR}\nBOAT_ZOMBIE 5150 Zl [npm install -g] <defunct>\nBOAT_DISK_END\n`))).kind, "disk-restoring");
  // The check's own text never reads as a missing entry point.
  assert.ok(!DISK_CHECK_SCRIPT.includes("npm/bin/bb-app"));
});

test("the daemon unit is this machine's: bb-host-daemon-<server with dashes>-<host id>.service", () => {
  const daemon = {
    dirs: ["/home/user/.bb-machines/other.example", "/home/user/.bb-machines/bb.example.com"],
    units: ["bb-host-daemon-other-example-host_zz9.service", "bb-host-daemon-bb-example-com-host_ab1.service"],
  };
  assert.deepEqual(pickDaemon(daemon, "host_ab1"), { dir: "/home/user/.bb-machines/bb.example.com", unit: "bb-host-daemon-bb-example-com-host_ab1.service" });
  assert.deepEqual(pickDaemon(daemon, "host_zz9"), { dir: "/home/user/.bb-machines/other.example", unit: "bb-host-daemon-other-example-host_zz9.service" });
  // Several and none of them this host's: no guess.
  assert.deepEqual(pickDaemon(daemon, "host_nope"), { dir: null, unit: null });
  assert.deepEqual(pickDaemon(daemon, null), { dir: null, unit: null });
  // The only one there is.
  assert.deepEqual(pickDaemon({ dirs: ["/home/user/.bb-machines/acme"], units: ["bb-host-daemon-acme-host_1.service"] }, null), { dir: "/home/user/.bb-machines/acme", unit: "bb-host-daemon-acme-host_1.service" });
  // The repair text never names another machine's unit: it says how to find this one.
  const text = daemonRepairQuestion({ sandboxId: "bx_demo1", detail: null, hostId: "host_nope", daemon: { dir: null, unit: daemon.units[0]!, zombie: false, ...daemon } });
  assert.match(text.context, /systemctl --user reset-failed <this machine's unit, bb-host-daemon-<server>-host_nope\.service: systemctl --user list-units 'bb-host-daemon\*'>/);
  assert.match(text.context, /^D=~\/\.bb-machines\/<server>$/m);
});
