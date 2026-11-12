// Worker chats: a task's agent runs as a regular bb chat on its boat sandbox.
// The service decides what to do; this is how it asks bb to do it.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hasWork, readMachineActivity, rowWork, type MachineActivity, type ThreadRow } from "./activity.ts";
import { MACHINE_PROVIDER_ID, keepSandboxKey } from "./machine.ts";
import { threadSection } from "./sections.ts";
import { TURN_EVENT_TYPES, type TurnEventRow } from "./steer-retry.ts";
import type { Provider } from "./store.ts";

export const PERSONAL_PROJECT = "proj_personal";

/** bb's agent provider for each of our agents. */
export const CHAT_PROVIDER: Record<Provider, string> = { claude: "claude-code", codex: "codex" };

export type ChatWhere =
  /** A machine of its own (or shared): a fresh workspace in the checkout. */
  | { kind: "machine"; hostId: string; path: string | null }
  /** The same workspace as another chat (a reviewer, a handover). */
  | { kind: "environment"; environmentId: string };

export interface ChatSpawn {
  taskId: string;
  title: string;
  prompt: string;
  provider: Provider;
  model: string | null;
  effort: string | null;
  /** The orchestrator: the chat nests under it and wakes it when a turn ends. */
  parentThreadId: string | null;
  /** bb project for the chat (the orchestrator's); null = personal. */
  projectId: string | null;
  where: ChatWhere;
}

/** What bb's own new-chat composer submits (forwarded to threads.spawn unchanged). */
export interface ComposerRequest {
  providerId: string;
  model: string;
  reasoningLevel: string;
  permissionMode: string;
  serviceTier?: string;
  sessionOptions?: Record<string, unknown>;
  executionInputSources?: Record<string, unknown>;
  input: unknown[];
}

export interface ChatState {
  status: "starting" | "pending" | "active" | "stopping" | "idle" | "error";
  /** Epoch ms of the chat's last change (activity). */
  updatedAt: number | null;
  archived: boolean;
  /** bb fills in the chat's workspace after the spawn returns. */
  environmentId: string | null;
  /** Messages waiting to run (a queued follow-up, a provider retry). */
  queued: number;
  /** Background agents still running after the turn's reply. */
  backgroundAgents: number;
  /** bb workflows still running after the turn's reply (bb's thread list; the thread page doesn't say). */
  workflows?: number;
  /** bb's agent provider for the chat (codex, claude-code, …), when bb says. */
  providerId?: string | null;
}

/** What a send did: started (or joined) a turn now, or left a row in bb's queue. */
export type SendResult = { delivery: "sent" } | { delivery: "queued"; queuedMessageId: string | null; waitingOn: string | null };

/** A bb machine as bb sees it (hosts.get): its lifecycle phase and connection. */
export interface MachineState {
  /** active, creating, resuming, suspended, suspending, removing, destroyed (null: unknown). */
  phase: string | null;
  connected: boolean;
  /** bb's lifecycle message (a failed resume says why). */
  message: string | null;
}

