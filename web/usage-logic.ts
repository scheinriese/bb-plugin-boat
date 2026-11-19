// Wording for the usage view (Settings › Usage limits): which agent can run
// now, and why. Pure, so tests can import it (test/usage-view.test.ts). The
// decision itself comes from the server (the relay's own checks); this only
// says it, with times in the user's local time.
import { USAGE_STALE_MS, type UsageAccountDto, type UsageViewDto, type UsageWindowDto } from "../contract-usage.ts";
import { checkedAt } from "./relay-logic.ts";

type Provider = "claude" | "codex";
type AgentRow = UsageViewDto["agents"][number];
export type Tone = "ok" | "warning" | "danger" | "muted";

const NAME: Record<Provider, string> = { claude: "Claude", codex: "Codex" };

/** No reading, or one older than about ten minutes. */
export function isStale(observedAt: number | null, now: number): boolean {
  return observedAt === null || now - observedAt > USAGE_STALE_MS;
}

/** "Thu 01:00" in local time; "Nov 24 01:00" more than six days out. */
export function dayTime(iso: string, now: number): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const date = new Date(at);
  const day = Math.abs(at - now) > 6 * 86_400_000 ? date.toLocaleDateString([], { month: "short", day: "numeric" }) : date.toLocaleDateString([], { weekday: "short" });
  return `${day} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/** "resets Thu 01:00", or "reset was due Thu 01:00" when the reading is older than its reset. */
export function resetLabel(resetsAt: string | null, now: number): string | null {
  const when = resetsAt === null ? null : dayTime(resetsAt, now);
  if (when === null) return null;
  return Date.parse(resetsAt!) <= now ? `reset was due ${when}` : `resets ${when}`;
}

/** A window's bar: at its limit, past the switch point, or fine. */
export function windowTone(window: Pick<UsageWindowDto, "usedPercent" | "atLimit">, switchAtPercent: number): Tone {
  if (window.atLimit) return "danger";
  if (window.usedPercent !== null && window.usedPercent >= switchAtPercent) return "warning";
  return "muted";
}

/** The bar's fill, 0–100. */
export function barPercent(usedPercent: number | null): number {
  return usedPercent === null ? 0 : Math.max(0, Math.min(100, usedPercent));
}

/** "40%", "100%", or "–" when not read yet. */
export function percentText(usedPercent: number | null): string {
  return usedPercent === null ? "–" : `${Math.round(usedPercent)}%`;
}

/** An account's line beside its name: off, held, the Pooler's state, or when it was read. */
export function accountStatus(account: Pick<UsageAccountDto, "enabled" | "state" | "heldUntil" | "observedAt">, now: number): { text: string; tone: Tone } {
  if (!account.enabled) return { text: "Off in the Account Pooler", tone: "muted" };
  if (account.heldUntil !== null && account.heldUntil > now) return { text: `Held until ${checkedAt(account.heldUntil, now)}`, tone: "warning" };
  if (account.state !== null) return { text: `Account Pooler: ${account.state.replace(/[-_]+/g, " ")}`, tone: "warning" };
  if (account.observedAt === null) return { text: "Not read yet", tone: "warning" };
  const checked = `checked ${checkedAt(account.observedAt, now)}`;
  return isStale(account.observedAt, now) ? { text: `Stale · ${checked}`, tone: "warning" } : { text: checked, tone: "muted" };
}

/**
 * The credits row: Claude extra usage on this account, never an amount
 * (the Pooler doesn't pass one on yet), with when it was checked.
 */
export function creditsRow(credits: NonNullable<UsageAccountDto["credits"]>, now: number): { status: string; tone: Tone; checked: string; stale: boolean } {
  const status =
    credits.status === "allowed"
      ? { status: "Available", tone: "ok" as const }
      : credits.status === "rejected"
        ? { status: "Blocked", tone: "danger" as const }
        : credits.status === "disabled"
          ? { status: "Off for this account", tone: "muted" as const }
          : { status: "Unknown", tone: "muted" as const };
  const stale = isStale(credits.observedAt, now);
  const checked = credits.observedAt === null ? "not checked yet" : `${stale ? "stale · " : ""}checked ${checkedAt(credits.observedAt, now)}`;
  return { ...status, checked, stale };
}

/** "Claude is at 40%", "Claude is at its weekly limit", "Claude hit its usage limit". */
export function agentFact(agent: AgentRow | undefined, provider: Provider): string {
  const name = NAME[provider];
  if (agent === undefined || agent.usedPercent === null) return `${name}'s usage is unknown`;
  if (agent.source === "limit-hit") return `${name} hit its usage limit`;
  if (agent.usedPercent >= 100) return `${name} is at its ${(agent.window ?? "usage limit").toLowerCase()}`;
  return `${name} is at ${Math.round(agent.usedPercent)}%`;
}

