import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatEventDto, TaskDto } from "../contract.ts";
import { groupTaskTranscript, taskReviews, transcriptMatches } from "../web/task-tab-logic.ts";

const event = (patch: Partial<ChatEventDto>): ChatEventDto => ({ type: "response", status: null, content: null, error: null, timestamp: null, tools: [], ...patch });

test("task transcript folds repeated prompt status while preserving replies and tool entries", () => {
  const turns = groupTaskTranscript([
    event({ type: "prompt", timestamp: 100, status: "running", content: "Fix the cart" }),
    event({ content: "Investigating", tools: ["exec_command"] }),
    event({ type: "prompt", timestamp: 100, status: "finished" }),
    event({ content: "Fixed the total" }),
    event({ type: "prompt", timestamp: 200, content: "Review it" }),
    event({ type: "usage_limit" }),
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].prompt, "Fix the cart");
  assert.equal(turns[0].status, "finished");
  assert.deepEqual(turns[0].content, ["Investigating", "Fixed the total"]);
  assert.deepEqual(turns[0].tools, ["exec_command"]);
  assert.deepEqual(turns[1].errors, ["Usage limit reached"]);
  assert.equal(transcriptMatches(turns[0], "EXEC_command"), true);
  assert.equal(transcriptMatches(turns[0], "the total"), true);
  assert.equal(transcriptMatches(turns[0], "not in this turn"), false);
});

test("a partial event window without a prompt remains visible and searchable", () => {
  const turns = groupTaskTranscript([event({ content: "Continued from an earlier window", error: "Permission denied" })]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].prompt, null);
  assert.equal(transcriptMatches(turns[0], "permission"), true);
  assert.deepEqual(groupTaskTranscript([]), []);
});

test("reviews belong to their implementation and stay chronological across task status", () => {
  const task = (id: string, role: TaskDto["role"], parentTaskId: string | null, createdAt: string) => ({ id, role, parentTaskId, createdAt }) as TaskDto;
  const tasks = [
    task("r2", "review", "implementation", "2026-11-07T02:00:00Z"),
    task("unrelated", "review", "other", "2026-11-07T00:00:00Z"),
    task("child-work", "implement", "implementation", "2026-11-07T00:00:00Z"),
    task("r1", "review", "implementation", "2026-11-07T01:00:00Z"),
  ];
  assert.deepEqual(taskReviews("implementation", tasks).map((row) => row.id), ["r1", "r2"]);
  assert.equal(tasks[0].id, "r2", "does not reorder the shared query cache");
});

test("transcript previews omit card markers but retain the message", async () => {
  const { transcriptPreview } = await import("../web/task-tab-logic.ts");
  assert.equal(transcriptPreview('Ready for review. ::boat-review{id="t_1234"} ::boat-ready{id="t_1234"}'), "Ready for review.");
});
