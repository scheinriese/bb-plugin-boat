import { ownMacConfigSchema } from "../../../contract-providers.ts";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { MachineExecutor, PluginKvStorage } from "@get-bb/plugin-sdk";
import { unavailableProvider } from "../registry.ts";
import {
  ProviderError,
  type SandboxProvider,
  type SandboxInfo,
} from "../types.ts";
import { SCALEWAY_TASK_SIZES, BOOTSTRAP } from "../scaleway/provider.ts";
import { shellQuote } from "../shell.ts";
import type { SshRequest } from "../scaleway/ssh.ts";
import type { CredentialSource } from "../../credentials.ts";
import {
  aliasExec,
  AVAILABILITY_SCRIPT,
  availability,
  localIdentity,
  parseReading,
  refusal,
  sshAliasSchema,
  type AliasExec,
  type Identity,
  type Reading,
} from "./probe.ts";

export interface OwnMacConfig {
  ownMacIsolation?: string;
  ownMacEnabled: boolean;
  ownMacPaused: boolean;
  ownMacAlias: string;
  ownMacMaxTasks: number;
}
const recordSchema = z.object({
  id: z.string().regex(/^ownmac_[0-9a-f-]{36}$/),
  alias: sshAliasSchema.refine(Boolean),
  hardware: z.string().regex(/^[a-f0-9]{64}$/),
  user: z.string().regex(/^[a-z_][a-z0-9_-]*$/i),
  uid: z.number().int().positive(),
  createdAt: z.string().datetime(),
  cpus: z.number().positive(),
  memoryMiB: z.number().positive(),
  active: z.boolean(),
  notice: z.string().optional(),
});
type Record = z.infer<typeof recordSchema>;
export const OWN_MAC_RECORDS = "ownMacTasksV1";
const fail = (message: string, code = "host_unavailable") =>
  new ProviderError(message, { code });
