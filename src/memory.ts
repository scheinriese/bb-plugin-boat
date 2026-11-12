// Sandbox sizes and memory, without I/O: what each size is, the probe that
// reads a sandbox's size and its out-of-memory kills, the sampler that
// measures a turn's peak memory, the recommendation, and the words for all
// of it (prompts, history, notices).
//
// What a sandbox prints is untrusted: an agent there has full access (and
// passwordless sudo), and `boat exec` runs a login shell whose profile it can
// write. Every value is clamped, process names are sanitized, and probe data
// never moves a sandbox by itself.
import type { MachineType } from "./boat-api.ts";
import type { Runner, TaskEvent } from "./store.ts";
import { AUTO_RETRY_RECORD } from "./steer-retry.ts";

// ------------------------------------------------------------------ sizes

export const SIZE_ORDER: readonly MachineType[] = ["small", "default", "large", "xlarge"];

export interface SizeSpec {
  label: string;
  cpus: number;
  /** As boat names it ("8 GB"); the VM's MemTotal is a little less. */
  memoryGb: number;
  /** Price per hour against Default (XLarge: boat states none). */
  rate: "half" | "double" | null;
}

/** Sizes as `boat new --help` describes them (boat 1.0.89). */
export const SIZE_SPECS: Record<MachineType, SizeSpec> = {
  small: { label: "Small", cpus: 2, memoryGb: 4, rate: "half" },
  default: { label: "Default", cpus: 4, memoryGb: 8, rate: null },
  large: { label: "Large", cpus: 8, memoryGb: 16, rate: "double" },
  xlarge: { label: "XLarge", cpus: 16, memoryGb: 32, rate: null },
};

export function isMachineType(value: unknown): value is MachineType {
  return typeof value === "string" && (SIZE_ORDER as readonly string[]).includes(value);
}

/** "8 vCPU, 16 GB" */
export function specText(type: MachineType): string {
  const spec = SIZE_SPECS[type];
  return `${spec.cpus} vCPU, ${spec.memoryGb} GB`;
}

/** "8 vCPU, 16 GB · double rate" (the size pickers' wording). */
export function sizeDetail(type: MachineType): string {
  const spec = SIZE_SPECS[type];
  return `${specText(type)}${spec.rate ? ` · ${spec.rate} rate` : ""}`;
}

/** The next size up (null: XLarge is the largest). */
export function nextSize(type: MachineType): MachineType | null {
  return SIZE_ORDER[SIZE_ORDER.indexOf(type) + 1] ?? null;
}

/** Negative when a is smaller than b. */
export function compareSizes(a: MachineType, b: MachineType): number {
  return SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b);
}

const KB_PER_GIB = 1_048_576;

/** One decimal: 6396314 kB → 6.1. */
export function gb(kb: number): number {
  return Math.round((kb / KB_PER_GIB) * 10) / 10;
}

/**
 * The size from what the VM reports: memory decides (GiB within 0.85–1.05 of
 * boat's GB), CPUs only when memory is unknown. 4 CPUs and 7.76 GiB → default.
 */
export function inferType(cpus: number | null, memTotalKb: number | null): MachineType | null {
  const gib = memTotalKb !== null && memTotalKb > 0 ? memTotalKb / KB_PER_GIB : null;
  if (gib !== null) {
    return SIZE_ORDER.find((type) => gib >= SIZE_SPECS[type].memoryGb * 0.85 && gib <= SIZE_SPECS[type].memoryGb * 1.05) ?? null;
  }
  return cpus === null ? null : (SIZE_ORDER.find((type) => SIZE_SPECS[type].cpus === cpus) ?? null);
}

export interface KnownSize {
  type: MachineType | null;
  cpus: number | null;
  memTotalKb: number | null;
}

/** "Default (4 vCPU, 8 GB)"; unknown type: "4 vCPU, about 8 GB"; nothing known: null. */
export function sizeSummary(size: KnownSize | null): string | null {
  if (size === null) return null;
  if (size.type !== null) return `${SIZE_SPECS[size.type].label} (${specText(size.type)})`;
  if (size.cpus === null && size.memTotalKb === null) return null;
  return [size.cpus !== null ? `${size.cpus} vCPU` : null, size.memTotalKb !== null ? `about ${Math.round(size.memTotalKb / KB_PER_GIB)} GB` : null]
    .filter(Boolean)
    .join(", ");
}

/** Price per hour against Default (boat states none for XLarge). */
const RATE: Record<MachineType, number | null> = { small: 0.5, default: 1, large: 2, xlarge: null };
const TIMES: Record<string, string> = { "0.25": "a quarter as much", "0.5": "half as much", "2": "twice as much", "4": "four times as much" };

/**
 * "Large costs twice as much per hour as Default." Against `from` (the size
 * it is now) when given: "Large costs four times as much per hour as
 * Small." "" when there's nothing to say (the same rate); boat states no
 * rate for XLarge, so it only "costs more".
 */
export function costSentence(type: MachineType, from: MachineType | null = null): string {
  const base: MachineType = from ?? "default";
  if (type === base) return "";
  const to = RATE[type];
  const was = RATE[base];
  if (to === null || was === null) return compareSizes(type, base) > 0 ? `${SIZE_SPECS[type].label} costs more per hour than ${SIZE_SPECS[base].label}.` : "";
  const times = TIMES[String(to / was)];
  return times ? `${SIZE_SPECS[type].label} costs ${times} per hour as ${SIZE_SPECS[base].label}.` : "";
}

// ------------------------------------------------------------------ the probe

/** A task id as it may appear in a path (t_1a2b → t_1a2b; anything else is dropped). */
export function safeTaskId(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "task";
}

export type KlogMode = "journal" | "sudo";

/**
 * One `boat exec` that reads the sandbox's size, its out-of-memory counter
 * and (with `since`) the kernel's kill lines after that time; with `task`,
 * the peak the sampler recorded (and `stopSampler` ends it). Under 10 s in
 * the worst case: every journal read has its own timeout, so a slow journal
 * never costs the size and counter lines. Readable without root:
 * /proc, `journalctl -k` (else `sudo -n`); never dmesg (dmesg_restrict).
 */
