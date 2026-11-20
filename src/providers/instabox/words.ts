// Instabox's words: its commands, links and hints, and its errors in plain
// words. A leaf module, so InstaboxError can explain itself.
import type { ExplainedError } from "../types.ts";
import type { InstaboxError } from "./cli.ts";

export const INSTALL_COMMAND = "npm install -g instabox";
export const DASHBOARD_URL = "https://instabox.sh/dashboard";
export const KEYS_URL = "https://instabox.sh/docs/security/api-keys.md";
export const GITHUB_LOGIN_HINT = "The Instabox machine has no GitHub login. Save a GitHub token as an Instabox Secret for github.com and api.github.com (`instabox secrets set GH_TOKEN --host github.com --host api.github.com`). For a team org, add `--org <org>` so the Secret is saved in the API key's org. Then try again.";
/** Where the owner stores the key: bb's secure entry for this plugin's secret setting. */
export const KEY_HINT =
  "Add your Instabox API key in bb: Settings → Plugins → Harbormaster → Instabox API key (create one with `instabox keys create --name bb`). It is kept in bb's secret store.";
export const ENABLE_HINT = "Turn Instabox on with `bb boat config set instaboxEnabled true` (or in the plugin's settings), then add its API key.";
export const INSTALL_HINT = `Install the instabox CLI: run \`${INSTALL_COMMAND}\` in a terminal. Installed somewhere else? Set Instabox CLI location (\`bb boat config set instaboxPath <path>\`).`;
export const INVITE_HINT = "Instabox's free accounts are invite-only: redeem an invite code (`instabox login --invite-code <code>`) or start a paid plan at https://instabox.sh/pricing.";

/** Instabox's errors in plain words, with what to do (the CLI, the page and agent tools share them). */
export function explainInstaboxError(error: InstaboxError): ExplainedError {
  const code = error.code;
  if (code === "instabox_not_found") return { code, message: "The instabox CLI was not found.", hint: INSTALL_HINT };
  if (code === "key_missing" || code === "missing_key") return { code: "key_missing", message: "No Instabox API key is stored.", hint: KEY_HINT };
  if (/^(unauthenticated|malformed_key|invalid_key|expired_key|revoked_key|api_key_expired|api_key_revoked)$/.test(code) || error.status === 401) {
    return { code: "unauthorized", message: `Instabox refused the API key: ${error.message}`, hint: KEY_HINT };
  }
  if (code === "invite_required") return { code, message: "Your Instabox account isn't activated yet (invite only).", hint: INVITE_HINT };
  if (code === "missing_scope" || code === "insufficient_scope") {
    return { code, message: `The Instabox API key lacks a permission: ${error.message}`, hint: "Create a key with the default scopes (machines:read, machines:write, machines:delete, images:read)." };
  }
  if (code === "no_capacity") return { code, message: "Instabox has no room for a new machine right now.", hint: "Try again in a minute; nothing was created." };
  if (/^(quota_exceeded|credit_exhausted|spend_limit_reached|spec_not_allowed|template_not_allowed|template_limit|subscription_required|payment_method_required)$/.test(code) || error.status === 402) {
    return { code, message: `Instabox: ${error.message}`, hint: "Run `instabox usage` to see your plan's limits; delete machines you no longer need with `instabox rm <name>`." };
  }
  if (error.retryable || code === "host_unavailable" || code === "instabox_timeout" || (error.status !== null && error.status >= 500)) {
    return { code, message: `Instabox isn't answering right now: ${error.message}`, hint: "Try again shortly (https://statuspage.incident.io/instabox); nothing was marked failed." };
  }
  return { code, message: `Instabox: ${error.message}`, hint: null };
}
