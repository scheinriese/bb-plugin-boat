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
//
// Waiting isn't working: a chat waiting for a slot, for a retry at a usage
// limit's reset, or (past a grace) on the user, and a chat whose machine is
// gone don't keep a sandbox on. Nor does a turn that's been kept on for
// KEEP_LIMIT_MS in a row: boat's stop comes then. And the keeper never
// suspends a sandbox where something else works: a headless agent (boat says
// "running"), a dispatch, ship or wake in flight, or a live preview.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ACTIVE_STATES, autoStopHours, withinAutoStopCap, type BoatApi } from "./boat-api.ts";
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
/**
 * A chat waiting on the user (an approval, a question) counts as working
 * this long after the keeper first sees it waiting: one more extend at most.
 */
export const BLOCKED_GRACE_MS = 30 * 60_000;
/** A chat may take this long to stop and still count as working. */
export const STOPPING_GRACE_MS = 10 * 60_000;
/**
 * The keeper keeps a sandbox on at most this long in a row (for a task
 * chat: in one turn). A turn that runs longer is likely stuck; boat's stop
 * then comes as it would without the plugin.
 */
export const KEEP_LIMIT_MS = 12 * 60 * 60_000;
/** boat states with nothing of boat's at work: only then is a machine suspended. */
const QUIET_STATES = new Set(["idle", "ready"]);
/** The task history note the keeper writes (once per turn). */
export const KEPT_ON_EVENT = "sandbox-kept";
/** Task events that end a turn: the next turn gets its own note. */
const TURN_ENDS = new Set(["finished", "failed"]);

const resourceSchema = z.object({ sandboxId: z.string(), key: z.string() });

/** What the keeper reads of a bb thread (threads.list). */
export interface ThreadRow {
  id?: string;
  status?: string;
  archivedAt?: number | null;
  deletedAt?: number | null;
  queuedWork?: string;
  /** The agent is blocked on the user: an approval or a question. */
  hasPendingInteraction?: boolean;
  /** `status` refined by the machine's state ("waiting-for-host", "provisioning"). */
  runtime?: { displayStatus?: string } | null;
  runtimeStatus?: string;
  activity?: { activeBackgroundAgentCount?: number } | null;
}

/** A state that only counts as working for a while (the keeper times it). */
export function lingering(thread: ThreadRow): "blocked" | "stopping" | null {
  if (thread.status === "stopping") return "stopping";
  if ((thread.status === "active" || thread.status === "starting") && thread.hasPendingInteraction === true) return "blocked";
  return null;
}

/**
 * A turn (or a background agent) is under way in this chat. `lingeredMs`:
 * how long the keeper has seen it waiting on the user, or stopping.
 */
