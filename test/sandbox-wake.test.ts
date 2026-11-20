// `bb boat sandbox wake`: resolving the id, the dry run, the paced resume, each diagnosis's action
// (a stop and a start for an unreadable disk), bb's update, the chat's retry, the safety stops and
// the start limit. Fakes only: no boat CLI, no bb.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Limits, Sandbox, StopReport } from "../src/providers/boat/api.ts";
import { createBbUpdater, parseInspection } from "../src/bb-update.ts";
import type { MachineState } from "../src/chat.ts";
import type { QueuedFacts, ThreadFacts } from "../src/paid-resume.ts";
import { TaskError } from "../src/service.ts";
import type { Task } from "../src/store.ts";
import type { TurnEventRow } from "../src/steer-retry.ts";
import { WakePacer } from "../src/wake-pacer.ts";
import { classifyDiskCheck, parseDiskCheck } from "../src/wake-diagnosis.ts";
import { WAKE_MARKERS_KEY, WAKE_RETRY_REASON, createSandboxWaker, finishedNotice, routeWake, startCheck, wakeText, type SandboxWakeDeps, type WakeFindings, type WakeMarker, type WakeReport } from "../src/sandbox-wake.ts";
import { composeProtocol } from "../src/protocol.ts";
import { makeService } from "./fakes.ts";
import { createChatRunner } from "../src/chat.ts";
import { MACHINE_PROVIDER_ID } from "../src/providers/boat/provider.ts";

const T0 = Date.parse("2026-11-19T09:00:00Z");
const HYDRATOR = "[lazyfs] [ERROR] HYDRATOR FAILED attempt 32 (mount stays up, on-demand serving continues, retrying …): decode/feed: chunk 1 GET 0000.tar.zst: status code 503";
const HEALTHY_DISK = "BOAT_DISK ok .profile\nBOAT_DISK ok .bashrc\nBOAT_DISK_END\n";
const UNREADABLE_DISK = `BOAT_HYDRATOR ${HYDRATOR}\nBOAT_DISK fail .profile head: error reading '/home/user/.profile': Input/output error\nBOAT_DISK_END\n`;
const CLEAN_CHECKOUTS = "BOAT_GIT_AT ahead=0 dirty=0 stash=0 /home/user/work/web\nBOAT_GIT_SCAN_END\n";
const DIRTY_CHECKOUTS = "BOAT_GIT_AT ahead=2 dirty=1 stash=0 /home/user/work/web\nBOAT_GIT_SCAN_END\n";
const DATA_DIR = "/home/user/.bb-machines/acme-example-com";
const UNIT = "bb-host-daemon-acme-example-com-host_1.service";

/** bb's install as the look prints it (src/bb-update.ts inspectScript). */
function inspection(facts: { installed?: string; tgz?: string; bin?: string; active?: string } = {}): string {
  return [
    `BOAT_BB dir ${DATA_DIR}`,
    `BOAT_BB unit ${UNIT}`,
    "BOAT_BB node /home/user/.nvm/versions/node/v22.0.0/bin/node",
    `BOAT_BB installed ${facts.installed ?? "0.50.1"}`,
    `BOAT_BB bin ${facts.bin ?? "ok"}`,
    `BOAT_BB tgz ${facts.tgz ?? "none"}`,
    `BOAT_BB state ActiveState=${facts.active ?? "failed"} SubState=failed Result=exit-code NRestarts=3 StateChangeTimestampMonotonic=1000000`,
    "BOAT_BB uptime 600",
    "BOAT_BB end",
  ].join("\n");
}

const LIMITS: Limits = {
  tier: "standard",
  summary: null,
  activeSandboxes: 0,
  maxActiveSandboxes: 100,
  startsLeftToday: 180,
  startsLeftThisHour: 58,
  startsLeftThisMinute: 12,
  canStart: true,
  blockedReason: null,
  checkoutRequired: false,
  autoStopCapHours: null,
  extraStartsEnabled: false,
  nextStartDollars: 0,
};

function sandbox(id: string, state: string): Sandbox {
  return { id, name: id, state, health: null, url: null, desktopUrl: null, environment: null, createdAt: null, archiveAfter: null, stoppedAt: null, setupStatus: null, error: null };
}

function thread(id: string, facts: Partial<ThreadFacts> = {}): ThreadFacts {
  return { id, title: "Fix the login test", providerId: "claude-code", status: "idle", archived: false, projectId: null, parentThreadId: null, environmentId: "env_1", backgroundAgents: 0, ...facts };
}

/** A failed turn: its request, then the provider's error after it. */
function failedTurn(message = "Machine is paused", category = "host-offline"): TurnEventRow[] {
  return [
    { seq: 1, type: "client/turn/requested", data: { requestId: "req_1" }, createdAt: T0 - 60_000 },
    { seq: 2, type: "provider/error", data: { message, errorInfo: { category } }, createdAt: T0 - 50_000 },
  ] as TurnEventRow[];
}

interface WorldOptions {
  state?: string;
  host?: Partial<MachineState> | null;
  /** bb's machine record can't be read: it throws, or bb says nothing (null). */
  hostRead?: "throw" | "null";
  /** Looking up bb's machine on the sandbox fails (bb's machine list, or one machine's resource). */
  hostLookup?: "throw";
  /** The task's state (default failed). */
  taskStatus?: string;
  /** Another chat on the machine, of an older task that was cancelled (thr_old, task t_0ld00000). */
  oldChat?: boolean;
  /** Withdrawing a provider retry's row doesn't take (it stays in bb's queue). */
  cancelStuck?: boolean;
  limits?: Partial<Limits> | null;
  disk?: string[];
  /** The disk check once the sandbox was stopped and started (default: the disk list goes on). */
  diskAfterStop?: string;
  checkouts?: string;
  bb?: string;
  serverVersion?: string;
  stop?: (call: number, force: boolean) => StopReport | Error;
  stopStatus?: (call: number) => StopReport;
  execDown?: boolean;
  /** The test fork: its snapshot reads fine, can't be read, or boat can't make one. */
  fork?: "healthy" | "unreadable" | Error;
  /** Resumes wait for this (a long run). */
  gate?: Promise<void>;
  /** A resume fails (call number from 1). */
  bringUpFails?: (call: number) => Error | null;
  lifecycle?: AbortSignal;
  /** After the sandbox's stop, the plugin goes away (its lifetime ends). */
  abortAfterStop?: AbortController;
  timing?: SandboxWakeDeps["timing"];
}

