// Thin, typed wrapper around the `instabox` CLI (https://instabox.sh).
//
// Every call runs `instabox <command> --json` on the machine that runs the bb
// server. The API key the owner stored in bb's secret setting goes in as
// INSTABOX_API_KEY in the child's environment only: never in its arguments,
// a log line or an error. Output is one JSON value (or JSON Lines); a failure
// prints `{"error":{"code","message","status",…}}` on stdout and exits
// non-zero (3: auth, 4: not found, 5: quota or plan, 75: retryable).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { ProviderError, type ExplainedError } from "../types.ts";
import { explainInstaboxError } from "./words.ts";

export type JsonRecord = Record<string, unknown>;

export class InstaboxError extends ProviderError {
  /** Instabox says the same call may work later (retryable, or exit 75). */
  readonly retryable: boolean;
  constructor(message: string, options: { code?: string; status?: number | null; exitCode?: number | null; retryable?: boolean } = {}) {
    super(message, { ...options, code: options.code ?? "instabox_failed" });
    this.name = "InstaboxError";
    this.retryable = options.retryable ?? false;
  }

  /** Instabox's failures in plain words, with what to do. */
  override explain(): ExplainedError {
    return explainInstaboxError(this);
  }
}

export interface InstaboxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Every JSON object printed on stdout, in order (one per line, or the whole output). */
  records: JsonRecord[];
  /** The whole stdout as one JSON value, when it is one (an array for list commands). */
  value: unknown;
}

export interface InstaboxRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Return the result instead of throwing when instabox exits non-zero. */
  allowFailure?: boolean;
  /** Fed to the command's stdin (a prompt read with `-`). */
  stdin?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
/** The key's variable: the CLI uses it instead of a sign-in. */
export const KEY_VARIABLE = "INSTABOX_API_KEY";

