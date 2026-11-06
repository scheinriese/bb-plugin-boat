// The plugin's core: sandboxes, tasks, dispatch, and the completion sweep.
// CLI commands, agent tools, RPC (UI) and the background monitor are thin
// layers over this class.
import { BUILTIN_CONFIG_NAMES, evidenceInstallScript, evidenceLinks, installSummary, parseEvidenceSource, parseInstallResult, type EvidenceSource } from "./evidence.ts";
import { randomUUID } from "node:crypto";
import {
  ACTIVE_STATES,
  BoatApi,
  assertBranch,
  finalResponse,
  normalizeRepo,
  promptStatus,
  type CheckoutMode,
  type Limits,
  type MachineType,
  type PreparedRepo,
  type Sandbox,
  type ShipConflict,
  type ShipResult,
  type EnvironmentInfo,
  busyProcesses,
  programName,
  shellQuote,
} from "./boat-api.ts";
import { checkPreview, previewLink, previewView, type PreviewView } from "./previews.ts";
import { KEEP_LIMIT_MS, describeWork, hasWork } from "./activity.ts";
import { BOAT_GIT_ENV, aiProxyPrice, autoStopHours, withinAutoStopCap, type AiProxyState } from "./boat-api.ts";
import { BoatError } from "./boat.ts";
import { alwaysProtectedBranches, protectedBranches, type OrchestratorProject, type ProjectRepo } from "./projects.ts";
import {
  composeEvidencePrompt,
  composeFollowupPrompt,
  composeHandoverPrompt,
  deepMode,
  composeInitialPrompt,
  extractPrUrl,
  parsePreview,
  parseReport,
} from "./briefs.ts";
import {
  OPEN_STATUSES,
  TaskStore,
  newTaskId,
  type Preview,
  type PreviewHealth,
  type Provider,
  type Runner,
  type SinceApproval,
  type Task,
  type TaskRole,
  type TaskStatus,
} from "./store.ts";
import { changedSinceApproval, parseSinceApproval, sinceApprovalScript } from "./ship-approval.ts";
import {
  bbModelId,
  boatEffort,
  boatModelId,
  chatChoiceFromBoat,
  choiceFor,
  defaultTierFor,
  effortAgent,
  isTier,
  modelAgent,
  needsFrontierApproval,
  tierSummary,
  type Tier,
  type TierMap,
} from "./tiers.ts";
import type { ChatRunner, ChatWhere, ComposerRequest } from "./chat.ts";
import type { WorkspaceInfo } from "./briefs.ts";
import type { QuotaReader } from "./quota.ts";
import { AGENT_NAME, agentWithRoom, effectiveRelay, onlyAgent, otherAgent, type AgentChoice, type RelaySettings } from "./relay.ts";
import type { ConnectCheck } from "./connect.ts";
import { renderBoatTranscript, transcriptDir, transcriptPath } from "./transcript.ts";
import type { PreflightInput } from "./setup.ts";
import type { PlanSize, SizedProject } from "./memory.ts";
import { SandboxSizes } from "./sandbox-size.ts";

export interface BoatSettings {
  boatPath: string;
  environment: string;
  machineType: MachineType;
  /** Size of boat sandboxes that run bb chats (cloud orchestrators). */
  orchestratorMachineType: MachineType;
  implementProvider: Provider;
  implementModel: string;
  reviewProvider: Provider;
  reviewModel: string;
  reasoningEffort: string;
  sandboxTtlHours: number;
  maxActiveSandboxes: number;
  stopIdleAfterMinutes: number;
  freeSlotsWhenFull: boolean;
  deleteSandboxOnClose: boolean;
  reviewSandbox: "auto" | "new" | "same";
  workerInstructions: string;
  /** Continue a turn with the other agent when one hits a usage limit. */
  autoFailover: boolean;
  /** Model and effort per tier and agent (Settings → Orchestrator protocol). */
  modelTiers: TierMap;
  /** From How tasks run (workers): chat when tasks may run as bb chats (each project decides); boat: always headless in boat. */
  workerMode: Runner;
  /** From How tasks run: tasks on repos outside your projects (unknown trust); chat only with "As chats everywhere". */
  adhocWorkerMode: Runner;
  /** Where new orchestrators go in the sidebar: their project's section, Pinned, or nowhere special. */
  sidebarLayout: "sections" | "pinned" | "plain";
  /** Handing orchestrators (and new workers) between Claude and Codex by usage. */
  relay: RelaySettings;
  /** With both agents near their limits, wait instead of using paid extra usage. */
  avoidExtraUsage: boolean;
  /** Where the evidence uploader comes from ("builtin" or "owner/repo:path[@ref]"); empty: off. */
  evidenceUploader: string;
  /** Which agents the plugin uses (both, or only claude or codex): the Coding agents setting, or what boat.dev reports for Auto-detect. With one, everything runs on it. */
  agents: AgentChoice;
  /** The Coding agents setting itself (auto: follow boat.dev). */
  agentsSetting: "auto" | AgentChoice;
  /**
   * Agents boat.dev last reported as not connected while it can't be read now
   * (Auto-detect only). Nothing switches to one on its own.
   */
  notConnectedAgents: Provider[];
  /** Orchestrators that run in a boat sandbox start in Full Access, like task chats. */
  cloudOrchestratorFullAccess: boolean;
  /** Branches protected in every sandbox on top of main and master (the "Extra protected branches" setting). */
  extraProtectedBranches: string[];
  /** Orchestrators ask the user before running more tasks than this at once (0: never ask). */
  tasksBeforeAsking: number;
}

/** A notice that can't go out yet (its orchestrator is being handed over): tried again later. */
export class DeliveryDeferred extends Error {
  constructor(threadId: string) {
    super(`notices for ${threadId} wait for its successor`);
  }
}

export interface ProjectAccess {
  /** The boat environment its workers use (null: boat's default). */
  environment: string | null;
  /** Reading the environment failed. */
  error: string | null;
  /** Names of the environment's variables; values are never read into the plugin's results. */
  secretNames: string[];
  secretFiles: string[];
  passGithub: boolean | null;
  passSecrets: boolean | null;
  passAgentsCredentials: boolean | null;
  /** boat credentials (the boat CLI's login, for the whole account): workers could start, stop and delete any sandbox. */
  passSandboxCredentials: boolean | null;
  proxyAiCredentials: boolean | null;
  /** Sandboxes get placeholder AI keys (the account's `boat ai proxy`, or the environment's proxy toggle); null: couldn't tell. */
  aiProxy: boolean | null;
  /** What the proxy costs, a paid boat add-on ("about $1 a day plus $1 per 1,000 requests"); null: boat didn't say. */
  aiProxyPrice: string | null;
  repos: {
    repo: string;
    baseBranch: string;
    /** boat's GitHub permission as the environment lists it (write, read), or null when it isn't listed. */
    environmentPermission: string | null;
    /** The last check inside a sandbox: write, read, none or expired. */
    lastCheck: { access: string; detail: string | null; checkedAt: string } | null;
  }[];
}

export interface Notification {
  threadId: string;
  tasks: Task[];
}

export interface ServiceHooks {
  settings(): Promise<BoatSettings>;
  /** Aborted when the plugin unloads; background work stops with it. */
  lifecycle: AbortSignal;
  /** Called after every task change so UIs refresh. */
  changed(taskIds: string[]): void;
  /** Deliver finished-turn notices to the threads that dispatched the tasks. */
  notify(notification: Notification): Promise<void>;
  log: { info(message: string): void; warn(message: string): void };
  /** Runs workers as bb chats; without it every task is a boat conversation. */
  chat?: ChatRunner;
  /** How the project that has this repo runs its workers (null: not in any project). */
  repoWorkerMode?(repo: string): Runner | null;
  /**
   * How work on this repo and base lands, from the current project settings:
   * push if any project ships it after approval (null: no project has it).
   */
  repoDelivery?(repo: string, baseBranch: string): "pr" | "push" | null;
  /** The branches your projects protect for this repo: their base branches and their own protected ones (any project). */
  repoBaseBranches?(repo: string): string[];
  /**
   * A project's instructions for its tasks' briefs: the project with this id,
   * else every project that has the repo (none: empty).
   */
  projectInstructions?(projectId: string | null, repo: string | null): string[];
  /** Each agent's subscription usage (the relay's signal); absent: unknown. */
  quotas?: QuotaReader;
  /** The evidence uploader's source (the bundled one, or fetched from GitHub on this machine). */
  evidence?: EvidenceSource;
  /** Does a preview link answer? (Tests replace the HTTP check.) */
  checkPreview?(link: string): Promise<PreviewHealth>;
  /** bb Connect's status: worker chats need it (absent: not checked). */
  connect?: ConnectCheck;
  /**
   * The setup checks before work starts (signed in, a plan, the agent's
   * login): throws a setup_required TaskError with the fix. Absent: not checked.
   */
  preflight?(input: PreflightInput): Promise<void>;
  /** Stored projects (a project's sandbox size); absent: none. */
  projects?(): SizedProject[];
  /** The plan's sandbox sizes from `boat limits` (fresh: read boat now); null: unknown, boat decides. */
  sizePlan?(options?: { fresh?: boolean }): Promise<PlanSize[] | null>;
  /** The same from the newest reading, never waiting (null: none yet). */
  sizePlanNow?(): PlanSize[] | null;
  /** Post a plain message into a chat (a move that ended after its caller stopped waiting). */
  tell?(threadId: string, text: string): Promise<void>;
  /**
   * The note a task's worker gets once with its next prompt after a stop
   * cut off its background work (the watchdog's); absent: none.
   */
  resumeNote?: { peek(taskId: string): Promise<string | null>; sent(taskId: string): Promise<void> };
  /**
   * The plugin suspended a worker machine itself (the idle stop, making
   * room, a stop someone asked for). underWork: background work still ran
   * (the idle stop at its limit). The watchdog tells a planned stop from
   * one that cut work off.
   */
  machineSuspended?(hostId: string, underWork: boolean): void;
  /** The idle stop stopped a headless sandbox whose finished agent's processes still computed (at the 12-hour limit). */
  processesStopped?(sandboxId: string, at: number): void;
  /** Tests: the memory check's cap and the move's poll interval and waits (ms). */
  sizeTiming?: { checkMs?: number; pollMs?: number; stopMs?: number; startMs?: number; reconnectMs?: number };
}

export interface StartTaskInput {
  title: string;
  role: TaskRole;
  brief: string;
  repo?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  pr?: string | null;
  provider?: Provider | null;
  model?: string | null;
  reasoningEffort?: string | null;
  /** Model tier: picks model and effort for the agent (explicit model/effort win). */
  tier?: Tier | null;
  /** One line on why this tier (logged on the task). */
  reason?: string | null;
  /** The user approved Frontier at max effort. */
  userApproved?: boolean;
  /** The agent is a default (e.g. a review's cross-model pick): use the other one if this is near its limit. */
  flexibleAgent?: boolean;
  /** "new" (default), "same" (parent task's sandbox), or a sandbox id. */
  sandbox?: string | null;
  machineType?: MachineType | null;
  parentTaskId?: string | null;
  orchestratorThreadId?: string | null;
  projectId?: string | null;
  /** The orchestrator's project: defaults repo, base branch, environment and snapshot. */
  project?: OrchestratorProject | null;
  /** boat environment for a new sandbox (default: the project's, then the setting). */
  environment?: string | null;
  /** Saved snapshot for a new sandbox (default: the project's). */
  snapshot?: string | null;
  /** "chat": a task chat; "boat": headless in boat; null: How tasks run and the repo's project decide. */
  runner?: Runner | null;
  /**
   * With runner "chat" for repos the rules don't run as chats: the repos the
   * user was warned about (New task on the Cloud agents page); [] for a task
   * with no repo. null: no warning was confirmed. A UI affordance, not a
   * security boundary: any client of the plugin's RPC can send it.
   */
  confirmUntrustedChat?: string[] | null;
  /** false: no evidence uploader in the sandbox (the test task); default: as the settings say. */
  evidence?: boolean;
  /** Measure the first turn's peak memory and recommend a size (the repo check, the test task). */
  measureMemory?: boolean;
  signal?: AbortSignal;
}

export class TaskError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(message: string, code: string, hint?: string) {
    super(message);
    this.name = "TaskError";
    this.code = code;
    this.hint = hint;
  }
}

const RESULT_LIMIT = 16_000;
/** The setup checklist's fix for bb Connect, when the connect plugin gives none. */
const CONNECT_FIX = "Turn on bb Connect: sign in with `bb account login`, then run `bb connect on`.";

/** "Your projects don't run tasks on acme/x as chats" (or How tasks run is In boat). */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function trustText(trust: ChatTrust): string {
  if (trust.workersBoat) return "How tasks run is set to In boat";
  return `Your projects don't run tasks on ${trust.untrustedRepos.join(", ")} as chats`;
}
const USAGE_LIMIT_PATTERN =
  /usage limit|rate[ -]?limit|limit reached|quota|out of credits|credit balance|too many requests|\b429\b|hit your (usage )?limit/i;
const LIMIT_NOTICE_PATTERN = /usage limit reached|hit your (usage )?limit|limit will reset|out of (extra )?usage|out of credits/i;
const STALE_STARTING_MS = 20 * 60_000;

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "task"
  );
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Snapshot failures in plain words: a missing name, or a plan without saved
 * snapshots (the trial). null: not a snapshot problem.
 */
export function snapshotError(error: unknown, name: string | null): TaskError | null {
  if (!(error instanceof BoatError)) return null;
  const text = `${error.code ?? ""} ${error.message}`;
  if (error.code === "snapshot_not_found" || (name !== null && /snapshot/i.test(text) && /not found|no saved snapshot/i.test(text))) {
    return new TaskError(
      `There's no saved snapshot "${name ?? "?"}".`,
      "snapshot_not_found",
      "`bb boat sandbox snapshots` lists yours. Fix the project's snapshot in Settings → Plugins → Boat Cloud Agents → Projects, or pass another one.",
    );
  }
  if (/snapshot/i.test(text) && (/trial|plan|upgrade|not available|not allowed|requires|payment/i.test(text) || error.status === 402 || error.status === 403)) {
    return new TaskError(
      "Saved snapshots need a paid boat plan; the trial doesn't have them.",
      "snapshots_unavailable",
      "Upgrade with `boat billing plan`, or start without a snapshot (clear it in the project settings).",
    );
  }
  return null;
}

/**
 * Whether a task surely gets a new sandbox (see pickSandbox): not for a
 * named or "same" sandbox, nor for a review that reuses (or may reuse) its
 * task's sandbox.
 */
export function surelyNewSandbox(input: Pick<StartTaskInput, "sandbox" | "role">, parent: Pick<Task, "sandboxId"> | null, settings: Pick<BoatSettings, "reviewSandbox">): boolean {
  const choice = (input.sandbox ?? "").trim();
  if (choice === "new") return true;
  if (choice !== "" && choice !== "auto") return false;
  if (input.role === "review" && parent?.sandboxId) {
    const mode = choice === "auto" ? "auto" : settings.reviewSandbox;
    if (mode === "same" || mode === "auto") return false;
  }
  return true;
}

/** Whether the rules alone may run these repos as a task chat, and the repos they don't. */
export interface ChatTrust {
  trusted: boolean;
  /** Repos no rule runs as task chats (all of them when How tasks run is In boat). */
  untrustedRepos: string[];
  /** How tasks run is In boat: no task becomes a chat on its own. */
  workersBoat: boolean;
}

/**
 * A task chat's sandbox can reach this bb, so the rules allow one only when
 * How tasks run allows chats and every repo the task clones is in a project
 * with Run tasks as chats on (or, outside projects, How tasks run is As chats
 * everywhere). A task with no repo needs only the first. The same rule picks
 * the runner (no --chat), allows --chat without the user's confirm, and sets
 * New task's default, so they never disagree. repoMode: how the projects run
 * a repo's tasks (null: none has it).
 */
export function chatTrust(
  repos: readonly string[],
  settings: Pick<BoatSettings, "workerMode" | "adhocWorkerMode">,
  repoMode: (repo: string) => Runner | null,
): ChatTrust {
  if (settings.workerMode !== "chat") return { trusted: false, untrustedRepos: [...repos], workersBoat: true };
  const untrustedRepos = repos.filter((repo) => (repoMode(repo) ?? settings.adhocWorkerMode) !== "chat");
  return { trusted: untrustedRepos.length === 0, untrustedRepos, workersBoat: false };
}

/** A sandbox named by id (not "", new, same or auto), or null. */
export function namedSandbox(choice: string | null | undefined): string | null {
  const named = (choice ?? "").trim();
  return named === "" || named === "new" || named === "same" || named === "auto" ? null : named;
}

/** The user's confirm (the repos they were warned about) covers every repo the rules don't trust. */
export function confirmCovers(confirmed: readonly string[] | null | undefined, trust: ChatTrust): boolean {
  if (trust.trusted) return true;
  if (confirmed === null || confirmed === undefined) return false;
  const seen = new Set(confirmed.map((repo) => repo.trim().toLowerCase()));
  return trust.untrustedRepos.every((repo) => seen.has(repo.toLowerCase()));
}

/** Where a review runs: push work only in the implementer's sandbox (its commits exist nowhere else). */
export function reviewSandboxFor(parent: Task, requested: string | null): string | null {
  if (parent.delivery !== "push") return requested;
  if (requested === null || requested === "" || requested === "auto" || requested === "new" || requested === "same") return "same";
  if (requested === parent.sandboxId) return requested;
  throw new TaskError(
    `Task ${parent.id}'s commits exist only in its own sandbox (${parent.sandboxId ?? "none"}), so the review runs there.`,
    "invalid_value",
    "Request the review without a sandbox, or with that task's.",
  );
}

/** The shell that (re)starts a preview server; see startPreviewServer. */
export function previewStartScript(repoPath: string, port: number, command: string): string {
  return [
    `cd ${shellQuote(repoPath)} || exit 1`,
    `for pid in $(ss -ltnpH "sport = :${port}" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do kill "$pid" 2>/dev/null; done`,
    "sleep 1",
    "export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.on.boat.dev",
    `{ ${command}`,
    `} > /tmp/preview-${port}.log 2>&1`,
  ].join("\n");
}

/** A long final message keeps its start and its report block (cut in the middle). */
export function clipResult(text: string, max = RESULT_LIMIT): string {
  if (text.length <= max) return text;
  const start = Math.max(text.lastIndexOf("=== REPORT ==="), text.lastIndexOf("=== REVIEW ==="));
  if (start === -1) return clip(text, max);
  // The block, plus the fence line before it in a chat.
  const blockStart = text.lastIndexOf("\n", Math.max(0, start - 2)) + 1;
  const tail = text.slice(blockStart);
  if (tail.length >= max - 200) return `…${text.slice(text.length - max + 1)}`;
  const marker = "\n\n…(cut)…\n\n";
  return `${text.slice(0, max - tail.length - marker.length)}${marker}${tail}`;
}

/** What a bb thread event told us about a worker chat. */
export interface ChatHint {
  kind: "idle" | "failed" | "active" | "archived";
  /** The turn's final text (thread.idle). */
  text?: string | null;
  /** bb's error message (thread.failed). */
  error?: string | null;
  /** The thread's updatedAt with the event (epoch ms). */
  at?: number | null;
}

/** A follow-up marker in promptId for chat tasks: when the turn was sent. */
function chatTurnMarker(): string {
  return `chat:${Date.now()}`;
}

function chatSentAt(task: Task): number | null {
  if (!task.promptId?.startsWith("chat:")) return null;
  const at = Number(task.promptId.slice(5));
  return Number.isFinite(at) ? at : null;
}

/** The model id the runner's agent understands. */
function agentModel(runner: Runner, provider: Provider, model: string | null): string | null {
  return runner === "chat" ? bbModelId(provider, model) : boatModelId(provider, model);
}

/** Effort levels above max exist only in bb's agents, each for one of them. */
function agentEffort(runner: Runner, provider: Provider, effort: string | null): string | null {
  if (runner === "boat") return boatEffort(effort);
  const owner = effortAgent(effort);
  if (owner !== null && owner !== provider) {
    throw new TaskError(
      `"${effort}" is a ${owner === "claude" ? "Claude Code" : "Codex"} level; ${provider === "claude" ? "Claude's is ultracode" : "Codex's is ultra"}.`,
      "invalid_effort",
      "Pick the model preset and let the plugin choose, or use the level of the agent that runs the task.",
    );
  }
  return effort;
}

/** "Build · opus-5-5 · xhigh — reason" for task history. */
function modelLine(tier: string | null, model: string | null, effort: string | null, reason: string | null): string {
  const summary = tierSummary(tier, model, effort) || "boat's default model";
  return reason ? `${summary} — ${reason}` : summary;
}

/** Frontier at max effort costs about 2.5× Deep; it needs the user's explicit OK. */
function assertFrontierAllowed(tiers: TierMap, tier: Tier | null, model: string | null, effort: string | null, approved: boolean): void {
  if (approved || !needsFrontierApproval(tiers, tier, model, effort)) return;
  throw new TaskError(
    `Frontier models at ${effort} need the user's approval (${model ?? "frontier"} · ${effort}).`,
    "frontier_needs_approval",
    "Use Frontier at xhigh (its default), or ask the user first and then pass user_approved (--user-approved). Max, Ultracode and Ultra all need the OK.",
  );
}

/** The Hard stop setting within the plan's auto-stop cap (none known when boat can't be read: boat's refusal then names it). */
function ttlSeconds(settings: BoatSettings, limits: Limits | null): number {
  return Math.round(autoStopHours(settings.sandboxTtlHours, limits?.autoStopCapHours ?? null) * 3600);
}

/**
 * The configured model for a provider, or null for boat's dashboard default.
 * Models are provider-specific: never send a Claude model id to Codex.
 */
export function defaultModelFor(provider: Provider, settings: BoatSettings): string | null {
  if (provider === settings.implementProvider && settings.implementModel.trim() !== "") return settings.implementModel.trim();
  if (provider === settings.reviewProvider && settings.reviewModel.trim() !== "") return settings.reviewModel.trim();
  return null;
}

/** States a sandbox passes through on its way up or down. */
const TRANSITIONAL_STATES = new Set(["provisioning", "starting", "stopping", "archiving", "resuming", "pending"]);
const TRANSITION_WAIT_MS = 120_000;
/** How long a turn may look finished in one endpoint but not the other. */
const SETTLE_MS = 30_000;
/** How long a `boat ps` reading of a sandbox is reused. */
const PROCESS_CHECK_MS = 5 * 60_000;

/** What `boat ps` says of a headless sandbox whose agent has finished. */
export type Computing = "busy" | "maybe" | "no";

/** A move to a chat whose task was closed or changed meanwhile. */
class MoveCancelled extends Error {
  readonly why: "closed" | "changed" | "unloaded";
  constructor(why: "closed" | "changed" | "unloaded") {
    super(
      why === "closed" ? "The task was closed during the move." : why === "unloaded" ? "bb stopped the plugin during the move." : "The task changed during the move.",
    );
    this.why = why;
    this.name = "MoveCancelled";
  }
}

/** Turn states after which a headless turn is over. */
const TERMINAL_PROMPT = new Set(["finished", "failed", "interrupted", "cancelled"]);
/** Move blockers that won't change on their own: the task's page shows no Continue as a chat for them. */
const MOVE_NEVER = new Set(["sandbox_lent", "sandbox_runs_bb", "review_shares_sandbox"]);
/** The task page's fixes where the CLI's name flags the page doesn't have. */
const PAGE_MOVE_HINTS: Record<string, string> = {
  sandbox_gone: "Start a new task instead.",
  sandbox_lent: "Start a new task with Run as a chat instead.",
  sandbox_runs_bb: "Start a new task with Run as a chat instead.",
};
/** A headless turn the sweep settled as cut off (its sandbox stopped mid-turn): boat's log never finishes it. */
const CUT_OFF_ERROR = "The turn stopped without finishing";
/** Events that start a turn (a failover continues the turn it hands over). */
const HANDOVER_TURN_STARTS = new Set(["dispatched", "followup", "followup-switch", "moved-to-chat"]);

/** Whether a headless task can continue as a task chat now (Continue as a chat on its page). */
export interface ChatMoveStatus {
  /** False: no button (a task chat already, closed, never dispatched, or no task chats on this bb). */
  offered: boolean;
  /** Why not now, with the fix. */
  blocked: { code: string; message: string; hint: string | null } | null;
  /** The rules don't run this task as a chat: the dialog warns and asks for a confirm. */
  untrusted: boolean;
  /** The repos the warning names (all of them with How tasks run In boat). */
  untrustedRepos: string[];
  /** Of those, the ones other tasks ran in this sandbox before (not this task's own). */
  otherRepos: string[];
  /** How tasks run is In boat. */
  workersBoat: boolean;
  /** bb already runs on the sandbox (no install). */
  hasMachine: boolean;
  /** The sandbox is stopped; it starts first. */
  sandboxStopped: boolean;
  /** A move is running now. */
  moving: boolean;
  /** The last try failed and nothing happened since (its history text). */
  lastFailure: string | null;
}

