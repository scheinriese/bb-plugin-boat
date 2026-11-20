// Credentials for SSH-reachable machines. Secrets stay in bb settings and
// travel only in the executor's private stdin, outside bootstrap/task logs.
import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ConnectCheck } from "./connect.ts";
import type { Provider } from "./store.ts";

const REFRESH_MARGIN = 45 * 60_000;
const problem = (message: string, code = "task_credentials_missing") => Object.assign(new Error(message), { code });
export const GITHUB_TOKEN_HELP = "Store GitHub token for rented machines in bb secret settings. Use a fine-grained token: only selected task repositories; Contents, Pull requests and Workflows read and write; 90-day expiry. Never paste it in chat.";

// Force file storage rather than the Mac's Keychain so cleanup can be verified.
// Neither this script nor argv contains the token. gh alone consumes stdin.
export const GITHUB_LOGIN_SCRIPT = `set +x
set -eu
umask 077
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_DEBUG GH_CONFIG_DIR XDG_CONFIG_HOME
test ! -L "$HOME/.config"
test ! -L "$HOME/.config/gh"
mkdir -p "$HOME/.config/gh"
test -z "$(find "$HOME/.config/gh" -type l -print -quit)"
chmod 700 "$HOME/.config/gh"
gh auth login --hostname github.com --git-protocol https --with-token --insecure-storage >/dev/null 2>&1
gh auth setup-git --hostname github.com >/dev/null 2>&1
find "$HOME/.config/gh" -type f -exec chmod 600 {} \\;
`;
export const GITHUB_CLEANUP_SCRIPT = `set +x
set -eu
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_DEBUG GH_CONFIG_DIR XDG_CONFIG_HOME
test ! -L "$HOME/.config"
if command -v gh >/dev/null 2>&1; then gh auth logout --hostname github.com </dev/null >/dev/null 2>&1 || true; fi
rm -rf "$HOME/.config/gh"
test ! -e "$HOME/.config/gh" && test ! -L "$HOME/.config/gh"
`;
export const CREDENTIAL_CLEANUP_SCRIPT = GITHUB_CLEANUP_SCRIPT + `
if command -v claude >/dev/null 2>&1; then claude auth logout </dev/null >/dev/null 2>&1 || true; fi
if command -v codex >/dev/null 2>&1; then codex logout </dev/null >/dev/null 2>&1 || true; fi
rm -f "$HOME/.claude/.credentials.json" "$HOME/.codex/auth.json"
for file in "$HOME/.claude/.credentials.json" "$HOME/.codex/auth.json"; do test ! -e "$file" && test ! -L "$file"; done
`;

export interface CredentialSource {
  githubConfigured(): Promise<boolean>;
  githubDeliveryProblem?(): Promise<string | null>;
  agentAvailable(agent: Provider, signal?: AbortSignal): Promise<boolean>;
  assertGithubAccess(repos: readonly string[], signal?: AbortSignal): Promise<void>;
  assertReady(agent: Provider, repos: readonly string[], signal?: AbortSignal): Promise<void>;
  ensureGithub(id: string, executor: MachineExecutor, signal?: AbortSignal, force?: boolean, beforeDelivery?: (expiresAt: string) => void | Promise<void>): Promise<string | null>;
  cleanupGithub(id: string, executor: MachineExecutor, signal?: AbortSignal): Promise<void>;
  cleanup(id: string, executor: MachineExecutor, signal?: AbortSignal): Promise<void>;
}

/** Only reads Pooler status. Core resolves serverPath through the enrolled
 * daemon's authenticated proxy and owns its per-machine bearer. No AI login
 * files, Pooler tokens or write RPCs are read or managed by this plugin. */
export function createAgentRouteCheck(bb: Pick<BbPluginApi, "sdk">, connect: ConnectCheck) {
  const schema = z.object({
    accepting: z.boolean(),
    routing: z.object({ claude: z.boolean(), codex: z.boolean() }),
    accounts: z.array(z.object({ provider: z.string(), enabled: z.boolean(), status: z.string() })),
    parent: z.object({ mode: z.string(), availability: z.object({ claude: z.boolean(), codex: z.boolean() }) }).nullable().optional(),
  });
  return async (agent: Provider, signal?: AbortSignal): Promise<boolean> => {
    try {
      if ((await connect()).state !== "ready") return false;
      const status = schema.parse(await bb.sdk.plugins.callRpc({ pluginId: "account-pool", method: "status.get", input: null, outputSchema: schema, signal } as never));
      if (!status.accepting || !status.routing[agent]) return false;
      if (status.parent?.mode === "proxy") return status.parent.availability[agent];
      return status.accounts.some(account => account.provider === agent && account.enabled && account.status === "ready");
    } catch { return false; }
  };
}

