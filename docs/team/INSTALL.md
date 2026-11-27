# Install and use Team phase 1a

Team is included in Harbormaster (`boat`) and off by default. It requires bb
0.48.1 or newer, with SDK 0.6.104 or newer. No sandbox subscription is needed
for the chief's home chat; cloud work uses existing Harbormaster settings.

## Build and install

In a checkout of this branch, run:

```sh
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run typecheck
REQUIRE_GITLEAKS=1 npm test
npm run build
bb plugin install "$PWD"
bb plugin install "$PWD/harbor"
```

The exact build command used in this sandbox (its CLI cannot otherwise resolve
`npm/package.json`) is:

```sh
NODE_PATH=/usr/lib/node_modules npm run build
```

That command builds **both** the Harbormaster and harbor companion bundles.
Use it in place of the plain build command above on this host. It does not
change package dependencies or the SDK pin. Both install commands are necessary
when installing the companion CLI alongside Harbormaster.

**Live install was intentionally not run in the implementation sandbox:** the
task's standing instructions prohibit plugin installation, reload and settings
changes against the owner's live bb. The operator runs the final install above.
Both plugin bundles are built and the runtime is exercised with the SDK fake
host and fake cloud CLI.

## Enable and use

1. Open bb Settings → Plugins → Harbormaster → Team. Turn on **Enable Team**.
2. Team creates Nora's home in Personal with a short, plugin-originated
   introduction prompt labelled `[team · setup]`. The SDK requires a nonempty
   first input; it has no supported turn-free thread creation method. Without
   Workbench, the chat is pinned. Team becomes enabled only after the home
   pointer is saved. If creation fails, Team stays off and settings shows an
   error; retry **Enable Team**. Open **Talk to Nora** to hand her work.
3. Each Harbormaster project's current active orchestrator appears as its lead. Nora can read
   the directory and board, assign work with a checkable “done when”, consult
   a lead, notify a lead, and create asks. No specialist is created automatically.
4. The former Cloud agents page shows Team's Today and Board while enabled.
   Sandboxes and Projects reuse their existing screens; Usage reuses existing
   usage meters. **Cloud work and activity** on Today retains the original
   task controls, setup, orchestrators, history and activity.
5. Rename Nora or edit her standing instructions and shared Team rules in
   the same settings section. `## Always include` holds the injected core:
   900 characters for standing instructions, 350 for shared rules.
6. Answer asks in Today, the Board details, Nora's tray or a blocked thread's
   composer row. A locked choice replaces the row with its restated scope,
   action button and Cancel. Long scopes open `ask/<id>`. Merge choices open
   the task chat and replace its strip, with fresh checks and the exact HEAD.
7. A typed answer names one ask and option and quotes the latest user reply
   through `team_answer_card`. Only a user-started turn with no sender thread
   in the ask's chat or chief's home can record it. It cannot obtain a confirmation token. Unrelated replies leave asks open.
8. “Wasn't me? Pause and revoke” revokes unused grant uses and pauses the
   member's work. Resume the member in Team settings after checking it.

On first enable, ready work from before Team is grouped under **From before
Team** on Today, collapsed and excluded from Nora's count. Its rows open the
existing task chats. Existing open project decisions still count. Only work
becoming ready after the original enable creates new counted Review asks; the
cutoff survives reloads and disabling/re-enabling. Existing installs recover it
from the chief's first saved home event. Board mirrors open work and the last
24 hours of native task activity; older copies remain stored for audit.

The pinned home is a fixed database pointer, never inferred from sidebar
order or writable thread metadata. `teamSave.homeThreadId` can explicitly
adopt an existing, verified thread. Changes record the previous pointer in
home history and the append-only event ledger.

## Roll back

Turn **Enable Team** off in Harbormaster settings. Team tools, ask surfaces,
sidebar data and engine delivery stop; the original Cloud agents page and
orchestration continue. Chats and Team records are preserved so enabling again
adopts the same chief and home. The chief's existing native pinned chat remains
available. If reverting code, use a checkout of the previous Harbormaster
version. Build both bundles and reinstall both plugins from that checkout:

```sh
npm ci --ignore-scripts
npm rebuild better-sqlite3
NODE_PATH=/usr/lib/node_modules npm run build
bb plugin install "$PWD"
bb plugin install "$PWD/harbor"
```

On hosts without the CLI resolution issue, `npm run build` is sufficient.
Do not delete the plugin database or attempt to undo its appended migrations.

The migration only appends `team_records`, `team_events`, `team_settings` and
`team_confirm_tokens` and their indexes. Existing task tables and settings are
not rewritten. Do not remove or reorder migrations after installation.

## Verification and preview

```sh
node --test test/team*.test.ts
npm run typecheck
npm test
npm run build
node scripts/team-preview-server.mjs
```

