import { validateLocalProjectLink } from "./project-catalog.ts";
// Shared plumbing for the CLI, agent tools and RPC handlers.
import { posix } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { findLocalProject, localToOrchestratorProject } from "./local-projects.ts";
import {
  PERSONAL_PROJECT_ID,
  getOrchestratorFlag,
  getOrchestratorPicks,
  getThreadProject,
  setOrchestrator as writeOrchestratorFlag,
  spawnOrchestrator as spawnThread,
  takeOverSection,
  type TakeOver,
} from "./orchestrator.ts";
import type { RepoFileReader } from "./github.ts";
import {
  CHAT_PROVIDER_ID,
  orchestratorAgentChoice,
  orchestratorPicks,
  parseOrchestratorPicks,
  type OrchestratorAgentChoice,
  type OrchestratorPicks,
} from "./orchestrator-agent.ts";
import { toOrchestratorProject, type OrchestratorProject, type ProjectStore } from "./projects.ts";
import { ensureProjectSection, threadSection } from "./sections.ts";
import type { QuotaReader, Quotas } from "./quota.ts";
import type { ConnectCheck, ConnectStatus } from "./connect.ts";
import type { ConfigDeps } from "./config.ts";
import type { SettingsStore } from "./settings-store.ts";
import { MACHINE_PROVIDER_ID } from "./machine.ts";
import type { Setup } from "./setup.ts";
import {
  AGENT_NAME,
  COOLDOWN_MS,
  decideRelay,
  effectiveRelay,
  handoffRequest,
  onlyAgent,
  isBusy,
  retryDelay,
  type OrchestratorView,
  type RelayDecision,
  type RelayState,
} from "./relay.ts";
import type { Provider, Task } from "./store.ts";
import { composeProtocol, loadProjectRules, renderSharedProtocol, type ProtocolStore } from "./protocol.ts";
import { DEFAULT_TIERS, parseTierMap, type TierMap } from "./tiers.ts";
import { TaskError, type BoatService } from "./service.ts";
import { OPEN_STATUSES } from "./store.ts";
import { changedApprovalReason, changedSinceApproval } from "./ship-approval.ts";
import { WATCHDOG_PREFIX } from "./format.ts";

/** How a caller names a project: a configured one, or a local bb project. */
export type ProjectRef = { kind: "boat"; id: string } | { kind: "local"; bbProjectId: string };

/** Parse "web" or "local:proj_123" (CLI and tool input). */
export function parseProjectRef(text: string): ProjectRef {
  const trimmed = text.trim();
  return trimmed.startsWith("local:") ? { kind: "local", bbProjectId: trimmed.slice(6) } : { kind: "boat", id: trimmed };
}

export interface StartOrchestratorInput {
  project: ProjectRef;
  prompt: string;
  title?: string | null;
  hostId?: string | null;
  /** Run in a new boat sandbox. Unset: there when bb Connect is set up, else on this machine. */
  cloud?: boolean;
  /** bb project the chat lives in (default: personal). */
  bbProjectId?: string | null;
  /** Agent, model and effort; unset: Agent and Effort for orchestrators, and the Build preset's model (src/orchestrator-agent.ts). */
  providerId?: string | null;
  model?: string | null;
  effort?: string | null;
  takeOver?: TakeOver | null;
}

export interface Runtime {
  bb: BbPluginApi;
  service: BoatService;
  projects: ProjectStore;
  protocol: ProtocolStore;
  /** The tier table (custom, else the defaults). */
  modelTiers(): Promise<{ tiers: TierMap; custom: boolean }>;
  saveModelTiers(tiers: TierMap | null): Promise<void>;
  /** The shared protocol plus the project's rules file, for an orchestrator. */
  orchestratorProtocol(project: OrchestratorProject | null, signal?: AbortSignal): Promise<string>;
  /** How long CLI/tool calls wait for a dispatch before returning "starting". */
  launchWaitMs: number;
  readInvokerFile(ctx: { threadId?: string; cwd?: string }, path: string): Promise<string>;
  isOrchestrator(threadId: string): Promise<boolean>;
  setOrchestrator(threadId: string, on: boolean, project?: OrchestratorProject | null): Promise<void>;
  /** Resolve a project choice; local projects must have their branch on GitHub. */
  resolveProject(ref: ProjectRef): Promise<OrchestratorProject>;
  /** The project a thread works on (orchestrator metadata), refreshed from settings. */
  projectForThread(threadId: string | undefined | null): Promise<OrchestratorProject | null>;
  /** `note`: why it runs on this computer when it could have run in the cloud (bb Connect). */
  startOrchestrator(
    input: StartOrchestratorInput,
  ): Promise<{ threadId: string; movedTaskIds: string[]; cloud: boolean; note: string | null; agent: OrchestratorAgentChoice }>;
  /** One pass of the relay over every orchestrator; returns what it did. */
  relayTick(): Promise<RelayAction[]>;
  /** Hand an orchestrator to another agent now (asks for a note first unless immediate). */
  relaySwitch(threadId: string, to: Provider, options?: { immediate?: boolean; reason?: string }): Promise<RelayAction>;
  /**
   * Did the user write in this orchestrator chat after the task's work was
   * reported? (A ship from chat needs it: an agent saying "approved" isn't
   * enough, and worker output can't produce a user message.) `discard`:
   * throwing unshipped work away; a ship's refusal says when a newer turn
   * needs a new OK.
   */
  chatApproval(threadId: string | null | undefined, task: Task, action?: "ship" | "discard"): Promise<{ ok: boolean; reason: string }>;
  /** Tell an orchestrator something (a ship from the overview, …). */
  tellOrchestrator(threadId: string, text: string): Promise<void>;
  /** A chat in a hand-over: worker notices wait for its successor. */
  isHandingOver(threadId: string): Promise<boolean>;
  /** bb's thread.idle for any chat: the relay keeps a requested handoff note. */
  relayIdle(threadId: string, text: string | null, at: number | null): Promise<void>;
  /** Usage per agent and what the relay would do for each orchestrator. */
  relayStatus(): Promise<{ quotas: Quotas; orchestrators: { threadId: string; title: string | null; provider: Provider | null; decision: RelayDecision; state: RelayState | null }[] }>;
  /** bb Connect's status (cloud orchestrators and worker chats need it). */
  connectStatus(): Promise<ConnectStatus>;
  /** The setup checks (null in tests that don't wire them). */
  setup: Setup | null;
  /** Every setting, wherever it lives (bb's list or the plugin's own). */
  settings: SettingsStore;
  /** Back up and restore: settings, projects, tiers and protocol (src/config.ts). */
  config: ConfigDeps;
  /** Write a file on the machine a CLI call came from. */
  writeInvokerFile(ctx: { threadId?: string; cwd?: string }, path: string, content: string): Promise<string>;
  /** Tell open UIs to refetch. */
  changed(): void;
  /** Nudge the monitor to check boat soon. */
  wake(): void;
}

