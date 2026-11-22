import { ownMacFactsSchema, ownMacRpcMethods, legacyMacAdoptionSchema } from "./contract-ownmac.ts";
import { monthlyMacRpcMethods, monthlyMacSuggestionSchema, monthlyMacComparisonSchema } from "./contract-monthly-macs.ts";
// Sandbox providers in the RPC contract (contract.ts spreads
// providerRpcMethods into it and puts runsOn on tasks and sandboxes):
// - sandboxProviders: the providers Boat knows, whether each is on and
//   connected (Settings › Sandbox providers), and where each project's new
//   work runs (Settings › Runs on);
// - setProjectRunsOn: pick the provider for a project's new work;
// - runsOn: where one task or sandbox runs, in the words the UI shows (the
//   tasks-started card, task chips, Cloud agents › Sandboxes).
// Like contract.ts it may only import zod: the app imports it as a value. It
// can't import contract.ts (that imports this), so it names its tags itself.
import { z } from "zod";

/** Tag of the providers read (setProjectRunsOn and settings changes invalidate it). */
export const PROVIDERS_TAG = "boat:providers";

/** boat.dev's id (tasks.sandbox_provider): the default provider, and the only one before there were others. */
export const DEFAULT_SANDBOX_PROVIDER = "boat";

/** connected: it can take work; not-connected: it can't reach the provider (signed out, a rejected key); key-missing: no API key yet. */
export const PROVIDER_CONNECTION_VALUES = ["connected", "not-connected", "key-missing"] as const;
/** cloud: the provider's own machines; own-mac: the user's Mac, enrolled in bb; monthly-mac: a Mac rented by the month, enrolled in bb. */
export const PROVIDER_KIND_VALUES = ["cloud", "own-mac", "monthly-mac"] as const;
export const RUNS_ON_OS_VALUES = ["linux", "macos"] as const;

/** Where one task or sandbox runs. */
export const runsOnSchema = z.object({
  /** The provider's id, as on the task (tasks.sandbox_provider): "boat", "instabox", … */
  provider: z.string(),
  /** Its name: "boat.dev", "Instabox", "Your Mac". */
  label: z.string(),
  os: z.enum(RUNS_ON_OS_VALUES),
  /** The machine in a word or two: "Default", "Small", "Linux · Default", "Mac M2", "MacBook Pro" (null: not known yet). */
  machine: z.string().nullable(),
  /** One more fact for the task's line: "lease ends Thu 14:00", "$0" (null: none). */
  note: z.string().nullable(),
  /**
   * A second line where there's room. On a task, what it shares (the chip's
   * tooltip: "Shares the lease with …"); on a sandbox, what it costs (the
   * Sandboxes table: "24 h lease · $10.80"). Null: none.
   */
  detail: z.string().nullable(),
  leaseCost: z.string().optional(),
  lease: z.object({ paidUntil: z.string(), endedAt: z.string().nullable(), shared: z.boolean(), kept: z.boolean(), releaseAt: z.string().nullable(), hourPrice: z.number().optional(), currency: z.string().optional(), billingIncrementSeconds:z.number().optional() }).optional(),
  sharedTasks: z.number().int().nonnegative().optional(),
});
export type RunsOnDto = z.infer<typeof runsOnSchema>;

/** A system a provider offers: a chip under its row. */
export const providerSystemSchema = z.object({
  os: z.enum(["linux", "macos", "windows"]),
  label: z.string(),
  /** Usable with this provider now: connected, and Boat can start sandboxes there (the chip gets a check). */
  ready: z.boolean(),
  /** Why it can't be ("not launched yet", "coming next"; a dashed chip). Null: it's only not connected. */
  note: z.string().nullable(),
});
export type ProviderSystemDto = z.infer<typeof providerSystemSchema>;

