// The watchdog: plain checks from the bb machine (no AI) that keep bb's
// record of Boat sandbox machines true to boat, get chats waiting on a
// stopped machine going again, and tell the orchestrator at once when
// something goes wrong. Each monitor pass:
//
// - remembers what each machine runs in the background while it's up;
// - a machine bb still has active whose sandbox boat stopped (its auto-stop,
//   a crash, the boat.dev dashboard) is suspended through bb, so bb resumes
//   it on the next message instead of queueing it as "Waiting for … to be
//   ready" for good;
// - a suspended machine with messages waiting for it is resumed (the
//   provider's resume: boat resume, then bb set up there again);
// - one [boat] message per incident to the task's orchestrator: a sandbox
//   stopped while background work ran there; messages waited more than 3
//   minutes on a stopped or disconnected machine; a running turn showed no
//   new transcript activity for 30 minutes. A normal stop (the idle stop
//   after a finished turn with nothing in the background) says nothing.
//
// After a stop that cut off background work, the worker's next message
// starts with a short note (once): when it stopped, that its background
// jobs and /tmp were lost, and to rerun what it still needs.
import type { BbPluginApi, PluginKvStorage } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { KEEP_LIMIT_MS, NO_WORK, addWork, describeWork, hasWork, messagesWaiting, rowWork, threadsOnMachine, type BackgroundWork, type ThreadRow } from "./activity.ts";
import { ACTIVE_STATES, type BoatApi, type Sandbox } from "./boat-api.ts";
import { RESUME_NOTE_PREFIX, quietNotice, resumeNoteText, stoppedNotice, waitingNotice, type NoticeSubject } from "./format.ts";
import { MACHINE_PROVIDER_ID } from "./machine.ts";
import { OPEN_STATUSES, type Task, type TaskStore } from "./store.ts";

/** Messages waiting this long on a stopped or disconnected machine: the orchestrator hears of it. */
export const WAIT_NOTICE_MS = 3 * 60_000;
/** While bb is resuming the machine itself, give it this long before a notice. */
export const RESUMING_NOTICE_MS = 10 * 60_000;
/** A running turn quiet this long may be stuck. */
export const QUIET_TURN_MS = 30 * 60_000;
/** How often one running turn's transcript is looked at. */
export const QUIET_CHECK_MS = 5 * 60_000;
/** bb resumes a suspended machine for a new message itself; after this the plugin does. */
export const RESUME_AFTER_MS = 45_000;
/** At most one notice of a kind about the same chat or sandbox this often (a stop: each one counts). */
export const NOTICE_GAP_MS = 30 * 60_000;
const STOP_NOTICE_GAP_MS = 5 * 60_000;
/** A machine whose suspend through bb keeps failing is left to the user after this many tries. */
const RECONCILE_TRIES = 3;
/** At most this many machines resumed in one pass (a stampede could take every sandbox slot). */
const RESUMES_PER_PASS = 2;
/** The machines are looked at this often (sooner when a message waits for an offline one). */
export const MACHINES_EVERY_MS = 30_000;
/** After a failed suspend or resume, leave that machine alone this long. */
const RETRY_MS = 3 * 60_000;
/** After a resume bb took, ask again only this much later (its setup there can take minutes). */
const RESUME_AGAIN_MS = 10 * 60_000;
/** How long a sent notice is remembered (dedupe across restarts). */
const SENT_TTL_MS = 7 * 24 * 3_600_000;
/** A notice that can't go out (a handover, a failed send) is tried again this long. */
const OUTBOX_TTL_MS = 6 * 3_600_000;
/** A machine's background work counts for a stop when it was seen this shortly before. */
const SEEN_FRESH_MS = 15 * 60_000;
/** Background work seen this long in a row: the stop came at the plugin's limit for it. */
const CAPPED_AFTER_MS = KEEP_LIMIT_MS - 30 * 60_000;
/** boat states of a stopped sandbox (its disk kept). */
const STOPPED_STATES = new Set(["stopped", "archived"]);
/** What a queued message waits on when it waits for its machine (not a time, a slot, an answer). */
const MACHINE_WAITS = new Set(["host-offline", "provisioning"]);

/** kv: notices sent (dedupe and rate limit). */
export const WATCHDOG_KEY = "watchdog";
/** kv: the note a task's worker gets with its next message after a stop. */
export const resumeNoteKey = (taskId: string) => `resumeNote:${taskId}`;

const resourceSchema = z.object({ sandboxId: z.string(), key: z.string() });
const noteSchema = z.object({ taskId: z.string(), threadId: z.string().nullable(), text: z.string() });
export type ResumeNote = z.infer<typeof noteSchema>;

