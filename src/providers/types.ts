// Sandbox providers: the services whose cloud sandboxes this plugin's agents
// work in. boat.dev (src/providers/boat/) is the only one today and the
// default. The rest of the plugin reaches a provider only through this
// interface, and asks the registry (./registry.ts) which provider a
// project's new work and each task's sandbox use.
//
// The members are what the plugin does with boat.dev today, named and typed
// so another provider can offer the same; each says which boat call it
// replaces (Instabox, src/providers/instabox/, offers all of them too).
// Members marked optional are what one provider has and another doesn't, or
// for later providers. The plugin's own repo steps (checkout, GitHub login,
// ship) aren't members: they run over any provider's exec
// (src/sandbox-repos.ts).
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import type { FidelityUsageDto } from "../../contract-fidelity.ts";
import type { SandboxUsage } from "../usage.ts";
import type { Provider } from "../store.ts";

/** The provider a task record without one means: boat.dev, the only one before there were providers. */
export const DEFAULT_PROVIDER_ID = "boat";

/** Every provider this plugin has an adapter for: where a project's work can run. */
export const PROVIDER_IDS = ["boat", "instabox", "scaleway", "ownmac"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
/** Their names in the plugin's words (a provider that isn't enabled is named too). */
export const PROVIDER_NAMES: Record<ProviderId, string> = { boat: "boat.dev", instabox: "Instabox", scaleway: "Scaleway", ownmac: "Your Mac" };

// ------------------------------------------------------------------ sizes and states

/**
 * The sizes the plugin offers (the contract's size values). They are
 * boat.dev's (`--type`); another provider maps its sizes onto these.
 */
export const MACHINE_TYPES = ["small", "default", "large", "xlarge"] as const;
export type MachineType = (typeof MACHINE_TYPES)[number];

/** One size a provider offers. */
export interface SizeOption {
  id: MachineType;
  label: string;
  cpus: number;
  /** As the provider names it ("8 GB"); the VM's MemTotal is a little less. */
  memoryGb: number;
}

/**
 * States in which a sandbox is up and counts against the account's limit.
 * SandboxInfo.state uses boat.dev's state names, which are the plugin's
 * state model for now; another provider maps its states onto them
 * (transitional: provisioning, starting, stopping, archiving, resuming,
 * pending; stopped: stopped, archived; dead: error, cancelled). "running"
 * means the provider's own agent is working there (caps.agentBusyState).
 */
export const ACTIVE_STATES: ReadonlySet<string> = new Set(["provisioned", "cloning", "ready", "idle", "running"]);

/** A sandbox as its provider reports it. */
export interface SandboxInfo {
  id: string;
  name: string | null;
  /** The state, in the plugin's state model (see ACTIVE_STATES). */
  state: string;
  health: string | null;
  url: string | null;
  desktopUrl: string | null;
  /** The provider environment it started from. */
  environment: string | null;
  createdAt: string | null;
  /** When the provider's auto-stop stops it (ISO), while it's up. */
  archiveAfter: string | null;
  stoppedAt: string | null;
  setupStatus: string | null;
  error: string | null;
  /** Its size, when the provider says (not verified that boat.dev does; the memory probe is what counts). */
  scheduledReleaseAt?: string | null;
  system?: "linux" | "macos";
  mac?: { model: string; leaseId: string; startedAt: string; chargeUntil: string; minimumCost: number; hourPrice: number; cpus: number; memoryMiB: number };
  machineType?: MachineType | null;
}

// ------------------------------------------------------------------ capabilities and capacity

/**
 * What a provider's sandboxes are like. The plugin branches on a few
 * (environments, concurrencyUnit, retentionAfterStopSeconds, idlePause); the
 * rest record what it assumes.
 */
export interface SandboxCapabilities {
  os: "linux" | "macos";
  /**
   * The systems it can start sandboxes on now (absent: only `os`). Settings
   * marks a system ready only when it's here, never because the provider's
   * service offers it somewhere.
   */
  systems?: readonly ("linux" | "macos" | "windows")[];
  /** Every exec runs its script in this shell, as a login shell (`bash -lc`). */
  shell: "bash";
  /** The sandbox user's home folder: checkouts in ~/work, the plugin's git hooks. */
  homeDir: string;
  /** The longest one exec may run, in seconds. */
  execMaxSeconds: number;
  /** A stop keeps the disk, the checkouts and the agent's conversations. */
  stopKeepsDisk: boolean;
  /** How long the provider keeps a stopped sandbox before deleting it (null: no limit). */
  retentionAfterStopSeconds: number | null;
  /** Named environments new sandboxes start from (repos, secrets, agent logins): `environment` settings apply. */
  environments: boolean;
  /**
   * The provider pauses a running sandbox on its own once it looks idle
   * (Instabox: 30 minutes, memory kept). seesBbActivity false: a bb chat
   * working there doesn't count, so the plugin keeps it awake while a turn
   * runs (an activity lease).
   */
  idlePause?: { minutes: number; seesBbActivity: boolean } | null;
  /** The provider stops a sandbox on its own after a time limit set at create and resume. */
  autoStop: {
    /** It can be moved out while the sandbox runs (extend). */
    extendable: boolean;
    /** It counts a bb chat working there (boat.dev's doesn't: the plugin's keeper moves it out). */
    seesBbActivity: boolean;
  } | null;
  /** The state says when the provider's own agent works ("running"). */
  agentBusyState: boolean;
  /**
   * Its wakes go through the plugin's wake pacer (src/wake-pacer.ts: 2 a
   * minute account-wide, a pause after a failed one): boat.dev restores a
   * woken disk lazily and limits starts. Absent: its wakes aren't paced,
   * and never take or hold one of boat.dev's.
   */
  pacedWakes?: boolean;
  /** How a sandbox port is opened: a link that carries its own token. */
  previews: "token-link";
  /** bb can run its daemon there (task chats and cloud orchestrators). */
  bbEnrollment: boolean;
  /** False when agents run only through enrolled bb task chats. Default: true. */
  headlessAgentRunner?: boolean;
  /**
   * What the account's limit on sandboxes counts: "sandboxes" the ones up
   * (a stop frees a slot: the plugin may make room by stopping an idle one);
   * "kept-sandboxes" every sandbox the account keeps, stopped and paused ones
   * included (only a delete frees one: the plugin never makes room).
   */
  concurrencyUnit: "sandboxes" | "kept-sandboxes";
}

/** What the provider account allows now (boat limits). */
export interface CapacityReport {
  /** The plan's tier or name (null: not said). */
  tier: string | null;
  /** The plan's limits in one line, as the provider words them. */
  summary: string | null;
  /** Sandboxes up now, on the whole account. */
  activeSandboxes: number;
  maxActiveSandboxes: number | null;
  startsLeftToday: number | null;
  startsLeftThisHour: number | null;
  canStart: boolean;
  blockedReason: string | null;
  /** The account has no plan yet (it asks for a checkout first). */
  checkoutRequired: boolean;
  /** The plan's cap on a sandbox's auto-stop, in hours (null: none). */
  autoStopCapHours: number | null;
  /** Included starts left this minute (null: not said). */
  startsLeftThisMinute?: number | null;
  /** The plan has no start limit. */
  startsUnlimited?: boolean | null;
  /** The provider's paid extra starts are on (boat: "keep going", `boat billing extra-starts`); the plugin never turns them on. */
  extraStartsEnabled?: boolean | null;
  /** What the next start costs, in dollars (0: included; null: not said). */
  nextStartDollars?: number | null;
  /**
   * The sizes the plan allows, when the provider says so here (boat.dev's
   * come from its setup reading instead). Absent or null: not said.
   */
  machineTypes?: { type: MachineType; available: boolean; reason: string | null }[] | null;
}

/** The plan's included hours this period (null: the provider doesn't say). */
export type UsagePlan = FidelityUsageDto["plan"];
export type { SandboxUsage };

/** Hours a new sandbox runs before its provider stops it: the Hard stop setting, within the plan's cap (null: none known). */
export function autoStopHours(settingHours: number, capHours: number | null, floor = 0.25): number {
  const hours = Math.max(floor, settingHours);
  return capHours === null ? hours : Math.min(hours, capHours);
}

// ------------------------------------------------------------------ errors

/**
 * A provider's error: its own code (boat.dev's: not_found, unauthorized,
 * repo_access, ship_conflict, …) and the HTTP status, if any. Providers
 * throw subclasses (BoatError).
 */
export class ProviderError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly exitCode: number | null;
  constructor(message: string, options: { code?: string; status?: number | null; exitCode?: number | null } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = options.code ?? "provider_failed";
    this.status = options.status ?? null;
    this.exitCode = options.exitCode ?? null;
  }

  /** In plain words, with what to do (a provider's subclass words its own). */
  explain(): ExplainedError {
    return { code: this.code, message: this.message, hint: null };
  }
}

