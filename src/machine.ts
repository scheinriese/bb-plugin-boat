// "Boat sandbox" as a bb machine: bb threads (for example a cloud
// orchestrator) can run inside a boat.dev sandbox. bb installs its daemon
// there through `boat ssh`; the daemon connects back over bb Connect.
import { spawn } from "node:child_process";
import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { reviewerSchema } from "../contract-review.ts";
import { ACTIVE_STATES, MACHINE_TYPES, type BoatApi, type MachineType } from "./boat-api.ts";
import { BoatError, type BoatCli } from "./boat.ts";
import type { BoatService, BoatSettings } from "./service.ts";
import type { ConnectCheck } from "./connect.ts";
import { machineProblem, type Setup, type SetupSettings } from "./setup.ts";
import { bootstrapExecutor, bootstrapFailureMessage, retryableBootstrap } from "./bootstrap.ts";

export const MACHINE_PROVIDER_ID = "boat-sandbox";

const resourceSchema = z.object({ sandboxId: z.string(), key: z.string() });
const inputsSchema = z
  .object({
    type: z.enum(MACHINE_TYPES).optional(),
    snapshot: z.string().trim().min(1).max(120).optional(),
    /** Explicit native-task choice; absent inherits its project/global policy. */
    reviewer: reviewerSchema.optional(),
    /** Adopt this prepared sandbox (a worker chat's) instead of creating one. */
    sandboxId: z.string().regex(/^bx_[A-Za-z0-9]+$/).optional(),
    /** The task whose worker chat runs on it. */
    taskId: z.string().max(64).optional(),
    /**
     * The sandbox holds a headless task's work (Continue as a chat): removing
     * this machine, or a failed creation, never deletes it until the move is done.
     */
    keepSandbox: z.boolean().optional(),
  })
  .strict();

/** kv key remembering which sandbox an adopting machine took (cleanup only gets the key). */
const adoptedKey = (key: string) => `machineSandbox:${key}`;

/**
 * kv key set while a machine's sandbox must survive the machine (a headless
 * task moving to a chat): remove and cleanup then leave the sandbox alone.
 * Only a finished move clears it (ChatRunner.settleMachine); a failed try's
 * flag stays, so a late removal can't delete the task's work.
 */
