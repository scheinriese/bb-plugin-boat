// Previews: a worker leaves a server running in its sandbox, and the plugin
// exposes it with `boat host --private`. The link is stable across stop and
// resume and carries its token in the query (`?_token=…`): the first visit
// sets a cookie and redirects to the page, so it opens in any browser.
import { ACTIVE_STATES, type Sandbox } from "./boat-api.ts";
import type { Preview, PreviewHealth, Task } from "./store.ts";

export type PreviewState = "live" | "sleeping" | "expired";


/** The link to open: boat's private URL with the page path (the token stays in the query). */
export function previewLink(url: string, path: string): string {
  try {
    const base = new URL(url);
    // "//other.site/x" would leave boat's host (with the token): only paths on it.
    const page = new URL(`/${path.replace(/^[/\\]+/, "")}`, base.origin);
    if (page.origin !== base.origin) return url;
    for (const [key, value] of base.searchParams) if (!page.searchParams.has(key)) page.searchParams.set(key, value);
    return page.toString();
  } catch {
    return url;
  }
}

export interface PreviewView {
  preview: Preview;
  /** The link with the page path. */
  link: string;
  state: PreviewState;
  /** Why it isn't live ("sandbox stopped", "server not running", …). */
  reason: string | null;
  /** When boat stops the sandbox (ISO), while it's on. */
  stopsAt: string | null;
}

/**
 * What a preview looks like now. `sandbox` undefined: the list wasn't read
 * (state from the last check); null: the sandbox is gone.
 */
export function previewView(preview: Preview, task: Task | null, sandbox: Sandbox | null | undefined): PreviewView {
  const link = previewLink(preview.url, preview.path);
  const closed = task === null || task.status === "done" || task.status === "cancelled";
  if (preview.expiredAt !== null || sandbox === null) {
    return { preview, link, state: "expired", reason: sandbox === null ? "the sandbox is gone" : "the task was closed", stopsAt: null };
  }
  if (sandbox !== undefined && !ACTIVE_STATES.has(sandbox.state)) {
    return { preview, link, state: "sleeping", reason: closed ? "the task is closed; the sandbox is stopped" : "the sandbox is stopped", stopsAt: null };
  }
  if (preview.health === "down") {
    return { preview, link, state: "sleeping", reason: "the server isn't running", stopsAt: sandbox?.archiveAfter ?? null };
  }
  if (preview.health === "blocked") {
    return { preview, link, state: "sleeping", reason: "the dev server blocks the preview's host name (Wake restarts it allowing .on.boat.dev)", stopsAt: sandbox?.archiveAfter ?? null };
  }
  return { preview, link, state: "live", reason: null, stopsAt: sandbox?.archiveAfter ?? null };
}

type FetchLike = (url: string, init: { redirect: "manual"; signal: AbortSignal; headers?: Record<string, string> }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/**
 * Does the preview answer? Opens the link like a browser would (token →
 * cookie → page). up: the server answered; down: boat reached the sandbox but
 * nothing listens (502–504) or the sandbox is stopped (403); unknown: no answer.
 */
export async function checkPreview(
  link: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 6_000,
  /** The sandbox is known to be on: a 403 then comes from the app, not from boat. */
  options: { sandboxActive?: boolean } = {},
): Promise<PreviewHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Only boat's preview hosts are ever fetched from this machine.
    if (!/\.on\.boat\.dev$/.test(new URL(link).hostname)) return "unknown";
    let response = await fetchImpl(link, { redirect: "manual", signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      // Follow the token redirect only on the same host (not to wherever an app points).
      const next = location ? new URL(location, link) : null;
      if (next !== null && next.origin === new URL(link).origin) {
        response = await fetchImpl(next.toString(), {
          redirect: "manual",
          signal: controller.signal,
          ...(cookie ? { headers: { cookie } } : {}),
        });
      }
    }
    if (response.status === 403) {
      // A dev server refusing boat's host name (Vite's or webpack's host check), an
      // app's own 403, or boat refusing a stopped sandbox.
      const body = await response.text().catch(() => "");
      if (/blocked request|is not allowed|allowedHosts|invalid host header|blocked hosts?/i.test(body)) return "blocked";
      return options.sandboxActive ? "up" : "down";
    }
    if (response.status >= 502 && response.status <= 504) return "down";
    return "up";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

/** "stops in 1h 40m" / "stopped". */
export function stopsInText(stopsAt: string | null, now = Date.now()): string | null {
  if (stopsAt === null) return null;
  const ms = Date.parse(stopsAt) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "stopping";
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `stops in ${Math.floor(minutes / 60)}h ${minutes % 60}m` : `stops in ${minutes}m`;
}
