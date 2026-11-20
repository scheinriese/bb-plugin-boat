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
  compareChips,
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
    enrolledDemand: {
      machineId: "monthly-1",
      forecasts: input.forecasts.map((f) => ({ ...f, days: 8.4 })),
    },
  };
  assert.equal(monthlyMacRule(cancel), false);
  assert.equal(
    monthlyMacRule({
      ...cancel,
      enrolledDemand: {
        machineId: "monthly-1",
        forecasts: cancel.enrolledDemand.forecasts.map((f) => ({
          ...f,
          days: 8.399,
        })),
      },
    }),
    true,
  );
  assert.equal(
    monthlyMacRule({
      ...cancel,
      enrolledDemand: {
        machineId: "monthly-1",
        forecasts: [
          { ...cancel.enrolledDemand.forecasts[0]!, days: 9 },
          { ...cancel.enrolledDemand.forecasts[1]!, days: 1 },
        ],
      },
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
  for (let d = 0; d < 200; d++)
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
  assert.equal(store.monthlyMacs.takeForTool("chat-one").length, 1);
  assert.equal(store.monthlyMacs.takeForTool("chat-one").length, 0);
  store.monthlyMacs.answer(s.id, "keep", now + 7 * DAY);
  const restarted = new TaskStore(() => db as unknown as Database.Database);
  assert.equal(restarted.monthlyMacs.get(s.id)?.answer, "keep");
  restarted.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now + 14 * DAY);
  assert.equal(
    restarted.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now + 21 * DAY - 1)
      .length,
    0,
  );
  const [resurfaced] = restarted.monthlyMacs.refresh(
    MONTHLY_MAC_PRICES,
    now + 21 * DAY,
  );
  assert.ok(resurfaced);
  assert.notEqual(resurfaced.id, s.id);
  assert.equal(
    restarted.monthlyMacs.get(s.id)?.answer,
    "keep",
    "the old receipt stays answered",
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
test("enrollment seam is inert without demand from the enrolled Mac", () => {
  const { store, db } = fixture();
  store.monthlyMacs.recordEnrolled("instabox:USD", MONTHLY_MAC_PRICES[1]!);
  assert.deepEqual(store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now), []);
  assert.deepEqual(
    store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now + 7 * DAY),
    [],
  );
  // No spillover day leases, even for months, must not mean a busy monthly
  // machine is idle. Demand collection is not implemented by enrollment yet.
  assert.deepEqual(
    store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now + 300 * DAY),
    [],
  );
  assert.deepEqual(
    store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now + 307 * DAY),
    [],
  );
  assert.equal(monthlyMacRule({ ...input, enrolled: true }), false);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM monthly_mac_forecasts").get()!.n,
    0,
  );
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

test("an unanswered suggestion is returned again exactly at 30 days, never as a repeated tool card before then", () => {
  const { store, db } = fixture();
  store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now);
  const [first] = store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now + 7 * DAY);
  assert.ok(first);
  assert.equal(store.monthlyMacs.takeForTool("chat").length, 1);
  for (const days of [7, 14, 21, 28]) {
    const [s] = store.monthlyMacs.refresh(
      MONTHLY_MAC_PRICES,
      now + (7 + days) * DAY,
    );
    assert.equal(s?.id, first.id);
    assert.equal(store.monthlyMacs.takeForTool("chat").length, 0);
  }
  assert.equal(
    store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now + 37 * DAY - 1)[0]?.id,
    first.id,
  );
  const [again] = store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now + 37 * DAY);
  assert.ok(again);
  assert.notEqual(again.id, first.id);
  assert.equal(store.monthlyMacs.takeForTool("chat").length, 1);
  db.close();
});

test("Scaleway sizes and chip display sorting are stable", () => {
  for (const [size, chip] of [
    ["M4-S", "M4"],
    ["M2-M", "M2"],
    ["M4-SP", "M4"],
    ["M4-XL", "M4 Pro"],
    ["m2-pro", "M2 Pro"],
    ["M2-L", "M2 Pro"],
  ])
    assert.equal(leaseChip(size!), chip);
  const chips = ["M2", "M4", "M2 Pro", "M4 Max", "M4 Ultra"];
  for (const a of chips)
    for (const b of chips) {
      assert.equal(
        Math.sign(compareChips(a, b)) + Math.sign(compareChips(b, a)),
        0,
      );
      assert.equal(compareChips(a, a), 0);
    }
  assert.deepEqual(
    [...chips].reverse().sort(compareChips),
    [...chips].sort(compareChips),
  );
});

