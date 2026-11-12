// A task chat's failed turn: did it take a steer, and was the failure a
// provider Bad Request? Fake event logs only, no providers.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isBadRequestFailure,
  isBadRequestText,
  readFailedTurn,
  retriesAfterSteer,
  steerRetryPrompt,
} from "../src/steer-retry.ts";
import { BAD_REQUEST, INCIDENT, STEER, laterTurn, without, withError } from "./steer-events.ts";

// ---------------------------------------------------------------- the matcher

test("the Bad Request matcher takes a provider 400 and nothing else", () => {
  // The incident: no classification, the body says Bad Request.
  assert.equal(isBadRequestFailure({ category: "unknown", httpStatusCode: null, texts: [BAD_REQUEST, BAD_REQUEST, BAD_REQUEST] }), true);
  assert.equal(isBadRequestFailure({ category: null, texts: ["Bad Request"] }), true);
  assert.equal(isBadRequestFailure({ texts: ["400 Bad Request"] }), true);
  assert.equal(isBadRequestFailure({ texts: ["HTTP 400: Bad Request"] }), true);
  assert.equal(isBadRequestFailure({ texts: [`unexpected status 400 Bad Request: ${BAD_REQUEST}`] }), true);
  assert.equal(isBadRequestFailure({ texts: ['{"error":{"message":"Bad Request","type":"invalid_request_error"}}'] }), true);
  // The provider's own classification.
  assert.equal(isBadRequestFailure({ category: "bad-request", httpStatusCode: 400, texts: ["Invalid value for 'input'."] }), true);
  assert.equal(isBadRequestFailure({ category: "unknown", httpStatusCode: 400, texts: [] }), true);

  // Other categories have their own paths.
  for (const category of ["rate-limit", "unauthorized", "billing", "budget-exceeded", "overloaded", "connection-failed", "stream-disconnected", "context-window-exceeded", "internal", "policy", "sandbox"]) {
    assert.equal(isBadRequestFailure({ category, httpStatusCode: null, texts: [BAD_REQUEST] }), false, category);
  }
  // Other status codes.
  for (const status of [401, 403, 429, 500, 502, 503, 504]) {
    assert.equal(isBadRequestFailure({ category: "unknown", httpStatusCode: status, texts: [BAD_REQUEST] }), false, String(status));
  }
  // Texts that are something else, or a Bad Request mixed with something else.
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
    "Bad Request: usage limit reached",
    "unexpected status 400 Bad Request: maximum context length exceeded",
    "unexpected status 401 Unauthorized: {\"detail\":\"Bad Request\"}",
    "The model refused",
    "",
  ]) {
    assert.equal(isBadRequestFailure({ category: "unknown", httpStatusCode: null, texts: [text] }), false, text);
  }
  // A Bad Request whose other text names a limit is a limit.
  assert.equal(isBadRequestFailure({ category: "bad-request", texts: ["usage limit reached"] }), false);
  assert.equal(isBadRequestFailure({ category: "unknown", texts: [BAD_REQUEST, "rate limit reached"] }), false);
  assert.equal(isBadRequestText(null), false);
});

// ---------------------------------------------------------------- the reading

test("the incident reads as a failed turn with one accepted steer and a Bad Request", () => {
  const turn = readFailedTurn(INCIDENT)!;
  assert.deepEqual(turn, { key: "turn:turn_a", steers: [STEER], badRequest: true, newerMessage: false, interrupted: false });
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
