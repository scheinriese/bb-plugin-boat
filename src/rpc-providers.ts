import { monthlyMacPrices } from "./monthly-macs.ts";
import { MONTHLY_MACS_TAG } from "../contract-monthly-macs.ts";
import { usageWindows } from "./usage.ts";
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
  type MacUsageDto,
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
const NO_MACS = "Harbormaster can't run agents on a Mac yet.";

export const PROVIDER_CATALOG: readonly CatalogEntry[] = [
  { id: "boat", label: "boat.dev", kind: "cloud", summary: "Linux", systems: [], apiKey: false },
  {
    id: "instabox",
    label: "Instabox",
    kind: "cloud",
    // No amounts here: prices come only from the provider itself (pricing).
    summary: "Linux microVMs billed per second. Macs: 24 h minimum, then per second.",
    systems: [
      { os: "linux", label: "Linux", note: null },
      { os: "macos", label: "Mac", note: null },
      { os: "windows", label: "Windows", note: "not launched yet" },
    ],
    apiKey: true,
  },
  { id: "scaleway", label: "Scaleway", kind: "cloud", summary: "Whole Mac minis. 24 h minimum, then hourly. Prices in EUR.", systems: [{ os: "macos", label: "Mac", note: null }], apiKey: true },
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

/** Whether a key is stored in bb's secrets, for providers that sign in with one (absent: not known). */
export type Keys = ReadonlyMap<string, boolean>;

/** The systems a provider can start sandboxes on now (null: the provider isn't here). */
function implementedSystems(provider: SandboxProvider | null): readonly string[] {
  if (provider === null) return [];
  return provider.caps.systems ?? [provider.caps.os];
}

function hoursText(hours: number): string {
  return hours.toLocaleString("en-US", { maximumFractionDigits: hours < 100 ? 1 : 0 });
}

function boatRow(provider: SandboxProvider, reading: BoatReading, isDefault: boolean): SandboxProviderDto {
  const connected = reading?.cli.found === true && reading.account.signedIn === true;
  const plan = reading?.plan ?? null;
  const why = reading === null ? "not checked yet" : !reading.cli.found ? "the boat CLI isn't installed" : reading.account.signedIn === false ? "not signed in" : "couldn't check";
  const summary = connected
    ? ["Linux", plan?.name ? `${plan.name} plan` : null, plan?.vmHoursRemaining != null ? `${hoursText(plan.vmHoursRemaining)} h left` : null]
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

/**
 * `provider`: enabled (it can take work); `here`: this version has it, on or
 * off (its systems and its key's setting are known even while it's off).
 */
function catalogRow(entry: CatalogEntry, provider: SandboxProvider | null, connection: SandboxProviderDto["connection"], isDefault: boolean, pricing: string | null, here: SandboxProvider | null = provider): SandboxProviderDto {
  const available = entry.unsupported === undefined;
  const implemented = implementedSystems(here);
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
      const offered = implemented.includes(system.os);
      const note = system.note ?? (here !== null && !offered ? "coming next" : null);
      return { ...system, note, ready: connection === "connected" && provider !== null && offered && note === null };
    }),
    // No setting holds the key until this version has the provider: the row says so instead of pointing at nothing.
    apiKey: entry.apiKey ? { setting: here === null ? null : entry.id === "scaleway" ? "Scaleway secret key" : `${entry.label} API key` } : null,
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
  if (macs) return "Mac tasks go to your Mac first, then a monthly Mac, then an enabled Mac day-lease provider. Harbormaster rents only for dispatched tasks.";
  return `New work runs on ${defaultLabel} unless a project picks another provider below.`;
}

function projectRow(project: BoatProject, registry: ProviderRegistry): ProjectRunsOnDto {
  const provider = project.sandboxProvider ?? registry.default.id;
  const os = project.sandboxSystem ?? registry.get(provider)?.caps.os ?? "linux";
  const repo = project.repos[0]?.repo ?? project.name;
  return { projectId: project.id, name: project.name, detail: `${repo} · ${os === "macos" ? "Mac" : "Linux"}`, provider: os === "macos" ? `${provider}-macos` : provider, chosen: project.sandboxProvider !== undefined };
}

