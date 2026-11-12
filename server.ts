// bb-plugin-boat — run coding agents in boat.dev cloud sandboxes and
// orchestrate them from bb threads.
//
// The plugin shells out to the `boat` CLI on the machine that runs the bb
// server (where the user is logged in to boat), keeps a task registry in its
// own SQLite database, watches running tasks in a background service, and
// posts a message into the dispatching thread when a worker finishes a turn.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { TAGS } from "./contract.ts";
import { BoatApi, parseBranchList, type MachineType } from "./src/boat-api.ts";
import { BoatCli, resolveBoatBinary } from "./src/boat.ts";
import { buildCli } from "./src/cli.ts";
import { registerBoatMachine } from "./src/machine.ts";
import { createSandboxKeeper } from "./src/keeper.ts";
import { createWatchdog, type QueuedRow, type Watchdog } from "./src/watchdog.ts";
import { notificationText } from "./src/format.ts";
import { DEFAULT_TASKS_BEFORE_ASKING, isOrchestratorMetadata, orchestratorInstructions, projectInstructions } from "./src/orchestrator.ts";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createChatRunner } from "./src/chat.ts";
import { ChatRecoveryStore, createChatRecovery } from "./src/chat-recovery.ts";
import { GOAL_EVENT_TYPES, type TurnEventRow } from "./src/steer-retry.ts";
import { createConnectCheck } from "./src/connect.ts";
import { createRepoFileReader, ghStatus } from "./src/github.ts";
import { ProjectStore, parseOrchestratorProject } from "./src/projects.ts";
import { ProtocolStore } from "./src/protocol.ts";
import { createQuotaReader } from "./src/quota.ts";
import { PROVIDER_OF_ID, createLimitTracker, limitFromErrorText, limitFromTurnFailure, type TurnFailure } from "./src/limits.ts";
import { createEvidenceSource, parseEvidenceSource } from "./src/evidence.ts";
import { CLI_MISSING_STATUS, createSetup, effectiveAgents, parseAgentsSetting, type SetupSettings } from "./src/setup.ts";
import { runnersFor } from "./src/settings.ts";
import { createMigratingSettingsStore } from "./src/settings-store.ts";
import { createAttentionNotifications, type AttentionNotifications } from "./src/attention-notifications.ts";
import { MODEL_TIERS_KEY } from "./src/runtime.ts";
import { parseTierMap } from "./src/tiers.ts";
import { registerRpc } from "./src/rpc.ts";
import { registerMergeRpc } from "./src/merge.ts";
import { registerStartQueueRpc } from "./src/start-queue-rpc.ts";
import { registerNativeReviews } from "./src/native-review.ts";
import { nativeStart, adoptNativeChat } from "./src/native-start.ts";
import { createRuntime, type Runtime } from "./src/runtime.ts";
import { BoatService, DeliveryDeferred, type BoatSettings, type Notification } from "./src/service.ts";
import { TaskStore, type Provider } from "./src/store.ts";
import { TOOL_NAMES, registerTools } from "./src/tools.ts";

const REALTIME_CHANNEL = "boat-changed";
/** bb thread states with a turn under way. */
const BUSY_THREAD = new Set(["active", "starting", "pending", "stopping"]);
/** How often the relay checks usage (the readings refresh about this often). */
const RELAY_INTERVAL_MS = 60_000;
/** Tries to remove a withdrawn row that bb grouped with newer input, and the wait between them after the first. */
const RELEASE_ROUNDS = 10;
const RELEASE_RETRY_MS = 30_000;
/** How often running turns are checked (waiting tasks: once a minute; task chats also react to bb's events). */
const POLL_INTERVAL_MS = 15_000;

