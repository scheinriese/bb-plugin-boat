import { useState } from "react";
import { experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { rpcContract, type TaskDto } from "../contract";
import { providerFailureCard, type ProviderFailure } from "../provider-failure";
import { INSTABOX_SECRETS_URL, SecretDetails } from "./provider-setup";
import { useCloudAgentsNavigation } from "./hooks";
import { showError } from "./ui";
export function ProviderFailureCard({
  failure,
  message,
  onCheck,
  onRetry,
  onLog,
  busy = false,
}: {
  failure: ProviderFailure;
  message?: string;
  onCheck?: () => void;
  onRetry?: () => void;
  onLog?: () => void;
  busy?: boolean;
}) {
  const card = providerFailureCard(failure, message);
  if (!card) return null;
  const owner = card.tone === "owner",
    broken = card.tone === "broken";
  const primary =
    "rounded-md bg-[#E6E6E6] px-3 py-[5px] text-xs font-medium text-[#141414] max-sm:w-full max-sm:py-2 max-sm:text-sm disabled:opacity-60";
  const secondary =
    "rounded-md border border-[#333333] px-3 py-[5px] text-xs text-[#D0D0D0] max-sm:flex-1 max-sm:py-2 max-sm:text-sm disabled:opacity-60";
  return (
    <section
      role={broken ? "alert" : "status"}
      className={`boat-ui my-3 max-w-[720px] space-y-3 rounded-[10px] border bg-[#181818] px-3.5 py-3 max-sm:rounded-xl max-sm:px-3 ${owner ? "border-[#3D3420]" : broken ? "border-[#3A2424]" : "border-[#2A2A2A]"}`}
      aria-label={card.title}
    >
      <div
        className={`hidden items-center gap-2 text-[13px] max-sm:flex ${owner ? "text-[#F0B135]" : broken ? "text-[#E06C6C]" : "text-[#A8A8A8]"}`}
      >
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
        {owner
          ? "Needs you"
          : broken
            ? "Something went wrong"
            : "Provider unavailable"}
        <span className="text-[#6E6E6E]">
          {failure.provider === "instabox" ? "Instabox" : "Scaleway"} setup
        </span>
      </div>
      <div className="flex gap-3">
        <span
          aria-hidden
          className={`mt-0.5 text-sm max-sm:hidden ${owner ? "text-[#F0B135]" : broken ? "text-[#E06C6C]" : "text-[#A8A8A8]"}`}
        >
          <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.2">{card.kind==="github" ? <><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></> : card.kind==="key" ? <><circle cx="5" cy="5" r="3"/><path d="m7 7 7 7m-2-2 2-2m-4 0 2-2"/></> : card.kind==="capacity" ? <path d="M3 3h10v7H3zM1 13h14"/> : <><circle cx="8" cy="8" r="6"/><path d="M8 4v5m0 2v1"/></>}</svg>
        </span>
        <div className="min-w-0 space-y-1">
          <h3 className="text-[13px] font-medium leading-5 text-[#EDEDED] max-sm:text-base max-sm:leading-[22px]">
            {card.title}
          </h3>
          <p className="text-xs leading-4 text-[#8A8A8A] max-sm:text-sm max-sm:leading-5">
            {card.body}
          </p>
        </div>
      </div>
      {card.kind === "github" && (
        <div className="sm:ml-[26px]">
          <SecretDetails />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 sm:pl-[26px]">
        {card.kind === "github" && (
          <a
            className={primary}
            href={INSTABOX_SECRETS_URL}
            target="_blank"
            rel="noreferrer"
          >
            Open Instabox Secrets ↗
          </a>
        )}
        {card.kind === "key" && (
          <a className={primary} href="/settings/plugins/boat">
            Replace key in bb secrets
          </a>
        )}
        {owner && onCheck && (
          <button
            type="button"
            disabled={busy}
            className={secondary}
            onClick={onCheck}
          >
            Check again
          </button>
        )}
        {onLog && card.kind === "failed" && (
          <button type="button" className={secondary} onClick={onLog}>
            Open log
          </button>
        )}
        {failure.canRetry && onRetry && (
          <button
            type="button"
            disabled={busy}
            className={card.kind === "failed" ? primary : secondary}
            onClick={onRetry}
          >
            {card.kind === "capacity" ? "Try now" : "Retry"}
          </button>
        )}
        {card.kind === "fresh" && (
          <a className={primary} href="/settings/plugins/boat">
            Set up an Instabox Mac
          </a>
        )}
      </div>
    </section>
  );
}
export function TaskProviderFailure({ task }: { task: TaskDto }) {
  const check = experimental_useRpcMutation({
    contract: rpcContract,
    method: "checkSandboxProviders",
  });
  const retry = experimental_useRpcMutation({
    contract: rpcContract,
    method: "retryProviderStart",
  });
  const { openTask } = useCloudAgentsNavigation();
  const [checked, setChecked] = useState(false);
  if (
    !task.providerFailure ||
    !providerFailureCard(task.providerFailure, task.error ?? "")
  )
    return null;
  return (
    <>
      <ProviderFailureCard
        failure={task.providerFailure}
        message={task.error ?? ""}
        busy={check.isPending || retry.isPending}
        onCheck={() =>
          void check
            .mutate(null)
            .then((result) => {
              setChecked(true);
              const row = result.providers.find(
                (p) => p.id === task.providerFailure!.provider,
              );
              if (
                task.providerFailure!.canRetry &&
                row?.steps?.filter((s) => s.possible).every((s) => s.done)
              )
                return retry.mutate({ id: task.id }).then((result) => {
                  if ("task" in result) openTask(result.task.id);
                });
            })
            .catch(showError)
        }
        onRetry={() =>
          void retry
            .mutate({ id: task.id })
            .then((result) => {
              if ("task" in result) openTask(result.task.id);
            })
            .catch(showError)
        }
        onLog={() => openTask(task.id)}
      />
      {checked && (
        <p className="text-xs text-[#A8A8A8]">
          Checks updated. Retry the task when setup is complete.
        </p>
      )}
    </>
  );
}
