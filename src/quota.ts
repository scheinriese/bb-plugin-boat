// How much of each agent's subscription is used, from any bb plugin that
// offers the provider-usage.v1 interface (the Account Pooler does). Reading it
// costs no tokens; it's the signal for handing work between Claude and Codex.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { LimitFlags } from "./limits.ts";
import type { Provider } from "./store.ts";

export interface AgentQuota {
  provider: Provider;
  /** Percent of the binding window used (may exceed 100 on paid extra usage). */
  usedPercent: number;
  /** When the binding window resets (ISO), if known. */
  resetsAt: string | null;
  /** "Weekly limit", "5-hour limit", … */
  window: string;
}

export type Quotas = Map<Provider, AgentQuota>;

export interface QuotaReader {
  /** Known quotas per agent; an agent missing from the map is unknown. */
  read(signal?: AbortSignal): Promise<Quotas>;
}

const PROVIDER_OF: Record<string, Provider> = { "claude-code": "claude", codex: "codex" };

const listSchema = z.object({
  resources: z.array(z.object({ id: z.string(), providerId: z.string().nullable().optional() }).passthrough()),
}).passthrough();

const windowSchema = z
  .object({
    label: z.string().optional(),
    usedPercent: z.number(),
    resetsAt: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
  })
  .passthrough();

const resourceSchema = z
  .object({
    usage: z
      .object({ status: z.string(), windows: z.array(windowSchema).optional() })
      .passthrough(),
  })
  .passthrough();

/**
 * One account's binding window: the fullest window that applies to all
 * models (model-specific ones, like a Fable cap, don't block the agent).
 */
export function bindingWindow(windows: readonly z.infer<typeof windowSchema>[]): { usedPercent: number; resetsAt: string | null; label: string } | null {
  const general = windows.filter((window) => !window.model);
  if (general.length === 0) return null;
  const fullest = general.reduce((max, window) => (window.usedPercent > max.usedPercent ? window : max));
  return { usedPercent: fullest.usedPercent, resetsAt: fullest.resetsAt ?? null, label: fullest.label ?? "limit" };
}

/**
 * An agent with several pooled accounts is as free as its freest account
 * (the pool moves to it).
 */
export function pickAgentQuota(provider: Provider, accounts: { usedPercent: number; resetsAt: string | null; label: string }[]): AgentQuota | null {
  if (accounts.length === 0) return null;
  const freest = accounts.reduce((min, account) => (account.usedPercent < min.usedPercent ? account : min));
  return { provider, usedPercent: freest.usedPercent, resetsAt: freest.resetsAt, window: freest.label };
}

/**
 * Usage sources, in order of preference: the Account Pooler (when it's on,
 * chats route through its accounts), then the agents' own providers (the
 * host's logins). Provider usage in bb's settings shows the same sources.
 */
export const USAGE_SOURCES = ["account-pool", "provider-claude-code", "provider-codex"] as const;

export interface QuotaReaderOptions {
  sources?: readonly string[];
  cacheMs?: number;
  /** Agents known to be at their limit (from failed turns); they read as full until it lifts. */
  limits?: () => Promise<LimitFlags>;
}

export function createQuotaReader(bb: BbPluginApi, options: QuotaReaderOptions = {}): QuotaReader {
  const { sources = USAGE_SOURCES, cacheMs = 60_000 } = options;
  let cache: { at: number; quotas: Quotas } | null = null;
  async function readings(signal?: AbortSignal): Promise<Quotas> {
    if (cache !== null && Date.now() - cache.at < cacheMs) return cache.quotas;
    const quotas: Quotas = new Map();
    for (const source of sources) {
      // Each agent's numbers come from the first source that has them.
      const found = await readSource(bb, source, signal);
      for (const [provider, quota] of found) if (!quotas.has(provider)) quotas.set(provider, quota);
      if (quotas.size === 2) break;
    }
    cache = { at: Date.now(), quotas };
    return quotas;
  }
  return {
    async read(signal) {
      const quotas = await readings(signal);
      const flags = options.limits ? await options.limits().catch(() => ({})) : {};
      return applyLimitFlags(quotas, flags);
    },
  };
}

