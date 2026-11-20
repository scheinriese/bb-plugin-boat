import { TaskError } from "./service.ts";
import type { SandboxProvider } from "./providers/types.ts";

// bb's Codex provider launches BB_CODEX_BRIDGE_APP_SERVER_COMMAND, or `codex`, through
// its host toolchain. Our remote executor approximates that environment with
// the login-shell PATH; it cannot read the running daemon's cached shell PATH.
// Resolve the actual npm entry point,
// rather than asking npm for the current user's potentially different prefix.
export const CODEX_HEALTH_SCRIPT = String.raw`
set -eu
codex_bin="$(command -v "${"$"}{BB_CODEX_BRIDGE_APP_SERVER_COMMAND:-codex}")" || { echo "Codex executable not found" >&2; exit 1; }
if output=$("$codex_bin" --version 2>&1); then exit 0; fi
case "$output" in
  (*"Missing optional dependency @openai/codex-"*) ;;
  (*) echo "Codex health check failed before opening the chat: $output" >&2; exit 1 ;;
esac
printf 'BOAT_CODEX_REPAIRING\n'
metadata=$(node - "$codex_bin" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const bin = fs.realpathSync(process.argv[2]);
const root = path.dirname(path.dirname(bin));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.name !== '@openai/codex' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) process.exit(1);
const prefix = path.resolve(root, '../../../..');
if (root !== path.join(prefix, 'lib/node_modules/@openai/codex')) process.exit(1);
console.log(pkg.version + '\n' + prefix);
NODE
) || { echo "Cannot identify the broken Codex npm installation" >&2; exit 1; }
version=$(printf '%s\n' "$metadata" | head -n 1)
prefix=$(printf '%s\n' "$metadata" | tail -n 1)
if [ -w "$prefix/lib/node_modules/@openai/codex" ] && [ -w "$prefix/bin" ] && [ -w "$prefix/lib/node_modules/@openai" ]; then
  npm install -g --prefix "$prefix" "@openai/codex@$version" --include=optional >&2
else
  sudo -n "$(command -v npm)" install -g --prefix "$prefix" "@openai/codex@$version" --include=optional >&2
fi
"$codex_bin" --version >&2
printf 'BOAT_CODEX_REPAIRED\n'
`;

export async function ensureCodexHealthy(
  provider: Pick<SandboxProvider, "exec">,
  sandboxId: string,
  agent: string,
  log: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (agent !== "codex") return;
  signal?.throwIfAborted();
  const result = await provider.exec(sandboxId, CODEX_HEALTH_SCRIPT, { timeoutMs: 120_000, login: true, ...(signal ? { signal } : {}) });
  signal?.throwIfAborted();
  if (result.exitCode !== 0) {
    const repairing = result.stdout.includes("BOAT_CODEX_REPAIRING");
    const detail = result.stderr.trim().slice(-2_000);
    throw new TaskError(
      `Codex ${repairing ? "repair" : "health check"} failed before opening the chat.${detail ? `\n${detail}` : ""}`,
      repairing ? "codex_repair_failed" : "codex_health_failed",
      repairing ? "Check npm access and permissions for the sandbox's Codex installation, then retry." : "Check the sandbox's Codex executable and environment, then retry.",
    );
  }
  if (result.stdout.includes("BOAT_CODEX_REPAIRED")) log("Repaired the sandbox's Codex install (missing platform binary)");
}

/** Cache only successful checks, scoped to a service instance and provider machine. */
export function createCodexHealthCheck(): typeof ensureCodexHealthy {
  const healthy = new WeakMap<Pick<SandboxProvider, "exec">, Set<string>>();
  return async (provider, sandboxId, agent, log, signal) => {
    if (agent !== "codex") return;
    signal?.throwIfAborted();
    if (healthy.get(provider)?.has(sandboxId)) return;
    await ensureCodexHealthy(provider, sandboxId, agent, log, signal);
    const machines = healthy.get(provider) ?? new Set<string>();
    machines.add(sandboxId);
    healthy.set(provider, machines);
  };
}
