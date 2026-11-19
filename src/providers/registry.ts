// Which sandbox provider each piece of work uses. Today there is one,
// boat.dev, the default: every project, task and sandbox gets it. Later the
// settings enable more and a project picks one; a task keeps the provider
// its sandbox is on (tasks.sandbox_provider), so ask for a task's or a
// project's provider rather than taking the default.
import { createBoatProvider, type BoatClient } from "./boat/provider.ts";
import { DEFAULT_PROVIDER_ID, ProviderError, type SandboxProvider } from "./types.ts";

export { DEFAULT_PROVIDER_ID };

export interface ProviderRegistry {
  /** Where new work goes unless its project says otherwise. */
  readonly default: SandboxProvider;
  /** Every enabled provider, the default first. */
  readonly enabled: readonly SandboxProvider[];
  /** An enabled provider by its id (null: none). */
  get(id: string): SandboxProvider | null;
  /**
   * The provider for a project's new work. Projects don't choose one yet (the
   * default); one that names a provider that isn't enabled gets an
   * unavailable provider, never another one's.
   */
  forProject(project?: { sandboxProvider?: string | null } | null): SandboxProvider;
  /**
   * The provider a task's sandbox is on: its record's (older records don't
   * have one: boat.dev). One that isn't enabled (a task another version
   * recorded) gets an unavailable provider: its calls refuse, nothing goes to
   * another provider.
   */
  forTask(task: { sandboxProvider?: string | null }): SandboxProvider;
  /**
   * The provider a sandbox id belongs to, by its shape (none matches: the
   * default). Only for ids no task recorded (typed by the user): a recorded
   * sandbox goes by its task (BoatService.sandboxProvider).
   */
  forSandbox(sandboxId: string): SandboxProvider;
  /** The provider whose bb machine provider this is (null: not a sandbox provider's). */
  forMachine(machineProviderId: string | null | undefined): SandboxProvider | null;
}

export function createProviderRegistry(providers: readonly SandboxProvider[]): ProviderRegistry {
  const first = providers[0];
  if (first === undefined) throw new Error("No sandbox provider is enabled.");
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const get = (id: string): SandboxProvider | null => byId.get(id) ?? null;
  const unavailable = new Map<string, SandboxProvider>();
  const named = (id: string): SandboxProvider => {
    const enabled = get(id);
    if (enabled !== null) return enabled;
    let inert = unavailable.get(id);
    if (inert === undefined) unavailable.set(id, (inert = unavailableProvider(id)));
    return inert;
  };
  return {
    default: first,
    enabled: providers,
    get,
    forProject: (project) => (project?.sandboxProvider == null ? first : named(project.sandboxProvider)),
    forTask: (task) => named(task.sandboxProvider ?? DEFAULT_PROVIDER_ID),
    forSandbox: (sandboxId) => providers.find((provider) => provider.idPattern.test(sandboxId)) ?? first,
    forMachine: (machineProviderId) =>
      machineProviderId ? (providers.find((provider) => provider.machine?.id === machineProviderId) ?? null) : null,
  };
}

/**
 * A provider this plugin doesn't have enabled (a task another version
 * recorded on it): every call refuses with code provider_unavailable, so
 * nothing is sent to another provider and nothing reads as gone. Its plain
 * members are inert.
 */
export function unavailableProvider(id: string): SandboxProvider {
  const refuse = (): Promise<never> =>
    Promise.reject(new ProviderError(`This sandbox is on "${id}", a sandbox provider that isn't enabled.`, { code: "provider_unavailable" }));
  return {
    id,
    displayName: id,
    caps: {
      os: "linux",
      shell: "bash",
      homeDir: "",
      execMaxSeconds: 0,
      stopKeepsDisk: false,
      retentionAfterStopSeconds: null,
      autoStop: null,
      agentBusyState: false,
      previews: "token-link",
      bbEnrollment: false,
      concurrencyUnit: "sandboxes",
      environments: false,
    },
    // Claims no sandbox id.
    idPattern: /(?!)/,
    sizes: [],
    capacity: refuse,
    usagePlan: refuse,
    usage: refuse,
    list: refuse,
    info: refuse,
    findInfo: refuse,
    create: refuse,
    delete: refuse,
    stop: refuse,
    stopStatus: refuse,
    fork: refuse,
    lastSnapshotAt: refuse,
    resume: refuse,
    extend: refuse,
    exec: refuse,
    execDetached: refuse,
    processes: refuse,
    host: refuse,
    snapshot: refuse,
    snapshots: refuse,
    environments: refuse,
    defaultEnvironment: refuse,
    environmentInfo: refuse,
    aiProxy: refuse,
    prompt: refuse,
    conversations: refuse,
    events: refuse,
    steer: refuse,
    interrupt: refuse,
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