class DispatchCancelled extends Error {
  constructor() {
    super("The task was closed while it was being dispatched.");
    this.name = "DispatchCancelled";
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BoatService {
  private sweeping: Promise<void> | null = null;
  private delivering: Promise<void> | null = null;
  /** Serializes capacity checks with the create/resume that follows them. */
  private slotQueue: Promise<unknown> = Promise.resolve();
  /** Sandboxes some in-flight dispatch is about to use; never stopped to free a slot. */
  private readonly claims = new Map<string, number>();
  /** In-flight dispatches, so closing a "starting" task can stop them. */
  private readonly dispatches = new Map<string, AbortController>();
  /** When a turn first looked finished without a terminal status. */
  private readonly settling = new Map<string, number>();
  /** Moves to a task chat in flight (Continue as a chat): closing the task aborts one. */
  private readonly moves = new Map<string, { controller: AbortController; done: Promise<unknown>; sandboxId: string }>();
  /** Follow-ups being sent, per task: a move refuses while one runs, and the other way round. */
  private readonly sending = new Map<string, number>();

  readonly boat: BoatApi;
  readonly store: TaskStore;
  private readonly hooks: ServiceHooks;
  /** Sandbox sizes and memory (src/sandbox-size.ts). */
  readonly sizes: SandboxSizes;

  constructor(boat: BoatApi, store: TaskStore, hooks: ServiceHooks) {
    this.boat = boat;
    this.store = store;
    this.hooks = hooks;
    this.sizes = new SandboxSizes({
      boat,
      store,
      hooks,
      settings: () => this.settings(),
      claim: (sandboxId) => this.claim(sandboxId),
      // A move to a task chat holds the sandbox too (bb is being installed there).
      claimed: (sandboxId) => this.claims.has(sandboxId) || this.isMovingSandbox(sandboxId),
      bringUp: (sandboxId, signal) => this.ensureRunning(sandboxId, signal),
      markSuspended: (hostId) => this.suspendedHosts.add(hostId),
      markResumed: (hostId) => this.suspendedHosts.delete(hostId),
      followup: (id, message, options) => this.followup(id, message, options),
      refresh: (id) => this.refreshChatTask(id),
      deliverPending: () => this.deliverPending(),
    });
  }

  settings(): Promise<BoatSettings> {
    return this.hooks.settings();
  }

  private withSlotLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.slotQueue.then(fn, fn);
    this.slotQueue = run.catch(() => undefined);
    return run;
  }

  private claim(sandboxId: string): () => void {
    this.claims.set(sandboxId, (this.claims.get(sandboxId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.claims.get(sandboxId) ?? 1) - 1;
      if (left <= 0) this.claims.delete(sandboxId);
      else this.claims.set(sandboxId, left);
    };
  }

  // -------------------------------------------------------------------------
  // Capacity

  async capacity(signal?: AbortSignal, forSandbox?: string): Promise<{
    limits: Limits | null;
    active: Sandbox[];
    cap: number | null;
    free: number | null;
  }> {
    const settings = await this.settings();
    const [limits, sandboxes] = await Promise.all([
      this.boat.limits(signal).catch(() => null),
      this.boat.list({ signal }),
    ]);
    const active = sandboxes.filter((sandbox) => ACTIVE_STATES.has(sandbox.state));
    const planCap = limits?.maxActiveSandboxes ?? null;
    const userCap = settings.maxActiveSandboxes > 0 ? settings.maxActiveSandboxes : null;
    const cap =
      planCap === null ? userCap : userCap === null ? planCap : Math.min(planCap, userCap);
    // boat's own count also covers sandboxes the list can miss while they provision.
    // A sandbox stopped for a move to another size keeps its slot (sizes).
    const used = Math.max(active.length, limits?.activeSandboxes ?? 0) + this.sizes.reservedSlots(active, forSandbox);
    return { limits, active, cap, free: cap === null ? null : Math.max(0, cap - used) };
  }

  /**
   * Make room for one more sandbox. Call only inside withSlotLock. Stops the
   * least recently used plugin-created sandbox whose tasks are all waiting
   * (their conversations survive the stop and resume on follow-up).
   */
  private async ensureSlot(signal?: AbortSignal, forSandbox?: string): Promise<{ limits: Limits | null; stopped: string | null }> {
    const settings = await this.settings();
    const { limits, active, cap, free } = await this.capacity(signal, forSandbox);
    if (limits?.checkoutRequired) {
      throw new TaskError(
        "Your boat.dev account has no plan yet, so it can't start sandboxes.",
        "setup_required",
        "Start a boat plan (7-day trial, card required): run `boat billing plan 20` or open https://boat.dev/dashboard.",
      );
    }
    if (limits !== null && !limits.canStart) {
      throw new TaskError(
        `boat will not start a sandbox right now${limits.blockedReason ? `: ${limits.blockedReason}` : ""}.`,
        "boat_start_blocked",
        "Run `boat limits --all` for details, or start a bigger plan (`boat billing plan`).",
      );
    }
    if (limits?.startsLeftToday === 0 || limits?.startsLeftThisHour === 0) {
      throw new TaskError(
        "The boat start limit is used up for now.",
        "boat_start_limit",
        "Wait for the window to roll over, reuse a sandbox with --sandbox <id>, or upgrade the plan (`boat billing plan`).",
      );
    }
    if (free === null || free > 0) return { limits, stopped: null };
    if (settings.freeSlotsWhenFull) {
      const candidates = active
        .filter((sandbox) => !this.claims.has(sandbox.id) && this.store.pluginOwnsSandbox(sandbox.id))
        .map((sandbox) => {
          const tasks = this.store.liveSandboxTasks(sandbox.id);
          const busy = tasks.some((task) => task.status === "running" || task.status === "starting");
          const lastTouched = tasks.reduce((latest, task) => (task.updatedAt > latest ? task.updatedAt : latest), "");
          return { sandbox, tasks, busy, lastTouched };
        })
        // A kept worker machine (no open task) is bb's: leave it alone.
        .filter((entry) => !entry.busy && entry.sandbox.state !== "running")
        .filter((entry) => entry.tasks.some((task) => task.runner === "chat") || !this.store.isChatMachineSandbox(entry.sandbox.id))
        // Sandboxes with a live preview go last: the user may be looking at it.
        .sort(
          (a, b) =>
            Number(this.hasLivePreview(a.sandbox.id)) - Number(this.hasLivePreview(b.sandbox.id)) || a.lastTouched.localeCompare(b.lastTouched),
        );
      // Work the tasks don't show keeps a sandbox on: another chat on its machine or
      // background work there. A headless sandbox still computing goes last.
      let victim: (typeof candidates)[number] | undefined;
      let computing: (typeof candidates)[number] | undefined;
      for (const entry of candidates) {
        if (await this.machineBusy(entry.tasks)) continue;
        if (!entry.tasks.some((task) => task.runner === "chat") && (await this.processesBusy(entry.sandbox.id)) !== "no") {
          computing ??= entry;
          continue;
        }
        victim = entry;
        break;
      }
      victim ??= computing;
      if (victim !== undefined) {
        // A worker chat's machine is suspended through bb, which resumes it on the next message.
        const hostId = victim.tasks.find((task) => task.runner === "chat" && task.hostId !== null)?.hostId ?? null;
        if (hostId !== null && this.hooks.chat !== undefined) {
          await this.hooks.chat.suspendMachine(hostId);
          this.suspendedHosts.add(hostId);
          this.hooks.machineSuspended?.(hostId, false);
        } else {
          await this.boat.stop(victim.sandbox.id, signal);
        }
        for (const task of victim.tasks) {
          this.store.addEvent(task.id, "sandbox-stopped", "Sandbox stopped to make room for new work; it resumes on follow-up.");
        }
        this.hooks.changed(victim.tasks.map((task) => task.id));
        return { limits, stopped: victim.sandbox.id };
      }
    }
    const names = active.map((sandbox) => `${sandbox.id}${sandbox.name ? ` (${sandbox.name})` : ""}`).join(", ");
    throw new TaskError(
      `All ${cap} sandboxes your limit allows are in use: ${names}.`,
      "boat_at_capacity",
      "Close finished tasks (`bb boat task close <id>`), stop a sandbox (`bb boat sandbox stop <id>`), reuse one with --sandbox <id>, or raise the limit by upgrading (`boat billing plan`).",
    );
  }

  // -------------------------------------------------------------------------
  // Sandboxes

  async createSandbox(options: {
    name: string;
    type?: MachineType | null;
    /** boat environment; null/undefined uses the plugin setting (else boat's default). */
    environment?: string | null;
    /** Saved snapshot to start from (`boat new --from`). */
    snapshot?: string | null;
    /** Route git through the base-branch push guard (worker sandboxes). */
    gitGuard?: boolean;
    signal?: AbortSignal;
  }): Promise<Sandbox> {
    const settings = await this.settings();
    const environment = options.environment || settings.environment || null;
    // Signed in, with a plan that can start one: a broken setup costs no start.
    await this.hooks.preflight?.({ newSandbox: true, environment });
    if (environment !== null) await this.assertEnvironment(environment, options.signal);
    return this.withSlotLock(async () => {
      const { limits } = await this.ensureSlot(options.signal);
      const create = (ttl: number) =>
        this.boat.create({
          name: options.name,
          type: options.type ?? settings.machineType,
          environment,
          from: options.snapshot ?? null,
          // git uses the plugin's hooks (base-branch guard) whatever the repo configures.
          env: options.gitGuard === false ? {} : BOAT_GIT_ENV,
          ttlSeconds: ttl,
          signal: options.signal,
        });
      // Snapshot errors in plain words, only when a snapshot was asked for.
      const plain = (error: unknown) => (options.snapshot ? snapshotError(error, options.snapshot) : null) ?? error;
      try {
        return await withinAutoStopCap(ttlSeconds(settings, limits), create);
      } catch (error) {
        throw plain(error);
      }
    });
  }

  private environmentCache: { at: number; names: string[] } | null = null;

  /** Fail early, with a fix, when a project's boat environment doesn't exist. */
  private async assertEnvironment(name: string, signal?: AbortSignal): Promise<void> {
    if (this.environmentCache === null || Date.now() - this.environmentCache.at > 60_000) {
      try {
        this.environmentCache = { at: Date.now(), names: await this.boat.environments(signal) };
      } catch {
        return; // Let `boat new` report it.
      }
    }
    if (this.environmentCache.names.includes(name)) return;
    this.environmentCache = null;
    throw new TaskError(
      `The boat environment "${name}" doesn't exist yet.`,
      "environment_missing",
      `Create it on boat.dev (Dashboard → Environment → +) or with \`boat env new ${name}\`, or clear the project's environment to use your default.`,
    );
  }

  /** Make sure a sandbox is up (resuming it within the slot limit). */
  bringUp(sandboxId: string, signal?: AbortSignal): Promise<Sandbox> {
    return this.ensureRunning(sandboxId, signal);
  }

  /**
   * Bring a sandbox up before sending it work: wait out stop/start
   * transitions, and resume a stopped one (one resume at a time).
   */
  private async ensureRunning(sandboxId: string, signal?: AbortSignal): Promise<Sandbox> {
    const deadline = Date.now() + TRANSITION_WAIT_MS;
    for (;;) {
      const sandbox = await this.boat.findInfo(sandboxId, signal);
      if (sandbox === null) throw new TaskError(`Sandbox ${sandboxId} no longer exists.`, "sandbox_gone");
      if (ACTIVE_STATES.has(sandbox.state)) return sandbox;
      if (sandbox.state === "stopped" || sandbox.state === "archived") {
        const resumed = await this.withSlotLock(async () => {
          const current = await this.boat.findInfo(sandboxId, signal);
          if (current === null) throw new TaskError(`Sandbox ${sandboxId} no longer exists.`, "sandbox_gone");
          if (ACTIVE_STATES.has(current.state)) return current;
          if (current.state !== "stopped" && current.state !== "archived") return null;
          const { limits } = await this.ensureSlot(signal, sandboxId);
          // A move to another size resumes onto it, whoever resumes (sizes).
          const type = this.sizes.pendingType(sandboxId);
          try {
            await withinAutoStopCap(ttlSeconds(await this.settings(), limits), (ttl) => this.boat.resume(sandboxId, ttl, signal, type));
          } catch (error) {
            if (type !== null) this.sizes.resumeFailed(sandboxId, error);
            throw error;
          }
          this.store.resetPreviewHealthForSandbox(sandboxId);
          return (await this.boat.findInfo(sandboxId, signal)) ?? current;
        });
        if (resumed !== null) return resumed;
        continue;
      }
      if (TRANSITIONAL_STATES.has(sandbox.state) && Date.now() < deadline && signal?.aborted !== true) {
        await delay(3_000, signal);
        continue;
      }
      throw new TaskError(
        `Sandbox ${sandboxId} is ${sandbox.state}${sandbox.error ? ` (${sandbox.error})` : ""}.`,
        "sandbox_unavailable",
      );
    }
  }

  /**
   * Delete a sandbox the plugin created, unless another open task still uses
   * it. Sandboxes the user made (and lent to a task) are never deleted.
   */
  async releaseSandbox(sandboxId: string, exceptTaskId: string, signal?: AbortSignal): Promise<"deleted" | "kept" | "gone"> {
    if (!this.store.pluginOwnsSandbox(sandboxId) || this.claims.has(sandboxId)) return "kept";
    const others = this.store.liveSandboxTasks(sandboxId).filter((task) => task.id !== exceptTaskId);
    if (others.length > 0) return "kept";
    try {
      await this.boat.delete(sandboxId, signal);
      return "deleted";
    } catch (error) {
      if (error instanceof BoatError && (error.code === "not_found" || error.status === 404)) return "gone";
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Tasks

  /**
   * Create the task record and dispatch it in the background. Resolves with
   * the dispatched task when that takes less than `waitMs`; otherwise with
   * the task still `starting` (the dispatching thread is told if it later
   * fails). Failures inside the wait window reject, so callers see them.
   */
  async launchTask(input: StartTaskInput, waitMs: number): Promise<{ task: Task; pending: boolean }> {
    // The caller's signal (a CLI request, a tool call) ends when we return;
    // the background dispatch only stops on close or plugin unload.
    const { task, run } = await this.prepareTask({ ...input, signal: this.hooks.lifecycle });
    const done = run();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      done.then(
        (dispatched) => ({ kind: "done" as const, task: dispatched }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), waitMs);
      }),
    ]);
    clearTimeout(timer);
    if (outcome.kind === "done") return { task: outcome.task, pending: false };
    if (outcome.kind === "error") {
      // The caller reports this failure itself; no [boat] message needed.
      this.store.update(task.id, { notifiedAt: new Date().toISOString() });
      throw outcome.error;
    }
    done.catch(() => this.deliverPending());
    return { task: this.store.get(task.id) ?? task, pending: true };
  }

  async startTask(input: StartTaskInput): Promise<Task> {
    const { run } = await this.prepareTask(input);
    return run();
  }

  private async prepareTask(input: StartTaskInput): Promise<{ task: Task; run: () => Promise<Task> }> {
    const settings = await this.settings();
    const title = input.title.trim();
    if (title === "") throw new TaskError("A task needs a title.", "invalid_task");
    if (input.brief.trim() === "") throw new TaskError("A task needs a brief.", "invalid_task");
    const parent = input.parentTaskId ? this.mustGet(input.parentTaskId) : null;
    const project = input.project ?? null;
    // GitHub is the source of truth: with a project, a worker always gets a repo.
    const repo = input.repo ? normalizeRepo(input.repo) : (parent?.repo ?? project?.repos[0]?.repo ?? null);
    const projectEntry = repo === null ? null : (project?.repos.find((entry) => entry.repo.toLowerCase() === repo.toLowerCase()) ?? null);
    const baseBranch =
      (input.baseBranch?.trim() ? assertBranch(input.baseBranch.trim(), "base branch") : null) ??
      parent?.baseBranch ??
      projectEntry?.baseBranch ??
      null;
    const extraRepos: ProjectRepo[] = parent
      ? parent.extraRepos
      : project !== null && projectEntry !== null
        ? project.repos.filter((entry) => entry !== projectEntry)
        : [];
    const environment = input.environment?.trim() || parent?.environment || project?.environment || null;
    // "none": a fresh sandbox even when the project names a snapshot. A repo
    // outside the project doesn't start from the project's snapshot.
    const snapshot =
      input.snapshot?.trim() === "none" ? null : input.snapshot?.trim() || parent?.snapshot || (projectEntry !== null ? (project?.snapshot ?? null) : null);
    const boatProject = project?.id ?? parent?.boatProject ?? null;
    const protect = protectedBranches(
      project,
      [baseBranch, ...extraRepos.map((entry) => entry.baseBranch), ...this.projectBaseBranches([repo, ...extraRepos.map((entry) => entry.repo)])],
      alwaysProtectedBranches(settings.extraProtectedBranches),
    );
    const roleProvider = input.role === "review" ? settings.reviewProvider : settings.implementProvider;
    // A model, or an effort level only one agent has, names that agent: it
    // wins over a default pick and is never switched for room.
    const askedModel = input.model?.trim() || null;
    const askedEffort = input.reasoningEffort?.trim() || null;
    const choiceAgent = modelAgent(askedModel) ?? effortAgent(askedEffort);
    const flexible = input.provider == null || input.flexibleAgent === true;
    const namesAgent = !flexible || askedModel !== null || effortAgent(askedEffort) !== null;
    let provider = (flexible ? choiceAgent : null) ?? input.provider ?? roleProvider;
    // With one agent (Coding agents), everything runs on it; a setting or
    // request for the other one falls back with a note instead of failing.
    const only = onlyAgent(settings.agents);
    let agentNote: string | null = null;
    if (only !== null && provider !== only) {
      agentNote = `Only ${AGENT_NAME[only]} is set up (Coding agents), so ${AGENT_NAME[only]} runs this ${input.role === "review" ? "review" : "task"} instead of ${AGENT_NAME[provider]}`;
      provider = only;
    }
    const relay = effectiveRelay(settings.relay, settings.agents);
    // A review of existing work goes to the agent with room, like a follow-up
    // (both agents, switching on limits on, the agent not named by hand).
    const reviewWithRoom =
      input.role === "review" &&
      parent !== null &&
      !namesAgent &&
      settings.autoFailover &&
      only === null &&
      !settings.notConnectedAgents.includes(otherAgent(provider));
    // A default agent near its usage limit gives way to the other one; with
    // both near their limits, wait rather than pay for extra usage.
    let relayNote: string | null = null;
    if ((!namesAgent || agentNote !== null) && this.hooks.quotas && (relay.enabled || reviewWithRoom || settings.avoidExtraUsage)) {
      const quotas = await this.hooks.quotas.read().catch(() => new Map());
      // With the relay off, the default agent stays; only "both out" still stops new work.
      const pick =
        relay.enabled || reviewWithRoom
          ? agentWithRoom(provider, quotas, relay.switchAtPercent, settings.agents)
          : agentWithRoom(provider, quotas, relay.switchAtPercent, settings.agents) === null
            ? null
            : provider;
      if (pick === null && settings.avoidExtraUsage) {
        throw only !== null
          ? new TaskError(
              `${AGENT_NAME[only]} is near its usage limit.`,
              "agents_at_limit",
              `Wait for a reset (\`bb boat relay status\` shows when), or name the agent explicitly (agent ${only}) to use paid extra usage.`,
            )
          : new TaskError(
              "Claude and Codex are both near their usage limits.",
              "agents_at_limit",
              "Wait for a reset (`bb boat relay status` shows when), or name an agent explicitly to use paid extra usage.",
            );
      }
      if (pick !== null && pick !== provider) {
        const used = quotas.get(provider)?.usedPercent;
        relayNote =
          input.role === "review" && used !== undefined
            ? `${AGENT_NAME[provider]} is at ${Math.round(used)}% of its limit; ${AGENT_NAME[pick]} runs this review`
            : `${AGENT_NAME[provider]} is near its usage limit, so ${AGENT_NAME[pick]} runs this task`;
        provider = pick;
      }
    }
    const roleModel = (input.role === "review" ? settings.reviewModel : settings.implementModel).trim() || null;
    const configuredModel = provider === roleProvider ? roleModel : defaultModelFor(provider, settings);
    // A model for the agent the user doesn't have can't run on the other one:
    // its id says so, or the request named that agent for it.
    const namedAgent = input.flexibleAgent ? null : (input.provider ?? null);
    const explicitModel = only !== null && askedModel !== null && (modelAgent(askedModel) ?? namedAgent ?? only) !== only ? null : askedModel;
    // A tier picks model and effort. Without one, a model from the settings is
    // used as before; otherwise the role's default tier (Build, or Review).
    const tier: Tier | null = input.tier ?? (explicitModel || configuredModel ? null : defaultTierFor(input.role));
    const choice = tier === null ? null : choiceFor(settings.modelTiers, tier, provider);
    // A project's own repo is trusted as the project says; anything else is ad hoc.
    // Trust follows the repo: any of your projects that has it decides.
    // Trust follows the repo across all your projects (the current settings, not
    // an orchestrator's old copy); a project's own setting is the fallback.
    const repoMode = (entry: string): Runner | null =>
      this.hooks.repoWorkerMode?.(entry) ?? (project !== null && project.repos.some((each) => each.repo.toLowerCase() === entry.toLowerCase()) ? project.workerMode : null);
    const projectMode = repo === null ? null : repoMode(repo);
    const repos = [repo, ...extraRepos.map((entry) => entry.repo)].filter((entry): entry is string => entry !== null);
    // One rule for every repo the task clones: the runner's, --chat's and New task's.
    const trust = chatTrust(repos, settings, repoMode);
    const runner = this.chooseRunner(input, parent, settings, trust);
    // A sandbox that runs bb (or did) holds this bb's login: never for repos you
    // don't trust, whatever the runner. Its own task's sandbox is no news to a review.
    const named = namedSandbox(input.sandbox);
    if (named !== null && !trust.trusted && !(parent !== null && named === parent.sandboxId && repo === parent.repo) && (await this.sandboxHasBb(named))) {
      throw new TaskError(
        `Sandbox ${named} runs bb (a task chat's or orchestrator's machine, or bb was installed there for a move), so a repo you don't trust can't run there, headless or not.`,
        "untrusted_sandbox",
        "Use a new sandbox, or add the repo to a project with Run tasks as chats on if you trust it.",
      );
    }
    // What the rules alone would have picked (null: they'd refuse), for the history.
    const ruleRunner = input.runner == null ? runner : this.tryRules(input, parent, settings, trust);
    // A worker chat runs bb in its sandbox, which reaches this bb through bb Connect.
    const connectState = (runner === "chat" || ruleRunner === "chat") && this.hooks.connect ? await this.hooks.connect() : null;
    if (runner === "chat" && connectState !== null) {
      const connect = connectState;
      if (connect.state === "off") {
        throw new TaskError(
          "Task chats need bb Connect, and it isn't set up on this bb.",
          "connect_required",
          input.runner === "chat"
            ? `${connect.fix ?? CONNECT_FIX} Or start it headless (--headless, or Run as a chat off in New task).`
            : `${connect.fix ? `${connect.fix} ` : ""}Or run tasks in boat: \`bb boat config set workers boat\` (Settings → Plugins → Boat Cloud Agents → How tasks run).`,
        );
      }
    }
    // Signed in, a plan that can start a sandbox, and this agent's login, before
    // anything is created (a sandbox the setup can't use would cost a start).
    // A review that reuses its task's sandbox needs no start; when it may
    // still get a new one, createSandbox checks the plan right before.
    if (this.hooks.preflight) {
      await this.hooks.preflight({ agent: provider, runner, environment, newSandbox: surelyNewSandbox(input, parent, settings) });
    }
    // Headless because the rules don't trust the repo (asked for or not): the Untrusted repo badge.
    const ruled = runner === "boat" && ruleRunner === "boat" && this.hooks.chat !== undefined && settings.workerMode === "chat";
    const untrusted = ruled && repo !== null && projectMode === null && (parent === null || this.store.latestEvent(parent.id, "trust") !== null);
    // Headless for another repo the task clones (its own is trusted).
    const otherUntrusted = ruled && parent === null && !trust.trusted && (repo === null || (projectMode ?? settings.adhocWorkerMode) === "chat");
    const model = agentModel(runner, provider, explicitModel ?? choice?.model ?? configuredModel);
    // Likewise an effort level only the missing agent has (ultra, ultracode).
    const explicitEffort = agentNote !== null && (effortAgent(askedEffort) ?? provider) !== provider ? null : askedEffort;
    const reasoningEffort = agentEffort(runner, provider, explicitEffort || choice?.effort || settings.reasoningEffort.trim() || null);
    assertFrontierAllowed(settings.modelTiers, tier, model, reasoningEffort, input.userApproved === true);
    const reason = input.reason?.trim() ? clip(input.reason.trim().replace(/\s+/g, " "), 300) : null;
    // The new sandbox's size: asked for, the project's, or the setting (sizes).
    const sandboxChoice = (input.sandbox ?? "").trim();
    const sizing = await this.sizes.resolveNewType({
      requested: input.machineType ?? null,
      checkPlan: sandboxChoice === "" || sandboxChoice === "new" || sandboxChoice === "auto",
      projectId: boatProject,
      repo,
      parent,
      role: input.role,
      settings,
      userApproved: input.userApproved === true,
    });
    const id = newTaskId();
    const now = new Date().toISOString();

    let branch: string | null = null;
    let checkout: CheckoutMode | null = null;
    if (repo !== null) {
      if (input.pr) {
        checkout = { kind: "pull-request", pr: input.pr };
      } else if (input.role === "implement" || input.role === "custom") {
        // Anything that may change code works on its own branch.
        branch = assertBranch(input.branch?.trim() || `boat/${id.slice(2)}-${slug(title)}`);
        if (protect.includes(branch)) {
          throw new TaskError(
            `"${branch}" is a base branch; tasks never push to it.`,
            "invalid_branch",
            "Give the task its own branch (or omit --branch for boat/<id>-<title>); it opens a draft PR against the base.",
          );
        }
        checkout = { kind: "new-branch", branch, base: baseBranch };
      } else if (input.branch) {
        branch = assertBranch(input.branch);
        checkout = { kind: "existing-branch", branch };
      } else if (parent?.branch) {
        branch = parent.branch;
        checkout = { kind: "existing-branch", branch };
      } else {
        checkout = { kind: "default-branch", base: baseBranch };
      }
    }

    // How the work lands. A review follows its implementer. Otherwise the current
    // project settings for the repo decide (the stricter "push" wins), but only
    // for a new branch off the project's base: a checked-out PR or existing
    // branch, or another base, goes through pull requests.
    const fromProject = project !== null && projectEntry !== null && baseBranch === projectEntry.baseBranch ? project.delivery : null;
    const projectDelivery = repo === null || baseBranch === null ? null : (this.hooks.repoDelivery?.(repo, baseBranch) ?? fromProject);
    const delivery: "pr" | "push" =
      parent !== null
        ? parent.delivery
        : projectDelivery === "push" && checkout !== null && (checkout.kind === "new-branch" || checkout.kind === "default-branch")
          ? "push"
          : "pr";
    const task: Task = this.store.insert({
      id,
      title: clip(title, 200),
      role: input.role,
      status: "starting",
      orchestratorThreadId: input.orchestratorThreadId ?? null,
      projectId: input.projectId ?? null,
      repo,
      repoPath: null,
      branch,
      baseBranch,
      sandboxId: null,
      conversationId: null,
      promptId: null,
      provider,
      model,
      reasoningEffort,
      tier,
      reason,
      runner,
      threadId: null,
      hostId: null,
      environmentId: null,
      readyAt: null,
      readyNote: null,
      delivery,
      boatProject,
      environment,
      snapshot,
      extraRepos,
      brief: input.brief.trim(),
      parentTaskId: parent?.id ?? null,
      prUrl: input.pr && /^https:\/\//.test(input.pr) ? input.pr : (parent?.prUrl ?? null),
      result: null,
      error: null,
      turns: 0,
      ownsSandbox: true,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      notifiedAt: null,
      unshipped: null,
      shipApproval: null,
    });
    this.store.addEvent(id, "created", `${input.role} task created · ${modelLine(tier, model, reasoningEffort, reason)}`);
    if (input.measureMemory) this.sizes.watch(id); // sizes
    if (agentNote !== null) this.store.addEvent(id, "agent", agentNote);
    if (relayNote !== null) this.store.addEvent(id, "relay", relayNote);
    if (untrusted) {
      this.store.addEvent(id, "trust", `${repo} isn't one of your projects: the task runs headless in boat, with no access to your bb.`);
    }
    if (otherUntrusted) {
      this.store.addEvent(id, "runner", `Runs headless in boat: ${lowerFirst(trustText(trust))}, and the task clones ${trust.untrustedRepos.length === 1 ? "it" : "them"} too`);
    }
    if (input.runner != null && ruleRunner !== null && ruleRunner !== runner && input.evidence !== false) {
      this.store.addEvent(
        id,
        "runner",
        runner === "chat"
          ? "Runs as a task chat, as asked (How tasks run would run it headless)"
          : connectState?.state === "off"
            ? "Runs headless in boat: task chats need bb Connect, which is off"
            : "Runs headless in boat, as asked (How tasks run would make it a task chat)",
      );
    }
    if (input.runner == null && runner === "boat" && parent?.runner === "chat" && this.userMadeChat(parent)) {
      this.store.addEvent(id, "runner", `Runs headless: task ${parent.id} is a task chat only because the user asked, so its reviews don't get this bb's reach`);
    }
    if (runner === "chat" && input.runner === "chat") {
      if (!trust.trusted) this.store.addEvent(id, "trust-confirmed", `${trustText(trust)}; started as a task chat after the warning in New task (its sandbox can reach this bb).`);
    }
    if (input.userApproved === true && needsFrontierApproval(settings.modelTiers, tier, model, reasoningEffort)) {
      this.store.addEvent(id, "approval", "Frontier at max effort, approved by the user");
    }
    // The implementer's history shows its reviews, so nobody starts a second one by mistake.
    if (input.role === "review" && parent !== null) {
      this.store.addEvent(parent.id, "review", `Review ${id} started (${provider} · ${modelLine(tier, model, reasoningEffort, null)})`);
    }
    this.hooks.changed([id]);

    // Registered now, so closing the task before run() starts still cancels it.
    const controller = new AbortController();
    this.dispatches.set(id, controller);
    // The project's own instructions for its tasks (a project given, else the parent's or the repo's).
    const projectNotes =
      project !== null ? (project.instructions?.trim() ? [project.instructions.trim()] : []) : (this.hooks.projectInstructions?.(boatProject, repo) ?? []);
    const run = () => this.runTask(task, input, controller, { parent, repo, checkout, provider, model, settings, protect, projectNotes, sizing });
    return { task, run };
  }

