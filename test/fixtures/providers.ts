// Sandbox provider DTOs for every state in the approved designs (Settings ›
// Sandbox providers and Runs on, where each task runs, the Sandboxes
// table's Runs on column): the tests check them against the contract, and
// local fidelity scenes render them. Test data only: the plugin never
// shows these.
import type { ProjectRunsOnDto, RunsOnDto, RunsOnOptionDto, SandboxProviderDto, SandboxProvidersResultDto } from "../../contract.ts";

// ------------------------------------------------------------------ providers

export const BOAT_CONNECTED: SandboxProviderDto = {
  id: "boat",
  label: "boat.dev",
  kind: "cloud",
  isDefault: true,
  available: true,
  enabled: true,
  connection: "connected",
  meta: null,
  summary: "Linux · Standard plan · 475 h left this month",
  pricing: null,
  systems: [],
  apiKey: null,
  status: null,
};

/** Plain words: production has no amounts. */
const INSTABOX_SUMMARY = "Linux microVMs billed per second.";
/** As a connected Instabox provider might state its prices (test and scene data only). */
const INSTABOX_PRICING = "Mac VMs lease for at least 24 h: M2 $10.80, M4 $18 a day.";

/** Connected, Linux only: Mac leases aren't in this version, so Mac reads "coming next". */
export const INSTABOX_CONNECTED: SandboxProviderDto = {
  id: "instabox",
  label: "Instabox",
  kind: "cloud",
  isDefault: false,
  available: true,
  enabled: true,
  connection: "connected",
  meta: null,
  summary: INSTABOX_SUMMARY,
  pricing: INSTABOX_PRICING,
  systems: [
    { os: "linux", label: "Linux", ready: true, note: null },
    { os: "macos", label: "Mac", ready: false, note: "coming next" },
    { os: "windows", label: "Windows", ready: false, note: "not launched yet" },
  ],
  apiKey: { setting: "Instabox API key" },
  status: null,
};

/** Connected once Mac leases exist (the design's state): both systems ready. */
export const INSTABOX_WITH_MAC: SandboxProviderDto = {
  ...INSTABOX_CONNECTED,
  systems: INSTABOX_CONNECTED.systems.map((system) => (system.os === "macos" ? { ...system, ready: true, note: null } : system)),
};

/** As main shows it today: no Instabox provider yet, so no key and no setting for one. */
export const INSTABOX_NOT_CONNECTED: SandboxProviderDto = {
  ...INSTABOX_CONNECTED,
  enabled: false,
  connection: "key-missing",
  pricing: null,
  systems: INSTABOX_CONNECTED.systems.map((system) => ({ ...system, ready: false, note: system.os === "windows" ? system.note : null })),
  apiKey: { setting: null },
};

export const SCALEWAY_NOT_CONNECTED: SandboxProviderDto = {
  id: "scaleway", label: "Scaleway", kind: "cloud", isDefault: false, available: true, enabled: false,
  connection: "key-missing", meta: null, summary: "Paris Apple silicon · 24 h minimum, then hourly until deleted.",
  pricing: null, systems: [{ os: "macos", label: "Mac", note: null, ready: false }], apiKey: { setting: null }, status: null,
};

export const YOUR_MAC_DISABLED: SandboxProviderDto = {
  id: "your-mac",
  label: "Your Mac",
  kind: "own-mac",
  isDefault: false,
  available: false,
  enabled: false,
  connection: "not-connected",
  meta: null,
  summary: "Agents on your own Mac, enrolled in bb. Boat can't run agents on a Mac yet.",
  pricing: null,
  systems: [],
  apiKey: null,
  status: "Not available yet",
};

export const MONTHLY_MAC_DISABLED: SandboxProviderDto = {
  id: "monthly-mac",
  label: "Monthly Mac",
  kind: "monthly-mac",
  isDefault: false,
  available: false,
  enabled: false,
  connection: "not-connected",
  meta: "none yet",
  summary: "A Mac you rent by the month and enroll in bb. Boat can't run agents on a Mac yet.",
  pricing: null,
  systems: [],
  apiKey: null,
  status: "Not available yet",
};

