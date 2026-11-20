import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type Database from "better-sqlite3";
import { TaskStore } from "../src/store.ts";
import {
  MONTHLY_MAC_PRICES,
  monthlyMacPrices,
  monthlyMacRule,
  chipMeets,
  leaseChip,
} from "../src/monthly-macs.ts";
import { monthlyMacPricesSchema } from "../contract-monthly-macs.ts";
const DAY = 86400000,
  now = Date.parse("2026-11-20T00:00:00Z");
const input = {
  now,
  historySince: now - 30 * DAY,
  monthlyPrice: 120,
  forecasts: [
    { at: now - 7 * DAY, days: 20, dayRate: 10 },
    { at: now, days: 20, dayRate: 10 },
  ],
};
test("monthly rule requires 30 days, consecutive weekly forecasts, strict 120% and >20% savings", () => {
  assert.equal(monthlyMacRule(input), true);
  assert.equal(
    monthlyMacRule({ ...input, historySince: input.historySince + 1 }),
    false,
  );
  for (const days of [12, 14.4, 15])
    assert.equal(
      monthlyMacRule({
        ...input,
        forecasts: input.forecasts.map((f) => ({ ...f, days })),
      }),
      false,
    );
  assert.equal(
    monthlyMacRule({
      ...input,
      forecasts: input.forecasts.map((f) => ({ ...f, days: 15.0001 })),
    }),
    true,
  );
  assert.equal(
    monthlyMacRule({ ...input, forecasts: input.forecasts.slice(1) }),
    false,
  );
  assert.equal(
    monthlyMacRule({
      ...input,
      forecasts: [input.forecasts[0]!, { ...input.forecasts[1]!, at: now - 1 }],
    }),
    false,
  );
  assert.equal(
    monthlyMacRule({
      ...input,
      forecasts: [
        { ...input.forecasts[0]!, at: now - 14 * DAY },
        input.forecasts[1]!,
      ],
    }),
    false,
  );
  assert.equal(
    monthlyMacRule({
      ...input,
      forecasts: input.forecasts.map((f) => ({ ...f, at: f.at - 7 * DAY })),
    }),
    false,
  );
  assert.equal(
    monthlyMacRule({
      ...input,
      forecasts: input.forecasts.map((f) => ({ ...f, dayRate: 0 })),
    }),
    false,
  );
});
test("two-week snooze and 30-day quiet have exact expiry boundaries", () => {
  assert.equal(monthlyMacRule({ ...input, snoozedUntil: now + 1 }), false);
  assert.equal(monthlyMacRule({ ...input, snoozedUntil: now }), true);
  assert.equal(
    monthlyMacRule({ ...input, lastSuggestedAt: now - 30 * DAY + 1 }),
    false,
  );
  assert.equal(
    monthlyMacRule({ ...input, lastSuggestedAt: now - 30 * DAY }),
    true,
  );
});
test("enrolled Macs require two forecasts strictly below 70% for cancellation advice", () => {
  const cancel = {
    ...input,
    enrolled: true,
    forecasts: input.forecasts.map((f) => ({ ...f, days: 8.4 })),
  };
  assert.equal(monthlyMacRule(cancel), false);
  assert.equal(
    monthlyMacRule({
      ...cancel,
      forecasts: cancel.forecasts.map((f) => ({ ...f, days: 8.399 })),
    }),
    true,
  );
  assert.equal(
    monthlyMacRule({
      ...cancel,
      forecasts: [
        { ...cancel.forecasts[0]!, days: 9 },
        { ...cancel.forecasts[1]!, days: 1 },
      ],
    }),
    false,
  );
});
test("dated price overrides validate; unknown chips, RAM, currency and stock fail closed", () => {
  assert.deepEqual(monthlyMacPrices(""), MONTHLY_MAC_PRICES);
  assert.deepEqual(monthlyMacPrices(JSON.stringify([MONTHLY_MAC_PRICES[1]])), [
    MONTHLY_MAC_PRICES[1],
  ]);
  assert.throws(() => monthlyMacPrices("[{}]"));
  assert.equal(
    monthlyMacPricesSchema.safeParse([
      { ...MONTHLY_MAC_PRICES[1], signupUrl: "javascript:alert(1)" },
    ]).success,
    false,
  );
  assert.equal(
    monthlyMacPricesSchema.safeParse([
      MONTHLY_MAC_PRICES[1],
      MONTHLY_MAC_PRICES[1],
    ]).success,
    false,
  );
  assert.equal(chipMeets("M4", "M2"), true);
  assert.equal(chipMeets("M1", "M2"), false);
  assert.equal(chipMeets("M4", "M2 Pro"), false);
  assert.equal(chipMeets("M4 Pro", "M2 Pro"), true);
  assert.equal(chipMeets("unknown", "M2"), false);
  assert.equal(leaseChip("m4-pro"), "M4 Pro");
});
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const sql of TaskStore.migrations()) db.exec(sql);
  const store = new TaskStore(() => db as unknown as Database.Database);
  // One physical Mac, five days a week; task overlap is deliberately absent.
  for (let d = 0; d < 85; d++)
    if (d % 7 < 5) {
      const start = now - 70 * DAY + d * DAY;
      store.macLeases.record({
        id: `lease-${d}`,
        provider: "instabox",
        machineId: `mac-${d}`,
        size: "m2",
        memoryMiB: 16384,
        cpus: 8,
        startedAt: new Date(start).toISOString(),
        paidUntil: new Date(start + DAY).toISOString(),
        minimumCost: 10.8,
        hourPrice: 0.45,
        currency: "USD",
      });
      store.macLeases.end(`lease-${d}`, "handed back", start + DAY);
    }
  return { db, store };
}
test("advisor persists weekly evidence, receipts, snooze and quiet across restart without provider actions", () => {
  const { db, store } = fixture();
  assert.equal(store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now).length, 0);
  assert.equal(
    store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now + 6 * DAY).length,
    0,
  );
  const [s] = store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now + 7 * DAY);
  assert.ok(s);
  assert.equal(s.candidate.id, "hostmyapple-m4");
  assert.equal(s.currency, "USD");
  assert.ok(Math.abs(s.dayRate - 10.8) < 1e-8);
  assert.ok(Math.abs(s.breakEven - 119.99 / 10.8) < 1e-8);
  assert.ok(s.alternatives.some((p) => p.currency === "EUR"));
  assert.ok(!s.alternatives.some((p) => !p.available));
  assert.equal(store.monthlyMacs.forThread("chat-one").length, 1);
  assert.equal(store.monthlyMacs.forThread("chat-one").length, 0);
  store.monthlyMacs.answer(s.id, "keep", now + 7 * DAY);
  const restarted = new TaskStore(() => db as unknown as Database.Database);
  assert.equal(restarted.monthlyMacs.get(s.id)?.answer, "keep");
  assert.equal(
    restarted.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now + 21 * DAY).length,
    0,
  );
  const row = db
    .prepare("SELECT snoozed_until FROM monthly_mac_suggestions WHERE id=?")
    .get(s.id)!;
  assert.equal(row.snoozed_until, now + 21 * DAY);
  db.close();
});
test("hardware changes, RAM, currency, hourly estimates and overlapping machines prevent wrong recommendations", () => {
  for (const price of [
    { ...MONTHLY_MAC_PRICES[1]!, ramGB: 8 },
    { ...MONTHLY_MAC_PRICES[1]!, chip: "M1" },
    { ...MONTHLY_MAC_PRICES[1]!, currency: "EUR" as const },
    { ...MONTHLY_MAC_PRICES[1]!, available: false },
    { ...MONTHLY_MAC_PRICES[1]!, billing: "hourly-estimate" as const },
  ]) {
    const { store, db } = fixture();
    store.monthlyMacs.refresh([price], now);
    assert.equal(store.monthlyMacs.refresh([price], now + 7 * DAY).length, 0);
    db.close();
  }
  const { store, db } = fixture();
  store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now);
  assert.equal(
    store.monthlyMacs.refresh(
      MONTHLY_MAC_PRICES.map((p) => ({
        ...p,
        monthlyPrice: p.monthlyPrice + 1,
      })),
      now + 7 * DAY,
    ).length,
    0,
    "edited price resets weekly evidence",
  );
  const lease = store.macLeases
    .list()
    .find((l) => Date.parse(l.startedAt) === now)!;
  store.macLeases.record({ ...lease, id: "parallel", machineId: "parallel" });
  store.macLeases.end("parallel", "handed back", Date.parse(lease.paidUntil));
  assert.equal(
    store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now + 14 * DAY).length,
    0,
  );
  db.close();
});
test("enrollment seam only records a contract and produces cancellation guidance after two low weeks", () => {
  const { store, db } = fixture();
  store.monthlyMacs.recordEnrolled("instabox:USD", MONTHLY_MAC_PRICES[1]!);
  assert.equal(
    store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now + 70 * DAY).length,
    0,
  );
  const [s] = store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now + 77 * DAY);
  assert.equal(s?.kind, "cancel");
  assert.throws(
    () => store.monthlyMacs.answer(s!.id, "rent"),
    /Choose an option/,
  );
  assert.equal(store.macLeases.held().length, 0);
  store.monthlyMacs.recordEnrolled("instabox:USD", null);
  db.close();
});

test("suggestions and receipts leave board decisions and sidebar attention counts unchanged", async () => {
  const { store, db } = fixture();
  const { buildBoard } = await import("../src/board.ts");
  const { attentionCount } = await import("../web/cards-logic.ts");
  store.addDecision({
    orchestratorThreadId: "chat",
    question: "Which flow?",
    recommendation: "A",
    options: ["A", "B"],
    taskIds: [],
  });
  store.addDecision({
    orchestratorThreadId: "chat",
    question: "Which color?",
    recommendation: "Blue",
    options: ["Blue", "Green"],
    taskIds: [],
  });
  const board = () =>
    buildBoard({
      tasks: [],
      latestVerdict: () => null,
      decisions: store.decisions({ statuses: ["open"] }),
    });
  const before = board();
  store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now);
  const [s] = store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now + 7 * DAY);
  assert.ok(s);
  assert.deepEqual(board(), before);
  assert.equal(attentionCount([], store.decisions({ statuses: ["open"] })), 2);
  store.monthlyMacs.answer(s.id, "rent", now + 7 * DAY);
  assert.deepEqual(board(), before);
  assert.equal(store.macLeases.held().length, 0);
  db.close();
});
