// The plugin's settings live in two places:
// - SETTINGS: bb's settings list (Settings → Plugins → Boat Cloud Agents,
//   `bb plugin config boat`), the ten everyday choices in this order;
// - PLUGIN_SETTINGS: the plugin's own settings, kept in its kv under one key,
//   shown in the plugin's own settings sections and set with
//   `bb boat config get|set|reset`.
// src/settings-store.ts merges both into one set of values; the backup
// (src/config.ts) exports and imports all of them.
import type { PluginSettingDescriptor, PluginSettingValue, PluginSettingsValues } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MACHINE_TYPES, invalidBranchNames } from "./boat-api.ts";
import { DEFAULT_EVIDENCE_UPLOADER, evidenceSourceProblem } from "./evidence.ts";

/** Number ranges (bb's list shows only label and description; the plugin's own UI shows these). */
export const NUMBER_RANGES = {
  maxActiveSandboxes: { min: 0, max: 1000, integer: true },
  stopIdleAfterMinutes: { min: 0, max: 1440, integer: true },
  tasksBeforeAsking: { min: 0, max: 100, integer: true },
  relaySwitchAt: { min: 5, max: 100, integer: true },
  relaySwitchBackBelow: { min: 0, max: 95, integer: true },
  relayQuietMinutes: { min: 0, max: 240, integer: true },
  sandboxTtlHours: { min: 0.25, max: 720, integer: false },
} as const;

function range(key: keyof typeof NUMBER_RANGES) {
  const { min, max, integer } = NUMBER_RANGES[key];
  return (integer ? z.number().int("Use a whole number.") : z.number()).min(min, `Use ${min} or more.`).max(max, `Use ${max} or less.`);
}

/** Size options; the rates and plan limits go in descriptions (option labels stay short). */
const SIZE_LABELS = {
  small: "Small (2 vCPU, 4 GB)",
  default: "Default (4 vCPU, 8 GB)",
  large: "Large (8 vCPU, 16 GB)",
  xlarge: "XLarge (16 vCPU, 32 GB)",
};

/**
 * Effort levels for orchestrator chats: the ones both Claude Code and Codex
 * take in bb (both also have max, and one level of their own above it,
 * which an orchestrator doesn't need).
 */
export const ORCHESTRATOR_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type OrchestratorEffort = (typeof ORCHESTRATOR_EFFORTS)[number];

/** "How tasks run": in boat everywhere, as chats for your projects, or as chats everywhere. */
export const WORKERS_VALUES = ["boat", "projects", "all"] as const;
export type Workers = (typeof WORKERS_VALUES)[number];

// ---------------------------------------------------------------- bb's settings list

