import { startQueueRpcContract } from "../contract-start-queue.ts";
import { createPaidStartInteractions } from "./start-queue-interaction.ts";
import { refuse } from "./rpc.ts";
import type { Runtime } from "./runtime.ts";

export function registerStartQueueRpc(runtime: Runtime): void {
  const { bb, startQueue } = runtime;
  const interactions = createPaidStartInteractions({ queue: startQueue, waitMs: runtime.launchWaitMs,
    requestInput: (request, options) => bb.ui.requestInput(request, options),
    changed: () => runtime.changed(),
  });
  bb.onDispose(() => interactions.dispose());
  bb.rpc.register(startQueueRpcContract, {
    queuedStarts: input => refuse(async () => ({ requests: startQueue.list(input.includeFinished).filter(q=>!input.threadId || q.threadId === input.threadId) })),
    queuedStart: input => refuse(async () => startQueue.get(input.id)),
    cancelQueuedStart: input => refuse(async () => { const result = startQueue.cancel(input.id,input.revision); interactions.cancel(input.id); return result; }),
    requestPaidStart: input => refuse(async () => interactions.request(input)),
    clearDesignClaudePreference: input => refuse(async () => {
      const task = runtime.service.mustGet(input.id);
      runtime.service.store.update(task.id, { designClaudePreference: false, ...(task.claudePaidContinuation ? { claudePaidContinuation: false, claudePaidContinuationRevoked: true } : {}) });
      runtime.service.store.addEvent(task.id, "design-routing-normal", "Returned this task to normal routing. Scoped paid continuation revoked; running turns are unchanged.");
      runtime.changed();
      return { ok: true as const };
    }),
    revokeClaudePaidContinuation: input => refuse(async () => {
      const task = runtime.service.mustGet(input.id);
      if (!task.claudePaidContinuation) return { ok: true as const };
      runtime.service.store.update(task.id, { claudePaidContinuation: false, claudePaidContinuationRevoked: true });
      runtime.service.store.addEvent(task.id, "claude-paid-continuation-revoked", "Claude paid continuation revoked. Future automatic paid resumes are disabled for this task.");
      runtime.changed();
      return { ok: true as const };
    }),
  });
}
