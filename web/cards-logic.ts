import type { TaskDto } from "../contract.ts";

export type CardStatus = {
  status:
    | "working"
    | "review"
    | "ready"
    | "shipped"
    | "needs-you"
    | "broken"
    | "stopped"
    | "waiting-reset";
  label: string;
  tone: "neutral" | "attention" | "positive" | "danger";
  reason: string | null;
  needsYou: boolean;
  moving: boolean;
};

/** Consume the v1 model when present, while older servers still supply phase. */
export function cardStatus(task: TaskDto): CardStatus {
  const live = (task as TaskDto & { publicStatus?: CardStatus }).publicStatus;
  if (live) return live;
  const status =
    task.phase === "failed"
      ? "broken"
      : task.phase === "ready"
        ? "ready"
        : task.phase === "cancelled"
          ? "stopped"
          : task.latestReview === "reviewing"
            ? "review"
            : "working";
  return {
    status,
    label:
      status === "broken"
        ? "Broken"
        : status === "stopped"
          ? "Stopped"
          : status === "review"
            ? "In review"
            : status === "ready"
              ? "Ready"
              : task.phase === "done"
                ? "Done"
                : "Working",
    tone:
      status === "broken"
        ? "danger"
        : status === "ready" || task.phase === "done"
          ? "positive"
          : "neutral",
    reason: task.error,
    needsYou: false,
    moving:
      task.phase === "starting" ||
      task.phase === "working" ||
      status === "review",
  };
}

export const CARD_TONES = {
  neutral: "text-muted-foreground",
  attention: "text-[#F0B135]",
  positive: "text-[#5BD08A]",
  danger: "text-[#E06C6C]",
} as const;

export function contextCounts(
  tasks: readonly TaskDto[],
  decisions: number,
  linkedTaskIds: readonly string[] = [],
): string {
  let ready = 0,
    working = 0,
    needs = decisions;
  const linked = new Set(linkedTaskIds);
  for (const task of tasks) {
    const state = cardStatus(task);
    if (state.status === "ready") ready++;
    else if (state.moving) working++;
    if (state.needsYou && !linked.has(task.id)) needs++;
  }
  return (
    [
      ready ? `${ready} ready` : null,
      needs ? `${needs} ${needs === 1 ? "needs" : "need"} you` : null,
      working ? `${working} working` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "No active work"
  );
}

/** IDs are identifiers only, never paths; allow the host's and Boat's prefixes. */
export function markerId(value: unknown): string | null {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(value)
    ? value
    : null;
}

/** Delivery begins only after the undo window, so Undo never reverses a sent message. */
export function queueDelivery(send: () => Promise<void>, delay = 4000) {
  let pending = true;
  const timer = setTimeout(() => {
    pending = false;
    void send();
  }, delay);
  return () => {
    if (!pending) return false;
    pending = false;
    clearTimeout(timer);
    return true;
  };
}

/** Existing decisions store prose recommendations alongside plain option strings. */
export function recommendedOption(
  options: readonly string[],
  recommendation: string,
): string | null {
  const text = recommendation.trim().toLowerCase();
  return (
    options.find((option) => {
      const label = option.trim().toLowerCase();
      return (
        text === label ||
        [":", " —", " –", " -", "."].some((separator) =>
          text.startsWith(label + separator),
        )
      );
    }) ?? null
  );
}