export interface ChatRunner {
  /**
   * Install bb on a prepared sandbox; returns the bb machine id and the key it
   * was created with. keepSandbox: the sandbox holds a headless task's work
   * (Continue as a chat): a new key per try, and the sandbox outlives the
   * machine until settleMachine.
   */
  attachMachine(args: { taskId: string; sandboxId: string; signal?: AbortSignal; keepSandbox?: boolean }): Promise<{ hostId: string; key: string }>;
  /** Undo an attach made with keepSandbox: bb forgets the machine, the sandbox stays. */
  detachMachine(hostId: string, key: string): Promise<void>;
  /** Keep a machine's sandbox when the machine goes (for a move that reuses it). Returns false when it was kept already. */
  protectSandbox(key: string, sandboxId: string): Promise<boolean>;
  /** The move is done: removing the machine deletes its sandbox again, like any task chat's. */
  settleMachine(key: string): Promise<void>;
  /** The key a machine was created with (null: unknown). */
  machineKey(hostId: string): Promise<string | null>;
  /** Write a file on a bb machine (parent folders created, only the owner can read it). */
  writeFile(hostId: string, path: string, content: string): Promise<void>;
  /** Remove a machine (bb deletes its sandbox through the machine provider). */
  removeMachine(hostId: string): Promise<void>;
  /** Suspend a machine through bb (boat stops the sandbox; bb resumes it on the next message). */
  suspendMachine(hostId: string): Promise<void>;
  resumeMachine(hostId: string): Promise<void>;
  /** The bb machine wrapping this sandbox, if any (e.g. one whose attach was cut short). */
  findMachine(sandboxId: string): Promise<string | null>;
  /** The machine's phase and connection (null: bb doesn't know it). */
  machineState(hostId: string): Promise<MachineState | null>;
  /** Any chat on the machine is working, a message waits there, or work runs in the background (every thread on it, not only the plugin's). */
  machineBusy(hostId: string): Promise<boolean>;
  /**
   * What bb reports running on the machine: turns, queued messages, and
   * background work (background agents and commands, bb workflows, working
   * child chats). Throws when bb can't list its chats.
   */
  machineActivity(hostId: string): Promise<MachineActivity>;
  spawn(args: ChatSpawn): Promise<{ threadId: string; environmentId: string | null }>;
  /** A chat the user composed in bb's own composer, placed in a worker's workspace. */
  spawnComposed(args: {
    taskId: string;
    request: ComposerRequest;
    parentThreadId: string | null;
    projectId: string | null;
    environmentId: string;
  }): Promise<{ threadId: string }>;
  /** Put a chat someone opened in a worker's workspace under the orchestrator (and its section). */
  adopt(threadId: string, parentThreadId: string): Promise<void>;
  send(
    threadId: string,
    text: string,
    options: { steer: boolean; model?: string | null; effort?: string | null },
  ): Promise<SendResult>;
  /**
   * Take a message the plugin sent back out of bb's queue before it runs:
   * "removed" once bb's queue no longer lists it (a delete is retried a few
   * times, a moment apart), "stuck" when it still does.
   */
  withdraw(threadId: string, queuedMessageId: string): Promise<"removed" | "stuck">;
  /** null: the chat no longer exists. */
  state(threadId: string): Promise<ChatState | null>;
  output(threadId: string): Promise<string | null>;
  /** The chat's latest turn lifecycle events (requests, accepted inputs, turn starts and ends, provider errors). */
  turnEvents(threadId: string): Promise<TurnEventRow[]>;
  stop(threadId: string): Promise<void>;
  archive(threadId: string): Promise<void>;
}

const STATES = new Set(["starting", "pending", "active", "stopping", "idle", "error"]);