interface HostRow {
  id: string;
  name?: string;
  status?: string;
  machineProviderId?: string | null;
  lastSeenAt?: number | null;
  lifecycle?: { phase?: string; suspendedAt?: number | null } | null;
}

/** A queued row (threads.queuedMessages / the message.queued event). */
export interface QueuedRow {
  id: string;
  threadId: string;
  content: unknown[];
  createdAt?: number;
  updatedAt: number;
  state?: string;
  editable?: boolean;
  waitingOn?: { kind?: string } | null;
  sendAt?: number | null;
}

export interface WatchdogDeps {
  boat: Pick<BoatApi, "list" | "events">;
  store: Pick<TaskStore, "list" | "get" | "addEvent" | "byThread" | "orchestratorThreadIds">;
  kv: PluginKvStorage;
  /** Post a plain message into a chat (runtime.tellOrchestrator). */
  tell: (threadId: string, text: string) => Promise<void>;
  /** Notices to this chat wait (its orchestrator is being handed over). */
  deferred?: (threadId: string) => Promise<boolean>;
  /** A phone or desktop notice for the user (an orchestrator stuck on its own machine can't read one). */
  notifyUser?: (title: string, body: string) => Promise<void>;
  /** Sandboxes the plugin is moving, resizing, or dispatching to right now: left alone. */
  held?: (sandboxId: string) => boolean;
  /** bb has the machine suspended now (the service skips it in its idle stop). */
  suspended?: (hostId: string) => void;
  /** bb has the machine up again, or the plugin resumed it (the idle stop watches it again). */
  resumed?: (hostId: string) => void;
  changed?: (taskIds: string[]) => void;
  log: (message: string) => void;
  info?: (message: string) => void;
  signal?: AbortSignal;
  now?: () => number;
}

export interface Watchdog {
  /** One pass, from the monitor loop. */
  tick(): Promise<void>;
  /** A message was queued somewhere (bb's message.queued): put a pending note in front of it. */
  queued(entry: QueuedRow): Promise<void>;
  /** The message.dispatch hook's decision for a pending note (sync, never throws). */
  dispatch(context: { threadId: string; attempt: string; text: string; queued: QueuedRow[]; originPluginId: string | null }):
    | { action: "proceed" }
    | { action: "wait"; reason: string; sendAt: number };
  /** The note for a task's next prompt (null: none). */
  noteFor(taskId: string): Promise<string | null>;
  /** The note went out with a prompt the plugin sent. */
  noteSent(taskId: string): Promise<void>;
  /** Load pending notes (after a restart). */
  load(): Promise<void>;
  /**
   * The plugin suspended this machine itself. Nothing ran in the background
   * (underWork false): a planned stop, even if the watchdog saw work there a
   * pass ago. underWork: at the 12-hour limit for it.
   */
  planned(hostId: string, underWork: boolean): void;
}

/** What the watchdog saw running in the background on a machine while it was up. */
interface Seen {
  /** Since when it has seen background work there, without a break. */
  since: number;
  at: number;
  work: BackgroundWork;
  /** Per chat on it: its background work. */
  chats: { threadId: string; work: BackgroundWork }[];
}

/** A notice to send: once per incident, at most one per subject and chat every NOTICE_GAP_MS. */
interface Outgoing {
  threadId: string;
  /** About this task: its orchestrator is read when the notice goes out (a successor may have taken over). */
  taskId?: string;
  /** The least time between two notices of this kind about the subject, to one chat. */
  gapMs: number;
  incident: string;
  subject: string;
  text: string;
  /** Only once the chat's own machine is up again (it's on that machine). */
  hostUp?: string;
  /** Written to the tasks' history once it went out. */
  after?: () => void;
  queuedAt: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rowsOf(raw: unknown): QueuedRow[] {
  return (Array.isArray(raw) ? raw : []) as QueuedRow[];
}

export function createWatchdog(bb: BbPluginApi, deps: WatchdogDeps): Watchdog {
  const now = () => deps.now?.() ?? Date.now();
  /** Host id → background work seen while it was up. */
  const seen = new Map<string, Seen>();
  /** Host id → resource (sandbox id). */
  const resources = new Map<string, string | null>();
  /** Host id → when to try a suspend or resume again. */
  const retryAt = new Map<string, number>();
  /** Host id → the outcome of the plugin's last resume of it. */
  const resumed = new Map<string, { at: number; ok: boolean; error: string | null }>();
  /** Host id → why the plugin couldn't bring bb's record in line (a failed suspend). */
  const problems = new Map<string, string>();
  /** Host id → the stop it's reconciling (bb's last sight of the machine), and how many tries. */
  const tries = new Map<string, { episode: number; count: number }>();
  /** Host ids the plugin suspended at its limit for background work (the notice says so). */
  const atLimit = new Set<string>();
  /** Host id → up and connected at the last look. */
  const upNow = new Map<string, boolean>();
  /** Thread id → since when its messages wait on a down machine. */
  const waiting = new Map<string, number>();
  /** Task id → the turn the watchdog watches: since when, and when it last looked. */
  const turns = new Map<string, { key: string; since: number; checked: number }>();
  /** Thread id → its pending note (the kv copy survives restarts). */
  const notes = new Map<string, ResumeNote>();
  /** Threads whose note held one dispatch already (a second never waits). */
  const held = new Set<string>();
  /** Notes already delivered (task ids), so a second way to the worker doesn't count again. */
  const delivered = new Set<string>();
  /** Notices waiting to go out. */
  let outbox: Outgoing[] = [];
  /** When the machines were last looked at; a message for an offline machine asks for a look at once. */
  let machinesAt = Number.NEGATIVE_INFINITY;
  let urgent = false;

  // ---------------------------------------------------------------- notices

  async function sentLog(): Promise<Record<string, number>> {
    const raw = await deps.kv.get<unknown>(WATCHDOG_KEY).catch(() => undefined);
    const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as { sent?: unknown }).sent : undefined;
    return record !== null && typeof record === "object" ? (record as Record<string, number>) : {};
  }

