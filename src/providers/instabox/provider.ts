import { macModels as readMacModels } from "./mac.ts";
import { createInstaboxSecrets } from "./secrets.ts";
import { GITHUB_LOGIN_HINT } from "./words.ts";
import type { MacLease, MacLeaseLedger } from "../../mac-leases.ts";
// Instabox (https://instabox.sh) as a sandbox provider: Linux and plan-gated Macs.
// Its members go through the instabox CLI (./cli.ts) like boat's go
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
import { InstaboxError, errorFromOutput, num, rec, redactKeys, safePositional, str, type JsonRecord, type InstaboxCli } from "./cli.ts";
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
  // Macs are advertised only after a successful live template/plan check.
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
    stillRestoring: (detail) => `Instabox can't stop it yet${detail}; Harbormaster tries again later`,
  },
};

/** GitHub in Instabox machines: an org Secret for github.com, then `gh auth setup-git` (src/sandbox-repos.ts). */
export const INSTABOX_REPO_WORDS: RepoWords = {
  cantSee: (repo) =>
    `The machine's GitHub login can't see ${repo}. Give the token in your Instabox GitHub Secret access to ${repo} (a fine-grained token's Repository access, on ${repo.split("/")[0] ?? repo}), or check the repo name. Then try again.`,
  denied: (repo, detail) => `GitHub refused the Instabox machine's access to ${repo}: ${detail}.`,
  noLogin: () => GITHUB_LOGIN_HINT,
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

/** Presence-only check used before repository preparation. */
export const GITHUB_SECRET_PROBE_SCRIPT = 'case "${GH_TOKEN:-}" in (ibsec_*) echo BOAT_GH_SECRET_present ;; (*) echo BOAT_GH_SECRET_missing ;; esac';

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
  secrets?: () => Promise<string>;
  enabled?: () => boolean;
  keyPresent?: () => boolean;
  now?: () => number;
  /** The private links this plugin got from Instabox (shown once), by machine and port. */
  links?: Map<string, string>;
  ledger?: MacLeaseLedger;
}

/** Preserve a matching legacy row, but scope new identities to the machine and
 * physical start: provider lease IDs need not be globally unique. */
export function instaboxLeaseInput(ledger: MacLeaseLedger, sandbox: SandboxInfo): Omit<MacLease, "endedAt" | "endReason" | "noticeAt" | "noticeText" | "kept" | "releaseAt"> | null {
  const m = sandbox.mac;
  if (!m || !m.leaseId || m.leaseId === "undefined" || m.leaseId === "null") return null;
  const legacyId = `instabox:${m.leaseId}`;
  const id = `instabox:${sandbox.id}:${m.leaseId}:${Date.parse(m.startedAt)}`;
  const existing = ledger.list().find(row => (row.id === legacyId || row.id === id) && row.provider === "instabox" && row.machineId === sandbox.id && Date.parse(row.startedAt) === Date.parse(m.startedAt));
  return { id: existing?.id ?? id, provider: "instabox", machineId: sandbox.id, size: m.model, startedAt: m.startedAt, paidUntil: m.chargeUntil, minimumCost: m.minimumCost, hourPrice: m.hourPrice, currency: "USD", cpus: m.cpus, memoryMiB: m.memoryMiB };
}