  /** The rules' trust for these repos (the plugin's projects and How tasks run), for a task that exists. */
  chatTrust(repos: readonly string[], settings: Pick<BoatSettings, "workerMode" | "adhocWorkerMode">): ChatTrust {
    return chatTrust(repos, settings, (repo) => this.hooks.repoWorkerMode?.(repo) ?? null);
  }

  /** This bb can run task chats at all (the chat runner is there). */
  canRunChats(): boolean {
    return this.hooks.chat !== undefined;
  }

  /** bb runs on this sandbox, or did (a task chat's or orchestrator's machine, a move's install): it may hold bb's login. */
  private async sandboxHasBb(sandboxId: string): Promise<boolean> {
    if (this.store.machineForSandbox(sandboxId) !== null || this.store.sandboxHadBb(sandboxId)) return true;
    return this.hooks.chat !== undefined && (await this.hooks.chat.findMachine(sandboxId).catch(() => null)) !== null;
  }

  /** A task chat the user made against the rules (a confirmed start or move): its reviews don't follow it. */
  private userMadeChat(task: Task): boolean {
    return this.store.latestEvent(task.id, "trust-confirmed") !== null;
  }

  private tryRules(input: StartTaskInput, parent: Task | null, settings: BoatSettings, trust: ChatTrust): Runner | null {
    try {
      return this.chooseRunner({ ...input, runner: null }, parent, settings, trust);
    } catch {
      return null;
    }
  }

  /**
   * An explicit "chat": this bb runs task chats, a named sandbox already runs
   * bb, and the rules trust the repos or the user confirmed the warning.
   */
  private explicitChat(input: StartTaskInput, trust: ChatTrust): Runner {
    if (this.hooks.chat === undefined) throw new TaskError("This bb can't run task chats.", "chat_unavailable", "Start it headless instead (drop --chat).");
    const named = namedSandbox(input.sandbox);
    if (named !== null && this.store.hostForSandbox(named) === null) {
      throw new TaskError(`Sandbox ${named} doesn't run bb, so a task chat can't start there.`, "sandbox_not_chat", "Use a new sandbox, or start it headless.");
    }
    if (!confirmCovers(input.confirmUntrustedChat, trust)) throw this.untrustedRepoError(trust, "start", input.confirmUntrustedChat != null);
    return "chat";
  }

  /** A task chat the rules don't allow and the user didn't confirm (or confirmed for other repos). */
  private untrustedRepoError(trust: ChatTrust, via: "start" | "move", confirmedOther: boolean, ownRepos?: readonly string[]): TaskError {
    const repo = trust.untrustedRepos[0] ?? null;
    const what = via === "start" ? "start as a task chat" : "continue as a task chat";
    // A move: a repo another task ran in the same sandbox counts too.
    const other = repo !== null && ownRepos !== undefined && !ownRepos.some((own) => own.toLowerCase() === repo.toLowerCase());
    const message = confirmedOther
      ? `The task's repos changed after the warning: your projects don't run tasks on ${trust.untrustedRepos.join(", ")} as chats.`
      : trust.workersBoat
        ? `How tasks run is set to In boat, so ${repo === null ? "a task" : other ? `a task whose sandbox also ran ${repo}` : repo} can't ${what} here.`
        : other
          ? `Another task ran ${repo} in this task's sandbox, and your projects don't run tasks on it as chats, so this task can't ${what} there.`
          : this.hooks.repoWorkerMode?.(repo ?? "") === "boat"
            ? `${repo}'s project runs its tasks headless (Run tasks as chats is off), so it can't ${what} here.`
            : `${repo} isn't in one of your projects with Run tasks as chats on, so it can't ${what} here.`;
    const hint = confirmedOther
      ? "Check the warning again, then try again."
      : via === "start"
        ? "A task chat's sandbox can reach this bb, so the user decides: Run as a chat in New task on the Cloud agents page asks them, or they add the repo to a project with Run tasks as chats on (Settings → Plugins → Boat Cloud Agents → Projects). Or run it headless: drop --chat."
        : "A task chat's sandbox can reach this bb, so the user decides: Continue as a chat on the task's page asks them, or they add the repo to a project with Run tasks as chats on (Settings → Plugins → Boat Cloud Agents → Projects).";
    return new TaskError(message, "untrusted_repo", hint);
  }

  /** Workers are bb chats unless the setting, a boat sandbox or the implementer says otherwise. */
  private chooseRunner(input: StartTaskInput, parent: Task | null, settings: BoatSettings, trust: ChatTrust): Runner {
    if (input.runner === "boat") return "boat";
    if (input.runner === "chat") return this.explicitChat(input, trust);
    if (this.hooks.chat === undefined || settings.workerMode !== "chat") return "boat";
    // A task the user made a chat against the rules: its reviews run headless,
    // so no more sandboxes get this bb's reach without their say.
    if (parent !== null && parent.runner === "chat" && this.userMadeChat(parent)) return "boat";
    // Worker chats hold bb machine credentials: only for repos you trust. A
    // review follows its implementer; a task without a repo clones no code.
    const trusted: Runner = parent !== null ? parent.runner : trust.trusted ? "chat" : "boat";
    const choice = namedSandbox(input.sandbox);
    if (choice !== null) {
      // A named sandbox without a bb machine stays a boat conversation.
      if (this.store.hostForSandbox(choice) === null) return "boat";
      // One with a machine holds bb credentials: never for a repo you don't trust.
      if (trusted === "boat") {
        throw new TaskError(
          `Sandbox ${choice} runs bb (a task chat's machine); a repo you don't trust can't run there.`,
          "untrusted_sandbox",
          "Use a new sandbox, or add the repo to a project if you trust it.",
        );
      }
      return "chat";
    }
    return trusted;
  }

  /** Every base branch your projects use for these repos: workers never push to one. */
  projectBaseBranches(repos: readonly (string | null)[]): string[] {
    return repos.flatMap((repo) => (repo === null ? [] : (this.hooks.repoBaseBranches?.(repo) ?? [])));
  }

  /** Keep a turn's evidence links: later turns' messages replace the result. */
  private recordEvidence(taskId: string, text: string): void {
    const links = evidenceLinks(text);
    if (links.length > 0) this.store.addEvent(taskId, "evidence-links", JSON.stringify(links));
  }

  /** Every evidence link the task's turns uploaded, oldest first. */
  evidenceLinks(taskId: string): string[] {
    const links: string[] = [];
    for (const event of this.store.events(taskId, 1000)) {
      if (event.kind !== "evidence-links") continue;
      try {
        for (const link of JSON.parse(event.text) as unknown[]) if (typeof link === "string" && !links.includes(link)) links.push(link);
      } catch {
        // Not ours.
      }
    }
    return links;
  }

  /**
   * Check out a repo, recording what boat's GitHub login may do there and
   * when it expires; no access or an expired login fails with what to fix.
   */
  private async prepareChecked(
    taskId: string,
    sandboxId: string,
    repo: string,
    checkout: CheckoutMode,
    options: Parameters<BoatApi["prepareRepo"]>[3],
  ): Promise<PreparedRepo> {
    try {
      const prepared = await this.boat.prepareRepo(sandboxId, repo, checkout, options);
      if (prepared.canPush !== undefined && prepared.canPush !== null) {
        this.store.setRepoAccess(repo, prepared.canPush ? "write" : "read", null);
        this.store.addEvent(taskId, "access", `GitHub access to ${repo}: ${prepared.canPush ? "can push" : "read only"}`);
      }
      if (prepared.githubExpiresAt) this.store.addEvent(taskId, "github-token", prepared.githubExpiresAt);
      return prepared;
    } catch (error) {
      if (error instanceof BoatError && (error.code === "repo_access" || error.code === "github_token_expired")) {
        this.store.setRepoAccess(repo, error.code === "repo_access" ? "none" : "expired", error.message);
        throw new TaskError(error.message, error.code);
      }
      throw error;
    }
  }

  /** When the task's sandbox's GitHub token expires (ISO), as last seen (a review sharing the implementer's sandbox uses its). */
  private githubExpiry(task: Task): string | null {
    const own = this.store.latestEvent(task.id, "github-token");
    if (own !== null) return own.text;
    const parent = task.parentTaskId ? this.store.get(task.parentTaskId) : null;
    return parent !== null && parent.sandboxId === task.sandboxId ? (this.store.latestEvent(parent.id, "github-token")?.text ?? null) : null;
  }

  /**
   * Before work that needs GitHub (a push, a PR, a ship): an expired sandbox
   * token is caught here, with what to do, instead of failing mid-turn.
   */
  private async assertGithubLogin(task: Task, options: { signal?: AbortSignal; resume?: boolean; forShip?: boolean } = {}): Promise<void> {
    const recorded = this.githubExpiry(task);
    if (recorded === null || task.sandboxId === null) return;
    // A turn can run a while: a token running out within it is checked too.
    if (Date.parse(recorded) - Date.now() > 45 * 60_000) return;
    // Ask the sandbox (boat may have given it a fresh login). A stopped one is
    // woken first when the work is about to run there anyway.
    let sandbox = await this.boat.findInfo(task.sandboxId, options.signal).catch(() => null);
    if (sandbox === null) return;
    if (!ACTIVE_STATES.has(sandbox.state)) {
      if (!options.resume) return;
      sandbox = await this.resumeSandbox(task.sandboxId, options.signal);
    }
    const login = await this.boat.githubLogin(task.sandboxId, options.signal).catch(() => ({ valid: null, expiresAt: null }));
    if (login.expiresAt) this.store.addEvent(task.id, "github-token", login.expiresAt);
    const expiresAt = login.expiresAt ?? recorded;
    const expired = login.valid === false || (login.valid !== true && Date.parse(expiresAt) <= Date.now()) || Date.parse(expiresAt) - Date.now() < 10 * 60_000;
    if (!expired) return;
    const settings = await this.settings();
    const environment = task.environment ?? sandbox.environment ?? (settings.environment || null);
    const upgrade = environment ? `\`boat env upgrade ${environment}\`` : "`boat env upgrade <its environment>`";
    const when = new Date(expiresAt).toUTCString().slice(17, 22);
    throw new TaskError(
      options.forShip
        ? `Task ${task.id}'s sandbox has an expired GitHub login (boat's GitHub tokens last about 8 hours; this one ${Date.parse(expiresAt) <= Date.now() ? "ran out" : "runs out"} at ${when} UTC), so it can't push the approved work.`
        : `Task ${task.id}'s sandbox has an expired GitHub login (boat's GitHub tokens last about 8 hours; this one ${Date.parse(expiresAt) <= Date.now() ? "ran out" : "runs out"} at ${when} UTC), so the agent can't push or open pull requests from it.`,
      "github_token_expired",
      options.forShip
        ? `Run ${upgrade} to give sandboxes fresh credentials, then ship again. Don't close this task or delete its sandbox: the approved commits exist only there.`
        : `Run ${upgrade} to give sandboxes fresh credentials and try again; if that doesn't help, start the work again in a new sandbox (boat_dispatch with context_from ${task.id}).`,
    );
  }

  /** The task's sandbox got the uploader (or tried to): its prompts ask for uploads. */
  private hasEvidence(taskId: string): boolean {
    return this.store.latestEvent(taskId, "evidence") !== null;
  }

  private evidenceEnabled(settings: BoatSettings): boolean {
    return this.hooks.evidence !== undefined && settings.evidenceUploader.trim() !== "";
  }

