// Instabox's JSON, read into the plugin's model (../types.ts). The shapes
// are the documented ones (CLI reference, OpenAPI 3.1 spec, `--help` of CLI
// 0.8.309); none was observed from a live account yet, so every accessor
// tolerates missing fields.
import type { CapacityReport, ChatEvent, Conversation, MachineType, ProcessSample, SandboxInfo, SavedSnapshot } from "../types.ts";
import { num, rec, str, type JsonRecord } from "./cli.ts";

/** Instabox machine ids. */
export const MACHINE_ID_PATTERN = /^m_[A-Za-z0-9]+$/;

/**
 * Instabox's states in the plugin's state model (boat.dev's names, see
 * ACTIVE_STATES): a machine that runs is "idle" (Instabox has no state for
 * its agent working), a paused one "stopped" (resume() tells it from a stop).
 */
export const STATES: Record<string, string> = {
  creating: "provisioning",
  starting: "starting",
  running: "idle",
  stopping: "stopping",
  suspending: "stopping",
  stopped: "stopped",
  suspended: "stopped",
  resuming: "resuming",
  deleting: "stopping",
  deleted: "cancelled",
  error: "error",
};

/** The plugin's sizes as Instabox names them (`--vcpus`, `--mem-mib`). */
export const SPECS: Record<MachineType, { vcpus: number; memMiB: number }> = {
  small: { vcpus: 2, memMiB: 4096 },
  default: { vcpus: 4, memMiB: 8192 },
  large: { vcpus: 8, memMiB: 16384 },
  xlarge: { vcpus: 16, memMiB: 32768 },
};

export function machineTypeOf(vcpus: number | null, memMiB: number | null): MachineType | null {
  for (const [type, spec] of Object.entries(SPECS) as [MachineType, { vcpus: number; memMiB: number }][]) {
    if (spec.vcpus === vcpus && spec.memMiB === memMiB) return type;
  }
  return null;
}

/** The machine's own state name (running, suspended, stopped, …). */
export function nativeState(raw: JsonRecord): string | null {
  return str(raw.state) ?? str(rec(raw.state)?.name);
}

/** `instabox get --json` / one entry of `ls --json`. */
export function toSandbox(raw: JsonRecord): SandboxInfo {
  const id = str(raw.id) ?? "";
  const state = nativeState(raw) ?? "unknown";
  const spec = rec(raw.spec);
  const error = rec(raw.lastError);
  const metadata = rec(raw.metadata);
  const lease = rec(raw.lease);
  const mac = lease && str(lease.startedAt) && str(lease.chargeUntil) && num(lease.hourUSD) !== null ? {
    model: str(metadata?.["boat-mac-model"]) ?? (str(rec(raw.template)?.id) === "macos" ? str(raw.model) : null) ?? str(raw.pool)?.replace(/^mac-/, "") ?? "mac",
    leaseId: String(lease.id), startedAt: str(lease.startedAt)!, chargeUntil: str(lease.chargeUntil)!, hourPrice: num(lease.hourUSD)!, minimumCost: num(lease.hourUSD)! * (Date.parse(str(lease.chargeUntil)!)-Date.parse(str(lease.startedAt)!))/3_600_000,
    cpus: num(spec?.vcpus) ?? 0, memoryMiB: num(spec?.memMiB) ?? 0,
  } : undefined;
  return {
    ...(mac ? { system: "macos" as const, mac } : str(rec(raw.template)?.id) === "macos" ? { system: "macos" as const } : {}),
    id,
    name: str(raw.name),
    state: STATES[state] ?? state,
    health: rec(raw.runtime)?.ready === true ? "ok" : null,
    url: null,
    desktopUrl: null,
    environment: null,
    createdAt: str(raw.createdAt),
    ...(mac ? { scheduledReleaseAt: str(raw.deleteAt) } : {}),
    // Instabox has no auto-stop deadline; it pauses an idle machine instead.
    archiveAfter: str(raw.archiveAt),
    stoppedAt: state === "stopped" || state === "suspended" ? (str(raw.updatedAt) ?? null) : null,
    setupStatus: str(metadata?.setupStatus),
    error: error === null ? null : (str(error.message) ?? str(error.code)),
    machineType: machineTypeOf(num(spec?.vcpus) ?? num(raw.vcpus), num(spec?.memMiB) ?? num(raw.memMiB)),
  };
}

/** `ls --json`: an array, or `{machines: [...]}`. */
export function machineList(value: unknown): JsonRecord[] {
  const list = Array.isArray(value) ? value : (rec(value)?.machines as unknown[] | undefined) ?? [];
  return list.map(rec).filter((entry): entry is JsonRecord => entry !== null);
}

/**
 * `usage --json`: the plan's machine limit counts machines in any state
 * (paused and stopped ones too), so `activeSandboxes` is every machine.
 */
