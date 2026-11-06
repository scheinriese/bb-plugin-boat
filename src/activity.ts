// What bb says still runs in a chat after its turn has ended: background
// agents, background shell commands and bb workflows (the activity counts
// on bb's thread list), and the chat's own child chats. The keeper, the
// idle stop, "make room at your sandbox limit" and the watchdog all read it
// here, so work in the background keeps a sandbox on everywhere alike.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Background work (and a turn the keeper keeps on) counts at most this long
 * in a row: a turn that runs longer is likely stuck, and a background job
 * that never ends shouldn't keep a sandbox on for good.
 */
export const KEEP_LIMIT_MS = 12 * 60 * 60_000;

/** What the plugin reads of a bb thread (threads.list rows). */
export interface ThreadRow {
  id?: string;
  title?: string | null;
  status?: string;
  archivedAt?: number | null;
  deletedAt?: number | null;
  /** Messages waiting to run ("waiting"), or none. */
  queuedWork?: string;
  /** The agent is blocked on the user: an approval or a question. */
  hasPendingInteraction?: boolean;
  /** `status` refined by the machine's state ("waiting-for-host", "provisioning"). */
  runtime?: { displayStatus?: string } | null;
  runtimeStatus?: string;
  activity?: {
    activeBackgroundAgentCount?: number;
    activeBackgroundCommandCount?: number;
    activeWorkflowCount?: number;
  } | null;
  parentThreadId?: string | null;
  /** The plugin that started the chat (this plugin's own task chats report to the plugin). */
  originPluginId?: string | null;
  environmentHostId?: string | null;
  updatedAt?: number;
}

/** Background work: what bb counts for a chat after its turn, and working child chats. */
export interface BackgroundWork {
  agents: number;
  commands: number;
  workflows: number;
  children: number;
}

export const NO_WORK: BackgroundWork = Object.freeze({ agents: 0, commands: 0, workflows: 0, children: 0 });

/** bb thread states with a turn under way (or about to start, or ending). */
const TURN_STATES = new Set(["active", "starting", "pending", "stopping"]);

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function isOpen(row: ThreadRow): boolean {
  return !row.archivedAt && !row.deletedAt;
}

/** The background work bb reports for one chat. */
export function rowWork(row: ThreadRow): BackgroundWork {
  if (!isOpen(row)) return NO_WORK;
  return {
    agents: count(row.activity?.activeBackgroundAgentCount),
    commands: count(row.activity?.activeBackgroundCommandCount),
    workflows: count(row.activity?.activeWorkflowCount),
    children: 0,
  };
}

export function addWork(a: BackgroundWork, b: BackgroundWork): BackgroundWork {
  return { agents: a.agents + b.agents, commands: a.commands + b.commands, workflows: a.workflows + b.workflows, children: a.children + b.children };
}

export function hasWork(work: BackgroundWork): boolean {
  return work.agents + work.commands + work.workflows + work.children > 0;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `a ${one}` : `${n} ${many}`;
}

