import { parseSandboxUsage, parseUsagePlan } from "./usage.ts";
// Typed boat operations built on the CLI wrapper. All JSON shapes were
// observed from boat CLI 1.0.89; every accessor tolerates missing fields.
import { randomUUID } from "node:crypto";
import { BoatCli, BoatError, bool, num, rec, str, type JsonRecord } from "./cli.ts";
import { shellQuote } from "../shell.ts";
import {
  ACTIVE_STATES,
  MACHINE_TYPES,
  autoStopHours,
  type AiProxyState,
  type CapacityReport,
  type ChatEvent,
  type Conversation,
  type Dispatch,
  type EnvironmentInfo,
  type HostedPort,
  type MachineType,
  type ProcessSample,
  type PromptOptions,
  type SandboxInfo,
  type SandboxProcess,
  type SavedSnapshot,
  type StopReport,
} from "../types.ts";

// The shapes boat's answers are read into live in ../types.ts (every
// provider shares them); boat code and its tests keep using these names.
export { ACTIVE_STATES, MACHINE_TYPES, autoStopHours, shellQuote };
export type {
  AiProxyState,
  ChatEvent,
  Conversation,
  Dispatch,
  EnvironmentInfo,
  HostedPort,
  MachineType,
  ProcessSample,
  SandboxProcess,
  SavedSnapshot,
  StopReport,
};
/** A sandbox as `boat info` and `boat list` report it. */
export type Sandbox = SandboxInfo;
/** `boat limits`, read. */
export type Limits = CapacityReport;

/**
 * The trial's auto-stop cap when boat says it's the trial but not the cap
 * (boat 1.0.89–1.0.92 enforce 2 hours). The cap itself comes from boat:
 * see autoStopCapFromLimits.
 */
export const TRIAL_AUTO_STOP_HOURS = 2;

const AUTO_STOP_UNITS: Record<string, number> = { h: 1, m: 1 / 60, s: 1 / 3600 };

/**
 * An auto-stop cap in boat's own words, in hours (null: none stated):
 * "auto-stop max 2h" (the trial's line in `boat limits`), "Set a TTL of
 * 2 hours or less" and "auto-stop is 2 hours maximum" (its refusals).
 */
export function autoStopCapFromText(text: string | null | undefined): number | null {
  if (!text) return null;
  const unit = String.raw`(\d+(?:\.\d+)?)\s*(h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\b`;
  const match =
    new RegExp(String.raw`auto-?stop[^.,;\n]{0,24}?\b` + unit, "i").exec(text) ??
    new RegExp(String.raw`\bttl of ` + unit + String.raw`\s+or less`, "i").exec(text);
  if (match === null) return null;
  const hours = Number(match[1]) * AUTO_STOP_UNITS[match[2]!.charAt(0).toLowerCase()]!;
  return Number.isFinite(hours) && hours > 0 ? hours : null;
}

/**
 * The plan's cap on a sandbox's auto-stop, in hours, from `boat limits --json`
 * (null: no cap). boat has no number field for it (checked with 1.0.89 and
 * 1.0.92): the trial's `trialLine` says it ("2 boxes, 75 new/day, …,
 * auto-stop max 2h, …"), and other plans have none. A trial whose line
 * doesn't say gets TRIAL_AUTO_STOP_HOURS.
 */
export function autoStopCapFromLimits(raw: JsonRecord): number | null {
  const stated = autoStopCapFromText(str(raw.trialLine));
  if (stated !== null) return stated;
  return str(raw.accessTier) === "trial" ? TRIAL_AUTO_STOP_HOURS : null;
}

/**
 * Run a boat call that sets an auto-stop. When boat refuses it as over the
 * plan's cap (trial_auto_stop_required: `boat limits` couldn't be read
 * first, or the cap changed), run it once more at the cap boat names in the
 * refusal, else TRIAL_AUTO_STOP_HOURS.
 */
export async function withinAutoStopCap<T>(ttlSeconds: number, run: (ttlSeconds: number) => Promise<T>): Promise<T> {
  try {
    return await run(ttlSeconds);
  } catch (error) {
    if (!(error instanceof BoatError) || error.code !== "trial_auto_stop_required") throw error;
    const capped = Math.round((autoStopCapFromText(error.message) ?? TRIAL_AUTO_STOP_HOURS) * 3600);
    if (capped >= ttlSeconds) throw error;
    return run(capped);
  }
}

/** At least this much CPU: the process is computing (a build, tests), not idling (a dev server, a watcher). */
export const BUSY_CPU_PERCENT = 20;
/**
 * Programs always there in a sandbox, whatever the task (by executable
 * name): boat's own (ascii-agent, ascii-lazyfs, …), bb's, the system's.
 */