/** Instabox as a SandboxProvider: the CLI for its members, the REST API where the CLI can't. */
export function createInstaboxProvider(cli: InstaboxCli, rest: InstaboxRest, options: InstaboxProviderOptions = {}): SandboxProvider {
  const secrets = createInstaboxSecrets(cli, options.secrets ?? (async () => "all"), options.now);
  const caps = { ...INSTABOX_CAPABILITIES };
  const remember = (sandbox: SandboxInfo, authoritativeRevision?: number) => {
    const ledger = options.ledger;
    if (sandbox.mac && ledger) {
      if (authoritativeRevision !== undefined && authoritativeRevision !== ledger.revision()) return sandbox;
      const input = instaboxLeaseInput(ledger, sandbox);
      if (!input) return sandbox;
      const history = ledger.list().filter(row => row.machineId === sandbox.id && row.provider === "instabox");
      if (history.some(row => row.id !== input.id && Date.parse(row.startedAt) >= Date.parse(input.startedAt))) return sandbox;
      const held = history.filter(row => !row.endedAt);
      // Lists can be stale. Only a get dispatched after the last local
      // transition may supersede a physical lease or correct an inferred end.
      if (held.some(row => row.id !== input.id) && authoritativeRevision === undefined) return sandbox;
      const row = authoritativeRevision === undefined ? ledger.record(input) : ledger.observeCurrent(input, authoritativeRevision);
      if (!row || row.endedAt) {
        const terminal = ledger.list().find(lease => lease.id === input.id);
        if (authoritativeRevision !== undefined && terminal?.endedAt) ledger.observeDiscrepancy(input.id, `Instabox currently reports this physical Mac lease active, but the local lease ended with unverified current billing. Recorded minimum USD ${input.minimumCost.toFixed(2)}, paid until ${input.paidUntil}; provider scheduled release ${sandbox.scheduledReleaseAt ?? "not reported"}. Billing may continue. Inspect the existing task and machine before recovery; no new rental was started.`, options.now?.() ?? Date.now());
        return sandbox;
      }
      if (authoritativeRevision !== undefined) ledger.schedule(row.id, sandbox.scheduledReleaseAt ?? null);
    }
    return sandbox;
  };
  async function macModels(signal?: AbortSignal) {
    caps.systems = ["linux"];
    const models = await readMacModels(cli, signal);
    if (models.length) caps.systems = ["linux", "macos"];
    return models;
  }
  const links = options.links ?? new Map<string, string>();

  const infoReads = new Map<string, number>();
  async function info(sandboxId: string, signal?: AbortSignal): Promise<SandboxInfo & { native: string | null }> {
    const revision = options.ledger?.revision();
    const read = (infoReads.get(sandboxId) ?? 0) + 1;
    infoReads.set(sandboxId, read);
    let record;
    try { record = await cli.json(["get", sandboxId, "--json"], { signal, timeoutMs: 60_000 }); }
    catch (error) {
      if (isNotFound(error) && infoReads.get(sandboxId) === read && revision === options.ledger?.revision()) for (const lease of options.ledger?.list().filter(row => row.machineId === sandboxId && row.provider === "instabox") ?? []) {
        if (!lease.endedAt) options.ledger?.end(lease.id, "deleted");
        else options.ledger?.clearNotice(lease.id);
      }
      throw error;
    }
    const raw = rec(record.machine) ?? record;
    const sandbox = { ...toSandbox(raw), native: nativeState(raw) };
    if (sandbox.id !== sandboxId) throw new InstaboxError("Instabox returned a different machine identity", {code: "instabox_bad_output"});
    if (infoReads.get(sandboxId) === read && revision === options.ledger?.revision()) {
      if (sandbox.native === "deleted" || (sandbox.native === "stopped" && !sandbox.mac && sandbox.stoppedAt)) {
        for (const lease of options.ledger?.list().filter(row => row.machineId === sandboxId && row.provider === "instabox") ?? []) if (sandbox.native === "deleted" || Date.parse(sandbox.stoppedAt!) >= Date.parse(lease.startedAt)) {
          if (!lease.endedAt) options.ledger?.end(lease.id, sandbox.native === "deleted" ? "deleted" : "handed back", sandbox.native === "deleted" ? undefined : Date.parse(sandbox.stoppedAt!));
          else options.ledger?.clearNotice(lease.id);
        }
      } else remember(sandbox, revision);
    }
    return sandbox;
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
      throw new InstaboxError(redactKeys(result.stderr.trim()) || "instabox exec printed no result", { code: "instabox_bad_output", exitCode: result.exitCode });
    }
    return { exitCode: num(record.exitCode) ?? result.exitCode, stdout: redactKeys(str(record.stdout) ?? ""), stderr: redactKeys(str(record.stderr) ?? "") };
  }

  const provider: SandboxProvider = {
    id: INSTABOX_PROVIDER_ID,
    displayName: "Instabox",
    caps,
    macModels,
    async presentation({ force, signal } = {}) {
      if (force) secrets.invalidate();
      let cliFound = false;
      try { await cli.binary(); cliFound = true; } catch { /* Missing CLI is a setup step. */ }
      const key = options.keyPresent?.() ?? true;
      let raw: JsonRecord | null = null;
      let problem: string | null = null;
      if (cliFound && key) {
        try { raw = await cli.json(["usage", "--json"], { signal }); }
        catch (error) { problem = ["unauthenticated", "unauthorized", "invalid_key"].includes((error as {code?:string}).code ?? "") ? "Instabox rejected the key" : "Could not check Instabox; try again"; }
      }
      const cost = rec(raw?.cost);
      let hoursScope:"period"|"running-machines"|undefined;
      let linuxHours: number | null = null, active: number | null = null;
      if (raw) try {
        const listed = machineList((await cli.run(["ls","--json"],{signal})).value).map(toSandbox);
        const machines = listed.filter(m=>m.system!=="macos");
        active=machines.filter(m=>ACTIVE_STATES.has(m.state)).length;
        const knownMac=new Set([...(options.ledger?.list().filter(l=>l.provider==="instabox").map(l=>l.machineId) ?? []),...listed.filter(m=>m.system==="macos").map(m=>m.id)]);
        const usageHours=await rest.linuxHours(new Set(machines.map(m=>m.id)),knownMac,signal,new Set(machines.filter(m=>ACTIVE_STATES.has(m.state)).map(m=>m.id))).catch(()=>null);
        linuxHours=usageHours?.hours ?? null;hoursScope=usageHours?.scope;
      } catch { /* Billing metadata still stands when machine usage is unavailable. */ }
      let github = false;
      if (raw) {
        try { await secrets.check(signal, () => { throw new Error("Metadata unavailable"); }); github = true; } catch { /* Metadata only, never key values. */ }
      }
      const plan = str(rec(raw?.org)?.tier);
      const periodEnd = str(cost?.periodEnd);
      const resetsAt = periodEnd && Number.isFinite(Date.parse(periodEnd)) ? periodEnd : null;
      const credit = num(cost?.allowanceUSD);
      return {
        steps: [
          { id: "cli", label: "Instabox CLI installed", done: cliFound, possible: true, detail: cliFound ? "found on this host" : "Install the Instabox CLI on this host" },
          { id: "key", label: "API key stored", done: key && problem !== "Instabox rejected the key", possible: true, detail: problem === "Instabox rejected the key" ? problem : key ? "in bb secrets · Change" : "Add Instabox API key in bb secrets" },
          { id: "plan", label: "Plan detected", done: raw !== null, possible: true, detail: problem ?? [plan ? `${plan.toLowerCase().replace(/\b\w/g,letter=>letter.toUpperCase())} plan` : "Plan checked", credit === null ? null : `${new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2,minimumFractionDigits:credit%1===0 ? 0 : 2}).format(credit)} monthly credit`, resetsAt ? `resets ${new Intl.DateTimeFormat("en-US", {month:"short",day:"numeric",timeZone:"UTC"}).format(new Date(resetsAt))}` : null].filter(Boolean).join(" · ") },
          { id: "github", label: "GitHub Secret present", done: github, possible: true, detail: "GH_TOKEN · proxy Secret · github.com, api.github.com" },
          { id: "enabled", label: "Turned on", done: options.enabled?.() ?? true, possible: true, detail: "Linux and Mac tasks can then run here" },
        ],
        linuxUsage: { plan, used: num(cost?.costUSD), credit, remaining: num(cost?.creditRemainingUSD), resetsAt, hours: linuxHours, ...(hoursScope ? {hoursScope} : {}), active, error: problem, accountCredit:(num(cost?.macosUSD) ?? 0)>0 },
      };
    },
    classifiesCreateErrors: true,
    idPattern: MACHINE_ID_PATTERN,
    sizes: INSTABOX_SIZES,
    machine: INSTABOX_MACHINE,
    repoWords: INSTABOX_REPO_WORDS,
    retryGithubAccess: true,
    async assertTaskReady({ repos, signal, onWarning }) {
      if (repos.length) await secrets.check(signal, onWarning);
    },
    async beforeRepo(sandboxId, signal) {
      // Print presence only, never the placeholder. A fresh login shell after
      // push reads /etc/profile.d/zz-instabox-secrets.sh before repo prep.
      const result = await exec(sandboxId, GITHUB_SECRET_PROBE_SCRIPT, { signal });
      if (result.exitCode !== 0) throw new InstaboxError("Could not check the Instabox machine's GitHub Secret.", { code: "repo_access" });
      if (!result.stdout.includes("BOAT_GH_SECRET_present")) await secrets.apply(sandboxId, signal);
    },

    async capacity(signal) {
      return toCapacity(await cli.json(["usage", "--json"], { signal }));
    },
    // Instabox's plans have credit, not included hours.
    usagePlan: async () => null,
    // Only what Instabox states itself (`instabox usage`): this month's cost and the credit left. Never a list price of ours.
    async pricing(signal) {
      const linux = toPricing(await cli.json(["usage", "--json"], { signal }));
      const models = await macModels(signal).catch(() => []);
      return [linux, ...models.map(m => `${m.label} ${new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency }).format(m.minimumCost)} minimum (${m.minimumHours} h), ${new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency }).format(m.hourPrice)}/h after`)].filter(Boolean).join(" · ") || null;
    },
    async usage(sandboxId, window = {}, signal) {
      const used = await rest.machineUsage(sandboxId, window, signal);
      const seconds = used.runningSeconds;
      const dollars = await rest.computeCost(sandboxId,window,signal).catch(()=>null);
      return { seconds, hours: seconds === null ? null : seconds / 3600, dollars, since: used.from ?? window.since ?? null, until: used.to ?? window.until ?? null, running: null };
    },

    async list(listOptions = {}) {
      const result = await cli.run(["ls", "--json"], { signal: listOptions.signal });
      const sandboxes = machineList(result.value).filter((raw) => nativeState(raw) !== "deleted").map(raw => {
        const sandbox = toSandbox(raw);
        return rec(raw.metadata)?.["created-by"] === "bb-boat" ? remember(sandbox) : sandbox;
      });
      // An active list entry matching a terminal local row needs a fresh
      // machine read. It may be a stale list after a real hand-back, or an
      // inferred/legacy end hiding a still-billing physical allocation.
      const checked: SandboxInfo[] = [];
      for (const sandbox of sandboxes) {
        const input = options.ledger ? instaboxLeaseInput(options.ledger, sandbox) : null;
        const history = options.ledger?.list() ?? [];
        const ended = input && history.find(lease => lease.id === input.id)?.endedAt;
        const newer = input && history.some(lease => lease.provider === "instabox" && lease.machineId === sandbox.id && lease.id !== input.id && Date.parse(lease.startedAt) >= Date.parse(input.startedAt));
        if (ended || newer) {
          const current = await findInfo(sandbox.id, listOptions.signal);
          if (current) checked.push(current);
        } else checked.push(sandbox);
      }
      return listOptions.all ? checked : checked.filter((sandbox) => ACTIVE_STATES.has(sandbox.state));
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
      if (create.system === "macos") {
        const models = await macModels(create.signal);
        const preferred = create.macCostLimit?.model ?? (create.type === "large" ? "m4" : create.type === "xlarge" ? "m4pro" : "m2");
        let model = models.find(m => m.id === preferred);
        if (create.snapshot) {
          const result = await cli.run(["snapshot", "ls", "--json"], { signal: create.signal });
          const raw = Array.isArray(result.value) ? result.value : rec(result.value)?.snapshots;
          const snapshot = Array.isArray(raw) ? raw.map(rec).find(s => s?.name === create.snapshot || s?.id === create.snapshot) : null;
          const spec = rec(snapshot?.defaultSpec);
          if (rec(snapshot?.template)?.id !== "macos" || snapshot?.status !== "ready") throw new InstaboxError("Choose a ready macOS snapshot for a Mac task.", { code: "snapshot_not_found" });
          model = models.find(m => m.cpus === num(spec?.vcpus) && m.memoryMiB === num(spec?.memMiB));
        }
        if (!model) throw new InstaboxError("This account cannot create the requested Mac model. Check its plan and templates.", { code: "template_not_allowed" });
        const need = SPECS[create.type];
        if (model.cpus < need.vcpus || model.memoryMiB < need.memMiB) throw new InstaboxError("The Mac model is too small for this task.", { code: "spec_not_allowed" });
        if(create.macCostLimit && (create.macCostLimit.provider!=="instabox" || create.macCostLimit.model!==model.id || create.macCostLimit.currency!==model.currency || create.macCostLimit.minimumCost<model.minimumCost || create.macCostLimit.hourPrice<model.hourPrice || create.macCostLimit.minimumHours<model.minimumHours || Date.parse(create.macCostLimit.expiresAt)<Date.now()))throw new InstaboxError("The rental price or model changed. Review a new quote before renting.",{code:"mac_price_changed"});
        // A Mac takes the model's whole size, not Linux size flags.
        args.splice(args.indexOf("--meta") + 2);
        if (!create.snapshot) args.push("--template", "macos", "--model", model.id);
        args.push("--accept-24h-minimum", "--meta", `boat-mac-model=${model.id}`);
      }
      if (create.snapshot) args.push("--snapshot", create.snapshot);
      args.push("--secrets", await secrets.selected());
      if (create.system === "macos") args.push("--env", "BOAT_HOOKS_DIR=/var/tmp/boat-hooks");
      if (create.gitGuard) for (const [key, value] of Object.entries(create.system === "macos" ? { ...INSTABOX_GIT_ENV, GIT_CONFIG_VALUE_0: "/var/tmp/boat-hooks" } : INSTABOX_GIT_ENV)) args.push("--env", `${key}=${value}`);
      let record;
      try { record = await cli.json(args, { signal: create.signal, timeoutMs: 11 * 60_000 }); }
      catch (error) {
        if (create.system !== "macos") throw error;
        const code = (error as {code?:string}).code;
        if (["no_capacity","quota_exceeded","unauthenticated","key_missing","template_not_allowed","spec_not_allowed","instabox_not_found","instabox_spawn_failed"].includes(code ?? "")) throw error;
        throw new InstaboxError("Instabox may have allocated a Mac before create failed. Check its machine list before retrying; Harbormaster will not rent a fallback Mac.",{code:"creation_unknown"});
      }
      let allocated: SandboxInfo | undefined;
      try {
        let sandbox = toSandbox(rec(record.machine) ?? record);
        if (sandbox.id === "") throw new InstaboxError("instabox create did not report a machine id", { code: create.system === "macos" ? "creation_unknown" : "instabox_bad_output" });
        allocated = sandbox;
        // Some create envelopes omit billing details. Re-read this exact VM;
        // never retry create or accept another physical minimum.
        if (create.system === "macos" && !sandbox.mac) sandbox = await info(sandbox.id, create.signal);
        allocated = sandbox;
        if (create.system === "macos" && !sandbox.mac) throw new InstaboxError("Instabox allocated a Mac without current physical lease terms", {code: "creation_allocated"});
        remember(sandbox, options.ledger?.revision());
        if (create.system === "macos" && options.ledger) {
          const input = instaboxLeaseInput(options.ledger, sandbox);
          if (!input || !options.ledger.restoreCurrent(input, {revision: options.ledger.revision()})) throw new InstaboxError("Instabox allocated a Mac but its current lease could not be registered safely", {code: "creation_allocated"});
        }
        return sandbox;
      } catch (error) {
        if (create.system !== "macos" || (error as {code?:string}).code === "creation_unknown") throw error;
        const failure = new InstaboxError("Instabox allocated a Mac but local lease registration failed. Reconcile its machine list before retrying.",{code:"creation_allocated"});
        if (allocated?.id) Object.defineProperty(failure,"machineId",{value:allocated.id});
        if (allocated?.mac?.leaseId && !["undefined","null"].includes(allocated.mac.leaseId)) Object.defineProperty(failure,"leaseId",{value:allocated.mac.leaseId});
        throw failure;
      }
    },
    async delete(sandboxId, signal, deleteOptions) {
      await cli.run(["rm", sandboxId, "--yes", "--json", ...(options.ledger?.held(sandboxId).length ? ["--now"] : [])], { signal, timeoutMs: 120_000 });
      for (const lease of options.ledger?.held(sandboxId) ?? []) options.ledger?.end(lease.id, deleteOptions?.leaseEndReason ?? "deleted", deleteOptions?.leaseEndAt);
      for (const key of [...links.keys()]) if (key.startsWith(`${sandboxId}:`)) links.delete(key);
    },
    async scheduleLeaseRelease(sandboxId, _at, signal) {
      await cli.run(["rm", sandboxId, "--yes", "--json"], { signal, timeoutMs: 120_000 });
    },
    async cancelLeaseRelease(sandboxId, signal) {
      await cli.run(["rm", sandboxId, "--cancel", "--json"], { signal, timeoutMs: 120_000 });
    },
    async stop(sandboxId, signal) {
      // Waits until it's down; the disk is kept.
      await cli.run(["stop", sandboxId, "--json"], { signal, timeoutMs: 180_000 });
      return { status: "completed", stopId: null, forced: null, error: null };
    },
    stopStatus: async (_sandboxId, stopId) => ({ status: "completed", stopId, forced: null, error: null }),
    async fork(sandboxId, forkOptions = {}) {
      await secrets.selected();
      const record = await cli.json(["fork", sandboxId, "--json", "--meta", CREATED_BY], { signal: forkOptions.signal, timeoutMs: 5 * 60_000 });
      const machines = Array.isArray(record.machines) ? record.machines.map(rec) : [];
      const id = str(machines[0]?.id) ?? str(rec(record.machine)?.id) ?? str(record.id);
      if (id === null) throw new InstaboxError("instabox fork did not report a machine id", { code: "instabox_bad_output" });
      // fork has no --secrets flag; it copies the source selection. Replace
      // that selection and refresh the running copy before returning it.
      try { await secrets.apply(id, forkOptions.signal); }
      catch (error) {
        await provider.delete(id).catch(() => undefined);
        throw error;
      }
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
      if (current.system === "macos" || options.ledger?.held(sandboxId).length) {
        // Starting after the physical lease ended accepts another minimum.
        // Recheck the key's live plan/templates and limits before that consent.
        if (!current.mac || Date.parse(current.mac.chargeUntil) <= Date.now()) {
          if (!current.mac) for (const lease of options.ledger?.held(sandboxId) ?? []) options.ledger?.end(lease.id, "handed back", Date.parse(current.stoppedAt ?? lease.paidUntil));
          const models = await macModels(resumeOptions.signal);
          if (!models.length) throw new InstaboxError("This account cannot start a new Mac lease. Check its plan and templates.", { code: "template_not_allowed" });
          const capacity = await provider.capacity(resumeOptions.signal);
          const restartingOnlyMachine = capacity.maxActiveSandboxes !== null && capacity.maxActiveSandboxes > 0 && capacity.activeSandboxes === capacity.maxActiveSandboxes;
          if (!capacity.canStart && !restartingOnlyMachine) throw new InstaboxError(capacity.blockedReason ?? "Instabox cannot start a new Mac lease", { code: "quota_exceeded" });
        }
        await cli.run(["start", sandboxId, "--accept-24h-minimum", "--json"], { signal: resumeOptions.signal, timeoutMs: 300_000 });
        remember(await info(sandboxId, resumeOptions.signal));
        return;
      }
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
