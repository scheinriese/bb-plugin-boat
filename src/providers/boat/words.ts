// boat's words: its commands, links and hints, and its errors in plain
// words. Every surface shares them (the setup checks, the CLI, the page, the
// agent tools); a leaf module, so BoatError can explain itself.
import type { ExplainedError } from "../types.ts";
import type { Provider } from "../../store.ts";
import type { BoatError } from "./cli.ts";

export const INSTALL_COMMAND = "curl -fsSL https://boat.dev/install | sh";
export const SIGN_IN_COMMAND = "boat onboard";
export const PLAN_COMMAND = "boat billing plan 20";
export const DASHBOARD_URL = "https://boat.dev/dashboard";
export const AGENTS_URL = "https://boat.dev/dashboard?tab=agents";
export const ENVIRONMENT_URL = "https://boat.dev/dashboard?tab=environment";

export const SIGN_IN_HINT = "Sign in to boat.dev: run `boat onboard` in a terminal.";
export const PLAN_HINT = `Start a boat plan (7-day trial, card required): run \`${PLAN_COMMAND}\` or open ${DASHBOARD_URL}.`;
export const INSTALL_HINT = `Install it: run \`${INSTALL_COMMAND}\` in a terminal (it signs you in and starts your trial). Installed somewhere else? Set boat CLI location in this plugin's settings.`;
export const GITHUB_HINT = 'Connect GitHub on boat.dev → Environment and give boat access to this repo (or turn off "Safe for third parties").';
export const DOCTOR_HINT = "Run `bb boat doctor` to see every check.";

export const AGENT_NAME: Record<Provider, string> = { claude: "Claude", codex: "Codex" };
/** What to connect on boat.dev for each agent. */
const LOGIN_NAME: Record<Provider, string> = { claude: "Claude", codex: "ChatGPT" };

export function agentsHint(providers: readonly Provider[] = ["claude", "codex"]): string {
  const names = providers.map((provider) => LOGIN_NAME[provider]).join(" or ");
  return `Connect ${names} on boat.dev → Agents (${AGENTS_URL}). Already connected? Your boat environment may be set to "Safe for third parties", which hides agent logins from sandboxes.`;
}

/** The fix for "Safe for third parties" when the command is shown on its own. */
export const SAFETY_TEXT = 'Turn off "Safe for third parties" for it on boat.dev → Environment, or run this in a terminal:';
export const RELOAD_COMMAND = "bb plugin reload boat";

export function safetyHint(environment: string): string {
  return `Turn off "Safe for third parties" for it on boat.dev → Environment, or run \`boat env set ${environment} --safe-for-third-parties false\`.`;
}

/** The message posted when the plugin loads without the boat CLI (cleared by a reload or a settings save). */
export const CLI_MISSING_STATUS = `The boat CLI was not found. Install it: run \`${INSTALL_COMMAND}\` in a terminal, then reload the plugin (\`bb plugin reload boat\`). Installed somewhere else? Set boat CLI location in this plugin's settings, then reload the plugin.`;

// ---------------------------------------------------------------- explaining errors

/** Which login a boat error is about, from its text. */
function loginFromText(text: string): Provider[] {
  const claude = /claude|anthropic/i.test(text);
  const codex = /codex|openai|chatgpt|gpt/i.test(text);
  return claude && !codex ? ["claude"] : codex && !claude ? ["codex"] : ["claude", "codex"];
}

/** boat's errors in plain words, with what to do (the CLI, the page and agent tools share them). */
export function explainBoatError(error: BoatError): ExplainedError {
  const text = `${error.code} ${error.message}`;
  if (error.code === "boat_not_found") return { code: error.code, message: "The boat CLI was not found.", hint: INSTALL_HINT };
  if (error.code === "unauthorized" || error.status === 401) return { code: "unauthorized", message: "You're not signed in to boat.dev.", hint: SIGN_IN_HINT };
  if (error.code === "provider_not_configured") return { code: error.code, message: `boat: ${error.message}`, hint: agentsHint(loginFromText(error.message)) };
  if (!/snapshot/i.test(text) && (/checkout_required|payment_required|plan_required|no_plan|subscription_required/.test(error.code) || error.status === 402)) {
    return { code: error.code, message: `boat: ${error.message}`, hint: PLAN_HINT };
  }
  return { code: error.code, message: `boat: ${error.message}`, hint: null };
}
