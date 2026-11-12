// One automatic retry of a task chat's turn that failed with a provider Bad
// Request right after a steer: the task lifecycle around it. Fakes only.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { notificationText } from "../src/format.ts";
import { projectHistoryEvent } from "../src/history.ts";
import type { TurnEventRow } from "../src/steer-retry.ts";
import { makeService } from "./fakes.ts";
import { BAD_REQUEST, INCIDENT, STEER, laterTurn, without, withError } from "./steer-events.ts";

async function chatTask(env: ReturnType<typeof makeService>) {
  const { task } = await env.service.launchTask(
    { title: "Add dark mode", role: "implement", brief: "Add a dark mode toggle.", repo: "acme/web", orchestratorThreadId: "thr_orch", projectId: "proj_personal" },
    5_000,
  );
  await env.service.sweep(); // seen busy
  return task;
}

/** bb fails the chat's turn: the thread lands in error and thread.failed fires. */
async function fail(env: ReturnType<typeof makeService>, threadId: string, rows: TurnEventRow[], error = BAD_REQUEST) {
  env.chat.events.set(threadId, rows);
  env.chat.finish(threadId, "", "error");
  await env.service.syncChatThread(threadId, { kind: "failed", error, at: Date.now() });
  // A failed turn's memory check holds its notice for a moment.
  await env.service.sizes.settled();
  await env.service.deliverPending();
}

test("the incident: the turn is retried once, with the steer, and the orchestrator isn't told it failed", async () => {
  const env = makeService({ chat: true });
  const task = await chatTask(env);
  const before = env.chat.sends.length;
  await fail(env, task.threadId!, INCIDENT);

  const sends = env.chat.sends.slice(before);
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.threadId, task.threadId);
  assert.equal(sends[0]!.steer, false);
  assert.match(sends[0]!.text, /# Automatic retry/);
  assert.ok(sends[0]!.text.includes(`> ${STEER}`));

  const retried = env.store.get(task.id)!;
  assert.equal(retried.status, "running");
  assert.equal(retried.error, null);
  assert.equal(retried.turns, task.turns + 1);
  assert.equal(env.notifications.length, 0);
  // History, and a retrying state instead of Agent stopped.
  const events = env.store.events(task.id, 50);
  assert.ok(events.some((event) => event.kind === "auto-retry" && event.text === "Retried automatically after a provider error following a steer"));
  assert.ok(!events.some((event) => event.kind === "failed"));
  const status = env.service.publicStatus(retried);
  assert.equal(status.status, "working");
  assert.equal(status.label, "Retrying");
  assert.equal(status.retrying, true);
  assert.equal(status.moving, true);

  // The same failure seen again (the event and the sweep): no second retry.
  await env.service.syncChatThread(task.threadId!, { kind: "failed", error: BAD_REQUEST, at: Date.now() });
  await env.service.sweep();
  assert.equal(env.chat.sends.length, before + 1);
  assert.equal(env.store.get(task.id)!.status, "running");

  // The retry finishes: one ordinary notice, which says it was a retry.
  env.chat.events.set(task.threadId!, [...INCIDENT, ...laterTurn(200, { status: "completed" })]);
  env.chat.finish(task.threadId!, "Done.\n\n=== REPORT ===\nSTATUS: done\n=== END REPORT ===");
  await env.service.sweep();
  await env.service.deliverPending();
  const done = env.store.get(task.id)!;
  assert.equal(done.status, "idle");
  assert.equal(env.notifications.length, 1);
  assert.equal(env.service.publicStatus(done).retrying, undefined);
  const notice = notificationText(env.notifications[0]!.tasks, (id) => env.store.events(id, 30));
  assert.match(notice, /This turn was an automatic retry/);
  assert.doesNotMatch(notice, /Error:/);
  // The history feed shows the retry as a step of the task.
  const row = { seq: 1, kind: "auto-retry", text: "Retried automatically after a provider error following a steer", at: new Date().toISOString(), metadata: "{}" };
  assert.equal(projectHistoryEvent(row, done)?.kind, "started");
});

test("the same error without a steer fails the task as before", async () => {
  const env = makeService({ chat: true });
  const task = await chatTask(env);
  const before = env.chat.sends.length;
  await fail(env, task.threadId!, without("steer"));
  assert.equal(env.chat.sends.length, before);
  const failed = env.store.get(task.id)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /Bad Request/);
  assert.doesNotMatch(failed.error!, /automatic retry/);
  assert.equal(env.notifications.length, 1);
});

test("a second failure after the retry is reported as failed, without another retry", async () => {
  const env = makeService({ chat: true });
  const task = await chatTask(env);
  const before = env.chat.sends.length;
  await fail(env, task.threadId!, INCIDENT);
  assert.equal(env.chat.sends.length, before + 1);
  await env.service.sweep(); // the retry's turn runs

  // The retry's turn takes another steer and fails the same way.
  await fail(env, task.threadId!, [...INCIDENT, ...laterTurn(200, { status: "failed", steer: "And the footer." })]);
  assert.equal(env.chat.sends.length, before + 1, "no loop");
  const failed = env.store.get(task.id)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /An automatic retry was already tried\./);
  assert.equal(env.notifications.length, 1);
  assert.match(notificationText(env.notifications[0]!.tasks), /Error: .*An automatic retry was already tried\./);
  assert.equal(env.service.publicStatus(failed).status, "broken");

  // Any other error on the retry's turn says the same.
  const other = makeService({ chat: true });
  const second = await chatTask(other);
  await fail(other, second.threadId!, INCIDENT);
  await other.service.sweep();
  await fail(other, second.threadId!, [...INCIDENT, ...laterTurn(200, { status: "failed", error: "stream disconnected before completion" })], "stream disconnected before completion");
  assert.match(other.store.get(second.id)!.error!, /An automatic retry was already tried\./);
});

