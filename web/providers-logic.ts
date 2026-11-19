// Words and glyphs for sandbox providers (web/providers.tsx): where a task
// or sandbox runs, and each provider's status in Settings. No React here,
// so the tests can read it.
import { DEFAULT_SANDBOX_PROVIDER, type RunsOnDto, type SandboxProviderDto } from "../contract-providers.ts";

/** The icon for a provider: boat.dev's sail, a cloud provider's box, a Mac's laptop (dashed: none enrolled yet). */
export type ProviderGlyph = "boat" | "box" | "laptop" | "laptop-dashed";

/** "boat.dev · Default", "Instabox · Mac M2 · lease ends Thu 14:00": a task's line and its chip's tooltip. */
export function runsOnLine(runsOn: RunsOnDto, fallbackMachine: string | null = null): string {
  return [runsOn.label, runsOn.machine ?? fallbackMachine, runsOnNote(runsOn)].filter(Boolean).join(" · ");
}

/** "boat.dev · Default", "Instabox · Mac M2": a sandbox's provider and machine (the Sandboxes table). */
export function runsOnMachine(runsOn: RunsOnDto, fallbackMachine: string | null = null): string {
  return [runsOn.label, runsOn.machine ?? fallbackMachine].filter(Boolean).join(" · ");
}

/** A task chip names its provider only off boat.dev ("Instabox", "Your Mac"); null: say nothing. */
export function chipProvider(runsOn: RunsOnDto | undefined): string | null {
  return runsOn === undefined || runsOn.provider === DEFAULT_SANDBOX_PROVIDER ? null : runsOn.label;
}

export function runsOnGlyph(runsOn: Pick<RunsOnDto, "provider" | "os">): ProviderGlyph {
  if (runsOn.os === "macos") return "laptop";
  return runsOn.provider === DEFAULT_SANDBOX_PROVIDER ? "boat" : "box";
}

export function providerGlyph(provider: Pick<SandboxProviderDto, "id" | "kind">): ProviderGlyph {
  if (provider.kind === "own-mac") return "laptop";
  if (provider.kind === "monthly-mac") return "laptop-dashed";
  return provider.id === DEFAULT_SANDBOX_PROVIDER ? "boat" : "box";
}

/** The dot and words beside a provider: "Connected" (green), else grey. */
export function providerStatus(provider: Pick<SandboxProviderDto, "connection" | "status" | "available">): { text: string; ok: boolean } {
  const ok = provider.available && provider.connection === "connected";
  return { text: provider.status ?? (ok ? "Connected" : "Not connected"), ok };
}

/** "3 providers ready" for the setup line, once more than one provider can take work (null: say the plan instead, as before). */
export function readyProvidersText(providers: readonly Pick<SandboxProviderDto, "available" | "enabled" | "connection">[] | undefined): string | null {
  const ready = (providers ?? []).filter((provider) => provider.available && provider.enabled && provider.connection === "connected").length;
  return ready > 1 ? `${ready} providers ready` : null;
}

/** A provider's API key line: whether it's set, and what the link says. Null: it doesn't use one. */
export function keyLine(provider: Pick<SandboxProviderDto, "apiKey" | "connection">): { set: boolean; action: string } | null {
  if (provider.apiKey === null) return null;
  const set = provider.connection !== "key-missing";
  return { set, action: set ? "Change" : "Add key in bb secrets" };
}

/**
 * Where to put a provider's key. The plugin SDK has no secure entry of its
 * own, so the link says where bb's is: the secret setting in the plugin's
 * settings list, above these sections.
 */
export function keyHint(provider: Pick<SandboxProviderDto, "label" | "apiKey">): { title: string; description: string } {
  const setting = provider.apiKey?.setting ?? null;
  if (setting === null) return { title: `This version of Boat can't take a key for ${provider.label} yet`, description: `${provider.label} comes in a later version; its key will go in bb's secrets, never to Boat.` };
  return { title: `Set “${setting}” in the settings list at the top of this page`, description: "bb keeps the key in its secrets; Boat never sees it." };
}

/** Local browser time; the server sends instants, never preformatted UTC. */
export function runsOnNote(runsOn: RunsOnDto, now = Date.now(), locale?: string, timeZone?: string): string | null {
  const lease = runsOn.lease;
  if (!lease) return runsOn.note;
  const time = (value: string) => new Intl.DateTimeFormat(locale, { weekday: "short", hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(new Date(value)).replace(",", "");
  if (lease.endedAt) return `lease ended ${time(lease.endedAt)}`;
  if (lease.kept) return "Kept · automatic hand-back off";
  if (lease.releaseAt) return `release scheduled ${time(lease.releaseAt)}`;
  if (now >= Date.parse(lease.paidUntil)) return `${lease.shared ? "same lease · " : ""}bills per second`;
  return `${lease.shared ? "same lease, paid until" : "paid until"} ${time(lease.paidUntil)}`;
}
