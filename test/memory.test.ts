// Sandbox sizes and memory without I/O: the probe's parsing, kernel kills,
// the out-of-memory finding, the words, the recommendation and the prompts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NEAR_LIMIT,
  decodeData,
  encodeData,
  errorWithOom,
  governingProject,
  inferType,
  movedNote,
  oomCausedFailure,
  oomFinding,
  oomHistory,
  oomMessage,
  parseKernelKills,
  parseProbe,
  peakLine,
  probeScript,
  recommendSize,
  samplerScript,
  sandboxLine,
  settledOomMessage,
  sizeSummary,
  splitOomError,
  turnWindow,
  victimLabel,
  type MemoryData,
} from "../src/memory.ts";
import { SIZE_FACTS } from "../src/setup.ts";
import { oomLines, probeOutput } from "./fakes.ts";

const BOOT = "0f3c1d2e-aaaa-bbbb-cccc-123456789abc";

/** The two lines today's kill printed, with the host and cgroup names made up. */
const REAL = [
  "1762400000.100000 box-node-test kernel: oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=user.slice,mems_allowed=0,global_oom,task_memcg=/user.slice/user-1000.slice/user@1000.service/app.slice/bb-host-daemon-acme.service,task=MainThread,pid=187709,uid=1000",
  "1762400000.100100 box-node-test kernel: Out of memory: Killed process 187709 (MainThread) total-vm:54751784kB, anon-rss:1467032kB, file-rss:3072kB, shmem-rss:0kB, UID:1000 pgtables:38764kB oom_score_adj:200",
];

test("the probe's output: every field, the last complete block only, clamped", () => {
  const out = probeOutput({ now: 1762400100, bootId: BOOT, bootTime: 1762300000, cpus: 4, memTotalKb: 8131944, memAvailableKb: 6000000, oomKills: 1, klog: "journal", kernel: REAL, peak: "6396314 8131944 120 1762399900 1762400090 0 4242" });
  const probe = parseProbe(out)!;
  assert.equal(probe.now, 1762400100);
  assert.equal(probe.bootId, BOOT);
  assert.equal(probe.bootTime, 1762300000);
  assert.equal(probe.cpus, 4);
  assert.equal(probe.memTotalKb, 8131944);
  assert.equal(probe.memAvailableKb, 6000000);
  assert.equal(probe.oomKills, 1);
  assert.equal(probe.klog, "journal");
  assert.equal(probe.lines.length, 2);
  assert.deepEqual(probe.peak, { peakKb: 6396314, memTotalKb: 8131944, samples: 120, start: 1762399900, last: 1762400090, swapKb: 0, pid: 4242 });

  assert.equal(parseProbe("hello\nworld"), null);
  // No END: cut off, so nothing counts.
  assert.equal(parseProbe("BOAT_MEM_PROBE 1\nCPUS 4\n"), null);
  // A login profile that prints a fake block first: only the last block counts.
  const faked = `BOAT_MEM_PROBE 1\nCPUS 64\nOOM 99\nEND\n${probeOutput({ cpus: 2, memTotalKb: 4000000, oomKills: 0 })}`;
  assert.equal(parseProbe(faked)!.cpus, 2);
  assert.equal(parseProbe(faked)!.oomKills, 0);
  // Garbage and impossible numbers become null.
  const garbage = parseProbe("BOAT_MEM_PROBE 1\nNOW soon\nCPUS 512\nMEM 999999999999 x 1 2\nOOM -1\nPEAK -\nBOOT ../../etc 12\nEND\n")!;
  assert.equal(garbage.now, null);
  assert.equal(garbage.cpus, null);
  assert.equal(garbage.memTotalKb, null);
  assert.equal(garbage.oomKills, null);
  assert.equal(garbage.peak, null);
  assert.equal(garbage.bootId, null);
  // A peak above memory and swap, or more samples than seconds, is refused.
  assert.equal(parseProbe(probeOutput({ memTotalKb: 8131944, peak: "99999999 8131944 10 1762399900 1762400000" }))!.peak, null);
  assert.equal(parseProbe(probeOutput({ memTotalKb: 8131944, peak: "6000000 8131944 5000 1762399900 1762400000" }))!.peak, null);
});