test("no retry when a newer message already reached the chat", async () => {
  const env = makeService({ chat: true });
  const task = await chatTask(env);
  const before = env.chat.sends.length;
  // The orchestrator's own follow-up went in after the failure.
  await fail(env, task.threadId!, [...INCIDENT, { id: "evt_130", seq: 130, type: "client/turn/requested", data: { requestId: "req_orch", target: { kind: "new-turn" }, source: "tell", input: [{ type: "text", text: "Your last turn ended with a provider error." }] } }]);
  assert.equal(env.chat.sends.length, before);
  assert.equal(env.store.get(task.id)!.status, "failed");
  // One queued in bb is a turn on its way: the task waits for it.
  const queued = makeService({ chat: true });
  const waiting = await chatTask(queued);
  queued.chat.events.set(waiting.threadId!, INCIDENT);
  queued.chat.finish(waiting.threadId!, "", "error");
  queued.chat.states.get(waiting.threadId!)!.queued = 1;
  await queued.service.syncChatThread(waiting.threadId!, { kind: "failed", error: BAD_REQUEST, at: Date.now() });
  assert.ok(!queued.chat.sends.some((send) => /Automatic retry/.test(send.text)));
  assert.equal(queued.store.get(waiting.id)!.status, "running");
});

test("no retry for a non-400 error, a stopped sandbox, or unreadable events", async () => {
  for (const [label, rows, error] of [
    ["rate limit", withError({ message: "Rate limit reached for requests", category: "rate-limit" }), "Rate limit reached for requests"],
    ["unauthorized", withError({ message: "Unauthorized", category: "unauthorized", httpStatusCode: 401 }), "Unauthorized"],
    ["5xx", withError({ message: "502 Bad Gateway", httpStatusCode: 502 }), "502 Bad Gateway"],
    ["tunnel", withError({ message: "tunnel closed unexpectedly" }), "tunnel closed unexpectedly"],
  ] as const) {
    // No failover: a limit would otherwise hand the task to the other agent first (its own path).
    const env = makeService({ chat: true, settings: { autoFailover: false } });
    const task = await chatTask(env);
    const before = env.chat.sends.length;
    await fail(env, task.threadId!, rows, error);
    assert.equal(env.chat.sends.length, before, label);
    assert.equal(env.store.get(task.id)!.status, "failed", label);
  }
  // The sandbox isn't running.
  const stopped = makeService({ chat: true });
  const task = await chatTask(stopped);
  stopped.chat.machineStates.set(task.hostId!, { phase: "suspended", connected: false, message: null });
  await fail(stopped, task.threadId!, INCIDENT);
  assert.ok(!stopped.chat.sends.some((send) => /Automatic retry/.test(send.text)));
  assert.equal(stopped.store.get(task.id)!.status, "failed");
  // bb can't list the chat's events: the failure stands.
  const unread = makeService({ chat: true });
  const other = await chatTask(unread);
  unread.chat.eventsError = new Error("events unavailable");
  await fail(unread, other.threadId!, INCIDENT);
  assert.equal(unread.store.get(other.id)!.status, "failed");
});

test("a closed task is never retried", async () => {
  const env = makeService({ chat: true });
  const task = await chatTask(env);
  env.chat.events.set(task.threadId!, INCIDENT);
  await env.service.closeTask(task.id, { status: "cancelled" });
  env.chat.finish(task.threadId!, "", "error");
  await env.service.syncChatThread(task.threadId!, { kind: "failed", error: BAD_REQUEST, at: Date.now() });
  assert.ok(!env.chat.sends.some((send) => /Automatic retry/.test(send.text)));
  assert.equal(env.chat.eventReads, 0);
});

test("the once-only record survives a plugin reload", async () => {
  const first = makeService({ chat: true });
  const task = await chatTask(first);
  await fail(first, task.threadId!, INCIDENT);
  const retries = () => first.chat.sends.filter((send) => /Automatic retry/.test(send.text)).length;
  assert.equal(retries(), 1);

  // bb reloads the plugin before the retry's turn starts: the chat still shows the failure.
  first.chat.states.get(task.threadId!)!.status = "error";
  const reloaded = makeService({ chat: true, reuse: { store: first.store, chat: first.chat, boat: first.boat } });
  await reloaded.service.syncChatThread(task.threadId!, { kind: "failed", error: BAD_REQUEST, at: Date.now() });
  await reloaded.service.sweep();
  assert.equal(retries(), 1);
  assert.equal(first.store.get(task.id)!.status, "running");
  assert.equal(reloaded.notifications.length, 0);

  // The retry's turn never shows up: after a minute the failure is reported, once.
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 2 * 60_000 });
  try {
    await reloaded.service.sweep();
    await reloaded.service.sizes.settled();
    await reloaded.service.deliverPending();
  } finally {
    mock.timers.reset();
  }
  assert.equal(retries(), 1);
  const failed = first.store.get(task.id)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /An automatic retry was already tried\./);
  assert.equal(reloaded.notifications.length, 1);
});

test("a retry that can't be sent leaves the failure to report", async () => {
  const env = makeService({ chat: true });
  const task = await chatTask(env);
  env.chat.send = async () => {
    throw new Error("bb refused the message");
  };
  await fail(env, task.threadId!, INCIDENT);
  const failed = env.store.get(task.id)!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.turns, task.turns);
  assert.match(failed.error!, /The automatic retry couldn't be sent\./);
  assert.equal(env.notifications.length, 1);
  assert.ok(!env.store.events(task.id, 50).some((event) => event.kind === "auto-retry"));
});
