import {
  OWN_MAC_MIN_FREE_GB,
  OWN_MAC_TARGET_CHANGED,
  ownMacFactsSchema,
  type OwnMacFacts,
} from "../../../contract-ownmac.ts";
import { CREDENTIAL_CLEANUP_SCRIPT } from "../../credentials.ts";
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

export const CREDENTIAL_CHECK_SCRIPT = `set -eu
for file in "$HOME/.config/gh" "$HOME/.claude/.credentials.json" "$HOME/.codex/auth.json"; do
  test ! -e "$file" && test ! -L "$file"
done
`;
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
  uid: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  cpus: z.number().positive(),
  memoryMiB: z.number().positive(),
  active: z.boolean(),
  vm: z.boolean().nullable().optional(),
  notice: z.string().optional(),
  proxyRemovalFailed: z.boolean().optional(),
});
const targetSchema = recordSchema
  .pick({ alias: true, hardware: true, user: true, uid: true })
  .extend({ vm: z.boolean().nullable() });
type Target = z.infer<typeof targetSchema>;
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
  taskState?: (id: string) => "running" | "idle" | "closed" | null;
  onTargetChanged?: () => Promise<void>;
}) {
  const readConfig = async () =>
    ownMacConfigSchema.parse(await options.config());
  let configuredIsolation = (await readConfig()).ownMacIsolation;
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
  let failedProbe: { at: number; key: string } | null = null;
  let lock: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = lock.then(run, run);
    lock = next.catch(() => undefined);
    return next;
  }
  const metaKey = "ownMacSetupV1";
  const setupSchema = z.object({
    step: z.number().int().min(0).max(7).default(0),
    testedAlias: z.string().default(""),
    target: targetSchema.optional(),
    observedAlias: z.string().optional(),
    changedTarget: z.string().optional(),
    targetNotice: z
      .object({
        id: z.string(),
        text: z.string(),
        deliveredTo: z.array(z.string()),
      })
      .optional(),
    since: z.string().nullable().default(null),
    refusal: z.enum(["personal", "admin"]).optional(),
    refusedAlias: z.string().optional(),
    lastCleanupCheck: z.string().nullable().default(null),
    testResult: z
      .object({
        ok: z.boolean(),
        title: z.string(),
        detail: z.string(),
        checkedAt: z.string(),
      })
      .optional(),
  });
  let setup = setupSchema.parse((await options.kv.get<unknown>(metaKey)) ?? {});
  const saveSetup = () => options.kv.set(metaKey, setup);
  if (setup.observedAlias === undefined) {
    setup.observedAlias =
      setup.target?.alias ??
      (setup.testedAlias || (await readConfig()).ownMacAlias);
    await saveSetup();
  }
  const targetOf = (alias: string, value: Reading): Target =>
    targetSchema.parse({
      alias,
      hardware: value.hardware,
      user: value.user,
      uid: value.uid,
      vm: value.vm,
    });
  const sameTarget = (a: Target, b: Target) =>
    a.alias === b.alias &&
    a.hardware === b.hardware &&
    a.user === b.user &&
    a.uid === b.uid &&
    a.vm === b.vm;
  async function targetChanged(fingerprint: string) {
    if (setup.changedTarget !== fingerprint) {
      setup.changedTarget = fingerprint;
      setup.targetNotice = {
        id: randomUUID(),
        text: OWN_MAC_TARGET_CHANGED,
        deliveredTo: [],
      };
      await saveSetup();
    }
    await options.onTargetChanged?.().catch(() => undefined);
  }
  async function observeAlias(alias: string) {
    if (setup.observedAlias !== alias) {
      setup.observedAlias = alias;
      await targetChanged(JSON.stringify({ alias }));
    }
  }
  async function observeTarget(alias: string, value: Reading) {
    if (setup.target && !sameTarget(setup.target, targetOf(alias, value)))
      await targetChanged(
        JSON.stringify(
          setup.target.alias !== alias ? { alias } : targetOf(alias, value),
        ),
      );
  }
  async function assertPinned(alias: string, value: Reading) {
    const config = await readConfig();
    await observeAlias(config.ownMacAlias);
    await observeTarget(alias, value);
    if (
      config.ownMacAlias !== alias ||
      !setup.target ||
      setup.changedTarget !== undefined ||
      !sameTarget(setup.target, targetOf(alias, value))
    )
      throw fail("Test connection again", "ownmac_target_changed");
  }
  const reserves = (value: Record) =>
    value.active &&
    (!options.taskState ||
      ["running", null].includes(options.taskState(value.id)));
  const active = () => [...records.values()].filter(reserves).length;
  function cleanupFacts() {
    const failed = [...records.values()].filter((value) => value.notice);
    if (!failed.length && !setup.lastCleanupCheck) return undefined;
    return {
      failed: failed.length > 0,
      checkedAt: setup.lastCleanupCheck,
      taskIds: failed.map((value) => value.id),
      steps: failed
        .map(
          (value) =>
            `# In the agents account, for task ${value.id}\n(\nexport HOME="$HOME/.bb-ownmac/${value.id}"\nexport PATH="$HOME/.local/bin:$PATH"\n${CREDENTIAL_CLEANUP_SCRIPT})\n`,
        )
        .join("\n"),
    };
  }
  function facts(
    config: Awaited<ReturnType<typeof readConfig>>,
    status: string,
    code: OwnMacFacts["code"],
  ): OwnMacFacts {
    const value = cached?.reading,
      clean = cleanupFacts();
    const result = {
      status,
      code,
      alias: config.ownMacAlias,
      enabled: config.ownMacEnabled,
      running: active(),
      max: config.ownMacMaxTasks,
      vm: value?.vm ?? null,
      freeMiB: value?.freeMiB,
      onPower: value?.ac,
      loggedIn: value?.session,
      account:
        code === "personal" || code === "target" ? undefined : value?.user,
      checkedAt: new Date(cached?.at ?? failedProbe?.at ?? now()).toISOString(),
      since: setup.since,
      tested: Boolean(
        setup.target &&
        setup.target.alias === config.ownMacAlias &&
        code !== "target",
      ),
      setupSteps: setup.step,
      testResult: setup.testResult,
      cleanup: clean,
    };
    return ownMacFactsSchema.parse(
      Object.fromEntries(
        Object.entries(result).filter(([, value]) => value !== undefined),
      ),
    );
  }
  async function readHost(
    config: Awaited<ReturnType<typeof readConfig>>,
    signal?: AbortSignal,
  ) {
    const local = await (options.local ?? localIdentity)();
    const result = await ssh(config.ownMacAlias, {
      command: ["/bin/bash", "-c", AVAILABILITY_SCRIPT],
      timeoutMs: 8000,
      signal,
    });
    if (result.exitCode) {
      const code = /permission denied|authentication failed/i.test(
        result.stderr,
      )
        ? "ssh_auth"
        : /could not resolve hostname/i.test(result.stderr)
          ? "ssh_alias"
          : "ssh_unreachable";
      throw fail(code, code);
    }
    cached = {
      at: now(),
      key: config.ownMacAlias,
      reading: parseReading(result.stdout),
      local,
    };
    await observeTarget(config.ownMacAlias, cached.reading);
    setup.since = null;
    failedProbe = null;
    return cached;
  }
  async function probe(
    force = false,
    signal?: AbortSignal,
  ): Promise<OwnMacFacts & { reading?: Reading }> {
    const config = await readConfig();
    await observeAlias(config.ownMacAlias);
    configuredIsolation = config.ownMacIsolation;
    if (
      setup.step === 5 &&
      config.ownMacEnabled &&
      setup.testedAlias === config.ownMacAlias
    ) {
      setup.step = 7;
      await saveSetup();
    }
    if ([...records.values()].some((value) => value.notice))
      return facts(config, "Logins left behind", "cleanup");
    if (
      config.ownMacAlias &&
      ((setup.target &&
        (config.ownMacAlias !== setup.target.alias ||
          setup.changedTarget !== undefined)) ||
        (!setup.target && config.ownMacEnabled))
    )
      return facts(config, "Test connection again", "target");
    if (
      (config.ownMacPaused || !config.ownMacEnabled) &&
      setup.refusal &&
      setup.refusedAlias === config.ownMacAlias
    )
      return facts(
        config,
        setup.refusal === "personal"
          ? "Can't use · your own login"
          : "Can't use · admin user",
        setup.refusal,
      );
    if (config.ownMacPaused) return facts(config, "Paused", "paused");
    if (
      !config.ownMacEnabled &&
      setup.refusal &&
      setup.refusedAlias === config.ownMacAlias
    )
      return facts(
        config,
        setup.refusal === "personal"
          ? "Can't use · your own login"
          : "Can't use · admin user",
        setup.refusal,
      );
    if (!config.ownMacEnabled)
      return facts(
        config,
        setup.testedAlias === config.ownMacAlias && config.ownMacAlias
          ? "Off"
          : "Not set up",
        setup.testedAlias === config.ownMacAlias && config.ownMacAlias
          ? "off"
          : "setup",
      );
    if (!config.ownMacAlias) return facts(config, "Not set up", "setup");
    if (
      !force &&
      failedProbe?.key === config.ownMacAlias &&
      now() - failedProbe.at < 45000
    )
      return facts(config, "Asleep or unreachable", "unreachable");
    try {
      if (
        force ||
        !cached ||
        cached.key !== config.ownMacAlias ||
        now() - cached.at >= 45000
      )
        await readHost(config, signal);
      if (
        !setup.target ||
        !sameTarget(setup.target, targetOf(config.ownMacAlias, cached!.reading))
      )
        return facts(config, "Test connection again", "target");
      const status = availability(
        cached!.reading,
        cached!.local,
        active(),
        config.ownMacMaxTasks,
      );
      const code: OwnMacFacts["code"] = status.includes("your own login")
        ? "personal"
        : status.includes("admin user")
          ? "admin"
          : status === "On battery"
            ? "battery"
            : status === "No logged-in session"
              ? "session"
              : status === "Not enough free memory"
                ? "memory"
                : status === "At task limit" || status.includes("CPU")
                  ? "busy"
                  : "available";
      return { ...facts(config, status, code), reading: cached!.reading };
    } catch {
      cached = null;
      failedProbe = { at: now(), key: config.ownMacAlias };
      if (!setup.since) {
        setup.since = new Date(now()).toISOString();
        await saveSetup();
      }
      return facts(config, "Asleep or unreachable", "unreachable");
    }
  }
  async function testConnection(): Promise<OwnMacFacts> {
    const config = await readConfig();
    await observeAlias(config.ownMacAlias);
    configuredIsolation = config.ownMacIsolation;
    if (config.ownMacAlias !== setup.testedAlias)
      setup.step = Math.min(setup.step, 4);
    let code: OwnMacFacts["code"] = "setup",
      status = "Not set up";
    try {
      if (!config.ownMacAlias) throw fail("missing alias", "ssh_alias");
      const value = await readHost(config),
        reason = refusal(value.reading, value.local);
      if (reason) {
        status = reason;
        code = reason.includes("your own login") ? "personal" : "admin";
        throw fail(reason, code);
      }
      delete setup.refusal;
      delete setup.refusedAlias;
      setup.step = 5;
      setup.testedAlias = config.ownMacAlias;
      setup.target = targetOf(config.ownMacAlias, value.reading);
      delete setup.changedTarget;
      const r = value.reading;
      setup.testResult = {
        ok: true,
        title: `Connected as ${r.user}`,
        detail: `${r.admin ? "Admin inside a VM" : "Standard user, not you"} · ${r.vm === true ? "macOS VM" : r.vm === false ? "Separate macOS user" : "Isolation not detected"} · ${Math.floor(r.freeMiB / 1024)} GB free · ${r.ac ? "on power" : "on battery"}${r.session ? "" : " · not logged in"}`,
        checkedAt: new Date(now()).toISOString(),
      };
      await saveSetup();
      const { reading: _reading, ...current } = await probe(false);
      return current;
    } catch (error) {
      const failure = (error as { code?: string }).code;
      if (failure === "personal" || failure === "admin") {
        setup.refusal = failure;
        setup.refusedAlias = config.ownMacAlias;
        setup.testedAlias = "";
      }
      const alias = config.ownMacAlias || "the SSH alias";
      const title =
        failure === "personal"
          ? `${alias} is your own login`
          : failure === "admin"
            ? `${cached?.reading.user ?? "The account"} is an admin on your Mac`
            : failure === "ssh_alias"
              ? `No alias called ${alias} in ~/.ssh/config`
              : failure === "ssh_auth"
                ? `Couldn't sign in as ${alias}`
                : `Your Mac didn't answer at ${alias}`;
      const detail =
        failure === "ssh_auth"
          ? "The alias was found and the Mac answered, but the agents account didn't accept your SSH key. Add your public key to that account's ~/.ssh/authorized_keys, then test again."
          : failure === "personal"
            ? "Create a macOS VM or a separate standard user, then point the alias at it."
            : failure === "admin"
              ? "Make this a standard user on the physical Mac, or use a VM."
              : "Check the SSH alias, Remote Login and network, then test again.";
      setup.testResult = {
        ok: false,
        title,
        detail,
        checkedAt: new Date(now()).toISOString(),
      };
      await saveSetup();
      return facts(config, status, code);
    }
  }
  async function checkCleanup(proxyRevoked?: (id: string) => Promise<boolean>) {
    for (const value of records.values())
      if (value.notice) {
        try {
          await verify(value);
          const checked = await run(value.id, {
            command: ["/bin/bash", "-c", CREDENTIAL_CHECK_SCRIPT],
            timeoutMs: 8000,
          });
          if (
            checked.exitCode ||
            (value.proxyRemovalFailed && !(await proxyRevoked?.(value.id)))
          )
            continue;
          value.active = false;
          delete value.notice;
          delete value.proxyRemovalFailed;
        } catch {
          /* A read failure keeps admission paused. */
        }
      }
    setup.lastCleanupCheck = new Date(now()).toISOString();
    await save();
    await saveSetup();
    const { reading: _reading, ...state } = await probe(true);
    return state;
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
    await observeAlias((await readConfig()).ownMacAlias);
    if (value.alias === setup.target?.alias)
      await observeTarget(value.alias, reading);
    const reason = refusal(reading, local);
    if (reason) throw fail(reason, "ownmac_refused");
    if (
      reading.hardware !== value.hardware ||
      reading.user !== value.user ||
      reading.uid !== value.uid ||
      (value.vm !== undefined && reading.vm !== value.vm)
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
      if (!record(id).active || record(id).notice)
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
      delete value.proxyRemovalFailed;
      await save();
      cached = null;
    } catch {
      value.notice =
        "Login cleanup could not be verified. Your Mac is automatically paused for new tasks until Check again passes. Running tasks are not moved or stopped.";
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
    ownMacStatus: async (force, signal) => {
      const { reading: _reading, ...state } = await probe(force, signal);
      return state;
    },
    ownMacTargetNotice: () =>
      setup.targetNotice
        ? {
            ...setup.targetNotice,
            deliveredTo: [...setup.targetNotice.deliveredTo],
          }
        : null,
    acknowledgeOwnMacTargetNotice: async (id, threadId) => {
      if (
        setup.targetNotice?.id === id &&
        !setup.targetNotice.deliveredTo.includes(threadId)
      ) {
        setup.targetNotice.deliveredTo.push(threadId);
        await saveSetup();
      }
    },
    ownMacCleanup: cleanupFacts,
    testOwnMacConnection: testConnection,
    ownMacSetupStep: async (step) => {
      setup.step = Math.max(setup.step, step);
      await saveSetup();
    },
    checkOwnMacCleanup: checkCleanup,
    runsOnMachine: (id) => {
      const vm = id ? records.get(id)?.vm : cached?.reading.vm;
      return vm === true
        ? "VM"
        : vm === false
          ? "separate user"
          : configuredIsolation === "user"
            ? "separate user"
            : "VM";
    },
    async presentation({ force, signal } = {}) {
      const { reading: _reading, ...state } = await probe(force, signal);
      return {
        steps: [],
        status: state.status,
        ownMac: {
          ...(await readConfig()),
          facts: state,
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
        if (!value.active || value.notice)
          throw fail(
            "This Your Mac task is closed. Start a new task to use a fresh credential home.",
            "task_closed",
          );
        await assertPinned(value.alias, await verify(value, signal));
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
        await assertPinned(state.alias!, state.reading);
        const need = SCALEWAY_TASK_SIZES.find(
          (size) => size.id === input.type,
        )!;
        const reserved = [...records.values()].filter(
          (value) =>
            reserves(value) && value.hardware === state.reading!.hardware,
        );
        if (
          state.reading.freeMiB -
            reserved.reduce((sum, value) => sum + value.memoryMiB, 0) <
            OWN_MAC_MIN_FREE_GB * 1024 ||
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
            alias: state.alias!,
            hardware: state.reading.hardware!,
            user: state.reading.user,
            uid: state.reading.uid,
            createdAt: new Date(now()).toISOString(),
            cpus: need.cpus,
            memoryMiB: need.memoryGb * 1024,
            active: true,
            vm: state.reading.vm,
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
      await assertPinned(record(id).alias, await verify(record(id), signal));
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
        // Remove reachable task logins even when core could not revoke the
        // proxy. Retain the failure until the read-only recheck proves both.
        await cleanup(id, signal).catch(() => undefined);
        value.proxyRemovalFailed = true;
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
      if (!value.active || value.notice)
        throw fail(
          "Start a new Your Mac task; closed sessions are not resumed.",
          "task_closed",
        );
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
      await assertPinned(record(id).alias, await verify(record(id), signal));
      if (await credentials.githubConfigured()) await ensureGithub(id, signal);
    },
    refreshGithubLogin: ensureGithub,
    machineHooks: () => ({
      bootstrapFailed: (id) => cleanup(id),
      beforeBootstrap: async (id, signal) => {
        await assertPinned(record(id).alias, await verify(record(id), signal));
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
