// Test doubles: an in-memory boat account and a SQLite store.
import { createFakePluginHost, type CreateFakePluginHostOptions } from "@get-bb/plugin-sdk/testing";
import type { PluginSettingValue } from "@get-bb/plugin-sdk";
import { PLUGIN_SETTINGS_KEY } from "../src/settings-store.ts";
import { isDeclaredKey, isPluginKey } from "../src/settings.ts";
import type { Quotas } from "../src/quota.ts";
import type { EvidenceSource } from "../src/evidence.ts";
import type { PreflightInput } from "../src/setup.ts";
import { DatabaseSync } from "node:sqlite";
import type Database from "better-sqlite3";
import type {
  BoatApi,
  ChatEvent,
  CheckoutMode,
  Conversation,
  Dispatch,
  Limits,
  PreparedRepo,
  PrepareOptions,
  Sandbox,
} from "../src/boat-api.ts";
import { BoatError } from "../src/boat.ts";
import { SIZE_SPECS, isMachineType, type SizedProject } from "../src/memory.ts";
import type { MachineTypeFacts } from "../src/setup.ts";
import type { ChatRunner, ChatSpawn, ChatState, MachineState } from "../src/chat.ts";
import { BoatService, type BoatSettings, type Notification, type ServiceHooks } from "../src/service.ts";
import { TaskStore } from "../src/store.ts";
import { DEFAULT_TIERS } from "../src/tiers.ts";

/**
 * bb's fake host, with settings from both places stored as if saved before
 * this load: bb's list as stored settings, the plugin's own in its kv.
 * A key that's neither is refused, and boatPath is required: a test must
 * never fall back to a real boat CLI. Sandboxes at once is 0 (the plan's
 * limit) unless a test sets it (undefined: the real default).
 */
export async function createTestHost(options: Omit<CreateFakePluginHostOptions, "settings"> & { settings: Record<string, unknown> }) {
  const values: Record<string, unknown> = { maxActiveSandboxes: 0, ...options.settings };
  if (typeof values.boatPath !== "string" || values.boatPath === "") throw new Error("test hosts need boatPath (the fake boat CLI)");
  const declared: Record<string, PluginSettingValue> = {};
  const own: Record<string, PluginSettingValue> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (isDeclaredKey(key)) declared[key] = value as PluginSettingValue;
    else if (isPluginKey(key)) own[key] = value as PluginSettingValue;
    else throw new Error(`test setting "${key}" doesn't exist`);
  }
  const host = createFakePluginHost({ ...options, settings: declared });
  await host.bb.storage.kv.set(PLUGIN_SETTINGS_KEY, own);
  return host;
}

export function memoryStore(): TaskStore {
  const db = new DatabaseSync(":memory:");
  for (const statement of TaskStore.migrations()) db.exec(statement);
  return new TaskStore(() => db as unknown as Database.Database);
}

/** What a fake sandbox answers the memory probe (src/memory.ts). */
export interface FakeProbe {
  now: number | null;
  bootId: string | null;
  bootTime: number | null;
  cpus: number | null;
  memTotalKb: number | null;
  memAvailableKb: number | null;
  swapTotalKb: number;
  swapFreeKb: number;
  oomKills: number | null;
  /** How the kernel log reads: journal, sudo, or none (not readable). */
  klog: "journal" | "sudo" | "none";
  /** The journal read timed out. */
  klogTimedOut: boolean;
  /** Kernel lines (oomLines builds kills). */
  kernel: string[];
  oomd: string[];
  /** The sampler's file: "max total samples start last [swap] [pid]". */
  peak: string | null;
}

export function defaultProbe(): FakeProbe {
  return {
    now: null,
    bootId: "0f3c1d2e-aaaa-bbbb-cccc-123456789abc",
    bootTime: 1_700_000_000,
    cpus: 4,
    memTotalKb: 8_131_944,
    memAvailableKb: 6_000_000,
    swapTotalKb: 2_097_148,
    swapFreeKb: 2_097_148,
    oomKills: 0,
    klog: "journal",
    klogTimedOut: false,
    kernel: [],
    oomd: [],
    peak: null,
  };
}

/**
 * The probe's output for these facts. With the script, only what it asks
 * for: the peak with a task, the kernel log with a window (lines from
 * --since @<epoch> on).
 */