const INFRASTRUCTURE_PROGRAMS =
  /^(ascii[\w.-]*|boat|bb|bb-host-daemon|sshd|systemd[\w.-]*|\(sd-pam\)|init|containerd[\w.-]*|dockerd|journald|rsyslogd|dbus[\w.-]*|cron|crond|atd|agetty|udevd|polkitd|tailscaled|snapd|packagekitd|unattended-upgrade[s]?|multipathd|ps|top)$/i;
/**
 * The same by full command line, for programs run by an interpreter: only
 * known entry points of bb's runtime (its host daemon and CLI, provider
 * bridge and plugin host workers, a plugin's host entry) and of boat
 * (ascii-lazyfs), and the plugin's memory sampler. Not a whole folder of
 * bb's: task workspaces live under a bb machine's data folder too.
 */
const INFRASTRUCTURE_COMMANDS = [
  /\/bb-app\/host-daemon\//,
  /\/bb-app\/dist\/bb(-app|-host-daemon)?\.js\b/,
  /\bbb-app\.js\b/,
  /\bbb-provider-bridge-worker\.mjs\b/,
  /\bbb-plugin-host-worker\.mjs\b/,
  /\bbb-parcel-watcher-child\.mjs\b/,
  /\/plugin-host-artifacts\/\S*\bhost\.mjs\b/,
  /\/var\/lib\/ascii-lazy-bin\/ascii-lazyfs\b/,
  /\/tmp\/boat-memory\//,
];
/** A bb workspace (or its worktrees): a process working there is the task's, whatever runs it. */
const WORKSPACE = /\/host-data\/workspaces\/|\/\.bb-machines\/\S*\/(workspaces|worktrees)\//;

/**
 * One of boat's, bb's or the system's own processes, never the task's
 * work. In doubt, it's work: a process with a workspace path in its
 * command line always is.
 */
export function isInfrastructure(entry: Pick<SandboxProcess, "command">): boolean {
  if (WORKSPACE.test(entry.command)) return false;
  return INFRASTRUCTURE_PROGRAMS.test(programName(entry.command)) || INFRASTRUCTURE_COMMANDS.some((pattern) => pattern.test(entry.command));
}

/** A process's program: the executable's file name ("cc1", "node"). */
export function programName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1);
}

/**
 * Processes still computing in a sandbox whose agent has finished: what a
 * headless task left running (a build, a test run). A stored sample (the
 * sandbox isn't live) counts for nothing.
 */
export function busyProcesses(sample: ProcessSample | null): SandboxProcess[] {
  if (sample === null || sample.live === false) return [];
  return sample.processes.filter((entry) => (entry.cpuPercent ?? 0) >= BUSY_CPU_PERCENT && !isInfrastructure(entry));
}

export function parseProcessSample(records: JsonRecord[]): ProcessSample {
  const last = records.at(-1) ?? {};
  const body = rec(last.data) ?? last;
  // One object with a list, or one record per process.
  const listed = Array.isArray(body.processes) ? body.processes : records.filter((record) => num(record.pid) !== null || num(rec(record.data)?.pid) !== null).map((record) => rec(record.data) ?? record);
  const processes = (listed as unknown[])
    .map((raw) => rec(raw))
    .filter((raw): raw is JsonRecord => raw !== null)
    .map((raw) => ({
      pid: num(raw.pid),
      command: str(raw.command) ?? str(raw.cmd) ?? str(raw.name) ?? "",
      cpuPercent: num(raw.cpuPercent) ?? num(raw.cpu),
      memoryMb: num(raw.memoryMB) ?? num(raw.memoryMb) ?? num(raw.memMb),
      commandId: str(raw.commandId),
      parentPid: num(raw.parentPid),
      startedAt: str(raw.startedAt),
      user: str(raw.user),
    }));
  return { live: bool(body.live), sampledAt: str(body.sampledAt), processes };
}

export function toSandbox(raw: JsonRecord): Sandbox {
  const id = str(raw.id);
  if (id === null) throw new BoatError("boat returned a sandbox without an id", { code: "boat_bad_output" });
  return {
    id,
    name: str(raw.name),
    state: str(raw.state) ?? "unknown",
    health: str(raw.health),
    url: str(raw.url),
    desktopUrl: str(raw.desktopUrl),
    environment: str(raw.environment),
    createdAt: str(raw.createdAt),
    archiveAfter: str(raw.archiveAfter),
    stoppedAt: str(raw.stoppedAt),
    setupStatus: str(raw.setupStatus),
    error: str(raw.error) ?? str(raw.setupError),
    machineType: [raw.type, raw.machineType, raw.size].find((value): value is MachineType => typeof value === "string" && (MACHINE_TYPES as readonly string[]).includes(value)) ?? null,
  };
}

