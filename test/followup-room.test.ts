// Follow-ups and reviews go to the agent with room: an agent at its switch
// point hands the next turn to the other one, with a note in the history.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentQuota, Quotas } from "../src/quota.ts";
import type { Provider } from "../src/store.ts";
import { makeService } from "./fakes.ts";

const REPORT = "Done.\n=== REPORT ===\nSTATUS: done\nPR: https://github.com/acme/web/pull/7\n=== END REPORT ===";
const brief = { title: "Header", role: "implement" as const, brief: "Do it.", repo: "acme/web", orchestratorThreadId: "thr_orch" };

/** Usage that tests change after the dispatch (the reader returns this same map). */
function usage(): { quotas: Quotas; set(claude: number, codex: number): void } {
  const quotas: Quotas = new Map();
  return {
    quotas,
    set(claude, codex) {
      for (const [provider, usedPercent] of [["claude", claude], ["codex", codex]] as [Provider, number][]) {
        quotas.set(provider, { provider, usedPercent, resetsAt: null, window: "Weekly limit" } satisfies AgentQuota);
      }
    },
  };
}

/** A boat task on Claude whose turn finished, with usage readings to change. */
async function finishedTask(settings: NonNullable<Parameters<typeof makeService>[0]>["settings"] = {}) {
  const meter = usage();
  // The relay is off: only the follow-up rule decides.
  const env = makeService({ quotas: meter.quotas, settings: { relay: { enabled: false, preferred: "claude", switchAtPercent: 90, switchBackBelowPercent: 50, quietMinutes: 10 }, ...settings } });
  const { task } = await env.service.launchTask(brief, 5_000);
  assert.equal(task.provider, "claude");
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  return { env, meter, task };
}

const notes = (env: ReturnType<typeof makeService>, taskId: string) =>
  env.store
    .events(taskId, 50)
    .filter((event) => event.kind === "agent")
    .map((event) => event.text);

test("a follow-up moves to the other agent when the task's agent is at its switch point", async () => {
  const { env, meter, task } = await finishedTask();
  meter.set(95, 10);
  const next = await env.service.followup(task.id, "Fix the spacing.");
  assert.equal(next.provider, "codex");
  // Headless: the same boat conversation, on Codex.
  const prompt = env.boat.prompts.at(-1)!;
  assert.equal(prompt.provider, "codex");
  assert.equal(next.conversationId, task.conversationId);
  assert.deepEqual(notes(env, task.id), ["Claude is at 95% of its limit; continued with Codex"]);
});

test("below the switch point, or with the other agent full too, the follow-up stays", async () => {
  const { env, meter, task } = await finishedTask();
  meter.set(80, 10);
  assert.equal((await env.service.followup(task.id, "One more.")).provider, "claude");
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  meter.set(95, 96);
  assert.equal((await env.service.followup(task.id, "And one more.")).provider, "claude");
  assert.deepEqual(notes(env, task.id), []);
});

test("never with switching on limits off, with one agent, or when an agent was asked for", async () => {
  const off = await finishedTask({ autoFailover: false });
  off.meter.set(95, 10);
  assert.equal((await off.env.service.followup(off.task.id, "Go on.")).provider, "claude");

  const one = await finishedTask({ agents: "claude" });
  one.meter.set(95, 10);
  assert.equal((await one.env.service.followup(one.task.id, "Go on.")).provider, "claude");
  assert.doesNotMatch(notes(one.env, one.task.id).join("\n"), /continued with Codex/);

  const named = await finishedTask();
  named.meter.set(95, 10);
  assert.equal((await named.env.service.followup(named.task.id, "Go on.", { provider: "claude" })).provider, "claude");

  const model = await finishedTask();
  model.meter.set(95, 10);
  assert.equal((await model.env.service.followup(model.task.id, "Go on.", { model: "claude-opus-5-5" })).provider, "claude");

  // boat.dev last said Codex isn't connected (and can't be read now).
  const missing = await finishedTask({ notConnectedAgents: ["codex"] });
  missing.meter.set(95, 10);
  assert.equal((await missing.env.service.followup(missing.task.id, "Go on.")).provider, "claude");
});

test("a steer redirects the running turn and never switches agents", async () => {
  const meter = usage();
  const env = makeService({ quotas: meter.quotas, settings: { relay: { enabled: false, preferred: "claude", switchAtPercent: 90, switchBackBelowPercent: 50, quietMinutes: 10 } } });
  const { task } = await env.service.launchTask(brief, 5_000);
  meter.set(95, 10);
  const steered = await env.service.followup(task.id, "Use the other icon.", { steer: true });
  assert.equal(steered.provider, "claude");
  assert.ok(env.boat.calls.some((call) => call.startsWith(`steer ${task.conversationId}`)));
  assert.deepEqual(notes(env, task.id), []);
});

