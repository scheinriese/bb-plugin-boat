// Pure formatting helpers and label tables for the Cloud agents UI.
import type { MACHINE_TYPE_VALUES, ROLE_VALUES, STATUS_VALUES, TaskDto } from "../contract";

export type Provider = TaskDto["provider"];
export type Phase = TaskDto["phase"];
export type Role = (typeof ROLE_VALUES)[number];
export type Status = (typeof STATUS_VALUES)[number];
export type MachineType = (typeof MACHINE_TYPE_VALUES)[number];

/** The nav panel's `path`; `toPluginPanel` takes it. */
export const PANEL_PATH = "cloud-agents";

/** Task ids the server mints (`t_` + hex). Used to validate untrusted input. */
export const TASK_ID_PATTERN = /^t_[0-9a-f]{4,16}$/;

export const PROVIDER_LABEL: Record<Provider, string> = { claude: "Claude Code", codex: "Codex" };
export const PROVIDER_SHORT: Record<Provider, string> = { claude: "Claude", codex: "Codex" };
/** bb's own agent provider ids, used to borrow their logos. */
export const BB_PROVIDER_ID: Record<Provider, string> = { claude: "claude-code", codex: "codex" };

export const ROLE_LABEL: Record<Role, string> = { implement: "Implement", review: "Review", custom: "Custom" };
export const ROLE_ICON: Record<Role, string> = { implement: "Code", review: "Eye", custom: "Bot" };

export const STATUS_LABEL: Record<Status, string> = {
  starting: "Starting",
  running: "Running",
  idle: "Waiting",
  failed: "Failed",
  done: "Done",
  cancelled: "Cancelled",
};

export const STATUS_DOT: Record<Status, string> = {
  starting: "bg-muted-foreground motion-safe:animate-pulse",
  running: "bg-muted-foreground motion-safe:animate-pulse",
  idle: "bg-muted-foreground",
  failed: "bg-[#E06C6C]",
  done: "bg-[#5BD08A]",
  cancelled: "bg-muted-foreground/50",
};

/** Where a task stands for the user: the board's status pill. */
export const PHASE_LABEL: Record<Phase, string> = {
  starting: "Starting",
  working: "Working",
  waiting: "Waiting on orchestrator",
  failed: "Failed",
  ready: "Ready",
  done: "Done",
  cancelled: "Cancelled",
};

export const PHASE_DOT: Record<Phase, string> = {
  starting: "bg-muted-foreground motion-safe:animate-pulse",
  working: "bg-muted-foreground motion-safe:animate-pulse",
  waiting: "bg-muted-foreground",
  failed: "bg-[#E06C6C]",
  ready: "bg-[#5BD08A]",
  done: "bg-[#5BD08A]",
  cancelled: "bg-muted-foreground/50",
};

export const PHASE_TEXT: Record<Phase, string> = {
  starting: "text-foreground",
  working: "text-foreground",
  waiting: "text-muted-foreground",
  failed: "text-destructive-text",
  ready: "text-foreground",
  done: "text-muted-foreground",
  cancelled: "text-muted-foreground",
};

/** Only an orchestrator reviews a finished turn; any other task waits on the user. */
const waitsOnUser = (task: Pick<TaskDto, "phase" | "source">) => task.phase === "waiting" && task.source.kind !== "orchestrator";

export const phaseDot = (task: Pick<TaskDto, "phase" | "source">): string =>
  waitsOnUser(task) ? "bg-warning" : PHASE_DOT[task.phase];

export const phaseText = (task: Pick<TaskDto, "phase" | "source">): string =>
  waitsOnUser(task) ? "text-foreground" : PHASE_TEXT[task.phase];

