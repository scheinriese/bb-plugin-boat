// A task chat's failed turn: did it take a steer, and was the failure a
// provider Bad Request? Fake event logs only, no providers.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isBadRequestFailure,
  isBadRequestText,
  goalBlockedSince,
  isSteerRetryText,
  readFailedTurn,
  readLatestTurn,
  retriesAfterSteer,
  steerRetryPrompt,
} from "../src/steer-retry.ts";
import { BAD_REQUEST, INCIDENT, STEER, laterTurn, without, withError } from "./steer-events.ts";

// ---------------------------------------------------------------- the matcher

test("the Bad Request matcher takes an explicit 400 or a bare Bad Request, and nothing else", () => {
  // The incident: no classification, the body is exactly {"detail":"Bad Request"}.
  assert.equal(isBadRequestFailure({ category: "unknown", httpStatusCode: null, texts: [BAD_REQUEST, BAD_REQUEST, BAD_REQUEST] }), true);
  assert.equal(isBadRequestFailure({ category: null, texts: ["Bad Request"] }), true);
  assert.equal(isBadRequestFailure({ texts: [" bad request "] }), true);
  // An explicit HTTP 400, whatever its body.
  assert.equal(isBadRequestFailure({ category: "bad-request", httpStatusCode: 400, texts: ["Invalid value for 'input'."] }), true);
  assert.equal(isBadRequestFailure({ category: "unknown", httpStatusCode: 400, texts: [] }), true);
  // A detail around a bare Bad Request doesn't hide it.
  assert.equal(isBadRequestFailure({ texts: [`unexpected status 400 Bad Request: ${BAD_REQUEST}`, BAD_REQUEST] }), true);

  // A category alone is not enough.
  assert.equal(isBadRequestFailure({ category: "bad-request", httpStatusCode: null, texts: ["Invalid value for 'input'."] }), false);
  assert.equal(isBadRequestFailure({ category: "bad-request", httpStatusCode: null, texts: [] }), false);
  // Only the bare forms count as text.
  for (const text of [
    "400 Bad Request",
    "HTTP 400: Bad Request",
    "Bad Request.",
    `unexpected status 400 Bad Request: ${BAD_REQUEST}`,
    '{"error":{"message":"Bad Request"}}',
    '{"message":"Bad Request"}',
    '{"detail":"Bad Request","code":"invalid"}',
    '{"detail":"Bad Request: invalid input"}',
    "Bad Request: invalid input",
  ]) {
    assert.equal(isBadRequestText(text), false, text);
    assert.equal(isBadRequestFailure({ category: "unknown", httpStatusCode: null, texts: [text] }), false, text);
  }

  // Other categories have their own paths.
  for (const category of ["rate-limit", "unauthorized", "billing", "budget-exceeded", "overloaded", "connection-failed", "stream-disconnected", "context-window-exceeded", "internal", "policy", "sandbox"]) {
    assert.equal(isBadRequestFailure({ category, httpStatusCode: 400, texts: [BAD_REQUEST] }), false, category);
  }
  // Other status codes.
  for (const status of [401, 403, 429, 500, 502, 503, 504]) {
    assert.equal(isBadRequestFailure({ category: "unknown", httpStatusCode: status, texts: [BAD_REQUEST] }), false, String(status));
  }
  // Texts that are something else.
  for (const text of [
    "Bad Gateway",
    "502 Bad Gateway",
    "Service Unavailable",
    "Internal Server Error",
    "Unauthorized",
    '{"detail":"Not Found"}',
    "You've hit your usage limit.",
    "Rate limit reached for requests",
    "tunnel closed unexpectedly",
    "stream disconnected before completion",
    "The model refused",
    "",
  ]) {
    assert.equal(isBadRequestFailure({ category: "unknown", httpStatusCode: null, texts: [text] }), false, text);
  }
  // A 400 or a Bad Request next to text that names a limit, auth or context size is that.
  assert.equal(isBadRequestFailure({ category: "unknown", httpStatusCode: 400, texts: ["maximum context length exceeded"] }), false);
  assert.equal(isBadRequestFailure({ category: "unknown", texts: [BAD_REQUEST, "rate limit reached"] }), false);
  assert.equal(isBadRequestFailure({ category: "unknown", texts: [BAD_REQUEST, "unexpected status 401 Unauthorized"] }), false);
  assert.equal(isBadRequestText(null), false);
});