The read-only preview listens on `127.0.0.1:4174` by default. Set `PORT`
to change the port; explicitly use `HOST=0.0.0.0 PORT=4174 node
scripts/team-preview-server.mjs` for a remote sandbox preview. Open `/?scene=today`, `board`, `tray`, `strip`, or `confirm`. It renders the
actual plugin components with the fictional example-day replay and a fake SDK.
It neither connects to the owner's bb nor executes effects; preview buttons
are illustrative. It needs the built `dist/app.css`.

## Boundaries and extension points

- The DTO is documented in [SIDEBAR-DTO.md](SIDEBAR-DTO.md). Workbench owns the
  Nora tile, member rows, orbit motion and its Team navigation label. The old
  SDK has a static native nav registration title; its fallback entry remains
  **Harbormaster**, with the Team page title and needs-you badge when enabled.
- Phase 1a keeps the 4,096 instruction floor on every host. Normal project
  configurations include the shared core and compact project rules. An
  unexpected overflow or invalid stored core falls back to the existing
  orchestrator instructions plus the consent line; it never prevents a turn.
  Larger memory injection is an extension point.
- Specialist templates, quick ask shortcut, compact phone page, routines,
  health checks, memory/journal UI and automatic rollover are deferred.
  The Markdown editor is included; import/export and home-history Undo UI
  are deferred.
- The outbox records sends before dispatch. An interrupted or ambiguous send
  stays **uncertain** and opens a Problem; it is not automatically resent.
  Native dispatch dedupe and idempotent start/result paths prevent duplicate
  work. Automated nonce reconciliation/resend is deferred; inspect the target
  chat before deciding whether to resend. The Board exposes delivery receipts.
- Problems currently cover stopped-early work, budgets, delivery ambiguity,
  disputed answers and uncertain merge outcomes. Offline-machine incidents
  are fixture-tested; automated machine monitoring and a dedicated Problems
  chat remain deferred to the health phase.
- Grants cover one member, explicit targets, expiry and uses. Sends are held
  30 seconds before a grant can be consumed. Team's tools check these rules;
  arbitrary external tools and shell commands are not sandboxed by Team.
  The host does not attest the owner: provenance is always **unverified tap**
  or **typed reply**. RPC clients can open the same restated confirmation as
  the UI; this is the spec's explicitly degraded approval model.
- Do asks enter verifying and stay open until the member reports observed
  effect evidence. Connector-specific secure forms and automatic probes are
  extension points. The receipt distinguishes a member's reported effect
  from native Merge's GitHub verification. There is no invented Undo button.
- Existing native Merge entry points route mapped tasks through Team's single
  confirmation step. Native push-delivery Ship retains Harbormaster's existing
  guarded confirmation; Team's automatic review bridge currently covers PRs.


## Runtime recovery

The mirror runs from the monitor and Team actions, never in a sidebar poll.
Each pass indexes members, assignments and asks once and updates only changed
native tasks. A malformed record becomes a Problem without blocking other
work. Optionless legacy decisions use their recommendation or a free-text
answer. Existing `boat_needs_you`, `boat_resolve` and CLI resolution continue
to operate: resolving or withdrawing supersedes the matching open ask and
invalidates its confirmation tokens. Team answers write a labelled, provenance-
bearing outbox relay before closing the native decision; uncertain delivery
remains visible instead of being silently dropped.


The chief uses bb's canonical Personal project id (`proj_personal`), shared with
Harbormaster's other spawn paths. A real bb 0.50.1 sandbox probe confirmed that
`personal` fails with `project_not_found`, while `proj_personal` accepts the
same pinned, plugin-originated text input (including empty mentions) and reached
active on the sandbox host. The probe
was stopped and archived. The client maps input directly to the thread creation
request; there is no need to remove plugin provenance or use a separate send.
Setup warnings include nested cause messages, codes and HTTP status. Failed
home setup is latched off persistently: monitor sweeps and state reads do not
retry it, including after reload. Retry explicitly with **Enable Team**.

## Delivery recovery

An explicit member pause is stored independently of native chat availability.
A temporary lookup failure holds pending delivery; it does not archive the member
or resume paused work. Confirmed archival/deletion can hide a project lead, but
unarchiving or recovering the lookup preserves the pause until **Resume**.
Resume while the chat is unavailable still holds delivery until bb verifies it.

Changing a project's current lead moves assignment references and **pending**
outbox receipts together in one transaction. Receipt ids, nonces and labelled
text stay unchanged. Accepted, sending, uncertain and failed receipts are retained
as history and never automatically resent to the replacement. An interrupted
migration rolls back and is safe to retry; older stranded pending receipts are
also reconciled. Sending rechecks native availability, pause and the current
receipt immediately before claiming it.

Adopting the chief's home validates the native thread and persists its actual
bb project. Archived/deleted chats and invalid project mappings are rejected
before settings change. Later project moves refresh the mapping; a lookup outage
keeps the last verified project while delivery waits. New generated homes still
start in `proj_personal`.
