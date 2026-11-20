import { useEffect, useState } from "react";
import {
  experimental_useRpcMutation,
  experimental_useRpcQuery,
  useBbNavigate,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import type { MonthlyMacSuggestion } from "../contract-monthly-macs";
import { rpcContract } from "../contract";
import { Button } from "../components/ui/button";
import { Frame } from "./decision-frame";
import { useFillComposer } from "./cards";
import { LeaseDayMeter } from "./mac-usage";
import { money } from "./provider-format";
import { toast } from "sonner";
import { showError } from "./ui";

const names: Record<string, string> = {
  instabox: "Instabox",
  scaleway: "Scaleway",
};
const choiceLabel = {
  rent: "Rent a monthly Mac ↗",
  keep: "Keep day leases",
  own: "Use my own Mac",
  cancel: "Review cancellation ↗",
};
/** Shared by chat, Today, usage disclosure and the neutral preview harness. */
export function MonthlyMacCard({
  suggestion: s,
  onChoose,
  onAnswer,
  receipt = false,
  project,
}: {
  suggestion: MonthlyMacSuggestion;
  onChoose?: (answer: NonNullable<MonthlyMacSuggestion["answer"]>) => void;
  onAnswer?: () => void;
  receipt?: boolean;
  project?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const closed = Boolean(s.answer);
  const provider = names[s.dayProvider] ?? s.dayProvider;
  const rent = s.kind === "rent";
  const primary = rent ? "rent" : "cancel";
  const price = `${money(s.candidate.monthlyPrice, s.currency)} / mo`;
  const choose = (answer: NonNullable<MonthlyMacSuggestion["answer"]>) =>
    onChoose?.(answer);
  const action = (
    answer: NonNullable<MonthlyMacSuggestion["answer"]>,
    mobile = false,
  ) => (
    <Button
      disabled={closed}
      variant={answer === primary ? "default" : "outline"}
      onClick={() => choose(answer)}
      className={`${mobile ? "h-10 w-full rounded-lg text-sm" : "h-7 px-3 text-xs"} ${answer === primary ? "bg-[#E6E6E6] text-[#141414]" : "border-[#333333] text-[#D0D0D0]"}`}
    >
      {choiceLabel[answer]}
    </Button>
  );
  if ((closed || receipt) && !expanded)
    return (
      <Frame>
        <div className="flex items-center gap-2 px-3.5 py-3 text-xs text-[#A8A8A8]">
          <span className="text-[#5BD08A]">✓</span>
          <span className="min-w-0 flex-1">
            You chose{" "}
            {s.answer
              ? choiceLabel[s.answer].replace(" ↗", "")
              : "Keep day leases"}
            {s.answer === "rent" || s.answer === "cancel"
              ? ` · opened ${s.candidate.provider}'s page`
              : s.answer === "keep"
                ? " · snoozed for 2 weeks"
                : s.answer === "own"
                  ? " · setup guidance is coming"
                  : ""}
          </span>
          <button onClick={() => setExpanded(true)}>Show options</button>
        </div>
      </Frame>
    );
  return (
    <Frame className="border-[#2A3A55] bg-[#181818] p-3 sm:p-0">
      <header className="flex flex-wrap items-center gap-2 border-[#242424] text-[13px] leading-[18px] sm:border-b sm:px-3.5 sm:py-2.5 sm:text-xs">
        <span className="inline-flex items-center gap-1.5 font-medium text-[#7AA7FF]">
          <span className="size-1.5 rounded-full bg-current" />
          Suggestion
        </span>
        <span className="text-[#6E6E6E]">from Harbormaster · Mac costs{project ? ` · ${project}` : ""} · today</span>
      </header>
      <div className="pt-2.5 sm:px-3.5 sm:pt-3.5">
        <h3 className="text-base font-medium leading-[22px] text-[#EDEDED] sm:text-[15px]">
          {rent
            ? "A monthly Mac would now be cheaper than day leases"
            : "Your monthly Mac may cost more than day leases"}
        </h3>
        <p className="mt-1 text-sm leading-5 text-[#A8A8A8] sm:text-[13px]">
          {provider} Mac · {Number(s.days.toFixed(1))} lease-days in the last 30
          days · {money(s.cost, s.currency)}
        </p>
        <div className="mb-3 mt-6 max-w-[440px]">
          <LeaseDayMeter days={s.days} breakEven={s.breakEven} showCount />
        </div>
        <div className="hidden sm:block">
          <table className="w-full table-fixed text-left text-[13px] leading-5">
            <thead className="h-[30px] border-b border-[#262626] text-xs text-[#6E6E6E]">
              <tr>
                <th className="font-normal">Option</th>
                <th className="w-[100px] font-normal">Cost</th>
                <th className="w-[120px] font-normal">At this pace</th>
                <th className="w-[175px] font-normal">Verdict</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-[#262626]">
                <td className="py-2.5">
                  <span className="font-medium text-[#EDEDED]">
                    {rent ? "Rent a monthly Mac" : "Review cancellation"}
                  </span>
                  <span className="ml-2 inline-block rounded bg-[#1E2A3D] px-1.5 py-px text-[11px] text-[#7AA7FF]">
                    Recommended
                  </span>
                  <span className="block text-xs text-[#8A8A8A]">
                    {s.candidate.provider} · {s.candidate.chip}{" "}
                    {s.candidate.ramGB} GB
                  </span>
                </td>
                <td>{price}</td>
                <td>
                  {rent
                    ? `saves ≈ ${money(s.savings, s.currency)} / mo`
                    : `${money(s.forecast.base * s.dayRate, s.currency)} in day leases`}
                </td>
                <td className="text-[#5BD08A]">
                  {rent
                    ? "Always ready for Mac work"
                    : "Check your notice period first"}
                </td>
              </tr>
              <tr className="border-b border-[#262626]">
                <td className="py-2.5">
                  Keep day leases
                  <span className="block text-xs text-[#8A8A8A]">
                    {provider} {s.chip}
                  </span>
                </td>
                <td>{money(s.dayRate, s.currency)} / day*</td>
                <td>≈ {money(s.forecast.base * s.dayRate, s.currency)} / mo</td>
                <td className="text-[#FC8C45]">Ask again in 2 weeks</td>
              </tr>
              <tr>
                <td className="py-2.5">
                  Use my own Mac
                  <span className="block text-xs text-[#8A8A8A]">
                    Needs it awake and on power
                  </span>
                </td>
                <td>{money(0, s.currency).replace(/\.00$/, "")}</td>
                <td>{money(0, s.currency).replace(/\.00$/, "")}</td>
                <td className="text-[#FC8C45]">Agents run on your machine</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="space-y-2.5 sm:hidden">
          <div className="space-y-1 rounded-[10px] border border-[#2A3A55] bg-[#1A2230] px-3 py-2.5">
            <p className="text-[15px] font-medium text-[#EDEDED]">
              {rent ? "Rent a monthly Mac" : "Review cancellation"}{" "}
              <span className="inline-block rounded bg-[#1E2A3D] px-1.5 py-px text-xs font-normal text-[#7AA7FF]">
                Recommended
              </span>
            </p>
            <p className="text-sm text-[#A8A8A8]">
              {s.candidate.provider} {s.candidate.chip} {s.candidate.ramGB} GB ·{" "}
              {price}
            </p>
            <p className="text-sm text-[#A8A8A8]">
              {rent
                ? `Saves ≈ ${money(s.savings, s.currency)} / mo at this pace`
                : "Check your notice period first"}
            </p>
            <p className="pb-1 text-sm text-[#5BD08A]">
              {rent
                ? "Always ready for Mac work"
                : "Only you can cancel the contract"}
            </p>
            {action(primary, true)}
          </div>
          <div className="flex items-center gap-3 rounded-[10px] border border-[#262626] px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-[15px] text-[#EDEDED]">
                Keep day leases{" "}
                <span className="text-sm text-[#8A8A8A]">
                  {provider} {s.chip}
                </span>
              </p>
              <p className="text-sm text-[#A8A8A8]">
                {money(s.dayRate, s.currency)} / day*
              </p>
              <p className="text-sm text-[#FC8C45]">Ask again in 2 weeks</p>
            </div>
            <Button
              disabled={closed}
              variant="outline"
              onClick={() => choose("keep")}
            >
              Keep
            </Button>
          </div>
          <div className="flex items-center gap-3 rounded-[10px] border border-[#262626] px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-[15px] text-[#EDEDED]">
                Use my own Mac{" "}
                <span className="text-sm text-[#8A8A8A]">
                  {money(0, s.currency).replace(/\.00$/, "")}
                </span>
              </p>
              <p className="text-sm text-[#A8A8A8]">
                Needs it awake and on power
              </p>
              <p className="text-sm text-[#FC8C45]">
                Agents run on your machine
              </p>
            </div>
            <Button
              disabled={closed}
              variant="outline"
              onClick={() => choose("own")}
            >
              Use
            </Button>
          </div>
        </div>
        <p className="mt-2.5 text-xs leading-4 text-[#8A8A8A]">
          Harbormaster never rents or cancels anything.{" "}
          {rent
            ? `Rent opens ${s.candidate.provider}'s signup page; you review the terms and enroll the Mac yourself.`
            : "Review opens the provider's page. Drain work and check contract terms before you cancel."}{" "}
          Own-Mac setup guidance is coming.
        </p>
        <p className="mt-2 text-xs leading-4 text-[#6E6E6E]">
          *Actual average cost per lease-day · billed per second or hour after
          the minimum. Forecast: {Number(s.forecast.low.toFixed(1))}–
          {Number(s.forecast.high.toFixed(1))} days; base{" "}
          {Number(s.forecast.base.toFixed(1))}.{" "}
          <a
            href={s.candidate.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[#7AA7FF]"
          >
            Prices as of {s.candidate.asOf}
          </a>
          . Before tax and extras; confirm region, software and availability.
        </p>
        {s.alternatives.some((p) => p.currency !== s.currency) && (
          <p className="mt-2 text-xs text-[#8A8A8A]">
            Other currencies, no conversion:{" "}
            {s.alternatives
              .filter((p) => p.currency !== s.currency)
              .map(
                (p) =>
                  `${p.provider} ${p.chip}: ${money(p.monthlyPrice, p.currency)} / mo${p.billing === "hourly-estimate" ? " (hourly estimate)" : ""}`,
              )
              .join(" · ")}
            . No cross-currency savings estimate.
          </p>
        )}
        <div className="flex flex-col gap-2 pb-1 pt-3.5 sm:flex-row sm:items-center sm:pb-3.5">
          <div className="hidden flex-wrap gap-2 sm:flex">
            {action(primary)}
            {action("keep")}
            {action("own")}
          </div>
          {onAnswer && (
            <button
              onClick={onAnswer}
              className="py-1 text-center text-sm text-[#8A8A8A] sm:ml-auto sm:text-xs"
            >
              Answer in your own words
            </button>
          )}
        </div>
      </div>
    </Frame>
  );
}
export function LiveMonthlyMacCard({
  suggestion,
  threadId,
  project,
}: {
  suggestion: MonthlyMacSuggestion;
  threadId?: string;
  project?: string;
}) {
  const navigate = useBbNavigate();
  const fill = useFillComposer(threadId ?? "");
  const mutation = experimental_useRpcMutation({
    contract: rpcContract,
    method: "answerMonthlyMacSuggestion",
  });
  const [saved, setSaved] = useState(suggestion);
  useEffect(() => setSaved(suggestion), [suggestion]);
  const [own, setOwn] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <MonthlyMacCard
        suggestion={saved}
        project={project}
        onChoose={async (answer) => {
          if (busy || saved.answer) return;
          setBusy(true);
          try {
            // A URL is the only external action. Saving the receipt cannot allocate,
            // enroll or cancel anything. The SDK opens the system browser.
            if (
              (answer === "rent" || answer === "cancel") &&
              !navigate.openUrl(saved.candidate.signupUrl)
            )
              throw new Error("Could not open the provider page. Try again.");
            if (answer === "own") {
              setOwn(true);
              navigate.openUrl("https://github.com/scheinriese/bb-plugin-boat/blob/main/docs/settings.md#your-mac");
              toast("Set up Your Mac in Settings", {
                description:
                  "Use an isolated VM or a separate standard user, then add its SSH alias in Settings.",
              });
            }
            setSaved(
              (await mutation.mutate({ id: saved.id, answer })).suggestion,
            );
          } catch (error) {
            showError(error);
          } finally {
            setBusy(false);
          }
        }}
        onAnswer={
          fill
            ? () =>
                fill("I have a question about the monthly Mac suggestion.\n\n")
            : undefined
        }
      />
      {own && (
        <p role="status" className="px-3.5 text-sm text-[#A8A8A8]">
          Use an isolated VM or a separate standard user. Add its SSH alias in Settings → Your Mac and keep the execution account logged in on mains power.
        </p>
      )}
    </>
  );
}
export function MonthlyMacSuggestions() {
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "monthlyMacSuggestions",
    input: null,
  });
  return (
    <>
      {query.data?.suggestions.map((s) => (
        <LiveMonthlyMacCard key={s.id} suggestion={s} />
      ))}
    </>
  );
}
export function MonthlyMacDirective(props: PluginMessageDirectiveProps) {
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "monthlyMacSuggestion",
    input: { id: props.attributes.id ?? "" },
  });
  return query.data?.suggestion ? (
    <LiveMonthlyMacCard
      key={query.data.suggestion.id}
      suggestion={query.data.suggestion}
      threadId={props.message.threadId}
    />
  ) : null;
}