/** One fake account: a sandbox, bb's machine on it, its chats, and a clock. */
function world(options: WorldOptions = {}) {
  let clock = T0;
  const now = () => clock;
  const sleep = async (ms: number) => {
    clock += ms;
  };
  const sandboxes = new Map<string, Sandbox>([["bx_demo1", sandbox("bx_demo1", options.state ?? "idle")]]);
  const calls: string[] = [];
  const scripts: string[] = [];
  const disks = [...(options.disk ?? [HEALTHY_DISK])];
  let stops = 0;
  let statuses = 0;
  let resumes = 0;
  const host: MachineState | null = options.host === null ? null : { phase: "suspended", connected: false, message: null, ...options.host };
  const machine = { state: host };
  /** bb's service started on a machine that isn't suspended: it connects. */
  const serviceUp = () => {
    if (machine.state !== null && machine.state.phase !== "suspended") machine.state = { ...machine.state, phase: "active", connected: true };
  };
  const boat = {
    async findInfo(id: string) {
      return sandboxes.get(id) ?? null;
    },
    async capacity(): Promise<Limits> {
      if (options.limits === null) throw new Error("boat didn't answer");
      return { ...LIMITS, ...options.limits };
    },
    async exec(id: string, script: string) {
      scripts.push(script);
      if (!["idle", "running", "ready"].includes(sandboxes.get(id)?.state ?? "")) throw new Error("sandbox is not running");
      if (script === "echo BOAT_EXEC_OK") {
        if (options.execDown) throw new Error("boat exec timed out");
        return { exitCode: 0, stdout: "BOAT_EXEC_OK\n", stderr: "" };
      }
      if (script.includes("BOAT_DISK_END")) {
        if (id === "bx_fork1") return { exitCode: 0, stdout: options.fork === "unreadable" ? UNREADABLE_DISK : HEALTHY_DISK, stderr: "" };
        if (options.diskAfterStop !== undefined && stops > 0) return { exitCode: 0, stdout: options.diskAfterStop, stderr: "" };
        return { exitCode: 0, stdout: disks.length > 1 ? disks.shift()! : disks[0]!, stderr: "" };
      }
      if (script.includes("BOAT_GIT_SCAN_END")) return { exitCode: 0, stdout: options.checkouts ?? CLEAN_CHECKOUTS, stderr: "" };
      if (script.includes("host-package-download/bb-app.tgz") && script.includes("say end")) return { exitCode: 0, stdout: options.bb ?? inspection(), stderr: "" };
      if (script.includes("BOAT_BBUP")) {
        calls.push("bb install");
        serviceUp();
        return { exitCode: 0, stdout: "BOAT_BBUP done 0.50.1 active\n", stderr: "" };
      }
      if (script.includes("BOAT_UNIT")) {
        calls.push("restart bb service");
        serviceUp();
        return { exitCode: 0, stdout: "BOAT_UNIT active\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async stop(id: string, _signal?: AbortSignal, stopOptions: { force?: boolean } = {}): Promise<StopReport> {
      stops++;
      const force = stopOptions.force === true;
      calls.push(force ? "stop --force" : "stop");
      const said = options.stop?.(stops, force) ?? { status: "completed", stopId: `stop_${stops}`, forced: force ? true : null };
      if (said instanceof Error) throw said;
      if (said.status === "completed" || (force && said.forced === true)) sandboxes.set(id, sandbox(id, "stopped"));
      if (sandboxes.get(id)?.state === "stopped") options.abortAfterStop?.abort();
      return said;
    },
    async stopStatus(id: string, stopId: string): Promise<StopReport> {
      statuses++;
      calls.push(`stop --status ${stopId}`);
      const said = options.stopStatus?.(statuses) ?? { status: "completed", stopId, forced: null };
      if (said.status === "completed") sandboxes.set(id, sandbox(id, "stopped"));
      return said;
    },
    async lastSnapshotAt() {
      return "2026-11-19T00:41:00.000Z";
    },
    async fork(id: string) {
      calls.push(`fork ${id}`);
      if (options.fork instanceof Error) throw options.fork;
      sandboxes.set("bx_fork1", sandbox("bx_fork1", "idle"));
      return { id: "bx_fork1" };
    },
    async delete(id: string) {
      calls.push(`delete ${id}`);
      sandboxes.delete(id);
    },
  };
  const pacer = new WakePacer({ now, sleep: async (ms) => sleep(ms) });
  const paid: boolean[] = [];
  const threads = new Map<string, ThreadFacts>([["thr_task", thread("thr_task", { status: "error" })]]);
  const queues = new Map<string, QueuedFacts[]>();
  const events = new Map<string, TurnEventRow[]>([["thr_task", failedTurn()]]);
  const task = { id: "t_1a2b3c4d", title: "Fix the login test", status: options.taskStatus ?? "failed", sandboxId: "bx_demo1", hostId: "host_1", threadId: "thr_task", runner: "chat", repoPath: "/home/user/work/web", delivery: "pr", unshipped: null, orchestratorThreadId: null } as unknown as Task;
  const store = new Map<string, unknown>();
  const kv = { get: async <T>(key: string) => store.get(key) as T | undefined, set: async (key: string, value: unknown) => void store.set(key, structuredClone(value)) };
  const updater = createBbUpdater({ boat, kv, serverVersion: async () => options.serverVersion ?? "0.50.1", now, sleep: async (ms) => sleep(ms) });
  const notices: { threadId: string; text: string }[] = [];
  const told: string[] = [];
  /** Whether each note went to closed tasks too. */
  const toldClosedToo: boolean[] = [];
  const oldTask = { id: "t_0ld00000", title: "Old attempt", status: "cancelled", sandboxId: "bx_demo1", hostId: "host_1", threadId: "thr_old", runner: "chat", repoPath: "/home/user/work/web", delivery: "pr", unshipped: null, orchestratorThreadId: null } as unknown as Task;
  if (options.oldChat) threads.set("thr_old", thread("thr_old", { title: "Old attempt", status: "idle" }));
  const makeWaker = (extra: Partial<SandboxWakeDeps> = {}) =>
    createSandboxWaker({
      boat,
      async bringUp(id, _signal, wake) {
        resumes++;
        calls.push("resume");
        paid.push(wake.paidStart);
        assert.ok(wake.permit, "a wake slot from the pacer");
        if (options.gate) await options.gate;
        const failure = options.bringUpFails?.(resumes) ?? null;
        if (failure !== null) throw failure;
        sandboxes.set(id, sandbox(id, "idle"));
      },
      pacer,
      guard: {
        forget: async (id) => void calls.push(`forget ${id}`),
        moving: async () => false,
      },
      quietLogins: async () => {
        calls.push("login scripts off");
        return "disabled";
      },
      updateBb: updater,
      serverVersion: async () => options.serverVersion ?? "0.50.1",
      tasks: {
        resolve: (id) => (task.id.startsWith(id) && id.length >= 4 ? task : null),
        liveSandboxTasks: (id) => (id === "bx_demo1" && !["done", "cancelled"].includes(task.status) ? [task] : []),
        sandboxTasks: (id) => (id === "bx_demo1" ? [...(options.oldChat ? [oldTask] : []), task] : []),
        forThread: async (id) => (id === "thr_task" ? task : id === "thr_old" && options.oldChat ? oldTask : null),
        hostForSandbox: () => null,
      },
      threads: {
        get: async (id) => threads.get(id) ?? null,
        stopEvents: async (id) => events.get(id) ?? [],
        queued: async (id) => queues.get(id!) ?? [],
        sendQueued: async (id, rowId) => void calls.push(`send queued ${id} ${rowId}`),
        cancelRetry: async (id, rowId) => {
          calls.push(`cancel retry ${id} ${rowId}`);
          if (options.cancelStuck) return "stuck";
          queues.set(id, (queues.get(id) ?? []).filter((row) => row.id !== rowId));
          return "removed";
        },
        retry: async (id, requestId, reason) => {
          assert.equal(reason, WAKE_RETRY_REASON);
          calls.push(`retry ${id} ${requestId}`);
        },
      },
      machines: {
        hostOf: async (environmentId) => (environmentId === "env_1" ? "host_1" : null),
        sandboxOf: async (hostId) => (hostId === "host_1" ? "bx_demo1" : null),
        hostFor: async (id) => {
          if (options.hostLookup === "throw") throw new Error("bb couldn't read machine host_1");
          return id === "bx_demo1" && (machine.state !== null || options.hostRead !== undefined) ? "host_1" : null;
        },
        host: async () => {
          if (options.hostRead === "throw") throw new Error("bb didn't answer");
          if (options.hostRead === "null") return null;
          return machine.state === null ? null : { ...machine.state };
        },
        resume: async (hostId) => {
          calls.push(`bb machine resume ${hostId}`);
          machine.state = { phase: "active", connected: true, message: null };
        },
        threadsOn: async () => [
          { id: "thr_task", status: threads.get("thr_task")?.status ?? "idle", title: "Fix the login test" },
          ...(options.oldChat ? [{ id: "thr_old", status: "idle", title: "Old attempt" }] : []),
        ],
      },
      kv,
      notify: async (threadId, text) => void notices.push({ threadId, text }),
      tell: (_sandboxId, text, tellOptions) => {
        told.push(text);
        toldClosedToo.push(tellOptions?.closedToo === true);
      },
      now,
      sleep: async (ms) => sleep(ms),
      ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
      ...(options.timing ? { timing: options.timing } : {}),
      ...extra,
    });
  const waker = makeWaker();
  return { waker, makeWaker, calls, scripts, sandboxes, pacer, paid, machine, threads, queues, events, store, notices, told, toldClosedToo, stopsMade: () => stops, now, advance: (ms: number) => void (clock += ms) };
}

function stepTexts(report: WakeReport, status?: string): string[] {
  return report.steps.filter((step) => status === undefined || step.status === status).map((step) => step.text);
}

// ---------------------------------------------------------------- resolving the id

test("each id type leads to the sandbox: a sandbox id, a task id, a chat's thread id", async () => {
  const { waker } = world();
  const bySandbox = await waker.resolve("bx_demo1");
  assert.equal(bySandbox.kind, "sandbox");
  assert.equal(bySandbox.sandboxId, "bx_demo1");
  assert.equal(bySandbox.hostId, "host_1");
  assert.deepEqual(bySandbox.threadIds, ["thr_task"], "the chats on its bb machine");
  assert.deepEqual(bySandbox.taskIds, ["t_1a2b3c4d"]);

  const byTask = await waker.resolve("t_1a2b");
  assert.equal(byTask.kind, "task");
  assert.equal(byTask.sandboxId, "bx_demo1");
  assert.equal(byTask.hostId, "host_1");
  assert.deepEqual(byTask.threadIds, ["thr_task"]);

  // A chat: its workspace, then that workspace's hostId, then the bb machine's sandbox.
  const byThread = await waker.resolve("thr_task");
  assert.equal(byThread.kind, "thread");
  assert.equal(byThread.sandboxId, "bx_demo1");
  assert.equal(byThread.hostId, "host_1");
  assert.deepEqual(byThread.threadIds, ["thr_task"]);
  assert.deepEqual(byThread.path, ["chat thr_task", "workspace env_1", "bb machine host_1", "sandbox bx_demo1"]);
});

test("an id that leads to no Boat sandbox is refused with what's wrong", async () => {
  const { waker, threads } = world();
  await assert.rejects(waker.resolve("thr_nope"), (error: unknown) => error instanceof TaskError && error.code === "wake_target_not_found");
  threads.set("thr_local", thread("thr_local", { environmentId: "env_local" }));
  await assert.rejects(waker.resolve("thr_local"), (error: unknown) => error instanceof TaskError && error.code === "not_on_sandbox" && /isn't on a bb machine/.test(error.message));
  threads.set("thr_free", thread("thr_free", { environmentId: null }));
  await assert.rejects(waker.resolve("thr_free"), /has no workspace/);
  await assert.rejects(waker.resolve("  "), (error: unknown) => error instanceof TaskError && error.code === "missing_target");
});

// ---------------------------------------------------------------- the dry run

test("a dry run on a stuck sandbox looks and prints the plan, and changes nothing", async () => {
  const { waker, calls, scripts, sandboxes, pacer } = world({ state: "idle", disk: [UNREADABLE_DISK] });
  const report = await waker.run({ target: "thr_task", dryRun: true });
  assert.equal(report.outcome, "planned");
  assert.equal(report.dryRun, true);
  assert.equal(report.route?.problem, "disk-unreadable");
  assert.equal(report.route?.action, "stop-and-start");
  // Nothing changed: no stop, no resume, no forget, no install, no service restart, no chat retry, no wake slot.
  assert.deepEqual(calls, []);
  assert.equal(sandboxes.get("bx_demo1")?.state, "idle");
  assert.deepEqual((await pacer.snapshot()).taken, []);
  // Only read-only looks ran.
  assert.ok(scripts.every((script) => !/systemctl --user (stop|restart|start)|chmod|mv -- |npm install|pkill/.test(script)), "read-only scripts only");
  const planned = stepTexts(report, "planned");
  assert.ok(planned.some((text) => /^Stop it with a plain boat stop \(a fresh snapshot, nothing lost\), follow that stop, and start it again/.test(text) && /check the snapshot with a test fork on another node first, and force the stop only if it reads fine there \(nothing there could be lost\)/.test(text)), planned.join("\n"));
  assert.ok(planned.some((text) => /^Start it again: an included boat start \(58 left this hour\), with a wake slot free now\.$/.test(text)));
  assert.ok(planned.some((text) => text === "Retry chat thr_task (\"Fix the login test\")'s failed turn."));
  const text = wakeText(report);
  assert.match(text, /^Dry run for sandbox bx_demo1: nothing was changed\./);
  assert.match(text, /Run it without --dry-run to do this: bb boat sandbox wake thr_task$/);
});

test("a dry run on a stopped sandbox plans the paced resume, then the rest", async () => {
  const { waker, calls, sandboxes } = world({ state: "stopped" });
  const report = await waker.run({ target: "bx_demo1", dryRun: true });
  assert.equal(report.outcome, "planned");
  assert.deepEqual(calls, []);
  assert.equal(sandboxes.get("bx_demo1")?.state, "stopped");
  assert.match(stepTexts(report, "planned")[0]!, /^Resume it: an included boat start \(58 left this hour\), with a wake slot free now\.$/);
  assert.ok(stepTexts(report, "planned").some((text) => /^Then bb's machine: resume it if it's suspended \(bb's own resume updates bb safely and starts it\)/.test(text)));
});

// ---------------------------------------------------------------- the paced resume

test("a stopped sandbox is resumed through the wake pacer, then bb's machine and the chat come back", async () => {
  const { waker, calls, pacer, paid, machine } = world({ state: "stopped" });
  const report = await waker.run({ target: "t_1a2b3c4d" });
  assert.equal(report.outcome, "awake", wakeText(report));
  assert.equal((await pacer.snapshot()).taken.length, 1, "one wake slot taken");
  assert.deepEqual(paid, [false], "an included start");
  // bb has the machine suspended: only `bb machine resume` (its own resume restarts bb there), no service restart first.
  assert.deepEqual(calls, ["forget bx_demo1", "resume", "login scripts off", "bb machine resume host_1", "retry thr_task req_1"]);
  assert.equal(machine.state?.connected, true);
  assert.match(wakeText(report), /It's back\.$/);
});

test("a wake slot further off than the pacer waits: Needs you, with when to try again", async () => {
  const { waker, pacer, calls, now } = world({ state: "stopped" });
  // Two wakes this minute already, and a failure's pause after them.
  await (await pacer.acquire()).succeeded();
  await (await pacer.acquire()).failed();
  for (let index = 0; index < 4; index++) await (await pacer.acquire({ maxWaitMs: 60 * 60_000 }).catch(() => null))?.failed();
  const report = await waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "needs-you");
  assert.ok(report.needsYou?.retryAt !== null && report.needsYou!.retryAt! > now());
  assert.deepEqual(report.needsYou?.commands, ["bb boat sandbox wake bx_demo1"]);
  assert.ok(!calls.includes("resume"));
});

// ---------------------------------------------------------------- diagnosis → action

function findings(disk: string | null, extra: Partial<WakeFindings> = {}): WakeFindings {
  const seen = disk === null ? null : parseDiskCheck(disk);
  return { execFailed: null, diagnosis: seen === null ? null : classifyDiskCheck(seen), disk: seen, bb: null, ...extra };
}

test("each diagnosis leads to its action; a stuck or unreadable disk to a stop and a start", () => {
  const route = (input: WakeFindings) => {
    const { problem, action } = routeWake(input);
    return `${problem} → ${action}`;
  };
  assert.equal(route(findings(UNREADABLE_DISK)), "disk-unreadable → stop-and-start");
  assert.equal(route(findings("BOAT_DISK fail .profile Input/output error\nBOAT_DISK_END\n")), "disk-unreadable → stop-and-start");
  // A read waiting on the disk is waited for first; still stuck after the wait: a stop and a start.
  const fuse = findings("BOAT_DSTATE 812 request_wait_answer fuse_simple_request node /usr/bin/node\nBOAT_DISK ok .profile\nBOAT_DISK_END\n");
  assert.equal(route(fuse), "disk-stuck → wait-for-disk");
  assert.equal(`${routeWake(fuse, { waited: true }).problem} → ${routeWake(fuse, { waited: true }).action}`, "disk-stuck → stop-and-start");
  const hydrating = findings("BOAT_HYDRATING [SNAPSHOT-INC] lazy volume hydration in progress (61%)\nBOAT_DISK ok .profile\nBOAT_DISK_END\n");
  assert.equal(routeWake(hydrating, { waited: true }).action, "none", "only still hydrating, its files reading fine: it goes on");
  assert.equal(route(findings("BOAT_HYDRATING [SNAPSHOT-INC] lazy volume hydration in progress (61%)\nBOAT_DISK ok .profile\nBOAT_DISK_END\n")), "disk-restoring → wait-for-disk");
  assert.equal(route({ execFailed: "boat exec timed out", diagnosis: null, disk: null, bb: null }), "exec-unreachable → stop-and-start");
  assert.equal(route(findings("BOAT_MOTD_HUNG 4242 95 run-parts --lsbsysinit /etc/update-motd.d\nBOAT_DISK ok .profile\nBOAT_DISK_END\n")), "ssh-login-hang → login-scripts");
  assert.equal(route(findings(`BOAT_ZOMBIE 777 Zl [npm install -g bb-app] <defunct>\nBOAT_BB_DIR ${DATA_DIR}\nBOAT_DISK ok .profile\nBOAT_DISK_END\n`)), "npm-zombie → stop-and-start");
  assert.equal(route(findings(`BOAT_BB_DIR ${DATA_DIR}\nBOAT_BB_MISSING ${DATA_DIR}\nBOAT_DISK ok .profile\nBOAT_DISK_END\n`)), "bb-broken → bb-update");
  const old = parseInspection(inspection({ installed: "0.49.0", tgz: "0.50.1" }));
  assert.equal(route(findings(HEALTHY_DISK, { bb: { seen: old, plan: { kind: "update", to: "0.50.1", from: "0.49.0", broken: false }, target: "0.50.1" } })), "bb-old → bb-update");
  assert.equal(route(findings(HEALTHY_DISK, { bb: { seen: old, plan: { kind: "none", why: "no download" }, target: "0.50.1" } })), "bb-old → bb-update");
  assert.equal(route(findings(HEALTHY_DISK, { bb: { seen: old, plan: { kind: "hung", detail: "npm install left a zombie: pid 777" }, target: "0.50.1" } })), "npm-zombie → stop-and-start");
  assert.equal(route(findings(HEALTHY_DISK)), "none → none");
});


test("an unreadable disk: a plain stop (its status followed, never a second stop), a paced start, and it's back", async () => {
  const { waker, calls, pacer, stopsMade } = world({
    state: "idle",
    disk: [UNREADABLE_DISK, HEALTHY_DISK],
    // boat answers "pending" while it takes the final snapshot; its status says when it's done.
    stop: () => ({ status: "pending", stopId: "stop_9", forced: null }),
    stopStatus: (call) => (call < 3 ? { status: "pending", stopId: "stop_9", forced: null } : { status: "completed", stopId: "stop_9", forced: null }),
  });
  const report = await waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "awake", wakeText(report));
  assert.equal(stopsMade(), 1, "one boat stop; its status read with --status");
  assert.deepEqual(calls.slice(0, 6), ["forget bx_demo1", "stop", "stop --status stop_9", "stop --status stop_9", "stop --status stop_9", "resume"]);
  assert.ok(!calls.includes("stop --force"));
  assert.equal((await pacer.snapshot()).taken.length, 1);
  assert.ok(stepTexts(report, "done").includes("Stopped it with a fresh snapshot."));
  const texts = stepTexts(report);
  const said = texts.findIndex((text) => /^boat\.dev can't restore this sandbox's disk \(HYDRATOR FAILED attempt 32 .*status code 503\)\.$/.test(text));
  assert.ok(said >= 0, texts.join("\n"));
  assert.equal(texts[said + 1], "Stopping it to start it again: boat.dev's fix for a stuck sandbox.");
  assert.ok(texts.includes("Started it again, with an included boat start (58 left this hour)."));
});

test("a sandbox still up after a silent stop isn't taken as refused before the stop's status is read", async () => {
  const { waker, calls } = world({
    state: "idle",
    disk: [UNREADABLE_DISK, HEALTHY_DISK],
    stop: () => ({ status: null, stopId: "stop_3", forced: null }),
    stopStatus: () => ({ status: "completed", stopId: "stop_3", forced: null }),
  });
  const report = await waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "awake", wakeText(report));
  assert.ok(calls.includes("stop --status stop_3"));
  assert.ok(!calls.includes("stop --force"), "idle isn't a refusal");
});

test("boat refuses the plain stop and nothing could be lost: forced, started again", async () => {
  const { waker, calls } = world({
    state: "idle",
    disk: [UNREADABLE_DISK, HEALTHY_DISK],
    host: { phase: "active", connected: true },
    stop: (_call, force) => (force ? { status: "completed", stopId: "stop_f", forced: true } : { status: "failing", stopId: "stop_1", forced: null, error: "Final snapshot failed; stop aborted to protect unsaved data" }),
  });
  // Nothing mid-turn there: the chat is idle.
  const report = await waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "awake", wakeText(report));
  assert.deepEqual(calls.filter((call) => /^(stop|fork|delete)/.test(call)), ["stop", "fork bx_demo1", "delete bx_fork1", "stop --force"], "a test fork of its snapshot before the force");
  assert.ok(stepTexts(report, "done").some((text) => /Stopped it with --force/.test(text)));
});

test("safety stop: boat refuses the plain stop and a checkout has unpushed work, so it's Needs you with the facts and the commands", async () => {
  const { waker, calls, sandboxes } = world({
    state: "idle",
    disk: [UNREADABLE_DISK],
    checkouts: DIRTY_CHECKOUTS,
    stop: () => ({ status: "failing", stopId: "stop_1", forced: null, error: "Final snapshot failed; stop aborted to protect unsaved data" }),
  });
  const report = await waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "needs-you");
  assert.ok(!calls.includes("stop --force"), "never forced with work at risk");
  assert.equal(sandboxes.get("bx_demo1")?.state, "idle");
  assert.match(report.needsYou!.reason, /^boat refused to stop sandbox bx_demo1 with a fresh snapshot \(boat said: "Final snapshot failed; stop aborted to protect unsaved data"\)\. Forcing the stop keeps only 00:41 UTC \(its last completed snapshot\)/);
  assert.match(report.needsYou!.reason, /task t_1a2b3c4d has 2 unpushed commits; task t_1a2b3c4d has changes that aren't committed/);
  assert.deepEqual(report.needsYou!.commands, ["boat stop bx_demo1 --force", "bb boat sandbox wake bx_demo1"]);
  const text = wakeText(report);
  assert.match(text, /\nNeeds you: boat refused to stop sandbox bx_demo1/);
  assert.match(text, /\n {4}\$ boat stop bx_demo1 --force\n {4}\$ bb boat sandbox wake bx_demo1$/);
  assert.equal(report.steps.filter((step) => step.status === "needs-you").length, 1);
});

test("safety stop: a stop would interrupt a turn running there, so it's left to the user", async () => {
  // A chat mid-turn on a connected machine.
  let w = world({ state: "idle", disk: [UNREADABLE_DISK], host: { phase: "active", connected: true } });
  w.threads.set("thr_task", thread("thr_task", { status: "active" }));
  let report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "needs-you");
  assert.equal(w.stopsMade(), 0);
  assert.match(report.needsYou!.reason, /, but the chat "Fix the login test" is mid-turn, and a stop would interrupt it\./);

  // The same chat on a paused machine: nothing runs there, so it's stopped and started again.
  w = world({ state: "idle", disk: [UNREADABLE_DISK, HEALTHY_DISK] });
  w.threads.set("thr_task", thread("thr_task", { status: "active" }));
  report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(w.stopsMade(), 1, wakeText(report));
});

test("a stop still pending after the wait: its status command, never a second stop", async () => {
  const { waker, stopsMade } = world({ state: "idle", disk: [UNREADABLE_DISK], stop: () => ({ status: "pending", stopId: "stop_7", forced: null }), stopStatus: () => ({ status: "pending", stopId: "stop_7", forced: null }) });
  const report = await waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "needs-you");
  assert.equal(stopsMade(), 1);
  assert.deepEqual(report.needsYou!.commands, ["boat stop bx_demo1 --status stop_7", "bb boat sandbox wake bx_demo1"]);
});

test("still unreadable after a stop and a start: Needs you, no second restart", async () => {
  const { waker, stopsMade } = world({ state: "idle", disk: [UNREADABLE_DISK] });
  const report = await waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "needs-you");
  assert.equal(stopsMade(), 1);
  assert.match(report.needsYou!.reason, /still after a stop and a start\. Leave it until boat\.dev has recovered/);
});

