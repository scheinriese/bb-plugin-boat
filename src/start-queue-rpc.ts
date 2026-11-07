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
  });
}
