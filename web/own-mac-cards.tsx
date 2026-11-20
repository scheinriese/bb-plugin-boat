import { useEffect, useId, useState } from "react";
import type { OwnMacFacts, OwnMacNotice } from "../contract-ownmac";
import { OWN_MAC_GUIDE } from "../contract-ownmac";
import { money, leaseTime } from "./provider-format";
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
export function OwnMacRentalCard({
  notice,
  onAnswer,
  onSelect,
  onRefresh,
  busy,
  approving,
  error,
  onOwnWords,
}: {
  notice: OwnMacNotice;
  onAnswer?: (answer: "rent" | "wait") => void;
  onSelect?: (quoteId: string) => void;
  onRefresh?: () => void;
  busy?: boolean;
  approving?: boolean;
  error?: string;
  onOwnWords?: () => void;
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
  if (notice.answer === "failed")
    return <p role="alert" className="rounded-lg border border-[#3A2424] bg-[#181818] px-3.5 py-3 text-[13px] leading-5 text-[#A8A8A8]">The start failed. Inspect the task and the provider’s machines before retrying; a rental may already exist. No other provider was approved.</p>;
  if (notice.answer === "auto")
    return <p className="text-[13px] leading-5 text-[#A8A8A8]">Your Mac is available again, so “{notice.title}” runs on your Mac. No extra cost.</p>;
  if (notice.answer === "rent" && notice.replacementId)
    return <div role="status" className="max-w-[720px] rounded-[10px] border border-[#2A2A2A] bg-[#181818] px-3.5 py-3 text-[13px] leading-5 text-[#A8A8A8]">You approved one {q?.label} {q?.modelLabel} rental for {price} {q?.currency} minimum. Starting the task; check its status below.</div>;
  return (
    <section aria-label="Mac rental choice" aria-busy={busy || undefined} className="min-w-0 max-w-[720px] overflow-hidden rounded-[10px] border border-[#3D3420] bg-[#181818]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#242424] px-3.5 py-2.5 text-xs leading-4">
        <span className="size-1.5 rounded-full bg-[#F0B135]" />
        <span role="status" className="font-medium text-[#F0B135]">{approving ? "Starting rental…" : notice.answer === "wait" ? "Waiting for your Mac" : "Waiting for you"}</span>
        <span className="text-[#6E6E6E]">Mac task</span>
      </div>
      <div className="space-y-3 p-3.5">
        <div>
          <h3 className="break-words text-[15px] font-medium leading-[22px] text-[#EDEDED]">Choose a Mac for “{notice.title}”</h3>
          <p className="mt-1 text-[13px] leading-5 text-[#A8A8A8]">
            {notice.canWaitForOwnMac === false
              ? "The project's Runs on selects a rented Mac."
              : `Your Mac ${notice.reason === "can't be used" ? "can't be used" : `is ${notice.reason}`}.`}{" "}
            {approving ? "Checking the selected quote and starting one rental." : "The task waits until you choose; nothing is rented yet."}
          </p>
        </div>
        {error && <p role="alert" className="break-words rounded-md border border-[#3A2424] px-3 py-2 text-[13px] leading-5 text-[#E06C6C]">{error}</p>}
        {offers.length > 0 && <fieldset disabled={busy} className="m-0 min-w-0 space-y-2 border-0 p-0">
          <legend className="mb-2 text-xs leading-4 text-[#8A8A8A]">Choose for this task only</legend>
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            {offers.map(offer => {
              const selected = q?.id === offer.id;
              const recommended = notice.recommendedQuoteId === offer.id;
              const outOfDate = Date.parse(offer.expiresAt) <= now;
              return <label key={offer.id} className={cn("flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-[13px] leading-5", selected ? "border-[#6B5B36] bg-[#211E18]" : "border-[#303030] bg-[#151515]", busy && "opacity-60")}>
                <input type="radio" name={group} checked={selected} disabled={busy || !onSelect || outOfDate} onChange={() => onSelect?.(offer.id)} className="mt-1 shrink-0 accent-[#F0B135]" />
                <span className="min-w-0 flex-1 break-words">
                  <span className="block font-medium text-[#EDEDED]">{offer.label} · {offer.modelLabel}</span>
                  {recommended && <span className="mt-1 block text-xs text-[#5BD08A]">Recommended</span>}
                  <span className="mt-2 block text-base font-medium tabular-nums text-[#EDEDED]">{money(offer.minimumCost, offer.currency)} {offer.currency} total minimum</span>
                  <span className="block text-xs text-[#A8A8A8]">{offer.minimumHours} h minimum · then {money(offer.hourPrice, offer.currency)} / h</span>
                  {outOfDate && <span className="mt-1 block text-xs text-[#FC8C45]">Quote expired</span>}
                </span>
              </label>;
            })}
          </div>
        </fieldset>}
        {notice.recommendationReason && <p className="text-xs leading-[18px] text-[#A8A8A8]">{notice.recommendationReason}</p>}
        {!offers.length && <p role="status" className="text-[13px] leading-5 text-[#FC8C45]">No rental offer is available. Refresh to check again.</p>}
        {expired && offers.length > 0 && <p role="status" className="text-[13px] leading-5 text-[#FC8C45]">This quote expired. Refresh offers to see the current cost before approving.</p>}
        {(notice.unavailable?.length ?? 0) > 0 && <details className="text-xs leading-[18px] text-[#8A8A8A]">
          <summary className="cursor-pointer">Unavailable choices ({notice.unavailable!.length})</summary>
          <ul className="mt-2 space-y-1">{notice.unavailable!.map((option, index) => <li key={`${option.provider}:${index}`} className="break-words"><span className="text-[#D0D0D0]">{option.label}:</span> {option.reason}</li>)}</ul>
        </details>}
        {q && <p className="text-xs leading-[18px] text-[#8A8A8A]">Approve one {q.label} {q.modelLabel} rental for this task: {price} {q.currency} total for at least {q.minimumHours} h, then {money(q.hourPrice, q.currency)} {q.currency} / h until released. This does not approve another provider or paid Claude usage.</p>}
        <div className="flex flex-wrap items-center gap-2">
          {q && <button className={primary} disabled={busy || expired || !onAnswer} onClick={() => onAnswer?.("rent")}>{approving ? "Starting rental…" : `Rent for ${price} ${q.currency} · ${q.label}`}</button>}
          {notice.canWaitForOwnMac !== false && <button className={secondary} disabled={busy || !onAnswer} onClick={() => onAnswer?.("wait")}>Wait for your Mac</button>}
          {onRefresh && <button className={secondary} disabled={busy} onClick={onRefresh}>{busy && !approving ? "Updating…" : "Refresh offers"}</button>}
        </div>
        {notice.canWaitForOwnMac === false && <p className="text-xs leading-4 text-[#6E6E6E]">Choose Your Mac in Runs on to wait for it.</p>}
        {onOwnWords && <button className={link} onClick={onOwnWords}>Ask about this rental</button>}
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