test("an exec that never answers is a stuck sandbox: stopped and started again", async () => {
  const w = world({ state: "idle", execDown: true });
  const report = await w.waker.run({ target: "bx_demo1" });
  // The fake's exec stays down after the restart too: Needs you after one restart.
  assert.equal(report.outcome, "needs-you");
  assert.equal(w.stopsMade(), 1);
  assert.match(report.needsYou!.reason, /^boat's exec doesn't answer \(boat exec timed out\), still after a stop and a start/);
});

test("nothing kills processes by pattern", async () => {
  const { waker, scripts } = world({ state: "stopped", bb: inspection({ installed: "0.49.0", tgz: "0.50.1" }) });
  await waker.run({ target: "bx_demo1" });
  assert.ok(scripts.length > 0);
  for (const script of scripts) assert.doesNotMatch(script, /\bpkill\b|\bkillall\b/);
});

// ---------------------------------------------------------------- bb's update

test("bb older than the server, with the server's download there: the safe update on a disconnected machine, then it connects", async () => {
  const { waker, calls } = world({ state: "stopped", host: { phase: "active", connected: false }, bb: inspection({ installed: "0.49.0", tgz: "0.50.1" }) });
  const report = await waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "awake", wakeText(report));
  assert.ok(stepTexts(report, "done").includes("Updated bb on the sandbox from 0.49.0 to 0.50.1."));
  // The install started bb's service again: no second restart, and bb didn't have it suspended: no machine resume.
  assert.deepEqual(calls.filter((call) => /bb install|restart bb service|bb machine resume/.test(call)), ["bb install"]);
  assert.ok(stepTexts(report, "done").includes("bb's machine host_1 is connected."), wakeText(report));
});