export const providerStepSchema = z.object({
  id: z.string(), label: z.string(), done: z.boolean(), detail: z.string(),
  possible: z.boolean().default(true),
  /** Optional setup (for example GitHub for repo-less tasks) does not block readiness. */
  required: z.boolean().optional(),
  docsUrl: z.string().url().optional(),
});
export type ProviderStepDto = z.infer<typeof providerStepSchema>;
export const linuxUsageSchema = z.object({
  plan: z.string().nullable(), used: z.number().nullable(), credit: z.number().nullable(),
  remaining: z.number().nullable(), resetsAt: z.string().nullable(), hours: z.number().nullable(),
  hoursScope:z.enum(["period","running-machines"]).optional(),
  active: z.number().nullable(), error: z.string().nullable(),
  accountCredit: z.boolean().optional(),
  /** This usage endpoint reports the whole provider account, including Macs. */
  scope: z.literal("account-total").optional(),
  includesMacs: z.literal(true).optional(),
  currency: z.literal("USD").optional(),
  /** Time of the successful provider usage read; never the time of a failed attempt. */
  observedAt: z.string().nullable().optional(),
  periodStart: z.string().nullable().optional(),
  periodEnd: z.string().nullable().optional(),
});
export type LinuxUsageDto = z.infer<typeof linuxUsageSchema>;

export const sshAliasSchema = z.string().max(128).refine(value => value === "" || /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value), "Use an SSH host alias only: letters, numbers, underscores or hyphens; no paths, spaces or options.");
export const ownMacConfigSchema = z.object({ownMacEnabled:z.boolean(),ownMacPaused:z.boolean(),ownMacAlias:sshAliasSchema,ownMacMaxTasks:z.number().int().min(1).max(4),ownMacIsolation:z.enum(["vm","user"]).default("vm")});
export const ownMacSchema = ownMacConfigSchema.extend({running:z.number().int().nonnegative(),max:z.number().int().positive(),facts:ownMacFactsSchema.optional()});
export type OwnMacDto = z.infer<typeof ownMacSchema>;
/** One row of Settings › Sandbox providers. */
export const sandboxProviderSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(PROVIDER_KIND_VALUES),
  /** New work goes here unless a project picks another. */
  isDefault: z.boolean(),
  /** This version of Boat has the provider (false: the row shows, greyed out, until it does). */
  available: z.boolean(),
  /** In use: new work can go there (it's available and turned on). */
  enabled: z.boolean(),
  connection: z.enum(PROVIDER_CONNECTION_VALUES),
  /** After the name: its machine ("MacBook Pro M3 · bb machine") or "none yet" (null: nothing). */
  meta: z.string().nullable(),
  /** Under the name: the plan and what's left, what it offers, or why it's greyed out. Never amounts: those are in pricing. */
  summary: z.string(),
  /** Its prices, as the provider itself states them (null: it doesn't say; Boat never makes them up). */
  pricing: z.string().nullable(),
  /** The systems it offers (empty: it doesn't list them). */
  systems: z.array(providerSystemSchema),
  /**
   * It signs in with an API key that bb keeps in its secrets, so Boat never
   * sees the value (null: it signs in another way). setting: that bb
   * setting's label in the plugin's settings list (null: this version of
   * Boat has no such setting yet).
   */
  apiKey: z.object({ setting: z.string().nullable() }).nullable(),
  /** Status words when the connection alone doesn't say it ("Awake · on power", "Not available yet"); null: the connection's own. */
  status: z.string().nullable(),
  steps: z.array(providerStepSchema).optional(),
  releaseNotice: z.string().optional(),
  linuxUsage: linuxUsageSchema.optional(),
  waitingTasks: z.number().optional(),
  ownMac: ownMacSchema.optional(),
});
export type SandboxProviderDto = z.infer<typeof sandboxProviderSchema>;

/** A choice in a project's Runs on dropdown. */
export const runsOnOptionSchema = z.object({
  provider: z.string(),
  label: z.string(),
  /** Why it can't be picked now (null: it can). */
  disabledReason: z.string().nullable(),
});
export type RunsOnOptionDto = z.infer<typeof runsOnOptionSchema>;

/** One row of Settings › Runs on. */
export const projectRunsOnSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  /** Under the name: its main repo and system, or where its Mac work falls back to. */
  detail: z.string(),
  /** The provider its new work goes to: its own pick, or the default. */
  provider: z.string(),
  /** The project picked it (false: it follows the default). */
  chosen: z.boolean(),
});
export type ProjectRunsOnDto = z.infer<typeof projectRunsOnSchema>;