// ---------------------------------------------------------------- the reading

test("the incident reads as a failed turn with one accepted steer and a Bad Request", () => {
  const turn = readFailedTurn(INCIDENT)!;
  assert.deepEqual(turn, { key: "turn:turn_a", status: "failed", startSeq: 0, steers: [STEER], opener: "Add a dark mode toggle.", badRequest: true, newerMessage: false, laterTurn: false, interrupted: false });
  assert.equal(retriesAfterSteer(turn), true);
  // Order doesn't matter (bb lists newest first).
  assert.deepEqual(readFailedTurn([...INCIDENT].reverse()), turn);
});

test("only a failed latest turn with an accepted steer qualifies", () => {
  // No steer: the same error is not this case.
  const plain = readFailedTurn(without("steer"))!;
  assert.deepEqual(plain.steers, []);
  assert.equal(plain.badRequest, true);
  assert.equal(retriesAfterSteer(plain), false);
  // A steer bb never accepted didn't reach the turn.
  assert.deepEqual(readFailedTurn(INCIDENT.filter((row) => row.id !== "evt_111"))!.steers, []);
  // A finished or interrupted turn isn't a failure.
  const ended = (status: string) => INCIDENT.map((row) => (row.type === "turn/completed" ? { ...row, data: { ...row.data, status } } : row));
  assert.equal(readFailedTurn(ended("completed")), null);
  assert.equal(readFailedTurn(ended("interrupted")), null);
  assert.equal(readFailedTurn(INCIDENT.filter((row) => row.type !== "turn/completed")), null);
  assert.equal(readFailedTurn([]), null);
  // An interrupt inside the turn.
  const stopped = [...INCIDENT, { id: "evt_119", seq: 119, type: "system/thread/interrupted", data: {} }];
  assert.equal(retriesAfterSteer(readFailedTurn(stopped)), false);
  // A non-400 error.
  assert.equal(retriesAfterSteer(readFailedTurn(withError({ message: "Rate limit reached", category: "rate-limit" }))), false);
  // bb's retried provider errors don't decide; the turn's own end does.
  const retried = INCIDENT.map((row) => (row.type === "provider/error" ? { ...row, data: { ...row.data, willRetry: true } } : row));
  assert.equal(readFailedTurn(retried)!.badRequest, true);
});

test("a steer counts only inside the failed turn, and bb's own notices never do", () => {
  // The steer was in an earlier turn that finished; the next turn failed on its own.
  const earlier = [...INCIDENT.map((row) => (row.type === "turn/completed" ? { ...row, data: { status: "completed" } } : row)), ...laterTurn(200, { status: "failed" })];
  const turn = readFailedTurn(earlier)!;
  assert.equal(turn.key, "turn:turn_200");
  assert.deepEqual(turn.steers, []);
  // "auto" joins a running turn when another input started it.
  const auto = INCIDENT.map((row) => (row.id === "evt_110" ? { ...row, data: { ...row.data, target: { kind: "auto", expectedTurnId: "turn_a" } } } : row));
  assert.deepEqual(readFailedTurn(auto)!.steers, [STEER]);
  const opener = INCIDENT.map((row) => (row.id === "evt_101" ? { ...row, data: { ...row.data, target: { kind: "auto", expectedTurnId: null } } } : row));
  assert.deepEqual(readFailedTurn(opener)!.steers, [STEER]);
  // A child's outcome delivered into the turn is not a steer anybody asked for.
  const notice = INCIDENT.map((row) => (row.id === "evt_110" ? { ...row, data: { ...row.data, systemMessageKind: "child-completed" } } : row));
  assert.deepEqual(readFailedTurn(notice)!.steers, []);
});

