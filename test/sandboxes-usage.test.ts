import assert from "node:assert/strict";
import { test } from "node:test";
import {
  creditDifference,
  leaseBreakdownNote,
  machineCounts,
  readingStatus,
} from "../web/sandboxes-usage-logic.ts";

test("current counts distinguish guest power from activity, loading, and partial inventory", () => {
  assert.deepEqual(
    machineCounts(
      [
        { power: "on", state: "idle" },
        { power: "on", state: "running" },
        { power: "off", state: "stopped" },
      ],
      true,
    ),
    { on: 2, stopped: 1, unknown: 0, exact: true },
  );
  assert.deepEqual(machineCounts([], false), {
    on: 0,
    stopped: 0,
    unknown: 0,
    exact: false,
  });
  assert.equal(
    machineCounts([{ power: "unknown", state: "starting" }], true).exact,
    false,
  );
  assert.equal(
    machineCounts([{ power: "on", state: "idle" }], false).exact,
    false,
  );
  assert.equal(
    machineCounts([{ power: "off", state: "deleted" }], true).stopped,
    0,
  );
  assert.equal(machineCounts([{ power: "off", state: "cancelled" }], true).stopped, 0);
});

test("freshness retains observation times on failed refresh and never treats unknown as checked", () => {
  const at = "2026-06-10T12:00:00Z",
    now = Date.parse(at);
  assert.match(readingStatus(at, now), /^Checked /);
  assert.match(readingStatus(at, now + 11 * 60_000), /^Stale: last checked /);
  assert.match(readingStatus(at, now, true), /^Stale: last checked /);
  assert.equal(readingStatus(null, now), "Not checked yet");
  assert.equal(readingStatus(null, now, true), "Unavailable");
  assert.equal(readingStatus("invalid", now), "Not checked yet");
});

test("local lease breakdown stays unreconciled across currencies, unsupported periods and accounts", () => {
  const aligned = {
    currency: "USD" as const,
    periodStart: "2026-06-01T00:00:00Z",
    periodEnd: "2026-07-01T00:00:00Z",
  };
  assert.match(
    leaseBreakdownNote(aligned, "EUR"),
    /matching provider account total and currency are unavailable/,
  );
  assert.match(
    leaseBreakdownNote({ ...aligned, periodStart: null }, "USD"),
    /period is unavailable/,
  );
  assert.match(
    leaseBreakdownNote(aligned, "USD"),
    /account match is unverified/,
  );
  assert.match(
    leaseBreakdownNote(
      { ...aligned, periodStart: "2026-06-15T00:00:00Z" },
      "USD",
    ),
    /calendar month/,
  );
  // Equality of currencies and dates cannot prove account identity or provider line attribution.
  assert.match(leaseBreakdownNote(aligned, "USD"), /^Unreconciled:/);
});

test("credit exceeded is an account balance fact independent of current machines", () => {
  assert.equal(creditDifference(18.25, 9), 9.25);
  assert.equal(creditDifference(0, 9), -9);
  assert.equal(creditDifference(null, 9), null);
  assert.equal(creditDifference(0, null), null);
  assert.equal(machineCounts([], true).on, 0);
});