/** The provider says the sandbox doesn't exist (any more). */
export function isNotFound(error: unknown): boolean {
  return error instanceof ProviderError && (error.code === "not_found" || error.status === 404);
}

/** A provider error in plain words, with what to do (the CLI, the page and agent tools share them). */
export interface ExplainedError {
  code: string;
  message: string;
  hint: string | null;
}

/** What a provider said of a stop (boat stop). */
export interface StopReport {
  /** pending, failing, completed, superseded (null: not said). */
  status: string | null;
  /** The stop's id, to ask after it (stopStatus). */
  stopId: string | null;
  /** A forced stop: whether the provider forced it (false: it's still pending instead). */
  forced: boolean | null;
  /**
   * The provider's reason when it won't stop it (boat.dev: "Final snapshot
   * failed; stop aborted to protect unsaved data …"), even while the status
   * still reads pending. Non-null: refused. Absent or null: none given.
   */
  error?: string | null;
}

// ------------------------------------------------------------------ exec and processes

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** One process in a sandbox (unknown fields null). */
export interface SandboxProcess {
  pid: number | null;
  /** The full command line. */
  command: string;
  cpuPercent: number | null;
  memoryMb: number | null;
  /** The provider command it belongs to (boat.dev: cmd_…), if it says. */
  commandId: string | null;
  parentPid?: number | null;
  startedAt?: string | null;
  /** The user it runs as ("root", "user"). */
  user?: string | null;
}

