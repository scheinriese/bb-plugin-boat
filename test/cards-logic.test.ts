import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskDto } from "../contract.ts";
import {
  cardStatus,
  contextCounts,
  markerId,
  queueDelivery,
  recommendedOption,
  type CardStatus,
} from "../web/cards-logic.ts";

const task = (
  id: string,
  status: CardStatus["status"],
  extra: Partial<CardStatus> = {},
): TaskDto =>
  ({
    id,
    phase: "working",
    source: { kind: "chat" },
    publicStatus: {
      status,
      label: status,
      tone: "neutral",
      needsYou: false,
      reason: null,
      moving: status === "working",
      ...extra,
    },
  }) as unknown as TaskDto;

test("v1 status takes precedence over legacy phase", () => {
  assert.equal(
    cardStatus(task("t_a", "waiting-reset")).status,
    "waiting-reset",
  );
  assert.equal(cardStatus(task("t_a", "stopped")).moving, false);
});
test("context counts ready, decisions and working; neutral stops and usage waits stay quiet", () => {
  const tasks = [
    task("t_a", "ready"),
    task("t_b", "working"),
    task("t_c", "stopped"),
    task("t_d", "waiting-reset"),
    task("t_e", "needs-you", { needsYou: true }),
  ];
  assert.equal(
    contextCounts(tasks, 1, ["t_e"]),
    "1 ready · 1 needs you · 1 working",
  );
  assert.equal(contextCounts(tasks, 1), "1 ready · 2 need you · 1 working");
});
test("markers accept identifiers and reject path-like or unbounded attributes", () => {
  assert.equal(markerId("t_abcd"), "t_abcd");
  for (const value of [
    "../private",
    "t_a/b",
    "<script>",
    "x".repeat(129),
    null,
  ])
    assert.equal(markerId(value), null);
});
test("Undo cancels queued delivery before any mutation", async () => {
  let sent = 0;
  const cancel = queueDelivery(async () => {
    sent++;
  }, 10);
  assert.equal(cancel(), true);
  assert.equal(cancel(), false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(sent, 0);
});
test("delivery waits for undo window and becomes irrevocable once sending starts", async () => {
  let sent = 0;
  const cancel = queueDelivery(async () => {
    sent++;
  }, 10);
  assert.equal(sent, 0);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(sent, 1);
  assert.equal(cancel(), false);
});

test("a prose recommendation selects the named option without inventing a recommendation", () => {
  assert.equal(
    recommendedOption(["A", "B"], "B: calmer, matches the grid"),
    "B",
  );
  assert.equal(
    recommendedOption(["Strict", "Generous"], "Generous"),
    "Generous",
  );
  assert.equal(recommendedOption(["A", "B"], "Ask the team first"), null);
});