export async function createOwnMacProvider(options: {
  config(): Promise<OwnMacConfig>;
  kv: PluginKvStorage;
  credentials: CredentialSource;
  ssh?: AliasExec;
  local?: () => Promise<Identity>;
  now?: () => number;
}) {
  const readConfig = async () =>
    ownMacConfigSchema.parse(await options.config());
  let configuredAlias = (await readConfig()).ownMacAlias;
  const ssh = options.ssh ?? aliasExec,
    now = options.now ?? Date.now,
    credentials = options.credentials;
  const records = new Map<string, Record>(
    z
      .array(recordSchema)
      .parse((await options.kv.get<unknown>(OWN_MAC_RECORDS)) ?? [])
      .map((record) => [record.id, record]),
  );
  let storageLock: Promise<unknown> = Promise.resolve();
  function save() {
    // Keep recovery records for every active/uncertain task and a bounded
    // recent closed history. Checkouts themselves remain on the Mac.
    const closed = [...records.values()].filter(
      (value) => !value.active && !value.notice,
    );
    for (const value of closed.slice(0, Math.max(0, closed.length - 128)))
      records.delete(value.id);
    const snapshot = [...records.values()].map((value) => ({ ...value }));
    const next = storageLock.then(() =>
      options.kv.set(OWN_MAC_RECORDS, snapshot),
    );
    storageLock = next.catch(() => undefined);
    return next;
  }
  let cached: {
    at: number;
    key: string;
    reading: Reading;
    local: Identity;
  } | null = null;
  let lock: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = lock.then(run, run);
    lock = next.catch(() => undefined);
    return next;
  }
  const active = () =>
    [...records.values()].filter((record) => record.active).length;
  async function probe(force = false, signal?: AbortSignal) {
    const config = await readConfig();
    configuredAlias = config.ownMacAlias;
    const running = active();
    if (
      !config.ownMacEnabled ||
      !config.ownMacAlias ||
      !sshAliasSchema.safeParse(config.ownMacAlias).success
    )
      return { status: "Not set up", running, max: config.ownMacMaxTasks };
    if (config.ownMacPaused)
      return { status: "Paused", running, max: config.ownMacMaxTasks };
    try {
      if (
        force ||
        !cached ||
        cached.key !== config.ownMacAlias ||
        now() - cached.at >= 45_000
      ) {
        const local = await (options.local ?? localIdentity)();
        const result = await ssh(config.ownMacAlias, {
          command: ["/bin/bash", "-c", AVAILABILITY_SCRIPT],
          timeoutMs: 8000,
          signal,
        });
        if (result.exitCode) throw new Error();
        cached = {
          at: now(),
          key: config.ownMacAlias,
          reading: parseReading(result.stdout),
          local,
        };
      }
      return {
        status: availability(
          cached.reading,
          cached.local,
          running,
          config.ownMacMaxTasks,
        ),
        reading: cached.reading,
        running,
        max: config.ownMacMaxTasks,
      };
    } catch {
      cached = null;
      return {
        status: "Asleep or unreachable",
        running,
        max: config.ownMacMaxTasks,
      };
    }
  }
  function record(id: string) {
    const value = records.get(id);
    if (!value)
      throw fail("This Your Mac task has no recorded target.", "not_found");
    return value;
  }
  // Credential removal uses the recorded target even after pause/disable or an
  // alias edit. Recheck its identity first, so an SSH-config edit cannot send
  // cleanup to a different account. Never use the current alias as recovery.
  async function verify(value: Record, signal?: AbortSignal) {
    const result = await ssh(value.alias, {
      command: ["/bin/bash", "-c", AVAILABILITY_SCRIPT],
      timeoutMs: 8000,
      signal,
    });
    if (result.exitCode) throw fail("Your Mac is asleep or unreachable.");
    const reading = parseReading(result.stdout),
      local = await (options.local ?? localIdentity)();
    const reason = refusal(reading, local);
    if (reason) throw fail(reason, "ownmac_refused");
    if (
      reading.hardware !== value.hardware ||
      reading.user !== value.user ||
      reading.uid !== value.uid
    )
      throw fail(
        "The SSH alias now points to a different account. Restore the recorded target before cleanup.",
        "ownmac_refused",
      );
    return reading;
  }
  async function run(id: string, request: SshRequest) {
    const value = record(id);
    // The extra home separates task credentials; the VM/user is the security
    // boundary. Never mount or copy the owner's home into this directory.
    const command = `export HOME="$HOME/.bb-ownmac/${id}"\nexport PATH="$HOME/.local/bin:$PATH"\nexec ${request.command.map(shellQuote).join(" ")}`;
    return ssh(value.alias, {
      ...request,
      command: ["/bin/bash", "-c", command],
    });
  }
  const executor = (id: string): MachineExecutor => ({
    async exec(request) {
      const result = await run(id, request);
      return { exitCode: result.exitCode };
    },
  });
  const credentialLocks = new Map<string, Promise<unknown>>();
  async function locked<T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const next = (credentialLocks.get(id) ?? Promise.resolve()).then(
      operation,
      operation,
    );
    credentialLocks.set(id, next);
    try {
      return await next;
    } finally {
      if (credentialLocks.get(id) === next) credentialLocks.delete(id);
    }
  }
  const cleanup = (id: string, signal?: AbortSignal) =>
    locked(id, () => cleanupInner(id, signal));
  async function ensureGithub(id: string, signal?: AbortSignal) {
    return locked(id, async () => {
      if (!record(id).active)
        throw fail("This Your Mac task is closed.", "task_closed");
      await verify(record(id), signal);
      return credentials.ensureGithub(id, executor(id), signal);
    });
  }
  async function cleanupInner(id: string, signal?: AbortSignal) {
    const value = record(id);
    if (!value.active && !value.notice) return;
    try {
      await verify(value, signal);
      await credentials.cleanup(id, executor(id), signal);
      const result = await ssh(value.alias, {
        command: ["/bin/bash", "-c", `rm -f "$HOME/.bb-ownmac-active/${id}"`],
        timeoutMs: 8000,
        signal,
      });
      if (result.exitCode) throw new Error();
      value.active = false;
      delete value.notice;
      await save();
      cached = null;
    } catch {
      value.notice =
        "Credential removal could not be verified on Your Mac. Restore SSH access and close the task again to retry cleanup. Revoke or rotate its GitHub token if access cannot be restored.";
      await save();
      throw fail(value.notice, "credential_cleanup_failed");
    }
  }
  const info = (id: string): SandboxInfo => {
    const value = record(id);
    return {
      id,
      name: "Your Mac",
      system: "macos",
      state: value.active ? "idle" : "stopped",
      health: null,
      url: null,
      desktopUrl: null,
      environment: null,
      createdAt: value.createdAt,
      archiveAfter: null,
      stoppedAt: null,
      setupStatus: null,
      error: value.notice ?? null,
    };
  };
  const unsupported = async (): Promise<never> => {
    throw fail(
      "Your Mac runs tasks as bb chats. This operation is not available.",
      "unsupported",
    );
  };
  const provider: SandboxProvider = {
    ...unavailableProvider("ownmac"),
    displayName: "Your Mac",
    idPattern: /^ownmac_[0-9a-f-]{36}$/,
    sizes: SCALEWAY_TASK_SIZES,
    caps: {
      os: "macos",
      systems: ["macos"],
      shell: "bash",
      homeDir: "~",
      execMaxSeconds: 3600,
      stopKeepsDisk: true,
      retentionAfterStopSeconds: null,
      environments: false,
      autoStop: null,
      agentBusyState: false,
      previews: "token-link",
      bbEnrollment: true,
      headlessAgentRunner: false,
      concurrencyUnit: "sandboxes",
    },
    machine: {
      id: "ownmac-sandbox",
      displayName: "Your Mac",
      description: "Tasks in your isolated Mac account or VM",
      icon: "Computer",
      environments: [],
      machineName: (key) => `bb-ownmac-${key}`,
      machineLabel: () => "Your Mac",
      words: {
        invalidInputs: "Choose a Mac task size.",
        usingPrepared: "Using Your Mac",
        creating: "Preparing Your Mac",
        resuming: "Reconnecting to Your Mac",
        created: () => "Your Mac",
        gone: () => "Your Mac task is no longer available",
        stopSaid: (reason) => reason,
        notStopped: (why) => why,
        stillRestoring: (detail) => `Reconnecting to Your Mac${detail}`,
      },
    },
    classifiesCreateErrors: true,
    configured: async () => Boolean((await readConfig()).ownMacAlias),
    ownMacStatus: probe,
    runsOnMachine: (id) =>
      id ? (records.get(id)?.alias ?? null) : configuredAlias || null,
    async presentation({ force, signal } = {}) {
      const state = await probe(force, signal);
      return {
        steps: [],
        status: state.status,
        ownMac: {
          ...(await readConfig()),
          running: state.running,
          max: state.max,
        },
        pricing: "$0 rent",
        meta: `${state.running} of ${state.max} tasks running`,
      };
    },
    releaseNotice: () =>
      [...records.values()]
        .flatMap((value) => (value.notice ? [value.notice] : []))
        .join("\n") || null,
    pricing: async () => "$0 rent",
    usagePlan: async () => null,
    usage: async () => ({
      seconds: 0,
      hours: 0,
      dollars: 0,
      since: null,
      until: null,
      running: null,
    }),
    async capacity(signal) {
      const state = await probe(false, signal);
      return {
        tier: "Your Mac",
        summary: "$0 rent",
        activeSandboxes: state.running,
        maxActiveSandboxes: state.max,
        startsLeftToday: null,
        startsLeftThisHour: null,
        canStart: state.status === "Available",
        blockedReason: state.status === "Available" ? null : state.status,
        checkoutRequired: false,
        autoStopCapHours: null,
      };
    },
    list: async () =>
      [...records.values()]
        .filter((value) => value.active)
        .map((value) => info(value.id)),
    info: async (id) => info(id),
    findInfo: async (id) => (records.has(id) ? info(id) : null),
    async assertTaskReady({ agent, repos, sandboxId, signal }) {
      if (sandboxId) {
        const value = record(sandboxId);
        if (!value.active)
          throw fail(
            "This Your Mac task is closed. Start a new task to use a fresh credential home.",
            "task_closed",
          );
        const reading = await verify(value, signal);
        if (!reading.ac || !reading.session)
          throw fail(!reading.ac ? "On battery" : "No logged-in session");
      } else {
        const state = await probe(true, signal);
        if (state.status !== "Available")
          throw fail(state.status, "ownmac_unavailable");
      }
      await credentials.assertReady(agent, repos, signal);
    },
    allocate: (input) =>
      serial(async () => {
        if (input.system !== "macos" || input.snapshot)
          throw fail(
            "Your Mac supports Mac tasks without snapshots.",
            "unsupported",
          );
        const state = await probe(true, input.signal);
        if (state.status !== "Available" || !state.reading)
          throw fail(state.status, "ownmac_unavailable");
        const need = SCALEWAY_TASK_SIZES.find(
          (size) => size.id === input.type,
        )!;
        const reserved = [...records.values()].filter(
          (value) => value.active && value.hardware === state.reading!.hardware,
        );
        if (
          state.reading.freeMiB -
            need.memoryGb * 1024 -
            reserved.reduce((sum, value) => sum + value.memoryMiB, 0) <
            Math.max(4096, state.reading.memoryMiB / 4) ||
          need.cpus + reserved.reduce((sum, value) => sum + value.cpus, 0) >=
            state.reading.cpus
        )
          throw fail(
            "Not enough free memory or CPU for this task and your headroom.",
            "ownmac_unavailable",
          );
        const id = `ownmac_${randomUUID()}`,
          value: Record = {
            id,
            alias: (await readConfig()).ownMacAlias,
            hardware: state.reading.hardware!,
            user: state.reading.user,
            uid: state.reading.uid,
            createdAt: new Date(now()).toISOString(),
            cpus: need.cpus,
            memoryMiB: need.memoryGb * 1024,
            active: true,
          };
        records.set(id, value);
        await save();
        let result;
        try {
          result = await ssh(value.alias, {
            command: [
              "/bin/bash",
              "-c",
              `umask 077; mkdir -p "$HOME/.bb-ownmac/${id}" "$HOME/.bb-ownmac-active"; touch "$HOME/.bb-ownmac-active/${id}"`,
            ],
            timeoutMs: 8000,
            signal: input.signal,
          });
        } catch {
          result = { exitCode: 255 };
        }
        if (result.exitCode) {
          try {
            await cleanup(id);
          } catch {
            throw fail(
              "Your Mac task setup could not be confirmed. Restore SSH and clean up its tracked task before retrying.",
              "creation_allocated",
            );
          }
          throw fail("Your Mac task setup failed.");
        }
        return info(id);
      }),
    async waitReady(id, signal) {
      await verify(record(id), signal);
      const result = await run(id, {
        command: ["/bin/bash", "-s"],
        stdin: BOOTSTRAP,
        timeoutMs: 15 * 60000,
        signal,
      });
      if (result.exitCode)
        throw fail("Your Mac tooling installation failed.", "bootstrap_failed");
      return info(id);
    },
    async create(input) {
      const sandbox = await provider.allocate!(input);
      return provider.waitReady!(sandbox.id, input.signal);
    },
    closeTaskCredentials: async (id, signal, machineRemoved = true) => {
      if (!machineRemoved) {
        const value = record(id);
        value.active = true;
        value.notice =
          "Your Mac task credentials need attention: bb could not remove its machine and revoke its agent proxy access. Close the task again after restoring access.";
        await save();
        throw fail(value.notice, "credential_cleanup_failed");
      }
      await cleanup(id, signal);
    },
    delete: cleanup,
    stop: async () => ({ status: "completed", stopId: null, forced: false }),
    stopStatus: async () => ({
      status: "completed",
      stopId: null,
      forced: false,
    }),
    resume: async (id, input) => {
      const value = record(id);
      if (!value.active)
        throw fail(
          "Start a new Your Mac task; closed sessions are not resumed.",
          "task_closed",
        );
      const config = await readConfig();
      if (!config.ownMacEnabled || config.ownMacPaused)
        throw fail(config.ownMacPaused ? "Paused" : "Not set up");
      await verify(value, input?.signal);
    },
    exec: (id, script, input) =>
      run(id, {
        command: ["/bin/bash", input?.login === false ? "-c" : "-lc", script],
        timeoutMs: input?.timeoutMs ?? 60000,
        signal: input?.signal,
      }),
    async execDetached(id, script, signal) {
      const result = await provider.exec(
        id,
        `nohup bash -lc ${shellQuote(script)} </dev/null >/dev/null 2>&1 & echo $!`,
        { signal },
      );
      return { pid: Number(result.stdout.trim()) || null };
    },
    executor,
    beforeRepo: async (id, signal) => {
      await verify(record(id), signal);
      if (await credentials.githubConfigured()) await ensureGithub(id, signal);
    },
    refreshGithubLogin: ensureGithub,
    machineHooks: () => ({
      bootstrapFailed: (id) => cleanup(id),
      beforeBootstrap: async (id, signal) => {
        await verify(record(id), signal);
        const result = await run(id, {
          command: ["/bin/bash", "-s"],
          stdin: BOOTSTRAP,
          timeoutMs: 15 * 60000,
          signal,
        });
        if (result.exitCode)
          throw fail(
            "Your Mac tooling installation failed.",
            "bootstrap_failed",
          );
      },
    }),
    processes: unsupported,
    host: unsupported,
    lastSnapshotAt: async () => null,
    snapshots: async () => ({ snapshots: [], included: null, used: null }),
    environments: async () => [],
    defaultEnvironment: async () => null,
    aiProxy: async () => ({
      enabled: false,
      dailyDollars: 0,
      dollarsPer1000Requests: 0,
    }),
    conversations: async () => [],
  };
  return provider;
}