test("an interrupt after the failed completion vetoes the retry", () => {
  // A manual stop logged after turn/completed, before the plugin settled the failure.
  const stopped = [...INCIDENT, { id: "evt_122", seq: 122, type: "system/thread/interrupted", data: { reason: "manual-stop" } }];
  const turn = readFailedTurn(stopped)!;
  assert.equal(turn.key, "turn:turn_a");
  assert.equal(turn.interrupted, true);
  assert.equal(retriesAfterSteer(turn), false);
  // An interrupt in an earlier turn doesn't.
  const earlier = [{ id: "evt_090", seq: 90, type: "system/thread/interrupted", data: {} }, { id: "evt_091", seq: 91, type: "turn/completed", data: { status: "interrupted" } }, ...INCIDENT];
  assert.equal(retriesAfterSteer(readFailedTurn(earlier)), true);
});

test("the latest turn reads however it ended, and its goal can be seen going blocked", () => {
  // A finished turn after the failure: readFailedTurn has nothing, readLatestTurn has the finished one.
  const later = [...INCIDENT, ...laterTurn(200, { status: "completed" })];
  assert.equal(readFailedTurn(later), null);
  const turn = readLatestTurn(later)!;
  assert.equal(turn.key, "turn:turn_200");
  assert.equal(turn.status, "completed");
  assert.equal(turn.startSeq, 121);
  assert.equal(turn.opener, "Retry");
  // The goal went from active to blocked after the turn began.
  const goal = (seq: number, status: string) => ({ id: `g_${seq}`, seq, type: "thread/goal/updated", data: { objective: "Ship v2", status } });
  assert.equal(goalBlockedSince([goal(50, "active"), goal(130, "blocked")], 100), true);
  // Blocked before the turn, never active, paused in between, or active again: no.
  assert.equal(goalBlockedSince([goal(50, "active"), goal(90, "blocked")], 100), false);
  assert.equal(goalBlockedSince([goal(130, "blocked")], 100), false);
  assert.equal(goalBlockedSince([goal(50, "paused"), goal(130, "blocked")], 100), false);
  assert.equal(goalBlockedSince([goal(50, "active"), goal(130, "blocked"), goal(140, "active")], 100), false);
  // Codex's own goal state counts as well.
  const codex = (seq: number, status: string) => ({ id: `c_${seq}`, seq, type: "thread/extensionState/updated", data: { kind: "provider-codex/goal", payload: { objective: "Ship v2", status } } });
  assert.equal(goalBlockedSince([codex(50, "active"), codex(130, "blocked")], 100), true);
  // The retry message is known by its heading.
  assert.equal(isSteerRetryText(steerRetryPrompt([STEER])), true);
  assert.equal(isSteerRetryText("# Automatic retry is off"), false);
  assert.equal(isSteerRetryText("Your last turn ended with a provider error."), false);
});

test("a message that reached the chat after the failure is newer", () => {
  const followed = [...INCIDENT, { id: "evt_130", seq: 130, type: "client/turn/requested", data: { requestId: "req_next", target: { kind: "new-turn" }, input: [] } }];
  const turn = readFailedTurn(followed)!;
  assert.equal(turn.newerMessage, true);
  assert.equal(retriesAfterSteer(turn), false);
});

