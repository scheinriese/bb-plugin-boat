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
import { ACTIVE_STATES, type BoatApi, type MachineType } from "./boat-api.ts";
import { BoatError } from "./boat.ts";
import { SIZE_SPECS, isMachineType } from "./memory.ts";

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

/** boat refused a resume because the sandbox's data doesn't fit its size. */
export interface DiskTooLarge {
  /** The sandbox's data as boat counts it, in GB (null: boat didn't say). */
  usedGb: number | null;
  /** The size boat tried to start it on (null: boat didn't say). */
  type: MachineType | null;
  /** The most that size fits, in GB (null: boat didn't say). */
  budgetGb: number | null;
  /** boat's words (one line, clipped). */
  detail: string;
}

/**
 * boat's words for it, on a plain resume and on one with --type (code type_too_small):
 * "This sandbox uses 84.1 GB of disk, which does not fit any available 'small' machine (largest budget: 76.0 GB). …"
 * "This sandbox uses 84.1 GB of disk, which does not fit a 'default' machine (76.0 GB). … or resume it as '…' or larger."
 */
export const DISK_TOO_LARGE = /does not fit (?:any available|an?) '?[a-z]+'? machine|\btype_too_small\b/i;
/** The size asked for, and what it fits: "(76.0 GB)" or "(largest budget: 76.0 GB)". */
const DOES_NOT_FIT = /does not fit (?:any available|an?) '?([a-z]+)'? machine(?: \((?:largest budget:? *)?([\d.]+) ?GB\))?/i;

function gb(text: string | undefined): number | null {
  const value = text === undefined ? NaN : Number(text);
  return Number.isFinite(value) ? value : null;
}

/** The size refusal in a failed resume (null: it's something else). */
export function diskTooLarge(error: unknown): DiskTooLarge | null {
  const text = error instanceof Error ? error.message : String(error);
  const code = error instanceof BoatError ? error.code : null;
  if (!DISK_TOO_LARGE.test(text) && code !== "type_too_small") return null;
  const fit = DOES_NOT_FIT.exec(text);
  const type = fit?.[1]?.toLowerCase();
  const line = text.split("\n").find((entry) => DISK_TOO_LARGE.test(entry)) ?? text;
  const clean = line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  return {
    usedGb: gb(/\buses ([\d.]+) ?GB\b/i.exec(text)?.[1]),
    type: isMachineType(type) ? type : null,
    budgetGb: gb(fit?.[2] ?? /\bbudget:? ([\d.]+) ?GB\b/i.exec(text)?.[1]),
    detail: clean.length > 300 ? `${clean.slice(0, 299)}…` : clean || "type_too_small",
  };
}

/**
 * A resume onto another size (a resize under way, src/sandbox-size.ts): a
 * refusal there is the resize's to report, and it rolls back, so no Needs you.
 */
export function markResize<T>(error: T, type: string): T {
  if (error !== null && typeof error === "object") Object.assign(error, { resizeType: type });
  return error;
}
export function resizeRefused(error: unknown): boolean {
  return error !== null && typeof error === "object" && typeof (error as { resizeType?: unknown }).resizeType === "string";
}

/** A size its data fits, from the size boat was asked for: Large for Small and Default (they fit the same), XLarge for Large (null: none larger). */
export function roomierSize(type: MachineType | null): MachineType | null {
  if (type === "xlarge") return null;
  return type === "large" ? "xlarge" : "large";
}

const label = (type: MachineType | null) => (type === null ? "its size" : SIZE_SPECS[type].label);
const amount = (value: number) => `${value.toFixed(1)} GB`;

/** "its data is 84.1 GB, too large for its size (Small fits 76.0 GB)". */
function tooLargeFacts(size: DiskTooLarge | null, type: MachineType | null): string {
  const data = size?.usedGb != null ? `its data is ${amount(size.usedGb)},` : "its data is";
  const fits = size?.budgetGb != null && type !== null ? ` (${label(type)} fits ${amount(size.budgetGb)})` : "";
  return `${data} too large for its size${fits}`;
}

/** The machine's failure message, and the line on the sandbox's tasks. */
export function tooLargeMessage(size: DiskTooLarge | null): string {
  const type = size?.type ?? null;
  const bigger = roomierSize(type);
  const facts = tooLargeFacts(size, type);
  const what = `This sandbox won't start: ${facts}.`;
  if (bigger === null) return `${what} No larger size fits it; it's under Needs you.`;
  return `${what} One start on ${label(bigger)} plus a cleanup brings it back to ${label(type)}; the steps are under Needs you.`;
}

/**
 * Needs you: bring it back by hand. Start it once on a larger size, trim
 * the disk and remove dangling Docker images, stop it (boat snapshots what's
 * left), then start it on its own size again. `type`: its size, when boat's
 * words don't name it.
 */
export function tooLargeQuestion(input: { sandboxId: string; size: DiskTooLarge | null; type?: MachineType | null }) {
  const id = input.sandboxId;
  const type = input.size?.type ?? input.type ?? null;
  const bigger = roomierSize(type);
  const facts = `Sandbox ${id} won't start: ${tooLargeFacts(input.size, type)}.`;
  const detail = input.size?.detail ?? "(no details)";
  const said = `boat.dev said: ${detail}${/[.!?…]$/.test(detail) ? "" : "."}`;
  if (bigger === null) {
    return {
      question: `${facts} No larger size fits it. What now?`,
      recommendation: "Report it to boat.dev with the error below.",
      options: ["Report it to boat.dev", "Leave it for now"],
      context: said,
      shortLabel: "Sandbox too large for its size",
    };
  }
  const steps = [
    `boat resume ${id} --type ${bigger}`,
    `boat exec ${id} --timeout 300 -- sudo fstrim -av`,
    `boat exec ${id} -- sudo -n docker image prune -f`,
    `boat stop ${id}`,
    `boat resume ${id} --type ${type ?? "<its size>"}`,
  ];
  return {
    question: `${facts} Bring it back to ${label(type)} with one start on ${label(bigger)}?`,
    recommendation: `Usually most of it is space from deleted files, which boat.dev still counts until the disk is trimmed. One start on ${label(bigger)} plus a cleanup brings it back to ${label(type)}: resume it on ${label(bigger)}, trim its disk and remove dangling Docker images, stop it, then resume it on ${label(type)} (the commands are below). If that last resume still fails, also remove the Docker images no container uses (\`boat exec ${id} -- sudo -n docker image prune -af\`; they download or build again when needed), then stop and resume it again. Boat doesn't do this on its own: a start on ${label(bigger)} costs more.`,
    options: ["I'll do it", "Leave it for now"],
    context: `${said}\n${steps.join("\n")}`,
    shortLabel: "Sandbox too large for its size",
  };
}
