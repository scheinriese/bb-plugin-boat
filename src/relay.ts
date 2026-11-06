// The orchestrator relay: keep every orchestrator running on an agent with
// room left. Near a usage limit it hands over to the other agent (after
// asking for a handoff note while there's budget for one); once the preferred
// agent has room again, it hands back at a quiet moment. Paid extra usage is
// avoided: with both agents near their limits, it waits and tells the user.
import type { AgentQuota, Quotas } from "./quota.ts";
import type { Provider } from "./store.ts";

export interface RelaySettings {
  enabled: boolean;
  preferred: Provider;
  /** Hand over when the agent's binding window reaches this percent. */
  switchAtPercent: number;
  /** Hand back to the preferred agent once it's below this percent. */
  switchBackBelowPercent: number;
  /** Hand back only after the orchestrator has been quiet this long. */
  quietMinutes: number;
}

export interface OrchestratorView {
  threadId: string;
  provider: Provider | null;
  /** bb thread status: idle, active, starting, pending, stopping, error. */
  status: string;
  /** Epoch ms of the chat's last activity. */
  updatedAt: number | null;
  archived: boolean;
  /** Started for a project, so a successor can be started elsewhere. */
  hasProject: boolean;
}

export type RelayState =
  | {
      phase: "handoff-requested";
      to: Provider;
      reason: string;
      since: number;
      /** The note, once the chat finished the turn that writes it. */
      note?: string | null;
      noteAt?: number | null;
    }
  | { phase: "cooldown"; until: number }
  | { phase: "both-out"; since: number }
  /** A take-over failed; tried again after retryAt (backing off). */
  | { phase: "failed"; to: Provider; reason: string; attempts: number; retryAt: number; error: string };

export type RelayDecision =
  | { kind: "none" }
  | { kind: "request-handoff"; to: Provider; reason: string }
  | { kind: "take-over"; to: Provider; reason: string }
  | { kind: "both-out"; reason: string }
  /** It should move, but can't (no project to restart it with). */
  | { kind: "stuck"; reason: string };

export const COOLDOWN_MS = 30 * 60_000;
/** A note that takes longer than this isn't waited for. */
export const HANDOFF_WAIT_MS = 15 * 60_000;
/** A request the chat hasn't reacted to in this long is treated as answered. */
export const NOTE_START_GRACE_MS = 3 * 60_000;

export const AGENT_NAME: Record<Provider, string> = { claude: "Claude", codex: "Codex" };

/** The agents the plugin uses (the Coding agents setting, or what boat.dev reports): both, or only one. */
export type AgentChoice = "both" | Provider;

/** The one agent the user has, or null when they have both. */
export function onlyAgent(agents: AgentChoice | undefined): Provider | null {
  return agents === "claude" || agents === "codex" ? agents : null;
}

/** The relay as it runs: it needs both agents, so it's off with one. */
export function effectiveRelay(relay: RelaySettings, agents: AgentChoice | undefined): RelaySettings {
  return onlyAgent(agents) === null ? relay : { ...relay, enabled: false };
}

export function otherAgent(provider: Provider): Provider {
  return provider === "claude" ? "codex" : "claude";
}

function describe(quota: AgentQuota): string {
  if (quota.window === "Usage limit (hit)") {
    const until = quota.resetsAt ? ` (until about ${new Date(quota.resetsAt).toUTCString().slice(0, 22)} UTC)` : "";
    return `${AGENT_NAME[quota.provider]} hit its usage limit${until}`;
  }
  const resets = quota.resetsAt ? ` (resets ${new Date(quota.resetsAt).toUTCString().slice(0, 22)} UTC)` : "";
  return `${AGENT_NAME[quota.provider]} is at ${Math.round(quota.usedPercent)}% of its ${quota.window.toLowerCase()}${resets}`;
}

const BUSY = new Set(["active", "starting", "pending", "stopping"]);

/** The chat is between turns (a failed turn counts: nothing runs). */
export function isBusy(status: string): boolean {
  return BUSY.has(status);
}

/**
 * Unknown usage counts as room (as for new workers): an agent known to be
 * out reads as full, because a limit hit marks it so until it lifts.
 */
function hasRoom(quota: AgentQuota | undefined, settings: RelaySettings): boolean {
  return quota === undefined || quota.usedPercent < settings.switchAtPercent;
}