export const EFFORT_LABEL: Record<string, string> = {
  ultracode: "Ultracode",
  ultra: "Ultra",
  max: "Max",
  xhigh: "Extra high",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const effortLabel = (effort: string): string => EFFORT_LABEL[effort] ?? effort;

/** "Claude Code or Codex", or just the one agent the plugin uses. */
export function agentWords(only: Provider | null): string {
  return only === "claude" ? "Claude Code" : only === "codex" ? "Codex" : "Claude Code or Codex";
}

/** claude-opus-5-5 and boat's opus-5-5 → "Opus 5.5", gpt-6.1-sol → "GPT-6.1 Sol"; other ids as they are. */
export function modelName(model: string): string {
  const claude = /^(?:claude-([a-z]+)|(opus|sonnet|haiku|fable))-(\d+)(?:-(\d))?(?:-\d{8})?(?:\[1m\])?$/.exec(model);
  if (claude) {
    const [, named, bare, major, minor] = claude;
    return `${capitalize((named ?? bare)!)} ${minor === undefined ? major : `${major}.${minor}`}`;
  }
  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?$/.exec(model);
  if (gpt) {
    const [, version, variant] = gpt;
    return variant ? `GPT-${version} ${capitalize(variant)}` : `GPT-${version}`;
  }
  return model;
}

/** "Build · Opus 5.5 · Extra high": tier, model (else the agent), effort. */
export function modelChipLabel(task: Pick<TaskDto, "tier" | "model" | "provider" | "reasoningEffort">): string {
  return [
    task.tier ? capitalize(task.tier) : null,
    task.model ? modelName(task.model) : PROVIDER_SHORT[task.provider],
    task.reasoningEffort ? effortLabel(task.reasoningEffort) : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** A review in progress, asking for changes, or outdated, in plain words; null otherwise. */
export function reviewLabel(review: string | null): { text: string; tone: Tone } | null {
  if (review === "reviewing") return { text: "Reviewing", tone: "muted" };
  if (review === "changes-requested") return { text: "Changes requested", tone: "warning" };
  // "outdated": the work changed since its last review.
  if (review === "outdated") return { text: "Changed since review", tone: "muted" };
  return null;
}

/** Sizes as boat describes them; pickers prefer the sandboxSizes RPC (it knows the plan). */
export const MACHINE_LABEL: Record<MachineType, string> = {
  small: "Small · 2 vCPU, 4 GB",
  default: "Default · 4 vCPU, 8 GB",
  large: "Large · 8 vCPU, 16 GB",
  xlarge: "XLarge · 16 vCPU, 32 GB",
};

export const isRunning = (status: Status) => status === "running" || status === "starting";
export const isClosed = (status: Status) => status === "done" || status === "cancelled";

/** The bb chat a task runs in; null for tasks headless in boat and before it starts. */
export const workerChatId = (task: Pick<TaskDto, "runner" | "threadId">): string | null =>
  task.runner === "chat" ? task.threadId : null;

export type Tone = "success" | "warning" | "destructive" | "muted";

export const TONE_DOT: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

export const TONE_CHIP: Record<Tone, string> = {
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning-text",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive-text",
  muted: "border-border bg-secondary text-muted-foreground",
};

/** Tone for a report's STATUS or a review's VERDICT. */
export function reportTone(value: string): Tone {
  if (value === "approve" || value === "approved" || value === "done") return "success";
  if (value === "changes-requested" || value === "partial") return "warning";
  if (value === "blocked" || value === "reject" || value === "rejected") return "destructive";
  return "muted";
}

export function sandboxTone(state: string): Tone {
  if (state === "running" || state === "idle" || state === "ready") return "success";
  if (state === "stopped" || state === "archived") return "muted";
  if (state === "error" || state === "cancelled") return "destructive";
  return "warning";
}

const ACTIVE_SANDBOX_STATES = new Set(["provisioned", "cloning", "ready", "idle", "running", "starting"]);
export const isSandboxActive = (state: string) => ACTIVE_SANDBOX_STATES.has(state);
export const canStopSandbox = (state: string) => ACTIVE_SANDBOX_STATES.has(state);
export const canResumeSandbox = (state: string) => state === "stopped" || state === "archived";

export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** "stops in 1h 12m" from a sandbox's auto-stop deadline. */
export function stopsIn(archiveAfter: string | null, now: number): string | null {
  if (!archiveAfter) return null;
  const deadline = Date.parse(archiveAfter);
  if (Number.isNaN(deadline)) return null;
  const left = deadline - now;
  return left <= 0 ? "stopping soon" : `stops in ${formatDuration(left)}`;
}

export function clockTime(value: string | number | null): string {
  if (value === null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function dateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function prLabel(url: string): string {
  const number = url.match(/\/pull\/(\d+)/)?.[1];
  return number ? `#${number}` : "PR";
}

export function shortRepo(repo: string): string {
  return repo
    .replace(/^https?:\/\/(www\.)?github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Text a user can paste into any chat to point at a task. */
export function taskReference(task: Pick<TaskDto, "id" | "title" | "prUrl">): string {
  const line = `boat task ${task.id} — ${task.title}`;
  return task.prUrl ? `${line}\n${task.prUrl}` : line;
}

export interface BoardCounts {
  needsYou: number;
  ready: number;
  running: number;
  done: number;
}

/** Counts in the board's words: "1 needs you · 2 ready · 3 running". */
export function summarizeBoardCounts({ needsYou, ready, running, done }: BoardCounts): string {
  const parts: string[] = [];
  if (needsYou > 0) parts.push(`${needsYou} ${needsYou === 1 ? "needs" : "need"} you`);
  if (ready > 0) parts.push(`${ready} ready`);
  if (running > 0) parts.push(`${running} running`);
  if (parts.length > 0) return parts.join(" · ");
  return done > 0 ? `${plural(done, "task")} done` : "No tasks";
}

export function summarizeBoard(board: Record<keyof BoardCounts, readonly unknown[]>): string {
  return summarizeBoardCounts({
    needsYou: board.needsYou.length,
    ready: board.ready.length,
    running: board.running.length,
    done: board.done.length,
  });
}

/**
 * Routes under PANEL_PATH: "" (overview), "task/<id>" and
 * "orchestrator/<threadId>". The server links an orchestrator's board in chat
 * as `/plugins/boat/cloud-agents/orchestrator/<threadId>`.
 */
export type PanelRoute =
  | { kind: "overview"; signIn?: boolean }
  | { kind: "task"; id: string }
  | { kind: "orchestrator"; threadId: string }
  | { kind: "unknown" };

/** Sub-paths for `toPluginPanel(PANEL_PATH, { subPath })`, which encodes the segments. */
export const SIGN_IN_SUBPATH = "sign-in";
export const taskSubPath = (id: string) => `task/${id}`;
export const orchestratorSubPath = (threadId: string) => `orchestrator/${threadId}`;

export function parseSubPath(subPath: string): PanelRoute {
  const segments = subPath
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  if (segments.length === 0) return { kind: "overview" };
  // From Settings → Setup: the page opens a terminal for `boat onboard` (Settings has none).
  if (segments.length === 1 && segments[0] === SIGN_IN_SUBPATH) return { kind: "overview", signIn: true };
  if (segments[0] === "task" && segments.length === 2 && segments[1]) return { kind: "task", id: segments[1] };
  if (segments[0] === "orchestrator" && segments.length === 2 && segments[1]) {
    return { kind: "orchestrator", threadId: segments[1] };
  }
  return { kind: "unknown" };
}

/** "owner/name@base" for one project repo. */
export function repoAtBase(entry: { repo: string; baseBranch: string }): string {
  return `${shortRepo(entry.repo)}@${entry.baseBranch}`;
}

/** "owner/a@main, owner/b@dev" for a project's repos. */
export function reposLabel(repos: readonly { repo: string; baseBranch: string }[]): string {
  return repos.map(repoAtBase).join(", ");
}

export function environmentLabel(environment: string | null): string {
  return environment ? `${environment} environment` : "default environment";
}

export function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}
