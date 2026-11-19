// Instabox (https://instabox.sh) as a sandbox provider, Linux machines only
// for now. Its members go through the instabox CLI (./cli.ts) like boat's go
// through boat's: lifecycle, exec, ports, snapshots, usage and its headless
// agent runner (`instabox agent`, which only the CLI has). The REST API
// (./api.ts) is for what the CLI can't do: bb's setup over exec with
// `noHistory` and stdin, activity leases, and a machine's running time.
//
// Instabox in the plugin's terms:
// - Machines (m_…) are the sandboxes; a running one reads "idle", a paused
//   or stopped one "stopped". The plugin's stop is `instabox stop` (shut down,
//   disk kept, as its guide maps boat's stop); resume starts a stopped one
//   and resumes a paused one.
// - No auto-stop deadline: an idle machine pauses itself after 30 minutes.
//   bb's daemon connection doesn't count as activity, so a task chat's
//   machine gets an activity lease while a turn works (./keeper.ts).
// - One command runs at most 600 s; bb's setup goes in steps (a short
//   preparation, then bb's own command) within it.
// - Private ports carry their token as `?_token=ibp_…`, shown once: a
//   republish without one rotates it.
// - The plan's machine limit counts every machine, paused and stopped ones
//   too, so the plugin never "makes room" by stopping one.
// - No named environments: env is fixed at create, secrets are org Secrets.
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { SIZE_SPECS } from "../../memory.ts";
import { shellQuote } from "../shell.ts";
import {
  ACTIVE_STATES,
  MACHINE_TYPES,
  isNotFound,
  type ExecResult,
  type HostedPort,
  type MachineHookContext,
  type MachineHooks,
  type MachineSpec,
  type RepoWords,
  type SandboxCapabilities,
  type SandboxInfo,
  type SandboxProvider,
  type SizeOption,
} from "../types.ts";
import { EXEC_MAX_SECONDS, type InstaboxRest } from "./api.ts";
import { InstaboxError, errorFromOutput, num, rec, safePositional, str, type InstaboxCli } from "./cli.ts";
import {
  MACHINE_ID_PATTERN,
  SPECS,
  machineList,
  nativeState,
  toCapacity,
  toPricing,
  toChatEvents,
  toConversations,
  toProcessSample,
  toSandbox,
  toSnapshots,
  turnId,
} from "./parse.ts";

export const INSTABOX_PROVIDER_ID = "instabox";
/** bb's machine provider id for Instabox machines; bb keeps it on every machine and host. */
export const INSTABOX_MACHINE_PROVIDER_ID = "instabox-sandbox";
/** The machine user's home (exec, SSH and the agent runner start there). */
export const INSTABOX_HOME = "/data/home";
/** Metadata on every machine the plugin creates (`instabox ls --meta created-by=bb-boat`). */
export const CREATED_BY = "created-by=bb-boat";

/** git reads the plugin's hooks whatever the repo configures (fixed at create: Instabox env can't change later). */
export const INSTABOX_GIT_ENV: Record<string, string> = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: `${INSTABOX_HOME}/.boat-hooks`,
};

export const INSTABOX_CAPABILITIES: SandboxCapabilities = {
  os: "linux",
  // Instabox also leases Macs; this version starts Linux machines only.
  systems: ["linux"],
  shell: "bash",
  homeDir: INSTABOX_HOME,
  execMaxSeconds: EXEC_MAX_SECONDS,
  stopKeepsDisk: true,
  // Nothing expires on its own.
  retentionAfterStopSeconds: null,
  // No deadline: an idle pause instead (idlePause).
  autoStop: null,
  agentBusyState: false,
  previews: "token-link",
  bbEnrollment: true,
  concurrencyUnit: "kept-sandboxes",
  environments: false,
  idlePause: { minutes: 30, seesBbActivity: false },
};

