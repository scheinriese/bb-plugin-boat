// The shared orchestrator protocol: a Markdown file in the plugin's data
// folder (too long for agent instructions, which stop at 4096 characters).
// Orchestrators load it with boat_protocol / `bb boat protocol show`,
// followed by the project's own rules file from its main repo.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AGENTS_PLACEHOLDER,
  DEFAULT_PROTOCOL,
  EVIDENCE_PLACEHOLDER,
  OLD_TASKS_AT_ONCE_SENTENCE,
  TASKS_AT_ONCE_PLACEHOLDER,
  TIER_TABLE_PLACEHOLDER,
  WORKERS_PLACEHOLDER,
} from "./default-protocol.ts";
import { DEFAULT_TASKS_BEFORE_ASKING } from "./orchestrator.ts";
import type { RepoFileReader } from "./github.ts";
import type { OrchestratorProject } from "./projects.ts";
import { AGENT_NAME, onlyAgent, otherAgent } from "./relay.ts";
import type { BoatSettings } from "./service.ts";
import { tierTable, type TierMap } from "./tiers.ts";

export const MAX_PROTOCOL_CHARS = 100_000;

export interface ProtocolFile {
  text: string;
  /** False while the built-in protocol is used (no file saved yet). */
  custom: boolean;
  path: string;
  updatedAt: string | null;
}

export class ProtocolStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  read(): ProtocolFile {
    try {
      const text = readFileSync(this.path, "utf8");
      if (text.trim() !== "") {
        return { text, custom: true, path: this.path, updatedAt: statSync(this.path).mtime.toISOString() };
      }
    } catch {
      // No file yet: the built-in protocol applies.
    }
    return { text: DEFAULT_PROTOCOL, custom: false, path: this.path, updatedAt: null };
  }

  save(text: string): ProtocolFile {
    const normalized = text.replace(/\r\n/g, "\n");
    if (normalized.trim() === "") throw new Error("The protocol is empty. Use Reset to go back to the built-in one.");
    if (normalized.length > MAX_PROTOCOL_CHARS) {
      throw new Error(`The protocol is longer than ${MAX_PROTOCOL_CHARS.toLocaleString("en-US")} characters.`);
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, normalized.endsWith("\n") ? normalized : `${normalized}\n`, "utf8");
    renameSync(temp, this.path);
    return this.read();
  }

  /** Back to the built-in protocol (it then follows plugin updates). */
  reset(): ProtocolFile {
    rmSync(this.path, { force: true });
    return this.read();
  }
}

/** The settings the protocol's placeholders describe. */
export type ProtocolSettings = Pick<
  BoatSettings,
  "workerMode" | "agents" | "implementProvider" | "relay" | "avoidExtraUsage" | "autoFailover" | "evidenceUploader"
> &
  Partial<Pick<BoatSettings, "adhocWorkerMode" | "tasksBeforeAsking">>;

/**
 * The shared protocol with its placeholders filled in: the tier table and,
 * from the settings, how workers run, the agents and their limits, and
 * evidence uploads. Without settings, general wording. A protocol without
 * `{{model-tiers}}` still gets the table at the end; the other placeholders
 * are only filled where a protocol uses them.
 */
export function renderSharedProtocol(text: string, tiers: TierMap, settings?: ProtocolSettings): string {
  const table = tierTable(tiers);
  const filled = text
    .split(WORKERS_PLACEHOLDER)
    .join(workersText(settings))
    .split(AGENTS_PLACEHOLDER)
    .join(agentsText(settings))
    .split(EVIDENCE_PLACEHOLDER)
    .join(evidenceText(settings))
    .split(TASKS_AT_ONCE_PLACEHOLDER)
    .join(tasksAtOnceText(settings))
    // A saved copy of the older built-in protocol follows the setting too.
    .split(OLD_TASKS_AT_ONCE_SENTENCE)
    .join(tasksAtOnceText(settings));
  if (filled.includes(TIER_TABLE_PLACEHOLDER)) return filled.split(TIER_TABLE_PLACEHOLDER).join(table);
  return `${filled.trimEnd()}\n\n## Model presets (from the plugin settings)\n\n${table}\n`;
}

/** `{{workers}}`: one or two sentences on how a task runs (the How tasks run setting). */
export function workersText(settings?: Pick<ProtocolSettings, "workerMode" | "adhocWorkerMode">): string {
  return `${workersRunText(settings)} I can also move a headless task into a task chat from its page; boat_followup then goes into that chat.`;
}

