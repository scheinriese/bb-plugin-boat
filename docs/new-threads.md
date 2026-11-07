# Created-for-you rows

The owner-confirmed addition to sidebar-spec.md uses a plain lowercase `new`
word (Inter11/14, #9A9A9A), a24px title-line slot, no pill. Priority is draft,
attention, broken, new, unread. A working ring remains visible beside new.

Boat v1 adds required `createdFor: "you" | null` and `listedIn: string | null`.
Adopted owner-started chats return null/null. Workbench stores opened IDs in
its own plugin KV (`workbench:seenThreads:v1`) and reads the SDK's `lastReadAt`
where it shows a thread has already been read since creation. Opening the
listing chat clears the children currently listed there, including arrivals
while that parent remains open.
The store serializes writes, caps ID count and bytes below SDK KV256KiB, and
never changes Boat's storage. Collapsed new counts are computed by the client.

Generic plugin-created visible chats can be identified via public
`PluginSidebarThread.originPluginId`. The SDK only exposes `originKind:
"fork" | null`, and no creation device or automation provenance; therefore
unseen owner-created chats from another device cannot be identified reliably
from SDK0.6.104. They retain native unread signals. This is a `missing data`
limit, supported by the public PluginSidebarThread declaration.

The board C Quiet new word until opened on Paper p-7-0 (y5480) is included in
the comparison/design review batch.

Opened-parent history alone does not clear future tasks. On a parent open,
the sidebar records the IDs currently named by its listing card; while that
parent remains open it records new arrivals too. A later task created after
the parent was left stays new. This avoids relying on a stale parent-open bit.