/** A sandbox's processes, live or (stopped) its last stored sample. */
export interface ProcessSample {
  /** False: the last stored sample (the sandbox is stopped, or its agent is older); null: not said. */
  live: boolean | null;
  sampledAt: string | null;
  processes: SandboxProcess[];
}

// ------------------------------------------------------------------ repos

export type CheckoutMode =
  | { kind: "new-branch"; branch: string; base: string | null }
  | { kind: "existing-branch"; branch: string }
  | { kind: "pull-request"; pr: string }
  /** Check out the base branch itself (read-only use: context repos, reviews). */
  | { kind: "default-branch"; base?: string | null };

export interface PrepareOptions {
  signal?: AbortSignal;
  /** Subfolder of ~/work for this checkout (one per task, so tasks sharing a sandbox never share a working tree). */
  workDir?: string | null;
  /** Branches a pre-push hook refuses to push to from this checkout (base branches). */
  protect?: readonly string[];
  /** Branches refused from every checkout in the sandbox (default: main and master). */
  alwaysProtect?: readonly string[];
  /**
   * Use the copy the provider environment already cloned into ~/<repo name>
   * (setup script and dependencies done) when it's there. Only for a sandbox
   * the task has to itself.
   */
  useEnvironmentCheckout?: boolean;
  /**
   * The project ships after the user approves: the worker only commits, and
   * the pre-push hook refuses every push from this checkout (the plugin's
   * ship step pushes with --no-verify).
   */
  noPush?: boolean;
  /** The sandbox's provider environment (named in error hints). */
  environment?: string | null;
}

