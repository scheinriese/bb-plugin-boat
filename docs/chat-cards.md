# Chat cards

Live cards use authored one-line markers and read their facts from Boat's RPC.
Review markers may name a recorded round, for example `::boat-review{id="t_123" round="2"}`.
A missing round falls back to the latest recorded verdict. Full review and transcript actions open the public Task panel when it is available.

A decision marker may include up to three authored follow-ups, each at most 200 characters:

```text
::boat-decision{id="d_123" followup1="Show the measured requests per client" followup2="Explain the alternatives"}
```

Selecting a follow-up fills the current chat's composer and focuses it. It does not submit a turn.
Decision choices retain the short Undo window. Suggestions and labels are never inferred from a task title.

An OOM marker may include a bounded authored stage description:

```text
::boat-problem{id="t_123" stage="during the production build"}
```

Peak memory, proposed size, relative cost, and stopped events still come from recorded task facts. Larger-size actions use the existing confirmation flow. A native paused-machine banner suppresses only Boat's duplicate banner, using public thread/environment/host lifecycle reads.

`::boat-handoff{}` reads only recorded provider changes. `seq="…"` or an ISO `at="…"` pins a historical switch so a later handoff cannot replace it. Orchestrator notes expand and collapse; task switches stay one event line and link to a recorded previous chat when available. The existing runtime opens a successor chat for a different provider and preserves its environment. The card does not initiate a switch.

With switching enabled, the context row adds a quiet usage hint in the last ten percentage points before the configured threshold. An orchestrator on its alternate agent shows the return-after-reset hint only while the preferred agent is still at its threshold. Every percentage and provider comes from the relay RPC.
