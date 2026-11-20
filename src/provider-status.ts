// Every sandbox provider's state for `bb boat providers`: on or off, a key
// stored or not (never the key), ready or what to fix, and which projects
// run there. boat.dev's state is its setup checks; Instabox's its own
// (src/providers/instabox/setup.ts). The page's view is src/rpc-providers.ts.
import type { ProviderRegistry } from "./providers/registry.ts";
import { DEFAULT_PROVIDER_ID, type SandboxProvider } from "./providers/types.ts";
import type { CheckState, SetupCheck, SetupStatus } from "./providers/boat/setup.ts";
import type { InstaboxCheck, InstaboxSetup } from "./providers/instabox/setup.ts";

/** One provider's state, as the CLI shows it. */
export interface ProviderState {
  id: string;
  displayName: string;
  isDefault: boolean;
  /** The owner turned it on (boat.dev always is). */
  turnedOn: boolean;
  /** Work can go there now: turned on and its key stored. */
  enabled: boolean;
  /** A key is stored in bb's secret settings (never the key); null: it needs none. */
  keyPresent: boolean | null;
  status: "ready" | "setup-required" | "off" | "unknown";
  problem: string | null;
  os: "linux" | "macos";
  machineProviderId: string | null;
  projectIds: string[];
  orphans?: { id: string; name: string }[];
  checks: { id: string; label: string; state: CheckState; required: boolean; detail: string; fix: { text: string; command: string | null } | null }[];
}

export interface ProviderStatusDeps {
  registry: ProviderRegistry;
  projects(): readonly { id: string; sandboxProvider?: string | null }[];
  /** bb machine providers registered at this load. */
  machines(): ReadonlySet<string>;
  /** boat.dev's setup checks (null: not wired, e.g. in tests). */
  boatSetup: { status(options: { force?: boolean }): Promise<SetupStatus> } | null;
  instabox: { setup: Pick<InstaboxSetup, "status">; keyPresent(): boolean } | null;
}

function check(entry: SetupCheck | InstaboxCheck): ProviderState["checks"][number] {
  return { id: entry.id, label: entry.label, state: entry.state, required: entry.required, detail: entry.detail, fix: entry.fix ? { text: entry.fix.text, command: entry.fix.command ?? null } : null };
}

/** Each provider the plugin has (the default first), with its state; a check that fails reads "unknown", never throws. */
export async function providerStates(deps: ProviderStatusDeps, options: { force?: boolean } = {}): Promise<ProviderState[]> {
  const enabled = new Set(deps.registry.enabled.map((provider) => provider.id));
  const projects = deps.projects();
  const machines = deps.machines();
  const base = (provider: SandboxProvider) => ({
    id: provider.id,
    displayName: provider.displayName,
    isDefault: provider === deps.registry.default,
    enabled: enabled.has(provider.id),
    os: provider.caps.os,
    machineProviderId: provider.machine !== undefined && machines.has(provider.machine.id) ? provider.machine.id : null,
    projectIds: projects.filter((project) => (project.sandboxProvider || DEFAULT_PROVIDER_ID) === provider.id).map((project) => project.id),
  });
  return Promise.all(
    deps.registry.all.map(async (provider): Promise<ProviderState> => {
      if (provider.id === DEFAULT_PROVIDER_ID) {
        const status = await deps.boatSetup?.status({ force: options.force }).catch(() => null);
        return {
          ...base(provider),
          turnedOn: true,
          keyPresent: null,
          status: status === null || status === undefined ? "unknown" : status.ok ? "ready" : "setup-required",
          problem: status && !status.ok ? status.summary : null,
          checks: status ? status.checks.map(check) : [],
        };
      }
      if (provider.id === "instabox" && deps.instabox !== null) {
        const status = await deps.instabox.setup.status({ force: options.force }).catch(() => null);
        const failing = status?.checks.find((entry) => entry.required && entry.state !== "ok") ?? null;
        return {
          ...base(provider),
          turnedOn: status?.turnedOn ?? false,
          keyPresent: deps.instabox.keyPresent(),
          status: status === null ? "unknown" : !status.turnedOn ? "off" : status.ok ? "ready" : failing?.state === "unknown" ? "unknown" : "setup-required",
          problem: failing === null ? null : `${failing.label}: ${failing.detail}${failing.fix ? `. ${failing.fix.text}` : ""}`,
          checks: status?.checks.map(check) ?? [],
        };
      }
      if (provider.id === "scaleway" && !enabled.has(provider.id) && !(await provider.configured?.())) {
        return {...base(provider),turnedOn:false,keyPresent:null,status:"off",problem:null,checks:[]};
      }
      if (provider.id === "scaleway" && provider.presentation) {
        const presentation = await provider.presentation().catch(() => null);
        const missing = presentation?.steps.find(step=>step.possible && step.required !== false && !step.done);
        const orphans = presentation?.steps.find(step=>step.id==="project")?.done ? await provider.orphans?.(AbortSignal.timeout(10_000)).catch(()=>undefined) : undefined;
        return {...base(provider),orphans,turnedOn:presentation?.steps.find(step=>step.id==="project")?.done ?? false,keyPresent:null,status:presentation && !missing ? "ready" : "setup-required",checks:[],problem:missing?.detail ?? (presentation ? null : "Could not check machine credentials.")};
      }
      if (enabled.has(provider.id) && provider.orphans) {
        try {
          const orphans = await provider.orphans(AbortSignal.timeout(10_000));
          return { ...base(provider), turnedOn: true, keyPresent: null, status: provider.id === "scaleway" ? "setup-required" : "ready", checks: [], orphans,
            problem: provider.id === "scaleway" ? "Held Macs only; logins on fresh Macs are not possible yet." : orphans.length ? `${orphans.length} orphan server(s) have no local ownership record. They are not managed; inspect them in the provider console.` : null };
        } catch (error) {
          return { ...base(provider), turnedOn: true, keyPresent: null, status: "unknown", problem: provider.id === "scaleway" ? ((error as {code?:string}).code === "key_missing" ? "Add the Scaleway secret key in bb secrets." : (error as {code?:string}).code === "provider_unavailable" ? "Set a valid Scaleway project ID and Paris zone in Harbormaster settings." : "Check the Scaleway secret key and project access.") : "Could not check provider ownership records.", checks: [] };
        }
      }
      return { ...base(provider), turnedOn: false, keyPresent: null, status: "off", problem: null, checks: [] };
    }),
  );
}