export type RelayAction =
  | { threadId: string; kind: "requested-handoff"; to: Provider; reason: string }
  | { threadId: string; kind: "took-over"; to: Provider; reason: string; successor: string }
  | { threadId: string; kind: "both-out"; reason: string }
  | { threadId: string; kind: "skipped"; reason: string };

const PROVIDER_FROM_ID: Record<string, Provider> = { "claude-code": "claude", codex: "codex" };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface RuntimeDeps {
  bb: BbPluginApi;
  service: BoatService;
  projects: ProjectStore;
  protocol: ProtocolStore;
  /** Reads a file from GitHub (the project's rules file). */
  readRepoFile: RepoFileReader;
  /** Each agent's subscription usage (the relay's signal). */
  quotas?: QuotaReader;
  /** A desktop/phone notice for the user (relay switches, both agents out). */
  notifyUser?(title: string, body: string): Promise<void>;
  /** bb Connect's status (absent: unknown, nothing is blocked). */
  connect?: ConnectCheck;
  /** Every setting, wherever it lives (bb's list or the plugin's own). */
  settings: SettingsStore;
  /** The setup checks (bb boat doctor, the page, the checks before a sandbox). */
  setup?: Setup;
  changed(): void;
  wake(): void;
}

const MAX_FILE_BYTES = 512 * 1024;

/** kv key of the custom tier table (absent: DEFAULT_TIERS). */
export const MODEL_TIERS_KEY = "modelTiers";
export { DEFAULT_TIERS };

