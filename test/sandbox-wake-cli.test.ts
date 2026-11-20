// `bb boat sandbox wake` through the whole plugin and the scripted boat CLI: the dry run on a
// stuck sandbox, --json, the start limit with and without --allow-paid-start, and the exit codes.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import plugin from "../server.ts";
import { createTestHost } from "./fakes.ts";

const fakeBoat = fileURLToPath(new URL("../src/providers/boat/fixtures/fake-boat.mjs", import.meta.url));
const HYDRATOR = "[lazyfs] [ERROR] HYDRATOR FAILED attempt 32 (mount stays up, on-demand serving continues, retrying …): decode/feed: chunk 1 GET 0000.tar.zst: status code 503";

async function setup(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), "boat-wake-test-"));
  const statePath = join(dir, "state.json");
  process.env.FAKE_BOAT_STATE = statePath;
  const { bb, harness } = await createTestHost({ pluginId: "boat", settings: { boatPath: fakeBoat, evidenceUploader: "" }, agentSkillIds: ["boat", "boat-orchestrator", "boat-sandbox-wake"] });
  t.after(async () => {
    await harness.lifecycle.dispose();
  });
  harness.sdk.stub("hosts.list", async () => []);
  await plugin(bb);
  const made = await harness.runCli(["sandbox", "new", "--json"]);
  assert.equal(made.exitCode, 0, made.stderr);
  const sandboxId = (JSON.parse(made.stdout) as { sandbox: { id: string } }).sandbox.id;
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const edit = (change: (current: Record<string, any>) => void) => {
    const current = state();
    change(current);
    writeFileSync(statePath, JSON.stringify(current));
  };
  const calls = () => (state().calls as string[][]).map((call) => call[0]);
  return { harness, sandboxId, state, edit, calls };
}

test("bb boat sandbox wake --dry-run on a stuck sandbox: the diagnosis and the plan, nothing changed", async (t) => {
  const { harness, sandboxId, edit, calls, state } = await setup(t);
  edit((current) => {
    current.diskCheck = `BOAT_HYDRATOR ${HYDRATOR}\nBOAT_DISK fail .profile head: error reading '/home/user/.profile': Input/output error\nBOAT_DISK_END\n`;
  });
  const before = calls().length;
  const result = await harness.runCli(["sandbox", "wake", sandboxId, "--dry-run"]);
  assert.equal(result.exitCode, 0, result.stdout + (result.stderr ?? ""));
  assert.match(result.stdout, new RegExp(`^Dry run for sandbox ${sandboxId}: nothing was changed\\.`));
  assert.match(result.stdout, /· boat\.dev can't restore this sandbox's disk \(HYDRATOR FAILED attempt 32 .*status code 503\)\./);
  assert.match(result.stdout, /→ Stop it with a plain boat stop \(a fresh snapshot, nothing lost\), follow that stop, and start it again/);
  // No bb machine is known there: Boat can't see which chats run there, so it wouldn't force a stop.
  assert.match(result.stdout, /If boat refuses the plain stop, Harbormaster won't force it: Harbormaster couldn't see which chats run there\./);
  assert.match(result.stdout, /→ Start it again: an included boat start \(20 left this hour\), with a wake slot free now\./);
  // Only reads: no stop, resume or delete reached boat.
  const made = calls().slice(before);
  assert.ok(made.every((call) => ["info", "limits", "exec", "list"].includes(call!)), made.join(", "));
  assert.equal(state().sandboxes[sandboxId].state, "idle");

  const json = await harness.runCli(["sandbox", "wake", sandboxId, "--dry-run", "--json"]);
  assert.equal(json.exitCode, 0);
  const report = JSON.parse(json.stdout) as { outcome: string; dryRun: boolean; route: { problem: string; action: string }; target: { kind: string; sandboxId: string } };
  assert.equal(report.outcome, "planned");
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.route && { problem: report.route.problem, action: report.route.action }, { problem: "disk-unreadable", action: "stop-and-start" });
  assert.deepEqual(report.target.kind, "sandbox");
});

test("bb boat sandbox wake: no paid extra start without --allow-paid-start (exit 1, Needs you)", async (t) => {
  const { harness, sandboxId, edit, calls } = await setup(t);
  edit((current) => {
    current.sandboxes[sandboxId].state = "stopped";
    current.starts = { day: { remaining: 0, limit: 75 }, hour: { remaining: 0 } };
    current.extraStarts = true;
    current.nextStartDollars = 0.03;
  });
  const refused = await harness.runCli(["sandbox", "wake", sandboxId]);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stdout, /\nNeeds you: No included boat start is left today or this hour, so this start would be a paid extra start \(about \$0\.03\)\. Run it again with --allow-paid-start once the user agrees/);
  assert.ok(!calls().includes("resume"));

  const planned = await harness.runCli(["sandbox", "wake", sandboxId, "--allow-paid-start", "--dry-run"]);
  assert.equal(planned.exitCode, 0, planned.stdout);
  assert.match(planned.stdout, /→ Resume it: a paid extra start \(about \$0\.03\), allowed with --allow-paid-start, with a wake slot free now\./);

  // Paid extra starts off: no start, whatever the flag (Boat never turns them on).
  edit((current) => {
    current.extraStarts = false;
    current.nextStartDollars = 0;
  });
  const none = await harness.runCli(["sandbox", "wake", sandboxId, "--allow-paid-start"]);
  assert.equal(none.exitCode, 1);
  assert.match(none.stdout, /Needs you: No included boat start is left today or this hour, and boat's paid extra starts are off \(Harbormaster never turns them on\)/);
  assert.ok(!calls().includes("resume"));
});

test("bb boat sandbox wake resumes a stopped sandbox and brings it back", async (t) => {
  const { harness, sandboxId, edit, state } = await setup(t);
  edit((current) => {
    current.sandboxes[sandboxId].state = "stopped";
  });
  const result = await harness.runCli(["sandbox", "wake", sandboxId]);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /✓ Resumed the sandbox, with an included boat start/);
  assert.match(result.stdout, /✓ The sandbox looks healthy: its disk reads fine and nothing hangs\./);
  assert.match(result.stdout, /\nIt's back\.$/m);
  assert.equal(state().sandboxes[sandboxId].state, "idle");

  // --status: the last wake of that sandbox, and nothing started.
  const before = (state().calls as string[][]).length;
  const status = await harness.runCli(["sandbox", "wake", "--status", sandboxId]);
  assert.equal(status.exitCode, 0, status.stdout);
  assert.match(status.stdout, /✓ Resumed the sandbox, with an included boat start/);
  assert.match(status.stdout, /\nIt's back\.$/m);
  assert.equal((state().calls as string[][]).length, before, "--status asks boat nothing");
});

test("bb boat sandbox wake with an id that isn't a sandbox, task or chat: a plain error", async (t) => {
  const { harness } = await setup(t);
  harness.sdk.stub("threads.get", async () => {
    throw new Error("thread not found (404)");
  });
  const result = await harness.runCli(["sandbox", "wake", "thr_missing"]);
  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout}${result.stderr}`, /No sandbox, task or chat "thr_missing"/);
});
