// Which sandbox provider each piece of work uses. boat.dev is the default
// and always enabled; another (Instabox) is enabled while the owner has it
// turned on and its key stored (`isEnabled`, read on every call, so a
// settings change applies at once). A project picks one ("runs on"); a task
// keeps the provider its sandbox is on (tasks.sandbox_provider), so ask for a
// task's or a project's provider rather than taking the default.
import { createBoatProvider, type BoatClient } from "./boat/provider.ts";
import { DEFAULT_PROVIDER_ID, PROVIDER_NAMES, ProviderError, type SandboxProvider } from "./types.ts";

export { DEFAULT_PROVIDER_ID };

export interface ProviderRegistry {
  /** Where new work goes unless its project says otherwise. */
  readonly default: SandboxProvider;
  /** Every enabled provider, the default first. */
  readonly enabled: readonly SandboxProvider[];
  /** Every provider the plugin has, enabled or not (the settings list them). */
  readonly all: readonly SandboxProvider[];
  /** An enabled provider by its id (null: none). */
  get(id: string): SandboxProvider | null;
  /**
   * The provider for a project's new work: the one it runs on (none: the
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

/**
 * `providers`: the default first. `isEnabled`: whether one of the others is
 * enabled right now (absent: all of them are); the default always is.
 */
export function createProviderRegistry(providers: readonly SandboxProvider[], options: { isEnabled?: (provider: SandboxProvider) => boolean } = {}): ProviderRegistry {
  const first = providers[0];
  if (first === undefined) throw new Error("No sandbox provider is enabled.");
  const on = (provider: SandboxProvider) => provider === first || (options.isEnabled?.(provider) ?? true);
  const enabled = () => providers.filter(on);
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const get = (id: string): SandboxProvider | null => {
    const provider = byId.get(id);
    return provider !== undefined && on(provider) ? provider : null;
  };
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
    get enabled() {
      return enabled();
    },
    all: providers,
    get,
    forProject: (project) => (project?.sandboxProvider == null ? first : named(project.sandboxProvider)),
    forTask: (task) => named(task.sandboxProvider ?? DEFAULT_PROVIDER_ID),
    // An id of a provider that isn't enabled (an Instabox m_… while it's off) fails closed, never goes to boat.dev.
    forSandbox: (sandboxId) => {
      const owner = providers.find((provider) => provider.idPattern.test(sandboxId));
      return owner === undefined ? first : named(owner.id);
    },
    forMachine: (machineProviderId) =>
      machineProviderId ? (enabled().find((provider) => provider.machine?.id === machineProviderId) ?? null) : null,
  };
}

/**
 * A provider this plugin doesn't have enabled (a task another version
 * recorded on it): every call refuses with code provider_unavailable, so
 * nothing is sent to another provider and nothing reads as gone. Its plain
 * members are inert.
 */
export function unavailableProvider(id: string): SandboxProvider {
  const name = (PROVIDER_NAMES as Record<string, string>)[id] ?? id;
  const refuse = (): Promise<never> =>
    Promise.reject(new ProviderError(`This sandbox is on ${name === id ? `"${id}"` : name}, a sandbox provider that isn't enabled.`, { code: "provider_unavailable" }));
  return {
    id,
    displayName: name,
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
