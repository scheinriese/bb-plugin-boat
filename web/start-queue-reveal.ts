// A queued start has no chat of its own yet, so opening it means opening the
// chat that requested it. bb's navigation opens a chat but can't point at one
// of its messages (`toThread(threadId, {split})` only, SDK 0.6.146), so the
// request's live ::boat-start-queue card brings itself into view instead,
// once it has rendered. Pure logic; the card's hook lives in start-queue.tsx.

/** Long enough for a navigation to load the chat; a later visit doesn't jump. */
export const REVEAL_WINDOW_MS = 10_000;
/**
 * A chat can hold several cards that list the same request (an older group
 * card, a repeated marker). The card whose own marker is the request takes the
 * reveal at once; a card that only lists it waits this long for that card first.
 */
export const LISTED_FALLBACK_MS = 300;
const QUEUED_START_ID = /^qs_[0-9a-f-]{36}$/;

let pending: { id: string; until: number; fallbackAt: number | null } | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of [...listeners]) listener(); };

/** Bring the card that shows this request into view, now or when it renders. */
export function revealQueuedStart(id: string, now = Date.now()): void {
  if (!QUEUED_START_ID.test(id)) return;
  pending = { id, until: now + REVEAL_WINDOW_MS, fallbackAt: null };
  notify();
}

/**
 * A card takes the pending reveal once and gets the request id back.
 * `ownId` is the request of the card's own marker; `ids` are all the requests
 * it lists. The owner wins; a listing card wins only after LISTED_FALLBACK_MS
 * passed without an owner (listeners hear again when it has).
 */
export function claimQueuedStartReveal(ownId: string | null, ids: readonly string[], now = Date.now()): string | null {
  if (!pending) return null;
  if (pending.until < now) {
    pending = null;
    return null;
  }
  const { id } = pending;
  if (ownId !== id) {
    if (!ids.includes(id)) return null;
    if (pending.fallbackAt === null) {
      const waiting = pending;
      waiting.fallbackAt = now + LISTED_FALLBACK_MS;
      // Timers and Date.now can disagree by a millisecond: the timer itself opens the fallback.
      const timer = setTimeout(() => {
        if (pending !== waiting) return;
        waiting.fallbackAt = 0;
        notify();
      }, LISTED_FALLBACK_MS) as { unref?: () => void };
      timer.unref?.();
    }
    if (now < (pending.fallbackAt ?? 0)) return null;
  }
  pending = null;
  return id;
}

/** The user scrolled after the click: a card that renders later stays where it is. */
export function cancelQueuedStartReveal(): void {
  pending = null;
}

export function onQueuedStartReveal(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type ClickLike = Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & { target: EventTarget | null };
type ElementLike = { closest(selector: string): ElementLike | null; getAttribute(name: string): string | null };

/**
 * The request a plain click on a sidebar queued-start row opens. Rows mark
 * themselves with `data-queued-start-id` and `data-queued-start-state` (see
 * docs/sidebar-contract.md); their link opens the requesting chat. Started
 * rows open their task instead, and menu buttons aren't links.
 */
export function queuedRowClickId(event: ClickLike): string | null {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const target = event.target as Partial<ElementLike> | null;
  if (!target || typeof target.closest !== "function") return null;
  const row = target.closest("[data-queued-start-id]");
  if (!row || !target.closest("[data-queued-start-id] a[href]")) return null;
  const state = row.getAttribute("data-queued-start-state");
  if (state !== "waiting" && state !== "dispatching") return null;
  const id = row.getAttribute("data-queued-start-id") ?? "";
  return QUEUED_START_ID.test(id) ? id : null;
}