  function post(notice: Omit<Outgoing, "queuedAt">): void {
    if (outbox.some((entry) => entry.incident === notice.incident && entry.threadId === notice.threadId)) return;
    outbox.push({ ...notice, queuedAt: now() });
  }

  /** Send what can go out: not twice for one incident, not during a handover, not into a chat whose machine is down. */
  async function flush(): Promise<void> {
    if (outbox.length === 0) return;
    const at = now();
    const sent = await sentLog();
    const keep: Outgoing[] = [];
    let wrote = false;
    for (const entry of outbox) {
      if (entry.taskId !== undefined) entry.threadId = deps.store.get(entry.taskId)?.orchestratorThreadId ?? entry.threadId;
      if (sent[`i:${entry.incident}:${entry.threadId}`] !== undefined) continue;
      const last = sent[`s:${entry.subject}:${entry.threadId}`];
      if (last !== undefined && at - last < entry.gapMs) continue;
      if (at - entry.queuedAt > OUTBOX_TTL_MS) continue;
      if ((entry.hostUp !== undefined && upNow.get(entry.hostUp) !== true) || (await deps.deferred?.(entry.threadId).catch(() => false))) {
        keep.push(entry);
        continue;
      }
      try {
        await deps.tell(entry.threadId, entry.text);
      } catch (error) {
        deps.log(`watchdog notice to ${entry.threadId}: ${message(error)}`);
        keep.push(entry);
        continue;
      }
      sent[`i:${entry.incident}:${entry.threadId}`] = at;
      sent[`s:${entry.subject}:${entry.threadId}`] = at;
      wrote = true;
      entry.after?.();
    }
    outbox = keep;
    if (!wrote) return;
    const next: Record<string, number> = {};
    for (const [key, value] of Object.entries(sent)) if (typeof value === "number" && at - value < SENT_TTL_MS) next[key] = value;
    await deps.kv.set(WATCHDOG_KEY, { sent: next }).catch((error: unknown) => deps.log(`watchdog: ${message(error)}`));
  }

  function event(tasks: Task[], text: string): void {
    for (const task of tasks) deps.store.addEvent(task.id, "watchdog", text);
    if (tasks.length > 0) deps.changed?.(tasks.map((task) => task.id));
  }

  // ---------------------------------------------------------------- notes

  async function setNote(task: Task, stoppedAt: number, work: string, capped: boolean): Promise<void> {
    const note: ResumeNote = { taskId: task.id, threadId: task.runner === "chat" ? task.threadId : null, text: resumeNoteText(stoppedAt, work, now(), capped) };
    await deps.kv.set(resumeNoteKey(task.id), note).catch((error: unknown) => deps.log(`resume note ${task.id}: ${message(error)}`));
    delivered.delete(task.id);
    if (note.threadId !== null) {
      notes.set(note.threadId, note);
      held.delete(note.threadId);
    }
  }

  async function dropNote(note: ResumeNote, how: string): Promise<void> {
    // Once: whichever way reaches the worker first takes it.
    if (note.threadId !== null && notes.get(note.threadId)?.taskId === note.taskId) notes.delete(note.threadId);
    if (delivered.has(note.taskId)) return;
    delivered.add(note.taskId);
    await deps.kv.delete(resumeNoteKey(note.taskId)).catch(() => undefined);
    deps.store.addEvent(note.taskId, "watchdog", `Told the agent (${how}) that its background jobs and /tmp were lost in the stop.`);
    deps.changed?.([note.taskId]);
  }

