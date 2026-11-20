import {
  ownMacFactsSchema,
  ownMacNoticeSchema,
  macRentalQuoteSchema,
  type OwnMacNotice,
} from "../contract-ownmac.ts";
import type { Task, TaskStore } from "./store.ts";
export function ownMacEvent(
  store: TaskStore,
  id: string,
  kind: string,
  data: unknown,
  text: string,
) {
  store.addOwnMacEvent(
    id,
    kind,
    text,
    kind === "ownmac-skipped" ? ownMacFactsSchema.parse(data) : data,
  );
}
function data(store: TaskStore, id: string, kind: string): unknown {
  return store.ownMacEventData(id, kind);
}

export function ownMacTaskNotice(
  store: TaskStore,
  task: Task,
): OwnMacNotice | null {
  const skipped = ownMacFactsSchema.safeParse(
    data(store, task.id, "ownmac-skipped"),
  );
  const quote = macRentalQuoteSchema.safeParse(
    data(store, task.id, "ownmac-rental-offer"),
  );
  const parsedChoices = ownMacNoticeSchema.pick({offers:true,recommendedQuoteId:true,recommendationReason:true,unavailable:true}).safeParse(data(store,task.id,"ownmac-rental-choices"));
  const choices=parsedChoices.success ? parsedChoices.data : null;
  const answer = data(store, task.id, "ownmac-rental-answer") as {
    answer?: string;
    replacementId?: string;
  } | null;
  const fallback = data(store, task.id, "ownmac-fallback");
  const linked = answer?.replacementId ? store.get(answer.replacementId) : null;
  const allocation = linked ? data(store, linked.id, "ownmac-allocation") as {machineId?:unknown;provider?:unknown;leaseId?:unknown;ledgerLeaseId?:unknown;startedAt?:unknown}|null : null;
  const machineId = linked?.sandboxId ?? (typeof allocation?.machineId === "string" ? allocation.machineId : null);
  // Bind billing facts to this task's physical allocation. A later lease on
  // the same VM must never become the failed task's apparent paid minimum.
  const snapshot = linked && machineId ? store.macLeases.snapshot() : null;
  const history = snapshot?.leases.filter(entry => entry.machineId === machineId && entry.provider === linked?.sandboxProvider) ?? [];
  const attached = snapshot?.tasks.find(entry => entry.taskId === linked?.id)?.leaseId;
  const exactId = attached ?? (typeof allocation?.ledgerLeaseId === "string" ? allocation.ledgerLeaseId : undefined);
  let candidates = exactId ? history.filter(entry => entry.id === exactId) : history;
  if (!exactId && typeof allocation?.leaseId === "string") {
    const raw = allocation.leaseId;
    candidates = candidates.filter(entry => entry.id === `instabox:${raw}` || entry.id.startsWith(`instabox:${machineId}:${raw}:`));
  }
  const allocationStart = typeof allocation?.startedAt === "string" ? Date.parse(allocation.startedAt) : null;
  if (allocationStart !== null) candidates = candidates.filter(entry => Date.parse(entry.startedAt) === allocationStart);
  if ((typeof allocation?.machineId === "string" && allocation.machineId !== machineId) || (typeof allocation?.provider === "string" && allocation.provider !== linked?.sandboxProvider)) candidates = [];
  // Older allocations may lack a physical identity. Only a unique historical
  // row is usable then; ambiguous or missing evidence stays unconfirmed.
  const lease = candidates.length === 1 ? candidates[0] : undefined;
  const linkedTask = linked ? {
    taskId: linked.id, status: linked.status, turns: linked.turns, error: linked.error,
    machineId,
    ...(lease ? {lease:{provider:lease.provider,model:lease.size,minimumCost:lease.minimumCost,hourPrice:lease.hourPrice,currency:lease.currency,paidUntil:lease.paidUntil,releaseAt:lease.releaseAt,endedAt:lease.endedAt}} : {}),
  } : undefined;
  if (task.status === "cancelled" && !answer?.replacementId) return null;
  if (!skipped.success && !quote.success && !choices) return null;
  const state = skipped.success ? skipped.data : null;
  return ownMacNoticeSchema.parse(
    Object.fromEntries(
      Object.entries({
        taskId: task.id,
        title: task.title,
        alias: state?.alias ?? "",
        reason:
          state?.code === "busy"
            ? `busy (${state.running} of ${state.max})`
            : state?.code === "personal" || state?.code === "admin" || state?.code === "target"
              ? "can't be used"
              : state?.code === "power"
                ? "in an unknown power state"
              : state?.code === "memory"
                ? "low on memory"
                : state?.code === "session"
                  ? "not logged in"
                  : state?.code === "unreachable"
                    ? "asleep or unreachable"
                    : (state?.status.toLowerCase() ?? "unavailable"),
        account: state?.account,
        refusal:
          state?.code === "personal"
            ? "personal"
            : state?.code === "admin"
              ? "admin"
              : undefined,
        fallback: fallback ?? undefined,
        offer: quote.success ? quote.data : undefined,
        offers: choices?.offers,
        recommendedQuoteId: choices?.recommendedQuoteId,
        recommendationReason: choices?.recommendationReason,
        unavailable: choices?.unavailable,
        answer: answer?.answer,
        replacementId: answer?.replacementId,
        linkedTask,
      }).filter(([, value]) => value !== undefined),
    ),
  );
}
