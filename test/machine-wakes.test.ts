// Waking Boat sandbox machines gently: paced resumes, plain failures, Boat's own retries,
// login scripts off before bb's SSH setup, and teardown that backs off.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BoatApi } from "../src/boat-api.ts";
import { BoatError, type BoatCli } from "../src/boat.ts";
import { registerBoatMachine } from "../src/machine.ts";
import { WakeDeferred, WakePacer } from "../src/wake-pacer.ts";
import { createWakeGuard } from "../src/wake-retry.ts";
import { defaultSettings, makeService } from "./fakes.ts";

type Provider = {
  create(args: unknown): Promise<{ status: string; resource?: { sandboxId: string; key: string }; message?: string }>;
  resume(args: unknown): Promise<unknown>;
  suspend(args: unknown): Promise<unknown>;
  remove(args: unknown): Promise<{ status: string; message?: string }>;
};

const HYDRATOR = "[lazyfs] [ERROR] HYDRATOR FAILED attempt 32 (mount stays up, on-demand serving continues, retrying …): decode/feed: chunk 1 GET 0000.tar.zst: status code 503";

function setup(options: { maxWaitMs?: number; moves?: { forkCheck?: boolean } } = {}) {
  let at = Date.parse("2026-11-19T00:00:00Z");
  const sleeps: number[] = [];
  const pacer = new WakePacer({ now: () => at, sleep: async (ms) => { sleeps.push(ms); at += ms; }, ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }) });
  const kvValues = new Map<string, unknown>();
  const kv = {
    values: kvValues,
    async get<T>(key: string) { return kvValues.get(key) as T | undefined; },
    async set(key: string, value: unknown) { kvValues.set(key, structuredClone(value)); },
    async delete(key: string) { kvValues.delete(key); },
  };
  let wakes: ReturnType<typeof createWakeGuard> | null = null;
  const fake = makeService({ wakes: { pacer, forget: (sandboxId) => wakes!.forget(sandboxId) } });
  wakes = createWakeGuard({ pacer, kv, boat: fake.boat as never, store: fake.store, now: () => at, ...(options.moves ? { moves: options.moves } : {}) });
  // Room for every sandbox here: pacing is what's tested, not the plan's limit.
  fake.boat.limitsValue = { ...fake.boat.limitsValue, maxActiveSandboxes: 10 };
  // bb's setup there, in order with the plugin's own steps.
  const order: string[] = [];
  let bootstrapError: Error | null = null;
  const execBefore = fake.boat.exec.bind(fake.boat);
  fake.boat.exec = async (sandboxId, script, execOptions) => {
    if (script.includes("update-motd.d")) order.push(`login scripts ${sandboxId}`);
    return execBefore(sandboxId, script, execOptions);
  };
  let provider: Provider | null = null;
  const bb = {
    experimental_machines: {
      register: (definition: Provider) => { provider = definition; },
      bootstrap: async () => {
        order.push("bootstrap");
        if (bootstrapError) throw bootstrapError;
        return { hostId: "host_123456" };
      },
    },
    experimental_environments: { register: () => undefined },
    storage: { kv },
  } as unknown as BbPluginApi;
  registerBoatMachine(bb, { boat: fake.boat as unknown as BoatApi, cli: { binary: async () => "/bin/boat" } as unknown as BoatCli, service: fake.service, settings: async () => defaultSettings(), wakes });
  const report = { steps: [] as string[], step(text: string) { this.steps.push(text); }, log: () => undefined };
  const lifecycle = (resource: unknown) => ({ resource, report, signal: new AbortController().signal, hostId: "host_123456" });
  return {
    ...fake, pacer, wakes, order, sleeps, report, lifecycle,
    provider: () => provider!,
    advance(ms: number) { at += ms; },
    failBootstrap(error: Error | null) { bootstrapError = error; },
    async stoppedMachine(key: string) {
      const created = await provider!.create({ inputs: {}, key, checkpoint: async () => undefined, report, signal: new AbortController().signal });
      assert.equal(created.status, "created", created.message);
      fake.boat.sandboxes.get(created.resource!.sandboxId)!.state = "stopped";
      return created.resource!;
    },
  };
}

const resumes = (calls: string[]) => calls.filter((call) => call.startsWith("resume "));

test("machine resumes are paced: a third wake within a minute waits for its slot", async () => {
  const env = setup();
  const machines = [await env.stoppedMachine("a"), await env.stoppedMachine("b"), await env.stoppedMachine("c")];
  for (const resource of machines) await env.provider().resume(env.lifecycle(resource));
  assert.equal(resumes(env.boat.calls).length, 3);
  // The first two went at once; the third waited out the minute.
  assert.deepEqual(env.sleeps, [60_000]);
  assert.ok(env.report.steps.some((step) => step === "Waiting until 00:01 UTC: Boat wakes at most 2 sandboxes a minute"), env.report.steps.join("\n"));
});