/** "a bb workflow, 2 background commands and a child chat" (empty: nothing). */
export function describeWork(work: BackgroundWork): string {
  const parts = [
    work.workflows > 0 ? plural(work.workflows, "bb workflow", "bb workflows") : null,
    work.commands > 0 ? plural(work.commands, "background command", "background commands") : null,
    work.agents > 0 ? plural(work.agents, "background agent", "background agents") : null,
    work.children > 0 ? plural(work.children, "child chat", "child chats") : null,
  ].filter((part): part is string => part !== null);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** A turn is under way in the chat (or about to start, or ending). */
export function turnRuns(row: ThreadRow): boolean {
  return isOpen(row) && TURN_STATES.has(row.status ?? "");
}

/** Messages wait to run in the chat (bb resumes a suspended machine for them). */
export function messagesWaiting(row: ThreadRow): boolean {
  return isOpen(row) && row.queuedWork === "waiting";
}

/**
 * A child chat counts while its turn runs or while its own background work
 * does; not while it only waits on the user (an approval, a question).
 */
export function childWorking(row: ThreadRow): boolean {
  if (!isOpen(row)) return false;
  const display = row.runtime?.displayStatus ?? row.runtimeStatus;
  // Its machine is down: nothing of it is running.
  if (display === "waiting-for-host" || display === "provisioning") return false;
  if (hasWork(rowWork(row))) return true;
  return (row.status === "active" || row.status === "starting") && row.hasPendingInteraction !== true;
}

/** What bb reports running on one machine. */
export interface MachineActivity {
  /** The chats on the machine (bb's list, hidden ones included). */
  rows: ThreadRow[];
  /** Child chats of those chats that work elsewhere (this plugin's own task chats aside). */
  children: ThreadRow[];
  /** Background work across the machine's chats, plus the working child chats. */
  background: BackgroundWork;
  /** A turn is under way in one of its chats. */
  turns: boolean;
  /** A message waits to run in one of its chats. */
  waiting: boolean;
}

function rowsOf(raw: unknown): ThreadRow[] {
  return (Array.isArray(raw) ? raw : ((raw as { threads?: unknown[] } | null)?.threads ?? [])) as ThreadRow[];
}

/** The chats on a machine (null: bb couldn't say). */
export async function threadsOnMachine(bb: BbPluginApi, hostId: string): Promise<ThreadRow[]> {
  return rowsOf(await bb.sdk.threads.list({ hostId, includeHidden: true } as never));
}

/** bb machines that are Boat sandboxes (the plugin looks after those itself). */
export async function boatMachineIds(bb: BbPluginApi, providerId: string): Promise<Set<string>> {
  const raw = (await bb.sdk.hosts.list()) as unknown;
  const hosts = (Array.isArray(raw) ? raw : ((raw as { hosts?: unknown[] } | null)?.hosts ?? [])) as { id?: string; machineProviderId?: string | null }[];
  return new Set(hosts.filter((host) => host.machineProviderId === providerId && typeof host.id === "string").map((host) => host.id!));
}

/**
 * Working child chats of these chats elsewhere (a subagent chat on this bb
 * machine, a laptop). Children on a Boat sandbox don't count: that sandbox
 * is kept on for them itself, and when their turn ends the plugin (or bb)
 * messages the parent, which resumes its machine. Nor do this plugin's own
 * task chats, for the same reason.
 */
export async function workingChildren(bb: BbPluginApi, parents: ThreadRow[], boatMachines: Set<string>): Promise<ThreadRow[]> {
  const found: ThreadRow[] = [];
  for (const parent of parents) {
    if (parent.id === undefined || !isOpen(parent)) continue;
    const children = rowsOf(await bb.sdk.threads.list({ parentThreadId: parent.id, includeHidden: true } as never));
    for (const child of children) {
      if (child.environmentHostId && boatMachines.has(child.environmentHostId)) continue;
      if (child.originPluginId === bb.pluginId) continue;
      if (childWorking(child)) found.push(child);
    }
  }
  return found;
}

/** What runs on a machine. Throws when bb can't list its chats. */
export async function readMachineActivity(bb: BbPluginApi, hostId: string, options: { children?: boolean; providerId?: string } = {}): Promise<MachineActivity> {
  const rows = (await threadsOnMachine(bb, hostId)).filter(isOpen);
  const children =
    options.children === false
      ? []
      : await boatMachineIds(bb, options.providerId ?? "boat-sandbox")
          .then((boat) => workingChildren(bb, rows, boat.add(hostId)))
          .catch(() => []);
  let background = NO_WORK;
  for (const row of rows) background = addWork(background, rowWork(row));
  background = { ...background, children: children.length };
  return { rows, children, background, turns: rows.some(turnRuns), waiting: rows.some(messagesWaiting) };
}