export interface PreparedRepo {
  path: string;
  branch: string | null;
  baseBranch: string | null;
  /** What the sandbox's GitHub login may do there (null: couldn't tell). */
  canPush?: boolean | null;
  /** When the sandbox's GitHub token expires (ISO), if GitHub said. */
  githubExpiresAt?: string | null;
}

/** The sandbox's GitHub login now: still valid (null: couldn't tell), and until when. */
export interface GithubLogin {
  valid: boolean | null;
  expiresAt: string | null;
}

/** One repo the ship step pushes: its checkout and the branch it lands on. */
export interface ShipTarget {
  path: string;
  baseBranch: string;
}

export interface ShipResult {
  /** Repos whose commits landed, with the new head and how many commits. */
  shipped: { path: string; baseBranch: string; sha: string; commits: number }[];
}

/** What a ship's rebase stopped on (the ship script's conflict detail). */
export interface ShipConflict {
  /** The task's head commit and the base commit the rebase ran onto (null: not printed). */
  head: string | null;
  base: string | null;
  /** The conflicting files (at most 10) and how many more there were. */
  files: string[];
  moreFiles: number;
  /** Up to 3 base commits since the task's fork point that changed those files. */
  commits: { sha: string; subject: string }[];
}

// ------------------------------------------------------------------ previews, snapshots, environments

/** A sandbox port on a stable HTTPS link; a private one carries its token in the query. */
export interface HostedPort {
  url: string;
  port: number;
  title: string | null;
  isProtected: boolean;
}

/** A saved snapshot, which a new sandbox can start from. */
export interface SavedSnapshot {
  name: string;
  sizeBytes: number | null;
  createdAt: string | null;
  sourceSandboxId: string | null;
  status: string | null;
  type: string | null;
}

/** A provider environment, as the plugin shows it: secret NAMES only, never values. */
export interface EnvironmentInfo {
  name: string;
  secretNames: string[];
  secretFiles: string[];
  /** Repos the environment clones, with the permission the provider's GitHub access has. */
  repos: { repo: string; permission: string | null; baseBranch: string | null }[];
  /** What sandboxes really get ("Safe for third parties" turns these off on boat.dev). */
  passGithub: boolean | null;
  passSecrets: boolean | null;
  passAgentsCredentials: boolean | null;
  /** The provider's own login in the sandbox, for the whole account. */
  passSandboxCredentials: boolean | null;
  /** With "Safe for third parties": AI logins still go in, as proxy placeholders. */
  proxyAiCredentials: boolean | null;
  safeForThirdParties: boolean | null;
}

/**
 * The account's AI credentials proxy, a paid add-on: on, sandboxes get
 * placeholder AI keys and real keys never enter them.
 */
export interface AiProxyState {
  /** null: couldn't tell. */
  enabled: boolean | null;
  /** What it costs, as the provider prices it (null: not reported). */
  dailyDollars: number | null;
  dollarsPer1000Requests: number | null;
}

// ------------------------------------------------------------------ the agent runner

/** One conversation of the provider's agent runner in a sandbox. */
export interface Conversation {
  id: string;
  running: boolean;
  harness: string | null;
  model: string | null;
  prompts: number;
  lastPromptAt: string | null;
  lastPromptPreview: string | null;
}

export interface ChatEvent {
  type: string;
  /** The prompt run this event belongs to (the promptId a prompt returned). */
  promptId: string | null;
  conversationId: string | null;
  status: string | null;
  content: string | null;
  /** Failure reason on a failed prompt event. */
  error: string | null;
  timestamp: number | null;
  tools: string[];
}

/** A turn the runner queued. */
export interface Dispatch {
  conversationId: string;
  promptId: string | null;
  model: string | null;
}