test("over the wait, a machine resume fails clearly, retryably, without waking anything", async () => {
  const env = setup({ maxWaitMs: 0 });
  const machines = [await env.stoppedMachine("a"), await env.stoppedMachine("b"), await env.stoppedMachine("c")];
  await env.provider().resume(env.lifecycle(machines[0]));
  await env.provider().resume(env.lifecycle(machines[1]));
  await assert.rejects(env.provider().resume(env.lifecycle(machines[2])), /^Error: Boat wakes at most 2 sandboxes a minute and others are waking now\. Boat will wake this one at 00:01 UTC\.$/);
  assert.equal(resumes(env.boat.calls).length, 2);
  assert.equal((await env.wakes.scheduled(machines[2]!.sandboxId))!.kind, "paced");
});

test("bb's setup hitting EIO: the plain disk message, a retry plan, and no hammering before it", async () => {
  const env = setup();
  const resource = await env.stoppedMachine("orch");
  env.boat.execResult = (script) => ({ exitCode: 0, stdout: script.includes("BOAT_DISK_END") ? `BOAT_HYDRATOR ${HYDRATOR}\nBOAT_DISK fail .profile Input/output error\nBOAT_DISK_END\n` : "", stderr: "" });
  env.failBootstrap(new Error("Machine bootstrap command failed: grep: /home/user/.ssh/authorized_keys: Input/output error"));
  await assert.rejects(env.provider().resume(env.lifecycle(resource)), /^Error: boat\.dev is still restoring this sandbox's disk \(its storage is returning errors\)\. Boat will retry at 00:02 UTC; pressing Resume earlier won't help\.$/);
  assert.equal((await env.pacer.snapshot()).failures, 1, "the account's next wake pauses");
  // bb's Resume, the watchdog or bb's provider retry before 00:02: refused without asking boat.dev.
  const calls = env.boat.calls.length;
  const order = env.order.length;
  await assert.rejects(env.provider().resume(env.lifecycle(resource)), /pressing Resume earlier won't help/);
  assert.equal(env.boat.calls.length, calls);
  assert.equal(env.order.length, order);
  // At 00:02 it goes ahead; once bb is set up, the plan is gone.
  env.advance(2 * 60_000);
  env.failBootstrap(null);
  await env.provider().resume(env.lifecycle(resource));
  assert.equal(await env.wakes.scheduled(resource.sandboxId), null);
});

test("the login message scripts go off over exec before bb's SSH setup, on create and on resume", async () => {
  const env = setup();
  const resource = await env.stoppedMachine("orch");
  assert.deepEqual(env.order, [`login scripts ${resource.sandboxId}`, "bootstrap"]);
  // Answered "disabled" once: the next wake doesn't ask again.
  env.boat.execResult = () => ({ exitCode: 0, stdout: "BOAT_MOTD disabled\n", stderr: "" });
  await env.provider().resume(env.lifecycle(resource));
  assert.deepEqual(env.order.slice(2), [`login scripts ${resource.sandboxId}`, "bootstrap"]);
  env.boat.sandboxes.get(resource.sandboxId)!.state = "stopped";
  await env.provider().resume(env.lifecycle(resource));
  assert.deepEqual(env.order.slice(4), ["bootstrap"]);
});

test("service resumes take a wake slot too, and a failed resume pauses the next", async () => {
  const env = setup({ maxWaitMs: 0 });
  for (const id of ["bx_s1", "bx_s2", "bx_s3"]) env.boat.addSandbox(id, "default", "stopped");
  await env.service.bringUp("bx_s1");
  await env.service.bringUp("bx_s2");
  await assert.rejects(env.service.bringUp("bx_s3"), (error: unknown) => error instanceof WakeDeferred);
  assert.deepEqual(resumes(env.boat.calls).map((call) => call.split(" ")[1]), ["bx_s1", "bx_s2"]);
  // A resume boat refused ("error" with "Resume failed"): resumable again, and its failure pauses the account's wakes.
  env.advance(60_000);
  const broken = env.boat.addSandbox("bx_s4", "default", "error");
  broken.error = "Resume failed: Failed to restore snapshot: Please reduce your request rate.";
  env.boat.resumeError = () => new BoatError("Failed to restore snapshot: Please reduce your request rate.", { code: "boat_failed" });
  await assert.rejects(env.service.bringUp("bx_s4"), /reduce your request rate/);
  assert.equal(resumes(env.boat.calls).at(-1)?.split(" ")[1], "bx_s4");
  assert.equal((await env.pacer.snapshot()).failures, 1);
});

test("an explicit resume (bb boat sandbox resume) starts the sandbox's retry plan over", async () => {
  const env = setup();
  const sandbox = env.boat.addSandbox("bx_plan", "default", "stopped");
  await assert.rejects(env.wakes.machine({ sandboxId: sandbox.id, hostId: null, signal: new AbortController().signal, report: { step: () => undefined, log: () => undefined } }, async () => { throw new Error("Resume failed: Failed to restore snapshot: Please reduce your request rate."); }));
  assert.notEqual(await env.wakes.scheduled(sandbox.id), null);
  await env.service.sandboxAction(sandbox.id, "resume", 3600);
  assert.equal(await env.wakes.scheduled(sandbox.id), null);
  assert.equal(sandbox.state, "idle");
});

test("teardown backs off: bb's retries in between don't reach boat.dev", async () => {
  const env = setup();
  const created = await env.provider().create({ inputs: {}, key: "gone", checkpoint: async () => undefined, report: env.report, signal: new AbortController().signal });
  const resource = created.resource!;
  let deletes = 0;
  env.boat.delete = async () => { deletes += 1; throw new BoatError("Please reduce your request rate.", { code: "rate_limited", status: 429 }); };
  const first = await env.provider().remove({ resource });
  assert.equal(first.status, "failed");
  assert.match(first.message!, /^boat\.dev failed to delete this sandbox \(Please reduce your request rate\.\)\. Boat asks it again at \d\d:\d\d UTC\.$/);
  const second = await env.provider().remove({ resource });
  assert.match(second.message!, /failed to delete this sandbox a moment ago/);
  assert.equal(deletes, 1);
  // The same for a stop.
  let stops = 0;
  env.boat.stop = async () => { stops += 1; throw new BoatError("upstream 503", { code: "boat_failed" }); };
  await assert.rejects(env.provider().suspend({ resource }), /boat\.dev failed to stop this sandbox \(upstream 503\)/);
  await assert.rejects(env.provider().suspend({ resource }), /a moment ago/);
  assert.equal(stops, 1);
  // A sandbox already gone counts as removed.
  env.boat.delete = async () => { throw new BoatError("not found (404)", { code: "not_found", status: 404 }); };
  await new Promise((resolve) => setTimeout(resolve, 0));
  const other = await env.provider().create({ inputs: {}, key: "other", checkpoint: async () => undefined, report: env.report, signal: new AbortController().signal });
  assert.equal((await env.provider().remove({ resource: other.resource })).status, "removed");
});

test("a plain stop boat refuses on a disk it hasn't restored: Boat force-stops it, keeping the last snapshot, instead of hammering", async () => {
  const env = setup({ moves: { forkCheck: false } });
  const created = await env.provider().create({ inputs: {}, key: "orch", checkpoint: async () => undefined, report: env.report, signal: new AbortController().signal });
  const resource = created.resource!;
  env.boat.stopRefused = true;
  env.boat.execResult = (script) => ({ exitCode: 0, stdout: script.includes("BOAT_DISK_END") ? `BOAT_HYDRATOR ${HYDRATOR.replace("attempt 32", "attempt 77")}\nBOAT_DISK_END\n` : "", stderr: "" });
  await assert.rejects(env.provider().suspend(env.lifecycle(resource)), /^Error: boat\.dev failed to stop this sandbox \(it can't snapshot a disk it hasn't finished restoring; Boat moves it off its node, or asks first under Needs you\)\. Boat asks it again at \d\d:\d\d UTC\.$/);
  const plan = (await env.wakes.scheduled(resource.sandboxId))!;
  assert.deepEqual(plan.move, { state: "due", at: plan.lastAt, resume: false });
  assert.equal(await env.wakes.tick(), resource.sandboxId);
  for (let round = 0; round < 500 && (await env.wakes.scheduled(resource.sandboxId)) !== null; round++) await new Promise((resolve) => setImmediate(resolve));
  // An orchestrator's sandbox, nothing to lose: stopped, keeping its last completed snapshot; its next wake starts it on a new node.
  assert.ok(env.boat.calls.includes(`stop ${resource.sandboxId} --force`));
  assert.equal(env.boat.sandboxes.get(resource.sandboxId)!.state, "stopped");
  assert.equal(await env.wakes.scheduled(resource.sandboxId), null);
});

test("a refused stop with a healthy disk is only reported", async () => {
  const env = setup({ moves: {} });
  const created = await env.provider().create({ inputs: {}, key: "orch", checkpoint: async () => undefined, report: env.report, signal: new AbortController().signal });
  env.boat.stopRefused = true;
  env.boat.execResult = () => ({ exitCode: 0, stdout: "BOAT_DISK ok .profile\nBOAT_DISK_END\n", stderr: "" });
  await assert.rejects(env.provider().suspend(env.lifecycle(created.resource)), /boat didn't stop it: it's still idle/);
  assert.equal(await env.wakes.scheduled(created.resource!.sandboxId), null);
  assert.ok(!env.boat.calls.some((call) => call.includes("--force")));
});
