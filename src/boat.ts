// Thin, typed wrapper around the `boat` CLI.
//
// Every call runs `boat <args> --json` on the machine that runs the bb server
// (where the user installed and logged in to the boat CLI). Output is JSON or
// JSON Lines; failures print `{"event":"error","code","error","status"}` on
// stdout and exit non-zero.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type JsonRecord = Record<string, unknown>;

export class BoatError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly exitCode: number | null;
  constructor(
    message: string,
    options: { code?: string; status?: number | null; exitCode?: number | null } = {},
  ) {
    super(message);
    this.name = "BoatError";
    this.code = options.code ?? "boat_failed";
    this.status = options.status ?? null;
    this.exitCode = options.exitCode ?? null;
  }
}

export interface BoatRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Every JSON object printed on stdout, in order (one per line). */
  records: JsonRecord[];
}

export interface BoatRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Return the result instead of throwing when boat exits non-zero. */
  allowFailure?: boolean;
  /**
   * Keep the newest output when it exceeds the capture limit (for logs that
   * print oldest first, like `boat events`). The default keeps the oldest.
   */
  keepTail?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

/** Find the boat binary: explicit setting, the installer's default, then PATH. */
export function resolveBoatBinary(configured: string): string | null {
  const explicit = configured.trim();
  if (explicit !== "") {
    const expanded = explicit.startsWith("~/")
      ? join(homedir(), explicit.slice(2))
      : explicit;
    return existsSync(expanded) ? expanded : null;
  }
  const installerDefault = join(homedir(), ".ascii", "bin", "boat");
  if (existsSync(installerDefault)) return installerDefault;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "boat");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Put `--json` right after the (single-word) subcommand: after a trailing
 * prompt it could be read as prompt text, and after `--` the remote command
 * would receive it.
 */
export function withJsonFlag(args: readonly string[]): string[] {
  if (args.length === 0) return ["--json"];
  return [args[0]!, "--json", ...args.slice(1)];
}

export function parseJsonLines(text: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        records.push(value as JsonRecord);
      }
    } catch {
      // Ignore non-JSON lines (progress text, warnings).
    }
  }
  return records;
}

function errorFromRecords(
  records: JsonRecord[],
  stderr: string,
  exitCode: number,
): BoatError {
  const errorRecord = [...records]
    .reverse()
    .find((record) => record.event === "error" || typeof record.error === "string");
  if (errorRecord !== undefined) {
    const message =
      typeof errorRecord.error === "string"
        ? errorRecord.error
        : typeof errorRecord.message === "string"
          ? errorRecord.message
          : JSON.stringify(errorRecord).slice(0, 500);
    return new BoatError(message, {
      code: typeof errorRecord.code === "string" ? errorRecord.code : "boat_failed",
      status: typeof errorRecord.status === "number" ? errorRecord.status : null,
      exitCode,
    });
  }
  const tail = stderr.trim().split("\n").slice(-5).join("\n");
  return new BoatError(tail === "" ? `boat exited with code ${exitCode}` : tail, {
    exitCode,
  });
}

export class BoatCli {
  private readonly getBinary: () => Promise<string | null>;

  constructor(getBinary: () => Promise<string | null>) {
    this.getBinary = getBinary;
  }

  async binary(): Promise<string> {
    const binary = await this.getBinary();
    if (binary === null) {
      throw new BoatError(
        "The boat CLI was not found. Install it: run `curl -fsSL https://boat.dev/install | sh` in a terminal. Installed somewhere else? Set boat CLI location in this plugin's settings.",
        { code: "boat_not_found" },
      );
    }
    return binary;
  }

