// Native composer submission: only mark the thread before its first turn.
// Core owns the selected environment, provider, model, draft and provisioning.
import type {
  MessageDispatchHookContext,
  MessageDispatchHookDecision,
} from "@get-bb/plugin-sdk";
import { normalizeRepo } from "./boat-api.ts";
import { newTaskId } from "./store.ts";
import type { Runtime } from "./runtime.ts";

export async function nativeStart(
  context: MessageDispatchHookContext,
  runtime: Runtime,
): Promise<MessageDispatchHookDecision | null> {
  const intent = context.experimental_submission;
  if (
    intent?.pluginId !== "boat" ||
    !intent.data ||
    typeof intent.data !== "object" ||
    Array.isArray(intent.data) ||
    intent.data.boatStart !== "orchestrator"
  )
    return null;
  try {
    if (runtime.service.store.byThread(context.thread.id))
      return {
        action: "reject",
        message:
          "This chat already runs a task. Coordinate from its parent chat.",
      };
    if (await runtime.isOrchestrator(context.thread.id))
      return { action: "proceed" };
    const repo = context.project.gitRemoteUrl
      ? normalizeRepo(context.project.gitRemoteUrl)
      : null;
    const configured = repo ? runtime.projects.forRepo(repo) : null;
    const project = await runtime.resolveProject(
      configured
        ? { kind: "boat", id: configured.id }
        : { kind: "local", bbProjectId: context.project.id },
    );
    await runtime.setOrchestrator(context.thread.id, true, project);
    return { action: "proceed" };
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
  bb.rpc.experimental_invalidate(["boat:tasks", "boat:overview", "boat:sandboxes"]);
  return true;
}
