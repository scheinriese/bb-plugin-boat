# Mac leases

Mac tasks use the project's Mac provider. Instabox is available after enabling
it and storing its API key in bb's secret setting. Choose **Instabox · Mac**
in Runs on, use `task start --system macos`, or pass `sandbox_system: "macos"`
to the dispatch tool. Reviews always inherit their parent's system, including
older Linux tasks whose records have no explicit system.

## Billing and persisted terms

The shared ledger receives each provider's own start, `paidUntil` (the fixed
end of its paid minimum), `minimumCost`, `hourPrice`, currency and resource
capacity. It does not extend paid time or assume that a minimum is 24 hours.
Instabox supplies these from `Machine.lease` (`startedAt`, `chargeUntil`,
`hourUSD`) and live templates; its minimum is currently 24 hours. Total
compute cost is the minimum plus `hourPrice × elapsed hours after paidUntil`.
The rate is prorated by elapsed time, without rounding up to another day.
Storage, tax and other provider charges are not included.

`mac_leases` stores those terms, machine/model, end time/reason, the last
notice time and page notice text, `kept`, and a pending `releaseAt`. Because this schema has not
shipped, its final billing, keep, scheduling and notice columns are created
directly in one `CREATE TABLE`, without upgrade rewrites. The attachment
table retains task/resource history, a close outcome with its task turn count,
and an index on `task_id`. An ended
record is never reopened by a list upsert.

`between(from, until, now, machineId?)` returns fractional billable lease-days
and costs per currency. One lease-day is 24 billable hours. The minimum's
price is spread over its actual interval; later seconds use the separate
hourly rate. Calendar boundaries split both time and cost proportionally.
The entire minimum remains payable after early deletion. Sharing tasks
never multiplies a machine's bill.

`summary(now)` returns a UTC calendar-month allocation and a rolling 30-day
historical window. **This month uses UTC calendar boundaries; lease times
use the owner's local timezone.** The monthly-suggestion task must preserve
this distinction. The month includes committed minimum time allocated to
that month, including its prepaid future portion. The rolling window ends
at now and excludes future prepaid time. This distinction keeps the full
current-month minimum visible while exposing historical usage to the next
monthly-Mac suggestion task. The `macUsage` RPC shares these queries with
the meter. `macRunsOnBatch` takes a two-query snapshot and builds maps once
per collection RPC; formatting each task performs no additional ledger reads.

## Placement and hand-back

The seam for own Mac → enrolled monthly Mac precedes held lease → new lease.
Only the last two exist here. Providers qualify through live `macModels`
or advertised Mac capabilities, and task reservations use their own `sizes`
(CPU and memory), with no Instabox-specific routing or resource table in
shared code. Each connected Mac provider gets its own Runs on choice.
Held active machines, or stopped machines
still inside their minimum, are tried first. Open-task resource reservations
must fit. Dispatch claims do not exclude a held Mac: placement is serialized,
and each task gets its own checkout/workspace. Moves, resizes and busy review
parents remain excluded. A new minimum on resume rechecks live plan/templates
and account capacity before accepting consent; the existing machine is
already included in its provider's machine count.

The release policy is provider-neutral:

- Inside the minimum, an empty Mac remains available. Within the configured
  margin (default 30 minutes), providers that support scheduling and cancelling
  release schedule it for `paidUntil`. New work cancels the schedule before
  attaching. Other providers wait until the minimum ends.
- After the minimum, an empty Mac is released on the next pass.
- Open tasks, including failed or unpushed work, are never automatically deleted.
  Near the minimum end, if all have been idle for the configured threshold
  (default 60 minutes), their orchestrators receive one persisted notice that
  paid time is ending and subsequent idle time bills per second. Past the
  minimum, idle tasks get a reminder with running compute cost at most once
  every 24 hours, persisted across restarts. Active work continues silently;
  there are no daily billing renewals.
- Only an explicit `keep_sandbox: true` permanently keeps a clean Mac. The
  general keep-on-close setting protects a Mac only when there is confirmed unshipped
  work, so clean closed Macs remain eligible for hand-back. Archiving a chat
  with unshipped work marks its lease kept, and hand-back independently checks
  every task in attachment history, including cancelled and done tasks.
  Closing records `shipped`, `discarded`, `clean`, `unshipped` or `unknown`
  before the close can hide a ship event. Conclusive outcomes remain valid
  for that task's turn count; a later turn invalidates them. Shipped, discarded
  and clean closes need no further git probe, including while paused.
  An unavailable probe (`null`) defers release for this pass and cancels any
  pending release; it never creates a permanent keep. Unknown outcomes retry
  on a later pass and receive a cost notice after the minimum. Only a positive
  work count automatically sets `kept`. Hand-back probes work only inside
  the release margin or after the minimum.
  A kept Mac past its minimum sends a running-cost reminder at most once
  every 24 hours, including when all attached tasks are closed. Usage and
  task lines show hand-back is off; manual deletion remains available.
- Tasks started from the Cloud agents page can have no orchestrator thread.
  Their cost notice is saved atomically with its reminder timestamp and shown
  on Today and Overview until the lease ends, with the same daily updates.
  A shared lease with both page and chat tasks reaches both surfaces.

Placement and hand-back share a lock. Release rechecks task records, claims,
bb machine activity, attachment-history work and keep state after I/O. Successful lists close missing
machines; a scheduled release ends at its scheduled time on reconciliation,
and a stopped lease uses the provider's `stoppedAt` rather than the later list time.
Failed lists never authorize another rental or mark machines gone. Mac
maintenance and Linux activity leases have independent error handling; no
held Mac leases means no Mac maintenance/provider-list pass.

## Display and verification

The UI follows HANDOFF.md sections 2 and 4: a 300 px rolling meter, provider
rows and task lines, icons, existing colors and sizes, no break-even marker.
Copy reflects minimum-plus-elapsed billing. Instants travel as structured
values and render in the owner's browser timezone. Lease-days are fractional
and correctly singular; idle durations use hours where appropriate. A boat.dev
error still hides its sandbox count. Explicitly kept Macs are visible. The
Mac usage row takes provider names from the registry, including other Mac
providers; tool descriptions do not assume a particular Mac provider.

Tests use documented CLI/REST shapes and fake provider/SDK hosts. The rendered
component preview checks usage, shared task lines, scheduled/kept leases,
another provider's name, page cost notices and boat.dev's error state without
installing/reloading the plugin. Live Mac
creation, enrollment, snapshot restore, exact release/cancel behavior and
rated invoices still need an Instabox account. Xcode/signing remain owner
setup. The monthly suggestion, own/monthly-Mac routing and bb sidebar changes
remain separate tasks.

Sources checked 2026-11-19:
[macOS machines](https://instabox.sh/docs/machines/macos.md),
[OpenAPI](https://api.instabox.sh/v1/openapi.json).

## Accepted copy changes from the original designs

The mocks assumed whole-day billing. The implementation keeps their layout
but uses “Paid until” instead of “Lease ends”, “$X minimum” instead of “$X a
day”, and “$/h after 24 h minimum” on task lines (using the provider's actual
minimum length). “Bills per second”, “Release scheduled” and “Kept · hand-back
off” describe the later states. Orchestrator messages report paid-time expiry
and running compute cost, rather than daily lease renewals.

## Scaleway billing increments

The same ledger also supports provider-supplied `billingIncrementSeconds`.
Its default preserves Instabox's elapsed-time rate. Scaleway supplies 3600: a
24-hour minimum plus each begun hour after it, split across UTC months. See
[Scaleway setup and sources](scaleway-mac-leases.md).