/** Why automatic paid Claude doesn't start now (the fallback is on, and it isn't available). */
function paidClaudeHeld(view: UsageViewDto, now: number): string {
  // A refused turn holds paid Claude even with a fresh "allowed" reading.
  const hold = view.agents.find((agent) => agent.provider === "claude")?.limitHitUntil ?? null;
  if (hold !== null && hold > now) {
    const until = dayTime(new Date(hold).toISOString(), now);
    return `paid Claude is on hold${until ? ` until ${until}` : ""} (a Claude turn hit its limit)`;
  }
  const extra = view.claudeExtraUsage;
  if (extra.pool === "off") return "paid Claude is unknown (Account Pooler off)";
  if (extra.pool === "not-routing") return "paid Claude is unknown (Account Pooler isn’t routing Claude)";
  if (extra.status === "rejected") return "paid Claude is blocked";
  if (extra.status === "disabled") return "paid Claude is off";
  if (extra.status === "allowed") return "paid Claude needs a newer check";
  return "paid Claude is unknown";
}

/**
 * The one line on what Boat does next: "Codex is at 99% · Claude is at its
 * weekly limit · paid Claude is available, so new work goes to Claude", or
 * "Both are at their limits · work waits until Thu 01:00".
 */
export function nextStepLine(view: UsageViewDto, now = Date.now()): string {
  const line = nextStep(view, now);
  const resumed = view.resumedOnPaid ?? 0;
  return resumed > 0 ? `${line} · ${resumed} stopped ${resumed === 1 ? "chat" : "chats"} resumed on paid Claude` : line;
}

function nextStep(view: UsageViewDto, now: number): string {
  const { next } = view;
  const fact = (provider: Provider) => agentFact(view.agents.find((agent) => agent.provider === provider), provider);
  const both = view.onlyAgent === null && view.agents.length === 2 && view.agents.every((agent) => agent.usedPercent !== null && agent.usedPercent >= view.switchAtPercent);
  const lead = both ? "Both are at their limits" : fact(next.wanted);
  switch (next.kind) {
    case "room":
      return `${fact(next.wanted)} · new work goes to ${NAME[next.wanted]}`;
    case "switch":
      return `${fact(next.wanted)} · ${fact(next.agent!)}, so new work goes to ${NAME[next.agent!]}`;
    case "paid": {
      const facts = view.onlyAgent === null ? [fact("codex"), fact("claude")] : [fact("claude")];
      return `${facts.join(" · ")} · paid Claude is available, so new work goes to Claude${view.paidClaudeHeadless ? "" : " (headless tasks wait)"}`;
    }
    case "wait": {
      const when = next.until === null ? null : dayTime(next.until, now);
      const parts = [lead];
      if (both && view.paidClaudeFallback && view.onlyAgent !== "codex") parts.push(paidClaudeHeld(view, now));
      else if (!both && !next.switching && view.onlyAgent === null) parts.push("switching is off");
      parts.push(when === null ? "work waits for a reset" : `work waits until ${when}`);
      return parts.join(" · ");
    }
    case "over":
      return `${lead} · new work still starts on ${NAME[next.agent!]} (Don’t start work on paid extra usage is off)`;
  }
}