test("on a machine bb has suspended, bb's own resume updates bb: only `bb machine resume`, nothing restarted before it", async () => {
  const { waker, calls } = world({ state: "stopped", bb: inspection({ installed: "0.49.0", tgz: "0.50.1" }) });
  const report = await waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "awake", wakeText(report));
  assert.deepEqual(calls.filter((call) => /bb install|restart bb service|bb machine resume/.test(call)), ["bb machine resume host_1"]);
  assert.ok(stepTexts(report).includes("bb 0.49.0 on this sandbox is older than the server's 0.50.1: bb's machine resume updates it safely itself, before it starts bb."), wakeText(report));
});

test("bb older than the server without a download: the same safe update, from the npm registry", async () => {
  // Suspended: bb's machine resume runs it; nothing to do by hand.
  let w = world({ state: "stopped", bb: inspection({ installed: "0.49.0", tgz: "none" }) });
  let report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "awake", wakeText(report));
  assert.ok(!w.calls.includes("bb install"));
  assert.ok(stepTexts(report).includes("bb 0.49.0 on this sandbox is older than the server's 0.50.1: bb's machine resume updates it safely itself, before it starts bb."), wakeText(report));
  assert.ok(!stepTexts(report).some((text) => /No download of bb|by hand/.test(text)), wakeText(report));
  // Disconnected, not suspended: Boat installs bb-app 0.50.1 from the npm registry itself.
  const dry = world({ state: "idle", host: { phase: "active", connected: false }, bb: inspection({ installed: "0.49.0", tgz: "none" }) });
  report = await dry.waker.run({ target: "bx_demo1", dryRun: true });
  assert.ok(stepTexts(report).includes("Update bb on the sandbox from 0.49.0 to 0.50.1: a fresh install from the npm registry (no download of it there), swapped in, the old one kept."), wakeText(report));
  w = world({ state: "stopped", host: { phase: "active", connected: false }, bb: inspection({ installed: "0.49.0", tgz: "none" }) });
  report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "awake", wakeText(report));
  assert.ok(stepTexts(report, "done").includes("Updated bb on the sandbox from 0.49.0 to 0.50.1, installed from the npm registry."), wakeText(report));
  const install = w.scripts.find((script) => script.includes("BOAT_BBUP"));
  assert.match(install!, /^V='0\.50\.1'$/m);
  assert.match(install!, /npm pack --ignore-scripts --registry=https:\/\/registry\.npmjs\.org\/ .* "bb-app@\$V"/);
});

