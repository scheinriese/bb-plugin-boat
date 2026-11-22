import type { ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { LinuxUsageDto, MacUsageDto } from "../contract-providers";
import type { SandboxDto, TaskDto } from "../contract";
import { ownMacStatusWords } from "../contract-ownmac";
import {
  useCloudAgentsNavigation,
  type useSandboxes,
  type useSandboxProviders,
} from "./hooks";
import {
  creditDifference,
  leaseBreakdownNote,
  machineCounts,
  readingStatus,
} from "./sandboxes-usage-logic";
import { hours, money, resetDate } from "./provider-format";
import { formatLeaseDays } from "./mac-usage-logic";

type Read<T> = {
  data?: T;
  error?: { message: string } | null;
  isLoading?: boolean;
};
type Snapshots = {
  snapshots: {
    name: string;
    provider?: string;
    status?: string | null;
    type?: string | null;
  }[];
  error: string | null;
  observedAt?: string | null;
  complete?: boolean;
};
type Plan = {
  name: string | null;
  hoursRemaining: number | null;
  hoursTotal: number | null;
  resetsAt?: string | null;
};
const heading =
  "text-sm font-semibold leading-5 tracking-normal text-[color:var(--boat-content)]";
const card = "rounded-xl border border-border";
const muted = "text-muted-foreground";

function Heading({
  children,
  checked,
}: {
  children: ReactNode;
  checked?: string;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 className={heading}>{children}</h2>
      {checked && (
        <span className="text-xs leading-4 text-muted-foreground">
          {checked}
        </span>
      )}
    </div>
  );
}

function Meter({
  fraction,
  caution = false,
}: {
  fraction: number;
  caution?: boolean;
}) {
  return (
    <div
      className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
      aria-hidden
    >
      <div
        className={
          caution
            ? "h-full rounded-full bg-[color:var(--sandboxes-warning)]"
            : "h-full rounded-full bg-[color:var(--sandboxes-link)]"
        }
        style={{ width: `${Math.max(0, Math.min(100, fraction * 100))}%` }}
      />
    </div>
  );
}

function AccountUsage({
  label,
  usage,
  mac,
  macFailed,
  failed,
  now,
}: {
  label: string;
  usage?: LinuxUsageDto;
  mac?: MacUsageDto;
  macFailed: boolean;
  failed: boolean;
  now: number;
}) {
  const currency = usage?.currency ?? "USD";
  const used = usage?.used ?? null,
    credit = usage?.credit ?? null;
  const difference = creditDifference(used, credit);
  const providers =
    mac?.byProvider?.filter((provider) => provider.id === "instabox") ?? [];
  const breakdown = providers.flatMap((provider) =>
    Object.entries(provider.month.costs).map(([code, amount]) => ({
      code,
      amount,
      days: provider.month.leaseDays,
    })),
  );
  return (
    <article className={`${card} p-3.5`} aria-label={`${label} account usage`}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-[15px] font-medium leading-5">{label} account</h3>
        <p className="text-xs leading-4 text-muted-foreground">
          {[
            usage?.plan,
            usage?.resetsAt
              ? `resets ${resetDate(usage.resetsAt)}`
              : "Period unavailable",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      {used !== null ? (
        <>
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <strong className="text-[22px] font-semibold leading-7">
              {money(used, currency)} {currency}
            </strong>
            <span className={muted}>
              {credit === null
                ? "used"
                : `used of ${money(credit, currency)} credit`}
            </span>
          </p>
          {credit !== null && credit > 0 && (
            <Meter
              fraction={used / credit}
              caution={difference !== null && difference > 0}
            />
          )}
          {difference !== null && (
            <p
              className={`mt-2 ${difference > 0 ? "text-[color:var(--sandboxes-warning)]" : muted}`}
            >
              {money(Math.abs(difference), currency)}{" "}
              {difference > 0 ? "over credit" : "credit left"}
            </p>
          )}
        </>
      ) : (
        <p className="text-muted-foreground" role="status">
          {label} usage unavailable
        </p>
      )}
      {(usage?.includesMacs || breakdown.length > 0) && (
        <div className="mt-3.5 rounded-lg border border-border p-3 text-[13px] leading-[18px]">
          <p className="mb-2 text-xs leading-4 text-muted-foreground">
            {usage?.includesMacs
              ? "Mac charges are included in the account total"
              : "Mac lease estimate · account attribution unavailable"}
          </p>
          {breakdown.length === 0 ? (
            <p className={muted}>
              {mac && !macFailed
                ? "No Mac lease estimate recorded this calendar month."
                : "Mac lease estimate unavailable."}
            </p>
          ) : (
            breakdown.map((item) => (
              <div key={item.code} className="mb-2 last:mb-0">
                <div className="flex items-baseline justify-between gap-3">
                  <span>Mac rentals</span>
                  <span className="shrink-0">
                    {money(item.amount, item.code)} {item.code}
                  </span>
                </div>
                <p className={muted}>
                  {formatLeaseDays(item.days)} · Harbormaster estimate ·
                  calendar month
                </p>
                <p className={`mt-1 text-xs leading-4 ${muted}`}>
                  {leaseBreakdownNote(usage, item.code)} This estimate is not an
                  additional charge.
                </p>
              </div>
            ))
          )}
          <p className="mt-2 text-xs leading-4 text-muted-foreground">
            Local estimate · {readingStatus(mac?.calculatedAt, now, macFailed)}.
            Based on recorded leases.
          </p>
        </div>
      )}
      <div className="mt-3.5">
        <div className="flex justify-between gap-3">
          <span>Linux running time</span>
          <span className="shrink-0">
            {usage?.hours == null ? "Unavailable" : `${hours(usage.hours)} h`}
          </span>
        </div>
        <p className="text-xs leading-4 text-muted-foreground">
          {usage?.hoursScope === "running-machines"
            ? "Only machines running now; not a cost"
            : usage?.hoursScope === "period"
              ? "This billing period; not a cost"
              : "Time scope unavailable; not a cost"}
        </p>
      </div>
      <p
        className={`mt-3 border-t border-border pt-3 text-xs leading-[18px] ${failed || usage?.error || (usage?.observedAt && now - Date.parse(usage.observedAt) > 600_000) ? "text-[color:var(--sandboxes-warning)]" : muted}`}
      >
        {label} usage ·{" "}
        {readingStatus(
          usage?.observedAt,
          now,
          failed || !usage || Boolean(usage?.error),
        )}
        . Not an invoice.
      </p>
    </article>
  );
}

export function SandboxesUsage({
  inventory,
  providers,
  mac,
  snapshots,
  tasks,
  plan,
  planObservedAt,
  planFailed,
  now,
  children,
}: {
  inventory: ReturnType<typeof useSandboxes>;
  providers: ReturnType<typeof useSandboxProviders>;
  mac: Read<MacUsageDto>;
  snapshots: Read<Snapshots>;
  tasks: readonly TaskDto[];
  plan?: Plan | null;
  planObservedAt?: string | null;
  planFailed: boolean;
  now: number;
  children?: ReactNode;
}) {
  const { openTask } = useCloudAgentsNavigation();
  const navigate = useBbNavigate();
  const data = inventory.data;
  const configured =
    providers.data?.providers.filter(
      (provider) =>
        provider.kind === "cloud" && (provider.enabled || provider.linuxUsage),
    ) ?? [];
  const nativeProvider = (id: string) =>
    id === "ownmac" ||
    id === "monthly-mac" ||
    providers.data?.providers.some(
      (provider) => provider.id === id && provider.kind !== "cloud",
    );
  const ids = Array.from(
    new Set([
      "boat",
      ...configured.map((provider) => provider.id),
      ...(data?.inventory?.providers.map((provider) => provider.id) ?? []),
      ...(data?.sandboxes.map(
        (sandbox) => sandbox.runsOn?.provider ?? "boat",
      ) ?? []),
      ...(data?.macLeases?.map((lease) => lease.provider) ?? []),
    ]),
  ).filter((id) => !nativeProvider(id));
  const providerName = (id: string) =>
    providers.data?.providers.find((provider) => provider.id === id)?.label ??
    { boat: "boat.dev", instabox: "Instabox", scaleway: "Scaleway" }[id] ??
    "Provider";
  const completeFor = (id: string) =>
    !inventory.error &&
    data?.inventory?.providers.some(
      (provider) =>
        provider.id === id &&
        provider.status === "fresh" &&
        !provider.truncated,
    ) === true;
  const machines = (id: string, os: string) =>
    data?.sandboxes.filter(
      (sandbox) =>
        (sandbox.runsOn?.provider ?? "boat") === id &&
        (sandbox.runsOn?.os ?? "linux") === os,
    ) ?? [];
  const counts = (id: string, os: string) =>
    machineCounts(machines(id, os), completeFor(id));
  const instaboxLinux = counts("instabox", "linux"),
    instaboxMac = counts("instabox", "macos");
  const instaboxExact = instaboxLinux.exact && instaboxMac.exact;
  const instaboxOn = instaboxLinux.on + instaboxMac.on;
  const observed = data?.inventory?.providers
    .map((provider) => provider.observedAt)
    .filter((at): at is string => Boolean(at))
    .sort()[0];
  function taskLinks(sandbox: SandboxDto) {
    return sandbox.uses
      .filter((use) => use.open)
      .slice(0, 5)
      .map((use) => (
        <button
          key={`${use.kind}:${use.id}`}
          type="button"
          className="flex min-h-11 items-center text-left text-[color:var(--sandboxes-link)] hover:underline"
          onClick={() =>
            use.kind === "task" ? openTask(use.id) : navigate.toThread(use.id)
          }
        >
          {use.kind === "task" ? "For " : "Chat: "}
          {use.title ||
            (use.kind === "orchestrator" ? "Orchestrator" : "Open task")}
        </button>
      ));
  }
  return (
    <div className="sandboxes-summary space-y-7 text-sm leading-5 tabular-nums">
      <section aria-label="Running now">
        <Heading
          checked={readingStatus(
            observed,
            now,
            Boolean(inventory.error || data?.error),
          )}
        >
          Running now
        </Heading>
        <h1 className="mb-1 text-xl font-semibold leading-[26px]">
          {!data
            ? inventory.error
              ? "Machine status unavailable"
              : "Checking machines…"
            : ids.includes("instabox")
              ? instaboxExact
                ? `${observed && now - Date.parse(observed) > 600_000 ? "Last known: " : ""}${instaboxOn === 0 ? "No" : instaboxOn} Instabox machine${instaboxOn === 1 ? "" : "s"} running`
                : "Instabox machine status incomplete"
              : "Current machines"}
        </h1>
        <p className="mb-3 text-muted-foreground">
          Powered-on guests include idle machines. Lease ownership and billing
          usage are shown separately.
        </p>
        <div className={`${card} divide-y divide-border`}>
          {ids.flatMap((id) =>
            (id === "boat" ? ["linux"] : ["linux", "macos"]).map((os) => {
              const rows = machines(id, os),
                count = counts(id, os);
              const leases =
                data?.macLeases?.filter((lease) => lease.provider === id) ?? [];
              const held =
                os === "macos"
                  ? leases.filter((lease) => lease.state === "held")
                  : [];
              const ended =
                os === "macos"
                  ? leases
                      .filter((lease) => lease.state !== "held")
                      .sort((a, b) =>
                        (b.endedAt ?? "").localeCompare(a.endedAt ?? ""),
                      )[0]
                  : undefined;
              const enabled = configured.some(
                (provider) => provider.id === id && provider.enabled,
              );
              if (
                os === "macos" &&
                id !== "instabox" &&
                rows.length === 0 &&
                leases.length === 0 &&
                held.length === 0
              )
                return null;
              return (
                <div
                  key={`${id}:${os}`}
                  className="grid grid-cols-[minmax(0,1fr)_64px] gap-x-3 px-3.5 py-3"
                >
                  <div className="min-w-0 break-words">
                    <p className="text-[15px] leading-5">
                      {providerName(id)} · {os === "macos" ? "Mac" : "Linux"}
                    </p>
                    <p className="text-[13px] leading-[18px] text-muted-foreground">
                      {!data
                        ? inventory.error
                          ? "Status unavailable"
                          : "Checking…"
                        : !enabled &&
                            !data.inventory?.providers.some(
                              (provider) => provider.id === id,
                            )
                          ? "Provider off · current status unavailable"
                          : !count.exact
                            ? "Inventory incomplete · current count unknown"
                            : os === "linux" && id === "boat"
                              ? "Included in plan hours"
                              : count.on === 0 && count.stopped === 0
                                ? "None running or stopped"
                                : `${count.stopped} stopped${count.unknown ? ` · ${count.unknown} status unknown` : ""}`}
                    </p>
                    {count.unknown > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Starting or power state unknown: {count.unknown}
                      </p>
                    )}
                    {rows.map((sandbox) => (
                      <div key={sandbox.id}>
                        {taskLinks(sandbox)}
                        {sandbox.power === "off" && (
                          <p className="text-xs text-muted-foreground">
                            Guest stopped ·{" "}
                            {os === "macos"
                              ? "lease may still be held"
                              : "files retained"}
                          </p>
                        )}
                      </div>
                    ))}
                    {rows.some(
                      (sandbox) =>
                        sandbox.power === "on" &&
                        !sandbox.uses.some((use) => use.open),
                    ) && (
                      <p className="text-xs text-muted-foreground">
                        {
                          rows.filter(
                            (sandbox) =>
                              sandbox.power === "on" &&
                              !sandbox.uses.some((use) => use.open),
                          ).length
                        }{" "}
                        on · no linked chat or task
                      </p>
                    )}
                    {held.map((lease) => (
                      <div
                        key={lease.machineId}
                        className="text-xs leading-[18px] text-muted-foreground"
                      >
                        Recorded lease held ·{" "}
                        {money(lease.minimumCost, lease.currency)}{" "}
                        {lease.currency} minimum commitment through{" "}
                        {new Date(lease.paidUntil).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          timeZoneName: "short",
                        })}{" "}
                        · then {money(lease.hourPrice, lease.currency)} / h.{" "}
                        {lease.kept && "Kept · automatic hand-back off. "}
                        {lease.releaseAt
                          ? `Release scheduled ${new Date(lease.releaseAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}.`
                          : ""}
                        {lease.taskIds
                          .filter(
                            (id) =>
                              !rows.some((sandbox) =>
                                sandbox.uses.some(
                                  (use) =>
                                    use.kind === "task" &&
                                    use.id === id &&
                                    use.open,
                                ),
                              ),
                          )
                          .map((id) => (
                            <button
                              key={id}
                              type="button"
                              className="flex min-h-11 items-center text-left text-sm text-[color:var(--sandboxes-link)] hover:underline"
                              onClick={() => openTask(id)}
                            >
                              For{" "}
                              {tasks.find((task) => task.id === id)?.title ||
                                "Open task"}
                            </button>
                          ))}
                      </div>
                    ))}
                    {ended && held.length === 0 && (
                      <>
                        <p className="text-[13px] leading-[18px] text-muted-foreground">
                          {ended.state === "returned"
                            ? "Last Mac handed back"
                            : "Last lease ended locally; return unverified"}
                          {ended.endedAt
                            ? ` ${new Date(ended.endedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}`
                            : ""}
                          . Final billing unconfirmed.
                        </p>
                        {ended.taskIds.map((id) => (
                          <button
                            key={id}
                            type="button"
                            className="flex min-h-11 items-center text-left text-[color:var(--sandboxes-link)] hover:underline"
                            onClick={() => openTask(id)}
                          >
                            Was for{" "}
                            {tasks.find((task) => task.id === id)?.title ||
                              "Open task"}
                          </button>
                        ))}
                      </>
                    )}
                    {data?.macLeasesTruncated && os === "macos" && (
                      <p className="text-xs text-muted-foreground">
                        Lease history incomplete.
                      </p>
                    )}
                  </div>
                  <div
                    className="min-w-[48px] self-center text-right text-[15px] text-muted-foreground"
                    aria-label={`${providerName(id)} ${os} powered on`}
                  >
                    {!data || !count.exact ? (
                      "—"
                    ) : count.on > 0 ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          aria-hidden
                          className="size-1.5 shrink-0 rounded-full bg-[color:var(--sandboxes-on)]"
                        />
                        {count.on} on
                      </span>
                    ) : (
                      "0"
                    )}
                  </div>
                </div>
              );
            }),
          )}
          {mac.data?.ownMac?.enabled && (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 p-3.5">
              <div>
                <p>Your Mac</p>
                <p className="text-xs text-muted-foreground">
                  {ownMacStatusWords(mac.data.ownMac)} · $0 rent
                </p>
              </div>
              <span className="self-center text-xs text-muted-foreground">
                {readingStatus(mac.data.ownMac.checkedAt, now)}
              </span>
            </div>
          )}
          {providers.data?.providers
            .filter(
              (provider) => provider.kind === "monthly-mac" && provider.enabled,
            )
            .map((provider) => (
              <div key={provider.id} className="p-3.5">
                <p>{provider.label}</p>
                <p className="text-xs text-muted-foreground">
                  {provider.status || "Status unavailable"} · task environments,
                  physical machine count unavailable
                </p>
              </div>
            ))}
        </div>
      </section>
      <section aria-label="This billing period">
        <Heading>This billing period</Heading>
        <div className="space-y-2.5">
          {configured
            .filter((provider) => provider.id === "instabox")
            .map((provider) => (
              <AccountUsage
                key={provider.id}
                label={provider.label}
                usage={provider.linuxUsage}
                mac={mac.data}
                macFailed={Boolean(mac.error)}
                failed={Boolean(providers.error)}
                now={now}
              />
            ))}
          {!providers.data && (
            <article className={`${card} p-3.5 text-muted-foreground`}>
              {providers.error
                ? "Provider usage unavailable"
                : "Checking provider usage…"}
            </article>
          )}
          {mac.data?.byProvider
            ?.filter(
              (provider) =>
                provider.id !== "instabox" &&
                Object.keys(provider.month.costs).length > 0,
            )
            .flatMap((provider) =>
              Object.entries(provider.month.costs).map(([currency, amount]) => (
                <article
                  key={`${provider.id}:${currency}`}
                  className={`${card} p-3.5`}
                >
                  <h3 className="text-[15px] font-medium">
                    Mac · {provider.label}
                  </h3>
                  <p className="mt-2">
                    <strong className="text-xl">
                      {money(amount, currency)} {currency}
                    </strong>{" "}
                    lease estimate
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Calendar month · {formatLeaseDays(provider.month.leaseDays)}{" "}
                    · Harbormaster estimate. Provider account total unavailable;
                    unreconciled. Not an invoice.
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Local estimate ·{" "}
                    {readingStatus(
                      mac.data?.calculatedAt,
                      now,
                      Boolean(mac.error),
                    )}
                    . Based on recorded leases.
                  </p>
                </article>
              )),
            )}
          <article className={`${card} p-3.5`} aria-label="boat.dev plan usage">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[15px] font-medium">boat.dev plan</h3>
              <p className="text-xs text-muted-foreground">
                {[
                  plan?.name,
                  plan?.resetsAt
                    ? `resets ${resetDate(plan.resetsAt)}`
                    : "Period unavailable",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            {plan?.hoursTotal != null && plan.hoursRemaining != null ? (
              <>
                <p className="text-muted-foreground">
                  <strong className="text-lg font-semibold text-foreground">
                    {hours(Math.max(0, plan.hoursTotal - plan.hoursRemaining))}{" "}
                    h
                  </strong>{" "}
                  used of {hours(plan.hoursTotal)} h ·{" "}
                  {hours(plan.hoursRemaining)} h left
                </p>
                {plan.hoursTotal > 0 && (
                  <Meter
                    fraction={
                      (plan.hoursTotal - plan.hoursRemaining) / plan.hoursTotal
                    }
                  />
                )}
              </>
            ) : (
              <p className="text-muted-foreground">
                {planFailed ? "Plan usage unavailable" : "Checking plan usage…"}
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              {readingStatus(planObservedAt, now, planFailed)}
            </p>
          </article>
        </div>
      </section>
      <section aria-label="Saved, not running">
        <Heading>Saved, not running</Heading>
        <div className={`${card} divide-y divide-border`}>
          {!snapshots.data ? (
            <p className="p-3.5 text-muted-foreground">
              {snapshots.error
                ? "Snapshots unavailable"
                : "Checking snapshots…"}
            </p>
          ) : (
            <>
              {snapshots.data.snapshots.map((snapshot, index) => (
                <div
                  key={`${snapshot.provider}:${snapshot.name}:${index}`}
                  className="p-3.5"
                >
                  <p className="text-[15px]">
                    Saved snapshot · {providerName(snapshot.provider ?? "boat")}
                  </p>
                  <p className="text-[13px] leading-[18px] text-muted-foreground">
                    {snapshot.status === "ready"
                      ? "Ready to reuse"
                      : snapshot.status
                        ? `Provider status: ${snapshot.status}`
                        : "Readiness unavailable"}{" "}
                    · starting from it not tested yet
                  </p>
                </div>
              ))}
              {snapshots.data.snapshots.length === 0 &&
                !snapshots.data.error && (
                  <p className="p-3.5 text-muted-foreground">
                    No saved snapshots
                  </p>
                )}
              {(snapshots.error ||
                snapshots.data.error ||
                snapshots.data.complete === false) && (
                <p className="p-3.5 text-muted-foreground">
                  Snapshot inventory incomplete; some providers unavailable.
                </p>
              )}
              <p className="px-3.5 py-2 text-xs text-muted-foreground">
                {readingStatus(
                  snapshots.data.observedAt,
                  now,
                  Boolean(snapshots.error || snapshots.data.error),
                )}
                . Snapshots do not count as machines.
              </p>
            </>
          )}
        </div>
      </section>
      {children}
    </div>
  );
}