/** An agent that hit its limit reads as full (100%) until the limit lifts. */
export function applyLimitFlags(quotas: Quotas, flags: LimitFlags): Quotas {
  if (Object.keys(flags).length === 0) return quotas;
  const merged: Quotas = new Map(quotas);
  for (const [provider, until] of Object.entries(flags) as [Provider, number][]) {
    const reading = quotas.get(provider);
    if (reading !== undefined && reading.usedPercent >= 100) continue;
    merged.set(provider, { provider, usedPercent: 100, resetsAt: new Date(until).toISOString(), window: "Usage limit (hit)" });
  }
  return merged;
}

const poolStatusSchema = z
  .object({
    routing: z.object({ claude: z.boolean(), codex: z.boolean() }).partial().passthrough(),
    accounts: z.array(z.object({ id: z.string(), provider: z.string().optional(), status: z.string().optional() }).passthrough()),
  })
  .passthrough();

/**
 * The Account Pooler's readings count only for agents it routes, and only for
 * accounts it uses; for the others the host's own login is what chats use.
 */
async function poolFilter(bb: BbPluginApi, signal?: AbortSignal): Promise<(resourceId: string, provider: Provider) => boolean> {
  const status = (await bb.sdk.plugins.callRpc({
    pluginId: "account-pool",
    method: "status.get",
    input: null,
    outputSchema: poolStatusSchema,
    ...(signal ? { signal } : {}),
  } as never)) as z.infer<typeof poolStatusSchema>;
  const accounts = new Map(status.accounts.map((account) => [account.id, account]));
  return (resourceId, provider) => {
    if (status.routing[provider] !== true) return false;
    const account = accounts.get(resourceId);
    return account === undefined || account.status !== "disabled";
  };
}

async function readSource(bb: BbPluginApi, sourcePluginId: string, signal?: AbortSignal): Promise<Quotas> {
  const quotas: Quotas = new Map();
  try {
    // Without the pool's routing state, its readings can't be trusted for either agent.
    const counts = sourcePluginId === "account-pool" ? await poolFilter(bb, signal) : () => true;
    const list = await bb.sdk.plugins.callRpc({
      pluginId: sourcePluginId,
      method: "provider-usage.v1.listResources",
      input: {},
      outputSchema: listSchema,
      ...(signal ? { signal } : {}),
    } as never);
    const byProvider = new Map<Provider, { usedPercent: number; resetsAt: string | null; label: string }[]>();
    for (const resource of (list as z.infer<typeof listSchema>).resources) {
      const provider = PROVIDER_OF[resource.providerId ?? ""];
      if (!provider || !counts(resource.id, provider)) continue;
      const detail = (await bb.sdk.plugins
        .callRpc({
          pluginId: sourcePluginId,
          method: "provider-usage.v1.getResource",
          input: { resourceId: resource.id, refresh: false },
          outputSchema: resourceSchema,
          ...(signal ? { signal } : {}),
        } as never)
        .catch(() => null)) as z.infer<typeof resourceSchema> | null;
      if (detail?.usage.status !== "ok") continue;
      const binding = bindingWindow(detail.usage.windows ?? []);
      if (binding) byProvider.set(provider, [...(byProvider.get(provider) ?? []), binding]);
    }
    for (const [provider, accounts] of byProvider) {
      const quota = pickAgentQuota(provider, accounts);
      if (quota) quotas.set(provider, quota);
    }
  } catch {
    // This source isn't installed or doesn't answer: try the next one.
  }
  return quotas;
}

/** "Claude: 21% of the weekly limit used, resets 2026-11-12 01:00 UTC" */
export function quotaLine(quota: AgentQuota | undefined, provider: Provider): string {
  const name = provider === "claude" ? "Claude" : "Codex";
  if (!quota) return `${name}: usage unknown`;
  const resets = quota.resetsAt ? `, resets ${new Date(quota.resetsAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
  return `${name}: ${Math.round(quota.usedPercent)}% of the ${quota.window.toLowerCase()} used${resets}`;
}
