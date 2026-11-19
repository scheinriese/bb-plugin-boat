// A sandbox's machine time and cost, and the windows the usage view sums
// (the provider reads them: boat usage, src/providers/boat/usage.ts).
export interface SandboxUsage {
  seconds: number | null; hours: number | null; dollars: number | null;
  since: string | null; until: string | null; running: boolean | null;
}
/** Offset follows JS Date.getTimezoneOffset(), including its sign. */
export function usageWindows(now: Date, offsetMinutes = 0): { day: { since: string; until: string }; week: { since: string; until: string } } {
  const shifted = new Date(now.getTime() - offsetMinutes * 60_000);
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) + offsetMinutes * 60_000;
  const monday = midnight - ((shifted.getUTCDay() + 6) % 7) * 86_400_000;
  return { day: { since: new Date(midnight).toISOString(), until: now.toISOString() }, week: { since: new Date(monday).toISOString(), until: now.toISOString() } };
}
