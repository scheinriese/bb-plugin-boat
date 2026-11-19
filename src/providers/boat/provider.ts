// boat.dev as a sandbox provider: the SandboxProvider members on the boat
// CLI (BoatApi, ./api.ts). Each member hands its call to the boat client as
// the plugin made it before the provider layer, so boat sees the same
// commands; boat's own rules stay here (the auto-stop cap's retry, the git
// hooks' environment, the `boat ssh` executor).
import { SIZE_SPECS } from "../../memory.ts";
import { MACHINE_TYPES, type MachineSpec, type SandboxCapabilities, type SandboxProvider, type SizeOption } from "../types.ts";
import { BOAT_GIT_ENV, withinAutoStopCap, type BoatApi } from "./api.ts";
import type { BoatCli } from "./cli.ts";
import { sshExecutor } from "./ssh.ts";

/** The boat client the provider calls: the plugin's BoatApi, or a test's stand-in for it. */
export type BoatClient = BoatApi;

/** bb's machine provider id for boat sandboxes; bb keeps it on every machine and host. */
export const MACHINE_PROVIDER_ID = "boat-sandbox";

/** boat sandbox ids. */
export const SANDBOX_ID_PATTERN = /^bx_[A-Za-z0-9]+$/;

export const BOAT_CAPABILITIES: SandboxCapabilities = {
  os: "linux",
  shell: "bash",
  homeDir: "/home/user",
  execMaxSeconds: 600,
  stopKeepsDisk: true,
  // boat deletes a stopped sandbox after 14 days.
  retentionAfterStopSeconds: 14 * 24 * 3600,
  // Hard stop after (`--ttl`, `boat extend`); it counts only boat's own agents as working.
  autoStop: { extendable: true, seesBbActivity: false },
  agentBusyState: true,
  previews: "token-link",
  bbEnrollment: true,
  concurrencyUnit: "sandboxes",
};

/** boat's sizes (`--type`), as `boat new --help` describes them. */
export const BOAT_SIZES: readonly SizeOption[] = MACHINE_TYPES.map((id) => ({
  id,
  label: SIZE_SPECS[id].label,
  cpus: SIZE_SPECS[id].cpus,
  memoryGb: SIZE_SPECS[id].memoryGb,
}));

/** "Boat sandbox" in bb's machine and environment pickers. */
export const BOAT_MACHINE: MachineSpec = {
  id: MACHINE_PROVIDER_ID,
  displayName: "Boat sandbox",
  description: "Run bb chats in a boat.dev cloud sandbox, with the Claude and ChatGPT logins connected in boat.dev (or bb's Account Pooler, if it routes them).",
  icon: "ComputerCloud",
  // For project chats (bb clones the project there) and project-less chats.
  environments: [
    {
      id: "boat-sandbox",
      displayName: "Boat sandbox",
      description: "A new boat.dev cloud sandbox with this project checked out",
      environmentProviderId: "project-checkout",
    },
    {
      id: "boat-sandbox-personal",
      displayName: "Boat sandbox",
      description: "A new boat.dev cloud sandbox with a personal workspace",
      environmentProviderId: "personal-workspace",
    },
  ],
  machineName: (key) => `bb machine ${key.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24)}`,
  machineLabel: (sandboxId, hostId) => `Boat ${sandboxId} (${hostId.slice(-6)})`,
  words: {
    invalidInputs: "Boat machine options are invalid. Choose a supported size, snapshot and reviewer.",
    usingPrepared: "Using the prepared boat sandbox",
    creating: "Creating the boat sandbox",
    resuming: "Resuming the boat sandbox",
    created: (sandboxId) => `boat sandbox ${sandboxId}`,
    gone: (sandboxId) => `boat sandbox ${sandboxId} no longer exists`,
  },
};

/**
 * boat.dev as a SandboxProvider. `cli`: the boat CLI for `boat ssh` (bb
 * machines); without it, the client's.
 */
export function createBoatProvider(client: BoatClient, options: { cli?: Pick<BoatCli, "binary"> } = {}): SandboxProvider {
  return {
    id: "boat",
    displayName: "boat.dev",
    caps: BOAT_CAPABILITIES,
    idPattern: SANDBOX_ID_PATTERN,
    sizes: BOAT_SIZES,
    machine: BOAT_MACHINE,

    capacity: (signal) => client.limits(signal),
    usagePlan: (signal) => client.usagePlan(signal),
    usage: (sandboxId, window, signal) => client.usage(sandboxId, window, signal),

    list: (options) => client.list(options),
    info: (sandboxId, signal) => client.info(sandboxId, signal),
    findInfo: (sandboxId, signal) => client.findInfo(sandboxId, signal),
    create: (options) =>
      withinAutoStopCap(options.ttlSeconds, (ttlSeconds) =>
        client.create({
          name: options.name,
          type: options.type,
          environment: options.environment,
          from: options.snapshot ?? null,
          // git uses the plugin's hooks (base-branch guard) whatever the repo configures.
          env: options.gitGuard ? BOAT_GIT_ENV : {},
          ttlSeconds,
          signal: options.signal,
        }),
      ),
    delete: (sandboxId, signal) => client.delete(sandboxId, signal),
    stop: (sandboxId, signal, options) => client.stop(sandboxId, signal, options),
    stopStatus: (sandboxId, stopId, signal) => client.stopStatus(sandboxId, stopId, signal),
    fork: (sandboxId, options) => client.fork(sandboxId, options),
    lastSnapshotAt: (sandboxId, signal) => client.lastSnapshotAt(sandboxId, signal),
    resume: (sandboxId, options) =>
      withinAutoStopCap(options.ttlSeconds, (ttlSeconds) => client.resume(sandboxId, ttlSeconds, options.signal, options.type)),
    extend: (sandboxId, ttlSeconds, signal) =>
      withinAutoStopCap(ttlSeconds, async (seconds) => {
        await client.extend(sandboxId, ["--ttl", String(seconds)], signal);
        return { ttlSeconds: seconds };
      }),

    exec: (sandboxId, script, options) => client.exec(sandboxId, script, options),
    execDetached: (sandboxId, script, signal) => client.execDetached(sandboxId, script, signal),
    processes: (sandboxId, signal) => client.processes(sandboxId, signal),

    prepareRepo: (sandboxId, repo, checkout, options) => client.prepareRepo(sandboxId, repo, checkout, options),
    githubLogin: (sandboxId, signal) => client.githubLogin(sandboxId, signal),
    ship: (sandboxId, targets, signal, shippedBy) => client.ship(sandboxId, targets, signal, shippedBy),

    host: (sandboxId, port, title, signal) => client.host(sandboxId, port, title, signal),
    snapshot: (sandboxId, name, signal) => client.snapshot(sandboxId, name, signal),
    snapshots: (signal) => client.snapshots(signal),
    environments: (signal) => client.environments(signal),
    defaultEnvironment: (signal) => client.defaultEnvironment(signal),
    environmentInfo: (name, signal) => client.environmentInfo(name, signal),
    aiProxy: (signal) => client.aiProxy(signal),

    prompt: (options) => client.prompt(options),
    conversations: (sandboxId, signal) => client.conversations(sandboxId, signal),
    events: (sandboxId, conversationId, signal) => client.events(sandboxId, conversationId, signal),
    steer: (sandboxId, conversationId, message, signal) => client.steer(sandboxId, conversationId, message, signal),
    interrupt: (sandboxId, conversationId, signal) => client.interrupt(sandboxId, conversationId, signal),

    executor: (sandboxId) => sshExecutor(options.cli ?? client.cli, sandboxId),
  };
}
