// Native composer admission: retain intent, then wait before a cold first Boat start.
// Core owns the selected environment, provider, model, draft and provisioning.
import type {
  MessageDispatchHookContext,
  MessageDispatchHookDecision,
} from "@get-bb/plugin-sdk";
import { reviewerSchema } from "../contract-review.ts";
import { normalizeRepo } from "./boat-api.ts";
import { newTaskId } from "./store.ts";
import type { Runtime } from "./runtime.ts";
import type { QuotaReader } from "./quota.ts";

const NATIVE_USAGE_RETRY_MS = 30_000;
const NATIVE_USAGE_READ_MS = 4_000;
const NATIVE_OVERRIDE =
  "Send now overrides this wait and may use paid extra usage.";

/** Only the first pending dispatch, before an environment exists. No warm work. */
function coldNativeBoatStart(context: MessageDispatchHookContext): boolean {
  if (
    context.attempt !== "start-turn" ||
    context.thread.status !== "pending" ||
    context.thread.environmentId !== null ||
    context.environment !== null ||
    context.thread.archivedAt != null ||
    context.thread.deletedAt != null
  )
    return false;
  const target = context.environmentIntent;
  if (target?.kind !== "provider") return false;
  if (target.machine.type === "new")
    return target.machine.machineProviderId === "boat-sandbox";
  return (
    context.host?.machineProviderId === "boat-sandbox" &&
    context.host.lifecycle.phase !== "active"
  );
}