  function noteBlock(content: unknown[]): boolean {
    return content.some((block) => {
      const entry = block as { type?: string; text?: string } | null;
      return entry?.type === "text" && typeof entry.text === "string" && entry.text.startsWith(RESUME_NOTE_PREFIX);
    });
  }

  /**
   * Put the note in front of a queued message (its own blocks stay as they
   * were; the note is for the agent only). True: the row carries it now.
   */
  async function prepend(note: ResumeNote, row: QueuedRow): Promise<boolean> {
    if (noteBlock(row.content)) return true;
    if (row.editable === false) return false;
    await bb.sdk.threads.queuedMessages.update({
      threadId: row.threadId,
      queuedMessageId: row.id,
      expectedUpdatedAt: row.updatedAt,
      input: [{ type: "text", text: note.text, mentions: [], visibility: "agent-only" }, ...row.content],
    } as never);
    return true;
  }

  /** Into the first editable row the chat has queued (re-read once, as the row may have moved on). */
  async function prependQueued(note: ResumeNote, threadId: string, preferred?: QueuedRow): Promise<boolean> {
    if (preferred !== undefined) {
      try {
        if (await prepend(note, preferred)) return true;
      } catch {
        // Changed meanwhile: read it again.
      }
    }
    const rows = rowsOf(await bb.sdk.threads.queuedMessages.list({ threadId } as never).catch(() => []));
    const row = rows.find((candidate) => candidate.id === preferred?.id) ?? rows.find((candidate) => candidate.editable !== false);
    return row === undefined ? false : prepend(note, row).catch(() => false);
  }

  // ---------------------------------------------------------------- machines

  async function sandboxOf(hostId: string): Promise<string | null> {
    if (resources.has(hostId)) return resources.get(hostId) ?? null;
    const parsed = resourceSchema.safeParse(await bb.experimental_machines.getResource(hostId).catch(() => null));
    const sandboxId = parsed.success ? parsed.data.sandboxId : null;
    resources.set(hostId, sandboxId);
    return sandboxId;
  }

  /** Who hears about a machine: the orchestrators of the tasks on it, and an orchestrator that runs there itself. */
  function audience(sandboxId: string, rows: ThreadRow[]): { tasks: Task[]; own: string[] } {
    const tasks = deps.store.list({ statuses: OPEN_STATUSES, limit: 1000 }).filter((task) => task.sandboxId === sandboxId);
    const { current } = deps.store.orchestratorThreadIds();
    const own = rows.map((row) => row.id).filter((id): id is string => id !== undefined && current.has(id));
    return { tasks, own };
  }

  function remember(hostId: string, rows: ThreadRow[], at: number): void {
    let work = NO_WORK;
    const chats: Seen["chats"] = [];
    for (const row of rows) {
      const own = rowWork(row);
      if (!hasWork(own) || row.id === undefined) continue;
      work = addWork(work, own);
      chats.push({ threadId: row.id, work: own });
    }
    if (hasWork(work)) seen.set(hostId, { since: seen.get(hostId)?.since ?? at, at, work, chats });
    else seen.delete(hostId);
  }

  /** The machine stopped while background work ran there: tell everyone concerned, once. */
  async function stoppedUnderWork(hostId: string, sandboxId: string, rows: ThreadRow[], stoppedAt: number, cause: string, did: string): Promise<void> {
    const last = seen.get(hostId);
    seen.delete(hostId);
    if (last === undefined || stoppedAt - last.at > SEEN_FRESH_MS) return;
    // At the plugin's limit for background work: it may have been stuck, so no "rerun it now".
    const capped = last.at - last.since >= CAPPED_AFTER_MS;
    const { tasks, own } = audience(sandboxId, rows);
    const incident = `stopped:${sandboxId}:${Math.floor(stoppedAt / 60_000)}`;
    const work = describeWork(last.work);
    event(tasks, `The sandbox stopped while ${work} was running in the background. ${cause} ${did}`);
    for (const task of tasks) await setNote(task, stoppedAt, work, capped);
    const told = new Set<string>();
    for (const task of tasks) {
      const threadId = task.orchestratorThreadId;
      if (threadId === null || told.has(threadId)) continue;
      told.add(threadId);
      const text = stoppedNotice({ subject: { kind: "task", taskId: task.id, title: task.title, sandboxId }, work, stoppedAt, cause, did, now: now(), capped });
      post({ threadId, taskId: task.id, gapMs: STOP_NOTICE_GAP_MS, incident, subject: `stopped:${sandboxId}`, text });
    }
    for (const threadId of own) {
      if (told.has(threadId)) continue;
      told.add(threadId);
      const mine = last.chats.filter((chat) => chat.threadId === threadId);
      const ownWork = mine.length > 0 ? describeWork(mine.reduce((sum, chat) => addWork(sum, chat.work), NO_WORK)) : work;
      post({
        threadId,
        gapMs: STOP_NOTICE_GAP_MS,
        incident,
        subject: `stopped:${sandboxId}`,
        text: stoppedNotice({ subject: { kind: "own", sandboxId }, work: ownWork, stoppedAt, cause, did, now: now(), capped }),
        // A boat stop: the notice itself resumes the orchestrator to rerun what it needs.
        // At the limit: it waits until something else wakes the machine (no loop).
        ...(capped ? { hostUp: hostId } : {}),
      });
    }
  }

