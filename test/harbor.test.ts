import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import harbor from "../harbor/server.ts";
import boat from "../server.ts";
import { createTestHost } from "./fakes.ts";

async function serve(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

test("harbor forwards argv and invoking context unchanged, and preserves output and exit status", async t => {
  const argv = ["sandbox", "exec", "bx_1", "--", "printf", "bb boat --help", "$(literal)"];
  const expected = { exitCode: 7, stdout: "bb boat data\n", stderr: "a failure\n" };
  let calls = 0;
  const loopbackBaseUrl = await serve(t, (req, res) => {
    void (async () => {
      calls++;
      assert.equal(req.url, "/api/v1/plugins/boat/cli");
      assert.equal(req.method, "POST");
      assert.deepEqual(await body(req), { argv, cwd: "/work/my-env", threadId: "thr_invoker", projectId: "proj_invoker" });
      res.writeHead(200, { "content-type": "application/json" });
      // bb keeps long CLI responses alive with whitespace before the result.
      res.write("\n\n");
      res.end(JSON.stringify(expected));
    })().catch(error => { res.destroy(error); });
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "harbor", loopbackBaseUrl });
  t.after(() => harness.lifecycle.dispose());
  harbor(bb);
  assert.equal(harness.registrations.cli?.name, "harbor");
  assert.deepEqual(await harness.runCli(argv, { cwd: "/work/my-env", threadId: "thr_invoker", projectId: "proj_invoker" }), expected);
  assert.equal(calls, 1, "a failed mutation must never be retried");
});

test("harbor uses its own name in help and errors, keeping boat, JSON and saved state intact", async t => {
  process.env.FAKE_BOAT_STATE = join(mkdtempSync(join(tmpdir(), "harbor-test-")), "state.json");
  const main = await createTestHost({ pluginId: "boat", settings: {
    boatPath: fileURLToPath(new URL("../src/providers/boat/fixtures/fake-boat.mjs", import.meta.url)),
    evidenceUploader: "",
  } });
  t.after(() => main.harness.lifecycle.dispose());
  await boat(main.bb);
  const loopbackBaseUrl = await serve(t, (req, res) => {
    void (async () => {
      const { argv, ...ctx } = await body(req);
      res.end(JSON.stringify(await main.harness.runCli(argv, ctx)));
    })().catch(error => { res.destroy(error); });
  });
  const alias = createFakePluginHost({ pluginId: "harbor", loopbackBaseUrl });
  t.after(() => alias.harness.lifecycle.dispose());
  harbor(alias.bb);
  for (const argv of [
    [], ["--json"], ["--help"], ["-h"], ["help", "task"],
    ["task", "start", "--help"], ["sandbox", "exec", "--help"],
    ["project", "list", "--json"], ["task", "show", "t_missing", "--json"],
    ["project", "list", "--unknown"], ["project", "list", "--unknown", "--json"],
    ["task", "start", "--title", "x"], ["not-a-command"],
    ["project", "add", "--name", "Unsafe", "--repo", "acme/web@main", "--size", "xlarge", "--json"],
  ]) {
    const ctx = { threadId: "thr_invoker" };
    const direct = await main.harness.runCli(argv, ctx);
    const forwarded = await alias.harness.runCli(argv, ctx);
    const help = direct.stdout.startsWith("bb boat");
    if (help) assert.match(forwarded.stdout, /^bb harbor\b/);
    assert.deepEqual(forwarded, {
      ...direct,
      stdout: help ? direct.stdout.replaceAll("bb boat", "bb harbor") : direct.stdout,
      stderr: direct.stderr.replaceAll("bb boat", "bb harbor"),
    }, argv.join(" "));
    assert.deepEqual(await main.harness.runCli(argv, ctx), direct, "boat output stays unchanged");
    if (argv.includes("--unknown") || argv.includes("t_missing") || argv.includes("xlarge")) assert.notEqual(direct.exitCode, 0);
    if (argv.includes("xlarge")) assert.equal(JSON.parse(direct.stdout).error.code, "size_needs_approval");
  }
  const added = await alias.harness.runCli(["project", "add", "--name", "Web", "--repo", "acme/web@main", "--json"]);
  assert.equal(added.exitCode, 0, added.stderr);
  const fromBoat = await main.harness.runCli(["project", "list", "--json"]);
  assert.match(fromBoat.stdout, /acme\/web/);
  assert.deepEqual(await alias.harness.runCli(["project", "list", "--json"]), fromBoat);
  assert.equal(main.harness.registrations.cli?.name, "boat");
});

test("harbor leaves command data, JSON and quoted error values unchanged", async t => {
  const payload = "bb boat\nUsage:\n  bb boat sandbox exec\n`bb boat`\nboat.dev bb boatyard\n";
  let expected = { exitCode: 0, stdout: payload, stderr: payload };
  const loopbackBaseUrl = await serve(t, (_req, res) => res.end(JSON.stringify(expected)));
  const { bb, harness } = createFakePluginHost({ pluginId: "harbor", loopbackBaseUrl });
  t.after(() => harness.lifecycle.dispose());
  harbor(bb);
  assert.deepEqual(await harness.runCli(["task", "events", "t_1"]), expected);
  expected = { exitCode: 1, stdout: JSON.stringify({ error: { message: payload, hint: "bb boat --help" } }), stderr: 'No project `bb boat` exists.\n' };
  assert.deepEqual(await harness.runCli(["project", "show", "bb boat", "--json"]), expected);
  expected = { exitCode: 7, stdout: payload, stderr: payload };
  assert.deepEqual(await harness.runCli(["sandbox", "exec", "bx_1", "--", "printf", "--help"]), expected);
});

test("harbor companion and main plugin versions stay in sync", () => {
  const manifest = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  assert.equal(manifest("../harbor/package.json").version, manifest("../package.json").version);
});

test("harbor reports malformed endpoints in JSON, without retrying", async t => {
  for (const response of ["not JSON", '{"exitCode":0,"stdout":42}', '{"ok":false,"error":"unavailable"}']) {
    let calls = 0;
    const loopbackBaseUrl = await serve(t, (_req, res) => { calls++; res.end(response); });
    const { bb, harness } = createFakePluginHost({ pluginId: "harbor", loopbackBaseUrl });
    t.after(() => harness.lifecycle.dispose());
    harbor(bb);
    const result = await harness.runCli(["status", "--json"]);
    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.stdout).error.code, "harbor_unavailable");
    assert.match(result.stderr, /boat plugin.*enabled/);
    assert.equal(calls, 1);
  }
});

