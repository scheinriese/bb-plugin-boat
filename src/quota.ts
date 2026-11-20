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
  /** Recent public Account Pooler evidence, never a money balance or spending cap. */
  extraUsage?: ExtraUsageEvidence;
  /** Current ready, enabled, unrestricted Pooler route; permits an attempt, never proves paid funds. */
  paidAttemptAllowed?: boolean;
  /** Explicit all-model weekly window from Pooler; separate from a binding 5-hour limit. */
  weekly?: { usedPercent: number; resetsAt: string; windowMinutes: number };
  weeklyAdvice?: WeeklyPace | null;
  /** A real failed turn blocks automatic paid admission until this time. */
  blockedUntil?: number;
  /** The usage source the numbers came from (one of USAGE_SOURCES). */
  source?: string;
}

export type ExtraUsageStatus = "allowed" | "rejected" | "disabled" | "unknown";

/**
 * Claude extra usage as the Account Pooler last saw it. `observedAt` is when
 * the Pooler read it (null: never), so an old "rejected" never looks fresh.
 * `pool`: "off" when the Pooler doesn't answer, "not-routing" when it doesn't
 * route this agent; then nothing is known.
 */
export interface ExtraUsageEvidence {
  allowed: boolean;
  status?: ExtraUsageStatus;
  observedAt: number | null;
  pool?: "on" | "off" | "not-routing";
}

export type Quotas = Map<Provider, AgentQuota>;

export interface QuotaReadOptions {
  /** Skip the cache and ask each source for a new reading. */
  fresh?: boolean;
  /**
   * With fresh: the Account Pooler's accounts were just refreshed by hand
   * (account.refreshUsage), so read them again without asking twice.
   */
  poolRefreshed?: boolean;
}

export interface QuotaReader {
  /** Known quotas per agent; an agent missing from the map is unknown. */
  read(signal?: AbortSignal, options?: QuotaReadOptions): Promise<Quotas>;
}

const PROVIDER_OF: Record<string, Provider> = { "claude-code": "claude", codex: "codex" };

const listSchema = z.object({
  resources: z.array(z.object({ id: z.string(), providerId: z.string().nullable().optional() }).passthrough()),
}).passthrough();