export interface PromptOptions {
  sandboxId: string;
  prompt: string;
  /** The agent, always explicit: without it boat.dev uses its dashboard default. */
  provider: Provider;
  /** The provider's model id and effort (src/tiers.ts maps the plugin's tiers onto them). */
  model?: string | null;
  reasoningEffort?: string | null;
  /** Continue this conversation; a new one gets an id the provider is told (known before dispatch). */
  conversationId?: string | null;
  signal?: AbortSignal;
}

// ------------------------------------------------------------------ bb machines

/**
 * The bb machine provider a sandbox provider registers (./machine.ts), so
 * bb chats can run in its sandboxes: task chats, cloud orchestrators, and
 * native chats on a new sandbox. The words are the provider's.
 */
export interface MachineSpec {
  /** bb's machine provider id; bb stores it on every machine and host. */
  id: string;
  displayName: string;
  description: string;
  icon: string;
  /** Environment choices to register (bb's environment picker). */
  environments: { id: string; displayName: string; description: string; environmentProviderId: string }[];
  /** The sandbox's name for a bb machine key (found again by it after a lost create). */
  machineName(key: string): string;
  /** The machine's name in bb. */
  machineLabel(sandboxId: string, hostId: string): string;
  /** Progress and error words. */
  words: {
    invalidInputs: string;
    usingPrepared: string;
    creating: string;
    resuming: string;
    created(sandboxId: string): string;
    gone(sandboxId: string): string;
    /** A refused stop: what the provider said. */
    stopSaid(reason: string): string;
    /** Why a stop didn't happen. */
    notStopped(why: string): string;
    /** A stop refused while the disk is still being restored, so the sandbox moves to another node (detail: what it said, or ""). */
    stillRestoring(detail: string): string;
  };
}

// ------------------------------------------------------------------ the plugin's own steps, in the provider's words

/**
 * How a provider words what goes wrong in the plugin's repo steps
 * (src/sandbox-repos.ts): GitHub access in its sandboxes and how to fix it,
 * and its own error class (whose explain() words it for the CLI and page).
 */
export interface RepoWords {
  /** The sandbox's GitHub login can't see the repo (or the name is wrong). */
  cantSee(repo: string): string;
  /** GitHub refused it (detail: GitHub's answer). */
  denied(repo: string, detail: string): string;
  /** The sandbox has no GitHub login (environment: the sandbox's, if any). */
  noLogin(environment: string | null): string;
  /** The sandbox's GitHub login expired. */
  expired(environment: string | null): string;
  error(message: string, options: { code: string; exitCode?: number | null }): ProviderError;
}

/** Steps a provider adds around bb's setup and planned stops of its bb machines (./machine.ts). */
export interface MachineHooks {
  /** Remove delivered credentials after bb installation/enrollment fails. */
  bootstrapFailed?(sandboxId: string): Promise<void>;
  /** On a sandbox that is up, before bb's setup there (each create and resume); never fails it. */
  beforeBootstrap?(sandboxId: string, signal?: AbortSignal): Promise<unknown>;
  /** Before a planned stop of a sandbox that is up (state: what the provider said, if known); never fails it. */
  beforeStop?(sandboxId: string, options: { state?: string; signal?: AbortSignal }): Promise<unknown>;
}

/** What the plugin gives a provider's machine hooks. */
export interface MachineHookContext {
  warn(line: string): void;
  debug(line: string): void;
  /** Tests: the budget of a step before a stop. */
  stopStepTimeoutMs?: number;
}

// ------------------------------------------------------------------ the provider

export interface CreateSandboxOptions {
  system?: "linux" | "macos";
  name: string;
  type: MachineType;
  /** The provider environment to start from (null: the account's default). */
  environment?: string | null;
  /** A saved snapshot (or share code) to start from. */
  snapshot?: string | null;
  /**
   * Seconds until the provider's auto-stop. Above the plan's cap, the
   * provider tries once more at the cap it names.
   */
  ttlSeconds: number;
  /** git uses the plugin's hooks (the base-branch push guard), whatever the repo configures. */
  gitGuard: boolean;
  signal?: AbortSignal;
}

