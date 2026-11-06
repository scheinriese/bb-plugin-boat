// Sandbox sizes and memory for tasks: what a task's sandbox is (agents are
// told in every prompt), out-of-memory kills when a turn fails, the peak a
// measured turn used, a project's size for new sandboxes, and moving a
// sandbox to another size (stop, then `boat resume --type`).
//
// Everything is recorded as task events: visible "sandbox-size" and
// "memory" lines for the history, and hidden "memory-data" JSON for the
// plugin (no database migration). BoatService builds one SandboxSizes and
// calls it from a few places (marked "sizes" there).
import type { TaskMemoryDto, ResizeInfoDto } from "../contract-size.ts";
import { ACTIVE_STATES, type BoatApi, type MachineType, type Sandbox } from "./boat-api.ts";
import {
  DATA_KIND,
  MEMORY_KIND,
  SIZE_KIND,
  SIZE_SPECS,
  TURN_END_KINDS,
  TURN_START_KINDS,
  compareSizes,
  decodeData,
  encodeData,
  errorWithOom,
  gb,
  governingProject,
  inferType,
  movedNote,
  nextSize,
  oomCausedFailure,
  oomFinding,
  oomHistory,
  oomMessage,
  parseProbe,
  peakLine,
  planVerdict,
  probeScript,
  recommendSize,
  samplerScript,
  sandboxLine,
  sizeDetail,
  sizeSummary,
  specText,
  splitOomError,
  turnWindow,
  victimLabel,
  type KlogMode,
  type KnownSize,
  type MemoryData,
  type OomFinding,
  type PlanSize,
  type Probe,
  type SizeSource,
  type SizedProject,
} from "./memory.ts";
import { TaskError, type BoatService, type BoatSettings, type ServiceHooks } from "./service.ts";
import type { Runner, Task, TaskStore } from "./store.ts";

type DataOf<T extends MemoryData["type"]> = Extract<MemoryData, { type: T }>;
type FollowupOptions = NonNullable<Parameters<BoatService["followup"]>[2]>;

export interface SizesDeps {
  boat: BoatApi;
  store: TaskStore;
  hooks: ServiceHooks;
  settings(): Promise<BoatSettings>;
  /** Hold a sandbox (idle stops, room-making, wakes and ships leave it alone). */
  claim(sandboxId: string): () => void;
  claimed(sandboxId: string): boolean;
  /** Resume a stopped sandbox within the slot limit (ensureRunning). */
  bringUp(sandboxId: string, signal?: AbortSignal): Promise<Sandbox>;
  markSuspended(hostId: string): void;
  markResumed(hostId: string): void;
  followup(id: string, message: string, options: FollowupOptions): Promise<Task>;
  /** A chat task brought up to date (one that just finished may still read running). */
  refresh(id: string): Promise<Task>;
  deliverPending(): Promise<void>;
}

export interface ResizeRequest {
  /** The task asking; its follow-up goes out once the sandbox is up. */
  taskId: string;
  type: MachineType;
  /** null or empty: only move the sandbox. */
  message: string | null;
  followup?: FollowupOptions;
  /** The user said yes (the page's click, --user-approved, user_approved). XLarge needs it. */
  userApproved: boolean;
  /** Who asked (a chat): told if the move ends after they stopped waiting. */
  notifyThreadId: string | null;
  /** How long the caller waits before it gets `pending`. */
  waitMs: number;
  /** page: the user; cli: the CLI; tool: an orchestrator (only up, and Large only after a memory finding unless approved). */
  by: "page" | "cli" | "tool";
}

export interface ResizeResult {
  task: Task;
  pending: boolean;
  from: MachineType | null;
  to: MachineType;
  moved: string[];
  sent: boolean;
}

type Step = "stopping" | "starting" | "reconnecting" | "sending";
type Outcome = { ok: true; sent: boolean } | { ok: false; error: TaskError };

interface Job {
  sandboxId: string;
  taskId: string;
  from: MachineType | null;
  to: MachineType;
  step: Step;
  withMessage: boolean;
  moved: string[];
  previews: number;
  /** The caller still waits: it gets the outcome itself. */
  callerWaiting: boolean;
  release: () => void;
  done: Promise<Outcome> | null;
}

const LABEL = (type: MachineType) => SIZE_SPECS[type].label;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const trimDot = (text: string) => text.trim().replace(/[.\s]+$/, "");

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Resolves null after `ms` (fakes and some boat calls ignore signals). */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]);
}

function chatSentAt(task: Pick<Task, "promptId">): number | null {
  if (!task.promptId?.startsWith("chat:")) return null;
  const at = Number(task.promptId.slice(5));
  return Number.isFinite(at) ? at : null;
}

/** "Small costs half as much per hour as Default." ("" for Default; boat states no rate for XLarge). */
export function costSentence(type: MachineType): string {
  if (type === "small") return "Small costs half as much per hour as Default.";
  if (type === "large") return "Large costs twice as much per hour as Default.";
  return "";
}

export class SandboxSizes {
  private readonly deps: SizesDeps;
  /** Tasks whose failure notice waits for the memory check (until the epoch ms). */
  private readonly holding = new Map<string, number>();
  private readonly checks = new Set<Promise<void>>();
  /** How each sandbox's kernel log reads, per boot. */
  private readonly klogModes = new Map<string, { bootId: string | null; mode: KlogMode }>();
  /** Moves in progress, by sandbox. */
  private readonly jobs = new Map<string, Job>();
  /** The last failed move per task (shown until its next turn). */
  private readonly failures = new Map<string, { from: MachineType | null; to: MachineType; error: string; turns: number }>();
  /** A move's target: any resume of the sandbox meanwhile (ours, or bb's on a message) uses it. */
  private readonly pendingTypes = new Map<string, MachineType>();
  /** Why a resume onto the pending type failed (bb drives a chat machine's resume). */
  private readonly resumeErrors = new Map<string, string>();
  /** The Default sandbox size setting, as last read (view never waits on settings). */
  private settingType: MachineType = "default";

  constructor(deps: SizesDeps) {
    this.deps = deps;
  }

  private get timing() {
    const timing = this.deps.hooks.sizeTiming ?? {};
    return {
      checkMs: timing.checkMs ?? 20_000,
      pollMs: timing.pollMs ?? 3_000,
      stopMs: timing.stopMs ?? 4 * 60_000,
      startMs: timing.startMs ?? 5 * 60_000,
      reconnectMs: timing.reconnectMs ?? 5 * 60_000,
    };
  }

  // ---------------------------------------------------------------- records

  private data(taskId: string): { at: string; data: MemoryData }[] {
    const out: { at: string; data: MemoryData }[] = [];
    for (const event of this.deps.store.events(taskId, 1000)) {
      if (event.kind !== DATA_KIND) continue;
      const data = decodeData(event.text);
      if (data !== null) out.push({ at: event.at, data });
    }
    return out;
  }

  private latest<T extends MemoryData["type"]>(taskId: string, type: T): { at: string; data: DataOf<T> } | null {
    const all = this.data(taskId).filter((entry) => entry.data.type === type);
    return (all.at(-1) as { at: string; data: DataOf<T> } | undefined) ?? null;
  }

  private record(taskId: string, data: MemoryData): void {
    this.deps.store.addEvent(taskId, DATA_KIND, encodeData(data));
  }

  private say(taskId: string, kind: typeof SIZE_KIND | typeof MEMORY_KIND, text: string): void {
    this.deps.store.addEvent(taskId, kind, text);
  }

  /** The newest size reading of a sandbox, from any task that used it. */
  private sizeOf(sandboxId: string, extra: readonly string[] = []): DataOf<"size"> | null {
    const ids = new Set([...this.deps.store.liveSandboxTasks(sandboxId).map((task) => task.id), ...extra]);
    let best: DataOf<"size"> | null = null;
    for (const id of ids) {
      for (const { data } of this.data(id)) {
        if (data.type !== "size" || data.sandboxId !== sandboxId) continue;
        if (best === null || data.at >= best.at) best = data;
      }
    }
    return best;
  }

