// P5 through the whole plugin and a scripted boat CLI: snapshots and --from,
// boat host and preview wake, project settings, and shipping from chat.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import plugin from "../server.ts";
import { createTestHost } from "./fakes.ts";

const fakeBoat = fileURLToPath(new URL("./fixtures/fake-boat.mjs", import.meta.url));

const REPORT = `Done.
=== REPORT ===
STATUS: done
PR: none
BRANCH: boat/x
SUMMARY: Sticky header.
TESTS: ok
PREVIEW: port=4321 path=/projects cmd="npm run dev -- --host 0.0.0.0 --port 4321"
OPEN QUESTIONS: none
=== END REPORT ===`;

async function setup(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), "boat-p5-test-"));
  const statePath = join(dir, "state.json");
  process.env.FAKE_BOAT_STATE = statePath;
  process.env.BOAT_PLUGIN_PREVIEW_CHECK = "up";
  const { bb, harness } = await createTestHost({
    pluginId: "boat",
    settings: { boatPath: fakeBoat, evidenceUploader: "" },
    agentSkillIds: ["boat", "boat-orchestrator"],
  });
  t.after(async () => {
    delete process.env.BOAT_PLUGIN_PREVIEW_CHECK;
    await harness.lifecycle.dispose();
  });
  harness.sdk.stub("threads.get", async () => ({ id: "thr_orch", environmentId: null, deletedAt: null, archivedAt: null }));
  harness.sdk.stub("threads.send", async () => ({ ok: true, delivery: "sent" }));
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "orchestrator" }));
  harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
  await plugin(bb);
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const edit = (change: (current: Record<string, any>) => void) => {
    const current = state();
    change(current);
    writeFileSync(statePath, JSON.stringify(current));
  };
  const finishAll = (reply: string) =>
    edit((current) => {
      for (const convo of Object.values(current.convos) as { running: boolean; reply: string | null; sandboxId: string }[]) {
        convo.running = false;
        convo.reply = reply;
        current.sandboxes[convo.sandboxId].state = "idle";
      }
    });
  return { harness, state, edit, finishAll };
}

