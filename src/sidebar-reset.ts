// Only live provider-retry queue rows establish a paused subscription reset.
// Quota timestamps or Boat's both-out planning state alone do not pause a turn.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
export interface PausedReset {
  sendAt: number;
  updatedAt: number;
}
export async function readPausedResets(
  bb: Pick<BbPluginApi, "sdk">,
  now = Date.now(),
): Promise<Map<string, PausedReset>> {
  const signal = AbortSignal.timeout(4000);
  const rows = await Promise.resolve()
    .then(() => bb.sdk.threads.queue.list({ signal }))
    .catch(() => []);
  const candidates = rows
    .slice(0, 1000)
    .filter(
      (row) =>
        row.originPluginId === "provider-retry" &&
        row.payload.kind === "retry" &&
        row.payload.reason === "Rate limited" &&
        ["scheduled", "waiting"].includes(row.state) &&
        typeof row.sendAt === "number" &&
        Number.isFinite(row.sendAt) &&
        row.sendAt > now,
    )
    .slice(0, 50);
  const result = new Map<string, PausedReset>();
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (cursor < candidates.length) {
        const row = candidates[cursor++]!;
        try {
          const thread = await bb.sdk.threads.get({
            threadId: row.threadId,
            signal,
          });
          if (
            !["idle", "error"].includes(thread.status) ||
            thread.archivedAt != null ||
            thread.deletedAt != null
          )
            continue;
          const old = result.get(row.threadId);
          if (!old || row.sendAt! < old.sendAt)
            result.set(row.threadId, {
              sendAt: row.sendAt!,
              updatedAt: row.updatedAt,
            });
        } catch {
          /* Unknown/moving threads retain their ordinary state. */
        }
      }
    }),
  );
  return result;
}
export function resetWaitText(
  at: number,
  timezoneOffsetMinutes = new Date().getTimezoneOffset(),
): string {
  const local = new Date(at - timezoneOffsetMinutes * 60000);
  const hours = local.getUTCHours();
  return `Waits for reset · ${hours % 12 || 12}:${String(local.getUTCMinutes()).padStart(2, "0")} ${hours >= 12 ? "pm" : "am"}`;
}