export function probeOutput(facts: Partial<FakeProbe>, script?: string): string {
  const probe = { ...defaultProbe(), ...facts };
  const now = probe.now ?? Math.floor(Date.now() / 1000);
  const lines = [
    "BOAT_MEM_PROBE 1",
    `NOW ${now}`,
    `BOOT ${probe.bootId ?? "-"} ${probe.bootTime ?? ""}`,
    `CPUS ${probe.cpus ?? 0}`,
    `MEM ${probe.memTotalKb ?? 0} ${probe.memAvailableKb ?? 0} ${probe.swapTotalKb} ${probe.swapFreeKb}`,
    `OOM ${probe.oomKills ?? -1}`,
  ];
  if (script === undefined || script.includes("/tmp/boat-memory/")) lines.push(`PEAK ${probe.peak ?? "-"}`);
  const since = script === undefined ? null : (/--since @(\d+)/.exec(script)?.[1] ?? null);
  // Like the script: a way to read the log from before, while the boot is the same.
  const cached = script === undefined ? null : /boot_id 2>\/dev\/null\)" = "([0-9a-f-]+)" \]; then J=(journal|sudo);/.exec(script);
  if (since !== null && cached !== null && cached[1] === probe.bootId) {
    lines.push(`KLOG ${cached[2]}`);
    // Not readable any more: sudo fails out loud, the journal just says nothing.
    if (probe.klog === "none" && cached[2] === "sudo") lines.push("KLOG_FAIL");
    else if (probe.klog !== "none") for (const line of probe.kernel.filter((line) => Number(line.split(" ")[0]) >= Number(since))) lines.push(`K ${line}`);
  } else if (script === undefined || since !== null) {
    lines.push(`KLOG ${probe.klog === "none" ? "-" : probe.klog}`);
    if (probe.klog !== "none") {
      const after = (line: string) => since === null || Number(line.split(" ")[0]) >= Number(since);
      if (!probe.klogTimedOut) for (const line of probe.kernel.filter(after)) lines.push(`K ${line}`);
      if (probe.klogTimedOut) lines.push("KLOG_TIMEOUT");
      for (const line of probe.oomd.filter(after)) lines.push(`D ${line}`);
    }
  }
  lines.push("END");
  return `${lines.join("\n")}\n`;
}

const UNIT_PATHS = {
  bb: { memcg: "/user.slice/user-1000.slice/user@1000.service/app.slice/bb-host-daemon-acme.service", adj: 200 },
  agent: { memcg: "/system.slice/ascii-agent.service", adj: -900 },
  command: { memcg: "/user.slice/user-1000.slice/user@1000.service/app.slice/ascii-cmd-0000.scope", adj: 0 },
  other: { memcg: "/user.slice/user-1000.slice/session-1.scope", adj: 0 },
} as const;

/** A kill as the kernel logs it (two lines, host and cgroup names made up). */
export function oomLines(kill: { at: number; pid: number; comm: string; unit: keyof typeof UNIT_PATHS; rssKb: number }): string[] {
  const where = UNIT_PATHS[kill.unit];
  return [
    `${kill.at.toFixed(6)} box-node-test kernel: oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=user.slice,mems_allowed=0,global_oom,task_memcg=${where.memcg},task=${kill.comm},pid=${kill.pid},uid=1000`,
    `${(kill.at + 0.0001).toFixed(6)} box-node-test kernel: Out of memory: Killed process ${kill.pid} (${kill.comm}) total-vm:54751784kB, anon-rss:${kill.rssKb - 3072}kB, file-rss:3072kB, shmem-rss:0kB, UID:1000 pgtables:38764kB oom_score_adj:${where.adj}`,
  ];
}

interface FakeConversation {
  id: string;
  sandboxId: string;
  running: boolean;
  provider: string;
  prompts: { promptId: string; text: string; status: string; reply: string | null; error?: string }[];
}

let counter = 0;

