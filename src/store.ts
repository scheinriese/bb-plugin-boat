// Plugin-owned task registry (SQLite, <dataDir>/plugins/boat/data.db).
//
// A task is one piece of delegated work: a coding agent conversation inside a
// boat sandbox, dispatched by (usually) an orchestrator thread.
import { eventMetadata, projectHistoryEvent, reviewFindings, type EventMetadata } from "./history.ts";
import { randomBytes } from "node:crypto";
import { START_QUEUE_MIGRATIONS } from "./start-queue-migrations.ts";
import { CHAT_RECOVERY_MIGRATIONS } from "./chat-recovery-migrations.ts";
import type Database from "better-sqlite3";
import { normalizeDecisionOptions, type DecisionOption, type DecisionOptionInput, historyInputSchema, type HistoryEventDto } from "../contract-fidelity.ts";

export const TASK_ROLES = ["implement", "review", "custom"] as const;
export type TaskRole = (typeof TASK_ROLES)[number];

/**
 * running   — the agent is working on a turn.
 * idle      — the last turn finished; waiting for the orchestrator to decide.
 * failed    — the turn or the sandbox failed; see `error`.
 * done      — the orchestrator closed the task (accepted / merged).
 * cancelled — the orchestrator or user stopped the task.
 */
export const TASK_STATUSES = ["starting", "running", "idle", "failed", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const OPEN_STATUSES: readonly TaskStatus[] = ["starting", "running", "idle", "failed"];

export const PROVIDERS = ["claude", "codex"] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * chat — the worker is a regular bb chat on a boat sandbox machine (you can
 *        type into it; the plugin wakes the orchestrator when its turn ends).
 * boat — the worker is a boat conversation the plugin drives with `boat prompt`.
 */
export const RUNNERS = ["chat", "boat"] as const;
export type Runner = (typeof RUNNERS)[number];

export interface Task {
  id: string;
  title: string;
  compactTitle?: string | null;
  role: TaskRole;
  status: TaskStatus;
  orchestratorThreadId: string | null;
  projectId: string | null;
  repo: string | null;
  /** The task's own checkout inside the sandbox. */
  repoPath: string | null;
  branch: string | null;
  baseBranch: string | null;
  sandboxId: string | null;
  conversationId: string | null;
  promptId: string | null;
  provider: Provider;
  model: string | null;
  reasoningEffort: string | null;
  /** Model tier the orchestrator chose (light … frontier); null = a model picked by hand. */
  tier: string | null;
  /** The orchestrator's one-line reason for the tier/model. */
  reason: string | null;
  runner: Runner;
  /** chat: the worker's current bb chat (a handover to the other agent opens a new one). */
  threadId: string | null;
  /** chat: the bb machine that wraps the sandbox. */
  hostId: string | null;
  /** chat: the bb environment (workspace) the worker chat runs in; reviewers can share it. */
  environmentId: string | null;
  /** When the orchestrator marked the work ready for the user to review (cleared by the next turn). */
  readyAt: string | null;
  /** The orchestrator's one-line note for the user (what to look at). */
  readyNote: string | null;
  /** pr: the worker pushes its branch and opens a draft PR; push: it only commits, and the plugin ships to the base branch once the user approves. */
  delivery: Delivery;
  /** The orchestrator project this task belongs to (projects table id, or local:<bb project>). */
  boatProject: string | null;
  /** boat environment the sandbox was created with; null = the default. */
  environment: string | null;
  /** Saved boat snapshot the sandbox was created from. */
  snapshot: string | null;
  /** Other project repos cloned next to the main one (path once checked out). */
  extraRepos: { repo: string; baseBranch: string; path?: string }[];
  brief: string;
  parentTaskId: string | null;
  prUrl: string | null;
  result: string | null;
  error: string | null;
  turns: number;
  ownsSandbox: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** When the orchestrator was last told about a finished turn. */
  notifiedAt: string | null;
  /**
   * push: commits not on the base yet (+1 for changed files), checked when
   * the last turn ended; 0 = nothing to ship; null = not checked or unknown.
   */
  unshipped: number | null;
  /**
   * push: what the user approved when a ship stopped on a conflict (the
   * task's head and the base it was rebased onto). A later turn is new work
   * the user hasn't seen; cleared once the task ships or closes.
   */
  shipApproval: ShipApproval | null;
}

/** "What changed since you approved": compared in the sandbox after the turn that followed a conflict. */
export interface SinceApproval {
  /** The task's turn it was compared for. */
  turns: number;
  /** range-diff of the approved commits and the new ones; stat: `git diff --stat` instead; none: couldn't compare. */
  via: "range-diff" | "stat" | "none";
  /** At most SINCE_APPROVAL_LINES lines. */
  text: string;
  /** Lines left out (0: the whole output). */
  omitted: number;
}

export interface ShipApproval {
  /** When the ship attempt stopped. */
  at: string;
  /** The task's turns then: a higher count means newer work. */
  turns: number;
  /** The checkout that conflicted and its base branch. */
  path: string;
  baseBranch: string;
  /** The task's head commit and the base commit at that attempt. */
  head: string;
  base: string;
  /** The conflicting files (at most 10) and how many more there were. */
  files: string[];
  moreFiles: number;
  /** The ship error the user saw. */
  message: string;
  /** Filled in after the next turn. */
  changes: SinceApproval | null;
}

export interface TaskEvent {
  taskId: string;
  at: string;
  kind: string;
  text: string;
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    orchestrator_thread_id TEXT,
    project_id TEXT,
    repo TEXT,
    branch TEXT,
    base_branch TEXT,
    sandbox_id TEXT,
    conversation_id TEXT,
    prompt_id TEXT,
    provider TEXT NOT NULL,
    model TEXT,
    brief TEXT NOT NULL,
    parent_task_id TEXT,
    pr_url TEXT,
    result TEXT,
    error TEXT,
    turns INTEGER NOT NULL DEFAULT 1,
    owns_sandbox INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    notified_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status)`,
  `CREATE INDEX IF NOT EXISTS tasks_orchestrator ON tasks(orchestrator_thread_id)`,
  `CREATE TABLE IF NOT EXISTS task_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, seq)`,
  `CREATE TABLE IF NOT EXISTS orchestrators (
    thread_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  )`,
  `ALTER TABLE tasks ADD COLUMN repo_path TEXT`,
  `ALTER TABLE tasks ADD COLUMN reasoning_effort TEXT`,
  `ALTER TABLE tasks ADD COLUMN boat_project TEXT`,
  `ALTER TABLE tasks ADD COLUMN environment TEXT`,
  `ALTER TABLE tasks ADD COLUMN snapshot TEXT`,
  `ALTER TABLE tasks ADD COLUMN extra_repos TEXT`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `ALTER TABLE orchestrators ADD COLUMN project_id TEXT`,
  `ALTER TABLE orchestrators ADD COLUMN project_name TEXT`,
  `ALTER TABLE tasks ADD COLUMN tier TEXT`,
  `ALTER TABLE tasks ADD COLUMN reason TEXT`,
  `ALTER TABLE tasks ADD COLUMN runner TEXT NOT NULL DEFAULT 'boat'`,
  `ALTER TABLE tasks ADD COLUMN thread_id TEXT`,
  `ALTER TABLE tasks ADD COLUMN host_id TEXT`,
  `ALTER TABLE tasks ADD COLUMN environment_id TEXT`,
  `CREATE INDEX IF NOT EXISTS tasks_thread ON tasks(thread_id)`,
  `ALTER TABLE tasks ADD COLUMN ready_at TEXT`,
  `ALTER TABLE tasks ADD COLUMN ready_note TEXT`,
  `CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    orchestrator_thread_id TEXT,
    question TEXT NOT NULL,
    recommendation TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '[]',
    task_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    answer TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS decisions_thread ON decisions(orchestrator_thread_id, status)`,
  `ALTER TABLE tasks ADD COLUMN delivery TEXT`,
  `CREATE TABLE IF NOT EXISTS previews (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    sandbox_id TEXT NOT NULL,
    port INTEGER NOT NULL,
    path TEXT NOT NULL,
    command TEXT,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    health TEXT NOT NULL DEFAULT 'unknown',
    checked_at TEXT,
    expired_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS previews_task_port ON previews(task_id, port)`,
  `ALTER TABLE previews ADD COLUMN reported_at TEXT`,
  `CREATE TABLE IF NOT EXISTS repo_access (
    repo TEXT PRIMARY KEY,
    access TEXT NOT NULL,
    detail TEXT,
    checked_at TEXT NOT NULL
  )`,
  // A chat that stopped being an orchestrator (taken over, or turned off) is
  // kept, so its old tasks still read as started by an orchestrator.
  `ALTER TABLE orchestrators ADD COLUMN retired_at TEXT`,
  `ALTER TABLE tasks ADD COLUMN unshipped INTEGER`,
  `ALTER TABLE tasks ADD COLUMN ship_approval TEXT`,
  `ALTER TABLE decisions ADD COLUMN context TEXT`,
  `ALTER TABLE decisions ADD COLUMN asked_by_task_id TEXT`,
  `ALTER TABLE task_events ADD COLUMN metadata TEXT`,
  `CREATE INDEX IF NOT EXISTS task_events_time ON task_events(at, seq)`,
  `ALTER TABLE decisions ADD COLUMN short_label TEXT`,
  `ALTER TABLE tasks ADD COLUMN compact_title TEXT`,
  ...START_QUEUE_MIGRATIONS,
  ...CHAT_RECOVERY_MIGRATIONS,
];

export const DECISION_STATUSES = ["open", "answered", "withdrawn"] as const;

export type Delivery = "pr" | "push";

/** What the last check of a preview link saw. */
export type PreviewHealth = "up" | "down" | "blocked" | "unknown";

export interface Preview {
  id: string;
  taskId: string;
  sandboxId: string;
  port: number;
  /** Where the page is, e.g. "/" or "/projects/demo". */
  path: string;
  /** The command that starts the server, run from the task's checkout (Wake restarts it). */
  command: string | null;
  /** boat's private link (its token is in the query); open it with the path. */
  url: string;
  title: string;
  health: PreviewHealth;
  checkedAt: string | null;
  /** The sandbox is gone (the task closed): the link can't work again. */
  expiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toPreview(row: Record<string, unknown>): Preview {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    sandboxId: String(row.sandbox_id),
    port: Number(row.port),
    path: String(row.path),
    command: typeof row.command === "string" ? row.command : null,
    url: String(row.url),
    title: String(row.title),
    health: row.health === "up" || row.health === "down" || row.health === "blocked" ? row.health : "unknown",
    checkedAt: typeof row.checked_at === "string" ? row.checked_at : null,
    expiredAt: typeof row.expired_at === "string" ? row.expired_at : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** Something only the user can decide, posted by an orchestrator with its recommendation. */
export interface Decision {
  id: string;
  orchestratorThreadId: string | null;
  question: string;
  recommendation: string;
  options: string[];
  optionDetails?: DecisionOption[];
  context?: string | null;
  askedByTaskId?: string | null;
  shortLabel?: string | null;
  taskIds: string[];
  status: DecisionStatus;
  answer: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

function stringList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function toDecision(row: Record<string, unknown>): Decision {
  return {
    id: String(row.id),
    orchestratorThreadId: typeof row.orchestrator_thread_id === "string" ? row.orchestrator_thread_id : null,
    question: String(row.question),
    recommendation: String(row.recommendation),
    options: normalizeDecisionOptions(row.options).map((option) => option.label),
    optionDetails: normalizeDecisionOptions(row.options),
    context: typeof row.context === "string" ? row.context : null,
    askedByTaskId: typeof row.asked_by_task_id === "string" ? row.asked_by_task_id : null,
    shortLabel: typeof row.short_label === "string" ? row.short_label : null,
    taskIds: stringList(row.task_ids),
    status: (DECISION_STATUSES as readonly string[]).includes(String(row.status)) ? (row.status as DecisionStatus) : "open",
    answer: typeof row.answer === "string" ? row.answer : null,
    createdAt: String(row.created_at),
    resolvedAt: typeof row.resolved_at === "string" ? row.resolved_at : null,
  };
}

type Row = Record<string, unknown>;

const COLUMN_BY_FIELD: Record<keyof Task, string> = {
  id: "id",
  title: "title",
  compactTitle: "compact_title",
  role: "role",
  status: "status",
  orchestratorThreadId: "orchestrator_thread_id",
  projectId: "project_id",
  repo: "repo",
  repoPath: "repo_path",
  branch: "branch",
  baseBranch: "base_branch",
  sandboxId: "sandbox_id",
  conversationId: "conversation_id",
  promptId: "prompt_id",
  provider: "provider",
  model: "model",
  reasoningEffort: "reasoning_effort",
  tier: "tier",
  reason: "reason",
  runner: "runner",
  threadId: "thread_id",
  hostId: "host_id",
  environmentId: "environment_id",
  readyAt: "ready_at",
  readyNote: "ready_note",
  delivery: "delivery",
  boatProject: "boat_project",
  environment: "environment",
  snapshot: "snapshot",
  extraRepos: "extra_repos",
  brief: "brief",
  parentTaskId: "parent_task_id",
  prUrl: "pr_url",
  result: "result",
  error: "error",
  turns: "turns",
  ownsSandbox: "owns_sandbox",
  createdAt: "created_at",
  updatedAt: "updated_at",
  finishedAt: "finished_at",
  notifiedAt: "notified_at",
  unshipped: "unshipped",
  shipApproval: "ship_approval",
};

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toTask(row: Row): Task {
  return {
    id: String(row.id),
    title: String(row.title),
    compactTitle: nullableString(row.compact_title)?.trim().slice(0, 120) || null,
    role: row.role as TaskRole,
    status: row.status as TaskStatus,
    orchestratorThreadId: nullableString(row.orchestrator_thread_id),
    projectId: nullableString(row.project_id),
    repo: nullableString(row.repo),
    repoPath: nullableString(row.repo_path),
    branch: nullableString(row.branch),
    baseBranch: nullableString(row.base_branch),
    sandboxId: nullableString(row.sandbox_id),
    conversationId: nullableString(row.conversation_id),
    promptId: nullableString(row.prompt_id),
    provider: row.provider as Provider,
    model: nullableString(row.model),
    reasoningEffort: nullableString(row.reasoning_effort),
    tier: nullableString(row.tier),
    reason: nullableString(row.reason),
    runner: row.runner === "chat" ? "chat" : "boat",
    threadId: nullableString(row.thread_id),
    hostId: nullableString(row.host_id),
    environmentId: nullableString(row.environment_id),
    readyAt: nullableString(row.ready_at),
    readyNote: nullableString(row.ready_note),
    delivery: row.delivery === "push" ? "push" : "pr",
    boatProject: nullableString(row.boat_project),
    environment: nullableString(row.environment),
    snapshot: nullableString(row.snapshot),
    extraRepos: parseRepos(row.extra_repos),
    brief: String(row.brief),
    parentTaskId: nullableString(row.parent_task_id),
    prUrl: nullableString(row.pr_url),
    result: nullableString(row.result),
    error: nullableString(row.error),
    turns: Number(row.turns ?? 1),
    ownsSandbox: Number(row.owns_sandbox ?? 1) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: nullableString(row.finished_at),
    notifiedAt: nullableString(row.notified_at),
    unshipped: row.unshipped === null || row.unshipped === undefined ? null : Number(row.unshipped),
    shipApproval: parseShipApproval(row.ship_approval),
  };
}

function parseShipApproval(value: unknown): ShipApproval | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const parsed = JSON.parse(value) as Partial<ShipApproval> | null;
    if (parsed === null || typeof parsed.head !== "string" || typeof parsed.base !== "string" || typeof parsed.path !== "string") return null;
    const changes = parsed.changes;
    return {
      at: String(parsed.at ?? ""),
      turns: Number(parsed.turns ?? 0),
      path: parsed.path,
      baseBranch: String(parsed.baseBranch ?? ""),
      head: parsed.head,
      base: parsed.base,
      files: Array.isArray(parsed.files) ? parsed.files.filter((file): file is string => typeof file === "string") : [],
      moreFiles: Number(parsed.moreFiles ?? 0),
      message: String(parsed.message ?? ""),
      changes:
        changes && typeof changes.text === "string"
          ? {
              turns: Number(changes.turns ?? 0),
              via: changes.via === "range-diff" || changes.via === "stat" ? changes.via : "none",
              text: changes.text,
              omitted: Number(changes.omitted ?? 0),
            }
          : null,
    };
  } catch {
    return null;
  }
}

function parseRepos(value: unknown): { repo: string; baseBranch: string; path?: string }[] {
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is { repo: string; baseBranch: string } =>
            typeof entry?.repo === "string" && typeof entry?.baseBranch === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function toColumnValue(field: keyof Task, value: unknown): unknown {
  if (field === "ownsSandbox") return value === true ? 1 : 0;
  if (field === "extraRepos") return JSON.stringify(Array.isArray(value) ? value : []);
  if (field === "shipApproval") return value === null || value === undefined ? null : JSON.stringify(value);
  return value ?? null;
}

export function newTaskId(): string {
  return `t_${randomBytes(4).toString("hex")}`;
}

export interface TaskFilter {
  orchestratorThreadId?: string;
  statuses?: readonly TaskStatus[];
  parentTaskId?: string;
  limit?: number;
}

export class TaskStore {
  private readonly db: () => Database.Database;

  constructor(db: () => Database.Database) {
    this.db = db;
  }

  static migrations(): string[] {
    return [...MIGRATIONS];
  }

  insert(task: Task): Task {
    const fields = Object.keys(COLUMN_BY_FIELD) as (keyof Task)[];
    const columns = fields.map((field) => COLUMN_BY_FIELD[field]);
    const placeholders = fields.map((field) => `@${field}`);
    const params: Record<string, unknown> = {};
    for (const field of fields) params[field] = toColumnValue(field, task[field]);
    this.db()
      .prepare(`INSERT INTO tasks (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`)
      .run(params);
    return task;
  }

  get(id: string): Task | null {
    const row = this.db().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Row | undefined;
    return row === undefined ? null : toTask(row);
  }

  /** Setup's receipt outlives the board's bounded list of recently closed work. */
  latestSetupTest(): Task | null {
    const row = this.db().prepare(`SELECT * FROM tasks WHERE role = 'custom' AND title = 'Test task' AND reason = 'Test task: checks the setup' AND repo IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as Row | undefined;
    return row === undefined ? null : toTask(row);
  }

  /** Persisted attribution for the fresh headless check behind Project → Rebuild. */
  latestProjectSnapshotCheck(projectId: string): Task | null {
    const row = this.db().prepare(`SELECT * FROM tasks WHERE role = 'custom' AND boat_project = ? AND reason = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(projectId, `Project snapshot check: ${projectId}`) as Row | undefined;
    return row === undefined ? null : toTask(row);
  }

  /** Accepts a full id or an unambiguous prefix (`t_ab` → `t_ab12cd34`). */
  resolve(idOrPrefix: string): Task | null {
    const exact = this.get(idOrPrefix);
    if (exact !== null) return exact;
    const rows = this.db()
      .prepare(`SELECT * FROM tasks WHERE id LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 2`)
      .all(`${idOrPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as Row[];
    return rows.length === 1 && rows[0] !== undefined ? toTask(rows[0]) : null;
  }

  update(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Task | null {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as [
      keyof Task,
      unknown,
    ][];
    const now = new Date().toISOString();
    const sets = entries.map(([field]) => `${COLUMN_BY_FIELD[field]} = @${field}`);
    sets.push(`updated_at = @__now`);
    const params: Record<string, unknown> = { __id: id, __now: now };
    for (const [field, value] of entries) params[field] = toColumnValue(field, value);
    this.db().prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = @__id`).run(params);
    return this.get(id);
  }

  /**
   * Update only if the task is still in one of `from` (and, when given, on
   * the same prompt). Returns null when someone else changed it first, so a
   * slow sweep never overwrites a close or a newer turn.
   */
  transition(
    id: string,
    from: readonly TaskStatus[],
    patch: Partial<Omit<Task, "id" | "createdAt">>,
    options: { promptId?: string | null } = {},
  ): Task | null {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as [keyof Task, unknown][];
    const sets = entries.map(([field]) => `${COLUMN_BY_FIELD[field]} = @${field}`);
    sets.push(`updated_at = @__now`);
    const params: Record<string, unknown> = { __id: id, __now: new Date().toISOString() };
    for (const [field, value] of entries) params[field] = toColumnValue(field, value);
    const statusParams = from.map((status, index) => {
      params[`__s${index}`] = status;
      return `@__s${index}`;
    });
    let sql = `UPDATE tasks SET ${sets.join(", ")} WHERE id = @__id AND status IN (${statusParams.join(", ")})`;
    if (options.promptId !== undefined) {
      sql += ` AND prompt_id IS @__prompt`;
      params.__prompt = options.promptId;
    }
    const result = this.db().prepare(sql).run(params) as { changes: number | bigint };
    return Number(result.changes) > 0 ? this.get(id) : null;
  }

  /** True when some task created this sandbox (so the plugin may stop or delete it). */
  pluginOwnsSandbox(sandboxId: string): boolean {
    return (
      this.db().prepare(`SELECT 1 AS one FROM tasks WHERE sandbox_id = ? AND owns_sandbox = 1 LIMIT 1`).get(sandboxId) !==
      undefined
    );
  }

  /** Finished turns whose dispatching thread has not been told yet. */
  pendingNotifications(): Task[] {
    return (
      this.db()
        .prepare(
          `SELECT * FROM tasks WHERE orchestrator_thread_id IS NOT NULL AND status IN ('idle','failed') AND finished_at IS NOT NULL AND (notified_at IS NULL OR notified_at < finished_at) ORDER BY finished_at LIMIT 200`,
        )
        .all() as Row[]
    ).map(toTask);
  }

  list(filter: TaskFilter = {}): Task[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.orchestratorThreadId !== undefined) {
      where.push(`orchestrator_thread_id = ?`);
      params.push(filter.orchestratorThreadId);
    }
    if (filter.parentTaskId !== undefined) {
      where.push(`parent_task_id = ?`);
      params.push(filter.parentTaskId);
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      where.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      params.push(...filter.statuses);
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
    const sql = `SELECT * FROM tasks ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ${limit}`;
    return (this.db().prepare(sql).all(...params) as Row[]).map(toTask);
  }

  /** Every task that ever ran in a sandbox, whatever its state now. */
  sandboxTasks(sandboxId: string): Task[] {
    return (this.db().prepare(`SELECT * FROM tasks WHERE sandbox_id = ? ORDER BY created_at`).all(sandboxId) as Row[]).map(toTask);
  }

  /** Tasks still occupying (or possibly occupying) a sandbox. */
  /**
   * Guard a queued message the plugin is withdrawing (a steer retry or chat
   * recovery bb queued instead of starting): bb's dispatch hook refuses that
   * exact row until the delete is confirmed.
   */
  guardQueuedMessage(threadId: string, queuedMessageId: string): void {
    this.db()
      .prepare(`INSERT OR REPLACE INTO queue_guards (queued_message_id, thread_id, state, at) VALUES (?, ?, 'pending', ?)`)
      .run(queuedMessageId, threadId, new Date().toISOString());
  }

  /**
   * removed: bb's queue no longer lists it, so the guard goes. stuck: it
   * couldn't be removed, and the guard stays. The guard's `at` stays its
   * creation time either way.
   */
  settleQueuedGuard(queuedMessageId: string, state: "removed" | "stuck"): void {
    if (state === "removed") this.dropQueuedGuard(queuedMessageId);
    else this.db().prepare(`UPDATE queue_guards SET state = ? WHERE queued_message_id = ?`).run(state, queuedMessageId);
  }

  dropQueuedGuard(queuedMessageId: string): void {
    this.db().prepare(`DELETE FROM queue_guards WHERE queued_message_id = ?`).run(queuedMessageId);
  }

  /** The first of these queued messages the plugin still guards, with when the guard was made (epoch ms). */
  queuedGuard(queuedMessageIds: readonly string[]): { queuedMessageId: string; threadId: string; createdAt: number } | null {
    for (const id of queuedMessageIds) {
      const row = this.db().prepare(`SELECT thread_id, state, at FROM queue_guards WHERE queued_message_id = ?`).get(id) as { thread_id?: string; state?: string; at?: string } | undefined;
      if (row !== undefined && row.state !== "removed") return { queuedMessageId: id, threadId: String(row.thread_id), createdAt: Date.parse(String(row.at)) || 0 };
    }
    return null;
  }

  /** The first of these queued messages the plugin still guards (not confirmed gone), or null. */
  guardedQueuedMessage(queuedMessageIds: readonly string[]): string | null {
    return this.queuedGuard(queuedMessageIds)?.queuedMessageId ?? null;
  }

  /** Every guard still held, for the cleanup on plugin start. */
  queuedGuards(): { queuedMessageId: string; threadId: string; createdAt: number }[] {
    const rows = this.db().prepare(`SELECT queued_message_id, thread_id, at FROM queue_guards WHERE state != 'removed'`).all() as { queued_message_id: string; thread_id: string; at: string }[];
    return rows.map((row) => ({ queuedMessageId: row.queued_message_id, threadId: row.thread_id, createdAt: Date.parse(row.at) || 0 }));
  }

  liveSandboxTasks(sandboxId: string): Task[] {
    return (
      this.db()
        .prepare(
          `SELECT * FROM tasks WHERE sandbox_id = ? AND status IN ('starting','running','idle','failed')`,
        )
        .all(sandboxId) as Row[]
    ).map(toTask);
  }

  addOrchestrator(threadId: string, project: { id: string; name: string } | null = null): void {
    const existing = this.db().prepare(`SELECT retired_at FROM orchestrators WHERE thread_id = ?`).get(threadId) as Row | undefined;
    this.db()
      .prepare(
        `INSERT INTO orchestrators (thread_id, created_at, project_id, project_name) VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET project_id = COALESCE(excluded.project_id, orchestrators.project_id),
           project_name = COALESCE(excluded.project_name, orchestrators.project_name), retired_at = NULL`,
      )
      .run(threadId, new Date().toISOString(), project?.id ?? null, project?.name ?? null);
    if (!existing || existing.retired_at !== null) this.addEvent("", "orchestrator-started", `${project?.name ?? "Orchestrator"} started`, { source: "user", orchestratorThreadId: threadId, to: "working" });
  }

  /** The chat stops being an orchestrator (it stays known as a former one). */
  removeOrchestrator(threadId: string): void {
    this.db().prepare(`UPDATE orchestrators SET retired_at = ? WHERE thread_id = ? AND retired_at IS NULL`).run(new Date().toISOString(), threadId);
  }

  /** Current orchestrators (real ones: started or turned on as orchestrators), newest first. */
  orchestrators(): { threadId: string; createdAt: string; projectId: string | null; projectName: string | null }[] {
    return (
      this.db()
        .prepare(`SELECT thread_id, created_at, project_id, project_name FROM orchestrators WHERE retired_at IS NULL ORDER BY created_at DESC`)
        .all() as Row[]
    ).map((row) => ({
      threadId: String(row.thread_id),
      createdAt: String(row.created_at),
      projectId: nullableString(row.project_id),
      projectName: nullableString(row.project_name),
    }));
  }

  /** Every chat that is or was an orchestrator (a task it started reads as an orchestrator's). */
  orchestratorThreadIds(): { current: Set<string>; former: Set<string> } {
    const rows = this.db().prepare(`SELECT thread_id, retired_at FROM orchestrators`).all() as Row[];
    const current = new Set<string>();
    const former = new Set<string>();
    for (const row of rows) (row.retired_at === null || row.retired_at === undefined ? current : former).add(String(row.thread_id));
    return { current, former };
  }

  /** Move a previous orchestrator's open tasks to its successor, so reports reach the new chat. */
  reassignOpenTasks(fromThreadId: string, toThreadId: string): string[] {
    const ids = (
      this.db()
        .prepare(
          `SELECT id FROM tasks WHERE orchestrator_thread_id = ? AND status IN ('starting','running','idle','failed')`,
        )
        .all(fromThreadId) as Row[]
    ).map((row) => String(row.id));
    if (ids.length > 0) {
      this.db()
        .prepare(
          `UPDATE tasks SET orchestrator_thread_id = ?, updated_at = ? WHERE orchestrator_thread_id = ? AND status IN ('starting','running','idle','failed')`,
        )
        .run(toThreadId, new Date().toISOString(), fromThreadId);
    }
    return ids;
  }

  /** Threads that dispatched tasks (orchestrators or not), newest activity first. */
  dispatchingThreads(limit = 50): string[] {
    return (
      this.db()
        .prepare(
          `SELECT orchestrator_thread_id AS id, MAX(updated_at) AS last FROM tasks WHERE orchestrator_thread_id IS NOT NULL GROUP BY orchestrator_thread_id ORDER BY last DESC LIMIT ?`,
        )
        .all(limit) as Row[]
    ).map((row) => String(row.id));
  }

  addEvent(taskId: string, kind: string, text: string, metadata: EventMetadata = {}): void {
    const clean = eventMetadata(metadata);
    const reviewId = kind === "review" ? text.match(/^Review (t_[\w]+)(?: started\b|:)/)?.[1] : null;
    if (reviewId) {
      const review = this.get(reviewId);
      if (review) clean.review = {
        reviewTaskId: review.id, round: Math.max(1, this.list({ parentTaskId: taskId, limit: 1000 }).filter((entry) => entry.role === "review" && entry.createdAt <= review.createdAt).length),
        provider: review.provider, model: review.model, freshContext: review.turns <= 1,
        verdict: text.match(/: ([a-z-]+)$/)?.[1] ?? null, findings: reviewFindings(review.result),
      };
    }
    this.db().prepare(`INSERT INTO task_events (task_id, at, kind, text, metadata) VALUES (?, ?, ?, ?, ?)`)
      .run(taskId, new Date().toISOString(), kind, text.slice(0, 4000), JSON.stringify(clean));
  }

  /** Distinct tasks with a recorded ship/merge, including chats that are not orchestrators. */
  shippedCount(orchestratorThreadId: string, since: string, until: string): number {
    const row = this.db().prepare(`SELECT COUNT(DISTINCT e.task_id) AS count FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE t.orchestrator_thread_id = ? AND e.kind IN ('shipped', 'merged') AND julianday(e.at) >= julianday(?) AND julianday(e.at) < julianday(?)`).get(orchestratorThreadId, since, until) as Row;
    return Number(row.count);
  }

  /** Newest first, stable seq cursor; scan bounds apply before presentation filtering. */
  history(input: { taskId?: string; orchestratorThreadId?: string; beforeSeq?: number; since?: string; until?: string; limit?: number } = {}): { events: HistoryEventDto[]; nextBeforeSeq: number | null } {
    const filter = historyInputSchema.parse(input);
    const clauses: string[] = []; const params: (string | number)[] = [];
    if (filter.taskId) { clauses.push("e.task_id = ?"); params.push(filter.taskId); }
    if (filter.orchestratorThreadId) {
      clauses.push("(t.orchestrator_thread_id = ? OR json_extract(CASE WHEN json_valid(e.metadata) THEN e.metadata ELSE '{}' END, '$.orchestratorThreadId') = ?)");
      params.push(filter.orchestratorThreadId, filter.orchestratorThreadId);
    }
    if (filter.beforeSeq) { clauses.push("e.seq < ?"); params.push(filter.beforeSeq); }
    if (filter.since) { clauses.push("julianday(e.at) >= julianday(?)"); params.push(filter.since); }
    if (filter.until) { clauses.push("julianday(e.at) < julianday(?)"); params.push(filter.until); }
    // Scan at most 2000 rows per page, even when raw logs vastly outnumber visible events.
    const rows = this.db().prepare(`SELECT e.* FROM task_events e LEFT JOIN tasks t ON t.id = e.task_id ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY e.seq DESC LIMIT 2001`).all(...params) as Row[];
    const events: HistoryEventDto[] = [];
    let scanned = 0;
    for (const row of rows.slice(0, 2000)) {
      scanned++;
      const projected = projectHistoryEvent(row, this.get(String(row.task_id)));
      if (projected) events.push(projected);
      if (events.length === filter.limit) break;
    }
    return { events, nextBeforeSeq: scanned < rows.length ? Number(rows[scanned - 1]!.seq) : null };
  }

  // ------------------------------------------------------------ previews

  /** Record (or refresh) a task's preview on a port. */
  upsertPreview(input: { taskId: string; sandboxId: string; port: number; path: string; command: string | null; url: string; title: string; health: PreviewHealth }): Preview {
    const now = new Date().toISOString();
    const existing = this.db().prepare(`SELECT id FROM previews WHERE task_id = ? AND port = ?`).get(input.taskId, input.port) as Row | undefined;
    const id = existing ? String(existing.id) : `p_${randomBytes(4).toString("hex")}`;
    this.db()
      .prepare(
        `INSERT INTO previews (id, task_id, sandbox_id, port, path, command, url, title, health, checked_at, expired_at, created_at, updated_at, reported_at)
         VALUES (@id, @taskId, @sandboxId, @port, @path, @command, @url, @title, @health, @now, NULL, @now, @now, @now)
         ON CONFLICT(task_id, port) DO UPDATE SET sandbox_id = @sandboxId, path = @path, command = COALESCE(@command, command), url = @url,
           title = @title, health = @health, checked_at = @now, expired_at = NULL, updated_at = @now, reported_at = @now`,
      )
      .run({ ...input, id, now });
    return this.preview(id)!;
  }

  preview(id: string): Preview | null {
    const row = this.db().prepare(`SELECT * FROM previews WHERE id = ?`).get(id) as Row | undefined;
    return row === undefined ? null : toPreview(row);
  }

  /** Previews, newest first: a task's, the tasks of an orchestrator, or all. */
  previews(filter: { taskId?: string; orchestratorThreadId?: string | null; includeExpired?: boolean } = {}): Preview[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.taskId) {
      where.push("p.task_id = ?");
      params.push(filter.taskId);
    }
    if (filter.orchestratorThreadId) {
      where.push("t.orchestrator_thread_id = ?");
      params.push(filter.orchestratorThreadId);
    }
    if (!filter.includeExpired) where.push("p.expired_at IS NULL");
    const rows = this.db()
      .prepare(
        `SELECT p.* FROM previews p JOIN tasks t ON t.id = p.task_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(p.reported_at, p.created_at) DESC LIMIT 200`,
      )
      .all(...params) as Row[];
    return rows.map(toPreview);
  }

  setPreviewHealth(id: string, health: PreviewHealth, url?: string): void {
    const now = new Date().toISOString();
    this.db()
      .prepare(`UPDATE previews SET health = ?, checked_at = ?, updated_at = ?${url ? ", url = ?" : ""} WHERE id = ?`)
      .run(...(url ? [health, now, now, url, id] : [health, now, now, id]));
  }

  /** After a resume nothing runs yet: a preview counts as live only after a fresh check. */
  resetPreviewHealthForSandbox(sandboxId: string): void {
    this.db().prepare(`UPDATE previews SET health = 'unknown' WHERE sandbox_id = ? AND expired_at IS NULL`).run(sandboxId);
  }

  /** A sandbox was deleted: every preview on it (any task's) is gone. */
  expirePreviewsForSandbox(sandboxId: string): void {
    const now = new Date().toISOString();
    this.db().prepare(`UPDATE previews SET expired_at = ?, updated_at = ? WHERE sandbox_id = ? AND expired_at IS NULL`).run(now, now, sandboxId);
  }

  /** The task's sandbox is gone: its previews can't come back. */
  expirePreviews(taskId: string): void {
    const now = new Date().toISOString();
    this.db().prepare(`UPDATE previews SET expired_at = ?, updated_at = ? WHERE task_id = ? AND expired_at IS NULL`).run(now, now, taskId);
  }

  /** Expired previews are listed for a week, then forgotten. */
  prunePreviews(olderThanIso: string): void {
    this.db().prepare(`DELETE FROM previews WHERE expired_at IS NOT NULL AND expired_at < ?`).run(olderThanIso);
  }

  // --------------------------------------------------------- repo access

  /** What the last check inside a sandbox found for a repo: write, read, none or expired. */
  setRepoAccess(repo: string, access: "write" | "read" | "none" | "expired", detail: string | null): void {
    this.db()
      .prepare(
        `INSERT INTO repo_access (repo, access, detail, checked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(repo) DO UPDATE SET access = excluded.access, detail = excluded.detail, checked_at = excluded.checked_at`,
      )
      .run(repo.toLowerCase(), access, detail, new Date().toISOString());
  }

  /** The newest repo check (any repo), for the setup checks. */
  latestRepoAccess(): { repo: string; access: string; detail: string | null; checkedAt: string } | null {
    const row = this.db().prepare(`SELECT * FROM repo_access ORDER BY checked_at DESC LIMIT 1`).get() as Row | undefined;
    return row === undefined ? null : { repo: String(row.repo), access: String(row.access), detail: nullableString(row.detail), checkedAt: String(row.checked_at) };
  }

  repoAccess(repo: string): { access: string; detail: string | null; checkedAt: string } | null {
    const row = this.db().prepare(`SELECT * FROM repo_access WHERE repo = ?`).get(repo.toLowerCase()) as Row | undefined;
    return row === undefined ? null : { access: String(row.access), detail: nullableString(row.detail), checkedAt: String(row.checked_at) };
  }

  // ----------------------------------------------------------- decisions

  addDecision(input: { orchestratorThreadId: string | null; question: string; recommendation: string; options: DecisionOptionInput[]; taskIds: string[]; context?: string | null; askedByTaskId?: string | null; shortLabel?: string | null }): Decision {
    const id = `d_${randomBytes(4).toString("hex")}`;
    const taskIds = [...new Set([...input.taskIds, ...(input.askedByTaskId ? [input.askedByTaskId] : [])])];
    this.db()
      .prepare(
        `INSERT INTO decisions (id, orchestrator_thread_id, question, recommendation, options, task_ids, status, created_at, context, asked_by_task_id, short_label)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      )
      .run(id, input.orchestratorThreadId, input.question, input.recommendation, JSON.stringify(normalizeDecisionOptions(input.options)), JSON.stringify(taskIds), new Date().toISOString(), input.context?.slice(0, 1000) ?? null, input.askedByTaskId ?? taskIds[0] ?? null, input.shortLabel?.slice(0, 120) ?? null);
    const decision = this.decision(id)!;
    this.addEvent(input.askedByTaskId ?? input.taskIds[0] ?? "", "needs-you", input.question, { source: "agent", decisionId: id, orchestratorThreadId: input.orchestratorThreadId ?? undefined });
    return decision;
  }

  decision(id: string): Decision | null {
    const row = this.db().prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as Row | undefined;
    return row === undefined ? null : toDecision(row);
  }

  decisions(filter: { orchestratorThreadId?: string | null; statuses?: readonly DecisionStatus[]; limit?: number } = {}): Decision[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.orchestratorThreadId) {
      where.push(`orchestrator_thread_id = ?`);
      params.push(filter.orchestratorThreadId);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      where.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      params.push(...filter.statuses);
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
    const sql = `SELECT * FROM decisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ${limit}`;
    return (this.db().prepare(sql).all(...params) as Row[]).map(toDecision);
  }

  /** Close an open decision; null when it was already closed. */
  resolveDecision(id: string, status: "answered" | "withdrawn", answer: string | null): Decision | null {
    const result = this.db()
      .prepare(`UPDATE decisions SET status = ?, answer = ?, resolved_at = ? WHERE id = ? AND status = 'open'`)
      .run(status, answer, new Date().toISOString(), id) as { changes: number | bigint };
    if (Number(result.changes) === 0) return null;
    const decision = this.decision(id)!;
    this.addEvent(decision.askedByTaskId ?? decision.taskIds[0] ?? "", status === "answered" ? "decision-answered" : "decision-withdrawn", decision.question, { source: "user", decisionId: id, orchestratorThreadId: decision.orchestratorThreadId ?? undefined });
    return decision;
  }

  /** Decisions move with their orchestrator's tasks on a take-over. */
  reassignOpenDecisions(fromThreadId: string, toThreadId: string): void {
    this.db().prepare(`UPDATE decisions SET orchestrator_thread_id = ? WHERE orchestrator_thread_id = ? AND status = 'open'`).run(toThreadId, fromThreadId);
  }

  /** True when any task (open or not) ran a worker chat on this sandbox: bb owns its lifecycle. */
  isChatMachineSandbox(sandboxId: string): boolean {
    return this.db().prepare(`SELECT 1 AS one FROM tasks WHERE sandbox_id = ? AND host_id IS NOT NULL LIMIT 1`).get(sandboxId) !== undefined;
  }

  /** bb was ever installed on this sandbox for a move to a chat (bb-installed events), even if that move failed. */
  sandboxHadBb(sandboxId: string): boolean {
    return this.db().prepare(`SELECT 1 AS one FROM task_events WHERE kind = 'bb-installed' AND text = ? LIMIT 1`).get(sandboxId) !== undefined;
  }

  /** The bb machine that wraps a sandbox, whatever its tasks' state (a kept machine of closed tasks too). */
  machineForSandbox(sandboxId: string): string | null {
    const row = this.db()
      .prepare(`SELECT host_id FROM tasks WHERE sandbox_id = ? AND host_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1`)
      .get(sandboxId) as Row | undefined;
    return row === undefined ? null : nullableString(row.host_id);
  }

  hostForSandbox(sandboxId: string): string | null {
    const row = this.db()
      .prepare(
        `SELECT host_id FROM tasks WHERE sandbox_id = ? AND host_id IS NOT NULL AND status IN ('starting','running','idle','failed') ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(sandboxId) as Row | undefined;
    return row === undefined ? null : nullableString(row.host_id);
  }

  /** The open chat task whose workspace this is (the implementer when several share it). */
  taskByEnvironment(environmentId: string): Task | null {
    const rows = this.db()
      .prepare(
        `SELECT * FROM tasks WHERE environment_id = ? AND runner = 'chat' AND status IN ('starting','running','idle','failed') ORDER BY created_at`,
      )
      .all(environmentId) as Row[];
    const tasks = rows.map(toTask);
    return tasks.find((task) => task.role !== "review") ?? tasks[0] ?? null;
  }

  /** The open task whose worker chat this is (any chat the task ever used). */
  byThread(threadId: string): Task | null {
    const direct = this.db().prepare(`SELECT * FROM tasks WHERE thread_id = ? LIMIT 1`).get(threadId) as Row | undefined;
    if (direct !== undefined) return toTask(direct);
    const viaEvent = this.db()
      .prepare(`SELECT task_id FROM task_events WHERE kind IN ('chat', 'chat-extra') AND text = ? ORDER BY seq DESC LIMIT 1`)
      .get(threadId) as Row | undefined;
    return viaEvent === undefined ? null : this.get(String(viaEvent.task_id));
  }

  /** Every chat a task has used (current one last). */
  chatThreads(taskId: string): string[] {
    const rows = this.db()
      .prepare(`SELECT text FROM task_events WHERE task_id = ? AND kind IN ('chat', 'chat-extra') ORDER BY seq`)
      .all(taskId) as Row[];
    return [...new Set(rows.map((row) => String(row.text)))];
  }

  /** The newest event of one kind (e.g. "review", "approval"), or null. */
  latestEvent(taskId: string, kind: string): TaskEvent | null {
    const row = this.db()
      .prepare(`SELECT task_id, at, kind, text FROM task_events WHERE task_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1`)
      .get(taskId, kind) as Row | undefined;
    return row === undefined ? null : { taskId: String(row.task_id), at: String(row.at), kind: String(row.kind), text: String(row.text) };
  }

  /**
   * The task (other than `except`) whose ship landed this commit as its new
   * head: shipped events name it by its first 7 characters.
   */
  shippedBy(sha: string, except: string | null = null): string | null {
    const short = sha.slice(0, 7);
    if (!/^[0-9a-f]{7}$/.test(short)) return null;
    const row = this.db()
      .prepare(`SELECT task_id FROM task_events WHERE kind IN ('shipped', 'shipped-partly') AND text LIKE ? AND task_id IS NOT ? ORDER BY seq DESC LIMIT 1`)
      .get(`%(${short})%`, except) as Row | undefined;
    return row === undefined ? null : String(row.task_id);
  }

  events(taskId: string, limit = 50): TaskEvent[] {
    const rows = this.db()
      .prepare(
        `SELECT task_id, at, kind, text FROM task_events WHERE task_id = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(taskId, limit) as Row[];
    return rows
      .map((row) => ({
        taskId: String(row.task_id),
        at: String(row.at),
        kind: String(row.kind),
        text: String(row.text),
      }))
      .reverse();
  }
}