export function probeScript(
  options: {
    since?: number | null;
    task?: string | null;
    stopSampler?: boolean;
    /** How the log read last time, in that boot: used only while the sandbox is still in it. */
    klog?: { mode: KlogMode; bootId: string | null } | null;
  } = {},
): string {
  const lines = [
    "echo BOAT_MEM_PROBE 1",
    "printf 'NOW %(%s)T\\n' -1",
    `echo "BOOT $(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo -) $(awk '/^btime /{print $2}' /proc/stat 2>/dev/null)"`,
    'echo "CPUS $(nproc 2>/dev/null || echo 0)"',
    `awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} /^SwapTotal:/{st=$2} /^SwapFree:/{sf=$2} END{printf "MEM %d %d %d %d\\n", t, a, st, sf}' /proc/meminfo 2>/dev/null`,
    `awk 'BEGIN{v=-1} /^oom_kill /{v=$2} END{print "OOM", v}' /proc/vmstat 2>/dev/null`,
  ];
  if (options.task) {
    const task = safeTaskId(options.task);
    lines.push(
      `P=/tmp/boat-memory/${task}.peak`,
      `if [ -s "$P" ]; then echo "PEAK $(head -c 200 "$P" | tr -d '\\n')"; else echo "PEAK -"; fi`,
      `H=/tmp/boat-memory/${task}.samples; if [ -s "$H" ]; then tail -n 480 "$H" | head -c 32768 | sed 's/^/SAMPLE /'; fi`,
    );
    if (options.stopSampler) lines.push(`touch /tmp/boat-memory/${task}.stop 2>/dev/null`);
  }
  if (options.since !== undefined && options.since !== null) {
    const since = Math.max(0, Math.floor(options.since));
    const detect = "J=-; if kread; then J=journal; elif kread sudo -n; then J=sudo; fi";
    // Boot ids are [0-9a-f-] (parseProbe): safe in the script.
    const cached = options.klog && options.klog.bootId !== null && /^[0-9a-f-]{8,64}$/.test(options.klog.bootId) ? options.klog : null;
    lines.push(
      `kread() { timeout 2 "$@" journalctl -k -b -n 1 -o short-unix --no-pager -q 2>/dev/null | grep -q ' kernel: '; }`,
      cached ? `if [ "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" = "${cached.bootId}" ]; then J=${cached.mode}; else ${detect}; fi` : detect,
      'echo "KLOG $J"',
      'if [ "$J" != - ]; then',
      '  S=; [ "$J" = sudo ] && S="sudo -n"',
      `  timeout 5 $S journalctl -k -b --since @${since} -o short-unix --no-pager -q 2>/dev/null | grep -E 'oom-kill:|Killed process [0-9]+ ' | tail -n 40 | sed 's/^/K /'`,
      // A timeout may have cut the lines short; any other failure (sudo now wants a password) means it wasn't read.
      '  R=${PIPESTATUS[0]}; [ "$R" = 124 ] && echo KLOG_TIMEOUT; [ "$R" != 0 ] && [ "$R" != 124 ] && echo KLOG_FAIL',
      // systemd-oomd kills show neither in the counter nor in the kernel log. Every step is capped (the probe stays under boat's 15 s).
      "  if timeout 2 systemctl is-active --quiet systemd-oomd 2>/dev/null; then",
      `    timeout 2 $S journalctl -u systemd-oomd -b --since @${since} -o short-unix --no-pager -q 2>/dev/null | grep -E 'Killed ' | tail -n 10 | sed 's/^/D /'`,
      "  fi",
      "fi",
    );
  }
  lines.push("echo END");
  return lines.join("\n");
}

/**
 * Peak memory of the whole VM, once a second, until the stop file appears,
 * 4 hours pass, or the sandbox stops: MemTotal − MemAvailable plus swap in
 * use (page cache doesn't count). Detached with `boat exec --detach`. It
 * asks not to be the OOM killer's victim itself (best effort) and records
 * its pid, so a kill of it is never blamed on the work.
 */
export function samplerScript(taskId: string): string {
  const task = safeTaskId(taskId);
  return [
    "mkdir -p /tmp/boat-memory || exit 0",
    `P=/tmp/boat-memory/${task}.peak; S=/tmp/boat-memory/${task}.stop; H=/tmp/boat-memory/${task}.samples; rm -f "$S" "$P" "$H"`,
    `sudo -n sh -c "echo -1000 > /proc/$$/oom_score_adj" 2>/dev/null`,
    "printf -v start '%(%s)T' -1; end=$((start + 14400)); max=0; smax=0; n=0; t=0",
    'while [ ! -e "$S" ]; do',
    "  printf -v now '%(%s)T' -1; [ \"$now\" -ge \"$end\" ] && break",
    "  t=0; a=0; st=0; sf=0",
    '  while read -r k v _; do case "$k" in MemTotal:) t=$v;; MemAvailable:) a=$v;; SwapTotal:) st=$v;; SwapFree:) sf=$v; break;; esac; done < /proc/meminfo',
    "  s=$((st - sf)); u=$((t - a + s)); n=$((n + 1))",
    '  if [ $((n % 30)) -eq 1 ]; then',
    '    echo "$now $u $t $s" >> "$H"',
    '    tail -n 480 "$H" > "$H.tmp" && mv -f "$H.tmp" "$H"',
    '  fi',
    '  if [ "$u" -gt "$max" ] || [ $((n % 30)) -eq 0 ]; then',
    '    if [ "$u" -gt "$max" ]; then max=$u; smax=$s; fi',
    '    echo "$max $t $n $start $now $smax $$" > "$P.tmp" && mv -f "$P.tmp" "$P"',
    "  fi",
    "  sleep 1",
    "done",
    "printf -v now '%(%s)T' -1; echo \"$max $t $n $start $now $smax $$\" > \"$P.tmp\" && mv -f \"$P.tmp\" \"$P\"",
  ].join("\n");
}

