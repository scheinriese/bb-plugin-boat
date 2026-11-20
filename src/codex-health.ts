import type { SandboxProvider } from "./providers/types.ts";

// bb's Codex provider launches BB_CODEX_BRIDGE_APP_SERVER_COMMAND, or `codex`, through
// its host toolchain (login-shell PATH). Resolve the actual npm entry point,
// rather than asking npm for the current user's potentially different prefix.
export const CODEX_HEALTH_SCRIPT = String.raw`
set -eu
codex_bin="$(command -v "${"$"}{BB_CODEX_BRIDGE_APP_SERVER_COMMAND:-codex}")"
if output=$("$codex_bin" --version 2>&1); then exit 0; fi
case "$output" in
  *"Missing optional dependency @openai/codex-"*) ;;
  *) echo "Codex health check failed before opening the chat: $output" >&2; exit 1 ;;
esac
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
  sudo -n npm install -g --prefix "$prefix" "@openai/codex@$version" --include=optional >&2
fi
"$codex_bin" --version >&2
printf 'BOAT_CODEX_REPAIRED\n'
`;

export async function ensureCodexHealthy(
  provider: Pick<SandboxProvider, "exec">,
  sandboxId: string,
  agent: string,
  log: (line: string) => void,
): Promise<void> {
  if (agent !== "codex") return;
  const result = await provider.exec(sandboxId, CODEX_HEALTH_SCRIPT, { timeoutMs: 120_000, login: true });
  if (result.exitCode !== 0) throw new Error("Codex health check or repair failed before opening the chat. Check the sandbox's Codex installation and npm access.");
  if (result.stdout.includes("BOAT_CODEX_REPAIRED")) log("Repaired the sandbox's Codex install (missing platform binary)");
}