export function threadWorking(thread: ThreadRow, lingeredMs = 0): boolean {
  if (thread.archivedAt || thread.deletedAt) return false;
  // Its machine is gone or not up: no agent there makes progress (bb's suspend stops it cleanly).
  const display = thread.runtime?.displayStatus ?? thread.runtimeStatus;
  if (display === "waiting-for-host" || display === "provisioning") return false;
  // A workflow's agents work even while the chat reads idle.
  if ((thread.activity?.activeBackgroundAgentCount ?? 0) > 0) return true;
  const state = lingering(thread);
  if (state === "blocked") return lingeredMs <= BLOCKED_GRACE_MS;
  if (state === "stopping") return lingeredMs <= STOPPING_GRACE_MS;
  // Waiting isn't working: for a slot under bb's limits ("pending"), or a
  // queued message (a retry at a usage limit's reset). bb resumes a
  // suspended machine for it.
  return thread.status === "active" || thread.status === "starting";
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

function turnRuns(task: Task): boolean {
  return task.status === "running" || task.status === "starting";
}

export interface KeeperDeps {
  boat: Pick<BoatApi, "list" | "limits" | "extend">;
  store: Pick<TaskStore, "list" | "get" | "events" | "addEvent" | "chatThreads" | "previews">;
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
  /** Sandboxes a dispatch, ship or wake holds right now: never suspended. */
  held?: (sandboxId: string) => boolean;
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

/** A run of extends with work seen at each: since when, and for which task turns. */
interface Streak {
  since: number;
  turns: string;
  /** The keeper said it stopped keeping the sandbox on. */
  ended: boolean;
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
  /** Sandbox id → the run of extends it's in. */
  const streaks = new Map<string, Streak>();
  /** Thread id → since when the keeper sees it waiting on the user, or stopping (and when it last saw it). */
  const lingered = new Map<string, { state: "blocked" | "stopping"; since: number; seen: number }>();
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

  /** The chats on the machine, as bb lists them (null: bb couldn't say). */
  async function threadsOn(hostId: string): Promise<ThreadRow[] | null> {
    try {
      const raw = (await bb.sdk.threads.list({ hostId, includeHidden: true })) as unknown;
      return (Array.isArray(raw) ? raw : ((raw as { threads?: unknown[] } | null)?.threads ?? [])) as ThreadRow[];
    } catch (error) {
      deps.log(`keep ${hostId} on: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** Whether the chat works, timing how long it has waited on the user or been stopping. */
  function working(thread: ThreadRow, now: number): boolean {
    const state = lingering(thread);
    const id = thread.id;
    if (id === undefined) return threadWorking(thread);
    if (state === null) {
      lingered.delete(id);
      return threadWorking(thread);
    }
    const seen = lingered.get(id);
    if (seen === undefined || seen.state !== state) {
      lingered.set(id, { state, since: now, seen: now });
      return threadWorking(thread, 0);
    }
    seen.seen = now;
    return threadWorking(thread, now - seen.since);
  }

  /**
   * A note in the task's history. Not right after a failover: "one switch
   * per turn" reads the newest event, and a note there would hide it.
   */
  function addNote(task: Task, text: string): boolean {
    if (deps.store.events(task.id, 1).at(-1)?.kind === "failover") return false;
    deps.store.addEvent(task.id, KEPT_ON_EVENT, text);
    return true;
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
      if (addNote(task, `Kept the sandbox on while the agent works (${moreTime(seconds)}).`)) noted.push(task.id);
    }
    if (noted.length > 0) deps.changed?.(noted);
  }

  /** Nothing else works in the sandbox: no headless agent, dispatch, ship, wake or live preview. */
  function quiet(sandboxId: string, state: string, tasks: Task[]): boolean {
    if (!QUIET_STATES.has(state)) return false;
    // A headless agent's turn (boat keeps those on itself), or any dispatch under way.
    if (tasks.some((task) => task.status === "starting" || (task.runner !== "chat" && task.status === "running"))) return false;
    if (deps.held?.(sandboxId)) return false;
    // A live preview the user hasn't looked at yet (the idle stop keeps those on too).
    return !deps.store
      .previews()
      .some((preview) => preview.sandboxId === sandboxId && preview.health === "up" && deps.store.get(preview.taskId)?.status === "idle");
  }

  return async function keep(): Promise<void> {
    const now = deps.now?.() ?? Date.now();
    for (const [id, at] of extendedAt) if (now - at >= RECENT_MS) extendedAt.delete(id);
    for (const [id, at] of retryAt) if (at <= now) retryAt.delete(id);
    for (const [id, entry] of lingered) if (now - entry.seen > KEEP_LIMIT_MS) lingered.delete(id);

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
      if (turnRuns(task)) candidates.set(task.sandboxId, { sandboxId: task.sandboxId, hostId: task.hostId, machineUp: false });
    }
    // A sandbox no longer up ends its run of extends.
    for (const id of streaks.keys()) if (!candidates.has(id)) streaks.delete(id);
    if (candidates.size === 0) return;

    const sandboxes = new Map((await deps.boat.list({ signal: deps.signal })).map((sandbox) => [sandbox.id, sandbox]));
    for (const candidate of candidates.values()) {
      const { sandboxId, hostId } = candidate;
      if (deps.skip?.(sandboxId) || retryAt.has(sandboxId) || extendedAt.has(sandboxId)) continue;
      const sandbox = sandboxes.get(sandboxId);
      if (sandbox === undefined || !ACTIVE_STATES.has(sandbox.state)) {
        streaks.delete(sandboxId);
        continue;
      }
      if (sandbox.archiveAfter === null) continue;
      const deadline = Date.parse(sandbox.archiveAfter);
      if (!Number.isFinite(deadline) || deadline - now > KEEP_MARGIN_MS) continue;
      const ttl = await ttlSeconds(now);
      // A short auto-stop: extend at half of it, so one extend isn't followed by another.
      if (deadline - now > Math.min(KEEP_MARGIN_MS, ttl * 500)) continue;

      // Who works there: any chat on the machine (bb's word), or a task chat's
      // turn bb doesn't list (the plugin's record).
      const here = open.filter((task) => task.sandboxId === sandboxId);
      const threads = hostId === null ? null : await threadsOn(hostId);
      const listed = new Set((threads ?? []).map((thread) => thread.id));
      const busyChats = new Set((threads ?? []).filter((thread) => working(thread, now)).map((thread) => thread.id ?? "?"));
      const unlisted = here.filter((task) => task.runner === "chat" && turnRuns(task) && (threads === null || task.threadId === null || !listed.has(task.threadId)));
      const workers = here.filter((task) => unlisted.includes(task) || deps.store.chatThreads(task.id).some((threadId) => busyChats.has(threadId)));
      let keepOn = busyChats.size > 0 || unlisted.length > 0;

      if (keepOn) {
        // A run of extends; a task chat's next turn starts a new one.
        const turns = workers
          .map((task) => `${task.id}:${task.turns}`)
          .sort()
          .join(",");
        let streak = streaks.get(sandboxId);
        if (streak === undefined || (turns !== "" && streak.turns !== "" && streak.turns !== turns)) {
          streak = { since: now, turns, ended: false };
          streaks.set(sandboxId, streak);
        } else if (streak.turns === "") {
          streak.turns = turns;
        }
        if (now - streak.since >= KEEP_LIMIT_MS) {
          // Long enough: boat's stop comes (bb suspends the machine first, below).
          keepOn = false;
          if (!streak.ended) {
            streak.ended = true;
            const hours = Math.round(KEEP_LIMIT_MS / 3_600_000);
            deps.info?.(`stopped keeping ${sandboxId} on after ${hours} hours`);
            const noted = workers.filter((task) => addNote(task, `Stopped keeping the sandbox on after ${hours} hours. It stops at its auto-stop; the next message resumes it.`));
            if (noted.length > 0) deps.changed?.(noted.map((task) => task.id));
          }
        }
      } else {
        streaks.delete(sandboxId);
      }

      // bb couldn't say whether a chat there works: neither extend nor suspend on a guess.
      if (!keepOn && hostId !== null && threads === null) continue;
      try {
        if (keepOn) {
          const used = await withinAutoStopCap(ttl, async (seconds) => {
            await deps.boat.extend(sandboxId, ["--ttl", String(seconds)], deps.signal);
            return seconds;
          });
          extendedAt.set(sandboxId, now);
          deps.info?.(`kept ${sandboxId} on for ${moreTime(used)}: a chat there is working`);
          note(workers, used);
        } else if (candidate.machineUp && hostId !== null && quiet(sandboxId, sandbox.state, here)) {
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
