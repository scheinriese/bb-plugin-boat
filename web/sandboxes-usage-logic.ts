import type { LinuxUsageDto } from "../contract-providers.ts";
import type { SandboxDto } from "../contract.ts";

export const READING_STALE_MS = 10 * 60_000;

/** Successful observations retain their time; a failed refresh never renews it. */
export function readingStatus(
  observedAt: string | null | undefined,
  now: number,
  failed = false,
): string {
  const at = observedAt ? Date.parse(observedAt) : NaN;
  if (!Number.isFinite(at)) return failed ? "Unavailable" : "Not checked yet";
  const time = new Date(at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  return `${failed || now - at > READING_STALE_MS ? "Stale: last checked" : "Checked"} ${time}`;
}

/** These are guest power facts, not task activity or lease ownership. */
export function machineCounts(
  machines: readonly Pick<SandboxDto, "power" | "state">[],
  complete: boolean,
) {
  const on = machines.filter((machine) => machine.power === "on").length;
  const stopped = machines.filter(
    (machine) =>
      machine.power === "off" &&
        !["deleted", "destroyed", "cancelled"].includes(machine.state),
  ).length;
  const unknown = machines.filter(
    (machine) => machine.power !== "on" && machine.power !== "off",
  ).length;
  return { on, stopped, unknown, exact: complete && unknown === 0 };
}

/** Never reconcile a calendar-month lease estimate with an unbound provider account. */
export function leaseBreakdownNote(
  usage:
    | Pick<LinuxUsageDto, "periodStart" | "periodEnd" | "currency">
    | undefined,
  currency: string,
): string {
  if (!usage || usage.currency !== currency)
    return "Unreconciled: a matching provider account total and currency are unavailable.";
  if (!usage.periodStart || !usage.periodEnd)
    return "Unreconciled: the provider billing period is unavailable.";
  return "Unreconciled: the lease estimate uses a calendar month; the provider account match is unverified.";
}

export function creditDifference(
  used: number | null,
  credit: number | null,
): number | null {
  return used === null || credit === null ? null : used - credit;
}