export function toCapacity(raw: JsonRecord): CapacityReport {
  const limits = rec(raw.limits) ?? {};
  const unlimited = Array.isArray(limits.unlimited) ? limits.unlimited.filter((entry): entry is string => typeof entry === "string") : [];
  const machines = num(raw.machines) ?? 0;
  const max = unlimited.includes("maxMachines") ? null : num(limits.maxMachines);
  const org = rec(raw.org);
  const tier = str(org?.tier);
  const full = max !== null && machines >= max;
  return {
    tier,
    summary: max === null ? "no limit on machines" : `up to ${max} machine${max === 1 ? "" : "s"}, paused and stopped ones included`,
    activeSandboxes: machines,
    maxActiveSandboxes: max,
    startsLeftToday: null,
    startsLeftThisHour: null,
    canStart: !full,
    blockedReason: full
      ? `your plan allows ${max} machine${max === 1 ? "" : "s"} and ${machines} exist (paused and stopped ones count); delete one you no longer need with \`instabox rm <name>\``
      : null,
    checkoutRequired: false,
    autoStopCapHours: null,
    machineTypes: planSizes(limits.machineSpecs),
  };
}

/** The plugin's sizes against the plan's (`limits.machineSpecs`: vCPUs and memory a new machine may have); null: not said. */
export function planSizes(specs: unknown): CapacityReport["machineTypes"] {
  if (!Array.isArray(specs)) return null;
  const allowed = specs.map(rec).filter((spec): spec is JsonRecord => spec !== null);
  return (Object.keys(SPECS) as MachineType[]).map((type) => {
    const available = allowed.some((spec) => num(spec.vcpus) === SPECS[type].vcpus && num(spec.memMiB) === SPECS[type].memMiB);
    return { type, available, reason: available ? null : "your Instabox plan doesn't include this size" };
  });
}

/**
 * `usage --json`'s cost, in one line as Instabox states it: this month's
 * usage so far and the credit left ("$3.21 used this month · $16.79 credit
 * left"). Null when it says neither (an older server, a free account).
 */
export function toPricing(raw: JsonRecord): string | null {
  const cost = rec(raw.cost);
  const dollars = (value: unknown) => {
    const amount = num(value);
    return amount === null ? null : `$${amount.toFixed(2)}`;
  };
  const used = dollars(cost?.costUSD);
  const left = dollars(cost?.creditRemainingUSD);
  const parts = [used === null ? null : `${used} used this month`, left === null ? null : `${left} credit left`].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** GET /v1/machines/{id}/processes, including its freshness/completeness envelope.
 * Bare CLI rows remain unknown: ps --json omits this evidence even for a
 * stored or truncated list. Never promote them based on a successful exit.
 */
export function toProcessSample(value: unknown, read?: { machineId: string; requestedAt: number; receivedAt: number }): ProcessSample {
  const raw = rec(value);
  const rows = Array.isArray(value) ? value : Array.isArray(raw?.processes) ? raw.processes : [];
  const capturedAt = str(raw?.capturedAt);
  const captured = capturedAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(capturedAt) ? Date.parse(capturedAt) : NaN;
  const nonnegative = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const complete = Array.isArray(raw?.processes) && rows.every(value => {
    const row = rec(value);
    return row !== null && Number.isSafeInteger(row.pid) && (row.pid as number) > 0
      && Number.isSafeInteger(row.ppid) && (row.ppid as number) >= 0
      && typeof row.command === "string" && row.command.trim() !== ""
      && typeof row.user === "string" && row.user.trim() !== ""
      && nonnegative(row.cpuPercent) && nonnegative(row.memPercent)
      && Number.isSafeInteger(row.elapsedSeconds) && (row.elapsedSeconds as number) >= 0;
  });
  // Bound both request duration and capture age; allow at most five seconds
  // of server clock skew. The provider timestamp is evidence, not local now().
  const fresh = read !== undefined && Number.isFinite(captured)
    && read.receivedAt >= read.requestedAt && read.receivedAt - read.requestedAt <= 30_000
    && captured >= read.requestedAt - 5_000 && captured <= read.receivedAt + 5_000
    && read.receivedAt - captured <= 30_000;
  const live = raw?.live === false ? false
    : raw?.live === true && raw.machineId === read?.machineId && raw.state === "running"
      && raw.trigger === "request" && raw.truncated === false && raw.error === undefined
      && complete && fresh ? true : null;
  return {
    live,
    sampledAt: Number.isFinite(captured) ? capturedAt : null,
    processes: rows
      .map(rec)
      .filter((row): row is JsonRecord => row !== null)
      .map((row) => ({
        pid: num(row.pid),
        command: str(row.command) ?? "",
        cpuPercent: num(row.cpuPercent),
        memoryMb: null,
        commandId: null,
        parentPid: num(row.ppid),
        startedAt: null,
        user: str(row.user),
      })),
  };
}

/** `snapshot ls --json`: an array, or `{snapshots: [...]}`. */
export function toSnapshots(value: unknown): SavedSnapshot[] {
  const rows = Array.isArray(value) ? value : (rec(value)?.snapshots as unknown[] | undefined) ?? [];
  return rows
    .map(rec)
    .filter((row): row is JsonRecord => row !== null && str(row.name) !== null)
    .map((row) => {
      const data = num(row.dataSizeBytes);
      const root = num(row.rootSizeBytes);
      return {
        name: str(row.name)!,
        sizeBytes: data === null && root === null ? null : (data ?? 0) + (root ?? 0),
        createdAt: str(row.createdAt),
        sourceSandboxId: str(row.sourceMachineId),
        status: str(row.status),
        type: null,
      };
    });
}

/** `agent ls --json`: `{conversations: [...], total}`. */
export function toConversations(value: unknown): Conversation[] {
  const rows = Array.isArray(value) ? value : (rec(value)?.conversations as unknown[] | undefined) ?? [];
  return rows
    .map(rec)
    .filter((row): row is JsonRecord => row !== null && (str(row.id) ?? str(row.conversationId)) !== null)
    .map((row) => ({
      id: (str(row.id) ?? str(row.conversationId))!,
      running: str(row.status) === "running",
      harness: str(row.provider),
      model: str(row.model),
      prompts: num(row.turns) ?? 0,
      lastPromptAt: str(row.lastPromptAt),
      lastPromptPreview: str(row.firstPrompt) ?? str(row.lastPrompt),
    }));
}

/** The id a turn's events and its dispatch share: its turn number, else its job. */
export function turnId(raw: JsonRecord): string | null {
  const turn = num(raw.turn);
  return turn !== null ? `turn-${turn}` : str(raw.jobId);
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content.map((part) => (rec(part)?.type === "text" ? str(rec(part)?.text) : null)).filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join("\n");
}

function toolsOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.map((part) => (rec(part)?.type === "tool_use" ? str(rec(part)?.name) : null)).filter((name): name is string => name !== null);
}