test("bb's install isn't touched under a connected machine", async () => {
  const { waker, calls } = world({ state: "idle", host: { phase: "active", connected: true }, bb: inspection({ installed: "0.49.0", tgz: "0.50.1" }) });
  const report = await waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "awake");
  assert.ok(!calls.includes("bb install"));
  assert.ok(!calls.includes("restart bb service"));
  assert.ok(stepTexts(report, "skipped").includes("bb's machine is connected, so Boat leaves bb's install alone (bb updates itself)."));
});

// ---------------------------------------------------------------- the chat

test("the chat: a failed turn retried, a pending provider retry sent now, a sending queue left alone, a usage limit left to its reset", async () => {
  // A failed turn.
  let w = world({ state: "idle", host: { phase: "active", connected: true } });
  let report = await w.waker.run({ target: "thr_task" });
  assert.ok(w.calls.includes("retry thr_task req_1"));
  assert.ok(stepTexts(report, "done").includes("Retried chat thr_task (\"Fix the login test\")'s failed turn."));

  // A provider retry due later: sent now.
  w = world({ state: "idle", host: { phase: "active", connected: true } });
  w.queues.set("thr_task", [{ id: "q_1", threadId: "thr_task", retry: true, sendAt: T0 + 30 * 60_000 }]);
  report = await w.waker.run({ target: "thr_task" });
  assert.ok(w.calls.includes("send queued thr_task q_1"));
  assert.ok(!w.calls.some((call) => call.startsWith("retry ")));

  // Its queue sends on its own once the machine is back: left alone.
  w = world({ state: "idle", host: { phase: "active", connected: true } });
  w.threads.set("thr_task", thread("thr_task", { status: "idle" }));
  w.queues.set("thr_task", [{ id: "q_2", threadId: "thr_task", retry: false, sendAt: null }]);
  report = await w.waker.run({ target: "thr_task" });
  assert.ok(!w.calls.some((call) => /^(retry|send queued) /.test(call)));
  assert.ok(stepTexts(report, "skipped").some((text) => /queue is sending its 1 queued message now/.test(text)));

  // Stopped at a usage limit: not retried here (it continues at the reset).
  w = world({ state: "idle", host: { phase: "active", connected: true } });
  w.events.set("thr_task", failedTurn("You've hit your usage limit", "rate-limit"));
  report = await w.waker.run({ target: "thr_task" });
  assert.ok(!w.calls.some((call) => call.startsWith("retry ")));
  assert.ok(stepTexts(report, "skipped").some((text) => /stopped at a usage limit/.test(text)));
});

// ---------------------------------------------------------------- the start limit

test("start check: included starts, used up, paid extra starts with and without --allow-paid-start", () => {
  assert.deepEqual(startCheck(LIMITS, false), { ok: true, paid: false, text: "an included boat start (58 left this hour)" });
  const usedUp = { ...LIMITS, startsLeftThisHour: 0 };
  // Paid extra starts off: no start, whatever the flag.
  for (const allow of [false, true]) {
    const check = startCheck(usedUp, allow);
    assert.equal(check.ok, false);
    assert.equal(check.ok === false && check.code, "no_start");
    assert.match(check.ok === false ? check.text : "", /^No included boat start is left this hour, and boat's paid extra starts are off \(Boat never turns them on\), so boat can't start it now\. Included starts come back within the hour\.$/);
  }
  // Paid extra starts on: only with the flag.
  const extra = { ...usedUp, extraStartsEnabled: true, nextStartDollars: 0.03 };
  const refused = startCheck(extra, false);
  assert.equal(refused.ok === false && refused.code, "paid_start");
  assert.match(refused.ok === false ? refused.text : "", /would be a paid extra start \(about \$0\.03\)\. Run it again with --allow-paid-start once the user agrees/);
  assert.deepEqual(startCheck(extra, true), { ok: true, paid: true, text: "a paid extra start (about $0.03), allowed with --allow-paid-start" });
  // boat prices the next start: paid even with starts left.
  assert.equal(startCheck({ ...LIMITS, nextStartDollars: 0.05 }, false).ok, false);
  // Limits boat didn't answer can't rule out a paid start.
  assert.equal(startCheck(null, false).ok === false && (startCheck(null, false) as { code: string }).code, "start_unknown");
  assert.equal(startCheck(null, true).ok, true);
  assert.equal(startCheck({ ...LIMITS, canStart: false, blockedReason: "billing past due" }, true).ok, false);
});

test("the start limit on a wake: Needs you without --allow-paid-start; with it, a paid start", async () => {
  const limits = { startsLeftToday: 0, extraStartsEnabled: true, nextStartDollars: 0.03 };
  let w = world({ state: "stopped", limits });
  let report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "needs-you");
  assert.ok(!w.calls.includes("resume"));
  assert.equal(report.steps.at(-1)?.step, "start-limit");
  assert.match(report.needsYou!.reason, /^No included boat start is left today, so this start would be a paid extra start \(about \$0\.03\)/);

  w = world({ state: "stopped", limits });
  report = await w.waker.run({ target: "bx_demo1", allowPaidStart: true });
  assert.equal(report.outcome, "awake", wakeText(report));
  assert.deepEqual(w.paid, [true]);

  // No start at all: the user hears so, and nothing is stopped that can't start again.
  w = world({ state: "idle", disk: [UNREADABLE_DISK], limits: { startsLeftThisHour: 0 } });
  report = await w.waker.run({ target: "bx_demo1", allowPaidStart: true });
  assert.equal(report.outcome, "needs-you");
  assert.equal(w.stopsMade(), 0, "not stopped: it couldn't start again");
  assert.match(report.needsYou!.reason, /boat\.dev's fix is to stop it and start it again, but no included boat start is left this hour/);
});

test("the service's bringUp gets past its own start limit only for an allowed paid start", async () => {
  const { service, boat } = makeService();
  boat.sandboxes.set("bx_s", sandbox("bx_s", "stopped"));
  boat.limitsValue = { ...boat.limitsValue, startsLeftToday: 0 };
  await assert.rejects(service.bringUp("bx_s"), (error: unknown) => error instanceof TaskError && error.code === "boat_start_limit");
  assert.equal((await service.bringUp("bx_s", undefined, { paidStart: true })).state, "idle");
});

// ---------------------------------------------------------------- review follow-ups