export function decideRelay(
  orchestrator: OrchestratorView,
  quotas: Quotas,
  state: RelayState | null,
  settings: RelaySettings,
  now: number,
): RelayDecision {
  if (orchestrator.archived) return { kind: "none" };
  const busy = isBusy(orchestrator.status);

  // A note was asked for (by the relay or by hand): finish the hand-over even
  // with the relay switched off since. Once that turn is over (or it takes
  // too long), take over, unless the target filled up in the meantime.
  if (state?.phase === "handoff-requested") {
    if (!hasRoom(quotas.get(state.to), settings)) return decideRelay(orchestrator, quotas, null, settings, now);
    const answered =
      (state.noteAt ?? 0) > state.since ||
      (orchestrator.updatedAt !== null && orchestrator.updatedAt > state.since) ||
      now - state.since > NOTE_START_GRACE_MS;
    if ((!busy && answered) || now - state.since > HANDOFF_WAIT_MS) {
      return orchestrator.hasProject ? { kind: "take-over", to: state.to, reason: state.reason } : { kind: "stuck", reason: "it has no project" };
    }
    return { kind: "none" };
  }

  if (!settings.enabled || orchestrator.provider === null) return { kind: "none" };
  if (state?.phase === "cooldown" && now < state.until) return { kind: "none" };
  if (state?.phase === "failed" && now < state.retryAt) return { kind: "none" };
  const decision = decideMove(orchestrator, quotas, state, settings, now, busy);
  if ((decision.kind === "request-handoff" || decision.kind === "take-over") && !orchestrator.hasProject) {
    return { kind: "stuck", reason: "it has no project to restart it with" };
  }
  return decision;
}

function decideMove(
  orchestrator: OrchestratorView,
  quotas: Quotas,
  state: RelayState | null,
  settings: RelaySettings,
  now: number,
  busy: boolean,
): RelayDecision {
  const current = orchestrator.provider!;
  const other = otherAgent(current);
  const ownQuota = quotas.get(current);
  const otherQuota = quotas.get(other);

  // Away from an agent at (or near) its limit.
  if (!hasRoom(ownQuota, settings)) {
    if (hasRoom(otherQuota, settings)) {
      if (busy) return { kind: "none" };
      const reason = describe(ownQuota!);
      // No budget left for a note: take over from what the plugin and bb already know.
      return ownQuota!.usedPercent >= 100 ? { kind: "take-over", to: other, reason } : { kind: "request-handoff", to: other, reason };
    }
    // Both near their limits: wait for a reset rather than pay for extra usage.
    if (state?.phase === "both-out") return { kind: "none" };
    return { kind: "both-out", reason: `${describe(ownQuota!)}; ${describe(otherQuota!)}` };
  }

  // Back to the preferred agent once it has room again, at a quiet moment.
  if (current !== settings.preferred) {
    const preferred = quotas.get(settings.preferred);
    const quiet = orchestrator.updatedAt !== null && now - orchestrator.updatedAt >= settings.quietMinutes * 60_000;
    if (preferred !== undefined && preferred.usedPercent < settings.switchBackBelowPercent && !busy && orchestrator.status !== "error" && quiet) {
      return {
        kind: "request-handoff",
        to: settings.preferred,
        reason: `${AGENT_NAME[settings.preferred]} has room again (${Math.round(preferred.usedPercent)}% of its ${preferred.window.toLowerCase()} used)`,
      };
    }
  }
  return { kind: "none" };
}

/** How long to wait before trying a failed take-over again. */
export function retryDelay(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000;
}

/** The message that asks the outgoing orchestrator for its handoff note. */
export function handoffRequest(to: Provider, reason: string): string {
  return `[boat relay] ${reason}. A ${AGENT_NAME[to]} orchestrator takes over from this chat after this turn, with your open tasks and decisions.

Write a short handoff as your final message now: decisions in force, open questions waiting on the user, what's running, and what's next. Don't dispatch, follow up or close anything else.`;
}

/**
 * Pick the agent for a new worker: the wanted one if it has room, else the
 * other if that has room; null when both are near their limits. With one
 * agent (`agents`), only that one, or null when it's near its limit.
 */
export function agentWithRoom(wanted: Provider, quotas: Quotas, switchAtPercent: number, agents: AgentChoice = "both"): Provider | null {
  const room = (provider: Provider) => {
    const quota = quotas.get(provider);
    return quota === undefined || quota.usedPercent < switchAtPercent;
  };
  const only = onlyAgent(agents);
  if (only !== null) return room(only) ? only : null;
  if (room(wanted)) return wanted;
  if (room(otherAgent(wanted))) return otherAgent(wanted);
  return null;
}

/** What the relay is doing for an orchestrator, in a few words (null: nothing). */
export function relayNote(state: RelayState | null, decision: RelayDecision, now = Date.now()): string | null {
  if (state?.phase === "handoff-requested") return `writing a handoff note for ${AGENT_NAME[state.to]}`;
  if (state?.phase === "both-out") return "waiting: both agents near their limits";
  if (state?.phase === "failed" && state.retryAt > now) return `couldn't move to ${AGENT_NAME[state.to]}; trying again soon`;
  if (decision.kind === "stuck") return `can't move: ${decision.reason}`;
  if (state?.phase === "cooldown" && state.until > now) return "just switched";
  if (decision.kind === "request-handoff" || decision.kind === "take-over") return `moves to ${AGENT_NAME[decision.to]} at the next check`;
  return null;
}
