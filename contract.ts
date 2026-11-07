import { projectRpcMethods } from "./contract-projects.ts";
import { sidebarRpcMethods } from "./contract-sidebar.ts";
import { queuedStartSchema } from "./contract-start-queue.ts";
export * from "./contract-sidebar.ts";
// Shared RPC contract between server.ts and app.tsx.
//
// Imported as a VALUE by both sides (the app's live query hooks need it), so
// it may only import zod — nothing node-only. The SDK is a devDependency (a
// git install omits it), so only its types are imported; defineRpcContract
// is an identity function.
import type { defineRpcContract as DefineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { compactTitleSchema, decisionOptionSchema, fidelityRpcMethods } from "./contract-fidelity.ts";
export * from "./contract-fidelity.ts";
import { sizeRpcMethods, taskMemorySchema } from "./contract-size.ts";

export { SIZE_VALUES, taskMemorySchema, resizeInfoSchema, type TaskMemoryDto, type ResizeInfoDto } from "./contract-size.ts";

const defineRpcContract = ((contract: unknown) => contract) as typeof DefineRpcContract;

// Account-level UI state (contract-ui.ts), spread into the contract at its end.
import { uiRpcMethods } from "./contract-ui.ts";
export { UI_TAG, uiStateSchema, type UiStateDto } from "./contract-ui.ts";
// What a new orchestrator starts with (contract-orchestrator.ts), spread in at the end too.
import { orchestratorEffortSchema, orchestratorRpcMethods } from "./contract-orchestrator.ts";
export { ORCHESTRATOR_EFFORT_VALUES, type OrchestratorChoicesDto, type OrchestratorEffortDto } from "./contract-orchestrator.ts";

export const PROVIDER_VALUES = ["claude", "codex"] as const;
export const ROLE_VALUES = ["implement", "review", "custom"] as const;
export const STATUS_VALUES = ["starting", "running", "idle", "failed", "done", "cancelled"] as const;
export const MACHINE_TYPE_VALUES = ["small", "default", "large", "xlarge"] as const;

export const providerSchema = z.enum(PROVIDER_VALUES);
export const roleSchema = z.enum(ROLE_VALUES);
export const statusSchema = z.enum(STATUS_VALUES);
export const machineTypeSchema = z.enum(MACHINE_TYPE_VALUES);

// Model tiers (mirrors src/tiers.ts; the app can't import server modules).
export const TIER_VALUES = ["light", "review", "build", "deep", "frontier"] as const;
export const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max", "ultracode", "ultra"] as const;
export const tierSchema = z.enum(TIER_VALUES);
export const effortSchema = z.enum(EFFORT_VALUES);
const tierChoiceSchema = z.object({
  model: z
    .string()
    .trim()
    .min(1, "Enter a model id")
    .max(120)
    .regex(/^[A-Za-z0-9._:/-]+$/, "Not a model id"),
  effort: effortSchema,
});
const tierRowSchema = z
  .object({ claude: tierChoiceSchema, codex: tierChoiceSchema })
  .refine((row) => row.claude.effort !== "ultra", { message: "ultra is a Codex level; Claude's is ultracode", path: ["claude", "effort"] })
  .refine((row) => row.codex.effort !== "ultracode", { message: "ultracode is a Claude level; Codex's is ultra", path: ["codex", "effort"] });
export const tierMapSchema = z.object({
  light: tierRowSchema,
  review: tierRowSchema,
  build: tierRowSchema,
  deep: tierRowSchema,
  frontier: tierRowSchema,
});
export type TierMapDto = z.infer<typeof tierMapSchema>;

/** Tags the server invalidates when data changes. */
export const TAGS = {
  tasks: "boat:tasks",
  sandboxes: "boat:sandboxes",
  overview: "boat:overview",
  projects: "boat:projects",
  protocol: "boat:protocol",
  relay: "boat:relay",
  setup: "boat:setup",
  settings: "boat:settings",
} as const;

// ------------------------------------------------------------- setup checks
// Mirrors src/setup.ts (the app can't import server modules).

export const SETUP_CHECK_IDS = ["cli", "signed-in", "plan", "agents", "environment", "boat-credentials", "github", "connect", "gh"] as const;
export const SETUP_CHECK_STATES = ["ok", "missing", "warning", "unknown", "optional"] as const;
/**
 * Buttons a fix can offer. check-again: run the checks again (setup with
 * force); sign-in: run the command (boat onboard) in a terminal; use-detected-
 * agents: applySetupFix sets Coding agents to Auto-detect.
 */
export const SETUP_ACTION_VALUES = ["check-again", "sign-in", "use-detected-agents"] as const;
export const AGENTS_SETTING_VALUES = ["auto", "both", "claude", "codex"] as const;

export const setupCheckSchema = z.object({
  id: z.enum(SETUP_CHECK_IDS),
  label: z.string(),
  /** ok, missing (blocks new work when required), warning, unknown (couldn't check), optional (not needed now). */
  state: z.enum(SETUP_CHECK_STATES),
  required: z.boolean(),
  detail: z.string(),
  fix: z
    .object({
      text: z.string(),
      /** A command to run in a terminal (show it with Copy). */
      command: z.string().optional(),
      url: z.string().optional(),
      action: z.enum(SETUP_ACTION_VALUES).optional(),
    })
    .optional(),
});
export type SetupCheckDto = z.infer<typeof setupCheckSchema>;

export const machineTypeFactsSchema = z.object({ type: z.string(), available: z.boolean(), reason: z.string().nullable() });

/** The boat plan as boat limits reports it (sizes, starts, hours, trial). */
export const planSchema = z.object({
  /** "Standard", "Trial", … */
  name: z.string().nullable(),
  accessTier: z.string().nullable(),
  trial: z.boolean(),
  trialEndsAt: z.string().nullable(),
  checkoutRequired: z.boolean(),
  canStart: z.boolean(),
  startBlockedReason: z.string().nullable(),
  activeSandboxes: z.number(),
  maxActiveSandboxes: z.number().nullable(),
  startsLeftToday: z.number().nullable(),
  startsPerDay: z.number().nullable(),
  vmHoursRemaining: z.number().nullable(),
  /** Sizes the plan can (and can't) use, with boat's reason. */
  machineTypes: z.array(machineTypeFactsSchema),
  extraStartsEnabled: z.boolean().nullable(),
  /** The plan's cap on a sandbox's auto-stop, in hours (the trial's; null: none). */
  autoStopCapHours: z.number().nullable(),
});
export type PlanDto = z.infer<typeof planSchema>;

export const setupStatusSchema = z.object({
  /** Every required check passes (warnings allowed). */
  ok: z.boolean(),
  checkedAt: z.string(),
  /** One line: "Setup: ready." / "Setup: 2 things to fix (…)". */
  summary: z.string(),
  checks: z.array(setupCheckSchema),
  agents: z.object({
    setting: z.enum(AGENTS_SETTING_VALUES),
    /** What boat.dev has for new sandboxes (null: couldn't tell). */
    detected: z.array(providerSchema).nullable(),
    /** What the plugin uses. */
    effective: z.enum(["both", "claude", "codex"]),
  }),
  plan: planSchema.nullable(),
  /** The environment new sandboxes use. */
  environment: z.object({ name: z.string(), isDefault: z.boolean(), safeForThirdParties: z.boolean().nullable() }).nullable(),
});
export type SetupStatusDto = z.infer<typeof setupStatusSchema>;

/**
 * An RPC failure's parts: the plugin's own error code (setup_required,
 * unauthorized, provider_not_configured, …), the message, and what to do.
 * The refusal's message is "message hint" for older screens; the parts ride
 * in its issues.
 */
export interface RpcErrorInfo {
  code: string | null;
  message: string;
  hint: string | null;
}

export function rpcErrorInfo(error: unknown): RpcErrorInfo {
  const message = error instanceof Error ? error.message : String(error);
  const issues = (error as { issues?: unknown } | null)?.issues;
  const part = (name: string): string | null => {
    if (!Array.isArray(issues)) return null;
    const found = issues.find(
      (issue): issue is { message: string; path: unknown[] } =>
        issue !== null && typeof issue === "object" && Array.isArray((issue as { path?: unknown }).path) && (issue as { path: unknown[] }).path[0] === name,
    );
    return typeof found?.message === "string" ? found.message : null;
  };
  return { code: part("code"), message: part("message") ?? message, hint: part("hint") };
}

export const projectRepoSchema = z.object({ repo: z.string(), baseBranch: z.string() });

export const projectSchema = z.object({
  localBbProjectId: z.string().nullable().optional(),
  id: z.string(),
  name: z.string(),
  repos: z.array(projectRepoSchema),
  environment: z.string().nullable(),
  snapshot: z.string().nullable(),
  protocolPath: z.string().nullable(),
  /** chat: Run tasks as chats (only matters when How tasks run is As chats for projects or everywhere). */
  workerMode: z.enum(["chat", "boat"]),
  /** pr: draft pull requests; push: ships to the base branch after you approve a preview. */
  delivery: z.enum(["pr", "push"]),
  /** Branches no task may push to, on top of the base branches. */
  protectedBranches: z.array(z.string()),
  /** Added to the brief of every task of this project ("" for none). */
  instructions: z.string(),
  /** Size of its new task sandboxes (null: the Default sandbox size setting). */
  machineType: machineTypeSchema.nullable(),
  reviewer: z.enum(["codex", "claude", "none"]).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectDto = z.infer<typeof projectSchema>;

// Same limits as the server's projects.ts schema, so the form gets field errors.
export const projectInputSchema = z.object({
  localBbProjectId: z.string().trim().min(1).max(200).nullable().optional(),
  id: z.string().max(64).optional(),
  name: z.string().trim().min(1).max(80),
  repos: z
    .array(z.object({ repo: z.string().trim().min(3).max(200), baseBranch: z.string().trim().min(1).max(200) }))
    .min(1)
    .max(8),
  environment: z.string().trim().max(80).nullable(),
  snapshot: z.string().trim().max(120).nullable(),
  protocolPath: z.string().trim().max(300).nullable(),
  workerMode: z.enum(["chat", "boat"]).optional(),
  delivery: z.enum(["pr", "push"]).optional(),
  /** A list, or the text field as is ("release, develop"); absent: unchanged. */
  protectedBranches: z.union([z.array(z.string().max(200)).max(50), z.string().max(2000)]).optional(),
  /** absent: unchanged. */
  instructions: z.string().max(10_000).optional(),
  /** null: the Default sandbox size setting; absent: unchanged. */
  machineType: machineTypeSchema.nullable().optional(),
  reviewer: z.enum(["codex", "claude", "none"]).nullable().optional(),
});
export type ProjectInputDto = z.infer<typeof projectInputSchema>;

export const localProjectSchema = z.object({
  bbProjectId: z.string(),
  name: z.string(),
  repo: z.string(),
  branch: z.string().nullable(),
  unpushed: z.number().nullable(),
  branchMissingRemotely: z.boolean(),
  path: z.string().nullable(),
  matchesProjectId: z.string().nullable(),
  problem: z.string().nullable(),
});
export type LocalProjectDto = z.infer<typeof localProjectSchema>;

/** How the New orchestrator dialog names its project. */
export const projectRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("boat"), id: z.string().min(1) }),
  z.object({ kind: z.literal("local"), bbProjectId: z.string().min(1) }),
]);
export type ProjectRefDto = z.infer<typeof projectRefSchema>;

