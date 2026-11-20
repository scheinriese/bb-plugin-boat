// A sandbox provider's sandboxes as bb machines: bb threads (for example a
// cloud orchestrator) can run inside one. bb installs its daemon there
// through the provider's executor; the daemon connects back over bb Connect.
// The provider supplies its words, its executor and its own steps around
// bb's setup and planned stops (machineHooks; boat.dev: ./boat/machine.ts
// registers "Boat sandbox", whose hooks quiet the login scripts and trim the
// disk). Wakes are paced, diagnosed and retried (src/wake-retry.ts), and bb
// is updated safely on a resume (src/bb-update.ts), where the caller passes
// those.
import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { reviewerSchema } from "../../contract-review.ts";
import { ACTIVE_STATES, isNotFound, type MachineType, type SandboxProvider, type StopReport } from "./types.ts";
import type { BoatService, BoatSettings } from "../service.ts";
import { bootstrapExecutor, bootstrapFailureMessage, retryableBootstrap } from "../bootstrap.ts";
import { directWakes, type WakeGuard } from "../wake-retry.ts";
import { TeardownBackoff } from "../teardown-backoff.ts";
import type { HostPrep } from "../bb-update.ts";
import { stopOutcome } from "../node-move.ts";

const resourceSchema = z.object({ sandboxId: z.string(), key: z.string() });

function inputsSchema(provider: Pick<SandboxProvider, "sizes" | "idPattern">) {
  return z
    .object({
      type: z.enum(provider.sizes.map((size) => size.id) as [MachineType, ...MachineType[]]).optional(),
      snapshot: z.string().trim().min(1).max(120).optional(),
      /** Explicit native-task choice; absent inherits its project/global policy. */
      reviewer: reviewerSchema.optional(),
      /** Adopt this prepared sandbox (a worker chat's) instead of creating one. */
      sandboxId: z.string().regex(provider.idPattern).optional(),
      /** The task whose worker chat runs on it. */
      taskId: z.string().max(64).optional(),
      /**
       * The sandbox holds a headless task's work (Continue as a chat): removing
       * this machine, or a failed creation, never deletes it until the move is done.
       */
      keepSandbox: z.boolean().optional(),
    })
    .strict();
}

/** kv key remembering which sandbox an adopting machine took (cleanup only gets the key). */
const adoptedKey = (key: string) => `machineSandbox:${key}`;

/**
 * kv key set while a machine's sandbox must survive the machine (a headless
 * task moving to a chat): remove and cleanup then leave the sandbox alone.
 * Only a finished move clears it (ChatRunner.settleMachine); a failed try's
 * flag stays, so a late removal can't delete the task's work.
 */
export const keepSandboxKey = (key: string) => `machineKeep:${key}`;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MachineDeps {
  service: Pick<BoatService, "createSandbox" | "bringUp">;
  settings: () => Promise<BoatSettings>;
  /** Can new machines start now (setup-required, with what to fix)? */
  availability: () => Promise<{ status: "available" } | { status: "setup-required"; message: string }>;
  /** Paced wakes, diagnosed failures and Boat's own retries (src/wake-retry.ts); absent: resumes go out at once. */
  wakes?: Pick<WakeGuard, "machine"> & Partial<Pick<WakeGuard, "stopRefused">>;
  /** Before bb's setup on a sandbox that is up, instead of the provider's own step (tests; boat.dev's quiets the login scripts, src/login-scripts.ts). */
  quietLogins?: (sandboxId: string, signal?: AbortSignal) => Promise<unknown>;
  /**
   * Before bb's setup on a resume: read bb's files, update bb there safely
   * (src/bb-update.ts); forget: the sandbox is deleted. Absent: bb's setup goes straight ahead.
   */
  prepareHost?: ((prep: HostPrep) => Promise<unknown>) & { forget?(sandboxId: string): Promise<void> };
  /** Tests: the teardown backoff's clock. */
  now?: () => number;
  /** How long a suspend follows a pending stop, and how often it asks (default 5 s, up to 90 s). */
  stopWait?: { pollMs: number; maxMs: number };
  /** Tests: the budget of the provider's step before a stop (boat.dev's trim: TRIM_TIMEOUT_MS, a minute). */
  trimTimeoutMs?: number;
}