export const MAX_MEMORY_SAMPLES = 480;
export interface MemorySample { at: number; usedKb: number; totalKb: number; swapKb: number }

/** Bounds untrusted persisted/probe rows; only real measured points survive. */
export function memorySeries(value: unknown, bounds: { since?: number; until?: number } = {}): MemorySample[] {
  if (!Array.isArray(value)) return [];
  const samples: MemorySample[] = [];
  for (const row of value.slice(-MAX_MEMORY_SAMPLES)) {
    if (!row || typeof row !== "object") continue;
    const { at, usedKb, totalKb, swapKb } = row as MemorySample;
    if (![at, usedKb, totalKb, swapKb].every(Number.isSafeInteger) || epoch(at) === null || totalKb <= 0 || totalKb > MAX_MEM_KB || swapKb < 0 || swapKb > MAX_SWAP_KB || usedKb < 0 || usedKb > totalKb + swapKb || at < (bounds.since ?? 0) || at > (bounds.until ?? Infinity)) continue;
    if (samples.length && at <= samples.at(-1)!.at) continue;
    samples.push({ at, usedKb, totalKb, swapKb });
  }
  return samples;
}

export interface ProbePeak {
  /** Highest MemTotal − MemAvailable + swap in use, kB. */
  peakKb: number;
  memTotalKb: number;
  samples: number;
  /** Epoch seconds on the sandbox's clock. */
  start: number;
  last: number;
  /** Swap in use at the peak, kB. */
  swapKb: number | null;
  /** The sampler's own pid. */
  pid: number | null;
}

export interface Probe {
  /** The sandbox's clock, epoch seconds. */
  now: number | null;
  bootId: string | null;
  /** When the sandbox booted (epoch seconds, its clock). */
  bootTime: number | null;
  cpus: number | null;
  memTotalKb: number | null;
  memAvailableKb: number | null;
  swapTotalKb: number | null;
  swapFreeKb: number | null;
  /** /proc/vmstat oom_kill: kills since boot. */
  oomKills: number | null;
  peak: ProbePeak | null;
  series?: MemorySample[];
  /** How the kernel log was read (none: not readable; null: not asked). */
  klog: KlogMode | "none" | null;
  /** The journal read ran out of time: its lines may be incomplete. */
  klogTimedOut: boolean;
  /** Kernel lines with kills, as journalctl printed them. */
  lines: string[];
  /** systemd-oomd's kill lines. */
  oomd: string[];
}

const MAX_MEM_KB = 128 * KB_PER_GIB;
const MAX_SWAP_KB = 64 * KB_PER_GIB;

function int(text: string | undefined): number | null {
  if (text === undefined || !/^-?\d{1,15}$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function within(value: number | null, min: number, max: number): number | null {
  return value !== null && value >= min && value <= max ? value : null;
}

/** Plausible epoch seconds (2020–2100). */
function epoch(value: number | null): number | null {
  return within(value, 1_577_836_800, 4_102_444_800);
}

/**
 * The probe's output, or null without a complete block. Only the last
 * block counts (a login profile may print before it), and every number is
 * clamped to what a boat sandbox can have.
 */
export function parseProbe(stdout: string): Probe | null {
  const lines = stdout.split("\n").map((line) => line.replace(/\r$/, ""));
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) if (lines[index]!.trim() === "BOAT_MEM_PROBE 1") start = index;
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line.trim() === "END");
  if (end === -1) return null;
  const probe: Probe = {
    now: null,
    bootId: null,
    bootTime: null,
    cpus: null,
    memTotalKb: null,
    memAvailableKb: null,
    swapTotalKb: null,
    swapFreeKb: null,
    oomKills: null,
    peak: null,
    klog: null,
    klogTimedOut: false,
    lines: [],
    oomd: [],
  };
  let peakText: string | null = null;
  const rawSeries: MemorySample[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const [key, ...rest] = line.split(" ");
    const values = rest.filter((part) => part !== "");
    switch (key) {
      case "NOW":
        probe.now = epoch(int(values[0]));
        break;
      case "BOOT":
        probe.bootId = values[0] && /^[0-9a-f-]{8,64}$/i.test(values[0]) ? values[0].toLowerCase() : null;
        probe.bootTime = epoch(int(values[1]));
        break;
      case "CPUS":
        probe.cpus = within(int(values[0]), 1, 64);
        break;
      case "MEM": {
        probe.memTotalKb = within(int(values[0]), 1, MAX_MEM_KB);
        probe.memAvailableKb = probe.memTotalKb === null ? null : within(int(values[1]), 0, probe.memTotalKb);
        probe.swapTotalKb = within(int(values[2]), 0, MAX_SWAP_KB);
        probe.swapFreeKb = probe.swapTotalKb === null ? null : within(int(values[3]), 0, probe.swapTotalKb);
        break;
      }
      case "OOM":
        probe.oomKills = within(int(values[0]), 0, 1_000_000);
        break;
      case "PEAK":
        peakText = values[0] === "-" ? null : values.join(" ");
        break;
      case "SAMPLE":
        if (rawSeries.length < MAX_MEMORY_SAMPLES) rawSeries.push({ at: Number(values[0]), usedKb: Number(values[1]), totalKb: Number(values[2]), swapKb: Number(values[3]) });
        break;
      case "KLOG":
        probe.klog = values[0] === "journal" || values[0] === "sudo" ? values[0] : "none";
        break;
      case "KLOG_TIMEOUT":
        probe.klogTimedOut = true;
        break;
      case "KLOG_FAIL":
        // The read failed: no line from it decides anything (the counter does).
        probe.klog = "none";
        break;
      case "K":
        if (probe.lines.length < 40) probe.lines.push(rest.join(" ").slice(0, 2000));
        break;
      case "D":
        if (probe.oomd.length < 10) probe.oomd.push(rest.join(" ").slice(0, 2000));
        break;
      default:
        break;
    }
  }
  if (peakText !== null) probe.peak = parsePeak(peakText, probe);
  probe.series = memorySeries(rawSeries, { since: probe.peak?.start, until: probe.peak?.last ?? probe.now ?? undefined });
  return probe;
}