/**
 * Who started a task: a real orchestrator, a plain chat, or the Cloud agents
 * page. threadId/title name the chat (title null when unknown).
 */
export const taskSourceSchema = z.object({
  kind: z.enum(["orchestrator", "chat", "page"]),
  threadId: z.string().nullable(),
  title: z.string().nullable(),
});
export type TaskSourceDto = z.infer<typeof taskSourceSchema>;

export const taskPublicStatusSchema = z.object({
  status: z.enum(["working", "review", "ready", "shipped", "needs-you", "broken", "stopped", "waiting-reset"]),
  label: z.string(),
  tone: z.enum(["neutral", "attention", "positive", "danger"]),
  reason: z.string().nullable(),
  needsYou: z.boolean(),
  moving: z.boolean(),
});
export type TaskPublicStatusDto = z.infer<typeof taskPublicStatusSchema>;

export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  compactTitle: compactTitleSchema.nullable().optional(),
  role: roleSchema,
  status: statusSchema,
  orchestratorThreadId: z.string().nullable(),
  /** Who started it (and gets its notices). */
  source: taskSourceSchema,
  projectId: z.string().nullable(),
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  sandboxId: z.string().nullable(),
  conversationId: z.string().nullable(),
  provider: providerSchema,
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  /** Model tier the orchestrator chose; null when a model was picked by hand. */
  tier: z.string().nullable(),
  /** The orchestrator's one-line reason for the tier. */
  reason: z.string().nullable(),
  /** "chat": the worker is a regular bb chat (threadId); "boat": a boat conversation. */
  runner: z.enum(["chat", "boat"]),
  threadId: z.string().nullable(),
  /**
   * Where it stands for the user: starting, working, waiting (on its
   * orchestrator), failed, ready (a finished turn of a page or plain-chat task,
   * or work its orchestrator marked ready), done, cancelled.
   */
  phase: z.enum(["starting", "working", "waiting", "failed", "ready", "done", "cancelled"]),
  /** Shared v1 status, additive for older cached task responses. */
  publicStatus: taskPublicStatusSchema.optional(),
  /** The orchestrator's note when it marked the work ready for review. */
  readyNote: z.string().nullable(),
  /** Latest review of an implementation: "reviewing", "approve", "changes-requested", … */
  latestReview: z.string().nullable(),
  /** Preview link of the work, once there is one. */
  previewUrl: z.string().nullable(),
  /** pr: the worker opens a draft PR; push: the work ships to the base branch once the user approves. */
  delivery: z.enum(["pr", "push"]),
  /**
   * push delivery: work may wait in its sandbox (commits or changed files not
   * shipped yet; also while a turn runs, or when the last check couldn't tell).
   */
  unshipped: z.boolean(),
  /** The user can ship it now (unshipped work, its turn finished). */
  canShip: z.boolean(),
  /** The repo isn't one of the user's projects, so the worker ran as a boat conversation. */
  untrustedRepo: z.boolean(),
  /** A move to a task chat is running (Continue as a chat). */
  movingToChat: z.boolean(),
  parentTaskId: z.string().nullable(),
  prUrl: z.string().nullable(),
  error: z.string().nullable(),
  turns: z.number(),
  ownsSandbox: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** Parsed from the worker's report block, when present. */
  reportStatus: z.string().nullable(),
  verdict: z.string().nullable(),
  /** The tail of the agent's last message (≤ 600 chars) for cards. */
  excerpt: z.string().nullable(),
});
export type TaskDto = z.infer<typeof taskSchema>;

