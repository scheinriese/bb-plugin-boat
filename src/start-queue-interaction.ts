import { randomUUID } from "node:crypto";
import type { PluginInteractionRequest, PluginInteractionResult } from "@get-bb/plugin-sdk";
import { PAID_START_RENDERER_ID, paidStartChoiceSchema } from "../contract-start-queue.ts";
import { TaskError } from "./service.ts";
import type { Provider } from "./store.ts";
import type { StartQueue } from "./start-queue.ts";

export function createPaidStartInteractions(deps: {
  queue: StartQueue; waitMs: number;
  requestInput(request: PluginInteractionRequest, options: { signal: AbortSignal }): Promise<PluginInteractionResult>;
  changed(): void;
}) {
  const lifecycle = new AbortController();
  const active = new Map<string, { requestId: string; threadId: string; abort: AbortController; done: Promise<void> }>();
  return {
    request(input: { id: string; revision: number; provider: Provider }) {
      lifecycle.signal.throwIfAborted();
      const existing = active.get(input.id);
      if (existing) return { pending: true as const, requestId: existing.requestId, threadId: existing.threadId, duplicate: true };
      const queued = deps.queue.get(input.id);
      if (!queued || queued.state !== "waiting" || queued.revision !== input.revision) throw new TaskError("This queued request changed. Check its current state before requesting paid start.", "queued_start_stale");
      if (!queued.threadId) throw new TaskError("Paid start needs the original request's chat for confirmation.", "paid_start_thread_required");
      const requestId = randomUUID(), abort = new AbortController(), threadId = queued.threadId;
      const entry = { requestId, threadId, abort, done: Promise.resolve() };
      active.set(input.id, entry);
      entry.done = Promise.resolve().then(async () => {
        const quote = await deps.queue.quotePaid(input.id, input.revision, input.provider);
        abort.signal.throwIfAborted();
        const answer = await deps.requestInput({ threadId, rendererId: PAID_START_RENDERER_ID, title: "Start on paid extra usage?",
          payload: { requestId, queueId: input.id, title: queued.title, provider: quote.provider, quotas: quote.quotas, quotedAt: quote.quotedAt, expiresAt: quote.expiresAt }, timeoutMs: 5*60_000,
          presentation: { label: { pending: "Start on paid extra usage?", completed: "Paid-start choice received" }, icon: { glyph: "CircleDollarSign" } },
          describeSubmission(value) { const choice = paidStartChoiceSchema.safeParse(value); return { title: choice.success && choice.data.requestId === requestId ? choice.data.choice === "start" ? "Confirmed this paid start" : "Keep waiting for reset" : "Paid-start choice rejected" }; },
        }, { signal: abort.signal });
        abort.signal.throwIfAborted();
        if (answer.outcome === "cancelled") return;
        const parsed = paidStartChoiceSchema.safeParse(answer.value);
        if (!parsed.success || parsed.data.requestId !== requestId) throw new TaskError("This paid-start choice is invalid. Request a fresh confirmation.", "paid_start_invalid");
        if (parsed.data.choice === "wait") return;
        await deps.queue.confirmPaid(quote, deps.waitMs, abort.signal);
      }).catch(async (error: unknown) => {
        if (abort.signal.aborted) return;
        // Persist feedback for the live receipt. Sending a chat message here
        // would wake an agent merely to report a failed confirmation.
        try { deps.queue.paidFailure(input.id, input.revision, error); } catch { /* A corrupt/missing request stays non-dispatchable. */ }
      }).finally(() => { active.delete(input.id); deps.changed(); });
      deps.changed(); return { pending: true as const, requestId, threadId, duplicate: false };
    },
    cancel(id: string) { active.get(id)?.abort.abort(); },
    async settled() { await Promise.all([...active.values()].map(e=>e.done)); },
    dispose() { lifecycle.abort(); for (const entry of active.values()) entry.abort.abort(); },
  };
}