const windowSchema = z
  .object({
    label: z.string().optional(),
    usedPercent: z.number().finite().nonnegative(),
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
  async function readings(signal?: AbortSignal, fresh = false, poolRefreshed = false): Promise<Quotas> {
    if (!fresh && cache !== null && Date.now() - cache.at < cacheMs) return cache.quotas;
    const quotas: Quotas = new Map();
    for (const source of sources) {
      // Each agent's numbers come from the first source that has them.
      const found = await readSource(bb, source, signal, fresh && !(poolRefreshed && source === "account-pool"));
      for (const [provider, quota] of found) if (!quotas.has(provider)) quotas.set(provider, quota);
      if (quotas.size === 2) break;
    }
    // Read after the sources refreshed, so the Pooler's state is its newest.
    const claude = quotas.get("claude");
    if (claude !== undefined && sources.includes("account-pool")) {
      const paid = await poolPaidState(bb, "claude", signal);
      const current = { ...claude, extraUsage: paid.extraUsage, paidAttemptAllowed: paid.attemptAllowed, ...(paid.weekly ? { weekly: paid.weekly } : {}) };
      quotas.set("claude", { ...current, weeklyAdvice: weeklyPace(current, Date.now(), cache?.quotas.get("claude")?.weeklyAdvice) });
    }
    cache = { at: Date.now(), quotas };
    return quotas;
  }
  return {
    async read(signal, readOptions) {
      const quotas = await readings(signal, readOptions?.fresh, readOptions?.poolRefreshed);
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
    if (reading !== undefined && reading.usedPercent >= 100) {
      merged.set(provider, { ...reading, blockedUntil: until });
      continue;
    }
    merged.set(provider, { provider, usedPercent: 100, resetsAt: new Date(until).toISOString(), window: "Usage limit (hit)", blockedUntil: until });
  }
  return merged;
}

// The Account Pooler's status.get. Every field may be missing, null or of
// another type in another version: a field that doesn't fit reads as null,
// an account without an id is skipped, and unknown fields are ignored.
const maybeNumber = z.number().finite().nullable().optional().catch(null);
const maybeString = z.string().nullable().optional().catch(null);
const poolWindowSchema = z
  .object({
    slot: maybeString,
    windowMinutes: maybeNumber,
    /** 0–1 (over 1 past the limit). */
    utilization: maybeNumber,
    resetAt: z.union([z.number().finite(), z.string()]).nullable().optional().catch(null),
    /** allowed, allowed_warning, rejected. */
    status: maybeString,
    observedAt: maybeNumber,
  })
  .passthrough();
const poolAccountSchema = z
  .object({
    id: z.string().min(1),
    provider: maybeString,
    label: maybeString,
    email: maybeString,
    enabled: z.boolean().nullable().optional().catch(null),
    status: maybeString,
    usageRestriction: z.unknown().optional(),
    extraUsage: z.object({ status: maybeString, observedAt: maybeNumber }).passthrough().nullable().optional().catch(null),
    familyWeekly: z.record(z.string(), poolWindowSchema.nullable().catch(null)).nullable().optional().catch(null),
    limitWindows: z.array(poolWindowSchema.nullable().catch(null)).nullable().optional().catch(null),
    observedAt: maybeNumber,
    heldUntil: maybeNumber,
    error: z.unknown().optional(),
  })
  .passthrough();
const poolStatusSchema = z
  .object({
    routing: z.object({ claude: z.boolean().optional().catch(undefined), codex: z.boolean().optional().catch(undefined) }).passthrough(),
    accounts: z.array(poolAccountSchema.nullable().catch(null)).nullable().optional().catch(null),
  })
  .passthrough();

type PoolAccount = z.infer<typeof poolAccountSchema>;
interface PoolStatus {
  routing: Partial<Record<Provider, boolean>>;
  accounts: PoolAccount[];
}

/** The Pooler's status.get (read-only), or a throw when it doesn't answer. */
async function readPoolStatus(bb: BbPluginApi, signal?: AbortSignal): Promise<PoolStatus> {
  const raw = await bb.sdk.plugins.callRpc({
    pluginId: "account-pool",
    method: "status.get",
    input: null,
    outputSchema: poolStatusSchema,
    ...(signal ? { signal } : {}),
  } as never);
  const status = poolStatusSchema.parse(raw);
  return { routing: status.routing, accounts: (status.accounts ?? []).filter((account): account is PoolAccount => account !== null) };
}

/**
 * The Account Pooler's readings count only for agents it routes, and only for
 * accounts it uses; for the others the host's own login is what chats use.
 */
async function poolFilter(bb: BbPluginApi, signal?: AbortSignal): Promise<(resourceId: string, provider: Provider) => boolean> {
  const status = await readPoolStatus(bb, signal);
  const accounts = new Map(status.accounts.map((account) => [account.id, account]));
  return (resourceId, provider) => {
    if (status.routing[provider] !== true) return false;
    const account = accounts.get(resourceId);
    return account === undefined || account.status !== "disabled";
  };
}

const UNKNOWN_EXTRA_USAGE = (pool: ExtraUsageEvidence["pool"]): ExtraUsageEvidence => ({ allowed: false, status: "unknown", observedAt: null, pool });

/**
 * Read AFTER fresh resource refreshes; subscription numbers alone never imply
 * paid room. The newest allowed account wins (the Pooler moves to it);
 * otherwise the newest real reading, with the time the Pooler took it.
 */
export async function poolExtraUsage(bb: BbPluginApi, provider: Provider, signal?: AbortSignal): Promise<ExtraUsageEvidence> {
  let status: PoolStatus;
  try {
    status = await readPoolStatus(bb, signal);
  } catch {
    return UNKNOWN_EXTRA_USAGE("off");
  }
  return extraUsageFrom(status, provider);
}

/** Routing/credential state is separate from unreliable paid-usage telemetry. */
async function poolPaidState(bb: BbPluginApi, provider: Provider, signal?: AbortSignal): Promise<{ extraUsage: ExtraUsageEvidence; attemptAllowed: boolean; weekly?: AgentQuota["weekly"] }> {
  let status: PoolStatus;
  try { status = await readPoolStatus(bb, signal); }
  catch { return { extraUsage: UNKNOWN_EXTRA_USAGE("off"), attemptAllowed: false }; }
  const attemptAllowed = status.routing[provider] === true && status.accounts.some(account =>
    account.provider === provider && account.enabled !== false && account.status === "ready" &&
    account.usageRestriction == null && (account.heldUntil == null || account.heldUntil <= Date.now()) &&
    account.error == null,
  );
  const weekly = status.accounts.filter(account => account.provider === provider && account.enabled !== false && account.status === "ready")
    .flatMap(account => (account.limitWindows ?? []).flatMap(window => {
      const resetsAt = instant(window?.resetAt);
      return window?.windowMinutes === 7 * 24 * 60 && typeof window.utilization === "number" && window.utilization >= 0 && resetsAt
        ? [{ usedPercent: window.utilization * 100, resetsAt, windowMinutes: window.windowMinutes }] : [];
    })).sort((a,b) => a.usedPercent - b.usedPercent)[0];
  return { extraUsage: extraUsageFrom(status, provider), attemptAllowed, ...(weekly ? { weekly } : {}) };
}

function extraUsageFrom(status: PoolStatus, provider: Provider): ExtraUsageEvidence {
  if (status.routing[provider] !== true) return UNKNOWN_EXTRA_USAGE("not-routing");
  const readings = status.accounts
    .filter(a => a.provider === provider && a.status === "ready")
    .map(accountExtraUsage)
    .sort((a, b) => (b.observedAt ?? -Infinity) - (a.observedAt ?? -Infinity));
  return readings.find(r => r.allowed) ?? readings.find(r => r.observedAt !== null) ?? readings[0] ?? UNKNOWN_EXTRA_USAGE("on");
}

/** One account's extra usage: a usage restriction (a spend control) turns it off for the account. */
function accountExtraUsage(a: PoolAccount): ExtraUsageEvidence {
  const observedAt = typeof a.extraUsage?.observedAt === "number" ? a.extraUsage.observedAt : null;
  if (a.usageRestriction != null) return { allowed: false, status: "disabled", observedAt, pool: "on" };
  const status = a.extraUsage?.status;
  if ((status !== "allowed" && status !== "rejected") || observedAt === null) return { allowed: false, status: "unknown", observedAt, pool: "on" };
  return { allowed: status === "allowed", status, observedAt, pool: "on" };
}

// ------------------------------------------------------------- per account

/** One limit of one pooled account, as the Account Pooler last read it. */
export interface AccountWindow {
  /** "5-hour limit", "Weekly limit", "Fable weekly limit". */
  label: string;
  /** The model family a model-only limit applies to ("fable"); null: every model. */
  model: string | null;
  /** Percent used (over 100 past the limit); null: not read yet. */
  usedPercent: number | null;
  resetsAt: string | null;
  /** The provider refuses work at this limit now. */
  atLimit: boolean;
  /** When the Pooler read it (epoch ms; null: never). */
  observedAt: number | null;
}

export interface PoolAccountUsage {
  id: string;
  provider: Provider;
  /** The email, else the Pooler's label. */
  name: string;
  /** Off in the Account Pooler: chats don't use it. */
  enabled: boolean;
  /** The Pooler's state when it isn't "ready" (null: ready, or not said). */
  state: string | null;
  windows: AccountWindow[];
  extraUsage: ExtraUsageEvidence;
  /** The newest reading of this account (epoch ms; null: never). */
  observedAt: number | null;
  heldUntil: number | null;
  /** The Pooler's last error for this account. */
  error: string | null;
}

/** Every pooled account, or "off" when the Account Pooler doesn't answer. */
export type PoolUsage = { pool: "on"; routing: Record<Provider, boolean>; accounts: PoolAccountUsage[] } | { pool: "off" };

/** The Account Pooler's accounts and their limits, read-only (status.get). */
export async function readPoolUsage(bb: BbPluginApi, signal?: AbortSignal): Promise<PoolUsage & { claudeExtraUsage: ExtraUsageEvidence }> {
  let status: PoolStatus;
  try {
    status = await readPoolStatus(bb, signal);
  } catch {
    return { pool: "off", claudeExtraUsage: UNKNOWN_EXTRA_USAGE("off") };
  }
  return {
    pool: "on",
    routing: { claude: status.routing.claude === true, codex: status.routing.codex === true },
    accounts: status.accounts.flatMap((account) => {
      const usage = accountUsage(account);
      return usage === null ? [] : [usage];
    }),
    claudeExtraUsage: extraUsageFrom(status, "claude"),
  };
}

const FAMILY_LABEL: Record<string, string> = { other: "Other models" };

function windowLabel(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return "Usage limit";
  if (minutes === 7 * 1440) return "Weekly limit";
  if (minutes === 1440) return "Daily limit";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

function instant(value: number | string | null | undefined): string | null {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function toWindow(window: z.infer<typeof poolWindowSchema>, label: string, model: string | null): AccountWindow {
  // Rounded like the Pooler's provider-usage reading the relay goes by, so a bar and the next step agree on "at its limit".
  const usedPercent = typeof window.utilization === "number" ? Math.round(window.utilization * 100) : null;
  return {
    label,
    model,
    usedPercent,
    resetsAt: instant(window.resetAt),
    atLimit: window.status === "rejected" || (usedPercent !== null && usedPercent >= 100),
    observedAt: window.observedAt ?? null,
  };
}

/** The Pooler's error for an account (a string or { message }), or null when there is none. */
export function poolErrorText(error: unknown): string | null {
  if (typeof error === "string") return error.trim() || null;
  if (error !== null && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message.trim() || null;
  return null;
}

/** One account for the usage view: all-model limits first (shortest first), then model-only ones. */
function accountUsage(account: PoolAccount): PoolAccountUsage | null {
  const provider = account.provider === "claude" || account.provider === "codex" ? account.provider : null;
  if (provider === null) return null;
  const general = (account.limitWindows ?? [])
    .filter((window): window is z.infer<typeof poolWindowSchema> => window !== null)
    .sort((a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity))
    .map((window) => toWindow(window, windowLabel(window.windowMinutes ?? null), null));
  const families = Object.entries(account.familyWeekly ?? {}).flatMap(([family, window]) =>
    window ? [toWindow(window, `${FAMILY_LABEL[family] ?? family.charAt(0).toUpperCase() + family.slice(1)} weekly limit`, family)] : [],
  );
  const windows = [...general, ...families];
  const times = [account.observedAt, ...windows.map((window) => window.observedAt)].filter((at): at is number => typeof at === "number");
  const disabled = account.enabled === false || account.status === "disabled";
  return {
    id: account.id,
    provider,
    name: account.email?.trim() || account.label?.trim() || `${provider === "claude" ? "Claude" : "Codex"} account`,
    enabled: !disabled,
    state: disabled || account.status == null || account.status === "ready" ? null : account.status,
    windows,
    extraUsage: accountExtraUsage(account),
    observedAt: times.length > 0 ? Math.max(...times) : null,
    heldUntil: account.heldUntil ?? null,
    error: poolErrorText(account.error),
  };
}

async function readSource(bb: BbPluginApi, sourcePluginId: string, signal?: AbortSignal, fresh = false): Promise<Quotas> {
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
          input: { resourceId: resource.id, refresh: fresh },
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
      if (quota) quotas.set(provider, { ...quota, source: sourcePluginId });
    }
  } catch {
    // This source isn't installed or doesn't answer: try the next one.
  }
  return quotas;
}

export interface WeeklyPace {
  conserve: boolean;
  projectedPercent: number;
  resetsAt: string;
}

/**
 * Advisory average pace through an explicit weekly window, never an admission
 * or billing decision. A prior conserve advice clears below 95% projected
 * usage to avoid toggling on small reading/reset jitter around 100%.
 */
export function weeklyPace(quota: AgentQuota | undefined, now = Date.now(), previous?: WeeklyPace | null): WeeklyPace | null {
  const weekly = quota?.weekly;
  if (!weekly || weekly.windowMinutes !== 7 * 24 * 60 || !Number.isFinite(weekly.usedPercent) || weekly.usedPercent < 0) return null;
  const duration = weekly.windowMinutes * 60_000, reset = Date.parse(weekly.resetsAt), elapsed = now - (reset - duration);
  // A due reset or a window that has barely started is not enough evidence.
  if (!Number.isFinite(reset) || elapsed < 60 * 60_000 || elapsed >= duration) return null;
  const projectedPercent = weekly.usedPercent * duration / elapsed;
  const sameWindow = previous && Math.abs(Date.parse(previous.resetsAt) - reset) < 5 * 60_000;
  return { conserve: projectedPercent > (sameWindow && previous.conserve ? 95 : 100), projectedPercent, resetsAt: weekly.resetsAt };
}

/** "Claude: 21% of the weekly limit used, resets 2026-11-12 01:00 UTC" */
export function quotaLine(quota: AgentQuota | undefined, provider: Provider, now = Date.now()): string {
  const name = provider === "claude" ? "Claude" : "Codex";
  if (!quota) return `${name}: usage unknown`;
  const resets = quota.resetsAt ? `, resets ${new Date(quota.resetsAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
  const pace = provider === "claude" ? quota.weeklyAdvice ?? weeklyPace(quota, now) : null;
  const advice = pace?.conserve ? `; weekly pace projects ${Math.round(pace.projectedPercent)}% by reset: consider Codex for flexible implementation, preserve Claude for orchestration/reviews until the normal cutoff` : "";
  return `${name}: ${Math.round(quota.usedPercent)}% of the ${quota.window.toLowerCase()} used${resets}${advice}`;
}

/** What the relay RPC shows: the Pooler's verdict and when it was taken. */
export function extraUsageDto(evidence: ExtraUsageEvidence): { status: ExtraUsageStatus; observedAt: number | null; pool: "on" | "off" | "not-routing" } {
  return { status: evidence.status ?? (evidence.allowed ? "allowed" : "unknown"), observedAt: evidence.observedAt, pool: evidence.pool ?? "on" };
}
