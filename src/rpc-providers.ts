// RPC handlers for sandbox providers (contract-providers.ts): Settings ›
// Sandbox providers and Runs on, and the runsOn words on tasks and
// sandboxes. boat.dev's row reads the setup's boat facts (CLI, sign-in,
// plan, hours left). A provider this version doesn't have yet shows as not
// connected (Instabox) or greyed out (your Mac, a monthly Mac), never as
// working. A project's pick is kept on the project (projects.ts), where the
// registry's forProject reads it; nothing here starts, stops or moves work.
import { experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import {
  PROVIDERS_TAG,
  type ProjectRunsOnDto,
  type ProviderSystemDto,
  type RunsOnDto,
  type RunsOnOptionDto,
  type SandboxProviderDto,
  type SandboxProvidersResultDto,
} from "../contract-providers.ts";
import { SIZE_SPECS } from "./memory.ts";
import type { BoatProject } from "./projects.ts";
import type { BoatFacts } from "./providers/boat/setup.ts";
import type { ProviderRegistry } from "./providers/registry.ts";
import type { MachineType, SandboxProvider } from "./providers/types.ts";
import type { Runtime } from "./runtime.ts";

type Kind = SandboxProviderDto["kind"];

/** A provider the settings list whether or not this version has it, in the order they're shown. */
interface CatalogEntry {
  id: string;
  label: string;
  kind: Kind;
  /** Under the name while it isn't connected (connected cloud providers say their plan instead). */
  summary: string;
  /** The systems it offers; ready ones get a check once it's connected. */
  systems: { os: ProviderSystemDto["os"]; label: string; note: string | null }[];
  /** It signs in with an API key kept in bb's secrets. */
  apiKey: boolean;
  /** This version of Boat can't run agents there at all (the row is greyed out). */
  unsupported?: string;
}

/** Why the Mac rows are greyed out: no Mac provider in this version. */
const NO_MACS = "Boat can't run agents on a Mac yet.";

export const PROVIDER_CATALOG: readonly CatalogEntry[] = [
  { id: "boat", label: "boat.dev", kind: "cloud", summary: "Linux", systems: [], apiKey: false },
  {
    id: "instabox",
    label: "Instabox",
    kind: "cloud",
    // No amounts here: prices come only from the provider itself (pricing).
    summary: "Linux microVMs billed per second.",
    systems: [
      { os: "linux", label: "Linux", note: null },
      { os: "macos", label: "Mac", note: null },
      { os: "windows", label: "Windows", note: "not launched yet" },
    ],
    apiKey: true,
  },
  { id: "your-mac", label: "Your Mac", kind: "own-mac", summary: `Agents on your own Mac, enrolled in bb. ${NO_MACS}`, systems: [], apiKey: false, unsupported: NO_MACS },
  {
    id: "monthly-mac",
    label: "Monthly Mac",
    kind: "monthly-mac",
    summary: `A Mac you rent by the month and enroll in bb. ${NO_MACS}`,
    systems: [],
    apiKey: false,
    unsupported: NO_MACS,
  },
];

/** A provider's name as the settings show it ("boat.dev"); one the catalog doesn't know goes by its own. */
export function providerLabel(id: string, provider?: Pick<SandboxProvider, "displayName"> | null): string {
  return PROVIDER_CATALOG.find((entry) => entry.id === id)?.label ?? provider?.displayName ?? id;
}

// ------------------------------------------------------------------ where a task or sandbox runs

/**
 * Where work on this provider runs: boat.dev's machine is its size
 * ("Default"); another provider names the system too ("Linux · Default"),
 * since it may offer more than one.
 */
export function runsOnOf(provider: Pick<SandboxProvider, "id" | "displayName" | "caps">, size: MachineType | null, defaultId: string): RunsOnDto {
  const sizeLabel = size === null ? null : SIZE_SPECS[size].label;
  const system = provider.caps.os === "macos" ? "Mac" : "Linux";
  const machine = provider.id === defaultId ? sizeLabel : [system, sizeLabel].filter(Boolean).join(" · ");
  return { provider: provider.id, label: providerLabel(provider.id, provider), os: provider.caps.os, machine: machine || null, note: null, detail: null };
}

// ------------------------------------------------------------------ Settings › Sandbox providers and Runs on

/** What the view needs from boat.dev's setup reading (null: none yet). */
export type BoatReading = Pick<BoatFacts, "cli" | "account" | "plan"> | null;

/** How each enabled provider other than boat.dev answers (connected, or what's wrong). */
export type Connections = ReadonlyMap<string, SandboxProviderDto["connection"]>;

/** Each enabled provider's prices as it states them (absent: it doesn't say). */
export type Prices = ReadonlyMap<string, string>;

/** The systems a provider can start sandboxes on now (null: the provider isn't here). */
function implementedSystems(provider: SandboxProvider | null): readonly string[] {
  if (provider === null) return [];
  return provider.caps.systems ?? [provider.caps.os];
}

function hoursText(hours: number): string {
  return hours.toLocaleString("en-US", { maximumFractionDigits: hours < 10 ? 1 : 0 });
}

function boatRow(provider: SandboxProvider, reading: BoatReading, isDefault: boolean): SandboxProviderDto {
  const connected = reading?.cli.found === true && reading.account.signedIn === true;
  const plan = reading?.plan ?? null;
  const why = reading === null ? "not checked yet" : !reading.cli.found ? "the boat CLI isn't installed" : reading.account.signedIn === false ? "not signed in" : "couldn't check";
  const summary = connected
    ? ["Linux", plan?.name ? `${plan.name} plan` : null, plan?.vmHoursRemaining != null ? `${hoursText(plan.vmHoursRemaining)} h left this month` : null]
    : ["Linux", why];
  return {
    id: provider.id,
    label: providerLabel(provider.id, provider),
    kind: "cloud",
    isDefault,
    available: true,
    enabled: true,
    connection: connected ? "connected" : "not-connected",
    meta: null,
    summary: summary.filter(Boolean).join(" · "),
    pricing: null,
    systems: [],
    apiKey: null,
    status: null,
  };
}

function catalogRow(entry: CatalogEntry, provider: SandboxProvider | null, connection: SandboxProviderDto["connection"], isDefault: boolean, pricing: string | null): SandboxProviderDto {
  const available = entry.unsupported === undefined;
  const implemented = implementedSystems(provider);
  return {
    id: entry.id,
    label: providerLabel(entry.id, provider),
    kind: entry.kind,
    isDefault,
    available,
    enabled: available && provider !== null,
    connection,
    meta: entry.kind === "monthly-mac" ? "none yet" : null,
    summary: entry.summary,
    pricing,
    // Ready only where this version can start sandboxes; a system the provider is here without says so.
    systems: entry.systems.map((system) => {
      const here = implemented.includes(system.os);
      const note = system.note ?? (provider !== null && !here ? "coming next" : null);
      return { ...system, note, ready: connection === "connected" && here && note === null };
    }),
    // No setting holds the key until the provider is here: the row says so instead of pointing at nothing.
    apiKey: entry.apiKey ? { setting: provider === null ? null : `${entry.label} API key` } : null,
    status: available ? null : "Not available yet",
  };
}

/** Why a provider can't be picked under Runs on (null: it can). */
function pickProblem(row: SandboxProviderDto): string | null {
  if (row.isDefault) return null;
  if (!row.available) return "Not available yet";
  if (row.connection === "key-missing") return "Add its API key first";
  if (!row.enabled || row.connection !== "connected") return "Not connected";
  return null;
}

/** The line under the providers: where work goes first. */
function routingLine(rows: readonly SandboxProviderDto[], defaultLabel: string): string {
  const macs = rows.some((row) => row.kind !== "cloud" && row.available);
  if (macs) return "Mac tasks go to your Mac first, then a monthly Mac, then an Instabox day lease. Boat never rents or cancels anything for you.";
  return `New work runs on ${defaultLabel} unless a project picks another provider below.`;
}

function projectRow(project: BoatProject, registry: ProviderRegistry): ProjectRunsOnDto {
  const provider = project.sandboxProvider ?? registry.default.id;
  const os = registry.get(provider)?.caps.os ?? "linux";
  const repo = project.repos[0]?.repo ?? project.name;
  return { projectId: project.id, name: project.name, detail: `${repo} · ${os === "macos" ? "Mac" : "Linux"}`, provider, chosen: project.sandboxProvider !== undefined };
}

/** Settings › Sandbox providers and Runs on, from the registry, boat.dev's reading and the projects. */
export function providersView(input: {
  registry: ProviderRegistry;
  boat: BoatReading;
  connections?: Connections;
  prices?: Prices;
  projects: readonly BoatProject[];
}): SandboxProvidersResultDto {
  const { registry } = input;
  const defaultId = registry.default.id;
  const seen = new Set<string>();
  const rows: SandboxProviderDto[] = [];
  for (const entry of PROVIDER_CATALOG) {
    seen.add(entry.id);
    const provider = registry.get(entry.id);
    if (entry.id === "boat") {
      if (provider !== null) rows.push(boatRow(provider, input.boat, defaultId === entry.id));
      continue;
    }
    const connection = provider === null ? (entry.apiKey ? "key-missing" : "not-connected") : (input.connections?.get(entry.id) ?? "not-connected");
    rows.push(catalogRow(entry, provider, connection, defaultId === entry.id, input.prices?.get(entry.id) ?? null));
  }
  // A provider the catalog doesn't know yet still gets its row.
  for (const provider of registry.enabled) {
    if (seen.has(provider.id)) continue;
    const entry: CatalogEntry = { id: provider.id, label: provider.displayName, kind: "cloud", summary: provider.caps.os === "macos" ? "Mac" : "Linux", systems: [], apiKey: false };
    rows.push(catalogRow(entry, provider, input.connections?.get(provider.id) ?? "not-connected", defaultId === provider.id, input.prices?.get(provider.id) ?? null));
  }
  rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));

  const options: RunsOnOptionDto[] = rows
    // A monthly Mac is a choice once one is enrolled.
    .filter((row) => row.kind !== "monthly-mac" || (row.available && row.connection === "connected"))
    .map((row) => ({ provider: row.id, label: row.label, disabledReason: pickProblem(row) }));
  const projects = input.projects.map((project) => projectRow(project, registry));
  // A pick this version doesn't know (a backup from a newer one) still shows, greyed out.
  for (const project of projects) {
    if (!options.some((option) => option.provider === project.provider)) options.push({ provider: project.provider, label: providerLabel(project.provider), disabledReason: "Not available in this version" });
  }
  return { providers: rows, routing: routingLine(rows, providerLabel(defaultId, registry.default)), options, projects };
}

