import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { BootstrapNpmEvidence, bootstrapExecutor, bootstrapFailureMessage, retryableBootstrap } from "../src/bootstrap.ts";
import { sshExecutor } from "../src/machine.ts";
import type { BoatCli } from "../src/boat.ts";

const installing = "⠋ Installing the server's bb-app build\n";
const missing = "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/example-pkg/-/example-pkg-1.0.1.tgz - Not found\n";
type Request = Parameters<MachineExecutor["exec"]>[0];
function request(output: string[], signal = new AbortController().signal): Request {
  return { command: ["bash", "-s"], stdin: "fake_enrollment_stdin_not_for_logs", timeoutMs: 600_000, signal, onOutput: chunk => output.push(chunk) };
}
function clock() {
  let at = 0;
  const pauses: number[] = [];
  return { pauses, advance(ms: number) { at += ms; }, now: () => at,
    async wait(ms: number, signal: AbortSignal) { signal.throwIfAborted(); pauses.push(ms); at += ms; } };
}

test("successful bootstrap runs once and forwards output without logging enrollment input", async () => {
  const output: string[] = [], logs: string[] = []; let calls = 0; const time = clock();
  const executor = bootstrapExecutor({ async exec(r) { calls++; r.onOutput("Installed successfully\n"); return { exitCode: 0 }; } }, { log: m => logs.push(m) }, time);
  assert.deepEqual(await executor.exec(request(output)), { exitCode: 0 });
  assert.equal(calls, 1); assert.deepEqual(time.pauses, []); assert.deepEqual(output, ["Installed successfully\n"]); assert.deepEqual(logs, []);
});

for (const code of ["E404", "ETARGET", "ETIMEDOUT", "ECONNRESET"] as const) test(`transient npm ${code} retries the identical command/enrollment with bounded backoff`, async () => {
  const output: string[] = [], logs: string[] = [], calls: Request[] = []; const time = clock(); const initial = request(output);
  const executor = bootstrapExecutor({ async exec(r) {
    calls.push(r); time.advance(100);
    r.onOutput(installing);
    if (calls.length < 3) {
      for (const chunk of (code === "E404" ? missing : `npm ERR! code ${code}\n`)) r.onOutput(chunk);
      return { exitCode: 1 };
    }
    r.onOutput("✓ Installed the server's bb-app build\n"); return { exitCode: 0 };
  } }, { log: m => logs.push(m) }, time);
  assert.equal((await executor.exec(initial)).exitCode, 0);
  assert.equal(calls.length, 3); assert.deepEqual(time.pauses, [30_000, 60_000]);
  for (const r of calls) { assert.equal(r.stdin, initial.stdin); assert.deepEqual(r.command, initial.command); assert.equal(r.signal, initial.signal); }
  assert.deepEqual(calls.map(r => r.timeoutMs), [600_000, 569_900, 509_800]);
  assert.equal(logs.length, 2); assert.match(logs[1], /same sandbox.*60s.*3\/3/);
  assert.ok(!logs.join("").includes(initial.stdin)); assert.ok(!output.join("").includes("bootstrap_retryable"));
});

test("exhausted retry is explicit and sanitized, without repeating raw diagnostics", async () => {
  const output: string[] = []; let calls = 0; const time = clock();
  const result = await bootstrapExecutor({ async exec(r) { calls++; r.onOutput(installing + missing); return { exitCode: 1 }; } }, { log() {} }, time).exec(request(output));
  assert.equal(result.exitCode, 1); assert.equal(calls, 3);
  const parsed = retryableBootstrap(new Error(output.join("")));
  assert.deepEqual(parsed, { code: "E404", attempts: 3 });
  assert.match(bootstrapFailureMessage(parsed!), /agent did not start.*Retry starting/i);
  assert.ok(!bootstrapFailureMessage(parsed!).includes("registry.npmjs.org"));
});

for (const [label, text] of [
  ["outside the bb install phase", missing],
  ["private registry 404", installing + "npm error code E404\nnpm error GET https://registry.example.invalid/pkg/-/pkg-1.tgz\n"],
  ["manifest 404", installing + "npm error code E404\nnpm error GET https://registry.npmjs.org/example-pkg\n"],
  ["auth failure", installing + missing + "npm error code E401\n"],
  ["integrity mismatch", installing + missing + "npm error code EINTEGRITY\n"],
  ["permissions", installing + "npm error code ECONNRESET\nnpm error EACCES permission denied\n"],
  ["disk full", installing + "npm error code ETIMEDOUT\nnpm error ENOSPC\n"],
  ["engine mismatch", installing + "npm error code ETARGET\nnpm warn EBADENGINE\n"],
  ["native build error", installing + "npm error code 1\nnode-gyp failed\n"],
  ["a different terminal npm error", installing + missing + "npm error code EINVALIDPACKAGENAME\n"],
  ["post-install failure", installing + missing + "✓ Installed the server's bb-app build\nConnection failed\n"],
] as const) test(`does not retry ${label}`, async () => {
  let calls = 0; const output: string[] = []; const time = clock();
  const result = await bootstrapExecutor({ async exec(r) { calls++; r.onOutput(text); return { exitCode: 1 }; } }, { log() { assert.fail("Unexpected retry"); } }, time).exec(request(output));
  assert.equal(result.exitCode, 1); assert.equal(calls, 1); assert.deepEqual(time.pauses, []);
  assert.equal(retryableBootstrap(new Error(output.join(""))), null);
});

