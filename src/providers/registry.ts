// Which sandbox provider each piece of work uses. Today there is one,
// boat.dev, the default: every project, task and sandbox gets it. Later the
// settings enable more and a project picks one; a task keeps the provider
// its sandbox is on (tasks.sandbox_provider), so ask for a task's or a
// project's provider rather than taking the default.
import { createBoatProvider, type BoatClient } from "./boat/provider.ts";
import { DEFAULT_PROVIDER_ID, type SandboxProvider } from "./types.ts";

export { DEFAULT_PROVIDER_ID };

export interface ProviderRegistry {
  /** Where new work goes unless its project says otherwise. */
  readonly default: SandboxProvider;
  /** Every enabled provider, the default first. */
  readonly enabled: readonly SandboxProvider[];
  /** An enabled provider by its id (null: none). */
  get(id: string): SandboxProvider | null;
  /** The provider for a project's new work (projects don't choose yet: the default). */
  forProject(project?: { sandboxProvider?: string | null } | null): SandboxProvider;
  /**
   * The provider a task's sandbox is on: its record's, which older records
   * don't have (boat.dev). One that's no longer enabled: the default.
   */
  forTask(task: { sandboxProvider?: string | null }): SandboxProvider;
  /** The provider a sandbox id belongs to, by its shape (none matches: the default). */
  forSandbox(sandboxId: string): SandboxProvider;
  /** The provider whose bb machine provider this is (null: not a sandbox provider's). */
  forMachine(machineProviderId: string | null | undefined): SandboxProvider | null;
}

export function createProviderRegistry(providers: readonly SandboxProvider[]): ProviderRegistry {
  const first = providers[0];
  if (first === undefined) throw new Error("No sandbox provider is enabled.");
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const get = (id: string): SandboxProvider | null => byId.get(id) ?? null;
  return {
    default: first,
    enabled: providers,
    get,
    forProject: (project) => (project?.sandboxProvider ? get(project.sandboxProvider) : null) ?? first,
    forTask: (task) => get(task.sandboxProvider ?? DEFAULT_PROVIDER_ID) ?? first,
    forSandbox: (sandboxId) => providers.find((provider) => provider.idPattern.test(sandboxId)) ?? first,
    forMachine: (machineProviderId) =>
      machineProviderId ? (providers.find((provider) => provider.machine?.id === machineProviderId) ?? null) : null,
  };
}

/** A registry, or the boat client alone: the plugin's BoatApi on its boat CLI, or a test's stand-in for it. */
export type ProviderSource = ProviderRegistry | BoatClient;

function isRegistry(value: ProviderSource): value is ProviderRegistry {
  return "forTask" in value && typeof value.forTask === "function";
}

/** The plugin's providers: a registry as it is, or boat.dev alone around a boat client. */
export function providerRegistry(source: ProviderSource): ProviderRegistry {
  return isRegistry(source) ? source : createProviderRegistry([createBoatProvider(source)]);
}