  /** Suspend through bb a machine whose sandbox boat stopped behind bb's back. Returns what the plugin did. */
  async function reconcile(host: HostRow, sandboxId: string, at: number): Promise<{ ok: boolean; did: string }> {
    try {
      await bb.sdk.hosts.experimental_suspend({ hostId: host.id } as never);
      problems.delete(host.id);
      deps.suspended?.(host.id);
      deps.info?.(`watchdog: ${host.id} (${sandboxId}) was stopped by boat; suspended it through bb`);
      return { ok: true, did: "The plugin suspended its bb machine to match, so the next message resumes it." };
    } catch (error) {
      retryAt.set(host.id, at + RETRY_MS);
      problems.set(host.id, message(error));
      deps.log(`watchdog: suspend ${host.id}: ${message(error)}`);
      return { ok: false, did: `The plugin couldn't update bb's record of the machine (${message(error)}); it tries again in a few minutes.` };
    }
  }

  async function resume(hostId: string, at: number): Promise<void> {
    try {
      await bb.sdk.hosts.experimental_resume({ hostId } as never);
      resumed.set(hostId, { at, ok: true, error: null });
      deps.resumed?.(hostId);
      deps.info?.(`watchdog: resumed ${hostId}: messages were waiting for it`);
    } catch (error) {
      retryAt.set(hostId, at + RETRY_MS);
      resumed.set(hostId, { at, ok: false, error: message(error) });
      deps.log(`watchdog: resume ${hostId}: ${message(error)}`);
    }
  }

  /**
   * Since when a chat's oldest message waits for its machine (null: none
   * does). A message held for later on purpose (a retry at a usage limit's
   * reset, a slot under bb's limits, an answer the agent waits for) doesn't
   * count, nor do the plugin's own notices.
   */
  async function waitingSince(threadId: string, at: number): Promise<number | null> {
    let rows: QueuedRow[];
    try {
      rows = rowsOf(await bb.sdk.threads.queuedMessages.list({ threadId } as never));
    } catch {
      return waiting.get(threadId) ?? null;
    }
    const onMachine = rows.filter(
      (row) =>
        (row.state === "queued" || row.state === "waiting") &&
        (row.sendAt === null || row.sendAt === undefined || row.sendAt <= at) &&
        MACHINE_WAITS.has(row.waitingOn?.kind ?? "") &&
        (row as { originPluginId?: string | null }).originPluginId !== bb.pluginId,
    );
    if (onMachine.length === 0) {
      waiting.delete(threadId);
      return null;
    }
    const oldest = Math.min(at, ...onMachine.map((row) => (typeof row.createdAt === "number" ? row.createdAt : at)));
    const since = Math.min(oldest, waiting.get(threadId) ?? oldest);
    waiting.set(threadId, since);
    return since;
  }

  function subjectFor(threadId: string, sandboxId: string): { subject: NoticeSubject; to: string | null; task: Task | null } | null {
    const task = deps.store.byThread(threadId);
    if (task !== null && OPEN_STATUSES.includes(task.status) && task.orchestratorThreadId !== null) {
      return { subject: { kind: "task", taskId: task.id, title: task.title, sandboxId }, to: task.orchestratorThreadId, task };
    }
    // The orchestrator's own machine: a message into it would only queue behind the others.
    if (deps.store.orchestratorThreadIds().current.has(threadId)) return { subject: { kind: "own", sandboxId }, to: null, task: null };
    return null;
  }

