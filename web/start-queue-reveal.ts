// A queued start has no chat of its own yet, so opening it means opening the
// chat that requested it. bb's navigation opens a chat but can't point at one
// of its messages (`toThread(threadId, {split})` only, SDK 0.6.146), so the
// request's live ::boat-start-queue card brings itself into view instead,
// once it has rendered. Pure logic; the card's hook lives in start-queue.tsx.

/** Long enough for a navigation to load the chat; a later visit doesn't jump. */
export const REVEAL_WINDOW_MS = 10_000;
const QUEUED_START_ID = /^qs_[0-9a-f-]{36}$/;

let pending: { id: string; until: number } | null = null;
const listeners = new Set<() => void>();

/** Bring the card that shows this request into view, now or when it renders. */
export function revealQueuedStart(id: string, now = Date.now()): void {
  if (!QUEUED_START_ID.test(id)) return;
  pending = { id, until: now + REVEAL_WINDOW_MS };
  for (const listener of [...listeners]) listener();
}

/** A card showing these requests takes the pending reveal once. Returns the request id. */
export function claimQueuedStartReveal(ids: readonly string[], now = Date.now()): string | null {
  if (!pending) return null;
  if (pending.until < now) {
    pending = null;
    return null;
  }
  if (!ids.includes(pending.id)) return null;
  const { id } = pending;
  pending = null;
  return id;
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

/** Test seam: forget a pending reveal. */
export function resetQueuedStartReveal(): void {
  pending = null;
}
