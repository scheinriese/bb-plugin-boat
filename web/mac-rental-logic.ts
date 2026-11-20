import type { MacRentalQuote } from "../contract-ownmac.ts";

/** A conditional price boundary, never a fetched or assumed exchange rate.
 * Round down so the displayed condition cannot overstate the cheaper range. */
export function rentalBreakEven(a: MacRentalQuote, b: MacRentalQuote): number | null {
  if (a.currency === b.currency || a.minimumHours !== b.minimumHours) return null;
  const values = [a.minimumCost, b.minimumCost, a.hourPrice, b.hourPrice];
  if (values.some(value => !Number.isFinite(value) || value <= 0)) return null;
  const minimum = b.minimumCost / a.minimumCost;
  const hourly = b.hourPrice / a.hourPrice;
  if ((minimum < 1 && hourly > 1) || (minimum > 1 && hourly < 1)) return null;
  const threshold = Math.floor(Math.min(minimum, hourly) * 100) / 100;
  return Number.isFinite(threshold) && threshold > 0 ? threshold : null;
}

export function compareRentalOffers(a: MacRentalQuote, b?: MacRentalQuote): string {
  if (!b) return "Eligible for this task.";
  if (a.minimumHours !== b.minimumHours) return `Compared with ${b.label} ${b.modelLabel}: minimum durations differ; compare the total and ongoing rate.`;
  if (a.currency !== b.currency) {
    const threshold = rentalBreakEven(a, b);
    return threshold === null
      ? `Compared with ${b.label} ${b.modelLabel}: different currencies; compare both totals and hourly rates. No exchange rate is assumed.`
      : `Below ${threshold.toFixed(2)} ${b.currency} per ${a.currency}, both minimum and hourly costs are lower than ${b.label} ${b.modelLabel}. No exchange rate is assumed.`;
  }
  const comparison = `Compared with ${b.label} ${b.modelLabel}: `;
  if (a.minimumCost === b.minimumCost && a.hourPrice === b.hourPrice) return comparison + "same minimum total and hourly rate.";
  if (a.minimumCost <= b.minimumCost && a.hourPrice <= b.hourPrice) return comparison + "same minimum duration; lower total or hourly rate, with neither higher.";
  if (a.minimumCost >= b.minimumCost && a.hourPrice >= b.hourPrice) return comparison + "same minimum duration; higher total or hourly rate, with neither lower.";
  return a.minimumCost < b.minimumCost
    ? comparison + "lower minimum total, but a higher hourly rate."
    : comparison + "higher minimum total, but a lower hourly rate.";
}