export const sandboxProvidersResultSchema = z.object({
  providers: z.array(sandboxProviderSchema),
  /** The line under the providers: where work goes first, and what Boat never does. */
  routing: z.string(),
  /** The Runs on dropdown's choices, the default first. */
  options: z.array(runsOnOptionSchema),
  projects: z.array(projectRunsOnSchema),
});
export type SandboxProvidersResultDto = z.infer<typeof sandboxProvidersResultSchema>;

export const macUsageWindowSchema = z.object({ leaseDays: z.number(), costs: z.record(z.string(),z.number()) });
export const macUsageSchema = z.object({
  /** Local ledger calculation, never a provider billing observation. */
  calculatedAt: z.string().optional(),
  monthPeriod: z.object({ since: z.string(), until: z.string() }).optional(),
  ownMac: ownMacFactsSchema.extend({rent:z.literal(0)}).optional(),
  monthlySuggestions: z.array(monthlyMacSuggestionSchema).optional(),
  monthlyComparisons: z.array(monthlyMacComparisonSchema).optional(),
  month: macUsageWindowSchema, rolling30: macUsageWindowSchema,
  byProvider: z.array(z.object({ id: z.string(), label: z.string(), month: macUsageWindowSchema, rolling30: macUsageWindowSchema })).optional(),
  today: z.record(z.string(),z.number()).optional(),
  providers: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  notices: z.array(z.object({ id: z.string(), provider: z.string(), label: z.string(), machineId: z.string(), at: z.string(), text: z.string(), tokenRevocation: z.boolean().optional(), expiresAt: z.string().nullable().optional() })).optional(),
  adoptions: z.array(z.object({
    leaseId:z.string(), provider:z.string(), machineId:z.string(), taskId:z.string(), sourceTaskId:z.string(), adoptedAt:z.string(), endedAt:z.string().nullable(),
    operatorProof:legacyMacAdoptionSchema,
    original:z.object({endedAt:z.string().nullable(),endReason:z.string().nullable(),endEvidence:z.string(),releaseAt:z.string().nullable()}),
    observed:z.object({leaseId:z.string(),startedAt:z.string(),paidUntil:z.string(),model:z.string(),minimumCost:z.number(),hourPrice:z.number(),currency:z.string(),scheduledReleaseAt:z.string().nullable()}),
  })).optional(),
  /** Raw history for evidence inspection, not a claim of recovery eligibility. */
  legacyEnded: z.array(z.object({
    id:z.string(),provider:z.string(),machineId:z.string(),model:z.string(),startedAt:z.string(),paidUntil:z.string(),endedAt:z.string(),endReason:z.literal("deleted"),endEvidence:z.literal("legacy"),releaseAt:z.string().nullable(),kept:z.boolean(),minimumCost:z.number(),hourPrice:z.number(),currency:z.string(),
  })).max(100).optional(),
  held: z.array(z.object({ provider: z.string().optional(), billingIncrementSeconds: z.number().optional(), machineId: z.string(), size: z.string(), paidUntil: z.string(), minimumCost: z.number(), hourPrice: z.number(), kept: z.boolean(), releaseAt: z.string().nullable(), currency: z.string() })),
});
export type MacUsageDto = z.infer<typeof macUsageSchema>;
export const providerRpcMethods = {
  ...monthlyMacRpcMethods,
  ...ownMacRpcMethods,
  macUsage: { input: z.object({timezoneOffsetMinutes:z.number().int().min(-840).max(840)}).nullable(), output: macUsageSchema, tags: () => ["boat:sandboxes", "boat:tasks", "boat:monthly-macs"] },
  /** Settings › Sandbox providers and Runs on. */
  sandboxProviders: {
    input: z.null(),
    output: sandboxProvidersResultSchema,
    tags: () => [PROVIDERS_TAG, "boat:projects", "boat:setup"],
  },
  checkSandboxProviders: { input: z.null(), output: sandboxProvidersResultSchema },
  /** Pick the provider for a project's new work (the default's id clears its own pick). Tasks already running stay where they are. */
  setProjectRunsOn: {
    input: z.object({ projectId: z.string().min(1).max(64), provider: z.string().trim().min(1).max(40) }),
    output: projectRunsOnSchema,
  },
};
