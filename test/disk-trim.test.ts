// Boat trims the blocks deleted files freed before it stops a sandbox, so boat's snapshot doesn't outgrow
// the sandbox's size: bounded, only while it runs, never in the stop's way.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BoatApi } from "../src/boat-api.ts";
import { BoatError, type BoatCli } from "../src/boat.ts";
import { registerBoatMachine } from "../src/machine.ts";
import { TRIM_TIMEOUT_MS, diskTooLarge, parseTrim, roomierSize, tooLargeMessage, tooLargeQuestion, trimFreedBlocks, trimScript } from "../src/disk-trim.ts";
import { defaultSettings, makeService } from "./fakes.ts";

// As fstrim -av prints it (the amount seen live on a sandbox that outgrew Small).
const FSTRIM = "/boot/efi: 0 B (0 bytes) trimmed on /dev/vda15\n/: 124.2 GiB (133352955904 bytes) trimmed on /dev/vda1\n";

type Provider = {
  create(args: unknown): Promise<{ status: string; resource?: { sandboxId: string; key: string }; message?: string }>;
  suspend(args: unknown): Promise<unknown>;
};

const isTrim = (script: string) => script.includes("fstrim");

function setup(options: { trimTimeoutMs?: number } = {}) {
  const fake = makeService();
  const debug: string[] = [];
  // Every exec in boat's call order, so a trim shows where it ran.
  const execBefore = fake.boat.exec.bind(fake.boat);
  const execOptions: { login?: boolean; timeoutMs?: number }[] = [];
  fake.boat.exec = async (sandboxId, script, opts) => {
    if (isTrim(script)) {
      fake.boat.calls.push(`trim ${sandboxId}`);
      execOptions.push(opts as { login?: boolean; timeoutMs?: number });
    }
    return execBefore(sandboxId, script, opts);
  };
  let provider: Provider | null = null;
  const values = new Map<string, unknown>();
  const bb = {
    experimental_machines: { register: (definition: Provider) => { provider = definition; }, bootstrap: async () => ({ hostId: "host_123456" }) },
    experimental_environments: { register: () => undefined },
    storage: { kv: { async get(key: string) { return values.get(key); }, async set(key: string, value: unknown) { values.set(key, value); }, async delete(key: string) { values.delete(key); } } },
    log: { debug: (line: string) => debug.push(line), info: () => undefined, warn: () => undefined, error: () => undefined },
  } as unknown as BbPluginApi;
  registerBoatMachine(bb, {
    boat: fake.boat as unknown as BoatApi,
    cli: { binary: async () => "/bin/boat" } as unknown as BoatCli,
    service: fake.service,
    settings: async () => defaultSettings(),
    stopWait: { pollMs: 1, maxMs: 5 },
    ...(options.trimTimeoutMs === undefined ? {} : { trimTimeoutMs: options.trimTimeoutMs }),
  });
  const report = { step: () => undefined, log: () => undefined };
  return {
    ...fake, debug, execOptions,
    provider: () => provider!,
    async machine(key = "orch") {
      const created = await provider!.create({ inputs: {}, key, checkpoint: async () => undefined, report, signal: new AbortController().signal });
      assert.equal(created.status, "created", created.message);
      return created.resource!;
    },
    suspend: (resource: unknown) => provider!.suspend({ resource, hostId: "host_123456", signal: new AbortController().signal }),
  };
}

const answer = (stdout: string, exitCode = 0) => (script: string) => (isTrim(script) ? { exitCode, stdout, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });

test("fstrim -av's lines: the amount trimmed on each filesystem, summed", () => {
  assert.deepEqual(parseTrim(FSTRIM), { bytes: 133352955904, lines: ["0 B on /dev/vda15", "124.2 GiB on /dev/vda1"] });
  assert.equal(parseTrim("sudo: a password is required\n"), null);
  assert.equal(parseTrim(""), null);
  // Bounded in the sandbox too, without a password prompt; a plain bash runs it.
  assert.equal(trimScript(), "timeout -k 5 50 sudo -n fstrim -av 2>&1");
  assert.equal(TRIM_TIMEOUT_MS, 60_000);
});

