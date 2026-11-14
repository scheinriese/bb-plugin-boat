import { setTimeout as delay } from "node:timers/promises";
import type { MachineExecutor } from "@get-bb/plugin-sdk";

const CODES = ["E404", "ETARGET", "ETIMEDOUT", "ECONNRESET"] as const;
export type BootstrapNpmCode = typeof CODES[number];
const BACKOFF_MS = [30_000, 60_000] as const;
const INSTALLING = /Installing (?:the server['’]s bb-app build|bb-app from the npm registry)/;
const INSTALLED = /Installed (?:the server['’]s bb-app build|bb-app from the npm registry)/;
const PERMANENT = /\b(?:E401|E403|ENEEDAUTH|EAUTH|EINTEGRITY|EACCES|EPERM|EBADENGINE|ENOTSUP|ERESOLVE|ENOSPC)\b|unable to authenticate|permission denied|no space left on device/i;

/** Bounded streaming evidence only: never retain commands, enrollment input or URLs. */
export class BootstrapNpmEvidence {
  private pending = "";
  private installing = false;
  private blocked = false;
  private tarball = false;
  private code: BootstrapNpmCode | null = null;

  output(chunk: string): void {
    // Inspect bounded segments even if a producer never terminates a long line.
    for (let offset = 0; offset < chunk.length; offset += 4096) {
      this.pending += chunk.slice(offset, offset + 4096);
      let boundary: number;
      while ((boundary = this.pending.search(/[\r\n]/)) >= 0) {
        this.line(this.pending.slice(0, boundary));
        this.pending = this.pending.slice(boundary + 1);
      }
      if (this.pending.length > 8192) {
        this.line(this.pending.slice(0, 8192));
        this.pending = this.pending.slice(-4096);
      }
    }
  }

  private line(raw: string): void {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    if (INSTALLING.test(line)) this.installing = true;
    if (INSTALLED.test(line)) {
      this.installing = false;
      this.code = null;
      this.tarball = false;
    }
    if (!this.installing) return;
    if (PERMANENT.test(line)) this.blocked = true;
    const code = /\bnpm\s+(?:ERR!|error)\s+code\s+([A-Z0-9_-]+)\b/i.exec(line)?.[1]?.toUpperCase();
    if (code) {
      if (CODES.includes(code as BootstrapNpmCode)) this.code = code as BootstrapNpmCode;
      else this.blocked = true;
    }
    // A private registry/package authorization 404 is not propagation evidence.
    if (/\bhttps:\/\/registry\.npmjs\.org\/[^\s?#]*\/-\/[^\s?#]+\.tgz(?:\s|$|[?#])/.test(line)) this.tarball = true;
  }

  failureCode(): BootstrapNpmCode | null {
    this.line(this.pending);
    this.pending = "";
    return this.installing && !this.blocked && (this.code !== "E404" || this.tarball) ? this.code : null;
  }
}

export type RetryableBootstrap = { code: BootstrapNpmCode; attempts: number };
export function retryableBootstrap(error: unknown): RetryableBootstrap | null {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const match = /\[bootstrap_retryable:(E404|ETARGET|ETIMEDOUT|ECONNRESET):([1-3])\]/.exec(text);
  return match ? { code: match[1] as BootstrapNpmCode, attempts: Number(match[2]) } : null;
}

export function bootstrapFailureMessage(failure: RetryableBootstrap): string {
  return `bb installation could not fetch an npm dependency (${failure.code}) after ${failure.attempts} ${failure.attempts === 1 ? "attempt" : "attempts"}. The agent did not start. Retry starting the task after checking npm's registry availability. [bootstrap_retryable:${failure.code}:${failure.attempts}]`;
}

/**
 * Replay only an installer that exited unsuccessfully with npm-fetch evidence.
 * The same opaque enrollment stdin, command, signal and sandbox are reused;
 * bb's bootstrap API itself is called once. All attempts share its time budget.
 */
export function bootstrapExecutor(
  executor: MachineExecutor,
  report: { log(message: string): void },
  clock: { now(): number; wait(ms: number, signal: AbortSignal): Promise<unknown> } = {
    now: Date.now,
    wait: (ms, signal) => delay(ms, undefined, { signal }),
  },
): MachineExecutor {
  return {
    async exec(request) {
      const deadline = clock.now() + request.timeoutMs;
      for (let attempt = 1; ; attempt++) {
        request.signal.throwIfAborted();
        const evidence = new BootstrapNpmEvidence();
        const result = await executor.exec({
          ...request,
          timeoutMs: Math.max(1, deadline - clock.now()),
          onOutput(chunk) { evidence.output(chunk); request.onOutput(chunk); },
        });
        request.signal.throwIfAborted();
        if (result.exitCode === 0) return result;
        const code = evidence.failureCode();
        if (!code) return result;
        const pause = BACKOFF_MS[attempt - 1];
        if (pause === undefined || deadline - clock.now() <= pause) {
          // Core includes output tails in the failed-machine message; emit only
          // sanitized categorical evidence, never another copy of npm output.
          request.onOutput(`\n${bootstrapFailureMessage({ code, attempts: attempt })}\n`);
          return result;
        }
        report.log(`npm ${code}: retrying bb installation on the same sandbox in ${pause / 1000}s (attempt ${attempt + 1}/3).\n`);
        await clock.wait(pause, request.signal);
        request.signal.throwIfAborted();
        if (clock.now() >= deadline) {
          request.onOutput(`\n${bootstrapFailureMessage({ code, attempts: attempt })}\n`);
          return result;
        }
      }
    },
  };
}