export interface ResumeOptions {
  /** Seconds until the auto-stop (above the plan's cap: once more at the cap). */
  ttlSeconds: number;
  /** Resume onto another size (null or absent: the sandbox keeps its size). */
  type?: MachineType | null;
  signal?: AbortSignal;
}

/** Identity and the account: who the provider is and what its plan allows. */
export interface ProviderAccount {
  /** Stored on each task (tasks.sandbox_provider). */
  readonly id: string;
  readonly displayName: string;
  readonly caps: SandboxCapabilities;
  /** Its sandbox ids (boat.dev: bx_…). */
  readonly idPattern: RegExp;
  readonly sizes: readonly SizeOption[];
  /** boat limits */
  capacity(signal?: AbortSignal): Promise<CapacityReport>;
  /** boat limits (planIncluded) */
  usagePlan(signal?: AbortSignal): Promise<UsagePlan>;
  /** boat usage <id> --since --until: machine time and cost, size included. */
  usage(sandboxId: string, window?: { since?: string; until?: string }, signal?: AbortSignal): Promise<SandboxUsage>;
}

/** Sandboxes: find, create, stop, resume and delete them. */
export interface SandboxLifecycle {
  /** boat list [--all]: up sandboxes, or all of them. */
  list(options?: { all?: boolean; signal?: AbortSignal }): Promise<SandboxInfo[]>;
  /** boat info: throws when the sandbox is gone. */
  info(sandboxId: string, signal?: AbortSignal): Promise<SandboxInfo>;
  /** boat info: null when the sandbox is gone. */
  findInfo(sandboxId: string, signal?: AbortSignal): Promise<SandboxInfo | null>;
  /** boat new: a new sandbox, up (a failed create leaves none behind). */
  create(options: CreateSandboxOptions): Promise<SandboxInfo>;
  /** boat delete --yes */
  delete(sandboxId: string, signal?: AbortSignal, options?: { leaseEndReason?: "handed back" | "deleted" | "failed"; leaseEndAt?: number }): Promise<void>;
  /**
   * boat stop [--force]: keeps the disk and the agent's conversations, and
   * says what became of the stop. force: stop even if the provider can't
   * snapshot the disk (what was written since its last snapshot is lost).
   */
  stop(sandboxId: string, signal?: AbortSignal, options?: { force?: boolean }): Promise<StopReport>;
  /** boat stop <id> --status <stop id>: an earlier stop's status (it never stops again). */
  stopStatus(sandboxId: string, stopId: string, signal?: AbortSignal): Promise<StopReport>;
  /** boat fork --wait: a new sandbox from this one's latest snapshot, up. */
  fork(sandboxId: string, options?: { noSnapshots?: boolean; ttlSeconds?: number; signal?: AbortSignal }): Promise<{ id: string }>;
  /** boat snapshots <id>: when its last snapshot completed (null: none, or not said). */
  lastSnapshotAt(sandboxId: string, signal?: AbortSignal): Promise<string | null>;
  /** boat resume [--ttl] [--type] */
  resume(sandboxId: string, options: ResumeOptions): Promise<void>;
  /** boat extend --ttl: the auto-stop this many seconds from now; returns the seconds set (the plan's cap may lower them). */
  extend(sandboxId: string, ttlSeconds: number, signal?: AbortSignal): Promise<{ ttlSeconds: number }>;
}

/** Commands in a sandbox, and what runs there. */
export interface SandboxExec {
  /**
   * boat exec --timeout -- bash -lc <script>. login false: a plain
   * `bash -c` that never reads the login profile (it may not be restored yet).
   */
  exec(sandboxId: string, script: string, options?: { timeoutMs?: number; signal?: AbortSignal; login?: boolean }): Promise<ExecResult>;
  /** boat exec --detach -- bash -lc <script>: it outlives the call. */
  execDetached(sandboxId: string, script: string, signal?: AbortSignal): Promise<{ pid: number | null }>;
  /** boat ps: the sandbox's processes (its last stored sample when it's stopped). */
  processes(sandboxId: string, signal?: AbortSignal): Promise<ProcessSample>;
}

