// Workers as regular bb chats on their boat sandboxes.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createChatRunner } from "../src/chat.ts";
import { TaskError } from "../src/service.ts";
import { makeService } from "./fakes.ts";

const REPORT = `Done.

=== REPORT ===
STATUS: done
PR: https://github.com/acme/web/pull/12
BRANCH: boat/x
SUMMARY: done
TESTS: ok
OPEN QUESTIONS: none
=== END REPORT ===`;

async function dispatch(env: ReturnType<typeof makeService>, overrides: Record<string, unknown> = {}) {
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

/** Let the monitor see a finished turn (the 60 s "not started yet" grace is skipped once the chat was seen busy). */
async function settle(env: ReturnType<typeof makeService>) {
  await env.service.sweep();
}

test("a worker is a bb chat on its prepared sandbox, nested under the orchestrator", async () => {
  const env = makeService({ chat: true });
  const task = await dispatch(env, { tier: "deep", reason: "Hard bug" });
  assert.equal(task.runner, "chat");
  assert.equal(task.status, "running");
  // The plugin created and prepared the sandbox (checkout, branch, push guard), then bb adopted it.
  assert.equal(env.boat.created.length, 1);
  assert.ok(env.boat.prepared.some((entry) => entry.repo === "acme/web"));
  assert.deepEqual(env.chat.machines, [{ taskId: task.id, sandboxId: task.sandboxId!, hostId: "host_1" }]);
  const spawn = env.chat.spawns[0]!;
  assert.equal(spawn.parentThreadId, "thr_orch");
  assert.equal(spawn.provider, "claude");
  // bb's model ids, and the real Ultracode level.
  assert.equal(spawn.model, "claude-opus-5-5");
  assert.equal(spawn.effort, "ultracode");
  assert.deepEqual(spawn.where, { kind: "machine", hostId: "host_1", path: task.repoPath });
  assert.match(spawn.prompt, /You run in a bb chat/);
  assert.match(spawn.prompt, /you run with Ultracode on/);
  assert.equal(task.threadId, spawn.threadId);
  assert.equal(task.hostId, "host_1");
  // No boat conversation.
  assert.equal(env.boat.prompts.length, 0);
});

test("finished chat turns are recorded, then the orchestrator gets a [boat] notice", async () => {
  const env = makeService({ chat: true });
  const task = await dispatch(env);
  await settle(env); // seen busy
  env.chat.finish(task.threadId!, REPORT);
  await settle(env);
  const done = env.store.get(task.id)!;
  assert.equal(done.status, "idle");
  assert.equal(done.prUrl, "https://github.com/acme/web/pull/12");
  // The plugin wakes the orchestrator only now that the task reads idle.
  assert.equal(env.notifications.length, 1);
  assert.equal(env.notifications[0]!.tasks[0]!.status, "idle");

  // The user writes in the worker chat directly: that's a new turn.
  env.chat.states.get(task.threadId!)!.status = "active";
  await settle(env);
  assert.equal(env.store.get(task.id)!.status, "running");
  assert.ok(env.store.events(task.id).some((event) => event.kind === "turn"));
});

test("a follow-up goes into the chat; a new tier changes model and effort for that turn", async () => {
  const env = makeService({ chat: true });
  const task = await dispatch(env, { tier: "build" });
  await settle(env);
  env.chat.finish(task.threadId!, REPORT);
  await settle(env);

  await env.service.followup(task.id, "Fix the header.");
  const plain = env.chat.sends.at(-1)!;
  assert.equal(plain.threadId, task.threadId);
  assert.equal(plain.steer, false);
  assert.equal(plain.model, undefined); // the chat keeps its own model
  await settle(env);
  env.chat.finish(task.threadId!, REPORT);
  await settle(env);

  const deeper = await env.service.followup(task.id, "Still flaky.", { tier: "deep", reason: "Build fell short" });
  const escalated = env.chat.sends.at(-1)!;
  assert.equal(escalated.model, "claude-opus-5-5");
  assert.equal(escalated.effort, "ultracode");
  assert.match(escalated.text, /you run with Ultracode on/);
  assert.equal(deeper.tier, "deep");

  // Steering a running chat.
  await env.service.followup(task.id, "Focus on Safari.", { steer: true });
  assert.equal(env.chat.sends.at(-1)!.steer, true);
});

test("switching agent opens a second chat in the same workspace", async () => {
  const env = makeService({ chat: true });
  const task = await dispatch(env, { tier: "build" });
  await settle(env);
  env.chat.finish(task.threadId!, REPORT);
  await settle(env);
  const switched = await env.service.followup(task.id, "Continue on Codex.", { provider: "codex" });
  const handover = env.chat.spawns.at(-1)!;
  assert.equal(handover.provider, "codex");
  assert.equal(handover.model, "gpt-6.1-sol");
  assert.equal(handover.effort, "xhigh");
  // bb reports the workspace after the spawn; the monitor picked it up.
  assert.equal(task.environmentId, null);
  assert.deepEqual(handover.where, { kind: "environment", environmentId: env.store.get(task.id)!.environmentId });
  assert.ok(env.store.get(task.id)!.environmentId);
  assert.match(handover.prompt, /moved this task from claude \(@thread:thr_w\d+\) to you/);
  assert.match(handover.prompt, /## Message from the orchestrator\nContinue on Codex\./);
  assert.equal(switched.threadId, handover.threadId);
  assert.equal(switched.provider, "codex");
  assert.deepEqual(env.store.chatThreads(task.id), [task.threadId, handover.threadId]);
});

test("a usage limit hands the chat over to the other agent at the same tier", async () => {
  const env = makeService({ chat: true });
  const task = await dispatch(env, { tier: "review", role: "custom", title: "Audit" });
  await settle(env);
  env.chat.finish(task.threadId!, "Claude usage limit reached, resets at 5pm", "error");
  await settle(env);
  const switched = env.store.get(task.id)!;
  assert.equal(switched.status, "running");
  assert.equal(switched.provider, "codex");
  assert.equal(switched.reasoningEffort, "high");
  assert.notEqual(switched.threadId, task.threadId);
  assert.match(env.chat.spawns.at(-1)!.prompt, /stopped because it hit a usage limit/);
  assert.equal(env.store.events(task.id).at(-1)!.kind, "failover");
});

test("Codex levels and Claude levels don't mix in chats", async () => {
  const env = makeService({ chat: true });
  await assert.rejects(
    dispatch(env, { provider: "codex", reasoningEffort: "ultracode" }),
    (error: unknown) => error instanceof TaskError && error.code === "invalid_effort",
  );
  const codexDeep = await dispatch(env, { provider: "codex", tier: "deep", title: "Codex deep" });
  assert.equal(codexDeep.reasoningEffort, "ultra");
  // boat conversations stop at max.
  const boat = makeService();
  const boatDeep = await dispatch(boat, { tier: "deep" });
  assert.equal(boatDeep.runner, "boat");
  assert.equal(boatDeep.model, "opus-5-5");
  assert.equal(boatDeep.reasoningEffort, "max");
});

test("a reviewer sharing the implementer's checkout joins its workspace", async () => {
  const env = makeService({ chat: true, settings: { reviewSandbox: "same" } });
  const task = await dispatch(env);
  await settle(env);
  env.chat.finish(task.threadId!, REPORT);
  await settle(env);
  const implementer = env.store.get(task.id)!;
  const { task: review } = await env.service.launchTask(await env.service.reviewInput(task.id), 5_000);
  assert.equal(review.runner, "chat");
  const spawn = env.chat.spawns.at(-1)!;
  assert.deepEqual(spawn.where, { kind: "environment", environmentId: implementer.environmentId });
  assert.equal(spawn.provider, "codex");
  assert.equal(env.chat.machines.length, 1); // no second machine
});

test("closing archives the task's chats (bb then removes the machine); interrupt stops the chat", async () => {
  const env = makeService({ chat: true });
  const task = await dispatch(env);
  await env.service.interruptTask(task.id);
  assert.deepEqual(env.chat.stopped, [task.threadId]);
  await settle(env);
  const result = await env.service.closeTask(task.id);
  assert.equal(result.sandbox, "deleted");
  assert.deepEqual(env.chat.archived, [task.threadId]);
  // The machine goes (bb then deletes the sandbox through the provider); the plugin doesn't delete it directly.
  assert.deepEqual(env.chat.removed, ["host_1"]);
  assert.ok(!env.boat.calls.some((call) => call.startsWith("delete ")));
});

test("a failed machine setup removes the machine and fails the task", async () => {
  const env = makeService({ chat: true });
  env.chat.attachError = new Error("bb Connect is off");
  await assert.rejects(dispatch(env), /bb Connect is off/);
  const [task] = env.store.list({ limit: 10 });
  assert.equal(task!.status, "failed");
  // Without a machine the plugin deletes the sandbox it made.
  assert.ok(env.boat.calls.some((call) => call.startsWith("delete ")));
});

test("an archived worker chat cancels its task", async () => {
  const env = makeService({ chat: true });
  const task = await dispatch(env);
  env.chat.states.get(task.threadId!)!.archived = true;
  await settle(env);
  assert.equal(env.store.get(task.id)!.status, "cancelled");
});

test("the bb runner spawns chats with the right environment and execution options", async () => {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const bb = {
    pluginId: "boat",
    sdk: {
      hosts: {
        experimental_create: async (args: Record<string, unknown>) => {
          calls.push({ method: "hosts.create", args });
          return { id: "host_9" };
        },
      },
      threads: {
        spawn: async (args: Record<string, unknown>) => {
          calls.push({ method: "threads.spawn", args });
          return { id: "thr_9", environmentId: "env_9" };
        },
        send: async (args: Record<string, unknown>) => {
          calls.push({ method: "threads.send", args });
          return { ok: true, delivery: "sent" };
        },
      },
    },
  } as unknown as BbPluginApi;
  const runner = createChatRunner(bb);
  assert.deepEqual(await runner.attachMachine({ taskId: "t_1", sandboxId: "bx_1" }), { hostId: "host_9" });
  assert.deepEqual(calls[0]!.args, { machineProviderId: "boat-sandbox", inputs: { sandboxId: "bx_1", taskId: "t_1" }, key: "task-t_1", wait: true });
  await runner.spawn({
    taskId: "t_1",
    title: "Fix",
    prompt: "Do it",
    provider: "codex",
    model: "gpt-6.1-sol",
    effort: "ultra",
    parentThreadId: "thr_orch",
    projectId: "proj_storefront",
    where: { kind: "machine", hostId: "host_9", path: "/home/user/work/t_1/web" },
  });
  const spawn = calls[1]!.args;
  assert.deepEqual(spawn.environment, { type: "host", hostId: "host_9", workspace: { type: "unmanaged", path: "/home/user/work/t_1/web" } });
  assert.equal(spawn.providerId, "codex");
  assert.equal(spawn.reasoningLevel, "ultra");
  assert.equal(spawn.permissionMode, "full");
  assert.equal(spawn.parentThreadId, "thr_orch");
  // Nested under the orchestrator, but the plugin (not bb) wakes it.
  assert.equal(spawn.parentNotifications, "off");
  // Personal project chats get a personal workspace on the machine.
  await runner.spawn({
    taskId: "t_2",
    title: "Fix",
    prompt: "Do it",
    provider: "claude",
    model: null,
    effort: null,
    parentThreadId: null,
    projectId: null,
    where: { kind: "machine", hostId: "host_9", path: "/x" },
  });
  assert.deepEqual(calls[2]!.args.environment, { type: "host", hostId: "host_9", workspace: { type: "personal" } });
  assert.equal(calls[2]!.args.providerId, "claude-code");
  await runner.send("thr_9", "go", { steer: true, model: "claude-opus-5-5", effort: "ultracode" });
  assert.equal(calls[3]!.args.mode, "steer-if-active");
  assert.equal(calls[3]!.args.reasoningLevel, "ultracode");
});

test("closing keeps a machine another open task still uses", async () => {
  const env = makeService({ chat: true, settings: { reviewSandbox: "same" } });
  const task = await dispatch(env);
  await settle(env);
  env.chat.finish(task.threadId!, REPORT);
  await settle(env);
  const { task: review } = await env.service.launchTask(await env.service.reviewInput(task.id), 5_000);
  const closed = await env.service.closeTask(review.id);
  assert.equal(closed.sandbox, "kept");
  assert.deepEqual(env.chat.removed, []);
  const last = await env.service.closeTask(task.id);
  assert.equal(last.sandbox, "deleted");
  assert.deepEqual(env.chat.removed, ["host_1"]);
});

test("chat workers fence their report block so it renders line by line", async () => {
  const env = makeService({ chat: true });
  await dispatch(env);
  assert.match(env.chat.spawns[0]!.prompt, /inside a ```text code fence:\n\n```text\n=== REPORT ===[\s\S]*=== END REPORT ===\n```/);
  const boat = makeService();
  await dispatch(boat);
  assert.doesNotMatch(boat.boat.prompts[0]!.text, /```text/);
});

// ------------------------------------------------------- review fixes

test("a bb idle event records the turn at once, with its text, and wakes the orchestrator", async () => {
  const env = makeService({ chat: true });
  const task = await dispatch(env);
  // No sweep saw it busy, and it's well within the old 60 s guess.
  env.chat.finish(task.threadId!, REPORT);
  await env.service.syncChatThread(task.threadId!, { kind: "idle", text: REPORT, at: Date.now() });
  assert.equal(env.store.get(task.id)!.status, "idle");
  assert.equal(env.notifications.length, 1);
  // Events for a chat that isn't the task's current one are ignored.
  await env.service.syncChatThread("thr_unknown", { kind: "idle", text: "x" });
});

test("queued messages and background agents keep a chat task running", async () => {
  const env = makeService({ chat: true });
  const task = await dispatch(env);
  await settle(env);
  env.chat.finish(task.threadId!, REPORT);
  env.chat.states.get(task.threadId!)!.backgroundAgents = 2;
  await settle(env);
  assert.equal(env.store.get(task.id)!.status, "running");
  env.chat.states.get(task.threadId!)!.backgroundAgents = 0;
  env.chat.states.get(task.threadId!)!.queued = 1;
  await settle(env);
  assert.equal(env.store.get(task.id)!.status, "running");
  env.chat.states.get(task.threadId!)!.queued = 0;
  await settle(env);
  assert.equal(env.store.get(task.id)!.status, "idle");
});

test("a turn that ends without a new answer doesn't repeat the old report", async () => {
  const env = makeService({ chat: true });
  const task = await dispatch(env);
  await settle(env);
  env.chat.finish(task.threadId!, REPORT);
  await settle(env);
  await env.service.followup(task.id, "One more check.");
  await settle(env);
  env.chat.finish(task.threadId!, REPORT); // same text: no new answer
  await settle(env);
  const after = env.store.get(task.id)!;
  assert.equal(after.status, "idle");
  assert.equal(after.result, "(The turn ended without a new message.)");
});

test("a usage limit from bb's error hands over with the pending follow-up, and stops the old chat", async () => {
  const env = makeService({ chat: true });
  const task = await dispatch(env, { tier: "build" });
  await settle(env);
  env.chat.finish(task.threadId!, REPORT);
  await settle(env);
  await env.service.followup(task.id, "Fix the Safari header.");
  await settle(env);
  env.chat.finish(task.threadId!, REPORT, "error");
  await env.service.syncChatThread(task.threadId!, { kind: "failed", error: "Claude AI usage limit reached|1794441600" });
  const handover = env.chat.spawns.at(-1)!;
  assert.equal(handover.provider, "codex");
  assert.match(handover.prompt, /## Message from the orchestrator\nFix the Safari header\./);
  assert.ok(env.chat.stopped.includes(task.threadId!));
  assert.ok(env.chat.archived.includes(task.threadId!));
  assert.equal(env.store.get(task.id)!.threadId, handover.threadId);
  // A non-limit error just fails the task.
  const other = await dispatch(env, { title: "Other" });
  await settle(env);
  env.chat.finish(other.threadId!, "", "error");
  await env.service.syncChatThread(other.threadId!, { kind: "failed", error: "The model refused" });
  assert.equal(env.store.get(other.id)!.status, "failed");
  assert.match(env.store.get(other.id)!.error!, /The model refused/);
});

test("a follow-up that fails to send leaves the task as it was", async () => {
  const env = makeService({ chat: true });
  const task = await dispatch(env);
  await settle(env);
  env.chat.finish(task.threadId!, REPORT);
  await settle(env);
  const before = env.store.get(task.id)!;
  env.chat.send = async () => {
    throw new Error("bb is restarting");
  };
  await assert.rejects(env.service.followup(task.id, "Again."), /bb is restarting/);
  const after = env.store.get(task.id)!;
  assert.equal(after.status, "idle");
  assert.equal(after.turns, before.turns);
  assert.equal(after.promptId, before.promptId);
});

test("archiving a worker chat by hand cancels the task and removes its machine", async () => {
  const env = makeService({ chat: true });
  const task = await dispatch(env);
  await env.service.syncChatThread(task.threadId!, { kind: "archived" });
  assert.equal(env.store.get(task.id)!.status, "cancelled");
  assert.deepEqual(env.chat.removed, ["host_1"]);
});

test("a machine left by a cut-short attach is found and removed", async () => {
  const env = makeService({ chat: true });
  const original = env.chat.attachMachine.bind(env.chat);
  env.chat.attachMachine = async (args) => {
    await original(args); // bb made the machine...
    throw new Error("timed out"); // ...but we never heard back
  };
  await assert.rejects(dispatch(env), /timed out/);
  assert.deepEqual(env.chat.removed, ["host_1"]);
});

test("idle worker machines are suspended through bb, never stopped behind its back", async () => {
  const env = makeService({ chat: true, settings: { stopIdleAfterMinutes: 1 } });
  const task = await dispatch(env);
  await settle(env);
  env.chat.finish(task.threadId!, REPORT);
  await settle(env);
  const realNow = Date.now;
  Date.now = () => realNow() + 5 * 60_000; // five idle minutes later
  try {
    await settle(env);
    assert.deepEqual(env.chat.suspended, ["host_1"]);
    assert.ok(!env.boat.calls.some((call) => call.startsWith("stop ")));
    // Once only: bb resumes it on the next message.
    await settle(env);
    assert.deepEqual(env.chat.suspended, ["host_1"]);
  } finally {
    Date.now = realNow;
  }
});

test("boat conversation failover uses boat's model ids and max", async () => {
  const env = makeService();
  const task = await dispatch(env, { tier: "deep", provider: "codex" });
  env.boat.finish(task.conversationId!, "", "failed", "usage limit reached");
  await env.service.sweep();
  const switched = env.store.get(task.id)!;
  assert.equal(switched.provider, "claude");
  assert.equal(env.boat.prompts.at(-1)!.model, "opus-5-5");
  assert.equal(env.boat.prompts.at(-1)!.effort, "max");
});

test("the Deep brief only claims Ultracode when the chat really runs it", async () => {
  const env = makeService({ chat: true });
  await dispatch(env, { tier: "deep", reasoningEffort: "max", title: "Deep at max" });
  assert.doesNotMatch(env.chat.spawns.at(-1)!.prompt, /you run with Ultracode on/);
  assert.match(env.chat.spawns.at(-1)!.prompt, /This is Deep work: the result gains/);
});

test("stopping or deleting a worker chat's sandbox by hand goes through bb", async () => {
  const env = makeService({ chat: true });
  const task = await dispatch(env);
  await env.service.sandboxAction(task.sandboxId!, "stop", 0);
  await env.service.sandboxAction(task.sandboxId!, "resume", 3600);
  await env.service.sandboxAction(task.sandboxId!, "delete", 0);
  assert.deepEqual(env.chat.suspended, ["host_1"]);
  assert.deepEqual(env.chat.resumed, ["host_1"]);
  assert.deepEqual(env.chat.removed, ["host_1"]);
  assert.ok(env.chat.archived.includes(task.threadId!));
  assert.ok(!env.boat.calls.some((call) => /^(stop|resume|delete) /.test(call)));
});

test("only trusted repos get chat workers: project repos chat, other repos boat by default", async () => {
  const { toOrchestratorProject, normalizeProject } = await import("../src/projects.ts");
  const project = toOrchestratorProject(
    normalizeProject({ id: "storefront", name: "Storefront", repos: [{ repo: "acme/storefront", baseBranch: "master" }] }),
  );
  const env = makeService({ chat: true, settings: { adhocWorkerMode: "boat" } });
  env.boat.limitsValue.maxActiveSandboxes = 10;
  const trusted = await dispatch(env, { repo: null, project, title: "Trusted" });
  assert.equal(trusted.runner, "chat");
  // A repo outside the project: unknown trust, so a boat conversation.
  const foreign = await dispatch(env, { repo: "someone/else", project, title: "Foreign" });
  assert.equal(foreign.runner, "boat");
  // A project that opts out.
  const careful = await dispatch(env, { repo: null, project: { ...project, workerMode: "boat" }, title: "Careful" });
  assert.equal(careful.runner, "boat");
  // Older orchestrator metadata (no workerMode) counts as trusted.
  const { parseOrchestratorProject } = await import("../src/projects.ts");
  const { workerMode: _drop, ...legacy } = project;
  assert.equal(parseOrchestratorProject(legacy)?.workerMode, "chat");
});

test("trust follows the repo: a repo in any project counts, even without naming the project", async () => {
  const env = makeService({ chat: true, settings: { adhocWorkerMode: "boat" } });
  env.boat.limitsValue.maxActiveSandboxes = 10;
  (env.service as unknown as { hooks: { repoWorkerMode: (repo: string) => "chat" | "boat" | null } }).hooks.repoWorkerMode = (repo) =>
    repo === "acme/storefront" ? "chat" : null;
  const known = await dispatch(env, { repo: "acme/storefront", title: "Known" });
  assert.equal(known.runner, "chat");
  const unknown = await dispatch(env, { repo: "someone/else", title: "Unknown" });
  assert.equal(unknown.runner, "boat");
  assert.ok(env.store.events(unknown.id).some((event) => event.kind === "trust"));
});

test("an extra chat at work keeps its machine from being suspended", async () => {
  const env = makeService({ chat: true, settings: { stopIdleAfterMinutes: 1 } });
  const task = await dispatch(env);
  await settle(env);
  env.chat.finish(task.threadId!, REPORT);
  await settle(env);
  // The user opened another chat in the workspace and it's busy.
  env.store.addEvent(task.id, "chat-extra", "thr_extra");
  env.chat.states.set("thr_extra", { status: "active", updatedAt: Date.now(), archived: false, environmentId: null, queued: 0, backgroundAgents: 0 });
  const realNow = Date.now;
  Date.now = () => realNow() + 5 * 60_000;
  try {
    await settle(env);
    assert.deepEqual(env.chat.suspended, []);
    env.chat.states.get("thr_extra")!.status = "idle";
    await settle(env);
    assert.deepEqual(env.chat.suspended, ["host_1"]);
  } finally {
    Date.now = realNow;
  }
});