/** "max total samples start last [swap] [pid]", checked against the probe and the clock. */
function parsePeak(text: string, probe: Probe): ProbePeak | null {
  const [peak, total, samples, start, last, swap, pid] = text.split(" ").map((part) => int(part));
  const memTotalKb = within(total ?? null, 1, MAX_MEM_KB);
  const first = epoch(start ?? null);
  const latest = epoch(last ?? null);
  if (memTotalKb === null || first === null || latest === null || latest < first) return null;
  const swapRoom = probe.swapTotalKb ?? 0;
  const peakKb = within(peak ?? null, 0, memTotalKb + swapRoom);
  const count = within(samples ?? null, 0, latest - first + 2);
  if (peakKb === null || count === null) return null;
  return {
    peakKb,
    memTotalKb,
    samples: count,
    start: first,
    last: latest,
    swapKb: within(swap ?? null, 0, swapRoom),
    pid: within(pid ?? null, 1, 4_194_304),
  };
}

// ------------------------------------------------------------------ kernel kills

/** Where the killed process ran: bb's task-chat service, boat's headless agent, a `boat exec`, or elsewhere. */
export type KillUnit = "bb" | "agent" | "command" | "other";

export interface KernelKill {
  /** Epoch seconds on the sandbox's clock. */
  at: number;
  pid: number;
  /** The process name (comm), sanitized; "" for a systemd-oomd kill of a whole service. */
  process: string;
  /** anon + file + shmem RSS at the kill, kB. */
  rssKb: number | null;
  unit: KillUnit;
  constraint: "global" | "cgroup" | "oomd" | null;
  /** oom_score_adj: 200 is bb's task-chat service, -900 boat's headless agent. */
  adj: number | null;
}

/** A process name as shown anywhere: [A-Za-z0-9._-], at most 15 characters. */
export function safeComm(comm: string): string {
  return comm.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 15);
}

function unitOf(memcg: string | null, adj: number | null): KillUnit {
  if (memcg) {
    if (memcg.includes("bb-host-daemon")) return "bb";
    if (memcg.includes("ascii-agent.service")) return "agent";
    if (memcg.includes("/ascii-cmd-")) return "command";
    return "other";
  }
  if (adj === 200) return "bb";
  if (adj === -900) return "agent";
  return "other";
}

const KILLED = /^(\d+(?:\.\d+)?) \S+ kernel: (?:Out of memory|Memory cgroup out of memory): Killed process (\d+) \((.*?)\) (.*)$/;
const OOM_KILL = /^(\d+(?:\.\d+)?) \S+ kernel: oom-kill:(.*)$/;
const OOMD = /^(\d+(?:\.\d+)?) \S+ systemd-oomd\[\d+\]: Killed (\S+) due to/;

/**
 * Kills from kernel lines (`journalctl -k -o short-unix`): the always-printed
 * "Killed process" line (pid, name, RSS, oom_score_adj) joined by pid with
 * the rate-limited "oom-kill:" line (its cgroup); either alone counts.
 * Host names and cgroup paths are read, never kept.
 */
export function parseKernelKills(lines: readonly string[], oomdLines: readonly string[] = []): KernelKill[] {
  const kills: KernelKill[] = [];
  const details: { at: number; pid: number; process: string; memcg: string | null; global: boolean; constraint: string | null }[] = [];
  for (const line of lines) {
    const killed = KILLED.exec(line);
    if (killed) {
      const rest = killed[4]!;
      const kb = (name: string) => int(new RegExp(`${name}:(\\d+)kB`).exec(rest)?.[1]);
      const parts = [kb("anon-rss"), kb("file-rss"), kb("shmem-rss")];
      const adj = int(/oom_score_adj:(-?\d+)/.exec(rest)?.[1]);
      kills.push({
        at: Number(killed[1]),
        pid: Number(killed[2]),
        process: safeComm(killed[3]!),
        rssKb: parts.every((part) => part === null) ? null : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0),
        unit: unitOf(null, adj),
        constraint: /^\d+(?:\.\d+)? \S+ kernel: Memory cgroup/.test(line) ? "cgroup" : null,
        adj,
      });
      continue;
    }
    const oom = OOM_KILL.exec(line);
    if (oom) {
      const fields = new Map<string, string>();
      let global = false;
      for (const part of oom[2]!.split(",")) {
        const eq = part.indexOf("=");
        if (eq === -1) {
          if (part.trim() === "global_oom") global = true;
          continue;
        }
        fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
      }
      const pid = int(fields.get("pid"));
      if (pid === null) continue;
      details.push({ at: Number(oom[1]), pid, process: safeComm(fields.get("task") ?? ""), memcg: fields.get("task_memcg") ?? null, global, constraint: fields.get("constraint") ?? null });
    }
  }
  for (const detail of details) {
    const constraint = detail.constraint === "CONSTRAINT_MEMCG" ? "cgroup" : detail.global || detail.constraint === "CONSTRAINT_NONE" ? "global" : null;
    const match = kills.find((kill) => kill.pid === detail.pid && Math.abs(kill.at - detail.at) <= 5);
    if (match) {
      if (detail.memcg) match.unit = unitOf(detail.memcg, match.adj);
      match.constraint = match.constraint ?? constraint;
      continue;
    }
    kills.push({ at: detail.at, pid: detail.pid, process: detail.process, rssKb: null, unit: unitOf(detail.memcg, null), constraint, adj: null });
  }
  for (const line of oomdLines) {
    const match = OOMD.exec(line);
    if (match) kills.push({ at: Number(match[1]), pid: 0, process: "", rssKb: null, unit: unitOf(match[2]!, null), constraint: "oomd", adj: null });
  }
  return kills.sort((a, b) => a.at - b.at);
}

