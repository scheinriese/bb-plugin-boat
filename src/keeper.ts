// Keeps Boat sandboxes on while a bb chat's agent works there.
//
// boat's auto-stop (Hard stop after, within the plan's cap) only counts
// boat's own headless agents as working. A sandbox where a bb chat runs (a
// task chat, a cloud orchestrator, any chat on a Boat sandbox; bb's daemon
// runs there) reads "idle" to boat, so boat would stop it at its deadline,
// mid-turn. Shortly before that deadline the keeper moves it out while a
// turn runs there, and otherwise lets bb suspend the machine (bb resumes it
// on the next message). It never keeps on a sandbox whose turns are over:
// the plugin's own idle stop (Stop idle sandboxes after) works as before.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { autoStopHours, withinAutoStopCap, type BoatApi } from "./boat-api.ts";
import { MACHINE_PROVIDER_ID } from "./machine.ts";
import type { BoatSettings } from "./service.ts";
import { OPEN_STATUSES, type Task, type TaskStore } from "./store.ts";

/** Move the deadline once it's this close (or half the auto-stop, if that's shorter). */
export const KEEP_MARGIN_MS = 25 * 60_000;
/** After a failed extend, leave that sandbox alone this long. */
const RETRY_MS = 2 * 60_000;
/**
 * After an extend, leave that sandbox alone this long: `boat list` may still
 * show the old deadline. Shorter than any next extend can be due (an
 * auto-stop is at least 30 minutes, extended at half of it at the latest).
 */
const RECENT_MS = 10 * 60_000;
/** How long a `boat limits` reading (the plan's auto-stop cap) is reused. */
const LIMITS_MS = 5 * 60_000;
/** The task history note the keeper writes (once per turn). */
export const KEPT_ON_EVENT = "sandbox-kept";
/** Task events that end a turn: the next turn gets its own note. */
const TURN_ENDS = new Set(["finished", "failed"]);
/** bb thread states with a turn under way. */
const BUSY_THREAD = new Set(["active", "starting", "pending", "stopping"]);

const resourceSchema = z.object({ sandboxId: z.string(), key: z.string() });

/** What the keeper reads of a bb thread (threads.list). */
interface ThreadRow {
  id?: string;
  status?: string;
  archivedAt?: number | null;
  deletedAt?: number | null;
  queuedWork?: string;
  activity?: { activeBackgroundAgentCount?: number } | null;
}

/** A turn (or queued work, or background agents) is under way in this chat. */
export function threadWorking(thread: ThreadRow): boolean {
  if (thread.archivedAt || thread.deletedAt) return false;
  return BUSY_THREAD.has(thread.status ?? "") || thread.queuedWork === "waiting" || (thread.activity?.activeBackgroundAgentCount ?? 0) > 0;
}

