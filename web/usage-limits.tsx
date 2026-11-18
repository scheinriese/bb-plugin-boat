// Settings › Usage limits: which agent can run now, and why. Each pooled
// account's limits and Claude extra usage as the Account Pooler last read
// them, and the one line on what Boat does next (decided on the server by
// the relay's own checks). Accounts are managed in the Pooler's settings.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_useRpcMutation, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { rpcContract, rpcErrorInfo, type UsageAccountDto, type UsageViewDto } from "../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { POOLER_SETTINGS_HREF, PROVIDER_SHORT, USAGE_SETTINGS_HREF } from "./format";
import { useNow } from "./hooks";
import { checkedAt } from "./relay-logic";
import { AgentLogo, InlineAlert } from "./ui";
import { accountStatus, barPercent, creditsRow, isStale, nextStepLine, percentText, resetLabel, windowTone, type Tone } from "./usage-logic";

type Provider = "claude" | "codex";

const TONE_TEXT: Record<Tone, string> = { ok: "text-[#5BD08A]", warning: "text-[#F0B135]", danger: "text-[#E06C6C]", muted: "text-muted-foreground" };
const TONE_BAR: Record<Tone, string> = { ok: "bg-[#5BD08A]", warning: "bg-[#F0B135]", danger: "bg-[#E06C6C]", muted: "bg-foreground/50" };
const NEXT_DOT: Record<UsageViewDto["next"]["kind"], string> = { room: "bg-[#5BD08A]", switch: "bg-[#5BD08A]", paid: "bg-[#FC8C45]", wait: "bg-[#F0B135]", over: "bg-[#FC8C45]" };
const ROW = "px-3.5 py-3";
/** Label, bar, percent (or a credits amount later), reset or check time. */
const GRID = "grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)_2.75rem_minmax(0,8.5rem)] items-center gap-x-3 text-xs leading-4";

/** A compact usage signal (homepage, thread chip) that opens Settings › Usage limits. */
export function UsageLink({ className, title, children }: { className?: string; title?: string; children: ReactNode }) {
  return (
    <a href={USAGE_SETTINGS_HREF} title={title ?? "Which agent can run now, and why"} className={cn("hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", className)}>
      {children}
    </a>
  );
}

