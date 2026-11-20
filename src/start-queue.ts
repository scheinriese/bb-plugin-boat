import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { startQuotaSchema, type QueuedStartDto } from "../contract-start-queue.ts";
import { TaskError, type BoatService, type StartTaskInput } from "./service.ts";
import { StartQueueStore, durableStartInput, queueDigest, type QueuedStart } from "./start-queue-store.ts";
import { reviewGeneration } from "./review-policy.ts";
import { agentForWork, automaticRoom, onlyAgent } from "./relay.ts";
import type { Provider, Task } from "./store.ts";
import type { QuotaReader, Quotas } from "./quota.ts";

export type StartLaunch = { kind: "started"; task: Task; pending: boolean } | { kind: "queued"; request: QueuedStartDto; pending: true };
export interface PaidStartQuote { entry: QueuedStart; provider: Provider; quotas: ReturnType<typeof quotaRows>; quotedAt: string; expiresAt: string; policyDigest: string; policyRevision: number; claudePaidContinuation?: boolean }
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
  // Revisions also cover display metadata (for example reset timestamps).
  // Consent belongs to immutable request content and its reserved task ID.
  function sameRequest(entry: QueuedStart, expected: QueuedStart) {
    if (entry.dto.id !== expected.dto.id || entry.digest !== expected.digest || entry.reservedTaskId !== expected.reservedTaskId || entry.parentGeneration !== expected.parentGeneration) throw new TaskError("This paid-start request changed. Request it again.", "paid_start_stale");
    return entry;
  }
  function currentRequest(expected: QueuedStart) { return sameRequest(must(expected.dto.id), expected); }
  function scopedAllowed(entry: QueuedStart, provider: Provider) { return provider === "claude" && entry.input.role !== "review" && !entry.input.parentTaskId; }
  function assertPaid(quote: PaidStartQuote, entry: QueuedStart, quotas?: Quotas) {
    sameRequest(entry, quote.entry);
    if (!Number.isFinite(Date.parse(quote.expiresAt)) || now() >= Date.parse(quote.expiresAt)) throw new TaskError("This paid-start confirmation expired. Request a fresh confirmation for this same queued request.", "paid_start_stale");
    if (quote.claudePaidContinuation && !scopedAllowed(entry, quote.provider)) throw new TaskError("Claude continuation can only be approved for one Claude task, excluding reviews and child work.", "paid_start_invalid");
    // These observations are a display, not a spending cap. Reset estimates,
    // percent changes and another agent's usage do not invalidate permission to
    // attempt this provider. Actual provider refusals remain authoritative.
    if (quote.claudePaidContinuation && quotas && quotas.get("claude")?.paidAttemptAllowed !== true) throw new TaskError("Claude routing, credentials or account restrictions prevent this paid attempt. Reconnect or repair the account before requesting confirmation again.", "queued_agent_unavailable");
    if (quotas && !quotas.has(quote.provider)) throw new TaskError("Current usage for the selected agent is unknown. Request a fresh paid-start confirmation.", "queued_usage_unknown");
  }
  function paidFailure(id: string, error: unknown, expected?: QueuedStart) {
    const entry = store.get(id);
    // Feedback follows the original receipt despite metadata revisions; it can
    // never overwrite cancellation, dispatch, insertion or different content.
    if (!entry || entry.dto.state !== "waiting") return;
    if (expected) { try { sameRequest(entry, expected); } catch { return; } }
    const closed = error instanceof TaskError && error.code === "queued_source_changed";
    const message = `Paid start stopped. ${error instanceof Error ? error.message : "Request a fresh paid-start confirmation."}`;
    if (entry.dto.message === message && !closed) return;
    store.transition(id, entry.dto.revision, ["waiting"], closed ? "cancelled" : "waiting", message, entry.dto.resetsAt);
    deps.changed();
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
      if (paid) assertPaid(paid, entry, quotas);
      // Async reads above may overlap a monitor update of presentation fields.
      // Claim the current row only when its immutable request still matches.
      entry = currentRequest(entry);
      const claimed = store.transition(entry.dto.id, entry.dto.revision, ["waiting"], "dispatching", "Checking this request before starting.");
      if (!claimed) throw new TaskError("This queued request changed before it could start.", "queued_start_stale");
      entry = claimed; deps.changed();
      try {
        const launched = await service.launchTask({ ...entry.input as StartTaskInput,
          ...(paid ? { provider: paid.provider, flexibleAgent: false } : {}),
          queuedStart: {
            taskId: entry.reservedTaskId,
            paidApproved: !!paid,
            claudePaidContinuation: paid?.claudePaidContinuation === true,
            async beforeInsert() {
              quotas = await fresh(signal);
              if (paid) {
                await allowed(paid.provider);
                assertPaid(paid, currentRequest(entry), quotas);
              }
              assertPolicy(await service.settings());
              // The origin read is last: a close during quota/settings reads
              // must still cancel before the synchronous registry transaction.
              await sourceCurrent(entry, signal);
            },
            insert(task, save, preparedSettings) {
              signal.throwIfAborted(); lifecycle.signal.throwIfAborted(); localSourceCurrent(entry);
              assertPolicy(preparedSettings);
              if (paid) assertPaid(paid, currentRequest(entry), quotas);
              const q = quotas.get(task.provider);
              if (paid ? task.provider !== paid.provider : !automaticRoom(task.provider, quotas, settings.relay, settings.agents) || task.runner === "boat" && !settings.relay.paidClaudeHeadless && !!q && q.usedPercent >= threshold) throw new TaskError("The requested agent still has no confirmed subscription room or authorized extra usage.", "agents_at_limit");
              return store.attach(entry, task, () => {
                const saved = save();
                service.store.addEvent(saved.id, "queued-start", JSON.stringify({ requestId: entry.dto.id, digest: entry.digest }));
                if (paid) service.store.addEvent(saved.id, "paid-start-approved", JSON.stringify({ requestId: entry.dto.id, digest: entry.digest, provider: paid.provider, quotas: paid.quotas, quotedAt: paid.quotedAt, confirmedAt: entry.claudeConsent?.confirmedAt ?? new Date().toISOString(), claudePaidContinuation: paid.claudePaidContinuation === true }));
                if (paid?.claudePaidContinuation) service.store.addEvent(saved.id, "claude-continuation-approved", "Owner approved attempting Claude paid usage for this task only; upstream uses included allowance before paid usage. Provider and billing refusals remain authoritative.");
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
        store.transition(entry.dto.id, entry.dto.revision, ["dispatching"], to, to === "waiting" && !paid ? waitingMessage : error instanceof Error ? error.message : "This request could not start.", quotaReset(quotas)); deps.changed();
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
      const revision = deps.policyRevision?.() ?? 0;
      const assertCurrent = () => {
        lifecycle.signal.throwIfAborted();
        if ((deps.policyRevision?.() ?? 0) !== revision) throw new TaskError("The start policy changed. Check the current settings and request this work again.", "start_policy_changed");
      };
      try { return { kind: "started", ...await service.launchTask({ ...input, subscriptionGuard: {
        async check(provider, settings, runner) {
          assertCurrent();
          await service.assertSubscriptionRoom(provider, { settings, signal: lifecycle.signal, runner });
          if (queueDigest(await service.settings()) !== queueDigest(settings)) throw new TaskError("The start policy changed. Request this work again.", "start_policy_changed");
          assertCurrent();
        }, assertCurrent,
      } }, waitMs) }; }
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
    paidFailure(id: string, _revision: number, error: unknown, expected?: QueuedStart) { paidFailure(id, error, expected); },
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
      const current = currentRequest(entry);
      if (current.dto.state !== "waiting") throw new TaskError("This request is no longer waiting.", "paid_start_stale");
      const quotedAt = new Date(now()).toISOString();
      const policyDigest = queueDigest(settings);
      if ((deps.policyRevision?.() ?? 0) !== policyRevision || queueDigest(await service.settings()) !== policyDigest) throw new TaskError("The start policy changed. Request a fresh paid-start confirmation.", "paid_start_stale");
      return { entry: current, provider, quotas: quotaRows(quotas), quotedAt, expiresAt: new Date(now()+5*60_000).toISOString(), policyDigest, policyRevision };
    },
    async confirmPaid(quote: PaidStartQuote, waitMs: number, signal?: AbortSignal): Promise<StartLaunch> {
      let entry = currentRequest(quote.entry);
      if (entry.dto.state === "started" && entry.dto.taskId) {
        const task = service.store.get(entry.dto.taskId);
        if (task && task.provider === quote.provider) return { kind: "started", task, pending: task.status === "starting" };
      }
      if (entry.dto.state !== "waiting" && !(entry.dto.state === "dispatching" && active.has(entry.dto.id))) throw new TaskError("This paid-start request is no longer waiting.", "paid_start_stale");
      assertPaid(quote, entry);
      if (entry.claudeConsent && !quote.claudePaidContinuation) throw new TaskError("This request has Claude continuation permission. Request a fresh Claude continuation confirmation or cancel it; an older start-only receipt cannot replace that scope.", "paid_start_stale");
      const settings = await allowed(quote.provider);
      if (queueDigest(settings) !== quote.policyDigest || (deps.policyRevision?.() ?? 0) !== quote.policyRevision) throw new TaskError("The start policy changed. Request a fresh paid-start confirmation.", "paid_start_stale");
      await sourceCurrent(entry, signal);
      entry = currentRequest(entry);
      if (active.has(entry.dto.id)) return { kind: "queued", request: entry.dto, pending: true };
      if (entry.dto.state !== "waiting") throw new TaskError("This paid-start request is no longer waiting.", "paid_start_stale");
      if (quote.claudePaidContinuation) {
        entry = store.approveClaude(entry, { provider: "claude", digest: entry.digest, reservedTaskId: entry.reservedTaskId, policyDigest: quote.policyDigest, quotas: quote.quotas, quotedAt: quote.quotedAt, expiresAt: quote.expiresAt, confirmedAt: new Date(now()).toISOString() }) ?? currentRequest(entry);
        deps.changed();
      }
      return dispatch(entry, waitMs, quote, signal);
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
            const resetsAt = quotaReset(quotas);
            if (quotas.size > 0 && entry.dto.resetsAt !== resetsAt) {
              entry = store.transition(entry.dto.id, entry.dto.revision, ["waiting"], "waiting", entry.dto.message, resetsAt) ?? entry;
              deps.changed();
            }
            if (entry.claudeConsent) {
              const consent = entry.claudeConsent;
              if (now() >= Date.parse(consent.expiresAt) || queueDigest(settings) !== consent.policyDigest) {
                const message = "Paid start stopped. Claude continuation confirmation expired or the start policy changed. Request a fresh confirmation for this same queued request.";
                if (entry.dto.message !== message) store.transition(entry.dto.id, entry.dto.revision, ["waiting"], "waiting", message, entry.dto.resetsAt);
                deps.changed(); continue;
              }
              dispatched++;
              await dispatch(entry, 0, { entry, provider: "claude", quotas: consent.quotas, quotedAt: consent.quotedAt, expiresAt: consent.expiresAt, policyDigest: consent.policyDigest, policyRevision: deps.policyRevision?.() ?? 0, claudePaidContinuation: true });
              continue;
            }
            const preferred = entry.input.provider ?? (entry.input.role === "review" ? settings.reviewProvider : settings.implementProvider);
            const canSwitch = settings.relay.enabled || (entry.input.role === "review" && !!entry.input.parentTaskId && settings.autoFailover);
            const candidate = canSwitch ? agentForWork(preferred, quotas, settings.relay, settings.agents) : onlyAgent(settings.agents) ?? preferred;
            if (!candidate || !automaticRoom(candidate, quotas, settings.relay, settings.agents) || settings.notConnectedAgents.includes(candidate)) continue;
            dispatched++;
            await dispatch(entry, 0);
          } catch (error) {
            const current = store.get(entry.dto.id);
            if (current && ["waiting", "dispatching"].includes(current.dto.state) && error instanceof TaskError && error.code === "queued_source_changed") store.transition(current.dto.id, current.dto.revision, ["waiting", "dispatching"], "cancelled", error.message);
            else if (current?.claudeConsent && !lifecycle.signal.aborted) paidFailure(entry.dto.id, error, entry);
            deps.changed();
          }
        }
      } finally { ticking = false; }
    },
    dispose() { lifecycle.abort(); },
  };
}
export type StartQueue = ReturnType<typeof createStartQueue>;
