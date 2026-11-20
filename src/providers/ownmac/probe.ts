import { spawn } from "node:child_process";
import { platform, userInfo } from "node:os";
import { z } from "zod";
import type { ExecResult } from "../types.ts";
import { shellQuote } from "../shell.ts";
import type { SshRequest } from "../scaleway/ssh.ts";

import { sshAliasSchema } from "../../../contract-providers.ts";
export { sshAliasSchema };
export interface Identity {
  hardware: string | null;
  user: string;
  uid: number;
}
export interface Reading extends Identity {
  admin: boolean;
  ac: boolean;
  session: boolean;
  memoryMiB: number;
  freeMiB: number;
  cpus: number;
  load: number;
  running: number;
}
export const IDENTITY_SCRIPT = `set -eu
uuid=$(ioreg -rd1 -c IOPlatformExpertDevice | awk -F '"' '/"IOPlatformUUID"/ {print $(NF-1); exit}')
test -n "$uuid"
printf 'hardware=%s\\nuser=%s\\nuid=%s\\n' "$(printf %s "$uuid" | shasum -a 256 | awk '{print $1}')" "$(id -un)" "$(id -u)"
`;
export const AVAILABILITY_SCRIPT = `${IDENTITY_SCRIPT}
groups=$(id -Gn)
admin=$(case " $groups " in (*' admin '*) echo 1 ;; (*) echo 0 ;; esac)
ac=$(case "$(pmset -g batt)" in (*"AC Power"*) echo 1 ;; (*"Battery Power"*) echo 0 ;; (*) exit 1 ;; esac)
console=$(stat -f %Su /dev/console)
session=0
if [ "$console" = "$(id -un)" ]; then session=1; fi
# Fast-user-switching leaves the execution user's GUI session logged in.
if pgrep -u "$(id -u)" -x loginwindow >/dev/null 2>&1; then session=1; fi
memory=$(sysctl -n hw.memsize)
free=$(vm_stat | awk 'NR==1 {for(i=1;i<=NF;i++) if($i=="of") page=$(i+1)} /^Pages (free|inactive|speculative):/ {gsub(/\\./,"",$NF); pages+=$NF} END {if(page>0) printf "%.0f", pages*page/1048576; else exit 1}')
cpus=$(sysctl -n hw.ncpu)
load=$(sysctl -n vm.loadavg | awk '{print $2}')
running=$(find "$HOME/.bb-ownmac-active" -type f 2>/dev/null | wc -l | tr -d ' ')
printf 'admin=%s\\nac=%s\\nsession=%s\\nmemoryMiB=%s\\nfreeMiB=%s\\ncpus=%s\\nload=%s\\nrunning=%s\\n' "$admin" "$ac" "$session" "$((memory / 1048576))" "$free" "$cpus" "$load" "$running"
`;
const readingSchema = z.object({
  hardware: z.string().regex(/^[a-f0-9]{64}$/),
  user: z.string().regex(/^[a-z_][a-z0-9_-]*$/i),
  uid: z.coerce.number().int().nonnegative(),
  admin: z.enum(["0", "1"]).transform((v) => v === "1"),
  ac: z.enum(["0", "1"]).transform((v) => v === "1"),
  session: z.enum(["0", "1"]).transform((v) => v === "1"),
  memoryMiB: z.coerce.number().positive(),
  freeMiB: z.coerce.number().nonnegative(),
  cpus: z.coerce.number().int().positive(),
  load: z.coerce.number().nonnegative(),
  running: z.coerce.number().int().nonnegative(),
});
export function parseReading(stdout: string): Reading {
  return readingSchema.parse(
    Object.fromEntries(
      stdout
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    ),
  );
}
export function refusal(remote: Reading, local: Identity): string | null {
  if (remote.admin || remote.uid === 0)
    return "Refused: this account is an administrator. Use a standard user or a VM with a standard user.";
  if (
    local.hardware &&
    remote.hardware === local.hardware &&
    (remote.user === local.user || remote.uid === local.uid)
  )
    return "Refused: this is your personal login on the bb server. Use a separate standard user or a VM.";
  return null;
}
export function availability(
  reading: Reading,
  local: Identity,
  running: number,
  max: number,
): string {
  const reason = refusal(reading, local);
  if (reason) return reason;
  if (!reading.ac) return "On battery";
  if (!reading.session) return "No logged-in session";
  if (reading.freeMiB < Math.max(4096, reading.memoryMiB / 4))
    return "Not enough free memory";
  if (reading.load > Math.max(1, reading.cpus - 1))
    return "Not enough free CPU";
  if (Math.max(running, reading.running) >= max) return "At task limit";
  return "Available";
}
// No identity files or private keys are read by the plugin. OpenSSH resolves
// the alias and uses the owner's agent; unknown host keys fail closed.
export type AliasExec = (
  alias: string,
  request: SshRequest,
) => Promise<ExecResult>;
function processExec(
  command: string,
  args: string[],
  request: SshRequest,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      signal: request.signal,
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), request.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-1048576);
      request.onOutput?.(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-1048576);
      request.onOutput?.(String(chunk));
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Your Mac could not be reached."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 255, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(request.stdin ?? "");
  });
}
export const aliasExec: AliasExec = (alias, request) => {
  if (!sshAliasSchema.safeParse(alias).success || !alias)
    return Promise.reject(new Error("Set an SSH host alias in Settings."));
  return processExec(
    "ssh",
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "-o",
      "StrictHostKeyChecking=yes",
      "--",
      alias,
      request.command.map(shellQuote).join(" "),
    ],
    request,
  );
};
export async function localIdentity(): Promise<Identity> {
  const user = userInfo();
  if (platform() !== "darwin")
    return { hardware: null, user: user.username, uid: user.uid };
  const result = await processExec("/bin/bash", ["-c", IDENTITY_SCRIPT], {
    command: [],
    timeoutMs: 5000,
  });
  const fields = Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  if (result.exitCode || !/^[a-f0-9]{64}$/.test(fields.hardware ?? ""))
    throw new Error("Cannot verify the bb server's Mac identity.");
  return { hardware: fields.hardware!, user: user.username, uid: user.uid };
}
