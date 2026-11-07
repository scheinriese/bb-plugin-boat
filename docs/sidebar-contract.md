# Boat sidebar state v1

Boat remains independent of Workbench sidebar. Its default-list row status and
metadata remain registered when this consumer is absent.

The consumer uses public `useSdk().plugins.callRpc` with `pluginId: "boat"`,
`method: "sidebarState"`, input `{ "version": 1 }`, and the Zod output schema
in `contract-sidebar.ts`. This additive RPC is read-only.

The response is `{version:1, revision:string, threads:SidebarThreadDto[],
truncated:boolean}`; at most 2000 records. Every record contains:

| Field | Meaning |
| --- | --- |
| threadId | Existing BB thread id; never a synthetic sidebar row |
| role | orchestrator, task, review, chat |
| status | working, review, ready, shipped, needs-you, broken, stopped, waiting-reset |
| provider | claude, codex or null |
| secondLine | `{text,tone}` or null; tone neutral, attention, danger, success |
| parentThreadId | Existing parent thread id or null |
| createdFor | `"you"` for plugin-dispatched worker chats; null for an owner-started native chat |
| listedIn | Source chat listing the task, or null |
| rollup | `{needsYou,stopped,ready,working,shippedToday}` or null |
| hidden | Hide from sidebar; preserve host search and other surfaces |
| updatedAt | Timestamp string |

Unknown added fields are stripped by the v1 schema. Unknown version/status or
malformed responses fall back to generic BB rows. An unavailable, disabled, or
older Boat (including unknown_method) fails quietly without notifications.
The consumer reads once for the list every 3 seconds in the foreground and
30 seconds in the background, aborts on unmount, avoids concurrent requests,
and retains object identity while revision is unchanged.

Workbench uses Boat nesting, hides shipped tasks and retired reviews from this
list, and sorts sibling Boat tasks by needs-you, broken, ready, review, working,
stopped, waiting-reset. The generic BB list, order, search and other plugin row
signals continue to work. Second lines appear only for needs-you/broken/ready,
except a collapsed orchestrator's neutral rollup. Drafts replace the dot;
rollup dot priority is needs-you then broken. Provider identity comes from BB's
public provider catalog and thread record.

Fixture state belongs only in the isolated demo's backend. Product code never
inserts fixture threads or creates Boat work.

The sidebar owns per-device viewed state. A row is new only when createdFor is
`"you"` and neither it nor listedIn has been opened. It computes the rollup’s
`+N new` count after applying its viewed state; Boat does not send a shared new
count. Native Boat chats adopted from New thread carry the native-chat event
and are never marked created-for-you. Existing orchestrators have no creation
provenance and return null until their creator supplies it.