export function dashboardUrl(sandboxId: string): string {
  return `https://boat.dev/dashboard?sandbox=${encodeURIComponent(sandboxId)}`;
}

/** `owner/name` from `owner/name`, `https://github.com/owner/name(.git)`, or `git@github.com:owner/name.git`. */
export function normalizeRepo(input: string): string {
  const trimmed = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const match =
    trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+)$/i) ??
    trimmed.match(/^git@github\.com:([\w.-]+)\/([\w.-]+)$/i) ??
    trimmed.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new BoatError(`"${input}" is not a GitHub repository (expected owner/name or a github.com URL)`, {
      code: "invalid_repo",
    });
  }
  return `${match[1]}/${match[2]}`;
}

const BRANCH_PATTERN = /^(?!\/|.*\/\/|.*\.\.|.*@\{|.*\.lock$)[A-Za-z0-9._\/-]{1,200}$/;

export function assertBranch(name: string, label = "branch"): string {
  if (!BRANCH_PATTERN.test(name) || name.startsWith("-")) {
    throw new BoatError(`"${name}" is not a valid ${label} name`, { code: "invalid_branch" });
  }
  return name;
}

const isBranchName = (name: string) => BRANCH_PATTERN.test(name) && !name.startsWith("-");

/** "release, develop" → ["release", "develop"]; names that aren't valid branch names are left out. */
export function parseBranchList(text: string): string[] {
  const names = text
    .split(/[,\n]/)
    .map((name) => name.trim())
    .filter((name) => name !== "" && isBranchName(name));
  return [...new Set(names)];
}

/** The entries of a comma-separated list that aren't valid branch names. */
export function invalidBranchNames(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((name) => name.trim())
    .filter((name) => name !== "" && !isBranchName(name));
}

/** A positional argument that clap must not read as a flag. */
function safePositional(text: string): string {
  return /^\s*-/.test(text) ? `\u200b${text}` : text;
}

/**
 * `boat ai proxy --json` (no state given: it only shows), e.g.
 * `{"enabled":false,"pricing":{"dailyDollars":1,"dollarsPer1000Requests":1},…}`
 * (fixtures/boat-json/ai-proxy.json).
 */
export function parseAiProxy(raw: JsonRecord): AiProxyState {
  const nested = rec(raw.proxy) ?? rec(raw.aiProxy);
  const state = str(raw.state) ?? str(nested?.state);
  const enabled = bool(raw.enabled) ?? bool(nested?.enabled) ?? (state === "on" ? true : state === "off" ? false : null);
  const pricing = rec(raw.pricing) ?? rec(nested?.pricing);
  const dollars = (value: unknown) => {
    const amount = num(value);
    return amount !== null && amount >= 0 ? amount : null;
  };
  return { enabled, dailyDollars: dollars(pricing?.dailyDollars), dollarsPer1000Requests: dollars(pricing?.dollarsPer1000Requests) };
}

/** "about $1 a day plus $1 per 1,000 requests" (null: boat didn't say). */
export function aiProxyPrice(state: Pick<AiProxyState, "dailyDollars" | "dollarsPer1000Requests">): string | null {
  const money = (amount: number) => "$" + (Number.isInteger(amount) ? String(amount) : amount.toFixed(2));
  const parts = [
    state.dailyDollars !== null ? `${money(state.dailyDollars)} a day` : null,
    state.dollarsPer1000Requests !== null ? `${money(state.dollarsPer1000Requests)} per 1,000 requests` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : `about ${parts.join(" plus ")}`;
}

/** Where the plugin keeps its git hooks in a sandbox. */
export const BOAT_HOOKS_DIR = "/home/user/.boat-hooks";

/**
 * Per-sandbox environment for sandboxes the plugin creates: git reads hooks
 * from the plugin's folder whatever the repo configures (husky and friends
 * set a repo-local core.hooksPath during `npm install`). Environment config
 * outranks repo config; the hooks chain to the repo's own hooks.
 */
export const BOAT_GIT_ENV: Record<string, string> = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: BOAT_HOOKS_DIR,
};


/**
 * Variable names from a dotenv text, never values: a quoted value spanning
 * lines (a PEM key) is skipped whole, so none of it can pass for a name.
 */
export function envNames(contents: string): string[] {
  const names: string[] = [];
  let open: string | null = null;
  const closes = (text: string, quote: string): boolean => {
    for (let index = 0; index < text.length; index += 1) {
      if (quote !== "'" && text[index] === "\\") {
        index += 1;
        continue;
      }
      if (text[index] === quote) return true;
    }
    return false;
  };
  for (const raw of contents.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (open !== null) {
      if (closes(line, open)) open = null;
      continue;
    }
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match === null) continue;
    names.push(match[1]!);
    const value = match[2] ?? "";
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && !closes(value.slice(1), quote)) open = quote;
  }
  return [...new Set(names)];
}