test("harbor preserves the host error for a missing main plugin", async t => {
  const expected = { exitCode: 1, stdout: "", stderr: 'unknown plugin "boat"' };
  const loopbackBaseUrl = await serve(t, (_req, res) => res.end(JSON.stringify(expected)));
  const { bb, harness } = createFakePluginHost({ pluginId: "harbor", loopbackBaseUrl });
  t.after(() => harness.lifecycle.dispose());
  harbor(bb);
  assert.deepEqual(await harness.runCli(["status"]), expected);
});

test("harbor reports connection failures in text", async t => {
  const loopbackBaseUrl = await serve(t, (_req, res) => res.destroy());
  const { bb, harness } = createFakePluginHost({ pluginId: "harbor", loopbackBaseUrl });
  t.after(() => harness.lifecycle.dispose());
  harbor(bb);
  const result = await harness.runCli(["status"]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /boat plugin.*enabled/);
});

test("harbor passes cancellation through to the CLI request", { timeout: 10_000 }, async t => {
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  let arrived!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; });
  const loopbackBaseUrl = await serve(t, (_req, res) => {
    res.on("close", closed);
    res.writeHead(200, { "content-type": "application/json" });
    res.write("\n");
    arrived();
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "harbor", loopbackBaseUrl });
  t.after(() => harness.lifecycle.dispose());
  harbor(bb);
  const controller = new AbortController();
  const result = harness.runCli(["task", "wait", "--json"], { signal: controller.signal });
  await started;
  controller.abort();
  const cancelled = await result;
  assert.equal(cancelled.exitCode, 1);
  assert.equal(cancelled.stderr, "Cancelled.\n");
  assert.deepEqual(JSON.parse(cancelled.stdout), { ok: false, error: { code: "cancelled", message: "Cancelled." } });
  await disconnected;
  assert.equal((await harness.runCli(["task", "wait"], { signal: controller.signal })).stderr, "Cancelled.\n");
});
