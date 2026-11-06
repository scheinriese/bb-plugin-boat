// Sandbox sizes and memory through the service: the size line in prompts,
// out-of-memory kills when a turn fails, and a measured turn's peak.
import assert from "node:assert/strict";
import { test } from "node:test";
import { notificationText } from "../src/format.ts";
import { decodeData } from "../src/memory.ts";
import { testTaskInput } from "../src/setup.ts";
import { makeService, oomLines } from "./fakes.ts";

const REPORT = `Done.

=== REPORT ===
STATUS: done
PR: https://github.com/acme/web/pull/12
BRANCH: boat/x
SUMMARY: done
TESTS: ok
OPEN QUESTIONS: none
=== END REPORT ===`;

const TRIAL = [
  { type: "small", available: true, reason: null },
  { type: "default", available: true, reason: null },
  { type: "large", available: false, reason: "not during the free trial; the first payment unlocks it" },
  { type: "xlarge", available: false, reason: "needs the $100/month plan or higher" },
];

type Env = ReturnType<typeof makeService>;

async function start(env: Env, overrides: Record<string, unknown> = {}) {
  const { task } = await env.service.launchTask(
    {
      title: "Add dark mode",
      role: "implement",
      brief: "Add a dark mode toggle.",
      repo: "acme/web",
      orchestratorThreadId: "thr_orch",
      projectId: "proj_personal",
      ...overrides,
    },
    5_000,
  );
  return task;
}

const now = () => Date.now() / 1000;
const data = (env: Env, taskId: string, type: string) =>
  env.store
    .events(taskId, 1000)
    .filter((event) => event.kind === "memory-data")
    .map((event) => decodeData(event.text)!)
    .filter((entry) => entry.type === type);
const history = (env: Env, taskId: string, kind: string) => env.store.events(taskId, 1000).filter((event) => event.kind === kind).map((event) => event.text);
const probes = (env: Env) => env.boat.execs.filter((exec) => exec.script.includes("BOAT_MEM_PROBE"));

/** The notices a test's turn produced, as the orchestrator reads them. */
function notice(env: Env): string {
  const last = env.notifications.at(-1);
  assert.ok(last, "a notice went out");
  return notificationText(last.tasks.map((task) => env.store.get(task.id)!), (id) => env.store.events(id, 30));
}

