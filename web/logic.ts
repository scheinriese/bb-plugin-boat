// Pure UI logic for the Cloud agents page, its dialogs and the settings
// sections: which state the page is in, the status line, starter templates,
// protocol placeholders and other wording. No React and no SDK here, so the
// tests can import it directly (test/web-logic.test.ts).
import type { PlanDto, SandboxUseDto, TaskDto } from "../contract";

// ------------------------------------------------------------------ page state

/**
 * A: setup needed (and nothing to show yet), B: ready but never used,
 * C: tasks but no orchestrator, D: at least one orchestrator.
 */
export type PageState = "setup" | "first" | "regular" | "orchestrators";

export function pageState(input: {
  /** null while the checks load or when they can't run: never blocks the page. */
  setupOk: boolean | null;
  hasTasks: boolean;
  orchestrators: number;
}): PageState {
  const used = input.hasTasks || input.orchestrators > 0;
  // Someone with work on the page keeps seeing it; the checklist then sits on top.
  if (input.setupOk === false && !used) return "setup";
  if (input.orchestrators > 0) return "orchestrators";
  return input.hasTasks ? "regular" : "first";
}

/**
 * The setup summary for the UI: the checklist is on screen, so no pointer to
 * `bb boat doctor`. "Setup: 1 thing to fix (Coding agents). Run …" →
 * "1 thing to fix: Coding agents."
 */
export function setupSummaryText(summary: string): string {
  const text = summary
    .replace(/^Setup:\s*/, "")
    .replace(/\s*Run `bb boat doctor`\.?$/, "")
    .replace(/ \(([^)]*)\)\.$/, ": $1.");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ------------------------------------------------------------------ status line

export interface StatusLine {
  /** "Standard plan", "3 of 3 sandboxes", "550 sandbox hours left", … */
  parts: string[];
  /** The sandboxes part is at the cap (shown in the warning color). */
  full: boolean;
  /** 0–100; null: no bar (under 70 % of the cap, or no cap). */
  barPercent: number | null;
}

export function statusLine(input: { plan: PlanDto | null; cap: number | null; active: number }): StatusLine {
  const { plan, cap, active } = input;
  const parts: string[] = [];
  if (plan?.name) parts.push(`${plan.name} plan`);
  // No verb: idle sandboxes count too, while "Running" below means working tasks.
  parts.push(cap !== null ? `${active} of ${cap} ${cap === 1 ? "sandbox" : "sandboxes"}` : `${active} ${active === 1 ? "sandbox" : "sandboxes"}`);
  if (plan?.vmHoursRemaining != null) parts.push(`${formatHours(plan.vmHoursRemaining)} sandbox hours left`);
  const left = plan?.startsLeftToday ?? null;
  const perDay = plan?.startsPerDay ?? null;
  // Starts only matter on the trial or when they run low.
  if (left !== null && (plan?.trial || (perDay !== null && perDay > 0 && left / perDay <= 0.25))) {
    parts.push(`${left} ${left === 1 ? "start" : "starts"} left today`);
  }
  const ratio = cap !== null && cap > 0 ? active / cap : 0;
  return {
    parts,
    full: cap !== null && active >= cap,
    barPercent: cap !== null && cap > 0 && ratio >= 0.7 ? Math.min(100, Math.round(ratio * 100)) : null,
  };
}

function formatHours(hours: number): string {
  return hours >= 10 ? String(Math.round(hours)) : String(Math.round(hours * 10) / 10);
}

export interface AgentUsage {
  provider: "claude" | "codex";
  usedPercent: number | null;
  window: string | null;
}

const AGENT_NAME = { claude: "Claude", codex: "Codex" } as const;

/** "weekly" from "Weekly limit". */
function windowName(window: string | null): string | null {
  if (!window) return null;
  return window.toLowerCase().replace(/ limits?$/, "").trim() || null;
}