/** A small in-memory imitation of the boat account the plugin talks to. */
export class FakeBoat {
  sandboxes = new Map<string, Sandbox>();
  convos = new Map<string, FakeConversation>();
  calls: string[] = [];
  limitsValue: Limits = {
    tier: "trial",
    summary: "2 boxes",
    activeSandboxes: 0,
    maxActiveSandboxes: 2,
    startsLeftToday: 75,
    startsLeftThisHour: 25,
    canStart: true,
    blockedReason: null,
    checkoutRequired: false,
    autoStopCapHours: 2,
  };
  prepareError: Error | null = null;
  promptError: Error | null = null;
  /** `boat limits` fails (boat can't be read). */
  limitsError: Error | null = null;
  /** boat refuses an auto-stop above this (trial_auto_stop_required), as the trial does. */
  autoStopCapSeconds: number | null = null;
  private checkAutoStop(ttl: number | null | undefined): void {
    if (this.autoStopCapSeconds === null || ttl === null || ttl === undefined || ttl <= this.autoStopCapSeconds) return;
    const hours = this.autoStopCapSeconds / 3600;
    throw new BoatError(`Free-trial auto-stop is ${hours} hours maximum. Set a TTL of ${hours} hours or less, or end the trial (first payment) to lift it.`, {
      code: "trial_auto_stop_required",
      status: 400,
    });
  }

  environmentNames = ["base", "storefront", "storefront-api", "docs", "web"];
  async environments(): Promise<string[]> {
    return this.environmentNames;
  }

