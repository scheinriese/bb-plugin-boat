import assert from "node:assert/strict";
import { test } from "node:test";
import { resetTimeText } from "../lib/reset-time.ts";
import { resetWaitText } from "../src/sidebar-reset.ts";

const at = (iso: string) => Date.parse(iso);
// Berlin winter time: local is UTC+1, so the JavaScript offset is -60.
const BERLIN = -60;
// Tuesday 2026-11-17, 11:00 in Berlin.
const NOW = at("2026-11-17T10:00:00Z");

test("a reset later today shows only the clock", () => {
  assert.equal(resetTimeText(at("2026-11-17T21:30:00Z"), NOW, BERLIN), "10:30 pm");
  assert.equal(resetTimeText(at("2026-11-17T10:05:00Z"), NOW, BERLIN), "11:05 am");
  // Earlier the same day (a reset that just passed) still reads as a clock.
  assert.equal(resetTimeText(at("2026-11-17T08:00:00Z"), NOW, BERLIN), "9:00 am");
});

test("an overnight reset under 12 hours away shows only the clock; otherwise it says tomorrow", () => {
  const evening = at("2026-11-17T21:00:00Z"); // Tue 22:00 in Berlin
  assert.equal(resetTimeText(at("2026-11-18T00:00:00Z"), evening, BERLIN), "1:00 am");
  assert.equal(resetTimeText(at("2026-11-18T08:59:00Z"), evening, BERLIN), "9:59 am");
  assert.equal(resetTimeText(at("2026-11-18T09:00:00Z"), evening, BERLIN), "tomorrow 10:00 am");
  // The morning before, the same 1:00 am is a day away and names it.
  assert.equal(resetTimeText(at("2026-11-18T00:00:00Z"), at("2026-11-17T08:00:00Z"), BERLIN), "tomorrow 1:00 am");
  assert.equal(resetTimeText(at("2026-11-18T22:00:00Z"), NOW, BERLIN), "tomorrow 11:00 pm");
});

test("a reset within the coming week names the weekday", () => {
  // The reported case: two days away, Thursday 1:00 am.
  assert.equal(resetTimeText(at("2026-11-19T00:00:00Z"), NOW, BERLIN), "Thu 1:00 am");
  assert.equal(resetWaitText(at("2026-11-19T00:00:00Z"), BERLIN, NOW), "Waits for reset · Thu 1:00 am");
  assert.equal(resetTimeText(at("2026-11-21T14:15:00Z"), NOW, BERLIN), "Sat 3:15 pm");
  assert.equal(resetTimeText(at("2026-11-23T09:00:00Z"), NOW, BERLIN), "Mon 10:00 am");
});

test("a reset a week or more away, or on an earlier day, shows the date", () => {
  // Seven days out is the same weekday as today, so a bare weekday would mislead.
  assert.equal(resetTimeText(at("2026-11-24T00:00:00Z"), NOW, BERLIN), "Nov 24, 1:00 am");
  assert.equal(resetTimeText(at("2026-12-03T17:45:00Z"), NOW, BERLIN), "Dec 3, 6:45 pm");
  assert.equal(resetTimeText(at("2027-01-02T08:00:00Z"), NOW, BERLIN), "Jan 2, 9:00 am");
  assert.equal(resetTimeText(at("2026-11-15T12:00:00Z"), NOW, BERLIN), "Nov 15, 1:00 pm");
});

test("day and clock follow the reader's time zone offset, JavaScript sign", () => {
  const now = at("2026-11-17T20:00:00Z");
  const reset = at("2026-11-18T06:30:00Z");
  assert.equal(resetTimeText(reset, now, 0), "6:30 am"); // UTC: Tue 20:00 → Wed 06:30
  assert.equal(resetTimeText(reset, now, 300), "1:30 am"); // New York: Tue 15:00 → Wed 01:30
  assert.equal(resetTimeText(reset, now, 480), "10:30 pm"); // Los Angeles: same day
  assert.equal(resetTimeText(reset, now, -540), "3:30 pm"); // Tokyo: Wed 05:00 → Wed 15:30
  assert.equal(resetTimeText(reset, now, -330), "12:00 pm"); // India, a half-hour zone
  assert.equal(resetTimeText(reset, now, -840), "8:30 pm"); // UTC+14, the bound
  assert.equal(resetTimeText(reset, now, 720), "6:30 pm"); // UTC-12, the other bound
  // An offset can move the reset onto another weekday.
  const late = at("2026-11-19T23:30:00Z");
  const monday = at("2026-11-16T12:00:00Z");
  assert.equal(resetTimeText(late, monday, 0), "Thu 11:30 pm");
  assert.equal(resetTimeText(late, monday, BERLIN), "Fri 12:30 am");
  assert.equal(resetTimeText(late, monday, 300), "Thu 6:30 pm");
});

test("midnight and noon read as 12 am and 12 pm", () => {
  const day = at("2026-11-17T00:00:00Z");
  const clock = (iso: string) => resetTimeText(at(iso), day, 0);
  assert.equal(clock("2026-11-17T00:00:00Z"), "12:00 am");
  assert.equal(clock("2026-11-17T00:05:00Z"), "12:05 am");
  assert.equal(clock("2026-11-17T11:59:00Z"), "11:59 am");
  assert.equal(clock("2026-11-17T12:00:00Z"), "12:00 pm");
  assert.equal(clock("2026-11-17T12:59:00Z"), "12:59 pm");
  assert.equal(clock("2026-11-17T23:59:00Z"), "11:59 pm");
  // A minute before midnight, a reset at midnight is overnight.
  assert.equal(resetTimeText(at("2026-11-18T00:00:00Z"), at("2026-11-17T23:59:00Z"), 0), "12:00 am");
});

test("ISO strings work; missing or unparsable times give no text", () => {
  assert.equal(resetTimeText("2026-11-19T00:00:00Z", NOW, BERLIN), "Thu 1:00 am");
  for (const value of [null, undefined, "", "soon", Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(resetTimeText(value, NOW, BERLIN), null);
  assert.equal(resetWaitText(Number.NaN, BERLIN, NOW), "Waits for reset");
});

test("without an offset, the runtime's own time zone applies", () => {
  const reset = at("2026-11-19T00:00:00Z");
  assert.equal(resetTimeText(reset, NOW), resetTimeText(reset, NOW, new Date(reset).getTimezoneOffset()));
});