export function UsageLimitsSection() {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "usage", input: null });
  const refresh = experimental_useRpcMutation({ contract: rpcContract, method: "refreshUsage" });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const now = useNow(60_000);
  const ref = useRef<HTMLElement>(null);
  // Links from the homepage, a thread or a waiting start land here.
  useEffect(() => {
    if (window.location.hash === "#usage") ref.current?.scrollIntoView({ block: "start" });
  }, []);
  async function runRefresh() {
    setBusy(true);
    setErrors([]);
    try {
      const result = await refresh.mutate(null);
      setErrors(result.errors.map((error) => (error.name ? `Couldn't refresh ${error.name}: ${error.message}` : error.message)));
      await query.refetch();
    } catch (error) {
      setErrors([rpcErrorInfo(error).message]);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section id="usage" ref={ref} aria-label="Usage limits" className="scroll-mt-4 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-medium leading-[18px] text-[color:var(--boat-group-heading)]">Usage limits</h3>
        <Button variant="outline" size="sm" className="h-7 shrink-0" disabled={busy || query.data === undefined} onClick={() => void runRefresh()}>
          <Icon name={busy ? "Loading" : "ArrowReloadHorizontal"} className={cn(busy && "animate-spin")} />
          {busy ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {errors.length > 0 ? (
        <div role="alert" className="space-y-0.5 text-xs leading-[17px] text-[#E06C6C]">
          {errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      ) : null}
      {query.data === undefined ? (
        query.error ? (
          <InlineAlert>{query.error.message}</InlineAlert>
        ) : (
          <p className="rounded-[10px] border border-[var(--boat-setting-border)] bg-card px-3.5 py-3 text-xs text-muted-foreground">Reading usage…</p>
        )
      ) : (
        <UsageCard view={query.data} now={now} />
      )}
    </section>
  );
}

/** The card for one reading; also what the screenshots render. */
export function UsageCard({ view, now }: { view: UsageViewDto; now: number }) {
  const providers: Provider[] = view.onlyAgent !== null ? [view.onlyAgent] : ["claude", "codex"];
  return (
    <div className="divide-y divide-[color:var(--boat-divider)] overflow-hidden rounded-[10px] border border-[var(--boat-setting-border)] bg-card">
      <div role="status" className={cn(ROW, "flex items-start gap-2.5")}>
        <span aria-hidden className={cn("mt-[6px] size-1.5 shrink-0 rounded-full", NEXT_DOT[view.next.kind])} />
        <p className="text-[13px] leading-[18px] text-[var(--boat-label)]">{nextStepLine(view, now)}</p>
      </div>
      {view.pool === "off" ? (
        <PoolOff view={view} providers={providers} now={now} />
      ) : (
        providers.map((provider) =>
          view.routing[provider] ? (
            <PooledAccounts key={provider} view={view} provider={provider} now={now} />
          ) : (
            <NotRouting key={provider} view={view} provider={provider} now={now} />
          ),
        )
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3.5 py-2.5 text-xs leading-4">
        <span className="text-[color:var(--boat-faint)]">
          {view.pool === "on" ? `From the Account Pooler · read ${checkedAt(view.checkedAt, now)}` : `From bb's Provider usage · read ${checkedAt(view.checkedAt, now)}`}
        </span>
        <a href={POOLER_SETTINGS_HREF} className="text-[#7AA7FF] hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          {view.pool === "on" ? "Manage accounts in the Account Pooler →" : "Open the Account Pooler →"}
        </a>
      </div>
    </div>
  );
}

function PooledAccounts({ view, provider, now }: { view: UsageViewDto; provider: Provider; now: number }) {
  const accounts = view.accounts.filter((account) => account.provider === provider);
  if (accounts.length === 0) {
    return (
      <div className={cn(ROW, "flex items-center gap-2")}>
        <AgentLogo provider={provider} className="size-3.5" />
        <span className="text-xs text-muted-foreground">No {PROVIDER_SHORT[provider]} accounts in the Account Pooler</span>
      </div>
    );
  }
  return (
    <>
      {accounts.map((account) => (
        <AccountRow key={account.id} account={account} switchAtPercent={view.switchAtPercent} now={now} />
      ))}
    </>
  );
}

function AccountRow({ account, switchAtPercent, now }: { account: UsageAccountDto; switchAtPercent: number; now: number }) {
  const status = accountStatus(account, now);
  const stale = isStale(account.observedAt, now);
  return (
    <div className={cn(ROW, "space-y-2")}>
      <div className="flex items-center gap-2">
        <AgentLogo provider={account.provider} className="size-3.5" />
        <span title={account.name} className={cn("min-w-0 flex-1 truncate text-[13px] leading-[18px] text-[var(--boat-label)]", !account.enabled && "text-muted-foreground")}>
          {account.name}
        </span>
        <span className={cn("shrink-0 text-xs leading-4", TONE_TEXT[status.tone])}>{status.text}</span>
      </div>
      {account.error ? <p className="pl-[22px] text-xs leading-4 text-[#E06C6C]">The Account Pooler reports: {account.error}</p> : null}
      {account.enabled ? (
        <div className="space-y-1.5 pl-[22px]">
          {account.windows.length === 0 ? <p className="text-xs leading-4 text-muted-foreground">No limits read yet</p> : null}
          {account.windows.map((window) => (
            <LimitBar
              key={`${window.label}-${window.model ?? ""}`}
              label={window.label}
              title={window.model ? `Only for ${window.label.replace(/ weekly limit$/, "")}; other models keep running` : undefined}
              usedPercent={window.usedPercent}
              tone={windowTone(window, switchAtPercent)}
              detail={resetLabel(window.resetsAt, now)}
              faded={stale || isStale(window.observedAt, now)}
              name={account.name}
            />
          ))}
          {account.credits ? <CreditsRow credits={account.credits} now={now} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function LimitBar({ label, title, usedPercent, tone, detail, faded, name }: { label: string; title?: string; usedPercent: number | null; tone: Tone; detail: string | null; faded: boolean; name: string }) {
  return (
    <div className={GRID}>
      <span title={title ?? label} className="truncate text-muted-foreground">
        {label}
      </span>
      <div
        role="progressbar"
        aria-label={`${name}: ${label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(barPercent(usedPercent))}
        className={cn("h-1.5 overflow-hidden rounded-full bg-secondary", faded && "opacity-50")}
      >
        <div className={cn("h-full rounded-full", TONE_BAR[tone])} style={{ width: `${barPercent(usedPercent)}%` }} />
      </div>
      <span className={cn("text-right tabular-nums", faded ? "text-muted-foreground" : TONE_TEXT[tone])}>{percentText(usedPercent)}</span>
      <span className="truncate text-[color:var(--boat-faint)]">{detail ?? ""}</span>
    </div>
  );
}

/**
 * Claude extra usage on this account: its status and when the Pooler
 * checked. The third column is kept for an amount ("$40 / $100") once the
 * Pooler passes one on (bb#7740); Boat never estimates one.
 */
function CreditsRow({ credits, now }: { credits: NonNullable<UsageAccountDto["credits"]>; now: number }) {
  const row = creditsRow(credits, now);
  return (
    <div className={GRID}>
      <span className="truncate text-muted-foreground">Extra usage</span>
      <span className={cn("truncate", row.stale && credits.observedAt !== null ? "text-muted-foreground" : TONE_TEXT[row.tone])}>{row.status}</span>
      <span aria-hidden className="text-right tabular-nums" />
      <span className={cn("truncate", row.stale ? "text-[#F0B135]" : "text-[color:var(--boat-faint)]")}>{row.checked}</span>
    </div>
  );
}

/** The agent-wide reading Boat goes by when the Pooler doesn't route this agent. */
function LoginReading({ view, provider, now }: { view: UsageViewDto; provider: Provider; now: number }) {
  const agent = view.agents.find((entry) => entry.provider === provider);
  if (agent === undefined || agent.usedPercent === null) return <p className="text-xs leading-4 text-muted-foreground">No usage reading for {PROVIDER_SHORT[provider]}</p>;
  return (
    <LimitBar
      label={agent.window ?? "Usage limit"}
      usedPercent={agent.usedPercent}
      tone={windowTone({ usedPercent: agent.usedPercent, atLimit: agent.usedPercent >= 100 }, view.switchAtPercent)}
      detail={resetLabel(agent.resetsAt, now)}
      faded={false}
      name={PROVIDER_SHORT[provider]}
    />
  );
}

function NotRouting({ view, provider, now }: { view: UsageViewDto; provider: Provider; now: number }) {
  const name = PROVIDER_SHORT[provider];
  return (
    <div className={cn(ROW, "space-y-2")}>
      <div className="flex items-center gap-2">
        <AgentLogo provider={provider} className="size-3.5" />
        <span className="min-w-0 flex-1 text-[13px] leading-[18px] text-[var(--boat-label)]">Not routing {name}</span>
        <span className="shrink-0 text-xs leading-4 text-[#F0B135]">This computer's login</span>
      </div>
      <div className="space-y-1.5 pl-[22px]">
        <p className="text-xs leading-[17px] text-muted-foreground">
          The Account Pooler doesn't route {name}, so chats use this computer's {name} login.
          {provider === "claude" ? " Claude extra usage is unknown, so paid Claude won't start." : ""}
        </p>
        <LoginReading view={view} provider={provider} now={now} />
      </div>
    </div>
  );
}

function PoolOff({ view, providers, now }: { view: UsageViewDto; providers: Provider[]; now: number }) {
  return (
    <div className={cn(ROW, "space-y-2")}>
      <div className="flex items-center gap-2">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[#F0B135]" />
        <span className="min-w-0 flex-1 text-[13px] leading-[18px] text-[var(--boat-label)]">Account Pooler off</span>
      </div>
      <div className="space-y-1.5 pl-[14px]">
        <p className="text-xs leading-[17px] text-muted-foreground">
          Boat can't see your pooled accounts or Claude extra usage, so paid Claude won't start. Chats use this computer's own logins.
        </p>
        {providers.map((provider) => (
          <div key={provider} className="flex items-center gap-2">
            <AgentLogo provider={provider} className="size-3.5" />
            <div className="min-w-0 flex-1">
              <LoginReading view={view} provider={provider} now={now} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
