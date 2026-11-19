// RPC handlers for the usage view (contract-usage.ts), Settings › Usage
// limits: which agent can run now, and why. Boat only reads from the Account
// Pooler (status.get); the one call that asks it for anything is
// account.refreshUsage, and only when the user presses Refresh. Never its
// credentials, its other account.*, routing, config or login methods.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { TAGS, type UsageViewDto } from "../contract.ts";
import { extraUsageDto, poolErrorText, readPoolUsage, type AgentQuota, type QuotaReader, type Quotas } from "./quota.ts";
import { automaticPaidClaude, effectiveRelay, nextForNewWork, onlyAgent, type NewWorkSettings } from "./relay.ts";
import type { Runtime } from "./runtime.ts";
import { PROVIDERS } from "./store.ts";

/** A refresh the Pooler doesn't finish in this long is reported, not waited for. */
export const REFRESH_TIMEOUT_MS = 30_000;

type PoolReading = Awaited<ReturnType<typeof readPoolUsage>>;
type AgentSource = UsageViewDto["agents"][number]["source"];

function sourceOf(quota: AgentQuota): AgentSource {
  if (quota.source === "account-pool") return "pool";
  if (quota.source !== undefined) return "login";
  return quota.blockedUntil !== undefined ? "limit-hit" : null;
}

/**
 * The view from one reading: the Pooler's accounts as it saw them, the
 * relay's per-agent numbers, and the next step from the relay's own checks.
 */
export function usageView({ quotas, pool, settings, now }: { quotas: Quotas; pool: PoolReading; settings: NewWorkSettings; now: number }): UsageViewDto {
  const only = onlyAgent(settings.agents);
  return {
    checkedAt: now,
    pool: pool.pool,
    routing: pool.pool === "on" ? pool.routing : { claude: false, codex: false },
    accounts:
      pool.pool === "on"
        ? pool.accounts.map((account) => ({
            id: account.id,
            provider: account.provider,
            name: account.name,
            enabled: account.enabled,
            state: account.state,
            windows: account.windows,
            credits: account.provider === "claude" ? { status: account.extraUsage.status ?? "unknown", observedAt: account.extraUsage.observedAt } : null,
            observedAt: account.observedAt,
            heldUntil: account.heldUntil,
            error: account.error,
          }))
        : [],
    agents: PROVIDERS.filter((provider) => only === null || provider === only).map((provider) => {
      const quota = quotas.get(provider);
      return {
        provider,
        usedPercent: quota?.usedPercent ?? null,
        window: quota?.window ?? null,
        resetsAt: quota?.resetsAt ?? null,
        source: quota === undefined ? null : sourceOf(quota),
        limitHitUntil: quota?.blockedUntil ?? null,
      };
    }),
    onlyAgent: only,
    switchAtPercent: settings.relay.switchAtPercent,
    paidClaudeFallback: settings.relay.paidClaudeFallback === true,
    paidClaudeHeadless: settings.relay.paidClaudeHeadless === true,
    paidClaudeAvailable: automaticPaidClaude(quotas, settings.relay, settings.agents, now),
    // The relay's own evidence first, so it matches paidClaudeAvailable.
    claudeExtraUsage: extraUsageDto(quotas.get("claude")?.extraUsage ?? pool.claudeExtraUsage),
    next: { ...nextForNewWork(quotas, settings, now), switching: effectiveRelay(settings.relay, settings.agents).enabled },
  };
}

/** A failed refresh in plain words. */
export function refreshErrorText(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "The Account Pooler didn't answer in time.";
  const text = (error instanceof Error ? error.message : String(error)).trim();
  if (/unknown method|method not found|no such method|not implemented/i.test(text)) return "This Account Pooler can't refresh from Boat. Use Reload in its own settings.";
  if (/not installed|not enabled|disabled|not running/i.test(text)) return "The Account Pooler is off.";
  return text.slice(0, 300) || "The Account Pooler couldn't refresh it.";
}

/**
 * account.refreshUsage's reply (bb 0.49.0): the account's status after the
 * refresh, or null when the Pooler doesn't have the account. A failed
 * refresh usually doesn't throw: it comes back with the account's error.
 */
const refreshReplySchema = z.object({ account: z.object({ error: z.unknown().optional() }).passthrough().nullable() }).passthrough();

/** What a refresh reply says went wrong, in plain words; null when it worked. */
export function refreshReplyError(value: unknown): string | null {
  const reply = refreshReplySchema.safeParse(value);
  if (!reply.success) return "The Account Pooler's answer couldn't be read.";
  if (reply.data.account === null) return "The Account Pooler no longer has this account.";
  return poolErrorText(reply.data.account.error)?.slice(0, 300) ?? null;
}

/**
 * New readings because the user asked: account.refreshUsage for each
 * account the Pooler uses, then the relay's numbers again (the providers'
 * own logins with a refresh; the Pooler's without asking it twice).
 */
export async function refreshUsage(bb: BbPluginApi, quotas: QuotaReader | null): Promise<{ errors: { accountId: string | null; name: string | null; message: string }[] }> {
  const errors: { accountId: string | null; name: string | null; message: string }[] = [];
  const pool = await readPoolUsage(bb);
  if (pool.pool === "on") {
    const accounts = pool.accounts.filter((account) => account.enabled);
    const results = await Promise.allSettled(
      accounts.map((account) =>
        bb.sdk.plugins.callRpc({
          pluginId: "account-pool",
          method: "account.refreshUsage",
          input: { accountId: account.id },
          outputSchema: z.unknown(),
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        } as never),
      ),
    );
    results.forEach((result, index) => {
      const message = result.status === "rejected" ? refreshErrorText(result.reason) : refreshReplyError(result.value);
      if (message !== null) errors.push({ accountId: accounts[index]!.id, name: accounts[index]!.name, message });
    });
  }
  if (quotas !== null) {
    await quotas.read(undefined, { fresh: true, poolRefreshed: pool.pool === "on" }).catch((error: unknown) => {
      errors.push({ accountId: null, name: null, message: `Couldn't read usage again: ${refreshErrorText(error)}` });
    });
  }
  return { errors };
}

export function usageHandlers(runtime: Runtime) {
  const { bb, service } = runtime;
  // One refresh at a time: a second press waits for the running one.
  let refreshing: ReturnType<typeof refreshUsage> | null = null;
  return {
    usage: async () => {
      const settings = await service.settings();
      const [quotas, pool] = await Promise.all([
        runtime.quotas ? runtime.quotas.read().catch((): Quotas => new Map()) : Promise.resolve<Quotas>(new Map()),
        readPoolUsage(bb),
      ]);
      return usageView({ quotas, pool, settings, now: Date.now() });
    },
    refreshUsage: async () => {
      refreshing ??= refreshUsage(bb, runtime.quotas).finally(() => {
        refreshing = null;
      });
      const result = await refreshing;
      // The homepage line, the thread chip and the queue card show the new numbers too.
      bb.rpc.experimental_invalidate([TAGS.relay]);
      return result;
    },
  };
}
