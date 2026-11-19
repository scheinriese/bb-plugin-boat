// Turn off Ubuntu's login message scripts before bb's SSH setup.
//
// Every SSH session runs PAM's login message (`run-parts --lsbsysinit
// /etc/update-motd.d`). Right after a wake, boat.dev is still restoring the
// disk, and a script there (90-updates-available reads apt's files) can wait
// on a file that isn't restored yet for good: sshd takes the key, but the
// session never starts, and each bootstrap try leaves one more stuck session.
// Taking the scripts' execute bit away over boat's exec API (no SSH) made
// `boat ssh` work at once. Login messages aren't needed on a bb machine.
//
// Idempotent and cheap: one `boat exec` that changes nothing when the scripts
// are already off, then never again for that sandbox while the plugin runs.
// It never fails a wake: without sudo it says so and bb's setup goes ahead.
import type { BoatApi } from "./providers/boat/api.ts";

/**
 * Plain `bash -c` (a login shell would read ~/.profile, which may not be
 * restored yet). Only what's in the folder changes: regular files lose their
 * execute bit (find without -L never follows a link), and a link (Ubuntu's
 * 50-landscape-sysinfo points into /usr/share/landscape) is renamed to a
 * name `run-parts --lsbsysinit` skips: a ".disabled" suffix (a dot and no
 * dash after it; ".boat-off" would still run).
 */
export const QUIET_LOGIN_SCRIPT = [
  "D=/etc/update-motd.d",
  '[ -d "$D" ] || { echo "BOAT_MOTD none"; exit 0; }',
  'X=$(timeout 5 find "$D" -mindepth 1 -maxdepth 1 -type f -perm /111 2>/dev/null | head -n 1)',
  'L=$(timeout 5 find "$D" -mindepth 1 -maxdepth 1 -type l ! -name "*.disabled" 2>/dev/null | head -n 1)',
  '[ -n "$X$L" ] || { echo "BOAT_MOTD off"; exit 0; }',
  "OK=1",
  '[ -z "$X" ] || timeout 10 sudo -n find "$D" -mindepth 1 -maxdepth 1 -type f -perm /111 -exec chmod a-x {} + 2>/dev/null || OK=0',
  'if [ -n "$L" ]; then',
  '  for l in "$D"/*; do',
  '    [ -L "$l" ] || continue',
  '    case "$l" in *.disabled) continue ;; esac',
  '    timeout 5 sudo -n mv -T -- "$l" "$l.disabled" 2>/dev/null || OK=0',
  "  done",
  "fi",
  '[ "$OK" = 1 ] && echo "BOAT_MOTD disabled" || echo "BOAT_MOTD failed"',
].join("\n");

export type QuietLogin = "disabled" | "off" | "none" | "failed";

export function parseQuietLogin(stdout: string): QuietLogin {
  const said = /BOAT_MOTD (disabled|off|none|failed)/.exec(stdout)?.[1];
  return (said as QuietLogin | undefined) ?? "failed";
}

/**
 * Returns the step for a sandbox that is up: turns its login message scripts
 * off (once per sandbox per plugin load), and reports what it found.
 */
export function createLoginQuieter(
  boat: Pick<BoatApi, "exec">,
  log: (line: string) => void = () => undefined,
): (sandboxId: string, signal?: AbortSignal) => Promise<QuietLogin> {
  const done = new Set<string>();
  return async (sandboxId, signal) => {
    if (done.has(sandboxId)) return "off";
    let result: QuietLogin;
    try {
      result = parseQuietLogin((await boat.exec(sandboxId, QUIET_LOGIN_SCRIPT, { timeoutMs: 20_000, signal, login: false })).stdout);
    } catch (error) {
      signal?.throwIfAborted();
      log(`login scripts on ${sandboxId}: ${error instanceof Error ? error.message : String(error)}`);
      return "failed";
    }
    if (result === "failed") log(`login scripts on ${sandboxId}: couldn't turn them off (no sudo?); bb's setup goes ahead`);
    else done.add(sandboxId);
    return result;
  };
}