  /** `boat limits` waits for this. */
  limitsGate: Promise<void> | null = null;
  async limits(): Promise<Limits> {
    if (this.limitsGate) await this.limitsGate;
    if (this.limitsError) throw this.limitsError;
    return { ...this.limitsValue, activeSandboxes: [...this.sandboxes.values()].filter((s) => s.state !== "stopped").length };
  }
  async list(options: { all?: boolean } = {}): Promise<Sandbox[]> {
    const all = [...this.sandboxes.values()];
    return options.all ? all : all.filter((sandbox) => sandbox.state !== "stopped");
  }
  async info(id: string): Promise<Sandbox> {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) throw new BoatError("not found (404)", { code: "not_found", status: 404 });
    return sandbox;
  }
  /** Every findInfo takes this long (a slow boat CLI). */
  findInfoDelayMs = 0;
  async findInfo(id: string): Promise<Sandbox | null> {
    if (this.findInfoDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.findInfoDelayMs));
    return this.sandboxes.get(id) ?? null;
  }
  created: {
    name: string;
    type: string;
    ttlSeconds?: number | null;
    environment?: string | null;
    from?: string | null;
    env?: Record<string, string>;
  }[] = [];
  async create(options: {
    name: string;
    type: string;
    ttlSeconds?: number | null;
    environment?: string | null;
    from?: string | null;
    env?: Record<string, string>;
  }): Promise<Sandbox> {
    this.calls.push(`create ${options.type} ttl=${options.ttlSeconds}`);
    this.checkAutoStop(options.ttlSeconds);
    counter += 1;
    const id = `bx_fake${counter}`;
    this.created.push(options);
    const sandbox: Sandbox = {
      id,
      name: options.name,
      state: "idle",
      health: "ok",
      url: null,
      desktopUrl: null,
      environment: "base",
      createdAt: new Date().toISOString(),
      archiveAfter: null,
      stoppedAt: null,
      setupStatus: null,
      error: null,
      machineType: isMachineType(options.type) ? options.type : null,
    };
    this.sandboxes.set(id, sandbox);
    this.probes.set(id, this.probeFor(options.type));
    return sandbox;
  }
  async delete(id: string): Promise<void> {
    this.calls.push(`delete ${id}`);
    this.sandboxes.delete(id);
  }
  async stop(id: string): Promise<void> {
    this.calls.push(`stop ${id}`);
    const sandbox = this.sandboxes.get(id);
    if (sandbox) sandbox.state = "stopped";
  }
  /** A resume waits for this. */
  resumeGate: Promise<void> | null = null;
  /** Refuse a resume (null: allowed); `type` is the size asked for (null: keep it). */
  resumeError: (type: string | null) => Error | null = () => null;
  private boots = 0;
  /** The call fails after boat did the resume (a CLI timeout while boat finishes it). */
  resumeLateError: (type: string | null) => Error | null = () => null;
  async resume(id: string, ttl: number | null, _signal?: AbortSignal, type?: string | null): Promise<void> {
    this.calls.push(`resume ${id} ttl=${ttl}${type ? ` type=${type}` : ""}`);
    this.checkAutoStop(ttl);
    if (this.resumeGate) await this.resumeGate;
    const refused = this.resumeError(type ?? null);
    if (refused) throw refused;
    const sandbox = this.sandboxes.get(id);
    if (sandbox) {
      sandbox.state = "idle";
      // A new boot (processes ended at the stop): a new boot id, the kill counter and kernel log from 0.
      this.boots += 1;
      const boot = { bootId: `0f3c1d2e-aaaa-bbbb-cccc-${String(this.boots).padStart(12, "0")}`, bootTime: Math.floor(Date.now() / 1000), oomKills: 0, kernel: [], oomd: [] };
      this.probes.set(id, { ...this.probe(id), ...boot });
      // Like boat: without --type the sandbox keeps its size.
      if (type && isMachineType(type)) {
        sandbox.machineType = type;
        this.probes.set(id, { ...this.probe(id), ...this.sizeFacts(type) });
      }
    }
    const late = this.resumeLateError(type ?? null);
    if (late) throw late;
  }
  prepared: { id: string; repo: string; checkout: CheckoutMode; options: PrepareOptions }[] = [];
  async prepareRepo(id: string, repo: string, checkout: CheckoutMode, options: PrepareOptions = {}): Promise<PreparedRepo> {
    this.prepared.push({ id, repo, checkout, options });
    this.calls.push(`prepare ${id} ${repo} ${checkout.kind}${"branch" in checkout ? ` ${checkout.branch}` : ""}`);
    if (this.prepareError) throw this.prepareError;
    return {
      path: `/home/user/work/${repo.split("/")[1]}`,
      branch: "branch" in checkout ? checkout.branch : "main",
      baseBranch: ("base" in checkout ? checkout.base : null) ?? "main",
      canPush: this.canPush[repo] ?? true,
      githubExpiresAt: this.ghExpires,
    };
  }
  /** Per repo: may the sandbox's GitHub login push (default yes). */
  canPush: Record<string, boolean> = {};
  /** The sandbox token's expiry the checkout reports. */
  ghExpires: string | null = "2099-01-01T00:00:00.000Z";
  /** What asking the sandbox's GitHub login says. */
  login: { valid: boolean | null; expiresAt: string | null } = { valid: true, expiresAt: "2099-01-01T00:00:00.000Z" };
  loginChecks: string[] = [];
  async githubLogin(id: string) {
    this.loginChecks.push(id);
    return this.login;
  }
  async defaultEnvironment() {
    return "base";
  }
  async environmentInfo(name: string) {
    return { name, secretNames: ["A_KEY"], secretFiles: [], repos: [], passGithub: true, passSecrets: true, passAgentsCredentials: true, proxyAiCredentials: false };
  }
  prompts: { provider: string; model: string | null; effort: string | null; text: string }[] = [];
  async prompt(options: {
    sandboxId: string;
    prompt: string;
    provider: string;
    model?: string | null;
    reasoningEffort?: string | null;
    conversationId?: string | null;
  }): Promise<Dispatch> {
    this.calls.push(`prompt ${options.sandboxId} ${options.provider} ${options.conversationId ?? "new"}`);
    this.prompts.push({ provider: options.provider, model: options.model ?? null, effort: options.reasoningEffort ?? null, text: options.prompt });
    if (this.promptError) throw this.promptError;
    const conversationId = options.conversationId ?? `c_${++counter}`;
    const promptId = `p_${++counter}`;
    const conversation = this.convos.get(conversationId) ?? {
      id: conversationId,
      sandboxId: options.sandboxId,
      running: false,
      provider: options.provider,
      prompts: [],
    };
    conversation.running = true;
    conversation.provider = options.provider;
    conversation.prompts.push({ promptId, text: options.prompt, status: "running", reply: null });
    this.convos.set(conversationId, conversation);
    const sandbox = this.sandboxes.get(options.sandboxId);
    if (sandbox) sandbox.state = "running";
    return { conversationId, promptId, model: options.model ?? null };
  }
  /** Finish the latest turn of a conversation. */
  finish(conversationId: string, reply: string, status: "finished" | "failed" | "interrupted" = "finished", error?: string) {
    const conversation = this.convos.get(conversationId)!;
    const turn = conversation.prompts.at(-1)!;
    turn.status = status;
    turn.reply = reply;
    turn.error = error;
    conversation.running = false;
    const sandbox = this.sandboxes.get(conversation.sandboxId);
    if (sandbox && ![...this.convos.values()].some((c) => c.sandboxId === sandbox.id && c.running)) sandbox.state = "idle";
  }
  async conversations(sandboxId: string): Promise<Conversation[]> {
    return [...this.convos.values()]
      .filter((c) => c.sandboxId === sandboxId)
      .map((c) => ({
        id: c.id,
        running: c.running,
        harness: c.provider,
        model: null,
        prompts: c.prompts.length,
        lastPromptAt: null,
        lastPromptPreview: null,
      }));
  }
  async events(_sandboxId: string, conversationId: string): Promise<ChatEvent[]> {
    const conversation = this.convos.get(conversationId);
    if (!conversation) return [];
    const events: ChatEvent[] = [];
    let ts = 1;
    for (const turn of conversation.prompts) {
      events.push({ type: "prompt", promptId: turn.promptId, conversationId, status: turn.status, content: null, error: turn.error ?? null, timestamp: ts++, tools: [] });
      events.push({ type: "response", promptId: turn.promptId, conversationId, status: null, content: "", error: null, timestamp: ts++, tools: ["Bash"] });
      if (turn.reply !== null) {
        events.push({ type: "response", promptId: turn.promptId, conversationId, status: null, content: turn.reply, error: null, timestamp: ts++, tools: [] });
      }
    }
    return events;
  }
  async steer(_sandboxId: string, conversationId: string, message: string): Promise<void> {
    this.calls.push(`steer ${conversationId} ${message}`);
  }
  async interrupt(_sandboxId: string, conversationId: string | null): Promise<void> {
    this.calls.push(`interrupt ${conversationId}`);
    if (conversationId) this.finish(conversationId, "", "interrupted");
  }
  /** Ports exposed with host. */
  hosts: { id: string; port: number; title: string }[] = [];
  async host(id: string, port: number, title: string): Promise<{ url: string; port: number; title: string; isProtected: boolean }> {
    this.hosts.push({ id, port, title });
    this.calls.push(`host ${id} ${port}`);
    return { url: `https://${id}-${port}.on.boat.dev?_token=tok_${id}`, port, title, isProtected: true };
  }
  /** Commands started in the background. */
  detached: { id: string; command: string }[] = [];
  async execDetached(id: string, command: string): Promise<{ pid: number | null }> {
    this.detached.push({ id, command });
    return { pid: 4242 };
  }
  extended: { id: string; args: string[] }[] = [];
  async extend(id: string, args: string[]): Promise<Record<string, unknown>> {
    const ttl = args.indexOf("--ttl");
    this.checkAutoStop(ttl === -1 ? null : Number(args[ttl + 1]));
    this.extended.push({ id, args });
    return { sandbox: this.sandboxes.get(id) ?? null };
  }
  savedSnapshots: { name: string; sizeBytes: number | null; createdAt: string | null; sourceSandboxId: string | null; status: string | null; type: string | null }[] = [];
  snapshotError: Error | null = null;
  async snapshot(id: string, name: string): Promise<{ name: string; sizeBytes: number | null }> {
    if (this.snapshotError) throw this.snapshotError;
    this.savedSnapshots.push({ name, sizeBytes: 1000, createdAt: new Date().toISOString(), sourceSandboxId: id, status: "ready", type: "default" });
    return { name, sizeBytes: 1000 };
  }
  async snapshots() {
    if (this.snapshotError) throw this.snapshotError;
    return { snapshots: this.savedSnapshots, included: 10, used: this.savedSnapshots.length };
  }
  /** What ship pushed; shipError makes it fail like a conflict. */
  ships: { id: string; targets: { path: string; baseBranch: string }[] }[] = [];
  shipError: Error | null = null;
  shipCommits = 2;
  async ship(id: string, targets: { path: string; baseBranch: string }[]) {
    this.ships.push({ id, targets });
    if (this.shipError) throw this.shipError;
    return { shipped: this.shipCommits === 0 ? [] : targets.slice(0, 1).map((target) => ({ ...target, sha: "abcdef1234567890", commits: this.shipCommits })) };
  }
  /** Scripts run with exec (sandbox id, script). */
  execs: { sandboxId: string; script: string }[] = [];
  /** Answers exec; the default succeeds silently. */
  execResult: (script: string) => { exitCode: number; stdout: string; stderr: string } = () => ({ exitCode: 0, stdout: "", stderr: "" });
  async exec(sandboxId: string, script: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.execs.push({ sandboxId, script });
    if (script.includes("BOAT_MEM_PROBE")) {
      if (this.probeHang) {
        // Like boat: a call runs until its signal aborts it.
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) return resolve();
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new BoatError("boat call aborted", { code: "aborted" });
      }
      if (this.probeGate) await this.probeGate;
      const probe = this.probes.get(sandboxId);
      if (probe === undefined || this.probeBroken) return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: probeOutput(probe, script), stderr: "" };
    }
    return this.execResult(script);
  }

  /** Each sandbox's memory facts (a new one: its size's). */
  probes = new Map<string, FakeProbe>();
  /** The probe never answers (until its signal aborts). */
  probeHang = false;
  /** The probe prints nothing usable. */
  probeBroken = false;
  /** The probe waits for this. */
  probeGate: Promise<void> | null = null;
  /** The probe of a sandbox (made if missing). */
  probe(sandboxId: string): FakeProbe {
    let probe = this.probes.get(sandboxId);
    if (probe === undefined) {
      probe = defaultProbe();
      this.probes.set(sandboxId, probe);
    }
    return probe;
  }
  private sizeFacts(type: string): Pick<FakeProbe, "cpus" | "memTotalKb" | "memAvailableKb"> {
    const spec = isMachineType(type) ? SIZE_SPECS[type] : SIZE_SPECS.default;
    // A VM's MemTotal is a little under boat's GB.
    const memTotalKb = Math.round(spec.memoryGb * 1_016_493);
    return { cpus: spec.cpus, memTotalKb, memAvailableKb: Math.round(memTotalKb * 0.75) };
  }
  private probeFor(type: string): FakeProbe {
    return { ...defaultProbe(), ...this.sizeFacts(type) };
  }
  /** Add a sandbox someone else made (the user's), with its size. */
  addSandbox(id: string, type: string | null, state = "idle"): Sandbox {
    const sandbox: Sandbox = {
      id,
      name: id,
      state,
      health: "ok",
      url: null,
      desktopUrl: null,
      environment: "base",
      createdAt: new Date().toISOString(),
      archiveAfter: null,
      stoppedAt: null,
      setupStatus: null,
      error: null,
      machineType: type !== null && isMachineType(type) ? type : null,
    };
    this.sandboxes.set(id, sandbox);
    this.probes.set(id, this.probeFor(type ?? "default"));
    return sandbox;
  }
}

