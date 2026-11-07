import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { startQuotaSchema, type QueuedStartDto } from "../contract-start-queue.ts";
import { TaskError, type BoatService, type StartTaskInput } from "./service.ts";
import { StartQueueStore, durableStartInput, queueDigest, type QueuedStart } from "./start-queue-store.ts";
import { reviewGeneration } from "./review-policy.ts";
import { agentWithRoom, onlyAgent } from "./relay.ts";
import type { Provider, Task } from "./store.ts";
import type { QuotaReader, Quotas } from "./quota.ts";

export type StartLaunch = { kind: "started"; task: Task; pending: boolean } | { kind: "queued"; request: QueuedStartDto; pending: true };
export interface PaidStartQuote { entry: QueuedStart; provider: Provider; quotas: ReturnType<typeof quotaRows>; quotedAt: string; expiresAt: string; policyDigest: string; policyRevision: number }
export function quotaRows(quotas: Quotas) { return [...quotas.values()].sort((a,b) => a.provider.localeCompare(b.provider)).slice(0,2).map(q => startQuotaSchema.parse(q)); }
const waitingMessage = "Waiting for a usage reset. No sandbox has been created.";
const quotaReset = (quotas: Quotas) => quotaRows(quotas).map(q=>q.resetsAt).filter((at): at is string => !!at && Number.isFinite(Date.parse(at))).sort()[0] ?? null;
export interface StartQueueDeps {
  bb: Pick<BbPluginApi, "sdk" | "onDispose">; service: BoatService; store: StartQueueStore; quotas?: QuotaReader;
  changed(): void; wake(): void;
  projectCurrent?(input: QueuedStart["input"]): boolean;
  policyRevision?(): number;
  /** Test clock; production uses the actual wall clock. */
  now?(): number;
}
export function createStartQueue(deps: StartQueueDeps) {
  const { service, store } = deps;
  const now = deps.now ?? Date.now;
  const lifecycle = new AbortController();
  const active = new Set<string>(); let ticking = false; let nextTickAt = 0; let cursor = 0;
  deps.bb.onDispose(() => lifecycle.abort());
  function must(id: string, revision?: number): QueuedStart {
    const entry = store.get(id);
    if (!entry) throw new TaskError("This queued request no longer exists.", "queued_start_missing");
    if (revision !== undefined && revision !== entry.dto.revision) throw new TaskError("This queued request changed. Check its current state and try again.", "queued_start_stale");
    return entry;
  }
  function localSourceCurrent(entry: QueuedStart) {
    if (deps.projectCurrent && !deps.projectCurrent(entry.input)) throw new TaskError("The original project changed or was removed. Request this work again with its current configuration.", "queued_source_changed");
    if (!entry.input.parentTaskId) return;
    const parent = service.store.get(entry.input.parentTaskId);
    if (!parent || ["done", "cancelled"].includes(parent.status) || reviewGeneration(parent) !== entry.parentGeneration) throw new TaskError("The original task changed or closed. Request this work again from its current state.", "queued_source_changed");
  }
  async function sourceCurrent(entry: QueuedStart, signal = lifecycle.signal) {
    signal.throwIfAborted(); lifecycle.signal.throwIfAborted(); localSourceCurrent(entry);
    if (entry.dto.threadId) {
      const thread = await deps.bb.sdk.threads.get({ threadId: entry.dto.threadId, signal });
      if (thread.archivedAt != null || thread.deletedAt != null) throw new TaskError("The source chat was closed. Its queued work was cancelled.", "queued_source_changed");
    }
    signal.throwIfAborted(); lifecycle.signal.throwIfAborted(); localSourceCurrent(entry);
  }
  async function fresh(signal = lifecycle.signal): Promise<Quotas> {
    if (!deps.quotas) throw new TaskError("Current agent usage is unavailable. Keep waiting or try again later.", "queued_usage_unknown");
    try {
      const reading = await deps.quotas.read(signal, { fresh: true }); signal.throwIfAborted(); lifecycle.signal.throwIfAborted(); return reading;
    } catch (error) {
      signal.throwIfAborted(); lifecycle.signal.throwIfAborted();
      throw new TaskError("Current agent usage could not be confirmed. The request will keep waiting.", "queued_usage_unknown");
    }
  }
  async function allowed(provider: Provider) {
    const settings = await service.settings();
    const only = onlyAgent(settings.agents);
    if ((only && only !== provider) || settings.notConnectedAgents.includes(provider)) throw new TaskError("The selected agent is unavailable. Choose an agent that is connected.", "queued_agent_unavailable");
    return settings;
  }
  async function dispatch(entry: QueuedStart, waitMs: number, paid?: PaidStartQuote, signal = lifecycle.signal): Promise<StartLaunch> {
    if (active.has(entry.dto.id)) return { kind: "queued", request: must(entry.dto.id).dto, pending: true };
    active.add(entry.dto.id);
    try {
      await sourceCurrent(entry, signal);
      let quotas = await fresh(signal);
      const revision = paid?.policyRevision ?? deps.policyRevision?.() ?? 0;
      const settings = await service.settings();
      const policyDigest = paid?.policyDigest ?? queueDigest(settings);
      function assertPolicy(current = settings) {
        if ((deps.policyRevision?.() ?? 0) !== revision || queueDigest(current) !== policyDigest) throw new TaskError("The start policy changed. Review the current settings before starting this request.", paid ? "paid_start_stale" : "queued_policy_changed");
      }
      assertPolicy();
      const threshold = settings.relay.switchAtPercent;
      if (paid && (now() >= Date.parse(paid.expiresAt) || queueDigest(quotaRows(quotas)) !== queueDigest(paid.quotas))) throw new TaskError("Agent usage changed while this confirmation was open. Request paid start again to review the current usage.", "paid_start_stale");
      const claimed = store.transition(entry.dto.id, entry.dto.revision, ["waiting"], "dispatching", "Checking this request before starting.");
      if (!claimed) throw new TaskError("This queued request changed before it could start.", "queued_start_stale");
      entry = claimed; deps.changed();
      try {
        const launched = await service.launchTask({ ...entry.input as StartTaskInput,
          ...(paid ? { provider: paid.provider, flexibleAgent: false } : {}),
          queuedStart: {
            taskId: entry.reservedTaskId,
            async beforeInsert() {
              await sourceCurrent(entry, signal);
              quotas = await fresh(signal);
              if (paid) {
                await allowed(paid.provider);
                if (now() >= Date.parse(paid.expiresAt) || queueDigest(quotaRows(quotas)) !== queueDigest(paid.quotas)) throw new TaskError("Agent usage changed. Review a fresh paid-start confirmation.", "paid_start_stale");
              }
              assertPolicy(await service.settings());
            },
            insert(task, save, preparedSettings) {
              signal.throwIfAborted(); lifecycle.signal.throwIfAborted(); localSourceCurrent(entry);
              assertPolicy(preparedSettings);
              const q = quotas.get(task.provider);
              if (paid ? task.provider !== paid.provider : !q || q.usedPercent >= threshold) throw new TaskError("The requested agent still has no confirmed subscription room.", "agents_at_limit");
              return store.attach(entry, task, () => {
                const saved = save();
                service.store.addEvent(saved.id, "queued-start", JSON.stringify({ requestId: entry.dto.id, digest: entry.digest }));
                if (paid) service.store.addEvent(saved.id, "paid-start-approved", JSON.stringify({ requestId: entry.dto.id, digest: entry.digest, provider: paid.provider, quotas: paid.quotas, quotedAt: paid.quotedAt, confirmedAt: new Date().toISOString() }));
                return saved;
              });
            },
          },
        }, waitMs);
        deps.changed(); return { kind: "started", ...launched };
      } catch (error) {
        // A persisted registry receipt owns any post-insertion failure. Never
        // replay it, even when launchTask rejected before its wait expired.
        const current = must(entry.dto.id);
        if (current.dto.taskId) { deps.changed(); throw error; }
        const code = error instanceof TaskError ? error.code : "";
        const to = lifecycle.signal.aborted || signal.aborted || code === "agents_at_limit" || code === "paid_start_stale" || code === "queued_policy_changed" || code === "queued_usage_unknown" ? "waiting" : code === "queued_source_changed" ? "cancelled" : "failed";
        store.transition(entry.dto.id, entry.dto.revision, ["dispatching"], to, to === "waiting" ? waitingMessage : error instanceof Error ? error.message : "This request could not start.", quotaReset(quotas)); deps.changed();
        if (to === "waiting" && !paid) return { kind: "queued", request: must(entry.dto.id).dto, pending: true };
        throw error;
      }
    } finally { active.delete(entry.dto.id); }
  }
  return {
    async launch(input: StartTaskInput, waitMs: number): Promise<StartLaunch> {
      const parent = input.parentTaskId ? service.mustGet(input.parentTaskId) : null;
      const parentGeneration = parent ? reviewGeneration(parent) : null;
      let plain: ReturnType<typeof durableStartInput>;
      try { plain = durableStartInput(input); } catch { throw new TaskError("The task request is invalid or exceeds the queue's supported bounds.", "invalid_task"); }
      const existing = store.pending(plain, parentGeneration);
      if (existing) { deps.wake(); return { kind: "queued", request: existing.dto, pending: true }; }
      try { return { kind: "started", ...await service.launchTask(input, waitMs) }; }
      catch (error) {
        if (!(error instanceof TaskError) || error.code !== "agents_at_limit") throw error;
        input.signal?.throwIfAborted(); lifecycle.signal.throwIfAborted();
        if (parent && reviewGeneration(service.mustGet(parent.id)) !== parentGeneration) throw new TaskError("The source task changed. Request the work again.", "queued_source_changed");
        let quotas: Quotas = new Map();
        try { quotas = await fresh(input.signal ?? lifecycle.signal); }
        catch { input.signal?.throwIfAborted(); lifecycle.signal.throwIfAborted(); }
        const queued = store.enqueue(plain, parentGeneration, waitingMessage, quotaReset(quotas));
        deps.changed(); deps.wake(); return { kind: "queued", request: queued.dto, pending: true };
      }
    },
    list: (includeFinished = false) => store.list(includeFinished).map(e=>e.dto),
    get: (id: string) => store.get(id)?.dto ?? null,
    cancel(id: string, revision: number) {
      const entry = must(id);
      if (entry.dto.state === "started" || entry.dto.state === "cancelled") return entry.dto;
      must(id, revision);
      const cancelled = store.transition(id, revision, ["waiting", "dispatching", "failed"], "cancelled", "Cancelled. No queued work will start.");
      deps.changed(); return cancelled?.dto ?? entry.dto;
    },
    async quotePaid(id: string, revision: number, provider: Provider): Promise<PaidStartQuote> {
      const entry = must(id, revision);
      if (entry.dto.state !== "waiting") throw new TaskError("Only waiting work can request paid start.", "queued_start_not_waiting");
      if (!entry.dto.threadId) throw new TaskError("A paid start needs the original request's chat for confirmation.", "paid_start_thread_required");
      await sourceCurrent(entry); const policyRevision = deps.policyRevision?.() ?? 0; const settings = await allowed(provider);
      const quotas = await fresh();
      if (!quotas.has(provider)) throw new TaskError("Current usage for this agent is unknown. No paid start was requested.", "queued_usage_unknown");
      must(id, revision); const quotedAt = new Date(now()).toISOString();
      const policyDigest = queueDigest(settings);
      if ((deps.policyRevision?.() ?? 0) !== policyRevision || queueDigest(await service.settings()) !== policyDigest) throw new TaskError("The start policy changed. Request a fresh paid-start confirmation.", "paid_start_stale");
      return { entry, provider, quotas: quotaRows(quotas), quotedAt, expiresAt: new Date(now()+5*60_000).toISOString(), policyDigest, policyRevision };
    },
    async confirmPaid(quote: PaidStartQuote, waitMs: number, signal?: AbortSignal) {
      const entry = must(quote.entry.dto.id, quote.entry.dto.revision);
      if (entry.digest !== quote.entry.digest || entry.dto.state !== "waiting") throw new TaskError("This paid-start request changed. Request it again.", "paid_start_stale");
      await allowed(quote.provider); return dispatch(entry, waitMs, quote, signal);
    },
    async tick() {
      if (ticking || lifecycle.signal.aborted || now() < nextTickAt) return;
      ticking = true; nextTickAt = now()+30_000;
      try {
        const rows = store.list();
        if (rows.length === 0) return;
        const settings = await service.settings();
        let quotas: Quotas = new Map();
        try { quotas = await fresh(); } catch { lifecycle.signal.throwIfAborted(); }
        const batch = [...rows.slice(cursor), ...rows.slice(0,cursor)].slice(0,20);
        cursor = rows.length ? (cursor+batch.length)%rows.length : 0;
        let dispatched = 0;
        for (let entry of batch) {
          if (lifecycle.signal.aborted || dispatched >= 3) break;
          if (active.has(entry.dto.id)) continue;
          try {
            await sourceCurrent(entry);
            if (entry.dto.state === "dispatching") {
              entry = store.transition(entry.dto.id, entry.dto.revision, ["dispatching"], "waiting", "Retrying the queued request after reload.", quotaReset(quotas)) ?? entry;
            }
            const preferred = entry.input.provider ?? (entry.input.role === "review" ? settings.reviewProvider : settings.implementProvider);
            const canSwitch = settings.relay.enabled || (entry.input.role === "review" && !!entry.input.parentTaskId && settings.autoFailover);
            const candidate = canSwitch ? agentWithRoom(preferred, quotas, settings.relay.switchAtPercent, settings.agents) : onlyAgent(settings.agents) ?? preferred;
            if (!candidate || !quotas.has(candidate) || quotas.get(candidate)!.usedPercent >= settings.relay.switchAtPercent || settings.notConnectedAgents.includes(candidate)) continue;
            dispatched++;
            await dispatch(entry, 0);
          } catch (error) {
            const current = store.get(entry.dto.id);
            if (current && ["waiting", "dispatching"].includes(current.dto.state) && error instanceof TaskError && error.code === "queued_source_changed") store.transition(current.dto.id, current.dto.revision, ["waiting", "dispatching"], "cancelled", error.message);
            deps.changed();
          }
        }
      } finally { ticking = false; }
    },
    dispose() { lifecycle.abort(); },
  };
}
export type StartQueue = ReturnType<typeof createStartQueue>;