export function createCredentialSource(options: {
  githubToken(): Promise<string | null>;
  agentAvailable(agent: Provider, signal?: AbortSignal): Promise<boolean>;
  assertDeliveryAllowed?(): Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}): CredentialSource {
  const fetcher = options.fetch ?? fetch, now = options.now ?? Date.now;
  const delivered = new Map<string, { expiresAt: string; fingerprint: string }>(); // No raw tokens.
  async function token() {
    try {
      const value = await options.githubToken();
      if (value && /^[A-Za-z0-9_]+$/.test(value)) return value;
    } catch { /* Secret store errors must not escape. */ }
    throw problem(GITHUB_TOKEN_HELP);
  }
  async function access(value: string, repos: readonly string[], signal?: AbortSignal) {
    try {
      let expiry: string | null = null;
      for (const repo of [null, ...new Set(repos)]) {
        if (repo !== null && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error();
        const response = await fetcher(`https://api.github.com/${repo === null ? "user" : `repos/${repo}`}`, {
          headers: { Authorization: `Bearer ${value}`, Accept: "application/vnd.github+json" },
          redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error();
        const header = response.headers.get("github-authentication-token-expiration");
        const parsed = header ? Date.parse(header.replace(" UTC", "Z").replace(" ", "T")) : NaN;
        if (Number.isFinite(parsed)) expiry = new Date(parsed).toISOString();
        if (repo !== null) {
          const data = await response.json() as { permissions?: { push?: boolean; pull?: boolean } };
          if (data.permissions?.push !== true || data.permissions?.pull !== true) throw new Error();
        } else await response.body?.cancel();
      }
      if (!expiry || Date.parse(expiry) - now() <= REFRESH_MARGIN) throw new Error();
      return expiry;
    } catch {
      throw problem(`The rented-machine GitHub token could not verify repository access and at least 45 minutes of validity. ${GITHUB_TOKEN_HELP}`);
    }
  }
  async function execute(executor: MachineExecutor, command: string[], stdin: string | undefined, signal?: AbortSignal) {
    // Discard output: even a misbehaving gh/transport cannot log a secret.
    try { return (await executor.exec({ command, stdin: stdin ?? "", onOutput: () => undefined, timeoutMs: 60_000, signal: signal ?? AbortSignal.timeout(60_000) })).exitCode === 0; }
    catch { return false; }
  }
  const source: CredentialSource = {
    async githubConfigured() { try { await token(); return true; } catch { return false; } },
    async githubDeliveryProblem() {
      try { await options.assertDeliveryAllowed?.(); return null; }
      catch (error) { return (error as {code?:string} | null)?.code === "task_credentials_missing" ? (error as Error).message : "GitHub delivery is blocked because the rented-machine account fingerprint could not be verified."; }
    },
    agentAvailable: options.agentAvailable,
    async assertGithubAccess(repos, signal) { await options.assertDeliveryAllowed?.(); await access(await token(), repos, signal); },
    async assertReady(agent, repos, signal) {
      if (repos.length) await source.assertGithubAccess(repos, signal);
      if (!(await options.agentAvailable(agent, signal))) throw problem(`Task credentials are not configured for ${agent}. Enable an available ${agent} route in Account Pooler and bb Connect on the owner server. Nothing was rented.`);
    },
    async ensureGithub(id, executor, signal, force = false, beforeDelivery) {
      await options.assertDeliveryAllowed?.();
      const value = await token();
      const fingerprint = createHash("sha256").update(value).digest("hex");
      const previous = delivered.get(id);
      if (!force && previous?.fingerprint === fingerprint && Date.parse(previous.expiresAt) - now() > REFRESH_MARGIN) { await beforeDelivery?.(previous.expiresAt); return previous.expiresAt; }
      delivered.delete(id);
      const expiry = await access(value, [], signal);
      await options.assertDeliveryAllowed?.();
      await beforeDelivery?.(expiry);
      // The provider may await a fresh physical-lease read before recording
      // delivery. Recheck the account after that boundary, before stdin.
      await options.assertDeliveryAllowed?.();
      if (!(await execute(executor, ["bash", "-c", GITHUB_LOGIN_SCRIPT], `${value}\n`, signal))) {
        // A shared machine may still serve other tasks. Its lifecycle owner
        // records the attempt and cleans up once no live task needs its logins.
        throw problem("GitHub credential delivery failed. Check the rented-machine token in bb secret settings.");
      }
      delivered.set(id, { expiresAt: expiry, fingerprint });
      return expiry;
    },
    async cleanupGithub(id, executor, signal) {
      delivered.delete(id);
      if (!(await execute(executor, ["bash", "-c", GITHUB_CLEANUP_SCRIPT], undefined, signal))) throw problem("Credential removal could not be verified. The machine is kept; retry cleanup before releasing it.", "credential_cleanup_failed");
    },
    async cleanup(id, executor, signal) {
      delivered.delete(id);
      if (!(await execute(executor, ["bash", "-c", CREDENTIAL_CLEANUP_SCRIPT], undefined, signal))) throw problem("Credential removal could not be verified. The machine is kept; retry cleanup before releasing it.", "credential_cleanup_failed");
    },
  };
  return source;
}