/** "2 more hours", "30 more minutes". */
function moreTime(seconds: number): string {
  if (seconds >= 3600) {
    const hours = Math.round((seconds / 3600) * 10) / 10;
    return `${hours} more ${hours === 1 ? "hour" : "hours"}`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} more ${minutes === 1 ? "minute" : "minutes"}`;
}

export interface KeeperDeps {
  boat: Pick<BoatApi, "list" | "limits" | "extend">;
  store: Pick<TaskStore, "list" | "events" | "addEvent" | "chatThreads">;
  settings: () => Promise<Pick<BoatSettings, "sandboxTtlHours">>;
  signal: AbortSignal;
  /** Problems (a failed extend or suspend). */
  log: (message: string) => void;
  /** What it did (an extend). */
  info?: (message: string) => void;
  /** Tasks whose history got a note. */
  changed?: (taskIds: string[]) => void;
  /** Sandboxes to leave alone (a task moving to a chat there keeps it up itself). */
  skip?: (sandboxId: string) => boolean;
  now?: () => number;
}

/** A sandbox the keeper looks after: a Boat sandbox machine bb has up, or a task chat's sandbox. */
interface Candidate {
  sandboxId: string;
  /** The bb machine on it (null: none known). */
  hostId: string | null;
  /** bb lists the machine as up: an idle one may be suspended through bb. */
  machineUp: boolean;
}

/**
 * The keeper, run from the monitor loop. It remembers when it extended
 * each sandbox (so a stale `boat list` doesn't make it extend twice) and
 * backs off after a failed extend.
 */
export function createSandboxKeeper(bb: BbPluginApi, deps: KeeperDeps): () => Promise<void> {
  /** Sandbox id → when the keeper last extended it (epoch ms). */
  const extendedAt = new Map<string, number>();
  /** Sandbox id → when to try again after a failure (epoch ms). */
  const retryAt = new Map<string, number>();
  let limits: { at: number; capHours: number | null } | null = null;

  /** Seconds an extend asks for: Hard stop after, within the plan's cap, at least half an hour. */
  async function ttlSeconds(now: number): Promise<number> {
    if (limits === null || now - limits.at > LIMITS_MS) {
      const read = await deps.boat.limits(deps.signal).catch(() => null);
      // Unreadable: the setting; boat names its cap if it refuses (withinAutoStopCap).
      limits = read === null ? { at: now - LIMITS_MS + 60_000, capHours: null } : { at: now, capHours: read.autoStopCapHours };
    }
    return Math.round(autoStopHours((await deps.settings()).sandboxTtlHours, limits.capHours, 0.5) * 3600);
  }

  async function machines(): Promise<Candidate[]> {
    const hosts = ((await bb.sdk.hosts.list()) as unknown as {
      id: string;
      machineProviderId: string | null;
      lifecycle?: { phase?: string; suspendedAt?: number | null } | null;
    }[]).filter((host) => host.machineProviderId === MACHINE_PROVIDER_ID && host.lifecycle?.phase === "active" && !host.lifecycle?.suspendedAt);
    const found: Candidate[] = [];
    for (const host of hosts) {
      const resource = resourceSchema.safeParse(await bb.experimental_machines.getResource(host.id).catch(() => null));
      if (resource.success) found.push({ sandboxId: resource.data.sandboxId, hostId: host.id, machineUp: true });
    }
    return found;
  }

  /** Chats on the machine with a turn under way (null: bb couldn't say). */
  async function workingThreads(hostId: string): Promise<Set<string> | null> {
    try {
      const raw = (await bb.sdk.threads.list({ hostId, includeHidden: true })) as unknown;
      const threads = (Array.isArray(raw) ? raw : ((raw as { threads?: unknown[] } | null)?.threads ?? [])) as ThreadRow[];
      return new Set(threads.filter(threadWorking).map((thread) => thread.id ?? "?"));
    } catch (error) {
      deps.log(`keep ${hostId} on: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** One note per task and turn: none since its last turn ended. */
  function note(tasks: Task[], seconds: number): void {
    const noted: string[] = [];
    for (const task of tasks) {
      const events = deps.store.events(task.id, 100);
      let already = false;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const kind = events[index]!.kind;
        if (TURN_ENDS.has(kind)) break;
        if (kind === KEPT_ON_EVENT) {
          already = true;
          break;
        }
      }
      if (already) continue;
      deps.store.addEvent(task.id, KEPT_ON_EVENT, `Kept the sandbox on while the agent works (${moreTime(seconds)}).`);
      noted.push(task.id);
    }
    if (noted.length > 0) deps.changed?.(noted);
  }

  return async function keep(): Promise<void> {
    const now = deps.now?.() ?? Date.now();
    for (const [id, at] of extendedAt) if (now - at >= RECENT_MS) extendedAt.delete(id);
    for (const [id, at] of retryAt) if (at <= now) retryAt.delete(id);

    const open = deps.store.list({ statuses: OPEN_STATUSES, limit: 1000 });
    const candidates = new Map<string, Candidate>();
    try {
      for (const machine of await machines()) candidates.set(machine.sandboxId, machine);
    } catch (error) {
      deps.log(`keep machines on: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A task chat's turn keeps its sandbox on even when bb doesn't list its machine.
    for (const task of open) {
      if (task.runner !== "chat" || task.sandboxId === null || candidates.has(task.sandboxId)) continue;
      if (task.status === "running" || task.status === "starting") candidates.set(task.sandboxId, { sandboxId: task.sandboxId, hostId: task.hostId, machineUp: false });
    }
    if (candidates.size === 0) return;

    const sandboxes = new Map((await deps.boat.list({ signal: deps.signal })).map((sandbox) => [sandbox.id, sandbox]));
    for (const candidate of candidates.values()) {
      const { sandboxId, hostId } = candidate;
      if (deps.skip?.(sandboxId) || retryAt.has(sandboxId) || extendedAt.has(sandboxId)) continue;
      const sandbox = sandboxes.get(sandboxId);
      if (sandbox === undefined || sandbox.archiveAfter === null) continue;
      const deadline = Date.parse(sandbox.archiveAfter);
      if (!Number.isFinite(deadline) || deadline - now > KEEP_MARGIN_MS) continue;
      const ttl = await ttlSeconds(now);
      // A short auto-stop: extend at half of it, so one extend isn't followed by another.
      if (deadline - now > Math.min(KEEP_MARGIN_MS, ttl * 500)) continue;

      // Who works there: a task chat's turn (the plugin's record), or any chat on the machine (bb's).
      const here = open.filter((task) => task.sandboxId === sandboxId);
      const running = here.filter((task) => task.runner === "chat" && (task.status === "running" || task.status === "starting"));
      const threads = hostId === null ? null : await workingThreads(hostId);
      const working = running.length > 0 || (threads !== null && threads.size > 0);
      // bb couldn't say whether a chat there works: neither extend nor suspend on a guess.
      if (!working && hostId !== null && threads === null) continue;
      try {
        if (working) {
          const used = await withinAutoStopCap(ttl, async (seconds) => {
            await deps.boat.extend(sandboxId, ["--ttl", String(seconds)], deps.signal);
            return seconds;
          });
          extendedAt.set(sandboxId, now);
          deps.info?.(`kept ${sandboxId} on for ${moreTime(used)}: a chat there is working`);
          const busyChats = threads ?? new Set<string>();
          note(
            here.filter((task) => running.includes(task) || deps.store.chatThreads(task.id).some((threadId) => busyChats.has(threadId))),
            used,
          );
        } else if (candidate.machineUp && hostId !== null) {
          // bb drains the machine, calls the provider's suspend (boat stop), and resumes it on demand.
          await bb.sdk.hosts.experimental_suspend({ hostId });
        }
      } catch (error) {
        retryAt.set(sandboxId, now + RETRY_MS);
        deps.log(`keep ${hostId ?? sandboxId} on: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
}