/** Ports, saved snapshots, and the provider's environments (secrets, repos, agent logins). */
export interface SandboxExtras {
  /** boat host <id> <port> --private --title: a link that stays the same across stop and resume. */
  host(sandboxId: string, port: number, title: string, signal?: AbortSignal): Promise<HostedPort>;
  /** boat snapshot <id> <name> */
  snapshot(sandboxId: string, name: string, signal?: AbortSignal): Promise<{ name: string; sizeBytes: number | null }>;
  /** boat snapshots: saved snapshots and the plan's allowance for them. */
  snapshots(signal?: AbortSignal): Promise<{ snapshots: SavedSnapshot[]; included: number | null; used: number | null }>;
  /** boat env list: the environments' names. */
  environments(signal?: AbortSignal): Promise<string[]>;
  /** boat env list: the one used when none is named (null: none marked). */
  defaultEnvironment(signal?: AbortSignal): Promise<string | null>;
  /** boat env info: secret names only. */
  environmentInfo(name: string, signal?: AbortSignal): Promise<EnvironmentInfo>;
  /** boat ai proxy (read only) */
  aiProxy(signal?: AbortSignal): Promise<AiProxyState>;
}

/** The provider's headless agent runner: Claude Code or Codex turns without bb in the sandbox. */
export interface AgentRunner {
  /** boat prompt --provider --resume: returns once the turn is queued; the agent works on after. */
  prompt(options: PromptOptions): Promise<Dispatch>;
  /** boat conversations */
  conversations(sandboxId: string, signal?: AbortSignal): Promise<Conversation[]>;
  /** boat events --convo */
  events(sandboxId: string, conversationId: string, signal?: AbortSignal): Promise<ChatEvent[]>;
  /** boat steer --convo */
  steer(sandboxId: string, conversationId: string, message: string, signal?: AbortSignal): Promise<void>;
  /** boat interrupt [--convo] */
  interrupt(sandboxId: string, conversationId: string | null, signal?: AbortSignal): Promise<void>;
}

/** For later providers: not called yet. */
export interface MacModel { id: string; label: string; cpus: number; memoryMiB: number; minimumCost: number; minimumHours: number; hourPrice: number; currency: string }
export interface LaterMembers {
  /** Already rented monthly capacity is reused before held day leases; never allocated. */
  macLeaseKind?: "monthly" | "day";
  closeTaskCredentials?(sandboxId: string, signal?: AbortSignal, machineRemoved?: boolean): Promise<void>;
  runsOnMachine?(sandboxId?: string | null): string | null;
  ownMacStatus?(force?: boolean, signal?: AbortSignal): Promise<{ status: string; running: number; max: number }>;
  /** Whether any provider-specific setup was saved, even if incomplete. */
  configured?(): boolean | Promise<boolean>;
  /** Read-only, bounded setup and billing metadata. Also works while turned off. */
  presentation?(options?: { force?: boolean; signal?: AbortSignal }): Promise<{ steps: import("../../contract-providers.ts").ProviderStepDto[]; linuxUsage?: import("../../contract-providers.ts").LinuxUsageDto; status?: string; ownMac?: import("../../contract-providers.ts").OwnMacDto; pricing?: string; meta?: string }>;

