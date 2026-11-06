// Keeps Boat sandboxes on while a bb chat's agent works there.
//
// boat's auto-stop (Hard stop after, within the plan's cap) only counts
// boat's own headless agents as working. A sandbox where a bb chat runs (a
// task chat, a cloud orchestrator, any chat on a Boat sandbox; bb's daemon
// runs there) reads "idle" to boat, so boat would stop it at its deadline,
// mid-turn. Shortly before that deadline the keeper moves it out while a
// turn runs there, or work bb reports in the background after a turn (a
// background command, a bb workflow, a child chat), and otherwise lets bb
// suspend the machine (bb resumes it on the next message) rather than boat
// stopping it behind bb's back. It never keeps on a sandbox whose turns and
// background work are over: the plugin's own idle stop (Stop idle
// sandboxes after) works as before. A headless task whose agent has
// finished keeps its sandbox on the same way while processes it left are
// still computing (`boat ps`).
//
// Waiting isn't working: a chat waiting for a slot, for a retry at a usage
// limit's reset, or (past a grace) on the user, and a chat whose machine is
// gone don't keep a sandbox on. Nor does a turn that's been kept on for
// KEEP_LIMIT_MS in a row: boat's stop comes then. And the keeper never
// suspends a sandbox where something else works: a headless agent (boat says
// "running"), a dispatch, ship or wake in flight, or a live preview.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { KEEP_LIMIT_MS, hasWork, rowWork, workingChildren, type ThreadRow } from "./activity.ts";
import { ACTIVE_STATES, autoStopHours, withinAutoStopCap, type BoatApi } from "./boat-api.ts";
import { MACHINE_PROVIDER_ID } from "./machine.ts";
import type { BoatSettings } from "./service.ts";
import { OPEN_STATUSES, type Task, type TaskStore } from "./store.ts";

/** Move the deadline once it's this close (or half the auto-stop, if that's shorter). */
export const KEEP_MARGIN_MS = 25 * 60_000;
/**
 * This close to boat's deadline, a sandbox the keeper doesn't keep on is
 * suspended through bb even with a live preview: boat would stop it
 * moments later anyway, and then bb wouldn't know.
 */
export const LAST_CALL_MS = 5 * 60_000;
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
 * then comes as it would without the plugin (through bb, near its deadline).
 */
export { KEEP_LIMIT_MS };
/** boat states with nothing of boat's at work: only then is a machine suspended. */
const QUIET_STATES = new Set(["idle", "ready"]);
/** The task history note the keeper writes (once per turn). */
export const KEPT_ON_EVENT = "sandbox-kept";
/** Open headless tasks whose agent has finished (their sandbox may still compute). */
const WAITING = new Set(["idle", "failed"]);
/** Task events that end a turn: the next turn gets its own note. */
const TURN_ENDS = new Set(["finished", "failed"]);

const resourceSchema = z.object({ sandboxId: z.string(), key: z.string() });

export type { ThreadRow } from "./activity.ts";

/** A state that only counts as working for a while (the keeper times it). */
export function lingering(thread: ThreadRow): "blocked" | "stopping" | null {
  if (thread.status === "stopping") return "stopping";
  if ((thread.status === "active" || thread.status === "starting") && thread.hasPendingInteraction === true) return "blocked";
  return null;
}

/**
 * A turn, or work in the background, is under way in this chat.
 * `lingeredMs`: how long the keeper has seen it waiting on the user, or
 * stopping.
 */