test("suspend trims the disk over exec before boat's stop, and logs the amount at debug", async () => {
  const env = setup();
  const resource = await env.machine();
  env.boat.execResult = answer(FSTRIM);
  await env.suspend(resource);
  const calls = env.boat.calls.filter((call) => call.startsWith("trim ") || call.startsWith("stop "));
  assert.deepEqual(calls, [`trim ${resource.sandboxId}`, `stop ${resource.sandboxId}`]);
  assert.equal(env.boat.sandboxes.get(resource.sandboxId)!.state, "stopped");
  // A plain `bash -c` (no ~/.profile), with exec's own timeout inside the minute.
  assert.equal(env.execOptions[0]!.login, false);
  assert.ok(env.execOptions[0]!.timeoutMs! < TRIM_TIMEOUT_MS);
  assert.deepEqual(env.debug, [`disk trim ${resource.sandboxId}: trimmed 124.2 GiB (0 B on /dev/vda15, 124.2 GiB on /dev/vda1)`]);
});

test("a trim that hangs never holds up the stop past its budget", async () => {
  const env = setup({ trimTimeoutMs: 40 });
  const resource = await env.machine();
  let cancelled = false;
  const execBefore = env.boat.exec;
  // fstrim never answers; boat's call isn't even cut short by the cancel.
  env.boat.exec = async (sandboxId, script, opts) => {
    if (!isTrim(script)) return execBefore(sandboxId, script, opts);
    env.boat.calls.push(`trim ${sandboxId}`);
    opts?.signal?.addEventListener("abort", () => { cancelled = true; }, { once: true });
    return new Promise(() => undefined);
  };
  const started = Date.now();
  await env.suspend(resource);
  assert.ok(Date.now() - started < 2_000, "the stop went ahead after the budget");
  assert.ok(env.boat.calls.includes(`stop ${resource.sandboxId}`));
  assert.equal(env.boat.sandboxes.get(resource.sandboxId)!.state, "stopped");
  assert.equal(cancelled, true, "boat's call is cancelled");
  assert.match(env.debug[0]!, /^disk trim bx_\w+: couldn't trim \(no answer within \d+s\)$/);
});

test("a trim that fails never fails the stop: boat's error, sudo refused, fstrim timed out in the sandbox", async () => {
  const cases: { name: string; run: (env: ReturnType<typeof setup>) => void; logged: RegExp }[] = [
    {
      name: "boat's exec fails",
      run: (env) => {
        const execBefore = env.boat.exec;
        env.boat.exec = async (sandboxId, script, opts) => {
          if (isTrim(script)) throw new BoatError("sandbox not responding (exec)\nmore", { code: "boat_failed" });
          return execBefore(sandboxId, script, opts);
        };
      },
      logged: /couldn't trim \(sandbox not responding \(exec\)\)$/,
    },
    { name: "sudo asks for a password", run: (env) => { env.boat.execResult = answer("sudo: a password is required\n", 1); }, logged: /couldn't trim \(sudo: a password is required\)$/ },
    { name: "timeout ends fstrim", run: (env) => { env.boat.execResult = answer("", 124); }, logged: /couldn't trim \(fstrim timed out\)$/ },
    { name: "nothing takes a trim", run: (env) => { env.boat.execResult = answer("", 0); }, logged: /couldn't trim \(fstrim named no filesystem it trimmed\)$/ },
  ];
  for (const entry of cases) {
    const env = setup();
    const resource = await env.machine();
    entry.run(env);
    await env.suspend(resource);
    assert.ok(env.boat.calls.includes(`stop ${resource.sandboxId}`), entry.name);
    assert.equal(env.boat.sandboxes.get(resource.sandboxId)!.state, "stopped", entry.name);
    assert.match(env.debug[0]!, entry.logged, entry.name);
  }
});

test("a sandbox that isn't running isn't trimmed: exec must never wake it", async () => {
  // Already stopped (boat's auto-stop): suspend neither trims nor stops.
  const env = setup();
  const resource = await env.machine();
  env.boat.sandboxes.get(resource.sandboxId)!.state = "stopped";
  await env.suspend(resource);
  assert.deepEqual(env.boat.calls.filter((call) => call.startsWith("trim ") || call.startsWith("stop ")), []);
  // The helper on its own: stopped, gone, or a look that fails.
  const looks: (string | null | Error)[] = ["stopped", null, new BoatError("boat list failed")];
  const lines: string[] = [];
  for (const look of looks) {
    let execs = 0;
    const boat = {
      findInfo: async () => {
        if (look instanceof Error) throw look;
        return look === null ? null : { state: look };
      },
      exec: async () => {
        execs += 1;
        return { exitCode: 0, stdout: FSTRIM, stderr: "" };
      },
    };
    const outcome = await trimFreedBlocks(boat as never, "bx_away", { log: (line) => lines.push(line) });
    assert.equal(execs, 0);
    assert.notEqual(outcome.status, "trimmed");
  }
  assert.deepEqual(lines, ["disk trim bx_away: skipped, the sandbox is stopped", "disk trim bx_away: skipped, the sandbox is gone", "disk trim bx_away: couldn't trim (boat list failed)"]);
  // A look that never answers is bounded too, and a cancelled stop doesn't trim at all.
  const slow = { findInfo: () => new Promise(() => undefined), exec: async () => ({ exitCode: 0, stdout: FSTRIM, stderr: "" }) };
  assert.equal((await trimFreedBlocks(slow as never, "bx_slow", { timeoutMs: 20 })).status, "failed");
  const cancelled = new AbortController();
  cancelled.abort();
  assert.deepEqual(await trimFreedBlocks(slow as never, "bx_slow", { signal: cancelled.signal }), { status: "skipped", reason: "the stop was cancelled" });
});

test("Boat's other stops trim first too: an explicit stop of a headless sandbox", async () => {
  const env = setup();
  const sandbox = env.boat.addSandbox("bx_headless", "small", "idle");
  env.boat.execResult = answer(FSTRIM);
  await env.service.sandboxAction(sandbox.id, "stop", 3600);
  assert.deepEqual(env.boat.calls.filter((call) => call.endsWith(sandbox.id)), [`trim ${sandbox.id}`, `stop ${sandbox.id}`]);
  assert.deepEqual(env.debugs, [`disk trim ${sandbox.id}: trimmed 124.2 GiB (0 B on /dev/vda15, 124.2 GiB on /dev/vda1)`]);
});

test("Boat's other stops trim first too: the idle stop of a finished headless task", async () => {
  const env = makeService({ settings: { stopIdleAfterMinutes: 1 } });
  const execBefore = env.boat.exec.bind(env.boat);
  env.boat.exec = async (sandboxId, script, opts) => {
    if (isTrim(script)) env.boat.calls.push(`trim ${sandboxId}`);
    return execBefore(sandboxId, script, opts);
  };
  const { task } = await env.service.launchTask({ title: "Docs", role: "implement", brief: "Write them.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
  env.boat.finish(task.conversationId!, "Done.\n\n=== REPORT ===\nSTATUS: done\nPR: none\nBRANCH: none\nSUMMARY: done\nTESTS: ok\nOPEN QUESTIONS: none\n=== END REPORT ===");
  await env.service.sweep();
  const realNow = Date.now;
  Date.now = () => realNow() + 5 * 60_000;
  try {
    await env.service.sweep();
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(env.boat.calls.filter((call) => call === `trim ${task.sandboxId}` || call === `stop ${task.sandboxId}`), [`trim ${task.sandboxId}`, `stop ${task.sandboxId}`]);
});

// boat's words when the data doesn't fit the sandbox's size (seen live on 19 Nov).
const TOO_LARGE = "This sandbox uses 84.1 GB of disk, which does not fit any available 'small' machine (largest budget: 76.0 GB)";

test("boat's size refusal: the data, the size and what it fits, from its words or its code", () => {
  assert.deepEqual(diskTooLarge(new BoatError(TOO_LARGE, { code: "boat_failed" })), { usedGb: 84.1, type: "small", budgetGb: 76, detail: TOO_LARGE });
  assert.deepEqual(diskTooLarge(new Error(`Resume failed: ${TOO_LARGE}`))?.type, "small");
  assert.deepEqual(diskTooLarge(new BoatError("Requested machine type is too small", { code: "type_too_small" })), { usedGb: null, type: null, budgetGb: null, detail: "Requested machine type is too small" });
  assert.equal(diskTooLarge(new Error("Failed to restore snapshot: Please reduce your request rate.")), null);
  assert.equal(diskTooLarge(new BoatError("not found (404)", { code: "not_found" })), null);
  // Small and Default fit the same, so Large; then XLarge; nothing past it.
  assert.deepEqual((["small", "default", "large", "xlarge", null] as const).map(roomierSize), ["large", "large", "xlarge", null, "large"]);
});

test("too large for its size: plain words, and Needs you with the exact way back by hand", () => {
  const size = diskTooLarge(new BoatError(TOO_LARGE, { code: "type_too_small" }));
  assert.equal(tooLargeMessage(size), "This sandbox won't start: its data is 84.1 GB, too large for its size (Small fits 76.0 GB). One start on Large plus a cleanup brings it back to Small; the steps are under Needs you.");
  const asked = tooLargeQuestion({ sandboxId: "bx_acme01", size });
  assert.equal(asked.question, "Sandbox bx_acme01 won't start: its data is 84.1 GB, too large for its size (Small fits 76.0 GB). Bring it back to Small with one start on Large?");
  assert.match(asked.recommendation, /^Usually most of it is space from deleted files, which boat\.dev still counts until the disk is trimmed\. One start on Large plus a cleanup brings it back to Small: /);
  assert.match(asked.recommendation, /Boat doesn't do this on its own: a start on Large costs more\.$/);
  assert.deepEqual(asked.options, ["I'll do it", "Leave it for now"]);
  assert.equal(asked.shortLabel, "Sandbox too large for its size");
  assert.deepEqual(asked.context.split("\n"), [
    `boat.dev said: ${TOO_LARGE}.`,
    "boat resume bx_acme01 --type large",
    "boat exec bx_acme01 -- sudo fstrim -av",
    "boat exec bx_acme01 -- docker image prune -af",
    "boat stop bx_acme01",
    "boat resume bx_acme01 --type small",
  ]);
  // Only boat's code: the size from what Boat knows of the sandbox.
  const bare = diskTooLarge(new BoatError("Requested machine type is too small", { code: "type_too_small" }));
  assert.equal(tooLargeMessage(bare), "This sandbox won't start: its data is too large for its size. One start on Large plus a cleanup brings it back to its size; the steps are under Needs you.");
  const known = tooLargeQuestion({ sandboxId: "bx_abc", size: bare, type: "default" });
  assert.equal(known.question, "Sandbox bx_abc won't start: its data is too large for its size. Bring it back to Default with one start on Large?");
  assert.equal(known.context.split("\n").at(-1), "boat resume bx_abc --type default");
  // XLarge: no larger size to clean it up on.
  const biggest = tooLargeQuestion({ sandboxId: "bx_big", size: { usedGb: 900, type: "xlarge", budgetGb: 600, detail: "does not fit any available 'xlarge' machine" } });
  assert.equal(biggest.question, "Sandbox bx_big won't start: its data is 900.0 GB, too large for its size (XLarge fits 600.0 GB). No larger size fits it. What now?");
  assert.ok(!biggest.context.includes("boat resume"));
});
