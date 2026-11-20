# Mac rental handoff QA

Scope: supplied M2 phone task-detail and D1 desktop rental-card references, adapted to the existing plugin. Captures use actual rental/task components with fake data and a rendering-only host. No installed host, real account, or rental was exercised.

## Findings

No unresolved P0, P1 or P2 findings within this scope. Comparison fixes included selected-card colors, native radio appearance, compact alternative copy, a full-width pending heading, removal of duplicate pending metadata, and compact desktop confirmation.

- Typography: existing host font stack retained; phone card title 16/22, body 14/20, price 20px; desktop title 15/22, body 13/20, price 18px. Pending title is 20/26. Provider/currency text remains readable when wrapping.
- Layout: options stack at 360/390px and sit side by side at desktop width. Selected phone details expand; alternatives stay compact. One confirmation is visible, measuring 52px on phones and 32px on desktop. Page/document widths match at 360, 390 and 1280px for both interactive card and pending task scenes.
- Tokens: selected surface/border, blue recommendation chip/radio, orange total, amber attention state and neutral surfaces use the supplied palette. Meaningful secondary instructions use the readable secondary gray.
- Assets: no raster or decorative assets are needed. Existing host icons and native radio controls are retained; device and application chrome are not recreated.
- Content: totals, minimum duration, ongoing rate and currency are explicit. Hardware and region come from quote facts or say Not listed. Preference-based recommendations are identified; cross-currency boundaries are conditional calculations, not exchange-rate assumptions. GUI readiness and automatic hand-back are not promised by a quote.
- Interaction: keyboard selection updates the exact provider/price confirmation and keeps radio focus in the fake interactive preview. Keep it queued remains on the same request; subsequent approval reaches a fake receipt. Expired offers disable confirmation; no-offer state has no confirmation. Browser console reports no errors.
- Pending page: choice precedes details, status says Waiting for your choice, and queued/not-started metadata replaces finished/turn-count placeholders. Brief remains available; cancellation uses the existing native action.

## Intentional differences and limits

- Examples use neutral fake models, regions and prices; they do not duplicate the mock's illustrative amounts.
- Reuse summaries, proven GUI-automation behavior, new settings flows and leased-Mac progress/hand-back redesigns are not inferred from quote data and are outside this follow-up.
- The existing desktop task-page column and visible phone Cancel action are retained. D2's new page grid and a new phone overflow menu are not part of the scoped M2/D1 component comparison.
- Native RPC latency, assistive-technology behavior and the full installed host chrome require owner-side validation; server consent/concurrency policy is covered by fake-provider tests.

## Implementation checklist

- [x] Responsive choices and selected details
- [x] Exact single-rental consent and task-only queue action
- [x] Pending task status, metadata, cancellation and footer
- [x] Browser checks at phone and desktop widths
- [x] Source-to-render comparison for the scoped component surfaces

final result: passed