/**
 * "Claude 29% · Codex 0% of weekly limits"; with different windows each
 * names its own ("Claude 29% of the weekly limit · Codex 4% of the 5-hour
 * limit"). null when no agent has a reading.
 */
export function usageSummary(agents: readonly AgentUsage[]): string | null {
  const known = agents.filter((agent) => agent.usedPercent !== null);
  if (known.length === 0) return null;
  const windows = new Set(known.map((agent) => windowName(agent.window)));
  const shared = windows.size === 1 ? [...windows][0]! : undefined;
  const value = (agent: AgentUsage) => `${AGENT_NAME[agent.provider]} ${agent.usedPercent === null ? "–" : `${Math.round(agent.usedPercent)}%`}`;
  if (shared !== undefined) {
    const tail = shared === null ? (known.length === 1 ? "of its limit" : "of their limits") : known.length === 1 ? `of the ${shared} limit` : `of ${shared} limits`;
    return `${agents.map(value).join(" · ")} ${tail}`;
  }
  return agents
    .map((agent) => {
      const name = windowName(agent.window);
      return name && agent.usedPercent !== null ? `${value(agent)} of the ${name} limit` : value(agent);
    })
    .join(" · ");
}

// ------------------------------------------------------------------ tasks

/** The pill for a task: a finished turn of a task from a chat or the page reads "Finished". */
export function taskPhaseLabel(task: Pick<TaskDto, "phase" | "source">): string {
  switch (task.phase) {
    case "starting":
      return "Starting";
    case "working":
      return "Working";
    case "waiting":
      return task.source.kind === "orchestrator" ? "Waiting on orchestrator" : "Waiting on you";
    case "failed":
      return "Failed";
    case "ready":
      return task.source.kind === "orchestrator" ? "Ready" : "Finished";
    case "done":
      return "Done";
    case "cancelled":
      return "Cancelled";
  }
}

/** "From Fix the login bug" / "Checkout refresh" / null for the page. */
export function sourceLabel(source: TaskDto["source"], fallbackTitle = "a chat"): string | null {
  if (source.kind === "page") return null;
  const title = source.title ?? fallbackTitle;
  return source.kind === "chat" ? `From ${title}` : title;
}

