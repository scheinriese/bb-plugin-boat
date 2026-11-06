// RPC handlers behind the Cloud agents UI (contract in ../contract.ts).
import { experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { TAGS, rpcContract, type PreviewDto, type SandboxDto, type TaskDetailDto, type TaskDto, type TaskSourceDto, type ThreadRoleDto } from "../contract.ts";
import type { PreviewView } from "./previews.ts";
import { MACHINE_TYPES, assertBranch, autoStopHours, dashboardUrl, normalizeRepo, type MachineType, type Sandbox } from "./boat-api.ts";
import { BoatError, resolveBoatBinary } from "./boat.ts";
import { parseReport } from "./briefs.ts";
import { resultExcerpt } from "./format.ts";
import { bbProjectRepo, listLocalProjects, pushLocalBranch } from "./local-projects.ts";
import { alwaysProtectedBranches, protectedBranches } from "./projects.ts";
import type { Runtime } from "./runtime.ts";
import { DEFAULT_PROTOCOL } from "./default-protocol.ts";
import { MAX_PROTOCOL_CHARS } from "./protocol.ts";
import { TaskError } from "./service.ts";
import { DEFAULT_TIERS, tierMapSchema } from "./tiers.ts";
import { buildBoard, isReady, phaseOf, reviewState } from "./board.ts";
import { ConfigError, applyImport, changeCount, exportConfig, exportFileName, planImport, summarize } from "./config.ts";
import { CHAT_PROVIDER } from "./chat.ts";
import { OPEN_STATUSES, PROVIDERS, type Provider, type Task } from "./store.ts";
import { effectiveRelay, onlyAgent, relayNote } from "./relay.ts";
import { explainBoatError, sandboxSizes, testTaskInput, type ExplainedError } from "./setup.ts";
import { SettingsError, settingRows } from "./settings-store.ts";
import { SETTING_SECTIONS } from "./settings.ts";
import { MACHINE_PROVIDER_ID } from "./machine.ts";

/** Chats that are or were orchestrators (store.orchestratorThreadIds). */
export interface OrchestratorSets {
  current: Set<string>;
  former: Set<string>;
}

/** Who started a task: a real orchestrator (now or before), a plain chat, or the page. */
export function taskSource(task: Pick<Task, "orchestratorThreadId">, orchestrators: OrchestratorSets, title: (threadId: string) => string | null = () => null): TaskSourceDto {
  const threadId = task.orchestratorThreadId;
  if (threadId === null) return { kind: "page", threadId: null, title: null };
  const kind = orchestrators.current.has(threadId) || orchestrators.former.has(threadId) ? "orchestrator" : "chat";
  return { kind, threadId, title: title(threadId) };
}

/**
 * Work that ships after approval may wait in its sandbox: while a turn runs,
 * or when the end of the last one found commits or changed files (or
 * couldn't tell). False once that check found nothing.
 */
export function holdsUnshippedWork(task: Pick<Task, "delivery" | "role" | "turns" | "status" | "unshipped">): boolean {
  if (task.delivery !== "push" || task.role === "review" || task.turns === 0) return false;
  return task.status === "running" || task.status === "starting" || task.unshipped !== 0;
}

export function toTaskDto(
  task: Task,
  extras: { ready?: boolean; latestReview?: string | null; untrustedRepo?: boolean; previewUrl?: string | null; source?: TaskSourceDto; movingToChat?: boolean } = {},
): TaskDto {
  const report = task.result ? parseReport(task.result) : { status: null, verdict: null };
  const unshipped = holdsUnshippedWork(task);
  return {
    source:
      extras.source ??
      (task.orchestratorThreadId === null ? { kind: "page", threadId: null, title: null } : { kind: "chat", threadId: task.orchestratorThreadId, title: null }),
    phase: phaseOf(task, extras.ready ?? task.readyAt !== null),
    readyNote: task.readyNote,
    latestReview: extras.latestReview ?? null,
    previewUrl: extras.previewUrl ?? null,
    delivery: task.delivery,
    unshipped,
    canShip: unshipped && task.status === "idle",
    untrustedRepo: extras.untrustedRepo ?? false,
    movingToChat: extras.movingToChat ?? false,
    id: task.id,
    title: task.title,
    role: task.role,
    status: task.status,
    orchestratorThreadId: task.orchestratorThreadId,
    projectId: task.projectId,
    repo: task.repo,
    branch: task.branch,
    baseBranch: task.baseBranch,
    sandboxId: task.sandboxId,
    conversationId: task.conversationId,
    provider: task.provider,
    model: task.model,
    reasoningEffort: task.reasoningEffort,
    tier: task.tier,
    reason: task.reason,
    runner: task.runner,
    threadId: task.threadId,
    parentTaskId: task.parentTaskId,
    prUrl: task.prUrl,
    error: task.error,
    turns: task.turns,
    ownsSandbox: task.ownsSandbox,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
    reportStatus: report.status,
    verdict: report.verdict,
    excerpt: task.result ? resultExcerpt(task.result, 600) : null,
  };
}

/** A chat that runs on a Boat sandbox machine (sandboxUses). */
export interface MachineChat {
  sandboxId: string;
  threadId: string;
  title: string | null;
}

/**
 * What uses a sandbox: its open tasks first, then chats on it (a task's own
 * chat is that task), then closed tasks that kept it.
 */
export function sandboxUses(
  sandboxId: string,
  tasks: readonly Pick<Task, "id" | "title" | "status" | "sandboxId" | "threadId">[],
  chats: readonly MachineChat[],
  orchestrators: ReadonlySet<string>,
): SandboxDto["uses"] {
  const own = tasks.filter((task) => task.sandboxId === sandboxId);
  const open = own.filter((task) => OPEN_STATUSES.includes(task.status));
  const taskChats = new Set(own.map((task) => task.threadId).filter((id): id is string => id !== null));
  return [
    ...open.map((task) => ({ kind: "task" as const, id: task.id, title: task.title, open: true })),
    ...chats
      .filter((chat) => chat.sandboxId === sandboxId && !taskChats.has(chat.threadId))
      .map((chat) => ({ kind: orchestrators.has(chat.threadId) ? ("orchestrator" as const) : ("chat" as const), id: chat.threadId, title: chat.title, open: true })),
    ...own.filter((task) => !OPEN_STATUSES.includes(task.status)).map((task) => ({ kind: "task" as const, id: task.id, title: task.title, open: false })),
  ];
}

function toSandboxDto(sandbox: Sandbox, taskIds: string[], uses: SandboxDto["uses"] = []): SandboxDto {
  return {
    id: sandbox.id,
    name: sandbox.name,
    state: sandbox.state,
    health: sandbox.health,
    url: sandbox.url,
    createdAt: sandbox.createdAt,
    archiveAfter: sandbox.archiveAfter,
    dashboardUrl: dashboardUrl(sandbox.id),
    sshCommand: `boat ssh ${sandbox.id}`,
    taskIds,
    uses,
  };
}

function message(error: unknown): string {
  if (error instanceof BoatError) {
    // boat's failures in plain words, with what to do (signed out, no CLI, …).
    const explained = explainBoatError(error);
    return explained.hint ? `${explained.message} ${explained.hint}` : explained.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * A refusal the UI can explain: its message is "message hint" (older screens
 * show it as is); the plugin's code, the message and the hint ride in its
 * issues as paths ["code"], ["message"], ["hint"] (contract.ts rpcErrorInfo).
 */
export function refusal(code: "conflict" | "forbidden" | "invalid" | "not_found", error: ExplainedError): experimental_PluginRpcRefusal {
  return new experimental_PluginRpcRefusal({
    code,
    message: error.hint ? `${error.message} ${error.hint}` : error.message,
    issues: [
      { message: error.code, path: ["code"] },
      { message: error.message, path: ["message"] },
      ...(error.hint ? [{ message: error.hint, path: ["hint"] }] : []),
    ],
  });
}

/** Expected failures become RPC refusals the UI can show as-is. */
async function refuse<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof TaskError) {
      throw refusal(error.code === "task_not_found" ? "not_found" : "conflict", { code: error.code, message: error.message, hint: error.hint ?? null });
    }
    if (error instanceof BoatError) throw refusal(error.status === 404 ? "not_found" : "conflict", explainBoatError(error));
    throw error;
  }
}

