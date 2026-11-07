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