  /** What the task's sandbox is, as last read (null: not known). */
  knownSize(task: Pick<Task, "id" | "sandboxId">): KnownSize | null {
    if (task.sandboxId === null) return null;
    const size = this.sizeOf(task.sandboxId, [task.id]);
    return size === null ? null : { type: size.machineType, cpus: size.cpus, memTotalKb: size.memTotalKb };
  }

  private recordSize(taskIds: readonly string[], sandboxId: string, size: KnownSize, source: SizeSource, probe: Probe | null): void {
    const data: MemoryData = {
      type: "size",
      sandboxId,
      machineType: size.type,
      cpus: size.cpus,
      memTotalKb: size.memTotalKb,
      source,
      at: Date.now() / 1000,
      ...(probe ? { bootId: probe.bootId, oomKills: probe.oomKills } : {}),
    };
    for (const id of taskIds) this.record(id, data);
  }

  /** The plan's sizes from the newest boat reading, without waiting (null: unknown). */
  private planNow(): PlanSize[] | null {
    try {
      return this.deps.hooks.sizePlanNow?.() ?? null;
    } catch {
      return null;
    }
  }

  /** The plan's sizes read from boat now (a refusal or a move shouldn't rest on an old reading). */
  private async planFresh(): Promise<PlanSize[] | null> {
    return (await this.deps.hooks.sizePlan?.({ fresh: true }).catch(() => null)) ?? this.planNow();
  }

  // ---------------------------------------------------------------- the probe

  /**
   * One probe of a sandbox, capped (never fails: null when it couldn't
   * read). `hostAt`: the host clock in the middle of the call, for skew.
   */
  private async probe(
    sandboxId: string,
    options: { since?: number | null; task?: string | null; stopSampler?: boolean; signal?: AbortSignal },
  ): Promise<{ probe: Probe; hostAt: number } | null> {
    const cap = this.timing.checkMs;
    const cached = this.klogModes.get(sandboxId);
    const script = probeScript({ since: options.since, task: options.task, stopSampler: options.stopSampler, klog: cached?.mode ?? null });
    const started = Date.now();
    try {
      const signal = AbortSignal.any([this.deps.hooks.lifecycle, AbortSignal.timeout(cap), ...(options.signal ? [options.signal] : [])]);
      const result = await within(this.deps.boat.exec(sandboxId, script, { timeoutMs: 15_000, signal }), cap);
      if (result === null) {
        this.deps.hooks.log.warn(`memory check ${sandboxId}: no answer within ${Math.round(cap / 1000)}s`);
        return null;
      }
      const probe = parseProbe(result.stdout);
      if (probe === null) return null;
      if (probe.klog === "journal" || probe.klog === "sudo") this.klogModes.set(sandboxId, { bootId: probe.bootId, mode: probe.klog });
      else if (probe.klog === "none" || (cached && cached.bootId !== probe.bootId)) this.klogModes.delete(sandboxId);
      return { probe, hostAt: (started + Date.now()) / 2000 };
    } catch (error) {
      this.deps.hooks.log.warn(`memory check ${sandboxId}: ${message(error)}`);
      return null;
    }
  }

  private sizeFromProbe(probe: Probe | null): KnownSize | null {
    if (probe === null || (probe.cpus === null && probe.memTotalKb === null)) return null;
    return { type: inferType(probe.cpus, probe.memTotalKb), cpus: probe.cpus, memTotalKb: probe.memTotalKb };
  }

  // ---------------------------------------------------------------- dispatch

  /** A measured task: its first turn's peak memory is recorded (the repo check, the test task). */
  watch(taskId: string): void {
    this.record(taskId, { type: "watch" });
  }

  private watched(taskId: string): boolean {
    return this.latest(taskId, "watch") !== null;
  }

  /**
   * Before the first prompt: read the sandbox's size (new or reused), record
   * it with an out-of-memory baseline, start the sampler for a measured
   * task, and return the prompt's line about the size. Never fails the
   * dispatch.
   */
  async atDispatch(task: Task, sandbox: Sandbox, options: { created: boolean; requested: MachineType | null; signal: AbortSignal }): Promise<string> {
    const read = await this.probe(sandbox.id, { signal: options.signal });
    let size = this.sizeFromProbe(read?.probe ?? null);
    let source: SizeSource = "probe";
    if (size === null) {
      const known = this.sizeOf(sandbox.id);
      if (known !== null) {
        size = { type: known.machineType, cpus: known.cpus, memTotalKb: known.memTotalKb };
        source = known.source;
      } else if (sandbox.machineType) {
        size = { type: sandbox.machineType, cpus: null, memTotalKb: null };
        source = "boat";
      } else if (options.created && options.requested !== null) {
        size = { type: options.requested, cpus: null, memTotalKb: null };
        source = "requested";
      }
    }
    if (size !== null) {
      this.recordSize([task.id], sandbox.id, size, source, read?.probe ?? null);
      const summary = sizeSummary(size);
      if (summary !== null) this.say(task.id, SIZE_KIND, `Sandbox size: ${summary}`);
    }
    if (this.watched(task.id)) await this.startSampler(task, sandbox.id, options.signal);
    return sandboxLine(size, task.runner);
  }

  private async startSampler(task: Task, sandboxId: string, signal: AbortSignal): Promise<void> {
    try {
      const started = await within(this.deps.boat.execDetached(sandboxId, samplerScript(task.id), AbortSignal.any([signal, AbortSignal.timeout(this.timing.checkMs)])), this.timing.checkMs);
      if (started === null) throw new Error("no answer");
      this.record(task.id, { type: "sampler", sandboxId, turn: task.turns + 1, pid: started.pid });
      this.say(task.id, MEMORY_KIND, "Measuring peak memory during this turn.");
    } catch (error) {
      if (signal.aborted) return;
      this.deps.hooks.log.warn(`memory sampler ${task.id}: ${message(error)}`);
    }
  }

  /** The Environment line for a prompt written later (a handover): the last known size. */
  lineFor(task: Task, runner: Runner): string {
    return sandboxLine(this.knownSize(task), runner);
  }