/** Abortable sleep that cleans up its listener either way. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export default async function plugin(bb: BbPluginApi) {
  // bb's settings list plus the plugin's own settings, read and written as one.
  const settings = await createMigratingSettingsStore(bb);

  // Storage
  bb.storage.migrate(bb.storage.database(), TaskStore.migrations());
  const store = new TaskStore(() => bb.storage.database());
  const projects = new ProjectStore(() => bb.storage.database());

  // boat CLI
  const cli = new BoatCli(async () => resolveBoatBinary((await settings.get()).boatPath));
  const boat = new BoatApi(cli);
  // Worker chats and cloud orchestrators need bb Connect.
  const connect = createConnectCheck(bb);

  /** What the setup checks need from the settings. */
  async function setupSettings(): Promise<SetupSettings> {
    const values = await settings.get();
    const custom = (() => {
      try {
        return parseEvidenceSource(values.evidenceUploader)?.kind === "github";
      } catch {
        return false;
      }
    })();
    const list = projects.list();
    return {
      agents: parseAgentsSetting(values.agents),
      environment: values.environment,
      projectEnvironments: list.map((project) => project.environment).filter((name): name is string => name !== null && name !== ""),
      // Task chats are possible: for every repo, or for projects that run tasks as chats.
      connectNeeded: values.workers === "all" || (values.workers === "projects" && list.some((project) => project.workerMode === "chat")),
      ghNeeded: custom || list.some((project) => project.protocolPath !== null),
    };
  }

  // Setup checks: read-only boat commands, cached about a minute.
  const setup = createSetup({
    binary: async () => resolveBoatBinary((await settings.get()).boatPath),
    run: (args, options) => cli.run(args, options),
    settings: setupSettings,
    connect,
    repoAccess: () => store.latestRepoAccess(),
    gh: () => ghStatus(),
    startedWithoutCli: () => initialBinary === null,
  });

  async function readSettings(): Promise<BoatSettings & { pushNotifications: boolean }> {
    const values = await settings.get();
    // Auto-detect: the agents boat.dev has for the environment new sandboxes use.
    const agentsSetting = parseAgentsSetting(values.agents);
    const detected = agentsSetting === "auto" ? await setup.detectedAgents(values.environment).catch(() => null) : null;
    return {
      boatPath: values.boatPath,
      environment: values.environment,
      machineType: values.machineType as MachineType,
      orchestratorMachineType: values.orchestratorMachineType as MachineType,
      implementProvider: values.implementProvider as Provider,
      implementModel: values.implementModel,
      reviewProvider: values.reviewProvider as Provider,
      reviewModel: values.reviewModel,
      reasoningEffort: values.reasoningEffort === "default" ? "" : values.reasoningEffort,
      sandboxTtlHours: values.sandboxTtlHours,
      maxActiveSandboxes: values.maxActiveSandboxes,
      stopIdleAfterMinutes: values.stopIdleAfterMinutes,
      freeSlotsWhenFull: values.freeSlotsWhenFull,
      deleteSandboxOnClose: values.deleteSandboxOnClose,
      reviewSandbox: values.reviewSandbox as BoatSettings["reviewSandbox"],
      workerInstructions: values.workerInstructions,
      evidenceUploader: values.evidenceUploader,
      autoFailover: values.autoFailover,
      agents: effectiveAgents(agentsSetting, detected),
      agentsSetting,
      notConnectedAgents: agentsSetting === "auto" ? setup.lastMissingAgents(values.environment) : [],
      cloudOrchestratorFullAccess: values.cloudOrchestratorFullAccess,
      extraProtectedBranches: parseBranchList(values.extraProtectedBranches),
      tasksBeforeAsking: values.tasksBeforeAsking,
      modelTiers: parseTierMap(await bb.storage.kv.get<unknown>(MODEL_TIERS_KEY)),
      // How tasks run: chats possible at all (workerMode), and for repos outside your projects.
      ...runnersFor(values.workers),
      sidebarLayout: values.sidebarLayout === "pinned" || values.sidebarLayout === "plain" ? values.sidebarLayout : "sections",
      relay: {
        enabled: values.relayEnabled,
        preferred: values.relayPreferred === "codex" ? "codex" : "claude",
        switchAtPercent: values.relaySwitchAt,
        switchBackBelowPercent: Math.min(values.relaySwitchBackBelow, values.relaySwitchAt - 5),
        quietMinutes: values.relayQuietMinutes,
      },
      avoidExtraUsage: values.avoidExtraUsage,
      pushNotifications: values.pushNotifications,
    };
  }

  // The shared orchestrator protocol lives next to data.db, so it can be
  // edited in Settings or in any editor.
  const databaseFile = bb.storage.database().name;
  const pluginDir = databaseFile && databaseFile !== ":memory:" ? dirname(databaseFile) : join(tmpdir(), "bb-plugin-boat");
  const protocol = new ProtocolStore(join(pluginDir, "orchestrator-protocol.md"));

  // Without the CLI nothing works: say how to install it (a reload or a settings save clears this).
  const initialBinary = resolveBoatBinary((await settings.get()).boatPath);
  if (initialBinary === null) bb.status.needsConfiguration(CLI_MISSING_STATUS);

  const lifecycle = new AbortController();
  bb.onDispose(() => lifecycle.abort());

  let wakeMonitor: () => void = () => undefined;
  let attentionNotifications: AttentionNotifications | null = null;

  function changed(): void {
    bb.rpc.experimental_invalidate([TAGS.tasks, TAGS.sandboxes, TAGS.overview, TAGS.projects, TAGS.protocol, TAGS.relay, TAGS.setup, TAGS.settings]);
    bb.realtime.publish(REALTIME_CHANNEL, null);
    void attentionNotifications?.flush();
  }
  // A settings change (here, from bb's settings page or the CLI) refreshes open UIs.
  settings.onChange(() => changed());

  /**
   * A phone/desktop notice through bb's push-notifications plugin. Turn
   * notices follow the "Push notifications" setting; the relay's rare ones
   * (an orchestrator moved, both agents near their limits) always go out.
   */
  async function pushNotice(title: string, body: string, options: { threadId?: string; always?: boolean } = {}): Promise<void> {
    if (!options.always && !(await readSettings()).pushNotifications) return;
    const threadId = options.threadId;
    await bb.sdk.plugins
      .callRpc({
        pluginId: "push-notifications",
        method: "notifications.send",
        input: { title, body, ...(threadId ? { threadId } : {}) },
        outputSchema: z.object({ ok: z.literal(true) }).passthrough(),
      })
      .catch((error: unknown) => bb.log.warn(`push notification failed: ${String(error)}`));
  }

  // Agents that hit a usage limit (from failed turns) read as full until it lifts.
  const limits = createLimitTracker(bb.storage.kv);
  // Each agent's usage, from the Account Pooler or the providers' own readings.
  const quotas = createQuotaReader(bb, { limits: () => limits.active() });
  // Set once the runtime exists (notices wait while an orchestrator is handed over).
  let runtimeRef: Runtime | null = null;
  // Set once the watchdog exists (it keeps the note a worker gets after a stop).
  let watchdogRef: Watchdog | null = null;
  // GitHub files through this machine's `gh` login (project rules, the evidence uploader).
  const readRepoFile = createRepoFileReader();

  async function notify({ threadId, tasks: listed }: Notification): Promise<void> {
    let thread: { deletedAt?: number | null; archivedAt?: number | null; status?: string; thread?: { status?: string } };
    try {
      thread = (await bb.sdk.threads.get({ threadId })) as typeof thread;
    } catch (error) {
      // A thread that no longer exists can't be told; count it as delivered.
      if (/not[ _]found|404/i.test(error instanceof Error ? error.message : String(error))) return;
      throw error;
    }
    if (thread.deletedAt || thread.archivedAt) return;
    // An orchestrator being handed over gets no notices; its successor gets them.
    if (runtimeRef !== null && (await runtimeRef.isHandingOver(threadId))) throw new DeliveryDeferred(threadId);
    // A chat in the middle of a turn hears about it when the turn ends (thread.idle
    // delivers): a notice queued now could arrive after the chat closed the task.
    if (BUSY_THREAD.has(thread.status ?? thread.thread?.status ?? "")) throw new DeliveryDeferred(threadId);
    // Only turns still waiting: a task closed in the meantime needs no notice.
    const tasks = listed
      .map((task) => service.store.get(task.id) ?? task)
      .filter((task) => task.status === "idle" || task.status === "failed");
    if (tasks.length === 0) return;
    await bb.sdk.threads.send({
      threadId,
      mode: "queue-if-active",
      originPluginId: bb.pluginId,
      input: [
        {
          type: "text",
          text: notificationText(
            tasks,
            (taskId) => service.store.events(taskId, 30),
            (taskId) => service.store.latestEvent(taskId, "evidence")?.text ?? null,
            (taskId) => service.previewNoticeFor(taskId),
          ),
          mentions: [],
        },
      ],
    });
    await attentionNotifications?.flush();
  }

  const chatRunner = createChatRunner(bb);
  const service = new BoatService(boat, store, {
    settings: readSettings,
    lifecycle: lifecycle.signal,
    changed,
    notify,
    log: { info: (message) => bb.log.info(message), warn: (message) => bb.log.warn(message) },
    chat: chatRunner,
    // Tests answer preview checks without the network.
    ...(process.env.BOAT_PLUGIN_PREVIEW_CHECK ? { checkPreview: async () => process.env.BOAT_PLUGIN_PREVIEW_CHECK as "up" | "down" | "unknown" } : {}),
    quotas,
    connect,
    preflight: (input) => setup.preflight(input),
    // Sandbox sizes: the projects' sizes, the plan's sizes (never waiting unless fresh), and plain messages to chats.
    projects: () => projects.list(),
    sizePlan: async (options) => (await setup.reading({ force: options?.fresh === true }).catch(() => null))?.plan?.machineTypes ?? null,
    sizePlanNow: () => setup.peek()?.facts.plan?.machineTypes ?? null,
    tell: (threadId, text) => runtimeRef?.tellOrchestrator(threadId, text) ?? Promise.resolve(),
    resumeNote: {
      peek: (taskId) => watchdogRef?.noteFor(taskId) ?? Promise.resolve(null),
      sent: (taskId) => watchdogRef?.noteSent(taskId) ?? Promise.resolve(),
    },
    machineSuspended: (hostId, underWork) => watchdogRef?.planned(hostId, underWork),
    sandboxStopped: (sandboxId) => watchdogRef?.planned(sandboxId, false),
    processesStopped: (sandboxId, at) => void watchdogRef?.headlessStopped({ sandboxId, stoppedAt: at, how: "idle-stop" }).catch(() => undefined),
    evidence: createEvidenceSource(readRepoFile, undefined, (error, at) =>
      bb.log.warn(`evidence uploader: GitHub refresh failed (${error instanceof Error ? error.message : String(error)}); installing the copy from ${new Date(at).toISOString()}`),
    ),
    repoWorkerMode: (repo) => {
      const lower = repo.toLowerCase();
      const owners = projects.list().filter((project) => project.repos.some((entry) => entry.repo.toLowerCase() === lower));
      if (owners.length === 0) return null;
      // In two projects with different settings, the careful one wins.
      return owners.some((project) => project.workerMode === "boat") ? "boat" : "chat";
    },
    repoDelivery: (repo, baseBranch) => {
      const lower = repo.toLowerCase();
      const owners = projects.list().filter((project) => project.repos.some((entry) => entry.repo.toLowerCase() === lower && entry.baseBranch === baseBranch));
      if (owners.length === 0) return null;
      // The stricter one wins: if any project ships this repo's base after approval, workers only commit.
      return owners.some((project) => project.delivery === "push") ? "push" : "pr";
    },
    repoBaseBranches: (repo) => {
      // Every project with this repo protects its base branch and its own protected branches.
      const lower = repo.toLowerCase();
      return projects
        .list()
        .filter((project) => project.repos.some((entry) => entry.repo.toLowerCase() === lower))
        .flatMap((project) => [
          ...project.repos.filter((entry) => entry.repo.toLowerCase() === lower).map((entry) => entry.baseBranch),
          ...project.protectedBranches,
        ]);
    },
    projectReviewer: (projectId, repo) => {
      const own = projectId === null ? null : projects.get(projectId);
      return (own ?? (repo === null ? null : projects.forRepo(repo)))?.reviewer ?? null;
    },
    projectInstructions: (projectId, repo) => {
      // The task's project, else every project with its repo.
      const own = projectId === null ? null : projects.get(projectId);
      if (own !== null) return own.instructions.trim() ? [own.instructions.trim()] : [];
      if (repo === null) return [];
      const lower = repo.toLowerCase();
      const texts = projects
        .list()
        .filter((project) => project.repos.some((entry) => entry.repo.toLowerCase() === lower))
        .map((project) => project.instructions.trim())
        .filter((text) => text !== "");
      return [...new Set(texts)];
    },
  });

  const runtime = createRuntime({
    bb,
    service,
    projects,
    protocol,
    readRepoFile,
    quotas,
    connect,
    settings,
    // Relay progress and reset waits stay in-chat; only task needs-you/ready pushes are sent.
    notifyUser: async () => undefined,
    setup,
    changed,
    wake: () => wakeMonitor(),
  });
  runtimeRef = runtime;
  const nativeReviews = registerNativeReviews(runtime);
  attentionNotifications = createAttentionNotifications({
    kv: bb.storage.kv,
    enabled: async (kind) => {
      const values = await settings.get();
      return values.pushNotifications && (kind === "ready" ? values.notifyReady : kind === "needs-you" ? values.notifyNeedsYou : kind === "progress" ? values.notifyProgress : true);
    },
    decisions: () => store.decisions({ statuses: ["open"], limit: 1000 }),
    tasks: () => store.list({ statuses: ["idle", "failed"], limit: 1000 }),
    status: (task) => service.publicStatus(task),
    stopped: () => lifecycle.signal.aborted,
    failed: (error) => bb.log.warn(`attention notification: ${String(error)}`),
    async send(notice) {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: "push-notifications",
        method: "notifications.send",
        input: { title: notice.title, body: notice.body, threadId: notice.threadId },
        outputSchema: z.object({ ok: z.literal(true), channels: z.array(z.enum(["web", "desktop", "mobile"])) }).passthrough(),
      });
      if (result.channels.length === 0) throw new Error("No notification channel accepted the notice.");
    },
  });

  bb.cli.register(buildCli(runtime));
  registerBoatMachine(bb, { boat, cli, service, settings: readSettings, setup, setupSettings, connect });
  registerTools(runtime);
  registerRpc(runtime);
  registerMergeRpc(runtime);
  registerStartQueueRpc(runtime);

  // Tasks at once before asking, for the instructions (bb asks for them synchronously).
  let tasksBeforeAsking = await settings
    .get()
    .then((values) => values.tasksBeforeAsking)
    .catch(() => DEFAULT_TASKS_BEFORE_ASKING);
  settings.onChange((keys) => {
    if (!keys.includes("tasksBeforeAsking")) return;
    void settings
      .get()
      .then((values) => {
        tasksBeforeAsking = values.tasksBeforeAsking;
      })
      .catch(() => undefined);
  });

  // Orchestrator threads get the boat tools, the playbook skill, and standing
  // instructions; every thread can use the general `boat` skill and CLI.
  bb.agents.configure((context) => {
    if (isOrchestratorMetadata(context.pluginMetadata)) {
      return {
        tools: [...TOOL_NAMES],
        skills: ["boat", "boat-orchestrator"],
        // bb caps instructions at 4096 characters; the full protocol comes from boat_protocol.
        instructions: `${orchestratorInstructions(tasksBeforeAsking)}${projectInstructions(parseOrchestratorProject(context.pluginMetadata.project))}`.slice(0, 4096),
      };
    }
    // Another chat in a worker's workspace learns where it is and who else works there.
    const workspace = context.environment?.id ? service.workspaceInstructions(context.environment.id, context.thread.id) : null;
    return workspace ? { tools: [], skills: ["boat"], instructions: workspace.slice(0, 4096) } : { tools: [], skills: ["boat"] };
  });

  // Worker chats: react to bb's thread events at once (the monitor's poll is the backstop).
  const onThread = (kind: "idle" | "failed" | "active" | "archived") => (payload: unknown) => {
    const event = payload as { thread?: { id?: string; updatedAt?: unknown }; lastAssistantText?: string | null; error?: string | null };
    const threadId = event.thread?.id;
    if (typeof threadId !== "string") return;
    const at = typeof event.thread?.updatedAt === "number" ? event.thread.updatedAt : null;
    void adoptNativeChat(threadId, runtime)
      .then(() => service.syncChatThread(threadId, {
        kind,
        ...(kind === "idle" ? { text: event.lastAssistantText ?? null } : {}),
        ...(kind === "failed" ? { error: event.error ?? null } : {}),
        at,
      }))
      .then(() => nativeReviews.afterThreadSync(threadId))
      .catch((error: unknown) => bb.log.warn(`chat event ${kind} ${threadId}: ${error instanceof Error ? error.message : String(error)}`));
  };
  // A chat someone opens in a worker's workspace joins the task.
  bb.events.on("thread.created", (payload: unknown) => {
    const thread = (
      payload as {
        thread?: { id?: string; environmentId?: string | null; providerId?: string | null; parentThreadId?: string | null; originPluginId?: string | null };
      }
    ).thread;
    // Chats the plugin opens itself are recorded when it opens them.
    if (typeof thread?.id !== "string" || thread.originPluginId === bb.pluginId) return;
    void service
      .adoptWorkspaceChat({
        id: thread.id,
        environmentId: thread.environmentId ?? null,
        providerId: thread.providerId ?? null,
        parentThreadId: thread.parentThreadId ?? null,
      })
      .then((adopted) => (adopted ? changed() : undefined))
      .catch((error: unknown) => bb.log.warn(`adopt ${thread.id}: ${error instanceof Error ? error.message : String(error)}`));
  });
  bb.events.on("thread.idle", onThread("idle"));
  // Notices held back while a chat was busy go out once its turn ends.
  bb.events.on("thread.idle", () => {
    void service.deliverPending().catch(() => undefined);
  });
  // The relay keeps a requested handoff note.
  bb.events.on("thread.idle", (payload: unknown) => {
    const event = payload as { thread?: { id?: string; updatedAt?: unknown }; lastAssistantText?: string | null };
    if (typeof event.thread?.id !== "string") return;
    const at = typeof event.thread.updatedAt === "number" ? event.thread.updatedAt : null;
    void runtime.relayIdle(event.thread.id, event.lastAssistantText ?? null, at).catch(() => undefined);
  });
  // Usage limits, from any chat on this bb (a limit is account-wide).
  bb.events.on("turn.failed", (payload: unknown) => {
    const event = payload as TurnFailure & { threadId?: string };
    const until = limitFromTurnFailure(event);
    if (until === null || typeof event.threadId !== "string") return;
    void (async () => {
      let provider = PROVIDER_OF_ID[event.rateLimits?.providerId ?? ""];
      if (provider === undefined) {
        const thread = (await bb.sdk.threads.get({ threadId: event.threadId! }).catch(() => null)) as { providerId?: string | null } | null;
        provider = PROVIDER_OF_ID[thread?.providerId ?? ""];
      }
      if (provider !== undefined) await limits.record(provider, until);
    })().catch(() => undefined);
  });
  bb.events.on("thread.failed", (payload: unknown) => {
    const event = payload as { thread?: { providerId?: string | null }; error?: string | null };
    const provider = PROVIDER_OF_ID[event.thread?.providerId ?? ""];
    const until = limitFromErrorText(event.error);
    if (provider !== undefined && until !== null) void limits.record(provider, until).catch(() => undefined);
  });
  bb.events.on("thread.failed", onThread("failed"));
  bb.events.on("thread.active", onThread("active"));
  bb.events.on("thread.archived", onThread("archived"));

  // Any other chat on this bb: one recovery message after a steer-triggered provider Bad Request.
  const chatRecovery = createChatRecovery({
    enabled: async () => (await settings.get()).recoverChatsAfterSteer === true,
    // Boat task chats have their own retry (with the orchestrator's notices).
    isTaskThread: (threadId) => service.store.byThread(threadId) !== null,
    threads: {
      state: (threadId) => chatRunner.state(threadId),
      turnEvents: (threadId) => chatRunner.turnEvents(threadId),
      goalEvents: async (threadId) => {
        const raw = (await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "20", types: [...GOAL_EVENT_TYPES] } as never)) as unknown;
        return (Array.isArray(raw) ? raw : ((raw as { events?: unknown[] } | null)?.events ?? [])) as TurnEventRow[];
      },
      // A new turn now, or bb's queue (which the recovery withdraws from at once); never a steer.
      send: (threadId, text) => chatRunner.send(threadId, text, { steer: false }),
      withdraw: (threadId, queuedMessageId) => chatRunner.withdraw(threadId, queuedMessageId),
    },
    store: new ChatRecoveryStore(() => bb.storage.database()),
    guards: service.store,
    log: { info: (line) => bb.log.info(line), warn: (line) => bb.log.warn(line) },
    signal: lifecycle.signal,
  });
  const recoverChat = (threadId: unknown) => {
    if (typeof threadId === "string") void chatRecovery.failed(threadId).catch((error: unknown) => bb.log.warn(`chat recovery ${threadId}: ${error instanceof Error ? error.message : String(error)}`));
  };
  bb.events.on("thread.failed", (payload: unknown) => recoverChat((payload as { thread?: { id?: unknown } }).thread?.id));
  bb.events.on("turn.failed", (payload: unknown) => recoverChat((payload as { threadId?: unknown }).threadId));
  bb.events.on("thread.idle", (payload: unknown) => {
    const threadId = (payload as { thread?: { id?: unknown } }).thread?.id;
    if (typeof threadId === "string") void chatRecovery.idle(threadId).catch(() => undefined);
  });

  // boat's auto-stop doesn't see a bb chat working: keep its sandbox on while a turn runs.
  const keepSandboxesOn = createSandboxKeeper(bb, {
    boat,
    store: service.store,
    settings: readSettings,
    signal: lifecycle.signal,
    log: (line) => bb.log.warn(line),
    info: (line) => bb.log.info(line),
    changed: () => changed(),
    // A task moving to a chat there: the move keeps its sandbox up.
    skip: (sandboxId) => service.isMovingSandbox(sandboxId),
    // A dispatch, ship or wake in flight there: never suspended under it.
    held: (sandboxId) => service.holdsSandbox(sandboxId),
    // A headless task's finished agent left processes computing there (boat ps).
    computing: (sandboxId) => service.processesBusy(sandboxId),
    // The watchdog tells the keeper's planned stops from ones that cut work off.
    suspended: (hostId, underWork) => watchdogRef?.planned(hostId, underWork),
    stopsComputing: (sandboxId, deadline) => void watchdogRef?.headlessStopped({ sandboxId, stoppedAt: deadline, how: "auto-stop" }).catch(() => undefined),
  });

  // The watchdog: bb's record of Boat sandbox machines true to boat, chats
  // waiting on a stopped machine resumed, and a [boat] notice per incident.
  const watchdog = createWatchdog(bb, {
    boat,
    store: service.store,
    kv: bb.storage.kv,
    // The same boat ps readings the idle stop and the keeper go by.
    computing: (sandboxId) => service.processesBusy(sandboxId),
    tell: (threadId, text) => runtime.tellOrchestrator(threadId, text),
    // An orchestrator being handed over hears of it once its successor is in place.
    deferred: (threadId) => runtime.isHandingOver(threadId),
    // Relay progress and reset waits stay in-chat; only task needs-you/ready pushes are sent.
    notifyUser: async () => undefined,
    // A move, resize, dispatch, ship or wake there: the plugin is at it itself.
    held: (sandboxId) => service.holdsSandbox(sandboxId),
    suspended: (hostId) => service.noteSuspended(hostId),
    resumed: (hostId) => service.noteResumed(hostId),
    changed: () => changed(),
    log: (line) => bb.log.warn(line),
    info: (line) => bb.log.info(line),
    signal: lifecycle.signal,
  });
  watchdogRef = watchdog;
  // A message queued for a chat whose worker missed background work in a stop: the note goes in front.
  // One queued for a machine that's offline: check at once instead of on the next pass.
  bb.events.on("message.queued", (payload: unknown) => {
    const entry = (payload as { entry?: QueuedRow }).entry;
    if (entry === undefined || typeof entry.threadId !== "string") return;
    if (entry.waitingOn?.kind === "host-offline") wakeMonitor();
    void watchdog.queued(entry).catch(() => undefined);
  });
  // A message that carried the note: deleted before it ran, the note waits for the next one.
  bb.events.on("message.cancelled", (payload: unknown) => {
    const entry = (payload as { entry?: QueuedRow }).entry;
    if (entry !== undefined && typeof entry.id === "string") void watchdog.cancelled(entry).catch(() => undefined);
  });
  bb.events.on("message.dispatched", (payload: unknown) => {
    const entry = (payload as { entry?: QueuedRow }).entry;
    if (entry !== undefined && typeof entry.id === "string") watchdog.dispatched(entry);
  });
  // The same note for a message that would go straight to the worker: held a moment, once, to add it.
  // A withdrawn row bb grouped with newer input: remove it, then have bb dispatch the rest again.
  const releasing = new Set<string>();
  const releaseGroup = async (threadId: string, queuedMessageId: string) => {
    if (releasing.has(queuedMessageId)) return;
    releasing.add(queuedMessageId);
    try {
      for (let round = 0; round < RELEASE_ROUNDS && !lifecycle.signal.aborted; round++) {
        // Let bb queue the group on the plugin's wait first.
        await sleep(round === 0 ? 250 : RELEASE_RETRY_MS, lifecycle.signal);
        if ((await chatRunner.withdraw(threadId, queuedMessageId).catch(() => "stuck" as const)) !== "removed") continue;
        service.store.settleQueuedGuard(queuedMessageId, "removed");
        bb.log.info(`removed withdrawn queued message ${queuedMessageId} from ${threadId}; bb dispatches the messages grouped with it again`);
        // bb re-attempts every row queued on a plugin wait, through this hook again (SDK: experimental_hooks.recheck).
        await bb.experimental_hooks.recheck("message.dispatch");
        return;
      }
      if (!lifecycle.signal.aborted) {
        bb.log.warn(`couldn't remove withdrawn queued message ${queuedMessageId} from ${threadId}; the messages grouped with it stay queued, waiting on Boat, until it's deleted`);
      }
    } finally {
      releasing.delete(queuedMessageId);
    }
  };
  bb.experimental_hooks.on("message.dispatch", async (context) => {
    // A steer retry or chat recovery the plugin withdrew but bb's queue may still hold: never let it run.
    const queuedIds = context.queuedMessages.map((row) => row.id);
    const guarded = service.store.guardedQueuedMessage(queuedIds);
    if (guarded !== null && queuedIds.length <= 1) {
      bb.log.warn(`refused queued message ${guarded} in ${context.thread.id}: the plugin withdrew it, the chat moved on before it could run`);
      return { action: "reject", message: "Boat withdrew this automatic message: the chat moved on before it could run." };
    }
    if (guarded !== null) {
      // Grouped with newer input: refusing would refuse that too, and a hook can't take one row out of a group.
      // Hold the group (nothing is refused or lost), delete only the withdrawn row, then bb dispatches the rest again.
      bb.log.warn(`held a queued group in ${context.thread.id}: it carries withdrawn message ${guarded}, which the plugin removes before the rest goes out`);
      void releaseGroup(context.thread.id, guarded);
      return { action: "wait", reason: "Boat is removing an automatic message it withdrew; your messages go out right after." };
    }
    const start = await nativeStart(context, runtime, quotas);
    if (start?.action === "wait" || start?.action === "reject") return start;
    return watchdog.dispatch({
      threadId: context.thread.id,
      attempt: context.attempt,
      text: context.input.text,
      queued: context.queuedMessages as unknown as QueuedRow[],
      originPluginId: typeof context.originPluginId === "string" ? context.originPluginId : null,
    });
  });

  // Monitor: check running tasks, collect results, notify, stop idle sandboxes.
  bb.background.service("monitor", {
    async start(signal) {
      // bb stops services (with a short grace) before dispose hooks run, so
      // abort in-flight boat calls as soon as the service is stopped.
      const abortMonitor = () => { lifecycle.abort(); runtime.startQueue.dispose(); };
      signal.addEventListener("abort", abortMonitor, { once: true });
      if (signal.aborted) { abortMonitor(); return; }
      await watchdog.load().catch((error: unknown) => bb.log.warn(`watchdog notes: ${error instanceof Error ? error.message : String(error)}`));
      if (signal.aborted) return;
      let lastRelayAt = 0;
      while (!signal.aborted) {
        try {
          // Also delivers notices a restart or a failed send left pending.
          if (service.hasOpenWork()) await service.sweep();
          else await service.deliverPending();
          await nativeReviews.tick();
          await runtime.startQueue.tick();
          await attentionNotifications?.flush();
        } catch (error) {
          bb.log.warn(`monitor sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        // The relay: orchestrators move between Claude and Codex around usage limits.
        if (Date.now() - lastRelayAt >= RELAY_INTERVAL_MS) {
          lastRelayAt = Date.now();
          try {
            const actions = await runtime.relayTick();
            for (const action of actions) if (action.kind !== "skipped") bb.log.info(`relay ${action.threadId}: ${action.kind} (${action.reason})`);
            // Fresh usage numbers for open overviews.
            bb.rpc.experimental_invalidate([TAGS.relay]);
          } catch (error) {
            bb.log.warn(`relay failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        try {
          await keepSandboxesOn();
        } catch (error) {
          bb.log.warn(`machine keeper failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
          await watchdog.tick();
        } catch (error) {
          bb.log.warn(`watchdog failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        // Running turns are checked often; waiting tasks (idle-stop, notices) slowly.
        const intervalMs = service.hasActiveWork() ? POLL_INTERVAL_MS : 60_000;
        const wake = new AbortController();
        wakeMonitor = () => {
          wakeMonitor = () => undefined;
          // Give boat a moment to register the new turn.
          setTimeout(() => wake.abort(), 5_000);
        };
        await sleep(intervalMs, AbortSignal.any([signal, wake.signal]));
        wakeMonitor = () => undefined;
      }
    },
  });
}
