// `boat ssh` as bb's machine executor: bb installs its daemon in a boat
// sandbox through it (src/providers/machine.ts).
import { spawn } from "node:child_process";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { shellQuote } from "../shell.ts";
import type { BoatCli } from "./cli.ts";

/**
 * Runs bootstrap commands over `boat ssh`, which streams output and keeps
 * stdin (enrollment secrets) out of boat's command history.
 */
export function sshExecutor(cli: Pick<BoatCli, "binary">, sandboxId: string): MachineExecutor {
  return {
    async exec({ command, stdin, timeoutMs, signal, onOutput }) {
      signal.throwIfAborted();
      const binary = await cli.binary();
      signal.throwIfAborted();
      // ssh hands the remote side one command string; quote each argv entry
      // and run it in a login shell so the sandbox's node (nvm) is on PATH.
      const remote = `bash -lc ${shellQuote(command.map(shellQuote).join(" "))}`;
      return new Promise<{ exitCode: number }>((resolve, reject) => {
        const child = spawn(binary, ["ssh", sandboxId, remote], {
          env: { ...process.env, BOAT_NO_UPDATE: "1", NO_COLOR: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          fn();
        };
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          finish(() => reject(new Error(`command timed out after ${Math.round(timeoutMs / 1000)}s`)));
        }, timeoutMs);
        const onAbort = () => {
          child.kill("SIGTERM");
          finish(() => reject(new Error("aborted")));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => onOutput(chunk));
        child.stderr.on("data", (chunk: string) => onOutput(chunk));
        child.on("error", (error) => finish(() => reject(error)));
        child.on("close", (code) => finish(() => resolve({ exitCode: code ?? 1 })));
        child.stdin.on("error", () => undefined);
        child.stdin.end(stdin);
      });
    },
  };
}