test("kernel kill lines: joined by pid, the cgroup and oom_score_adj say where it ran", () => {
  const [kill] = parseKernelKills(REAL);
  assert.deepEqual(kill, { at: 1762400000.1001, pid: 187709, process: "MainThread", rssKb: 1470104, unit: "bb", constraint: "global", adj: 200 });

  const memcg = parseKernelKills(["1762400000.5 box-node-test kernel: Memory cgroup out of memory: Killed process 4242 (node) total-vm:1kB, anon-rss:900000kB, file-rss:0kB, shmem-rss:0kB, UID:1000 pgtables:1kB oom_score_adj:0"]);
  assert.equal(memcg[0]!.constraint, "cgroup");
  assert.equal(memcg[0]!.unit, "other");

  const two = parseKernelKills([...oomLines({ at: 1762400000, pid: 11, comm: "node", unit: "command", rssKb: 900000 }), ...oomLines({ at: 1762400030, pid: 12, comm: "chrome", unit: "bb", rssKb: 1200000 })]);
  assert.deepEqual(two.map((entry) => [entry.pid, entry.process, entry.unit]), [[11, "node", "command"], [12, "chrome", "bb"]]);

  assert.deepEqual(parseKernelKills(["1762400000.1 box-node-test kernel: EXT4-fs (sda1): mounted", "1762400000.2 box-node-test kernel: usb 1-1: new device"]), []);

  // Without its rate-limited oom-kill: partner, the adj still says where: -900 is boat's headless agent.
  const alone = parseKernelKills(["1762400000.2 box-node-test kernel: Out of memory: Killed process 77 (node) total-vm:1kB, anon-rss:500000kB, file-rss:0kB, shmem-rss:0kB, UID:1000 pgtables:1kB oom_score_adj:-900"]);
  assert.equal(alone[0]!.unit, "agent");
  const plain = parseKernelKills(["1762400000.2 box-node-test kernel: Out of memory: Killed process 78 (python3) total-vm:1kB, anon-rss:500000kB, file-rss:0kB, shmem-rss:0kB, UID:1000 pgtables:1kB oom_score_adj:0"]);
  assert.equal(plain[0]!.unit, "other");
  // A process name from the sandbox can't carry markup or newlines.
  const odd = parseKernelKills(["1762400000.2 box-node-test kernel: Out of memory: Killed process 79 (`rm -rf`*) total-vm:1kB, anon-rss:1kB, file-rss:0kB, shmem-rss:0kB, UID:1000 pgtables:1kB oom_score_adj:0"]);
  assert.equal(odd[0]!.process, "rm-rf");
  // systemd-oomd kills a whole service.
  const oomd = parseKernelKills([], ["1762400000.3 box-node-test systemd-oomd[512]: Killed /user.slice/user-1000.slice/user@1000.service/app.slice/bb-host-daemon-acme.service due to memory used (7.1G) / total (7.7G)"]);
  assert.equal(oomd[0]!.constraint, "oomd");
  assert.equal(victimLabel(oomd[0]!), "the task chat's processes");
});