/** Find the instabox binary: explicit setting, then PATH (npm's global bin). */
export function resolveInstaboxBinary(configured: string): string | null {
  const explicit = configured.trim();
  if (explicit !== "") {
    const expanded = explicit.startsWith("~/") ? join(homedir(), explicit.slice(2)) : explicit;
    return existsSync(expanded) ? expanded : null;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "instabox");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** JSON objects in the output: the whole of it, else one per line. */
export function parseJsonOutput(text: string): { records: JsonRecord[]; value: unknown } {
  const trimmed = text.trim();
  if (trimmed !== "") {
    try {
      const value: unknown = JSON.parse(trimmed);
      const records = Array.isArray(value) ? value.filter(isRecord) : isRecord(value) ? [value] : [];
      return { records, value };
    } catch {
      // JSON Lines, or text around it.
    }
  }
  const records: JsonRecord[] = [];
  for (const line of text.split("\n")) {
    const entry = line.trim();
    if (!entry.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(entry);
      if (isRecord(value)) records.push(value);
    } catch {
      // Not JSON (a progress line).
    }
  }
  return { records, value: records.length === 1 ? records[0] : records };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Never a key in a message: anything shaped like one is cut out. */
export function redactKeys(text: string): string {
  return text.replace(/\b(?:ib[kp]v?|ibsec)_[A-Za-z0-9_-]{6,}/g, "ib…_[hidden]");
}

/** The error an instabox failure printed, else its stderr's last lines. */
export function errorFromOutput(records: JsonRecord[], stderr: string, exitCode: number): InstaboxError {
  const record = [...records].reverse().find((entry) => isRecord(entry.error) || typeof entry.error === "string");
  const error = record === undefined ? null : isRecord(record.error) ? record.error : { message: record.error };
  if (error !== null) {
    const status = typeof error.status === "number" ? error.status : null;
    return new InstaboxError(redactKeys(typeof error.message === "string" ? error.message : JSON.stringify(error).slice(0, 500)), {
      code: typeof error.code === "string" ? error.code : codeForExit(exitCode),
      status,
      exitCode,
      retryable: error.retryable === true || exitCode === 75,
    });
  }
  // `instabox: error CODE: MESSAGE` on stderr.
  const line = stderr.trim().split("\n").reverse().find((entry) => /^instabox: error /.test(entry));
  const said = line?.match(/^instabox: error ([a-z_]+): (.*)$/);
  if (said) return new InstaboxError(redactKeys(said[2]!), { code: said[1]!, exitCode, retryable: exitCode === 75 });
  const tail = redactKeys(stderr.trim().split("\n").slice(-5).join("\n"));
  return new InstaboxError(tail === "" ? `instabox exited with code ${exitCode}` : tail, { code: codeForExit(exitCode), exitCode, retryable: exitCode === 75 });
}

/** The kind of error an exit code says (the CLI's documented codes). */
function codeForExit(exitCode: number): string {
  switch (exitCode) {
    case 3:
      return "unauthenticated";
    case 4:
      return "not_found";
    case 5:
      return "quota_exceeded";
    case 75:
      return "host_unavailable";
    default:
      return "instabox_failed";
  }
}

export class InstaboxCli {
  private readonly getBinary: () => Promise<string | null>;
  private readonly getKey: () => Promise<string | null>;

  /** `key`: the API key from bb's secret setting (null: none stored). */
  constructor(getBinary: () => Promise<string | null>, key: () => Promise<string | null>) {
    this.getBinary = getBinary;
    this.getKey = key;
  }

  async binary(): Promise<string> {
    const binary = await this.getBinary();
    if (binary === null) {
      throw new InstaboxError("The instabox CLI was not found. Install it: run `npm install -g instabox` in a terminal. Installed somewhere else? Set Instabox CLI location in this plugin's settings.", {
        code: "instabox_not_found",
      });
    }
    return binary;
  }

  /** The child's environment: the key from bb's secret setting, and no update check or colors. */
  async env(): Promise<NodeJS.ProcessEnv> {
    const key = await this.getKey();
    if (key === null || key.trim() === "") {
      throw new InstaboxError("No Instabox API key is stored.", { code: "key_missing" });
    }
    return { ...process.env, [KEY_VARIABLE]: key.trim(), INSTABOX_NO_UPDATE_CHECK: "1", NO_COLOR: "1" };
  }

  /** Run `instabox <args>` (the caller puts `--json` where the command takes it) and collect its output. */
  async run(args: string[], options: InstaboxRunOptions = {}): Promise<InstaboxRunResult> {
    if (options.signal?.aborted) throw new InstaboxError("instabox call aborted", { code: "aborted" });
    const [binary, env] = await Promise.all([this.binary(), this.env()]);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const result = await new Promise<InstaboxRunResult>((resolve, reject) => {
      // stdin only for a command that reads its input (`-`): `instabox exec` refuses piped input without --stdin.
      const child = spawn(binary, args, { env, stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      const out = child.stdout!;
      const err = child.stderr!;
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
        finish(() => reject(new InstaboxError(`instabox ${args[0] ?? ""} timed out after ${Math.round(timeoutMs / 1000)}s`, { code: "instabox_timeout" })));
      }, timeoutMs);
      const onAbort = () => {
        child.kill("SIGTERM");
        finish(() => reject(new InstaboxError("instabox call aborted", { code: "aborted" })));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      out.setEncoding("utf8");
      err.setEncoding("utf8");
      out.on("data", (chunk: string) => {
        if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk;
      });
      err.on("data", (chunk: string) => {
        if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk;
      });
      child.on("error", (error) => finish(() => reject(new InstaboxError(`could not run instabox: ${error.message}`, { code: "instabox_spawn_failed" }))));
      child.on("close", (code) => finish(() => resolve({ exitCode: code ?? 1, stdout, stderr, ...parseJsonOutput(stdout) })));
      if (options.stdin !== undefined && child.stdin !== null) {
        child.stdin.on("error", () => undefined);
        child.stdin.end(options.stdin);
      }
    });
    if (result.exitCode !== 0 && options.allowFailure !== true) throw errorFromOutput(result.records, result.stderr, result.exitCode);
    return result;
  }

  /** Run and return the single (or last) JSON object printed. */
  async json(args: string[], options: InstaboxRunOptions = {}): Promise<JsonRecord> {
    const result = await this.run(args, options);
    const last = result.records.at(-1);
    if (last === undefined) throw new InstaboxError(`instabox ${args[0] ?? ""} printed no JSON`, { code: "instabox_bad_output" });
    return last;
  }
}

// ---------------------------------------------------------------------------
// Small accessors for loosely typed instabox JSON.

export function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function rec(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

/** A positional the CLI must not read as a flag. */
export function safePositional(text: string): string {
  return /^\s*-/.test(text) ? `\u200b${text}` : text;
}