/** The read stays bounded even when an optional usage source ignores abort. */
async function withinNativeDeadline<T>(
  read: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(read), stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * Core owns this queued message and provisioning. Native Send-now bypasses
 * message.dispatch by explicit SDK design; the delegated paid-start form does
 * not protect that user override. Each normal drain/retry reads actual usage.
 */
async function nativeUsageWait(
  context: MessageDispatchHookContext,
  runtime: Runtime,
  quotas?: QuotaReader,
): Promise<MessageDispatchHookDecision | null> {
  if (!coldNativeBoatStart(context)) return null;
  const signal = AbortSignal.timeout(NATIVE_USAGE_READ_MS);
  const provider =
    context.requestedExecution.providerId === "codex"
      ? "codex"
      : context.requestedExecution.providerId === "claude-code"
        ? "claude"
        : null;
  const agent =
    provider === "codex"
      ? "Codex"
      : provider === "claude"
        ? "Claude"
        : "the selected agent";
  const unknown = () => ({
    action: "wait" as const,
    reason: `Couldn’t confirm usage for ${agent}. Waiting before starting this Boat chat. ${NATIVE_OVERRIDE}`,
    sendAt: Date.now() + NATIVE_USAGE_RETRY_MS,
  });
  try {
    const settings = await withinNativeDeadline(
      () => runtime.service.settings(),
      signal,
    );
    if (!settings.avoidExtraUsage) return null;
    if (!provider || !quotas) return unknown();
    const reading = await withinNativeDeadline(
      () => quotas.read(signal, { fresh: true }),
      signal,
    );
    const current = await withinNativeDeadline(
      () => runtime.service.settings(),
      signal,
    );
    if (!current.avoidExtraUsage) return null;
    const quota = reading.get(provider);
    if (
      !quota ||
      quota.provider !== provider ||
      !Number.isFinite(quota.usedPercent) ||
      quota.usedPercent < 0
    )
      return unknown();
    if (quota.usedPercent < current.relay.switchAtPercent) return null;
    const now = Date.now(),
      reset = quota.resetsAt ? Date.parse(quota.resetsAt) : NaN;
    // A real earlier reset can shorten the retry. A future timestamp alone
    // never authorizes provisioning, and settings/usage are rechecked promptly.
    const sendAt = Math.min(
      now + NATIVE_USAGE_RETRY_MS,
      Number.isFinite(reset) && reset > now ? reset : Infinity,
    );
    return {
      action: "wait",
      reason: `${agent} is near its subscription limit. Waiting for room. ${NATIVE_OVERRIDE}`,
      sendAt,
    };
  } catch {
    return unknown();
  }
}

export async function nativeStart(
  context: MessageDispatchHookContext,
  runtime: Runtime,
  quotas?: QuotaReader,
): Promise<MessageDispatchHookDecision | null> {
  const intent = context.experimental_submission;
  const orchestrator =
    intent?.pluginId === "boat" &&
    intent.data &&
    typeof intent.data === "object" &&
    !Array.isArray(intent.data) &&
    intent.data.boatStart === "orchestrator";
  if (orchestrator) {
    try {
      if (runtime.service.store.byThread(context.thread.id))
        return {
          action: "reject",
          message:
            "This chat already runs a task. Coordinate from its parent chat.",
        };
      if (!(await runtime.isOrchestrator(context.thread.id))) {
        const repo = context.project.gitRemoteUrl
          ? normalizeRepo(context.project.gitRemoteUrl)
          : null;
        const configured = repo ? runtime.projects.forRepo(repo) : null;
        const project = await runtime.resolveProject(
          configured
            ? { kind: "boat", id: configured.id }
            : { kind: "local", bbProjectId: context.project.id },
        );
        // Core drops opaque submission data on a queued retry, and Send-now
        // bypasses hooks entirely. Retain the explicit role using the existing
        // metadata-only path before admission can wait; no task/VM is started.
        await runtime.setOrchestrator(context.thread.id, true, project);
      }
    } catch (error) {
      return {
        action: "reject",
        message:
          error instanceof Error
            ? error.message
            : "Couldn’t set up this project for orchestration.",
      };
    }
  }
  const waiting = await nativeUsageWait(context, runtime, quotas);
  return waiting ?? (orchestrator ? { action: "proceed" } : null);
}

/** Register an already provisioned native chat; never create or launch work here. */
export async function adoptNativeChat(
  threadId: string,
  runtime: Runtime,
): Promise<boolean> {
  const { bb, service } = runtime;
  if (
    service.store.byThread(threadId) ||
    (await runtime.isOrchestrator(threadId))
  )
    return false;
  const thread = await bb.sdk.threads.get({ threadId });
  if (
    !thread.environmentId ||
    !["claude-code", "codex"].includes(thread.providerId ?? "")
  )
    return false;
  const environment = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  if (service.store.taskByEnvironment(environment.id)) return false;
  const host = await bb.sdk.hosts.get({ hostId: environment.hostId });
  if (host.machineProviderId !== "boat-sandbox") return false;
  const resource = (await bb.experimental_machines.getResource(host.id)) as {
    sandboxId?: unknown;
    snapshot?: unknown;
    reviewer?: unknown;
  } | null;
  if (
    typeof resource?.sandboxId !== "string" ||
    !/^bx_[A-Za-z0-9]+$/.test(resource.sandboxId)
  )
    return false;
  const projectRow = await bb.sdk.projects.get({ projectId: thread.projectId });
  const repo = projectRow.gitRemoteUrl
    ? normalizeRepo(projectRow.gitRemoteUrl)
    : null;
  const project = repo ? runtime.projects.forRepo(repo) : null;
  // A second lifecycle event may have adopted it while the public reads awaited.
  if (
    service.store.byThread(threadId) ||
    service.store.taskByEnvironment(environment.id)
  )
    return false;
  const now = new Date().toISOString();
  const task = service.store.insert({
    id: newTaskId(),
    title: thread.title ?? "Cloud task",
    role: "implement",
    status: "running",
    orchestratorThreadId: thread.parentThreadId,
    projectId: project?.id ?? null,
    repo,
    repoPath: environment.path,
    branch: null,
    baseBranch: project?.repos[0]?.baseBranch ?? null,
    sandboxId: resource.sandboxId,
    conversationId: null,
    promptId: null,
    provider: thread.providerId === "codex" ? "codex" : "claude",
    model: null,
    reasoningEffort: null,
    tier: null,
    reason: null,
    runner: "chat",
    threadId,
    hostId: host.id,
    environmentId: environment.id,
    readyAt: null,
    readyNote: null,
    // The native checkout's branch is not known; do not offer direct shipping.
    delivery: "pr",
    boatProject: null,
    environment: null,
    snapshot: typeof resource.snapshot === "string" ? resource.snapshot : null,
    extraRepos: [],
    brief: "",
    parentTaskId: null,
    prUrl: null,
    result: null,
    error: null,
    turns: 1,
    ownsSandbox: false,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    notifiedAt: null,
    unshipped: null,
    shipApproval: null,
  });
  service.store.addEvent(
    task.id,
    "native-chat",
    "Registered this existing Boat chat; bb owns its sandbox lifecycle.",
  );
  service.store.addEvent(task.id, "chat", threadId);
  const reviewer = reviewerSchema.safeParse(resource.reviewer);
  service.store.addEvent(
    task.id,
    "native-review-policy",
    JSON.stringify({
      version: 1,
      machineReviewer: reviewer.success ? reviewer.data : null,
      valid: resource.reviewer == null || reviewer.success,
    }),
  );
  bb.rpc.experimental_invalidate([
    "boat:tasks",
    "boat:overview",
    "boat:sandboxes",
  ]);
  return true;
}