test("the finding: kills in the turn, no false positives, counter evidence is only a maybe", () => {
  const since = 1762399990;
  const withKill = parseProbe(probeOutput({ bootId: BOOT, oomKills: 1, klog: "journal", kernel: REAL }))!;
  const found = oomFinding(withKill, { since, baseline: { bootId: BOOT, oomKills: 0 }, reported: new Set() })!;
  assert.equal(found.certain, true);
  assert.equal(found.count, 1);
  assert.equal(found.source, "journal");
  assert.equal(victimLabel(found.kills[0]!), "a 1.4 GB process in the task chat (MainThread)");

  // Readable journal, no kill line: none, even when the counter moved (that kill was another turn's).
  const quiet = parseProbe(probeOutput({ bootId: BOOT, oomKills: 3, klog: "journal", kernel: [] }))!;
  assert.equal(oomFinding(quiet, { since, baseline: { bootId: BOOT, oomKills: 0 }, reported: new Set() }), null);
  // A kill before the turn started, or one already reported, doesn't count.
  assert.equal(oomFinding(withKill, { since: 1762400001, baseline: null, reported: new Set() }), null);
  assert.equal(oomFinding(withKill, { since, baseline: null, reported: new Set([found.kills[0]!.key]) }), null);
  // The sampler's own death isn't the work's.
  assert.equal(oomFinding(withKill, { since, baseline: null, reported: new Set(), excludePids: new Set([187709]) }), null);

  // No readable log: the counter against a reading of the same boot, as a maybe.
  const blind = parseProbe(probeOutput({ bootId: BOOT, oomKills: 2, klog: "none" }))!;
  const maybe = oomFinding(blind, { since, baseline: { bootId: BOOT, oomKills: 1 }, reported: new Set() })!;
  assert.deepEqual([maybe.certain, maybe.count, maybe.source], [false, 1, "counter"]);
  assert.equal(oomFinding(blind, { since, baseline: { bootId: BOOT, oomKills: 2 }, reported: new Set() }), null);
  assert.equal(oomFinding(blind, { since, baseline: null, reported: new Set() }), null);
  assert.equal(oomFinding(blind, { since, baseline: { bootId: BOOT, oomKills: 1 }, reported: new Set([maybe.counterKey!]) }), null);
  // Rebooted during the turn: the kills since that boot.
  const rebooted = parseProbe(probeOutput({ bootId: "11111111-2222-3333-4444-555555555555", bootTime: since + 5, oomKills: 1, klog: "none" }))!;
  assert.equal(oomFinding(rebooted, { since, baseline: { bootId: BOOT, oomKills: 0 }, reported: new Set() })!.count, 1);
  // Rebooted before the turn (a stop and resume) with no reading of this boot: its counter started at 0.
  const bootedBefore = parseProbe(probeOutput({ bootId: "11111111-2222-3333-4444-555555555555", bootTime: since - 500, oomKills: 1, klog: "none" }))!;
  assert.deepEqual(
    (({ certain, count, source }) => ({ certain, count, source }))(oomFinding(bootedBefore, { since, baseline: { bootId: BOOT, oomKills: 0 }, reported: new Set() })!),
    { certain: false, count: 1, source: "counter" },
  );
  const quietBoot = parseProbe(probeOutput({ bootId: "11111111-2222-3333-4444-555555555555", bootTime: since - 500, oomKills: 0, klog: "none" }))!;
  assert.equal(oomFinding(quietBoot, { since, baseline: { bootId: BOOT, oomKills: 3 }, reported: new Set() }), null);
  // Without boot ids only a boot inside the turn counts.
  const noIds = parseProbe(probeOutput({ bootId: null, bootTime: since - 500, oomKills: 1, klog: "none" }))!;
  assert.equal(oomFinding(noIds, { since, baseline: { bootId: null, oomKills: 0 }, reported: new Set() }), null);
  // A journal read that ran out of time falls back to the counter.
  const slow = parseProbe(probeOutput({ bootId: BOOT, oomKills: 1, klog: "journal", kernel: [], klogTimedOut: true }))!;
  assert.equal(oomFinding(slow, { since, baseline: { bootId: BOOT, oomKills: 0 }, reported: new Set() })!.certain, false);
});

