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
