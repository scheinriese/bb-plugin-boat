// Read bb's own files right after a wake, before bb starts.
//
// boat.dev restores a woken sandbox's disk lazily: a file streams in from
// boat's storage the first time something reads it. bb's service and setup
// read thousands of files at once (node, npm, bb-app's node_modules), and a
// read that waits on a file not restored yet can block for good. Reading
// them through first, gently (nice, ionice, one file at a time), lets boat.dev
// stream them in before bb needs them, and shows a failing disk before bb's
// setup hangs on it.
//
// Only two places, both in the home: bb's data dir (~/.bb-machines/<server>,
// without old or half-made installs and bb's download, and without the
// install Boat is about to replace) and the nvm node bb runs on
// (~/.nvm/versions/node/<current>; a system node isn't read).
// Bounded in time (60 s), in total size (1.5 GiB) and per file (256 MiB);
// it never fails or holds up the wake past its limit, whatever the disk does.
import type { BoatApi } from "./boat-api.ts";
import type { PrefetchRequest } from "./bb-update.ts";

export const PREFETCH_SECONDS = 60;
export const PREFETCH_MAX_BYTES = 1536 * 1024 * 1024;
export const PREFETCH_MAX_FILE_KB = 256 * 1024;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Plain `bash -c`. Prints `BOAT_PREFETCH done <bytes> <seconds>` (or `none`). */
export function prefetchScript(request: PrefetchRequest, limits: { seconds?: number; maxBytes?: number; maxFileKb?: number } = {}): string {
  const seconds = Math.max(5, Math.round(limits.seconds ?? PREFETCH_SECONDS));
  return [
    `D=${shellQuote(request.dataDir ?? "")}`,
    `N=${shellQuote(request.node ?? "")}`,
    `X=${request.skipInstall ? 1 : 0}`,
    `L=${seconds}`,
    `M=${Math.max(1, Math.round(limits.maxBytes ?? PREFETCH_MAX_BYTES))}`,
    `F=${Math.max(1, Math.round(limits.maxFileKb ?? PREFETCH_MAX_FILE_KB))}`,
    "R=()",
    // Only inside the home: never a system folder, whatever bb's unit says.
    'case "$D" in "$HOME"/?*) ;; *) D= ;; esac',
    'if [ -n "$D" ]; then [ -d "$D" ] && R+=("$D"); elif [ -d "$HOME/.bb-machines" ]; then R+=("$HOME/.bb-machines"); fi',
    "V=",
    'case "$N" in "$HOME"/.nvm/versions/node/?*/bin/node) V=${N%/bin/node} ;; esac',
    'if [ -z "$V" ] || [ ! -d "$V" ]; then V=$(ls -d "$HOME"/.nvm/versions/node/*/ 2>/dev/null | sort -V | tail -n 1); V=${V%/}; fi',
    '[ -n "$V" ] && [ -d "$V" ] && R+=("$V")',
    '[ ${#R[@]} -gt 0 ] || { echo "BOAT_PREFETCH none"; exit 0; }',
    "Q=(-name npm.new -o -name 'npm.old-*' -o -name 'npm.broken-*' -o -name host-package-download)",
    '[ "$X" = 1 ] && [ -n "$D" ] && Q+=(-o -path "$D/npm")',
    "IO=()",
    "ionice -c 2 -n 7 true 2>/dev/null && IO=(ionice -c 2 -n 7)",
    "S=$(date +%s)",
    'B=$(timeout -k 5 "$L" nice -n 19 "${IO[@]}" find "${R[@]}" -xdev \\( "${Q[@]}" \\) -prune -o -type f -size -"$F"k -print0 2>/dev/null | timeout -k 5 "$L" nice -n 19 "${IO[@]}" xargs -0 -r cat -- 2>/dev/null | head -c "$M" | wc -c)',
    'echo "BOAT_PREFETCH done ${B:-0} $(( $(date +%s) - S ))"',
  ].join("\n");
}

export type PrefetchResult =
  | { kind: "done"; bytes: number; seconds: number }
  | { kind: "none" }
  | { kind: "timed-out" }
  | { kind: "failed"; detail: string };

export function parsePrefetch(stdout: string): PrefetchResult | null {
  if (/^BOAT_PREFETCH none$/m.test(stdout)) return { kind: "none" };
  const match = /^BOAT_PREFETCH done (\d+) (\d+)$/m.exec(stdout);
  return match === null ? null : { kind: "done", bytes: Number(match[1]), seconds: Number(match[2]) };
}

/**
 * Run the prefetch. Never throws (except the wake's own abort) and never
 * takes longer than its limit plus a little: a read stuck on the disk only
 * leaves its exec behind.
 */
export async function prefetchBbFiles(
  boat: Pick<BoatApi, "exec">,
  sandboxId: string,
  request: PrefetchRequest,
  options: { signal: AbortSignal; seconds?: number; log?: (line: string) => void; maxBytes?: number; maxFileKb?: number },
): Promise<PrefetchResult> {
  const seconds = options.seconds ?? PREFETCH_SECONDS;
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<PrefetchResult>((resolve) => {
    timer = setTimeout(() => {
      stop.abort();
      resolve({ kind: "timed-out" });
    }, (seconds + 15) * 1000);
  });
  const ran = boat
    .exec(sandboxId, prefetchScript(request, { seconds, maxBytes: options.maxBytes, maxFileKb: options.maxFileKb }), { timeoutMs: (seconds + 10) * 1000, signal, login: false })
    .then((result): PrefetchResult => parsePrefetch(result.stdout) ?? { kind: "failed", detail: (result.stderr.trim() || `exit code ${result.exitCode}`).slice(0, 200) })
    .catch((error: unknown): PrefetchResult => ({ kind: "failed", detail: (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200) }));
  try {
    const result = await Promise.race([ran, timedOut]);
    options.signal.throwIfAborted();
    const log = options.log ?? (() => undefined);
    if (result.kind === "done") log(`prefetch ${sandboxId}: read ${Math.round(result.bytes / 1_048_576)} MiB of bb's files in ${result.seconds}s`);
    else if (result.kind === "timed-out") log(`prefetch ${sandboxId}: stopped waiting after ${seconds + 15}s; bb's setup goes ahead`);
    else if (result.kind === "failed") log(`prefetch ${sandboxId}: ${result.detail}; bb's setup goes ahead`);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