/** What a chat is to the plugin (rpc threadRoles): a task chat with its task, a real orchestrator, or a plain chat. */
export const threadRoleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), task: taskSchema }),
  z.object({ kind: z.literal("orchestrator") }),
  z.object({ kind: z.literal("chat") }),
]);
export type ThreadRoleDto = z.infer<typeof threadRoleSchema>;

export const taskDetailSchema = taskSchema.extend({
  brief: z.string(),
  result: z.string().nullable(),
  events: z.array(z.object({ at: z.string(), kind: z.string(), text: z.string() })),
  dashboardUrl: z.string().nullable(),
  /** Its sandbox's size, out-of-memory kills, peak memory and moves (null: couldn't read). */
  memory: taskMemorySchema.nullable(),
  /**
   * Ship stopped on a conflict after you approved (cleared once it ships or
   * closes): the error, and after the next turn what changed since then.
   */
  shipApproval: z
    .object({
      message: z.string(),
      at: z.string(),
      /** range-diff: the approved commits compared with the new ones; stat: changed files; none: couldn't compare (text says why). */
      changes: z.object({ via: z.enum(["range-diff", "stat", "none"]), text: z.string(), omitted: z.number() }).nullable(),
    })
    .nullable(),
});
export type TaskDetailDto = z.infer<typeof taskDetailSchema>;

/** What runs in a sandbox: a task, a chat on a Boat sandbox machine, or an orchestrator chat. */
export const sandboxUseSchema = z.object({
  kind: z.enum(["task", "chat", "orchestrator"]),
  /** The task id, or the chat's thread id. */
  id: z.string(),
  title: z.string().nullable(),
  /** False for a closed task whose sandbox was kept. */
  open: z.boolean(),
});
export type SandboxUseDto = z.infer<typeof sandboxUseSchema>;

