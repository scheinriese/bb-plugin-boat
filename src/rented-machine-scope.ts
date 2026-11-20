// Defence in depth only: bb lets agents write these settings too. Never treat
// re-enabling delivery as proof of owner identity or GitHub token revocation.
import { createHash } from "node:crypto";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const RENTED_GITHUB_SCOPE_KEY = "rentedGithubScopeV1";
export const INSTABOX_GITHUB_SCOPE_KEY = "instaboxGithubScopeV1";
const scopeSchema = z.object({ enabled: z.boolean(), key: z.string(), project: z.string(), blocked: z.array(z.enum(["key", "project"])) });
type Scope = z.infer<typeof scopeSchema>;
class ScopeError extends Error { readonly code = "task_credentials_missing"; }
export const scopeFingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const reenable = "GitHub delivery is blocked. Check the account, then re-enable GitHub token for rented machines in Settings: clear the token, save, enter it again and save. This settings check is defence in depth; agents can change settings too.";

export function createRentedMachineScope(options: { kv: PluginKvStorage; provider?: "instabox"; read(): Promise<{ enabled: boolean; key: string | null; project: string }> }) {
  const instabox = options.provider === "instabox";
  const label = instabox ? "Instabox" : "Scaleway";
  const storageKey = instabox ? INSTABOX_GITHUB_SCOPE_KEY : RENTED_GITHUB_SCOPE_KEY;
  let pending: Promise<unknown> = Promise.resolve();
  let storageFailed = false;
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(async () => {
      try { return await operation(); }
      catch (error) {
        if (error instanceof ScopeError) throw error;
        storageFailed = true;
        throw new ScopeError(`The ${label} account fingerprint could not be verified. ${reenable}`);
      }
    });
    pending = result.catch(() => undefined);
    return result;
  }
  async function check(enabledOverride?: boolean) {
    if (storageFailed && enabledOverride !== false) throw new ScopeError(`The ${label} account fingerprint could not be saved. ${reenable}`);
    const raw = await options.kv.get<unknown>(storageKey);
    const parsed = raw === undefined ? undefined : scopeSchema.safeParse(raw);
    if (parsed && !parsed.success) throw new ScopeError(`The stored ${label} account fingerprint is invalid. ${reenable}`);
    const previous = parsed?.success ? parsed.data : undefined;
    if (enabledOverride === false) {
      await options.kv.set(storageKey, { enabled: false, key: previous?.key ?? "", project: previous?.project ?? "", blocked: [] });
      storageFailed = false;
      return;
    }
    const current = await options.read();
    if (!(enabledOverride ?? current.enabled)) {
      if (previous?.enabled) await options.kv.set(storageKey, { ...previous, enabled: false });
      return;
    }
    const key = scopeFingerprint(current.key?.trim() ?? ""), project = scopeFingerprint(instabox ? current.project.trim() : current.project.trim().toLowerCase());
    if (!previous?.enabled) {
      if (!current.key?.trim() || !current.project.trim()) throw new ScopeError(`Configure the ${label} ${instabox ? "API key and endpoint" : "secret key and project"} before enabling GitHub delivery. ${reenable}`);
      await options.kv.set(storageKey, { enabled: true, key, project, blocked: [] });
      return;
    }
    const changed = [...new Set([...previous.blocked, ...(key !== previous.key ? ["key" as const] : []), ...(project !== previous.project ? ["project" as const] : [])])];
    if (changed.length) {
      const blocked: Scope = { ...previous, blocked: changed };
      await options.kv.set(storageKey, blocked);
      throw new ScopeError(`The ${label} ${changed.map(field => field === "key" ? (instabox ? "API key" : "secret key") : (instabox ? "API endpoint" : "project")).join(" and ")} changed since GitHub delivery was enabled. ${reenable}`);
    }
  }
  return {
    assertAllowed: () => serial(() => check()),
    // Verify the exact transport snapshot, after its final async key read.
    // Delivery must not resolve another key/endpoint after this check.
    assertIdentity: (key: string, endpoint: string) => serial(async () => {
      await check();
      const previous = scopeSchema.parse(await options.kv.get<unknown>(storageKey));
      const changed = [...new Set([...previous.blocked,
        ...(scopeFingerprint(key.trim()) !== previous.key ? ["key" as const] : []),
        ...(scopeFingerprint(endpoint.trim()) !== previous.project ? ["project" as const] : []),
      ])];
      if (!previous.enabled || changed.length) {
        await options.kv.set(storageKey, { ...previous, blocked: changed });
        throw new ScopeError(`The ${label} credential transport changed before delivery. ${reenable}`);
      }
    }),
    // Capture the empty/nonempty transition at the secret-setting event, even
    // when clear and re-entry happen before the next task. Changes made while
    // the plugin is stopped are not observed; reset again while it is running.
    tokenPresenceChanged: (enabled: boolean) => serial(() => check(enabled)),
    configurationChanged: (field: "key" | "project") => serial(async () => {
      const raw = await options.kv.get<unknown>(storageKey);
      if (raw === undefined) return;
      const previous = scopeSchema.parse(raw);
      if (previous.enabled) await options.kv.set(storageKey, { ...previous, blocked: [...new Set([...previous.blocked, field])] });
    }),
  };
}