  /**
   * Put \`evidence-upload\` into the sandbox. Never fatal: without it the
   * worker reports that uploads failed. Returns whether the brief should ask
   * for uploads.
   */
  private async installEvidence(taskId: string, sandboxId: string, settings: BoatSettings, signal: AbortSignal): Promise<boolean> {
    if (!this.evidenceEnabled(settings)) return false;
    try {
      const source = parseEvidenceSource(settings.evidenceUploader);
      if (source === null) return false;
      const script = await this.hooks.evidence!.script(source, signal);
      // The bundled uploader's variables are known; a custom script's are its own.
      const checkNames = source.kind === "builtin" ? BUILTIN_CONFIG_NAMES : [];
      const result = await this.boat.exec(sandboxId, evidenceInstallScript(script, checkNames), { timeoutMs: 120_000, signal });
      const parsed = parseInstallResult(result.stdout, checkNames);
      if (result.exitCode !== 0 || parsed === null) {
        const detail = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-3).join(" ");
        throw new Error(detail || `exit code ${result.exitCode}`);
      }
      this.store.addEvent(taskId, "evidence", installSummary(parsed, source));
    } catch (error) {
      if (signal.aborted) throw error;
      const message = errorText(error);
      this.hooks.log.warn(`evidence-upload install failed for ${taskId}: ${message}`);
      this.store.addEvent(taskId, "evidence", `Couldn't install evidence-upload: ${clip(message, 300)}`);
    }
    return true;
  }

  private async runTask(
    initial: Task,
    input: StartTaskInput,
    controller: AbortController,
    plan: {
      parent: Task | null;
      repo: string | null;
      checkout: CheckoutMode | null;
      provider: Provider;
      model: string | null;
      settings: BoatSettings;
      protect: string[];
      /** The project's instructions, added after the standing ones. */
      projectNotes: string[];
      /** A new sandbox's size, and the history note on where it came from. */
      sizing: { type: MachineType; note: string | null };
    },
  ): Promise<Task> {
    const { parent, repo, checkout, provider, model, settings, protect, projectNotes, sizing } = plan;
    const id = initial.id;
    const onOuterAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const signal = controller.signal;
    let release: () => void = () => undefined;
    let task = initial;
    let createdSandbox: string | null = null;
    let createdHost: string | null = null;
    // Stop as soon as the task is closed (or the plugin unloads).
    const stillWanted = () => {
      if (signal.aborted || this.store.get(id)?.status !== "starting") throw new DispatchCancelled();
    };
    try {
      stillWanted();
      // 1. Sandbox: reuse or create.
      const reuse = await this.pickSandbox(input, parent, settings, signal);
      stillWanted();
      this.sizes.assertSandboxNotResizing(reuse, "Start the task once the move is done, or in a new sandbox."); // sizes
      let sandbox: Sandbox;
      if (reuse !== null) {
        release = this.claim(reuse);
        sandbox = await this.ensureRunning(reuse, signal);
        task = this.store.update(id, { sandboxId: sandbox.id, ownsSandbox: false }) ?? task;
        this.store.addEvent(id, "sandbox", `Reusing sandbox ${sandbox.id}`);
      } else {
        sandbox = await this.createSandbox({
          name: `bb ${id} ${slug(task.title)}`,
          type: sizing.type,
          environment: task.environment,
          snapshot: task.snapshot,
          signal,
        });
        createdSandbox = sandbox.id;
        release = this.claim(sandbox.id);
        task = this.store.update(id, { sandboxId: sandbox.id, ownsSandbox: true }) ?? task;
        this.store.addEvent(id, "sandbox", `Created sandbox ${sandbox.id}${task.snapshot ? ` from snapshot ${task.snapshot}` : ""}`);
        if (sizing.note !== null) this.store.addEvent(id, "sandbox-size", sizing.note); // sizes
      }
      this.hooks.changed([id]);
      stillWanted();

      // 2. Repository checkout. A reviewer sharing the implementer's sandbox
      // reads the implementer's checkout as is; checking out again could
      // move the branch under unpushed work.
      let prepared: PreparedRepo | null = null;
      const sharesParentCheckout =
        parent !== null && reuse === parent.sandboxId && repo !== null && repo === parent.repo;
      if (sharesParentCheckout) {
        prepared = {
          path: parent.repoPath ?? `/home/user/work/${repo.split("/")[1] ?? "repo"}`,
          branch: parent.branch,
          baseBranch: parent.baseBranch,
        };
        task = this.store.update(id, { repoPath: prepared.path }) ?? task;
        this.store.addEvent(id, "repo", `Reviewing the checkout of task ${parent.id} at ${prepared.path}`);
      } else if (repo !== null && checkout !== null) {
        // Each task gets its own checkout, so tasks sharing a sandbox never
        // switch branches under each other.
        prepared = await this.prepareChecked(id, sandbox.id, repo, checkout, {
          signal,
          workDir: id,
          protect,
          alwaysProtect: alwaysProtectedBranches(settings.extraProtectedBranches),
          noPush: task.delivery === "push",
          environment: task.environment ?? settings.environment ?? null,
          // A fresh sandbox of our own: reuse the environment's checkout (deps installed).
          useEnvironmentCheckout: createdSandbox !== null,
        });
        stillWanted();
        // A worker that has to push (its branch, or later the ship) needs write access;
        // reviews and custom work that doesn't ship only read.
        if (prepared.canPush === false && (input.role === "implement" || (input.role === "custom" && task.delivery === "push"))) {
          throw new TaskError(
            `boat's GitHub access can read ${repo} but not push to it.`,
            "repo_read_only",
            `Your GitHub account needs write access to ${repo}, and boat needs access to it: connect GitHub on boat.dev → Environment and select ${repo} (GitHub → Settings → Applications → boat → Repository access, on ${repo.split("/")[0]}). Then try again.`,
          );
        }
        task =
          this.store.update(id, {
            repoPath: prepared.path,
            branch: prepared.branch ?? task.branch,
            // A known base (the project's, the parent's) wins over what the checkout guessed.
            baseBranch: task.baseBranch ?? prepared.baseBranch,
          }) ?? task;
        this.store.addEvent(id, "repo", `Checked out ${repo} at ${prepared.path} (${prepared.branch ?? "detached"})`);
      }

      // Other project repos, next to the main one on their base branch.
      const extras: { repo: string; baseBranch: string; path: string }[] = [];
      for (const extra of task.extraRepos) {
        if (sharesParentCheckout) {
          const known = parent?.extraRepos.find((entry) => entry.repo === extra.repo)?.path;
          if (known) extras.push({ repo: extra.repo, baseBranch: extra.baseBranch, path: known });
          continue;
        }
        const ready = await this.prepareChecked(
          id,
          sandbox.id,
          extra.repo,
          { kind: "default-branch", base: extra.baseBranch },
          {
            signal,
            workDir: id,
            protect,
            alwaysProtect: alwaysProtectedBranches(settings.extraProtectedBranches),
            useEnvironmentCheckout: createdSandbox !== null,
            noPush: task.delivery === "push",
            environment: task.environment ?? settings.environment ?? null,
          },
        );
        stillWanted();
        extras.push({ repo: extra.repo, baseBranch: extra.baseBranch, path: ready.path });
        this.store.addEvent(id, "repo", `Checked out ${extra.repo} at ${ready.path} (${extra.baseBranch})`);
      }
      if (!sharesParentCheckout && extras.length > 0) task = this.store.update(id, { extraRepos: extras }) ?? task;
      // Screenshots and recordings must outlive the sandbox: install the uploader.
      const evidence = input.evidence === false ? false : await this.installEvidence(id, sandbox.id, settings, signal);
      stillWanted();
      // The checkout may have found the base branch (repo default); protect it too.
      const briefProtect = [...new Set([...protect, ...(task.baseBranch ? [task.baseBranch] : [])])];

      // A sandbox with no bb machine (a boat conversation's) can't host a chat.
      if (task.runner === "chat" && reuse !== null && !(sharesParentCheckout && parent?.environmentId) && this.store.hostForSandbox(reuse) === null) {
        if (input.runner === "chat") {
          throw new TaskError(`Sandbox ${reuse} doesn't run bb, so a task chat can't start there.`, "sandbox_not_chat", "Use a new sandbox, or start it headless.");
        }
        task = this.store.update(id, { runner: "boat", model: boatModelId(provider, task.model), reasoningEffort: boatEffort(task.reasoningEffort) }) ?? task;
        this.store.addEvent(id, "runner", `Sandbox ${reuse} has no bb machine; running headless in boat`);
      }
      // What the sandbox is (new or reused), for the prompt (sizes).
      const sandboxLine = await this.sizes.atDispatch(task, sandbox, { created: createdSandbox !== null, requested: sizing.type, signal });
      stillWanted();

      // 3. Dispatch the agent.
      const prompt = composeInitialPrompt({
        runner: task.runner,
        effort: task.reasoningEffort,
        taskId: id,
        role: input.role,
        title: task.title,
        brief: task.brief,
        workspace: {
          repo,
          repoPath: prepared?.path ?? null,
          branch: task.branch,
          baseBranch: task.baseBranch,
          prUrl: task.prUrl,
          extraRepos: extras,
          protectedBranches: briefProtect,
          delivery: task.delivery,
        },
        originalBrief: parent?.brief ?? null,
        tier: task.tier,
        provider,
        evidence,
        sandboxLine,
        extraInstructions: [
          settings.workerInstructions,
          ...projectNotes,
          sharesParentCheckout
            ? "You share this sandbox and checkout with the task you review. Do not edit files, commit, push, or switch branches; only read, build, and test."
            : "",
        ]
          .filter((part) => part.trim() !== "")
          .join("\n\n"),
      });
      if (task.runner === "chat") {
        return await this.dispatchChat(task, input, {
          prompt,
          sandbox,
          reuse,
          parent,
          sharesParentCheckout,
          checkoutPath: prepared?.path ?? null,
          signal,
          stillWanted,
          onHost: (hostId) => {
            createdHost = hostId;
          },
        });
      }
      const conversationId = randomUUID();
      task = this.store.update(id, { conversationId }) ?? task;
      stillWanted();
      const dispatch = await this.boat.prompt({
        sandboxId: sandbox.id,
        conversationId,
        prompt,
        provider,
        model: task.model,
        reasoningEffort: task.reasoningEffort,
        signal,
      });
      const running = this.store.transition(id, ["starting"], {
        status: "running",
        conversationId: dispatch.conversationId,
        promptId: dispatch.promptId,
        model: dispatch.model ?? model,
        turns: 1,
        notifiedAt: null,
      });
      if (running === null) {
        // Closed while the prompt was in flight: stop the agent we just started.
        await this.boat.interrupt(sandbox.id, dispatch.conversationId).catch(() => undefined);
        throw new DispatchCancelled();
      }
      this.store.addEvent(
        id,
        "dispatched",
        `Sent to ${provider} · ${modelLine(task.tier, dispatch.model ?? model, task.reasoningEffort, task.reason)}`,
      );
      this.hooks.changed([id]);
      return running;
    } catch (error) {
      if (error instanceof DispatchCancelled || (signal.aborted && this.store.get(id)?.status !== "starting")) {
        // Closed mid-dispatch: clean up what we made and leave the status alone.
        release();
        await this.discardNew(id, createdSandbox, createdHost);
        this.hooks.changed([id]);
        return this.store.get(id) ?? task;
      }
      const message = errorText(error);
      this.store.transition(id, ["starting"], { status: "failed", error: clip(message, 4000), finishedAt: new Date().toISOString() });
      this.store.addEvent(id, "failed", message);
      this.hooks.changed([id]);
      // Do not leave a fresh sandbox behind when setup failed.
      release();
      await this.discardNew(id, createdSandbox, createdHost);
      throw error;
    } finally {
      release();
      input.signal?.removeEventListener("abort", onOuterAbort);
      if (this.dispatches.get(id) === controller) this.dispatches.delete(id);
    }
  }

  /** Remove what a failed or cancelled dispatch created (a machine takes its sandbox with it). */
  private async discardNew(taskId: string, sandboxId: string | null, hostId: string | null): Promise<void> {
    // An attach that was cut short (cancel, restart) may still have made a machine.
    if (hostId === null && sandboxId !== null && this.hooks.chat && this.store.get(taskId)?.runner === "chat") {
      hostId = await this.hooks.chat.findMachine(sandboxId).catch(() => null);
    }
    if (hostId !== null && this.hooks.chat) {
      await this.hooks.chat.removeMachine(hostId).catch((error) => this.hooks.log.warn(`remove machine ${hostId}: ${errorText(error)}`));
      return;
    }
    if (sandboxId !== null) await this.releaseSandbox(sandboxId, taskId).catch(() => undefined);
  }

  /**
   * Start the worker as a regular bb chat: bb adopts the prepared sandbox as
   * a machine (or the chat joins the implementer's workspace), and the chat
   * nests under the orchestrator, which the plugin wakes when a turn ends.
   */
  private async dispatchChat(
    initial: Task,
    input: StartTaskInput,
    ctx: {
      prompt: string;
      sandbox: Sandbox;
      reuse: string | null;
      parent: Task | null;
      sharesParentCheckout: boolean;
      checkoutPath: string | null;
      signal: AbortSignal;
      stillWanted: () => void;
      onHost: (hostId: string) => void;
    },
  ): Promise<Task> {
    const chat = this.hooks.chat!;
    const id = initial.id;
    let task = initial;
    let where: ChatWhere;
    let hostId: string | null;
    let environmentId: string | null = null;
    if (ctx.sharesParentCheckout && ctx.parent !== null && ctx.parent.environmentId === null && ctx.parent.threadId !== null) {
      const known = (await chat.state(ctx.parent.threadId).catch(() => null))?.environmentId ?? null;
      if (known !== null) ctx.parent = this.store.update(ctx.parent.id, { environmentId: known }) ?? ctx.parent;
    }
    if (ctx.sharesParentCheckout && ctx.parent?.environmentId) {
      // A reviewer reading the implementer's checkout joins its workspace.
      environmentId = ctx.parent.environmentId;
      hostId = ctx.parent.hostId;
      where = { kind: "environment", environmentId };
    } else {
      hostId = ctx.reuse !== null ? this.store.hostForSandbox(ctx.reuse) : null;
      if (hostId === null) {
        this.store.addEvent(id, "machine", "Installing bb on the sandbox (about a minute)");
        this.hooks.changed([id]);
        hostId = (await chat.attachMachine({ taskId: id, sandboxId: ctx.sandbox.id, signal: ctx.signal })).hostId;
        ctx.onHost(hostId);
        this.store.addEvent(id, "machine", `The sandbox is bb machine ${hostId}`);
      }
      where = { kind: "machine", hostId, path: ctx.checkoutPath };
    }
    task = this.store.update(id, { hostId }) ?? task;
    ctx.stillWanted();
    const spawned = await chat.spawn({
      taskId: id,
      title: task.title,
      prompt: ctx.prompt,
      provider: task.provider,
      model: task.model,
      effort: task.reasoningEffort,
      parentThreadId: task.orchestratorThreadId,
      projectId: input.projectId ?? null,
      where,
    });
    this.store.addEvent(id, "chat", spawned.threadId);
    this.recordChat(id, spawned.threadId, task.provider, task.model, task.reasoningEffort);
    const running = this.store.transition(id, ["starting"], {
      status: "running",
      threadId: spawned.threadId,
      environmentId: spawned.environmentId ?? environmentId,
      promptId: chatTurnMarker(),
      turns: 1,
      notifiedAt: null,
    });
    if (running === null) {
      // Closed while the chat was being opened.
      await chat.stop(spawned.threadId).catch(() => undefined);
      await chat.archive(spawned.threadId).catch(() => undefined);
      throw new DispatchCancelled();
    }
    this.store.addEvent(id, "dispatched", `Opened a ${task.provider} chat · ${modelLine(task.tier, task.model, task.reasoningEffort, task.reason)}`);
    this.hooks.changed([id]);
    return running;
  }

  private async pickSandbox(
    input: StartTaskInput,
    parent: Task | null,
    settings: BoatSettings,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const choice = (input.sandbox ?? "").trim();
    if (choice !== "" && choice !== "new" && choice !== "same" && choice !== "auto") return choice;
    if (choice === "new") return null;
    if (choice === "same") {
      if (parent?.sandboxId == null) {
        throw new TaskError("--sandbox same needs a parent task with a sandbox.", "invalid_task");
      }
      return parent.sandboxId;
    }
    // Reviews default to the reviewSandbox setting; "auto" prefers a fresh
    // sandbox and falls back to the implementer's running one when no slot
    // is free.
    if (input.role === "review" && parent?.sandboxId) {
      const mode = choice === "auto" ? "auto" : settings.reviewSandbox;
      if (mode === "same") return parent.sandboxId;
      if (mode === "auto") {
        const { free, active } = await this.capacity(signal);
        if (free !== null && free <= 0 && active.some((sandbox) => sandbox.id === parent.sandboxId)) {
          return parent.sandboxId;
        }
      }
    }
    return null;
  }

  async followup(idOrPrefix: string, message: string, options: Parameters<BoatService["sendFollowup"]>[2] = {}): Promise<Task> {
    // Entered before the task is read: a follow-up right after a move sees the chat.
    const leave = this.enterFollowup(this.mustGet(idOrPrefix).id);
    try {
      return await this.sendFollowup(idOrPrefix, message, options);
    } finally {
      leave();
    }
  }

  /** Follow-ups and a move to a chat exclude each other; follow-ups don't exclude each other. */
  private enterFollowup(taskId: string): () => void {
    if (this.moves.has(taskId)) {
      throw new TaskError(`Task ${taskId} is moving to a task chat.`, "task_busy", "Send it once the chat is open (in about a minute); it goes there.");
    }
    this.sending.set(taskId, (this.sending.get(taskId) ?? 0) + 1);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      const count = (this.sending.get(taskId) ?? 1) - 1;
      if (count <= 0) this.sending.delete(taskId);
      else this.sending.set(taskId, count);
    };
  }

  /** bb suspended this worker machine (the watchdog brought bb's record in line): the idle stop leaves it. */
  noteSuspended(hostId: string): void {
    this.suspendedHosts.add(hostId);
    this.backgroundSince.delete(hostId);
  }

  /** bb has this worker machine up again (the watchdog resumed it, or sees it connected): the idle stop watches it again. */
  noteResumed(hostId: string): void {
    this.suspendedHosts.delete(hostId);
    this.backgroundSince.delete(hostId);
  }

  /** A move to a task chat is running for this task. */
  isMovingToChat(taskId: string): boolean {
    return this.moves.has(taskId);
  }

  /** A move to a task chat holds this sandbox (the machine keeper leaves it alone). */
  isMovingSandbox(sandboxId: string): boolean {
    return [...this.moves.values()].some((move) => move.sandboxId === sandboxId);
  }

  /** A dispatch, ship or wake holds this sandbox right now (the machine keeper doesn't suspend it). */
  holdsSandbox(sandboxId: string): boolean {
    // A dispatch, ship or wake; a move to a task chat; a move to another size.
    return this.claims.has(sandboxId) || this.isMovingSandbox(sandboxId) || this.sizes.isResizing(sandboxId);
  }

  private assertNotMoving(taskId: string): void {
    if (this.moves.has(taskId)) throw new TaskError(`Task ${taskId} is moving to a task chat.`, "task_busy", "Try again once the chat is open (in about a minute).");
  }

  private async sendFollowup(
    idOrPrefix: string,
    message: string,
    options: {
      steer?: boolean;
      provider?: Provider | null;
      model?: string | null;
      /** Change tier for this and later turns (escalate or step down). */
      tier?: Tier | null;
      effort?: string | null;
      reason?: string | null;
      userApproved?: boolean;
      /** Only ask for uploads: same agent and model, and the task keeps its review and ready state. */
      evidenceOnly?: boolean;
      /** Only run the checks, send nothing (a move to another size checks its follow-up first; sizes). */
      dryRun?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<Task> {
    const settings = await this.settings();
    // A chat that just finished may not be recorded yet.
    const task = await this.refreshChatTask(idOrPrefix);
    if (message.trim() === "") throw new TaskError("The follow-up message is empty.", "invalid_task");
    this.sizes.assertCanFollowup(task); // sizes
    if (options.evidenceOnly) return this.evidenceFollowup(task, message, options);
    if (task.status === "starting") {
      throw new TaskError(
        `Task ${task.id} is still being dispatched.`,
        "task_starting",
        "Wait for its [boat] message (or `bb boat task show`) before sending a follow-up; do not start a duplicate task.",
      );
    }
    if (task.status === "done" || task.status === "cancelled") {
      throw new TaskError(`Task ${task.id} is ${task.status}.`, "task_closed", "Start a new task, or reopen work with a new brief.");
    }
    const isChat = task.runner === "chat";
    if (isChat ? task.threadId === null : task.sandboxId === null || task.conversationId === null || task.promptId === null) {
      throw new TaskError(`Task ${task.id} never reached its agent; start a new task instead.`, "task_not_dispatched");
    }
    if (isChat && this.hooks.chat === undefined) {
      throw new TaskError(`Task ${task.id} is a bb chat; open it to continue.`, "chat_unavailable");
    }
    if (task.status === "running") {
      if (options.steer !== true) {
        throw new TaskError(
          `Task ${task.id} is still running.`,
          "task_running",
          "Wait for it to finish, or pass --steer to redirect the running turn.",
        );
      }
      // A steer only redirects the running turn; it can't switch model or agent.
      const changes = [
        options.tier ? "model preset" : null,
        options.effort?.trim() ? "effort" : null,
        options.model?.trim() ? "model" : null,
        options.provider && options.provider !== task.provider ? "agent" : null,
      ].filter((change): change is string => change !== null);
      if (changes.length > 0) {
        throw new TaskError(
          `A steer only redirects the running turn of ${task.id}; it can't change ${changes.join(", ")}.`,
          "steer_cannot_change",
          "Steer without those options, or wait for the turn to finish (or interrupt it) and send a follow-up with the new model preset or agent.",
        );
      }
      if (isChat) await this.hooks.chat!.send(task.threadId!, message, { steer: true });
      else await this.boat.steer(task.sandboxId!, task.conversationId!, message, options.signal);
      this.store.addEvent(task.id, "steered", clip(message, 2000));
      this.hooks.changed([task.id]);
      return this.store.get(task.id) ?? task;
    }
    // Pushing a branch or posting on a PR needs the sandbox's GitHub login.
    const needsGithub = task.delivery === "pr" && task.repo !== null;
    // A worker chat's machine is woken by the follow-up anyway: wake it now to check its login.
    if (needsGithub && options.dryRun !== true) await this.assertGithubLogin(task, { signal: options.signal, resume: task.runner === "chat" });
    // With one agent (Coding agents), the follow-up runs on it, with a note.
    const only = onlyAgent(settings.agents);
    // An agent at its switch point hands the follow-up to the other one (when
    // that one has room), unless an agent was asked for (by name, a model,
    // or an effort level only it has).
    const namesAgent =
      options.provider != null || (options.model?.trim() ?? "") !== "" || effortAgent(options.effort?.trim() || null) !== null;
    const roomy = namesAgent ? null : await this.agentWithRoomFor(task, settings);
    const wanted = options.provider ?? roomy?.provider ?? task.provider;
    const provider = only ?? wanted;
    const agentNote =
      only !== null && wanted !== only
        ? `Only ${AGENT_NAME[only]} is set up (Coding agents), so ${AGENT_NAME[only]} continues instead of ${AGENT_NAME[wanted]}`
        : null;
    // A model or effort level for the missing agent doesn't apply.
    const askedModel = options.model?.trim() || "";
    const modelOption = only !== null && askedModel !== "" && (modelAgent(askedModel) ?? options.provider ?? only) !== only ? "" : askedModel;
    const effortOption = agentNote === null || (effortAgent(options.effort?.trim() || null) ?? provider) === provider ? options.effort?.trim() || "" : "";
    const previousTier = isTier(task.tier) ? task.tier : null;
    const tier = options.tier ?? previousTier;
    // Same agent and tier: keep what the task ran with. A new agent or tier
    // takes that tier's model and effort; without a tier, the old rules.
    const unchanged = provider === task.provider && tier === previousTier;
    const choice = tier === null ? null : choiceFor(settings.modelTiers, tier, provider);
    const model = agentModel(
      task.runner,
      provider,
      modelOption ||
        (unchanged ? task.model : (choice?.model ?? (provider === task.provider ? task.model : defaultModelFor(provider, settings)))),
    );
    // An effort level is model-specific: without a tier, keep it only on the same agent.
    const reasoningEffort = agentEffort(
      task.runner,
      provider,
      effortOption ||
        (unchanged ? task.reasoningEffort : (choice?.effort ?? (provider === task.provider ? task.reasoningEffort : null))),
    );
    // A task already running approved Frontier·max keeps that approval while
    // it continues unchanged; raising a task to it needs a new OK.
    const keepsApproval =
      model === task.model &&
      reasoningEffort === task.reasoningEffort &&
      this.store.latestEvent(task.id, "approval") !== null;
    assertFrontierAllowed(settings.modelTiers, tier, model, reasoningEffort, options.userApproved === true || keepsApproval);
    if (options.dryRun === true) return task;
    const newlyApproved =
      options.userApproved === true && !keepsApproval && needsFrontierApproval(settings.modelTiers, tier, model, reasoningEffort);
    const reason = options.reason?.trim()
      ? clip(options.reason.trim().replace(/\s+/g, " "), 300)
      : tier === previousTier
        ? task.reason
        : null;
    const enteringDeep = tier === "deep" && (previousTier !== "deep" || provider !== task.provider);
    if (isChat) {
      const updated = await this.followupChat(task, message, {
        provider,
        model,
        reasoningEffort,
        tier,
        reason,
        enteringDeep,
        // bb keeps the chat's own model unless this turn changes it.
        changesModel: !unchanged || Boolean(modelOption) || Boolean(effortOption),
      });
      if (newlyApproved) this.store.addEvent(task.id, "approval", "Frontier at max effort, approved by the user (follow-up)");
      if (agentNote !== null) this.store.addEvent(task.id, "agent", agentNote);
      if (roomy !== null && provider === roomy.provider) this.store.addEvent(task.id, "agent", roomy.note);
      if (!unchanged || modelOption || effortOption) {
        this.store.addEvent(
          task.id,
          "model",
          `${provider === task.provider ? "" : `${task.provider} → ${provider} · `}${modelLine(tier, model, reasoningEffort, reason)}`,
        );
      }
      this.store.addEvent(task.id, provider === task.provider ? "followup" : "followup-switch", clip(provider === task.provider ? message : `(${task.provider} → ${provider}) ${message}`, 2000));
      this.hooks.changed([task.id]);
      return updated;
    }
    const release = this.claim(task.sandboxId!);
    try {
      this.sizes.assertCanFollowup(task); // sizes
      await this.ensureRunning(task.sandboxId!, options.signal);
      // Now that the sandbox is up, its login can be asked directly.
      if (needsGithub) await this.assertGithubLogin(task, { signal: options.signal });
      const note = await this.resumeNoteFor(task.id);
      const dispatch = await this.boat.prompt({
        sandboxId: task.sandboxId!,
        conversationId: task.conversationId!,
        // A new agent on a Deep task gets the working mode for its own tools.
        prompt: this.withNote(
          note,
          composeFollowupPrompt(task.role, message, {
            enteringDeep,
            provider,
            evidence: this.hasEvidence(task.id),
            delivery: task.delivery,
            sandboxNote: this.sizes.followupNote(task),
          }),
        ),
        provider,
        model,
        reasoningEffort,
        signal: options.signal,
      });
      const updated = this.store.transition(
        task.id,
        ["idle", "failed"],
        {
          status: "running",
          promptId: dispatch.promptId,
          provider,
          model: dispatch.model ?? model,
          reasoningEffort,
          tier,
          reason,
          turns: task.turns + 1,
          error: null,
          finishedAt: null,
          notifiedAt: null,
          readyAt: null,
          readyNote: null,
        },
        // A move to a chat (or another turn) that landed meanwhile wins.
        { promptId: task.promptId },
      );
      if (updated === null) {
        await this.boat.interrupt(task.sandboxId!, task.conversationId!).catch(() => undefined);
        throw new TaskError(`Task ${task.id} changed while the follow-up was being sent.`, "task_changed");
      }
      this.sizes.noteSent(task.id); // sizes
      this.noteSent(task.id, note);
      if (newlyApproved) this.store.addEvent(task.id, "approval", "Frontier at max effort, approved by the user (follow-up)");
      this.markChangedSinceReview(task);
      if (agentNote !== null) this.store.addEvent(task.id, "agent", agentNote);
      if (roomy !== null && provider === roomy.provider) this.store.addEvent(task.id, "agent", roomy.note);
      if (!unchanged || modelOption || effortOption) {
        this.store.addEvent(
          task.id,
          "model",
          `${provider === task.provider ? "" : `${task.provider} → ${provider} · `}${modelLine(tier, dispatch.model ?? model, reasoningEffort, reason)}`,
        );
      }
      this.store.addEvent(task.id, provider === task.provider ? "followup" : "followup-switch", clip(provider === task.provider ? message : `(${task.provider} → ${provider}) ${message}`, 2000));
      this.hooks.changed([task.id]);
      return updated;
    } finally {
      release();
    }
  }

  /**
   * The other agent, when the task's agent is at its switch point (the relay's
   * readings) and the other one has room: null otherwise. Only with both
   * agents and switching on limits on (autoFailover).
   */
  private async agentWithRoomFor(task: Task, settings: BoatSettings): Promise<{ provider: Provider; note: string } | null> {
    if (!settings.autoFailover || onlyAgent(settings.agents) !== null || this.hooks.quotas === undefined) return null;
    const other = otherAgent(task.provider);
    if (settings.notConnectedAgents.includes(other)) return null;
    const quotas = await this.hooks.quotas.read().catch(() => null);
    const own = quotas?.get(task.provider);
    if (quotas == null || own === undefined || own.usedPercent < settings.relay.switchAtPercent) return null;
    if (agentWithRoom(task.provider, quotas, settings.relay.switchAtPercent, settings.agents) !== other) return null;
    return {
      provider: other,
      note: `${AGENT_NAME[task.provider]} is at ${Math.round(own.usedPercent)}% of its limit; continued with ${AGENT_NAME[other]}`,
    };
  }

  /**
   * "Upload your screenshots": a turn that changes no code, so the task keeps
   * its ready mark and its review stays current.
   */
  private async evidenceFollowup(
    task: Task,
    message: string,
    options: { steer?: boolean; provider?: Provider | null; model?: string | null; tier?: Tier | null; effort?: string | null; signal?: AbortSignal },
  ): Promise<Task> {
    if (task.status === "done" || task.status === "cancelled") throw new TaskError(`Task ${task.id} is ${task.status}.`, "task_closed");
    if (task.status !== "idle" && task.status !== "failed") {
      throw new TaskError(`Task ${task.id} is ${task.status}.`, "task_running", "Ask for the uploads once its turn has finished.");
    }
    if ((options.provider && options.provider !== task.provider) || options.tier || options.model?.trim() || options.effort?.trim() || options.steer) {
      throw new TaskError("An evidence-only follow-up keeps the task's agent, model and model preset.", "invalid_value", "Send it without those options.");
    }
    if (!this.hasEvidence(task.id)) {
      throw new TaskError(
        `Task ${task.id}'s sandbox has no evidence-upload.`,
        "evidence_unavailable",
        "It started before uploads were set up, or uploads are off (Settings → Plugins → Boat Cloud Agents → Setup → Screenshots and recordings).",
      );
    }
    const isChat = task.runner === "chat";
    if (isChat ? task.threadId === null || this.hooks.chat === undefined : task.sandboxId === null || task.conversationId === null) {
      throw new TaskError(`Task ${task.id} never reached its agent.`, "task_not_dispatched");
    }
    const running = { status: "running" as const, turns: task.turns + 1, error: null, finishedAt: null, notifiedAt: null };
    if (isChat) {
      const marker = chatTurnMarker();
      this.sizes.assertCanFollowup(task); // sizes
      const claimed = this.store.transition(task.id, ["idle", "failed"], { ...running, promptId: marker });
      if (claimed === null) throw new TaskError(`Task ${task.id} changed while the follow-up was being sent.`, "task_changed");
      if (task.hostId !== null) this.suspendedHosts.delete(task.hostId);
      try {
        const note = await this.resumeNoteFor(task.id);
        await this.hooks.chat!.send(task.threadId!, this.withNote(note, composeEvidencePrompt(task.role, message, "chat")), { steer: false });
        this.noteSent(task.id, note);
      } catch (error) {
        this.store.transition(
          task.id,
          ["running"],
          { status: task.status, promptId: task.promptId, turns: task.turns, error: task.error, finishedAt: task.finishedAt, notifiedAt: task.notifiedAt },
          { promptId: marker },
        );
        throw error;
      }
      this.store.addEvent(task.id, "followup", clip(`(evidence only) ${message}`, 2000));
      this.hooks.changed([task.id]);
      return claimed;
    }
    const release = this.claim(task.sandboxId!);
    try {
      this.sizes.assertCanFollowup(task); // sizes
      await this.ensureRunning(task.sandboxId!, options.signal);
      const note = await this.resumeNoteFor(task.id);
      const dispatch = await this.boat.prompt({
        sandboxId: task.sandboxId!,
        conversationId: task.conversationId!,
        prompt: this.withNote(note, composeEvidencePrompt(task.role, message, "boat")),
        provider: task.provider,
        model: task.model,
        reasoningEffort: task.reasoningEffort,
        signal: options.signal,
      });
      const updated = this.store.transition(task.id, ["idle", "failed"], { ...running, promptId: dispatch.promptId });
      if (updated === null) {
        await this.boat.interrupt(task.sandboxId!, task.conversationId!).catch(() => undefined);
        throw new TaskError(`Task ${task.id} changed while the follow-up was being sent.`, "task_changed");
      }
      this.noteSent(task.id, note);
      this.store.addEvent(task.id, "followup", clip(`(evidence only) ${message}`, 2000));
      this.hooks.changed([task.id]);
      return updated;
    } finally {
      release();
    }
  }

  /** The note for the worker's next prompt after a stop that cut off its background work (null: none). */
  private async resumeNoteFor(taskId: string): Promise<string | null> {
    return (await this.hooks.resumeNote?.peek(taskId).catch(() => null)) ?? null;
  }

  /** The prompt with the note first. */
  private withNote(note: string | null, prompt: string): string {
    return note === null ? prompt : `${note}\n\n${prompt}`;
  }

  /** The note went out: the next prompt goes without it. */
  private noteSent(taskId: string, note: string | null): void {
    if (note !== null) void this.hooks.resumeNote?.sent(taskId).catch(() => undefined);
  }

  /** A follow-up in the worker's chat; another agent means a new chat in the same workspace. */
  private async followupChat(
    task: Task,
    message: string,
    next: {
      provider: Provider;
      model: string | null;
      reasoningEffort: string | null;
      tier: Tier | null;
      reason: string | null;
      enteringDeep: boolean;
      changesModel: boolean;
    },
  ): Promise<Task> {
    const chat = this.hooks.chat!;
    // Claim the turn first, so the monitor treats what follows as this turn.
    const marker = chatTurnMarker();
    this.sizes.assertCanFollowup(task); // sizes
    const claimed = this.store.transition(task.id, ["idle", "failed"], {
      status: "running",
      promptId: marker,
      provider: next.provider,
      model: next.model,
      reasoningEffort: next.reasoningEffort,
      tier: next.tier,
      reason: next.reason,
      turns: task.turns + 1,
      error: null,
      finishedAt: null,
      notifiedAt: null,
      readyAt: null,
      readyNote: null,
    });
    if (claimed === null) throw new TaskError(`Task ${task.id} changed while the follow-up was being sent.`, "task_changed");
    if (task.hostId !== null) this.suspendedHosts.delete(task.hostId);
    this.markChangedSinceReview(task);
    try {
      if (next.provider !== task.provider) {
        const threadId = await this.openHandoverChat(task, { ...next, why: "switch", message });
        // The handover names the sandbox's size (sizes).
        this.sizes.noteSent(task.id);
        await chat.stop(task.threadId!).catch(() => undefined);
        return this.store.update(task.id, { threadId }) ?? claimed;
      }
      const note = await this.resumeNoteFor(task.id);
      await chat.send(
        task.threadId!,
        this.withNote(
          note,
          composeFollowupPrompt(task.role, message, {
            enteringDeep: next.enteringDeep,
            provider: next.provider,
            runner: "chat",
            effort: next.reasoningEffort,
            evidence: this.hasEvidence(task.id),
            delivery: task.delivery,
            sandboxNote: this.sizes.followupNote(task),
          }),
        ),
        { steer: false, ...(next.changesModel ? { model: next.model, effort: next.reasoningEffort } : {}) },
      );
      this.sizes.noteSent(task.id); // sizes
      this.noteSent(task.id, note);
      return claimed;
    } catch (error) {
      // Nothing was sent: put the task back as it was.
      this.store.transition(
        task.id,
        ["running"],
        {
          status: task.status,
          promptId: task.promptId,
          provider: task.provider,
          model: task.model,
          reasoningEffort: task.reasoningEffort,
          tier: task.tier,
          reason: task.reason,
          turns: task.turns,
          error: task.error,
          finishedAt: task.finishedAt,
          notifiedAt: task.notifiedAt,
          readyAt: task.readyAt,
          readyNote: task.readyNote,
        },
        { promptId: marker },
      );
      throw error;
    }
  }

  /**
   * No turn has ended since the plugin opened the task's current chat (its
   * "chat" event): the chat has no earlier answer to compare with.
   */
  private firstTurnInChat(task: Task): boolean {
    if (task.threadId === null) return false;
    const events = this.store.events(task.id, 200);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (event.kind === "finished") return false;
      if (event.kind === "chat" && event.text === task.threadId) return true;
    }
    return false;
  }

  /** bb chats keep one agent: a handover opens a new chat in the task's workspace. */
  private async openHandoverChat(
    task: Task,
    next: {
      provider: Provider;
      model: string | null;
      reasoningEffort: string | null;
      tier: Tier | null;
      /** from-boat: the move's read-up turn hit a usage limit; the next agent reads up instead. */
      why: "usage-limit" | "switch" | "from-boat";
      message: string | null;
    },
  ): Promise<string> {
    let environmentId = task.environmentId;
    if (environmentId === null && task.threadId !== null) {
      environmentId = (await this.hooks.chat!.state(task.threadId).catch(() => null))?.environmentId ?? null;
      if (environmentId !== null) this.store.update(task.id, { environmentId });
    }
    if (environmentId === null) {
      throw new TaskError(`Task ${task.id}'s workspace is unknown, so another agent can't join it.`, "task_not_dispatched", "Start a new task.");
    }
    const settings = await this.settings();
    const { extraProtectedBranches } = settings;
    const fromBoat =
      next.why === "from-boat"
        ? {
            latestReport: task.result ? clipResult(task.result, 8_000) : null,
            extraInstructions: this.standingInstructions(task, settings),
          }
        : {};
    // A new agent in the same sandbox: a stop that cut off background work concerns it too.
    const note = await this.resumeNoteFor(task.id);
    const spawned = await this.hooks.chat!.spawn({
      taskId: task.id,
      title: task.title,
      prompt: this.withNote(note, composeHandoverPrompt({
        ...fromBoat,
        taskId: task.id,
        role: task.role,
        title: task.title,
        brief: task.brief,
        workspace: this.handoverWorkspace(task, extraProtectedBranches),
        // A task that moved from boat: its headless conversation stays readable.
        transcriptPath: this.store.latestEvent(task.id, "moved-to-chat") !== null ? transcriptPath(task.id) : null,
        fromProvider: task.provider,
        fromThreadId: task.threadId,
        why: next.why,
        message: next.message,
        tier: next.tier,
        provider: next.provider,
        effort: next.reasoningEffort,
        evidence: this.hasEvidence(task.id),
        sandboxLine: this.sizes.lineFor(task, "chat"),
      })),
      provider: next.provider,
      model: next.model,
      effort: next.reasoningEffort,
      parentThreadId: task.orchestratorThreadId,
      projectId: task.projectId,
      where: { kind: "environment", environmentId },
    });
    this.noteSent(task.id, note);
    this.store.addEvent(task.id, "chat", spawned.threadId);
    this.recordChat(task.id, spawned.threadId, next.provider, next.model, next.reasoningEffort);
    return spawned.threadId;
  }

  /** The settings' and the project's standing instructions for a task's agent. */
  private standingInstructions(task: Task, settings: BoatSettings): string {
    return [settings.workerInstructions, ...(this.hooks.projectInstructions?.(task.boatProject, task.repo) ?? [])].filter((part) => part.trim() !== "").join("\n\n");
  }

  /** Where a task's code is, for a chat that takes it over (a handover, a move from boat). */
  private handoverWorkspace(task: Task, extraProtected: string[]): WorkspaceInfo {
    return {
      repo: task.repo,
      repoPath: task.repoPath,
      branch: task.branch,
      baseBranch: task.baseBranch,
      prUrl: task.prUrl,
      extraRepos: task.extraRepos.filter((extra): extra is { repo: string; baseBranch: string; path: string } => typeof extra.path === "string"),
      protectedBranches: protectedBranches(
        null,
        [task.baseBranch, ...task.extraRepos.map((extra) => extra.baseBranch), ...this.projectBaseBranches([task.repo, ...task.extraRepos.map((extra) => extra.repo)])],
        alwaysProtectedBranches(extraProtected),
      ),
      delivery: task.delivery,
    };
  }

  /** A new turn on reviewed work: the old verdict no longer covers it. */
  private markChangedSinceReview(task: Task): void {
    if (task.role !== "implement") return;
    const last = this.store.latestEvent(task.id, "review");
    if (last === null || /^Changed since/.test(last.text)) return;
    this.store.addEvent(task.id, "review", "Changed since the last review");
  }

  /** Remove a task's machine (and so its sandbox) when no other open task uses it. */
  private async removeMachineIfUnused(task: Task): Promise<"deleted" | "kept" | "none"> {
    if (task.hostId === null || this.hooks.chat === undefined) return "none";
    const shared =
      this.store.list({ statuses: OPEN_STATUSES, limit: 1000 }).some((other) => other.id !== task.id && other.hostId === task.hostId) ||
      (task.sandboxId !== null && this.store.liveSandboxTasks(task.sandboxId).some((other) => other.id !== task.id));
    if (shared) return "kept";
    try {
      // A moved task's machine may still carry the keep flag (a restart between the switch and the settle).
      if (this.store.latestEvent(task.id, "moved-to-chat") !== null) {
        const key = await this.hooks.chat.machineKey(task.hostId).catch(() => null);
        if (key !== null) await this.hooks.chat.settleMachine(key);
      }
      await this.hooks.chat.removeMachine(task.hostId);
      this.store.addEvent(task.id, "sandbox", `Removed bb machine ${task.hostId} and its sandbox ${task.sandboxId ?? ""}`.trim());
      return "deleted";
    } catch (error) {
      this.store.addEvent(task.id, "sandbox", `Couldn't remove bb machine ${task.hostId}: ${errorText(error)}`);
      return "kept";
    }
  }

  /** React to a bb thread event for a worker chat right away (the poll is the backstop). */
  async syncChatThread(threadId: string, hint: ChatHint): Promise<void> {
    if (this.hooks.chat === undefined) return;
    const task = this.store.byThread(threadId);
    // Only the task's current chat counts (an old handover chat is history).
    if (task === null || task.runner !== "chat" || task.threadId !== threadId) return;
    if (task.status === "starting" || task.status === "done" || task.status === "cancelled") return;
    if (await this.syncChat(task, Date.now(), hint)) {
      this.hooks.changed([task.id]);
      await this.deliverPending();
    }
  }

  /** Bring a chat task up to date before acting on its status. */
  async refreshChatTask(idOrPrefix: string): Promise<Task> {
    const task = this.mustGet(idOrPrefix);
    if (task.runner === "chat" && task.threadId !== null && task.status === "running" && this.hooks.chat !== undefined) {
      if (await this.syncChat(task, Date.now())) this.hooks.changed([task.id]);
    }
    return this.store.get(task.id) ?? task;
  }

  /**
   * Stop, resume or delete a sandbox by hand. A worker chat's sandbox is a bb
   * machine: those go through bb, or bb's view of the machine breaks.
   */
  private environmentCacheByName = new Map<string, { at: number; info: Promise<EnvironmentInfo>; ok: boolean }>();

  /**
   * A boat environment's setup (secret NAMES only): cached for five minutes,
   * a failure for one; callers at the same time share one boat call.
   */
  environmentInfo(name: string, signal?: AbortSignal): Promise<EnvironmentInfo> {
    const hit = this.environmentCacheByName.get(name);
    if (hit && Date.now() - hit.at < (hit.ok ? 5 * 60_000 : 60_000)) return hit.info;
    const entry = { at: Date.now(), info: this.boat.environmentInfo(name, signal), ok: true };
    entry.info.catch(() => {
      entry.ok = false;
    });
    this.environmentCacheByName.set(name, entry);
    return entry.info;
  }

  private aiProxyCache: { at: number; value: Promise<AiProxyState | null>; known: boolean } | null = null;

  /** The account's AI credentials proxy and its price (null: couldn't tell): cached like an environment, unknown for one minute. */
  private aiProxy(signal?: AbortSignal): Promise<AiProxyState | null> {
    const hit = this.aiProxyCache;
    if (hit && Date.now() - hit.at < (hit.known ? 5 * 60_000 : 60_000)) return hit.value;
    const entry = { at: Date.now(), value: this.boat.aiProxy(signal).catch(() => null), known: true };
    void entry.value.then((value) => {
      entry.known = value !== null && value.enabled !== null;
    });
    this.aiProxyCache = entry;
    return entry.value;
  }

  /**
   * What a project's workers can reach: per repo, boat's GitHub access (the
   * last check inside a sandbox, and the environment's listing), the
   * environment's secret names, and what else it passes in (boat
   * credentials, real AI keys or placeholders).
   */
  async projectAccess(project: Pick<OrchestratorProject, "repos" | "environment">, signal?: AbortSignal): Promise<ProjectAccess> {
    const settings = await this.settings();
    let environment = project.environment || settings.environment || null;
    let info: EnvironmentInfo | null = null;
    let error: string | null = null;
    const accountProxy = this.aiProxy(signal);
    try {
      // No environment named: boat uses its default one.
      if (environment === null) environment = await this.boat.defaultEnvironment(signal);
      if (environment !== null) info = await this.environmentInfo(environment, signal);
      else error = "boat has no default environment";
    } catch (failure) {
      error = errorText(failure);
    }
    const proxied = info?.safeForThirdParties === true && info.proxyAiCredentials === true;
    const account = await accountProxy;
    return {
      environment,
      error,
      secretNames: info?.secretNames ?? [],
      secretFiles: info?.secretFiles ?? [],
      passGithub: info?.passGithub ?? null,
      passSecrets: info?.passSecrets ?? null,
      passAgentsCredentials: info?.passAgentsCredentials ?? null,
      passSandboxCredentials: info?.passSandboxCredentials ?? null,
      proxyAiCredentials: info?.proxyAiCredentials ?? null,
      aiProxy: proxied ? true : (account?.enabled ?? null),
      aiProxyPrice: account === null ? null : aiProxyPrice(account),
      repos: project.repos.map((entry) => {
        const listed = info?.repos.find((repo) => repo.repo.toLowerCase() === entry.repo.toLowerCase());
        const checked = this.store.repoAccess(entry.repo);
        return {
          repo: entry.repo,
          baseBranch: entry.baseBranch,
          environmentPermission: listed?.permission ?? null,
          lastCheck: checked,
        };
      }),
    };
  }

  /** Save a sandbox's state under a name, for `--from` (a project's snapshot). */
  async saveSnapshot(sandboxId: string, name: string, signal?: AbortSignal): Promise<{ name: string; sizeBytes: number | null }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)) {
      throw new TaskError(`"${name}" isn't a snapshot name.`, "invalid_value", "Use letters, digits, dots, dashes and underscores (up to 80).");
    }
    this.sizes.assertSandboxNotResizing(sandboxId); // sizes
    // A bb machine's disk holds bb's login for this server: a snapshot of it would
    // carry that into every sandbox started from it, untrusted repos' included.
    if (await this.sandboxHasBb(sandboxId)) {
      throw new TaskError(
        `Sandbox ${sandboxId} runs bb (a task chat's or orchestrator's machine), so it can't be a snapshot.`,
        "invalid_value",
        "Snapshot a plain sandbox (`bb boat sandbox new`, set it up, then snapshot it).",
      );
    }
    try {
      return await this.boat.snapshot(sandboxId, name, signal);
    } catch (error) {
      throw snapshotError(error, name) ?? error;
    }
  }

  async snapshots(signal?: AbortSignal) {
    try {
      return await this.boat.snapshots(signal);
    } catch (error) {
      throw snapshotError(error, null) ?? error;
    }
  }

  async sandboxAction(sandboxId: string, action: "stop" | "resume" | "delete", ttlSeconds: number, signal?: AbortSignal): Promise<void> {
    if (this.isMovingSandbox(sandboxId)) {
      throw new TaskError(`A task is moving to a task chat in sandbox ${sandboxId}.`, "task_busy", "Try again once the chat is open (in about a minute).");
    }
    this.sizes.assertSandboxNotResizing(sandboxId); // sizes
    const hostId = this.hooks.chat === undefined ? null : this.store.hostForSandbox(sandboxId);
    if (hostId === null) {
      if (action === "stop") await this.boat.stop(sandboxId, signal);
      else if (action === "resume") await withinAutoStopCap(ttlSeconds, (ttl) => this.boat.resume(sandboxId, ttl, signal));
      else await this.boat.delete(sandboxId, signal);
      return;
    }
    const chat = this.hooks.chat!;
    if (action === "stop") {
      await chat.suspendMachine(hostId);
      this.suspendedHosts.add(hostId);
      this.hooks.machineSuspended?.(hostId, false);
    } else if (action === "resume") {
      await chat.resumeMachine(hostId);
      this.suspendedHosts.delete(hostId);
      this.store.resetPreviewHealthForSandbox(sandboxId);
    } else {
      for (const task of this.store.liveSandboxTasks(sandboxId)) {
        for (const threadId of this.store.chatThreads(task.id)) await chat.archive(threadId).catch(() => undefined);
      }
      await chat.removeMachine(hostId);
    }
  }

  /**
   * Another chat in a worker's workspace, composed in bb's own composer (any
   * agent and model): it shares the checkout and sits next to the worker's chat.
   */
  async openWorkspaceChat(idOrPrefix: string, request: ComposerRequest): Promise<string> {
    const chat = this.hooks.chat;
    const task = this.mustGet(idOrPrefix);
    if (chat === undefined || task.runner !== "chat" || task.threadId === null) {
      throw new TaskError(`Task ${task.id} has no task chat.`, "not_a_worker");
    }
    if (task.status === "done" || task.status === "cancelled") {
      throw new TaskError(`Task ${task.id} is ${task.status}; its workspace may be gone.`, "task_closed", "Start a new task instead.");
    }
    let environmentId = task.environmentId;
    if (environmentId === null) {
      environmentId = (await chat.state(task.threadId).catch(() => null))?.environmentId ?? null;
      if (environmentId !== null) this.store.update(task.id, { environmentId });
    }
    if (environmentId === null) throw new TaskError(`Task ${task.id}'s workspace isn't ready yet.`, "task_not_dispatched", "Try again in a moment.");
    const { threadId } = await chat.spawnComposed({
      taskId: task.id,
      request,
      parentThreadId: task.orchestratorThreadId,
      projectId: task.projectId,
      environmentId,
    });
    this.recordWorkspaceChat(task, threadId, request.providerId, request.model, request.reasoningLevel);
    return threadId;
  }

  /**
   * A chat someone opened in a worker's workspace with bb's own "+" (the
   * sidebar's workspace row): it becomes part of the task and nests under the
   * orchestrator like the others.
   */
  async adoptWorkspaceChat(thread: { id: string; environmentId: string | null; providerId: string | null; parentThreadId: string | null }): Promise<boolean> {
    if (this.hooks.chat === undefined || thread.environmentId === null) return false;
    const task = this.store.taskByEnvironment(thread.environmentId);
    if (task === null || this.store.byThread(thread.id) !== null || thread.id === task.orchestratorThreadId) return false;
    this.recordWorkspaceChat(task, thread.id, thread.providerId, null, null);
    if (thread.parentThreadId === null && task.orchestratorThreadId !== null) {
      await this.hooks.chat.adopt(thread.id, task.orchestratorThreadId).catch((error) => this.hooks.log.warn(`adopt ${thread.id}: ${errorText(error)}`));
    }
    return true;
  }

  private recordWorkspaceChat(task: Task, threadId: string, providerId: string | null, model: string | null, effort: string | null): void {
    const provider: Provider | null = providerId === "codex" ? "codex" : providerId === "claude-code" ? "claude" : null;
    this.store.addEvent(task.id, "chat-extra", threadId);
    if (provider !== null) this.recordChat(task.id, threadId, provider, model, effort);
    this.hooks.changed([task.id]);
  }

  /**
   * Standing instructions for a chat in a worker's workspace (not the
   * worker's own chat, whose brief says it all): where the code is, and that
   * other agents work there too.
   */
  workspaceInstructions(environmentId: string, threadId: string): string | null {
    const task = this.store.taskByEnvironment(environmentId);
    if (task === null || task.threadId === threadId) return null;
    const safe = (text: string | null) => (text ?? "").replace(/[`\n\r]/g, " ").slice(0, 200);
    const lines = [
      `You're in the workspace of the boat task ${task.id} "${safe(task.title)}", in a boat.dev cloud sandbox.`,
      task.repoPath ? `- The checkout is at ${safe(task.repoPath)}${task.branch ? `, on the branch ${safe(task.branch)}` : ""}${task.baseBranch ? ` (base ${safe(task.baseBranch)})` : ""}. Work there.` : null,
      task.threadId ? `- Another agent works here too (the task chat, @thread:${task.threadId}). Don't switch its branch or push to it unless asked; push your own branch if you change code.` : null,
      "- Never push to a base branch or merge pull requests; a git hook refuses such pushes.",
      this.hasEvidence(task.id)
        ? "- The sandbox is deleted when the task closes: upload screenshots and recordings you make with `evidence-upload <files or folders> --name <short label>` and share the links it prints, never sandbox paths."
        : null,
    ];
    return lines.filter(Boolean).join("\n");
  }

  /** Which agent, model and effort a chat of the task started with (for the workspace strip). */
  private recordChat(taskId: string, threadId: string, provider: Provider, model: string | null, effort: string | null): void {
    this.store.addEvent(taskId, "chat-info", JSON.stringify({ threadId, provider, model, effort }));
  }

  /** The agent, model and effort each of a task's chats started with. */
  chatInfo(taskId: string): Map<string, { provider: Provider; model: string | null; effort: string | null }> {
    const info = new Map<string, { provider: Provider; model: string | null; effort: string | null }>();
    for (const event of this.store.events(taskId, 500)) {
      if (event.kind !== "chat-info") continue;
      try {
        const parsed = JSON.parse(event.text) as { threadId?: string; provider?: Provider; model?: string | null; effort?: string | null };
        if (parsed.threadId && (parsed.provider === "claude" || parsed.provider === "codex")) {
          info.set(parsed.threadId, { provider: parsed.provider, model: parsed.model ?? null, effort: parsed.effort ?? null });
        }
      } catch {
        // Not ours.
      }
    }
    return info;
  }

  /** The orchestrator says this task's work is ready for the user to look at. */
  markReady(idOrPrefix: string, note: string): Task {
    const task = this.mustGet(idOrPrefix);
    if (task.status !== "idle") {
      throw new TaskError(
        `Task ${task.id} is ${task.status}; only a task whose turn finished can be ready for review.`,
        "task_not_idle",
        "Wait for its [boat] message, then mark it ready.",
      );
    }
    const updated = this.store.update(task.id, { readyAt: new Date().toISOString(), readyNote: clip(note.trim().replace(/\s+/g, " "), 300) || null }) ?? task;
    this.store.addEvent(task.id, "ready", note.trim() ? `Ready for review: ${clip(note.trim(), 300)}` : "Ready for review");
    this.hooks.changed([task.id]);
    return updated;
  }

  /** A worker chat's state, or null (no chat runner, or the chat is gone). */
  async chatState(threadId: string): Promise<{ status: string; updatedAt: number | null } | null> {
    return (await this.hooks.chat?.state(threadId).catch(() => null)) ?? null;
  }

  /** Stop a task's running turn (the task stays open). */
  async interruptTask(idOrPrefix: string, signal?: AbortSignal): Promise<Task> {
    const task = this.mustGet(idOrPrefix);
    if (task.runner === "chat") {
      if (task.threadId === null || this.hooks.chat === undefined) {
        throw new TaskError(`Task ${task.id} has no running chat.`, "task_not_dispatched");
      }
      await this.hooks.chat.stop(task.threadId);
    } else {
      if (task.sandboxId === null || task.conversationId === null) {
        throw new TaskError(`Task ${task.id} has no running conversation.`, "task_not_dispatched");
      }
      await this.boat.interrupt(task.sandboxId, task.conversationId, signal);
    }
    return task;
  }

  /** Build the input for a review of an implementation task (launch it with launchTask). */
  async reviewInput(
    implementationId: string,
    options: {
      brief?: string | null;
      provider?: Provider | null;
      model?: string | null;
      tier?: Tier | null;
      effort?: string | null;
      reason?: string | null;
      userApproved?: boolean;
      sandbox?: string | null;
      orchestratorThreadId?: string | null;
      projectId?: string | null;
      signal?: AbortSignal;
    } = {},
  ): Promise<StartTaskInput> {
    const settings = await this.settings();
    const parent = await this.refreshChatTask(implementationId);
    // A review started mid-move would reuse a sandbox that's half a machine.
    this.assertNotMoving(parent.id);
    if (parent.status === "running" || parent.status === "starting") {
      throw new TaskError(`Task ${parent.id} is still running.`, "task_running", "Review it after its turn finishes.");
    }
    // Cross-model review by default: if the implementer used the configured
    // review provider, switch to the other one.
    const provider =
      options.provider ??
      (parent.provider === settings.reviewProvider
        ? parent.provider === "claude"
          ? "codex"
          : "claude"
        : settings.reviewProvider);
    const brief =
      options.brief?.trim() ||
      `Review the implementation of "${parent.title}"${parent.prUrl ? ` in ${parent.prUrl}` : ""}${parent.branch ? ` on branch ${parent.branch}` : ""}. Focus on correctness, regressions, tests, and whether it fully does what the original task asked.`;
    return {
      title: `Review: ${parent.title}`,
      role: "review",
      brief,
      repo: parent.repo,
      branch: parent.branch,
      baseBranch: parent.baseBranch,
      pr: parent.prUrl,
      provider,
      flexibleAgent: options.provider == null,
      model: options.model ?? null,
      tier: options.tier ?? null,
      reasoningEffort: options.effort ?? null,
      reason: options.reason ?? null,
      userApproved: options.userApproved,
      // Unshipped commits live only in the implementer's sandbox: review them there.
      sandbox: reviewSandboxFor(parent, options.sandbox ?? null),
      parentTaskId: parent.id,
      orchestratorThreadId: options.orchestratorThreadId ?? parent.orchestratorThreadId,
      projectId: options.projectId ?? parent.projectId,
      signal: options.signal,
    };
  }

  // -------------------------------------------------------------------------
  // Continue as a chat: a headless task moves into a task chat

  /** A task's repos: its own and the other project repos it cloned. */
  private taskRepos(task: Task): string[] {
    return [task.repo, ...task.extraRepos.map((extra) => extra.repo)].filter((repo): repo is string => repo !== null);
  }

  /**
   * Every repo that ran in the task's sandbox: its own, then other tasks'
   * (closed ones too: what they left there stays when bb comes in).
   */
  private sandboxRepos(task: Task): string[] {
    const repos = this.taskRepos(task);
    const seen = new Set(repos.map((repo) => repo.toLowerCase()));
    for (const other of task.sandboxId === null ? [] : this.store.sandboxTasks(task.sandboxId)) {
      for (const repo of this.taskRepos(other)) {
        if (seen.has(repo.toLowerCase())) continue;
        seen.add(repo.toLowerCase());
        repos.push(repo);
      }
    }
    return repos;
  }

  /** The Untrusted repo badge: headless because the rules don't trust its repo, and bb was never installed on its sandbox. */
  untrustedRepo(task: Task): boolean {
    if (task.runner !== "boat" || this.store.latestEvent(task.id, "trust") === null) return false;
    return task.sandboxId === null || !this.store.sandboxHadBb(task.sandboxId);
  }

  /** bb was installed on this sandbox for a move (it may hold bb's files even after a rollback). */
  private bbWasInstalled(sandboxId: string): boolean {
    return this.store.sandboxHadBb(sandboxId);
  }

  /** The last try's failure text while nothing happened since (no new try, no new turn), else null. */
  private lastMoveFailure(taskId: string): string | null {
    const last = this.store
      .events(taskId, 200)
      .filter((event) => event.kind === "chat-move" || event.kind === "chat-move-failed" || event.kind === "failover" || HANDOVER_TURN_STARTS.has(event.kind))
      .at(-1);
    return last?.kind === "chat-move-failed" ? last.text : null;
  }

  /** Why the button isn't there at all (null: it is). */
  private moveHidden(task: Task): TaskError | null {
    if (this.hooks.chat === undefined) return new TaskError("This bb can't run task chats.", "chat_unavailable");
    if (task.runner === "chat") return new TaskError(`Task ${task.id} already runs as a task chat.`, "already_chat", "Open its chat.");
    if (task.status === "done" || task.status === "cancelled") return new TaskError(`Task ${task.id} is ${task.status}.`, "task_closed", "Start a new task instead.");
    if (task.status !== "starting" && (task.sandboxId === null || task.conversationId === null)) {
      return new TaskError(`Task ${task.id} never reached its agent.`, "task_not_dispatched", "Start a new task instead.");
    }
    return null;
  }

  /** The checks that need neither boat nor bb, in the order the user meets them. */
  private moveBlockerNow(task: Task): TaskError | null {
    const hidden = this.moveHidden(task);
    if (hidden !== null) return hidden;
    if (task.status === "starting") return new TaskError("The task is still starting.", "task_starting", "Wait for its first turn to end.");
    if (task.status === "running") return new TaskError("The agent's turn is running.", "task_running", "Wait for the turn to end, or Interrupt it.");
    if (this.moves.has(task.id)) return new TaskError(`Task ${task.id} is moving to a task chat.`, "task_busy", "It's open in about a minute.");
    if ((this.sending.get(task.id) ?? 0) > 0) return new TaskError("A follow-up is being sent to this task.", "task_busy", "Try again in a moment.");
    const sandboxId = task.sandboxId!;
    try {
      this.sizes.assertSandboxNotResizing(sandboxId, "Continue as a chat once the move to the new size is done."); // sizes
    } catch (error) {
      if (error instanceof TaskError) return error;
      throw error;
    }
    if (this.claims.has(sandboxId)) {
      return new TaskError("Something is using the task's sandbox right now (a ship, a preview or a follow-up).", "task_busy", "Try again in a moment.");
    }
    if (!this.store.pluginOwnsSandbox(sandboxId)) {
      return new TaskError(
        `Task ${task.id} runs in a sandbox the plugin didn't create, so bb isn't installed there.`,
        "sandbox_lent",
        `Start a new task as a chat instead (\`bb boat task start --chat --context-from ${task.id}\`).`,
      );
    }
    const other = this.store.liveSandboxTasks(sandboxId).find((entry) => entry.id !== task.id);
    if (other !== undefined) {
      return task.role === "review" && other.id === task.parentTaskId
        ? new TaskError(
            "A review that shares its task's sandbox can't move to a chat while that task is open.",
            "review_shares_sandbox",
            `Close task ${other.id} first, keeping its sandbox, then try again.`,
          )
        : new TaskError(`Task ${other.id} also works in this sandbox.`, "sandbox_shared", "Close it first, then try again.");
    }
    return null;
  }

  private async connectBlocker(): Promise<TaskError | null> {
    if (!this.hooks.connect) return null;
    const connect = await this.hooks.connect();
    if (connect.state !== "off") return null;
    return new TaskError("Task chats need bb Connect, which is off.", "connect_required", connect.fix ?? CONNECT_FIX);
  }

  /** What the sandbox says: gone, broken, or up (null: boat couldn't be read; the move itself will say). */
  private sandboxBlocker(task: Task, sandbox: Sandbox | null | undefined): TaskError | null {
    if (sandbox === null) {
      return new TaskError(`Task ${task.id}'s sandbox is gone.`, "sandbox_gone", `Start a new task; \`--context-from ${task.id}\` gives it this one's brief and report.`);
    }
    if (sandbox !== undefined && (sandbox.state === "error" || sandbox.state === "cancelled")) {
      return new TaskError(`Task ${task.id}'s sandbox is ${sandbox.state}.`, "sandbox_unavailable", "Start a new task instead.");
    }
    return null;
  }

  /**
   * The bb machine to reuse on the sandbox: the one the plugin knows (a kept
   * machine of a closed task chat), or this task's own from a try cut short.
   * Another one (an orchestrator's) is refused. null: none, attach one.
   */
  private async moveMachine(task: Task): Promise<{ hostId: string; key: string | null; own: boolean } | null> {
    const chat = this.hooks.chat!;
    const found = await chat.findMachine(task.sandboxId!);
    if (found === null) return null;
    const key = await chat.machineKey(found).catch(() => null);
    if (key?.startsWith(`task-${task.id}-m`)) return { hostId: found, key, own: true };
    if (found === this.store.machineForSandbox(task.sandboxId!)) return { hostId: found, key, own: false };
    throw new TaskError(
      `Sandbox ${task.sandboxId} already runs bb for another chat.`,
      "sandbox_runs_bb",
      `Start a new task as a chat instead (\`bb boat task start --chat --context-from ${task.id}\`).`,
    );
  }

  /** For the task's page: can it continue as a chat now, and what the dialog has to say. */
  async continueAsChatStatus(idOrPrefix: string, signal?: AbortSignal): Promise<ChatMoveStatus> {
    const task = this.mustGet(idOrPrefix);
    const settings = await this.settings();
    const trust = this.chatTrust(this.sandboxRepos(task), settings);
    const own = new Set(this.taskRepos(task).map((repo) => repo.toLowerCase()));
    const base = {
      untrusted: !trust.trusted,
      untrustedRepos: trust.untrustedRepos,
      otherRepos: trust.untrustedRepos.filter((repo) => !own.has(repo.toLowerCase())),
      workersBoat: trust.workersBoat,
      hasMachine: false,
      sandboxStopped: false,
      moving: this.moves.has(task.id),
      lastFailure: this.moves.has(task.id) ? null : this.lastMoveFailure(task.id),
    };
    // The page's words: no CLI flags in its fixes.
    const plain = (error: TaskError) => ({ code: error.code, message: error.message, hint: PAGE_MOVE_HINTS[error.code] ?? error.hint ?? null });
    const hidden = this.moveHidden(task);
    if (hidden !== null) return { ...base, offered: false, blocked: plain(hidden) };
    let blocked = this.moveBlockerNow(task) ?? (await this.connectBlocker());
    if (blocked !== null) return { ...base, offered: !MOVE_NEVER.has(blocked.code), blocked: plain(blocked) };
    const sandbox = await this.boat.findInfo(task.sandboxId!, signal).catch(() => undefined);
    blocked = this.sandboxBlocker(task, sandbox);
    let hasMachine = false;
    if (blocked === null) {
      try {
        hasMachine = (await this.moveMachine(task)) !== null;
      } catch (error) {
        if (error instanceof TaskError) blocked = error;
      }
    }
    return {
      ...base,
      // What won't change on its own (a sandbox the plugin didn't make, another chat's bb, a review in its task's sandbox): no button.
      offered: blocked === null || !MOVE_NEVER.has(blocked.code),
      blocked: blocked === null ? null : plain(blocked),
      hasMachine,
      sandboxStopped: sandbox !== null && sandbox !== undefined && !ACTIVE_STATES.has(sandbox.state),
    };
  }

  /**
   * Move a headless task into a task chat: bb on its sandbox (or the machine
   * already there), the conversation so far in a file outside the repo, and a
   * chat with the same agent in the same checkout. The quick checks throw
   * right away; the rest runs in the background like a launch: the caller
   * waits up to waitMs (or, with waitFor "checks", until the checks that ask
   * boat and bb have passed). Any failure leaves the task headless, with a
   * history note. confirmUntrusted: the repos the user was warned about.
   */
  async continueAsChat(
    idOrPrefix: string,
    options: {
      confirmUntrusted: string[] | null;
      via: "page" | "cli";
      waitMs: number;
      waitFor?: "checks" | "done";
      /** A failure after the caller stopped waiting. */
      onLateFailure?: (message: string) => void;
    },
  ): Promise<{ task: Task; pending: boolean }> {
    let task = this.mustGet(idOrPrefix);
    const settings = await this.settings();
    const now = this.moveBlockerNow(task);
    if (now !== null) throw now;
    // bb comes into a sandbox that's been used: what every task left there counts.
    const trust = this.chatTrust(this.sandboxRepos(task), settings);
    if (!confirmCovers(options.confirmUntrusted, trust)) throw this.untrustedRepoError(trust, "move", options.confirmUntrusted !== null, this.taskRepos(task));
    const connect = await this.connectBlocker();
    if (connect !== null) throw connect;
    // Every await is behind us: check again and take the task in one step.
    task = this.mustGet(task.id);
    const again = this.moveBlockerNow(task);
    if (again !== null) throw again;
    const controller = new AbortController();
    const onUnload = () => controller.abort();
    this.hooks.lifecycle.addEventListener("abort", onUnload, { once: true });
    const release = this.claim(task.sandboxId!);
    const entry = { controller, done: Promise.resolve() as Promise<unknown>, sandboxId: task.sandboxId! };
    this.moves.set(task.id, entry);
    this.store.addEvent(task.id, "chat-move", `Moving to a task chat (${options.via === "page" ? "asked on the Cloud agents page" : "from the CLI"})`);
    this.hooks.changed([task.id]);
    let checked: () => void = () => undefined;
    const checks = new Promise<void>((resolve) => {
      checked = resolve;
    });
    const id = task.id;
    const run = this.runMove(task, trust, options.via, controller.signal, () => checked()).finally(() => {
      release();
      this.hooks.lifecycle.removeEventListener("abort", onUnload);
      if (this.moves.get(id) === entry) this.moves.delete(id);
      this.hooks.changed([id]);
    });
    entry.done = run;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      run.then(
        (moved) => ({ kind: "done" as const, task: moved }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      ...(options.waitFor === "checks" ? [checks.then(() => ({ kind: "pending" as const }))] : []),
      new Promise<{ kind: "pending" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "pending" }), options.waitMs);
      }),
    ]);
    clearTimeout(timer);
    if (outcome.kind === "done") return { task: outcome.task, pending: false };
    if (outcome.kind === "error") throw outcome.error;
    run.catch((error: unknown) => options.onLateFailure?.(clip(errorText(error), 300)));
    return { task: this.store.get(id) ?? task, pending: true };
  }

  private async runMove(initial: Task, trust: ChatTrust, via: "page" | "cli", signal: AbortSignal, checked: () => void): Promise<Task> {
    const chat = this.hooks.chat!;
    const id = initial.id;
    const sandboxId = initial.sandboxId!;
    const conversationId = initial.conversationId!;
    /** A machine this try attached (undone on failure). */
    let attached: { hostId: string; key: string } | null = null;
    /** This task's machine from an earlier try (kept for the next one on failure). */
    let reusedOwn: string | null = null;
    /** A reused machine's key this move protected for its length. */
    let protectedKey: string | null = null;
    let spawnedThread: string | null = null;
    /** Why the move stopped being wanted (null: it still is). */
    const unwanted = (): MoveCancelled | null => {
      if (signal.aborted) return new MoveCancelled(signal.reason === "closed" ? "closed" : "unloaded");
      const current = this.store.get(id);
      if (current === null || current.status === "done" || current.status === "cancelled") return new MoveCancelled("closed");
      if (current.status === "running" || current.status === "starting" || current.promptId !== initial.promptId || current.runner !== "boat") return new MoveCancelled("changed");
      return null;
    };
    const stillWanted = () => {
      const why = unwanted();
      if (why !== null) throw why;
    };
    try {
      // 1. Checks that ask boat and bb.
      const sandbox = await this.boat.findInfo(sandboxId, signal);
      const gone = this.sandboxBlocker(initial, sandbox);
      if (gone !== null) throw gone;
      await this.hooks.preflight?.({ agent: initial.provider, runner: "chat", environment: initial.environment, newSandbox: false });
      const machine = await this.moveMachine(initial);
      let hostId = machine?.hostId ?? null;
      if (machine?.own) {
        reusedOwn = machine.hostId;
      } else if (machine !== null && machine.key !== null && (await chat.protectSandbox(machine.key, sandboxId))) {
        protectedKey = machine.key;
      }
      stillWanted();
      checked();

      // 2. Bring the sandbox up and keep it up, and make sure the headless turn is over.
      if (!ACTIVE_STATES.has(sandbox!.state)) {
        if (hostId !== null) {
          await chat.resumeMachine(hostId);
          this.suspendedHosts.delete(hostId);
          await this.waitForSandbox(sandboxId, signal);
        } else {
          await this.ensureRunning(sandboxId, signal);
        }
        this.store.resetPreviewHealthForSandbox(sandboxId);
      }
      await this.extendSandbox(sandboxId, signal);
      const conversation = (await this.boat.conversations(sandboxId, signal)).find((entry) => entry.id === conversationId);
      const events = await this.boat.events(sandboxId, conversationId, signal);
      const turn = promptStatus(events, initial.promptId);
      // A turn cut off by a stopped sandbox stays unfinished in boat's log: it's over once boat doesn't run it.
      const cutOff = initial.status === "idle" && (initial.error ?? "").startsWith(CUT_OFF_ERROR);
      if (conversation?.running === true || (turn !== null && !TERMINAL_PROMPT.has(turn) && !cutOff)) {
        throw new TaskError(
          "The headless conversation is still running in boat.",
          "task_running",
          `Try again once its turn ends; \`bb boat task interrupt ${id}\` stops it.`,
        );
      }
      if (initial.delivery === "pr" && initial.repo !== null) await this.assertGithubLogin(initial, { signal });
      stillWanted();

      // 3. The conversation so far.
      const rendered = renderBoatTranscript(events, {
        taskId: id,
        title: initial.title,
        provider: initial.provider,
        model: initial.model,
        at: new Date().toISOString(),
        expectedTurns: initial.turns,
      });

      // 4. bb on the sandbox.
      if (hostId === null) {
        this.store.addEvent(id, "machine", "Installing bb on the sandbox (about a minute)");
        this.hooks.changed([id]);
        // From here on its files may be on the sandbox, whatever happens next.
        this.store.addEvent(id, "bb-installed", sandboxId);
        try {
          attached = await chat.attachMachine({ taskId: id, sandboxId, keepSandbox: true, signal });
        } catch (error) {
          // An attach cut short may still have made the machine.
          const left = await chat.findMachine(sandboxId).catch(() => null);
          const key = left === null ? null : await chat.machineKey(left).catch(() => null);
          if (left !== null && key?.startsWith(`task-${id}-m`)) attached = { hostId: left, key };
          throw error;
        }
        hostId = attached.hostId;
        this.store.addEvent(id, "machine", `The sandbox is bb machine ${hostId}`);
      } else {
        this.store.addEvent(id, "machine", `bb already runs on the sandbox (machine ${hostId})`);
      }
      this.suspendedHosts.delete(hostId);
      this.hooks.changed([id]);
      stillWanted();

      // 5. The transcript, outside every checkout (never in history, logs or errors).
      const path = transcriptPath(id);
      await chat.writeFile(hostId, path, rendered.text);
      this.store.addEvent(
        id,
        "transcript",
        `Wrote the headless conversation (${rendered.turns} ${rendered.turns === 1 ? "turn" : "turns"}) to ${path} for the chat${rendered.cut > 0 ? `; ${rendered.cut} earlier ${rendered.cut === 1 ? "turn" : "turns"} left out` : ""}`,
      );
      stillWanted();

      // 6. The first message: brief, workspace, rules, latest report, and where the conversation is.
      const settings = await this.settings();
      const choice = chatChoiceFromBoat(initial.provider, initial.model, initial.reasoningEffort, initial.tier, settings.modelTiers);
      const effort = agentEffort("chat", initial.provider, choice.effort);
      const standing = this.standingInstructions(initial, settings);
      const prompt = composeHandoverPrompt({
        taskId: id,
        role: initial.role,
        title: initial.title,
        brief: initial.brief,
        workspace: this.handoverWorkspace(initial, settings.extraProtectedBranches),
        fromProvider: initial.provider,
        fromThreadId: null,
        why: "from-boat",
        message: null,
        tier: initial.tier,
        provider: initial.provider,
        effort,
        evidence: this.hasEvidence(id),
        transcriptPath: path,
        latestReport: initial.result ? clipResult(initial.result, 8_000) : null,
        extraInstructions: standing,
        sandboxLine: this.sizes.lineFor(initial, "chat"),
      });

      // 7. The chat, in the task's checkout on the machine.
      const spawned = await chat.spawn({
        taskId: id,
        title: initial.title,
        prompt,
        provider: initial.provider,
        model: choice.model,
        effort,
        parentThreadId: initial.orchestratorThreadId,
        projectId: initial.projectId,
        where: { kind: "machine", hostId, path: initial.repoPath },
      });
      spawnedThread = spawned.threadId;

      // 8. Switch the task, only if nothing else happened to it meanwhile.
      stillWanted();
      const moved = this.store.transition(
        id,
        ["idle", "failed"],
        {
          runner: "chat",
          status: "running",
          hostId,
          threadId: spawned.threadId,
          environmentId: spawned.environmentId ?? null,
          promptId: chatTurnMarker(),
          model: choice.model,
          reasoningEffort: effort,
          turns: initial.turns + 1,
          error: null,
          finishedAt: null,
          notifiedAt: null,
        },
        { promptId: initial.promptId },
      );
      if (moved === null) throw unwanted() ?? new MoveCancelled("changed");

      // 9. Record it; the chat runs the read-up turn now.
      this.store.addEvent(id, "chat", spawned.threadId);
      this.recordChat(id, spawned.threadId, initial.provider, choice.model, effort);
      if (!trust.trusted) {
        this.store.addEvent(id, "trust-confirmed", `${trustText(trust)}; moved to a task chat after the warning on the task's page (its sandbox can reach this bb).`);
      }
      if (choice.note !== null) this.store.addEvent(id, "model", choice.note);
      this.store.addEvent(
        id,
        "moved-to-chat",
        `Moved to the task chat @thread:${spawned.threadId} (${initial.provider} · ${modelLine(initial.tier, choice.model, effort, null)}). The headless conversation stops here; follow-ups go to the chat.`,
      );
      this.settling.delete(id);
      this.chatTurnSeen.delete(id);
      // Two agents never share the checkout: stop the headless one if anything restarted it.
      const still = (await this.boat.conversations(sandboxId).catch(() => [])).find((entry) => entry.id === conversationId);
      if (still?.running) await this.boat.interrupt(sandboxId, conversationId).catch(() => undefined);
      // From now on, removing the machine deletes the sandbox like any task chat's.
      const settle = attached?.key ?? (reusedOwn !== null ? machine?.key : null) ?? protectedKey;
      if (settle) await chat.settleMachine(settle).catch((error) => this.hooks.log.warn(`settle ${settle}: ${errorText(error)}`));
      void via;
      this.hooks.changed([id]);
      return moved;
    } catch (error) {
      if (spawnedThread !== null) {
        await chat.stop(spawnedThread).catch(() => undefined);
        await chat.archive(spawnedThread).catch(() => undefined);
      }
      let undo = "";
      if (attached !== null) {
        try {
          await chat.detachMachine(attached.hostId, attached.key);
          undo = " The bb machine was removed again; the sandbox and its work stay.";
        } catch (detachError) {
          this.hooks.log.warn(`detach ${attached.hostId}: ${errorText(detachError)}`);
          undo = ` bb is still on the sandbox (machine ${attached.hostId}); the next try reuses it.`;
        }
      } else if (reusedOwn !== null) {
        undo = ` bb is still on the sandbox (machine ${reusedOwn}); the next try reuses it.`;
      }
      if (protectedKey !== null) await chat.settleMachine(protectedKey).catch(() => undefined);
      // An abort (a close, an unload) can surface as any error from the step it cut short.
      const cancelled = error instanceof MoveCancelled ? error : signal.aborted ? unwanted() : null;
      const reason = cancelled !== null ? cancelled.message : clip(errorText(error), 300);
      this.store.addEvent(id, "chat-move-failed", `Couldn't continue as a chat: ${reason.replace(/\.?$/, ".")} The task stays headless.${undo}`);
      this.hooks.changed([id]);
      if (cancelled !== null) {
        throw new TaskError(`Task ${id} ${cancelled.why === "closed" ? "was closed" : "changed"} while it was moving to a chat.`, "task_changed", "Nothing moved; try again.");
      }
      throw error;
    }
  }

  /** Keep a sandbox from stopping during a move (boat's auto-stop); never fatal. */
  private async extendSandbox(sandboxId: string, signal: AbortSignal): Promise<void> {
    try {
      const limits = await this.boat.limits(signal).catch(() => null);
      await withinAutoStopCap(ttlSeconds(await this.settings(), limits), (ttl) => this.boat.extend(sandboxId, ["--ttl", String(ttl)], signal));
    } catch (error) {
      this.hooks.log.warn(`extend ${sandboxId}: ${errorText(error)}`);
    }
  }

  /** A move cut short (a restart) may have left this task's machine on its sandbox: bb forgets it, the sandbox stays. */
  private async detachLeftoverMachine(task: Task): Promise<string | null> {
    if (this.hooks.chat === undefined || task.sandboxId === null || this.store.latestEvent(task.id, "chat-move") === null) return null;
    const hostId = await this.hooks.chat.findMachine(task.sandboxId).catch(() => null);
    if (hostId === null) return null;
    const key = await this.hooks.chat.machineKey(hostId).catch(() => null);
    if (!key?.startsWith(`task-${task.id}-m`)) return null;
    try {
      await this.hooks.chat.detachMachine(hostId, key);
      return hostId;
    } catch (error) {
      this.hooks.log.warn(`detach ${hostId}: ${errorText(error)}`);
      return null;
    }
  }

  /** Moves bb restarted in the middle of: undo what's left and say so (once per move). */
  private async reconcileMoves(open: readonly Task[]): Promise<string[]> {
    const changed: string[] = [];
    for (const task of open) {
      if (task.runner !== "boat" || this.moves.has(task.id) || this.store.latestEvent(task.id, "chat-move") === null) continue;
      const last = this.store
        .events(task.id, 200)
        .filter((event) => event.kind === "chat-move" || event.kind === "chat-move-failed" || event.kind === "moved-to-chat")
        .at(-1);
      if (last?.kind !== "chat-move") continue;
      const detached = await this.detachLeftoverMachine(task);
      this.store.addEvent(
        task.id,
        "chat-move-failed",
        `Couldn't continue as a chat: bb restarted during the move. The task stays headless.${detached ? " The bb machine was removed again; the sandbox and its work stay." : ""}`,
      );
      changed.push(task.id);
    }
    return changed;
  }

  // -------------------------------------------------------------------------
  // Previews

  private lastRetentionCheck = 0;

  /**
   * boat deletes a stopped sandbox's data after 14 days. Unshipped work exists
   * only there: after 10 days stopped, ask the user (once) on the overview.
   */
  private async warnBeforeRetention(open: Task[], now: number): Promise<void> {
    const candidates = open.filter(
      (task) =>
        task.delivery === "push" && task.role !== "review" && task.sandboxId !== null && task.turns > 0 && task.unshipped !== 0 && !this.shippedSinceLastTurn(task),
    );
    if (candidates.length === 0) return;
    const sandboxes = new Map((await this.boat.list({ all: true, signal: this.hooks.lifecycle })).map((sandbox) => [sandbox.id, sandbox]));
    for (const task of candidates) {
      const sandbox = sandboxes.get(task.sandboxId!);
      const stoppedAt = sandbox?.stoppedAt ? Date.parse(sandbox.stoppedAt) : NaN;
      if (sandbox === undefined || sandbox.state !== "stopped" || !Number.isFinite(stoppedAt) || now - stoppedAt < 10 * 24 * 3_600_000) continue;
      if (this.store.latestEvent(task.id, "retention-warning") !== null) continue;
      const left = Math.max(0, Math.ceil((stoppedAt + 14 * 24 * 3_600_000 - now) / (24 * 3_600_000)));
      this.store.addEvent(task.id, "retention-warning", `Its sandbox has been stopped since ${sandbox.stoppedAt}; boat deletes it in about ${left} days`);
      this.store.addDecision({
        orchestratorThreadId: task.orchestratorThreadId,
        question: `"${task.title}" hasn't shipped, and boat deletes its stopped sandbox in about ${left} day${left === 1 ? "" : "s"}. Ship it, or let it go?`,
        recommendation: "Wake its preview to look once more, then ship it or close it.",
        options: ["Ship it", "Let it go"],
        taskIds: [task.id],
      });
      this.hooks.changed([task.id]);
    }
  }

  /** Tasks whose reported preview is being hosted: their notice waits for the link. */
  private readonly hostingPreviews = new Set<string>();

  /** Host the preview a turn reported; never fails the turn. */
  private async hostReportedPreview(task: Task, text: string): Promise<void> {
    if (task.role === "review" || task.sandboxId === null) return;
    const spec = parsePreview(text);
    if (spec === null) return;
    // Synchronously, before the first await: no notice can go out without the link.
    this.hostingPreviews.add(task.id);
    try {
      const hosted = await this.boat.host(task.sandboxId, spec.port, task.title, this.hooks.lifecycle);
      let health = await this.checkPreviewLink(previewLink(hosted.url, spec.path), true);
      // The worker's server didn't survive its turn, or blocks boat's host name: start it again once.
      if ((health === "down" || health === "blocked") && spec.command !== null && task.repoPath !== null) {
        await this.startPreviewServer(task.sandboxId, task.repoPath, spec.port, spec.command);
        health = await this.waitForPreview(previewLink(hosted.url, spec.path), 20_000);
      }
      // Closed meanwhile: don't bring a preview of a deleted sandbox back.
      const current = this.store.get(task.id);
      if (current === null || current.status === "done" || current.status === "cancelled") return;
      const preview = this.store.upsertPreview({
        taskId: task.id,
        sandboxId: task.sandboxId,
        port: spec.port,
        path: spec.path,
        command: spec.command,
        url: hosted.url,
        title: task.title,
        health,
      });
      this.store.addEvent(
        task.id,
        "preview",
        `Preview ${preview.id} on port ${spec.port}${
          health === "down"
            ? " (the server isn't answering; Wake restarts it)"
            : health === "blocked"
              ? " (the dev server blocks the preview's host name; the task's agent should allow .on.boat.dev)"
              : ""
        }`,
      );
    } catch (error) {
      this.hooks.log.warn(`preview ${task.id}: ${errorText(error)}`);
      this.store.addEvent(task.id, "preview", `Couldn't host the preview on port ${spec.port}: ${clip(errorText(error), 300)}`);
    } finally {
      this.hostingPreviews.delete(task.id);
      // The notice that waited for the link.
      void this.deliverPending().catch(() => undefined);
    }
  }

  private checkPreviewLink(link: string, sandboxActive = false): Promise<PreviewHealth> {
    return this.hooks.checkPreview ? this.hooks.checkPreview(link) : checkPreview(link, undefined, undefined, { sandboxActive });
  }

  private async waitForPreview(link: string, timeoutMs: number): Promise<PreviewHealth> {
    const deadline = Date.now() + timeoutMs;
    let health: PreviewHealth = "unknown";
    for (;;) {
      health = await this.checkPreviewLink(link);
      if (health === "up" || Date.now() >= deadline || this.hooks.lifecycle.aborted) return health;
      await delay(2_500, this.hooks.lifecycle).catch(() => undefined);
    }
  }

  /**
   * (Re)start a preview server: free its port (a stuck or host-blocking
   * server), allow boat's preview host names for Vite-style dev servers, and
   * run the worker's command from the checkout, detached.
   */
  private async startPreviewServer(sandboxId: string, repoPath: string, port: number, command: string): Promise<void> {
    await this.boat.execDetached(sandboxId, previewStartScript(repoPath, port, command), this.hooks.lifecycle);
  }

  /** Previews with their state; refreshes stale checks of live ones. */
  async previews(filter: { taskId?: string; orchestratorThreadId?: string | null; includeExpired?: boolean } = {}): Promise<PreviewView[]> {
    const rows = this.store.previews(filter);
    if (rows.length === 0) return [];
    const sandboxes = new Map<string, Sandbox>();
    let known = false;
    try {
      // --all: stopped sandboxes too (their previews are sleeping, not gone).
      for (const sandbox of await this.boat.list({ all: true, signal: this.hooks.lifecycle })) sandboxes.set(sandbox.id, sandbox);
      known = true;
    } catch (error) {
      this.hooks.log.warn(`previews: ${errorText(error)}`);
    }
    // A sandbox missing from the list is gone only if boat says so (404).
    const lookup = new Map<string, Sandbox | null | undefined>();
    for (const preview of rows) {
      if (lookup.has(preview.sandboxId)) continue;
      if (!known) lookup.set(preview.sandboxId, undefined);
      else if (sandboxes.has(preview.sandboxId)) lookup.set(preview.sandboxId, sandboxes.get(preview.sandboxId));
      else if (preview.expiredAt !== null) lookup.set(preview.sandboxId, null);
      else lookup.set(preview.sandboxId, await this.boat.findInfo(preview.sandboxId, this.hooks.lifecycle).catch(() => undefined));
    }
    const view = (preview: Preview) => previewView(preview, this.store.get(preview.taskId), lookup.get(preview.sandboxId));
    const views = rows.map(view);
    // Re-check links on running sandboxes (at most once a minute each), down ones too.
    const stale = views.filter((entry) => {
      const sandbox = lookup.get(entry.preview.sandboxId);
      const active = sandbox !== null && sandbox !== undefined && ACTIVE_STATES.has(sandbox.state);
      return active && entry.preview.expiredAt === null && Date.now() - Date.parse(entry.preview.checkedAt ?? "") > 60_000;
    });
    await Promise.all(
      stale.map(async (entry) => {
        const health = await this.checkPreviewLink(entry.link, true);
        if (health !== "unknown") this.store.setPreviewHealth(entry.preview.id, health);
      }),
    );
    if (stale.length === 0) return views;
    return this.store.previews(filter).map(view);
  }

  /** Resume a sandbox: through bb when it's a bb machine (kept ones of closed tasks too), else boat. */
  private async resumeSandbox(sandboxId: string, signal?: AbortSignal): Promise<Sandbox> {
    const hostId = this.hooks.chat === undefined ? null : this.store.machineForSandbox(sandboxId);
    let sandbox: Sandbox;
    if (hostId !== null) {
      await this.hooks.chat!.resumeMachine(hostId);
      this.suspendedHosts.delete(hostId);
      sandbox = await this.waitForSandbox(sandboxId, signal);
    } else {
      sandbox = await this.ensureRunning(sandboxId, signal);
    }
    this.store.resetPreviewHealthForSandbox(sandboxId);
    return sandbox;
  }

  /** Stop a sandbox: bb suspends its machine when it's one, else boat stops it. */
  private async suspendSandbox(sandboxId: string, signal?: AbortSignal): Promise<void> {
    const hostId = this.hooks.chat === undefined ? null : this.store.machineForSandbox(sandboxId);
    if (hostId !== null) {
      await this.hooks.chat!.suspendMachine(hostId);
      this.suspendedHosts.add(hostId);
      this.hooks.machineSuspended?.(hostId, false);
    } else {
      await this.boat.stop(sandboxId, signal);
    }
  }

  private mustGetPreview(id: string): { preview: Preview; task: Task } {
    const preview = this.store.preview(id.trim());
    if (preview === null) throw new TaskError(`No preview "${id}".`, "preview_not_found", "Run `bb boat preview list` to see them.");
    const task = this.store.get(preview.taskId);
    if (task === null) throw new TaskError(`Preview ${id}'s task is gone.`, "preview_not_found");
    return { preview, task };
  }

  /**
   * Bring a preview back: resume its sandbox, restart the server if nothing
   * answers, host the port again (the same link), and check it.
   */
  async wakePreview(id: string, signal?: AbortSignal): Promise<PreviewView> {
    const { preview, task } = this.mustGetPreview(id);
    if (preview.expiredAt !== null) throw new TaskError(`Preview ${preview.id} expired: its sandbox is gone.`, "preview_expired", "Ask for a new preview in a new task.");
    if (this.claims.has(preview.sandboxId)) throw new TaskError("That sandbox is in use right now.", "sandbox_busy", "Try again in a moment.");
    // Held for the whole wake: no idle stop or room-making stop in between.
    const release = this.claim(preview.sandboxId);
    try {
      const sandbox = await this.boat.findInfo(preview.sandboxId, signal);
      if (sandbox === null) {
        this.store.expirePreviewsForSandbox(preview.sandboxId);
        throw new TaskError(`Preview ${preview.id}'s sandbox is gone.`, "preview_expired");
      }
      if (!ACTIVE_STATES.has(sandbox.state)) await this.resumeSandbox(preview.sandboxId, signal);
      const link = () => previewLink(this.store.preview(preview.id)!.url, preview.path);
      let health = await this.checkPreviewLink(link(), true);
      if (health !== "up" && preview.command !== null && task.repoPath !== null) {
        await this.startPreviewServer(preview.sandboxId, task.repoPath, preview.port, preview.command);
      }
      const hosted = await this.boat.host(preview.sandboxId, preview.port, preview.title, signal);
      if (health !== "up") health = await this.waitForPreview(previewLink(hosted.url, preview.path), 45_000);
      this.store.setPreviewHealth(preview.id, health, hosted.url);
      this.store.addEvent(task.id, "preview", `Woke preview ${preview.id}${health === "up" ? "" : " (the server isn't answering yet)"}`);
      // The idle timer starts again from the wake.
      this.store.update(task.id, {});
      this.hooks.changed([task.id]);
      return previewView(this.store.preview(preview.id)!, task, await this.boat.findInfo(preview.sandboxId, signal));
    } finally {
      release();
    }
  }

  private async waitForSandbox(sandboxId: string, signal?: AbortSignal): Promise<Sandbox> {
    const deadline = Date.now() + TRANSITION_WAIT_MS;
    for (;;) {
      const sandbox = await this.boat.findInfo(sandboxId, signal);
      if (sandbox === null) throw new TaskError(`Sandbox ${sandboxId} no longer exists.`, "sandbox_gone");
      if (ACTIVE_STATES.has(sandbox.state)) return sandbox;
      if (Date.now() >= deadline || signal?.aborted) throw new TaskError(`Sandbox ${sandboxId} is still ${sandbox.state}.`, "sandbox_unavailable");
      await delay(3_000, signal);
    }
  }

  /**
   * Keep a preview's sandbox on longer (boat's auto-stop), within the plan's
   * cap. `hours`: what it was set to.
   */
  async extendPreview(id: string, hours: number, signal?: AbortSignal): Promise<PreviewView & { hours: number }> {
    const { preview, task } = this.mustGetPreview(id);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new TaskError("Extend by 1 to 24 hours.", "invalid_value");
    this.sizes.assertSandboxNotResizing(preview.sandboxId); // sizes
    const limits = await this.boat.limits(signal).catch(() => null);
    const wanted = Math.round(Math.min(hours, limits?.autoStopCapHours ?? hours) * 3600);
    const ttl = await withinAutoStopCap(wanted, async (seconds) => {
      await this.boat.extend(preview.sandboxId, ["--ttl", String(seconds)], signal);
      return seconds;
    });
    const set = Math.round((ttl / 3600) * 100) / 100;
    const capped = set < hours ? ` (your plan's auto-stop cap)` : "";
    this.store.addEvent(task.id, "preview", `Extended preview ${preview.id}'s sandbox to ${set} more ${set === 1 ? "hour" : "hours"}${capped}`);
    this.hooks.changed([task.id]);
    return { ...previewView(preview, task, await this.boat.findInfo(preview.sandboxId, signal)), hours: set };
  }

  /** Stop a preview's sandbox (Wake brings it back; the link stays the same). */
  async stopPreview(id: string, signal?: AbortSignal): Promise<PreviewView> {
    const { preview, task } = this.mustGetPreview(id);
    const others = this.store.liveSandboxTasks(preview.sandboxId).filter((entry) => entry.id !== task.id && (entry.status === "running" || entry.status === "starting"));
    if (others.length > 0) {
      throw new TaskError(`Another task (${others[0]!.id}) is working in that sandbox.`, "sandbox_busy", "Stop it once that turn is over.");
    }
    if (task.status === "running" || task.status === "starting") {
      throw new TaskError(`Task ${task.id} is still working in that sandbox.`, "task_running");
    }
    if (this.claims.has(preview.sandboxId)) throw new TaskError("That sandbox is in use right now (a ship or a follow-up).", "sandbox_busy", "Try again once it's done.");
    await this.suspendSandbox(preview.sandboxId, signal);
    this.store.setPreviewHealth(preview.id, "unknown");
    this.store.addEvent(task.id, "preview", `Stopped preview ${preview.id}'s sandbox`);
    this.hooks.changed([task.id]);
    return previewView(this.store.preview(preview.id)!, task, await this.boat.findInfo(preview.sandboxId, signal));
  }

  /** The task's newest preview link that isn't expired (for cards and notices). */
  previewLinkFor(taskId: string): string | null {
    const preview = this.store.previews({ taskId })[0];
    return preview ? previewLink(preview.url, preview.path) : null;
  }

  /** The preview line of a notice: the link, and what's wrong with it if anything. */
  previewNoticeFor(taskId: string): string | null {
    const preview = this.store.previews({ taskId })[0];
    if (!preview) return null;
    const link = previewLink(preview.url, preview.path);
    if (preview.health === "down") return `${link} (not answering; \`boat_preview\` wake ${preview.id} restarts it)`;
    if (preview.health === "blocked") return `${link} (the dev server blocks the preview's host name; \`boat_preview\` wake ${preview.id} restarts it allowing .on.boat.dev, or ask the task's agent to)`;
    return link;
  }

  /** A sandbox with a live preview whose task waits on the user isn't stopped as idle. */
  private hasLivePreview(sandboxId: string): boolean {
    return this.store
      .previews()
      .some((preview) => preview.sandboxId === sandboxId && preview.health === "up" && this.store.get(preview.taskId)?.status === "idle");
  }

  // -------------------------------------------------------------------------
  // Shipping (projects that land on the base branch after the user approves)

  /** The work was shipped after its last turn (nothing new since). */
  private shippedSinceLastTurn(task: Task): boolean {
    // A turn running now may be making new commits.
    if (task.finishedAt === null || task.status === "running" || task.status === "starting") return false;
    const shipped = this.store.latestEvent(task.id, "shipped");
    return shipped !== null && shipped.at >= task.finishedAt;
  }

  /** The repos a task's work lands in: its checkout and the other project repos it cloned. */
  private shipTargets(task: Task): { path: string; baseBranch: string }[] {
    if (task.repoPath === null || task.baseBranch === null) return [];
    return [
      { path: task.repoPath, baseBranch: task.baseBranch },
      ...task.extraRepos
        .filter((extra): extra is { repo: string; baseBranch: string; path: string } => typeof extra.path === "string")
        .map((extra) => ({ path: extra.path, baseBranch: extra.baseBranch })),
    ];
  }

  /** Open tasks on a sandbox whose unshipped work would be lost with it. */
  async unshippedTasks(sandboxId: string, signal?: AbortSignal): Promise<Task[]> {
    const held: Task[] = [];
    for (const task of this.store.liveSandboxTasks(sandboxId)) if (await this.holdsUnshippedWork(task, signal)) held.push(task);
    return held;
  }

  /** Push work that may exist only in its sandbox (commits or files not shipped yet). */
  private async holdsUnshippedWork(task: Task, signal?: AbortSignal): Promise<boolean> {
    if (task.delivery !== "push" || task.role === "review" || task.turns === 0) return false;
    if (this.shippedSinceLastTurn(task)) return false;
    return (await this.unshippedCommits(task, signal)) !== 0;
  }

  /**
   * Push a worker's commits to the base branch. Only after the user approved
   * it (the caller checks that): the worker itself can't push in these
   * projects.
   */
  async shipTask(idOrPrefix: string, options: { keepOpen?: boolean; approval: string; signal?: AbortSignal }): Promise<{ task: Task; shipped: ShipResult["shipped"]; sandbox: "deleted" | "kept" | "gone" | "none" }> {
    const task = await this.refreshChatTask(idOrPrefix);
    this.assertNotMoving(task.id);
    if (task.delivery !== "push") {
      throw new TaskError(`Task ${task.id} delivers through a pull request.`, "not_shippable", "Merge its pull request on GitHub.");
    }
    if (task.role === "review") throw new TaskError(`Task ${task.id} is a review; ship the task it reviewed.`, "not_shippable");
    if (task.status === "running" || task.status === "starting") throw new TaskError(`Task ${task.id} is still working.`, "task_running", "Ship it once its turn has finished.");
    if (task.status === "done" || task.status === "cancelled") throw new TaskError(`Task ${task.id} is ${task.status}.`, "task_closed");
    if (task.sandboxId === null || task.repoPath === null || task.baseBranch === null) {
      throw new TaskError(`Task ${task.id} has no checkout to ship.`, "not_shippable");
    }
    this.sizes.assertNotResizing(task, "ship"); // sizes
    const release = this.claim(task.sandboxId);
    let result: ShipResult;
    try {
      const hostId = this.hooks.chat === undefined ? null : this.store.hostForSandbox(task.sandboxId);
      const sandbox = await this.boat.findInfo(task.sandboxId, options.signal);
      if (sandbox === null) throw new TaskError(`Task ${task.id}'s sandbox is gone, and its unshipped commits with it.`, "sandbox_gone");
      if (!ACTIVE_STATES.has(sandbox.state)) {
        if (hostId !== null) {
          await this.sandboxAction(task.sandboxId, "resume", 0, options.signal);
          await this.waitForSandbox(task.sandboxId, options.signal);
        } else {
          await this.ensureRunning(task.sandboxId, options.signal);
        }
      }
      await this.assertGithubLogin(task, { signal: options.signal, forShip: true });
      try {
        // Base commits another task of this plugin shipped are named with it.
        result = await this.boat.ship(task.sandboxId, this.shipTargets(task), options.signal, (sha) => this.store.shippedBy(sha, task.id));
      } catch (error) {
        // Repos that landed before a later one failed are recorded as shipped.
        const partial = (error as { shipped?: ShipResult["shipped"] }).shipped ?? [];
        if (partial.length > 0) {
          this.store.addEvent(
            task.id,
            "shipped-partly",
            `Shipped ${partial.map((entry) => `${entry.commits} commit${entry.commits === 1 ? "" : "s"} to ${entry.baseBranch} (${entry.sha.slice(0, 7)})`).join(", ")} before it stopped; the rest is still unshipped`,
          );
        }
        if (error instanceof BoatError) {
          const conflict = (error as { conflict?: (ShipConflict & { path: string; baseBranch: string }) | null }).conflict ?? null;
          if (error.code === "ship_conflict") this.noteShipConflict(task, error.message, conflict);
          throw new TaskError(error.message, error.code ?? "ship_failed");
        }
        throw error;
      }
    } finally {
      release();
    }
    if (result.shipped.length === 0) {
      throw new TaskError(`Task ${task.id} has no commits that aren't on ${task.baseBranch} yet.`, "nothing_to_ship", "Ask the task's agent to commit its changes first.");
    }
    const summary = result.shipped.map((entry) => `${entry.commits} commit${entry.commits === 1 ? "" : "s"} to ${entry.baseBranch} (${entry.sha.slice(0, 7)})`).join(", ");
    this.store.addEvent(task.id, "shipped", `Shipped ${summary}; approved ${options.approval}`);
    // Shipped: an approval kept from a conflict has done its job.
    if (task.shipApproval !== null) this.store.update(task.id, { shipApproval: null });
    // Nothing left to ship, unless a follow-up started during the push.
    this.store.transition(task.id, ["idle"], { unshipped: 0 }, { promptId: task.promptId });
    this.hooks.changed([task.id]);
    // A follow-up that started during the push keeps the task (and its sandbox) open.
    const now = this.store.get(task.id) ?? task;
    if (options.keepOpen || now.status !== "idle" || now.turns !== task.turns) return { task: now, shipped: result.shipped, sandbox: "kept" };
    const closed = await this.closeTask(task.id, { status: "done", signal: options.signal });
    return { task: closed.task, shipped: result.shipped, sandbox: closed.sandbox };
  }

  async closeTask(
    idOrPrefix: string,
    options: { status?: "done" | "cancelled"; keepSandbox?: boolean; discard?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ task: Task; sandbox: "deleted" | "kept" | "gone" | "none" }> {
    const settings = await this.settings();
    let task = this.mustGet(idOrPrefix);
    this.sizes.assertNotResizing(task, "close"); // sizes
    // A move to a chat in flight stops (and rolls back) first; then the row is current.
    const move = this.moves.get(task.id);
    if (move !== undefined) {
      move.controller.abort("closed");
      await move.done.catch(() => undefined);
      task = this.store.get(task.id) ?? task;
    }
    const unfinished = task.status === "running" || task.status === "starting";
    const status: TaskStatus = options.status ?? (unfinished ? "cancelled" : "done");
    // Unshipped work lives only in its sandbox: closing (or cancelling) throws it away.
    const keep = options.keepSandbox ?? !settings.deleteSandboxOnClose;
    if (options.discard !== true && !keep && (await this.holdsUnshippedWork(task, options.signal))) {
      throw new TaskError(
        `Task ${task.id}'s work hasn't shipped, and closing it deletes its sandbox.`,
        "unshipped_work",
        "Ship it once the user approves (Ship on the overview, or boat_ship after their OK in chat), or ask the user whether to throw the work away.",
      );
    }
    const updated = this.store.update(task.id, { status, finishedAt: new Date().toISOString(), shipApproval: null }) ?? task;
    // Stop an in-flight dispatch, then the running turn.
    this.dispatches.get(task.id)?.abort();
    if (task.status === "running" && task.runner === "chat" && task.threadId && this.hooks.chat) {
      await this.hooks.chat.stop(task.threadId).catch(() => undefined);
    } else if (task.status === "running" && task.sandboxId && task.conversationId) {
      await this.boat.interrupt(task.sandboxId, task.conversationId, options.signal).catch(() => undefined);
    }
    this.store.addEvent(task.id, status, status === "done" ? "Closed" : "Cancelled");
    let sandbox: "deleted" | "kept" | "gone" | "none" = "none";
    const current = this.store.get(task.id) ?? task;
    const sandboxId = current.sandboxId;
    if (current.runner === "chat" && this.hooks.chat) {
      // bb owns the machine: archiving the task's chats lets bb remove it
      // (and delete the sandbox) once no other chat needs it.
      const keep = options.keepSandbox ?? !settings.deleteSandboxOnClose;
      if (keep) {
        sandbox = sandboxId === null ? "none" : "kept";
      } else {
        for (const threadId of this.store.chatThreads(task.id)) {
          await this.hooks.chat.archive(threadId).catch((error) => this.hooks.log.warn(`archive ${threadId}: ${errorText(error)}`));
        }
        this.store.addEvent(task.id, "chat-archived", "Archived the task's chats");
        // Machines the plugin creates aren't removed with their last chat; removing
        // the machine makes the provider delete the sandbox.
        const removed = await this.removeMachineIfUnused(current);
        sandbox = removed === "none" ? (sandboxId === null ? "none" : await this.releaseSandbox(sandboxId, task.id, options.signal)) : removed;
      }
    } else if (sandboxId !== null) {
      // A try to move it to a chat cut short (a restart) may have left a machine there.
      await this.detachLeftoverMachine(current);
      const keep = options.keepSandbox ?? !settings.deleteSandboxOnClose;
      sandbox = keep ? "kept" : await this.releaseSandbox(sandboxId, task.id, options.signal);
      if (sandbox === "deleted") this.store.addEvent(task.id, "sandbox", `Deleted sandbox ${sandboxId}`);
    }
    // A kept sandbox may get other tasks: the moved task's old conversation goes.
    if (sandbox === "kept" && sandboxId !== null && this.store.latestEvent(task.id, "moved-to-chat") !== null) {
      await this.boat
        .exec(sandboxId, `rm -rf ${shellQuote(transcriptDir(task.id))}`, { timeoutMs: 30_000, signal: options.signal })
        .catch((error) => this.hooks.log.warn(`remove transcript ${task.id}: ${errorText(error)}`));
    }
    if (sandbox === "deleted" || sandbox === "gone") {
      this.store.expirePreviews(task.id);
      if (sandboxId !== null) this.store.expirePreviewsForSandbox(sandboxId);
    }
    this.hooks.changed([task.id]);
    return { task: this.store.get(task.id) ?? updated, sandbox };
  }

  /**
   * Commits on the task's branch that aren't on its base yet: 0 when the
   * sandbox says so, null when it can't tell (stopped, unreachable).
   */
  private async unshippedCommits(task: Task, signal?: AbortSignal, known?: Sandbox): Promise<number | null> {
    const targets = this.shipTargets(task);
    if (task.sandboxId === null || targets.length === 0) return 0;
    try {
      const sandbox = known ?? (await this.boat.findInfo(task.sandboxId, signal));
      if (sandbox === null) return 0;
      if (!ACTIVE_STATES.has(sandbox.state)) return null;
      // Per repo: commits not on its base, plus 1 when files aren't committed (untracked too).
      const script = targets
        .map(
          (target) =>
            `cd ${shellQuote(target.path)} 2>/dev/null && echo "BOAT_AHEAD $(git rev-list --count ${shellQuote(`origin/${target.baseBranch}`)}..HEAD 2>/dev/null || echo x) $([ -z "$(git status --porcelain 2>/dev/null)" ] && echo clean || echo dirty)" || echo "BOAT_AHEAD x x"`,
        )
        .join("\n");
      const result = await this.boat.exec(task.sandboxId, script, { timeoutMs: 30_000, signal });
      const rows = [...result.stdout.matchAll(/BOAT_AHEAD (\S+) (\S+)/g)];
      if (rows.length !== targets.length) return null;
      let total = 0;
      for (const row of rows) {
        const count = Number(row[1]);
        if (!Number.isFinite(count) || row[2] === "x") return null;
        total += count + (row[2] === "dirty" ? 1 : 0);
      }
      return total;
    } catch {
      return null;
    }
  }

  /**
   * After a turn of work that ships after approval: note whether anything
   * waits to ship, so Ship is only offered then. Never fails the turn.
   */
  private async noteUnshipped(task: Task, known?: Sandbox): Promise<void> {
    if (task.delivery !== "push" || task.role === "review") return;
    const unshipped = await this.unshippedCommits(task, this.hooks.lifecycle, known);
    // Only for the turn it checked: a newer turn or a close wins.
    this.store.transition(task.id, ["idle", "failed"], { unshipped }, { promptId: task.promptId });
    // The turn after a ship conflict: what changed since the user approved.
    const current = this.store.get(task.id);
    if (current !== null && this.needsComparison(current)) await this.compareSinceApproval(current, known);
  }

  /**
   * A ship stopped on a conflict: keep what the user approved (the task's
   * head and the base it was rebased onto), so the next turn's changes can be
   * shown and approved again. A later attempt replaces it.
   */
  private noteShipConflict(task: Task, message: string, conflict: (ShipConflict & { path: string; baseBranch: string }) | null): void {
    this.store.addEvent(task.id, "ship-conflict", message);
    if (conflict === null || conflict.head === null || conflict.base === null) return;
    this.store.update(task.id, {
      shipApproval: {
        at: new Date().toISOString(),
        turns: task.turns,
        path: conflict.path,
        baseBranch: conflict.baseBranch,
        head: conflict.head,
        base: conflict.base,
        files: conflict.files,
        moreFiles: conflict.moreFiles,
        message,
        changes: null,
      },
    });
    this.hooks.changed([task.id]);
  }

  /** Tasks whose "what changed since you approved" is being worked out: their notice waits for it. */
  private readonly comparing = new Map<string, Promise<void>>();
  /** Turns compared (or tried) since the plugin started, as `<task id>:<turns>`. */
  private readonly compared = new Set<string>();

  /** A finished turn after a ship conflict that hasn't been compared with the approved commits yet. */
  private needsComparison(task: Task): boolean {
    return (
      changedSinceApproval(task) &&
      task.shipApproval!.changes?.turns !== task.turns &&
      (task.status === "idle" || task.status === "failed") &&
      !this.compared.has(`${task.id}:${task.turns}`)
    );
  }

  /**
   * Compare the commits the user approved with the task's commits now, in
   * its sandbox (git range-diff; git diff --stat where that fails). Never
   * fails the turn: what went wrong is kept as the comparison.
   */
  private compareSinceApproval(task: Task, known?: Sandbox): Promise<void> {
    const running = this.comparing.get(task.id);
    if (running !== undefined) return running;
    const approval = task.shipApproval!;
    const work = (async () => {
      let changes: SinceApproval;
      try {
        if (task.sandboxId === null) throw new Error("the task has no sandbox");
        const sandbox = known ?? (await this.boat.findInfo(task.sandboxId, this.hooks.lifecycle));
        if (sandbox === null) throw new Error("its sandbox is gone");
        if (!ACTIVE_STATES.has(sandbox.state)) throw new Error(`its sandbox is ${sandbox.state}`);
        const result = await this.boat.exec(task.sandboxId, sinceApprovalScript(approval), { timeoutMs: 60_000, signal: this.hooks.lifecycle });
        changes = parseSinceApproval(result.stdout, task.turns);
      } catch (error) {
        changes = { turns: task.turns, via: "none", text: clip(errorText(error), 300), omitted: 0 };
      }
      // Only onto the same approval and turn: a newer attempt, turn or close wins.
      const current = this.store.get(task.id);
      if (current?.shipApproval?.at !== approval.at || current.turns !== task.turns) return;
      this.store.transition(task.id, ["idle", "failed"], { shipApproval: { ...current.shipApproval, changes } }, { promptId: task.promptId });
      this.hooks.changed([task.id]);
    })()
      .catch((error) => this.hooks.log.warn(`compare ${task.id}: ${errorText(error)}`))
      .finally(() => {
        this.compared.add(`${task.id}:${task.turns}`);
        this.comparing.delete(task.id);
        // The notice that waited for it.
        void this.deliverPending().catch(() => undefined);
      });
    this.comparing.set(task.id, work);
    return work;
  }


  /**
   * Context from other tasks for a new brief: what they did, where the code
   * is, and their reports. Workers share GitHub access, so they can fetch
   * each other's branches and pull requests.
   */
  contextBlock(ids: readonly string[]): string {
    if (ids.length === 0) return "";
    const blocks = ids.map((ref) => {
      const task = this.mustGet(ref);
      const lines = [
        `### ${task.id} (${task.role}, ${task.status}) — ${task.title}`,
        task.repo ? `Repository: ${task.repo}` : null,
        task.branch ? `Branch: ${task.branch}${task.baseBranch ? ` (base ${task.baseBranch})` : ""}` : null,
        task.prUrl ? `Pull request: ${task.prUrl}` : null,
        "",
        "Brief:",
        clip(task.brief, 3000),
        "",
        "Latest report:",
        clip(task.result ?? "(none yet)", 4000),
      ];
      return lines.filter((line) => line !== null).join("\n");
    });
    return `\n\n## Context from related tasks\nOther agents worked on these. Fetch their branches or PRs with git/gh if you need the code.\n\n${blocks.join("\n\n")}`;
  }

  mustGet(idOrPrefix: string): Task {
    const ref = idOrPrefix.trim();
    // A prefix this short would match arbitrary tasks (an empty one matches all).
    if (ref.length < 4) {
      throw new TaskError(`"${idOrPrefix}" is not a task id.`, "task_not_found", "Task ids look like t_1a2b3c4d; run `bb boat task list`.");
    }
    const task = this.store.resolve(ref);
    if (task === null) {
      throw new TaskError(`No task "${idOrPrefix}".`, "task_not_found", "Run `bb boat task list` to see task ids.");
    }
    return task;
  }

  // -------------------------------------------------------------------------
  // Monitoring

  /** One pass over open tasks. Concurrent callers share the same pass. */
  sweep(): Promise<void> {
    if (this.sweeping === null) {
      this.sweeping = this.runSweep().finally(() => {
        this.sweeping = null;
      });
    }
    return this.sweeping;
  }

  /** Anything the monitor still has to watch (turns, idle sandboxes, notices). */
  hasOpenWork(): boolean {
    return this.store.list({ statuses: OPEN_STATUSES, limit: 1 }).length > 0;
  }

  /** A turn is being dispatched or is running: check often. */
  hasActiveWork(): boolean {
    return this.store.list({ statuses: ["starting", "running"], limit: 1 }).length > 0;
  }

  private async runSweep(): Promise<void> {
    const settings = await this.settings();
    const open = this.store.list({ statuses: OPEN_STATUSES, limit: 1000 });
    const now = Date.now();
    // Expired previews stay listed for a week.
    this.store.prunePreviews(new Date(now - 7 * 24 * 3_600_000).toISOString());
    if (now - this.lastRetentionCheck > 3_600_000) {
      this.lastRetentionCheck = now;
      await this.warnBeforeRetention(open, now).catch((error) => this.hooks.log.warn(`retention check: ${errorText(error)}`));
    }

    // "starting" tasks whose dispatch is not running in this process (the
    // server restarted mid-dispatch).
    for (const task of open) {
      if (task.status !== "starting" || this.dispatches.has(task.id)) continue;
      if (now - Date.parse(task.createdAt) < 2 * 60_000) continue;
      const failed = this.store.transition(task.id, ["starting"], {
        status: "failed",
        error: "Dispatch did not finish (the bb server may have restarted). Start the task again.",
        finishedAt: new Date().toISOString(),
      });
      if (failed === null) continue;
      this.store.addEvent(task.id, "failed", "Dispatch did not finish");
      if (failed.sandboxId !== null && failed.ownsSandbox) {
        await this.discardNew(failed.id, failed.sandboxId, failed.runner === "chat" ? failed.hostId : null);
      }
      this.hooks.changed([task.id]);
    }

    const changed: string[] = await this.reconcileMoves(open).catch((error) => {
      this.hooks.log.warn(`move reconcile: ${errorText(error)}`);
      return [];
    });
    // Worker chats: bb runs them; mirror their state onto the tasks.
    if (this.hooks.chat !== undefined) {
      for (const task of open) {
        if (task.runner !== "chat" || task.threadId === null || task.status === "starting") continue;
        if (await this.syncChat(task, now)) changed.push(task.id);
      }
    }

    const running = open.filter((task) => task.status === "running" && task.runner === "boat" && task.sandboxId !== null);
    const sandboxes = new Map<string, Sandbox>();
    if (running.length > 0 || settings.stopIdleAfterMinutes > 0) {
      try {
        for (const sandbox of await this.boat.list({ all: true, signal: this.hooks.lifecycle })) sandboxes.set(sandbox.id, sandbox);
      } catch (error) {
        this.hooks.log.warn(`sweep: boat list failed: ${errorText(error)}`);
        if (changed.length > 0) this.hooks.changed(changed);
        await this.deliverPending();
        return;
      }
    }

    const bySandbox = new Map<string, Task[]>();
    for (const task of running) {
      const list = bySandbox.get(task.sandboxId!) ?? [];
      list.push(task);
      bySandbox.set(task.sandboxId!, list);
    }

    for (const [sandboxId, tasks] of bySandbox) {
      let sandbox = sandboxes.get(sandboxId);
      if (sandbox === undefined) {
        // `boat list` is paged; ask about this one directly before giving up.
        // Only a real 404 (null) counts as gone; other errors retry next sweep.
        try {
          sandbox = (await this.boat.findInfo(sandboxId, this.hooks.lifecycle)) ?? undefined;
        } catch (error) {
          this.hooks.log.warn(`sweep: info ${sandboxId}: ${errorText(error)}`);
          continue;
        }
      }
      if (sandbox === undefined || sandbox.state === "error" || sandbox.state === "cancelled") {
        const reason =
          sandbox === undefined
            ? `Sandbox ${sandboxId} disappeared.`
            : `Sandbox ${sandboxId} is ${sandbox.state}${sandbox.error ? `: ${sandbox.error}` : ""}.`;
        for (const task of tasks) {
          const failed = this.store.transition(
            task.id,
            ["running"],
            { status: "failed", error: reason, finishedAt: new Date().toISOString() },
            { promptId: task.promptId },
          );
          if (failed === null) continue;
          this.store.addEvent(task.id, "failed", reason);
          changed.push(task.id);
        }
        continue;
      }
      let conversations;
      try {
        conversations = await this.boat.conversations(sandboxId, this.hooks.lifecycle);
      } catch (error) {
        this.hooks.log.warn(`sweep: conversations ${sandboxId}: ${errorText(error)}`);
        continue;
      }
      for (const task of tasks) {
        const conversation = conversations.find((entry) => entry.id === task.conversationId);
        if (conversation?.running === true) {
          this.settling.delete(task.id);
          continue;
        }
        if (conversation === undefined) {
          // boat can take a moment to list a new conversation.
          if (sandbox.state === "running" || now - Date.parse(task.updatedAt) < 3 * 60_000) continue;
          const reason = `Conversation ${task.conversationId} is missing from sandbox ${sandboxId}.`;
          const failed = this.store.transition(
            task.id,
            ["running"],
            { status: "failed", error: reason, finishedAt: new Date().toISOString() },
            { promptId: task.promptId },
          );
          if (failed === null) continue;
          this.store.addEvent(task.id, "failed", reason);
          this.sizes.afterTurn(failed, { failed: true, sandbox }); // sizes
          changed.push(task.id);
          continue;
        }
        if (await this.collectResult(task, sandbox)) changed.push(task.id);
      }
    }

    if (changed.length > 0) this.hooks.changed(changed);
    await this.deliverPending();
    if (settings.stopIdleAfterMinutes > 0) await this.stopIdleSandboxes(settings, sandboxes, now);
  }

  /** Tasks whose chat turn was seen running since the last follow-up. */
  private readonly chatTurnSeen = new Set<string>();
  /** Worker machines this plugin suspended (bb resumes them on the next message). */
  private readonly suspendedHosts = new Set<string>();

  /** Mirror a worker chat's state onto its task. Returns true when the task changed. */
  private async syncChat(initial: Task, now: number, hint?: ChatHint): Promise<boolean> {
    let task = initial;
    const chat = this.hooks.chat!;
    let state;
    try {
      state = await chat.state(task.threadId!);
    } catch (error) {
      this.hooks.log.warn(`sweep: chat ${task.threadId}: ${errorText(error)}`);
      return false;
    }
    const nowIso = new Date(now).toISOString();
    if (state !== null && task.environmentId === null && state.environmentId !== null) {
      task = this.store.update(task.id, { environmentId: state.environmentId }) ?? task;
    }
    if (state === null || state.archived || hint?.kind === "archived") {
      // Archived or deleted by hand: the work there is over, and so is its machine.
      const closed = this.store.transition(task.id, ["running", "idle", "failed"], { status: "cancelled", finishedAt: nowIso, shipApproval: null });
      if (closed === null) return false;
      this.store.addEvent(task.id, "cancelled", "The task chat was archived or deleted");
      const settings = await this.settings();
      if (settings.deleteSandboxOnClose) {
        if (await this.holdsUnshippedWork({ ...closed, status: "idle", finishedAt: closed.finishedAt ?? nowIso })) {
          // The only copy of unshipped work: keep the machine until the user decides.
          this.store.addEvent(task.id, "sandbox", `Kept sandbox ${closed.sandboxId}: it holds work that hasn't shipped. Delete it on the Cloud agents page to throw that away.`);
        } else {
          const removed = await this.removeMachineIfUnused(closed);
          if (removed === "deleted" && closed.sandboxId !== null) this.store.expirePreviewsForSandbox(closed.sandboxId);
        }
      }
      return true;
    }
    // Queued messages (a follow-up, a provider retry), background agents and
    // bb workflows mean the work isn't over even when the chat reads idle.
    const busy = (state.status !== "idle" && state.status !== "error") || state.queued > 0 || state.backgroundAgents > 0 || (state.workflows ?? 0) > 0;
    if (busy) {
      this.chatTurnSeen.add(task.id);
      if (task.hostId !== null) this.suspendedHosts.delete(task.hostId);
      if (task.status === "running") return false;
      // Someone wrote in the worker chat directly: that's a turn too.
      const started = this.store.transition(task.id, ["idle", "failed"], {
        status: "running",
        promptId: chatTurnMarker(),
        turns: task.turns + 1,
        error: null,
        finishedAt: null,
        notifiedAt: null,
        readyAt: null,
        readyNote: null,
      });
      if (started === null) return false;
      this.store.addEvent(task.id, "turn", "A new turn started in the chat");
      this.markChangedSinceReview(task);
      return true;
    }
    if (task.status !== "running") return false;
    // A follow-up bb hasn't started yet still reads idle. An idle/failed event
    // after the send proves the turn ended; otherwise wait until the chat was
    // seen busy, or a minute passed.
    const sentAt = chatSentAt(task);
    const eventEnded = (hint?.kind === "idle" || hint?.kind === "failed") && (sentAt === null || (hint.at ?? now) >= sentAt);
    if (!eventEnded && !this.chatTurnSeen.has(task.id) && sentAt !== null && now - sentAt < 60_000) return false;
    this.chatTurnSeen.delete(task.id);
    let text = hint?.kind === "idle" && hint.text !== undefined ? (hint.text ?? "") : "";
    if (hint?.kind !== "idle") {
      try {
        text = (await chat.output(task.threadId!)) ?? "";
      } catch (error) {
        this.hooks.log.warn(`sweep: chat output ${task.threadId}: ${errorText(error)}`);
      }
    }
    // bb's output is the chat's last answer: the same text as before means
    // this turn ended without a new one (stopped, interrupted).
    // A chat the plugin just opened (a move to a chat, a handover to the other
    // agent) has no answer of its own yet: its first one is new even when it
    // repeats the latest report.
    const fresh = text.trim() !== "" && (this.firstTurnInChat(task) || text.trim() !== (task.result ?? "").trim());
    const guard = { promptId: task.promptId };
    if (state.status === "error" || hint?.kind === "failed") {
      const reason = hint?.error?.trim() || (fresh ? text.trim().split("\n").at(-1) ?? "" : "");
      if (USAGE_LIMIT_PATTERN.test(`${hint?.error ?? ""}\n${fresh ? text : ""}`) && (await this.chatFailover(task, reason || "usage limit"))) return true;
      const error = `The task chat stopped with an error${reason ? `: ${clip(reason, 300)}` : "."} Open the chat to see why.`;
      const failed = this.store.transition(
        task.id,
        ["running"],
        { status: "failed", error, result: fresh ? clipResult(text) : task.result, finishedAt: nowIso },
        guard,
      );
      if (failed === null) return false;
      if (fresh) this.recordEvidence(task.id, text);
      this.store.addEvent(task.id, "failed", error);
      this.sizes.afterTurn(failed, { failed: true }); // sizes
      await this.noteUnshipped(failed);
      return true;
    }
    const report = fresh ? parseReport(text) : { status: null, verdict: null };
    const prUrl = (fresh ? extractPrUrl(text) : null) ?? task.prUrl;
    // The plugin wakes the dispatching thread with a [boat] notice now that the
    // turn is recorded (notifiedAt stays empty for deliverPending).
    const done = this.store.transition(
      task.id,
      ["running"],
      {
        status: "idle",
        result: fresh ? clipResult(text) : "(The turn ended without a new message.)",
        prUrl,
        error: null,
        finishedAt: nowIso,
      },
      guard,
    );
    if (done === null) return false;
    if (fresh) {
      this.recordEvidence(task.id, text);
      await this.hostReportedPreview(done, text);
    }
    this.store.addEvent(
      task.id,
      "finished",
      [
        fresh ? "Turn finished" : "Turn ended without a new message",
        report.verdict ? `verdict ${report.verdict}` : report.status ? `status ${report.status}` : null,
        prUrl && prUrl !== task.prUrl ? `PR ${prUrl}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
    if (task.role === "review" && task.parentTaskId !== null && report.verdict !== null) {
      this.store.addEvent(task.parentTaskId, "review", `Review ${task.id}: ${report.verdict}`);
    }
    // A turn that ended without a new message may have been cut short (sizes).
    this.sizes.afterTurn(done, { failed: !fresh });
    await this.noteUnshipped(done);
    return true;
  }

  /** A worker chat hit a usage limit: the other agent continues in a new chat in the same workspace. */
  private async chatFailover(task: Task, reason: string): Promise<boolean> {
    const settings = await this.settings();
    // With one agent there's nobody to hand over to.
    if (!settings.autoFailover || onlyAgent(settings.agents) !== null) return false;
    if (this.store.events(task.id, 1).at(-1)?.kind === "failover") return false;
    const next: Provider = task.provider === "claude" ? "codex" : "claude";
    const tier = isTier(task.tier) ? task.tier : null;
    const choice = tier === null ? null : choiceFor(settings.modelTiers, tier, next);
    const model = agentModel("chat", next, choice?.model ?? defaultModelFor(next, settings));
    const reasoningEffort = choice?.effort ?? null;
    // What the stopped agent was working on: this turn's start (a failover hands the same turn over).
    const start = this.store.events(task.id, 200).filter((event) => HANDOVER_TURN_STARTS.has(event.kind)).at(-1) ?? null;
    // The first turn after a move only reads up: the next agent does that instead, from the old conversation.
    const fromBoat = start?.kind === "moved-to-chat";
    const lastFollowup =
      start?.kind === "followup" ? start.text : start?.kind === "followup-switch" ? start.text.replace(/^\([a-z]+ → [a-z]+\) /, "") : null;
    const marker = chatTurnMarker();
    const claimed = this.store.transition(
      task.id,
      ["running"],
      { provider: next, model, reasoningEffort, promptId: marker, turns: task.turns + 1 },
      { promptId: task.promptId },
    );
    if (claimed === null) return false;
    try {
      const threadId = await this.openHandoverChat(task, { provider: next, model, reasoningEffort, tier, why: fromBoat ? "from-boat" : "usage-limit", message: lastFollowup });
      this.store.update(task.id, { threadId });
      // The old chat must not resume (bb may retry it after the reset) in the same checkout.
      await this.hooks.chat!.stop(task.threadId!).catch(() => undefined);
      await this.hooks.chat!.archive(task.threadId!).catch(() => undefined);
      this.store.addEvent(
        task.id,
        "failover",
        `${task.provider} hit a usage limit; continued with ${next} · ${modelLine(tier, model, reasoningEffort, null)} in @thread:${threadId}. (${clip(reason.split("\n")[0] ?? "", 200)})`,
      );
      return true;
    } catch (error) {
      this.hooks.log.warn(`chat failover ${task.id}: ${errorText(error)}`);
      this.store.transition(
        task.id,
        ["running"],
        { provider: task.provider, model: task.model, reasoningEffort: task.reasoningEffort, promptId: task.promptId, turns: task.turns },
        { promptId: marker },
      );
      return false;
    }
  }

  /** Read the final answer of the task's last turn and record it. Returns true when the task changed. */
  private async collectResult(task: Task, sandbox: Sandbox): Promise<boolean> {
    if (task.sandboxId === null || task.conversationId === null) return false;
    let events;
    try {
      events = await this.boat.events(task.sandboxId, task.conversationId, this.hooks.lifecycle);
    } catch (error) {
      this.hooks.log.warn(`sweep: events ${task.id}: ${errorText(error)}`);
      return false;
    }
    const status = promptStatus(events, task.promptId);
    const terminal = status === "finished" || status === "failed" || status === "interrupted";
    if (!terminal) {
      // The conversation list and the event log can disagree for a moment;
      // a turn that stays unfinished on a sandbox that is not working was
      // cut off (the sandbox stopped mid-turn).
      if (sandbox.state === "running") return false;
      const firstSeen = this.settling.get(task.id);
      if (firstSeen === undefined) {
        this.settling.set(task.id, Date.now());
        return false;
      }
      if (Date.now() - firstSeen < SETTLE_MS) return false;
    }
    const text = finalResponse(events, task.promptId) ?? "";
    if (status === "finished" && !/=== (REPORT|REVIEW) ===/.test(text)) {
      // boat can record "finished" before the last reply lands; give a
      // report-less answer one more look before accepting it.
      const firstSeen = this.settling.get(task.id);
      if (firstSeen === undefined) {
        this.settling.set(task.id, Date.now());
        return false;
      }
      if (Date.now() - firstSeen < SETTLE_MS) return false;
    }
    this.settling.delete(task.id);
    const failedEvent = events.filter((event) => event.type === "prompt" && event.status === "failed").at(-1);
    const nowIso = new Date().toISOString();
    const guard = { promptId: task.promptId };
    // A failed turn that mentions limits, or a short "finished" turn whose
    // whole answer is a harness limit notice (Claude Code prints one).
    const limitHit =
      (status === "failed" && USAGE_LIMIT_PATTERN.test(`${failedEvent?.error ?? ""}\n${text}`)) ||
      (status === "finished" && text.length < 400 && LIMIT_NOTICE_PATTERN.test(text));
    if (limitHit) {
      const switched = await this.failover(task, `${failedEvent?.error ?? ""}\n${text}`.trim());
      if (switched !== null) return true;
    }
    if (status === "failed") {
      const reason = failedEvent?.error ?? "The agent turn failed (harness or credential error).";
      const updated = this.store.transition(
        task.id,
        ["running"],
        { status: "failed", error: clip(reason, 4000), result: text === "" ? task.result : clipResult(text), finishedAt: nowIso },
        guard,
      );
      if (updated === null) return false;
      if (text !== "") this.recordEvidence(task.id, text);
      this.store.addEvent(task.id, "failed", reason);
      this.sizes.afterTurn(updated, { failed: true, sandbox }); // sizes
      await this.noteUnshipped(updated, sandbox);
      return true;
    }
    const cutOff = !terminal;
    const prUrl = extractPrUrl(text) ?? task.prUrl;
    const report = parseReport(text);
    const updated = this.store.transition(
      task.id,
      ["running"],
      {
        status: "idle",
        result: clipResult(text || "(The agent finished without a final message.)"),
        prUrl,
        error: cutOff
          ? `${CUT_OFF_ERROR} (sandbox ${sandbox.state}). Send a follow-up to continue.`
          : status === "interrupted"
            ? "The turn was interrupted."
            : null,
        finishedAt: nowIso,
      },
      guard,
    );
    if (updated === null) return false;
    this.recordEvidence(task.id, text);
    if (status === "finished") await this.hostReportedPreview(updated, text);
    const summary = [
      cutOff ? "Turn cut off" : status === "interrupted" ? "Turn interrupted" : "Turn finished",
      report.verdict ? `verdict ${report.verdict}` : report.status ? `status ${report.status}` : null,
      prUrl && prUrl !== task.prUrl ? `PR ${prUrl}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    this.store.addEvent(task.id, "finished", summary);
    if (task.role === "review" && task.parentTaskId !== null && report.verdict !== null) {
      this.store.addEvent(task.parentTaskId, "review", `Review ${task.id}: ${report.verdict}`);
    }
    this.sizes.afterTurn(updated, { failed: cutOff, interrupted: status === "interrupted", sandbox }); // sizes
    await this.noteUnshipped(updated, sandbox);
    return true;
  }

  /**
   * The agent hit a subscription usage limit: continue the same conversation
   * with the other agent (boat hands over the transcript). One switch per turn.
   */
  private async failover(task: Task, reason: string): Promise<Task | null> {
    const settings = await this.settings();
    if (!settings.autoFailover || onlyAgent(settings.agents) !== null || task.sandboxId === null || task.conversationId === null) return null;
    const last = this.store.events(task.id, 1).at(-1);
    if (last?.kind === "failover") return null;
    const next: Provider = task.provider === "claude" ? "codex" : "claude";
    // Same tier on the other agent; without a tier, its configured default.
    const tier = isTier(task.tier) ? task.tier : null;
    const choice = tier === null ? null : choiceFor(settings.modelTiers, tier, next);
    // boat conversations take boat's ids and stop at max.
    const model = agentModel("boat", next, choice?.model ?? defaultModelFor(next, settings));
    const reasoningEffort = boatEffort(choice?.effort ?? null);
    const release = this.claim(task.sandboxId);
    try {
      await this.ensureRunning(task.sandboxId, this.hooks.lifecycle);
      const dispatch = await this.boat.prompt({
        sandboxId: task.sandboxId,
        conversationId: task.conversationId,
        provider: next,
        model,
        reasoningEffort,
        signal: this.hooks.lifecycle,
        prompt: `# Continue the task\n\nThe previous agent (${task.provider}) stopped because it hit a usage limit. You are taking over the same task in the same workspace with the full conversation so far. Check the current state (git status, git log, tests), then continue from where it stopped and finish the task as originally briefed, including the final report block.${tier === "deep" ? `\n\n## Working mode\n${deepMode(next)}` : ""}`,
      });
      const updated = this.store.transition(
        task.id,
        ["running"],
        { provider: next, model: dispatch.model ?? model, reasoningEffort, promptId: dispatch.promptId, turns: task.turns + 1 },
        { promptId: task.promptId },
      );
      if (updated === null) {
        await this.boat.interrupt(task.sandboxId, task.conversationId).catch(() => undefined);
        return null;
      }
      this.store.addEvent(
        task.id,
        "failover",
        `${task.provider} hit a usage limit; continued with ${next} · ${modelLine(tier, dispatch.model ?? model, reasoningEffort, null)}. (${clip(reason.split("\n")[0] ?? "", 200)})`,
      );
      return updated;
    } catch (error) {
      this.hooks.log.warn(`failover ${task.id}: ${errorText(error)}`);
      return null;
    } finally {
      release();
    }
  }

  /**
   * Tell dispatching threads about finished turns they have not heard about.
   * Driven by stored state, so a failed send or a restart is retried on the
   * next sweep instead of leaving an orchestrator waiting.
   */
  deliverPending(): Promise<void> {
    if (this.delivering === null) {
      this.delivering = this.runDelivery().finally(() => {
        this.delivering = null;
      });
    }
    return this.delivering;
  }

  private async runDelivery(): Promise<void> {
    const byThread = new Map<string, Task[]>();
    for (const task of this.store.pendingNotifications()) {
      const list = byThread.get(task.orchestratorThreadId!) ?? [];
      list.push(task);
      byThread.set(task.orchestratorThreadId!, list);
    }
    for (const [threadId, all] of byThread) {
      // A preview still being hosted, a memory check, or what changed since a
      // ship's approval: the notice goes out with them, on the next pass.
      const list = all.filter((task) => {
        if (this.needsComparison(task)) void this.compareSinceApproval(task);
        return !this.comparing.has(task.id) && !this.hostingPreviews.has(task.id) && !this.sizes.holds(task.id);
      });
      if (list.length === 0) continue;
      try {
        await this.hooks.notify({ threadId, tasks: list });
        const at = new Date().toISOString();
        for (const task of list) this.store.update(task.id, { notifiedAt: at });
      } catch (error) {
        if (!(error instanceof DeliveryDeferred)) this.hooks.log.warn(`notify ${threadId}: ${errorText(error)}`);
      }
    }
  }

  /** Worker machine → since when the idle stop sees background work there (its limit counts from then). */
  private readonly backgroundSince = new Map<string, number>();

  /** `boat ps` readings per sandbox: the busy programs (by executable name), reused a few minutes. */
  private readonly processChecks = new Map<string, { at: number; busy: string[]; verdict: Computing }>();

  /**
   * Processes a headless task's finished agent left are still computing
   * there (`boat ps`): "busy" when the same program was busy in two
   * readings a few minutes apart (a build's compiler processes come and
   * go, so by program, not pid); "maybe" after a first busy reading, until
   * the next one decides. Unknown counts as "no".
   */
  async processesBusy(sandboxId: string, now = Date.now()): Promise<Computing> {
    const cached = this.processChecks.get(sandboxId);
    if (cached !== undefined && now - cached.at < PROCESS_CHECK_MS) return cached.verdict;
    const sample = await this.boat.processes(sandboxId, this.hooks.lifecycle).catch(() => null);
    const busy = [...new Set(busyProcesses(sample).map((entry) => programName(entry.command)))];
    const again = cached !== undefined && now - cached.at < 4 * PROCESS_CHECK_MS && busy.some((name) => cached.busy.includes(name));
    const verdict: Computing = busy.length === 0 ? "no" : again ? "busy" : "maybe";
    this.processChecks.set(sandboxId, { at: now, busy, verdict });
    for (const [id, entry] of this.processChecks) if (now - entry.at > 4 * PROCESS_CHECK_MS) this.processChecks.delete(id);
    return verdict;
  }

  /**
   * Work the plugin's own records don't show runs on a worker machine: a
   * chat at work there (any thread), a queued message, or background work.
   * Unknown counts as busy. (Not for headless sandboxes: see processesBusy.)
   */
  private async machineBusy(tasks: Task[]): Promise<boolean> {
    const hostId = tasks.find((task) => task.runner === "chat" && task.hostId !== null)?.hostId ?? null;
    if (hostId === null || this.hooks.chat === undefined) return false;
    const activity = await this.hooks.chat.machineActivity(hostId).catch(() => null);
    return activity === null || activity.turns || activity.waiting || hasWork(activity.background);
  }

  /** Stop plugin-created sandboxes whose tasks have all been waiting for a while. */
  private async stopIdleSandboxes(settings: BoatSettings, sandboxes: Map<string, Sandbox>, now: number): Promise<void> {
    const threshold = settings.stopIdleAfterMinutes * 60_000;
    // Worker chat machines: suspend through bb once every task on them has waited long enough.
    if (this.hooks.chat !== undefined) {
      const byHost = new Map<string, Task[]>();
      for (const task of this.store.list({ statuses: OPEN_STATUSES, limit: 1000 })) {
        if (task.runner !== "chat" || task.hostId === null) continue;
        byHost.set(task.hostId, [...(byHost.get(task.hostId) ?? []), task]);
      }
      for (const [hostId, tasks] of byHost) {
        if (this.suspendedHosts.has(hostId)) continue;
        // A turn runs: background work after it is new work (its 12 hours start over).
        if (tasks.some((task) => task.status === "running" || task.status === "starting")) {
          this.backgroundSince.delete(hostId);
          continue;
        }
        // A wake, ship or dispatch holds the sandbox right now.
        if (tasks.some((task) => task.sandboxId !== null && this.claims.has(task.sandboxId))) continue;
        // A live preview the user hasn't looked at yet keeps the machine on.
        if (tasks.some((task) => task.sandboxId !== null && this.hasLivePreview(task.sandboxId))) continue;
        if (now - Math.max(...tasks.map((task) => Date.parse(task.updatedAt))) < threshold) continue;
        const sandbox = tasks[0]!.sandboxId === null ? undefined : sandboxes.get(tasks[0]!.sandboxId);
        if (sandbox !== undefined && sandbox.state !== "idle") continue;
        // The task's chats (an extra one the user opened, a reviewer) may still be at work.
        const chats = [...new Set(tasks.flatMap((task) => this.store.chatThreads(task.id)))];
        let busy = false;
        for (const threadId of chats) {
          const state = await this.hooks.chat.state(threadId).catch(() => null);
          if (state !== null && !state.archived && ((state.status !== "idle" && state.status !== "error") || state.queued > 0 || state.backgroundAgents > 0 || (state.workflows ?? 0) > 0)) {
            busy = true;
            break;
          }
        }
        if (busy) {
          this.backgroundSince.delete(hostId);
          continue;
        }
        // So may every other chat on the machine (a workflow's, one bb started),
        // and work left running in the background (background commands, bb
        // workflows, child chats).
        let activity;
        try {
          activity = await this.hooks.chat.machineActivity(hostId);
        } catch (error) {
          // bb couldn't say: no stop on a guess.
          this.hooks.log.warn(`idle stop ${hostId}: ${errorText(error)}`);
          continue;
        }
        if (activity.turns || activity.waiting) {
          this.backgroundSince.delete(hostId);
          continue;
        }
        // Background work keeps it on, up to the keeper's limit from when the idle stop first saw it.
        const background = hasWork(activity.background);
        if (!background) this.backgroundSince.delete(hostId);
        else {
          const since = this.backgroundSince.get(hostId) ?? now;
          this.backgroundSince.set(hostId, since);
          if (now - since < KEEP_LIMIT_MS) continue;
        }
        try {
          await this.hooks.chat.suspendMachine(hostId);
          this.suspendedHosts.add(hostId);
          this.backgroundSince.delete(hostId);
          this.hooks.machineSuspended?.(hostId, background);
          const hours = Math.round(KEEP_LIMIT_MS / 3_600_000);
          for (const task of tasks) {
            this.store.addEvent(
              task.id,
              "sandbox-stopped",
              background
                ? `Machine suspended: ${describeWork(activity.background)} had been running in the background for ${hours} hours, the most the plugin keeps a sandbox on for it. bb resumes it on the next message.`
                : `Machine suspended after ${settings.stopIdleAfterMinutes} idle minutes; bb resumes it on the next message.`,
            );
          }
          this.hooks.changed(tasks.map((task) => task.id));
        } catch (error) {
          this.hooks.log.warn(`suspend ${hostId}: ${errorText(error)}`);
        }
      }
    }
    const idle = this.store.list({ statuses: ["idle", "failed"], limit: 1000 });
    const seen = new Set<string>();
    for (const task of idle) {
      const sandboxId = task.sandboxId;
      if (sandboxId === null || seen.has(sandboxId) || this.claims.has(sandboxId)) continue;
      seen.add(sandboxId);
      const sandbox = sandboxes.get(sandboxId);
      if (sandbox === undefined || sandbox.state !== "idle") continue;
      if (!this.store.pluginOwnsSandbox(sandboxId)) continue;
      if (this.hasLivePreview(sandboxId)) continue;
      const tasks = this.store.liveSandboxTasks(sandboxId);
      // bb manages machines of worker chats (it suspends idle ones itself).
      if (tasks.some((entry) => entry.runner === "chat")) continue;
      if (tasks.some((entry) => entry.status === "running" || entry.status === "starting")) {
        this.backgroundSince.delete(sandboxId);
        continue;
      }
      const latest = Math.max(...tasks.map((entry) => Date.parse(entry.updatedAt)));
      if (now - latest < threshold) continue;
      // Processes the finished agent left computing (a build, tests) keep it on, up to
      // the keeper's limit. A first busy reading waits for the next one to decide.
      const computing = await this.processesBusy(sandboxId, now);
      if (computing === "maybe") continue;
      if (computing === "busy") {
        const since = this.backgroundSince.get(sandboxId) ?? now;
        this.backgroundSince.set(sandboxId, since);
        if (now - since < KEEP_LIMIT_MS) continue;
      }
      this.backgroundSince.delete(sandboxId);
      try {
        await this.boat.stop(sandboxId, this.hooks.lifecycle);
        const hours = Math.round(KEEP_LIMIT_MS / 3_600_000);
        for (const entry of tasks) {
          this.store.addEvent(
            entry.id,
            "sandbox-stopped",
            computing === "busy"
              ? `Sandbox stopped: processes the agent started had been computing for ${hours} hours, the most the plugin keeps a sandbox on for them. It resumes on follow-up.`
              : `Sandbox stopped after ${settings.stopIdleAfterMinutes} idle minutes; it resumes on follow-up.`,
          );
        }
        if (computing === "busy") this.hooks.processesStopped?.(sandboxId, now);
        this.hooks.changed(tasks.map((entry) => entry.id));
      } catch (error) {
        this.hooks.log.warn(`idle stop ${sandboxId}: ${errorText(error)}`);
      }
    }
  }
}
