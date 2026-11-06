// "Coding agents" (one agent or both) and bb Connect for worker chats.
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectStatus, createConnectCheck, type ConnectStatus } from "../src/connect.ts";
import type { AgentQuota, Quotas } from "../src/quota.ts";
import { agentWithRoom, effectiveRelay } from "../src/relay.ts";
import { TaskError } from "../src/service.ts";
import type { Provider } from "../src/store.ts";
import { makeService } from "./fakes.ts";

const REPORT = "Done.\n=== REPORT ===\nSTATUS: done\nPR: https://github.com/acme/web/pull/3\n=== END REPORT ===";
const brief = { title: "Header", role: "implement" as const, brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch" };

function quotas(claude: number | null, codex: number | null): Quotas {
  const map: Quotas = new Map();
  const add = (provider: Provider, usedPercent: number | null) => {
    if (usedPercent !== null) map.set(provider, { provider, usedPercent, resetsAt: null, window: "Weekly limit" } satisfies AgentQuota);
  };
  add("claude", claude);
  add("codex", codex);
  return map;
}

const agentNotes = (env: ReturnType<typeof makeService>, taskId: string) =>
  env.store
    .events(taskId, 50)
    .filter((event) => event.kind === "agent")
    .map((event) => event.text);

test("with one agent, the relay is off and agentWithRoom never picks the other one", () => {
  const relay = { enabled: true, preferred: "claude" as const, switchAtPercent: 90, switchBackBelowPercent: 50, quietMinutes: 10 };
  assert.equal(effectiveRelay(relay, "both").enabled, true);
  assert.equal(effectiveRelay(relay, "claude").enabled, false);
  assert.equal(effectiveRelay(relay, "codex").enabled, false);
  assert.equal(agentWithRoom("claude", quotas(95, 10), 90), "codex");
  assert.equal(agentWithRoom("claude", quotas(95, 10), 90, "claude"), null, "never the missing agent");
  assert.equal(agentWithRoom("claude", quotas(10, 10), 90, "codex"), "codex", "the one agent, whatever was wanted");
  assert.equal(agentWithRoom("claude", quotas(10, 95), 90, "codex"), null);
  assert.equal(agentWithRoom("codex", new Map(), 90, "claude"), "claude", "unknown usage counts as room");
});

test("with one agent, workers and reviews run on it; settings that name the other one fall back with a note", async () => {
  const env = makeService({ settings: { agents: "claude" } });
  const { task } = await env.service.launchTask(brief, 5_000);
  assert.equal(task.provider, "claude");
  assert.deepEqual(agentNotes(env, task.id), [], "the implementation agent is already Claude");
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  // The review setting says Codex (and cross-model would pick it): Claude reviews, with a note.
  const { task: review } = await env.service.launchTask(await env.service.reviewInput(task.id), 5_000);
  assert.equal(review.provider, "claude");
  assert.equal(review.status, "running", "the review still runs");
  assert.match(agentNotes(env, review.id).join("\n"), /Only Claude is set up \(Coding agents\), so Claude runs this review instead of Codex/);
  // A dispatch that names Codex, with a Codex model and level, runs on Claude with its own.
  const named = await env.service.launchTask({ ...brief, title: "Named", provider: "codex", model: "gpt-6.1-sol", reasoningEffort: "ultra" }, 5_000);
  assert.equal(named.task.provider, "claude");
  assert.notEqual(named.task.model, "gpt-6.1-sol");
  assert.match(agentNotes(env, named.task.id).join("\n"), /instead of Codex/);
  // Only Codex: the implementation setting (Claude) falls back the same way.
  const codex = makeService({ settings: { agents: "codex" } });
  const { task: onCodex } = await codex.service.launchTask(brief, 5_000);
  assert.equal(onCodex.provider, "codex");
  assert.match(agentNotes(codex, onCodex.id).join("\n"), /Only Codex is set up \(Coding agents\), so Codex runs this task instead of Claude/);
});

test("with one agent near its limit, new work waits (no switch to the missing agent)", async () => {
  const env = makeService({ quotas: quotas(95, 10), settings: { agents: "claude" } });
  await assert.rejects(
    env.service.launchTask(brief, 5_000),
    (error: unknown) => error instanceof TaskError && error.code === "agents_at_limit" && /^Claude is near its usage limit\.$/.test(error.message),
  );
  // Naming the agent is the orchestrator's call (paid extra usage).
  const named = await env.service.launchTask({ ...brief, provider: "claude" }, 5_000);
  assert.equal(named.task.provider, "claude");
  // With paid extra usage allowed, it runs.
  const allowed = makeService({ quotas: quotas(95, 10), settings: { agents: "claude", avoidExtraUsage: false } });
  assert.equal((await allowed.service.launchTask(brief, 5_000)).task.provider, "claude");
});

test("with one agent, a usage limit mid-task doesn't switch agents", async () => {
  const env = makeService({ settings: { agents: "claude" } });
  const { task } = await env.service.launchTask(brief, 5_000);
  env.boat.finish(task.conversationId!, "", "failed", "Claude usage limit reached, resets at 5pm");
  await env.service.sweep();
  const after = env.store.get(task.id)!;
  assert.equal(after.status, "failed");
  assert.equal(after.provider, "claude");
  assert.ok(!env.store.events(task.id, 50).some((event) => event.kind === "failover"));

  // Worker chats too.
  const chat = makeService({ chat: true, settings: { agents: "claude" } });
  const { task: chatTask } = await chat.service.launchTask(brief, 5_000);
  await chat.service.sweep();
  chat.chat.finish(chatTask.threadId!, "Claude usage limit reached, resets at 5pm", "error");
  await chat.service.sweep();
  assert.equal(chat.store.get(chatTask.id)!.provider, "claude");
  assert.equal(chat.chat.spawns.length, 1, "no second chat on Codex");
  assert.ok(!chat.store.events(chatTask.id, 50).some((event) => event.kind === "failover"));
});

test("with one agent, a follow-up stays on it (even on a task that ran on the other one)", async () => {
  const env = makeService();
  const { task } = await env.service.launchTask({ ...brief, provider: "codex" }, 5_000);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  env.setSettings({ agents: "claude" });
  const followed = await env.service.followup(task.id, "Fix the nit.", { provider: "codex", model: "gpt-6.1-sol" });
  assert.equal(followed.provider, "claude");
  assert.equal(env.boat.prompts.at(-1)!.provider, "claude");
  assert.notEqual(env.boat.prompts.at(-1)!.model, "gpt-6.1-sol");
  assert.match(agentNotes(env, task.id).join("\n"), /Only Claude is set up \(Coding agents\), so Claude continues instead of Codex/);
});

test("with one agent, a model named for it is kept, whichever agent the settings name", async () => {
  // Only Codex, and the implementation setting still says Claude.
  const codex = makeService({ settings: { agents: "codex" } });
  const { task } = await codex.service.launchTask({ ...brief, model: "gpt-6.1-sol-mini" }, 5_000);
  assert.equal(task.provider, "codex");
  assert.equal(task.model, "gpt-6.1-sol-mini");
  // A Claude model can't run on Codex.
  const claudeModel = await codex.service.launchTask({ ...brief, title: "Claude model", model: "claude-sonnet-5-5" }, 5_000);
  assert.equal(claudeModel.task.provider, "codex");
  assert.notEqual(claudeModel.task.model, "claude-sonnet-5-5");
  // A follow-up on a task that ran on Claude keeps a Codex model too.
  const both = makeService();
  const { task: onClaude } = await both.service.launchTask(brief, 5_000);
  both.boat.finish(onClaude.conversationId!, REPORT);
  await both.service.sweep();
  both.setSettings({ agents: "codex" });
  await both.service.followup(onClaude.id, "Fix the nit.", { model: "gpt-6.1-sol-mini" });
  assert.equal(both.boat.prompts.at(-1)!.provider, "codex");
  assert.equal(both.boat.prompts.at(-1)!.model, "gpt-6.1-sol-mini");

  // Only Claude: a review with a Claude model keeps it (the review setting says Codex).
  const claude = makeService({ settings: { agents: "claude" } });
  const { task: implementation } = await claude.service.launchTask(brief, 5_000);
  claude.boat.finish(implementation.conversationId!, REPORT);
  await claude.service.sweep();
  const { task: review } = await claude.service.launchTask(await claude.service.reviewInput(implementation.id, { model: "claude-sonnet-5-5" }), 5_000);
  assert.equal(review.provider, "claude");
  assert.equal(review.model, "claude-sonnet-5-5");
});

test("task chats need bb Connect: without it a task chat fails early, before any sandbox", async () => {
  const env = makeService({ chat: true });
  let status: ConnectStatus = { state: "off", fix: "Sign this bb in to getbb.app with `bb account login`, then run `bb connect on`." };
  (env.service as unknown as { hooks: { connect: () => Promise<ConnectStatus> } }).hooks.connect = async () => status;
  await assert.rejects(
    env.service.launchTask(brief, 5_000),
    (error: unknown) =>
      error instanceof TaskError &&
      error.code === "connect_required" &&
      /Task chats need bb Connect/.test(error.message) &&
      /bb account login[\s\S]*bb boat config set workers boat[\s\S]*How tasks run/.test(error.hint ?? ""),
  );
  assert.equal(env.boat.sandboxes.size, 0);
  // Boat conversations don't need it.
  env.setSettings({ workerMode: "boat" });
  assert.equal((await env.service.launchTask(brief, 5_000)).task.runner, "boat");
  // Unknown status doesn't block.
  env.setSettings({ workerMode: "chat" });
  status = { state: "unknown", fix: null };
  assert.equal((await env.service.launchTask({ ...brief, title: "Chat" }, 5_000)).task.runner, "chat");
});

test("bb Connect's status comes from the connect plugin, briefly cached", async () => {
  assert.deepEqual(connectStatus({ paired: true, enabled: true }), { state: "ready", fix: null });
  assert.equal(connectStatus({ paired: false, enabled: true }).state, "off");
  assert.match(connectStatus({ paired: false, enabled: true }).fix ?? "", /bb account login/);
  assert.match(connectStatus({ paired: true, enabled: false }).fix ?? "", /bb connect on/);
  assert.equal(connectStatus({}).state, "unknown");

  let answer: () => unknown = () => ({ state: "connected", paired: true, enabled: true });
  const calls: { pluginId: string; method: string }[] = [];
  const bb = {
    sdk: {
      plugins: {
        async callRpc(args: { pluginId: string; method: string }) {
          calls.push({ pluginId: args.pluginId, method: args.method });
          return answer();
        },
      },
    },
  };
  const check = createConnectCheck(bb as never, { cacheMs: 60_000 });
  assert.equal((await check()).state, "ready");
  assert.equal((await check()).state, "ready");
  assert.deepEqual(calls, [{ pluginId: "connect", method: "status" }], "cached");
  answer = () => {
    throw new Error('unknown plugin "connect"');
  };
  assert.equal((await createConnectCheck(bb as never)()).state, "off", "no connect plugin: no remote access");
  answer = () => {
    throw new Error("The operation timed out");
  };
  assert.deepEqual(await createConnectCheck(bb as never)(), { state: "unknown", fix: null });
});