test("every initial prompt says the sandbox's size, for both runners and reused sandboxes", async () => {
  const env = makeService();
  const task = await start(env);
  const prompt = env.boat.prompts[0]!.text;
  assert.match(prompt, /- This sandbox is Default size: 4 CPUs and 8 GB of memory, shared with other processes \(other tasks' checkouts, preview servers\)\. Run heavy test suites \(browser tests, full builds\) one at a time, not all at once\./);
  assert.deepEqual(history(env, task.id, "sandbox-size"), ["Sandbox size: Default (4 vCPU, 8 GB)"]);
  const [size] = data(env, task.id, "size");
  assert.equal(size?.type === "size" && size.oomKills, 0);
  assert.equal(size?.type === "size" && size.bootId, "0f3c1d2e-aaaa-bbbb-cccc-123456789abc");

  const chat = makeService({ chat: true });
  await start(chat);
  assert.match(chat.chat.spawns[0]!.prompt, /This sandbox is Default size: .*\(bb itself, other tasks' checkouts, preview servers\)\..*this chat included\./);

  // A sandbox the user lent: its real size, whatever the setting says.
  const reused = makeService();
  reused.boat.addSandbox("bx_mine", "large");
  await start(reused, { sandbox: "bx_mine" });
  assert.match(reused.boat.prompts[0]!.text, /This sandbox is Large size: 8 CPUs and 16 GB of memory/);
});

test("a review sharing its task's sandbox is told the size too; without a probe, the size asked for, else a general line", async () => {
  const env = makeService({ settings: { reviewSandbox: "same" } });
  const task = await start(env);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  const review = await env.service.launchTask(await env.service.reviewInput(task.id), 5_000);
  assert.equal(review.task.sandboxId, task.sandboxId);
  assert.match(env.boat.prompts.at(-1)!.text, /# Code review task[\s\S]*This sandbox is Default size/);

  const blind = makeService({ settings: { machineType: "large" } });
  blind.boat.probeBroken = true;
  const created = await start(blind);
  assert.match(blind.boat.prompts[0]!.text, /This sandbox is Large size/);
  assert.deepEqual(history(blind, created.id, "sandbox-size"), ["Sandbox size: Large (8 vCPU, 16 GB)"]);

  const unknown = makeService();
  unknown.boat.addSandbox("bx_mine", null);
  unknown.boat.probeBroken = true;
  await start(unknown, { sandbox: "bx_mine" });
  assert.match(unknown.boat.prompts[0]!.text, /- Other processes may share this sandbox's CPUs and memory/);
});

test("a probe that never answers doesn't hold up the dispatch", async () => {
  const env = makeService({ sizeTiming: { checkMs: 50 } });
  env.boat.probeHang = true;
  const started = Date.now();
  const task = await start(env);
  assert.equal(task.status, "running");
  assert.ok(Date.now() - started < 2_000);
  assert.match(env.boat.prompts[0]!.text, /This sandbox is Default size/);
});

test("a handover chat is told the size", async () => {
  const env = makeService({ chat: true });
  const task = await start(env);
  env.chat.finish(task.threadId!, REPORT);
  await env.service.syncChatThread(task.threadId!, { kind: "idle", text: REPORT, at: Date.now() });
  await env.service.followup(task.id, "Continue with the tests.", { provider: "codex" });
  assert.match(env.chat.spawns.at(-1)!.prompt, /# Taking over task[\s\S]*This sandbox is Default size/);
});

test("a headless turn that failed: out of memory says so, keeps the original error, and the notice says what to do", async () => {
  const env = makeService();
  const task = await start(env);
  env.boat.probe(task.sandboxId!).kernel = oomLines({ at: now() + 1, pid: 4242, comm: "claude", unit: "agent", rssKb: 2_000_000 });
  env.boat.probe(task.sandboxId!).oomKills = 1;
  env.boat.finish(task.conversationId!, "", "failed", "harness exited");
  await env.service.sweep();
  await env.service.sizes.settled();
  await env.service.deliverPending();
  const failed = env.store.get(task.id)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /^The sandbox ran out of memory: the system stopped Claude Code \(1\.9 GB\)\. Run fewer tests at once, or continue on a larger sandbox\./);
  assert.match(failed.error!, /\n\nOriginal error: harness exited$/);
  assert.deepEqual(history(env, task.id, "memory"), ["Out of memory: the system stopped Claude Code (1.9 GB)."]);
  const text = notice(env);
  assert.match(text, /Out of memory: The Default sandbox \(8 GB\) ran out of memory during this turn\./);
  assert.match(text, /`boat_followup` with `sandbox_size: "large"`/);
  assert.match(text, new RegExp(`bb boat task followup ${task.id} --type large`));
  assert.match(text, /Large costs twice as much per hour as Default/);
  assert.match(env.service.sizes.lines(failed).join("\n"), /Out of memory in the last turn: the system stopped Claude Code \(1\.9 GB\)\. Continue on a larger sandbox: bb boat task followup/);
});

test("a task chat that stopped with an error after bb's daemon lost a process", async () => {
  const env = makeService({ chat: true });
  const task = await start(env);
  env.boat.probe(task.sandboxId!).kernel = oomLines({ at: now() + 1, pid: 187709, comm: "MainThread", unit: "bb", rssKb: 1_470_104 });
  env.chat.finish(task.threadId!, "", "error");
  await env.service.syncChatThread(task.threadId!, { kind: "failed", error: "Thread interrupted because the host daemon disconnected", at: Date.now() });
  await env.service.sizes.settled();
  const failed = env.store.get(task.id)!;
  assert.match(
    failed.error!,
    /^The sandbox ran out of memory: the system stopped a 1\.4 GB process in the task chat \(MainThread\)\. That restarted bb on the sandbox and ended the chat's turn\. Run fewer tests at once, or continue on a larger sandbox\./,
  );
  const view = (await env.service.sizes.view(failed))!;
  assert.equal(view.oom?.cause, true);
  assert.match(view.oom!.original!, /host daemon disconnected/);
  assert.equal(view.next?.type, "large");
  assert.equal(view.next?.available, true);
  assert.equal(view.size?.label, "Default");
  assert.equal(view.canResize, true);
});

test("a turn that ended without a new message is checked too; a kill that isn't why it failed comes second", async () => {
  const env = makeService({ chat: true });
  const task = await start(env);
  env.boat.probe(task.sandboxId!).kernel = oomLines({ at: now() + 1, pid: 77, comm: "MainThread", unit: "bb", rssKb: 1_000_000 });
  env.chat.finish(task.threadId!, "");
  await env.service.syncChatThread(task.threadId!, { kind: "idle", text: "", at: Date.now() });
  await env.service.sizes.settled();
  assert.match(env.store.get(task.id)!.error!, /^The sandbox ran out of memory: the system stopped a 1\.0 GB process in the task chat/);

  // A test runner killed early, a turn that failed on something else.
  const other = makeService();
  const headless = await start(other);
  other.boat.probe(headless.sandboxId!).kernel = oomLines({ at: now() + 1, pid: 99, comm: "vitest", unit: "command", rssKb: 900_000 });
  other.boat.finish(headless.conversationId!, "", "failed", "API error 529: overloaded");
  await other.service.sweep();
  await other.service.sizes.settled();
  const error = other.store.get(headless.id)!.error!;
  assert.match(error, /^API error 529: overloaded\n\nThe sandbox also ran out of memory during this turn: the system stopped a 0\.9 GB process \(vitest\)\./);
  assert.equal((await other.service.sizes.view(other.store.get(headless.id)!))!.oom?.cause, false);
});

test("no kill, no claim: an unchanged counter and a quiet log leave the failure as it was", async () => {
  const env = makeService();
  const task = await start(env);
  env.boat.finish(task.conversationId!, "", "failed", "harness exited");
  await env.service.sweep();
  await env.service.sizes.settled();
  await env.service.deliverPending();
  assert.equal(env.store.get(task.id)!.error, "harness exited");
  assert.deepEqual(history(env, task.id, "memory"), []);
  assert.doesNotMatch(notice(env), /memory/i);

  // Kills from another task's earlier turn on the same sandbox, with an unreadable log: only a "may have".
  const blind = makeService();
  const first = await start(blind);
  blind.boat.probe(first.sandboxId!).klog = "none";
  blind.boat.probe(first.sandboxId!).oomKills = 2;
  blind.boat.finish(first.conversationId!, "", "failed", "harness exited");
  await blind.service.sweep();
  await blind.service.sizes.settled();
  assert.equal(blind.store.get(first.id)!.error, "harness exited");
  assert.match(history(blind, first.id, "memory")[0]!, /^The sandbox may have run out of memory/);
  assert.equal((await blind.service.sizes.view(blind.store.get(first.id)!))!.oom, null);
});

test("the check is capped: a probe that hangs never holds the failure or its notice for long", async () => {
  const env = makeService({ sizeTiming: { checkMs: 50 } });
  const task = await start(env);
  env.boat.probeHang = true;
  env.boat.finish(task.conversationId!, "", "failed", "harness exited");
  const started = Date.now();
  await env.service.sweep();
  await env.service.sizes.settled();
  await env.service.deliverPending();
  assert.ok(Date.now() - started < 1_000);
  assert.equal(env.store.get(task.id)!.status, "failed");
  assert.equal(env.notifications.length, 1);
  assert.deepEqual(history(env, task.id, "memory"), []);
  assert.ok(env.warnings.some((line) => /memory check/.test(line)));
});

test("a stopped sandbox isn't resumed to check it, and a finished turn of an unmeasured task isn't checked", async () => {
  const env = makeService({ chat: true });
  const task = await start(env);
  await env.boat.stop(task.sandboxId!);
  const before = probes(env).length;
  env.chat.finish(task.threadId!, "", "error");
  await env.service.syncChatThread(task.threadId!, { kind: "failed", error: "Thread interrupted", at: Date.now() });
  await env.service.sizes.settled();
  assert.equal(probes(env).length, before);
  assert.ok(!env.boat.calls.some((call) => call.startsWith("resume")));

  const ok = makeService();
  const fine = await start(ok);
  const count = probes(ok).length;
  ok.boat.finish(fine.conversationId!, REPORT);
  await ok.service.sweep();
  await ok.service.sizes.settled();
  assert.equal(ok.store.get(fine.id)!.status, "idle");
  assert.equal(probes(ok).length, count);
});

test("the notice waits for the check, then goes out once with the out-of-memory line", async () => {
  const env = makeService();
  const task = await start(env);
  env.boat.probe(task.sandboxId!).kernel = oomLines({ at: now() + 1, pid: 5, comm: "claude", unit: "agent", rssKb: 3_000_000 });
  let open: () => void = () => undefined;
  env.boat.probeGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  env.boat.finish(task.conversationId!, "", "failed", "harness exited");
  await env.service.sweep();
  await env.service.deliverPending();
  assert.equal(env.notifications.length, 0);
  assert.ok(env.service.sizes.holds(task.id));
  open();
  env.boat.probeGate = null;
  await env.service.sizes.settled();
  await env.service.deliverPending();
  assert.equal(env.notifications.length, 1);
  assert.match(notice(env), /Out of memory: The Default sandbox/);
});

test("the plan decides what the notice suggests", async () => {
  const trial = makeService({ plan: TRIAL });
  const task = await start(trial);
  trial.boat.probe(task.sandboxId!).kernel = oomLines({ at: now() + 1, pid: 5, comm: "claude", unit: "agent", rssKb: 3_000_000 });
  trial.boat.finish(task.conversationId!, "", "failed", "harness exited");
  await trial.service.sweep();
  await trial.service.sizes.settled();
  await trial.service.deliverPending();
  assert.match(trial.store.get(task.id)!.error!, /Run fewer tests at once \(your boat plan doesn't include a larger sandbox\)\./);
  assert.match(notice(trial), /Your boat plan doesn't include Large \(not during the free trial; the first payment unlocks it\), so ask the agent to run fewer tests at once, or ask the user about a bigger plan\./);
  assert.equal((await trial.service.sizes.view(trial.store.get(task.id)!))!.next?.available, false);

  const large = makeService({ settings: { machineType: "large" } });
  const big = await start(large);
  large.boat.probe(big.sandboxId!).kernel = oomLines({ at: now() + 1, pid: 5, comm: "claude", unit: "agent", rssKb: 3_000_000 });
  large.boat.finish(big.conversationId!, "", "failed", "harness exited");
  await large.service.sweep();
  await large.service.sizes.settled();
  await large.service.deliverPending();
  assert.match(notice(large), /only after the user's OK, move it to XLarge and continue: `boat_followup` with `sandbox_size: "xlarge"` and `user_approved`/);
});

test("two failing tasks on one sandbox: the notice suggests one move", async () => {
  const env = makeService({ settings: { reviewSandbox: "same" } });
  const task = await start(env);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  await env.service.deliverPending();
  const review = (await env.service.launchTask(await env.service.reviewInput(task.id), 5_000)).task;
  const followed = await env.service.followup(task.id, "Fix the flaky test.");
  env.boat.probe(task.sandboxId!).kernel = oomLines({ at: now() + 1, pid: 5, comm: "node", unit: "agent", rssKb: 3_000_000 });
  env.boat.finish(followed.conversationId!, "", "failed", "killed");
  env.boat.finish(review.conversationId!, "", "failed", "killed");
  await env.service.sweep();
  await env.service.sizes.settled();
  const text = notificationText([env.store.get(task.id)!, env.store.get(review.id)!], (id) => env.store.events(id, 30));
  assert.match(text, /`boat_followup` with `sandbox_size: "large"`/);
  assert.match(text, new RegExp(`Out of memory: same sandbox as ${task.id}\\. One \`boat_followup\` with \`sandbox_size\` on ${task.id} moves both`));
});

test("a measured turn records its peak and recommends a size", async () => {
  const env = makeService();
  const task = await start(env, { measureMemory: true });
  assert.equal(data(env, task.id, "watch").length, 1);
  assert.ok(env.boat.detached.some((entry) => entry.command.includes("/tmp/boat-memory/")));
  assert.ok(history(env, task.id, "memory").includes("Measuring peak memory during this turn."));
  const at = Math.floor(now());
  env.boat.probe(task.sandboxId!).peak = `6396314 8131944 120 ${at - 200} ${at} 0 4242`;
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  await env.service.sizes.settled();
  const done = env.store.get(task.id)!;
  assert.equal(done.status, "idle");
  assert.ok(history(env, task.id, "memory").includes("Peak memory during this turn: 6.1 of 8 GB. Recommended size: Large."));
  const view = (await env.service.sizes.view(done))!;
  assert.deepEqual(view.peak && { used: view.peak.usedGb, total: view.peak.totalGb, percent: view.peak.percent, shared: view.peak.shared }, { used: 6.1, total: 8, percent: 79, shared: false });
  assert.deepEqual(view.recommendation, { type: "large", label: "Large", current: "default", reason: "near-limit", allowed: true, planReason: null });
  // The probe stopped the sampler.
  assert.ok(probes(env).at(-1)!.script.includes(`touch /tmp/boat-memory/${task.id}.stop`));
  // Its later turns aren't measured.
  await env.service.followup(task.id, "One more thing.");
  const count = probes(env).length;
  env.boat.finish(env.store.get(task.id)!.conversationId!, REPORT);
  await env.service.sweep();
  await env.service.sizes.settled();
  assert.equal(probes(env).length, count);
});

test("the test task measures too; without measuring, no sampler; a lost sampler leaves the out-of-memory finding", async () => {
  const env = makeService();
  const { task } = await env.service.launchTask(testTaskInput("thr_orch"), 5_000);
  assert.equal(env.boat.created[0]!.type, "small");
  const at = Math.floor(now());
  env.boat.probe(task.sandboxId!).peak = `3200000 4065972 60 ${at - 100} ${at}`;
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  await env.service.sizes.settled();
  const view = (await env.service.sizes.view(env.store.get(task.id)!))!;
  assert.equal(view.recommendation?.type, "default");
  assert.equal(view.recommendation?.reason, "near-limit");

  const plain = makeService();
  await start(plain);
  assert.equal(plain.boat.detached.length, 0);

  const lost = makeService();
  const measured = await start(lost, { measureMemory: true });
  lost.boat.probe(measured.sandboxId!).kernel = oomLines({ at: now() + 1, pid: 5, comm: "claude", unit: "agent", rssKb: 3_000_000 });
  lost.boat.finish(measured.conversationId!, "", "failed", "harness exited");
  await lost.service.sweep();
  await lost.service.sizes.settled();
  const after = (await lost.service.sizes.view(lost.store.get(measured.id)!))!;
  assert.equal(after.peak, null);
  assert.ok(after.oom);
  assert.ok(history(lost, measured.id, "memory").includes("Couldn't measure peak memory during this turn (the measurement stopped early)."));
});

test("the project offer appears only for a stored project whose size differs", async () => {
  const env = makeService({ projects: [{ id: "web", name: "Web app", repos: [{ repo: "acme/web" }], machineType: null }] });
  const task = await start(env, { measureMemory: true });
  const at = Math.floor(now());
  env.boat.probe(task.sandboxId!).peak = `6396314 8131944 120 ${at - 200} ${at}`;
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  await env.service.sizes.settled();
  const view = (await env.service.sizes.view(env.store.get(task.id)!))!;
  assert.deepEqual(view.project, { id: "web", name: "Web app", machineType: null, effective: "default" });
  env.setProjects([{ id: "web", name: "Web app", repos: [{ repo: "acme/web" }], machineType: "large" }]);
  assert.equal((await env.service.sizes.view(env.store.get(task.id)!))!.project?.effective, "large");
  // A repo outside every project: no project to offer.
  const none = makeService();
  const other = await start(none, { repo: "acme/other" });
  assert.equal((await none.service.sizes.view(other))!.project, null);
});

test("after a stop and resume: a way to read the log from the old boot isn't trusted, and the new boot's counter counts", async () => {
  const env = makeService();
  const task = await start(env);
  const sandboxId = task.sandboxId!;
  // First failure: the journal reads (and the plugin remembers that, for this boot).
  env.boat.finish(task.conversationId!, "", "failed", "harness exited");
  await env.service.sweep();
  await env.service.sizes.settled();
  assert.deepEqual(history(env, task.id, "memory"), []);
  // An idle stop, then a follow-up resumes it: a new boot whose journal this user can't read.
  await env.boat.stop(sandboxId);
  await env.service.followup(task.id, "Try again.");
  assert.ok(env.boat.calls.includes(`resume ${sandboxId} ttl=7200`));
  const boot = env.boat.probe(sandboxId);
  boot.klog = "none";
  boot.bootTime = Math.floor(now()) - 60;
  boot.oomKills = 1;
  env.boat.finish(env.store.get(task.id)!.conversationId!, "", "failed", "harness exited");
  await env.service.sweep();
  await env.service.sizes.settled();
  const last = probes(env).at(-1)!.script;
  assert.match(last, /then J=journal; else J=-; if kread/);
  assert.match(history(env, task.id, "memory").at(-1)!, /^The sandbox may have run out of memory: its kernel counted an out-of-memory kill/);
});

test("sudo that stops working in the same boot: the failed read decides nothing, the counter does", async () => {
  const env = makeService();
  const task = await start(env);
  const probe = env.boat.probe(task.sandboxId!);
  probe.klog = "sudo";
  env.boat.finish(task.conversationId!, "", "failed", "harness exited");
  await env.service.sweep();
  await env.service.sizes.settled();
  await env.service.followup(task.id, "Again.");
  probe.klog = "none";
  probe.oomKills = 1;
  env.boat.finish(env.store.get(task.id)!.conversationId!, "", "failed", "harness exited");
  await env.service.sweep();
  await env.service.sizes.settled();
  assert.match(probes(env).at(-1)!.script, /then J=sudo; else/);
  assert.match(history(env, task.id, "memory").at(-1)!, /^The sandbox may have run out of memory/);
});

test("after a move, its own reading is the next turn's out-of-memory baseline", async () => {
  const env = makeService();
  const task = await start(env);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  await env.service.sizes.settled();
  await env.service.sizes.resize({ taskId: task.id, type: "large", message: "Go on.", userApproved: true, notifyThreadId: null, waitMs: 5_000, by: "page" });
  const boot = env.boat.probe(task.sandboxId!);
  const moved = data(env, task.id, "size").at(-1)!;
  assert.equal(moved.type === "size" && moved.bootId, boot.bootId);
  assert.equal(moved.type === "size" && moved.oomKills, 0);
  boot.klog = "none";
  boot.oomKills = 2;
  env.boat.finish(env.store.get(task.id)!.conversationId!, "", "failed", "harness exited");
  await env.service.sweep();
  await env.service.sizes.settled();
  assert.match(history(env, task.id, "memory").at(-1)!, /its kernel counted 2 out-of-memory kills/);
});

test("bb's restart doesn't explain a headless task's failure", async () => {
  const env = makeService();
  const task = await start(env);
  env.boat.probe(task.sandboxId!).kernel = oomLines({ at: now() + 1, pid: 77, comm: "MainThread", unit: "bb", rssKb: 1_400_000 });
  env.boat.finish(task.conversationId!, "", "failed", "API error 529: overloaded");
  await env.service.sweep();
  await env.service.sizes.settled();
  const error = env.store.get(task.id)!.error!;
  assert.match(error, /^API error 529: overloaded\n\nThe sandbox also ran out of memory during this turn: the system stopped a 1\.3 GB process in the task chat \(MainThread\)\./);
  assert.equal((await env.service.sizes.view(env.store.get(task.id)!))!.oom?.cause, false);
});

test("the check has one deadline: a slow boat and a slow probe together stay within it", async () => {
  const env = makeService({ sizeTiming: { checkMs: 200 } });
  const task = await start(env);
  env.store.update(task.id, { status: "failed", error: "harness exited" });
  env.boat.findInfoDelayMs = 150;
  env.boat.probeHang = true;
  const started = Date.now();
  env.service.sizes.afterTurn(env.store.get(task.id)!, { failed: true });
  assert.ok(env.service.sizes.holds(task.id));
  await env.service.sizes.settled();
  const took = Date.now() - started;
  assert.ok(took < 300, `took ${took} ms`);
  assert.equal(env.service.sizes.holds(task.id), false);
});
