import { useState } from "react";
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
        Your Mac is {notice.reason}, so “{notice.title}” runs on{" "}
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
  busy,
  onOwnWords,
}: {
  notice: OwnMacNotice;
  onAnswer?: (answer: "rent" | "wait") => void;
  busy?: boolean;
  onOwnWords?: () => void;
}) {
  const q = notice.offer;
  if (!q) return null;
  const price = money(q.minimumCost, q.currency),
    rate = money(q.hourPrice, q.currency);
  if (notice.answer === "failed" && notice.replacementId)
    return (
      <p className="text-xs text-[#A8A8A8]">
        The start failed. Inspect the task before retrying.
      </p>
    );
  if (notice.answer === "auto")
    return (
      <p className="flex items-start gap-2.5 text-[13px] leading-5 text-[#A8A8A8]">
        <span aria-hidden className="text-[#8A8A8A]">
          <InfoIcon />
        </span>
        <span>
          Your Mac is available again, so “{notice.title}” runs on your Mac.{" "}
          <span className="text-[#6E6E6E]">No extra cost.</span>
        </span>
      </p>
    );
  if (notice.answer && notice.answer !== "failed")
    return (
      <div className="max-w-[720px] rounded-[10px] border border-[#2A2A2A] bg-[#181818] px-3.5 py-3 text-xs text-[#A8A8A8]">
        ✓{" "}
        {notice.answer === "wait" && !notice.replacementId
          ? "Waiting for your Mac"
          : `You chose Rent for ${price} · ${q.label} ${q.modelLabel}`}
        {!notice.replacementId && (
          <button
            className={cn(link, "ml-3")}
            onClick={() => onAnswer?.("rent")}
          >
            Rent for {price} instead
          </button>
        )}
      </div>
    );
  return (
    <section className="max-w-[720px] overflow-hidden rounded-[10px] border border-[#3D3420] bg-[#181818]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#242424] px-3.5 py-2.5 text-xs leading-4">
        <span className="size-1.5 rounded-full bg-[#F0B135]" />
        <span className="font-medium text-[#F0B135]">Needs you</span>
        <span className="text-[#6E6E6E]">
          from Harbormaster · Mac tasks · just now
        </span>
      </div>
      <div className="px-3.5 pt-3.5 pb-2.5">
        <h3 className="text-[15px] font-medium leading-[22px] text-[#EDEDED]">
          Rent a Mac for “{notice.title}”?
        </h3>
        <p className="mt-1 text-[13px] leading-5 text-[#A8A8A8]">
          Your Mac{" "}
          {notice.reason === "can't be used"
            ? "can't be used"
            : `is ${notice.reason}`}
          , and no monthly or rented Mac is free. The task waits until you
          choose; nothing is rented yet.
        </p>
      </div>
      <div className="overflow-x-auto px-3.5 pt-1">
        <table className="w-full min-w-[560px] table-fixed text-left text-[13px] leading-5">
          <thead className="h-[30px] border-b border-[#262626] text-xs leading-4 text-[#6E6E6E]">
            <tr>
              <th className="font-normal">Option</th>
              <th className="w-[110px] font-normal">Cost</th>
              <th className="w-[110px] font-normal">Starts</th>
              <th className="w-[180px] font-normal">Verdict</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-[#262626]">
              <td className="py-2.5 pr-4">
                <p className="font-medium text-[#EDEDED]">
                  Rent {q.label === "Instabox" ? "an" : "a"} {q.label} Mac
                </p>
                <p className="text-xs text-[#8A8A8A]">
                  {q.modelLabel} · {q.minimumHours} h minimum
                </p>
              </td>
              <td>
                <p className="tabular-nums text-[#FC8C45]">{price}</p>
                <p className="text-xs text-[#8A8A8A]">then {rate} / h</p>
              </td>
              <td className="text-[#C1C1C1]">when ready</td>
              <td className="text-[#5BD08A]">
                Runs now; other Mac tasks can share it
              </td>
            </tr>
            <tr>
              <td className="py-2.5 pr-4 text-[#D0D0D0]">
                <p>Wait for your Mac</p>
                <p className="text-xs text-[#8A8A8A]">
                  {notice.alias} · {notice.reason}
                </p>
              </td>
              <td className="text-[#C1C1C1]">$0</td>
              <td className="text-[#C1C1C1]">when it's back</td>
              <td className="text-[#FC8C45]">Could be hours</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="px-3.5 pt-2.5 text-xs leading-4 text-[#8A8A8A]">
        Harbormaster never rents without asking. {q.label} bills at least{" "}
        {q.minimumHours} h; you can hand the Mac back after that.
      </p>
      <div className="flex flex-wrap items-center gap-2 p-3.5">
        <button
          className={primary}
          disabled={busy || !onAnswer}
          onClick={() => onAnswer?.("rent")}
        >
          Rent for {price}
        </button>
        <button
          className={secondary}
          disabled={busy || !onAnswer}
          onClick={() => onAnswer?.("wait")}
        >
          Wait for your Mac
        </button>
        {onOwnWords && (
          <button
            className="ml-auto text-xs text-[#8A8A8A]"
            onClick={onOwnWords}
          >
            Answer in your own words
          </button>
        )}
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
