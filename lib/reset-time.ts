// When a usage reset happens, in the reader's local time, short enough for a
// sidebar second line. Shared by the server (sidebar rows) and the web cards,
// so every surface prints the same words. A bare clock reads as "tonight", so
// a reset that isn't later today or overnight names its day.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A reset early on the next calendar day still reads as tonight. */
const OVERNIGHT_MS = 12 * 60 * 60 * 1000;

/** Whether this runtime knows the IANA time zone name (for example `Europe/Berlin`). */
export function isTimeZone(name: unknown): name is string {
  if (typeof name !== "string" || name === "" || name.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The JavaScript-sign offset of an IANA zone at one instant, so it follows daylight saving time. */
function zoneOffset(t: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(t);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((t - (t % 1000) - local) / 60_000);
}

/**
 * - later today, or overnight (the next day, under 12 hours away): `1:00 am`
 * - the next day otherwise: `tomorrow 1:00 am`
 * - within the coming week: `Thu 1:00 am`
 * - further out, or an earlier day: `Nov 26, 1:00 am`
 *
 * `zone` is an IANA time zone name, which follows daylight saving time, or
 * a fixed offset in the JavaScript sign (local time is UTC minus the offset,
 * as `Date#getTimezoneOffset` returns). A fixed offset is the reader's offset
 * now, so a reset across a daylight saving change can read an hour off.
 * Without a zone, or with an unknown name, the runtime's own time zone
 * applies. Null for a missing or unparsable time.
 */
export function resetTimeText(
  at: number | string | null | undefined,
  now = Date.now(),
  zone?: number | string,
): string | null {
  const time = typeof at === "string" ? Date.parse(at) : at;
  if (typeof time !== "number" || !Number.isFinite(time)) return null;
  const named = typeof zone === "string" && isTimeZone(zone) ? zone : null;
  const offset = (t: number) => named ? zoneOffset(t, named) : typeof zone === "number" ? zone : new Date(t).getTimezoneOffset();
  const local = (t: number) => new Date(t - offset(t) * 60_000);
  const when = local(time);
  const today = local(now);
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000;
  const days = day(when) - day(today);
  const hours = when.getUTCHours();
  const clock = `${hours % 12 || 12}:${String(when.getUTCMinutes()).padStart(2, "0")} ${hours >= 12 ? "pm" : "am"}`;
  if (days === 0 || (days === 1 && time - now < OVERNIGHT_MS)) return clock;
  if (days === 1) return `tomorrow ${clock}`;
  if (days > 1 && days < 7) return `${DAYS[when.getUTCDay()]} ${clock}`;
  return `${MONTHS[when.getUTCMonth()]} ${when.getUTCDate()}, ${clock}`;
}