  async function machines(at: number, sandboxes: Map<string, Sandbox>): Promise<void> {
    const hosts = ((await bb.sdk.hosts.list()) as unknown as HostRow[]).filter((host) => host.machineProviderId === MACHINE_PROVIDER_ID);
    const live = new Set(hosts.map((host) => host.id));
    for (const id of new Set([...seen.keys(), ...resources.keys(), ...resumed.keys(), ...problems.keys(), ...upNow.keys(), ...tries.keys()])) {
      if (live.has(id)) continue;
      seen.delete(id);
      resources.delete(id);
      resumed.delete(id);
      problems.delete(id);
      upNow.delete(id);
      tries.delete(id);
    }
    let resumes = 0;
    for (const host of hosts) {
      const phase = host.lifecycle?.phase ?? null;
      if (phase === "creating" || phase === "removing" || phase === "destroyed") continue;
      const sandboxId = await sandboxOf(host.id);
      // The plugin is moving, resizing or dispatching there: it stops and starts that sandbox itself.
      if (sandboxId === null || deps.held?.(sandboxId)) continue;
      const sandbox = sandboxes.get(sandboxId);
      if (sandbox === undefined) continue;
      let rows: ThreadRow[];
      try {
        rows = await threadsOnMachine(bb, host.id);
      } catch (error) {
        deps.log(`watchdog: chats on ${host.id}: ${message(error)}`);
        continue;
      }
      const connected = host.status === "connected";
      const up = phase === "active" && !host.lifecycle?.suspendedAt;
      const running = up && connected && ACTIVE_STATES.has(sandbox.state);
      if (running && upNow.get(host.id) !== true) deps.resumed?.(host.id);
      upNow.set(host.id, running);
      if (running) {
        remember(host.id, rows, at);
        resumed.delete(host.id);
        problems.delete(host.id);
        tries.delete(host.id);
      } else if (up && STOPPED_STATES.has(sandbox.state) && !connected) {
        // boat stopped it behind bb's back: bb would wait for it forever.
        const stoppedAt = typeof host.lastSeenAt === "number" ? host.lastSeenAt : at;
        const attempt = tries.get(host.id);
        const count = attempt?.episode === stoppedAt ? attempt.count : 0;
        if ((retryAt.get(host.id) ?? 0) <= at && count < RECONCILE_TRIES) {
          tries.set(host.id, { episode: stoppedAt, count: count + 1 });
          // Not seen up since a restart of the plugin: what bb last knew runs there.
          if (!seen.has(host.id)) remember(host.id, rows, stoppedAt);
          const hadWork = seen.has(host.id);
          const done = await reconcile(host, sandboxId, at);
          const cause = "boat stopped it (its auto-stop, a crash or the boat.dev dashboard), not bb.";
          if (done.ok && !hadWork) {
            const tasks = audience(sandboxId, rows).tasks.filter((task) => task.runner === "chat");
            event(tasks, "boat stopped the sandbox (its auto-stop, a crash or the boat.dev dashboard); the plugin suspended its bb machine to match, and bb resumes it on the next message.");
          }
          await stoppedUnderWork(host.id, sandboxId, rows, stoppedAt, cause, done.did);
        }
      } else if ((phase === "suspended" || phase === "suspending") && seen.has(host.id)) {
        // Suspended under background work: by the plugin at its limit, or by bb or someone's click.
        const stoppedAt = host.lifecycle?.suspendedAt ?? at;
        const cause = atLimit.delete(host.id) ? "The plugin suspended it: that's the most it keeps a sandbox on for background work." : "bb suspended the machine.";
        await stoppedUnderWork(host.id, sandboxId, rows, stoppedAt, cause, "bb resumes it on the next message.");
      }

      // Messages waiting for the machine while it's down.
      const down = !running;
      for (const row of rows) if (row.id !== undefined && (!down || !messagesWaiting(row))) waiting.delete(row.id);
      if (!down) continue;
      const waitingRows: { row: ThreadRow; since: number }[] = [];
      for (const row of rows.filter(messagesWaiting)) {
        const since = row.id === undefined ? null : await waitingSince(row.id, at);
        if (since !== null) waitingRows.push({ row, since });
      }
      if (waitingRows.length === 0) continue;
      const oldest = Math.min(...waitingRows.map((entry) => entry.since));
      // Read bb's record again right before acting on it (the suspend above, or bb's own resume).
      const fresh = (await bb.sdk.hosts.get({ hostId: host.id } as never).catch(() => null)) as unknown as HostRow | null;
      const phaseNow = fresh?.lifecycle?.phase ?? phase;
      const last = resumed.get(host.id);
      if (phaseNow === "suspended" && at - oldest >= RESUME_AFTER_MS && (retryAt.get(host.id) ?? 0) <= at && !(last?.ok === true && at - last.at < RESUME_AGAIN_MS) && resumes < RESUMES_PER_PASS) {
        // bb resumes a suspended machine for a new message itself; one queued before the stop it may not.
        resumes += 1;
        await resume(host.id, at);
      }
      const stopped = STOPPED_STATES.has(sandbox.state);
      const outcome = resumed.get(host.id);
      const problem = problems.get(host.id);
      const machine = phaseNow === "resuming" ? "starting up" : stopped ? "stopped" : phaseNow === "suspending" ? "being suspended by bb" : "running, but bb has lost its connection to it";
      const did =
        outcome !== undefined
          ? outcome.ok
            ? "The plugin resumed it; the messages go out once bb is set up there again."
            : `The plugin tried to resume it and couldn't: ${outcome.error}. It tries again in a few minutes; the user can also resume the machine from bb's machine menu.`
          : problem !== undefined
            ? (tries.get(host.id)?.count ?? 0) >= RECONCILE_TRIES
              ? `The plugin couldn't resume it: bb still has the machine as running and refused to suspend it (${problem}). Ask the user to resume the machine from bb's machine menu.`
              : `The plugin couldn't resume it yet: bb still has the machine as running (${problem}). It tries again in a few minutes.`
            : phaseNow === "resuming"
              ? "bb is resuming it itself; the plugin left that alone."
              : phaseNow === "suspending"
                ? "bb's suspend hasn't finished; the plugin resumes it once it has."
                : stopped
                  ? "The plugin resumes it on its next check."
                  : "The plugin left it alone: bb usually reconnects on its own. If it doesn't, restart the machine from bb's machine menu.";
      const threshold = phaseNow === "resuming" ? RESUMING_NOTICE_MS : WAIT_NOTICE_MS;
      for (const { row, since } of waitingRows) {
        if (row.id === undefined || at - since < threshold) continue;
        const target = subjectFor(row.id, sandboxId);
        if (target === null) continue;
        const text = waitingNotice({ subject: target.subject, waitedMs: at - since, machine, did });
        const incident = `waiting:${row.id}:${Math.floor(since / 60_000)}`;
        if (target.to === null) {
          // An orchestrator stuck on its own machine: the user hears of it instead.
          const sent = await sentLog();
          if (sent[`i:${incident}:user`] === undefined && deps.notifyUser !== undefined) {
            await deps.notifyUser("An orchestrator is waiting for its sandbox", text.replace(/^\[boat\] Watchdog: /, "")).catch(() => undefined);
            sent[`i:${incident}:user`] = at;
            await deps.kv.set(WATCHDOG_KEY, { sent }).catch(() => undefined);
          }
          continue;
        }
        const task = target.task;
        post({
          threadId: target.to,
          ...(task === null ? {} : { taskId: task.id }),
          gapMs: NOTICE_GAP_MS,
          incident,
          subject: `waiting:${row.id}`,
          text,
          ...(task === null ? {} : { after: () => event([task], `Messages waited ${Math.round((at - since) / 60_000)} minutes for the machine (sandbox ${machine}); the orchestrator was told.`) }),
        });
      }
    }
  }

