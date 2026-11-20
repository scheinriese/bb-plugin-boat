import type { SandboxProvider } from "./providers/types.ts";

/** Maintenance only. A missing key is inert; failed reads consume the interval
 * too, so an unavailable provider cannot flood the monitor log. */
export function createProviderRecovery(deps: {
  providers(): readonly SandboxProvider[];
  keyPresent(id: string): boolean;
  signal: AbortSignal;
  warn(message: string): void;
  now?: () => number;
}) {
  const last = new Map<string, number>(), now = deps.now ?? Date.now;
  return async () => {
    for (const provider of deps.providers()) {
      if (deps.signal.aborted) return;
      if (!provider.recoverCreations || (provider.id === "scaleway" && !deps.keyPresent(provider.id))) continue;
      const previous = last.get(provider.id), at = now();
      if (previous !== undefined && at - previous < 5 * 60_000) continue;
      last.set(provider.id, at);
      try { await provider.recoverCreations(deps.signal); }
      catch (error) { if (!deps.signal.aborted) deps.warn(`${provider.displayName} recovery: ${error instanceof Error ? error.message : String(error)}`); }
    }
  };
}