// ------------------------------------------------------------------ Runs on

const PROJECTS: ProjectRunsOnDto[] = [
  { projectId: "storefront", name: "Storefront", detail: "acme/storefront · Linux", provider: "boat", chosen: false },
  { projectId: "api", name: "API", detail: "acme/api · Linux", provider: "instabox", chosen: true },
  { projectId: "docs", name: "Docs", detail: "acme/docs · Linux", provider: "boat", chosen: false },
];

const BOAT_ROUTING = "New work runs on boat.dev unless a project picks another provider below.";

function options(instabox: string | null): RunsOnOptionDto[] {
  return [
    { provider: "boat", label: "boat.dev", disabledReason: null },
    { provider: "instabox", label: "Instabox", disabledReason: instabox },
    { provider: "scaleway", label: "Scaleway", disabledReason: "Add its API key first" },
    { provider: "your-mac", label: "Your Mac", disabledReason: "Not available yet" },
  ];
}

/** boat.dev and Instabox connected; the Mac rows greyed out. */
export const PROVIDERS_CONNECTED: SandboxProvidersResultDto = {
  providers: [BOAT_CONNECTED, INSTABOX_CONNECTED, SCALEWAY_NOT_CONNECTED, YOUR_MAC_DISABLED, MONTHLY_MAC_DISABLED],
  routing: BOAT_ROUTING,
  options: options(null),
  projects: PROJECTS,
};

/** What main shows with only boat.dev: Instabox without a key, every project on boat.dev. */
export const PROVIDERS_BOAT_ONLY: SandboxProvidersResultDto = {
  providers: [BOAT_CONNECTED, INSTABOX_NOT_CONNECTED, SCALEWAY_NOT_CONNECTED, YOUR_MAC_DISABLED, MONTHLY_MAC_DISABLED],
  routing: BOAT_ROUTING,
  options: options("Add its API key first"),
  projects: PROJECTS.map((project) => ({ ...project, provider: "boat", chosen: false })),
};

/** Signed out of boat.dev. */
export const PROVIDERS_SIGNED_OUT: SandboxProvidersResultDto = {
  ...PROVIDERS_BOAT_ONLY,
  providers: [{ ...BOAT_CONNECTED, connection: "not-connected", summary: "Linux · not signed in" }, INSTABOX_NOT_CONNECTED, SCALEWAY_NOT_CONNECTED, YOUR_MAC_DISABLED, MONTHLY_MAC_DISABLED],
};

// ------------------------------------------------------------------ where each task and sandbox runs

const runsOn = (fields: Partial<RunsOnDto> & Pick<RunsOnDto, "provider" | "label">): RunsOnDto => ({ os: "linux", machine: null, note: null, detail: null, ...fields });

export const RUNS_ON = {
  boatDefault: runsOn({ provider: "boat", label: "boat.dev", machine: "Default" }),
  boatSmall: runsOn({ provider: "boat", label: "boat.dev", machine: "Small" }),
  /** Just started: the size isn't read yet. */
  boatUnknown: runsOn({ provider: "boat", label: "boat.dev" }),
  instaboxLinux: runsOn({ provider: "instabox", label: "Instabox", machine: "Linux · Default" }),
  instaboxMac: runsOn({ provider: "instabox", label: "Instabox", os: "macos", machine: "Mac M2", note: "lease ends Thu 14:00" }),
  instaboxMacShared: runsOn({ provider: "instabox", label: "Instabox", os: "macos", machine: "Mac M2", note: "same lease, ends Thu 14:00", detail: "Shares the lease with Redesign the onboarding screens" }),
  yourMac: runsOn({ provider: "your-mac", label: "Your Mac", os: "macos", machine: "MacBook Pro", note: "$0" }),
  /** A sandbox row: what the lease costs under its name. */
  instaboxMacSandbox: runsOn({ provider: "instabox", label: "Instabox", os: "macos", machine: "Mac M2", detail: "24 h lease · $10.80" }),
} satisfies Record<string, RunsOnDto>;