export function killKey(bootId: string | null, kill: Pick<KernelKill, "pid" | "at" | "constraint">): string {
  return `${bootId ?? "?"}:${kill.constraint === "oomd" ? "oomd" : kill.pid}:${Math.floor(kill.at)}`;
}

export interface OomFinding {
  /** Named kills (at most 3 kept); empty for counter-only evidence. */
  kills: (KernelKill & { key: string })[];
  /** How many kills (the counter may know more than the lines). */
  count: number;
  source: KlogMode | "counter";
  /**
   * The kernel log names the kills inside the turn. Counter-only evidence
   * can't say when, or whose: it's only ever a "may have".
   */
  certain: boolean;
  /** Counter evidence: the counter's value (a dedupe key). */
  counterKey: string | null;
}

/**
 * Did the sandbox run out of memory during the turn? A readable kernel log
 * decides alone (no kill line after `since` means none, whatever the
 * counter says: those kills were in other turns). Without it, the counter
 * against an earlier reading of the same boot is a "may have". Never a
 * finding without evidence.
 */
export function oomFinding(
  probe: Probe,
  context: {
    /** Turn start, on the sandbox's clock (epoch seconds). */
    since: number;
    /** An earlier reading of this sandbox from before the turn, if any. */
    baseline: { bootId: string | null; oomKills: number } | null;
    /** Kill and counter keys this task already reported. */
    reported: ReadonlySet<string>;
    /** The sampler's pid: its kill isn't the work's. */
    excludePids?: ReadonlySet<number>;
  },
): OomFinding | null {
  if ((probe.klog === "journal" || probe.klog === "sudo") && !probe.klogTimedOut) {
    const kills = parseKernelKills(probe.lines, probe.oomd)
      .filter((kill) => kill.at >= context.since && !(context.excludePids?.has(kill.pid) ?? false))
      .map((kill) => ({ ...kill, key: killKey(probe.bootId, kill) }))
      .filter((kill) => !context.reported.has(kill.key));
    if (kills.length === 0) return null;
    // The biggest ones are what the user wants to hear about.
    const kept = [...kills].sort((a, b) => (b.rssKb ?? 0) - (a.rssKb ?? 0)).slice(0, 3);
    return { kills: kept, count: kills.length, source: probe.klog, certain: true, counterKey: null };
  }
  if (probe.oomKills === null || context.baseline === null) return null;
  const counterKey = `counter:${probe.bootId ?? "?"}:${probe.oomKills}`;
  if (context.reported.has(counterKey)) return null;
  const sameBoot = probe.bootId !== null && context.baseline.bootId === probe.bootId;
  if (sameBoot) {
    const delta = probe.oomKills - context.baseline.oomKills;
    return delta > 0 ? { kills: [], count: delta, source: "counter", certain: false, counterKey } : null;
  }
  // Rebooted since the baseline (a stop and resume: an idle stop, a move to
  // another size). The counter started at 0 with that boot, and nothing
  // older reads it: every kill it counts is in this boot, so this turn may
  // have had them (still only a "may have").
  // Without a boot id, only a boot inside the turn says the kills are this turn's.
  const rebooted = probe.bootId !== null || (probe.bootTime !== null && probe.bootTime >= context.since);
  if (rebooted && probe.oomKills > 0) {
    return { kills: [], count: probe.oomKills, source: "counter", certain: false, counterKey };
  }
  return null;
}

// ------------------------------------------------------------------ the turn

/** History kinds that start a turn, and that end one. */
export const TURN_START_KINDS: ReadonlySet<string> = new Set(["dispatched", "followup", "followup-switch", "failover", "turn"]);
export const TURN_END_KINDS: ReadonlySet<string> = new Set(["finished", "failed"]);

/**
 * The turn's start on the host clock (epoch seconds): its last turn-start
 * event, or a later chat follow-up marker; `since` reaches back `margin`
 * seconds for clock skew, but never into the previous turn.
 */
export function turnWindow(
  events: readonly Pick<TaskEvent, "at" | "kind">[],
  chatSentAtMs: number | null,
  margin = 15,
): { start: number; since: number } | null {
  const seconds = (iso: string) => Date.parse(iso) / 1000;
  const lastStart = [...events].reverse().find((event) => TURN_START_KINDS.has(event.kind));
  let start = lastStart ? seconds(lastStart.at) : null;
  if (chatSentAtMs !== null && (start === null || chatSentAtMs / 1000 > start)) start = chatSentAtMs / 1000;
  if (start === null || !Number.isFinite(start)) return null;
  const previousEnd = [...events]
    .filter((event) => TURN_END_KINDS.has(event.kind) && seconds(event.at) < start!)
    .map((event) => seconds(event.at))
    .reduce((latest, at) => Math.max(latest, at), -Infinity);
  return { start, since: Math.max(start - margin, previousEnd) };
}

// ------------------------------------------------------------------ words

const AGENTS: Record<string, string> = { claude: "Claude Code", codex: "Codex" };
const BROWSER = /^(chrome|chromium|chromium-browse|headless_shell|firefox|firefox-bin|msedge|WebKitWebProce|webkit)/i;

/**
 * Who was stopped, in plain words, from the facts only: "Claude Code" and
 * "Codex" by their names, a browser, else "a 1.4 GB process in the task chat
 * (MainThread)". bb's own processes and Claude Code's may share the name
 * MainThread, so that name is never mapped to either.
 */
export function victimLabel(kill: Pick<KernelKill, "process" | "rssKb" | "unit" | "constraint">): string {
  if (kill.constraint === "oomd") {
    return kill.unit === "bb" ? "the task chat's processes" : kill.unit === "agent" ? "the agent's processes" : "a group of processes";
  }
  const size = kill.rssKb !== null && kill.rssKb > 0 ? `${gb(kill.rssKb).toFixed(1)} GB` : null;
  const agent = AGENTS[kill.process];
  if (agent) return size ? `${agent} (${size})` : agent;
  if (BROWSER.test(kill.process)) return `a browser (${[kill.process, size].filter(Boolean).join(", ")})`;
  const where = kill.unit === "bb" ? " in the task chat" : kill.unit === "agent" ? " the agent started" : "";
  return `a ${size ? `${size} ` : ""}process${where} (${kill.process || "unknown"})`;
}