export const SETTINGS = {
  agents: {
    type: "select",
    label: "Coding agents",
    description:
      "Auto-detect uses the Claude and ChatGPT logins connected in boat.dev. Pick by hand if bb's Account Pooler logs your task chats in instead. With one agent, every task and review runs on it.",
    options: ["auto", "both", "claude", "codex"],
    experimental_optionLabels: { auto: "Auto-detect", both: "Claude and Codex", claude: "Only Claude", codex: "Only Codex" },
    default: "auto",
  },
  workers: {
    type: "select",
    label: "How tasks run",
    description:
      "In boat: headless; you follow each task on the Cloud agents page, and bb Connect isn't needed. As chats: each task is a bb chat you can open and type into; needs bb Connect. For projects: only repos you added as projects (with Run tasks as chats on), which is safer, since a task chat's sandbox holds bb machine credentials; other repos run in boat.",
    options: [...WORKERS_VALUES],
    experimental_optionLabels: { boat: "In boat (simplest)", projects: "As chats for projects", all: "As chats everywhere" },
    default: "boat",
  },
  environment: {
    type: "string",
    label: "Boat environment",
    description:
      "The boat.dev environment new sandboxes start from: its repos, secrets and agent logins. Empty: your boat default. A project can pick its own.",
    default: "",
  },
  machineType: {
    type: "select",
    label: "Default sandbox size",
    description: "For new task sandboxes; a project or a task can pick another size. Small runs at half rate and Large at double; XLarge needs a bigger boat plan.",
    options: [...MACHINE_TYPES],
    experimental_optionLabels: SIZE_LABELS,
    default: "default",
  },
  maxActiveSandboxes: {
    type: "number",
    label: "Sandboxes at once",
    description: "The most sandboxes running at the same time. Each one uses sandbox hours on your boat plan. 0: your plan's limit.",
    experimental_schema: range("maxActiveSandboxes"),
    default: 3,
  },
  implementProvider: {
    type: "select",
    label: "Agent for tasks",
    description: "For tasks that don't name an agent. With one agent connected, it runs everything.",
    options: ["claude", "codex"],
    experimental_optionLabels: { claude: "Claude Code", codex: "Codex" },
    default: "claude",
  },
  reviewProvider: {
    type: "select",
    label: "Agent for reviews",
    description: "When a task already ran on this agent, its review uses the other one. With one agent connected, it reviews too.",
    options: ["codex", "claude"],
    experimental_optionLabels: { claude: "Claude Code", codex: "Codex" },
    default: "codex",
  },
  stopIdleAfterMinutes: {
    type: "number",
    label: "Stop idle sandboxes after (min)",
    description:
      "A sandbox whose agent has finished and is waiting for you stops after this long, to save sandbox hours. Work still running, background jobs included, keeps it on. Your next message starts it again; anything the agent kept in memory or /tmp is lost. 60 is an hour; 0: never.",
    experimental_schema: range("stopIdleAfterMinutes"),
    default: 60,
  },
  pushNotifications: {
    type: "boolean",
    label: "Notify my devices",
    description:
      "A desktop or phone notice when a task finishes a turn. Notices that an orchestrator switched agents, or that both agents are near their limits, always go out.",
    default: false,
  },
  workerInstructions: {
    type: "string",
    label: "Instructions for every task",
    description: "Added to every task's brief: house rules, test commands, commit style. A project can add its own.",
    experimental_multiline: true,
    default: "",
  },
} satisfies Record<string, PluginSettingDescriptor>;

// ---------------------------------------------------------------- the plugin's own settings

/** The plugin's own settings sections, in order (Projects and Back up and restore sit between and after them). */
export const SETTING_SECTIONS = [
  { id: "setup", title: "Setup" },
  { id: "usage-limits", title: "Usage limits" },
  { id: "models", title: "Models" },
  { id: "orchestrators", title: "Orchestrators (optional)" },
  { id: "advanced", title: "Advanced" },
] as const;
export type SettingSection = (typeof SETTING_SECTIONS)[number]["id"];
export const SETTING_SECTION_IDS = SETTING_SECTIONS.map((section) => section.id) as [SettingSection, ...SettingSection[]];

/** A setting of the plugin's own: bb's descriptor shape, plus where the plugin's UI shows it. */
export type PluginSettingSpec = PluginSettingDescriptor & {
  section: SettingSection;
  description: string;
  /** Rows that belong together (the Claude ↔ Codex switching block). */
  group?: "switching";
  /** Shown under a fold with this title. */
  fold?: string;
};

const NEEDS_BOTH = "Needs both Claude and Codex.";

