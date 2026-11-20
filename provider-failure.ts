export type ProviderFailure = {
  code: string;
  provider: string;
  mac: boolean;
  released: boolean;
  canRetry: boolean;
};
export function providerFailureCard(failure: ProviderFailure, message = "") {
  const { code, provider, mac, released } = failure,
    instabox = provider === "instabox";
  // Your Mac refusal/fallback designs are pending; use the plain task status.
  if (provider === "ownmac") return null;
  if (
    instabox &&
    (code === "github_secret_missing" ||
      (code === "setup_required" && /GitHub|GH_TOKEN/.test(message)))
  )
    return {
      kind: "github",
      tone: "owner",
      title: "Instabox can't reach GitHub yet",
      body: "The task waits; nothing was rented. Add a GitHub token as an Instabox Secret, then check again.",
    } as const;
  if (
    instabox &&
    ((code === "setup_required" && /API key|key.*not valid/i.test(message)) ||
      [
        "unauthenticated",
        "unauthorized",
        "invalid_key",
        "revoked_key",
        "expired_key",
        "key_missing",
      ].includes(code))
  )
    return {
      kind: "key",
      tone: "owner",
      title: "Instabox didn't accept the API key",
      body: "It may be missing, revoked or mistyped. Nothing was rented; check the key in bb secrets.",
    } as const;
  if (code === "no_capacity")
    return {
      kind: "capacity",
      tone: "neutral",
      title: `${instabox ? "Instabox" : "Scaleway"} has no free ${mac ? "Mac" : "machine"} right now`,
      body: "Try again later. Nothing was rented. Harbormaster does not retry automatically.",
    } as const;
  if (provider === "scaleway" && code === "task_credentials_missing")
    return {
      kind: "fresh",
      tone: "neutral",
      title: "Scaleway needs task credentials",
      body: message ? `${message}${message.includes("Nothing was rented") ? "" : " Nothing was rented."}` : "Harbormaster needs a GitHub token for rented machines. Enable the chosen agent in Account Pooler with bb Connect. Nothing was rented.",
    } as const;
  if (
    mac &&
    [
      "creation_unknown",
      "creation_allocated",
      "host_unavailable",
      "bootstrap_failed",
      "bootstrap_retryable",
      "create_timeout",
      "provider_failed",
    ].includes(code)
  )
    return {
      kind: "failed",
      tone: "broken",
      title: `The ${instabox ? "Instabox" : "Scaleway"} Mac didn't start`,
      body: released
        ? "Harbormaster released it. The 24 h minimum may still apply; check the provider's billing before retrying."
        : "The Mac's state could not be confirmed. Check the log and provider machine list before retrying; a paid lease may still be held.",
    } as const;
  return null;
}
