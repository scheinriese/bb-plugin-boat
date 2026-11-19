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
});
export type RunsOnDto = z.infer<typeof runsOnSchema>;

/** A system a provider offers: a chip under its row. */
export const providerSystemSchema = z.object({
  os: z.enum(["linux", "macos", "windows"]),
  label: z.string(),
  /** Usable with this provider now (the chip gets a check). */
  ready: z.boolean(),
  /** Why it can't be, when the provider doesn't offer it yet ("not launched yet"; a dashed chip). Null: it's only not connected. */
  note: z.string().nullable(),
});
export type ProviderSystemDto = z.infer<typeof providerSystemSchema>;

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
  /** Under the name: the plan and what's left, its prices, or why it's greyed out. */
  summary: z.string(),
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

export const providerRpcMethods = {
  /** Settings › Sandbox providers and Runs on. */
  sandboxProviders: {
    input: z.null(),
    output: sandboxProvidersResultSchema,
    tags: () => [PROVIDERS_TAG, "boat:projects", "boat:setup"],
  },
  /** Pick the provider for a project's new work (the default's id clears its own pick). Tasks already running stay where they are. */
  setProjectRunsOn: {
    input: z.object({ projectId: z.string().min(1).max(64), provider: z.string().trim().min(1).max(40) }),
    output: projectRunsOnSchema,
  },
};