export function stopReport(records: JsonRecord[]): StopReport {
  const report: StopReport = { status: null, stopId: null, forced: null, error: null };
  for (const record of [...records].reverse()) {
    const stop = rec(record.stop) ?? rec(record.operation) ?? record;
    report.status ??= str(stop.status) ?? str(record.status);
    report.stopId ??= str(stop.stopId) ?? str(record.stopId) ?? str(stop.stop_id) ?? (str(stop.id)?.startsWith("stop") ? str(stop.id) : null);
    report.forced ??= bool(stop.forced) ?? bool(record.forced);
    report.error ??= str(stop.error) ?? str(rec(stop.error)?.message) ?? (stop === record ? null : str(record.error) ?? str(rec(record.error)?.message));
  }
  return report;
}

/**
 * The newest completed snapshot in `boat snapshots <id> --json` (shape not
 * verified against boat: any list of entries with a time; a status, when
 * given, must say it completed).
 */
export function lastCompletedSnapshot(records: JsonRecord[]): string | null {
  const entries: JsonRecord[] = [];
  for (const record of records) {
    entries.push(record);
    for (const value of Object.values(record)) if (Array.isArray(value)) for (const item of value) { const entry = rec(item); if (entry !== null) entries.push(entry); }
  }
  let newest: { at: number; text: string } | null = null;
  for (const entry of entries) {
    const status = (str(entry.status) ?? str(entry.state))?.toLowerCase() ?? null;
    if (status !== null && !/^(completed?|ready|done|succeeded|success|available)$/.test(status)) continue;
    const text = str(entry.completedAt) ?? str(entry.finishedAt) ?? str(entry.createdAt) ?? str(entry.takenAt);
    const at = text === null ? NaN : Date.parse(text);
    if (Number.isFinite(at) && (newest === null || at > newest.at)) newest = { at, text: new Date(at).toISOString() };
  }
  return newest?.text ?? null;
}

export class BoatApi {
  readonly cli: BoatCli;

  constructor(cli: BoatCli) {
    this.cli = cli;
  }

  async limits(signal?: AbortSignal): Promise<Limits> {
    const raw = await this.cli.json(["limits"], { signal });
    const current = rec(raw.currentLimits);
    const starts = rec(raw.starts);
    return {
      tier: str(raw.accessTier) ?? str(raw.planName),
      summary: str(raw.trialLine),
      activeSandboxes: num(raw.activeSandboxes) ?? 0,
      maxActiveSandboxes: num(current?.activeSandboxes) ?? num(raw.maxActiveSandboxes),
      startsLeftToday: num(rec(starts?.day)?.remaining),
      startsLeftThisHour: num(rec(starts?.hour)?.remaining),
      canStart: bool(raw.canStart) ?? true,
      blockedReason: str(raw.startBlockedReason) ?? str(raw.blockedReason),
      checkoutRequired: bool(raw.checkoutRequired) ?? false,
      autoStopCapHours: autoStopCapFromLimits(raw),
      startsLeftThisMinute: num(rec(starts?.minute)?.remaining),
      startsUnlimited: bool(starts?.unlimited),
      extraStartsEnabled: bool(rec(raw.keepGoing)?.enabled),
      nextStartDollars: num(raw.nextStartDollars),
    };
  }

  /** Read-only machine time/cost; billing seconds already include the size multiplier. */
  async usage(id: string, window: { since?: string; until?: string } = {}, signal?: AbortSignal) {
    return parseSandboxUsage(await this.cli.json(["usage", id, ...(window.since ? ["--since", window.since] : []), ...(window.until ? ["--until", window.until] : [])], { signal }));
  }

  async usagePlan(signal?: AbortSignal) {
    return parseUsagePlan(await this.cli.json(["limits"], { signal }));
  }

  /** Names of the account's boat environments. */
  /** The environment boat uses when none is named (null: none marked). */
  async defaultEnvironment(signal?: AbortSignal): Promise<string | null> {
    const raw = await this.cli.json(["env", "list"], { signal });
    const list = Array.isArray(raw.environments) ? raw.environments : [];
    const entry = list.map((item) => rec(item)).find((item) => item !== null && item.isDefault === true);
    return str(entry?.name) ?? null;
  }

  async environments(signal?: AbortSignal): Promise<string[]> {
    const raw = await this.cli.json(["env", "list"], { signal });
    const list = Array.isArray(raw.environments) ? raw.environments : [];
    return list.map((entry) => str(rec(entry)?.name)).filter((name): name is string => name !== null);
  }