export function createRuntime(deps: RuntimeDeps): Runtime {
  const { bb, service, projects } = deps;

  /** The machine a CLI call came from: the invoking thread's host, else the server's. */
  async function invokingHostId(threadId: string | undefined): Promise<string | undefined> {
    if (threadId) {
      // A path names a file on the invoking thread's machine; never guess another machine.
      const thread = (await bb.sdk.threads.get({ threadId })) as { environmentId?: string | null };
      if (!thread.environmentId) throw new Error("could not determine the machine this thread runs on");
      const environment = (await bb.sdk.environments.get({ environmentId: thread.environmentId })) as {
        hostId?: string | null;
      };
      if (!environment.hostId) throw new Error("could not determine the machine this thread runs on");
      return environment.hostId;
    }
    const config = (await bb.sdk.system.config()) as { primaryHostId?: string | null };
    return config.primaryHostId ?? undefined;
  }

  async function resolveProject(ref: ProjectRef): Promise<OrchestratorProject> {
    if (ref.kind === "boat") {
      const project = projects.find(ref.id);
      if (project === null) {
        const known = projects.list().map((entry) => entry.id);
        throw new TaskError(
          `No project "${ref.id}".`,
          "project_not_found",
          known.length > 0
            ? `Known projects: ${known.join(", ")} (or local:<bb project id>). Add one in Settings → Plugins → Boat Cloud Agents.`
            : "Add one in Settings → Plugins → Boat Cloud Agents, or with `bb boat project add`.",
        );
      }
      await validateLocalProjectLink(bb, project.localBbProjectId, project.repos[0]!.repo);
      return toOrchestratorProject(project);
    }
    const local = await findLocalProject(bb, projects, ref.bbProjectId);
    if (local.branch === null) {
      throw new TaskError(local.problem ?? "Couldn't read the local branch.", "local_branch_unknown");
    }
    if (local.branchMissingRemotely || (local.unpushed ?? 0) > 0) {
      throw new TaskError(
        local.branchMissingRemotely
          ? `${local.branch} isn't on GitHub yet; tasks clone from GitHub.`
          : `${local.branch} has ${local.unpushed} commit(s) that aren't on GitHub; tasks wouldn't see them.`,
        "local_branch_unpushed",
        "Push the branch first (the New orchestrator dialog has a button for it).",
      );
    }
    return localToOrchestratorProject(local, projects);
  }

  /** null: back to the built-in tiers. */
  async function storeModelTiers(tiers: TierMap | null): Promise<void> {
    if (tiers === null) await bb.storage.kv.delete(MODEL_TIERS_KEY);
    else await bb.storage.kv.set(MODEL_TIERS_KEY, tiers);
  }

  async function modelTiers(): Promise<{ tiers: TierMap; custom: boolean }> {
    const stored = await bb.storage.kv.get<unknown>(MODEL_TIERS_KEY);
    return { tiers: parseTierMap(stored), custom: stored !== undefined && stored !== null };
  }

  /**
   * Start an orchestrator chat for a project; with a take-over, the previous
   * one's open tasks, decisions and worker chats move to it, and it stops
   * being an orchestrator (two must never act at once).
   */
  async function launch(
    project: OrchestratorProject,
    options: {
      bbProjectId: string;
      hostId: string | null;
      cloud: boolean;
      providerId: string | null;
      model: string | null;
      reasoningLevel?: string | null;
      /** Kept with it for Claude ↔ Codex switching. */
      picks?: OrchestratorPicks | null;
      title: string | null;
      prompt: string;
      takeOver: TakeOver | null;
      sectionId: string | null;
      pinned: boolean;
      environmentId?: string | null;
      /** Start in Full Access (an orchestrator in a boat sandbox). */
      fullAccess?: boolean;
    },
  ): Promise<{ threadId: string; movedTaskIds: string[] }> {
    const takeOver = options.takeOver;
    const moving = takeOver?.threadId
      ? service.store.list({ orchestratorThreadId: takeOver.threadId, statuses: OPEN_STATUSES, limit: 500 }).map((task) => task.id)
      : [];
    const section = takeOver ? await takeOverSection(bb, takeOver, moving) : null;
    const { threadId } = await spawnThread(bb, {
      projectId: options.bbProjectId,
      project,
      hostId: options.hostId,
      cloud: options.cloud,
      providerId: options.providerId,
      model: options.model,
      reasoningLevel: options.reasoningLevel ?? null,
      picks: options.picks ?? null,
      title: options.title,
      prompt: options.prompt,
      takeOverSection: section,
      sectionId: options.sectionId,
      pinned: options.pinned,
      environmentId: options.environmentId ?? null,
      permissionMode: options.fullAccess ? "full" : null,
    });
    service.store.addOrchestrator(threadId, project);
    let movedTaskIds: string[] = [];
    const old = takeOver?.threadId ?? null;
    if (old !== null) {
      // The successor is the orchestrator from here on, whatever fails next.
      service.store.removeOrchestrator(old);
      movedTaskIds = service.store.reassignOpenTasks(old, threadId);
      service.store.reassignOpenDecisions(old, threadId);
      await bb.storage.kv.delete(relayKey(old)).catch(() => undefined);
      // It loses the boat tools on its next turn, and the relay never moves it again.
      await bb.sdk.threads
        .updatePluginMetadata({ threadId: old, pluginId: bb.pluginId, set: { role: "former-orchestrator", successor: threadId } } as never)
        .catch((error: unknown) => bb.log.warn(`retire ${old}: ${message(error)}`));
    }
    // Worker chats are bb children of the old orchestrator: re-parent them.
    for (const taskId of movedTaskIds) {
      for (const workerThreadId of service.store.chatThreads(taskId)) {
        await bb.sdk.threads
          .update({ threadId: workerThreadId, parentThreadId: threadId, ...(options.sectionId ? { sectionId: options.sectionId } : {}) } as never)
          .catch((error: unknown) => bb.log.warn(`re-parent ${workerThreadId}: ${message(error)}`));
      }
    }
    deps.changed();
    // Notices held back during the hand-over go to the successor now.
    deps.wake();
    return { threadId, movedTaskIds };
  }

  async function connectStatus(): Promise<ConnectStatus> {
    return deps.connect ? deps.connect() : { state: "unknown", fix: null };
  }

  /** Sidebar place for a chat that became an orchestrator (Orchestrators in the sidebar). */
  async function placeInSidebar(threadId: string, project: OrchestratorProject): Promise<void> {
    const { sidebarLayout } = await service.settings();
    if (sidebarLayout === "pinned") {
      await bb.sdk.threads.pin({ threadId });
      return;
    }
    if (sidebarLayout !== "sections" || (await threadSection(bb, threadId)) !== null) return;
    const sectionId = await ensureProjectSection(bb, project.name.replace(/ \([^)]*\)$/, ""));
    if (sectionId !== null) await bb.sdk.threads.update({ threadId, sectionId } as never);
  }

  /** Is this bb host a Boat sandbox machine? Unsure: no. */
  async function isBoatHost(hostId: string): Promise<boolean> {
    try {
      const listed = (await bb.sdk.hosts.list()) as unknown;
      const hosts = (Array.isArray(listed) ? listed : ((listed as { hosts?: unknown[] }).hosts ?? [])) as { id?: string; machineProviderId?: string | null }[];
      return hosts.some((host) => host.id === hostId && host.machineProviderId === MACHINE_PROVIDER_ID);
    } catch {
      return false;
    }
  }

  /** Does this workspace live on a Boat sandbox machine (a cloud orchestrator's)? Unsure: no. */
  async function inBoatSandbox(environmentId: string): Promise<boolean> {
    try {
      const raw = (await bb.sdk.environments.get({ environmentId })) as { hostId?: string | null; environment?: { hostId?: string | null } };
      const hostId = raw.hostId ?? raw.environment?.hostId ?? null;
      return hostId ? await isBoatHost(hostId) : false;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------- relay

  const relayKey = (threadId: string) => `relay:${threadId}`;
  /** Chats in the middle of a hand-over: worker notices wait for the successor. */
  const handingOver = new Set<string>();

  async function readState(threadId: string): Promise<RelayState | null> {
    return ((await bb.storage.kv.get<RelayState>(relayKey(threadId)).catch(() => null)) ?? null) as RelayState | null;
  }

  async function readThread(threadId: string) {
    const raw = (await bb.sdk.threads.get({ threadId }).catch(() => null)) as unknown;
    if (raw === null) return null;
    return ((raw as { thread?: unknown }).thread ?? raw) as {
      id: string;
      title?: string | null;
      titleFallback?: string | null;
      providerId?: string | null;
      status?: string;
      updatedAt?: number | string | null;
      archivedAt?: unknown;
      deletedAt?: unknown;
      environmentId?: string | null;
      projectId?: string | null;
      pinnedAt?: unknown;
    };
  }

  async function orchestratorView(threadId: string): Promise<OrchestratorView | null> {
    const thread = await readThread(threadId);
    if (thread === null || thread.deletedAt) return null;
    const updatedAt = typeof thread.updatedAt === "number" ? thread.updatedAt : thread.updatedAt ? Date.parse(thread.updatedAt) : null;
    return {
      threadId,
      provider: PROVIDER_FROM_ID[thread.providerId ?? ""] ?? null,
      status: thread.status ?? "idle",
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
      archived: Boolean(thread.archivedAt),
      hasProject: (await getThreadProject(bb, threadId).catch(() => null)) !== null,
    };
  }

  interface QueuedRow {
    id?: string;
    initiator?: string;
    originPluginId?: string | null;
    payload?: { kind?: string } | null;
    content?: { type?: string; text?: string }[];
  }

  async function queuedRows(threadId: string): Promise<QueuedRow[]> {
    const raw = (await bb.sdk.threads.queuedMessages.list({ threadId })) as unknown;
    return (Array.isArray(raw) ? raw : ((raw as { queuedMessages?: unknown[] }).queuedMessages ?? [])) as QueuedRow[];
  }

  /**
   * Messages waiting for a chat that the successor must see: the user's, and
   * bb's retry of a failed turn (the plugin's own notices are re-sent anyway).
   */
  function forwardable(rows: QueuedRow[]): string[] {
    return rows
      .filter((row) => row.originPluginId !== bb.pluginId && (row.initiator === "user" || row.payload?.kind === "retry"))
      .map((row) => (row.content ?? []).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim())
      .filter((text) => text !== "" && !text.startsWith("[boat"));
  }

  /** Drop a chat's queued messages (bb's retry after a limit, undelivered notices). */
  async function clearQueue(threadId: string, rows?: QueuedRow[]): Promise<void> {
    try {
      for (const row of rows ?? (await queuedRows(threadId))) {
        if (row.id) await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: row.id }).catch(() => undefined);
      }
    } catch (error) {
      bb.log.warn(`relay: couldn't clear the queue of ${threadId}: ${message(error)}`);
    }
  }

  /** Move an orchestrator to another agent: a successor chat in the same workspace takes over. */
  async function relayHandover(oldThreadId: string, to: Provider, reason: string, state: RelayState | null): Promise<string> {
    const project = await getThreadProject(bb, oldThreadId);
    if (project === null) throw new Error("the orchestrator has no project");
    const old = await readThread(oldThreadId);
    if (old === null || old.deletedAt) throw new Error("the orchestrator chat is gone");
    handingOver.add(oldThreadId);
    try {
      // Two orchestrators must never act at once: a turn still running (one
      // that ran past the note's deadline) is stopped, and must have stopped.
      if (isBusy(old.status ?? "idle")) {
        await bb.sdk.threads.stop({ threadId: oldThreadId }).catch(() => undefined);
        const after = await readThread(oldThreadId);
        if (after !== null && isBusy(after.status ?? "idle")) {
          throw new Error(`the old orchestrator is still ${after.status}; trying again at the next check`);
        }
      }
      const settings = await service.settings();
      // The other agent's Build model at Effort for orchestrators, like a new orchestrator
      // there; an effort picked for this orchestrator stays, and a model picked for that agent.
      const picks = parseOrchestratorPicks(await getOrchestratorPicks(bb, oldThreadId).catch(() => null));
      const agent = orchestratorAgentChoice(settings, (await deps.settings.get()).orchestratorEffort, {
        providerId: CHAT_PROVIDER_ID[to],
        model: picks.models?.[to] ?? null,
        effort: picks.effort ?? null,
      });
      const baseTitle = (old.title ?? old.titleFallback ?? project.name).replace(/ · (Claude|Codex)$/, "");
      const preferred = settings.relay.preferred;
      // What the old chat leaves behind: its note, and messages still waiting for it.
      const rows = await queuedRows(oldThreadId).catch(() => [] as QueuedRow[]);
      const lastOutput = ((await bb.sdk.threads.output({ threadId: oldThreadId }).catch(() => null)) as { output?: string | null } | null)?.output?.trim() ?? "";
      const note = state?.phase === "handoff-requested" ? (state.note?.trim() ?? "") : "";
      const prompt = [
        `Continue coordinating ${project.name} as its orchestrator. The plugin's Claude ↔ Codex switching moved this orchestrator to ${AGENT_NAME[to]}: ${reason}.`,
        to === preferred
          ? ""
          : `It hands back to ${AGENT_NAME[preferred]} on its own once ${AGENT_NAME[preferred]} has room again; until then you're the orchestrator.`,
        "Call boat_protocol, then boat_tasks, and carry on from the handoff below. Tell the user in one line that you took over and why.",
      ]
        .filter(Boolean)
        .join(" ");
      const { threadId } = await launch(project, {
        bbProjectId: old.projectId ?? PERSONAL_PROJECT_ID,
        hostId: null,
        cloud: false,
        providerId: agent.providerId,
        model: agent.model,
        reasoningLevel: agent.effort,
        // Passed on, so the switch back keeps them too.
        picks: Object.keys(picks).length > 0 ? picks : null,
        // The preferred agent's orchestrator keeps the plain title.
        title: to === preferred ? baseTitle : `${baseTitle} · ${AGENT_NAME[to]}`,
        prompt,
        takeOver: {
          threadId: oldThreadId,
          // A note followed by another turn isn't its last message any more.
          ...(note !== "" && note !== lastOutput ? { text: note, fileName: "its handoff note" } : {}),
          userMessages: forwardable(rows),
        },
        sectionId: await threadSection(bb, oldThreadId),
        pinned: Boolean(old.pinnedAt),
        // Same machine and workspace (a cloud orchestrator keeps its sandbox).
        environmentId: old.environmentId ?? null,
        // In a boat sandbox it runs unattended, like task chats (the setting decides).
        fullAccess: settings.cloudOrchestratorFullAccess && old.environmentId ? await inBoatSandbox(old.environmentId) : false,
      });
      await bb.storage.kv.set(relayKey(threadId), { phase: "cooldown", until: Date.now() + COOLDOWN_MS } satisfies RelayState).catch(() => undefined);
      // Nothing queued (bb's retry for the limit's reset, a notice) may wake the
      // old chat later, and a turn that slipped in during the switch is stopped.
      await clearQueue(oldThreadId);
      await bb.sdk.threads.stop({ threadId: oldThreadId }).catch(() => undefined);
      // The old chat stays readable in the archive (the successor links to it).
      await bb.sdk.threads.archive({ threadId: oldThreadId }).catch(() => undefined);
      await deps.notifyUser?.(`${baseTitle} moved to ${AGENT_NAME[to]}`, reason).catch(() => undefined);
      // Historical presentation only, after the existing handover succeeds.
      // A history write must never make a completed switch retry its lifecycle.
      try {
        service.store.addEvent("", "provider-changed", `Continued on ${AGENT_NAME[to]}`, {
          source: "system", orchestratorThreadId: threadId,
          ...(PROVIDER_FROM_ID[old.providerId ?? ""] ? { from: PROVIDER_FROM_ID[old.providerId!] } : {}),
          to, cause: reason.slice(0, 1_000), ...(note ? { detail: note.slice(0, 500) } : {}),
        });
      } catch (error) {
        bb.log.warn(`relay history ${threadId}: ${message(error)}`);
      }
      deps.changed();
      return threadId;
    } finally {
      handingOver.delete(oldThreadId);
    }
  }

  async function relaySwitch(threadId: string, to: Provider, options: { immediate?: boolean; reason?: string } = {}): Promise<RelayAction> {
    const reason = options.reason ?? `requested by hand`;
    const only = onlyAgent((await service.settings()).agents);
    if (only !== null && to !== only) {
      throw new TaskError(
        `Only ${AGENT_NAME[only]} is set up (Coding agents), so an orchestrator can't move to ${AGENT_NAME[to]}.`,
        "agent_unavailable",
        "Connect both in boat.dev (Coding agents set to Auto-detect), or pick Claude and Codex in Settings → Plugins → Boat Cloud Agents.",
      );
    }
    const view = await orchestratorView(threadId);
    if (view === null || view.archived) throw new TaskError(`Orchestrator ${threadId} is gone.`, "not_found");
    if (view.provider === to) throw new TaskError(`That orchestrator already runs on ${AGENT_NAME[to]}.`, "invalid_value");
    // Only an orchestrator started for a project can be restarted elsewhere;
    // don't ask for a note nothing would pick up.
    if (!view.hasProject) {
      throw new TaskError("That orchestrator has no project, so it can't be restarted on another agent.", "project_not_found");
    }
    if (options.immediate || view.status === "error") {
      const successor = await relayHandover(threadId, to, reason, await readState(threadId));
      return { threadId, kind: "took-over", to, reason, successor };
    }
    const since = Date.now();
    await bb.storage.kv.set(relayKey(threadId), { phase: "handoff-requested", to, reason, since } satisfies RelayState);
    await bb.sdk.threads.send({
      threadId,
      mode: "queue-if-active",
      originPluginId: bb.pluginId,
      input: [{ type: "text", text: handoffRequest(to, reason), mentions: [] }],
    } as never);
    deps.changed();
    return { threadId, kind: "requested-handoff", to, reason };
  }

  // One relay pass at a time (the monitor and the CLI may both ask).
  let relayLock: Promise<unknown> = Promise.resolve();
  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = relayLock.then(run, run);
    relayLock = next.catch(() => undefined);
    return next;
  }

  function relayTick(): Promise<RelayAction[]> {
    return exclusive(relayPass);
  }

  async function relayPass(): Promise<RelayAction[]> {
    const settings = await service.settings();
    if (deps.quotas === undefined) return [];
    const quotas = await deps.quotas.read();
    const actions: RelayAction[] = [];
    const now = () => Date.now();
    // With one agent (Coding agents) the relay is off.
    const relay = effectiveRelay(settings.relay, settings.agents);
    const only = onlyAgent(settings.agents);
    for (const row of service.store.orchestrators()) {
      const state = await readState(row.threadId);
      // A hand-over to an agent the user doesn't have (any more) is dropped, so notices flow again.
      if (state?.phase === "handoff-requested" && only !== null && state.to !== only) {
        await bb.storage.kv.delete(relayKey(row.threadId)).catch(() => undefined);
        continue;
      }
      // With the relay off, only hand-overs already asked for are finished.
      if (!relay.enabled && state?.phase !== "handoff-requested") continue;
      const view = await orchestratorView(row.threadId);
      if (view === null || view.archived) {
        if (state !== null) await bb.storage.kv.delete(relayKey(row.threadId)).catch(() => undefined);
        continue;
      }
      let decision = decideRelay(view, quotas, state, relay, now());
      // "Both out" ends once the same reading no longer says so.
      if (state?.phase === "both-out") {
        const fresh = decideRelay(view, quotas, null, relay, now());
        if (fresh.kind !== "both-out") {
          await bb.storage.kv.delete(relayKey(row.threadId)).catch(() => undefined);
          decision = fresh;
        }
      }
      // boat.dev last said this agent isn't connected (and can't be read now): don't move there.
      if ((decision.kind === "request-handoff" || decision.kind === "take-over") && settings.notConnectedAgents.includes(decision.to)) {
        actions.push({ threadId: row.threadId, kind: "skipped", reason: `boat.dev last reported ${AGENT_NAME[decision.to]} as not connected` });
        continue;
      }
      try {
        if (decision.kind === "request-handoff") {
          actions.push(await relaySwitch(row.threadId, decision.to, { reason: decision.reason }));
        } else if (decision.kind === "take-over") {
          const successor = await relayHandover(row.threadId, decision.to, decision.reason, state);
          actions.push({ threadId: row.threadId, kind: "took-over", to: decision.to, reason: decision.reason, successor });
        } else if (decision.kind === "both-out") {
          await bb.storage.kv.set(relayKey(row.threadId), { phase: "both-out", since: now() } satisfies RelayState);
          actions.push({ threadId: row.threadId, kind: "both-out", reason: decision.reason });
        }
      } catch (error) {
        const text = message(error);
        bb.log.warn(`relay ${row.threadId}: ${text}`);
        actions.push({ threadId: row.threadId, kind: "skipped", reason: text });
        if (decision.kind === "take-over") {
          // Back off, and tell the user once (not every minute).
          const attempts = (state?.phase === "failed" ? state.attempts : 0) + 1;
          await bb.storage.kv
            .set(relayKey(row.threadId), {
              phase: "failed",
              to: decision.to,
              reason: decision.reason,
              attempts,
              retryAt: now() + retryDelay(attempts),
              error: text.slice(0, 300),
            } satisfies RelayState)
            .catch(() => undefined);
          if (attempts === 1) {
            const title = (await readThread(row.threadId))?.title ?? "An orchestrator";
            await deps.notifyUser?.(`Couldn't move ${title} to ${AGENT_NAME[decision.to]}`, `${text}. The plugin tries again with growing pauses.`).catch(() => undefined);
          }
        }
      }
    }
    // One notice for all orchestrators that can't move.
    const waiting = actions.filter((action) => action.kind === "both-out");
    if (waiting.length > 0) {
      await deps
        .notifyUser?.(
          "Claude and Codex are both near their limits",
          `${waiting[0]!.reason}. New tasks wait until one has room, instead of using paid extra usage; running chats carry on (your accounts' extra-usage settings decide if they can go past a limit).`,
        )
        .catch(() => undefined);
    }
    return actions;
  }

  async function relayStatus() {
    const settings = await service.settings();
    const quotas = deps.quotas ? await deps.quotas.read() : new Map();
    const rows = [];
    for (const row of service.store.orchestrators()) {
      const view = await orchestratorView(row.threadId);
      if (view === null || view.archived) continue;
      const state = await readState(row.threadId);
      const thread = await readThread(row.threadId);
      rows.push({
        threadId: row.threadId,
        title: thread?.title ?? thread?.titleFallback ?? null,
        provider: view.provider,
        decision: decideRelay(view, quotas, state, effectiveRelay(settings.relay, settings.agents), Date.now()),
        state,
      });
    }
    return { quotas, orchestrators: rows };
  }

  /** A chat being handed over (asked for its note, or mid-switch): notices wait for the successor. */
  async function chatApproval(threadId: string | null | undefined, task: Task, action: "ship" | "discard" = "ship"): Promise<{ ok: boolean; reason: string }> {
    const taskId = task.id;
    if (!threadId) return { ok: false, reason: "only the task's orchestrator chat can ship or discard it (or the user, with the buttons on the overview)" };
    if (threadId !== task.orchestratorThreadId) return { ok: false, reason: "this chat isn't the task's orchestrator" };
    // The user can only approve what they've been shown: the latest turn must be reported here.
    if (task.finishedAt === null || task.notifiedAt === null || task.notifiedAt < task.finishedAt) {
      return { ok: false, reason: "the task's latest turn hasn't been reported in this chat yet" };
    }
    let items: { preview: string }[];
    try {
      const outline = (await bb.sdk.threads.conversationOutline({ threadId, role: "user" } as never)) as { items?: { preview?: string }[] };
      items = (outline.items ?? []).map((item) => ({ preview: (item.preview ?? "").trim() }));
    } catch (error) {
      return { ok: false, reason: `couldn't read this chat (${message(error)})` };
    }
    // Messages the plugin (or another agent) sent count as neither.
    const fromPlugin = (text: string) => text.startsWith("[boat") || text.startsWith("[bb message");
    const fromUser = (item: { preview: string }) => item.preview !== "" && !fromPlugin(item.preview);
    const reports: number[] = [];
    items.forEach((item, index) => {
      // A watchdog notice is about a task, not a report of its turn.
      if (item.preview.startsWith(WATCHDOG_PREFIX)) return;
      if (item.preview.startsWith("[boat]") && (item.preview.includes(taskId) || /^\[boat\] \d+ tasks finished a turn/.test(item.preview))) reports.push(index);
    });
    const reportedAt = reports.at(-1) ?? -1;
    if (reportedAt === -1) return { ok: false, reason: "the task's work hasn't been reported in this chat" };
    if (items.slice(reportedAt + 1).some(fromUser)) return { ok: true, reason: "" };
    // An OK to ship given before a newer turn doesn't cover it: say why it's needed again.
    if (action === "ship" && changedSinceApproval(task)) return { ok: false, reason: changedApprovalReason(task.shipApproval!) };
    const wroteBefore = reports.length > 1 && items.slice(reports[0]! + 1, reportedAt).some(fromUser);
    if (action === "ship" && wroteBefore && items[reportedAt]!.preview.includes(taskId)) {
      return { ok: false, reason: "the task had a newer turn after the user last wrote here; show the user what changed and ask them to approve again" };
    }
    return { ok: false, reason: "the user hasn't written in this chat since the task's work was reported" };
  }

  async function tellOrchestrator(threadId: string, text: string): Promise<void> {
    await bb.sdk.threads.send({
      threadId,
      mode: "queue-if-active",
      originPluginId: bb.pluginId,
      input: [{ type: "text", text, mentions: [] }],
    } as never);
  }

  async function isHandingOver(threadId: string): Promise<boolean> {
    if (handingOver.has(threadId)) return true;
    return (await readState(threadId))?.phase === "handoff-requested";
  }

  /** Is this thread still there and not archived? Unsure counts as yes. */
  async function threadIsOpen(threadId: string): Promise<boolean> {
    try {
      const raw = (await bb.sdk.threads.get({ threadId })) as { thread?: unknown } | null;
      const thread = (raw?.thread ?? raw) as { archivedAt?: unknown; deletedAt?: unknown } | null;
      return thread !== null && !thread.archivedAt && !thread.deletedAt;
    } catch (error) {
      return !/not[ _]found|404/i.test(message(error));
    }
  }

  /** Why a project can't be removed by an import: open tasks (from its orchestrators) or an open orchestrator. */
  async function projectRemovalBlocker(projectId: string): Promise<string | null> {
    const orchestrators = service.store.orchestrators().filter((row) => row.projectId === projectId);
    const threads = new Set(orchestrators.map((row) => row.threadId));
    const open = service.store
      .list({ statuses: OPEN_STATUSES, limit: 1000 })
      .filter((task) => task.projectId === projectId || (task.orchestratorThreadId !== null && threads.has(task.orchestratorThreadId))).length;
    const reasons = open > 0 ? [`it has ${open} open task${open === 1 ? "" : "s"}`] : [];
    for (const row of orchestrators) {
      if (!(await threadIsOpen(row.threadId))) continue;
      reasons.push(`its orchestrator @thread:${row.threadId} is open`);
      break;
    }
    return reasons.length > 0 ? reasons.join(" and ") : null;
  }

  async function writeInvokerFile(ctx: { threadId?: string; cwd?: string }, path: string, content: string): Promise<string> {
    const absolute = posix.isAbsolute(path) ? path : posix.join(ctx.cwd ?? "/", path);
    const hostId = await invokingHostId(ctx.threadId);
    // The file may hold standing instructions and project details: only the user reads it.
    await bb.sdk.files.write({ path: absolute, content, contentEncoding: "utf8", createParents: true, mode: 0o600, ...(hostId ? { hostId } : {}) });
    return absolute;
  }

  /** A chat finished a turn: keep it as the handoff note when one was asked for. */
  async function relayIdle(threadId: string, text: string | null, at: number | null): Promise<void> {
    const state = await readState(threadId);
    if (state?.phase !== "handoff-requested" || !text?.trim()) return;
    const when = at ?? Date.now();
    if (when <= state.since) return;
    await bb.storage.kv.set(relayKey(threadId), { ...state, note: text.slice(0, 20_000), noteAt: when } satisfies RelayState).catch(() => undefined);
  }

  return {
    bb,
    service,
    projects,
    protocol: deps.protocol,
    modelTiers,
    async saveModelTiers(tiers) {
      await storeModelTiers(tiers);
      deps.changed();
    },
    async orchestratorProtocol(project, signal) {
      const shared = renderSharedProtocol(deps.protocol.read().text, (await modelTiers()).tiers, await service.settings());
      const rules = await loadProjectRules(project, deps.readRepoFile, signal);
      return composeProtocol(shared, project, rules);
    },
    launchWaitMs: 90_000,

    async readInvokerFile(ctx, path) {
      const absolute = posix.isAbsolute(path) ? path : posix.join(ctx.cwd ?? "/", path);
      const hostId = await invokingHostId(ctx.threadId);
      const result = (await bb.sdk.files.read({ path: absolute, ...(hostId ? { hostId } : {}) })) as {
        content: string;
        contentEncoding: "utf8" | "base64";
        sizeBytes?: number;
      };
      if ((result.sizeBytes ?? 0) > MAX_FILE_BYTES) throw new Error(`file is larger than ${MAX_FILE_BYTES / 1024} KiB`);
      return result.contentEncoding === "base64"
        ? Buffer.from(result.content, "base64").toString("utf8")
        : result.content;
    },

    isOrchestrator: (threadId) => getOrchestratorFlag(bb, threadId),

    async setOrchestrator(threadId, on, project = null) {
      await writeOrchestratorFlag(bb, threadId, on, project);
      if (on) service.store.addOrchestrator(threadId, project);
      else service.store.removeOrchestrator(threadId);
      // Like a new orchestrator: into its project's section (or pinned), unless
      // the chat already sits in a section of your choosing.
      if (on && project !== null) await placeInSidebar(threadId, project).catch(() => undefined);
      deps.changed();
    },

    resolveProject,

    async projectForThread(threadId) {
      if (!threadId) return null;
      const stored = await getThreadProject(bb, threadId).catch(() => null);
      if (stored === null) return null;
      // Settings may have changed since the orchestrator started; prefer them.
      if (stored.source === "boat") {
        const current = projects.get(stored.id);
        if (current !== null) return toOrchestratorProject(current);
      }
      return stored;
    },

    async startOrchestrator(input) {
      const project = await resolveProject(input.project);
      if (input.prompt.trim() === "") throw new TaskError("Say what the orchestrator should coordinate.", "invalid_value");
      // A cloud orchestrator runs bb in a boat sandbox, which reaches this bb through bb Connect.
      const onMachine = input.cloud === false || Boolean(input.hostId);
      const connect = onMachine ? null : await connectStatus();
      const cloud = input.cloud ?? (!onMachine && connect?.state === "ready");
      if (cloud && connect?.state === "off") {
        throw new TaskError(
          "A cloud orchestrator needs bb Connect, and it isn't set up on this bb.",
          "connect_required",
          `${connect.fix ? `${connect.fix} ` : ""}Or start it on this computer (--local, or "This computer" in the dialog).`,
        );
      }
      // Left to the plugin and not in the cloud: say why, and what to set up.
      const note =
        input.cloud !== undefined || onMachine || cloud
          ? null
          : connect?.state === "off"
            ? `Started on this computer: cloud orchestrators need bb Connect.${connect.fix ? ` ${connect.fix}` : ""}`
            : "Started on this computer: couldn't check bb Connect, which cloud orchestrators need. Use --cloud to start one in a boat sandbox anyway.";
      const settings = await service.settings();
      const { sidebarLayout, cloudOrchestratorFullAccess } = settings;
      // Named here (dialog, CLI) or from the settings: always explicit, so it's what the dialog showed.
      const effortSetting = (await deps.settings.get()).orchestratorEffort;
      const agent = orchestratorAgentChoice(settings, effortSetting, {
        providerId: input.providerId,
        model: input.model,
        effort: input.effort,
      });
      const sectionId = sidebarLayout === "sections" ? await ensureProjectSection(bb, project.name.replace(/ \([^)]*\)$/, "")) : null;
      const started = await launch(project, {
        bbProjectId: input.bbProjectId ?? PERSONAL_PROJECT_ID,
        hostId: input.hostId ?? null,
        cloud,
        providerId: agent.providerId,
        model: agent.model,
        reasoningLevel: agent.effort,
        picks: orchestratorPicks(settings, effortSetting, agent),
        title: input.title ?? null,
        prompt: input.prompt,
        takeOver: input.takeOver ?? null,
        sectionId,
        pinned: sidebarLayout === "pinned",
        // In a Boat sandbox: a new one, or a Boat sandbox machine picked as host.
        fullAccess: cloudOrchestratorFullAccess && (cloud || (input.hostId ? await isBoatHost(input.hostId) : false)),
      });
      return { ...started, cloud, note, agent };
    },

    connectStatus,
    setup: deps.setup ?? null,
    settings: deps.settings,
    config: {
      settings: deps.settings,
      projects,
      protocol: deps.protocol,
      modelTiers,
      saveModelTiers: storeModelTiers,
      removalBlocker: projectRemovalBlocker,
    },
    writeInvokerFile,
    relayTick,
    relaySwitch: (threadId, to, options) => exclusive(() => relaySwitch(threadId, to, options)),
    relayStatus,
    isHandingOver,
    relayIdle,
    chatApproval,
    tellOrchestrator,

    changed: deps.changed,
    wake: deps.wake,
  };
}
