// RPC handlers for sandbox sizes (contract-size.ts): the Change sandbox size
// dialog's facts, the move itself, and a project's size.
import { experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import type { Runtime } from "./runtime.ts";

/** Wraps a handler so expected failures reach the UI as refusals (rpc.ts refuse). */
type Refuse = <T>(fn: () => Promise<T>) => Promise<T>;

export function sizeHandlers(runtime: Runtime, refuse: Refuse) {
  const { service } = runtime;
  return {
    sandboxResizeInfo: ({ id }: { id: string }) => refuse(() => service.sizes.info(id)),

    resizeSandbox: ({ id, type, message }: { id: string; type: "small" | "default" | "large" | "xlarge"; message: string | null }) =>
      refuse(async () => {
        const result = await service.sizes.resize({
          taskId: id,
          type,
          message: message?.trim() || null,
          // The user is the one clicking: their choice is the approval (XLarge, Frontier at max).
          userApproved: true,
          followup: { userApproved: true },
          notifyThreadId: null,
          waitMs: 3_000,
          by: "page",
        });
        runtime.wake();
        runtime.changed();
        return { pending: result.pending, to: result.to, moved: result.moved, sent: result.sent };
      }),

    setProjectSize: ({ projectId, machineType }: { projectId: string; machineType: "small" | "default" | "large" | "xlarge" | null }) =>
      refuse(async () => {
        const project = runtime.projects.get(projectId);
        if (project === null) throw new experimental_PluginRpcRefusal({ code: "not_found", message: `No project "${projectId}".` });
        const saved = runtime.projects.save({ ...project, machineType });
        runtime.changed();
        const verdict = service.sizes.projectSizeVerdict(saved.machineType);
        return { name: saved.name, machineType: saved.machineType, allowed: verdict.allowed, reason: verdict.reason };
      }),
  };
}
