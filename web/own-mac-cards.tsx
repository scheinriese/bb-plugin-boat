import { useEffect, useId, useState } from "react";
import type { OwnMacFacts, OwnMacNotice } from "../contract-ownmac";
import { OWN_MAC_GUIDE } from "../contract-ownmac";
import { money, leaseTime } from "./provider-format";
import { compareRentalOffers } from "./mac-rental-logic";
import { cn } from "@/lib/utils";
const primary =
  "rounded-md bg-[#E6E6E6] px-3 py-[5px] text-xs leading-4 font-medium text-[#141414] disabled:opacity-50 max-sm:w-full max-sm:rounded-lg max-sm:py-2 max-sm:text-sm";
const secondary =
  "rounded-md border border-[#333333] px-3 py-[5px] text-xs leading-4 text-[#D0D0D0] disabled:opacity-50 max-sm:flex-1 max-sm:rounded-lg max-sm:py-2 max-sm:text-sm";
const link = "text-xs leading-4 text-[#7AA7FF] hover:underline";
const details = "rounded-lg border border-[#262626] bg-[#151515] px-3 py-2.5";
function InfoIcon({ alert = false }: { alert?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      className="size-3.5 shrink-0"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6" />
      {alert ? <path d="M8 4.5v4M8 10.5v1" /> : <path d="M8 4.5v1M8 7v4.5" />}
    </svg>
  );
}
export function OwnMacFallbackLine({ notice }: { notice: OwnMacNotice }) {
  if (!notice.fallback) return null;
  return (
    <p className="flex items-start gap-2.5 text-[13px] leading-5 text-[#A8A8A8]">
      <span aria-hidden className="mt-[3px] text-sm text-[#8A8A8A]">
        <InfoIcon />
      </span>
      <span>
        Your Mac{" "}
        {notice.reason === "can't be used"
          ? "can't be used"
          : `is ${notice.reason}`}
        , so “{notice.title}” runs on{" "}
        {notice.fallback.monthly
          ? "your monthly Mac"
          : `the ${notice.fallback.label} Mac you already rented`}
        .{" "}
        <span className="text-[#6E6E6E]">
          {notice.fallback.monthly
            ? "No extra cost."
            : notice.fallback.paidUntil &&
                Date.parse(notice.fallback.paidUntil) > Date.now()
              ? `Paid until ${leaseTime(notice.fallback.paidUntil)}, no new cost.`
              : "No new rental; existing billing continues."}
        </span>
      </span>
    </p>
  );
}
export function OwnMacRefusalCard({
  notice,
  onTest,
  onSettings,
  onRent,
  busy,
}: {
  notice: OwnMacNotice;
  onTest?: () => void;
  onSettings?: () => void;
  onRent?: () => void;
  busy?: boolean;
}) {
  const personal = notice.refusal === "personal",
    who = notice.account ?? "the account",
    waiting = !notice.fallback;
  const reason = personal
    ? `${notice.alias} is your own login`
    : `${who} is an admin on your physical Mac`;
  const fix = personal
    ? "A macOS VM or a separate standard user"
    : `Make ${who} a standard user, or use a VM`;
  return (
    <section className="max-w-[720px] overflow-hidden rounded-[10px] border border-[#3D3420] bg-[#181818] max-sm:rounded-xl max-sm:p-3">
      <div className="flex gap-3 px-3.5 py-3 max-sm:block max-sm:p-0">
        <span
          aria-hidden
          className="mt-[3px] text-sm text-[#F0B135] max-sm:hidden"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="size-3.5"
          >
            <rect x="5" y="10" width="14" height="11" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          {waiting && (
            <div className="mb-2 hidden items-center gap-2 text-[13px] leading-[18px] max-sm:flex">
              <span className="size-1.5 rounded-full bg-[#F0B135]" />
              <span className="font-medium text-[#F0B135]">Needs you</span>
              <span className="text-[#6E6E6E]">Your Mac</span>
            </div>
          )}
          <h3 className="text-[13px] font-medium leading-5 text-[#EDEDED] max-sm:hidden">
            Your Mac can't take agents: {reason}
          </h3>
          <h3 className="hidden text-base font-medium leading-[22px] text-[#EDEDED] max-sm:block">
            Your Mac can't take agents yet
          </h3>
          <p className="mt-1 text-xs leading-4 text-[#8A8A8A] max-sm:text-sm max-sm:leading-5">
            {waiting
              ? `“${notice.title}” is waiting. Nothing was rented. ${personal ? `Agents never run in your own login, so point ${notice.alias} at a VM or a separate standard user, then test again.` : `${who} is an admin on your physical Mac. Make it a standard user or use a VM, then test again.`}`
              : `“${notice.title}” runs on ${notice.fallback?.monthly ? "your monthly Mac" : `the ${notice.fallback?.label} Mac you already rented`} instead${notice.fallback?.monthly || (notice.fallback?.paidUntil && Date.parse(notice.fallback.paidUntil) > Date.now()) ? ", at no extra cost" : "; existing billing continues"}. To use your Mac again, ${personal ? "point the alias at a VM or a separate standard user" : `make ${who} a standard user (or use a VM)`}, then test again.`}
          </p>
          <dl
            className={cn(
              details,
              "mt-3 hidden space-y-1.5 text-sm leading-5 max-sm:block",
            )}
          >
            <dt className="text-xs text-[#6E6E6E]">Alias</dt>
            <dd className="font-mono text-[13px] text-[#EDEDED]">
              {notice.alias}
            </dd>
            <dt className="pt-1 text-xs text-[#6E6E6E]">Signs in as</dt>
            <dd className="text-[#D6D6D6]">
              {personal
                ? "you (the user running bb)"
                : `${who} · Administrator`}
            </dd>
            <dt className="pt-1 text-xs text-[#6E6E6E]">Fix</dt>
            <dd className="text-[#D6D6D6]">{fix}</dd>
          </dl>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3.5 pb-3 pl-10 max-sm:mt-3 max-sm:p-0">
        <a
          className={cn(primary, "max-sm:hidden")}
          href="/settings/plugins/boat"
          onClick={onSettings}
        >
          Open Your Mac settings
        </a>
        <a
          href={OWN_MAC_GUIDE}
          target="_blank"
          rel="noreferrer"
          className={cn(primary, "hidden text-center max-sm:block")}
        >
          Setup guide ↗
        </a>
        <button className={secondary} disabled={busy} onClick={onTest}>
          Test again
        </button>
        {waiting && notice.offer && (
          <button
            className={cn(link, "ml-auto max-sm:hidden")}
            onClick={onRent}
          >
            Rent a Mac instead · from{" "}
            {money(notice.offer.minimumCost, notice.offer.currency)}
          </button>
        )}
        {waiting && notice.offer && (
          <button
            className={cn(secondary, "hidden max-sm:block")}
            onClick={onRent}
          >
            Rent a Mac
          </button>
        )}
      </div>
      <p className="mt-3 hidden text-center text-[13px] leading-[18px] text-[#6E6E6E] max-sm:block">
        Agents never run in your own login. Rent a Mac shows the cost first.
      </p>
    </section>
  );
}
/** A consumed native approval stays visible even if its linked app task failed. */
export function OwnMacLinkedRentalCard({notice,onOpenTask,onOpenMachine,onRecover,recovering,error}:{notice:OwnMacNotice;onOpenTask?:()=>void;onOpenMachine?:()=>void;onRecover?:()=>void;recovering?:boolean;error?:string}) {
  const linked=notice.linkedTask, lease=linked?.lease, quote=notice.offer;
  const stopped=linked && ["failed","cancelled"].includes(linked.status);
  const started=Boolean(linked && (linked.turns>0 || ["running","idle","done","ready"].includes(linked.status)));
  const heading=stopped ? (linked!.turns===0 ? "App task did not start" : "Linked task stopped") : started ? "App task started" : linked ? "Approval received · task preparing" : "Approval received · task status unavailable";
  return <section aria-label="Approved Mac rental" aria-busy={recovering || undefined} role={stopped?"alert":"status"} className={cn("min-w-0 max-w-[720px] overflow-hidden rounded-[10px] border bg-[#181818] px-3.5 py-3 text-[13px] leading-5 text-[#A8A8A8] max-sm:rounded-xl max-sm:p-3 max-sm:text-sm",stopped?"border-[#3A2424]":"border-[#2A2A2A]")}>
    <h3 className="font-medium text-[#EDEDED]">{heading}</h3>
    <ol aria-label="Rental start progress" className="mt-2 space-y-1.5">
      <li>Approval received for one {quote?.label ?? lease?.provider ?? "Mac"} {quote?.modelLabel ?? lease?.model ?? "rental"}{quote ? ` · ${money(quote.minimumCost,quote.currency)} ${quote.currency} minimum for ${quote.minimumHours} h` : ""}.</li>
      <li className="font-medium text-[#D0D0D0]">{linked?.machineId ? "Mac allocated" : "Mac allocation unconfirmed"}{linked?.machineId && <span className="mt-0.5 block break-all font-mono text-xs font-normal text-[#A8A8A8]">{linked.machineId}</span>}</li>
      <li>{lease && !lease.endedAt ? "Lease terms recorded" : "Current lease unconfirmed"}</li>
      <li>{stopped && linked!.turns===0 ? "App task did not start · 0 turns" : started ? "App task started" : "App task start unconfirmed"}</li>
    </ol>
    {linked?.error && <p className="mt-2 break-words text-[#E6A3A3]">{linked.error}</p>}
    {lease ? <dl className={cn(details,"mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs leading-[18px] max-sm:text-[13px] max-sm:leading-5")}>
      <dt>Minimum committed</dt><dd className="text-[#D0D0D0]">{money(lease.minimumCost,lease.currency)} {lease.currency}</dd>
      <dt>Paid until</dt><dd className="text-[#D0D0D0]"><time dateTime={lease.paidUntil} title={lease.paidUntil}>{leaseTime(lease.paidUntil)}</time></dd>
      <dt>Then</dt><dd className="text-[#D0D0D0]">{money(lease.hourPrice,lease.currency)} {lease.currency} / h until released</dd>
      <dt>Release plan</dt><dd className="text-[#D0D0D0]">{lease.releaseAt ? <>Scheduled for <time dateTime={lease.releaseAt} title={lease.releaseAt}>{leaseTime(lease.releaseAt)}</time></> : "No release schedule recorded"}</dd>
    </dl> : <p className="mt-2">Current paid-until time and release schedule are unconfirmed. A rental may already be billing.</p>}
    {lease && <p className="mt-2 text-xs leading-[18px] text-[#8A8A8A] max-sm:text-[13px] max-sm:leading-5">{lease.endedAt ? "The local ledger marks this lease ended; current provider lease and billing are unconfirmed." : "These are recorded lease terms. Scheduled release is not confirmation that billing has ended."}</p>}
    {stopped && <p className="mt-2">Recover the existing task on this same Mac after its current lease is verified. No second rental is approved. Its release plan and any work or logins must be preserved.</p>}
    {error && <p role="alert" className="mt-2 break-words text-[#E6A3A3]">{error}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      {linked?.status==="failed" && linked.turns===0 && linked.machineId && onRecover && <button type="button" className={cn(primary,"max-sm:min-h-11")} disabled={recovering} onClick={onRecover}>{recovering ? "Recovering existing task…" : "Recover on this Mac"}</button>}
      {notice.replacementId && <button type="button" className={secondary} disabled={!onOpenTask} onClick={onOpenTask}>Open existing task</button>}
      {linked?.machineId && <button type="button" className={secondary} disabled={!onOpenMachine} onClick={onOpenMachine}>View machine in Sandboxes</button>}
    </div>
  </section>;
}
export function OwnMacRentalCard({
  notice,
  showTaskTitle = true,
  onAnswer,
  onSelect,
  onRefresh,
  busy,
  approving,
  error,
  onOwnWords,
  onOpenTask,
  onOpenMachine,
  onRecover,
  recovering,
}: {
  notice: OwnMacNotice;
  showTaskTitle?: boolean;
  onAnswer?: (answer: "rent" | "wait" | "queue") => void;
  onSelect?: (quoteId: string) => void;
  onRefresh?: () => void;
  busy?: boolean;
  approving?: boolean;
  error?: string;
  onOwnWords?: () => void;
  onOpenTask?: () => void;
  onOpenMachine?: () => void;
  onRecover?: () => void;
  recovering?: boolean;
}) {
  const group = useId();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const q = notice.offer;
  const offers = notice.offers ?? (q ? [q] : []);
  const expired = !q || !Number.isFinite(Date.parse(q.expiresAt)) || Date.parse(q.expiresAt) <= now;
  const price = q ? money(q.minimumCost, q.currency) : "";
  if (notice.replacementId)
    return <OwnMacLinkedRentalCard notice={notice} onOpenTask={onOpenTask} onOpenMachine={onOpenMachine} onRecover={onRecover} recovering={recovering} error={error} />;
  if (notice.answer === "failed")
    return <p role="alert" className="rounded-lg border border-[#3A2424] bg-[#181818] px-3.5 py-3 text-[13px] leading-5 text-[#A8A8A8]">The start failed. Inspect the task and the provider’s machines before retrying; a rental may already exist. No other provider was approved.</p>;
  if (notice.answer === "auto")
    return <p className="text-[13px] leading-5 text-[#A8A8A8]">Your Mac is available again, so “{notice.title}” runs on your Mac. No extra cost.</p>;
  const orderedOffers = [...offers].sort((a, b) => Number(b.id === notice.recommendedQuoteId) - Number(a.id === notice.recommendedQuoteId));
  const comparison = q ? compareRentalOffers(q, offers.find(other => other.id !== q.id)) : undefined;
  const rationale = [q && q.id === notice.recommendedQuoteId ? notice.recommendationReason : undefined, comparison].filter(Boolean).join(" ");
  const rentalAction = "min-h-11 rounded-md border border-[#333333] px-3 py-2 text-[13px] leading-5 text-[#D0D0D0] disabled:opacity-50 max-sm:flex-1 max-sm:text-sm";
  return (
    <section aria-label="Mac rental choice" aria-busy={busy || undefined} className="min-w-0 max-w-[720px] overflow-hidden rounded-[10px] border border-[#3D3420] bg-[#181818] max-sm:rounded-xl">
      <div className="hidden flex-wrap items-center gap-2 border-b border-[#242424] px-3.5 py-2.5 text-xs leading-4 sm:flex">
        <span className="size-1.5 rounded-full bg-[#F0B135]" />
        <span role="status" className="font-medium text-[#F0B135]">{approving ? "Starting rental…" : notice.answer === "wait" ? "Waiting for your Mac" : notice.answer === "queue" ? "Kept queued" : "Needs you"}</span>
        <span className="text-[#6E6E6E]">from Harbormaster · Mac task</span>
      </div>
      <div className="space-y-3 p-3.5 max-sm:space-y-3.5 max-sm:p-3">
        <div>
          <h3 className="break-words text-[15px] font-medium leading-[22px] text-[#EDEDED] max-sm:text-base">
            <span className="sm:hidden">{showTaskTitle ? `Choose a Mac for “${notice.title}”` : "Choose a Mac to start this task"}</span>
            <span className="hidden sm:inline">Rent a Mac for “{notice.title}”?</span>
          </h3>
          <p role="status" className="mt-1 text-[13px] leading-5 text-[#A8A8A8] max-sm:mt-1.5 max-sm:text-sm">
            {approving
              ? "Checking the selected quote and starting one rental."
              : notice.answer === "queue"
                ? "Kept queued. Nothing was rented. You can still choose a rental below."
              : notice.answer === "wait"
                ? "Waiting for your Mac. You can still choose a rental below."
                : "Nothing is rented until you confirm. Your choice applies to this task only."}
          </p>
        </div>
        {error && <p role="alert" className="break-words rounded-md border border-[#3A2424] px-3 py-2 text-[13px] leading-5 text-[#E06C6C] max-sm:text-sm">{error}</p>}
        {offers.length > 0 && <fieldset role="radiogroup" aria-label="Mac rental providers" disabled={busy} className="m-0 min-w-0 border-0 p-0">
          <legend className="sr-only">Choose a Mac rental for this task</legend>
          <div className="grid min-w-0 items-start gap-2.5 sm:grid-cols-2">
            {orderedOffers.map(offer => {
              const selected = q?.id === offer.id;
              const recommended = notice.recommendedQuoteId === offer.id;
              const outOfDate = Date.parse(offer.expiresAt) <= now;
              const machine = [offer.cpus ? `${offer.cpus} cores` : null, offer.memoryMiB ? `${new Intl.NumberFormat("en-US", {maximumFractionDigits: 1}).format(offer.memoryMiB / 1024)} GB memory` : null].filter(Boolean).join(" · ");
              return <label key={offer.id} className={cn("flex min-w-0 cursor-pointer items-start gap-2 rounded-[10px] border-[1.5px] p-3 text-[13px] leading-5 max-sm:gap-2.5 max-sm:p-3.5 max-sm:text-sm", selected ? "border-[#5C82C9] bg-[#1A1F27]" : "border-[#333333] bg-[#1C1C1C]", busy && "opacity-60")}>
                <input type="radio" name={group} checked={selected} disabled={busy || !onSelect || outOfDate} onChange={() => onSelect?.(offer.id)} className="m-0 mt-1 size-3.5 shrink-0 accent-[#7AA7FF] [color-scheme:dark] max-sm:size-[18px]" />
                <span className="min-w-0 flex-1 break-words">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium text-[#EDEDED] max-sm:text-base max-sm:leading-[22px]">{offer.label} · {offer.modelLabel}</span>
                    {recommended && <span className="rounded bg-[#22314A] px-1.5 py-px text-[11px] font-medium leading-4 text-[#9CBCFF] max-sm:text-xs">Recommended</span>}
                  </span>
                  <span className="mt-2 block text-[#D0D0D0]">
                    <span className="text-[18px] font-semibold leading-6 tabular-nums text-[#FC8C45] max-sm:text-[20px] max-sm:leading-7">{money(offer.minimumCost, offer.currency)}</span>{" "}
                    <span>{offer.currency} total for the first {offer.minimumHours} h</span>
                  </span>
                  <span className="mt-0.5 block text-xs leading-[18px] text-[#A8A8A8] max-sm:text-sm max-sm:leading-5">then {money(offer.hourPrice, offer.currency)} / h until released</span>
                  <dl className={cn("mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-[#303744] pt-2 text-xs leading-[18px] max-sm:gap-x-4 max-sm:gap-y-1.5 max-sm:text-sm max-sm:leading-5", !selected && "max-sm:hidden")}>
                    <dt className="text-[#8A8A8A]">Minimum</dt><dd className="m-0 text-[#D0D0D0]">{offer.minimumHours} h, paid even if handed back sooner</dd>
                    <dt className="text-[#8A8A8A]">Machine</dt><dd className="m-0 text-[#D0D0D0]">{machine || "Not listed"}</dd>
                    <dt className="text-[#8A8A8A]">Region</dt><dd className="m-0 text-[#D0D0D0]">{offer.region || "Not listed"}</dd>
                  </dl>
                  {selected && rationale && <span className="mt-2.5 block text-sm leading-5 text-[#A8A8A8] sm:hidden"><span className="text-[#D0D0D0]">{recommended ? "Why this one: " : "Compared: "}</span>{rationale}</span>}
                  {!selected && <span className="mt-2 block text-sm leading-5 text-[#A8A8A8] sm:hidden"><span className="text-[#D0D0D0]">Compared: </span>{q && offer.currency !== q.currency ? `Quoted in ${offer.currency}; no currency conversion.` : compareRentalOffers(offer, q)}</span>}
                  {outOfDate && <span className="mt-1 block text-xs text-[#FC8C45] max-sm:text-sm">Quote expired</span>}
                </span>
              </label>;
            })}
          </div>
        </fieldset>}
        {rationale && <p className="hidden text-[13px] leading-5 text-[#A8A8A8] sm:block"><span className="text-[#D0D0D0]">{q && q.id === notice.recommendedQuoteId ? "Why this one: " : "Compared: "}</span>{rationale}</p>}
        {!offers.length && <p role="status" className="text-[13px] leading-5 text-[#FC8C45] max-sm:text-sm">No rental offer is available. Refresh to check again.</p>}
        {expired && offers.length > 0 && <p role="status" className="text-[13px] leading-5 text-[#FC8C45] max-sm:text-sm">This quote expired. Refresh offers to see the current cost before approving.</p>}
        {(notice.unavailable?.length ?? 0) > 0 && <details className="text-xs leading-[18px] text-[#8A8A8A] max-sm:text-sm max-sm:leading-5">
          <summary className="min-h-6 cursor-pointer max-sm:min-h-11 max-sm:py-3">Unavailable choices ({notice.unavailable!.length})</summary>
          <ul className="mt-2 space-y-1">{notice.unavailable!.map((option, index) => <li key={`${option.provider}:${index}`} className="break-words"><span className="text-[#D0D0D0]">{option.label}:</span> {option.reason}</li>)}</ul>
        </details>}
        {q && <p className="text-xs leading-[18px] text-[#8A8A8A] max-sm:text-[13px] max-sm:leading-5">{q.checkedAt ? `Selected quote checked ${new Date(q.checkedAt).toLocaleTimeString("en-US", {hour:"2-digit",minute:"2-digit",hourCycle:"h23"})}. ` : ""}Price and availability are checked again before any rental.</p>}
        {q && <p className="text-[13px] leading-5 text-[#A8A8A8]">Remote computer use is not confirmed by these quotes.</p>}
        {q && <div className="space-y-2.5">
          <button className="min-h-[52px] w-full rounded-lg bg-[#E6E6E6] px-3 py-2 text-center text-sm font-medium leading-5 text-[#141414] disabled:opacity-50 sm:min-h-8 sm:w-auto sm:rounded-md sm:py-1.5 sm:text-[13px]" disabled={busy || expired || !onAnswer} onClick={() => onAnswer?.("rent")}>
            <span className="block">{approving ? "Starting rental…" : `Rent ${q.label} Mac · ${price} ${q.currency}`}</span>
            <span className="block text-xs font-normal leading-4 text-[#505050] max-sm:text-[13px] sm:hidden">then {money(q.hourPrice, q.currency)} {q.currency} / h after {q.minimumHours} h</span>
          </button>
          <p className="text-xs leading-[18px] text-[#8A8A8A] max-sm:text-center max-sm:text-[13px] max-sm:leading-5">One rental, for this task. Your project's “Runs on” setting doesn't change.</p>
          <details className="text-xs leading-[18px] text-[#8A8A8A] max-sm:text-sm max-sm:leading-5">
            <summary className="min-h-6 cursor-pointer max-sm:min-h-11 max-sm:py-3">Rental details</summary>
            <p className="mt-1">Approve one {q.label} {q.modelLabel} rental for this task: {price} {q.currency} total for at least {q.minimumHours} h, then {money(q.hourPrice, q.currency)} {q.currency} / h until released. This does not approve another provider or paid Claude usage.</p>
            <p className="mt-2">A rental quote does not confirm GUI automation readiness.</p>
          </details>
        </div>}
        <div className="flex flex-wrap items-center gap-2">
          <button className={rentalAction} disabled={busy || !onAnswer} onClick={() => onAnswer?.("queue")}>{notice.answer === "queue" ? "Kept queued" : "Keep it queued"}</button>
          {notice.canWaitForOwnMac !== false && <button className={rentalAction} disabled={busy || !onAnswer} onClick={() => onAnswer?.("wait")}>Wait for your Mac</button>}
          {onRefresh && <button className={rentalAction} disabled={busy} onClick={onRefresh}>{busy && !approving ? "Updating…" : "Refresh offers"}</button>}
          {onOwnWords && <button className="min-h-11 text-xs leading-5 text-[#8A8A8A] max-sm:flex-1 max-sm:text-sm sm:ml-auto" onClick={onOwnWords}>Ask about this rental</button>}
        </div>
        {notice.canWaitForOwnMac === false && <p className="text-xs leading-4 text-[#8A8A8A] max-sm:text-[13px] max-sm:leading-5">Choose Your Mac in Runs on to wait for it.</p>}
      </div>
    </section>
  );
}
export function OwnMacCleanupCard({
  cleanup,
  title,
  onCheck,
  busy,
}: {
  cleanup: NonNullable<OwnMacFacts["cleanup"]>;
  title: string;
  onCheck?: () => void;
  busy?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  if (!cleanup.failed)
    return (
      <p className="text-xs text-[#A8A8A8]">
        ✓ Logins removed · checked{" "}
        {cleanup.checkedAt
          ? new Date(cleanup.checkedAt).toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            })
          : "just now"}
      </p>
    );
  return (
    <section className="max-w-[720px] rounded-[10px] border border-[#3A2424] bg-[#181818] max-sm:rounded-xl">
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span aria-hidden className="mt-[3px] text-sm text-[#E06C6C]">
          <InfoIcon alert />
        </span>
        <div>
          <h3 className="text-[13px] font-medium leading-5 text-[#EDEDED]">
            Login cleanup couldn't be verified
          </h3>
          <p className="mt-1 text-xs leading-4 text-[#8A8A8A]">
            “{title}” ended. Harbormaster couldn't confirm that the task's
            logins are gone. Your Mac is automatically paused for new tasks
            until Check again passes. Running tasks are not moved or stopped.
          </p>
        </div>
      </div>
      <div className={cn(details, "mx-3.5 ml-10 text-xs text-[#D6D6D6]")}>
        <span className="mr-3 text-[#6E6E6E]">Check failed</span>GitHub and
        agent login removal could not be verified. The check does not report
        individual items.
      </div>
      <div className="space-y-2 px-3.5 pt-3 pl-10 text-xs leading-[17px] text-[#A8A8A8]">
        <p className="font-medium text-[#D6D6D6]">Remove them by hand</p>
        <ol className="list-decimal space-y-2 pl-4">
          <li>
            Open the agents account: start the VM, or switch to the agents user
            on your Mac.
          </li>
          <li>
            In Terminal there, run the same task-home sign-out and file checks
            Harbormaster uses:
            <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-md border border-[#262626] bg-[#151515] px-2.5 py-2 font-mono text-[11px] leading-[17px] text-[#EDEDED]">
              {cleanup.steps}
            </pre>
          </li>
          <li>
            Remove the task's bb machine in Settings › Machines if it is still
            registered, to revoke its agent proxy access. Press Check again.
            Can't reach the Mac? Revoke the GitHub token on GitHub instead; it
            stops working everywhere.
          </li>
        </ol>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3.5 pt-3.5 pb-3 pl-10">
        <button
          className={primary}
          disabled={busy || !onCheck}
          onClick={onCheck}
        >
          Check again
        </button>
        <button
          className={secondary}
          onClick={() => {
            void navigator.clipboard
              .writeText(cleanup.steps)
              .then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy steps"}
        </button>
        <a
          className={cn(link, "ml-auto")}
          href="https://github.com/settings/personal-access-tokens"
          target="_blank"
          rel="noreferrer"
        >
          GitHub token settings ↗
        </a>
      </div>
    </section>
  );
}
