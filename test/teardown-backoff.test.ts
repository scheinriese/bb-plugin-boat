// After boat.dev fails a stop or delete, bb's retries in between don't reach boat.dev.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TeardownBackoff } from "../src/teardown-backoff.ts";

test("a failed teardown step holds that sandbox's next ones, doubling up to 15 minutes", () => {
  let at = Date.parse("2026-11-19T00:10:00Z");
  const backoff = new TeardownBackoff(() => at);
  assert.equal(backoff.held("bx_a", "delete"), null);
  assert.equal(backoff.failed("bx_a", "delete", new Error("Please reduce your request rate.\nmore lines")), "boat.dev failed to delete this sandbox (Please reduce your request rate.). Boat asks it again at 00:10 UTC.");
  assert.equal(backoff.held("bx_a", "delete"), "boat.dev failed to delete this sandbox a moment ago (Please reduce your request rate.). Boat asks it again at 00:10 UTC.");
  assert.equal(backoff.held("bx_b", "delete"), null, "other sandboxes aren't held");
  assert.equal(backoff.held("bx_a", "stop"), null, "nor the sandbox's other steps");
  at += 30_000;
  assert.equal(backoff.held("bx_a", "delete"), null, "30 seconds after the first failure");
  backoff.failed("bx_a", "delete", new Error("503"));
  at += 59_000;
  assert.notEqual(backoff.held("bx_a", "delete"), null, "60 seconds after the second");
  at += 1_000;
  assert.equal(backoff.held("bx_a", "delete"), null);
  for (let index = 0; index < 10; index++) backoff.failed("bx_a", "delete", new Error("503"));
  at += 15 * 60_000 - 1;
  assert.notEqual(backoff.held("bx_a", "delete"), null);
  at += 1;
  assert.equal(backoff.held("bx_a", "delete"), null, "never more than 15 minutes");
  backoff.failed("bx_a", "delete", new Error("503"));
  backoff.succeeded("bx_a", "delete");
  assert.equal(backoff.held("bx_a", "delete"), null, "a success clears it");
});
