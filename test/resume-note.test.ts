// After a stop that cut off a worker's background work, its next prompt
// from the plugin (a follow-up, an evidence request, a new agent in the
// same sandbox) starts with a short note, once.
import assert from "node:assert/strict";
import { test } from "node:test";
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

async function chatTask(env: ReturnType<typeof makeService>, title = "Add dark mode") {
  const { task } = await env.service.launchTask(
    { title, role: "implement", brief: "Add a dark mode toggle.", repo: "acme/web", orchestratorThreadId: "thr_orch", projectId: "proj_personal" },
    5_000,
  );
  await env.service.sweep();
  env.chat.finish(task.threadId!, REPORT);
  await env.service.sweep();
  return env.store.get(task.id)!;
}

test("after a stop that cut off background work, the worker's next follow-up starts with the note, once", async () => {
  const env = makeService({ chat: true });
  const task = await chatTask(env);
  env.resumeNotes.set(task.id, "[boat] Your sandbox stopped at 14:05 UTC while work was running in the background (a bb workflow). Rerun what you still need now.");
  await env.service.followup(task.id, "Carry on with the migration.");
  const first = env.chat.sends.at(-1)!;
  assert.ok(first.text.startsWith("[boat] Your sandbox stopped at 14:05 UTC"), first.text);
  assert.match(first.text, /Carry on with the migration\./);
  assert.equal(env.resumeNotes.size, 0);
  await env.service.sweep();
  env.chat.finish(task.threadId!, REPORT);
  await env.service.sweep();
  await env.service.followup(task.id, "And the docs.");
  assert.ok(!env.chat.sends.at(-1)!.text.includes("Your sandbox stopped"));
});

test("a headless worker gets the note the same way", async () => {
  const env = makeService();
  const { task } = await env.service.launchTask({ title: "Fix login", role: "implement", brief: "Fix it.", repo: "acme/web", orchestratorThreadId: "thr_orch" }, 5_000);
  env.boat.finish(task.conversationId!, REPORT);
  await env.service.sweep();
  env.resumeNotes.set(task.id, "[boat] Your sandbox stopped at 09:00 UTC while work was running in the background.");
  await env.service.followup(task.id, "Try again.");
  assert.ok(env.boat.prompts.at(-1)!.text.startsWith("[boat] Your sandbox stopped at 09:00 UTC"));
  assert.equal(env.resumeNotes.size, 0);
});

test("a follow-up on another agent opens its chat with the note first", async () => {
  const env = makeService({ chat: true });
  const task = await chatTask(env);
  env.resumeNotes.set(task.id, "[boat] Your sandbox stopped at 14:05 UTC while work was running in the background.");
  await env.service.followup(task.id, "Continue on Codex.", { provider: "codex" });
  assert.ok(env.chat.spawns.at(-1)!.prompt.startsWith("[boat] Your sandbox stopped at 14:05 UTC"));
  assert.equal(env.resumeNotes.size, 0);
});