/** bb's side of worker chats, in memory. */
export class FakeChat implements ChatRunner {
  machines: { taskId: string; sandboxId: string; hostId: string }[] = [];
  removed: string[] = [];
  spawns: (ChatSpawn & { threadId: string; environmentId: string })[] = [];
  sends: { threadId: string; text: string; steer: boolean; model?: string | null; effort?: string | null }[] = [];
  stopped: string[] = [];
  archived: string[] = [];
  states = new Map<string, ChatState>();
  outputs = new Map<string, string | null>();
  attachError: Error | null = null;
  private next = 0;

  async attachMachine(args: { taskId: string; sandboxId: string }) {
    if (this.attachError) throw this.attachError;
    const hostId = `host_${++this.next}`;
    this.machines.push({ taskId: args.taskId, sandboxId: args.sandboxId, hostId });
    return { hostId };
  }
  async removeMachine(hostId: string) {
    this.removed.push(hostId);
  }
  suspended: string[] = [];
  async suspendMachine(hostId: string) {
    this.suspended.push(hostId);
    if (this.linked === null) return;
    const sandboxId = this.sandboxOf(hostId);
    if (sandboxId !== null) await this.linked.boat.stop(sandboxId);
    this.machineStates.set(hostId, { phase: "suspended", connected: false, message: null });
  }
  composed: { taskId: string; request: unknown; parentThreadId: string | null; environmentId: string; threadId: string }[] = [];
  async spawnComposed(args: { taskId: string; request: unknown; parentThreadId: string | null; projectId: string | null; environmentId: string }) {
    const threadId = `thr_c${++this.next}`;
    this.composed.push({ taskId: args.taskId, request: args.request, parentThreadId: args.parentThreadId, environmentId: args.environmentId, threadId });
    return { threadId };
  }
  adopted: { threadId: string; parentThreadId: string }[] = [];
  async adopt(threadId: string, parentThreadId: string) {
    this.adopted.push({ threadId, parentThreadId });
  }
  resumed: string[] = [];
  async resumeMachine(hostId: string) {
    this.resumed.push(hostId);
    if (this.linked === null) return;
    const sandboxId = this.sandboxOf(hostId);
    if (sandboxId === null) return;
    this.machineStates.set(hostId, { phase: "resuming", connected: false, message: null });
    try {
      // Like bb's provider resume: the plugin's bringUp resumes the sandbox, then bb sets it up.
      await this.linked.bringUp(sandboxId);
      if (this.bootstrapFailures > 0) {
        this.bootstrapFailures -= 1;
        throw new Error("bootstrap failed: ssh connection reset");
      }
    } catch (error) {
      this.machineStates.set(hostId, { phase: "suspended", connected: false, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const connectsLater = this.neverReconnect || this.reconnectAfterPolls !== null;
    this.reconnectAfter = this.neverReconnect ? null : this.reconnectAfterPolls;
    this.machineStates.set(hostId, { phase: "active", connected: !connectsLater, message: null });
  }
  async findMachine(sandboxId: string) {
    return this.machines.find((machine) => machine.sandboxId === sandboxId && !this.removed.includes(machine.hostId))?.hostId ?? null;
  }
  /** bb's view of each machine (default: active and connected). */
  machineStates = new Map<string, MachineState>();
  machineStateCalls = 0;
  async machineState(hostId: string): Promise<MachineState | null> {
    this.machineStateCalls += 1;
    const state = this.machineStates.get(hostId) ?? { phase: "active", connected: true, message: null };
    // After a resume, bb reconnects only after a few looks.
    if (state.phase === "active" && !state.connected && this.reconnectAfter !== null) {
      this.reconnectAfter -= 1;
      if (this.reconnectAfter <= 0) {
        state.connected = true;
        this.reconnectAfter = null;
      }
    }
    return state;
  }
  /** Machines with a chat at work (any thread on them). */
  busyMachines = new Set<string>();
  async machineBusy(hostId: string) {
    return this.busyMachines.has(hostId);
  }
  /** Linked: suspend and resume act on the fake boat like bb's provider does. */
  private linked: { boat: FakeBoat; bringUp: (sandboxId: string) => Promise<unknown> } | null = null;
  /** After a resume, machineState reports connected only after this many calls (null: at once). */
  reconnectAfterPolls: number | null = null;
  private reconnectAfter: number | null = null;
  /** The machine never reconnects after a resume. */
  neverReconnect = false;
  /** bb's setup after the sandbox is up fails this many more times. */
  bootstrapFailures = 0;
  link(boat: FakeBoat, bringUp: (sandboxId: string) => Promise<unknown>) {
    this.linked = { boat, bringUp };
  }
  private sandboxOf(hostId: string): string | null {
    return this.machines.find((machine) => machine.hostId === hostId)?.sandboxId ?? null;
  }
  async spawn(args: ChatSpawn) {
    const threadId = `thr_w${++this.next}`;
    const environmentId = args.where.kind === "environment" ? args.where.environmentId : `env_${this.next}`;
    this.spawns.push({ ...args, threadId, environmentId });
    this.states.set(threadId, { status: "active", updatedAt: Date.now(), archived: false, environmentId, queued: 0, backgroundAgents: 0 });
    // Like bb: the workspace id isn't known yet when the spawn returns.
    return { threadId, environmentId: args.where.kind === "environment" ? environmentId : null };
  }
  async send(threadId: string, text: string, options: { steer: boolean; model?: string | null; effort?: string | null }) {
    this.sends.push({ threadId, text, ...options });
    const state = this.states.get(threadId);
    if (state) state.status = "active";
  }
  async state(threadId: string) {
    return this.states.get(threadId) ?? null;
  }
  async output(threadId: string) {
    return this.outputs.get(threadId) ?? null;
  }
  async stop(threadId: string) {
    this.stopped.push(threadId);
    this.finish(threadId, "(stopped)");
  }
  async archive(threadId: string) {
    this.archived.push(threadId);
    const state = this.states.get(threadId);
    if (state) state.archived = true;
  }
  /** The worker's turn ends with this answer. */
  finish(threadId: string, output: string, status: "idle" | "error" = "idle") {
    this.outputs.set(threadId, output);
    const state = this.states.get(threadId);
    if (state) {
      state.status = status;
      state.updatedAt = Date.now();
    }
  }
}

export function defaultSettings(overrides: Partial<BoatSettings> = {}): BoatSettings {
  return {
    boatPath: "",
    environment: "",
    machineType: "default",
    orchestratorMachineType: "small",
    implementProvider: "claude",
    implementModel: "",
    reviewProvider: "codex",
    reviewModel: "",
    reasoningEffort: "",
    sandboxTtlHours: 4,
    maxActiveSandboxes: 0,
    stopIdleAfterMinutes: 30,
    freeSlotsWhenFull: true,
    deleteSandboxOnClose: true,
    reviewSandbox: "auto",
    workerInstructions: "",
    autoFailover: true,
    modelTiers: DEFAULT_TIERS,
    workerMode: "boat",
    adhocWorkerMode: "chat",
    sidebarLayout: "sections",
    relay: { enabled: true, preferred: "claude", switchAtPercent: 90, switchBackBelowPercent: 50, quietMinutes: 10 },
    avoidExtraUsage: true,
    evidenceUploader: "",
    agents: "both",
    agentsSetting: overrides.agents ?? "both",
    notConnectedAgents: [],
    cloudOrchestratorFullAccess: true,
    extraProtectedBranches: [],
    ...overrides,
  };
}

export function makeService(
  options: {
    settings?: Partial<BoatSettings>;
    chat?: boolean;
    quotas?: Quotas;
    evidence?: EvidenceSource;
    /** The preview link check (default: every link answers). */
    checkPreview?: (link: string) => Promise<"up" | "down" | "unknown">;
    /** The setup checks before a sandbox (default: none). */
    preflight?: (input: PreflightInput) => Promise<void>;
    /** The plan's sandbox sizes (default: unknown, boat decides). */
    plan?: MachineTypeFacts[] | null;
    /** Stored projects with sizes. */
    projects?: SizedProject[];
    /** Task chat machines suspend and resume like bb's provider (through the service's bringUp). */
    linkedMachines?: boolean;
    /** The memory check's cap and the move's waits (ms; small defaults keep tests fast). */
    sizeTiming?: ServiceHooks["sizeTiming"];
  } = {},
) {
  const boat = new FakeBoat();
  const chat = options.chat ? new FakeChat() : undefined;
  const store = memoryStore();
  const notifications: Notification[] = [];
  let settings = defaultSettings({ ...(options.chat ? { workerMode: "chat" as const } : {}), ...options.settings });
  const told: { threadId: string; text: string }[] = [];
  const warnings: string[] = [];
  let plan: MachineTypeFacts[] | null = options.plan ?? null;
  let projects: SizedProject[] = options.projects ?? [];
  const service = new BoatService(boat as unknown as BoatApi, store, {
    settings: async () => settings,
    lifecycle: new AbortController().signal,
    changed: () => undefined,
    notify: async (notification) => {
      notifications.push(notification);
    },
    log: { info: () => undefined, warn: (message) => void warnings.push(message) },
    ...(chat ? { chat } : {}),
    projects: () => projects,
    sizePlan: async () => plan,
    sizePlanNow: () => plan,
    tell: async (threadId, text) => {
      told.push({ threadId, text });
    },
    sizeTiming: { checkMs: 200, pollMs: 1, stopMs: 200, startMs: 200, reconnectMs: 200, ...options.sizeTiming },
    ...(options.quotas ? { quotas: { read: async () => options.quotas! } } : {}),
    ...(options.evidence ? { evidence: options.evidence } : {}),
    ...(options.preflight ? { preflight: options.preflight } : {}),
    checkPreview: options.checkPreview ?? (async () => "up" as const),
  });
  if (chat && options.linkedMachines) chat.link(boat, (sandboxId) => service.bringUp(sandboxId));
  return {
    chat: chat!,
    boat,
    store,
    service,
    notifications,
    told,
    warnings,
    setSettings(next: Partial<BoatSettings>) {
      settings = { ...settings, ...next };
    },
    setPlan(next: MachineTypeFacts[] | null) {
      plan = next;
    },
    setProjects(next: SizedProject[]) {
      projects = next;
    },
  };
}
