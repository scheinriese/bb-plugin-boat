// One dated catalog; owners may replace it with monthlyMacPricesJson. No FX.
import {
  monthlyMacPricesSchema,
  type MonthlyMacPrice,
} from "../contract-monthly-macs.ts";
export const MONTHLY_MAC_PRICES: readonly MonthlyMacPrice[] =
  monthlyMacPricesSchema.parse([
    {
      id: "hostmyapple-m1",
      provider: "HostMyApple",
      model: "Mac mini M1",
      chip: "M1",
      ramGB: 16,
      monthlyPrice: 84.99,
      currency: "USD",
      signupUrl: "https://www.hostmyapple.com/dedicated-mac-hosting",
      sourceUrl: "https://www.hostmyapple.com/dedicated-mac-hosting",
      asOf: "2026-11-20",
      available: true,
      billing: "monthly",
    },
    {
      id: "hostmyapple-m4",
      provider: "HostMyApple",
      model: "Mac mini M4",
      chip: "M4",
      ramGB: 16,
      monthlyPrice: 119.99,
      currency: "USD",
      signupUrl: "https://www.hostmyapple.com/dedicated-mac-hosting",
      sourceUrl: "https://www.hostmyapple.com/dedicated-mac-hosting",
      asOf: "2026-11-20",
      available: true,
      billing: "monthly",
    },
    {
      id: "macstadium-m4",
      provider: "MacStadium",
      model: "M4.S Mac mini",
      chip: "M4",
      ramGB: 16,
      monthlyPrice: 149,
      currency: "USD",
      signupUrl: "https://macstadium.com/pricing",
      sourceUrl: "https://macstadium.com/pricing",
      asOf: "2026-11-20",
      available: true,
      billing: "monthly",
    },
    {
      id: "macincloud-m4",
      provider: "MacinCloud",
      model: "Dedicated M4",
      chip: "M4",
      ramGB: 16,
      monthlyPrice: 164,
      currency: "USD",
      signupUrl: "https://checkout.macincloud.com/select/dedicated",
      sourceUrl: "https://www.macincloud.com/pages/dedicated.html",
      asOf: "2026-11-20",
      available: true,
      billing: "monthly",
    },
    {
      id: "oakhost-m4",
      provider: "OakHost",
      model: "Mac M4.S",
      chip: "M4",
      ramGB: 16,
      monthlyPrice: 115,
      currency: "EUR",
      signupUrl: "https://www.oakhost.com/mac-mini-hosting",
      sourceUrl: "https://www.oakhost.com/mac-mini-hosting",
      asOf: "2026-11-20",
      available: false,
      billing: "monthly",
    },
    {
      id: "scaleway-m4",
      provider: "Scaleway",
      model: "Mac mini M4-S",
      chip: "M4",
      ramGB: 16,
      monthlyPrice: 149,
      currency: "EUR",
      signupUrl: "https://account.scaleway.com/register",
      sourceUrl: "https://www.scaleway.com/en/pricing/apple-silicon/",
      asOf: "2026-11-20",
      available: true,
      billing: "hourly-estimate",
    },
  ]);
export function monthlyMacPrices(json: string): MonthlyMacPrice[] {
  return json.trim()
    ? monthlyMacPricesSchema.parse(JSON.parse(json))
    : [...MONTHLY_MAC_PRICES];
}
/** A newer base chip is not assumed to replace a Pro, Max or Ultra. */
export function chipMeets(candidate: string, required: string): boolean {
  const parse = (chip: string) => /^(M)(\d+)(?: (Pro|Max|Ultra))?$/.exec(chip);
  const a = parse(candidate),
    b = parse(required);
  const tiers = [undefined, "Pro", "Max", "Ultra"];
  return Boolean(
    a &&
    b &&
    Number(a[2]) >= Number(b[2]) &&
    tiers.indexOf(a[3]) >= tiers.indexOf(b[3]),
  );
}
export function leaseChip(size: string): string | null {
  // Scaleway catalog sizes are SKUs, not chip names: M2-L and M4-XL are
  // Pro chips. Never drop an unknown SKU suffix and assume a base chip.
  const scaleway: Record<string, string> = {
    "M1-M": "M1",
    "M2-M": "M2",
    "M2-L": "M2 Pro",
    "M4-S": "M4",
    "M4-SP": "M4",
    "M4-M": "M4",
    "M4-XL": "M4 Pro",
  };
  if (scaleway[size.toUpperCase()]) return scaleway[size.toUpperCase()]!;
  const match = /^m(\d+)(?:[-_ ]?(pro|max|ultra))?$/i.exec(size);
  return match
    ? `M${match[1]}${match[2] ? ` ${match[2][0]!.toUpperCase()}${match[2].slice(1).toLowerCase()}` : ""}`
    : null;
}
/** A stable display order, separate from the partial hardware eligibility relation. */
export function compareChips(a: string, b: string): number {
  const parts = (chip: string) => /M(\d+)(?: (Pro|Max|Ultra))?/.exec(chip)!;
  const x = parts(a),
    y = parts(b);
  const tiers = [undefined, "Pro", "Max", "Ultra"];
  return (
    Number(x[1]) - Number(y[1]) || tiers.indexOf(x[2]) - tiers.indexOf(y[2])
  );
}
export interface WeeklyForecast {
  at: number;
  days: number;
  dayRate: number;
}
export function monthlyMacRule(input: {
  now: number;
  historySince: number;
  monthlyPrice: number;
  forecasts: readonly WeeklyForecast[];
  lastSuggestedAt?: number;
  snoozedUntil?: number;
  lastAnswer?: "rent" | "keep" | "own" | "cancel" | null;
  enrolled?: boolean;
  /** Future enrollment integration must supply demand on this actual machine.
   * Spillover day leases are not evidence of monthly-machine utilization. */
  enrolledDemand?: { machineId: string; forecasts: readonly WeeklyForecast[] };
}): boolean {
  const { now, monthlyPrice } = input;
  if (input.enrolled && !input.enrolledDemand?.machineId) return false;
  const forecasts = input.enrolled
    ? input.enrolledDemand!.forecasts
    : input.forecasts;
  if (
    !Number.isFinite(monthlyPrice) ||
    monthlyPrice <= 0 ||
    !Number.isFinite(now)
  )
    return false;
  if (
    now - input.historySince < 30 * 86400000 ||
    now < (input.snoozedUntil ?? 0) ||
    (input.lastAnswer !== "keep" &&
      now - (input.lastSuggestedAt ?? -Infinity) < 30 * 86400000)
  )
    return false;
  const [previous, latest] = forecasts.slice(-2);
  if (
    !previous ||
    !latest ||
    latest.at > now ||
    latest.at - previous.at < 7 * 86400000 ||
    latest.at - previous.at >= 14 * 86400000 ||
    now - latest.at >= 7 * 86400000
  )
    return false;
  return [previous, latest].every(
    (f) =>
      Number.isFinite(f.days) &&
      f.days >= 0 &&
      Number.isFinite(f.dayRate) &&
      f.dayRate > 0 &&
      (input.enrolled
        ? f.days < (0.7 * monthlyPrice) / f.dayRate
        : f.days > (1.2 * monthlyPrice) / f.dayRate &&
          (f.days * f.dayRate - monthlyPrice) / (f.days * f.dayRate) > 0.2),
  );
}