test("SSH exceptions and machine connection failures are not npm retries", async () => {
  let calls = 0;
  const executor = bootstrapExecutor({ async exec(r) { calls++; r.onOutput(installing + missing); throw new Error("SSH transport failed"); } }, { log() { assert.fail(); } });
  await assert.rejects(executor.exec(request([])), /SSH transport failed/); assert.equal(calls, 1);
});

test("a permanent second failure stops recovery without inheriting the first retryable error", async () => {
  let calls = 0; const output: string[] = []; const time = clock();
  await bootstrapExecutor({ async exec(r) { calls++; r.onOutput(installing + (calls === 1 ? missing : "npm error code EACCES\n")); return { exitCode: 1 }; } }, { log() {} }, time).exec(request(output));
  assert.equal(calls, 2); assert.deepEqual(time.pauses, [30_000]); assert.equal(retryableBootstrap(new Error(output.join(""))), null);
});

test("already aborted bootstrap never invokes its executor", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(bootstrapExecutor({ async exec() { assert.fail(); } }, { log() {} }).exec(request([], controller.signal)), { name: "AbortError" });
});

test("cancel during backoff stops immediately without another command", async () => {
  const controller = new AbortController(); let calls = 0;
  const executor = bootstrapExecutor({ async exec(r) { calls++; r.onOutput(installing + missing); return { exitCode: 1 }; } }, { log() { controller.abort(); } });
  await assert.rejects(executor.exec(request([], controller.signal)), { name: "AbortError" }); assert.equal(calls, 1);
});

test("cancel while the command finishes cannot be treated as success or trigger retry", async () => {
  const controller = new AbortController(); let calls = 0;
  const executor = bootstrapExecutor({ async exec(r) { calls++; r.onOutput(installing + missing); controller.abort(); return { exitCode: 0 }; } }, { log() { assert.fail(); } });
  await assert.rejects(executor.exec(request([], controller.signal)), { name: "AbortError" }); assert.equal(calls, 1);
});

test("retry backoff cannot extend the SDK command deadline", async () => {
  const output: string[] = [], budgets: number[] = []; const time = clock();
  const executor = bootstrapExecutor({ async exec(r) { budgets.push(r.timeoutMs); time.advance(1000); r.onOutput(installing + missing); return { exitCode: 1 }; } }, { log() {} }, time);
  await executor.exec({ ...request(output), timeoutMs: 35_000 });
  assert.deepEqual(budgets, [35_000, 4000]); assert.deepEqual(time.pauses, [30_000]);
  assert.deepEqual(retryableBootstrap(new Error(output.join(""))), { code: "E404", attempts: 2 });
});

test("a delayed timer cannot start another attempt after the deadline", async () => {
  const output: string[] = []; const time = clock(); let calls = 0;
  await bootstrapExecutor({ async exec(r) { calls++; r.onOutput(installing + missing); return { exitCode: 1 }; } }, { log() {} }, { now: time.now, async wait() { time.advance(600_001); } }).exec(request(output));
  assert.equal(calls, 1); assert.deepEqual(retryableBootstrap(new Error(output.join(""))), { code: "E404", attempts: 1 });
});

test("streaming evidence handles ANSI, split chunks and oversized lines without replaying input", () => {
  const evidence = new BootstrapNpmEvidence();
  for (const text of ["x".repeat(30_000) + "\n", "\x1b[32m" + installing + "\x1b[0m", ...missing]) evidence.output(text);
  assert.equal(evidence.failureCode(), "E404");
  assert.equal(retryableBootstrap("[bootstrap_retryable:EINTEGRITY:3]"), null);
  assert.equal(retryableBootstrap("[bootstrap_retryable:E404:4]"), null);
});

test("real SSH adapter replays only a local fake bootstrap process, on the same sandbox", async t => {
  const dir = mkdtempSync(join(tmpdir(), "boat-bootstrap-test-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, "fake-boat"); const attempts = join(dir, "calls.json");
  writeFileSync(binary, `#!/usr/bin/env node\nconst fs=require('node:fs');const file=${JSON.stringify(attempts)};const calls=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[];let stdin='';process.stdin.on('data',s=>stdin+=s);process.stdin.on('end',()=>{calls.push({args:process.argv.slice(2),stdin});fs.writeFileSync(file,JSON.stringify(calls));console.log(${JSON.stringify(installing)});if(calls.length<3){console.error(${JSON.stringify(missing)});process.exitCode=1}else console.log("Installed the server's bb-app build")});\n`);
  chmodSync(binary, 0o755);
  const adapter = sshExecutor({ binary: async () => binary } as unknown as BoatCli, "bx_fakebootstrap");
  const output: string[] = []; const initial = request(output);
  assert.equal((await bootstrapExecutor(adapter, { log() {} }, clock()).exec(initial)).exitCode, 0);
  const { readFileSync } = await import("node:fs");
  const calls = JSON.parse(readFileSync(attempts, "utf8")); assert.equal(calls.length, 3);
  for (const call of calls) { assert.equal(call.args[0], "ssh"); assert.equal(call.args[1], "bx_fakebootstrap"); assert.equal(call.stdin, initial.stdin); assert.deepEqual(call.args, calls[0].args); }
});

test("SSH adapter checks cancellation after asynchronous binary discovery", async () => {
  const controller = new AbortController();
  const adapter = sshExecutor({ async binary() { controller.abort(); return "/does-not-exist/fake-boat"; } } as unknown as BoatCli, "bx_fakebootstrap");
  await assert.rejects(adapter.exec(request([], controller.signal)), { name: "AbortError" });
});
