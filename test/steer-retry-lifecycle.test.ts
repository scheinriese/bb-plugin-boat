// One automatic retry of a task chat's turn that failed with a provider Bad
// Request right after a steer: the task lifecycle around it. Fakes only.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { notificationText } from "../src/format.ts";
import { projectHistoryEvent } from "../src/history.ts";
import { isSteerRetryText, type TurnEventRow } from "../src/steer-retry.ts";
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

/** The plugin sent its automatic retry into a chat. */
function retries(env: ReturnType<typeof makeService>): number {
  return env.chat.sends.filter((send) => isSteerRetryText(send.text)).length;
}

const STOPPED: TurnEventRow = { id: "evt_122", seq: 122, type: "system/thread/interrupted", data: { reason: "manual-stop" } };

test("a message that arrives while the plugin checks the sandbox stops the retry", async () => {
  // The user writes to the worker while bb answers the machine-state call: a new turn starts.
  const env = makeService({ chat: true });
  const task = await chatTask(env);
  env.chat.onMachineState = () => {
    env.chat.events.set(task.threadId!, [...INCIDENT, ...laterTurn(140, { status: "completed" }).slice(0, 3)]);
    env.chat.states.get(task.threadId!)!.status = "active";
  };
  await fail(env, task.threadId!, INCIDENT);
  assert.equal(retries(env), 0);
  // The task follows the user's turn instead: not failed, no notice yet.
  assert.equal(env.store.get(task.id)!.status, "running");
  assert.equal(env.notifications.length, 0);
  env.chat.onMachineState = null;
  await env.service.sweep(); // seen busy
  env.chat.events.set(task.threadId!, [...INCIDENT, ...laterTurn(140, { status: "completed" })]);
  env.chat.finish(task.threadId!, "Done.\n\n=== REPORT ===\nSTATUS: done\n=== END REPORT ===");
  await env.service.sweep();
  await env.service.sizes.settled();
  await env.service.deliverPending();
  assert.equal(retries(env), 0, "never fires later");
  assert.equal(env.store.get(task.id)!.status, "idle");
  assert.equal(env.notifications.length, 1);
  assert.doesNotMatch(notificationText(env.notifications[0]!.tasks, (id) => env.store.events(id, 30)), /automatic retry/);

  // A message bb queued meanwhile: the same.
  const queued = makeService({ chat: true });
  const waiting = await chatTask(queued);
  queued.chat.onMachineState = () => {
    queued.chat.events.set(waiting.threadId!, [...INCIDENT, { id: "evt_140", seq: 140, type: "client/turn/requested", data: { requestId: "req_user", target: { kind: "new-turn" }, input: [{ type: "text", text: "Try again" }] } }]);
    queued.chat.states.get(waiting.threadId!)!.queued = 1;
  };
  await fail(queued, waiting.threadId!, INCIDENT);
  assert.equal(retries(queued), 0);
  assert.equal(queued.store.get(waiting.id)!.status, "running");

  // An interrupt meanwhile: no retry, the failure is reported.
  const stopped = makeService({ chat: true });
  const halted = await chatTask(stopped);
  stopped.chat.onMachineState = () => void stopped.chat.events.set(halted.threadId!, [...INCIDENT, STOPPED]);
  await fail(stopped, halted.threadId!, INCIDENT);
  assert.equal(retries(stopped), 0);
  assert.equal(stopped.store.get(halted.id)!.status, "failed");
  assert.doesNotMatch(stopped.store.get(halted.id)!.error!, /automatic retry/);

  // The task closed meanwhile.
  const closed = makeService({ chat: true });
  const gone = await chatTask(closed);
  closed.chat.onMachineState = async () => void (await closed.service.closeTask(gone.id, { status: "cancelled" }));
  await fail(closed, gone.threadId!, INCIDENT);
  assert.equal(retries(closed), 0);
  assert.equal(closed.store.get(gone.id)!.status, "cancelled");
});

test("an interrupt after the failed completion vetoes the retry", async () => {
  // bb logged a manual stop after the failed turn, before the plugin settled the failure.
  const env = makeService({ chat: true });
  const task = await chatTask(env);
  await fail(env, task.threadId!, [...INCIDENT, STOPPED]);
  assert.equal(retries(env), 0);
  assert.equal(env.store.get(task.id)!.status, "failed");

  // The orchestrator's boat_interrupt (or the page's Interrupt) in the same gap.
  const other = makeService({ chat: true });
  const second = await chatTask(other);
  other.chat.events.set(second.threadId!, INCIDENT);
  other.chat.finish(second.threadId!, "", "error");
  await other.service.interruptTask(second.id);
  other.chat.states.get(second.threadId!)!.status = "error"; // nothing ran, so the failure still shows
  await other.service.syncChatThread(second.threadId!, { kind: "failed", error: BAD_REQUEST, at: Date.now() });
  assert.equal(retries(other), 0);
  assert.equal(other.store.get(second.id)!.status, "failed");
  assert.ok(other.store.events(second.id, 50).some((event) => event.kind === "interrupt-requested"));
});

