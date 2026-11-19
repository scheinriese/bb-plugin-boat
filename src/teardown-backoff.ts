// Teardown without hammering a failing boat.dev.
//
// bb retries a machine's suspend and removal on its own when the provider
// fails (one machine was torn down 36 times while boat.dev's storage was
// failing), and the plugin's keeper asks bb to suspend an idle machine again
// every few minutes. After boat.dev fails one teardown step for a sandbox,
// the provider doesn't call boat for that sandbox again until a doubling
// pause has passed (30 seconds up to 15 minutes): bb's retries in between
// fail at once, saying when Boat asks boat.dev again. In memory only: a
// reload of the plugin starts over.
import { clockTime } from "./format.ts";

export const TEARDOWN_BASE_MS = 30_000;
export const TEARDOWN_MAX_MS = 15 * 60_000;

export class TeardownBackoff {
  private readonly entries = new Map<string, { failures: number; until: number; error: string }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** The plain-words refusal while a pause holds this step for this sandbox (null: go ahead). */
  held(id: string, action: string): string | null {
    const entry = this.entries.get(`${action} ${id}`);
    if (entry === undefined || entry.until <= this.now()) return null;
    return `boat.dev failed to ${action} this sandbox a moment ago (${entry.error}). Boat asks it again at ${clockTime(entry.until, this.now())}.`;
  }

  /** boat.dev failed a step: the next waits. Returns the message to report. */
  failed(id: string, action: string, error: unknown): string {
    const text = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
    const failures = (this.entries.get(`${action} ${id}`)?.failures ?? 0) + 1;
    const until = this.now() + Math.min(TEARDOWN_MAX_MS, TEARDOWN_BASE_MS * 2 ** Math.min(failures - 1, 20));
    this.entries.set(`${action} ${id}`, { failures, until, error: text });
    return `boat.dev failed to ${action} this sandbox (${text}). Boat asks it again at ${clockTime(until, this.now())}.`;
  }

  succeeded(id: string, action: string): void {
    this.entries.delete(`${action} ${id}`);
  }
}
