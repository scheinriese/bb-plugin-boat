// `bb boat sandbox wake`: resolving the id, the dry run, the paced resume, each diagnosis's action
// (a stop and a start for an unreadable disk), bb's update, the chat's retry, the safety stops and
// the start limit. Fakes only: no boat CLI, no bb.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Limits, Sandbox, StopReport } from "../src/boat-api.ts";
import { createBbUpdater, parseInspection } from "../src/bb-update.ts";
import type { MachineState } from "../src/chat.ts";
import type { QueuedFacts, ThreadFacts } from "../src/paid-resume.ts";
import { TaskError } from "../src/service.ts";
import type { Task } from "../src/store.ts";
import type { TurnEventRow } from "../src/steer-retry.ts";
import { WakePacer } from "../src/wake-pacer.ts";
import { classifyDiskCheck, parseDiskCheck } from "../src/wake-diagnosis.ts";
import { WAKE_RETRY_REASON, createSandboxWaker, routeWake, startCheck, wakeText, type WakeFindings, type WakeReport } from "../src/sandbox-wake.ts";
import { composeProtocol } from "../src/protocol.ts";
import { makeService } from "./fakes.ts";

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

/** One fake account: a sandbox, bb's machine on it, its chats, and a clock. */
function world(options: { state?: string; host?: Partial<MachineState> | null; limits?: Partial<Limits> | null; disk?: string[]; checkouts?: string; bb?: string; serverVersion?: string; stop?: (call: number, force: boolean) => StopReport | Error; stopStatus?: (call: number) => StopReport; execDown?: boolean } = {}) {
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
  const boat = {
    async findInfo(id: string) {
      return sandboxes.get(id) ?? null;
    },
    async limits(): Promise<Limits> {
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
      if (script.includes("BOAT_DISK_END")) return { exitCode: 0, stdout: disks.length > 1 ? disks.shift()! : disks[0]!, stderr: "" };
      if (script.includes("BOAT_GIT_SCAN_END")) return { exitCode: 0, stdout: options.checkouts ?? CLEAN_CHECKOUTS, stderr: "" };
      if (script.includes("host-package-download/bb-app.tgz") && script.includes("say end")) return { exitCode: 0, stdout: options.bb ?? inspection(), stderr: "" };
      if (script.includes("BOAT_BBUP")) {
        calls.push("bb install");
        return { exitCode: 0, stdout: "BOAT_BBUP done 0.50.1 active\n", stderr: "" };
      }
      if (script.includes("BOAT_UNIT")) {
        calls.push("restart bb service");
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
  };
  const pacer = new WakePacer({ now, sleep: async (ms) => sleep(ms) });
  const paid: boolean[] = [];
  const host: MachineState | null = options.host === null ? null : { phase: "suspended", connected: false, message: null, ...options.host };
  const machine = { state: host };
  const threads = new Map<string, ThreadFacts>([["thr_task", thread("thr_task", { status: "error" })]]);
  const queues = new Map<string, QueuedFacts[]>();
  const events = new Map<string, TurnEventRow[]>([["thr_task", failedTurn()]]);
  const task = { id: "t_1a2b3c4d", title: "Fix the login test", status: "failed", sandboxId: "bx_demo1", hostId: "host_1", threadId: "thr_task", runner: "chat", repoPath: "/home/user/work/web", delivery: "pr", unshipped: null, orchestratorThreadId: null } as unknown as Task;
  const kv = new Map<string, unknown>();
  const updater = createBbUpdater({
    boat,
    kv: { get: async <T>(key: string) => kv.get(key) as T | undefined, set: async (key, value) => void kv.set(key, value) },
    serverVersion: async () => options.serverVersion ?? "0.50.1",
    now,
    sleep: async (ms) => sleep(ms),
  });
  const waker = createSandboxWaker({
    boat,
    async bringUp(id, _signal, wake) {
      calls.push("resume");
      paid.push(wake.paidStart);
      assert.ok(wake.permit, "a wake slot from the pacer");
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
      liveSandboxTasks: (id) => (id === "bx_demo1" ? [task] : []),
      hostForSandbox: () => null,
    },
    threads: {
      get: async (id) => threads.get(id) ?? null,
      stopEvents: async (id) => events.get(id) ?? [],
      queued: async (id) => queues.get(id!) ?? [],
      sendQueued: async (id, rowId) => void calls.push(`send queued ${id} ${rowId}`),
      retry: async (id, requestId, reason) => {
        assert.equal(reason, WAKE_RETRY_REASON);
        calls.push(`retry ${id} ${requestId}`);
      },
    },
    machines: {
      hostOf: async (environmentId) => (environmentId === "env_1" ? "host_1" : null),
      sandboxOf: async (hostId) => (hostId === "host_1" ? "bx_demo1" : null),
      hostFor: async (id) => (id === "bx_demo1" && machine.state !== null ? "host_1" : null),
      host: async () => (machine.state === null ? null : { ...machine.state }),
      resume: async (hostId) => {
        calls.push(`bb machine resume ${hostId}`);
        machine.state = { phase: "active", connected: true, message: null };
      },
      threadsOn: async () => [{ id: "thr_task", status: threads.get("thr_task")?.status ?? "idle", title: "Fix the login test" }],
    },
    now,
    sleep: async (ms) => sleep(ms),
  });
  return { waker, calls, scripts, sandboxes, pacer, paid, machine, threads, queues, events, stopsMade: () => stops, now };
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
  assert.ok(planned.some((text) => /^Stop it with a plain boat stop \(a fresh snapshot, nothing lost\), follow that stop, and start it again/.test(text) && /force it: nothing there could be lost/.test(text)), planned.join("\n"));
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
  assert.ok(stepTexts(report, "planned").some((text) => /bb machine resume|resume bb's machine/i.test(text)));
});

// ---------------------------------------------------------------- the paced resume

test("a stopped sandbox is resumed through the wake pacer, then bb's machine and the chat come back", async () => {
  const { waker, calls, pacer, paid, machine } = world({ state: "stopped" });
  const report = await waker.run({ target: "t_1a2b3c4d" });
  assert.equal(report.outcome, "awake", wakeText(report));
  assert.equal((await pacer.snapshot()).taken.length, 1, "one wake slot taken");
  assert.deepEqual(paid, [false], "an included start");
  assert.deepEqual(calls, ["forget bx_demo1", "resume", "login scripts off", "restart bb service", "bb machine resume host_1", "retry thr_task req_1"]);
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
  assert.equal(route(findings("BOAT_DSTATE 812 request_wait_answer fuse_simple_request node /usr/bin/node\nBOAT_DISK ok .profile\nBOAT_DISK_END\n")), "disk-stuck → stop-and-start");
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
  assert.deepEqual(calls.filter((call) => call.startsWith("stop")), ["stop", "stop --force"]);
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
  assert.match(report.needsYou!.reason, /still after a stop and a start\. Leave it stopped until boat\.dev has recovered/);
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

test("bb older than the server, with the server's download there: the safe update, then bb's machine", async () => {
  const { waker, calls } = world({ state: "stopped", bb: inspection({ installed: "0.49.0", tgz: "0.50.1" }) });
  const report = await waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "awake", wakeText(report));
  assert.ok(stepTexts(report, "done").includes("Updated bb on the sandbox from 0.49.0 to 0.50.1."));
  // The install started bb's service again: no second restart.
  assert.deepEqual(calls.filter((call) => /bb install|restart bb service|bb machine resume/.test(call)), ["bb install", "bb machine resume host_1"]);
});

test("bb older than the server without a download: said, with the npm registry as a manual step only", async () => {
  const { waker, calls } = world({ state: "stopped", bb: inspection({ installed: "0.49.0", tgz: "none" }) });
  const report = await waker.run({ target: "bx_demo1" });
  assert.equal(report.outcome, "awake", wakeText(report));
  assert.ok(!calls.includes("bb install"));
  const note = stepTexts(report).find((text) => text.startsWith("No download of bb 0.50.1 is on the sandbox"));
  assert.ok(note, wakeText(report));
  assert.match(note!, /To install it by hand from the npm registry instead \(a manual step; Boat doesn't run it\)/);
  assert.match(note!, /npm install -g .* --prefix "\$D\/npm\.new" bb-app@0\.50\.1/);
  assert.match(note!, /`D=~\/\.bb-machines\/acme-example-com`/);
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

// ---------------------------------------------------------------- the protocol

test("the orchestrator protocol says to wake a stuck machine with the command, not by hand", () => {
  const text = composeProtocol("Shared.", null, null);
  assert.match(text, /# Stuck machines\n\n- If a chat or task is stuck on a paused or resuming machine .*run `bb boat sandbox wake <id>` \(the `boat_wake` tool\).*; don't hand-repair\./);
});