export const keepSandboxKey = (key: string) => `machineKeep:${key}`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function machineName(key: string): string {
  return `bb machine ${key.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24)}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs bootstrap commands over `boat ssh`, which streams output and keeps
 * stdin (enrollment secrets) out of boat's command history.
 */
export function sshExecutor(cli: BoatCli, sandboxId: string): MachineExecutor {
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

export function registerBoatMachine(
  bb: BbPluginApi,
  deps: {
    boat: BoatApi;
    cli: BoatCli;
    service: BoatService;
    settings: () => Promise<BoatSettings>;
    /** The setup checks (signed in, a plan, an agent login); absent: only the CLI is checked. */
    setup?: Setup;
    setupSettings?: () => Promise<SetupSettings>;
    connect?: ConnectCheck;
  },
): void {
  const { boat, cli, service } = deps;

  /** The machine's sandbox holds a headless task's work: bb forgets the machine, the sandbox stays. */
  async function keptSandbox(key: string): Promise<boolean> {
    if (typeof (await bb.storage.kv.get<string>(keepSandboxKey(key))) !== "string") return false;
    await bb.storage.kv.delete(adoptedKey(key)).catch(() => undefined);
    return true;
  }

  async function findByKey(key: string) {
    const adopted = await bb.storage.kv.get<string>(adoptedKey(key));
    if (typeof adopted === "string") return boat.findInfo(adopted);
    const name = machineName(key);
    return (await boat.list({ all: true })).find((sandbox) => sandbox.name === name) ?? null;
  }

  bb.experimental_machines.register({
    id: MACHINE_PROVIDER_ID,
    displayName: "Boat sandbox",
    description: "Run bb chats in a boat.dev cloud sandbox, with the Claude and ChatGPT logins connected in boat.dev (or bb's Account Pooler, if it routes them).",
    icon: "ComputerCloud",
    // bb removes the machine (and we delete its sandbox) once no live chat needs it.
    ephemeral: true,
    inputs: inputsSchema,
    async availability() {
      try {
        await cli.binary();
      } catch {
        return { status: "setup-required" as const, message: "Install the boat CLI on the machine that runs bb: run `curl -fsSL https://boat.dev/install | sh` in a terminal." };
      }
      if (deps.setup === undefined || deps.setupSettings === undefined) return { status: "available" as const };
      try {
        // The newest reading without waiting (a stale one refreshes in the
        // background); boat is read here only before the very first one.
        const setup = deps.setup;
        const [facts, settings, connect] = await Promise.all([
          setup.peek()?.facts ?? setup.reading(),
          deps.setupSettings(),
          deps.connect ? deps.connect().catch(() => null) : Promise.resolve(null),
        ]);
        const problem = machineProblem(facts, settings, connect);
        return problem === null ? { status: "available" as const } : { status: "setup-required" as const, message: problem };
      } catch {
        // Couldn't check: let the creation itself say what's wrong.
        return { status: "available" as const };
      }
    },
    async create({ inputs, key, checkpoint, report, signal }) {
      try {
        const parsed = inputsSchema.safeParse(inputs ?? {});
        if (!parsed.success) throw new Error("Boat machine options are invalid. Choose a supported size, snapshot and reviewer.");
        const adopt = parsed.success ? (parsed.data.sandboxId ?? null) : null;
        let sandbox = adopt === null ? null : await boat.findInfo(adopt, signal);
        if (adopt !== null) {
          // A worker chat's sandbox: the plugin already created and prepared it.
          if (sandbox === null) throw new Error(`boat sandbox ${adopt} no longer exists`);
          if (parsed.success && parsed.data.keepSandbox) await bb.storage.kv.set(keepSandboxKey(key), adopt);
          await bb.storage.kv.set(adoptedKey(key), adopt);
          report.step("Using the prepared boat sandbox");
          if (!ACTIVE_STATES.has(sandbox.state)) sandbox = await service.bringUp(adopt, signal);
        } else {
          report.step("Creating the boat sandbox");
          sandbox = await findByKey(key);
        }
        if (sandbox === null) {
          const settings = await deps.settings();
          // Same slot handling as workers (frees an idle task sandbox when full);
          // orchestrators only coordinate, so they default to a small machine.
          sandbox = await service.createSandbox({
            name: machineName(key),
            type: ((inputs as { type?: MachineType } | null)?.type ?? settings.orchestratorMachineType) as MachineType,
            // Any bb chat can use this machine; keep the repo's own git hooks.
            gitGuard: false,
            snapshot: parsed.success ? parsed.data.snapshot ?? null : null,
            signal,
          });
        } else if (!ACTIVE_STATES.has(sandbox.state)) {
          report.step("Resuming the boat sandbox");
          sandbox = await service.bringUp(sandbox.id, signal);
        }
        await checkpoint({ sandboxId: sandbox.id, key, ...(parsed.success && parsed.data.snapshot ? { snapshot: parsed.data.snapshot } : {}), ...(parsed.success && parsed.data.reviewer ? { reviewer: parsed.data.reviewer } : {}) });
        report.log(`boat sandbox ${sandbox.id}`);
        report.step("Installing bb on the sandbox");
        const { hostId } = await bb.experimental_machines.bootstrap({
          key,
          executor: bootstrapExecutor(sshExecutor(cli, sandbox.id), report),
          report,
          signal,
        });
        return { status: "created" as const, name: `Boat ${sandbox.id} (${hostId.slice(-6)})`, resource: { sandboxId: sandbox.id, key, ...(parsed.success && parsed.data.snapshot ? { snapshot: parsed.data.snapshot } : {}), ...(parsed.success && parsed.data.reviewer ? { reviewer: parsed.data.reviewer } : {}) } };
      } catch (error) {
        signal.throwIfAborted();
        const transient = retryableBootstrap(error);
        return { status: "failed" as const, message: transient ? bootstrapFailureMessage(transient) : message(error) };
      }
    },
    async reconcileCleanup({ key }) {
      try {
        if (await keptSandbox(key)) return { status: "removed" as const };
        const sandbox = await findByKey(key);
        if (sandbox !== null) await boat.delete(sandbox.id);
        return { status: "removed" as const };
      } catch (error) {
        return { status: "failed" as const, message: message(error) };
      }
    },
    async suspend({ resource }) {
      const { sandboxId } = resourceSchema.parse(resource);
      const sandbox = await boat.findInfo(sandboxId);
      // Already stopped (for example by boat's auto-stop) is fine: the disk is kept.
      if (sandbox !== null && ACTIVE_STATES.has(sandbox.state)) await boat.stop(sandboxId);
      return { resource };
    },
    async resume({ resource, report, signal }) {
      const { sandboxId, key } = resourceSchema.parse(resource);
      const sandbox = await boat.findInfo(sandboxId, signal);
      if (sandbox === null) throw new Error(`boat sandbox ${sandboxId} no longer exists`);
      if (!ACTIVE_STATES.has(sandbox.state)) {
        report.step("Resuming the boat sandbox");
        await service.bringUp(sandboxId, signal);
      }
      report.step("Restarting bb on the sandbox");
      await bb.experimental_machines.bootstrap({ key, executor: bootstrapExecutor(sshExecutor(cli, sandboxId), report), report, signal });
      return { resource };
    },
    async remove({ resource }) {
      try {
        const { sandboxId, key } = resourceSchema.parse(resource);
        if (await keptSandbox(key)) return { status: "removed" as const };
        await boat.delete(sandboxId);
        await bb.storage.kv.delete(adoptedKey(key)).catch(() => undefined);
        return { status: "removed" as const };
      } catch (error) {
        if (error instanceof BoatError && (error.status === 404 || error.code === "not_found")) {
          return { status: "removed" as const };
        }
        return { status: "failed" as const, message: message(error) };
      }
    },
  });

  // Offer "new boat sandbox" in the environment picker, for project chats
  // (bb clones the project there) and for project-less chats.
  bb.experimental_environments.register({
    id: "boat-sandbox",
    displayName: "Boat sandbox",
    description: "A new boat.dev cloud sandbox with this project checked out",
    icon: "ComputerCloud",
    machineProviderId: MACHINE_PROVIDER_ID,
    environmentProviderId: "project-checkout",
  });
  bb.experimental_environments.register({
    id: "boat-sandbox-personal",
    displayName: "Boat sandbox",
    description: "A new boat.dev cloud sandbox with a personal workspace",
    icon: "ComputerCloud",
    machineProviderId: MACHINE_PROVIDER_ID,
    environmentProviderId: "personal-workspace",
  });
}
