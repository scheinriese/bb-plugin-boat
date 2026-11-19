# Instabox Mac leases

Mac tasks use Instabox only. Enable Instabox and store its API key in bb's
secret setting, then select **Instabox · Mac** in a project's Runs on. The
CLI also accepts `task start --system macos`; agent tools accept
`sandbox_system: "macos"`. Linux remains the default.

The live `usage` workspace tier must be Pro, Builder, Team or Enterprise,
and `templates` must return a creatable macOS template with a valid model,
size and 24-hour minimum price. Missing, rejected or older responses fail
closed. No plan purchase or monthly rental is performed. The existing size
choices reserve task resources: Small 2 CPU / 4 GiB, Default 4 / 8, Large
8 / 16, XLarge 16 / 32. New Macs use M2 for Small/Default, M4 for Large,
and M4 Pro for XLarge, with their full sizes from the live template. Prices
come exclusively from the live template and machine lease, in USD.

## Store and queries

`mac_leases` records the provider lease id, provider, machine id, model,
start, current day-window end, day price, currency, CPU/memory capacity,
end time/reason and last warned window. A partial unique index allows only
one held lease per provider/machine. `mac_lease_tasks` is an append-only
attachment history with task id, attachment time and resource reservation.
The existing plugin SQLite migration mechanism creates both tables. Tasks
also persist `sandbox_system`, defaulting to Linux for existing records.

`TaskStore.macLeases.summary()` returns UTC calendar-month and rolling
30-day lease-days and totals per currency, plus held leases. `between()`
queries an arbitrary range, optionally for one machine. Every started
24-hour window belongs to the calendar month of its start; concurrent Macs
count separately and sharing tasks never multiplies a lease-day. The
`macUsage` RPC shares these queries with the UI and the next suggestion task.

**Billing discrepancy:** the current Instabox documentation says the first
24 hours are a minimum and subsequent running time is billed per second.
The requested day-window policy advances by 24 hours whenever a held Mac
crosses a boundary. Its day prices and calendar-month totals are conservative
estimates, not provider invoices. Storage is additional. A later integration
can replace window estimates with actual rated Mac usage without losing
lease and task history. See [macOS machines](https://instabox.sh/docs/machines/macos.md)
and [OpenAPI](https://api.instabox.sh/v1/openapi.json), checked 2026-11-19.

## Placement and hand-back

The seam for eligible own Mac → enrolled monthly Mac precedes held day
leases → new day lease. Only the latter two exist here. Held running Macs and stopped Macs still inside their minimum
are tried first, including when a task requests a new workspace. Each task
gets its own checkout and bb workspace. CPU/memory reservations of open
tasks must fit the machine's live size; unknown reservations prevent reuse.
Busy parents are excluded from automatic review placement. An explicitly
shared parent checkout is refused while its implementer works. Only when
no lease fits is a new Mac created, through existing provider-scoped plan
and capacity checks with explicit 24-hour consent.

Task placement and hand-back share a lock. After restart, a successful
Instabox machine list imports only Boat-tagged Mac machines, reconstructs
held leases and closes missing machines as deleted. Failed lists never
close records or authorize another rental. Missed day boundaries catch up
idempotently. A missing or manually deleted machine records `deleted`; automatic
hand-back records `handed back`. The ledger also supports `failed` as an
explicit end reason; a failed task still holds its lease while open.

Closing a task retains a paid Mac for reuse. The monitor deletes an empty
Mac at `macHandBackMarginMinutes` before the window end (default 30). It
checks task records, dispatch/resize claims and bb machine activity again
after I/O immediately before deleting. Open tasks, including failed or
unpushed work, are never automatically deleted. If all are idle for
`macIdleNoticeMinutes` (default 60), their orchestrators receive one `[boat]`
heads-up per window, persisted before delivery to prevent restart duplicates.
Running work renews silently. No manual messages or vendor changes are made
by this implementation task.

## Verification boundaries

Tests use the documented CLI/REST shapes and fake provider/SDK hosts. A
rendered component preview covers usage and task-line designs without
installing or reloading the plugin into the owner's bb. Actual Mac creation,
bootstrap, CLI agents, resource sizes, billing timing and immediate `rm --now`
need a live Instabox account. Xcode installation/signing remain owner setup;
Instabox's standard Mac template includes Command Line Tools, not full Xcode.
The monthly suggestion, monthly/own-Mac routing and bb sidebar changes are
separate tasks.