export const sandboxSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  state: z.string(),
  health: z.string().nullable(),
  url: z.string().nullable(),
  createdAt: z.string().nullable(),
  /** Auto-stop deadline (ISO), null when stopped. */
  archiveAfter: z.string().nullable(),
  dashboardUrl: z.string(),
  sshCommand: z.string(),
  machineType: machineTypeSchema.nullable().optional(),
  taskIds: z.array(z.string()),
  /** What uses it: open tasks first, then chats on it (empty: not in use). */
  uses: z.array(sandboxUseSchema),
});
export type SandboxDto = z.infer<typeof sandboxSchema>;

export const limitsSchema = z.object({
  tier: z.string().nullable(),
  summary: z.string().nullable(),
  activeSandboxes: z.number(),
  maxActiveSandboxes: z.number().nullable(),
  startsLeftToday: z.number().nullable(),
  canStart: z.boolean(),
});

export const chatEventSchema = z.object({
  type: z.string(),
  status: z.string().nullable(),
  content: z.string().nullable(),
  error: z.string().nullable(),
  timestamp: z.number().nullable(),
  tools: z.array(z.string()),
});
export type ChatEventDto = z.infer<typeof chatEventSchema>;

/** A real orchestrator (started or turned on as one); chats that only started a task aren't listed. */
export const orchestratorSchema = z.object({
  threadId: z.string(),
  /** The chat's title (null when unknown, e.g. deleted). */
  title: z.string().nullable(),
  createdAt: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  openTasks: z.number(),
  runningTasks: z.number(),
  needsAttention: z.number(),
  /** Archived (e.g. replaced by the relay): only offered for "Take over from". */
  archived: z.boolean(),
});
export type OrchestratorDto = z.infer<typeof orchestratorSchema>;

export const previewSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  orchestratorThreadId: z.string().nullable(),
  port: z.number(),
  path: z.string(),
  /** Opens the page (the private link carries its token). */
  link: z.string(),
  state: z.enum(["live", "sleeping", "expired"]),
  reason: z.string().nullable(),
  /** When boat stops the sandbox (ISO), while it's on. */
  stopsAt: z.string().nullable(),
  /** Wake can restart the server (the worker reported how). */
  canRestart: z.boolean(),
  updatedAt: z.string(),
});
export type PreviewDto = z.infer<typeof previewSchema>;

export const hostSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  primary: z.boolean(),
});

export const decisionSchema = z.object({
  id: z.string(),
  orchestratorThreadId: z.string().nullable(),
  question: z.string(),
  recommendation: z.string(),
  options: z.array(z.string()),
  optionDetails: z.array(decisionOptionSchema).optional(),
  context: z.string().nullable().optional(),
  askedByTaskId: z.string().nullable().optional(),
  shortLabel: z.string().max(120).nullable().optional(),
  taskIds: z.array(z.string()),
  status: z.enum(["open", "answered", "withdrawn"]),
  answer: z.string().nullable(),
  createdAt: z.string(),
});
export type DecisionDto = z.infer<typeof decisionSchema>;

export const workspaceChatSchema = z.object({
  threadId: z.string(),
  title: z.string().nullable(),
  provider: z.enum(["claude", "codex"]).nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  /** The chat the task currently runs in. */
  current: z.boolean(),
  archived: z.boolean(),
});
export type WorkspaceChatDto = z.infer<typeof workspaceChatSchema>;

const ok = z.object({ ok: z.literal(true) });
const launchResult = z.object({ task: taskSchema, pending: z.boolean() });

/** A backup file's text, and whether projects missing from it are removed. */
const configImportInputSchema = z.object({ text: z.string().max(500_000), replaceProjects: z.boolean() });
const configImportResultSchema = z.object({
  /** Reasons the file can't be imported; empty when it can. */
  problems: z.array(z.string()),
  /** How many things change (0: this bb already matches the file). */
  changes: z.number(),
  sections: z.array(z.object({ title: z.string(), lines: z.array(z.string()) })),
});
export type ConfigImportResultDto = z.infer<typeof configImportResultSchema>;

// ------------------------------------------------------------- settings

/** The plugin's own settings sections, in order (bb's list has none). */
export const SETTING_SECTION_VALUES = ["setup", "usage-limits", "models", "orchestrators", "advanced"] as const;
const settingValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const settingSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  /** bb: bb's settings list (Settings → Plugins); plugin: the plugin's own sections. */
  where: z.enum(["bb", "plugin"]),
  /** The plugin's section (null: bb's list). */
  section: z.enum(SETTING_SECTION_VALUES).nullable(),
  /** Rows that belong together: "switching" (Claude ↔ Codex switching for orchestrators). */
  group: z.string().nullable(),
  /** Shown under a fold with this title ("Fine-tune"). */
  fold: z.string().nullable(),
  type: z.enum(["boolean", "number", "string", "select"]),
  value: settingValueSchema,
  default: settingValueSchema,
  isDefault: z.boolean(),
  /** Select settings: values with their labels. */
  options: z.array(z.object({ value: z.string(), label: z.string() })).nullable(),
  /** Number settings. */
  min: z.number().nullable(),
  max: z.number().nullable(),
  integer: z.boolean(),
  multiline: z.boolean(),
  /** Why it doesn't apply now ("Needs both Claude and Codex"); null: it does. */
  disabledReason: z.string().nullable(),
});
export type SettingDto = z.infer<typeof settingSchema>;

const settingsResultSchema = z.object({
  /** bb's list first (in its order), then the plugin's own, section by section. */
  settings: z.array(settingSchema),
  sections: z.array(z.object({ id: z.enum(SETTING_SECTION_VALUES), title: z.string() })),
  /** The one agent the plugin uses, or null with both (Usage limits grey out with one). */
  onlyAgent: providerSchema.nullable(),
  /** The boat CLI was found (null: unknown); Setup shows boat CLI location when it wasn't. */
  cliFound: z.boolean().nullable(),
  /** Where it was found (Sign in… runs it from there, in case the shell's PATH lacks it). */
  cliPath: z.string().nullable().optional(),
});
export type SettingsResultDto = z.infer<typeof settingsResultSchema>;

