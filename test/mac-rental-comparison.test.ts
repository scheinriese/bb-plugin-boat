import assert from "node:assert/strict";
import { test } from "node:test";
import type { MacRentalQuote } from "../contract-ownmac.ts";
import { compareRentalOffers, rentalBreakEven } from "../web/mac-rental-logic.ts";

const quote = (overrides: Partial<MacRentalQuote> = {}): MacRentalQuote => ({
  id: "fake-quote", provider: "fake", label: "Fake Mac", model: "fake-m2", modelLabel: "M2",
  minimumCost: 3.84, hourPrice: 0.16, minimumHours: 24, currency: "EUR", expiresAt: "2099-01-01T00:00:00Z", ...overrides,
});
test("cross-currency copy states a conservative conditional boundary without an exchange-rate claim", () => {
  const a = quote(), b = quote({minimumCost:10.8,hourPrice:0.45,currency:"USD"});
  assert.equal(rentalBreakEven(a,b),2.81);
  assert.match(compareRentalOffers(a,b), /Below 2\.81 USD per EUR/);
  assert.match(compareRentalOffers(a,b), /No exchange rate is assumed/);
  const boundary = rentalBreakEven(a,b)!;
  assert.ok(a.minimumCost * boundary < b.minimumCost);
  assert.ok(a.hourPrice * boundary < b.hourPrice);
});
test("crossed ratios, free rates, invalid amounts and differing minimums never produce a price boundary", () => {
  for (const a of [quote({minimumCost:20}), quote({hourPrice:0}), quote({minimumCost:0}), quote({hourPrice:Infinity}), quote({minimumHours:12})]) {
    assert.equal(rentalBreakEven(a,quote({minimumCost:10.8,hourPrice:0.45,currency:"USD"})), null);
  }
  assert.match(compareRentalOffers(quote({minimumCost:20}), quote({minimumCost:10.8,hourPrice:0.45,currency:"USD"})), /different currencies/);
});
test("same-currency comparisons distinguish a dominating offer, a tie and ongoing-rate tradeoffs", () => {
  const other=quote({minimumCost:10.8,hourPrice:0.45});
  assert.match(compareRentalOffers(quote(),other), /neither higher/);
  assert.match(compareRentalOffers(other,quote()), /neither lower/);
  assert.match(compareRentalOffers(quote(),quote()), /same minimum total and hourly rate/);
  assert.match(compareRentalOffers(quote({hourPrice:0.6}),other), /lower minimum total, but a higher hourly rate/);
  assert.match(compareRentalOffers(other,quote({hourPrice:0.6})), /higher minimum total, but a lower hourly rate/);
  assert.match(compareRentalOffers(quote({minimumHours:12}),other), /minimum durations differ/);
  assert.equal(compareRentalOffers(quote()),"Eligible for this task.");
});
