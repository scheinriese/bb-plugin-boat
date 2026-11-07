// Native composer submission: only mark the thread before its first turn.
// Core owns the selected environment, provider, model, draft and provisioning.
import type {
  MessageDispatchHookContext,
  MessageDispatchHookDecision,
} from "@get-bb/plugin-sdk";
import { normalizeRepo } from "./boat-api.ts";
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
