# Boat sidebar state v1

Boat remains independent of Workbench sidebar. Its default-list row status and
metadata remain registered when this consumer is absent.

The consumer uses public `useSdk().plugins.callRpc` with `pluginId: "boat"`,
`method: "sidebarState"`, input `{ "version": 1 }`, and the Zod output schema
in `contract-sidebar.ts`. This additive RPC is read-only.

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
this list. At seven open tasks, a group gains a rollup and collapses on its
first crossing; subsequent user choices persist. These groups sort by
needs-you, broken, ready, working/review, then idle, retaining BB order inside
each bucket. Smaller groups retain BB order. Automatic sorting waits while
the pointer is over the sidebar or a row has keyboard focus. The generic BB
list, search and other plugin row signals continue to work. Second lines
appear only for needs-you/broken/ready, except a collapsed rollup. Drafts replace the dot;
rollup dot priority is needs-you then broken. Provider identity comes from BB's
public provider catalog, using Boat's provider override when supplied.

Rollup categories are exclusive: paid out-of-memory recovery belongs to
`stopped`, while explicit decisions belong to `needsYou`. Navigation attention
can therefore differ from the sidebar's `needsYou` count. `shippedToday` counts
recorded shipping/merge events, never merely closed native chats. Producer regression tests cover these semantics.

Fixture state belongs only in the isolated demo's backend. Product code never
inserts fixture threads or creates Boat work.

Owner-confirmed additive v1 fields: required `createdFor: "you" | null` and
`listedIn: string | null`. New counts are client-side; no rollup.new field.
See [created-for-you rules](new-threads.md).

`moving?: boolean` is an additive field: a task can keep its logical working
status while its latest completed turn is idle. The provider ring runs only
for working/review with moving !== false; older producers without it keep the
v1 behavior. Idle completion is not presented as a stopped sandbox.

A genuinely paused subscription retry may carry neutral `Waits for reset · 4:00 pm`. Producer eligibility requires a live public `threads.queue.list` row authored by provider-retry, retry payload reason exactly `Rate limited`, scheduled/waiting state, finite future sendAt, and native thread status idle/error. A moving Boat turn, attention/error/ready state, archived/deleted thread, historical retry diagnostic, or bare quota reset never produces this line. The optional v1 input timezoneOffsetMinutes uses Date.getTimezoneOffset() sign (Berlin winter -60), bounded±840; omitted falls back to server-local time. Reads cache15seconds, inspect≤1000 queue rows/50 candidates with4 concurrent thread reads and4s signal; failures quietly retain ordinary rows. Core owns scheduled retry dispatch; disabling provider-retry does not cancel queued work.