function whoText(finding: Pick<OomFinding, "kills" | "count">): string {
  const labels = finding.kills.map(victimLabel);
  const count = Math.max(finding.count, labels.length);
  if (labels.length === 0) return count > 1 ? `${count} processes` : "a process";
  if (count === 1) return labels[0]!;
  if (count === 2 && labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  const others = count - 1;
  return `${labels[0]} and ${others} other ${others === 1 ? "process" : "processes"}`;
}

/** The advice that offers a larger sandbox (oomAdvice's when the plan has one). */
export const CONTINUE_ADVICE = "Run fewer tests at once, or continue on a larger sandbox.";

/** What to do about it, given what the plan allows. */
export function oomAdvice(options: { current: MachineType | null; next: MachineType | null; nextAllowed: boolean }): string {
  if (options.current !== null && options.next === null) return "Run fewer tests at once (XLarge is the largest sandbox).";
  if (options.next !== null && !options.nextAllowed) return "Run fewer tests at once (your boat plan doesn't include a larger sandbox).";
  return CONTINUE_ADVICE;
}

/**
 * A stored out-of-memory message once continuing on a larger sandbox no
 * longer applies: the sandbox moved since (`movedTo`), or the task is closed.
 */
export function settledOomMessage(text: string, options: { movedTo: MachineType | null; closed: boolean }): string {
  if (!text.includes(CONTINUE_ADVICE)) return text;
  if (options.movedTo !== null) return text.replace(CONTINUE_ADVICE, `The sandbox is ${SIZE_SPECS[options.movedTo].label} now. Send a follow-up to continue.`);
  if (options.closed) return text.replace(CONTINUE_ADVICE, "Run fewer tests at once.");
  return text;
}

/** "A, B and C" */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "“Review: Add dark mode” also uses this sandbox." (other tasks by title). */
export function sharedText(others: readonly string[]): string {
  if (others.length === 0) return "";
  const titles = others.map((title) => `“${title.length > 80 ? `${title.slice(0, 79)}…` : title}”`);
  return `${listText(titles)} also ${titles.length === 1 ? "uses" : "use"} this sandbox.`;
}

/**
 * The plain message for a turn with out-of-memory kills. `cause`: the kills
 * explain the failure (it becomes the headline); otherwise it's added after
 * the original error ("also ran out of memory").
 */
export function oomMessage(
  finding: Pick<OomFinding, "kills" | "count">,
  options: { current: MachineType | null; next: MachineType | null; nextAllowed: boolean; cause: boolean; chatRestart: boolean; others: readonly string[] },
): string {
  const who = whoText(finding);
  const restart = options.chatRestart ? " That restarted bb on the sandbox and ended the chat's turn." : "";
  const shared = sharedText(options.others);
  const head = options.cause ? `The sandbox ran out of memory: the system stopped ${who}.` : `The sandbox also ran out of memory during this turn: the system stopped ${who}.`;
  return `${head}${restart} ${oomAdvice(options)}${shared ? ` ${shared}` : ""}`;
}

/** History lines for a finding (one per named kill, at most 3). */
export function oomHistory(finding: Pick<OomFinding, "kills" | "count" | "certain">): string[] {
  if (!finding.certain) {
    return [
      `The sandbox may have run out of memory: its kernel counted ${finding.count === 1 ? "an out-of-memory kill" : `${finding.count} out-of-memory kills`} since the last check, but its log isn't readable here, so it's unclear what stopped.`,
    ];
  }
  return finding.kills.slice(0, 3).map((kill) => `Out of memory: the system stopped ${victimLabel(kill)}.`);
}

const KILL_TEXT = /host daemon disconnected|disconnected|\b137\b|sigkill|signal 9|\bkilled\b|out of memory|\boom\b|missing from sandbox|stopped without finishing/i;

/**
 * Did the kills end the turn? Yes when bb's service lost a process and the
 * task is a task chat (systemd restarts the whole service, the agent with
 * it; a headless agent runs outside bb), when the agent itself was killed,
 * or when the failure reads like a kill or a disconnect. A test runner
 * killed early in a turn that later failed on something else isn't the
 * cause.
 */
export function oomCausedFailure(finding: Pick<OomFinding, "kills" | "certain">, failure: string | null, runner: Runner): boolean {
  if (!finding.certain) return false;
  // bb's restart ends a task chat's turn; a headless agent runs outside bb and doesn't notice it.
  if (finding.kills.some((kill) => (kill.unit === "bb" && runner === "chat") || kill.process === "claude" || kill.process === "codex")) return true;
  return failure !== null && KILL_TEXT.test(failure);
}

/** The original error behind a rewritten one. */
export const ORIGINAL_ERROR = "\n\nOriginal error: ";

/** A rewritten error: the message first, the original kept as detail. */
export function errorWithOom(message: string, original: string | null, cause: boolean): string {
  const before = original?.trim() || null;
  const text = cause ? (before ? `${message}${ORIGINAL_ERROR}${before}` : message) : before ? `${before}\n\n${message}` : message;
  return text.length <= 4000 ? text : `${text.slice(0, 3999)}…`;
}

/** The parts of an error errorWithOom wrote. */
export function splitOomError(error: string | null): { message: string; original: string | null } | null {
  if (error === null) return null;
  const at = error.indexOf(ORIGINAL_ERROR);
  if (at === -1) return { message: error, original: null };
  return { message: error.slice(0, at), original: error.slice(at + ORIGINAL_ERROR.length) || null };
}

// ------------------------------------------------------------------ recommendation

/** A peak at or above this share of the sandbox's memory recommends the next size up. */
export const NEAR_LIMIT = 0.75;

export interface PlanSize {
  type: string;
  available: boolean;
  reason: string | null;
}

export type RecommendReason = "near-limit" | "out-of-memory" | "fits" | "largest";

export interface Recommendation {
  type: MachineType;
  reason: RecommendReason;
  /** The plan allows it (unknown plan: true). */
  allowed: boolean;
  /** boat's reason when it doesn't. */
  planReason: string | null;
}

export function planVerdict(type: MachineType, plan: readonly PlanSize[] | null): { allowed: boolean; reason: string | null } {
  const facts = plan?.find((entry) => entry.type === type);
  if (facts === undefined || facts.available) return { allowed: true, reason: null };
  return { allowed: false, reason: facts.reason ?? "Your boat plan doesn't include this size." };
}

/**
 * The size to use next time: one up when the peak reached 75% of the
 * sandbox's memory or something was killed for memory; otherwise the same.
 * Always with the plan's verdict, so nothing recommends a size the plan
 * doesn't allow without saying so.
 */
export function recommendSize(input: {
  peakKb: number | null;
  memTotalKb: number | null;
  oom: boolean;
  current: MachineType | null;
  plan: readonly PlanSize[] | null;
}): Recommendation | null {
  if (input.current === null) return null;
  const ratio = input.peakKb !== null && input.memTotalKb ? input.peakKb / input.memTotalKb : null;
  const tight = input.oom || (ratio !== null && ratio >= NEAR_LIMIT);
  const next = nextSize(input.current);
  if (tight && next === null) return { type: input.current, reason: "largest", ...planOf(input.current, input.plan) };
  const type = tight ? next! : input.current;
  return { type, reason: input.oom ? "out-of-memory" : tight ? "near-limit" : "fits", ...planOf(type, input.plan) };
}

function planOf(type: MachineType, plan: readonly PlanSize[] | null): { allowed: boolean; planReason: string | null } {
  const verdict = planVerdict(type, plan);
  return { allowed: verdict.allowed, planReason: verdict.reason };
}

/** "Peak memory during this turn: 6.1 of 8 GB. Recommended size: Large." */
export function peakLine(peak: { peakKb: number; memTotalKb: number; machineType: MachineType | null; swapKb?: number | null }, recommendation: Recommendation | null): string {
  const total = peak.machineType !== null ? SIZE_SPECS[peak.machineType].memoryGb : Math.round(peak.memTotalKb / KB_PER_GIB);
  const swap = peak.swapKb && peak.swapKb >= 104_858 ? ` (${gb(peak.swapKb).toFixed(1)} GB of it in swap)` : "";
  const head = `Peak memory during this turn: ${gb(peak.peakKb).toFixed(1)} of ${total} GB${swap}.`;
  if (recommendation === null) return head;
  const label = SIZE_SPECS[recommendation.type].label;
  const plan = recommendation.allowed ? "" : ` Your boat plan doesn't include ${label}: ${recommendation.planReason}.`;
  if (recommendation.reason === "largest") return `${head} XLarge is the largest size: run fewer tests at once.`;
  return `${head} Recommended size: ${label}.${plan}`;
}

// ------------------------------------------------------------------ prompts

/** The Environment line every initial, review and handover prompt gets. */
export function sandboxLine(size: KnownSize | null, runner: Runner): string {
  const tail =
    runner === "chat"
      ? "shared with other processes (bb itself, other tasks' checkouts, preview servers). Run heavy test suites (browser tests, full builds) one at a time, not all at once: running out of memory stops processes, this chat included."
      : "shared with other processes (other tasks' checkouts, preview servers). Run heavy test suites (browser tests, full builds) one at a time, not all at once.";
  if (size?.type) {
    const spec = SIZE_SPECS[size.type];
    return `- This sandbox is ${spec.label} size: ${spec.cpus} CPUs and ${spec.memoryGb} GB of memory, ${tail}`;
  }
  if (size && size.cpus !== null && size.memTotalKb !== null) {
    return `- This sandbox has ${size.cpus} CPUs and about ${Math.round(size.memTotalKb / KB_PER_GIB)} GB of memory, ${tail}`;
  }
  return runner === "chat"
    ? "- Other processes share this sandbox's CPUs and memory (bb itself, other tasks' checkouts, preview servers). Run heavy test suites (browser tests, full builds) one at a time, not all at once: running out of memory stops processes, this chat included."
    : "- Other processes may share this sandbox's CPUs and memory (other tasks' checkouts, preview servers). Run heavy test suites (browser tests, full builds) one at a time, not all at once.";
}

/** The follow-up's note after the sandbox moved to another size. */
export function movedNote(from: MachineType | null, to: MachineType): string {
  const spec = SIZE_SPECS[to];
  const direction = from === null ? "another machine size" : compareSizes(to, from) > 0 ? "a larger machine" : "a smaller machine";
  return `The sandbox moved to ${direction}: it's now ${spec.label}, ${spec.cpus} CPUs and ${spec.memoryGb} GB of memory. Your files are as you left them, but processes that were running (dev and preview servers, watchers) stopped; start again what you need.`;
}

// ------------------------------------------------------------------ records

/** Task event kinds the history doesn't show (JSON for the plugin). */
export const HIDDEN_EVENT_KINDS: ReadonlySet<string> = new Set(["chat-info", "memory-data", AUTO_RETRY_RECORD]);
/** Visible kinds: the sandbox's size and moves, and memory findings. */
export const SIZE_KIND = "sandbox-size";
export const MEMORY_KIND = "memory";
export const DATA_KIND = "memory-data";

export type SizeSource = "probe" | "boat" | "requested" | "resize";

export interface KillRecord {
  key: string;
  process: string;
  label: string;
  unit: KillUnit;
  rssKb: number | null;
  at: number;
}

export type MemoryData =
  /** The follow-up that told the agent about the latest move went out. */
  | { type: "note-sent" }
  | {
      type: "size";
      sandboxId: string;
      machineType: MachineType | null;
      cpus: number | null;
      memTotalKb: number | null;
      source: SizeSource;
      /** Host clock, epoch seconds. */
      at: number;
      bootId?: string | null;
      oomKills?: number | null;
    }
  /** A measured task (the repo check, the test task). */
  | { type: "watch" }
  | { type: "sampler"; sandboxId: string; turn: number; pid: number | null }
  | {
      type: "oom";
      turn: number;
      sandboxId: string;
      machineType: MachineType | null;
      kills: KillRecord[];
      count: number;
      source: KlogMode | "counter";
      certain: boolean;
      /** The kills ended the turn (the message became the error's headline). */
      cause: boolean;
      counterKey: string | null;
      message: string;
      next: MachineType | null;
      nextAllowed: boolean;
      nextReason: string | null;
      at: number;
    }
  | {
      type: "peak";
      turn: number;
      sandboxId: string;
      peakKb: number;
      memTotalKb: number;
      swapKb: number | null;
      samples: number;
      series?: MemorySample[];
      machineType: MachineType | null;
      oom: boolean;
      /** Other tasks worked on the sandbox during the turn: the peak is theirs too. */
      shared: boolean;
      recommended: MachineType | null;
      reason: RecommendReason | null;
      allowed: boolean;
      planReason: string | null;
      at: number;
    }
  | {
      type: "resize";
      sandboxId: string;
      from: MachineType | null;
      to: MachineType;
      state: "started" | "done" | "failed";
      error: string | null;
      byTask: string;
      at: number;
    };

export function encodeData(data: MemoryData): string {
  return JSON.stringify(data);
}

export function decodeData(text: string): MemoryData | null {
  try {
    const value = JSON.parse(text) as { type?: unknown } | null;
    if (value === null || typeof value !== "object" || typeof value.type !== "string") return null;
    if (!["size", "watch", "sampler", "oom", "peak", "resize", "note-sent"].includes(value.type)) return null;
    return value as MemoryData;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ projects

export interface SizedProject {
  id: string;
  name: string;
  repos: readonly { repo: string }[];
  machineType: MachineType | null;
}

/**
 * The project that sets a task's sandbox size: the task's own project (its
 * size, or none: the setting), else the project whose main repo it is.
 * Other projects that merely list the repo don't apply.
 */
export function governingProject<T extends SizedProject>(projects: readonly T[], projectId: string | null, repo: string | null): T | null {
  const own = projectId === null ? null : (projects.find((project) => project.id === projectId) ?? null);
  if (own !== null) return own;
  if (repo === null) return null;
  const lower = repo.toLowerCase();
  return projects.find((project) => project.repos[0]?.repo.toLowerCase() === lower) ?? null;
}

// ------------------------------------------------------------------ the notice

/** The task's newest memory record of a type among these events. */
function latestData<T extends MemoryData["type"]>(events: readonly Pick<TaskEvent, "kind" | "text">[], type: T): Extract<MemoryData, { type: T }> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind !== DATA_KIND) continue;
    const data = decodeData(event.text);
    if (data?.type === type) return data as Extract<MemoryData, { type: T }>;
  }
  return null;
}