/** Instabox Linux sizes, as the plugin names them (Pro: up to Large; Builder: XLarge). */
export const INSTABOX_SIZES: readonly SizeOption[] = MACHINE_TYPES.map((id) => ({
  id,
  label: SIZE_SPECS[id].label,
  cpus: SPECS[id].vcpus,
  memoryGb: SPECS[id].memMiB / 1024,
}));

/** "Instabox sandbox" in bb's machine and environment pickers. */
export const INSTABOX_MACHINE: MachineSpec = {
  id: INSTABOX_MACHINE_PROVIDER_ID,
  displayName: "Instabox sandbox",
  description: "Run bb chats in an Instabox cloud machine (Linux), with your Instabox account's agent logins.",
  icon: "ComputerCloud",
  environments: [
    {
      id: "instabox-sandbox",
      displayName: "Instabox sandbox",
      description: "A new Instabox machine with this project checked out",
      environmentProviderId: "project-checkout",
    },
    {
      id: "instabox-sandbox-personal",
      displayName: "Instabox sandbox",
      description: "A new Instabox machine with a personal workspace",
      environmentProviderId: "personal-workspace",
    },
  ],
  // Found again by this name after a lost create (src/providers/machine.ts), so it's already a valid Instabox name.
  machineName: (key) => machineName(`bb-machine-${key.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24)}`),
  machineLabel: (sandboxId, hostId) => `Instabox ${sandboxId} (${hostId.slice(-6)})`,
  words: {
    invalidInputs: "Instabox machine options are invalid. Choose a supported size, snapshot and reviewer.",
    usingPrepared: "Using the prepared Instabox machine",
    creating: "Creating the Instabox machine",
    resuming: "Resuming the Instabox machine",
    created: (sandboxId) => `Instabox machine ${sandboxId}`,
    gone: (sandboxId) => `Instabox machine ${sandboxId} no longer exists`,
    stopSaid: (reason) => `Instabox said: "${reason}"`,
    notStopped: (why) => `Instabox didn't stop it: ${why}`,
    stillRestoring: (detail) => `Instabox can't stop it yet${detail}; Boat tries again later`,
  },
};

/** GitHub in Instabox machines: an org Secret for github.com, then `gh auth setup-git` (src/sandbox-repos.ts). */
export const INSTABOX_REPO_WORDS: RepoWords = {
  cantSee: (repo) =>
    `The machine's GitHub login can't see ${repo}. Give the token in your Instabox GitHub Secret access to ${repo} (a fine-grained token's Repository access, on ${repo.split("/")[0] ?? repo}), or check the repo name. Then try again.`,
  denied: (repo, detail) => `GitHub refused the Instabox machine's access to ${repo}: ${detail}.`,
  noLogin: () =>
    "The Instabox machine has no GitHub login. Save a GitHub token as an Instabox Secret for github.com and api.github.com (`instabox secrets set GH_TOKEN --host github.com --host api.github.com`), then try again.",
  expired: () => "The Instabox machine's GitHub token has expired. Replace the GitHub Secret (`instabox secrets set GH_TOKEN …`), or start the work in a new machine.",
  error: (message, options) => new InstaboxError(message, options),
};

/** Instabox's rule for a machine name (OpenAPI CreateMachineRequest.name): 1-63 lowercase letters, digits or `-`, starting with a letter or digit. */
export const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * A name Instabox takes: lowercase, anything else (`_`, `.`, spaces) a
 * single `-`, no `-` at either end, at most 63 characters. "bb t_1a2b fix
 * the login" → "bb-t-1a2b-fix-the-login".
 */
export function machineName(text: string): string {
  const name = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return name === "" ? "bb-machine" : name;
}

/** The size flags for a size (none for Default: Instabox's default size is 4 vCPU, 8 GiB). */
export function sizeArgs(type: string | null | undefined): string[] {
  const spec = type && type !== "default" ? SPECS[type as keyof typeof SPECS] : undefined;
  return spec === undefined ? [] : ["--vcpus", String(spec.vcpus), "--mem-mib", String(spec.memMiB)];
}

