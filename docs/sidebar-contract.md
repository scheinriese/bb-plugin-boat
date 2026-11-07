# Boat sidebar state v1

Boat remains independent of Workbench sidebar. Its default-list row status and
metadata remain registered when this consumer is absent.

The consumer uses public `useSdk().plugins.callRpc` with `pluginId: "boat"`,
`method: "sidebarState"`, input `{ "version": 1,
"timezoneOffsetMinutes": new Date().getTimezoneOffset() }`, and the Zod output schema
in `contract-sidebar.ts`. This additive RPC is read-only.

The timezone field is optional, integer, bounded to -840..840, and uses the
JavaScript sign: local time is UTC minus the offset. `{version:1}` remains
valid with the producer's server-local fallback. Berlin winter time is -60.

The response is `{version:1, revision:string, threads:SidebarThreadDto[],
truncated:boolean}`; at most 2000 records. Every record contains:

| Field          | Meaning                                                                    |
| -------------- | -------------------------------------------------------------------------- |
| threadId       | Existing BB thread id; never a synthetic sidebar row                       |
| role           | orchestrator, task, review, chat                                           |
| status         | working, review, ready, shipped, needs-you, broken, stopped, waiting-reset |
| provider       | claude, codex or null                                                      |
| secondLine     | `{text,tone}` or null; tone neutral, attention, danger, success            |
| parentThreadId | Existing parent thread id or null                                          |
| createdFor     | `"you"` for plugin-created work, otherwise null                           |
| listedIn       | Listing chat id or null; used when its tasks-started card is seen            |
| moving         | Optional boolean; false suppresses an idle completed turn's activity ring    |
| rollup         | `{needsYou,stopped,ready,working,shippedToday}` or null                    |
| hidden         | Hide from sidebar; preserve host search and other surfaces                 |
| updatedAt      | Timestamp string                                                           |

Unknown added fields are stripped by the v1 schema. Unknown version/status or
malformed responses fall back to generic BB rows. An unavailable, disabled, or
older Boat (including unknown_method) fails quietly without notifications.
The consumer reads once for the list every 3 seconds in the foreground and
30 seconds in the background, aborts on unmount, avoids concurrent requests,
and retains object identity while revision is unchanged.

Workbench uses Boat nesting and hides shipped tasks and retired reviews from
this list. Any parent with seven open direct children gains a rollup and
collapses on its first crossing; subsequent user choices persist. This also
works with no Boat DTOs: the consumer counts public BB children and working
activity, e.g. `18 threads · 3 working`. Hidden/archived children are excluded.
An available Boat summary takes precedence; generic children keep BB order.
Only authentic Boat statuses contribute urgency: needs-you, broken, ready,
working/review, then idle, retaining BB order inside each bucket. Smaller
groups retain BB order. Automatic sorting waits while
the pointer is over the sidebar or a row has keyboard focus. The generic BB
list, search and other plugin row signals continue to work. Second lines
appear for needs-you/broken/ready, a collapsed rollup, and the reviewed
known-reset exception below. Drafts replace the dot;
rollup dot priority is needs-you then broken. Provider identity comes from BB's
public provider catalog, using Boat's provider override when supplied.

Rollup categories are exclusive: paid out-of-memory recovery belongs to
`stopped`, while explicit decisions belong to `needsYou`. Navigation attention
can therefore differ from the sidebar's `needsYou` count. `shippedToday` counts
recorded shipping/merge events, never merely closed native chats. Own demo
validation pins producer commit `d59c397` with these semantics.

Fixture state belongs only in the isolated demo's backend. Product code never
inserts fixture threads or creates Boat work.

Owner-confirmed additive v1 fields: required `createdFor: "you" | null` and
`listedIn: string | null`. New counts are client-side; no rollup.new field.
See [created-for-you rules](new-threads.md).

`moving?: boolean` is an additive field: a task can keep its logical working
status while its latest completed turn is idle. The provider ring runs only
for working/review with moving !== false; older producers without it keep the
v1 behavior. Idle completion is not presented as a stopped sandbox.

A neutral `waiting-reset` second line is shown only when supplied by Boat.
The producer verifies a live public `threads.queue.list` subscription-limit
retry from `provider-retry`, with `payload.kind=retry`, reason `Rate limited`,
state scheduled/waiting, and a future scheduled time. Native thread state
must be idle/error, unarchived and undeleted; moving, attention, ready and
broken work take precedence. Relay quota timestamps and historical events
alone do not establish a pause. No live retry means no reset line.
The line uses #7A7A7A and the normal second-line geometry; the idle ring is
suppressed. `Continued on Codex` remains omitted.

Producer reads cache15 seconds, inspect at most1000 queue rows and50 matching candidates with4 concurrent native thread reads and a4-second abort signal. Failures quietly retain ordinary rows. Core owns due retry dispatch: disabling provider-retry does not cancel already queued work. Any demo queue fixtures must remain behind a verified reject-all message.dispatch admission hook until their rows are removed at rest.

## Additive delegated-start requests

`sidebarState` may additionally return `queuedStarts` (up to200 entries). Older
v1 producers can omit it; consumers treat absence as an empty list. The producer
always emits the field and includes its ordered contents in `revision`.

| Field | Meaning |
| --- | --- |
| id | Actual durable queued-start request id, max100 characters |
| revision | Current nonnegative request revision for existing queue actions |
| title | Authored request title, max200 characters |
| sourceThreadId | Actual requesting chat, or null |
| provider | Explicit requested agent, actual started task agent, or null when unknown |
| resetsAt | Recorded usage reset timestamp, or null |
| createdAt | Actual request creation time; entries preserve createdAt/id order |
| state | waiting, dispatching, or started |
| taskId | Actual started task registry id, otherwise null |
| taskThreadId | Verified open BB chat for that task, otherwise null |

This separate collection never manufactures a BB thread. Waiting/dispatching
requests retain capacity before started receipts, independently of the most
recent finished receipts. The bounded started projection joins actual open
tasks, so closed/missing tasks, failed requests and cancelled requests disappear.
Native target validation uses at most4 concurrent public `threads.get` calls
under a shared4-second abort signal. An unverified/archived/deleted target stays
null. Headless tasks retain their actual taskId and null taskThreadId: the
consumer must offer actual Task detail/source navigation and must not call this
a BB task chat. A passive BB chat mirror for headless work remains a separate
SDK capability gap.

Show waiting requests after actual L2 task rows in request order, with a provider
mark when known, no activity ring/dot/New, and a neutral local reset line.
Once `taskThreadId` identifies an actual listed task chat, associate that normal
row with the queued position and mark it already listed/seen; do not duplicate it
or invent a transition chat. A source click navigates to the actual requesting
chat/card. The consumer can invoke the existing actions, never an ad hoc start:

- `queuedStart({id})` refreshes the current receipt and revision.
- `requestPaidStart({id, revision, provider})` opens the existing native
  per-request confirmation; the caller never submits approval automatically.
- `cancelQueuedStart({id, revision})` cancels only that queued request.

These actions are declared in `contract-start-queue.ts`; this sidebar RPC adds
no mutation method. Queue projection reads never transition a request, provision
a sandbox, start a provider, send a message, or change a task. Internal input
briefs, project settings, digests and errors are excluded from the DTO. A queue
read failure preserves the ordinary sidebar and marks its response truncated.