  /** Run `boat <args> --json` and collect its output. */
  async run(args: string[], options: BoatRunOptions = {}): Promise<BoatRunResult> {
    if (options.signal?.aborted) throw new BoatError("boat call aborted", { code: "aborted" });
    const binary = await this.binary();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const result = await new Promise<BoatRunResult>((resolve, reject) => {
      const child = spawn(binary, withJsonFlag(args), {
        env: { ...process.env, BOAT_NO_UPDATE: "1", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() =>
          reject(
            new BoatError(`boat ${args[0] ?? ""} timed out after ${Math.round(timeoutMs / 1000)}s`, {
              code: "boat_timeout",
            }),
          ),
        );
      }, timeoutMs);
      const onAbort = () => {
        child.kill("SIGTERM");
        finish(() => reject(new BoatError("boat call aborted", { code: "aborted" })));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (options.keepTail === true) {
          stdout += chunk;
          if (stdout.length > MAX_CAPTURE_BYTES) {
            // Drop the oldest output, starting at a line boundary.
            const cut = stdout.slice(stdout.length - MAX_CAPTURE_BYTES);
            stdout = cut.slice(cut.indexOf("\n") + 1);
          }
        } else if (stdout.length < MAX_CAPTURE_BYTES) {
          stdout += chunk;
        }
      });
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk;
      });
      child.on("error", (error) =>
        finish(() =>
          reject(new BoatError(`could not run boat: ${error.message}`, { code: "boat_spawn_failed" })),
        ),
      );
      child.on("close", (code) =>
        finish(() =>
          resolve({ exitCode: code ?? 1, stdout, stderr, records: parseJsonLines(stdout) }),
        ),
      );
    });
    if (result.exitCode !== 0 && options.allowFailure !== true) {
      throw errorFromRecords(result.records, result.stderr, result.exitCode);
    }
    return result;
  }

  /**
   * Start a streaming boat command, wait for the first JSON record `pick`
   * accepts, then stop the local process. Used for `boat prompt`, which
   * streams the whole agent turn: the agent keeps running in the sandbox
   * after the local CLI exits, so we only wait for the "queued" record.
   */
  async until<T>(
    args: string[],
    pick: (record: JsonRecord) => T | null,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (options.signal?.aborted) throw new BoatError("boat call aborted", { code: "aborted" });
    const binary = await this.binary();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const child = spawn(binary, withJsonFlag(args), {
        env: { ...process.env, BOAT_NO_UPDATE: "1", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      let stderr = "";
      const seen: JsonRecord[] = [];
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (child.exitCode === null) child.kill("SIGTERM");
        fn();
      };
      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new BoatError(
              `boat ${args[0] ?? ""} did not confirm within ${Math.round(timeoutMs / 1000)}s`,
              { code: "boat_timeout" },
            ),
          ),
        );
      }, timeoutMs);
      const onAbort = () =>
        finish(() => reject(new BoatError("boat call aborted", { code: "aborted" })));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const consume = (line: string) => {
        const [record] = parseJsonLines(line);
        if (record === undefined) return;
        seen.push(record);
        if (record.event === "error") {
          finish(() => reject(errorFromRecords([record], stderr, 1)));
          return;
        }
        const picked = pick(record);
        if (picked !== null) finish(() => resolve(picked));
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          consume(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      });
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 64 * 1024) stderr += chunk;
      });
      child.on("error", (error) =>
        finish(() =>
          reject(new BoatError(`could not run boat: ${error.message}`, { code: "boat_spawn_failed" })),
        ),
      );
      child.on("close", (code) => {
        if (buffer.trim() !== "") consume(buffer);
        finish(() => reject(errorFromRecords(seen, stderr, code ?? 1)));
      });
    });
  }

  /** Run and return the single (or last) JSON object printed. */
  async json(args: string[], options: BoatRunOptions = {}): Promise<JsonRecord> {
    const result = await this.run(args, options);
    const last = result.records.at(-1);
    if (last === undefined) {
      throw new BoatError(`boat ${args[0] ?? ""} printed no JSON`, { code: "boat_bad_output" });
    }
    return last;
  }
}

// ---------------------------------------------------------------------------
// Small accessors for loosely typed boat JSON.

export function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function rec(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}