/** A task title from the first line of what to do (when the title is left empty). */
export function titleFromBrief(brief: string, max = 80): string {
  const line =
    brief
      .split("\n")
      .map((entry) => entry.replace(/^#+\s*/, "").replace(/^[-*]\s+/, "").trim())
      .find((entry) => entry !== "") ?? "";
  const stripped = line.replace(/^(goal|what's wrong|task):\s*/i, "");
  // The first sentence, when the line has more than one (without its full stop).
  const sentence = /^(.+?[.!?])\s+\S/.exec(stripped)?.[1];
  const plain = sentence !== undefined && sentence.length >= 12 ? sentence.replace(/\.$/, "") : stripped;
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// ------------------------------------------------------------------ starters

export type StarterId = "check-repo" | "fix-bug" | "explore" | "test";

export interface Starter {
  id: StarterId;
  label: string;
  /** Needs a repo (all but the test task). */
  needsRepo: boolean;
  role: "implement" | "review" | "custom";
  /** Model preset (unless you type a model); null: the role's default (Build). */
  tier: "light" | "review" | null;
  title(repo: string): string;
  brief(repo: string): string;
}

const repoName = (repo: string) => repo.trim() || "this repo";

export const STARTERS: readonly Starter[] = [
  {
    id: "check-repo",
    label: "Check this repo runs in a sandbox",
    needsRepo: true,
    role: "custom",
    // Running existing scripts and reporting: the Light preset is enough.
    tier: "light",
    title: (repo) => `Check ${repoName(repo)} runs in a sandbox`,
    brief: (repo) =>
      `${repoName(repo)} is already checked out in this sandbox. Install its dependencies, run the tests and start the app. Don't change any code, and don't commit or push anything.\n\nReport what worked, what failed, and what the boat environment is missing (packages, variables, secret files).`,
  },
  {
    id: "fix-bug",
    label: "Fix a bug",
    needsRepo: true,
    role: "implement",
    tier: null,
    title: () => "",
    brief: () => "What's wrong: \nWhere (file or function): \nError output: \nExpected: \nHow to check: ",
  },
  {
    id: "explore",
    label: "Explore and plan, no changes",
    needsRepo: true,
    role: "custom",
    // Read-only, like a review.
    tier: "review",
    title: () => "",
    brief: (repo) =>
      `Explore ${repoName(repo)} and plan: \n\nDon't change any files. Report the plan, the files involved, the risks and your open questions.`,
  },
  {
    id: "test",
    label: "Test task (no repo)",
    needsRepo: false,
    role: "custom",
    // The server runs it on Light.
    tier: "light",
    title: () => "Test task",
    brief: () =>
      "Reports the output of `uname -a`, `node --version` and `git --version`, and whether GitHub access works (`gh auth status`). Changes nothing. It proves your boat sign-in, plan and agent login.",
  },
];

/** The setup test task (Run a test task, `bb boat task start --test`): no repo, nothing to review. */
export function isTestTask(task: { title: string; repo: string | null }): boolean {
  return task.title === "Test task" && task.repo === null;
}

/**
 * A repo named in a draft: a GitHub link, or one of your projects' repos
 * (owner/name). null: none (other owner/name-looking words may be paths).
 */
export function repoFromText(text: string, known: readonly string[]): string | null {
  const link = /https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+?)(?:\.git)?(?=[\s/#?),.;:]|$)/.exec(text);
  if (link) return link[1]!;
  const words = new Set((text.match(/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]*[A-Za-z0-9_-]/g) ?? []).map((word) => word.toLowerCase()));
  return known.find((repo) => words.has(repo.toLowerCase())) ?? null;
}

/** Tasks started from "Check this repo runs in a sandbox" (they offer Save as snapshot). */
export function isCheckRepoTask(title: string): boolean {
  return /^Check .+ runs in a sandbox$/.test(title);
}

/** A snapshot name from a repo: "acme/web" → "web-ready". */
export function snapshotNameFor(repo: string | null): string {
  const base = (repo ?? "")
    .replace(/\.git$/, "")
    .split("/")
    .pop()
    ?.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "");
  return `${base || "sandbox"}-ready`.slice(0, 80);
}

// ------------------------------------------------------------------ task page

/** Request review: open tasks with work to review (not reviews, not the test task). */
export function canRequestReview(task: Pick<TaskDto, "role" | "status" | "title" | "repo">): boolean {
  if (task.role === "review" || isTestTask(task)) return false;
  // A closed task's sandbox is usually gone, and with it what there was to review.
  return task.status !== "done" && task.status !== "cancelled";
}

/**
 * Whether a task's sandbox link still leads somewhere: open tasks keep their
 * sandbox; a closed one's only while boat still lists it (`sandboxes`: boat's
 * list, null while it loads or can't be read). "gone": deleted.
 */
export function sandboxLink(task: Pick<TaskDto, "status" | "sandboxId">, sandboxes: readonly { id: string }[] | null): "live" | "gone" | "unknown" | null {
  if (task.sandboxId === null) return null;
  if (task.status !== "done" && task.status !== "cancelled") return "live";
  if (sandboxes === null) return "unknown";
  return sandboxes.some((sandbox) => sandbox.id === task.sandboxId) ? "live" : "gone";
}

/** A history entry in plain words; the sandbox's GitHub login expiry is stored as a timestamp. */
export function historyText(event: { kind: string; text: string }, formatTime: (iso: string) => string): string {
  if (event.kind === "github-token" && Number.isFinite(Date.parse(event.text))) {
    return `The sandbox's GitHub login lasts until ${formatTime(event.text)}.`;
  }
  return event.text;
}

// ------------------------------------------------------------------ sandboxes

/** "Task: Fix the login bug", "Chat: Planning", "Orchestrator: Checkout refresh". */
export function sandboxUseLabel(use: Pick<SandboxUseDto, "kind" | "title" | "id">): string {
  const name = use.title ?? (use.kind === "task" ? use.id : "untitled chat");
  return `${use.kind === "task" ? "Task" : use.kind === "chat" ? "Chat" : "Orchestrator"}: ${name}`;
}

// ------------------------------------------------------------------ protocol

export interface Placeholder {
  token: string;
  /** What it becomes, in plain words. */
  meaning: string;
}

/** The template fields the server fills in when an orchestrator loads the protocol (src/protocol.ts). */
export const PROTOCOL_PLACEHOLDERS: readonly Placeholder[] = [
  { token: "{{workers}}", meaning: "how tasks run, from How tasks run" },
  { token: "{{agents}}", meaning: "your agents, usage limits and Claude ↔ Codex switching" },
  { token: "{{evidence}}", meaning: "what to do with screenshots and recordings" },
  { token: "{{model-tiers}}", meaning: "the model presets table (Settings → Models)" },
];

export type ProtocolSegment = { kind: "text"; text: string } | { kind: "field"; text: string; known: boolean };

/** The text split around `{{…}}` fields, so the editor can mark them. */
export function splitPlaceholders(text: string): ProtocolSegment[] {
  const segments: ProtocolSegment[] = [];
  const pattern = /\{\{[a-z0-9-]+\}\}/gi;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) segments.push({ kind: "text", text: text.slice(last, at) });
    segments.push({ kind: "field", text: match[0], known: PROTOCOL_PLACEHOLDERS.some((entry) => entry.token === match[0]) });
    last = at + match[0].length;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

// ------------------------------------------------------------------ text with links

export type RichPart = { kind: "text"; text: string } | { kind: "url"; text: string } | { kind: "code"; text: string };

/** Hints carry links and `commands`: split them so the UI can render both. */
export function richText(text: string): RichPart[] {
  const parts: RichPart[] = [];
  const pattern = /`([^`]+)`|(https:\/\/[^\s)]+[^\s).,;:])/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ kind: "text", text: text.slice(last, at) });
    if (match[1] !== undefined) parts.push({ kind: "code", text: match[1] });
    else parts.push({ kind: "url", text: match[2]! });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

// ------------------------------------------------------------------ evidence uploader

export type EvidenceMode = "off" | "builtin" | "script";

export function evidenceMode(value: string): EvidenceMode {
  const trimmed = value.trim();
  if (trimmed === "") return "off";
  return trimmed === "builtin" ? "builtin" : "script";
}

/** Variables the built-in uploader reads from the boat environment (names only). */
export const EVIDENCE_VARIABLES: readonly { name: string; note: string }[] = [
  { name: "EVIDENCE_BUCKET", note: "the bucket" },
  { name: "EVIDENCE_ACCESS_KEY_ID", note: "its access key" },
  { name: "EVIDENCE_SECRET_ACCESS_KEY", note: "its secret key" },
  { name: "EVIDENCE_ENDPOINT", note: "the S3 endpoint, or CLOUDFLARE_ACCOUNT_ID for R2" },
  { name: "EVIDENCE_REGION", note: "optional" },
  { name: "EVIDENCE_LINK_DAYS", note: "optional, 1–7 days (7)" },
];

// ------------------------------------------------------------- run as a chat

/** The setup checklist's fix for bb Connect, when the connect plugin gives none. */
export const CONNECT_FIX = "Turn on bb Connect: sign in with `bb account login`, then run `bb connect on`.";

export interface ChatControlInput {
  /** How tasks run (useSettings().values.workers): boat, projects or all; undefined while it loads or when it can't be read. */
  workers: string | undefined;
  /** The task's repos as the server sees them ("owner/name"): the typed one (or the project's main repo) first, then the project's others. */
  repos: readonly string[];
  /** The typed repo is complete ("owner/name") or empty: warnings wait for it. */
  repoComplete: boolean;
  /** The plugin's projects; undefined while they load. */
  projects: readonly { name: string; repos: readonly { repo: string }[]; workerMode: "chat" | "boat" }[] | undefined;
  /** overview.taskChats; undefined while it loads (or when it can't). */
  taskChats: boolean | undefined;
  connect: { state: "ready" | "off" | "unknown"; fix: string | null } | undefined;
  /** An existing sandbox is picked under More options: it decides. */
  existingSandbox: boolean;
  /** Still loading what decides (settings, projects, overview). */
  loading: boolean;
}

export interface ChatControl {
  loading: boolean;
  /** The checkbox can be ticked: this bb runs task chats, bb Connect isn't off, no existing sandbox picked. */
  possible: boolean;
  /** The rules run these repos as chats: the default, and no warning. Same rule as the server's chatTrust. */
  trusted: boolean;
  untrustedRepos: string[];
  /** How tasks run is In boat. */
  workersBoat: boolean;
  /** The first untrusted repo's project that runs its tasks headless (null: it's in no project). */
  headlessProject: string | null;
  /** The task's own repo (the first) is trusted; only another repo it clones isn't. */
  mainTrusted: boolean;
  /** The line under the checkbox (RichText). */
  hint: string;
}

/** How the projects run a repo's tasks: null in none; the careful one wins (like the server). */
export function repoModeIn(projects: ChatControlInput["projects"], repo: string): { mode: "chat" | "boat" | null; boatProject: string | null } {
  const lower = repo.toLowerCase();
  const owners = (projects ?? []).filter((project) => project.repos.some((entry) => shortRepoLower(entry.repo) === lower));
  if (owners.length === 0) return { mode: null, boatProject: null };
  const careful = owners.find((project) => project.workerMode === "boat") ?? null;
  return { mode: careful ? "boat" : "chat", boatProject: careful?.name ?? null };
}

function shortRepoLower(repo: string): string {
  return repo
    .replace(/^https?:\/\/(www\.)?github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

export function chatControl(input: ChatControlInput): ChatControl {
  const workersBoat = input.workers !== "projects" && input.workers !== "all";
  const untrustedRepos = workersBoat
    ? [...input.repos]
    : input.repos.filter((repo) => (repoModeIn(input.projects, repo).mode ?? (input.workers === "all" ? "chat" : "boat")) !== "chat");
  const trusted = !workersBoat && untrustedRepos.length === 0;
  const main = input.repos[0];
  const mainTrusted = !workersBoat && (main === undefined || !untrustedRepos.includes(main));
  const first = untrustedRepos[0];
  const headlessProject = first === undefined ? null : repoModeIn(input.projects, first).boatProject;
  const possible = !input.loading && input.taskChats === true && input.connect?.state !== "off" && !input.existingSandbox;
  const hint = input.loading
    ? "Opens as a bb chat you can type into."
    : input.taskChats !== true
      ? input.taskChats === false
        ? "This bb can't run task chats."
        : "Couldn't check whether this bb can run task chats; How tasks run decides."
      : input.existingSandbox
        ? "Follows the sandbox you picked: a chat only if it already runs bb."
        : input.connect?.state === "off"
          ? `Needs bb Connect, which is off. ${input.connect.fix ?? CONNECT_FIX}`
          : input.connect?.state === "unknown"
            ? "Opens as a bb chat you can type into. Couldn't check bb Connect; without it, the task won't start."
            : "Opens as a bb chat you can type into. Off: headless in boat, followed on the Cloud agents page.";
  return { loading: input.loading, possible, trusted, untrustedRepos, workersBoat, headlessProject, mainTrusted, hint };
}

export interface ChatChoice {
  /** What the checkbox shows. */
  checked: boolean;
  /** What startTask gets: what the checkbox shows; null where the rules (or the picked sandbox) decide. */
  runner: "chat" | "boat" | null;
  /** The repos the warning named, sent when the user starts the chat past it ([] for a task with no repo). */
  confirmUntrustedChat: string[] | null;
  /**
   * The one alert under Repository: the warning before an untrusted chat,
   * today's "runs headless" note, or why a project repo's task runs headless
   * (another repo it clones isn't trusted).
   */
  note: "untrusted-chat" | "untrusted" | "headless-other" | null;
}

/**
 * The checkbox follows the rules until the user ticks or clears it
 * (touched: their choice, null until then).
 */
export function chatChoice(
  control: ChatControl,
  touched: boolean | null,
  input: Pick<ChatControlInput, "workers" | "repos" | "repoComplete" | "existingSandbox" | "taskChats" | "projects"> & {
    /** A project has the typed repo (or was picked). */
    inProject: boolean;
  },
): ChatChoice {
  const checked = control.possible ? (touched ?? control.trusted) : false;
  // Unknown (the settings or the overview couldn't be read): the server's rules decide.
  const runner = control.loading || input.existingSandbox || input.taskChats === undefined || input.workers === undefined ? null : checked ? "chat" : "boat";
  const warn = checked && !control.trusted && input.repoComplete;
  // Notes on a headless task wait for the projects (a project repo isn't "outside" while they load).
  const known = !control.loading && input.projects !== undefined && input.repoComplete;
  const headlessNote = known && !checked && input.workers === "projects" && !input.inProject && input.repos.length > 0;
  const otherNote = known && !checked && !control.trusted && control.mainTrusted && input.repos.length > 1;
  return {
    checked,
    runner,
    confirmUntrustedChat: warn && runner === "chat" ? [...control.untrustedRepos] : null,
    note: warn ? "untrusted-chat" : headlessNote ? "untrusted" : otherNote ? "headless-other" : null,
  };
}

// ------------------------------------------------------------- sandbox sizes

type SizeValue = "small" | "default" | "large" | "xlarge";
const SIZE_LABELS: Record<SizeValue, string> = { small: "Small", default: "Default", large: "Large", xlarge: "XLarge" };
const SIZE_SPECS: Record<SizeValue, string> = { small: "2 vCPU, 4 GB", default: "4 vCPU, 8 GB", large: "8 vCPU, 16 GB", xlarge: "16 vCPU, 32 GB" };
const SIZE_ORDER: readonly SizeValue[] = ["small", "default", "large", "xlarge"];

/** "Large (8 vCPU, 16 GB)" */
export function sizeName(type: SizeValue): string {
  return `${SIZE_LABELS[type]} (${SIZE_SPECS[type]})`;
}

const RATE: Record<SizeValue, number | null> = { small: 0.5, default: 1, large: 2, xlarge: null };
const TIMES: Record<string, string> = { "0.25": "a quarter as much", "0.5": "half as much", "2": "twice as much", "4": "four times as much" };

/**
 * What a size costs next to the one it is now (else Default), like the
 * server's costSentence. boat states no rate for XLarge, so it only "costs
 * more" (or less).
 */
export function costHint(type: SizeValue, from: SizeValue | null = null): string {
  const base = from ?? "default";
  if (type === base) return type === "default" ? "Default is the standard rate." : "";
  const to = RATE[type];
  const was = RATE[base];
  if (to === null || was === null) return `${SIZE_LABELS[type]} costs ${isSmaller(type, base) ? "less" : "more"} per hour than ${SIZE_LABELS[base]}.`;
  const times = TIMES[String(to / was)];
  return times ? `${SIZE_LABELS[type]} costs ${times} per hour as ${SIZE_LABELS[base]}.` : "";
}

/** The follow-up the move sends, until the user edits it (`larger`: after running out of memory, onto a larger size). */
export function resizeMessage(type: SizeValue, larger: boolean): string {
  return `Continue where you left off. The sandbox is now ${sizeName(type)}.${larger ? " Run heavy test suites one at a time." : ""}`;
}

/**
 * The size the dialog preselects: after running out of memory, the next one
 * up the plan allows (never a smaller one, nothing when there's none);
 * otherwise nothing, so a move is always the user's pick.
 */
export function suggestedSize(
  current: SizeValue | null,
  sizes: readonly { type: SizeValue; available: boolean }[],
  serverSuggestion: SizeValue | null,
  oom: boolean,
): SizeValue | null {
  if (!oom) return null;
  if (serverSuggestion !== null && (current === null || isSmaller(current, serverSuggestion))) return serverSuggestion;
  if (current === null) return null;
  const allowed = (type: SizeValue) => sizes.find((size) => size.type === type)?.available ?? true;
  return SIZE_ORDER.slice(SIZE_ORDER.indexOf(current) + 1).find(allowed) ?? null;
}

export function isSmaller(type: SizeValue, than: SizeValue | null): boolean {
  return than !== null && SIZE_ORDER.indexOf(type) < SIZE_ORDER.indexOf(than);
}

/**
 * The size a project's new task gets, as the server decides it: the
 * project's when the plan has it, else the setting (or the largest size
 * below the project's the plan has). `blocked`: the project's size and
 * boat's reason, when it falls back.
 */
export function projectSizeOnPlan(
  wanted: SizeValue | null,
  setting: SizeValue,
  sizes: readonly { type: SizeValue; available: boolean; reason: string | null }[] | null,
): { type: SizeValue; blocked: { type: SizeValue; reason: string | null } | null } {
  if (wanted === null) return { type: setting, blocked: null };
  const facts = sizes?.find((size) => size.type === wanted);
  if (facts === undefined || facts.available) return { type: wanted, blocked: null };
  const allowed = (type: SizeValue) => sizes?.find((size) => size.type === type)?.available ?? true;
  const fallback = allowed(setting) ? setting : ([...SIZE_ORDER].reverse().find((type) => isSmaller(type, wanted) && allowed(type)) ?? setting);
  return { type: fallback, blocked: { type: wanted, reason: facts.reason } };
}

/** The peak card's sentence after "Peak memory: 6.1 of 8 GB". */
export function peakSentence(memory: {
  peak: { shared: boolean; percent: number } | null;
  recommendation: { type: SizeValue; label: string; current: SizeValue | null; reason: "near-limit" | "out-of-memory" | "fits" | "largest"; allowed: boolean; planReason: string | null } | null;
  project: { name: string; effective: SizeValue } | null;
}): string {
  const rec = memory.recommendation;
  if (rec === null) return "Its size isn't known, so there's no recommendation.";
  const parts = [
    rec.reason === "largest"
      ? "XLarge is the largest size. Run fewer tests at once."
      : rec.reason === "out-of-memory"
        ? `Recommended size: ${rec.label}. The sandbox ran out of memory during the check.`
        : rec.reason === "near-limit"
          ? `Recommended size: ${rec.label}. The sandbox used ${memory.peak ? `${memory.peak.percent}%` : "over 75%"} of its memory during the check.`
          : `Recommended size: ${rec.label}. The check fits with room to spare.`,
  ];
  if (!rec.allowed) parts.push(`Your boat plan doesn't include ${rec.label}: ${rec.planReason?.replace(/[.\s]+$/, "") ?? "not on your plan"}.`);
  if (memory.peak?.shared) parts.push("Other tasks worked on this sandbox meanwhile, so part of it is theirs.");
  if (rec.reason !== "largest" && memory.project !== null && memory.project.effective === rec.type) parts.push(`${memory.project.name} already uses ${rec.label} sandboxes.`);
  else if (rec.reason !== "largest" && memory.project === null && rec.type !== rec.current && rec.allowed) parts.push(`Next time, pick ${rec.label} under More options in New task.`);
  return parts.join(" ");
}

// ------------------------------------------------------------------ Close and Ship toasts

/** What Close or Ship did to the task's sandbox (closeTask and shipTask). */
export type SandboxOutcome = "deleted" | "kept" | "gone" | "none";

/** The server's reason a sandbox stayed, as a sentence: "Task t_9 still uses it." (null: none). */
export function keptSentence(keptBecause: string | null): string | null {
  const reason = keptBecause?.trim() ?? "";
  return reason === "" ? null : `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
}

/** After Close: "Closed t_1 · sandbox kept", and why it was kept. */
export function closeToast(input: { taskId: string; cancelled: boolean; sandbox: SandboxOutcome; keptBecause: string | null }): {
  title: string;
  description: string | null;
} {
  const note = input.sandbox === "deleted" ? " · sandbox deleted" : input.sandbox === "kept" ? " · sandbox kept" : "";
  return {
    title: `${input.cancelled ? "Cancelled" : "Closed"} ${input.taskId}${note}`,
    description: input.sandbox === "kept" ? keptSentence(input.keptBecause) : null,
  };
}

/** After Ship: whether the task closed, and what happened to its sandbox (kept: why); "stays open" only when it really does. */
export function shipOutcome(input: { status: TaskDto["status"]; sandbox: SandboxOutcome; keptBecause: string | null }): string {
  if (input.status !== "done" && input.status !== "cancelled") {
    return input.status === "running" || input.status === "starting" ? "The task stays open: a new turn started." : "The task stays open.";
  }
  if (input.sandbox === "deleted") return "The task is closed and its sandbox deleted.";
  if (input.sandbox === "kept") return input.keptBecause ? `The task is closed; its sandbox is kept: ${input.keptBecause}.` : "The task is closed; its sandbox is kept.";
  return "The task is closed.";
}

// ------------------------------------------------------------------ The orchestrator card

/** When the Cloud agents page shows the orchestrator card (unless it's hidden). */
export const ORCHESTRATOR_CARD_RULE = "The Cloud agents page shows it while you have no orchestrator.";

/** After the card's ×: what was hidden, and the Settings button that brings it back (in its own words). */
export function cardHiddenToast(): { title: string; description: string } {
  return {
    title: "Orchestrator card hidden. New orchestrator stays in the ⋯ menu at the top.",
    description: "Show the orchestrator card again in Settings → Plugins → Boat Cloud Agents → Orchestrators.",
  };
}

/**
 * After Show the orchestrator card again: "back on the page" only when it
 * is (no orchestrator yet; unknown counts as having one).
 */
export function cardShownToast(hasOrchestrator: boolean): { title: string; description: string | null } {
  return hasOrchestrator
    ? { title: "The orchestrator card is shown again", description: ORCHESTRATOR_CARD_RULE }
    : { title: "The orchestrator card is back on the Cloud agents page", description: null };
}

// ------------------------------------------------------------------ project access

/**
 * Notes on a project's access line about what its environment passes in:
 * boat credentials (the boat CLI's login, for the whole account), a warning,
 * or "couldn't tell" when boat didn't say (never read as off); and real AI
 * keys while the AI proxy is off (only when agent logins go in at all),
 * information only: the proxy is a paid add-on, a trade-off rather than a
 * misconfiguration. Call it only when the environment was read.
 */
export function accessNotes(access: {
  passSandboxCredentials: boolean | null;
  passAgentsCredentials: boolean | null;
  aiProxy: boolean | null;
}): ("boat-credentials" | "boat-credentials-unknown" | "real-ai-keys")[] {
  const notes: ("boat-credentials" | "boat-credentials-unknown" | "real-ai-keys")[] = [];
  if (access.passSandboxCredentials === true) notes.push("boat-credentials");
  if (access.passSandboxCredentials === null) notes.push("boat-credentials-unknown");
  if (access.passAgentsCredentials === true && access.aiProxy === false) notes.push("real-ai-keys");
  return notes;
}

/** "paid add-on, about $1 a day plus $1 per 1,000 requests", or just "paid add-on" when boat didn't price it. */
export function aiProxyCost(price: string | null): string {
  return price ? `paid add-on, ${price}` : "paid add-on";
}