/** Settings › Sandbox providers and Runs on, from the registry, boat.dev's reading and the projects. */
export function providersView(input: {
  registry: ProviderRegistry;
  boat: BoatReading;
  connections?: Connections;
  prices?: Prices;
  keys?: Keys;
  macReady?: ReadonlySet<string>;
  statuses?: ReadonlyMap<string, string>;
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
    // Here but off: with its key stored it's only turned off ("not-connected"); without, the key is what's missing.
    const here = registry.all.find((candidate) => candidate.id === entry.id) ?? null;
    const connection =
      provider === null ? (entry.apiKey && input.keys?.get(entry.id) !== true ? "key-missing" : "not-connected") : (input.connections?.get(entry.id) ?? "not-connected");
    rows.push(catalogRow(entry, provider, connection, defaultId === entry.id, input.prices?.get(entry.id) ?? null, here));
  }
  // A provider the catalog doesn't know yet still gets its row.
  for (const provider of registry.enabled) {
    if (seen.has(provider.id)) continue;
    const entry: CatalogEntry = { id: provider.id, label: provider.displayName, kind: "cloud", summary: provider.caps.os === "macos" ? "Mac" : "Linux", systems: [], apiKey: false };
    rows.push(catalogRow(entry, provider, input.connections?.get(provider.id) ?? "not-connected", defaultId === provider.id, input.prices?.get(provider.id) ?? null));
  }
  rows.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  for (const row of rows) row.status = input.statuses?.get(row.id) ?? row.status;

  const options: RunsOnOptionDto[] = rows
    // A monthly Mac is a choice once one is enrolled.
    .filter((row) => row.kind !== "monthly-mac" || (row.available && row.connection === "connected"))
    .map((row) => { const macOnly=registry.all.find(provider=>provider.id===row.id)?.caps.os==="macos"; return {provider:macOnly?`${row.id}-macos`:row.id,label:macOnly?`${row.label} · Mac`:row.label,disabledReason:pickProblem(row)}; });
  for (const provider of registry.enabled) {
    const row = rows.find(row => row.id === provider.id);
    const ready = input.macReady?.has(provider.id) ?? (provider.caps.systems ?? [provider.caps.os]).includes("macos");
    if (row?.available && row.connection === "connected" && ready && !options.some(option=>option.provider===`${provider.id}-macos`)) options.push({ provider: `${provider.id}-macos`, label: `${providerLabel(provider.id,provider)} · Mac`, disabledReason: null });
  }
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

export function providerHandlers(runtime: Runtime, now = Date.now) {
  const { service, bb } = runtime;
  let generation = 0;
  let checked: { at: number; connections: Connections; prices: Prices; macReady: ReadonlySet<string>; statuses: ReadonlyMap<string,string> } | null = null;

  /** Ask each enabled provider other than boat.dev for its plan (an answer means connected) and its prices. */
  async function others(): Promise<{ connections: Connections; prices: Prices; macReady: ReadonlySet<string>; statuses: ReadonlyMap<string,string> }> {
    if (checked !== null && now() - checked.at < CONNECTION_TTL_MS) return checked;
    const readGeneration = generation;
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
        const macReady = connection === "connected" && (provider.macModels ? (await provider.macModels(signal).catch(() => [])).length > 0 : (provider.caps.systems ?? [provider.caps.os]).includes("macos"));
        const orphans = connection === "connected" && provider.orphans ? await provider.orphans(signal).catch(() => null) : [];
        const status = orphans === null ? "Orphan check unavailable" : orphans.length ? `${orphans.length} orphan server(s) · not managed; inspect with bb boat providers` : null;
        return { id: provider.id, connection, pricing, macReady, status };
      }),
    );
    const result = {
      at: now(),
      macReady: new Set(results.filter(entry=>entry.macReady).map(entry=>entry.id)),
      connections: new Map(results.map((entry) => [entry.id, entry.connection])),
      prices: new Map(results.flatMap((entry) => (entry.pricing ? [[entry.id, entry.pricing] as const] : []))),
      statuses: new Map(results.flatMap(entry=>entry.status ? [[entry.id,entry.status] as const] : [])),
    };
    if (generation === readGeneration) checked = result;
    return result;
  }

  async function readPresentation(force = false): Promise<SandboxProvidersResultDto> {
    const reading = runtime.setup ? (runtime.setup.peek()?.facts ?? (await runtime.setup.reading().catch(() => null))) : null;
    if (force) checked = null;
    const { connections, prices, macReady, statuses } = await others();
    const keys = new Map(service.sandboxProviders.all.flatMap((provider) => {
      const stored = runtime.providers?.keyPresent(provider.id) ?? null;
      return stored === null ? [] : [[provider.id, stored] as const];
    }));
    const result = providersView({ registry: service.sandboxProviders, boat: reading, connections, prices, keys, macReady, statuses, projects: runtime.projects.list() });
    const boatPlan=reading ? await Promise.resolve().then(()=>service.sandboxProviders.default.usagePlan(AbortSignal.timeout(10_000))).catch(()=>null) : null;
    const boatRow=result.providers.find(row=>row.id==="boat");
    if(boatRow && boatPlan)boatRow.summary=["Linux",boatPlan.name ? `${boatPlan.name} plan` : null,boatPlan.hoursRemaining===null ? null : `${hoursText(boatPlan.hoursRemaining)} h left`,boatPlan.resetsAt ? `resets ${new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",timeZone:"UTC"}).format(new Date(boatPlan.resetsAt))}` : null].filter(Boolean).join(" · ");
    await Promise.all(result.providers.map(async row => {
      const provider = service.sandboxProviders.all.find(p => p.id === row.id);
      if (!provider?.presentation) return;
      const metadata = await provider.presentation({force, signal: AbortSignal.timeout(15_000)}).catch(() => null);
      if (metadata) Object.assign(row, metadata);
      if (row.steps) {
        const required = row.steps.filter(s => s.possible && s.required !== false);
        const complete = required.every(s => s.done);
        const setup = `Setting up · ${required.filter(s => s.done).length} of ${required.length}`;
        // Scaleway's orphan warning remains visible; Instabox keeps its existing copy.
        row.status = row.id === "scaleway" ? (complete ? (row.status ?? "Connected") : [row.status, setup].filter(Boolean).join(" · ")) : complete ? "Connected" : setup;
      }
    }));
    return result;
  }

  // One shared promise includes plan, usage, lists and Secret metadata. Project
  // choices and waiting counts are cheap local reads and stay current.
  let presentation: { at: number; value: Promise<SandboxProvidersResultDto> } | null = null;
  // Settings may change through bb or the CLI while this presentation is warm.
  // Drop both promises and connection facts; an old in-flight read cannot win.
  const clearPresentation = () => { generation++; presentation = null; checked = null; };
  runtime.settings?.onChange?.(clearPresentation);
  runtime.providers?.onChange?.(clearPresentation);
  let configuration = "";
  async function view(force = false): Promise<SandboxProvidersResultDto> {
    const current = JSON.stringify([service.sandboxProviders.enabled.map(p=>p.id),service.sandboxProviders.all.map(p=>[p.id,runtime.providers?.keyPresent(p.id)])]);
    if (current !== configuration) { configuration=current; clearPresentation(); }
    if (force || !presentation || now() - presentation.at >= CONNECTION_TTL_MS) {
      const value = readPresentation(force);
      presentation = { at: now(), value };
      value.catch(() => { if (presentation?.value === value) presentation = null; });
    }
    const result = await presentation.value;
    const waiting = result.providers.some(row => row.steps) ? service.store.list({ statuses: ["failed"], limit: 500 }) : [];
    return {
      ...result,
      projects: runtime.projects.list().map(project => projectRow(project, service.sandboxProviders)),
      providers: result.providers.map(row => ({
        ...row,
        ...(service.sandboxProviders.all.find(provider => provider.id === row.id)?.releaseNotice?.() ? { releaseNotice: service.sandboxProviders.all.find(provider => provider.id === row.id)!.releaseNotice!()!, status: "Credential action required" } : {}),
        ...(row.steps ? { waitingTasks: waiting.filter(task => task.sandboxProvider === row.id && /GitHub|API key|setup|credentials|Account Pooler/i.test(task.error ?? "")).length } : {}),
      })),
    };
  }

  return {
    monthlyMacSuggestions: () => ({ suggestions: service.store.monthlyMacs.active() }),
    monthlyMacSuggestion: ({id}: {id:string}) => ({ suggestion: service.store.monthlyMacs.get(id) }),
    answerMonthlyMacSuggestion: ({id,answer}: {id:string;answer:"rent"|"keep"|"own"|"cancel"}) => {
      try {
        const suggestion = service.store.monthlyMacs.answer(id,answer,now());
        bb.rpc.experimental_invalidate([MONTHLY_MACS_TAG]);
        return {suggestion};
      } catch (error) { throw new experimental_PluginRpcRefusal({code:"invalid",message:error instanceof Error ? error.message : "Could not save this choice."}); }
    },
    sandboxProviders: () => view(),
    checkSandboxProviders: async () => {
      const result = await view(true);
      bb.rpc.experimental_invalidate([PROVIDERS_TAG]);
      return result;
    },
    macUsage: async (input?: {timezoneOffsetMinutes:number}|null) => {
      const prices = monthlyMacPrices((await runtime.settings?.get?.())?.monthlyMacPricesJson ?? "");
      const summary = service.store.macLeases.summary();
      const now = Date.now(), date = new Date(now);
      const monthStart = Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1), monthEnd = Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1);
      const label = (id: string) => providerLabel(id, service.sandboxProviders.all.find(provider=>provider.id===id));
      const notices: NonNullable<MacUsageDto["notices"]> = [...summary.held.flatMap(lease=>lease.noticeText && lease.noticeAt ? [{id:lease.id,provider:lease.provider,label:label(lease.provider),machineId:lease.machineId,at:lease.noticeAt,text:lease.noticeText}] : []), ...service.store.macLeases.credentialNotices().map(notice=>({...notice,label:label(notice.provider),tokenRevocation:true}))];
      return { ...summary,
        monthlySuggestions: service.store.monthlyMacs.active(),
        monthlyComparisons: service.store.monthlyMacs.comparisons(prices, now),
        byProvider: summary.providers.map(id => ({id,label:label(id),month:service.store.macLeases.between(monthStart,monthEnd,now,undefined,id),rolling30:service.store.macLeases.between(now-30*86400000,now,now,undefined,id)})),
        today: service.store.macLeases.between(Date.parse(usageWindows(date,input?.timezoneOffsetMinutes ?? 0).day.since),now,now).costs,
        providers: summary.providers.map(id=>({id,label:label(id)})),
        notices };
    },

    setProjectRunsOn: async ({ projectId, provider }: { projectId: string; provider: string }) => {
      const missing = () => new experimental_PluginRpcRefusal({ code: "not_found", message: `No project "${projectId}".` });
      if (runtime.projects.get(projectId) === null) throw missing();
      const current = await view();
      // The checks above wait on providers: read the project again, so an edit
      // or a deletion made meanwhile stands, and change only its provider.
      const project = runtime.projects.get(projectId);
      if (project === null) throw missing();
      const option = current.options.find((entry) => entry.provider === provider);
      if (option === undefined) throw new experimental_PluginRpcRefusal({ code: "invalid", message: `"${provider}" isn't a sandbox provider Harbormaster knows.` });
      // Moving off a pick that's no longer available is fine; moving onto one isn't.
      if (option.disabledReason !== null && provider !== projectRow(project,service.sandboxProviders).provider) {
        throw new experimental_PluginRpcRefusal({ code: "conflict", message: `${option.label} can't take new work: ${option.disabledReason.charAt(0).toLowerCase()}${option.disabledReason.slice(1)}.` });
      }
      const macProvider = service.sandboxProviders.all.find(candidate => `${candidate.id}-macos` === provider || (candidate.id === provider && candidate.caps.os === "macos"));
      const providerId = macProvider?.id ?? provider;
      const saved = runtime.projects.save({ ...project, sandboxProvider: providerId === service.sandboxProviders.default.id ? null : providerId, sandboxSystem: macProvider ? "macos" : "linux" });
      runtime.changed();
      bb.rpc.experimental_invalidate([PROVIDERS_TAG]);
      return projectRow(saved, service.sandboxProviders);
    },
  };
}