  /** Classifies uncertain/allocated create outcomes itself; ordinary errors mean no machine was allocated. */
  classifiesCreateErrors?: boolean;
  /** Servers with Boat names but no local ownership record. Read-only; never adopted automatically. */
  orphans?(signal?: AbortSignal): Promise<{ id: string; name: string }[]>;
  /** Current persistent owner warning about credential cleanup during release. */
  releaseNotice?(): string | null;
  /** Allocate and record a lease quickly; readiness/bootstrap is a separate step outside the placement lock. */
  allocate?(options: CreateSandboxOptions): Promise<SandboxInfo>;
  waitReady?(sandboxId: string, signal?: AbortSignal): Promise<SandboxInfo>;
  /** Verify credentials before allocation, or on an existing machine before reuse. */
  assertTaskReady?(input: { agent: Provider; repos: readonly string[]; sandboxId?: string; signal?: AbortSignal; onWarning?: (message: string) => void }): Promise<void>;
  /** Re-deliver this provider's configured GitHub source before expiry. */
  refreshGithubLogin?(sandboxId: string, signal?: AbortSignal): Promise<string | null>;
  /** Reconcile ambiguous creates against complete provider lists, clearing only absent recovery records. */
  recoverCreations?(signal?: AbortSignal): Promise<{ recovered: number; cleared: number }>;

  macModels?(signal?: AbortSignal): Promise<MacModel[]>;
  /** Release an empty lease exactly when its paid minimum ends. Omit if the provider cannot schedule; Boat waits until the minimum ends instead. */
  scheduleLeaseRelease?(sandboxId: string, at: string, signal?: AbortSignal): Promise<void>;
  /** Cancel that schedule before attaching more work. */
  cancelLeaseRelease?(sandboxId: string, signal?: AbortSignal): Promise<void>;
  /**
   * Its prices in one line, as the provider states them now ("M2 $10.80 a
   * day"); null: it doesn't say. Settings shows amounts only from here.
   */
  pricing?(signal?: AbortSignal): Promise<string | null>;
  /** Copy a file out of a sandbox (capture runs' artifacts). */
  readFile?(sandboxId: string, path: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** Where the user can look at a sandbox: the provider's console, a shell command, a desktop. */
  links?(sandboxId: string): { console: string | null; shell: string | null; desktop: string | null };
}

export interface SandboxProvider extends ProviderAccount, SandboxLifecycle, SandboxExec, SandboxExtras, AgentRunner, LaterMembers {
  /** bb machines in its sandboxes (absent: the provider has no bb enrollment). */
  readonly machine?: MachineSpec;
  /** boat ssh: runs bb's bootstrap commands in a sandbox, with stdin and streamed output (with machine). */
  executor?(sandboxId: string): MachineExecutor;
  /** Its own steps around bb's setup and planned stops (boat.dev: quiet login scripts, trim the disk); absent: none. */
  machineHooks?(context: MachineHookContext): MachineHooks;
  /** Its words for the plugin's repo steps (absent: neutral words, ProviderError). */
  readonly repoWords?: RepoWords;
  /** Retry the GitHub access probe once after a 401 while proxy delivery settles. */
  readonly retryGithubAccess?: boolean;
  /** Refresh provider credentials before the checkout's login shell starts. */
  beforeRepo?(sandboxId: string, signal?: AbortSignal): Promise<void>;
}

/** Implemented Mac hosting, with live model checks performed before dispatch. */
export function canHostMac(provider: Pick<SandboxProvider, "macModels" | "caps">): boolean {
  return typeof provider.macModels === "function" || (provider.caps.systems ?? [provider.caps.os]).includes("macos");
}

/** Task reservations use this provider's published size aliases, independently
 * of the whole machine/model selected for a newly created Mac. */
export function macTaskResources(provider: Pick<SandboxProvider, "sizes" | "displayName">, type: MachineType): { vcpus: number; memMiB: number } {
  const size = provider.sizes.find(size => size.id === type);
  if (!size || !Number.isFinite(size.cpus) || size.cpus <= 0 || !Number.isFinite(size.memoryGb) || size.memoryGb <= 0) throw new ProviderError(`${provider.displayName} does not provide resource reservations for ${type}.`, { code: "size_unavailable" });
  return { vcpus: size.cpus, memMiB: Math.ceil(size.memoryGb*1024) };
}