  // ---------------------------------------------------------------- quiet turns

  /** A chat's turn is really under way (not just queued, not waiting on background work). */
  async function chatTurnRuns(threadId: string): Promise<boolean> {
    const raw = (await bb.sdk.threads.list({ threadIds: [threadId], includeHidden: true } as never)) as unknown;
    const row = ((Array.isArray(raw) ? raw : ((raw as { threads?: unknown[] } | null)?.threads ?? [])) as ThreadRow[]).find((entry) => entry.id === threadId);
    if (row === undefined) return false;
    // Waiting on the user (an approval, a question) isn't being stuck either.
    return (row.status === "active" || row.status === "starting") && row.hasPendingInteraction !== true && row.queuedWork !== "waiting" && !hasWork(rowWork(row));
  }

  async function lastActivity(task: Task): Promise<number | null> {
    if (task.runner === "chat") {
      if (task.threadId === null) return null;
      const raw = (await bb.sdk.threads.events.list({ threadId: task.threadId, order: "desc", limit: "1" } as never)) as unknown;
      const rows = (Array.isArray(raw) ? raw : ((raw as { events?: unknown[] } | null)?.events ?? [])) as { createdAt?: number }[];
      const at = rows[0]?.createdAt;
      return typeof at === "number" ? at : null;
    }
    if (task.sandboxId === null || task.conversationId === null) return null;
    const events = await deps.boat.events(task.sandboxId, task.conversationId, deps.signal);
    const stamps = events.map((entry) => entry.timestamp).filter((value): value is number => value !== null);
    return stamps.length > 0 ? Math.max(...stamps) : null;
  }