/** Register the provider's bb machine provider and its environments (nothing without bb enrollment). */
export function registerSandboxMachine(bb: BbPluginApi, provider: SandboxProvider, deps: MachineDeps): void {
  const machine = provider.machine;
  const executor = provider.executor?.bind(provider);
  if (machine === undefined || executor === undefined) return;
  const { service } = deps;
  const { words } = machine;
  const inputs = inputsSchema(provider);
  const wakes = deps.wakes ?? directWakes;
  // The provider's own steps around bb's setup and planned stops (boat.dev: quiet login scripts, trim the disk).
  const hooks = provider.machineHooks?.({
    warn: (line) => bb.log?.warn?.(line),
    debug: (line) => bb.log?.debug?.(line),
    ...(deps.trimTimeoutMs === undefined ? {} : { stopStepTimeoutMs: deps.trimTimeoutMs }),
  }) ?? {};
  const beforeBootstrap = deps.quietLogins ?? hooks.beforeBootstrap ?? (async () => undefined);
  /** After the provider fails a stop or delete, bb's retries wait (src/teardown-backoff.ts). */
  const teardown = new TeardownBackoff(deps.now);
  const stopWait = deps.stopWait ?? { pollMs: 5_000, maxMs: 90_000 };

  /** The machine's sandbox holds a headless task's work: bb forgets the machine, the sandbox stays. */
  async function keptSandbox(key: string): Promise<boolean> {
    if (typeof (await bb.storage.kv.get<string>(keepSandboxKey(key))) !== "string") return false;
    await bb.storage.kv.delete(adoptedKey(key)).catch(() => undefined);
    return true;
  }

  async function findByKey(key: string) {
    const adopted = await bb.storage.kv.get<string>(adoptedKey(key));
    if (typeof adopted === "string") return provider.findInfo(adopted);
    const name = machine!.machineName(key);
    return (await provider.list({ all: true })).find((sandbox) => sandbox.name === name) ?? null;
  }

  bb.experimental_machines.register({
    id: machine.id,
    displayName: machine.displayName,
    description: machine.description,
    icon: machine.icon,
    // bb removes the machine (and we delete its sandbox) once no live chat needs it.
    ephemeral: true,
    inputs,
    availability: () => deps.availability(),
    async create({ inputs: given, key, checkpoint, report, signal }) {
      let bootstrapSandbox: string | null = null;
      try {
        const parsed = inputs.safeParse(given ?? {});
        if (!parsed.success) throw new Error(words.invalidInputs);
        const adopt = parsed.success ? (parsed.data.sandboxId ?? null) : null;
        let sandbox = adopt === null ? null : await provider.findInfo(adopt, signal);
        if (adopt !== null) {
          // A worker chat's sandbox: the plugin already created and prepared it.
          if (sandbox === null) throw new Error(words.gone(adopt));
          if (parsed.success && parsed.data.keepSandbox) await bb.storage.kv.set(keepSandboxKey(key), adopt);
          await bb.storage.kv.set(adoptedKey(key), adopt);
          report.step(words.usingPrepared);
          if (!ACTIVE_STATES.has(sandbox.state)) sandbox = await service.bringUp(adopt, signal);
        } else {
          report.step(words.creating);
          sandbox = await findByKey(key);
        }
        if (sandbox === null) {
          const settings = await deps.settings();
          // Same slot handling as workers (frees an idle task sandbox when full);
          // orchestrators only coordinate, so they default to a small machine.
          sandbox = await service.createSandbox({
            name: machine.machineName(key),
            type: ((given as { type?: MachineType } | null)?.type ?? settings.orchestratorMachineType) as MachineType,
            // Any bb chat can use this machine; keep the repo's own git hooks.
            gitGuard: false,
            snapshot: parsed.success ? parsed.data.snapshot ?? null : null,
            // On this provider, within its own limits.
            sandboxProvider: provider,
            signal,
          });
        } else if (!ACTIVE_STATES.has(sandbox.state)) {
          report.step(words.resuming);
          sandbox = await service.bringUp(sandbox.id, signal);
        }
        await checkpoint({ sandboxId: sandbox.id, key, ...(parsed.success && parsed.data.snapshot ? { snapshot: parsed.data.snapshot } : {}), ...(parsed.success && parsed.data.reviewer ? { reviewer: parsed.data.reviewer } : {}) });
        report.log(words.created(sandbox.id));
        bootstrapSandbox = sandbox.id;
        await beforeBootstrap(sandbox.id, signal);
        report.step("Installing bb on the sandbox");
        const { hostId } = await bb.experimental_machines.bootstrap({
          key,
          executor: bootstrapExecutor(executor(sandbox.id), report),
          report,
          signal,
        });
        return { status: "created" as const, name: machine.machineLabel(sandbox.id, hostId), resource: { sandboxId: sandbox.id, key, ...(parsed.success && parsed.data.snapshot ? { snapshot: parsed.data.snapshot } : {}), ...(parsed.success && parsed.data.reviewer ? { reviewer: parsed.data.reviewer } : {}) } };
      } catch (error) {
        if (bootstrapSandbox !== null) await hooks.bootstrapFailed?.(bootstrapSandbox);
        signal.throwIfAborted();
        const transient = retryableBootstrap(error);
        return { status: "failed" as const, message: transient ? bootstrapFailureMessage(transient) : message(error) };
      }
    },
    async reconcileCleanup({ key }) {
      const held = teardown.held(`key:${key}`, "delete");
      if (held !== null) return { status: "failed" as const, message: held };
      try {
        if (await keptSandbox(key)) return { status: "removed" as const };
        const sandbox = await findByKey(key);
        if (sandbox !== null) {
          await provider.delete(sandbox.id);
          await deps.prepareHost?.forget?.(sandbox.id).catch(() => undefined);
        }
        teardown.succeeded(`key:${key}`, "delete");
        return { status: "removed" as const };
      } catch (error) {
        return { status: "failed" as const, message: teardown.failed(`key:${key}`, "delete", error) };
      }
    },
    async suspend({ resource, hostId, signal }) {
      const { sandboxId } = resourceSchema.parse(resource);
      const held = teardown.held(sandboxId, "stop");
      if (held !== null) throw new Error(held);
      let refused: string | null = null;
      let stop: StopReport | null = null;
      try {
        const sandbox = await provider.findInfo(sandboxId);
        // Already stopped (for example by the provider's auto-stop) is fine: the disk is kept.
        if (sandbox !== null && ACTIVE_STATES.has(sandbox.state)) {
          // The provider's step first (boat.dev: blocks deleted files freed are trimmed, since its snapshot
          // counts them until they are and the sandbox outgrows its size, src/disk-trim.ts). Bounded; it never fails the stop.
          await hooks.beforeStop?.(sandboxId, { state: sandbox.state, signal });
          stop = await provider.stop(sandboxId);
          // The provider usually answers "pending" while it takes the final snapshot: follow that
          // stop a while (its status, never a second stop). It may refuse: it can't snapshot a disk
          // it hasn't finished restoring.
          let state = (await provider.findInfo(sandboxId))?.state ?? null;
          let outcome = stopOutcome(stop, state);
          for (let polls = Math.ceil(stopWait.maxMs / stopWait.pollMs); outcome === "pending" && stop.stopId !== null && polls > 0; polls--) {
            await delay(stopWait.pollMs, undefined, { signal });
            stop = { ...(await provider.stopStatus(sandboxId, stop.stopId)), stopId: stop.stopId };
            state = (await provider.findInfo(sandboxId))?.state ?? null;
            outcome = stopOutcome(stop, state);
          }
          // Still pending: the provider goes on with it, as a stop always did.
          if (outcome === "refused") refused = stop.error ? words.stopSaid(stop.error.split("\n")[0]!.slice(0, 200)) : stop.status !== null && /^fail/i.test(stop.status) ? `the stop is ${stop.status}` : `it's still ${state ?? "up"}`;
        }
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(teardown.failed(sandboxId, "stop", error));
      }
      if (refused !== null) {
        const moving = (await deps.wakes?.stopRefused?.(sandboxId, hostId ?? null, stop).catch(() => false)) ?? false;
        throw new Error(teardown.failed(sandboxId, "stop", new Error(moving ? words.stillRestoring(stop?.error ? ` (${refused})` : "") : words.notStopped(refused))));
      }
      teardown.succeeded(sandboxId, "stop");
      return { resource };
    },
    async resume({ resource, report, signal, hostId }) {
      const { sandboxId, key } = resourceSchema.parse(resource);
      // Paced, with failures diagnosed and retried by Boat later (src/wake-retry.ts).
      await wakes.machine({ sandboxId, hostId: hostId ?? null, signal, report }, async (permit) => {
        const sandbox = await provider.findInfo(sandboxId, signal);
        if (sandbox === null) throw new Error(words.gone(sandboxId));
        let woke = false;
        if (!ACTIVE_STATES.has(sandbox.state)) {
          const slot = await permit();
          report.step(words.resuming);
          await service.bringUp(sandboxId, signal, { permit: slot });
          woke = true;
        }
        try {
          await beforeBootstrap(sandboxId, signal);
          // bb's own update can hang on a disk the provider is still restoring: Boat updates it first, safely.
          // No check for a running turn: bb calls resume() only for a suspended machine, so no turn runs
          // there, and stopping bb's unit for the install interrupts nothing.
          await deps.prepareHost?.({ sandboxId, hostId: hostId ?? null, woke, signal, report });
          report.step("Restarting bb on the sandbox");
          await bb.experimental_machines.bootstrap({ key, executor: bootstrapExecutor(executor(sandboxId), report), report, signal });
        } catch (error) { await hooks.bootstrapFailed?.(sandboxId); throw error; }
      });
      return { resource };
    },
    async remove({ resource }) {
      let sandboxId: string | null = null;
      try {
        const parsed = resourceSchema.parse(resource);
        sandboxId = parsed.sandboxId;
        if (await keptSandbox(parsed.key)) return { status: "removed" as const };
        const held = teardown.held(sandboxId, "delete");
        if (held !== null) return { status: "failed" as const, message: held };
        await provider.delete(sandboxId);
        teardown.succeeded(sandboxId, "delete");
        await deps.prepareHost?.forget?.(sandboxId).catch(() => undefined);
        await bb.storage.kv.delete(adoptedKey(parsed.key)).catch(() => undefined);
        return { status: "removed" as const };
      } catch (error) {
        if (isNotFound(error)) {
          if (sandboxId !== null) teardown.succeeded(sandboxId, "delete");
          return { status: "removed" as const };
        }
        return { status: "failed" as const, message: sandboxId === null ? message(error) : teardown.failed(sandboxId, "delete", error) };
      }
    },
  });

  // Offer a new sandbox in the environment picker.
  for (const environment of machine.environments) {
    bb.experimental_environments.register({
      id: environment.id,
      displayName: environment.displayName,
      description: environment.description,
      icon: machine.icon,
      machineProviderId: machine.id,
      environmentProviderId: environment.environmentProviderId,
    });
  }
}