function workersRunText(settings?: Pick<ProtocolSettings, "workerMode" | "adhocWorkerMode">): string {
  const chat =
    "a regular bb chat nested under your chat in the sidebar (I can open it and write to it directly; a turn I start there wakes you too)";
  if (settings?.workerMode === "boat") {
    return "Each task runs headless in boat on its own boat sandbox; I can follow it on the Cloud agents page.";
  }
  if (settings?.workerMode === "chat" && settings.adhocWorkerMode === "chat") {
    return `Each task runs on its own boat sandbox as ${chat}, except in projects set to run tasks in boat, where it runs headless and I follow it on the Cloud agents page.`;
  }
  if (settings?.workerMode === "chat") {
    return `Each task runs on its own boat sandbox: in projects that run tasks as chats, as ${chat}; otherwise headless in boat, and I follow it on the Cloud agents page.`;
  }
  return `Each task runs on its own boat sandbox, as ${chat} or headless in boat (I follow it on the Cloud agents page), depending on the plugin settings and the project.`;
}

/** `{{agents}}`: the default agent, usage limits, failover and the relay, as bullets. */
export function agentsText(settings?: Omit<ProtocolSettings, "workerMode" | "evidenceUploader">): string {
  if (settings === undefined) {
    return [
      "- A dispatch without `agent` uses the default agent from the plugin settings (with Claude ↔ Codex switching on, an agent with room). Name an agent only when the work needs that one.",
      "- If a dispatch fails with `agents_at_limit`, the agents are near their usage limits. Tell me and wait for a reset (`bb boat relay status` shows when); don't name an agent to get around it unless I said paid extra usage is fine.",
      "- A task that hits its limit mid-turn may be handed to the other agent automatically, with the same model preset (the task history says so). Don't restart the task elsewhere.",
      "- With Claude ↔ Codex switching on, you can be moved too: a `[boat relay]` message asks for your handoff note. Write it as your final message (decisions in force, open questions waiting on me, what's running, what's next) and do nothing else.",
    ].join("\n");
  }
  const only = onlyAgent(settings.agents);
  const lines: string[] = [];
  const limitLine = (who: string) =>
    settings.avoidExtraUsage
      ? `- If a dispatch fails with \`agents_at_limit\`, ${who}. Tell me and wait for a reset (\`bb boat relay status\` shows when); don't name an agent to get around it unless I said paid extra usage is fine.`
      : "- Paid extra usage is allowed in the plugin settings, so new work starts even near a usage limit.";
  if (only !== null) {
    const name = AGENT_NAME[only];
    lines.push(
      `- Only ${name} is set up, so every task and review runs on ${name} (reviews still run, in a fresh context). Don't pass \`agent\`.`,
      limitLine(`${name} is near its usage limit`),
      `- A task that hits its limit mid-turn stops. Tell me, and continue it with \`boat_followup\` after the reset.`,
    );
    return lines.join("\n");
  }
  const preferred = settings.implementProvider;
  const other = AGENT_NAME[otherAgent(preferred)];
  lines.push(
    settings.relay.enabled
      ? `- ${AGENT_NAME[preferred]} is the default agent. A dispatch without \`agent\` starts on an agent with room: near ${AGENT_NAME[preferred]}'s limit it goes to ${other} with the same model preset (the task history says so), and back once ${AGENT_NAME[preferred]} has room. Name an agent only when the work needs that one.`
      : `- ${AGENT_NAME[preferred]} is the default agent; a dispatch without \`agent\` uses it. Name an agent only when the work needs that one.`,
    limitLine("Claude and Codex are both near their limits"),
    settings.autoFailover
      ? "- A task that hits its limit mid-turn is handed to the other agent automatically, with the same model preset, in the same workspace (the task history says so). Don't restart the task elsewhere. To switch by hand, use `boat_followup` with the other agent: it keeps the preset and briefs the new agent on where the work stands."
      : "- A task that hits its limit mid-turn stops. Tell me; continue it with `boat_followup` after the reset, or with the other agent (it keeps the preset and briefs the new agent on where the work stands).",
  );
  if (settings.relay.enabled) {
    lines.push(
      `- You can be moved too. Near your own agent's limit, a \`[boat relay]\` message asks for your handoff note: write it as your final message (decisions in force, open questions waiting on me, what's running, what's next) and do nothing else. An orchestrator on the other agent then takes over in the same workspace, with your tasks and decisions. When ${AGENT_NAME[settings.relay.preferred]} has room again, it hands back the same way at a quiet moment.`,
    );
  }
  return lines.join("\n");
}

