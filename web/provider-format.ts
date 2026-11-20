/** Product copy has one locale; instants remain in the viewer's timezone. */
export const hours = (value: number) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: value < 100 ? 1 : 0,
    maximumFractionDigits: value < 100 ? 1 : 0,
  }).format(value);
export const money = (value: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
export const creditMoney = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
export const resetDate = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
export const leaseTime = (value: string, timeZone?: string) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  })
    .format(new Date(value))
    .replace(",", "");
export function leaseState(
  lease: {
    kept: boolean;
    releaseAt: string | null;
    paidUntil: string;
    hourPrice: number;
    currency: string;
    billingIncrementSeconds?: number;
  },
  now = Date.now(),
) {
  const rate = `${money(lease.hourPrice, lease.currency)} / h`;
  if (lease.kept)
    return {
      text: "Kept · hand-back off",
      detail: `${rate} while kept`,
      caution: true,
    };
  if (lease.releaseAt)
    return {
      text: "Release scheduled",
      detail: `${leaseTime(lease.releaseAt)} · nothing waiting`,
      caution: false,
    };
  if (now >= Date.parse(lease.paidUntil))
    return {
      text:
        lease.billingIncrementSeconds === 3600
          ? "Bills hourly"
          : "Bills per second",
      detail: `${rate} since ${leaseTime(lease.paidUntil)}`,
      caution: false,
    };
  return {
    text: `Paid until ${leaseTime(lease.paidUntil)}`,
    detail: `${rate} after that`,
    caution: false,
  };
}