/** One sandbox size for pickers: grey out the ones the plan can't use, with boat's reason. */
export const sandboxSizeSchema = z.object({
  type: machineTypeSchema,
  /** "Small" */
  label: z.string(),
  /** "2 vCPU, 4 GB · half rate" */
  detail: z.string(),
  available: z.boolean(),
  /** boat's reason when it isn't ("needs the $100/month plan or higher"). */
  reason: z.string().nullable(),
});
export type SandboxSizeDto = z.infer<typeof sandboxSizeSchema>;

export const rpcContract = defineRpcContract({
  ...projectRpcMethods,
  // Sandbox sizes and memory (contract-size.ts).
  ...sizeRpcMethods,
  ...fidelityRpcMethods,
  ...sidebarRpcMethods,
  // ------------------------------------------------------------- reads
  overview: {
    input: z.null(),
    output: z.object({
      limits: limitsSchema.nullable(),
      activeSandboxes: z.number(),
      cap: z.number().nullable(),
      freeSlots: z.number().nullable(),
      boatError: z.string().nullable(),
      defaults: z.object({
        implementProvider: providerSchema,
        reviewProvider: providerSchema,
        machineType: machineTypeSchema,
        orchestratorMachineType: machineTypeSchema,
        freeSlotsWhenFull: z.boolean(),
        /** The one agent the plugin uses (Coding agents), or null with both. */
        onlyAgent: providerSchema.nullable(),
        /** A follow-up may move to the other agent when the task's is near its limit. */
        autoFailover: z.boolean(),
      }),
      /** bb Connect (cloud orchestrators and worker chats need it): ready, off, or unknown; fix says how to set it up. */
      connect: z.object({ state: z.enum(["ready", "off", "unknown"]), fix: z.string().nullable() }),
      /** This bb can run task chats (the plugin's chat runner is there). */
      taskChats: z.boolean(),
    }),
    tags: () => [TAGS.overview, TAGS.sandboxes],
  },
  sandboxes: {
    input: z.object({ all: z.boolean() }),
    output: z.object({ sandboxes: z.array(sandboxSchema), error: z.string().nullable() }),
    tags: () => [TAGS.sandboxes],
  },
  tasks: {
    input: z.object({
      /** null = every status. */
      statuses: z.array(statusSchema).nullable(),
      threadId: z.string().nullable(),
      limit: z.number().int().min(1).max(500),
    }),
    output: z.object({ tasks: z.array(taskSchema) }),
    tags: () => [TAGS.tasks],
  },
  task: {
    input: z.object({ id: z.string() }),
    output: z.object({ task: taskDetailSchema.nullable() }),
    tags: () => [TAGS.tasks],
  },
  /** Keyed by thread id: the tasks each thread dispatched (open ones first). */
  tasksByThread: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(z.string(), z.array(taskSchema)),
    keyTags: () => [TAGS.tasks],
  },
  /** The worker's conversation, fetched live from boat (not cached). */
  transcript: {
    input: z.object({ id: z.string(), limit: z.number().int().min(1).max(500) }),
    output: z.object({ events: z.array(chatEventSchema), error: z.string().nullable() }),
  },
  orchestrators: {
    input: z.null(),
    output: z.object({ orchestrators: z.array(orchestratorSchema) }),
    tags: () => [TAGS.tasks],
  },
  hosts: {
    input: z.null(),
    output: z.object({ hosts: z.array(hostSchema) }),
  },
  /** Claude and Codex usage, and which agent runs each orchestrator (the relay). */
  relay: {
    input: z.null(),
    output: z.object({
      /** On only with the setting on and both agents (Coding agents). */
      enabled: z.boolean(),
      /** The one agent the user has, or null with both. */
      onlyAgent: providerSchema.nullable(),
      preferred: providerSchema,
      switchAtPercent: z.number(),
      avoidExtraUsage: z.boolean(),
      agents: z.array(
        z.object({
          provider: providerSchema,
          /** null: no usage source knows this agent. */
          usedPercent: z.number().nullable(),
          window: z.string().nullable(),
          resetsAt: z.string().nullable(),
        }),
      ),
      orchestrators: z.array(
        z.object({
          threadId: z.string(),
          provider: providerSchema.nullable(),
          /** What the relay is doing for it ("writing a handoff note", …), if anything. */
          note: z.string().nullable(),
          /** Needs a look: both agents near their limits, a failed switch, or it can't move. */
          waiting: z.boolean(),
        }),
      ),
    }),
    tags: () => [TAGS.relay],
  },

  /** The setup checklist (cached about a minute; force reads boat again). */
  setup: {
    input: z.object({ force: z.boolean() }),
    output: setupStatusSchema,
    tags: () => [TAGS.setup],
  },
  /** Every setting with its value, default and where it's shown (bb's list or a plugin section). */
  settings: {
    input: z.null(),
    output: settingsResultSchema,
    tags: () => [TAGS.settings],
  },
  /**
   * Sandbox sizes for pickers (New task, the Boat sandbox chip), from
   * `boat limits` (cached about a minute). When boat can't be read, every
   * size shows as available (known: false).
   */
  sandboxSizes: {
    input: z.null(),
    output: z.object({
      sizes: z.array(sandboxSizeSchema),
      /** The Default sandbox size and the Size for chats on a Boat sandbox settings. */
      taskDefault: machineTypeSchema,
      chatDefault: machineTypeSchema,
      /** The plan stops sandboxes after at most this many hours (from `boat limits`; the trial's); null: no such cap. */
      autoStopCapHours: z.number().nullable(),
      /** Hours a new sandbox runs before boat stops it: Hard stop after, within the plan's cap. */
      autoStopHours: z.number(),
      /** "Standard", "Trial", … (null: unknown). */
      plan: z.string().nullable(),
      known: z.boolean(),
    }),
    tags: () => [TAGS.setup, TAGS.settings],
  },

  // ------------------------------------------------------------- writes
  /**
   * Change settings, wherever they live: every value is checked first (and
   * the rules across them, like Switch back below vs Switch at), then all are
   * saved or none. null: back to the default. Refusals carry each problem.
   */
  saveSettings: {
    input: z.object({ values: z.record(z.string(), settingValueSchema.nullable()) }),
    output: settingsResultSchema,
  },
  /** Apply a fix's action (use-detected-agents, check-again); returns the fresh checklist. */
  applySetupFix: {
    input: z.object({ action: z.enum(SETUP_ACTION_VALUES) }),
    output: setupStatusSchema,
  },
  /**
   * The test task: no repo, headless in boat, small sandbox; reports uname,
   * node, git and GitHub access and changes nothing. notifyThreadId: a chat to
   * tell when it finishes (null: nobody, it shows on the page).
   */
  startTestTask: {
    input: z.object({ notifyThreadId: z.string().nullable(), provider: providerSchema.nullable() }),
    output: launchResult,
  },
  /** The latest real setup test, including after it leaves the board's history window. */
  setupTestTask: {
    input: z.null(),
    output: z.object({ task: taskSchema.nullable() }),
    tags: () => [TAGS.tasks, TAGS.setup],
  },
  startTask: {
    input: z.object({
      title: z.string().trim().min(1).max(200),
      brief: z.string().trim().min(1).max(100_000),
      role: roleSchema,
      repo: z.string().trim().nullable(),
      branch: z.string().trim().nullable(),
      baseBranch: z.string().trim().nullable(),
      provider: providerSchema.nullable(),
      model: z.string().trim().nullable(),
      /** Model tier; the plugin picks model and effort (an explicit model wins). */
      tier: tierSchema.nullable().optional(),
      effort: effortSchema.nullable().optional(),
      sandbox: z.string().trim().nullable(),
      machineType: machineTypeSchema.nullable(),
      /** Thread to notify when turns finish (null: nobody). */
      notifyThreadId: z.string().nullable(),
      /** Project defaults for repo, base branch and environment. */
      projectId: z.string().nullable().optional(),
      /** "chat": a task chat; "boat": headless in boat; null or absent: How tasks run and the repo's project decide. */
      runner: z.enum(["chat", "boat"]).nullable().optional(),
      /**
       * The repos the user saw the warning for and started as a task chat anyway
       * ([] for a task with no repo); null or absent: no warning confirmed.
       */
      confirmUntrustedChat: z.array(z.string().trim().max(200)).max(20).nullable().optional(),
      /** Measure the first turn's peak memory and recommend a size (Check this repo runs in a sandbox). */
      measureMemory: z.boolean().optional(),
    }),
    output: z.union([launchResult, z.object({ queued: queuedStartSchema, pending: z.literal(true) })]),
  },
  review: {
    input: z.object({
      id: z.string(),
      provider: providerSchema.nullable(),
      sandbox: z.string().nullable(),
      brief: z.string().nullable(),
    }),
    output: launchResult,
  },
  followup: {
    input: z.object({
      id: z.string(),
      message: z.string().trim().min(1).max(100_000),
      steer: z.boolean(),
      provider: providerSchema.nullable(),
      model: z.string().nullable(),
    }),
    output: z.object({ task: taskSchema }),
  },
  interrupt: { input: z.object({ id: z.string() }), output: ok },
  /** Can this headless task continue as a task chat now? Read live (boat and bb are asked); the page refetches when the task changes. */
  continueAsChatStatus: {
    input: z.object({ id: z.string() }),
    output: z.object({
      /** False: no button (a task chat already, closed, never dispatched, or no task chats on this bb). */
      offered: z.boolean(),
      /** Why not now, with the fix. */
      blocked: z.object({ code: z.string(), message: z.string(), hint: z.string().nullable() }).nullable(),
      /** The rules don't run this task as a chat: the dialog warns and needs a tick. */
      untrusted: z.boolean(),
      /** The repos the warning names (all of them with How tasks run In boat). */
      untrustedRepos: z.array(z.string()),
      /** Of those, the ones other tasks ran in this sandbox before. */
      otherRepos: z.array(z.string()),
      /** How tasks run is In boat. */
      workersBoat: z.boolean(),
      /** bb already runs on the sandbox (no install). */
      hasMachine: z.boolean(),
      /** The sandbox is stopped; it starts first. */
      sandboxStopped: z.boolean(),
      moving: z.boolean(),
      /** The last try failed and nothing happened since. */
      lastFailure: z.string().nullable(),
    }),
  },
  /**
   * Move a headless task into a task chat. confirmUntrusted: the repos the
   * user was warned about and ticked ([] for a task with no repo); null: no
   * warning confirmed. Returns once the quick checks passed (pending: true).
   */
  continueAsChat: {
    input: z.object({ id: z.string(), confirmUntrusted: z.array(z.string().max(200)).max(20).nullable() }),
    output: launchResult,
  },
  closeTask: {
    /** discard: close work that hasn't shipped (its sandbox and commits are deleted). */
    input: z.object({ id: z.string(), cancel: z.boolean(), keepSandbox: z.boolean(), discard: z.boolean().optional() }),
    /** keptBecause: why a closed task's sandbox stayed ("task t_… still uses it"), else null. */
    output: z.object({ task: taskSchema, sandbox: z.enum(["deleted", "kept", "gone", "none"]), keptBecause: z.string().nullable() }),
  },
  createSandbox: {
    input: z.object({
      name: z.string().trim().max(120).nullable(),
      machineType: machineTypeSchema.nullable(),
      repo: z.string().trim().nullable(),
      branch: z.string().trim().nullable(),
    }),
    output: z.object({ sandbox: sandboxSchema }),
  },
  sandboxAction: {
    input: z.object({ id: z.string(), action: z.enum(["stop", "resume", "delete"]) }),
    output: ok,
  },
  /** Save a sandbox's state under a name (a project's "start from"); not for sandboxes that run bb. */
  saveSnapshot: {
    input: z.object({ sandboxId: z.string().min(1), name: z.string().trim().min(1).max(80) }),
    output: z.object({ name: z.string(), sizeBytes: z.number().nullable() }),
  },
  /** Previews: an orchestrator's (threadId), a task's (taskId), or all. */
  previews: {
    input: z.object({ threadId: z.string().nullable(), taskId: z.string().nullable() }),
    output: z.object({ previews: z.array(previewSchema) }),
    tags: () => [TAGS.tasks],
  },
  previewAction: {
    input: z.object({ id: z.string(), action: z.enum(["wake", "extend", "stop"]), hours: z.number().min(1).max(24).optional() }),
    output: z.object({ preview: previewSchema }),
  },
  /**
   * Retired UI write: refuses with ship_confirmation_required. Use
   * shipRpcContract.requestShip and the in-thread confirmation instead.
   */
  shipTask: {
    input: z.object({ id: z.string(), keepOpen: z.boolean().optional(), from: z.enum(["page", "chat"]).optional() }),
    output: z.object({
      task: taskSchema,
      shipped: z.array(z.object({ baseBranch: z.string(), sha: z.string(), commits: z.number() })),
      sandbox: z.enum(["deleted", "kept", "gone", "none"]),
      /** Why the closed task's sandbox stayed ("task t_… still uses it"), else null. */
      keptBecause: z.string().nullable(),
    }),
  },
  /** What a project's workers can reach: GitHub access per repo, the environment's secret NAMES (never values), and what else it passes in. */
  projectAccess: {
    input: z.object({ projectId: z.string() }),
    output: z.object({
      environment: z.string().nullable(),
      error: z.string().nullable(),
      secretNames: z.array(z.string()),
      secretFiles: z.array(z.string()),
      passGithub: z.boolean().nullable(),
      passSecrets: z.boolean().nullable(),
      passAgentsCredentials: z.boolean().nullable(),
      /** boat credentials: the boat CLI's login, for the whole account (workers could start, stop and delete any sandbox). */
      passSandboxCredentials: z.boolean().nullable(),
      proxyAiCredentials: z.boolean().nullable(),
      /** Sandboxes get placeholder AI keys (`boat ai proxy on`); false: real keys go in; null: couldn't tell. */
      aiProxy: z.boolean().nullable(),
      /** The proxy is a paid boat add-on: "about $1 a day plus $1 per 1,000 requests", null when boat didn't say. */
      aiProxyPrice: z.string().nullable(),
      repos: z.array(
        z.object({
          repo: z.string(),
          baseBranch: z.string(),
          environmentPermission: z.string().nullable(),
          lastCheck: z.object({ access: z.string(), detail: z.string().nullable(), checkedAt: z.string() }).nullable(),
        }),
      ),
    }),
    tags: () => [TAGS.projects],
  },
  /** Saved boat snapshots (for a project's "start from"). */
  snapshots: {
    input: z.null(),
    output: z.object({
      snapshots: z.array(z.object({ name: z.string(), sizeBytes: z.number().nullable(), createdAt: z.string().nullable(), type: z.string().nullable(), status: z.string().max(60).nullable().optional() })),
      included: z.number().nullable(),
      used: z.number().nullable(),
      error: z.string().nullable(),
    }),
    tags: () => [TAGS.projects],
  },
  startOrchestrator: {
    input: z.object({
      /** Required: what the orchestrator works on. */
      project: projectRefSchema,
      prompt: z.string().trim().min(1).max(100_000),
      title: z.string().trim().max(200).nullable(),
      hostId: z.string().nullable(),
      /** Run in a new boat sandbox machine (cloud orchestrator). */
      cloud: z.boolean().optional(),
      /** Take over from a previous orchestrator thread (its open tasks move here). */
      takeOverThreadId: z.string().nullable().optional(),
      /** Handoff notes from a file, put into the kickoff. */
      takeOverText: z.string().max(200_000).nullable().optional(),
      takeOverFileName: z.string().max(300).nullable().optional(),
      /** Agent and effort picked in the dialog; null or absent: the settings (Agent and Effort for orchestrators). */
      provider: providerSchema.nullable().optional(),
      effort: orchestratorEffortSchema.nullable().optional(),
    }),
    output: z.object({ threadId: z.string(), movedTaskIds: z.array(z.string()) }),
  },
  // ------------------------------------------------------------- projects
  projects: {
    input: z.null(),
    output: z.object({ projects: z.array(projectSchema) }),
    tags: () => [TAGS.projects],
  },
  /** Projects for the New orchestrator dialog: configured ones and local bb projects. */
  orchestratorProjects: {
    input: z.null(),
    output: z.object({ projects: z.array(projectSchema), local: z.array(localProjectSchema), localError: z.string().nullable() }),
    tags: () => [TAGS.projects],
  },
  saveProject: { input: projectInputSchema, output: z.object({ project: projectSchema }) },
  deleteProject: { input: z.object({ id: z.string() }), output: ok },
  /** Push a local project's branch so workers can clone it. */
  pushLocalBranch: {
    /** `branch`: the branch the dialog showed; refused if the checkout moved since. */
    input: z.object({ bbProjectId: z.string(), branch: z.string() }),
    output: z.object({ local: localProjectSchema }),
  },
  /** Turn a chat into an orchestrator (for a project) or back into a plain chat. */
  setOrchestrator: {
    input: z.object({ threadId: z.string(), on: z.boolean(), project: projectRefSchema.nullable().optional() }),
    output: ok,
  },
  /**
   * The GitHub repo of a bb project (from its git remote; no git commands) and
   * the configured project with that repo. Both null for the personal project.
   */
  bbProjectRepo: {
    input: z.object({ bbProjectId: z.string() }),
    output: z.object({ repo: z.string().nullable(), projectId: z.string().nullable() }),
    tags: () => [TAGS.projects],
  },
  /**
   * Keyed by thread id: what the plugin knows about each chat, for the thread
   * header and menu actions. task: a task chat (any chat in a task's
   * workspace), with its task; orchestrator: a real one; chat: anything else.
   */
  threadRoles: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(z.string(), threadRoleSchema),
    keyTags: () => [TAGS.tasks],
  },
  // ------------------------------------------------------------- board
  /** The overview: one orchestrator's (threadId) or everything (null). */
  board: {
    input: z.object({ threadId: z.string().nullable() }),
    output: z.object({
      needsYou: z.array(decisionSchema),
      ready: z.array(taskSchema),
      running: z.array(taskSchema),
      done: z.array(taskSchema),
    }),
    tags: () => [TAGS.tasks],
  },
  /** Answer a decision from the overview: the orchestrator gets it as a message. */
  decision: {
    input: z.object({ id: z.string().min(1).max(128) }),
    output: z.object({ decision: decisionSchema.nullable() }),
    tags: () => [TAGS.tasks],
  },
  answerDecision: {
    input: z.object({
      id: z.string(),
      /** Take the orchestrator's recommendation. */
      accept: z.boolean(),
      answer: z.string().trim().max(2000).nullable(),
    }),
    /** delivered: false when the orchestrator chat is gone (the answer is only recorded). */
    output: z.object({ ok: z.literal(true), delivered: z.boolean() }),
  },
  /** Close a decision without answering (e.g. its orchestrator is gone). */
  dismissDecision: { input: z.object({ id: z.string() }), output: ok },
  /** The chats in a worker chat's workspace (null when the thread isn't a worker chat). */
  workspaceChats: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      workspace: z
        .object({
          taskId: z.string(),
          taskTitle: z.string(),
          orchestratorThreadId: z.string().nullable(),
          /** Who started the task: "Open orchestrator" only for a real one, else "Open <chat>". */
          source: taskSourceSchema,
          /** False once the task is closed (its workspace may be gone). */
          open: z.boolean(),
          /** The workspace (bb environment) the chats share; seeds bb's new-chat composer. */
          environmentId: z.string().nullable(),
          chats: z.array(workspaceChatSchema),
        })
        .nullable(),
    }),
    tags: () => [TAGS.tasks],
  },
  /**
   * Open another chat in a worker's workspace from bb's own composer
   * (experimental_NewThreadComposer): its submitted request, minus the
   * environment (always this workspace).
   */
  newWorkspaceChat: {
    input: z.object({
      threadId: z.string(),
      request: z.object({
        providerId: z.string().min(1),
        model: z.string().min(1),
        reasoningLevel: z.string().min(1),
        permissionMode: z.string().min(1),
        serviceTier: z.string().optional(),
        sessionOptions: z.record(z.string(), z.union([z.string(), z.boolean(), z.null()])).optional(),
        executionInputSources: z.record(z.string(), z.string()).optional(),
        // Prompt parts (text with mentions, images, files) pass through to bb unchanged.
        input: z.array(z.object({ type: z.string() }).passthrough()).min(1),
      }),
    }),
    output: z.object({ threadId: z.string() }),
  },
  // ------------------------------------------------------------- protocol
  /** The shared orchestrator protocol (a Markdown file in the plugin's data folder). */
  protocol: {
    input: z.null(),
    output: z.object({
      text: z.string(),
      /** False while the built-in protocol is used. */
      custom: z.boolean(),
      path: z.string(),
      updatedAt: z.string().nullable(),
      defaultText: z.string(),
      maxChars: z.number(),
    }),
    tags: () => [TAGS.protocol],
  },
  saveProtocol: { input: z.object({ text: z.string().max(100_000) }), output: ok },
  /** Delete the file: the built-in protocol applies again. */
  resetProtocol: { input: z.null(), output: ok },
  modelTiers: {
    input: z.null(),
    output: z.object({ tiers: tierMapSchema, defaults: tierMapSchema, custom: z.boolean() }),
    tags: () => [TAGS.protocol],
  },
  saveModelTiers: { input: z.object({ tiers: tierMapSchema }), output: ok },
  resetModelTiers: { input: z.null(), output: ok },
  // ------------------------------------------------------------- back up and restore
  /** Every setting, the projects, tiers and custom protocol, as the JSON file `bb boat config export` writes. */
  exportConfig: { input: z.null(), output: z.object({ fileName: z.string(), text: z.string() }) },
  /** What importing a backup would change; changes nothing. */
  previewConfigImport: { input: configImportInputSchema, output: configImportResultSchema },
  /** Import a backup (the same checks as the preview; a file with problems is refused). */
  importConfig: { input: configImportInputSchema, output: configImportResultSchema },
  refresh: { input: z.null(), output: ok },
  // ------------------------------------------------------------- account-level UI state (contract-ui.ts)
  ...uiRpcMethods,
  // ------------------------------------------------------------- what a new orchestrator starts with (contract-orchestrator.ts)
  ...orchestratorRpcMethods,
});

export type RpcContract = typeof rpcContract;