  async function quietTurns(at: number): Promise<void> {
    const running = deps.store.list({ statuses: ["running"], limit: 1000 });
    const live = new Set(running.map((task) => task.id));
    for (const id of turns.keys()) if (!live.has(id)) turns.delete(id);
    for (const task of running) {
      if (task.orchestratorThreadId === null) continue;
      const key = `${task.turns}:${task.promptId ?? ""}`;
      let entry = turns.get(task.id);
      if (entry === undefined || entry.key !== key) {
        entry = { key, since: at, checked: at };
        turns.set(task.id, entry);
        continue;
      }
      if (at - entry.since < QUIET_TURN_MS || at - entry.checked < QUIET_CHECK_MS) continue;
      entry.checked = at;
      let last: number | null;
      try {
        // Waiting to run, or on its background work, isn't being stuck.
        if (task.runner === "chat" && (task.threadId === null || !(await chatTurnRuns(task.threadId)))) continue;
        last = await lastActivity(task);
      } catch (error) {
        deps.log(`watchdog: transcript of ${task.id}: ${message(error)}`);
        continue;
      }
      // Nothing to go by: from when the watchdog first saw the turn.
      const quietSince = Math.max(last ?? entry.since, entry.since - QUIET_TURN_MS);
      if (at - quietSince < QUIET_TURN_MS) continue;
      const text = quietNotice({ taskId: task.id, title: task.title, quietMs: at - quietSince, lastAt: quietSince, now: at });
      post({
        threadId: task.orchestratorThreadId,
        taskId: task.id,
        gapMs: NOTICE_GAP_MS,
        incident: `quiet:${task.id}:${key}`,
        subject: `quiet:${task.id}`,
        text,
        after: () => event([task], `No new activity in this turn for ${Math.round((at - quietSince) / 60_000)} minutes; the orchestrator was told it may be stuck.`),
      });
    }
  }

  // ---------------------------------------------------------------- the pass

  return {
    async tick() {
      const at = now();
      await quietTurns(at).catch((error: unknown) => deps.log(`watchdog: turns: ${message(error)}`));
      if (urgent || at - machinesAt >= MACHINES_EVERY_MS) {
        urgent = false;
        machinesAt = at;
        try {
          const sandboxes = new Map((await deps.boat.list({ all: true, signal: deps.signal })).map((sandbox) => [sandbox.id, sandbox]));
          await machines(at, sandboxes);
        } catch (error) {
          deps.log(`watchdog: machines: ${message(error)}`);
        }
      }
      await flush().catch((error: unknown) => deps.log(`watchdog: notices: ${message(error)}`));
    },

    async queued(entry) {
      if (entry.waitingOn?.kind === "host-offline") urgent = true;
      const note = notes.get(entry.threadId);
      if (note === undefined) return;
      try {
        if (await prependQueued(note, entry.threadId, entry)) await dropNote(note, "before the next message");
      } catch (error) {
        deps.log(`resume note for ${note.taskId}: ${message(error)}`);
      }
    },

    dispatch(context) {
      try {
        const note = notes.get(context.threadId);
        if (note === undefined || context.attempt !== "start-turn") return { action: "proceed" };
        // The plugin's own follow-ups carry the note already; so does a row it was put in front of.
        if (context.originPluginId === bb.pluginId || context.text.includes(RESUME_NOTE_PREFIX) || context.queued.some((row) => noteBlock(row.content))) {
          return { action: "proceed" };
        }
        // Once only: a message that reaches the worker without the note goes ahead.
        if (held.has(context.threadId)) return { action: "proceed" };
        held.add(context.threadId);
        // A queued row takes the note now; an inline send becomes one, and
        // message.queued puts it there. The second try goes ahead either way.
        const first = context.queued[0];
        if (first !== undefined) {
          void prependQueued(note, context.threadId, first)
            .then((done) => (done ? dropNote(note, "before the next message") : undefined))
            .catch(() => undefined);
        }
        return { action: "wait", reason: "Adding a note about the sandbox's restart", sendAt: now() + 10_000 };
      } catch {
        return { action: "proceed" };
      }
    },

    async noteFor(taskId) {
      if (delivered.has(taskId)) return null;
      const parsed = noteSchema.safeParse(await deps.kv.get<unknown>(resumeNoteKey(taskId)).catch(() => undefined));
      return parsed.success ? parsed.data.text : null;
    },

    async noteSent(taskId) {
      const parsed = noteSchema.safeParse(await deps.kv.get<unknown>(resumeNoteKey(taskId)).catch(() => undefined));
      if (parsed.success) await dropNote(parsed.data, "in the follow-up");
    },

    planned(hostId, underWork) {
      if (underWork) atLimit.add(hostId);
      else {
        seen.delete(hostId);
        atLimit.delete(hostId);
      }
    },

    async load() {
      const keys = await deps.kv.list(resumeNoteKey("")).catch(() => [] as string[]);
      for (const key of keys) {
        const parsed = noteSchema.safeParse(await deps.kv.get<unknown>(key).catch(() => undefined));
        if (parsed.success && parsed.data.threadId !== null) notes.set(parsed.data.threadId, parsed.data);
      }
    },
  };
}
