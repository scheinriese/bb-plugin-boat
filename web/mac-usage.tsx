import { formatLeaseDays } from "./mac-usage-logic";
import type { MacUsageDto } from "../contract-providers";

/** Shared with the future monthly suggestion. A marker is optional, never supplied here. */
export function LeaseDayMeter({ days, breakEven }: { days: number; breakEven?: number }) {
  return <div className="w-[300px] max-w-full" aria-label={`${formatLeaseDays(days)} in the last 30 days`}>
    <div className="relative h-1.5 rounded-[3px] bg-[#262626]">
      <div className="h-full rounded-[3px] bg-[#6E6E6E]" style={{ width: `${Math.min(100, days/30*100)}%` }} />
      {breakEven !== undefined && <span className="absolute -top-1 h-3.5 w-0.5 rounded-sm bg-[#EDEDED]" style={{ left: `${Math.min(100,breakEven/30*100)}%` }} />}
    </div>
    <p className="mt-1.5 text-right text-xs leading-4 text-[color:var(--boat-faint)]">Last 30 days</p>
  </div>;
}
export const macLeaseEnd = (until: string) => new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(until)).replace(",", "");
const money = (amount: number, currency: string) => new Intl.NumberFormat(undefined,{ style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
function UsageIcon({ mac = false }: { mac?: boolean }) {
  return <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.1">{mac ? <path d="M3 3h10v7H3zM1 13h14" /> : <path d="M8 1v9H2l6-9Zm2 4 4 5h-4V5ZM2 12h12l-2 2H4l-2-2Z" />}</svg>;
}
export function ThisMonthUsage({ mac, plan, active, cap, idleMinutes, boatError = false }: {
  mac?: MacUsageDto; plan?: { name: string | null; hoursRemaining: number | null; hoursTotal: number | null } | null;
  active?: number; cap?: number | null; idleMinutes?: number; boatError?: boolean;
}) {
  const held = mac?.held[0];
  const used = plan?.hoursTotal != null && plan.hoursRemaining != null ? Math.max(0,plan.hoursTotal-plan.hoursRemaining) : null;
  const now = new Date();
  const month = now.toLocaleDateString(undefined,{ month:"short", timeZone:"UTC" });
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,0)).getUTCDate();
  return <section className="mb-[27px] text-[13px] leading-5" aria-label="This month">
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <h3 className="font-medium text-foreground dark:text-[#EDEDED]">This month</h3>
      <span className="text-xs text-[color:var(--boat-faint)]">{month} 1 – {lastDay} · resets {new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)).toLocaleDateString(undefined,{month:"short",day:"numeric",timeZone:"UTC"})}</span>
      {idleMinutes !== undefined && <span className="ml-auto text-xs text-[color:var(--boat-faint)]">Idle sandboxes {idleMinutes ? `stop after ${idleMinutes % 60 === 0 ? `${idleMinutes/60} h` : `${idleMinutes} min`}` : "stay on"} · <a href="/settings/plugins/boat" className="text-[#7AA7FF] hover:underline">change</a></span>}
    </div>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[740px] text-left">
        <thead className="border-b border-border text-xs text-[color:var(--boat-faint)]"><tr><th className="px-3.5 pb-2 font-normal">Runs on</th><th className="w-[220px] font-normal">Used</th><th className="w-[316px]"><span className="sr-only">Usage meter</span></th><th className="w-[170px] text-right font-normal">Now</th></tr></thead>
        <tbody className="divide-y divide-border/60 text-muted-foreground dark:text-[#D2D2D2]">
          <tr className="h-[60px]"><td className="px-3.5"><div className="flex items-start gap-2.5"><span className="mt-0.5"><UsageIcon /></span><div><p>boat.dev</p><p className="text-xs text-[color:var(--boat-faint)]">Linux{plan?.name ? ` · ${plan.name} plan` : ""}</p></div></div></td><td><p>{used === null ? "Usage unavailable" : `${used.toLocaleString(undefined,{maximumFractionDigits:1})} h of ${plan?.hoursTotal?.toLocaleString()} h`}</p>{!boatError && <p className="text-xs text-[color:var(--boat-faint)]">{active ?? "–"}{cap == null ? "" : ` of ${cap}`} sandboxes on</p>}</td><td><div className="h-1.5 w-[300px] rounded-[3px] bg-[#262626]"><div className="h-full rounded-[3px] bg-[#6E6E6E]" style={{width:`${used !== null && plan?.hoursTotal ? Math.min(100,used/plan.hoursTotal*100):0}%`}} /></div></td><td className="text-right">{plan?.hoursRemaining != null ? `${plan.hoursRemaining.toLocaleString()} h left` : ""}</td></tr>
          {mac && mac.month.leaseDays > 0 && <tr className="h-[68px]"><td className="px-3.5"><div className="flex items-start gap-2.5"><span className="mt-0.5"><UsageIcon mac /></span><div><p>Mac{mac.providers?.length ? ` · ${mac.providers.map(provider=>provider.label).join(", ")}` : ""}</p><p className="text-xs text-[color:var(--boat-faint)]">{held ? `${held.size.toUpperCase()} · ${money(held.minimumCost,held.currency)} minimum` : "Minimum + elapsed time"}</p></div></div></td><td><p>{formatLeaseDays(mac.month.leaseDays)} this month</p><p className="text-xs tabular-nums text-[color:var(--boat-faint)]" title="Paid minimum plus elapsed usage at the provider rate; storage and taxes excluded">{Object.entries(mac.month.costs).map(([currency,cost]) => money(cost,currency)).join(" · ")}</p></td><td><LeaseDayMeter days={mac.rolling30.leaseDays} /></td><td className="text-right">{held ? held.kept ? "Kept · hand-back off" : held.releaseAt ? `Release scheduled ${macLeaseEnd(held.releaseAt)}` : Date.now() >= Date.parse(held.paidUntil) ? (held.billingIncrementSeconds === 3600 ? "Bills hourly" : "Bills per second") : `Paid until ${macLeaseEnd(held.paidUntil)}` : "No lease now"}{held && <p className="text-xs text-[color:var(--boat-faint)]">{money(held.hourPrice,held.currency)}/h after minimum</p>}{mac.held.some(lease => lease.kept) && !held?.kept && <p className="text-xs text-[color:var(--boat-faint)]">Kept lease · hand-back off</p>}{mac.held.length > 1 && <p className="text-xs text-[color:var(--boat-faint)]">{mac.held.length} leases held</p>}</td></tr>}
        </tbody>
      </table>
    </div>
  </section>;
}