/**
 * The orchestrator notice's lines about memory for this turn: an
 * out-of-memory kill with what to do about it (the plan decides: move up
 * with boat_followup's sandbox_size, ask the user for XLarge or a bigger
 * plan, or run fewer tests), and a measured turn's peak.
 */
export function memoryNoticeLines(task: { id: string; turns: number }, events: readonly Pick<TaskEvent, "kind" | "text">[]): { oom: string | null; peak: string | null } {
  const oom = latestData(events, "oom");
  let oomLine: string | null = null;
  if (oom !== null && oom.turn === task.turns) {
    if (!oom.certain) {
      oomLine = "The sandbox may have run out of memory during this turn (its kernel counted an out-of-memory kill, but its log isn't readable there). If the agent's tests were cut short, ask it to run fewer at once.";
    } else {
      const size = oom.machineType === null ? "The sandbox" : `The ${SIZE_SPECS[oom.machineType].label} sandbox (${SIZE_SPECS[oom.machineType].memoryGb} GB)`;
      const head = `Out of memory: ${size} ran out of memory during this turn.`;
      if (oom.machineType === "xlarge") oomLine = `${head} XLarge is the largest size: ask the agent to run fewer tests at once.`;
      else if (oom.next === null) oomLine = `${head} Ask the agent to run fewer tests at once.`;
      else if (!oom.nextAllowed) {
        const label = SIZE_SPECS[oom.next].label;
        oomLine = `${head} Your boat plan doesn't include ${label}${oom.nextReason ? ` (${oom.nextReason.replace(/[.\s]+$/, "")})` : ""}, so ask the agent to run fewer tests at once, or ask the user about a bigger plan.`;
      } else if (oom.next === "xlarge") {
        oomLine = `${head} Ask the agent to run fewer tests at once, or, only after the user's OK, move it to XLarge and continue: \`boat_followup\` with \`sandbox_size: "xlarge"\` and \`user_approved\` (\`bb boat task followup ${task.id} --type xlarge --user-approved --message "…"\`).`;
      } else {
        const label = SIZE_SPECS[oom.next].label;
        const cost = costSentence(oom.next, oom.machineType);
        oomLine = `${head} Ask the agent to run fewer tests at once, or move it to ${label} and continue: \`boat_followup\` with \`sandbox_size: "${oom.next}"\` (\`bb boat task followup ${task.id} --type ${oom.next} --message "…"\`). ${cost ? `${cost.replace(/\.$/, "")}; mention it in your next update.` : ""}`.trimEnd();
      }
    }
  }
  const peak = latestData(events, "peak");
  let peakText: string | null = null;
  const rawSeries: MemorySample[] = [];
  if (peak !== null && peak.turn === task.turns) {
    const recommendation = peak.recommended && peak.reason ? { type: peak.recommended, reason: peak.reason, allowed: peak.allowed, planReason: peak.planReason } : null;
    peakText = `${peakLine({ peakKb: peak.peakKb, memTotalKb: peak.memTotalKb, machineType: peak.machineType, swapKb: peak.swapKb }, recommendation)}${peak.shared ? " Other tasks worked on this sandbox meanwhile." : ""}`;
  }
  return { oom: oomLine, peak: peakText };
}
