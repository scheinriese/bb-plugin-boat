# Monthly Mac suggestions

Harbormaster recommends; only the owner buys, signs up, enrolls or cancels.
The card's rent and cancellation buttons only open an HTTPS provider page in
the system browser. The other action records a choice; it never calls a
provider lifecycle API or changes routing.

`src/monthly-macs.ts` is the single dated price catalog. Prices were checked
against the linked public provider pages on November 20, 2026. OakHost's M4
is out of stock and excluded. Scaleway's monthly number is an hourly estimate,
not a contract or discount, so it is shown as an alternative only. Prices are
before tax and extras; the owner must confirm contract terms, region, software
and current stock. Dollars and euros stay separate, with no FX conversion.

To replace the catalog, set **Monthly Mac prices (JSON)** under Advanced in
plugin settings, or `bb boat config set monthlyMacPricesJson '<JSON array>'`.
An empty string restores the catalog; `[]` turns off recommendations.
Each entry has this shape (use an actual quote and date):

```json
[{
  "id": "sample-m4",
  "provider": "Example provider",
  "model": "Mac mini M4",
  "chip": "M4",
  "ramGB": 16,
  "monthlyPrice": 120,
  "currency": "USD",
  "signupUrl": "https://example.com/signup",
  "sourceUrl": "https://example.com/prices",
  "asOf": "2026-11-20",
  "available": true,
  "billing": "monthly"
}]
```

Only USD and EUR are supported. `billing` is `monthly` or `hourly-estimate`.
The table validates at the settings boundary. Editing prices or the hardware
mix resets the pair's weekly evidence.

## Policy

The lease ledger remains the source of billable lease-days and actual cost.
Groups are per day provider and currency. Break-even is monthly price divided
by actual trailing cost per lease-day, including minimums and billing
increments. The table's UTC calendar month and rolling 30-day window keep
their existing meaning.

A weekly forecast extrapolates the last seven days to 30, capped at one
machine's 30 days. The low and high range uses the last four weekly buckets.
At least 30 days of history and two consecutive observations at least seven
and less than fourteen days apart must exceed 120% of break-even; savings
must also exceed 20% of forecast day cost. Forecasts are recorded by the
maintenance loop and suggestions RPC, not invented retrospectively on
installation. The trailing 30 days must also exceed break-even before the card
or usage link appears. Repeated reads do not count as another weekly forecast.

A candidate must meet the RAM and chip of every recently leased Mac. A newer
base chip does not replace a Pro/Max/Ultra. Unknown hardware is excluded.
Overlapping physical leases are excluded because one monthly Mac cannot
replace concurrent machines. Storage, GUI, OS, region, idle fraction and
failure risk are not recorded reliably enough for automatic matching or
claims; review them on the provider page.

A new suggestion is suppressed for 30 days after issuance. **Keep day leases**
also snoozes for 14 days; the 30-day duplicate quiet period still applies. Saved
chat cards become receipts and remain readable after restart. Suggestions
are separate from decisions, so they never affect needs-you or sidebar counts.
The orchestrator receives a card directive on its next turn, once per card and
chat; the plugin never wakes it to deliver cost guidance. Today shows the same
card. The usage link and shared meter only appear for an eligible suggestion.

`MonthlyMacAdvisor.recordEnrolled(group, price)` is the integration seam for
the future Your Mac task. It records an enrolled contract without purchasing
anything. Two weekly forecasts strictly below 70% of break-even then suggest
reviewing cancellation. The owner checks notice deadlines, drains work and
cancels; no contract cancellation or machine termination is automated.

## Component preview

After `npm run build`, run:

```
npm run preview:providers -- --host 0.0.0.0 --port 4173
```

Scenes: `/?scene=monthly-chat`, `/?scene=monthly-today`,
`/?scene=monthly-usage`, `/?scene=monthly-receipt`, `/?scene=monthly-cancel`.
At 390px, chat uses the mobile option blocks. The harness renders the actual
components with neutral data and inert action callbacks.
