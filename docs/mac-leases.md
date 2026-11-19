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

`mac_leases` stores those terms, machine/model, end time/reason, the one-time
idle notice, `kept`, and a pending `releaseAt`. The historical `day_price`
column now stores the minimum price. Append-only migrations recover the
original minimum/rate from this branch's old day-window records, add keep
and schedule state, and index `mac_lease_tasks(task_id)` without changing
existing migration indexes. `mac_lease_tasks` retains attachment history and
CPU/memory reservations. An ended record is never reopened by a list upsert.

`between(from, until, now, machineId?)` returns fractional billable lease-days
and costs per currency. One lease-day is 24 billable hours. The minimum's
price is spread over its actual interval; later seconds use the separate
hourly rate. Calendar boundaries split both time and cost proportionally.
The entire minimum remains payable after early deletion. Sharing tasks
never multiplies a machine's bill.

`summary(now)` returns a UTC calendar-month allocation and a rolling 30-day
historical window. The month includes committed minimum time allocated to
that month, including its prepaid future portion. The rolling window ends
at now and excludes future prepaid time. This distinction keeps the full
current-month minimum visible while exposing historical usage to the next
monthly-Mac suggestion task. The `macUsage` RPC shares these queries with
the meter. `macRunsOnBatch` takes a two-query snapshot and builds maps once
per collection RPC; formatting each task performs no additional ledger reads.

## Placement and hand-back

The seam for own Mac → enrolled monthly Mac precedes held lease → new lease.
Only the last two exist here. Held running machines, or stopped machines
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
  paid time is ending and subsequent idle time bills per second. Active work
  continues without a notice. There are no daily renewals or recurring warnings.
- Closing with `keep_sandbox` (or the keep-on-close setting) persistently exempts
  the Mac from automatic release before the task's open-work protection is
  removed. Usage and task lines show that hand-back is off. Manual deletion
  remains available; later tasks do not silently clear the keep.

Placement and hand-back share a lock. Release rechecks task records, claims,
bb machine activity and keep state after I/O. Successful lists close missing
machines; a scheduled release ends at its scheduled time on reconciliation.
Failed lists never authorize another rental or mark machines gone. Mac
maintenance and Linux activity leases have independent error handling; no
held Mac leases means no Mac maintenance/provider-list pass.

## Display and verification

The UI follows HANDOFF.md sections 2 and 4: a 300 px rolling meter, provider
rows and task lines, icons, existing colors and sizes, no break-even marker.
Copy reflects minimum-plus-elapsed billing. Instants travel as structured
values and render in the owner's browser timezone. Lease-days are fractional
and correctly singular; idle durations use hours where appropriate. A boat.dev
error still hides its sandbox count. Explicitly kept Macs are visible.

Tests use documented CLI/REST shapes and fake provider/SDK hosts. The rendered
component preview checks usage, shared task lines, scheduled/kept leases and
boat.dev's error state without installing/reloading the plugin. Live Mac
creation, enrollment, snapshot restore, exact release/cancel behavior and
rated invoices still need an Instabox account. Xcode/signing remain owner
setup. The monthly suggestion, own/monthly-Mac routing and bb sidebar changes
remain separate tasks.

Sources checked 2026-11-19:
[macOS machines](https://instabox.sh/docs/machines/macos.md),
[OpenAPI](https://api.instabox.sh/v1/openapi.json).
