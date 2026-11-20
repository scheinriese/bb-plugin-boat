import { useState } from "react";
import { LiveMonthlyMacCard } from "./monthly-mac";
import type { MonthlyMacSuggestion } from "../contract-monthly-macs";
import { formatLeaseDays } from "./mac-usage-logic.ts";
import { ProviderGlyphIcon } from "./providers";
import type { ReactNode } from "react";
import type { LinuxUsageDto, MacUsageDto } from "../contract-providers";
import {
  hours,
  money,
  creditMoney,
  resetDate,
  leaseState,
  leaseTime,
} from "./provider-format";
export const macLeaseEnd = leaseTime;
export function LeaseDayMeter({days, breakEven, showCount=false}: {days:number;breakEven?:number;showCount?:boolean}) {
  const fill = Math.max(0, Math.min(100, days / 30 * 100));
  const marker = breakEven !== undefined && Number.isFinite(breakEven) && breakEven > 0 && breakEven <= 30 ? breakEven / 30 * 100 : null;
  return <div className="w-full max-w-full" aria-label={`${formatLeaseDays(days)} in the last 30 days${marker!==null ? `; break-even approximately ${Number(breakEven!.toFixed(1))} days` : ""}`}>
    {showCount && <div className="mb-1 text-xs text-[#FC8C45]" style={{paddingLeft:`${Math.min(fill,85)}%`}}>{Number(days.toFixed(1))} days</div>}
    <div className="relative h-1.5 rounded-[3px] bg-[#262626]">
      <div className="h-full rounded-[3px] bg-[#6E6E6E]" style={{width:`${fill}%`}}/>
      {marker!==null && <><div className="absolute top-0 h-full rounded-r-[3px] bg-[#FC8C45]" style={{left:`${marker}%`,width:`${Math.max(0,fill-marker)}%`}}/><span className="absolute -top-1 h-3.5 w-0.5 -translate-x-1/2 rounded-[1px] bg-[#EDEDED]" style={{left:`${marker}%`}}/></>}
    </div>
    <div className="relative mt-1.5 h-4 text-xs leading-4">{showCount && <span className="hidden text-[#6E6E6E] sm:inline">0</span>}<span className="absolute right-0 text-[#6E6E6E]">Last 30 days</span>{marker!==null && <span className="absolute -translate-x-1/2 whitespace-nowrap text-[#A8A8A8]" style={{left:`clamp(64px, ${marker}%, calc(100% - 160px))`}}>Break-even ≈ {Math.round(breakEven!)} days</span>}</div>
  </div>;
}
export function CreditWords({ usage }: { usage: LinuxUsageDto }) {
  if (usage.error) return <>Usage unavailable</>;
  if (usage.used === null) return <>Usage unavailable</>;
  return (
    <>
      {money(usage.used)}
      {usage.credit !== null
        ? ` of ${creditMoney(usage.credit)} credit`
        : " so far"}
    </>
  );
}
export function creditNow(usage: LinuxUsageDto): string {
  if (usage.error) return "Check provider setup";
  if (usage.used !== null && usage.credit !== null && usage.used > usage.credit)
    return `${money(usage.used - usage.credit)} over credit`;
  return usage.remaining !== null
    ? `${money(usage.remaining)} credit left`
    : "Usage so far";
}
function Sub({ children }: { children: ReactNode }) {
  return (
    <p className="truncate text-xs leading-4 text-[color:var(--boat-faint)]">
      {children}
    </p>
  );
}
function Row({
  name,
  sub,
  used,
  usedSub,
  meter,
  now,
  nowSub,
  caution = false,
}: {
  name: string;
  sub: ReactNode;
  used: ReactNode;
  usedSub: ReactNode;
  meter?: ReactNode;
  now: ReactNode;
  nowSub: ReactNode;
  caution?: boolean;
}) {
  return (
    <tr className={name.startsWith("Mac") ? "h-[68px]" : "h-[60px]"}>
      <td className="px-3.5">
        <div className="flex min-w-0 items-start gap-2.5">
          <ProviderGlyphIcon
            glyph={
              (name.startsWith("Mac") || name === "Your Mac")
                ? "laptop"
                : name === "boat.dev"
                  ? "boat"
                  : "box"
            }
            className="mt-0.5 size-3.5 shrink-0"
          />
          <div className="min-w-0">
            <p className="truncate text-[#E2E2E2]">{name}</p>
            <Sub>{sub}</Sub>
          </div>
        </div>
      </td>
      <td>
        <p className="truncate">{used}</p>
        <Sub>{usedSub}</Sub>
      </td>
      <td className="provider-usage-meter">{meter}</td>
      <td className={`text-right ${caution ? "text-[#FC8C45]" : ""}`}>
        <p className="truncate">{now}</p>
        <div className="text-xs leading-4 text-[color:var(--boat-faint)]">{nowSub}</div>
      </td>
    </tr>
  );
}
function Bar({
  fraction,
  caution = false,
}: {
  fraction: number;
  caution?: boolean;
}) {
  return (
    <div className="h-1.5 w-[300px] rounded-[3px] bg-[#262626]">
      <div
        className={`h-full rounded-[3px] ${caution ? "bg-[#FC8C45]" : "bg-[#6E6E6E]"}`}
        style={{ width: `${Math.max(0, Math.min(100, fraction * 100))}%` }}
      />
    </div>
  );
}
export function ThisMonthUsage({
  mac,
  plan,
  instabox,
  providersOff = false,
  active,
  cap,
  idleMinutes,
  boatError = false,
}: {
  mac?: MacUsageDto;
  plan?: {
    name: string | null;
    hoursRemaining: number | null;
    hoursTotal: number | null;
    resetsAt?: string | null;
  } | null;
  instabox?: LinuxUsageDto;
  providersOff?: boolean;
  active?: number;
  cap?: number | null;
  idleMinutes?: number;
  boatError?: boolean;
}) {
  const [selected,setSelected] = useState<MonthlyMacSuggestion|null>(null);
  const used =
    plan?.hoursTotal != null && plan.hoursRemaining != null
      ? Math.max(0, plan.hoursTotal - plan.hoursRemaining)
      : null;
  const macRows =
    mac?.byProvider ??
    (mac
      ? (mac.providers?.length
          ? mac.providers
          : [{ id: mac.held[0]?.provider ?? "instabox", label: "Instabox" }]
        ).map((p) => ({ ...p, month: mac.month, rolling30: mac.rolling30 }))
      : []);
  return (
    <section
      className="provider-usage mb-[27px] text-[13px] leading-[18px] tabular-nums"
      aria-label="Usage"
    >
      <style>{`.provider-usage{container-type:inline-size}.provider-usage table{table-layout:fixed;min-width:640px}.provider-usage th:first-child{min-width:180px}.provider-usage-meter{width:316px;padding-right:24px}@container(max-width:900px){.provider-usage-meter{display:none}}`}</style>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="font-medium text-[#EDEDED]">Usage</h3>
        <span className="text-xs text-[color:var(--boat-faint)]">
          Each provider on its own billing period
        </span>
        {idleMinutes !== undefined && (
          <span className="ml-auto text-xs text-[color:var(--boat-faint)]">
            Idle sandboxes{" "}
            {idleMinutes
              ? `stop after ${idleMinutes % 60 === 0 ? `${idleMinutes / 60} h` : `${idleMinutes} min`}`
              : "stay on"}{" "}
            ·{" "}
            <a className="text-[#7AA7FF]" href="/settings/plugins/boat">
              change
            </a>
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="border-b border-[#262626] text-xs text-[color:var(--boat-faint)]">
            <tr>
              <th className="px-3.5 pb-2 font-normal">Runs on</th>
              <th className="w-[220px] font-normal">Used</th>
              <th className="provider-usage-meter">
                <span className="sr-only">Usage meter</span>
              </th>
              <th className="w-[220px] text-right font-normal">Now</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#202020] text-[#D2D2D2]">
            <Row
              name="boat.dev"
              sub={`Linux${plan?.name ? ` · ${plan.name} plan` : ""}`}
              used={
                used === null
                  ? "Usage unavailable"
                  : `${hours(used)} h of ${hours(plan!.hoursTotal!)} h`
              }
              usedSub={
                boatError
                  ? ""
                  : `${active ?? "–"}${cap == null ? "" : ` of ${cap}`} on`
              }
              meter={
                <Bar
                  fraction={
                    used !== null && plan?.hoursTotal
                      ? used / plan.hoursTotal
                      : 0
                  }
                />
              }
              now={
                plan?.hoursRemaining != null
                  ? `${hours(plan.hoursRemaining)} h left`
                  : ""
              }
              nowSub={
                plan?.resetsAt
                  ? `resets ${resetDate(plan.resetsAt)}`
                  : "Billing period unavailable"
              }
            />
            {instabox && (
              <Row
                name="Instabox"
                sub={`Linux${instabox.plan ? ` · ${instabox.plan[0]!.toUpperCase() + instabox.plan.slice(1)} plan` : ""}`}
                used={<CreditWords usage={instabox} />}
                usedSub={
                  instabox.active === 0 && instabox.used === 0
                    ? "No sandboxes yet this period"
                    : [
                        instabox.hours === null
                          ? null
                          : `${hours(instabox.hours)} h${instabox.hoursScope==="running-machines" ? " · running machines only" : ""}`,
                        instabox.active === null
                          ? null
                          : `${instabox.active} sandbox${instabox.active === 1 ? "" : "es"} on`,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                }
                meter={
                  instabox.used !== null &&
                  instabox.credit !== null &&
                  instabox.credit > 0 ? (
                    <Bar
                      fraction={instabox.used / instabox.credit}
                      caution={instabox.used > instabox.credit}
                    />
                  ) : undefined
                }
                now={creditNow(instabox)}
                nowSub={
                  instabox.resetsAt
                    ? `per second · resets ${resetDate(instabox.resetsAt)}`
                    : "per second · period unavailable"
                }
                caution={
                  instabox.used !== null &&
                  instabox.credit !== null &&
                  instabox.used > instabox.credit
                }
              />
            )}
            {mac?.ownMac && <Row name="Your Mac" sub="Mac · $0 rent" used="$0" usedSub="No lease-days" now={`${mac.ownMac.running} of ${mac.ownMac.max} tasks running`} nowSub={mac.ownMac.status} />}
            {macRows
              .filter(
                (p) =>
                  p.month.leaseDays > 0 ||
                  mac?.held.some((l) => (l.provider ?? "instabox") === p.id),
              )
              .map((p) => {
                const held =
                    mac?.held.filter(
                      (l) => (l.provider ?? "instabox") === p.id,
                    ) ?? [],
                  lease = held[0],
                  state = lease ? leaseState(lease) : null;
                const comparison = mac?.monthlyComparisons?.find(item => item.dayProvider===p.id && (Object.keys(p.rolling30.costs).length===0 || (Object.keys(p.rolling30.costs).length===1 && Object.hasOwn(p.rolling30.costs,item.currency))));
                const suggestion = mac?.monthlySuggestions?.find(s => s.dayProvider===p.id && s.kind==="rent" && !s.answer && p.rolling30.leaseDays>s.breakEven);
                return (
                  <Row
                    key={p.id}
                    name={`Mac · ${p.label}`}
                    sub={
                      lease
                        ? `${lease.size.toUpperCase()} · ${money(lease.minimumCost, lease.currency)} minimum`
                        : "Minimum + elapsed time"
                    }
                    used={`${formatLeaseDays(p.month.leaseDays)} · ${Object.entries(
                      p.month.costs,
                    )
                      .map(([c, v]) => money(v, c))
                      .join(" · ")}`}
                    usedSub={
                      p.id === "scaleway"
                        ? "Hourly after 24 h · EUR"
                        : "Bills per second after 24 h"
                    }
                    meter={<LeaseDayMeter days={p.rolling30.leaseDays} breakEven={comparison?.breakEven} />}
                    now={state?.text ?? "No lease now"}
                    nowSub={suggestion ? <button className="inline-block max-w-full whitespace-normal text-right text-[#7AA7FF]" onClick={()=>setSelected(suggestion)}>Monthly {suggestion.candidate.chip}: {money(suggestion.candidate.monthlyPrice,suggestion.currency)} / mo</button> : [
                      state?.detail,
                      held.length > 1 ? `${held.length} leases held` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    caution={state?.caution}
                  />
                );
              })}
          </tbody>
        </table>
      </div>
      {selected && <div><button className="text-xs text-[#7AA7FF]" onClick={()=>setSelected(null)}>Close suggestion</button><LiveMonthlyMacCard key={selected.id} suggestion={selected}/></div>}
      {instabox?.accountCredit && (
        <p className="mt-2 text-xs text-[#8A8A8A]">
          Instabox account credit includes Mac charges. The Mac row shows its
          lease estimate separately.
        </p>
      )}
      {providersOff && (
        <p className="flex min-h-11 items-center gap-2 text-xs text-[#8A8A8A]">
          <span
            aria-hidden
            className="size-3.5 rounded border border-dashed border-[#5E5E5E]"
          />
          Instabox and Scaleway are off. Turn one on for Linux microVMs or Macs.{" "}
          <a className="ml-auto text-[#7AA7FF]" href="/settings/plugins/boat">
            Sandbox providers
          </a>
        </p>
      )}
    </section>
  );
}
