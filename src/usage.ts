// Boat CLI 1.0.92 `usage --json` prints SandboxUsageResponse verbatim.
// https://docs.boat.dev/api/reference/sandboxes/get-sandbox-usage
import { bool, num, rec, str, type JsonRecord } from "./boat.ts";
import type { FidelityUsageDto } from "../contract-fidelity.ts";

export interface SandboxUsage {
  seconds: number | null; hours: number | null; dollars: number | null;
  since: string | null; until: string | null; running: boolean | null;
}
function nonnegative(value: unknown): number | null {
  const n = num(value); return n !== null && Number.isFinite(n) && n >= 0 ? n : null;
}
function instant(value: unknown): string | null {
  const text = str(value); return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}
export function parseSandboxUsage(raw: JsonRecord): SandboxUsage {
  const seconds = nonnegative(raw.seconds);
  return { seconds, hours: seconds === null ? null : seconds / 3600, dollars: nonnegative(raw.dollars), since: instant(raw.since), until: instant(raw.until), running: bool(raw.running) };
}
export function parseUsagePlan(raw: JsonRecord): FidelityUsageDto["plan"] {
  const included = rec(raw.planIncluded);
  if (!included) return null;
  return { name: str(raw.planName) ?? str(raw.accessTier), hoursRemaining: nonnegative(included.vmHoursRemaining), hoursTotal: nonnegative(included.vmHours), resetsAt: instant(included.periodEnd) };
}
/** Offset follows JS Date.getTimezoneOffset(), including its sign. */
export function usageWindows(now: Date, offsetMinutes = 0): { day: { since: string; until: string }; week: { since: string; until: string } } {
  const shifted = new Date(now.getTime() - offsetMinutes * 60_000);
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) + offsetMinutes * 60_000;
  const monday = midnight - ((shifted.getUTCDay() + 6) % 7) * 86_400_000;
  return { day: { since: new Date(midnight).toISOString(), until: now.toISOString() }, week: { since: new Date(monday).toISOString(), until: now.toISOString() } };
}
