import type { ReactNode } from "react";
import type { MacUsageDto, SandboxProviderDto } from "../contract-providers";
import {
  hours,
  money,
  creditMoney,
  resetDate,
  leaseState,
} from "./provider-format";
import { creditNow } from "./mac-usage";
export function FooterMeter({
  label,
  value,
  detail,
  fraction,
  color = "#BDBDBD",
}: {
  label: string;
  value: string;
  detail: ReactNode;
  fraction?: number | null;
  color?: string;
}) {
  return (
    <div className="space-y-[5px]">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-[#A8A8A8]">{label}</span>
        <span className="text-right text-[13px] font-medium leading-4 tabular-nums text-[#EDEDED]">
          {value}
        </span>
      </div>
      {fraction != null && (
        <div className="h-1 overflow-hidden rounded-sm bg-[#2E2E2E]">
          <div
            className="h-full rounded-sm"
            style={{
              width: `${Math.max(0, Math.min(100, fraction * 100))}%`,
              background: color,
            }}
          />
        </div>
      )}
      <p className="text-[11px] leading-[14px] text-[#6E6E6E]">{detail}</p>
    </div>
  );
}
export function FooterUsage({
  plan,
  providers,
  mac,
  boatOn,
  cap,
  day,
}: {
  plan?: {
    hoursRemaining: number | null;
    hoursTotal: number | null;
    resetsAt: string | null;
  } | null;
  providers?: SandboxProviderDto[];
  mac?: MacUsageDto;
  boatOn: number | null;
  cap: number | null;
  day?: { hours: number | null; dollars: number | null };
}) {
  const instabox = providers?.find(
    (p) => p.id === "instabox" && p.enabled,
  )?.linuxUsage;
  return (
    <>
      {plan?.hoursRemaining != null && (
        <FooterMeter
          label="boat.dev"
          value={`${hours(plan.hoursRemaining)} h left`}
          color="#5BD08A"
          fraction={
            plan.hoursTotal ? plan.hoursRemaining / plan.hoursTotal : null
          }
          detail={`${boatOn ?? "–"} on${cap === null ? "" : ` of ${cap}`} · plan hours ${plan.resetsAt ? `reset ${resetDate(plan.resetsAt)}` : "reset date unavailable"}`}
        />
      )}
      {instabox && (
        <FooterMeter
          label="Instabox · Linux"
          value={creditNow(instabox)}
          fraction={
            instabox.credit && instabox.used !== null
              ? instabox.used / instabox.credit
              : null
          }
          color={
            instabox.credit !== null &&
            instabox.used !== null &&
            instabox.used > instabox.credit
              ? "#FC8C45"
              : "#BDBDBD"
          }
          detail={`${instabox.active ?? "–"} on · ${instabox.used === null ? "Usage unavailable" : `${money(instabox.used)}${instabox.credit === null ? " so far" : ` of ${creditMoney(instabox.credit)}`}`} · per second${instabox.resetsAt ? ` · resets ${resetDate(instabox.resetsAt)}` : ""}`}
        />
      )}
      {instabox?.accountCredit && (
        <p className="text-[11px] leading-[14px] text-[#6E6E6E]">
          Instabox account credit includes Mac charges.
        </p>
      )}
      {mac?.held.map((lease) => (
        <FooterMeter
          key={lease.machineId}
          label={`Mac · ${lease.provider === "scaleway" ? "Scaleway" : "Instabox"}`}
          value={leaseState(lease).text}
          detail={`1 held · ${lease.size.toUpperCase()} · ${money(lease.minimumCost, lease.currency)} minimum, then ${money(lease.hourPrice, lease.currency)} / h`}
        />
      ))}
      <div className="border-t border-[#2A2A2A] pt-2.5">
        <FooterMeter
          label="Today"
          value={`${day?.dollars == null ? "Unavailable" : money(day.dollars)}${mac?.today?.EUR ? ` · ${money(mac.today.EUR, "EUR")}` : ""}`}
          detail={`${day?.hours == null ? "Sandbox hours unavailable" : `${hours(day.hours)} sandbox hours`}${mac?.held.some((l) => l.currency === "USD") ? " · Mac lease not included" : ""}`}
        />
      </div>
    </>
  );
}