/** `{{tasks-at-once}}`: when to ask before running more tasks at once (Tasks at once before asking; 0: never). */
export function tasksAtOnceText(settings?: Pick<ProtocolSettings, "tasksBeforeAsking">): string {
  const value = settings?.tasksBeforeAsking ?? DEFAULT_TASKS_BEFORE_ASKING;
  const count = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  if (count === 0) return "You don't need to ask me before running several tasks at once, but each one uses sandbox time and agent usage: start only what the work needs.";
  return `Ask me before running more than ${count} ${count === 1 ? "task" : "tasks"} at once, unless I asked for more: each one uses sandbox time and agent usage.`;
}

/** `{{evidence}}`: what to do about screenshots and recordings (a bullet in "Acting on reports"). */
export function evidenceText(settings?: Pick<ProtocolSettings, "evidenceUploader">): string {
  const uploads =
    "- A report that mentions screenshots or recordings without links: ask the task's agent to upload them before its sandbox is stopped or deleted (`boat_followup` with `evidence_only`, which keeps the task's review and ready state). Upload links expire (after at most 7 days). For a fresh one, run `bb boat sandbox exec <sandbox id> -- evidence-upload --link <key>` on the sandbox of an open task whose history says evidence-upload is installed; your own workspace doesn't have it.";
  if (settings === undefined) return `${uploads} If evidence uploads are off in the plugin settings, screenshots and recordings stay in the sandbox: keep it until I've looked.`;
  if (settings.evidenceUploader.trim() !== "") return uploads;
  return "- Evidence uploads are off in the plugin settings, so screenshots and recordings stay in the task's sandbox. Ask its agent to describe what it checked, and keep the task open until I've looked: closing it deletes the sandbox.";
}

export interface ProjectRules {
  /** Repo-relative path, e.g. docs/agents/orchestrator.md. */
  path: string;
  repo: string;
  ref: string;
  text: string | null;
  error: string | null;
}

/** Fetch the project's rules file from its main repo on GitHub, if it has one. */
export async function loadProjectRules(
  project: OrchestratorProject | null,
  read: RepoFileReader,
  signal?: AbortSignal,
): Promise<ProjectRules | null> {
  const main = project?.repos[0];
  if (!project?.protocolPath || !main) return null;
  const base = { path: project.protocolPath, repo: main.repo, ref: main.baseBranch };
  try {
    return { ...base, text: await read(main.repo, project.protocolPath, main.baseBranch, signal), error: null };
  } catch (error) {
    return { ...base, text: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Shared protocol first, then the project's rules (they win where they're more specific). */
export function composeProtocol(shared: string, project: OrchestratorProject | null, rules: ProjectRules | null): string {
  const parts = [shared.trim()];
  if (project?.delivery === "push") {
    parts.push(
      "# How work lands in this project",
      `${project.name} ships after the user approves: tasks only commit in their sandbox (no branches or pull requests on GitHub), reviews run in the reviewed task's sandbox, and work reaches the base branch only through boat_ship after the user's OK in this chat (or their Ship click on the overview).`,
    );
  }
  if (project === null) {
    parts.push(
      "# Project",
      "This chat has no project. Pass `repo` (and `base_branch`) to boat_dispatch, or ask the user to set one with `bb boat orchestrator on --project <id>`.",
    );
  } else if (rules === null) {
    parts.push(
      `# Project rules: ${project.name}`,
      "This project has no rules file in its repo (set one in Settings → Plugins → Boat Cloud Agents → Projects). Tasks still follow the repo's AGENTS.md.",
    );
  } else if (rules.text !== null) {
    parts.push(
      `# Project rules: ${project.name}`,
      `From \`${rules.path}\` in ${rules.repo} (${rules.ref}). Read after the shared protocol: where they're more specific, they apply. Tasks still follow the repo's AGENTS.md.`,
      rules.text.trim(),
    );
  } else {
    parts.push(
      `# Project rules: ${project.name}`,
      `Couldn't read \`${rules.path}\` from ${rules.repo} (${rules.ref}): ${rules.error}`,
      `Read it yourself before dispatching: \`gh api -H "Accept: application/vnd.github.raw" "repos/${rules.repo}/contents/${rules.path}?ref=${rules.ref}"\`, or ask the user.`,
    );
  }
  return parts.join("\n\n");
}