  async list(options: { all?: boolean; signal?: AbortSignal } = {}): Promise<Sandbox[]> {
    const raw = await this.cli.json(["list", ...(options.all === true ? ["--all"] : [])], {
      signal: options.signal,
    });
    if (!Array.isArray(raw.sandboxes)) throw new BoatError("boat returned an invalid sandbox inventory", { code: "boat_bad_output" });
    const sandboxes = raw.sandboxes;
    if (sandboxes.some(entry => rec(entry) === null)) throw new BoatError("boat returned an invalid sandbox inventory", { code: "boat_bad_output" });
    return sandboxes
      .map((entry) => rec(entry))
      .filter((entry): entry is JsonRecord => entry !== null)
      .map(toSandbox);
  }

  async info(id: string, signal?: AbortSignal): Promise<Sandbox> {
    const raw = await this.cli.json(["info", id], { signal });
    const sandbox = rec(raw.sandbox) ?? raw;
    return toSandbox(sandbox);
  }

  /** Returns null when boat says the sandbox does not exist. */
  async findInfo(id: string, signal?: AbortSignal): Promise<Sandbox | null> {
    try {
      return await this.info(id, signal);
    } catch (error) {
      if (error instanceof BoatError && (error.code === "not_found" || error.status === 404)) return null;
      throw error;
    }
  }

