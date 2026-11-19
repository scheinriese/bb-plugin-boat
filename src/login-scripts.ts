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
import type { BoatApi } from "./boat-api.ts";

/** Plain `bash -c` (a login shell would read ~/.profile, which may not be restored yet). */
export const QUIET_LOGIN_SCRIPT = [
  "D=/etc/update-motd.d",
  '[ -d "$D" ] || { echo "BOAT_MOTD none"; exit 0; }',
  // -L: the scripts may be links (landscape's); the target's execute bit is what run-parts checks.
  'X=$(timeout 5 find -L "$D" -mindepth 1 -maxdepth 1 -type f -perm /111 2>/dev/null | head -n 1)',
  '[ -n "$X" ] || { echo "BOAT_MOTD off"; exit 0; }',
  'if timeout 10 sudo -n chmod a-x -- "$D"/* 2>/dev/null; then echo "BOAT_MOTD disabled"; else echo "BOAT_MOTD failed"; fi',
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
