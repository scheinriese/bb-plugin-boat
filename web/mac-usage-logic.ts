export function formatLeaseDays(days: number, locale?: string): string {
  const rounded = Number(days.toFixed(2));
  return `${rounded.toLocaleString(locale, { maximumFractionDigits: 2 })} lease-day${rounded === 1 ? "" : "s"}`;
}