const FUSE_DISK = "BOAT_DSTATE 812 request_wait_answer fuse_simple_request node /usr/bin/node\nBOAT_DISK ok .profile\nBOAT_DISK_END\n";
const REFUSED = (_call: number, force: boolean): StopReport => (force ? { status: "completed", stopId: "stop_f", forced: true } : { status: "failing", stopId: "stop_1", forced: null, error: "Final snapshot failed; stop aborted to protect unsaved data" });

test("a read waiting on the disk is waited for, not stopped: one D-state look, then healthy, gives no stop at all", async () => {
  const { waker, calls, stopsMade } = world({ state: "idle", host: { phase: "active", connected: true }, disk: [FUSE_DISK, HEALTHY_DISK], stop: REFUSED });
  const report = await waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "awake", wakeText(report));
  assert.equal(stopsMade(), 0, calls.join(", "));
  assert.ok(!calls.some((call) => /^(stop|fork)/.test(call)));
  assert.ok(stepTexts(report).some((text) => /^A read on this sandbox's disk is waiting for boat\.dev to restore it/.test(text)));
  assert.ok(stepTexts(report).includes("Waiting up to 2 minutes for boat.dev to restore the disk."));
});

test("reads still stuck after the disk wait: then a stop and a start", async () => {
  // Stuck for the whole wait (every look), healthy once it was stopped and started.
  const { waker, calls, stopsMade, now } = world({ state: "idle", disk: [FUSE_DISK], diskAfterStop: HEALTHY_DISK });
  const report = await waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "awake", wakeText(report));
  assert.equal(stopsMade(), 1);
  assert.ok(stepTexts(report).some((text) => /^Reads on this sandbox's disk are still stuck after the wait/.test(text)), wakeText(report));
  assert.ok(calls.indexOf("stop") < calls.lastIndexOf("resume"));
  assert.ok(now() - T0 >= 2 * 60_000, "only after the 2-minute wait");
});

test("bb's machine Boat can't read counts as connected: a chat mid-turn there means Needs you, not a stop", async () => {
  for (const hostRead of ["throw", "null"] as const) {
    const w = world({ state: "idle", disk: [UNREADABLE_DISK], hostRead });
    w.threads.set("thr_task", thread("thr_task", { status: "active" }));
    const report = await w.waker.run({ target: "bx_demo1" });
    assert.equal(report.outcome, "needs-you", hostRead);
    assert.equal(w.stopsMade(), 0, hostRead);
    assert.match(report.needsYou!.reason, /, but the chat "Fix the login test" is mid-turn, and a stop would interrupt it\./);
    assert.ok(!w.calls.includes("forget bx_demo1"), "a run that stops before acting keeps Boat's retry plan");
  }
});

test("a bb machine lookup that fails isn't \"no machine\": no stop under a chat that may be running, and Needs you", async () => {
  // Resolving the sandbox id: bb's machine list can't be read. A chat on the connected machine is mid-turn.
  let w = world({ state: "idle", disk: [UNREADABLE_DISK], host: { phase: "active", connected: true }, hostLookup: "throw" });
  w.threads.set("thr_task", thread("thr_task", { status: "active" }));
  let report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "needs-you");
  assert.equal(w.stopsMade(), 0, w.calls.join(", "));
  assert.equal(report.target.hostLookupFailed, "bb couldn't read machine host_1");
  assert.equal(report.steps[0]!.text, "Boat couldn't look up bb's machine on sandbox bx_demo1 (bb couldn't read machine host_1), so it can't tell whether a chat runs there.");
  assert.match(report.needsYou!.reason, /, but Boat couldn't look up bb's machine there \(bb couldn't read machine host_1\), so it can't see whether a chat is mid-turn\. Nothing was stopped: try again in a minute, or wake it by a chat's id\.$/);
  assert.ok(!w.calls.includes("forget bx_demo1"));

  // A healthy disk: nothing to stop, but bb's machine and its chats can't be brought back or checked: Needs you, no update, no service restart.
  w = world({ state: "idle", host: { phase: "active", connected: false }, hostLookup: "throw", bb: inspection({ installed: "0.49.0", tgz: "0.50.1" }) });
  report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "needs-you");
  assert.ok(!w.calls.some((call) => /bb install|restart bb service|bb machine resume|retry /.test(call)), w.calls.join(", "));
  assert.match(report.needsYou!.reason, /^Boat couldn't look up bb's machine on sandbox bx_demo1 \(bb couldn't read machine host_1\), so it can't bring bb back there or check the chats on it\./);
  assert.ok(stepTexts(report, "skipped").includes("Boat couldn't read bb's machine, so it leaves bb's install alone (it may be running turns)."));

  // The dry run says so too.
  w = world({ state: "stopped", hostLookup: "throw" });
  report = await w.waker.run({ target: "bx_demo1", dryRun: true });
  assert.equal(report.outcome, "needs-you");
  assert.deepEqual(w.calls, []);
});

test("before any force, a test fork of the snapshot: unreadable or unknown, and nothing is forced", async () => {
  // The fork can't read the snapshot either: forcing would keep only that.
  let w = world({ state: "idle", disk: [UNREADABLE_DISK], stop: REFUSED, fork: "unreadable" });
  let report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "needs-you");
  assert.ok(!w.calls.includes("stop --force"));
  assert.deepEqual(w.calls.filter((call) => /^(fork|delete)/.test(call)), ["fork bx_demo1", "delete bx_fork1"], "the test fork is deleted");
  assert.match(report.needsYou!.reason, /a test fork from the same snapshot couldn't read its files either: forcing the stop would keep only that snapshot/);
  assert.equal(w.sandboxes.get("bx_demo1")?.state, "idle", "still running: nothing was stopped");
  assert.equal(((w.store.get(WAKE_MARKERS_KEY) as Record<string, WakeMarker>).bx_demo1)?.restart, null, "no stop is left for the recovery");

  // boat can't make the fork: unknown, so nothing is forced; the user gets the force command and what it loses.
  w = world({ state: "idle", disk: [UNREADABLE_DISK], stop: REFUSED, fork: new Error("boat fork failed") });
  report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "needs-you");
  assert.ok(!w.calls.includes("stop --force"));
  assert.match(report.needsYou!.reason, /Boat couldn't check its snapshot with a test fork, so it won't force the stop: without a clear "it reads fine", nothing is forced\. Forcing the stop keeps only 00:41 UTC/);
  assert.deepEqual(report.needsYou!.commands, ["boat stop bx_demo1 --force", "bb boat sandbox wake bx_demo1"]);

  // A fork and a start need two starts: with one left, nothing is forked or forced.
  w = world({ state: "idle", disk: [UNREADABLE_DISK], stop: REFUSED, limits: { startsLeftThisHour: 1 } });
  report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "needs-you");
  assert.ok(!w.calls.some((call) => /^(fork|stop --force)/.test(call)));
  assert.match(report.needsYou!.reason, /Forcing it needs a test fork of its snapshot first and then a start, but fewer than 2 included boat starts are left this hour/);
});

test("start check: partial limits with paid extra starts not known to be off could be paid", () => {
  const partial = { ...LIMITS, startsLeftToday: null, startsLeftThisHour: null, startsLeftThisMinute: null, nextStartDollars: null };
  for (const extra of [true, null]) {
    const check = startCheck({ ...partial, extraStartsEnabled: extra }, false);
    assert.equal(check.ok === false && check.code, "start_unknown", String(extra));
    assert.match(check.ok === false ? check.text : "", /could be a paid extra start\. Run it again with --allow-paid-start once the user agrees\./);
    assert.deepEqual(startCheck({ ...partial, extraStartsEnabled: extra }, true), { ok: true, paid: true, text: "a boat start that may be a paid extra start, allowed with --allow-paid-start" });
  }
  // Known included: paid extra starts off, a price of 0, both counts, or no start limit at all.
  assert.equal(startCheck({ ...partial, extraStartsEnabled: false }, false).ok, true);
  assert.deepEqual(startCheck({ ...partial, extraStartsEnabled: true, nextStartDollars: 0 }, false), { ok: true, paid: false, text: "an included boat start" });
  assert.equal(startCheck({ ...partial, extraStartsEnabled: true, startsLeftToday: 5, startsLeftThisHour: 3 }, false).ok, true);
  assert.equal(startCheck({ ...partial, extraStartsEnabled: true, startsLeftToday: 5 }, false).ok, false, "only today's count");
  assert.equal(startCheck({ ...partial, extraStartsEnabled: null, startsUnlimited: true }, false).ok, true);
  // Used up with paid extra starts unknown: could be paid.
  const usedUp = startCheck({ ...LIMITS, startsLeftThisHour: 0, extraStartsEnabled: null }, false);
  assert.equal(usedUp.ok === false && usedUp.code, "paid_start");
  assert.match(usedUp.ok === false ? usedUp.text : "", /so this start may be a paid extra start/);
  // Two starts (a test fork and the start).
  assert.equal(startCheck({ ...LIMITS, startsLeftThisHour: 1 }, false, 2).ok, false);
  assert.equal(startCheck({ ...LIMITS, startsLeftThisHour: 2 }, false, 2).ok, true);
});

test("one wake per sandbox: a second one while the first runs gets its progress and stops nothing", async () => {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const w = world({ state: "idle", disk: [UNREADABLE_DISK, HEALTHY_DISK], gate });
  const first = w.waker.run({ target: "bx_demo1" });
  // Let the first one stop the sandbox and wait in its start.
  for (let index = 0; index < 50 && !w.calls.includes("resume"); index++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(w.calls.includes("resume"), w.calls.join(", "));
  const second = await w.waker.run({ target: "t_1a2b3c4d" });
  assert.equal(second.outcome, "running");
  assert.match(second.steps.at(-1)!.text, /^A wake is already running for this sandbox \(started 09:00 UTC\): this is how far it got\.$/);
  const viaWake = await w.waker.wake({ target: "thr_task", waitMs: 0 });
  assert.equal(viaWake.outcome, "running");
  // A dry run doesn't look meanwhile either.
  assert.equal((await w.waker.run({ target: "bx_demo1", dryRun: true })).outcome, "running");
  open();
  assert.equal((await first).outcome, "awake");
  assert.equal(w.stopsMade(), 1, "only the first wake stopped it");
});

test("a wake in another plugin load (a fresh heartbeat in kv) isn't run twice", async () => {
  const w = world({ state: "idle", disk: [UNREADABLE_DISK, HEALTHY_DISK] });
  const marker: WakeMarker = { instance: "another-load", startedAt: T0 - 60_000, heartbeatAt: T0 - 10_000, restart: null, report: null };
  w.store.set(WAKE_MARKERS_KEY, { bx_demo1: marker });
  const report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "running");
  assert.match(report.steps[0]!.text, /^A wake is already running for this sandbox in another load of the plugin/);
  assert.equal(w.stopsMade(), 0);
  // Its heartbeat gone stale: this load runs it.
  w.advance(5 * 60_000);
  assert.equal((await w.makeWaker().run({ target: "bx_demo1" })).outcome, "awake");
});

test("a long wake: the call returns after its wait with the progress so far, --status shows it, and the chat hears when it's done", async () => {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const w = world({ state: "stopped", gate });
  const running = await w.waker.wake({ target: "thr_task", waitMs: 5, threadId: "thr_orch" });
  assert.equal(running.outcome, "running");
  assert.equal(running.tellsThreadId, "thr_orch");
  assert.ok(running.steps.some((step) => step.text === "It's stopped."), "the progress so far");
  assert.match(wakeText(running, T0), /^Waking sandbox bx_demo1 \(still running; started 09:00 UTC\)\./);
  assert.match(wakeText(running), /Still running\. Check on it with `bb boat sandbox wake bx_demo1 --status`; this chat gets a \[boat\] message when it's done\.$/);
  assert.equal((await w.waker.status("bx_demo1")).outcome, "running");
  assert.equal(w.notices.length, 0, "not told before it ends");
  open();
  for (let index = 0; index < 200 && w.notices.length === 0; index++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(w.notices.length, 1);
  assert.equal(w.notices[0]!.threadId, "thr_orch");
  assert.match(w.notices[0]!.text, /^\[boat\] The wake of sandbox bx_demo1 \(`bb boat sandbox wake thr_task`\) is done: it's back\./);
  const done = await w.waker.status("thr_task");
  assert.equal(done.outcome, "awake");
  assert.equal(finishedNotice(done), w.notices[0]!.text);
  await assert.rejects(w.makeWaker().status("bx_other1"), (error: unknown) => error instanceof TaskError && error.code === "no_wake");
});

test("the time bound: no stop goes out without time left to start it again", async () => {
  const w = world({ state: "idle", disk: [UNREADABLE_DISK], timing: { maxMs: 10 * 60_000, restartBudgetMs: 15 * 60_000 } });
  const report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "needs-you");
  assert.equal(w.stopsMade(), 0);
  assert.match(report.needsYou!.reason, /too long to stop the sandbox and still start it again within its limit of about 10 minutes, so nothing was stopped\.$/);
});

test("a wake cut off between its stop and its start leaves a marker, and the next pass starts the sandbox again", async () => {
  const reload = new AbortController();
  const w = world({ state: "idle", disk: [UNREADABLE_DISK, HEALTHY_DISK], lifecycle: reload.signal, abortAfterStop: reload });
  const report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "needs-you");
  assert.match(report.needsYou!.reason, /^The wake was cut off \(the plugin stopped or reloaded\)/);
  assert.equal(w.sandboxes.get("bx_demo1")?.state, "stopped");
  assert.ok((w.store.get(WAKE_MARKERS_KEY) as Record<string, WakeMarker>).bx_demo1?.restart, "the stop is on record");
  // The next plugin load's pass (the same kv): it starts the sandbox again, with a wake slot.
  const next = w.makeWaker({ lifecycle: new AbortController().signal });
  assert.deepEqual(await next.recover(), ["bx_demo1"]);
  assert.equal(w.sandboxes.get("bx_demo1")?.state, "idle");
  assert.equal((w.store.get(WAKE_MARKERS_KEY) as Record<string, WakeMarker>).bx_demo1?.restart, null);
  assert.match(w.told.at(-1)!, /A wake stopped this sandbox and was cut off before it started it again, so Boat started it again now\./);
  assert.deepEqual(await next.recover(), [], "once");
});

test("a start after the stop that fails leaves the marker; the recovery tries again later", async () => {
  const w = world({ state: "idle", disk: [UNREADABLE_DISK, HEALTHY_DISK], bringUpFails: (call) => (call === 1 ? new Error("Resume failed: restore error") : null) });
  const report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "needs-you");
  assert.match(report.needsYou!.reason, /Boat stopped it for this wake and keeps trying to start it again \(every few minutes\)/);
  assert.equal(w.sandboxes.get("bx_demo1")?.state, "stopped");
  w.advance(60_000);
  assert.deepEqual(await w.waker.recover(), ["bx_demo1"]);
  assert.equal(w.sandboxes.get("bx_demo1")?.state, "idle");
});

test("Boat's retry plan stays when a wake stops before acting (no start left), and goes once it acts", async () => {
  let w = world({ state: "stopped", limits: { startsLeftThisHour: 0 } });
  let report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "needs-you");
  assert.ok(!w.calls.includes("forget bx_demo1"));
  w = world({ state: "stopped" });
  report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(w.calls.filter((call) => call === "forget bx_demo1").length, 1);
  assert.ok(w.calls.indexOf("forget bx_demo1") < w.calls.indexOf("resume"));
});