test("a retry bb queues instead of starting is withdrawn at once, so it never runs after newer work", async () => {
  // A user's message won the race: bb queues the retry behind that turn.
  const env = makeService({ chat: true });
  const task = await chatTask(env);
  env.chat.queueSends = { waitingOn: "thread-busy" };
  await fail(env, task.threadId!, INCIDENT);
  assert.equal(retries(env), 1, "sent once");
  assert.deepEqual(env.chat.withdrawn, [{ threadId: task.threadId!, queuedMessageId: `qm_${env.chat.sends.length}` }]);
  // Not a retry after all: the task follows the other turn, and nothing of the retry is left in bb's queue.
  const after = env.store.get(task.id)!;
  assert.equal(after.status, "running");
  assert.equal(after.promptId, task.promptId);
  assert.equal(after.turns, task.turns);
  assert.equal(env.service.publicStatus(after).retrying, undefined);
  const events = env.store.events(task.id, 50);
  assert.ok(events.some((event) => event.kind === "auto-retry-skipped"));
  assert.ok(!events.some((event) => event.kind === "auto-retry"));
  // The same failed turn seen again: skipped for good, no "already tried" note.
  env.chat.queueSends = null;
  env.chat.states.get(task.threadId!)!.status = "error";
  await env.service.syncChatThread(task.threadId!, { kind: "failed", error: BAD_REQUEST, at: Date.now() });
  assert.equal(retries(env), 1);
  assert.equal(env.store.get(task.id)!.status, "failed");
  assert.doesNotMatch(env.store.get(task.id)!.error!, /automatic retry/);

  // Held by another plugin's policy: withdrawn too, and the failure is reported as before.
  const held = makeService({ chat: true });
  const second = await chatTask(held);
  held.chat.queueSends = { waitingOn: "plugin" };
  await fail(held, second.threadId!, INCIDENT);
  assert.equal(held.chat.withdrawn.length, 1);
  assert.equal(held.store.get(second.id)!.status, "failed");
  assert.match(held.store.get(second.id)!.error!, /The automatic retry couldn't be sent\./);
  assert.equal(held.notifications.length, 1);
});

test("a queued retry bb won't let go of stays guarded, refused at dispatch, and is never a retry", async () => {
  for (const waitingOn of ["thread-busy", "plugin"]) {
    const env = makeService({ chat: true });
    const task = await chatTask(env);
    env.chat.queueSends = { waitingOn };
    env.chat.withdrawResult = "stuck";
    await fail(env, task.threadId!, INCIDENT);
    const id = `qm_${env.chat.sends.length}`;
    assert.deepEqual(env.chat.withdrawn, [{ threadId: task.threadId!, queuedMessageId: id }], waitingOn);
    // Not recorded as a retry: the task follows the other turn, or reports the failure.
    const after = env.store.get(task.id)!;
    assert.equal(env.service.publicStatus(after).retrying, undefined, waitingOn);
    assert.ok(!env.store.events(task.id, 50).some((event) => event.kind === "auto-retry"), waitingOn);
    assert.equal(after.status, waitingOn === "plugin" ? "failed" : "running", waitingOn);
    // The guard stays on that exact row (bb's dispatch hook refuses it), and a warning says so.
    assert.equal(env.store.guardedQueuedMessage(["qm_other", id]), id);
    assert.equal(env.store.guardedQueuedMessage(["qm_other"]), null);
    assert.ok(env.warnings.some((line) => line.includes(`couldn't remove the queued retry ${id}`)), waitingOn);
  }
  // Removed for sure: no guard left.
  const removed = makeService({ chat: true });
  const task = await chatTask(removed);
  removed.chat.queueSends = { waitingOn: "plugin" };
  await fail(removed, task.threadId!, INCIDENT);
  assert.equal(removed.store.guardedQueuedMessage([`qm_${removed.chat.sends.length}`]), null);
});

test("a chat busy at send time skips the retry for good", async () => {
  const env = makeService({ chat: true });
  const task = await chatTask(env);
  // The final look right before the send finds a turn running.
  env.chat.onMachineState = () => void (env.chat.states.get(task.threadId!)!.status = "active");
  await fail(env, task.threadId!, INCIDENT);
  assert.equal(retries(env), 0);
  assert.ok(env.store.events(task.id, 50).some((event) => event.kind === "auto-retry-skipped"));
  // That turn ends, and the failure shows again: still no retry.
  env.chat.onMachineState = null;
  env.chat.states.get(task.threadId!)!.status = "error";
  await env.service.syncChatThread(task.threadId!, { kind: "failed", error: BAD_REQUEST, at: Date.now() });
  assert.equal(retries(env), 0);
  assert.equal(env.store.get(task.id)!.status, "failed");
});

test("a failure bb reports before it's in the event log is read again, a bounded number of times", async () => {
  // turn/completed (and its provider error) land in the log a moment after thread.failed.
  const unlogged = INCIDENT.filter((row) => row.type !== "turn/completed" && row.type !== "provider/error");
  const env = makeService({ chat: true });
  const task = await chatTask(env);
  env.chat.onEventRead = (threadId, read) => {
    if (read === 2) env.chat.events.set(threadId, INCIDENT);
  };
  await fail(env, task.threadId!, unlogged);
  assert.equal(retries(env), 1);
  assert.equal(env.chat.eventReads, 3, "two reads to find it, one more right before the send");

  // Never logged: after the first read and two more, the failure is reported as before.
  const other = makeService({ chat: true });
  const second = await chatTask(other);
  await fail(other, second.threadId!, unlogged);
  assert.equal(other.chat.eventReads, 3);
  assert.equal(retries(other), 0);
  assert.equal(other.store.get(second.id)!.status, "failed");
});

/** A real queued-start capability models only the native owner's scoped grant. */
async function scopedCustomChat(env: ReturnType<typeof makeService>) {
  const { task } = await env.service.launchTask({
    title: "Fake panel exploration", role: "custom", brief: "Explore the panel layout.",
    repo: "acme/web", provider: "claude", runner: "chat", orchestratorThreadId: "thr_orch", projectId: "proj_personal",
    queuedStart: { taskId: "t_fake_scoped_retry", paidApproved: true, claudePaidContinuation: true, beforeInsert: async () => undefined, insert: (_task, save) => save() },
  }, 5_000);
  await env.service.sweep();
  return task;
}

function scopedRetryUsage(): import("../src/quota.ts").Quotas {
  return new Map([
    ["claude", { provider: "claude", usedPercent: 95, resetsAt: null, window: "Weekly limit", paidAttemptAllowed: true }],
    ["codex", { provider: "codex", usedPercent: 20, resetsAt: null, window: "Weekly limit" }],
  ]);
}

test("scoped custom task still retries a stable accepted-steer Bad Request once", async () => {
  const env = makeService({ chat: true, quotas: scopedRetryUsage() });
  const task = await scopedCustomChat(env);
  await fail(env, task.threadId!, INCIDENT);
  assert.equal(retries(env), 1);
  assert.equal(env.store.get(task.id)!.provider, "claude");
  assert.equal(env.store.get(task.id)!.claudePaidContinuation, true);
  await env.service.syncChatThread(task.threadId!, { kind: "failed", error: BAD_REQUEST, at: Date.now() });
  assert.equal(retries(env), 1, "the unchanged stopped turn is not retried twice");
});

test("a newer authentication failure during scoped consent quota reads vetoes the earlier steer retry", async () => {
  const usage = scopedRetryUsage();
  let duringQuotaRead: (() => void) | null = null;
  const env = makeService({ chat: true, get quotas() { duringQuotaRead?.(); return usage; } });
  const task = await scopedCustomChat(env);
  const before = env.chat.sends.length;
  duringQuotaRead = () => {
    duringQuotaRead = null;
    // The chat advances independently of the task registry's prompt marker.
    // This is the reported race: a new refused request lands while the paid
    // consent path is still awaiting its fresh account-route reading.
    env.chat.events.set(task.threadId!, [...INCIDENT, ...laterTurn(200, { status: "failed", error: "Authentication failed" })]);
    env.chat.states.get(task.threadId!)!.status = "error";
  };
  await fail(env, task.threadId!, INCIDENT);
  assert.equal(duringQuotaRead, null, "the race happened inside the consent quota read");
  assert.equal(env.chat.sends.length, before, "the old steer is not replayed past the newer authentication refusal");
  assert.equal(retries(env), 0);
  assert.equal(env.store.events(task.id).some(event => event.kind === "auto-retry"), false);
  assert.equal(env.chat.events.get(task.threadId!)?.at(-1)?.data?.status, "failed");
});

for (const change of ["request", "close", "revoke", "prompt", "chat"] as const) {
  test(`scoped steer retry rechecks ${change} at the final event-read boundary`, async () => {
    const env = makeService({ chat: true, quotas: scopedRetryUsage() });
    const task = await scopedCustomChat(env);
    const before = env.chat.sends.length;
    let raced = false;
    env.chat.onEventRead = (threadId, read) => {
      if (read !== 2) return;
      raced = true;
      if (change === "request") {
        // A newer request can reach core before Boat's task row is updated.
        env.chat.events.set(threadId, [...INCIDENT, { id: "evt_new_request", seq: 200, type: "client/turn/requested", data: { requestId: "req_new", target: { kind: "new-turn" }, input: [{ type: "text", text: "Use the updated brief." }] } }]);
      } else if (change === "close") env.store.update(task.id, { status: "cancelled", claudePaidContinuation: false, claudePaidContinuationRevoked: true });
      else if (change === "revoke") env.store.update(task.id, { claudePaidContinuation: false, claudePaidContinuationRevoked: true });
      else if (change === "prompt") env.store.update(task.id, { promptId: "chat:newer-request", turns: task.turns + 1 });
      else env.store.update(task.id, { threadId: "thr_new_workspace_chat" });
    };
    await fail(env, task.threadId!, INCIDENT);
    assert.equal(raced, true, "the final event read overlapped the competing update");
    assert.equal(env.chat.sends.length, before, `no retry or steer after ${change}`);
    assert.equal(retries(env), 0);
    assert.equal(env.store.events(task.id).some(event => event.kind === "auto-retry"), false);
  });
}

test("a project opting out during the final scoped retry event read vetoes automatic continuation", async () => {
  const env = makeService({ chat: true, quotas: scopedRetryUsage() });
  const task = await scopedCustomChat(env);
  const before = env.chat.sends.length;
  let optedOut = false;
  env.chat.onEventRead = (_threadId, read) => {
    if (read !== 2) return;
    optedOut = true;
    env.setProjects([{ id: "web", name: "Web", repos: [{ repo: "acme/web" }], machineType: null, neverPaidClaude: true }]);
  };
  await fail(env, task.threadId!, INCIDENT);
  assert.equal(optedOut, true);
  assert.equal(env.chat.sends.length, before, "no automatic Claude send after the current project opts out");
  assert.equal(retries(env), 0);
});

type RetryReadBoundary = "machine" | "quota" | "settings" | "chat state" | "events";
type RetryBoundaryChange = "authentication failure" | "project opt-out" | "consent removal" | "revocation" | "closure" | "new request" | "provider change";

// Core chat state/events, task consent and project policy have independent
// lifecycles. Mutate each while a real asynchronous read is in progress,
// without changing the task's prompt marker to conceal the competing change.
async function retryBoundaryScenario(scoped: boolean, boundary: RetryReadBoundary, change: RetryBoundaryChange) {
  const usage = scopedRetryUsage();
  if (!scoped) usage.get("codex")!.usedPercent = 100;
  let armed = false, changed = false;
  let mutate = () => undefined;
  const race = () => {
    if (!armed || changed) return;
    changed = true;
    mutate();
  };
  const env = makeService({
    chat: true,
    get quotas() { if (boundary === "quota") race(); return usage; },
    ...(!scoped ? { settings: { relay: { enabled: true, preferred: "claude" as const, switchAtPercent: 90, switchBackBelowPercent: 50, quietMinutes: 10, paidClaudeFallback: true } } } : {}),
  });
  const task = scoped ? await scopedCustomChat(env) : (await env.service.launchTask({
    title: "Fake global-policy layout", role: "custom", brief: "Explore the fake layout.",
    repo: "acme/web", provider: "claude", runner: "chat", orchestratorThreadId: "thr_orch", projectId: "proj_personal",
  }, 5_000)).task;
  if (!scoped) {
    await env.service.sweep();
    assert.ok(env.store.latestEvent(task.id, "paid-fallback-authorized"), "the global policy, not task consent, authorizes this task");
  }
  const before = env.chat.sends.length;
  mutate = () => {
    if (change === "authentication failure") {
      env.chat.events.set(task.threadId!, [...INCIDENT, ...laterTurn(200, { status: "failed", error: "Authentication failed" })]);
      env.chat.states.get(task.threadId!)!.status = "error";
    } else if (change === "project opt-out") {
      env.setProjects([{ id: "web", name: "Web", repos: [{ repo: "acme/web" }], machineType: null, neverPaidClaude: true }]);
    } else if (change === "consent removal") env.store.update(task.id, { claudePaidContinuation: false });
    else if (change === "revocation") env.store.update(task.id, { claudePaidContinuation: false, claudePaidContinuationRevoked: true });
    else if (change === "closure") env.store.update(task.id, { status: "cancelled" });
    else if (change === "new request") {
      env.chat.events.set(task.threadId!, [...INCIDENT, { id: "evt_competing_request", seq: 200, type: "client/turn/requested", data: { requestId: "req_competing", target: { kind: "new-turn" }, input: [{ type: "text", text: "Use the new task requirements." }] } }]);
    } else env.store.update(task.id, { provider: "codex" });
  };
  env.chat.onEventRead = () => {
    if (!armed) { armed = true; return; }
    if (boundary === "events") race();
  };
  env.chat.onMachineState = () => { if (boundary === "machine") race(); };
  const readState = env.chat.state.bind(env.chat);
  env.chat.state = async threadId => {
    const result = await readState(threadId);
    if (boundary === "chat state") race();
    return result;
  };
  const readSettings = env.service.settings.bind(env.service);
  env.service.settings = async () => {
    const result = await readSettings();
    if (boundary === "settings") race();
    return result;
  };
  await fail(env, task.threadId!, INCIDENT);
  assert.equal(changed, true, `${boundary} overlapped ${change}`);
  assert.equal(env.chat.sends.length, before, `no retry or steer after ${change} during ${boundary}`);
  assert.equal(retries(env), 0);
  assert.equal(env.store.events(task.id).some(event => event.kind === "auto-retry"), false);
}

for (const boundary of ["machine", "quota", "settings", "chat state", "events"] as const) {
  for (const change of ["authentication failure", "project opt-out", "consent removal", "revocation", "closure", "new request", "provider change"] as const) {
    test(`scoped automatic retry rejects ${change} during ${boundary} read`, () => retryBoundaryScenario(true, boundary, change));
  }
}

// Global policy has no per-task consent read; it must still respect current
// project/task/core state across the SDK boundaries it does await.
for (const boundary of ["machine", "chat state", "events"] as const) {
  for (const change of ["authentication failure", "project opt-out", "revocation", "closure", "new request", "provider change"] as const) {
    test(`global-policy automatic retry rejects ${change} during ${boundary} read`, () => retryBoundaryScenario(false, boundary, change));
  }
}

for (const scoped of [true, false]) {
  for (const providerId of ["claude-code", "codex"] as const) {
    test(`${scoped ? "scoped" : "global-policy"} retry validates known provider ${providerId} in the final core state`, async () => {
      const usage = scopedRetryUsage();
      if (!scoped) usage.get("codex")!.usedPercent = 100;
      const env = makeService({ chat: true, quotas: usage, ...(!scoped ? { settings: { relay: { enabled: true, preferred: "claude" as const, switchAtPercent: 90, switchBackBelowPercent: 50, quietMinutes: 10, paidClaudeFallback: true } } } : {}) });
      const task = scoped ? await scopedCustomChat(env) : (await env.service.launchTask({
        title: "Fake provider snapshot", role: "custom", brief: "Explore the fake layout.",
        repo: "acme/web", provider: "claude", runner: "chat", projectId: "proj_personal",
      }, 5_000)).task;
      if (!scoped) await env.service.sweep();
      const before = env.chat.sends.length;
      const readState = env.chat.state.bind(env.chat);
      let finalSnapshotReturned = false;
      env.chat.state = async threadId => {
        const state = await readState(threadId);
        if (!state || env.chat.eventReads === 0) return state;
        finalSnapshotReturned = true;
        // Core's provider can change independently of the task registry. Use a
        // returned snapshot, not mutation of a shared fake object after reads.
        return { ...state, providerId };
      };
      await fail(env, task.threadId!, INCIDENT);
      assert.equal(finalSnapshotReturned, true);
      assert.equal(env.chat.sends.length - before, providerId === "claude-code" ? 1 : 0);
      assert.equal(retries(env), providerId === "claude-code" ? 1 : 0);
      assert.equal(env.store.get(task.id)!.provider, "claude");
    });
  }
}
