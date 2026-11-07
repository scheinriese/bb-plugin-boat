// Pure logic behind the entry points outside the Cloud agents page
// (web/entry-points.tsx): the composer's "Send to a cloud agent" prefix, which
// thread actions a chat gets, the Boat sandbox size chip's value, and the
// project a chat would coordinate. No React and no SDK here, so the tests can
// import it directly (test/entry-points.test.ts).
import type { SandboxSizeDto, ThreadRoleDto } from "../contract";

type MachineType = SandboxSizeDto["type"];
const MACHINE_TYPES: readonly MachineType[] = [
  "small",
  "default",
  "large",
  "xlarge",
];

// ------------------------------------------------------------------ composer

/** What "Send to a cloud agent" puts before the draft; the boat skill does the rest. */
export const CLOUD_AGENT_PREFIX =
  "Use a cloud agent for this (boat skill: `bb boat task start`).\n\n";

interface Ranged {
  from: number;
  to: number;
}

/** The draft with `prefix` in front; mention pills move along with their text. */
export function prefixDraft<M extends Ranged>(
  draft: { text: string; mentions: readonly M[] },
  prefix: string,
): { text: string; mentions: M[] } {
  const shift = prefix.length;
  return {
    text: `${prefix}${draft.text}`,
    mentions: draft.mentions.map((mention) => ({
      ...mention,
      from: mention.from + shift,
      to: mention.to + shift,
    })),
  };
}

/** Undo prefixDraft (the send didn't go out); null when the draft no longer starts with it. */
export function unprefixDraft<M extends Ranged>(
  draft: { text: string; mentions: readonly M[] },
  prefix: string,
): { text: string; mentions: M[] } | null {
  if (!draft.text.startsWith(prefix)) return null;
  const shift = prefix.length;
  return {
    text: draft.text.slice(shift),
    mentions: draft.mentions
      .filter((mention) => mention.from >= shift)
      .map((mention) => ({
        ...mention,
        from: mention.from - shift,
        to: mention.to - shift,
      })),
  };
}

// ------------------------------------------------------------ thread actions

/** Ship in a task chat's header: when the task can ship (same rule as the Ship button on the page). */
export function shipFromChat(role: ThreadRoleDto | undefined) {
  return role?.kind === "task" && role.task.canShip ? role.task : null;
}

/**
 * Request review in a task chat's header: for open tasks that aren't reviews
 * themselves, disabled while the agent works (as on the task page).
 */
export function reviewFromChat(role: ThreadRoleDto | undefined) {
  if (role?.kind !== "task") return null;
  const { task } = role;
  if (
    task.role === "review" ||
    task.status === "done" ||
    task.status === "cancelled"
  )
    return null;
  return {
    task,
    disabled: task.status === "running" || task.status === "starting",
  };
}

/**
 * The thread menu's coordinate entry: plain chats can start coordinating,
 * orchestrators can stop. Task chats get neither, and nothing shows while the
 * role is still loading.
 */
export function coordinateAction(
  role: ThreadRoleDto | undefined,
  archived: boolean,
): "coordinate" | "stop" | null {
  if (role === undefined) return null;
  if (role.kind === "orchestrator") return "stop";
  if (role.kind === "chat" && !archived) return "coordinate";
  return null;
}

// ------------------------------------------------------------ size chip

export type MachineInputsChange =
  | { status: "ready"; value: Record<string, string | boolean> }
  | { status: "blocked"; reason: string };

export interface SizeChipState {
  /** The size the chip shows: the picked one, else the default for chats. */
  type: MachineType;
  /** Picked in the chip; otherwise the machine gets Size for chats on a Boat sandbox when it's created. */
  picked: boolean;
  /** A prepared sandbox the machine adopts (a task chat's): there's no size to pick. */
  adopted: boolean;
  change: MachineInputsChange;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What the Boat sandbox size chip reports for the machine's inputs (the
 * provider's schema: `{ type?, sandboxId?, taskId? }`). Unpicked, it reports
 * `{}`, so the setting decides at creation. A size the plan can't use blocks
 * the send with boat's reason. `sizes` null: unknown, every size allowed.
 */
export function sizeChipState(
  value: unknown,
  sizes: readonly SandboxSizeDto[] | null,
  chatDefault: MachineType,
): SizeChipState {
  const inputs = isRecord(value) ? value : {};
  if (typeof inputs.sandboxId === "string") {
    const kept: Record<string, string | boolean> = {
      sandboxId: inputs.sandboxId,
    };
    if (typeof inputs.taskId === "string") kept.taskId = inputs.taskId;
    if (inputs.keepSandbox === true) kept.keepSandbox = true;
    return {
      type: chatDefault,
      picked: false,
      adopted: true,
      change: { status: "ready", value: kept },
    };
  }
  const picked = MACHINE_TYPES.find((type) => type === inputs.type) ?? null;
  const type = picked ?? chatDefault;
  const size = sizes?.find((entry) => entry.type === type) ?? null;
  if (size !== null && !size.available) {
    return {
      type,
      picked: picked !== null,
      adopted: false,
      change: {
        status: "blocked",
        reason: size.reason
          ? `${size.label}: ${size.reason}`
          : `${size.label} isn't on your boat plan`,
      },
    };
  }
  const kept: Record<string, string | boolean> =
    picked === null ? {} : { type: picked };
  if (
    typeof inputs.snapshot === "string" &&
    inputs.snapshot.length > 0 &&
    inputs.snapshot.length <= 120
  )
    kept.snapshot = inputs.snapshot;
  return {
    type,
    picked: picked !== null,
    adopted: false,
    change: { status: "ready", value: kept },
  };
}

// ------------------------------------------------------------ coordinate

/**
 * The project a chat would coordinate: the one with its bb project's repo,
 * else the only one, else the one the newest orchestrator works on.
 */
export function coordinateProject(input: {
  matchId: string | null;
  projects: readonly { id: string }[];
  orchestrators: readonly { projectId: string | null; createdAt: string }[];
}): string | null {
  const known = new Set(input.projects.map((project) => project.id));
  if (input.matchId !== null && known.has(input.matchId)) return input.matchId;
  if (input.projects.length === 1) return input.projects[0]!.id;
  const newest = [...input.orchestrators]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .find((entry) => entry.projectId !== null && known.has(entry.projectId));
  return newest?.projectId ?? null;
}

export const NATIVE_STARTERS = [
  {
    id: "check-repo",
    label: "Check the repo runs",
    icon: "Play",
    prompt:
      "Check this repository runs. Install dependencies, run its checks, and report any setup problems.",
  },
  {
    id: "fix-bug",
    label: "Fix a bug",
    icon: "Bug",
    prompt:
      "Help me fix a bug in this repository. Ask me what happens and what I expected, then investigate.",
  },
  {
    id: "explore-plan",
    label: "Explore and plan",
    icon: "Search",
    prompt:
      "Explore this repository and help me plan the next change. Explain the relevant code before making changes.",
  },
] as const;

/** Let core submit its own complete draft and selection. Never copy text into startTask. */
export async function submitNativeStart(
  composer: {
    readonly isSubmittingBlocked: boolean;
    readonly submittingBlockedReason: string | null;
    submit(options?: {
      experimental_data?: { boatStart: "task" | "orchestrator" };
    }): Promise<unknown>;
  },
  kind: "task" | "orchestrator",
): Promise<void> {
  if (composer.isSubmittingBlocked)
    throw new Error(
      composer.submittingBlockedReason ??
        "Finish setting up this chat before starting.",
    );
  await composer.submit({ experimental_data: { boatStart: kind } });
}
