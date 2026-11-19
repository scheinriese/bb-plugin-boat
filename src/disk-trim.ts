// A sandbox's disk outgrowing its size, and how Boat keeps it from happening.
//
// boat's snapshot counts the disk blocks a sandbox ever wrote, deleted files'
// included, until the filesystem discards them. Seen live: `df` showed about
// 24 GB used, boat counted 84.1 GB, more than a Small or Default machine fits
// (76 GB), so the sandbox wouldn't resume on its size; `sudo fstrim -av` on
// a Large machine trimmed 124.2 GiB, and after a stop it resumed on Small.
// - Before Boat stops a sandbox on purpose it trims the disk over boat's exec
//   API: bounded in time, only while the sandbox runs, and never in the
//   stop's way.
// - A resume boat refuses for the sandbox's size goes under Needs you, with
//   the way back by hand (src/wake-retry.ts). Boat never starts it on a
//   larger size itself: that costs more.
import { ACTIVE_STATES, type BoatApi } from "./boat-api.ts";

/** The trim's whole budget, from the look at the sandbox to fstrim's answer; the stop goes ahead after it whatever happens. */
export const TRIM_TIMEOUT_MS = 60_000;

/**
 * fstrim on every mounted filesystem that takes it, ended by `timeout` in
 * the sandbox well inside the budget. Run with a plain `bash -c` (never
 * reads ~/.profile); `sudo -n` never waits for a password.
 */
export function trimScript(budgetMs = TRIM_TIMEOUT_MS): string {
  const seconds = Math.max(5, Math.floor(budgetMs / 1000) - 10);
  return `timeout -k 5 ${seconds} sudo -n fstrim -av 2>&1`;
}

/** fstrim -av's lines: "/: 124.2 GiB (133352955904 bytes) trimmed on /dev/vda1". */
const TRIMMED = /^(\S.*?): (\S+ \S+) \((\d+) bytes\) trimmed(?: on (\S+))?/;

/** What fstrim -av says it trimmed (null: no line says so). */
export function parseTrim(output: string): { bytes: number; lines: string[] } | null {
  let bytes = 0;
  const lines: string[] = [];
  for (const raw of output.split("\n")) {
    const line = TRIMMED.exec(raw.trim());
    if (line === null) continue;
    bytes += Number(line[3]);
    lines.push(`${line[2]} on ${line[4] ?? line[1]}`);
  }
  return lines.length === 0 ? null : { bytes, lines };
}

export type TrimOutcome =
  | { status: "trimmed"; bytes: number; detail: string }
  /** Not running (stopped, gone), so nothing to reach. */
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

function firstLine(text: string): string {
  return (text.trim().split("\n")[0] ?? "").replace(/\s+/g, " ").slice(0, 200);
}

function gib(bytes: number): string {
  return `${(bytes / 2 ** 30).toFixed(1)} GiB`;
}

/** The debug log line for a trim. */
export function trimLogLine(sandboxId: string, outcome: TrimOutcome): string {
  switch (outcome.status) {
    case "trimmed":
      return `disk trim ${sandboxId}: trimmed ${gib(outcome.bytes)} (${outcome.detail})`;
    case "skipped":
      return `disk trim ${sandboxId}: skipped, ${outcome.reason}`;
    case "failed":
      return `disk trim ${sandboxId}: couldn't trim (${outcome.reason})`;
  }
}

/**
 * Give boat.dev back the blocks deleted files freed, right before a stop
 * Boat makes on purpose. Skipped when the sandbox isn't running (exec must
 * never wake it). Never throws, and returns within `timeoutMs` whatever
 * boat does (a call still running then is cancelled). `state`: the
 * sandbox's state, when the caller just read it.
 */
export async function trimFreedBlocks(
  boat: Pick<BoatApi, "findInfo" | "exec">,
  sandboxId: string,
  options: { state?: string | null; signal?: AbortSignal; log?: (line: string) => void; timeoutMs?: number } = {},
): Promise<TrimOutcome> {
  const budget = options.timeoutMs ?? TRIM_TIMEOUT_MS;
  const done = (outcome: TrimOutcome) => {
    options.log?.(trimLogLine(sandboxId, outcome));
    return outcome;
  };
  if (options.signal?.aborted) return done({ status: "skipped", reason: "the stop was cancelled" });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, budget);
  const gaveUp = new Promise<TrimOutcome>((resolve) =>
    controller.signal.addEventListener("abort", () => resolve({ status: "failed", reason: options.signal?.aborted ? "the stop was cancelled" : `no answer within ${Math.round(budget / 1000)}s` }), { once: true }),
  );
  const attempt = async (): Promise<TrimOutcome> => {
    try {
      const state = options.state !== undefined ? options.state : ((await boat.findInfo(sandboxId, controller.signal))?.state ?? null);
      if (state === null || !ACTIVE_STATES.has(state)) return { status: "skipped", reason: state === null ? "the sandbox is gone" : `the sandbox is ${state}` };
      const result = await boat.exec(sandboxId, trimScript(budget), { timeoutMs: Math.max(5_000, budget - 5_000), signal: controller.signal, login: false });
      const trimmed = parseTrim(result.stdout);
      if (trimmed !== null) return { status: "trimmed", bytes: trimmed.bytes, detail: trimmed.lines.join(", ") };
      if (result.exitCode === 124 || result.exitCode === 137) return { status: "failed", reason: "fstrim timed out" };
      const said = `${result.stdout}\n${result.stderr}`.trim().split("\n").at(-1) ?? "";
      return { status: "failed", reason: firstLine(said) || (result.exitCode === 0 ? "fstrim named no filesystem it trimmed" : `exit code ${result.exitCode}`) };
    } catch (error) {
      return { status: "failed", reason: firstLine(error instanceof Error ? error.message : String(error)) };
    }
  };
  try {
    return done(await Promise.race([attempt(), gaveUp]));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    // A call still running is cancelled (its answer no longer matters).
    controller.abort();
  }
}
