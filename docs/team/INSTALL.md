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
npm test
npm run build
bb plugin install "$PWD"
```

If this sandbox's bb CLI cannot resolve `npm/package.json`, its build works
with `NODE_PATH=/usr/lib/node_modules npm run build`. This is an environment
workaround, not a package dependency or an SDK version change.

**Live install was intentionally not run in the implementation sandbox:** the
task's standing instructions prohibit plugin installation, reload and settings
changes against the owner's live bb. The operator runs the final install above.
Both plugin bundles are built and the runtime is exercised with the SDK fake
host and fake cloud CLI.

## Enable and use

1. Open bb Settings → Plugins → Harbormaster → Team. Turn on **Enable Team**.
2. Team creates Nora and an empty home chat in Personal. Without Workbench,
   that chat is pinned. Open **Talk to Nora** on the Team page and send the
   first request. Creating an empty thread ensures its fixed home pointer is
   stored before its first agent turn.
3. Existing Harbormaster orchestrators appear as project leads. Nora can read
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
7. A typed answer names one ask and option through `team_answer_card`. It
   cannot obtain a confirmation token. Unrelated replies leave asks open.
8. “Wasn't me? Pause and revoke” revokes unused grant uses and pauses the
   member's work. Resume the member in Team settings after checking it.

The pinned home is a fixed database pointer, never inferred from sidebar
order or writable thread metadata. `teamSave.homeThreadId` can explicitly
adopt an existing, verified thread. Changes record the previous pointer in
home history and the append-only event ledger.

## Roll back

Turn **Enable Team** off in Harbormaster settings. Team tools, ask surfaces,
sidebar data and engine delivery stop; the original Cloud agents page and
orchestration continue. Chats and Team records are preserved so enabling again
adopts the same chief and home. The chief's existing native pinned chat remains
available. If reverting code, install the previous Harbormaster checkout with
`bb plugin install "$PWD"` from that checkout. Do not delete its database.

The migration only appends `team_records`, `team_events`, `team_settings` and
`team_confirm_tokens` and their indexes. Existing task tables and settings are
not rewritten. Do not remove or reorder migrations after installation.

## Verification and preview

```sh
node --test test/team.test.ts test/team-runtime.test.ts
npm run typecheck
npm test
npm run build
node scripts/team-preview-server.mjs
```

The read-only preview listens on `0.0.0.0:4174` by default (`PORT` overrides
it). Open `/?scene=today`, `board`, `tray`, `strip`, or `confirm`. It renders the
actual plugin components with the fictional example-day replay and a fake SDK.
It neither connects to the owner's bb nor executes effects; preview buttons
are illustrative. It needs the built `dist/app.css`.

## Boundaries and extension points

- The DTO is documented in [SIDEBAR-DTO.md](SIDEBAR-DTO.md). Workbench owns the
  Nora tile, member rows, orbit motion and its Team navigation label. The old
  SDK has a static native nav registration title; its fallback entry remains
  **Harbormaster**, with the Team page title and needs-you badge when enabled.
- Phase 1a keeps the 4,096 instruction floor on every host. Whole mandatory
  blocks fit without truncation, including the full Team rules core and
  compact project rules. Larger memory injection is an extension point.
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