export function registerRpc(runtime: Runtime): void {
  const latestReview = (task: Task) =>
    task.role === "implement" ? reviewState(runtime.service.store.latestEvent(task.id, "review")?.text) : null;
  /** A task for the UI, with its review state and whether it's ready for the user. */
  const untrusted = (task: Task) => runtime.service.untrustedRepo(task);
  const { bb, service } = runtime;

  // Chat titles for task sources, read in batches and kept a minute.
  const titleCache = new Map<string, { at: number; title: string | null }>();
  type TitleRow = { id?: string; title?: string | null; titleFallback?: string | null };
  const rowsOf = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { threads?: unknown[] } | null)?.threads ?? [])) as TitleRow[];
  async function threadTitles(ids: readonly string[]): Promise<Map<string, string | null>> {
    const now = Date.now();
    const missing = [...new Set(ids)].filter((id) => now - (titleCache.get(id)?.at ?? 0) > 60_000).slice(0, 200);
    if (missing.length > 0) {
      try {
        const found = new Map<string, string | null>();
        for (const row of rowsOf(await bb.sdk.threads.list({ threadIds: missing } as never))) if (row.id) found.set(row.id, row.title ?? row.titleFallback ?? null);
        const rest = missing.filter((id) => !found.has(id));
        if (rest.length > 0) {
          for (const row of rowsOf(await bb.sdk.threads.list({ threadIds: rest, archived: true, includeHidden: true } as never))) {
            if (row.id) found.set(row.id, row.title ?? row.titleFallback ?? null);
          }
        }
        for (const id of missing) titleCache.set(id, { at: now, title: found.get(id) ?? null });
      } catch {
        // Titles are a nicety; sources still say what started the task.
      }
    }
    return new Map(ids.map((id) => [id, titleCache.get(id)?.title ?? null]));
  }

  /** Chats on Boat sandbox machines, by sandbox (kept 30 s; [] when bb can't say). */
  let machineCache: { at: number; chats: MachineChat[] } | null = null;
  async function machineChats(): Promise<MachineChat[]> {
    if (machineCache !== null && Date.now() - machineCache.at < 30_000) return machineCache.chats;
    const chats: MachineChat[] = [];
    try {
      const raw = (await bb.sdk.hosts.list()) as unknown;
      const hosts = (Array.isArray(raw) ? raw : ((raw as { hosts?: unknown[] } | null)?.hosts ?? [])) as { id?: string; machineProviderId?: string | null }[];
      for (const host of hosts) {
        if (!host.id || host.machineProviderId !== MACHINE_PROVIDER_ID) continue;
        const resource = (await bb.experimental_machines.getResource(host.id).catch(() => null)) as { sandboxId?: unknown } | null;
        if (typeof resource?.sandboxId !== "string") continue;
        const rows = rowsOf(await bb.sdk.threads.list({ hostId: host.id } as never).catch(() => []));
        for (const row of rows) if (row.id) chats.push({ sandboxId: resource.sandboxId, threadId: row.id, title: row.title ?? row.titleFallback ?? null });
      }
    } catch {
      // Sandboxes still list; their rows just can't name the chats on them.
    }
    machineCache = { at: Date.now(), chats };
    return chats;
  }

  /** Sources for these tasks (one title batch), and which chats are orchestrators now. */
  async function sourcing(tasks: readonly Task[]) {
    const sets = service.store.orchestratorThreadIds();
    const titles = await threadTitles(tasks.map((task) => task.orchestratorThreadId).filter((id): id is string => id !== null));
    return {
      source: (task: Task) => taskSource(task, sets, (id) => titles.get(id) ?? null),
      isOrchestrator: (threadId: string) => sets.current.has(threadId),
    };
  }
  type Sourcing = Awaited<ReturnType<typeof sourcing>>;

  const dto = (task: Task, sources: Sourcing, all?: readonly Task[]) =>
    toTaskDto(task, {
      untrustedRepo: untrusted(task),
      movingToChat: service.isMovingToChat(task.id),
      latestReview: latestReview(task),
      // Without the list: marked ready, or started from the page or a plain chat.
      ready: all
        ? isReady(task, all, latestReview, sources.isOrchestrator)
        : task.status === "idle" && (task.readyAt !== null || task.orchestratorThreadId === null || !sources.isOrchestrator(task.orchestratorThreadId)),
      previewUrl: service.previewLinkFor(task.id),
      source: sources.source(task),
    });
  /** One task for a write's answer. */
  const single = async (task: Task) => dto(task, await sourcing([task]));
  const toPreviewDto = (view: PreviewView): PreviewDto => {
    const task = service.store.get(view.preview.taskId);
    return {
      id: view.preview.id,
      taskId: view.preview.taskId,
      taskTitle: task?.title ?? view.preview.title,
      orchestratorThreadId: task?.orchestratorThreadId ?? null,
      port: view.preview.port,
      path: view.preview.path,
      link: view.link,
      state: view.state,
      reason: view.reason,
      stopsAt: view.stopsAt,
      canRestart: view.preview.command !== null,
      updatedAt: view.preview.updatedAt,
    };
  };

  /** The last setup result the page was given: a different one refreshes everything. */
  let lastSetup: string | null = null;
  function setupChanged(status: { ok: boolean; summary: string } | null): boolean {
    if (status === null) return false;
    const key = `${status.ok}|${status.summary}`;
    const changed = key !== lastSetup;
    lastSetup = key;
    return changed;
  }

  /** Every setting as rows, with what the UI needs around them. */
  async function settingsResult() {
    const values = await runtime.settings.get();
    const only = onlyAgent((await service.settings()).agents);
    return {
      settings: settingRows(values, { onlyAgent: only }),
      sections: SETTING_SECTIONS.map((section) => ({ id: section.id, title: section.title })),
      onlyAgent: only,
      cliFound: resolveBoatBinary(values.boatPath) !== null,
      cliPath: resolveBoatBinary(values.boatPath),
    };
  }

  bb.rpc.register(rpcContract, {
    overview: async () => {
      const settings = await service.settings();
      const only = onlyAgent(settings.agents);
      const defaults = {
        implementProvider: only ?? settings.implementProvider,
        reviewProvider: only ?? settings.reviewProvider,
        machineType: settings.machineType,
        orchestratorMachineType: settings.orchestratorMachineType,
        freeSlotsWhenFull: settings.freeSlotsWhenFull,
        onlyAgent: only,
        autoFailover: settings.autoFailover && only === null,
      };
      const connect = await runtime.connectStatus();
      try {
        const capacity = await service.capacity();
        return {
          limits: capacity.limits
            ? {
                tier: capacity.limits.tier,
                summary: capacity.limits.summary,
                activeSandboxes: capacity.limits.activeSandboxes,
                maxActiveSandboxes: capacity.limits.maxActiveSandboxes,
                startsLeftToday: capacity.limits.startsLeftToday,
                canStart: capacity.limits.canStart,
              }
            : null,
          activeSandboxes: capacity.active.length,
          cap: capacity.cap,
          freeSlots: capacity.free,
          boatError: null,
          defaults,
          connect,
          taskChats: service.canRunChats(),
        };
      } catch (error) {
        return { limits: null, activeSandboxes: 0, cap: null, freeSlots: null, boatError: message(error), defaults, connect, taskChats: service.canRunChats() };
      }
    },

    sandboxes: async ({ all }) => {
      try {
        const [sandboxes, chats] = await Promise.all([service.boat.list({ all }), machineChats()]);
        const tasks = service.store.list({ limit: 1000 });
        const orchestrators = service.store.orchestratorThreadIds().current;
        return {
          sandboxes: sandboxes.map((sandbox) =>
            toSandboxDto(
              sandbox,
              tasks.filter((task) => task.sandboxId === sandbox.id).map((task) => task.id),
              sandboxUses(sandbox.id, tasks, chats, orchestrators),
            ),
          ),
          error: null,
        };
      } catch (error) {
        return { sandboxes: [], error: message(error) };
      }
    },

    tasks: async ({ statuses, threadId, limit }) => {
      const list = service.store.list({ statuses: statuses ?? undefined, orchestratorThreadId: threadId ?? undefined, limit });
      const sources = await sourcing(list);
      return { tasks: list.map((task, _index, all) => dto(task, sources, all)) };
    },

    task: async ({ id }) => {
      const task = service.store.resolve(id);
      if (task === null) return { task: null };
      const detail: TaskDetailDto = {
        ...dto(task, await sourcing([task]), service.store.list({ parentTaskId: task.id, limit: 50 }).concat(task)),
        brief: task.brief,
        result: task.result,
        events: service.store
          .events(task.id, 150)
          .filter((event) => event.kind !== "chat-info")
          .slice(-100)
          .map(({ at, kind, text }) => ({ at, kind, text })),
        dashboardUrl: task.sandboxId ? dashboardUrl(task.sandboxId) : null,
      };
      return { task: detail };
    },

    tasksByThread: async ({ keys }) => {
      const result: Record<string, TaskDto[]> = {};
      const lists = keys.slice(0, 200).map((threadId) => [threadId, service.store.list({ orchestratorThreadId: threadId, limit: 100 })] as const);
      const sources = await sourcing(lists.flatMap(([, tasks]) => tasks.slice(0, 1)));
      for (const [threadId, tasks] of lists) {
        const open = tasks.filter((task) => OPEN_STATUSES.includes(task.status));
        const closed = tasks.filter((task) => !OPEN_STATUSES.includes(task.status));
        result[threadId] = [...open, ...closed].map((task) => dto(task, sources, tasks));
      }
      return result;
    },

    transcript: async ({ id, limit }) => {
      const task = service.store.resolve(id);
      if (task === null || task.sandboxId === null || task.conversationId === null) {
        return { events: [], error: task === null ? `No task ${id}` : null };
      }
      try {
        const events = await service.boat.events(task.sandboxId, task.conversationId);
        return {
          events: events.slice(-limit).map((event) => ({
            type: event.type,
            status: event.status,
            content: event.content,
            error: event.error,
            timestamp: event.timestamp,
            tools: event.tools,
          })),
          error: null,
        };
      } catch (error) {
        return { events: [], error: message(error) };
      }
    },

    relay: async () => {
      const settings = await service.settings();
      const status = await runtime.relayStatus();
      return {
        enabled: effectiveRelay(settings.relay, settings.agents).enabled,
        onlyAgent: onlyAgent(settings.agents),
        preferred: settings.relay.preferred,
        switchAtPercent: settings.relay.switchAtPercent,
        avoidExtraUsage: settings.avoidExtraUsage,
        agents: PROVIDERS.filter((provider) => onlyAgent(settings.agents) === null || provider === settings.agents).map((provider) => {
          const quota = status.quotas.get(provider);
          return { provider, usedPercent: quota?.usedPercent ?? null, window: quota?.window ?? null, resetsAt: quota?.resetsAt ?? null };
        }),
        orchestrators: status.orchestrators.map((row) => ({
          threadId: row.threadId,
          provider: row.provider,
          note: relayNote(row.state, row.decision),
          waiting: row.state?.phase === "both-out" || row.state?.phase === "failed" || row.decision.kind === "stuck",
        })),
      };
    },

    orchestrators: async () => {
      // Real orchestrators only: a chat that just started a task isn't one.
      const known = new Map(service.store.orchestrators().map((row) => [row.threadId, row]));
      // Titles in one batch (archived threads included), so pickers can name old chats.
      const titles = new Map<string, string | null>();
      const live = new Set<string>();
      const archivedIds = new Set<string>();
      let liveKnown = false;
      const ids = [...known.keys()].slice(0, 200);
      if (ids.length > 0) {
        try {
          const raw = (await bb.sdk.threads.list({ threadIds: ids, archived: true, includeHidden: true } as never)) as unknown;
          const rows = (Array.isArray(raw) ? raw : ((raw as { threads?: unknown[] }).threads ?? [])) as {
            id?: string;
            title?: string | null;
            titleFallback?: string | null;
            archivedAt?: unknown;
          }[];
          for (const row of rows) {
            if (!row.id) continue;
            titles.set(row.id, row.title ?? row.titleFallback ?? null);
            if (row.archivedAt) archivedIds.add(row.id);
          }
          const current = (await bb.sdk.threads.list({ threadIds: ids } as never)) as unknown;
          const liveRows = (Array.isArray(current) ? current : ((current as { threads?: unknown[] }).threads ?? [])) as typeof rows;
          for (const row of liveRows) {
            if (!row.id) continue;
            live.add(row.id);
            if (!titles.has(row.id)) titles.set(row.id, row.title ?? row.titleFallback ?? null);
          }
          liveKnown = true;
        } catch {
          // Titles are a nicety; the list still works without them.
        }
      }
      return {
        orchestrators: [...known.values()].map(({ threadId, createdAt, projectId, projectName }) => {
          const tasks = service.store.list({ orchestratorThreadId: threadId, statuses: OPEN_STATUSES });
          return {
            threadId,
            title: titles.get(threadId) ?? null,
            createdAt,
            projectId,
            projectName,
            openTasks: tasks.length,
            runningTasks: tasks.filter((task) => task.status === "running" || task.status === "starting").length,
            needsAttention: tasks.filter((task) => task.status === "idle" || task.status === "failed").length,
            archived: archivedIds.has(threadId) || (liveKnown && !live.has(threadId)),
          };
        }),
      };
    },

    hosts: async () => {
      const config = (await bb.sdk.system.config()) as { primaryHostId?: string | null };
      const raw = (await bb.sdk.hosts.list()) as unknown;
      const list = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { hosts?: unknown[] }).hosts)
          ? (raw as { hosts: unknown[] }).hosts
          : [];
      return {
        hosts: list
          .map((entry) => entry as { id?: string; name?: string | null; status?: string | null; connectionStatus?: string | null })
          .filter((host): host is { id: string; name?: string | null; status?: string | null; connectionStatus?: string | null } =>
            typeof host.id === "string",
          )
          .map((host) => ({
            id: host.id,
            name: host.name ?? host.id,
            status: host.connectionStatus ?? host.status ?? "unknown",
            primary: host.id === config.primaryHostId,
          })),
      };
    },

    startTask: (input) =>
      refuse(async () => {
        const { task, pending } = await service.launchTask(
          {
            title: input.title,
            brief: input.brief,
            role: input.role,
            repo: input.repo || null,
            branch: input.branch || null,
            baseBranch: input.baseBranch || null,
            provider: (input.provider as Provider | null) ?? null,
            model: input.model || null,
            tier: input.tier ?? null,
            reasoningEffort: input.effort ?? null,
            // The user is the one clicking: their choice is the approval.
            userApproved: true,
            sandbox: input.sandbox || null,
            machineType: (input.machineType as MachineType | null) ?? null,
            orchestratorThreadId: input.notifyThreadId,
            project: input.projectId ? await runtime.resolveProject({ kind: "boat", id: input.projectId }) : null,
            runner: input.runner ?? null,
            // Like Ship: the user's click past the warning is the confirm.
            confirmUntrustedChat: input.confirmUntrustedChat ?? null,
          },
          runtime.launchWaitMs,
        );
        runtime.wake();
        return { task: await single(task), pending };
      }),

    continueAsChatStatus: ({ id }) => refuse(() => service.continueAsChatStatus(id)),

    continueAsChat: ({ id, confirmUntrusted }) =>
      refuse(async () => {
        // The page doesn't wait for bb's install: it shows "Moving to a chat…" until it's done.
        const { task, pending } = await service.continueAsChat(id, {
          // Like Ship: the user's click past the warning (and their tick) is the confirm.
          confirmUntrusted,
          via: "page",
          waitMs: runtime.launchWaitMs,
          waitFor: "checks",
        });
        runtime.wake();
        return { task: await single(task), pending };
      }),

    startTestTask: ({ notifyThreadId, provider }) =>
      refuse(async () => {
        const { task, pending } = await service.launchTask({ ...testTaskInput(notifyThreadId), provider: (provider as Provider | null) ?? null }, runtime.launchWaitMs);
        runtime.wake();
        return { task: await single(task), pending };
      }),

    setup: async ({ force }) => {
      if (runtime.setup === null) throw new experimental_PluginRpcRefusal({ code: "conflict", message: "Setup checks aren't available." });
      return runtime.setup.status({ force });
    },

    settings: () => settingsResult(),

    saveSettings: ({ values }) =>
      refuse(async () => {
        try {
          await runtime.settings.set(values);
        } catch (error) {
          if (error instanceof SettingsError) {
            throw refusal("invalid", { code: "invalid_setting", message: error.problems.join(" "), hint: null });
          }
          throw error;
        }
        runtime.changed();
        return settingsResult();
      }),

    sandboxSizes: async () => {
      const settings = await service.settings();
      // Without waiting on boat once there's a reading (a stale one refreshes in the background).
      const reading = runtime.setup ? (runtime.setup.peek()?.facts ?? (await runtime.setup.reading().catch(() => null))) : null;
      const plan = reading?.plan ?? null;
      const capHours = plan?.autoStopCapHours ?? null;
      return {
        sizes: sandboxSizes(MACHINE_TYPES, plan).map((size) => ({ ...size, type: size.type as MachineType })),
        taskDefault: settings.machineType,
        chatDefault: settings.orchestratorMachineType,
        autoStopCapHours: capHours,
        autoStopHours: autoStopHours(settings.sandboxTtlHours, capHours),
        plan: plan?.name ?? null,
        known: plan !== null,
      };
    },

    applySetupFix: ({ action }) =>
      refuse(async () => {
        if (runtime.setup === null) throw new TaskError("Setup checks aren't available.", "setup_unavailable");
        // (A settings change refreshes every open screen by itself.)
        if (action === "use-detected-agents") await runtime.config.settings.set({ agents: "auto" });
        const status = await runtime.setup.status({ force: action !== "use-detected-agents" });
        // The Sign in… wait checks every few seconds: only a changed result
        // refreshes the rest of the page (plan, sandboxes, board).
        if (setupChanged(status)) runtime.changed();
        else bb.rpc.experimental_invalidate([TAGS.setup]);
        return status;
      }),

    review: (input) =>
      refuse(async () => {
        const parent = service.mustGet(input.id);
        const reviewInput = await service.reviewInput(parent.id, {
          brief: input.brief,
          provider: (input.provider as Provider | null) ?? null,
          sandbox: input.sandbox,
          orchestratorThreadId: parent.orchestratorThreadId,
          projectId: parent.projectId,
        });
        const { task, pending } = await service.launchTask(reviewInput, runtime.launchWaitMs);
        runtime.wake();
        return { task: await single(task), pending };
      }),

    followup: (input) =>
      refuse(async () => {
        const task = await service.followup(input.id, input.message, {
          steer: input.steer,
          provider: (input.provider as Provider | null) ?? null,
          model: input.model,
          userApproved: true,
        });
        runtime.wake();
        return { task: await single(task) };
      }),

    interrupt: ({ id }) =>
      refuse(async () => {
        const task = await service.interruptTask(id);
        service.store.addEvent(task.id, "interrupted", "Interrupted from the Cloud agents page");
        runtime.wake();
        return { ok: true as const };
      }),

    closeTask: ({ id, cancel, keepSandbox, discard }) =>
      refuse(async () => {
        const result = await service.closeTask(id, {
          status: cancel ? "cancelled" : "done",
          keepSandbox: keepSandbox ? true : undefined,
          discard: discard === true,
        });
        return { task: await single(result.task), sandbox: result.sandbox };
      }),

    previews: ({ threadId, taskId }) =>
      refuse(async () => {
        const views = await service.previews({ ...(taskId ? { taskId } : {}), orchestratorThreadId: threadId, includeExpired: true });
        return { previews: views.map(toPreviewDto) };
      }),

    previewAction: ({ id, action, hours }) =>
      refuse(async () => {
        const view =
          action === "wake" ? await service.wakePreview(id) : action === "extend" ? await service.extendPreview(id, hours ?? 2) : await service.stopPreview(id);
        runtime.changed();
        return { preview: toPreviewDto(view) };
      }),

    shipTask: ({ id, keepOpen, from }) =>
      refuse(async () => {
        // The user's click (on the page, or Ship in the task chat's header) is the approval.
        const place = from === "chat" ? "in the task chat" : "on the overview";
        const result = await service.shipTask(id, { keepOpen: keepOpen === true, approval: `by the user ${place}` });
        const task = result.task;
        if (task.orchestratorThreadId) {
          const where = result.shipped.map((entry) => `${entry.baseBranch} (${entry.sha.slice(0, 7)}, ${entry.commits} commit${entry.commits === 1 ? "" : "s"})`).join(", ");
          await runtime
            .tellOrchestrator(task.orchestratorThreadId, `[boat] The user shipped task ${task.id} "${task.title}" to ${where} ${from === "chat" ? "from the task chat" : "from the overview"}.${result.sandbox === "deleted" ? " The task is closed and its sandbox deleted." : ""} Mention it in your next update.`)
            .catch(() => undefined);
        }
        runtime.changed();
        return { task: await single(task), shipped: result.shipped.map(({ baseBranch, sha, commits }) => ({ baseBranch, sha, commits })), sandbox: result.sandbox };
      }),

    projectAccess: ({ projectId }) =>
      refuse(async () => {
        const project = runtime.projects.get(projectId);
        if (project === null) throw new experimental_PluginRpcRefusal({ code: "not_found", message: `No project "${projectId}".` });
        return await service.projectAccess(project);
      }),

    snapshots: async () => {
      try {
        const result = await service.snapshots();
        return {
          snapshots: result.snapshots.map(({ name, sizeBytes, createdAt, type }) => ({ name, sizeBytes, createdAt, type })),
          included: result.included,
          used: result.used,
          error: null,
        };
      } catch (error) {
        return { snapshots: [], included: null, used: null, error: message(error) };
      }
    },

    createSandbox: (input) =>
      refuse(async () => {
        let repo: string | null;
        let branch: string | null;
        try {
          repo = input.repo ? normalizeRepo(input.repo) : null;
          branch = input.branch ? assertBranch(input.branch) : null;
        } catch (error) {
          throw new experimental_PluginRpcRefusal({ code: "invalid", message: message(error) });
        }
        const sandbox = await service.createSandbox({
          name: input.name || `bb sandbox ${new Date().toISOString().slice(0, 16)}`,
          type: (input.machineType as MachineType | null) ?? null,
        });
        if (repo !== null) {
          const always = alwaysProtectedBranches((await service.settings()).extraProtectedBranches);
          try {
            await service.boat.prepareRepo(
              sandbox.id,
              repo,
              branch ? { kind: "new-branch", branch, base: null } : { kind: "default-branch" },
              { protect: protectedBranches(null, service.projectBaseBranches([repo]), always), alwaysProtect: always },
            );
          } catch (error) {
            await service.boat.delete(sandbox.id).catch(() => undefined);
            throw error;
          }
        }
        runtime.changed();
        return { sandbox: toSandboxDto(sandbox, []) };
      }),

    saveSnapshot: ({ sandboxId, name }) => refuse(() => service.saveSnapshot(sandboxId, name)),

    sandboxAction: ({ id, action }) =>
      refuse(async () => {
        const settings = await service.settings();
        const { limits } = await service.capacity();
        const hours = autoStopHours(settings.sandboxTtlHours, limits?.autoStopCapHours ?? null);
        if (action !== "delete") await service.sandboxAction(id, action, Math.round(hours * 3600));
        else {
          const live = service.store.liveSandboxTasks(id);
          await service.sandboxAction(id, "delete", 0);
          for (const task of live) {
            service.store.update(task.id, { status: "cancelled", finishedAt: new Date().toISOString() });
            service.store.expirePreviews(task.id);
            service.store.addEvent(task.id, "cancelled", `Sandbox ${id} deleted from the Cloud agents page`);
          }
        }
        runtime.changed();
        return { ok: true as const };
      }),

    startOrchestrator: (input) =>
      refuse(async () => {
        const { threadId, movedTaskIds } = await runtime.startOrchestrator({
          project: input.project,
          hostId: input.hostId,
          cloud: input.cloud ?? false,
          title: input.title,
          prompt: input.prompt,
          takeOver:
            input.takeOverThreadId || input.takeOverText
              ? { threadId: input.takeOverThreadId ?? null, text: input.takeOverText ?? null, fileName: input.takeOverFileName ?? null }
              : null,
        });
        return { threadId, movedTaskIds };
      }),

    projects: async () => ({ projects: runtime.projects.list() }),

    orchestratorProjects: async () => {
      try {
        return { projects: runtime.projects.list(), local: await listLocalProjects(bb, runtime.projects), localError: null };
      } catch (error) {
        return { projects: runtime.projects.list(), local: [], localError: message(error) };
      }
    },

    saveProject: async (input) => {
      try {
        const project = runtime.projects.save(input);
        runtime.changed();
        return { project };
      } catch (error) {
        throw new experimental_PluginRpcRefusal({ code: "invalid", message: message(error) });
      }
    },

    deleteProject: async ({ id }) => {
      if (!runtime.projects.delete(id)) throw new experimental_PluginRpcRefusal({ code: "not_found", message: `No project "${id}".` });
      runtime.changed();
      return { ok: true as const };
    },

    pushLocalBranch: ({ bbProjectId, branch }) =>
      refuse(async () => {
        try {
          const always = alwaysProtectedBranches((await service.settings()).extraProtectedBranches);
          const local = await pushLocalBranch(bb, runtime.projects, bbProjectId, branch, always);
          runtime.changed();
          return { local };
        } catch (error) {
          throw new experimental_PluginRpcRefusal({ code: "conflict", message: `git push failed: ${message(error)}` });
        }
      }),

    setOrchestrator: ({ threadId, on, project }) =>
      refuse(async () => {
        if (on && service.store.byThread(threadId)?.runner === "chat") {
          throw new TaskError(
            "This chat runs a task, so it can't coordinate other tasks.",
            "invalid_value",
            "Coordinate from the chat that started the task, or start a new orchestrator.",
          );
        }
        // Like `bb boat orchestrator on --project`: the project is checked first.
        const resolved = on && project ? await runtime.resolveProject(project) : null;
        await runtime.setOrchestrator(threadId, on, resolved);
        return { ok: true as const };
      }),

    bbProjectRepo: async ({ bbProjectId }) => {
      const repo = await bbProjectRepo(bb, bbProjectId).catch(() => null);
      if (repo === null) return { repo: null, projectId: null };
      // The project whose main repo it is, else one that includes it.
      const lower = repo.toLowerCase();
      const match =
        runtime.projects.forRepo(repo) ??
        runtime.projects.list().find((project) => project.repos.some((entry) => entry.repo.toLowerCase() === lower)) ??
        null;
      return { repo, projectId: match?.id ?? null };
    },

    threadRoles: async ({ keys }) => {
      const orchestrators = service.store.orchestratorThreadIds().current;
      const found = keys.slice(0, 500).map((threadId) => {
        const task = orchestrators.has(threadId) ? null : service.store.byThread(threadId);
        return [threadId, task !== null && task.runner === "chat" ? task : null] as const;
      });
      const tasks = found.flatMap(([, task]) => (task === null ? [] : [task]));
      const sources = tasks.length > 0 ? await sourcing(tasks) : null;
      const result: Record<string, ThreadRoleDto> = {};
      for (const [threadId, task] of found) {
        result[threadId] = orchestrators.has(threadId)
          ? { kind: "orchestrator" }
          : task !== null && sources !== null
            ? { kind: "task", task: dto(task, sources) }
            : { kind: "chat" };
      }
      return result;
    },

    refresh: async () => {
      // Read boat.dev again for the setup checklist too (a sign-out shows at once).
      if (runtime.setup !== null) setupChanged(await runtime.setup.status({ force: true }).catch(() => null));
      await service.sweep();
      runtime.changed();
      return { ok: true as const };
    },

    protocol: async () => {
      const file = runtime.protocol.read();
      return { ...file, defaultText: DEFAULT_PROTOCOL, maxChars: MAX_PROTOCOL_CHARS };
    },
    saveProtocol: ({ text }) =>
      refuse(async () => {
        try {
          runtime.protocol.save(text);
        } catch (error) {
          throw new TaskError(error instanceof Error ? error.message : String(error), "invalid_protocol");
        }
        runtime.changed();
        return { ok: true as const };
      }),
    resetProtocol: () =>
      refuse(async () => {
        runtime.protocol.reset();
        runtime.changed();
        return { ok: true as const };
      }),
    modelTiers: async () => {
      const { tiers, custom } = await runtime.modelTiers();
      return { tiers, defaults: DEFAULT_TIERS, custom };
    },
    saveModelTiers: ({ tiers }) =>
      refuse(async () => {
        const parsed = tierMapSchema.safeParse(tiers);
        if (!parsed.success) throw new TaskError(parsed.error.issues[0]?.message ?? "Invalid model presets.", "invalid_tiers");
        await runtime.saveModelTiers(parsed.data);
        return { ok: true as const };
      }),
    resetModelTiers: () =>
      refuse(async () => {
        await runtime.saveModelTiers(null);
        return { ok: true as const };
      }),

    exportConfig: async () => {
      const file = await exportConfig(runtime.config);
      return { fileName: exportFileName(new Date(file.exportedAt)), text: `${JSON.stringify(file, null, 2)}\n` };
    },
    previewConfigImport: async ({ text, replaceProjects }) => {
      try {
        const plan = await planImport(runtime.config, text, { replaceProjects });
        return { problems: plan.problems, changes: changeCount(plan), sections: summarize(plan) };
      } catch (error) {
        if (error instanceof ConfigError) return { problems: error.problems, changes: 0, sections: [] };
        throw error;
      }
    },
    importConfig: async ({ text, replaceProjects }) => {
      try {
        const plan = await planImport(runtime.config, text, { replaceProjects });
        await applyImport(runtime.config, plan);
        runtime.changed();
        return { problems: [], changes: changeCount(plan), sections: summarize(plan) };
      } catch (error) {
        const reason = error instanceof ConfigError ? error.message : `The import failed: ${message(error)}`;
        throw new experimental_PluginRpcRefusal({ code: "invalid", message: reason });
      }
    },

    board: async ({ threadId }) => {
      // Every open task, plus enough closed ones for Done (newest finished first).
      const scope = threadId ?? undefined;
      const tasks = [
        ...service.store.list({ orchestratorThreadId: scope, statuses: OPEN_STATUSES, limit: 1000 }),
        ...service.store.list({ orchestratorThreadId: scope, statuses: ["done", "cancelled"], limit: 200 }),
      ];
      const decisions = service.store.decisions({ orchestratorThreadId: threadId, statuses: ["open"] });
      const sources = await sourcing(tasks);
      // A finished turn of a page or plain-chat task is ready for the user (and counts in the badge).
      const board = buildBoard({ tasks, decisions, latestVerdict: latestReview, isOrchestrator: sources.isOrchestrator });
      const toDecisionDto = (decision: (typeof decisions)[number]) => ({
        id: decision.id,
        orchestratorThreadId: decision.orchestratorThreadId,
        question: decision.question,
        recommendation: decision.recommendation,
        options: decision.options,
        taskIds: decision.taskIds,
        status: decision.status,
        answer: decision.answer,
        createdAt: decision.createdAt,
      });
      return {
        needsYou: board.needsYou.map(toDecisionDto),
        ready: board.ready.map((task) =>
          toTaskDto(task, { ready: true, latestReview: latestReview(task), untrustedRepo: untrusted(task), movingToChat: service.isMovingToChat(task.id), previewUrl: service.previewLinkFor(task.id), source: sources.source(task) }),
        ),
        running: board.running.map((task) =>
          toTaskDto(task, { ready: false, latestReview: latestReview(task), untrustedRepo: untrusted(task), movingToChat: service.isMovingToChat(task.id), previewUrl: service.previewLinkFor(task.id), source: sources.source(task) }),
        ),
        done: board.done.map((task) => toTaskDto(task, { latestReview: latestReview(task), untrustedRepo: untrusted(task), source: sources.source(task) })),
      };
    },

    answerDecision: ({ id, accept, answer }) =>
      refuse(async () => {
        const decision = service.store.decision(id);
        if (decision === null) throw new TaskError(`No decision ${id}.`, "not_found");
        if (decision.status !== "open") throw new TaskError(`Decision ${id} is already ${decision.status}.`, "decision_closed");
        const text = accept ? `Go with your recommendation: ${decision.recommendation}` : (answer ?? "").trim();
        if (text === "") throw new TaskError("Write an answer, or accept the recommendation.", "invalid_value");
        // The orchestrator hears it like any message from the user, if it's still there.
        let delivered = false;
        if (decision.orchestratorThreadId) {
          const thread = (await runtime.bb.sdk.threads.get({ threadId: decision.orchestratorThreadId }).catch(() => null)) as {
            archivedAt?: unknown;
            deletedAt?: unknown;
            thread?: { archivedAt?: unknown; deletedAt?: unknown };
          } | null;
          const record = thread?.thread ?? thread;
          if (record && !record.archivedAt && !record.deletedAt) {
            await runtime.bb.sdk.threads.send({
              threadId: decision.orchestratorThreadId,
              mode: "queue-if-active",
              input: [{ type: "text", text: `Decision ${decision.id}: ${decision.question}\n${text}`, mentions: [] }],
            } as never);
            delivered = true;
          }
        }
        service.store.resolveDecision(id, "answered", text);
        runtime.changed();
        return { ok: true as const, delivered };
      }),

    dismissDecision: ({ id }) =>
      refuse(async () => {
        if (service.store.resolveDecision(id, "withdrawn", null) === null) {
          throw new TaskError(`Decision ${id} is already closed.`, "decision_closed");
        }
        runtime.changed();
        return { ok: true as const };
      }),

    workspaceChats: async ({ threadId }) => {
      const task = service.store.byThread(threadId);
      if (task === null || task.runner !== "chat") return { workspace: null };
      const chats = [];
      // The task's chats, plus those of tasks sharing its workspace (a reviewer reading the checkout).
      const sharing = task.environmentId
        ? service.store.list({ limit: 1000 }).filter((other) => other.id !== task.id && other.environmentId === task.environmentId && other.runner === "chat")
        : [];
      const info = new Map([...service.chatInfo(task.id), ...sharing.flatMap((other) => [...service.chatInfo(other.id)])]);
      const chatIds = [...new Set([...service.store.chatThreads(task.id), ...sharing.flatMap((other) => service.store.chatThreads(other.id))])];
      const currentChats = new Set([task.threadId, ...sharing.map((other) => other.threadId)].filter(Boolean));
      for (const chatId of chatIds) {
        let title: string | null = null;
        let providerId: string | null = null;
        let archived = false;
        try {
          const raw = (await runtime.bb.sdk.threads.get({ threadId: chatId })) as unknown as {
            thread?: { title?: string | null; titleFallback?: string | null; providerId?: string | null; archivedAt?: unknown };
            title?: string | null;
            titleFallback?: string | null;
            providerId?: string | null;
            archivedAt?: unknown;
          };
          const thread = raw.thread ?? raw;
          title = thread.title ?? thread.titleFallback ?? null;
          providerId = thread.providerId ?? null;
          archived = Boolean(thread.archivedAt);
        } catch {
          archived = true;
        }
        const known = info.get(chatId);
        const provider = (Object.entries(CHAT_PROVIDER).find(([, id]) => id === providerId)?.[0] ?? known?.provider ?? null) as Provider | null;
        const current = currentChats.has(chatId);
        const owner = chatId === task.threadId ? task : (sharing.find((other) => other.threadId === chatId) ?? null);
        chats.push({
          threadId: chatId,
          title,
          provider,
          model: owner ? owner.model : (known?.model ?? null),
          effort: owner ? owner.reasoningEffort : (known?.effort ?? null),
          current,
          archived,
        });
      }
      const open = task.status !== "done" && task.status !== "cancelled";
      return {
        workspace: {
          taskId: task.id,
          taskTitle: task.title,
          orchestratorThreadId: task.orchestratorThreadId,
          source: (await sourcing([task])).source(task),
          open,
          environmentId: task.environmentId,
          chats,
        },
      };
    },

    newWorkspaceChat: ({ threadId, request }) =>
      refuse(async () => {
        const task = service.store.byThread(threadId);
        if (task === null || task.runner !== "chat") throw new TaskError("This chat isn't a task chat.", "not_a_worker");
        const opened = await service.openWorkspaceChat(task.id, request);
        runtime.changed();
        return { threadId: opened };
      }),
  });
}