test("a task chat continues in a new chat on the other agent, in the same workspace", async () => {
  const meter = usage();
  const env = makeService({ chat: true, quotas: meter.quotas, settings: { adhocWorkerMode: "chat", relay: { enabled: false, preferred: "claude", switchAtPercent: 90, switchBackBelowPercent: 50, quietMinutes: 10 } } });
  const { task } = await env.service.launchTask(brief, 5_000);
  assert.equal(task.runner, "chat");
  await env.service.sweep(); // seen working
  env.chat.finish(task.threadId!, REPORT);
  await env.service.sweep();
  meter.set(10, 96);
  // Claude has room: the follow-up stays in its chat.
  const same = await env.service.followup(task.id, "Polish it.");
  assert.equal(same.provider, "claude");
  await env.service.sweep(); // seen working
  env.chat.finish(same.threadId!, REPORT);
  await env.service.sweep();
  meter.set(97, 20);
  const moved = await env.service.followup(task.id, "One more fix.");
  assert.equal(moved.provider, "codex");
  const spawn = env.chat.spawns.at(-1)!;
  assert.equal(spawn.provider, "codex");
  assert.deepEqual(spawn.where, { kind: "environment", environmentId: env.chat.spawns[0]!.environmentId });
  assert.notEqual(moved.threadId, task.threadId);
  assert.deepEqual(notes(env, task.id), ["Claude is at 97% of its limit; continued with Codex"]);
});

test("a review goes to the agent with room (even with the relay off)", async () => {
  const { env, meter, task } = await finishedTask();
  // Cross-model: Codex would review Claude's work, but Codex is at 95%.
  meter.set(10, 95);
  const { task: review } = await env.service.launchTask(await env.service.reviewInput(task.id), 5_000);
  assert.equal(review.provider, "claude");
  assert.ok(env.store.events(review.id, 20).some((event) => event.text === "Codex is at 95% of its limit; Claude runs this review"));

  // Asked for by name: it stays.
  const named = await env.service.launchTask(await env.service.reviewInput(task.id, { provider: "codex" }), 5_000);
  assert.equal(named.task.provider, "codex");
});

test("reviews keep the default agent with switching on limits off", async () => {
  const { env, meter, task } = await finishedTask({ autoFailover: false, avoidExtraUsage: false });
  meter.set(10, 95);
  const { task: review } = await env.service.launchTask(await env.service.reviewInput(task.id), 5_000);
  assert.equal(review.provider, "codex");
});

test("a review that names a model or an agent-only effort keeps that agent", async () => {
  const { env, meter, task } = await finishedTask();
  meter.set(10, 95);
  // Codex at 95%, but the review asks for a Codex model: Codex runs it, with that model.
  const { task: byModel } = await env.service.launchTask(await env.service.reviewInput(task.id, { model: "gpt-5.2-codex" }), 5_000);
  assert.equal(byModel.provider, "codex");
  assert.equal(byModel.model, "gpt-5.2-codex");
  assert.deepEqual({ provider: env.boat.prompts.at(-1)!.provider, model: env.boat.prompts.at(-1)!.model }, { provider: "codex", model: "gpt-5.2-codex" });
  assert.ok(!env.store.events(byModel.id, 20).some((event) => /runs this review/.test(event.text)));

  // A Claude model on a review whose default would be Codex: Claude runs it.
  meter.set(10, 10);
  const { task: claudeModel } = await env.service.launchTask(await env.service.reviewInput(task.id, { model: "claude-opus-5-5" }), 5_000);
  assert.equal(claudeModel.provider, "claude");
  assert.match(claudeModel.model ?? "", /opus-5-5/);
});

test("a new task that names a model keeps that model's agent near its limit", async () => {
  const meter = usage();
  const env = makeService({ quotas: meter.quotas, settings: { relay: { enabled: true, preferred: "claude", switchAtPercent: 90, switchBackBelowPercent: 50, quietMinutes: 10 } } });
  meter.set(95, 10);
  const { task } = await env.service.launchTask({ ...brief, model: "claude-opus-5-5" }, 5_000);
  assert.equal(task.provider, "claude");
  assert.match(task.model ?? "", /opus-5-5/);
  // Without one, the relay gives the task to the agent with room.
  const { task: open } = await env.service.launchTask({ ...brief, title: "Footer" }, 5_000);
  assert.equal(open.provider, "codex");
});

test("a review in its task's sandbox is not refused for a plan that can't start sandboxes", async () => {
  const seen: { newSandbox?: boolean }[] = [];
  const env = makeService({
    settings: { reviewSandbox: "same" },
    preflight: async (input) => {
      seen.push(input);
    },
  });
  const { task } = await env.service.launchTask(brief, 5_000);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  seen.length = 0;
  const { task: review } = await env.service.launchTask(await env.service.reviewInput(task.id), 5_000);
  assert.equal(review.sandboxId, task.sandboxId);
  assert.ok(seen.length > 0);
  assert.ok(seen.every((input) => input.newSandbox !== true));
});
