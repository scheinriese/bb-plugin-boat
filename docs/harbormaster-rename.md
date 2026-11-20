# Harbormaster rename status

The visible plugin name is **Harbormaster**, with **Cloud agents** as the page
descriptor. Provider names remain boat.dev, Instabox, Scaleway and Your Mac.
Settings uses the manifest's name and description; the plugin controls the
sidebar entry through `navPanel.title` and the page descriptor through
`experimental_usePageTitle`. No host DOM patch is needed for the rename.

## CLI: needs bb

The intended primary command is `bb harbor`, with `bb harbormaster` and
`bb boat` as permanent aliases. **Only `bb boat` is available in this draft.**
Commands, help, protocol hints and skill examples continue to use that working
namespace until bb supports the other names.

The pinned public Plugin SDK 0.6.104 allows exactly one `bb.cli.register` call
per plugin factory. `PluginCliRegistration` and `PluginCliSpec` have a single
`name` and no top-level aliases. The same restriction was verified in public
SDK packages 0.6.157 and 0.6.164 on 2026-11-20. `cliCommand.aliases` only aliases
subcommands, below the one registered name. Registering thin top-level aliases
is rejected by the host, and changing the one name to `harbor` would break
existing `bb boat` scripts.

Required upstream change: expose top-level CLI aliases in registration and
carry them through discovery, dispatch, collision checks and the CLI proxy.
Then register `harbor` with `harbormaster` and `boat` as aliases to the same
handler; help and examples can switch to `bb harbor`. Add host-level tests
that all three names resolve identically, including nested help, errors, JSON
output and mutating commands. No standalone `harbor` binary is proposed.

The [name check in PR #20](https://github.com/scheinriese/bb-plugin-boat/pull/20)
concludes “go with caveats.” Its recommendation to lead with `bb harbormaster`
is superseded by the owner's choice of `bb harbor`. Trademark verification
and marketplace publication remain separate tasks.

## Step 2 migration checklist

These compatibility surfaces deliberately keep their existing spellings:

- [ ] Package/repository/plugin identity: `bb-plugin-boat`, plugin id `boat`,
  install/reload/config examples and GitHub URLs (`package.json`, README).
- [ ] Tool API: all `boat_*` registrations and references (`src/tools.ts`,
  protocol, skills, and `server.ts` agent configuration).
- [ ] Skill ids and directories: `boat`, `boat-orchestrator`,
  `boat-sandbox-wake` (`skills/`, `server.ts`).
- [ ] Setting keys and values, including `boatPath`, runner `boat`, and
  `pluginSettings` KV storage (`src/settings.ts`, `src/settings-store.ts`,
  `src/projects.ts`, `src/store.ts`).
- [ ] Data directory/database: `plugins/boat/data.db`, plugin-local files,
  SQLite tables/columns, KV keys and migration history (`src/store.ts`,
  `src/runtime.ts`, `server.ts`). No data migration in this step.
- [ ] Provider ids: `boat`, `instabox`, `scaleway`, `your-mac`, `monthly-mac`
  (`src/providers/types.ts`, `src/rpc-providers.ts`).
- [ ] Machine/environment provider ids: `boat-sandbox`,
  `boat-sandbox-personal`; saved host/environment ids and resource fields
  (`src/providers/boat/provider.ts`, `src/providers/machine.ts`). Existing
  machine records are not rewritten; new display labels say boat.dev.
- [ ] RPC names and DTOs, including `sidebar.v1`, `provider-retry.v1.consent`,
  project scope `configured-boat-repos`, and realtime channel `boat-changed`
  (`contract*.ts`, `src/rpc*.ts`, `server.ts`).
- [ ] URL paths: `/plugins/boat/…`, `/settings/plugins/boat`, panel path
  `cloud-agents`, navigation ids, CSS classes/variables and branding icon ids
  (`app.tsx`, `web/format.ts`, `web/boat-ui.css`).
- [ ] Message protocol: `[boat]`, `[boat relay]`, `::boat-task`,
  `::boat-start-queue` and other `boat-*` directives (`src/format.ts`,
  `src/prompts.ts`, `web/cards.tsx`, `web/start-queue.tsx`).
- [ ] Backup/wire formats and generated file names: `bb-plugin-boat-config`,
  `boat-config-*.json`, branch prefix `boat/`, metadata/helper/hook markers
  (`src/config.ts`, `src/service.ts`, `src/sandbox-repos.ts`).
- [ ] External marketplace entry and historical media: existing screenshots,
  videos, asset paths and changelog history retain their original branding.
  Publish refreshed assets and migrate the marketplace separately.

`bb boat` must remain supported when the new CLI names become available;
it is not a candidate for removal in step 2.

## Preview evidence

Run `npm run build`, then `npm run preview:providers -- --host 0.0.0.0 --port 4173`
and open `/?scene=name`. The harness renders actual provider rows and a chat
notice card with neutral fixtures. Its Settings and page chrome are simulated
from the manifest and nav-panel registration; they do not exercise the live
bb host. Before/after images and CLI help are attached to the draft PR.