/** The plugin's first prompt carries an id Instabox doesn't know (a UUID): that starts a new conversation. */
const PLUGIN_CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Before bb's setup, on its own (the "steps" within the 600 s limit): keep
 * the user's systemd manager up without a login session (bb's daemon is a
 * user unit), and give user units the Org Secrets proxy's CA, which only
 * login shells get. Best effort; it never fails bb's setup.
 */
export const BOOTSTRAP_PREP_SCRIPT = [
  'U=$(id -un)',
  'if command -v loginctl >/dev/null 2>&1; then sudo -n loginctl enable-linger "$U" >/dev/null 2>&1 && echo "BOAT_IBX linger on" || echo "BOAT_IBX linger failed"; else echo "BOAT_IBX linger none"; fi',
  'CA="${NODE_EXTRA_CA_CERTS:-${SSL_CERT_FILE:-}}"',
  'if [ -n "$CA" ] && [ -f "$CA" ]; then',
  '  mkdir -p "$HOME/.config/environment.d"',
  "  printf 'NODE_EXTRA_CA_CERTS=%s\\n' \"$CA\" > \"$HOME/.config/environment.d/60-boat-instabox-ca.conf\"",
  '  systemctl --user set-environment NODE_EXTRA_CA_CERTS="$CA" >/dev/null 2>&1 || true',
  '  echo "BOAT_IBX ca on"',
  'else echo "BOAT_IBX ca none"; fi',
  'echo "BOAT_IBX node $(node -v 2>/dev/null || echo none)"',
].join("\n");

/**
 * bb's setup over Instabox's exec API (src/providers/machine.ts): stdin in,
 * output streamed, `noHistory` (bb's enrollment secret and its server's
 * address never land in the machine's exec history). One command runs at
 * most 600 s: a setup that needs longer fails with what happened.
 */
export function restExecutor(rest: Pick<InstaboxRest, "execStream">, machineId: string): MachineExecutor {
  return {
    async exec({ command, stdin, timeoutMs, signal, onOutput }) {
      signal.throwIfAborted();
      const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
      // The API runs it with `bash -lc`, so the machine's node is on PATH.
      const result = await rest.execStream(machineId, { cmd: command.map(shellQuote).join(" "), stdin, timeoutSeconds: Math.min(seconds, EXEC_MAX_SECONDS) }, onOutput, signal);
      if (result.timedOut) {
        throw new Error(
          seconds > EXEC_MAX_SECONDS
            ? `bb's setup ran past Instabox's ${EXEC_MAX_SECONDS / 60}-minute limit for one command (it asked for ${Math.round(seconds / 60)} minutes)`
            : `bb's setup timed out after ${seconds}s`,
        );
      }
      return { exitCode: result.exitCode };
    },
  };
}

export interface InstaboxProviderOptions {
  /** The private links this plugin got from Instabox (shown once), by machine and port. */
  links?: Map<string, string>;
}