test("the turn window: a margin for clock skew, never into the previous turn", () => {
  const at = (seconds: number) => new Date(seconds * 1000).toISOString();
  const events = [
    { at: at(1000), kind: "dispatched" },
    { at: at(1500), kind: "finished" },
    { at: at(1510), kind: "followup" },
  ];
  assert.deepEqual(turnWindow(events, null), { start: 1510, since: 1500 });
  assert.deepEqual(turnWindow(events.slice(0, 1), null), { start: 1000, since: 985 });
  // A chat follow-up marker newer than the events.
  assert.deepEqual(turnWindow(events, 2000_000), { start: 2000, since: 1985 });
  assert.equal(turnWindow([], null), null);
});

test("who was stopped, in plain words", () => {
  const kill = (process: string, unit: "bb" | "agent" | "command" | "other", rssKb: number | null = 1470104) => ({ process, unit, rssKb, constraint: "global" as const });
  assert.equal(victimLabel(kill("MainThread", "bb")), "a 1.4 GB process in the task chat (MainThread)");
  assert.equal(victimLabel(kill("claude", "bb")), "Claude Code (1.4 GB)");
  assert.equal(victimLabel(kill("codex", "agent", null)), "Codex");
  assert.equal(victimLabel(kill("chrome", "bb")), "a browser (chrome, 1.4 GB)");
  assert.equal(victimLabel(kill("node", "agent")), "a 1.4 GB process the agent started (node)");
  assert.equal(victimLabel(kill("node", "command")), "a 1.4 GB process (node)");

  const one = { kills: [{ ...kill("MainThread", "bb"), key: "a", at: 1, pid: 1, adj: 200 }], count: 1 };
  const base = { current: "default" as const, next: "large" as const, nextAllowed: true, cause: true, chatRestart: true, others: [] };
  assert.equal(
    oomMessage(one, base),
    "The sandbox ran out of memory: the system stopped a 1.4 GB process in the task chat (MainThread). That restarted bb on the sandbox and ended the chat's turn. Run fewer tests at once, or continue on a larger sandbox.",
  );
  const two = { kills: [one.kills[0]!, { ...kill("chrome", "command"), key: "b", at: 2, pid: 2, adj: 0 }], count: 2 };
  assert.match(oomMessage(two, { ...base, chatRestart: false }), /stopped a 1\.4 GB process in the task chat \(MainThread\) and a browser \(chrome, 1\.4 GB\)\./);
  assert.match(oomMessage({ kills: two.kills, count: 5 }, base), /and 4 other processes\./);
  assert.match(oomMessage({ kills: [], count: 1 }, base), /stopped a process\./);
  // What the plan allows decides the advice.
  assert.match(oomMessage(one, { ...base, current: "xlarge", next: null }), /Run fewer tests at once \(XLarge is the largest sandbox\)\.$/);
  assert.match(oomMessage(one, { ...base, nextAllowed: false }), /Run fewer tests at once \(your boat plan doesn't include a larger sandbox\)\.$/);
  // Other tasks on the sandbox, and a kill that isn't why the turn failed.
  assert.match(oomMessage(one, { ...base, others: ["Review: Add dark mode"] }), / “Review: Add dark mode” also uses this sandbox\.$/);
  assert.match(oomMessage(one, { ...base, others: ["A", "B", "C"] }), / “A”, “B” and “C” also use this sandbox\.$/);
  // Moved since, or closed: no "continue on a larger sandbox".
  const text = oomMessage(one, base);
  assert.match(settledOomMessage(text, { movedTo: "large", closed: false }), /Run fewer|The sandbox is Large now\. Send a follow-up to continue\.$/);
  assert.doesNotMatch(settledOomMessage(text, { movedTo: "large", closed: false }), /continue on a larger sandbox/);
  assert.match(settledOomMessage(text, { movedTo: null, closed: true }), /ended the chat's turn\. Run fewer tests at once\.$/);
  assert.equal(settledOomMessage(text, { movedTo: null, closed: false }), text);
  assert.match(oomMessage(one, { ...base, cause: false, chatRestart: false }), /^The sandbox also ran out of memory during this turn: /);

  assert.deepEqual(oomHistory({ ...one, certain: true }), ["Out of memory: the system stopped a 1.4 GB process in the task chat (MainThread)."]);
  assert.match(oomHistory({ kills: [], count: 2, certain: false })[0]!, /^The sandbox may have run out of memory: its kernel counted 2 out-of-memory kills/);
});

test("the error: the message first with the original as detail, or the original first when the kills aren't why", () => {
  const finding = { kills: [{ process: "vitest", unit: "command" as const, rssKb: 1, constraint: "global" as const, key: "k", at: 1, pid: 1, adj: 0 }], certain: true };
  assert.equal(oomCausedFailure(finding, "The agent turn failed: API error 529 overloaded", "boat"), false);
  assert.equal(oomCausedFailure(finding, "The task chat stopped with an error: Thread interrupted because the host daemon disconnected.", "chat"), true);
  assert.equal(oomCausedFailure(finding, "process exited with code 137", "boat"), true);
  // bb's restart ends a task chat's turn, not a headless agent's.
  assert.equal(oomCausedFailure({ ...finding, kills: [{ ...finding.kills[0]!, unit: "bb" }] }, "anything", "chat"), true);
  assert.equal(oomCausedFailure({ ...finding, kills: [{ ...finding.kills[0]!, unit: "bb" }] }, "API error 529: overloaded", "boat"), false);
  assert.equal(oomCausedFailure({ ...finding, kills: [{ ...finding.kills[0]!, process: "claude", unit: "agent" }] }, "harness exited", "boat"), true);
  assert.equal(oomCausedFailure({ ...finding, certain: false }, "killed", "boat"), false);

  const rewritten = errorWithOom("The sandbox ran out of memory: x.", "Thread interrupted.", true);
  assert.equal(rewritten, "The sandbox ran out of memory: x.\n\nOriginal error: Thread interrupted.");
  assert.deepEqual(splitOomError(rewritten), { message: "The sandbox ran out of memory: x.", original: "Thread interrupted." });
  assert.equal(errorWithOom("The sandbox also ran out of memory.", "API error.", false), "API error.\n\nThe sandbox also ran out of memory.");
  assert.ok(errorWithOom("m", "x".repeat(5000), true).length <= 4000);
});

test("the size from what the VM reports", () => {
  assert.equal(inferType(2, 4_000_000), "small");
  assert.equal(inferType(4, 8_131_944), "default");
  assert.equal(inferType(8, 16_300_000), "large");
  assert.equal(inferType(16, 32_800_000), "xlarge");
  // Memory wins when the CPUs disagree; CPUs only without memory.
  assert.equal(inferType(4, 16_300_000), "large");
  assert.equal(inferType(8, null), "large");
  assert.equal(inferType(3, 12_000_000), null);
  assert.equal(inferType(null, null), null);
  assert.equal(sizeSummary({ type: "default", cpus: 4, memTotalKb: 8_131_944 }), "Default (4 vCPU, 8 GB)");
  assert.equal(sizeSummary({ type: null, cpus: 3, memTotalKb: 12_000_000 }), "3 vCPU, about 11 GB");
  assert.equal(sizeSummary(null), null);
  // The size pickers read the same facts.
  assert.equal(SIZE_FACTS.large!.detail, "8 vCPU, 16 GB · double rate");
  assert.equal(SIZE_FACTS.small!.detail, "2 vCPU, 4 GB · half rate");
});

test("the recommendation: next size up at 75% or after a kill, with the plan's verdict", () => {
  const total = 8_131_944;
  const trial = [
    { type: "small", available: true, reason: null },
    { type: "default", available: true, reason: null },
    { type: "large", available: false, reason: "not during the free trial; the first payment unlocks it" },
    { type: "xlarge", available: false, reason: null },
  ];
  assert.equal(NEAR_LIMIT, 0.75);
  assert.deepEqual(recommendSize({ peakKb: Math.floor(total * 0.74), memTotalKb: total, oom: false, current: "default", plan: null }), { type: "default", reason: "fits", allowed: true, planReason: null });
  assert.deepEqual(recommendSize({ peakKb: Math.ceil(total * 0.75), memTotalKb: total, oom: false, current: "default", plan: null }), { type: "large", reason: "near-limit", allowed: true, planReason: null });
  assert.equal(recommendSize({ peakKb: Math.floor(total * 0.4), memTotalKb: total, oom: true, current: "default", plan: null })!.reason, "out-of-memory");
  assert.deepEqual(recommendSize({ peakKb: null, memTotalKb: null, oom: true, current: "xlarge", plan: null }), { type: "xlarge", reason: "largest", allowed: true, planReason: null });
  assert.deepEqual(recommendSize({ peakKb: total, memTotalKb: total, oom: false, current: "default", plan: trial }), {
    type: "large",
    reason: "near-limit",
    allowed: false,
    planReason: "not during the free trial; the first payment unlocks it",
  });
  assert.equal(recommendSize({ peakKb: total, memTotalKb: total, oom: false, current: "large", plan: trial })!.planReason, "Your boat plan doesn't include this size.");
  assert.equal(recommendSize({ peakKb: total, memTotalKb: total, oom: false, current: null, plan: null }), null);

  const near = recommendSize({ peakKb: 6_396_314, memTotalKb: total, oom: false, current: "default", plan: trial });
  assert.equal(
    peakLine({ peakKb: 6_396_314, memTotalKb: total, machineType: "default" }, near),
    "Peak memory during this turn: 6.1 of 8 GB. Recommended size: Large. Your boat plan doesn't include Large: not during the free trial; the first payment unlocks it.",
  );
});

test("the prompt line and the follow-up note after a move", () => {
  const known = { type: "default" as const, cpus: 4, memTotalKb: 8_131_944 };
  const chat = sandboxLine(known, "chat");
  assert.match(chat, /^- This sandbox is Default size: 4 CPUs and 8 GB of memory, shared with other processes \(bb itself, other tasks' checkouts, preview servers\)\./);
  assert.match(chat, /one at a time, not all at once: running out of memory stops processes, this chat included\.$/);
  const boat = sandboxLine(known, "boat");
  assert.doesNotMatch(boat, /bb itself|this chat/);
  assert.match(boat, /one at a time, not all at once\.$/);
  assert.match(sandboxLine({ type: null, cpus: 3, memTotalKb: 12_000_000 }, "boat"), /^- This sandbox has 3 CPUs and about 11 GB of memory/);
  assert.match(sandboxLine(null, "boat"), /^- Other processes may share this sandbox's CPUs and memory/);

  assert.match(movedNote("default", "large"), /^The sandbox moved to a larger machine: it's now Large, 8 CPUs and 16 GB of memory\./);
  assert.match(movedNote("large", "default"), /a smaller machine/);
  assert.match(movedNote(null, "large"), /another machine size/);
});

test("the scripts: a marker, a window only when asked, a safe task id, the sampler's deadline", () => {
  const plain = probeScript();
  assert.match(plain, /^echo BOAT_MEM_PROBE 1/);
  assert.match(plain, /echo END$/);
  assert.doesNotMatch(plain, /journalctl|boat-memory/);
  const windowed = probeScript({ since: 1762400000.7, task: "t_ab;rm -rf /", stopSampler: true });
  assert.match(windowed, /--since @1762400000 /);
  assert.match(windowed, /journalctl -k -b/);
  assert.match(windowed, /\/tmp\/boat-memory\/t_abrmrf\.peak/);
  assert.match(windowed, /touch \/tmp\/boat-memory\/t_abrmrf\.stop/);
  assert.doesNotMatch(windowed, /dmesg/);
  // Each journal read has its own timeout, under boat's.
  assert.match(windowed, /timeout 2 "\$@" journalctl/);
  assert.match(windowed, /timeout 5 \$S journalctl/);
  // Every step is capped, systemctl too (the probe stays under boat's 15 s).
  assert.match(windowed, /if timeout 2 systemctl is-active --quiet systemd-oomd/);
  assert.match(windowed, /\[ "\$R" != 0 \] && \[ "\$R" != 124 \] && echo KLOG_FAIL/);
  // A known way to read the log skips finding it again, only in the same boot.
  const cached = probeScript({ since: 1, klog: { mode: "sudo", bootId: BOOT } });
  assert.match(cached, new RegExp(`^if \\[ "\\$\\(cat /proc/sys/kernel/random/boot_id 2>/dev/null\\)" = "${BOOT}" \\]; then J=sudo; else J=-; if kread; then J=journal; elif kread sudo -n; then J=sudo; fi; fi$`, "m"));
  // A boot id that isn't one is never put in the script.
  assert.doesNotMatch(probeScript({ since: 1, klog: { mode: "sudo", bootId: "$(reboot)" } }), /reboot|then J=sudo; else/);
  assert.doesNotMatch(probeScript({ since: 1, klog: { mode: "sudo", bootId: null } }), /then J=sudo; else/);
  // A failed read decides nothing: the counter does.
  assert.equal(parseProbe("BOAT_MEM_PROBE 1\nOOM 2\nKLOG sudo\nKLOG_FAIL\nEND\n")!.klog, "none");
  const sampler = samplerScript("t_ab;x");
  assert.match(sampler, /end=\$\(\(start \+ 14400\)\)/);
  assert.match(sampler, /\/tmp\/boat-memory\/t_abx\.stop/);
  assert.match(sampler, /MemAvailable/);
});

test("records survive the history's 4000 characters, and only the project that governs a task sets its size", () => {
  const big: MemoryData = {
    type: "oom",
    turn: 3,
    sandboxId: "bx_test1",
    machineType: "default",
    kills: Array.from({ length: 3 }, (_, index) => ({ key: `${"f".repeat(36)}:${index}:1762400000`, process: "abcdefghijklmno", label: victimLabel({ process: "abcdefghijklmno", unit: "bb", rssKb: 99_999_999, constraint: "global" }), unit: "bb" as const, rssKb: 99_999_999, at: 1762400000 })),
    count: 40,
    source: "journal",
    certain: true,
    cause: true,
    counterKey: null,
    message: oomMessage({ kills: [], count: 40 }, { current: "default", next: "large", nextAllowed: false, cause: true, chatRestart: true, others: ["t_aaaaaaaa", "t_bbbbbbbb", "t_cccccccc", "t_dddddddd"] }),
    next: "large",
    nextAllowed: false,
    nextReason: "x".repeat(200),
    at: 1762400000,
  };
  const text = encodeData(big);
  assert.ok(text.length < 3500, `${text.length} characters`);
  assert.deepEqual(decodeData(text), big);
  assert.equal(decodeData("{not json"), null);
  assert.equal(decodeData('{"type":"other"}'), null);

  const projects = [
    { id: "web", name: "Web app", repos: [{ repo: "acme/web" }, { repo: "acme/api" }], machineType: "large" as const },
    { id: "docs", name: "Docs", repos: [{ repo: "acme/docs" }], machineType: null },
    { id: "api", name: "API", repos: [{ repo: "acme/api" }], machineType: "xlarge" as const },
  ];
  assert.equal(governingProject(projects, "web", "acme/api")?.id, "web");
  // Its own project without a size: the setting (no fall-through to another project).
  assert.equal(governingProject(projects, "docs", "acme/api")?.machineType, null);
  // No project: the one whose main repo it is, not one that merely lists it.
  assert.equal(governingProject(projects, null, "acme/API")?.id, "api");
  assert.equal(governingProject(projects, "local:proj_1", "acme/web")?.id, "web");
  assert.equal(governingProject(projects, null, "acme/other"), null);
});