test("the retry restates the steer and asks for the report as before", () => {
  const prompt = steerRetryPrompt([STEER, "Second line\nand more"]);
  assert.match(prompt, /^# Automatic retry/);
  assert.match(prompt, /provider error \(Bad Request\) right after a steer/);
  assert.match(prompt, /> Keep the old settings route working too\./);
  assert.match(prompt, /> Second line\n> and more/);
  assert.match(prompt, /report block/);
  assert.doesNotMatch(steerRetryPrompt([""]), />/);
});


test("the chat runner reads only the lifecycle events, newest first, and drops malformed rows", async () => {
  const { createChatRunner } = await import("../src/chat.ts");
  const calls: Record<string, unknown>[] = [];
  const bb = {
    sdk: {
      threads: {
        events: {
          list: async (args: Record<string, unknown>) => {
            calls.push(args);
            return [INCIDENT[6], { seq: "x", type: "turn/completed" }, null, INCIDENT[0]];
          },
        },
      },
    },
  } as unknown as Parameters<typeof createChatRunner>[0];
  const rows = await createChatRunner(bb).turnEvents("thr_w1");
  assert.deepEqual(rows, [INCIDENT[6], INCIDENT[0]]);
  assert.deepEqual(calls, [{ threadId: "thr_w1", order: "desc", limit: "200", types: ["client/turn/requested", "turn/input/accepted", "turn/started", "turn/completed", "provider/error", "system/thread/interrupted"] }]);
});

test("withdrawing a queued message is confirmed by bb's queue, with a few retries", async () => {
  const { createChatRunner } = await import("../src/chat.ts");
  function runner(options: { deleteFails: number; listFails?: number; goneWithoutDelete?: boolean }) {
    let queued = true;
    const calls = { delete: 0, list: 0 };
    let listFails = options.listFails ?? 0;
    const bb = {
      sdk: {
        threads: {
          queuedMessages: {
            delete: async () => {
              calls.delete += 1;
              if (calls.delete <= options.deleteFails) throw new Error("bb didn't answer");
              queued = false;
              return { ok: true };
            },
            list: async () => {
              calls.list += 1;
              if (listFails > 0) {
                listFails -= 1;
                throw new Error("bb didn't answer");
              }
              return queued && !options.goneWithoutDelete ? [{ id: "qm_1" }, { id: "qm_other" }] : [{ id: "qm_other" }];
            },
          },
        },
      },
    } as unknown as Parameters<typeof createChatRunner>[0];
    return { chat: createChatRunner(bb, { withdrawBackoffMs: [1, 1] }), calls };
  }
  // The first two deletes fail; the third works, and the queue confirms it.
  const retried = runner({ deleteFails: 2 });
  assert.equal(await retried.chat.withdraw("thr_w1", "qm_1"), "removed");
  assert.deepEqual(retried.calls, { delete: 3, list: 3 });
  // Every delete fails and the queue still lists it: stuck, after three tries.
  const stuck = runner({ deleteFails: 99 });
  assert.equal(await stuck.chat.withdraw("thr_w1", "qm_1"), "stuck");
  assert.deepEqual(stuck.calls, { delete: 3, list: 3 });
  // A delete that seemed to fail but the row is gone: removed.
  const gone = runner({ deleteFails: 99, goneWithoutDelete: true });
  assert.equal(await gone.chat.withdraw("thr_w1", "qm_1"), "removed");
  assert.equal(gone.calls.delete, 1);
  // A queue bb can't list isn't a confirmation.
  const unlisted = runner({ deleteFails: 0, listFails: 1 });
  assert.equal(await unlisted.chat.withdraw("thr_w1", "qm_1"), "removed");
  assert.deepEqual(unlisted.calls, { delete: 2, list: 2 });
});

test("a blocked goal's stretch begins at its first blocked snapshot, however often it repeats", () => {
  const goal = (seq: number, status: string) => ({ id: `g_${seq}`, seq, type: "thread/goal/updated", data: { objective: "Ship v2", status } });
  // Blocked before the failed turn (which starts after 150), then repeated after it: not this failure's doing.
  assert.equal(goalBlockedSince([goal(100, "active"), goal(140, "blocked"), goal(224, "blocked")], 150), false);
  assert.equal(goalBlockedSince([goal(100, "active"), goal(140, "blocked"), goal(170, "blocked"), goal(224, "blocked")], 150), false);
  // Blocked within the failed turn, then repeated: still this failure's doing.
  assert.equal(goalBlockedSince([goal(100, "active"), goal(160, "blocked"), goal(224, "blocked")], 150), true);
  // Active again in between: the stretch that counts begins after that.
  assert.equal(goalBlockedSince([goal(100, "active"), goal(140, "blocked"), goal(145, "active"), goal(160, "blocked"), goal(230, "blocked")], 150), true);
  // Blocked from the start, or after a pause: no.
  assert.equal(goalBlockedSince([goal(50, "blocked"), goal(160, "blocked")], 150), false);
  assert.equal(goalBlockedSince([goal(100, "paused"), goal(160, "blocked"), goal(224, "blocked")], 150), false);
});