test("price comparisons exist below break-even, before history qualifies and after a snooze", async () => {
  const { store, db } = fixture();
  const before = Number(db.prepare("SELECT total_changes() AS n").get()!.n);
  const comparisons = store.monthlyMacs.comparisons(MONTHLY_MAC_PRICES, now);
  assert.equal(
    Number(db.prepare("SELECT total_changes() AS n").get()!.n),
    before,
  );
  assert.equal(comparisons[0]?.candidate.id, "hostmyapple-m4");
  assert.ok(Math.abs(comparisons[0]!.breakEven - 119.99 / 10.8) < 1e-8);
  store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now);
  const [s] = store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now + 7 * DAY);
  store.monthlyMacs.answer(s!.id, "keep", now + 7 * DAY);
  assert.equal(
    store.monthlyMacs.comparisons(MONTHLY_MAC_PRICES, now + 8 * DAY).length,
    1,
  );
  const { providerHandlers } = await import("../src/rpc-providers.ts");
  const { createProviderRegistry, unavailableProvider } =
    await import("../src/providers/registry.ts");
  const handlers = providerHandlers(
    {
      service: {
        store,
        sandboxProviders: createProviderRegistry([unavailableProvider("boat")]),
      },
      settings: { get: async () => ({ monthlyMacPricesJson: "" }) },
      bb: {},
    } as unknown as import("../src/runtime.ts").Runtime,
    () => now + 8 * DAY,
  );
  const changes = Number(db.prepare("SELECT total_changes() AS n").get()!.n);
  assert.deepEqual(handlers.monthlyMacSuggestions(), { suggestions: [] });
  const usage = await handlers.macUsage();
  assert.equal(usage.monthlyComparisons.length, 1);
  assert.equal(
    Number(db.prepare("SELECT total_changes() AS n").get()!.n),
    changes,
    "query RPCs do not write forecasts, suggestions or delivery claims",
  );
  db.close();
});

test("upgrade discards false instruction-time delivery claims", () => {
  const { store, db } = fixture();
  store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now);
  const [s] = store.monthlyMacs.refresh(MONTHLY_MAC_PRICES, now + 7 * DAY);
  assert.ok(s);
  db.prepare("INSERT INTO monthly_mac_shown VALUES (?,?)").run(s.id, "chat");
  db.exec(TaskStore.migrations().at(-1)!);
  assert.equal(store.monthlyMacs.takeForTool("chat").length, 1);
  assert.equal(store.monthlyMacs.takeForTool("chat").length, 0);
  db.close();
});

test("Scaleway SKU comparisons use same-currency actual costs and match Pro hardware", () => {
  const { store, db } = fixture();
  const start = now - DAY;
  store.macLeases.record({
    id: "scaleway-1",
    provider: "scaleway",
    machineId: "scaleway-1",
    size: "M4-S",
    memoryMiB: 16384,
    cpus: 10,
    startedAt: new Date(start).toISOString(),
    paidUntil: new Date(now).toISOString(),
    minimumCost: 5.28,
    hourPrice: 0.22,
    currency: "EUR",
  });
  const price = { ...MONTHLY_MAC_PRICES[4]!, available: true };
  const [comparison] = store.monthlyMacs
    .comparisons([price], now)
    .filter((c) => c.dayProvider === "scaleway");
  assert.ok(comparison);
  assert.ok(Math.abs(comparison.breakEven - 115 / 5.28) < 1e-8);
  db.prepare(
    "UPDATE mac_leases SET size='M4-XL' WHERE provider='scaleway'",
  ).run();
  assert.equal(
    store.monthlyMacs
      .comparisons([price], now)
      .filter((c) => c.dayProvider === "scaleway").length,
    0,
    "a base M4 is not a replacement for M4 Pro",
  );
  db.close();
});

test("one day of history already has a break-even comparison without creating guidance",()=>{
 const {store,db}=fixture();db.prepare("DELETE FROM mac_leases").run();
 store.macLeases.record({id:"first-mac",provider:"instabox",machineId:"first-mac",size:"m2",memoryMiB:16384,cpus:8,startedAt:new Date(now-DAY).toISOString(),paidUntil:new Date(now).toISOString(),minimumCost:10.8,hourPrice:.45,currency:"USD"});
 const comparisons=store.monthlyMacs.comparisons(MONTHLY_MAC_PRICES,now);
 assert.equal(comparisons.length,1);assert.ok(Math.abs(comparisons[0]!.breakEven-119.99/10.8)<1e-8);
 assert.deepEqual(store.monthlyMacs.active(),[]);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM monthly_mac_forecasts").get()!.n,0);db.close();
});