/** Instabox as a SandboxProvider: the CLI for its members, the REST API where the CLI can't. */
export function createInstaboxProvider(cli: InstaboxCli, rest: InstaboxRest, options: InstaboxProviderOptions = {}): SandboxProvider {
  const links = options.links ?? new Map<string, string>();

  async function info(sandboxId: string, signal?: AbortSignal): Promise<SandboxInfo & { native: string | null }> {
    const record = await cli.json(["get", sandboxId, "--json"], { signal, timeoutMs: 60_000 });
    return { ...toSandbox(rec(record.machine) ?? record), native: nativeState(rec(record.machine) ?? record) };
  }

  async function findInfo(sandboxId: string, signal?: AbortSignal): Promise<(SandboxInfo & { native: string | null }) | null> {
    try {
      const sandbox = await info(sandboxId, signal);
      return sandbox.native === "deleted" ? null : sandbox;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async function exec(sandboxId: string, script: string, execOptions: { timeoutMs?: number; signal?: AbortSignal; login?: boolean } = {}): Promise<ExecResult> {
    const remoteSeconds = Math.max(5, Math.min(EXEC_MAX_SECONDS, Math.round((execOptions.timeoutMs ?? 120_000) / 1000)));
    // One argument: Instabox runs it with `bash -lc`. login false: the exact argv `bash -c <script>`.
    const command = execOptions.login === false ? ["bash", "-c", script] : [script];
    const result = await cli.run(["exec", sandboxId, "--timeout", String(remoteSeconds), "--json", "--", ...command], {
      timeoutMs: remoteSeconds * 1000 + 30_000,
      signal: execOptions.signal,
      allowFailure: true,
    });
    const record = result.records.at(-1);
    if (record !== undefined && (rec(record.error) !== null || typeof record.error === "string")) throw errorFromOutput([record], result.stderr, result.exitCode);
    if (record === undefined || num(record.exitCode) === null) {
      throw new InstaboxError(result.stderr.trim() || "instabox exec printed no result", { code: "instabox_bad_output", exitCode: result.exitCode });
    }
    return { exitCode: num(record.exitCode) ?? result.exitCode, stdout: str(record.stdout) ?? "", stderr: str(record.stderr) ?? "" };
  }

  const provider: SandboxProvider = {
    id: INSTABOX_PROVIDER_ID,
    displayName: "Instabox",
    caps: INSTABOX_CAPABILITIES,
    idPattern: MACHINE_ID_PATTERN,
    sizes: INSTABOX_SIZES,
    machine: INSTABOX_MACHINE,
    repoWords: INSTABOX_REPO_WORDS,

    async capacity(signal) {
      return toCapacity(await cli.json(["usage", "--json"], { signal }));
    },
    // Instabox's plans have credit, not included hours.
    usagePlan: async () => null,
    // Only what Instabox states itself (`instabox usage`): this month's cost and the credit left. Never a list price of ours.
    async pricing(signal) {
      return toPricing(await cli.json(["usage", "--json"], { signal }));
    },
    async usage(sandboxId, window = {}, signal) {
      const used = await rest.machineUsage(sandboxId, window, signal);
      const seconds = used.runningSeconds;
      return { seconds, hours: seconds === null ? null : seconds / 3600, dollars: null, since: used.from ?? window.since ?? null, until: used.to ?? window.until ?? null, running: null };
    },

    async list(listOptions = {}) {
      const result = await cli.run(["ls", "--json"], { signal: listOptions.signal });
      const sandboxes = machineList(result.value).filter((raw) => nativeState(raw) !== "deleted").map(toSandbox);
      return listOptions.all ? sandboxes : sandboxes.filter((sandbox) => ACTIVE_STATES.has(sandbox.state));
    },
    async info(sandboxId, signal) {
      const { native: _native, ...sandbox } = await info(sandboxId, signal);
      return sandbox;
    },
    async findInfo(sandboxId, signal) {
      const found = await findInfo(sandboxId, signal);
      if (found === null) return null;
      const { native: _native, ...sandbox } = found;
      return sandbox;
    },
    async create(create) {
      // --fail-fast: no room means no machine (exit 75, no_capacity), never one left behind.
      const args = ["create", "--name", machineName(create.name), "--json", "--fail-fast", "--ready-timeout", "10m", "--meta", CREATED_BY, ...sizeArgs(create.type)];
      if (create.snapshot) args.push("--snapshot", create.snapshot);
      if (create.gitGuard) for (const [key, value] of Object.entries(INSTABOX_GIT_ENV)) args.push("--env", `${key}=${value}`);
      const record = await cli.json(args, { signal: create.signal, timeoutMs: 11 * 60_000 });
      const sandbox = toSandbox(rec(record.machine) ?? record);
      if (sandbox.id === "") throw new InstaboxError("instabox create did not report a machine id", { code: "instabox_bad_output" });
      return sandbox;
    },
    async delete(sandboxId, signal) {
      await cli.run(["rm", sandboxId, "--yes", "--json"], { signal, timeoutMs: 120_000 });
      for (const key of [...links.keys()]) if (key.startsWith(`${sandboxId}:`)) links.delete(key);
    },
    async stop(sandboxId, signal) {
      // Waits until it's down; the disk is kept.
      await cli.run(["stop", sandboxId, "--json"], { signal, timeoutMs: 180_000 });
      return { status: "completed", stopId: null, forced: null, error: null };
    },
    stopStatus: async (_sandboxId, stopId) => ({ status: "completed", stopId, forced: null, error: null }),
    async fork(sandboxId, forkOptions = {}) {
      const record = await cli.json(["fork", sandboxId, "--json", "--meta", CREATED_BY], { signal: forkOptions.signal, timeoutMs: 5 * 60_000 });
      const machines = Array.isArray(record.machines) ? record.machines.map(rec) : [];
      const id = str(machines[0]?.id) ?? str(rec(record.machine)?.id) ?? str(record.id);
      if (id === null) throw new InstaboxError("instabox fork did not report a machine id", { code: "instabox_bad_output" });
      return { id };
    },
    async lastSnapshotAt(sandboxId, signal) {
      const result = await cli.run(["snapshot", "ls", "--json"], { signal });
      const times = toSnapshots(result.value)
        .filter((snapshot) => snapshot.sourceSandboxId === sandboxId && (snapshot.status === null || snapshot.status === "ready") && snapshot.createdAt !== null)
        .map((snapshot) => snapshot.createdAt!)
        .sort();
      return times.at(-1) ?? null;
    },
    async resume(sandboxId, resumeOptions) {
      const current = await info(sandboxId, resumeOptions.signal);
      if (current.native === "running") return;
      if (current.native === "suspended") {
        await cli.run(["resume", sandboxId, "--json"], { signal: resumeOptions.signal, timeoutMs: 180_000 });
        return;
      }
      // A size move: resize while it's stopped, then start.
      const size = sizeArgs(resumeOptions.type ?? null);
      if (resumeOptions.type && resumeOptions.type !== current.machineType) {
        await cli.run(["resize", sandboxId, ...(size.length > 0 ? size : ["--vcpus", "4", "--mem-mib", "8192"]), "--json"], { signal: resumeOptions.signal, timeoutMs: 180_000 });
      }
      await cli.run(["start", sandboxId, "--json"], { signal: resumeOptions.signal, timeoutMs: 300_000 });
    },
    // No deadline to move: keep it awake that long instead (an activity lease, at most an hour).
    async extend(sandboxId, ttlSeconds, signal) {
      const seconds = Math.max(30, Math.min(3600, Math.round(ttlSeconds)));
      await rest.lease(sandboxId, "bb-boat-extend", seconds, signal);
      return { ttlSeconds: seconds };
    },

    exec,
    async execDetached(sandboxId, script, signal) {
      const record = await cli.json(["exec", "--background", sandboxId, "--json", "--", script], { signal, timeoutMs: 60_000 });
      return { pid: num(record.pid) };
    },
    async processes(sandboxId, signal) {
      const result = await cli.run(["ps", sandboxId, "--json"], { signal, timeoutMs: 30_000 });
      return toProcessSample(result.value);
    },

    async host(sandboxId, port, title, signal): Promise<HostedPort> {
      const key = `${sandboxId}:${port}`;
      const publish = async (rotate: boolean) =>
        cli.json(["port", "publish", sandboxId, String(port), "--private", ...(rotate ? ["--rotate-token"] : []), "--name", title.slice(0, 100) || `Port ${port}`, "--json"], { signal });
      let record = await publish(false);
      // The token is shown once: a port published before (by an earlier load) gets a new one.
      let link = str(record.tokenUrl) ?? links.get(key) ?? null;
      if (link === null) {
        record = await publish(true);
        link = str(record.tokenUrl);
      }
      if (link === null) throw new InstaboxError(`Instabox didn't return a private link for port ${port}`, { code: "instabox_bad_output" });
      links.set(key, link);
      return { url: link, port: num(record.port) ?? port, title: str(record.name) ?? title, isProtected: true };
    },
    async snapshot(sandboxId, name, signal) {
      const record = await cli.json(["snapshot", "save", sandboxId, "--name", name, "--json"], { signal, timeoutMs: 15 * 60_000 });
      const snapshot = rec(record.snapshot) ?? record;
      const size = (num(snapshot.dataSizeBytes) ?? 0) + (num(snapshot.rootSizeBytes) ?? 0);
      return { name: str(snapshot.name) ?? name, sizeBytes: size > 0 ? size : null };
    },
    async snapshots(signal) {
      const result = await cli.run(["snapshot", "ls", "--json"], { signal });
      return { snapshots: toSnapshots(result.value), included: null, used: null };
    },
    // No named environments: env is fixed at create, secrets are org Secrets.
    environments: async () => [],
    defaultEnvironment: async () => null,
    environmentInfo: async (name) => {
      throw new InstaboxError(`Instabox has no named environments ("${name}"): machines get the org's Secrets instead.`, { code: "not_found" });
    },
    aiProxy: async () => ({ enabled: null, dailyDollars: null, dollarsPer1000Requests: null }),

    async prompt(promptOptions) {
      const resume = promptOptions.conversationId && !PLUGIN_CONVERSATION.test(promptOptions.conversationId) ? promptOptions.conversationId : null;
      const args = ["agent", "prompt", promptOptions.sandboxId, "--provider", promptOptions.provider, "--json"];
      if (promptOptions.model) args.push("--model", promptOptions.model);
      args.push(...(resume === null ? ["--new"] : ["--resume", resume]));
      // The prompt on stdin (`-`): never in the process list, and no length limit of an argument.
      args.push("-");
      const record = await cli.json(args, { signal: promptOptions.signal, timeoutMs: 120_000, stdin: promptOptions.prompt });
      const conversationId = str(record.conversationId) ?? resume;
      if (conversationId === null) throw new InstaboxError("instabox agent prompt did not report a conversation", { code: "instabox_bad_output" });
      return { conversationId, promptId: turnId(record), model: str(record.model) ?? promptOptions.model ?? null };
    },
    async conversations(sandboxId, signal) {
      const result = await cli.run(["agent", "ls", sandboxId, "--json"], { signal });
      return toConversations(result.value);
    },
    async events(sandboxId, conversationId, signal) {
      const record = await cli.json(["agent", "events", sandboxId, "--conversation", conversationId, "--json"], { signal, timeoutMs: 120_000 });
      return toChatEvents(record, conversationId);
    },
    async steer(sandboxId, conversationId, message, signal) {
      await cli.run(["agent", "steer", sandboxId, "--conversation", conversationId, "--json", safePositional(message)], { signal });
    },
    async interrupt(sandboxId, conversationId, signal) {
      await cli.run(["agent", "interrupt", sandboxId, ...(conversationId === null ? [] : ["--conversation", conversationId]), "--json"], { signal });
    },

    executor: (sandboxId) => restExecutor(rest, sandboxId),
    machineHooks: (context) => instaboxMachineHooks(provider, context),
  };
  return provider;
}

/** Instabox's step before bb's setup (BOOTSTRAP_PREP_SCRIPT); nothing before a stop. */
export function instaboxMachineHooks(provider: Pick<SandboxProvider, "exec">, context: MachineHookContext): MachineHooks {
  return {
    async beforeBootstrap(sandboxId, signal) {
      try {
        const result = await provider.exec(sandboxId, BOOTSTRAP_PREP_SCRIPT, { timeoutMs: 60_000, signal });
        const said = [...result.stdout.matchAll(/BOAT_IBX (\w+) (.+)/g)].map((match) => `${match[1]} ${match[2]!.trim()}`);
        context.debug(`instabox ${sandboxId} before bb's setup: ${said.join(", ") || `exit ${result.exitCode}`}`);
        return said;
      } catch (error) {
        signal?.throwIfAborted();
        context.warn(`instabox ${sandboxId} before bb's setup: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },
  };
}