// ------------------------------------------------------------------ handlers

/** How long another provider's connection check counts. */
const CONNECTION_TTL_MS = 60_000;

export function providerHandlers(runtime: Runtime) {
  const { service, bb } = runtime;
  let checked: { at: number; connections: Connections; prices: Prices } | null = null;

  /** Ask each enabled provider other than boat.dev for its plan (an answer means connected) and its prices. */
  async function others(): Promise<{ connections: Connections; prices: Prices }> {
    if (checked !== null && Date.now() - checked.at < CONNECTION_TTL_MS) return checked;
    const providers = service.sandboxProviders.enabled.filter((provider) => provider.id !== "boat");
    const results = await Promise.all(
      providers.map(async (provider) => {
        const signal = AbortSignal.timeout(10_000);
        let connection: SandboxProviderDto["connection"];
        try {
          await provider.capacity(signal);
          connection = "connected";
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          connection = code === "key_missing" ? "key-missing" : "not-connected";
        }
        const pricing = connection === "connected" && provider.pricing ? await provider.pricing(signal).catch(() => null) : null;
        return { id: provider.id, connection, pricing };
      }),
    );
    checked = {
      at: Date.now(),
      connections: new Map(results.map((entry) => [entry.id, entry.connection])),
      prices: new Map(results.flatMap((entry) => (entry.pricing ? [[entry.id, entry.pricing] as const] : []))),
    };
    return checked;
  }

  async function view(): Promise<SandboxProvidersResultDto> {
    const reading = runtime.setup ? (runtime.setup.peek()?.facts ?? (await runtime.setup.reading().catch(() => null))) : null;
    const { connections, prices } = await others();
    return providersView({ registry: service.sandboxProviders, boat: reading, connections, prices, projects: runtime.projects.list() });
  }

  return {
    sandboxProviders: () => view(),

    setProjectRunsOn: async ({ projectId, provider }: { projectId: string; provider: string }) => {
      const missing = () => new experimental_PluginRpcRefusal({ code: "not_found", message: `No project "${projectId}".` });
      if (runtime.projects.get(projectId) === null) throw missing();
      const current = await view();
      // The checks above wait on providers: read the project again, so an edit
      // or a deletion made meanwhile stands, and change only its provider.
      const project = runtime.projects.get(projectId);
      if (project === null) throw missing();
      const option = current.options.find((entry) => entry.provider === provider);
      if (option === undefined) throw new experimental_PluginRpcRefusal({ code: "invalid", message: `"${provider}" isn't a sandbox provider Boat knows.` });
      // Moving off a pick that's no longer available is fine; moving onto one isn't.
      if (option.disabledReason !== null && provider !== project.sandboxProvider) {
        throw new experimental_PluginRpcRefusal({ code: "conflict", message: `${option.label} can't take new work: ${option.disabledReason.charAt(0).toLowerCase()}${option.disabledReason.slice(1)}.` });
      }
      const saved = runtime.projects.save({ ...project, sandboxProvider: provider === service.sandboxProviders.default.id ? null : provider });
      runtime.changed();
      bb.rpc.experimental_invalidate([PROVIDERS_TAG]);
      return projectRow(saved, service.sandboxProviders);
    },
  };
}