test("snapshots: save, list, start from one, and plain errors", async (t) => {
  const { harness, state, edit } = await setup(t);
  const made = await harness.runCli(["sandbox", "new", "--json"]);
  assert.equal(made.exitCode, 0, made.stderr);
  const sandboxId = (JSON.parse(made.stdout) as { sandbox?: { id: string }; id?: string }).sandbox?.id ?? JSON.parse(made.stdout).id;
  const saved = await harness.runCli(["sandbox", "snapshot", sandboxId, "storefront-ready"]);
  assert.equal(saved.exitCode, 0, saved.stderr);
  assert.match(saved.stdout, /Saved storefront-ready \(6 MB\)/);
  const listed = await harness.runCli(["sandbox", "snapshots"]);
  assert.match(listed.stdout, /storefront-ready  small  6 MB/);
  assert.match(listed.stdout, /1 of 10 included snapshots used\./);

  const started = await harness.runCli(["task", "start", "--title", "From a snapshot", "--repo", "acme/web", "--brief", "Do it.", "--snapshot", "storefront-ready", "--json"], { threadId: "thr_orch" });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  const newCall = (state().calls as string[][]).filter((call) => call[0] === "new").at(-1)!;
  assert.equal(newCall[newCall.indexOf("--from") + 1], "storefront-ready");

  // Free a slot (the fake plan has two).
  edit((current) => {
    current.sandboxes[sandboxId].state = "stopped";
  });
  const missing = await harness.runCli(["task", "start", "--title", "Nope", "--repo", "acme/web", "--brief", "Do it.", "--snapshot", "no-such", "--json"], { threadId: "thr_orch" });
  assert.notEqual(missing.exitCode, 0);
  assert.match(`${missing.stdout}${missing.stderr}`, /There's no saved snapshot "no-such"/);

  edit((current) => {
    current.snapshotsDisabled = true;
  });
  const trial = await harness.runCli(["sandbox", "snapshots"]);
  assert.notEqual(trial.exitCode, 0);
  assert.match(`${trial.stdout}${trial.stderr}`, /Saved snapshots need a paid boat plan; the trial doesn't have them/);
});

test("a reported preview becomes a private boat host link, and Wake brings a stopped one back", async (t) => {
  const { harness, state, edit, finishAll } = await setup(t);
  const started = await harness.runCli(["task", "start", "--title", "Sticky header", "--repo", "acme/web", "--brief", "Do it.", "--json"], { threadId: "thr_orch" });
  const { task } = JSON.parse(started.stdout) as { task: { id: string; sandboxId: string } };
  finishAll(REPORT);
  await harness.runCli(["task", "show", task.id, "--refresh"]);
  const hostCall = (state().calls as string[][]).find((call) => call[0] === "host")!;
  assert.deepEqual(hostCall, ["host", "--json", task.sandboxId, "4321", "--private", "--title", "Sticky header"]);

  const list = await harness.runCli(["preview", "list", "--all"]);
  assert.match(list.stdout, new RegExp(`p_[0-9a-f]+  live  ${task.id} "Sticky header"  port 4321`));
  assert.match(list.stdout, new RegExp(`https://${task.sandboxId}-4321\\.on\\.boat\\.dev/projects\\?_token=tok_${task.sandboxId}`));
  const previewId = list.stdout.match(/p_[0-9a-f]+/)![0];
  // The notice names it.
  const notice = harness.inspection.sdk.callsTo("threads.send").map((call) => (call[0] as { input: { text: string }[] }).input[0]!.text).find((text) => text.includes(task.id))!;
  assert.match(notice, /\nPreview: https:\/\/.*-4321\.on\.boat\.dev\/projects\?_token=/);
  // The task page and the board carry it too.
  const board = (await harness.callRpc("board", { threadId: null })) as { running: { id: string; previewUrl: string | null }[]; ready: { id: string; previewUrl: string | null }[] };
  assert.match([...board.running, ...board.ready].find((entry) => entry.id === task.id)!.previewUrl ?? "", /\/projects\?_token=/);

  // The sandbox stops; the preview sleeps; Wake resumes it, restarts the server and hosts it again.
  edit((current) => {
    current.sandboxes[task.sandboxId].state = "stopped";
  });
  const sleeping = (await harness.callRpc("previews", { threadId: null, taskId: task.id })) as { previews: { state: string; canRestart: boolean }[] };
  assert.equal(sleeping.previews[0]!.state, "sleeping");
  assert.equal(sleeping.previews[0]!.canRestart, true);
  const woken = (await harness.callRpc("previewAction", { id: previewId, action: "wake" })) as { preview: { state: string; link: string } };
  assert.equal(woken.preview.state, "live");
  const calls = state().calls as string[][];
  assert.ok(calls.some((call) => call[0] === "resume" && call[2] === task.sandboxId));
  assert.equal(calls.filter((call) => call[0] === "host").length, 2);
  // Extend: on the trial, only up to the auto-stop cap boat reports ("auto-stop max 2h").
  const extended = await harness.runCli(["preview", "extend", previewId, "--hours", "3"]);
  assert.equal(extended.exitCode, 0, extended.stderr);
  assert.deepEqual(state().extended.at(-1), { id: task.sandboxId, ttl: "7200" });
  assert.match(extended.stdout, /stays on for 2 more hours \(your boat plan's auto-stop cap\)/);
  // A plan without a cap gets the hours asked for.
  edit((current) => {
    current.accessTier = "standard";
    current.trialLine = null;
  });
  const longer = await harness.runCli(["preview", "extend", previewId, "--hours", "3"]);
  assert.equal(longer.exitCode, 0, longer.stderr);
  assert.deepEqual(state().extended.at(-1), { id: task.sandboxId, ttl: "10800" });
  assert.match(longer.stdout, /stays on for 3 more hours\.$/m);
});

test("a project that ships after approval: set it, then ship only on the user's word in chat", async (t) => {
  const { harness, state, finishAll } = await setup(t);
  const added = await harness.runCli(["project", "add", "--name", "Storefront", "--repo", "acme/storefront@master", "--environment", "storefront"]);
  assert.equal(added.exitCode, 0, added.stderr);
  const set = await harness.runCli(["project", "set", "storefront", "--delivery", "push"]);
  assert.equal(set.exitCode, 0, set.stderr);
  assert.match(set.stdout, /storefront  Storefront .* ships after approval/);
  const started = await harness.runCli(["task", "start", "--project", "storefront", "--title", "Sticky header", "--brief", "Do it.", "--json"], { threadId: "thr_orch" });
  assert.equal(started.exitCode, 0, started.stderr || started.stdout);
  const { task } = JSON.parse(started.stdout) as { task: { id: string; sandboxId: string; delivery: string } };
  assert.equal(task.delivery, "push");
  // The worker's checkout refuses pushes.
  const prepare = (state().calls as string[][]).find((call) => call[0] === "exec" && call.at(-1)!.includes("BOAT_SETUP"))!;
  assert.match(prepare.at(-1)!, /boat-no-push/);
  finishAll(REPORT);
  await harness.runCli(["task", "show", task.id, "--refresh"]);

  // Only the notice since: the orchestrator can't ship on its own.
  let outline = [{ id: "m1", role: "user", preview: "Make the header sticky", attachmentSummary: null }, { id: "m2", role: "user", preview: `[boat] Task ${task.id} finished a turn.`, attachmentSummary: null }];
  harness.sdk.stub("threads.conversationOutline", async () => ({ items: outline, maxSeq: 2 }));
  const refused = await harness.runCli(["task", "ship", task.id], { threadId: "thr_orch" });
  assert.notEqual(refused.exitCode, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /Not shipped: the user hasn't written in this chat since the task's work was reported/);
  const tool = await harness.callAgentTool("boat_ship", { task_id: task.id }, { threadId: "thr_orch" });
  assert.match(JSON.stringify(tool), /Not shipped/);

  // The user says ship it.
  outline = [...outline, { id: "m3", role: "user", preview: "Looks good, ship it", attachmentSummary: null }];
  // Not without a chat (any agent can drop its thread id), and not from another chat.
  const bare = await harness.runCli(["task", "ship", task.id]);
  assert.notEqual(bare.exitCode, 0);
  assert.match(`${bare.stdout}${bare.stderr}`, /only the task's orchestrator chat can ship or discard it/);
  const elsewhere = await harness.runCli(["task", "ship", task.id], { threadId: "thr_other" });
  assert.match(`${elsewhere.stdout}${elsewhere.stderr}`, /this chat isn't the task's orchestrator/);
  const shipped = await harness.runCli(["task", "ship", task.id], { threadId: "thr_orch" });
  assert.equal(shipped.exitCode, 0, shipped.stderr || shipped.stdout);
  assert.match(shipped.stdout, /Shipped 2 commits to master \(abcdef1\)\.\nTask t_[0-9a-f]+ is closed; its sandbox is deleted\./);
  const shipScript = (state().ships as { script: string }[]).at(-1)!.script;
  assert.match(shipScript, /git rebase --quiet 'origin\/master'/);
  assert.match(shipScript, /git push --no-verify --quiet origin 'HEAD:refs\/heads\/master'/);
  assert.doesNotMatch(shipScript, /--force/);
});