/**
 * `agent events --json`: `{conversationId, jobId, status, exitCode, events}`,
 * the agent's own events (Claude stream-json, Codex exec --json) between
 * `instabox.turn` and `instabox.turn_end {exitCode, interrupted}`. Read into
 * the plugin's events: a "prompt" event per turn start and end (its status:
 * running, finished, failed, interrupted) and a "response" per message.
 */
export function toChatEvents(raw: JsonRecord, conversationId: string): ChatEvent[] {
  const events = Array.isArray(raw.events) ? raw.events.map(rec).filter((entry): entry is JsonRecord => entry !== null) : [];
  const out: ChatEvent[] = [];
  let promptId: string | null = null;
  let lastError: string | null = null;
  let open = false;
  const timestamp = (event: JsonRecord): number | null => {
    const at = str(event.at) ?? str(event.timestamp);
    const parsed = at === null ? NaN : Date.parse(at);
    return Number.isFinite(parsed) ? parsed : num(event.timestamp);
  };
  const push = (event: Omit<ChatEvent, "conversationId" | "promptId">, at: JsonRecord) => out.push({ ...event, promptId, conversationId, timestamp: event.timestamp ?? timestamp(at) });
  for (const event of events) {
    const type = str(event.type) ?? "";
    if (type === "instabox.turn") {
      promptId = turnId(event);
      lastError = null;
      open = true;
      push({ type: "prompt", status: "running", content: str(event.prompt), error: null, timestamp: null, tools: [] }, event);
      continue;
    }
    if (type === "instabox.turn_end") {
      const exit = num(event.exitCode);
      const interrupted = event.interrupted === true;
      const status = interrupted ? "interrupted" : exit === 0 ? "finished" : "failed";
      push({ type: "prompt", status, content: null, error: status === "failed" ? (lastError ?? `the agent exited with code ${exit ?? "?"}`) : null, timestamp: null, tools: [] }, event);
      open = false;
      continue;
    }
    // Claude Code (stream-json).
    if (type === "assistant") {
      const content = rec(event.message)?.content;
      const text = textOf(content);
      const tools = toolsOf(content);
      if (text !== null || tools.length > 0) push({ type: "response", status: null, content: text, error: null, timestamp: null, tools }, event);
      continue;
    }
    if (type === "result") {
      const text = str(event.result);
      if (event.is_error === true) lastError = text ?? str(event.subtype) ?? "the agent failed";
      else if (text !== null) push({ type: "response", status: null, content: text, error: null, timestamp: null, tools: [] }, event);
      continue;
    }
    // Codex (exec --json): agent messages, and the commands it ran.
    const item = rec(event.item);
    if (type === "item.completed" && item !== null) {
      if (str(item.type) === "agent_message") push({ type: "response", status: null, content: str(item.text), error: null, timestamp: null, tools: [] }, event);
      else if (str(item.type) !== null) push({ type: "response", status: null, content: null, error: null, timestamp: null, tools: [str(item.type)!] }, event);
      continue;
    }
    if (type === "error" || type === "turn.failed") lastError = str(event.message) ?? str(rec(event.error)?.message) ?? lastError;
  }
  // The job went away mid-turn: say so, rather than waiting on it.
  const conversation = str(raw.status);
  if (open && (conversation === "lost" || (conversation !== null && /^failed/.test(conversation)))) {
    out.push({ type: "prompt", promptId, conversationId, status: "failed", content: null, error: conversation === "lost" ? "Instabox lost the agent's job" : (lastError ?? `the agent ${conversation}`), timestamp: null, tools: [] });
  }
  return out;
}