// ---------------------------------------------------------------- work that's over

test("a cancelled task's chat is never woken for or retried; --force-wake wakes the sandbox, still without the retry", async () => {
  // The chat of a cancelled task: not woken.
  let w = world({ state: "stopped", taskStatus: "cancelled" });
  let report = await w.waker.run({ target: "thr_task" });
  assert.equal(report.outcome, "needs-you");
  assert.deepEqual(w.calls, [], "nothing woken");
  assert.match(report.needsYou!.reason, /^Chat thr_task belongs to task t_1a2b3c4d, which is cancelled, so Boat doesn't wake it: a chat there could go on with superseded work\. Wake it anyway with --force-wake only if the user wants that\.$/);
  assert.deepEqual(report.needsYou!.commands, ["bb boat sandbox wake thr_task --force-wake"]);

  // --force-wake: the sandbox comes back, but its chat isn't retried.
  w = world({ state: "stopped", taskStatus: "cancelled" });
  report = await w.waker.run({ target: "thr_task", forceWake: true });
  assert.equal(report.outcome, "awake", wakeText(report));
  assert.ok(w.calls.includes("resume"));
  assert.ok(!w.calls.some((call) => call.startsWith("retry ") || call.startsWith("send queued ")), w.calls.join(", "));
  assert.ok(stepTexts(report, "skipped").includes("Chat thr_task (\"Fix the login test\") belongs to task t_1a2b3c4d, which is cancelled: Boat doesn't retry it (it could push superseded work)."));

  // A pending provider retry of a closed task's chat isn't sent either.
  w = world({ state: "idle", host: { phase: "active", connected: true }, taskStatus: "done" });
  w.queues.set("thr_task", [{ id: "q_1", threadId: "thr_task", retry: true, sendAt: T0 + 30 * 60_000 }]);
  report = await w.waker.run({ target: "bx_demo1", forceWake: true });
  assert.ok(!w.calls.some((call) => call.startsWith("send queued ")));
  assert.ok(stepTexts(report, "skipped").some((text) => /which is closed: Boat doesn't retry it/.test(text)));
});

test("a sandbox whose only tasks are over, or a closed task, isn't woken without --force-wake", async () => {
  let w = world({ state: "stopped", taskStatus: "done" });
  let report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "needs-you");
  assert.deepEqual(w.calls, []);
  assert.match(report.needsYou!.reason, /^Sandbox bx_demo1's only task is over \(t_1a2b3c4d closed\), so Boat doesn't wake it/);
  // The dry run says the same.
  assert.equal((await w.waker.run({ target: "bx_demo1", dryRun: true })).outcome, "needs-you");

  w = world({ state: "stopped", taskStatus: "cancelled" });
  report = await w.waker.run({ target: "t_1a2b3c4d" });
  assert.equal(report.outcome, "needs-you");
  assert.match(report.needsYou!.reason, /^Task t_1a2b3c4d is cancelled, so Boat doesn't wake it/);

  w = world({ state: "stopped", taskStatus: "done" });
  report = await w.waker.run({ target: "bx_demo1", forceWake: true });
  assert.equal(report.outcome, "awake", wakeText(report));
  assert.ok(w.calls.includes("resume"));
});

test("a restart marker older than a day isn't acted on: a note on the tasks instead", async () => {
  const w = world({ state: "stopped" });
  const marker: WakeMarker = { instance: "an-old-load", startedAt: T0 - 26 * 3_600_000, heartbeatAt: T0 - 26 * 3_600_000, restart: { at: T0 - 25 * 3_600_000, paidStart: false, triedAt: null }, report: null };
  w.store.set(WAKE_MARKERS_KEY, { bx_demo1: marker });
  assert.deepEqual(await w.waker.recover(), []);
  assert.ok(!w.calls.includes("resume"));
  assert.equal(w.sandboxes.get("bx_demo1")?.state, "stopped");
  assert.equal((w.store.get(WAKE_MARKERS_KEY) as Record<string, WakeMarker>).bx_demo1?.restart ?? null, null, "no auto-resume left");
  assert.match(w.told.at(-1)!, /^A wake stopped this sandbox at 2026-11-18 08:00 UTC and couldn't start it again within a day, so Boat no longer starts it on its own\. Start it with `bb boat sandbox wake bx_demo1` when it's needed\.$/);
  assert.equal(w.toldClosedToo.at(-1), true, "on the record of every task that ran there, closed ones too");

  // Its tasks are over: not started again either.
  const closedWorld = world({ state: "stopped", taskStatus: "cancelled" });
  closedWorld.store.set(WAKE_MARKERS_KEY, { bx_demo1: { ...marker, restart: { at: T0 - 60_000, paidStart: false, triedAt: null } } });
  assert.deepEqual(await closedWorld.waker.recover(), []);
  assert.ok(!closedWorld.calls.includes("resume"));
  // Every task there is closed: the note still lands, on the closed tasks' record.
  assert.match(closedWorld.told.at(-1)!, /its tasks are over \(t_1a2b3c4d cancelled\), so Boat no longer starts it on its own/);
  assert.equal(closedWorld.toldClosedToo.at(-1), true);
});

test("findMachine strict: a machine whose resource bb couldn't read makes the lookup fail, not read as \"none\"", async () => {
  const bb = {
    sdk: { hosts: { list: async () => [{ id: "host_a", machineProviderId: MACHINE_PROVIDER_ID }, { id: "host_b", machineProviderId: MACHINE_PROVIDER_ID }] } },
    experimental_machines: {
      getResource: async (hostId: string) => {
        if (hostId === "host_a") throw new Error("bb didn't answer");
        return { sandboxId: "bx_other1", key: "k" };
      },
    },
  };
  const chat = createChatRunner(bb as never);
  assert.equal(await chat.findMachine("bx_demo1"), null, "the other callers keep their answer");
  await assert.rejects(chat.findMachine("bx_demo1", { strict: true }), /bb couldn't read machine host_a/);
  assert.equal(await chat.findMachine("bx_other1", { strict: true }), "host_b", "a match still answers");
});

test("--force-wake on a closed task's machine: its pending provider retry is cancelled before the machine comes back, its other queued messages are listed", async () => {
  const w = world({ state: "stopped", taskStatus: "cancelled" });
  w.queues.set("thr_task", [
    { id: "q_retry", threadId: "thr_task", retry: true, sendAt: null },
    { id: "q_user", threadId: "thr_task", retry: false, sendAt: null },
  ]);
  const report = await w.waker.run({ target: "bx_demo1", forceWake: true });
  assert.equal(report.outcome, "awake", wakeText(report));
  // Cancelled first: before the sandbox's resume, and so before bb's machine resume.
  assert.ok(w.calls.indexOf("cancel retry thr_task q_retry") >= 0 && w.calls.indexOf("cancel retry thr_task q_retry") < w.calls.indexOf("resume"), w.calls.join(", "));
  assert.ok(w.calls.indexOf("resume") < w.calls.indexOf("bb machine resume host_1"));
  assert.deepEqual(w.queues.get("thr_task")!.map((row) => row.id), ["q_user"], "the user's own message is left alone");
  assert.ok(!w.calls.some((call) => /^(retry|send queued) /.test(call)));
  assert.ok(stepTexts(report, "done").includes("Cancelled the pending provider retry of chat thr_task: task t_1a2b3c4d is cancelled."));
  assert.ok(stepTexts(report, "info").includes("bb will still deliver 1 queued message to chat thr_task of closed task t_1a2b3c4d; cancel them in bb if they're stale."));

  // The dry run plans it, and cancels nothing.
  const dry = world({ state: "stopped", taskStatus: "cancelled" });
  dry.queues.set("thr_task", [{ id: "q_retry", threadId: "thr_task", retry: true, sendAt: null }]);
  const planned = await dry.waker.run({ target: "bx_demo1", forceWake: true, dryRun: true });
  assert.equal(planned.outcome, "planned");
  assert.deepEqual(dry.calls, []);
  assert.ok(stepTexts(planned, "planned").includes("Cancel the pending provider retry of chat thr_task: task t_1a2b3c4d is cancelled."));

  // Without --force-wake nothing changes: the sandbox isn't woken, and nothing is cancelled.
  const plain = world({ state: "stopped", taskStatus: "cancelled" });
  plain.queues.set("thr_task", [{ id: "q_retry", threadId: "thr_task", retry: true, sendAt: null }]);
  assert.equal((await plain.waker.run({ target: "bx_demo1" })).outcome, "needs-you");
  assert.deepEqual(plain.calls, []);
});

test("a pending provider retry that can't be cancelled stops the wake before the machine comes back", async () => {
  const w = world({ state: "stopped", taskStatus: "done", cancelStuck: true });
  w.queues.set("thr_task", [{ id: "q_retry", threadId: "thr_task", retry: true, sendAt: T0 + 60_000 }]);
  const report = await w.waker.run({ target: "thr_task", forceWake: true });
  assert.equal(report.outcome, "needs-you");
  assert.deepEqual(w.calls, ["cancel retry thr_task q_retry"], "no resume, no forget");
  assert.match(report.needsYou!.reason, /^Boat couldn't cancel the pending provider retry of chat thr_task \(task t_1a2b3c4d is closed\), and it would go out once the machine is back\./);
  assert.deepEqual(report.needsYou!.commands, ["bb provider-retry cancel thr_task", "bb boat sandbox wake thr_task --force-wake"]);
});

test("another chat on the machine of a cancelled task: its retry is cancelled too, while the open task's chat is retried", async () => {
  const w = world({ state: "stopped", oldChat: true });
  w.queues.set("thr_old", [{ id: "q_old", threadId: "thr_old", retry: true, sendAt: null }]);
  const report = await w.waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "awake", wakeText(report));
  assert.ok(w.calls.indexOf("cancel retry thr_old q_old") < w.calls.indexOf("resume"), w.calls.join(", "));
  assert.ok(w.calls.includes("retry thr_task req_1"), "the open task's chat is still retried");
  assert.ok(stepTexts(report, "done").includes("Cancelled the pending provider retry of chat thr_old: task t_0ld00000 is cancelled."));
});

// ---------------------------------------------------------------- the protocol

test("the orchestrator protocol says to wake a stuck machine with the command, not by hand", () => {
  const text = composeProtocol("Shared.", null, null);
  assert.match(text, /# Stuck machines\n\n- If a chat or task is stuck on a paused or resuming machine .*run `bb boat sandbox wake <id>` \(the `boat_wake` tool\).*; don't hand-repair\./);
});
