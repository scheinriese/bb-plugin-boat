import type { SandboxInventoryDto } from "../contract-sandboxes.ts";

/** Count cloud guests only. Local task environments are not physical Macs. */
export function footerMachineCount(inventory: SandboxInventoryDto | undefined, failed = false, providerId?: string, now = Date.now()): number | null {
  const providers = inventory?.providers.filter(provider => !["ownmac", "monthly-mac"].includes(provider.id) && (providerId === undefined || provider.id === providerId));
  if (failed || !providers?.length) return null;
  if (providers.some(provider => provider.status !== "fresh" || provider.truncated || provider.poweredOn === null || provider.unknown !== 0 || !provider.observedAt || !Number.isFinite(Date.parse(provider.observedAt)) || now - Date.parse(provider.observedAt) > 10 * 60_000)) return null;
  return providers.reduce((total, provider) => total + provider.poweredOn!, 0);
}
