// Boat CLI 1.0.92 `usage --json` prints SandboxUsageResponse verbatim.
// https://docs.boat.dev/api/reference/sandboxes/get-sandbox-usage
import { bool, num, rec, str, type JsonRecord } from "./cli.ts";
import type { SandboxUsage, UsagePlan } from "../types.ts";

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
export function parseUsagePlan(raw: JsonRecord): UsagePlan {
  const included = rec(raw.planIncluded);
  if (!included) return null;
  return { name: str(raw.planName) ?? str(raw.accessTier), hoursRemaining: nonnegative(included.vmHoursRemaining), hoursTotal: nonnegative(included.vmHours), resetsAt: instant(included.periodEnd) };
}