export function threadWorking(thread: ThreadRow, lingeredMs = 0): boolean {
  if (thread.archivedAt || thread.deletedAt) return false;
  // Its machine is gone or not up: no agent there makes progress (bb's suspend stops it cleanly).
  const display = thread.runtime?.displayStatus ?? thread.runtimeStatus;
  if (display === "waiting-for-host" || display === "provisioning") return false;
  // Background agents, background commands and bb workflows work even while the chat reads idle.
  if (hasWork(rowWork(thread))) return true;
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

/** An extend never reaches past the 12 hours in a row (at least half an hour, like any extend). */
function withinLimit(ttlSeconds: number, streak: { since: number }, now: number): number {
  const left = Math.ceil((KEEP_LIMIT_MS - (now - streak.since)) / 1000);
  return Math.min(ttlSeconds, Math.max(1800, left));
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
  /** Processes a headless task's finished agent left are computing there (boat ps; "maybe": a first reading; absent: never). */
  computing?: (sandboxId: string) => Promise<"busy" | "maybe" | "no">;
  /** The keeper suspended this machine; underWork: background work still ran (at its 12-hour limit). */
  suspended?: (hostId: string, underWork: boolean) => void;
  /** A headless sandbox still computing reached the 12 hours: boat stops it at this deadline (epoch ms; the watchdog sees the stop). */
  stopsComputing?: (sandboxId: string, deadline: number) => void;
  now?: () => number;
}

/** A sandbox the keeper looks after: a Boat sandbox machine bb has up, a task chat's sandbox, or a headless task's. */
interface Candidate {
  sandboxId: string;
  /** The bb machine on it (null: none known). */
  hostId: string | null;
  /** bb lists the machine as up: an idle one may be suspended through bb. */
  machineUp: boolean;
  /** bb's daemon there is connected (a disconnected one may only be restarting: never suspended on that). */
  connected?: boolean;
  /** A headless task's sandbox whose agent has finished: kept on only while processes it left compute. */
  headless?: boolean;
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

  /** Every Boat sandbox machine bb has (child chats on one of them don't keep another on). */
  let boatMachines = new Set<string>();

  async function machines(): Promise<Candidate[]> {
    const all = (await bb.sdk.hosts.list()) as unknown as {
      id: string;
      status?: string;
      machineProviderId: string | null;
      lifecycle?: { phase?: string; suspendedAt?: number | null } | null;
    }[];
    boatMachines = new Set(all.filter((host) => host.machineProviderId === MACHINE_PROVIDER_ID).map((host) => host.id));
    const hosts = all.filter((host) => host.machineProviderId === MACHINE_PROVIDER_ID && host.lifecycle?.phase === "active" && !host.lifecycle?.suspendedAt);
    const found: Candidate[] = [];
    for (const host of hosts) {
      const resource = resourceSchema.safeParse(await bb.experimental_machines.getResource(host.id).catch(() => null));
      if (resource.success) found.push({ sandboxId: resource.data.sandboxId, hostId: host.id, machineUp: true, connected: host.status === undefined || host.status === "connected" });
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
  function note(tasks: Task[], seconds: number, why = "while the agent works"): void {
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
      if (addNote(task, `Kept the sandbox on ${why} (${moreTime(seconds)}).`)) noted.push(task.id);
    }
    if (noted.length > 0) deps.changed?.(noted);
  }

  /**
   * What else works in the sandbox (null: nothing): a headless agent (boat
   * keeps those on itself), a dispatch, ship or wake in flight, or a live
   * preview the user hasn't looked at yet (the idle stop keeps those on too).
   */
  function busyWith(sandboxId: string, state: string, tasks: Task[]): "agent" | "held" | "preview" | null {
    if (!QUIET_STATES.has(state)) return "agent";
    if (tasks.some((task) => task.runner !== "chat" && task.status === "running")) return "agent";
    if (tasks.some((task) => task.status === "starting") || deps.held?.(sandboxId)) return "held";
    const preview = deps.store
      .previews()
      .some((entry) => entry.sandboxId === sandboxId && entry.health === "up" && deps.store.get(entry.taskId)?.status === "idle");
    return preview ? "preview" : null;
  }



  return async function keep(): Promise<void> {
    const now = deps.now?.() ?? Date.now();
    for (const [id, at] of extendedAt) if (now - at >= RECENT_MS) extendedAt.delete(id);
    for (const [id, at] of retryAt) if (at <= now) retryAt.delete(id);
    for (const [id, entry] of lingered) if (now - entry.seen > KEEP_LIMIT_MS) lingered.delete(id);

    const open = deps.store.list({ statuses: OPEN_STATUSES, limit: 1000 });
    const candidates = new Map<string, Candidate>();
    let listed = true;
    try {
      for (const machine of await machines()) candidates.set(machine.sandboxId, machine);
    } catch (error) {
      listed = false;
      deps.log(`keep machines on: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A task chat's turn keeps its sandbox on even when bb doesn't list its machine.
    for (const task of open) {
      if (task.runner !== "chat" || task.sandboxId === null || candidates.has(task.sandboxId)) continue;
      if (turnRuns(task)) candidates.set(task.sandboxId, { sandboxId: task.sandboxId, hostId: task.hostId, machineUp: false });
    }
    // A headless task whose agent has finished: processes it left may still compute.
    for (const task of open) {
      if (task.runner === "chat" || task.sandboxId === null || candidates.has(task.sandboxId) || !WAITING.has(task.status)) continue;
      if (open.some((other) => other.sandboxId === task.sandboxId && (other.runner === "chat" || !WAITING.has(other.status)))) continue;
      candidates.set(task.sandboxId, { sandboxId: task.sandboxId, hostId: null, machineUp: false, headless: true });
    }
    // A sandbox no longer up ends its run of extends (not when bb just couldn't list its machines).
    if (listed) for (const id of streaks.keys()) if (!candidates.has(id)) streaks.delete(id);
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

      const here = open.filter((task) => task.sandboxId === sandboxId);
      if (candidate.headless) {
        // A headless sandbox: only processes its finished agent left keep it on (boat
        // keeps a running agent on itself). Nothing else of the plugin's to do here.
        if (sandbox.state !== "idle") continue;
        // Near boat's stop, a first busy reading counts: being wrong costs sandbox time, not work.
        const computing = (await deps.computing?.(sandboxId).catch(() => "no" as const)) ?? "no";
        if (computing === "no") {
          streaks.delete(sandboxId);
          continue;
        }
        const streak = streaks.get(sandboxId) ?? { since: now, turns: "", ended: false };
        streaks.set(sandboxId, streak);
        if (now - streak.since >= KEEP_LIMIT_MS) {
          if (!streak.ended) {
            streak.ended = true;
            deps.stopsComputing?.(sandboxId, deadline);
          }
          continue;
        }
        try {
          const used = await withinAutoStopCap(withinLimit(ttl, streak, now), async (seconds) => {
            await deps.boat.extend(sandboxId, ["--ttl", String(seconds)], deps.signal);
            return seconds;
          });
          extendedAt.set(sandboxId, now);
          deps.info?.(`kept ${sandboxId} on for ${moreTime(used)}: processes the agent started are still running`);
          note(here, used, "while processes the agent started are still running");
        } catch (error) {
          retryAt.set(sandboxId, now + RETRY_MS);
          deps.log(`keep ${sandboxId} on: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }

      // Who works there: any chat on the machine (bb's word), a child chat
      // of one of them working elsewhere, or a task chat's turn bb doesn't
      // list (the plugin's record).
      const threads = hostId === null ? null : await threadsOn(hostId);
      const listed = new Set((threads ?? []).map((thread) => thread.id));
      const busyChats = new Set((threads ?? []).filter((thread) => working(thread, now)).map((thread) => thread.id ?? "?"));
      const unlisted = here.filter((task) => task.runner === "chat" && turnRuns(task) && (threads === null || task.threadId === null || !listed.has(task.threadId)));
      const workers = here.filter((task) => unlisted.includes(task) || deps.store.chatThreads(task.id).some((threadId) => busyChats.has(threadId)));
      const children =
        busyChats.size > 0 || unlisted.length > 0 || threads === null || hostId === null ? [] : await workingChildren(bb, threads, new Set([...boatMachines, hostId])).catch(() => []);
      let keepOn = busyChats.size > 0 || unlisted.length > 0 || children.length > 0;
      /** Work still ran, but it has been kept on for KEEP_LIMIT_MS. */
      let limited = false;

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
          limited = true;
          if (!streak.ended) {
            streak.ended = true;
            const hours = Math.round(KEEP_LIMIT_MS / 3_600_000);
            deps.info?.(`stopped keeping ${sandboxId} on after ${hours} hours`);
            const noted = workers.filter((task) => addNote(task, `Stopped keeping the sandbox on after ${hours} hours. bb suspends it before its auto-stop; the next message resumes it.`));
            if (noted.length > 0) deps.changed?.(noted.map((task) => task.id));
          }
        }
      } else {
        streaks.delete(sandboxId);
      }

      // bb couldn't say whether a chat there works: neither extend nor suspend on a guess.
      if (!keepOn && hostId !== null && threads === null) continue;
      // bb has lost the machine's daemon while the sandbox runs (bb updating it, a network
      // blip): a turn may still run there. Never suspend on that; boat's stop, if it
      // comes, the watchdog brings in line with bb.
      if (!keepOn && candidate.connected === false) continue;
      const lastCall = deadline - now <= LAST_CALL_MS;
      const busy = keepOn || !candidate.machineUp || hostId === null ? null : busyWith(sandboxId, sandbox.state, here);
      // Right before boat's stop, a dispatch, ship or wake in flight is work too.
      if (!keepOn && lastCall && busy === "held") keepOn = true;
      try {
        if (keepOn) {
          const streak = streaks.get(sandboxId);
          const used = await withinAutoStopCap(streak === undefined ? ttl : withinLimit(ttl, streak, now), async (seconds) => {
            await deps.boat.extend(sandboxId, ["--ttl", String(seconds)], deps.signal);
            return seconds;
          });
          extendedAt.set(sandboxId, now);
          deps.info?.(`kept ${sandboxId} on for ${moreTime(used)}: a chat there is working`);
          note(workers, used);
        } else if (candidate.machineUp && hostId !== null && (busy === null || (lastCall && busy === "preview"))) {
          // bb drains the machine, calls the provider's suspend (boat stop), and
          // resumes it on demand. A live preview goes too right before boat's
          // stop: through bb, the next message brings it all back.
          await bb.sdk.hosts.experimental_suspend({ hostId });
          deps.suspended?.(hostId, limited);
        }
      } catch (error) {
        retryAt.set(sandboxId, now + RETRY_MS);
        deps.log(`keep ${hostId ?? sandboxId} on: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
}