export const PLUGIN_SETTINGS = {
  // Setup
  evidenceUploader: {
    section: "setup",
    type: "string",
    label: "Screenshots and recordings",
    description:
      "Lets agents upload screenshots and recordings before their sandbox is deleted. Empty: off. builtin: the uploader that comes with the plugin, for any S3-compatible bucket (set EVIDENCE_BUCKET and its keys in your boat environment). Or your own script as owner/repo:path/to/script.mjs@<commit>, fetched with this computer's gh login (pin a commit).",
    experimental_schema: z
      .string()
      .max(500)
      .refine((text) => evidenceSourceProblem(text) === null, { message: "Use builtin, or owner/repo:path/to/script.mjs (optionally @commit)." }),
    default: DEFAULT_EVIDENCE_UPLOADER,
  },
  // Usage limits
  autoFailover: {
    section: "usage-limits",
    type: "boolean",
    label: "When an agent hits its limit mid-task, continue with the other one",
    description: `The task carries on with the other agent in the same sandbox, and follow-ups go to the other agent when the task's agent is near its limit. ${NEEDS_BOTH}`,
    default: true,
  },
  avoidExtraUsage: {
    section: "usage-limits",
    type: "boolean",
    label: "Don't start work on paid extra usage",
    description: "With your agents near their usage limits, new tasks wait for a reset (and you're told) instead of using paid extra usage.",
    default: true,
  },
  relayEnabled: {
    section: "usage-limits",
    group: "switching",
    type: "boolean",
    label: "Claude ↔ Codex switching for orchestrators",
    description:
      "Near a usage limit, an orchestrator writes a handoff note and continues on the other agent, then moves back to the Agent for orchestrators (under Orchestrators) once it has room. New tasks also start on the agent with room. Needs both Claude and Codex; usage readings come from bb's Provider usage (and the Account Pooler, if you use it).",
    default: false,
  },
  relaySwitchAt: {
    section: "usage-limits",
    group: "switching",
    fold: "Fine-tune",
    type: "number",
    label: "Switch at (% of a usage limit)",
    description: "Keep it below 100, so paid extra usage isn't reached.",
    experimental_schema: range("relaySwitchAt"),
    default: 90,
  },
  relaySwitchBackBelow: {
    section: "usage-limits",
    group: "switching",
    fold: "Fine-tune",
    type: "number",
    label: "Switch back below (%)",
    description: "Orchestrators move back once the Agent for orchestrators is under this much of its usage limit. At least 5 below Switch at.",
    experimental_schema: range("relaySwitchBackBelow"),
    default: 50,
  },
  relayQuietMinutes: {
    section: "usage-limits",
    group: "switching",
    fold: "Fine-tune",
    type: "number",
    label: "Wait before switching back (min)",
    description: "Only between turns, after you haven't written for this long.",
    experimental_schema: range("relayQuietMinutes"),
    default: 10,
  },
  // Models
  implementModel: {
    section: "models",
    type: "string",
    label: "Model for tasks",
    description: "For tasks started without a model preset. Empty: the Build preset's model.",
    experimental_schema: z.string().max(200),
    default: "",
  },
  reviewModel: {
    section: "models",
    type: "string",
    label: "Model for reviews",
    description: "For reviews started without a model preset. Empty: the Review preset's model.",
    experimental_schema: z.string().max(200),
    default: "",
  },
  reasoningEffort: {
    section: "models",
    type: "select",
    label: "Effort",
    description: "Only for tasks with a model set above. Tasks with a model preset use the preset's effort.",
    options: ["default", "low", "medium", "high", "xhigh", "max"],
    experimental_optionLabels: { default: "boat's default", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" },
    default: "default",
  },
  // Orchestrators (optional)
  // The key is the old "Main agent for orchestrators" (backups keep working).
  relayPreferred: {
    section: "orchestrators",
    type: "select",
    label: "Agent for orchestrators",
    description: "New orchestrators start on it (on the other one while it isn't connected). Claude ↔ Codex switching brings them back to it once it has room.",
    options: ["claude", "codex"],
    experimental_optionLabels: { claude: "Claude Code", codex: "Codex" },
    default: "claude",
  },
  orchestratorEffort: {
    section: "orchestrators",
    type: "select",
    label: "Effort for orchestrators",
    description:
      "Orchestrators mostly read reports, plan and start tasks; the tasks do the heavy work at their own preset. Higher effort uses your limits faster: an orchestrator stays open and wakes after every task turn. The model is its agent's Build preset model, as for Build tasks (Models, above).",
    options: [...ORCHESTRATOR_EFFORTS],
    experimental_optionLabels: { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high" },
    default: "high",
  },
  tasksBeforeAsking: {
    section: "orchestrators",
    type: "number",
    label: "Tasks at once before asking",
    description: "Orchestrators ask you before running more tasks than this at the same time: each one uses sandbox hours and agent usage. 0: never ask.",
    experimental_schema: range("tasksBeforeAsking"),
    default: 5,
  },
  sidebarLayout: {
    section: "orchestrators",
    type: "select",
    label: "Orchestrators in the sidebar",
    description: "Sections by project: one sidebar section per project, with each orchestrator's task chats under it.",
    options: ["sections", "pinned", "plain"],
    experimental_optionLabels: { sections: "Sections by project", pinned: "Pinned", plain: "No grouping" },
    default: "sections",
  },
  orchestratorMachineType: {
    section: "orchestrators",
    type: "select",
    label: "Size for chats on a Boat sandbox",
    description: "Cloud orchestrators and any chat you start on a Boat sandbox. They mostly coordinate, so Small is usually enough.",
    options: [...MACHINE_TYPES],
    experimental_optionLabels: SIZE_LABELS,
    default: "small",
  },
  cloudOrchestratorFullAccess: {
    section: "orchestrators",
    type: "boolean",
    label: "Full access for cloud orchestrators",
    description:
      "Like task chats, they run unattended in their own sandbox. Off: they use your default mode for new chats, where Claude Code's sandbox can block the `bb` command.",
    default: true,
  },
  // Advanced
  sandboxTtlHours: {
    section: "advanced",
    type: "number",
    label: "Hard stop after (hours)",
    description: "boat stops a sandbox after this long unless an agent is working. Your plan may stop sandboxes sooner.",
    experimental_schema: range("sandboxTtlHours"),
    default: 2,
  },
  freeSlotsWhenFull: {
    section: "advanced",
    type: "boolean",
    label: "Make room at your sandbox limit",
    description: "At the limit, stop the sandbox that has waited longest (all its agents idle, nothing running in the background) to start new work. Its tasks pick up again on your next message.",
    default: true,
  },
  deleteSandboxOnClose: {
    section: "advanced",
    type: "boolean",
    label: "Delete sandboxes when tasks close",
    description: "Sandboxes with unshipped work are kept until you decide.",
    default: true,
  },
  reviewSandbox: {
    section: "advanced",
    type: "select",
    label: "Where reviews run",
    description: "A new sandbox while you're under your sandbox limit, else the reviewed task's sandbox; or always one of the two.",
    options: ["auto", "new", "same"],
    experimental_optionLabels: { auto: "New one if there's room", new: "Always a new sandbox", same: "The task's sandbox" },
    default: "auto",
  },
  extraProtectedBranches: {
    section: "advanced",
    type: "string",
    label: "Extra protected branches",
    description:
      "Comma-separated branches no task may push to, in every repo: on top of main, master, and each project's base and protected branches.",
    experimental_schema: z
      .string()
      .max(2000)
      .refine((text) => invalidBranchNames(text).length === 0, { message: "Use branch names separated by commas, like release, develop." }),
    default: "",
  },
  boatPath: {
    section: "advanced",
    type: "string",
    label: "boat CLI location",
    description: "Leave empty to find it on its own (~/.ascii/bin/boat, then PATH).",
    experimental_schema: z.string().max(1000),
    default: "",
  },
} satisfies Record<string, PluginSettingSpec>;

export type DeclaredKey = keyof typeof SETTINGS;
export type PluginKey = keyof typeof PLUGIN_SETTINGS;
export type SettingKey = DeclaredKey | PluginKey;
export type DeclaredValues = PluginSettingsValues<typeof SETTINGS>;
export type PluginValues = PluginSettingsValues<typeof PLUGIN_SETTINGS>;
/** Every setting's effective value, wherever it lives. */
export type SettingsValues = DeclaredValues & PluginValues;

/** Every setting, bb's list first, then the plugin's own in section order. */
export const ALL_SETTINGS: Record<SettingKey, PluginSettingDescriptor> = { ...SETTINGS, ...PLUGIN_SETTINGS };

export function isDeclaredKey(key: string): key is DeclaredKey {
  return Object.hasOwn(SETTINGS, key);
}

export function isPluginKey(key: string): key is PluginKey {
  return Object.hasOwn(PLUGIN_SETTINGS, key);
}

/** Settings that only mean something with both agents (the plugin's UI greys them out with one). */
export const BOTH_AGENTS_ONLY: readonly PluginKey[] = ["autoFailover", "relayEnabled", "relayPreferred", "relaySwitchAt", "relaySwitchBackBelow", "relayQuietMinutes"];
export const BOTH_AGENTS_REASON = "Needs both Claude and Codex";

// ---------------------------------------------------------------- checks

/** Why a value doesn't fit a setting, like bb's own check (null: it fits). */
export function settingProblem(key: string, descriptor: PluginSettingDescriptor, value: unknown): string | null {
  if (descriptor.type === "boolean") {
    if (typeof value !== "boolean") return `${key} must be true or false`;
  } else if (descriptor.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${key} must be a number`;
  } else {
    if (typeof value !== "string") return `${key} must be text`;
    if (descriptor.type === "select" && !descriptor.options.includes(value)) return `${key} must be one of ${descriptor.options.join(", ")}`;
  }
  const schema = descriptor.experimental_schema as { "~standard"?: { validate(input: unknown): unknown } } | undefined;
  const result = schema?.["~standard"]?.validate(value) as { issues?: readonly { message: string }[] } | Promise<unknown> | undefined;
  if (result && !(result instanceof Promise) && result.issues && result.issues.length > 0) {
    return `${key}: ${result.issues[0]!.message}`;
  }
  return null;
}

/** Points between "Switch at" and "Switch back below", so an orchestrator doesn't bounce between agents. */
export const RELAY_GAP = 5;

/** Rules across settings (one field's schema can't see the others). */
export function crossFieldProblems(values: Pick<PluginValues, "relaySwitchAt" | "relaySwitchBackBelow">): string[] {
  const highest = values.relaySwitchAt - RELAY_GAP;
  if (values.relaySwitchBackBelow <= highest) return [];
  return [
    `relaySwitchBackBelow (${values.relaySwitchBackBelow}) must be at least ${RELAY_GAP} below relaySwitchAt (${values.relaySwitchAt}), so orchestrators don't switch back and forth: use ${Math.max(0, highest)} or less, or raise relaySwitchAt.`,
  ];
}

/** A typed text value from the CLI (`bb boat config set relaySwitchAt 85`); throws with a plain reason. */
export function parseSettingText(key: string, descriptor: PluginSettingDescriptor, text: string): PluginSettingValue {
  if (descriptor.type === "boolean") {
    const lower = text.trim().toLowerCase();
    if (["true", "on", "yes", "1"].includes(lower)) return true;
    if (["false", "off", "no", "0"].includes(lower)) return false;
    throw new Error(`${key} must be true or false.`);
  }
  if (descriptor.type === "number") {
    const value = Number(text.trim());
    if (text.trim() === "" || !Number.isFinite(value)) throw new Error(`${key} must be a number.`);
    return value;
  }
  return text;
}

// ---------------------------------------------------------------- older settings

/** Settings earlier versions had that are gone (a backup's values are ignored). */
export const REMOVED_SETTINGS = ["pollIntervalSeconds"] as const;
/** The two settings `workers` replaced (version 1 backups). */
export const LEGACY_WORKER_SETTINGS = ["workerMode", "adhocWorkerMode"] as const;

type Runner = "chat" | "boat";

/**
 * workerMode + adhocWorkerMode (version 1) → workers: boat + anything → boat,
 * chat + boat → projects, chat + chat → all.
 */
export function workersFromLegacy(workerMode: Runner, adhocWorkerMode: Runner): Workers {
  if (workerMode === "boat") return "boat";
  return adhocWorkerMode === "chat" ? "all" : "projects";
}

/** What `workers` means for each kind of repo: chats are possible at all, and for repos outside your projects. */
export function runnersFor(workers: string): { workerMode: Runner; adhocWorkerMode: Runner } {
  return {
    workerMode: workers === "projects" || workers === "all" ? "chat" : "boat",
    adhocWorkerMode: workers === "all" ? "chat" : "boat",
  };
}