  /** The newest record of a type when no turn started after it (events in order, not by time). */
  private sinceLastTurn<T extends MemoryData["type"]>(taskId: string, type: T): DataOf<T> | null {
    const events = this.deps.store.events(taskId, 1000);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (TURN_START_KINDS.has(event.kind)) return null;
      if (event.kind !== DATA_KIND) continue;
      const data = decodeData(event.text);
      if (data?.type === type) return data as DataOf<T>;
    }
    return null;
  }

  /**
   * The follow-up's note after the sandbox moved (this task asked, or moved
   * along): once, until the next turn starts.
   */
  followupNote(task: Task): string | null {
    const moved = this.sinceLastTurn(task.id, "resize");
    if (moved === null || moved.state !== "done") return null;
    return movedNote(moved.from, moved.to);
  }

  // ---------------------------------------------------------------- after a turn

  /** The task's failure notice waits for its memory check. */
  holds(taskId: string): boolean {
    const until = this.holding.get(taskId);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.holding.delete(taskId);
    return false;
  }

  /** Every memory check and move started so far has finished (tests). */
  async settled(): Promise<void> {
    for (;;) {
      const pending = [...this.checks, ...[...this.jobs.values()].map((job) => job.done).filter((done): done is Promise<Outcome> => done !== null)];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
      // A job's bookkeeping ends in its finally.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private userInterrupted(task: Task): boolean {
    const window = turnWindow(this.deps.store.events(task.id, 1000), chatSentAt(task), 0);
    if (window === null) return false;
    return this.deps.store.events(task.id, 200).some((event) => event.kind === "interrupted" && Date.parse(event.at) / 1000 >= window.start);
  }

  private measuredTurn(task: Task): DataOf<"sampler"> | null {
    if (!this.watched(task.id)) return null;
    const sampler = this.latest(task.id, "sampler");
    if (sampler === null || sampler.data.turn !== task.turns) return null;
    const peak = this.latest(task.id, "peak");
    return peak !== null && peak.data.turn === task.turns ? null : sampler.data;
  }

  /**
   * A turn ended: check the sandbox for out-of-memory kills when it failed,
   * was cut off, ended without a new message, or was interrupted by nobody;
   * and read a measured turn's peak. Runs in the background, capped: the
   * task is already recorded, and only its notice waits (holds), never the
   * sweep or a user's next action.
   */
  afterTurn(task: Task, context: { failed: boolean; interrupted?: boolean; sandbox?: Sandbox }): void {
    if (task.sandboxId === null) return;
    const measured = this.measuredTurn(task);
    const suspicious = context.failed || (context.interrupted === true && !this.userInterrupted(task));
    if (!suspicious && measured === null) return;
    // Synchronously, before anything awaits: no notice goes out without the check.
    this.holding.set(task.id, Date.now() + this.timing.checkMs + 5_000);
    const check: Promise<void> = this.check(task, { suspicious, measured, sandbox: context.sandbox, interrupted: context.interrupted === true })
      .catch((error) => this.deps.hooks.log.warn(`memory check ${task.id}: ${message(error)}`))
      .finally(() => {
        this.holding.delete(task.id);
        this.checks.delete(check);
        this.deps.hooks.changed([task.id]);
        void this.deps.deliverPending().catch(() => undefined);
      });
    this.checks.add(check);
  }

  private async check(task: Task, context: { suspicious: boolean; measured: DataOf<"sampler"> | null; sandbox?: Sandbox; interrupted: boolean }): Promise<void> {
    const sandboxId = task.sandboxId!;
    // Only a sandbox that's up: a stopped one (idle stop, a suspended machine) is never resumed for this.
    const sandbox = context.sandbox ?? (await within(this.deps.boat.findInfo(sandboxId, this.deps.hooks.lifecycle), this.timing.checkMs).catch(() => null));
    if (sandbox === null || sandbox === undefined || !ACTIVE_STATES.has(sandbox.state)) return;
    const events = this.deps.store.events(task.id, 1000);
    const window = turnWindow(events, chatSentAt(task));
    if (window === null) return;
    const measured = context.measured;
    // A wide window for journalctl (the sandbox's clock isn't known yet); the exact one below.
    const read = await this.probe(sandboxId, { since: window.since - 300, task: measured ? task.id : null, stopSampler: measured !== null });
    if (read === null) return;
    const { probe, hostAt } = read;
    const skew = probe.now !== null ? probe.now - hostAt : 0;
    const since = window.since + skew;
    const finding = oomFinding(probe, {
      since,
      baseline: this.baselineBefore(sandboxId, window.start, task.id),
      reported: this.reportedKeys(task.id),
      excludePids: new Set([measured?.pid, probe.peak?.pid].filter((pid): pid is number => typeof pid === "number")),
    });
    // The newest reading is the next turn's baseline.
    const read_size = this.sizeFromProbe(probe) ?? this.knownSize(task);
    if (read_size !== null) this.recordSize([task.id], sandboxId, read_size, "probe", probe);
    const current = read_size?.type ?? null;
    if (finding !== null) this.reportFinding(task, finding, { current, measuredOk: !context.suspicious, interrupted: context.interrupted });
    if (measured !== null) this.reportPeak(task, probe, { current, oom: finding?.certain === true, windowStart: window.start });
  }

  /** The newest reading of this sandbox from before the turn (same boot is checked by the finding). */
  private baselineBefore(sandboxId: string, start: number, taskId: string): { bootId: string | null; oomKills: number } | null {
    const ids = new Set([...this.deps.store.liveSandboxTasks(sandboxId).map((task) => task.id), taskId]);
    let best: DataOf<"size"> | null = null;
    for (const id of ids) {
      for (const { data } of this.data(id)) {
        if (data.type !== "size" || data.sandboxId !== sandboxId || typeof data.oomKills !== "number" || data.at > start) continue;
        if (best === null || data.at > best.at) best = data;
      }
    }
    return best === null ? null : { bootId: best.bootId ?? null, oomKills: best.oomKills! };
  }

  private reportedKeys(taskId: string): Set<string> {
    const keys = new Set<string>();
    for (const { data } of this.data(taskId)) {
      if (data.type !== "oom") continue;
      for (const kill of data.kills) keys.add(kill.key);
      if (data.counterKey) keys.add(data.counterKey);
    }
    return keys;
  }

  private reportFinding(task: Task, finding: OomFinding, context: { current: MachineType | null; measuredOk: boolean; interrupted: boolean }): void {
    const now = this.deps.store.get(task.id);
    if (now === null) return;
    const next = context.current === null ? null : nextSize(context.current);
    const verdict = next === null ? { allowed: false, reason: null } : planVerdict(next, this.planNow());
    const others = this.deps.store
      .liveSandboxTasks(task.sandboxId!)
      .filter((other) => other.id !== task.id)
      .map((other) => other.id);
    // The error this turn ended with (a newer turn or a close leaves it alone).
    const sameTurn = now.turns === task.turns && now.promptId === task.promptId;
    const original = sameTurn ? now.error : null;
    const cause = finding.certain && !context.measuredOk && (oomCausedFailure(finding, original) || original === null || context.interrupted);
    const chatRestart = cause && task.runner === "chat" && finding.kills.some((kill) => kill.unit === "bb");
    const text = finding.certain
      ? oomMessage(finding, { current: context.current, next, nextAllowed: verdict.allowed, cause, chatRestart, others })
      : oomHistory(finding)[0]!;
    this.record(task.id, {
      type: "oom",
      turn: task.turns,
      sandboxId: task.sandboxId!,
      machineType: context.current,
      kills: finding.kills.map((kill) => ({ key: kill.key, process: kill.process, label: victimLabel(kill), unit: kill.unit, rssKb: kill.rssKb, at: kill.at })),
      count: finding.count,
      source: finding.source,
      certain: finding.certain,
      cause,
      counterKey: finding.counterKey,
      message: text,
      next,
      nextAllowed: verdict.allowed,
      nextReason: verdict.reason === null ? null : verdict.reason.slice(0, 200),
      at: Date.now() / 1000,
    });
    for (const line of oomHistory(finding)) this.say(task.id, MEMORY_KIND, line);
    if (!finding.certain || context.measuredOk || !sameTurn || (now.status !== "failed" && now.status !== "idle")) return;
    // The plain message on the task (and so in the notice, the page and task show); the original stays as detail.
    this.deps.store.transition(task.id, [now.status], { error: errorWithOom(text, original, cause) }, { promptId: task.promptId });
  }

  private reportPeak(task: Task, probe: Probe, context: { current: MachineType | null; oom: boolean; windowStart: number }): void {
    const peak = probe.peak;
    if (peak === null || peak.samples < 3) {
      this.say(task.id, MEMORY_KIND, "Couldn't measure peak memory during this turn (the sampler stopped early).");
      return;
    }
    const recommendation = recommendSize({ peakKb: peak.peakKb, memTotalKb: peak.memTotalKb, oom: context.oom, current: context.current, plan: this.planNow() });
    // Another task working on the sandbox meanwhile makes the peak partly its.
    const shared = this.deps.store
      .liveSandboxTasks(task.sandboxId!)
      .filter((other) => other.id !== task.id)
      .some(
        (other) =>
          other.status === "running" ||
          other.status === "starting" ||
          this.deps.store.events(other.id, 200).some((event) => (TURN_START_KINDS.has(event.kind) || TURN_END_KINDS.has(event.kind)) && Date.parse(event.at) / 1000 >= context.windowStart),
      );
    this.record(task.id, {
      type: "peak",
      turn: task.turns,
      sandboxId: task.sandboxId!,
      peakKb: peak.peakKb,
      memTotalKb: peak.memTotalKb,
      swapKb: peak.swapKb,
      samples: peak.samples,
      machineType: context.current,
      oom: context.oom,
      shared,
      recommended: recommendation?.type ?? null,
      reason: recommendation?.reason ?? null,
      allowed: recommendation?.allowed ?? true,
      planReason: recommendation?.planReason ?? null,
      at: Date.now() / 1000,
    });
    const line = peakLine({ peakKb: peak.peakKb, memTotalKb: peak.memTotalKb, machineType: context.current, swapKb: peak.swapKb }, recommendation);
    this.say(task.id, MEMORY_KIND, shared ? `${line} Other tasks worked on this sandbox meanwhile, so part of it is theirs.` : line);
  }

  // ---------------------------------------------------------------- new sandboxes

  /**
   * The size of a task's new sandbox: one asked for (refused before anything
   * starts when the plan doesn't have it), else the project's (the setting
   * when the plan doesn't have it, with a note), else the setting. A review
   * in a new sandbox gets at least its task's current size.
   */
  async resolveNewType(input: {
    requested: MachineType | null;
    /** A new sandbox may be made (not a named or "same" one): check the plan. */
    checkPlan: boolean;
    projectId: string | null;
    repo: string | null;
    parent: Task | null;
    role: Task["role"];
    settings: BoatSettings;
  }): Promise<{ type: MachineType; note: string | null }> {
    this.settingType = input.settings.machineType;
    const allowed = async (type: MachineType) => {
      let verdict = planVerdict(type, this.planNow());
      // A refusal reads boat again first: the user may have just upgraded.
      if (!verdict.allowed) verdict = planVerdict(type, await this.planFresh());
      return verdict;
    };
    if (input.requested !== null) {
      if (input.checkPlan) {
        const verdict = await allowed(input.requested);
        if (!verdict.allowed) {
          throw new TaskError(
            `Your boat plan doesn't include ${LABEL(input.requested)} sandboxes: ${trimDot(verdict.reason ?? "")}.`,
            "size_not_on_plan",
            "Pick another size, or change your plan (`boat billing plan`).",
          );
        }
      }
      return { type: input.requested, note: null };
    }
    let type: MachineType = input.settings.machineType;
    let note: string | null = null;
    const project = governingProject(this.deps.hooks.projects?.() ?? [], input.projectId, input.repo);
    if (project?.machineType) {
      const verdict = await allowed(project.machineType);
      if (verdict.allowed) {
        type = project.machineType;
        note = `${LABEL(type)} sandbox, from project ${project.name}`;
      } else {
        type = await this.fallback(project.machineType, input.settings.machineType);
        note = `${project.name} uses ${LABEL(project.machineType)} sandboxes, but your boat plan doesn't include ${LABEL(project.machineType)} (${trimDot(verdict.reason ?? "")}). This sandbox is ${LABEL(type)}.`;
      }
    }
    // After a move up, a review in a new sandbox would run the same tests on less.
    if (input.role === "review" && input.parent?.sandboxId) {
      const parentType = this.knownSize(input.parent)?.type ?? null;
      if (parentType !== null && compareSizes(parentType, type) > 0 && planVerdict(parentType, this.planNow()).allowed) {
        type = parentType;
        note = `${LABEL(type)} sandbox, like task ${input.parent.id}'s`;
      }
    }
    return { type, note };
  }

  /** The setting when the plan has it, else the largest size the plan has below `wanted`. */
  private async fallback(wanted: MachineType, setting: MachineType): Promise<MachineType> {
    const plan = this.planNow();
    if (planVerdict(setting, plan).allowed) return setting;
    const below = (["xlarge", "large", "default", "small"] as const).filter((type) => compareSizes(type, wanted) < 0 && planVerdict(type, plan).allowed);
    return below[0] ?? setting;
  }

  /** The plan's verdict on a project's size (for the save's note); reads boat when there's no reading yet. */
  async projectSizeVerdict(type: MachineType | null): Promise<{ allowed: boolean; reason: string | null }> {
    if (type === null) return { allowed: true, reason: null };
    const plan = this.planNow() ?? (await this.deps.hooks.sizePlan?.().catch(() => null)) ?? null;
    return planVerdict(type, plan);
  }

  // ---------------------------------------------------------------- moving a sandbox

  /** A move's target for this sandbox: ensureRunning resumes onto it. */
  pendingType(sandboxId: string): MachineType | null {
    return this.pendingTypes.get(sandboxId) ?? null;
  }

  /** boat refused to resume onto the pending type (ensureRunning reports it). */
  resumeFailed(sandboxId: string, error: unknown): void {
    if (this.pendingTypes.has(sandboxId)) this.resumeErrors.set(sandboxId, message(error));
  }

  /** Sandboxes stopped for a move count as active, so their slot isn't given away (except to their own resume). */
  reservedSlots(active: readonly Pick<Sandbox, "id">[], forSandbox?: string | null): number {
    const ids = new Set(active.map((sandbox) => sandbox.id));
    return [...this.jobs.keys()].filter((id) => !ids.has(id) && id !== forSandbox).length;
  }

  /** Refuses work on a sandbox that's moving (a follow-up, a close, a ship). The move's own follow-up goes through. */
  assertSandboxNotResizing(sandboxId: string | null, hint = "Try again once it's up (a few minutes)."): void {
    if (sandboxId === null) return;
    const job = this.jobs.get(sandboxId);
    if (job === undefined || job.step === "sending") return;
    throw new TaskError(`Sandbox ${sandboxId} is moving to ${LABEL(job.to)} right now.`, "sandbox_resizing", hint);
  }

  assertCanFollowup(task: Pick<Task, "id" | "sandboxId">): void {
    const job = task.sandboxId === null ? undefined : this.jobs.get(task.sandboxId);
    if (job === undefined || job.step === "sending") return;
    throw new TaskError(`Task ${task.id}'s sandbox is moving to ${LABEL(job.to)} right now.`, "sandbox_resizing", "Send the follow-up once it's up (a few minutes).");
  }

  assertNotResizing(task: Pick<Task, "id" | "sandboxId">, action: "close" | "ship"): void {
    const job = task.sandboxId === null ? undefined : this.jobs.get(task.sandboxId);
    if (job === undefined) return;
    throw new TaskError(
      `Task ${task.id}'s sandbox is moving to ${LABEL(job.to)} right now.`,
      "sandbox_resizing",
      action === "close" ? "Close it once the move is done." : "Ship it once the move is done.",
    );
  }

  /** The first reason a task's sandbox can't move now (sync checks; `type` null: any size). */
  private blocker(task: Task, options: { type: MachineType | null; by: ResizeRequest["by"]; userApproved: boolean; threadId: string | null }): TaskError | null {
    if (task.status === "done" || task.status === "cancelled") return new TaskError(`Task ${task.id} is ${task.status}.`, "task_closed", "Start a new task.");
    if (task.status === "starting") {
      return new TaskError(`Task ${task.id} is still being dispatched.`, "task_starting", "Wait for its first turn, then change the size.");
    }
    if (task.runner === "chat" ? task.threadId === null : task.conversationId === null) {
      return new TaskError(`Task ${task.id} never reached its agent; start a new task instead.`, "task_not_dispatched");
    }
    const sandboxId = task.sandboxId;
    if (sandboxId === null) return new TaskError(`Task ${task.id} has no sandbox.`, "no_sandbox");
    if (!this.deps.store.pluginOwnsSandbox(sandboxId)) {
      return new TaskError(
        `Sandbox ${sandboxId} isn't one the plugin created, so the plugin won't stop it.`,
        "invalid_value",
        `Resize it with boat: \`boat stop ${sandboxId}\`, then \`boat resume ${sandboxId} --type <size>\`.`,
      );
    }
    const job = this.jobs.get(sandboxId);
    if (job !== undefined) return new TaskError(`Sandbox ${sandboxId} is already moving to ${LABEL(job.to)}.`, "sandbox_resizing", "Wait a few minutes.");
    const hint = "Wait for its turn to end, or interrupt it, then change the size.";
    if (task.status === "running") return new TaskError(`Task ${task.id} is still running.`, "sandbox_busy", hint);
    const others = this.deps.store.liveSandboxTasks(sandboxId).filter((other) => other.id !== task.id);
    const busy = others.find((other) => other.status === "running" || other.status === "starting");
    if (busy !== undefined) return new TaskError(`Task ${busy.id} (“${busy.title}”) is still running on this sandbox.`, "sandbox_busy", hint);
    if (this.deps.claimed(sandboxId)) return new TaskError("That sandbox is in use right now (a dispatch, wake or ship).", "sandbox_busy", "Try again in a moment.");
    if (options.type === null) return null;
    const current = this.knownSize(task)?.type ?? null;
    if (current === options.type) return new TaskError(`Task ${task.id}'s sandbox is already ${LABEL(options.type)}.`, "same_size");
    if (options.type === "xlarge" && !options.userApproved) {
      return new TaskError("An XLarge sandbox needs the user's OK.", "size_needs_approval", "Ask the user first, then pass user_approved (--user-approved). Large needs no OK after an out-of-memory failure.");
    }
    if (options.by === "tool" && !options.userApproved) {
      if (current !== null && compareSizes(options.type, current) < 0) {
        return new TaskError("Orchestrators only move a sandbox to a larger size.", "invalid_value", "The user can pick a smaller size on the task page (Change size…).");
      }
      if (!this.ranOutOfRoom(task)) {
        return new TaskError(
          `Moving task ${task.id}'s sandbox to ${LABEL(options.type)} needs the user's OK: its latest turn didn't run out of memory or come near the limit.`,
          "size_needs_approval",
          `${costSentence(options.type) || `${LABEL(options.type)} costs more per hour.`} Ask the user first, then pass user_approved.`,
        );
      }
      const foreign = others.find((other) => other.orchestratorThreadId !== (options.threadId ?? task.orchestratorThreadId));
      if (foreign !== undefined) {
        return new TaskError(
          `Task ${foreign.id} (“${foreign.title}”) from another chat also uses this sandbox, and moving it stops that work too.`,
          "size_needs_approval",
          "Ask the user first, then pass user_approved.",
        );
      }
    }
    return null;
  }

  /** The latest turn ran out of memory (or may have), or came near the limit. */
  private ranOutOfRoom(task: Task): boolean {
    const oom = this.latest(task.id, "oom");
    if (oom !== null && oom.data.turn === task.turns) return true;
    const peak = this.latest(task.id, "peak");
    return peak !== null && peak.data.turn === task.turns && (peak.data.reason === "near-limit" || peak.data.reason === "out-of-memory" || peak.data.reason === "largest");
  }

  /** The checks that read boat or bb; `type` null: the dialog's (no size yet). */
  private async asyncBlocker(task: Task, type: MachineType | null): Promise<{ blocker: TaskError | null; startsLeft: number | null; current: MachineType | null }> {
    const sandboxId = task.sandboxId!;
    const info = await this.deps.boat.findInfo(sandboxId, this.deps.hooks.lifecycle).catch(() => undefined);
    if (info === null) {
      return { blocker: new TaskError(`Task ${task.id}'s sandbox no longer exists.`, "sandbox_gone", `Start a new task (\`boat_dispatch\` with \`context_from\` ${task.id}).`), startsLeft: null, current: null };
    }
    const current = this.knownSize(task)?.type ?? info?.machineType ?? null;
    if (type !== null && current === type) return { blocker: new TaskError(`Task ${task.id}'s sandbox is already ${LABEL(type)}.`, "same_size"), startsLeft: null, current };
    const chat = this.deps.hooks.chat;
    const hostId = chat === undefined ? null : this.deps.store.hostForSandbox(sandboxId);
    if (chat !== undefined && hostId !== null) {
      const threads = [...new Set(this.deps.store.liveSandboxTasks(sandboxId).flatMap((entry) => this.deps.store.chatThreads(entry.id)))];
      let busy = await chat.machineBusy(hostId).catch(() => false);
      for (const threadId of threads) {
        if (busy) break;
        const state = await chat.state(threadId).catch(() => null);
        busy = state !== null && !state.archived && ((state.status !== "idle" && state.status !== "error") || state.queued > 0 || state.backgroundAgents > 0);
      }
      if (busy) return { blocker: new TaskError("A chat on this sandbox is still working.", "sandbox_busy", "Wait for its turn to end, or interrupt it, then change the size."), startsLeft: null, current };
    }
    if (type !== null) {
      const verdict = planVerdict(type, await this.planFresh());
      if (!verdict.allowed) {
        return {
          blocker: new TaskError(`Your boat plan doesn't include ${LABEL(type)} sandboxes: ${trimDot(verdict.reason ?? "")}.`, "size_not_on_plan", "Pick another size, or change your plan (`boat billing plan`)."),
          startsLeft: null,
          current,
        };
      }
    }
    // The move resumes the sandbox: that's a boat start. Know it's there before stopping anything.
    const limits = await this.deps.boat.limits(this.deps.hooks.lifecycle).catch(() => null);
    const startsLeft = limits === null ? null : [limits.startsLeftToday, limits.startsLeftThisHour].filter((n): n is number => n !== null).reduce<number | null>((min, n) => (min === null ? n : Math.min(min, n)), null);
    if (limits !== null) {
      if (limits.checkoutRequired || !limits.canStart) {
        return { blocker: new TaskError(`boat won't start a sandbox right now${limits.blockedReason ? `: ${trimDot(limits.blockedReason)}` : ""}, so a moved sandbox couldn't start again.`, "boat_start_blocked", "Run `boat limits --all` for details."), startsLeft, current };
      }
      if (startsLeft === 0) {
        return { blocker: new TaskError("The boat start limit is used up for now, and a move starts the sandbox again.", "boat_start_limit", "Wait for the window to roll over, or upgrade the plan (`boat billing plan`)."), startsLeft, current };
      }
      const shrinking = type !== null && current !== null && compareSizes(type, current) < 0;
      if (startsLeft === 1 && type !== null && (shrinking || current === null)) {
        return {
          blocker: new TaskError(
            "This would use your last boat start for now, and boat may refuse the move (it refuses to shrink a sandbox whose data doesn't fit), leaving the sandbox stopped.",
            "boat_start_limit",
            "Wait for the start window to roll over, then change the size.",
          ),
          startsLeft,
          current,
        };
      }
    }
    return { blocker: null, startsLeft, current };
  }

  /** What the Change sandbox size dialog needs (never throws for a known task). */
  async info(taskId: string): Promise<ResizeInfoDto> {
    const task = await this.deps.refresh(taskId);
    const sandboxId = task.sandboxId;
    const others = sandboxId === null ? [] : this.deps.store.liveSandboxTasks(sandboxId).filter((other) => other.id !== task.id);
    const size = this.knownSize(task);
    const current = size === null ? null : { type: size.type, label: size.type ? LABEL(size.type) : "Unknown size", summary: (size.type ? specText(size.type) : sizeSummary(size)) ?? "" };
    let blocker = this.blocker(task, { type: null, by: "page", userApproved: true, threadId: null });
    let startsLeft: number | null = null;
    if (blocker === null) {
      const checked = await this.asyncBlocker(task, null);
      blocker = checked.blocker;
      startsLeft = checked.startsLeft;
    }
    const plan = this.planNow();
    let suggested: MachineType | null = null;
    for (let next = size?.type ? nextSize(size.type) : null; next !== null; next = nextSize(next)) {
      if (planVerdict(next, plan).allowed) {
        suggested = next;
        break;
      }
    }
    const oom = this.latest(task.id, "oom");
    return {
      sandboxId,
      current,
      suggested,
      oom: oom !== null && oom.data.turn === task.turns && oom.data.certain,
      others: others.map((other) => ({ id: other.id, title: other.title, status: other.status })),
      previews: sandboxId === null ? 0 : this.livePreviews(sandboxId),
      chat: sandboxId !== null && this.deps.hooks.chat !== undefined && this.deps.store.hostForSandbox(sandboxId) !== null,
      startsLeft,
      blocker: blocker === null ? null : { code: blocker.code, message: blocker.message, hint: blocker.hint ?? null },
    };
  }

  private livePreviews(sandboxId: string): number {
    return this.deps.store.previews().filter((preview) => preview.sandboxId === sandboxId && preview.health !== "unknown").length;
  }

  /**
   * Move a task's sandbox to another size, then send the message as its
   * follow-up. Refusals come first, before anything changes; the move runs
   * in the background (the caller waits up to waitMs, then gets pending).
   * Every task on the sandbox moves with it, and each one's history says so.
   */
  async resize(request: ResizeRequest): Promise<ResizeResult> {
    const task = await this.deps.refresh(request.taskId);
    // Registered before anything awaits: two moves, or a move and a follow-up, can't both pass.
    const refused = this.blocker(task, { type: request.type, by: request.by, userApproved: request.userApproved, threadId: request.notifyThreadId });
    if (refused !== null) throw refused;
    const sandboxId = task.sandboxId!;
    const job: Job = {
      sandboxId,
      taskId: task.id,
      from: null,
      to: request.type,
      step: "stopping",
      withMessage: Boolean(request.message?.trim()),
      moved: [],
      previews: this.livePreviews(sandboxId),
      callerWaiting: true,
      release: this.deps.claim(sandboxId),
      done: null,
    };
    this.jobs.set(sandboxId, job);
    try {
      const checked = await this.asyncBlocker(task, request.type);
      if (checked.blocker !== null) throw checked.blocker;
      job.from = checked.current;
    } catch (error) {
      this.jobs.delete(sandboxId);
      job.release();
      throw error;
    }
    this.failures.delete(task.id);
    const done = this.run(job, request);
    job.done = done;
    const outcome = await Promise.race([done, delay(request.waitMs).then(() => null)]);
    if (outcome === null) {
      job.callerWaiting = false;
      return { task: this.deps.store.get(task.id) ?? task, pending: true, from: job.from, to: job.to, moved: job.moved, sent: false };
    }
    if (!outcome.ok) throw outcome.error;
    return { task: this.deps.store.get(task.id) ?? task, pending: false, from: job.from, to: job.to, moved: job.moved, sent: outcome.sent };
  }

  private setStep(job: Job, step: Step): void {
    job.step = step;
    this.deps.hooks.changed(job.moved);
  }

  private async until(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const signal = this.deps.hooks.lifecycle;
    for (;;) {
      if (await check().catch(() => false)) return true;
      if (Date.now() >= deadline || signal.aborted) return false;
      await delay(this.timing.pollMs, signal);
    }
  }

  private async run(job: Job, request: ResizeRequest): Promise<Outcome> {
    const { sandboxId, to } = job;
    const { boat, store, hooks } = this.deps;
    const chat = hooks.chat;
    const signal = hooks.lifecycle;
    const affected = store.liveSandboxTasks(sandboxId);
    job.moved = affected.map((task) => task.id);
    const from = job.from === null ? "its current size" : LABEL(job.from);
    for (const task of affected) {
      this.record(task.id, { type: "resize", sandboxId, from: job.from, to, state: "started", error: null, byTask: job.taskId, at: Date.now() / 1000 });
      this.say(task.id, SIZE_KIND, `Moving the sandbox from ${from} to ${LABEL(to)}${task.id === job.taskId ? "" : ` for task ${job.taskId}`}`);
    }
    this.pendingTypes.set(sandboxId, to);
    this.resumeErrors.delete(sandboxId);
    const hostId = chat === undefined ? null : store.hostForSandbox(sandboxId);
    this.setStep(job, "stopping");
    try {
      // 1. Stop it (a task chat's machine through bb, so bb's view stays right).
      let stopError: string | null = null;
      try {
        if (chat !== undefined && hostId !== null) {
          const state = await chat.machineState(hostId).catch(() => null);
          if (state?.phase !== "suspended" && state?.phase !== "suspending") await chat.suspendMachine(hostId);
          this.deps.markSuspended(hostId);
        } else {
          const info = await boat.findInfo(sandboxId, signal);
          if (info !== null && ACTIVE_STATES.has(info.state)) await boat.stop(sandboxId, signal);
        }
      } catch (error) {
        stopError = message(error);
      }
      const stopped =
        stopError === null &&
        (await this.until(async () => {
          const info = await boat.findInfo(sandboxId, signal);
          if (info === null || (info.state !== "stopped" && info.state !== "archived")) return false;
          if (chat === undefined || hostId === null) return true;
          const state = await chat.machineState(hostId);
          return state === null || state.phase === "suspended";
        }, this.timing.stopMs));
      if (!stopped) {
        this.pendingTypes.delete(sandboxId);
        // Something may have started it meanwhile (a message to the task chat): say what it is now.
        const now = await this.measure(sandboxId);
        if (now?.type === to) return await this.finish(job, request, now);
        if (chat !== undefined && hostId !== null && (await chat.machineState(hostId).catch(() => null))?.phase === "suspended") {
          await chat.resumeMachine(hostId).catch(() => undefined);
          this.deps.markResumed(hostId);
        }
        const why = stopError ?? "it didn't stop within 4 minutes";
        return this.fail(job, request, `Couldn't move the sandbox to ${LABEL(to)}: ${trimDot(why)}. ${now?.type ? `It's still ${LABEL(now.type)}.` : "Its size didn't change."}`);
      }

      // 2. Start it on the new size: ensureRunning resumes onto the pending type.
      this.setStep(job, "starting");
      let startError: string | null = null;
      if (chat !== undefined && hostId !== null) {
        // bb runs the machine provider's resume, which calls bringUp.
        try {
          await chat.resumeMachine(hostId);
        } catch (error) {
          startError = this.resumeErrors.get(sandboxId) ?? message(error);
        }
        if (startError === null) {
          const up = await this.until(async () => {
            if (this.resumeErrors.has(sandboxId)) return true;
            const info = await boat.findInfo(sandboxId, signal);
            if (info !== null && ACTIVE_STATES.has(info.state)) return true;
            const state = await chat.machineState(hostId);
            if (state?.phase === "suspended" && state.message) {
              startError = state.message;
              return true;
            }
            return false;
          }, this.timing.startMs);
          startError = this.resumeErrors.get(sandboxId) ?? startError ?? (up ? null : "it didn't start within 5 minutes");
        }
      } else {
        try {
          await this.deps.bringUp(sandboxId, signal);
        } catch (error) {
          startError = this.resumeErrors.get(sandboxId) ?? message(error);
        }
      }
      this.pendingTypes.delete(sandboxId);
      this.resumeErrors.delete(sandboxId);
      if (startError !== null) return await this.rollback(job, request, hostId, startError);

      // 3. bb's daemon on the machine connects back.
      if (chat !== undefined && hostId !== null) {
        this.setStep(job, "reconnecting");
        const back = await this.until(async () => {
          const state = await chat.machineState(hostId);
          return state !== null && state.connected && state.phase === "active";
        }, this.timing.reconnectMs);
        this.deps.markResumed(hostId);
        if (!back) {
          const now = await this.measure(sandboxId);
          this.recordSize(job.moved, sandboxId, now ?? { type: to, cpus: null, memTotalKb: null }, "resize", null);
          return this.fail(
            job,
            request,
            `The sandbox is ${LABEL(now?.type ?? to)} now, but bb didn't reconnect to it within 5 minutes. ${job.withMessage ? "Your message wasn't sent: open the task chat, or send it again." : "Open the task chat to check on it."}`,
          );
        }
      }

      // 4. Check what boat started.
      const now = await this.measure(sandboxId);
      if (now?.type && now.type !== to) {
        this.recordSize(job.moved, sandboxId, now, "resize", null);
        return this.fail(job, request, `boat started the sandbox again, but it's still ${LABEL(now.type)}.${job.withMessage ? " Your message wasn't sent." : ""}`);
      }
      return await this.finish(job, request, now);
    } finally {
      this.pendingTypes.delete(sandboxId);
      this.resumeErrors.delete(sandboxId);
      job.release();
      this.jobs.delete(sandboxId);
      hooks.changed(job.moved);
      void this.deps.deliverPending().catch(() => undefined);
    }
  }

  /** The sandbox's size by asking it (null: no answer). */
  private async measure(sandboxId: string): Promise<KnownSize | null> {
    const read = await this.probe(sandboxId, {});
    return this.sizeFromProbe(read?.probe ?? null);
  }

  /** The move is done: record it on every task, tell the other orchestrators, then send the follow-up. */
  private async finish(job: Job, request: ResizeRequest, measured: KnownSize | null): Promise<Outcome> {
    const { store } = this.deps;
    const size: KnownSize = measured?.type ? measured : { type: job.to, cpus: measured?.cpus ?? null, memTotalKb: measured?.memTotalKb ?? null };
    this.recordSize(job.moved, job.sandboxId, size, "resize", null);
    const previews = job.previews > 0 ? ` ${job.previews === 1 ? "Its preview stopped; Wake starts it again." : "Its previews stopped; Wake starts them again."}` : "";
    const line = `The sandbox is now ${sizeSummary({ type: job.to, cpus: null, memTotalKb: null })}${job.from ? `; it was ${LABEL(job.from)}` : ""}.${previews}`;
    for (const id of job.moved) {
      this.record(id, { type: "resize", sandboxId: job.sandboxId, from: job.from, to: job.to, state: "done", error: null, byTask: job.taskId, at: Date.now() / 1000 });
      this.say(id, SIZE_KIND, line);
      // The idle timer starts again: a sandbox just moved isn't stopped as idle at once.
      store.update(id, {});
    }
    store.resetPreviewHealthForSandbox(job.sandboxId);
    await this.tellOthers(job, request);
    if (job.withMessage) {
      this.setStep(job, "sending");
      try {
        await this.deps.followup(job.taskId, request.message!.trim(), request.followup ?? {});
      } catch (error) {
        return this.fail(job, request, `The sandbox is ${LABEL(job.to)} now, but the follow-up couldn't be sent: ${trimDot(message(error))}. Send it again.`, { moved: true });
      }
      return { ok: true, sent: true };
    }
    if (!job.callerWaiting) await this.tell(job, `[boat] Task ${job.taskId}'s sandbox is now ${sizeSummary(size)}. You can send it a follow-up.`);
    return { ok: true, sent: false };
  }

  /** The other chats with tasks on the sandbox learn it moved (whoever asked knows). */
  private async tellOthers(job: Job, request: ResizeRequest): Promise<void> {
    const tell = this.deps.hooks.tell;
    if (tell === undefined) return;
    const asker = this.deps.store.get(job.taskId);
    const threads = new Map<string, string[]>();
    for (const id of job.moved) {
      const task = this.deps.store.get(id);
      const threadId = task?.orchestratorThreadId ?? null;
      if (threadId === null || threadId === request.notifyThreadId) continue;
      // The asking orchestrator learns from its tool call; the user's click is news to it.
      if (request.by !== "page" && threadId === asker?.orchestratorThreadId && id === job.taskId) continue;
      threads.set(threadId, [...(threads.get(threadId) ?? []), id]);
    }
    const cost = costSentence(job.to);
    for (const [threadId, ids] of threads) {
      const who = request.by === "page" ? "The user moved it" : `Task ${job.taskId}'s follow-up moved it`;
      const mine = ids.includes(job.taskId) && job.withMessage ? " The follow-up goes out now; you get a [boat] message when that turn finishes." : " You can follow up now.";
      const text = `[boat] Sandbox ${job.sandboxId} is now ${LABEL(job.to)} (${specText(job.to)})${job.from ? `; it was ${LABEL(job.from)}` : ""}. ${who} from ${request.by === "page" ? "the task page" : "a follow-up"}. Your tasks on it: ${ids.join(", ")}. Processes that were running there stopped (Wake restarts previews).${mine}${cost ? ` ${cost} Mention it in your next update.` : ""}`;
      await tell(threadId, text).catch((error) => this.deps.hooks.log.warn(`tell ${threadId}: ${message(error)}`));
    }
  }

  private async tell(job: Job, text: string): Promise<void> {
    const tell = this.deps.hooks.tell;
    // Read at tell time: the task may have moved to a successor orchestrator.
    const threadId = this.deps.store.get(job.taskId)?.orchestratorThreadId ?? null;
    const targets = [...new Set([threadId].filter((id): id is string => id !== null))];
    for (const target of targets) await tell?.(target, text).catch((error) => this.deps.hooks.log.warn(`tell ${target}: ${message(error)}`));
  }

  private async rollback(job: Job, request: ResizeRequest, hostId: string | null, reason: string): Promise<Outcome> {
    const chat = this.deps.hooks.chat;
    let back = false;
    try {
      if (chat !== undefined && hostId !== null) {
        await chat.resumeMachine(hostId);
        back = await this.until(async () => {
          const state = await chat.machineState(hostId);
          return state !== null && state.connected && state.phase === "active";
        }, this.timing.reconnectMs);
        this.deps.markResumed(hostId);
      } else {
        await this.deps.bringUp(job.sandboxId, this.deps.hooks.lifecycle);
        back = true;
      }
    } catch (error) {
      this.deps.hooks.log.warn(`resize rollback ${job.sandboxId}: ${message(error)}`);
    }
    const old = job.from === null ? "its old size" : LABEL(job.from);
    return this.fail(
      job,
      request,
      back
        ? `Couldn't move the sandbox to ${LABEL(job.to)}: ${trimDot(reason)}. It's back on ${old}.`
        : `Couldn't move the sandbox to ${LABEL(job.to)}: ${trimDot(reason)}. It's stopped; the next follow-up starts it again.`,
    );
  }

  private async fail(job: Job, request: ResizeRequest, text: string, options: { moved?: boolean } = {}): Promise<Outcome> {
    for (const id of job.moved) {
      this.record(id, { type: "resize", sandboxId: job.sandboxId, from: job.from, to: job.to, state: "failed", error: text.slice(0, 500), byTask: job.taskId, at: Date.now() / 1000 });
      this.say(id, SIZE_KIND, text);
    }
    const task = this.deps.store.get(job.taskId);
    this.failures.set(job.taskId, { from: job.from, to: job.to, error: text, turns: task?.turns ?? 0 });
    const unsent = job.withMessage && !text.includes("wasn't sent") ? " The follow-up wasn't sent." : "";
    if (!job.callerWaiting) {
      await this.tell(job, `[boat] Task ${job.taskId}: ${text}${unsent}${options.moved ? "" : " Send it again, with or without sandbox_size."}`);
    }
    return { ok: false, error: new TaskError(`${text}${unsent}`, "resize_failed") };
  }

  // ---------------------------------------------------------------- views

  /** The Default sandbox size setting (cached for views). */
  private async settingNow(): Promise<MachineType> {
    const settings = await within(this.deps.settings(), 1_000).catch(() => null);
    if (settings) this.settingType = settings.machineType;
    return this.settingType;
  }

  /** The task page's memory facts; null when they can't be read (the page still loads). */
  async view(task: Task): Promise<TaskMemoryDto | null> {
    try {
      const setting = await this.settingNow();
      const plan = this.planNow();
      const size = this.knownSize(task);
      const running = task.status === "running" || task.status === "starting";
      const oom = this.latest(task.id, "oom");
      const split = splitOomError(task.error);
      const oomView =
        oom !== null && oom.data.certain && oom.data.turn === task.turns && !running
          ? { message: oom.data.message, original: oom.data.cause ? (split?.original ?? null) : null, at: oom.at, cause: oom.data.cause }
          : null;
      const peak = this.latest(task.id, "peak");
      const peakView =
        peak === null || running
          ? null
          : {
              usedGb: gb(peak.data.peakKb),
              totalGb: peak.data.machineType ? SIZE_SPECS[peak.data.machineType].memoryGb : Math.round(peak.data.memTotalKb / 1_048_576),
              percent: Math.round((100 * peak.data.peakKb) / peak.data.memTotalKb),
              swapGb: peak.data.swapKb !== null && peak.data.swapKb >= 104_858 ? gb(peak.data.swapKb) : null,
              shared: peak.data.shared,
              at: peak.at,
            };
      const recommendation =
        peak === null || running || peak.data.recommended === null || peak.data.reason === null
          ? null
          : {
              type: peak.data.recommended,
              label: LABEL(peak.data.recommended),
              current: peak.data.machineType,
              reason: peak.data.reason,
              ...(() => {
                // The plan as it is now (the user may have upgraded since).
                const verdict = plan === null ? { allowed: peak.data.allowed, reason: peak.data.planReason } : planVerdict(peak.data.recommended!, plan);
                return { allowed: verdict.allowed, planReason: verdict.reason };
              })(),
            };
      const next = size?.type ? nextSize(size.type) : null;
      const project = governingProject<SizedProject>(this.deps.hooks.projects?.() ?? [], task.boatProject, task.repo);
      return {
        size: size === null ? null : { type: size.type, label: size.type ? LABEL(size.type) : "Unknown size", summary: (size.type ? specText(size.type) : sizeSummary(size)) ?? "" },
        oom: oomView,
        peak: peakView,
        recommendation,
        next: next === null ? null : { type: next, label: LABEL(next), detail: sizeDetail(next), ...(({ allowed, reason }) => ({ available: allowed, reason }))(planVerdict(next, plan)) },
        project: project === null ? null : { id: project.id, name: project.name, machineType: project.machineType, effective: project.machineType ?? setting },
        resize: this.resizeView(task),
        canResize:
          (task.status === "idle" || task.status === "failed") &&
          task.sandboxId !== null &&
          (task.runner === "chat" ? task.threadId !== null : task.conversationId !== null) &&
          this.deps.store.pluginOwnsSandbox(task.sandboxId) &&
          !this.jobs.has(task.sandboxId),
      };
    } catch (error) {
      this.deps.hooks.log.warn(`memory view ${task.id}: ${message(error)}`);
      return null;
    }
  }

  private resizeView(task: Task): TaskMemoryDto["resize"] {
    const job = task.sandboxId === null ? undefined : this.jobs.get(task.sandboxId);
    if (job !== undefined) {
      return { state: "running", from: job.from, to: job.to, toSummary: `${LABEL(job.to)} (${specText(job.to)})`, step: job.step, error: null, withMessage: job.withMessage && job.taskId === task.id };
    }
    const failure = this.failures.get(task.id);
    if (failure !== undefined && failure.turns === task.turns) {
      return { state: "failed", from: failure.from, to: failure.to, toSummary: `${LABEL(failure.to)} (${specText(failure.to)})`, step: null, error: failure.error, withMessage: false };
    }
    // A move the plugin lost (it restarted mid-move): it isn't running, whatever the record says.
    const last = this.sinceLastTurn(task.id, "resize");
    if (last !== null && last.state === "started") {
      return {
        state: "failed",
        from: last.from,
        to: last.to,
        toSummary: `${LABEL(last.to)} (${specText(last.to)})`,
        step: null,
        error: `The move to ${LABEL(last.to)} didn't finish (the plugin restarted). Check the sandbox size, then send a follow-up.`,
        withMessage: false,
      };
    }
    return null;
  }

  /** Lines for `bb boat task show` and boat_task (tool: the hint names boat_followup). */
  lines(task: Task, style: "cli" | "tool" = "cli"): string[] {
    const lines: string[] = [];
    const size = this.knownSize(task);
    const summary = sizeSummary(size);
    if (summary !== null) lines.push(`Sandbox size: ${summary}`);
    const oom = this.latest(task.id, "oom");
    if (oom !== null && oom.data.turn === task.turns && task.status !== "running") {
      if (oom.data.certain) {
        const who = oom.data.kills.map((kill) => kill.label);
        lines.push(`Out of memory in the last turn: the system stopped ${who.length === 0 ? "a process" : who.join(" and ")}. ${this.continueHint(task, oom.data, style)}`);
      } else {
        lines.push(oom.data.message);
      }
    }
    const peak = this.latest(task.id, "peak");
    if (peak !== null && task.status !== "running") {
      const recommendation = peak.data.recommended && peak.data.reason ? { type: peak.data.recommended, reason: peak.data.reason, allowed: peak.data.allowed, planReason: peak.data.planReason } : null;
      lines.push(peakLine({ peakKb: peak.data.peakKb, memTotalKb: peak.data.memTotalKb, machineType: peak.data.machineType, swapKb: peak.data.swapKb }, recommendation).replace(" during this turn", ""));
    }
    const resize = this.resizeView(task);
    if (resize?.state === "running") lines.push(`Moving the sandbox to ${resize.toSummary} (${resize.step ?? "starting"})…`);
    else if (resize?.state === "failed" && resize.error) lines.push(resize.error);
    return lines;
  }

  /** "Continue on a larger sandbox: …" for the CLI and agents. */
  private continueHint(task: Task, oom: DataOf<"oom">, style: "cli" | "tool"): string {
    const current = oom.machineType;
    if (current === "xlarge") return "XLarge is the largest size: run fewer tests at once.";
    if (oom.next === null) return "Run fewer tests at once.";
    if (!oom.nextAllowed) return `Your boat plan doesn't include ${LABEL(oom.next)}${oom.nextReason ? ` (${trimDot(oom.nextReason)})` : ""}: run fewer tests at once.`;
    const approve = oom.next === "xlarge" ? " --user-approved (after the user's OK)" : "";
    return style === "cli"
      ? `Continue on a larger sandbox: bb boat task followup ${task.id} --type ${oom.next}${approve} --message "…"`
      : `Continue on a larger sandbox: boat_followup with sandbox_size "${oom.next}"${oom.next === "xlarge" ? " and user_approved" : ""}.`;
  }
}

/** What a move did, for the CLI and agent tools. */
export function resizeText(result: ResizeResult, style: "cli" | "tool", agent: string): string {
  const to = `${LABEL(result.to)} (${specText(result.to)})`;
  const others = result.moved.filter((id) => id !== result.task.id);
  const also = others.length > 0 ? ` Also moved: ${others.join(", ")}.` : "";
  const cost = costSentence(result.to);
  const costNote = cost ? ` ${cost}${style === "tool" ? " Mention it in your next update." : ""}` : "";
  if (result.pending) {
    const from = result.from ? `from ${LABEL(result.from)} ` : "";
    const when = result.sent
      ? ""
      : style === "tool"
        ? " The follow-up goes out when it's up; you will get a [boat] message when that turn finishes, or if the move fails. Don't send another follow-up meanwhile."
        : " The follow-up goes out when it's up; you will be notified when that turn finishes, or if the move fails.";
    return `Task ${result.task.id}'s sandbox is moving ${from}to ${to} (a few minutes).${when}${costNote}`;
  }
  if (result.sent) {
    return `Moved task ${result.task.id}'s sandbox to ${to} and sent the follow-up (${agent}). You will be ${style === "tool" ? "messaged" : "notified"} when the turn finishes.${also}${costNote}`;
  }
  return `Moved task ${result.task.id}'s sandbox to ${to}.${also}${costNote}`;
}
