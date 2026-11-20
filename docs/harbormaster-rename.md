# Harbormaster rename status

The visible plugin name is **Harbormaster**, with **Cloud agents** as the page
descriptor. Provider names remain boat.dev, Instabox, Scaleway and Your Mac.
Settings uses the manifest's name and description; the plugin controls the
sidebar entry through `navPanel.title` and the page descriptor through
`experimental_usePageTitle`. No host DOM patch is needed for the rename.

## CLI: companion plugin (rename step 2)

**`bb harbor` is available through the optional `harbor/` companion plugin.**
The main plugin still registers `bb boat` exactly as before. Install both:

```sh
bb plugin install https://github.com/scheinriese/bb-plugin-boat
bb plugin install git:https://github.com/scheinriese/bb-plugin-boat --subdirectory harbor
```

The companion registers one command, `harbor`, and forwards argv and the
invoking cwd, thread id and project id to the main plugin's existing CLI
endpoint over `bb.server.loopbackBaseUrl`. It passes cancellation through,
preserves stdout, stderr and exit codes, and never retries a command. It has
no runtime dependencies, settings, database, services or duplicate task
runtime. Help and protocol/agent examples retain `bb boat`; both names run
those exact commands. This deliberately leaves user output untouched.

Keep both plugins enabled and update both when upgrading. A missing or disabled
main plugin returns bb's existing CLI error through `harbor`; a transport or
invalid-response failure returns `harbor_unavailable` with `--json`. Installing
only the main plugin, including on older supported hosts, keeps `bb boat`
working. Removing the companion has no effect on the main plugin's data.

The bridge uses bb's CLI HTTP endpoint rather than `sdk.plugins.callRpc`:
the SDK imposes a 75-second deadline, whereas commands such as `task wait`
can run for 30 minutes. Node's HTTP client adds no request deadline and accepts
bb's whitespace keepalives. The ordinary host CLI boundary still enforces
output limits, handler lifecycle and cancellation on both sides.

### Native aliases checked first

The pinned public Plugin SDK 0.6.104 allows exactly one `bb.cli.register` call
per plugin factory. `PluginCliRegistration` and `PluginCliSpec` have a single
`name` and no top-level aliases. The same restriction was verified in public
SDK packages 0.6.157 and 0.6.164 on 2026-11-20. npm's latest bb is 0.50.1 and
its latest SDK is 0.6.164; the published bb 0.50.1 runtime bundles SDK 0.6.157.
The host normalizer copies only `name`, `summary`, `commands`, `rendersHelp`
and `run`. The strict `bb` manifest schema also has no CLI aliases field.
`cliCommand.aliases` only aliases subcommands, below the one registered name.
Registering thin top-level aliases is rejected by the host, and changing the
one name to `harbor` would break existing `bb boat` scripts.

Required upstream change: expose top-level CLI aliases in registration and
carry them through discovery, dispatch, collision checks and the CLI proxy.
Then the main plugin can register `harbor` with `harbormaster` and `boat` as
aliases to the same handler and retain its single `boat` registration on
older hosts; help and examples can switch to `bb harbor`. The companion can
then be retired without dropping `bb boat`. Add host-level tests
that all three names resolve identically, including nested help, errors, JSON
output and mutating commands. No standalone `harbor` binary is proposed.

### Verification

See [real-host verification](harbor-host-verification.md) for bb 0.50.1
transcripts of both command names. `node scripts/check-harbor-host.mjs` repeats
read-only checks against the bb selected by `BB_CLI` and `BB_SERVER_URL`, with
both plugins already installed. Unit tests additionally exercise context,
shared state, safety refusals, failed-command non-retry, malformed responses,
keepalives and request cancellation. CI builds both plugins on bb 0.48.1,
0.49.0 and 0.50.1.

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