  async create(options: {
    name: string;
    type: MachineType;
    environment?: string | null;
    ttlSeconds?: number | null;
    noAutoStop?: boolean;
    /** Saved snapshot (or share code) to start from: `boat new --from`. */
    from?: string | null;
    /** Per-sandbox environment variables (`boat new -e`). */
    env?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<Sandbox> {
    const args = ["new", "--name", options.name.slice(0, 120), "--type", options.type];
    if (options.environment) args.push("--environment", options.environment);
    if (options.from) args.push("--from", options.from);
    for (const [key, value] of Object.entries(options.env ?? {})) args.push("-e", `${key}=${value}`);
    if (options.ttlSeconds !== null && options.ttlSeconds !== undefined) {
      args.push("--ttl", String(Math.round(options.ttlSeconds)));
    }
    if (options.noAutoStop === true) args.push("--no-auto-stop");
    const result = await this.cli.run(args, { timeoutMs: 180_000, signal: options.signal, allowFailure: true });
    const ready = [...result.records].reverse().find((record) => record.event === "ready");
    const created = result.records.find((record) => record.event === "created");
    if (result.exitCode !== 0) {
      // boat may have created the sandbox before failing; don't leave it holding a slot.
      const orphan = str(created?.id);
      if (orphan !== null) await this.delete(orphan).catch(() => undefined);
      const error = [...result.records].reverse().find((record) => record.event === "error");
      throw new BoatError(str(error?.error) ?? (result.stderr.trim() || `boat new exited with code ${result.exitCode}`), {
        code: str(error?.code) ?? "boat_failed",
        status: num(error?.status),
        exitCode: result.exitCode,
      });
    }
    const id = str(ready?.id) ?? str(created?.id);
    if (id === null) {
      throw new BoatError("boat new did not report a sandbox id", { code: "boat_bad_output" });
    }
    try {
      return await this.info(id, options.signal);
    } catch {
      return {
        id,
        name: options.name,
        state: str(ready?.state) ?? "ready",
        health: null,
        url: str(ready?.url),
        desktopUrl: str(ready?.desktopUrl),
        environment: options.environment ?? null,
        createdAt: null,
        archiveAfter: str(ready?.archiveAfter),
        stoppedAt: null,
        setupStatus: null,
        error: null,
      };
    }
  }

  async delete(id: string, signal?: AbortSignal): Promise<void> {
    await this.cli.run(["delete", id, "--yes"], { timeoutMs: 120_000, signal });
  }

  /**
   * force: stop even if boat can't snapshot it; keeps the last completed
   * snapshot, what was written since is lost (boat: only after a stop has
   * failed). Returns what boat printed of the stop (shape not verified):
   * its status (pending, failing, completed, superseded), its id for
   * `stopStatus`, and for a forced one whether boat forced it (false: it
   * returned a stop still pending instead).
   */
  async stop(id: string, signal?: AbortSignal, options: { force?: boolean } = {}): Promise<StopReport> {
    return this.stopCall(["stop", id, ...(options.force === true ? ["--force"] : [])], 180_000, signal);
  }

  /** An earlier stop's status (`boat stop <id> --status <stop id>`): reads it, never stops again. */
  async stopStatus(id: string, stopId: string, signal?: AbortSignal): Promise<StopReport> {
    return this.stopCall(["stop", id, "--status", stopId], 60_000, signal);
  }

  /** A stop call that failed but still names its stop comes back as that stop, refused (its error). */
  private async stopCall(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<StopReport> {
    const result = await this.cli.run(args, { timeoutMs, signal, allowFailure: true });
    const report = stopReport(result.records);
    if (result.exitCode === 0) return report;
    const failure = [...result.records].reverse().find((record) => record.event === "error");
    const said = str(failure?.error) ?? str(failure?.message) ?? (result.stderr.trim().split("\n").at(-1) || `boat stop exited with code ${result.exitCode}`);
    if (report.stopId === null && report.status === null) {
      throw new BoatError(said, { code: str(failure?.code) ?? "boat_failed", status: num(failure?.status), exitCode: result.exitCode });
    }
    return { ...report, error: report.error ?? said };
  }

  /**
   * Fork a sandbox from its latest snapshot and wait until it's ready (`boat
   * fork --wait`: created, state and ready lines, like `boat new`). A failed
   * fork's error carries `forkId` when boat made one.
   */
  async fork(id: string, options: { noSnapshots?: boolean; ttlSeconds?: number; signal?: AbortSignal } = {}): Promise<{ id: string }> {
    const args = ["fork", id, "--wait"];
    if (options.noSnapshots === true) args.push("--no-snapshots");
    if (options.ttlSeconds !== undefined) args.push("--ttl", String(Math.round(options.ttlSeconds)));
    const result = await this.cli.run(args, { timeoutMs: 300_000, signal: options.signal, allowFailure: true });
    const made = [...result.records].reverse().map((record) => str(record.id) ?? str(rec(record.sandbox)?.id)).find((value) => value !== null && value !== id) ?? null;
    if (result.exitCode !== 0 || made === null) {
      const error = [...result.records].reverse().find((record) => record.event === "error");
      throw Object.assign(new BoatError(str(error?.error) ?? (result.stderr.trim() || "boat fork failed"), { code: str(error?.code) ?? "boat_failed", status: num(error?.status), exitCode: result.exitCode }), { forkId: made });
    }
    return { id: made };
  }

  /** When boat last completed a snapshot of this sandbox (`boat snapshots <id>`; null: none, or not said). */
  async lastSnapshotAt(id: string, signal?: AbortSignal): Promise<string | null> {
    return lastCompletedSnapshot((await this.cli.run(["snapshots", id], { timeoutMs: 60_000, signal })).records);
  }

  /** `type`: resume onto another size (`--type`); omitted, boat keeps the sandbox's size. */
  async resume(id: string, ttlSeconds: number | null, signal?: AbortSignal, type?: MachineType | null): Promise<void> {
    const args = ["resume", id];
    if (ttlSeconds !== null) args.push("--ttl", String(Math.round(ttlSeconds)));
    if (type) args.push("--type", type);
    await this.cli.run(args, { timeoutMs: 180_000, signal });
  }

  /** Expose a port on a private, token-gated HTTPS link (stable across stop and resume). */
  async host(id: string, port: number, title: string, signal?: AbortSignal): Promise<HostedPort> {
    const record = await this.cli.json(["host", id, String(port), "--private", "--title", title.slice(0, 120)], { timeoutMs: 60_000, signal });
    const url = str(record.url);
    if (url === null || !/^https:\/\//.test(url)) throw new BoatError("boat host did not return a link", { code: "boat_bad_output" });
    return { url, port: num(record.port) ?? port, title: str(record.title), isProtected: bool(record.isProtected) ?? true };
  }

  /** Start a command in the background (it outlives the call); returns its process id. */
  async execDetached(id: string, command: string, signal?: AbortSignal): Promise<{ pid: number | null }> {
    const record = await this.cli.json(["exec", id, "--detach", "--", "bash", "-lc", command], { timeoutMs: 90_000, signal });
    if (record.event === "error" || record.success === false) {
      throw new BoatError(str(record.error) ?? "boat exec --detach failed", { code: str(record.code) ?? "boat_failed" });
    }
    return { pid: num(record.pid) ?? num(record.processId) };
  }

  /** Save the sandbox's state under a name (`boat new --from <name>` starts from it). */
  async snapshot(id: string, name: string, signal?: AbortSignal): Promise<{ name: string; sizeBytes: number | null }> {
    const record = await this.cli.json(["snapshot", id, name], { timeoutMs: 900_000, signal });
    return { name: str(record.name) ?? name, sizeBytes: num(record.sizeBytes) };
  }

  /** Saved snapshots and the plan's allowance for them. */
  async snapshots(signal?: AbortSignal): Promise<{ snapshots: SavedSnapshot[]; included: number | null; used: number | null }> {
    const record = await this.cli.json(["snapshots"], { timeoutMs: 60_000, signal });
    const named = Array.isArray(record.named) ? record.named : [];
    const allowance = rec(record.namedAllowance) ?? rec(record.savedAllowance);
    return {
      snapshots: named
        .map((entry) => rec(entry))
        .filter((entry): entry is JsonRecord => entry !== null && str(entry.name) !== null)
        .map((entry) => ({
          name: str(entry.name)!,
          sizeBytes: num(entry.sizeBytes),
          createdAt: str(entry.createdAt),
          sourceSandboxId: str(entry.sourceSandboxId),
          status: str(entry.status),
          type: str(entry.type),
        })),
      included: num(allowance?.included),
      used: num(allowance?.used),
    };
  }

  /**
   * Land a worker's commits on the base branch, after the user approved them:
   * bring them up to date with the base (a rebase; nothing is ever forced) and
   * push. Uncommitted changes or conflicts stop it before anything is pushed.
   */
  async extend(id: string, args: string[], signal?: AbortSignal): Promise<JsonRecord> {
    return this.cli.json(["extend", id, ...args], { signal });
  }

  async exec(
    id: string,
    command: string,
    /** login false: a plain `bash -c` that never reads ~/.profile (it may not be restored yet). */
    options: { timeoutMs?: number; signal?: AbortSignal; login?: boolean } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const remoteSeconds = Math.max(5, Math.min(600, Math.round((options.timeoutMs ?? 120_000) / 1000)));
    const result = await this.cli.run(
      ["exec", id, "--timeout", String(remoteSeconds), "--", "bash", options.login === false ? "-c" : "-lc", command],
      { timeoutMs: remoteSeconds * 1000 + 30_000, signal: options.signal, allowFailure: true },
    );
    const record = result.records.at(-1);
    if (record?.event === "error") {
      throw new BoatError(str(record.error) ?? "boat exec failed", {
        code: str(record.code) ?? "boat_failed",
        status: num(record.status),
      });
    }
    if (record === undefined || num(record.exitCode) === null) {
      throw new BoatError(result.stderr.trim() || "boat exec printed no result", {
        code: "boat_bad_output",
        exitCode: result.exitCode,
      });
    }
    return {
      exitCode: num(record.exitCode) ?? result.exitCode,
      stdout: str(record.stdout) ?? "",
      stderr: str(record.stderr) ?? "",
    };
  }

  /**
   * A boat environment's setup, with its variables' NAMES only: the values
   * are dropped the moment they're read and never leave this function.
   */
  async environmentInfo(name: string, signal?: AbortSignal): Promise<EnvironmentInfo> {
    const record = await this.cli.json(["env", "info", name], { timeoutMs: 60_000, signal });
    const env = rec(record.environment) ?? record;
    const effective = rec(env.effective) ?? {};
    const secretNames = envNames(typeof env.envContents === "string" ? env.envContents : "");
    const files = Array.isArray(env.secretFiles) ? env.secretFiles : [];
    const repos = Array.isArray(env.selectedRepositories) ? env.selectedRepositories : [];
    return {
      name: str(env.name) ?? name,
      secretNames,
      secretFiles: files.map((file) => (typeof file === "string" ? file : (str(rec(file)?.path) ?? str(rec(file)?.name) ?? "?"))),
      repos: repos
        .map((entry) => rec(entry))
        .filter((entry): entry is JsonRecord => entry !== null && str(entry.fullName) !== null)
        .map((entry) => ({ repo: str(entry.fullName)!, permission: str(entry.permissions), baseBranch: str(entry.baseBranch) })),
      passGithub: bool(effective.passGithub) ?? bool(env.passGithub),
      passSecrets: bool(effective.passSecrets) ?? bool(env.passSecrets),
      passAgentsCredentials: bool(effective.passAgentsCredentials) ?? bool(env.passAgentsCredentials),
      passSandboxCredentials: bool(effective.passSandboxCredentials) ?? bool(env.passSandboxCredentials),
      proxyAiCredentials: bool(env.proxyAiCredentials),
      safeForThirdParties: bool(env.safeForThirdParties),
    };
  }

  /** The account's AI credentials proxy and its price (read-only: `boat ai proxy` without on or off). */
  async aiProxy(signal?: AbortSignal): Promise<AiProxyState> {
    return parseAiProxy(await this.cli.json(["ai", "proxy"], { timeoutMs: 30_000, signal }));
  }

  /**
   * Send a prompt to a coding agent in the sandbox and return as soon as boat
   * has queued it. The agent keeps working after the local CLI exits.
   */
  async prompt(options: PromptOptions): Promise<Dispatch> {
    // boat creates a conversation under an unknown id passed to --resume, so
    // new conversations get an id we choose: known before dispatch, and a
    // retry cannot fork a second conversation.
    const conversationId = options.conversationId ?? randomUUID();
    const args = ["prompt", options.sandboxId, "--provider", options.provider, "--resume", conversationId];
    if (options.model) args.push("--model", options.model);
    if (options.reasoningEffort) args.push("--reasoning-effort", options.reasoningEffort);
    args.push(safePositional(options.prompt));
    return this.cli.until(
      args,
      (record) => {
        if (record.event !== "queued") return null;
        const data = rec(record.data);
        const run = rec(data?.promptRun);
        return {
          conversationId:
            str(data?.conversationId) ?? str(run?.conversationId) ?? str(record.convo) ?? conversationId,
          promptId: str(data?.promptId) ?? str(run?.id) ?? str(record.promptId),
          model: str(data?.model) ?? str(record.model),
        };
      },
      { timeoutMs: 120_000, signal: options.signal },
    );
  }

  async conversations(sandboxId: string, signal?: AbortSignal): Promise<Conversation[]> {
    const result = await this.cli.run(["conversations", sandboxId], { signal });
    return result.records
      .map((record) => rec(record.data) ?? record)
      .map((data) => {
        const id = str(data.id);
        if (id === null) return null;
        return {
          id,
          running: bool(data.running) ?? false,
          harness: str(data.lastHarness),
          model: str(data.lastModel),
          prompts: num(data.prompts) ?? 0,
          lastPromptAt: str(data.lastPromptAt),
          lastPromptPreview: str(data.lastPromptPreview),
        };
      })
      .filter((entry): entry is Conversation => entry !== null);
  }

  async events(sandboxId: string, conversationId: string, signal?: AbortSignal): Promise<ChatEvent[]> {
    const result = await this.cli.run(["events", sandboxId, "--convo", conversationId], {
      signal,
      timeoutMs: 120_000,
      keepTail: true,
    });
    return result.records
      .filter((record) => record.event === "chat" || record.event === "usage_limit")
      .map((record) => {
        const outer = rec(record.data) ?? {};
        const inner = rec(outer.data) ?? {};
        const tools = Array.isArray(inner.tools)
          ? inner.tools
              // boat sends { use: { name, input }, result } per tool step.
              .map((tool) => str(rec(rec(tool)?.use)?.name) ?? str(rec(tool)?.name))
              .filter((name): name is string => name !== null)
          : [];
        return {
          type: str(outer.type) ?? "unknown",
          promptId: str(outer.taskId),
          conversationId: str(outer.conversationId),
          status: str(inner.status),
          // Responses carry `content`; prompt events carry the prompt text.
          content: typeof inner.content === "string" ? inner.content : str(inner.prompt),
          error: str(inner.error) ?? str(rec(inner.error)?.message) ?? (record.event === "chat" && str(outer.type) === "usage_limit" ? JSON.stringify(inner).slice(0, 500) : null),
          timestamp: num(outer.timestamp),
          tools,
        };
      });
  }

  /** `boat ps`: what runs in the sandbox (its last stored sample when it's stopped). */
  async processes(sandboxId: string, signal?: AbortSignal): Promise<ProcessSample> {
    const result = await this.cli.run(["ps", sandboxId], { signal, timeoutMs: 30_000 });
    return parseProcessSample(result.records);
  }

  async steer(sandboxId: string, conversationId: string, message: string, signal?: AbortSignal): Promise<void> {
    await this.cli.run(["steer", sandboxId, "--convo", conversationId, safePositional(message)], { signal });
  }

  async interrupt(sandboxId: string, conversationId: string | null, signal?: AbortSignal): Promise<void> {
    const args = ["interrupt", sandboxId];
    if (conversationId !== null) args.push("--convo", conversationId);
    await this.cli.run(args, { signal });
  }
}

/** The agent's final answer for one prompt run: the last non-empty response. */
export function finalResponse(events: ChatEvent[], promptId: string | null): string | null {
  const relevant = events.filter(
    (event) => event.type === "response" && (promptId === null || event.promptId === promptId),
  );
  for (let index = relevant.length - 1; index >= 0; index -= 1) {
    const content = relevant[index]?.content?.trim();
    if (content) return content;
  }
  return null;
}

/** The terminal status boat recorded for one prompt run (`finished`, `failed`, ...). */
export function promptStatus(events: ChatEvent[], promptId: string | null): string | null {
  const prompts = events.filter(
    (event) => event.type === "prompt" && (promptId === null || event.promptId === promptId),
  );
  return prompts.at(-1)?.status ?? null;
}