function asEpoch(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isNotFound(error: unknown): boolean {
  return /not[ _]found|404/i.test(error instanceof Error ? error.message : String(error));
}

/** Waits between tries to delete a queued message (three tries, about 1.5 s in all). */
const WITHDRAW_BACKOFF_MS = [300, 1_200];

export function createChatRunner(bb: BbPluginApi, options: { withdrawBackoffMs?: readonly number[] } = {}): ChatRunner {
  const backoffMs = options.withdrawBackoffMs ?? WITHDRAW_BACKOFF_MS;
  return {
    async attachMachine({ taskId, sandboxId, signal, keepSandbox }) {
      const key = keepSandbox ? `task-${taskId}-m${Date.now().toString(36)}` : `task-${taskId}`;
      // Before bb runs the provider: a failed or cut-short creation can't delete the sandbox.
      if (keepSandbox) await bb.storage.kv.set(keepSandboxKey(key), sandboxId);
      const host = (await bb.sdk.hosts.experimental_create({
        machineProviderId: MACHINE_PROVIDER_ID,
        inputs: keepSandbox ? { sandboxId, taskId, keepSandbox: true } : { sandboxId, taskId },
        key,
        wait: true,
        ...(signal ? { signal } : {}),
      })) as unknown as { id?: string; hostId?: string; host?: { id?: string } };
      const hostId = host.id ?? host.hostId ?? host.host?.id;
      if (typeof hostId !== "string") throw new Error("bb did not return the new machine's id");
      return { hostId, key };
    },

    async detachMachine(hostId, key) {
      const resource = (await bb.experimental_machines.getResource(hostId).catch(() => null)) as { sandboxId?: string } | null;
      if (typeof resource?.sandboxId === "string") await bb.storage.kv.set(keepSandboxKey(key), resource.sandboxId);
      await bb.sdk.hosts.delete({ hostId } as never).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
    },

    async protectSandbox(key, sandboxId) {
      if (typeof (await bb.storage.kv.get<string>(keepSandboxKey(key))) === "string") return false;
      await bb.storage.kv.set(keepSandboxKey(key), sandboxId);
      return true;
    },

    async settleMachine(key) {
      await bb.storage.kv.delete(keepSandboxKey(key));
    },

    async machineKey(hostId) {
      const resource = (await bb.experimental_machines.getResource(hostId).catch(() => null)) as { key?: unknown } | null;
      return typeof resource?.key === "string" ? resource.key : null;
    },

    async writeFile(hostId, path, content) {
      await bb.sdk.files.write({ hostId, path, content, contentEncoding: "utf8", createParents: true, mode: 0o600 } as never);
    },

    async removeMachine(hostId) {
      await bb.sdk.hosts.delete({ hostId } as never).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
    },

    async suspendMachine(hostId) {
      await bb.sdk.hosts.experimental_suspend({ hostId } as never);
    },

    async resumeMachine(hostId) {
      await bb.sdk.hosts.experimental_resume({ hostId } as never);
    },

    async machineState(hostId) {
      let raw: unknown;
      try {
        raw = await bb.sdk.hosts.get({ hostId } as never);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      const host = ((raw as { host?: unknown } | null)?.host ?? raw) as { status?: string; lifecycle?: { phase?: string; message?: string | null } | null } | null;
      if (host === null) return null;
      return {
        phase: typeof host.lifecycle?.phase === "string" ? host.lifecycle.phase : null,
        connected: host.status === "connected",
        message: typeof host.lifecycle?.message === "string" && host.lifecycle.message !== "" ? host.lifecycle.message : null,
      };
    },

    async machineBusy(hostId) {
      // bb's list rows carry queuedWork and the activity counts (not the thread page's fields).
      const activity = await readMachineActivity(bb, hostId, { children: false });
      return activity.turns || activity.waiting || hasWork(activity.background);
    },

    machineActivity(hostId) {
      return readMachineActivity(bb, hostId, { providerId: MACHINE_PROVIDER_ID });
    },

    async findMachine(sandboxId) {
      const raw = (await bb.sdk.hosts.list()) as unknown;
      const hosts = (Array.isArray(raw) ? raw : ((raw as { hosts?: unknown[] }).hosts ?? [])) as { id: string; machineProviderId?: string | null }[];
      for (const host of hosts) {
        if (host.machineProviderId !== MACHINE_PROVIDER_ID) continue;
        const resource = (await bb.experimental_machines.getResource(host.id).catch(() => null)) as { sandboxId?: string } | null;
        if (resource?.sandboxId === sandboxId) return host.id;
      }
      return null;
    },

    async spawn(args) {
      const projectId = args.projectId ?? PERSONAL_PROJECT;
      const environment =
        args.where.kind === "environment"
          ? { type: "reuse" as const, environmentId: args.where.environmentId }
          : projectId === PERSONAL_PROJECT || args.where.path === null
            ? { type: "host" as const, hostId: args.where.hostId, workspace: { type: "personal" as const } }
            : { type: "host" as const, hostId: args.where.hostId, workspace: { type: "unmanaged" as const, path: args.where.path } };
      // Workers join their orchestrator's section (they nest under it there).
      const sectionId = args.parentThreadId ? await threadSection(bb, args.parentThreadId) : null;
      const result = (await bb.sdk.threads.spawn({
        projectId,
        ...(sectionId ? { sectionId } : {}),
        prompt: args.prompt,
        title: args.title,
        environment,
        providerId: CHAT_PROVIDER[args.provider],
        ...(args.model ? { model: args.model } : {}),
        ...(args.effort ? { reasoningLevel: args.effort } : {}),
        // Workers run unattended in a disposable sandbox.
        permissionMode: "full",
        // Nested under the orchestrator; the plugin wakes it (after recording
        // the turn, with the output framed as untrusted), not bb.
        ...(args.parentThreadId ? { parentThreadId: args.parentThreadId, parentNotifications: "off" } : {}),
        pluginMetadata: { role: "worker", taskId: args.taskId },
      } as unknown as Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0])) as unknown as {
        id?: string;
        environmentId?: string | null;
        thread?: { id?: string; environmentId?: string | null };
      };
      const threadId = result.thread?.id ?? result.id;
      if (typeof threadId !== "string") throw new Error("bb did not return the task chat's id");
      return { threadId, environmentId: result.thread?.environmentId ?? result.environmentId ?? null };
    },

    async spawnComposed({ taskId, request, parentThreadId, projectId, environmentId }) {
      const sectionId = parentThreadId ? await threadSection(bb, parentThreadId) : null;
      const result = (await bb.sdk.threads.spawn({
        ...request,
        projectId: projectId ?? PERSONAL_PROJECT,
        environment: { type: "reuse", environmentId },
        ...(sectionId ? { sectionId } : {}),
        ...(parentThreadId ? { parentThreadId, parentNotifications: "off" } : {}),
        pluginMetadata: { role: "workspace-chat", taskId },
      } as unknown as Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0])) as unknown as { id?: string; thread?: { id?: string } };
      const threadId = result.thread?.id ?? result.id;
      if (typeof threadId !== "string") throw new Error("bb did not return the new chat's id");
      return { threadId };
    },

    async adopt(threadId, parentThreadId) {
      const sectionId = await threadSection(bb, parentThreadId);
      await bb.sdk.threads.update({
        threadId,
        parentThreadId,
        parentNotifications: "off",
        ...(sectionId ? { sectionId } : {}),
      } as never);
    },

    async send(threadId, text, options) {
      const result = (await bb.sdk.threads.send({
        threadId,
        mode: options.steer ? "steer-if-active" : "queue-if-active",
        originPluginId: bb.pluginId,
        input: [{ type: "text", text, mentions: [] }],
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { reasoningLevel: options.effort } : {}),
      } as unknown as Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0])) as unknown as {
        delivery?: string;
        queuedMessage?: { id?: unknown; waitingOn?: { kind?: unknown } | null } | null;
      } | null;
      if (result?.delivery !== "queued") return { delivery: "sent" };
      const row = result.queuedMessage ?? null;
      return {
        delivery: "queued",
        queuedMessageId: typeof row?.id === "string" ? row.id : null,
        waitingOn: typeof row?.waitingOn?.kind === "string" ? row.waitingOn.kind : null,
      };
    },

    async withdraw(threadId, queuedMessageId) {
      for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt - 1]));
        await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId }).catch(() => undefined);
        // Confirmed only by the queue itself: a delete that seemed to fail may have worked, and one that seemed to work may not have.
        const listed = (await bb.sdk.threads.queuedMessages.list({ threadId }).catch(() => null)) as unknown;
        const rows = Array.isArray(listed) ? listed : ((listed as { items?: unknown[]; queuedMessages?: unknown[] } | null)?.items ?? (listed as { queuedMessages?: unknown[] } | null)?.queuedMessages ?? null);
        if (Array.isArray(rows) && !rows.some((row) => (row as { id?: unknown } | null)?.id === queuedMessageId)) return "removed";
      }
      return "stuck";
    },

    async state(threadId) {
      let raw: unknown;
      try {
        raw = await bb.sdk.threads.get({ threadId });
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      const thread = ((raw as { thread?: unknown }).thread ?? raw) as {
        status?: string;
        updatedAt?: unknown;
        archivedAt?: unknown;
        deletedAt?: unknown;
        environmentId?: string | null;
        queuedMessageCount?: number;
        activeBackgroundAgentCount?: number;
        providerId?: string | null;
      };
      if (thread.deletedAt) return null;
      // The thread page has background agents only; bb's list row also counts its workflows.
      const listed = (await bb.sdk.threads.list({ threadIds: [threadId], includeHidden: true } as never).catch(() => null)) as unknown;
      const row = ((Array.isArray(listed) ? listed : ((listed as { threads?: unknown[] } | null)?.threads ?? [])) as ThreadRow[]).find((entry) => entry.id === threadId);
      const work = row === undefined ? null : rowWork(row);
      const agents = typeof thread.activeBackgroundAgentCount === "number" ? thread.activeBackgroundAgentCount : 0;
      return {
        status: (STATES.has(thread.status ?? "") ? thread.status : "idle") as ChatState["status"],
        updatedAt: asEpoch(thread.updatedAt),
        archived: Boolean(thread.archivedAt),
        environmentId: typeof thread.environmentId === "string" ? thread.environmentId : null,
        queued: typeof thread.queuedMessageCount === "number" ? thread.queuedMessageCount : 0,
        backgroundAgents: Math.max(agents, work?.agents ?? 0),
        workflows: work?.workflows ?? 0,
        providerId: typeof thread.providerId === "string" ? thread.providerId : null,
      };
    },

    async output(threadId) {
      const result = (await bb.sdk.threads.output({ threadId })) as { output?: string | null };
      return result.output ?? null;
    },

    async turnEvents(threadId) {
      const raw = (await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "200", types: [...TURN_EVENT_TYPES] } as never)) as unknown;
      const rows = (Array.isArray(raw) ? raw : ((raw as { events?: unknown[] } | null)?.events ?? [])) as TurnEventRow[];
      return rows.filter((row) => row !== null && typeof row === "object" && typeof row.seq === "number" && typeof row.type === "string");
    },

    async stop(threadId) {
      await bb.sdk.threads.stop({ threadId });
    },

    async archive(threadId) {
      await bb.sdk.threads.archive({ threadId }).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
    },
  };
}
