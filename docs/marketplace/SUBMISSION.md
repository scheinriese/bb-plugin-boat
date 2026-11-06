# Marketplace submission (draft)

Drafts for listing this plugin in the bb Community marketplace
(https://github.com/get-bb/marketplace). Nothing here is used by the plugin
at runtime.

- `entry.json` becomes `entries/boat.json` in the marketplace repo. Its
  description starts with the same hook as `bb.description` in
  `package.json`; keep the two in step.
- `PLUGIN_OVERVIEW.md` (repo root) is copied to `overview/boat.md`. It must
  stay at 4000 characters or less, counted as the marketplace's
  `checkOverviewMarkdown` counts them (Unicode code points after trimming
  trailing spaces and blank lines).
- `assets/icon.svg` is copied to `icons/boat-<first 8 sha256 characters>.svg`
  (today `icons/boat-474dbab3.svg`; recompute with
  `shasum -a 256 assets/icon.svg` if the icon changes, and update
  `entry.json`).
- The screenshots in `docs/screenshots/` that `entry.json` lists are copied
  to `screenshots/boat/` (at most 6). Each must be PNG, JPEG or WebP, at
  least 1200 px wide, at most 2 MiB, and show no tokens, email addresses,
  home paths, private repo names or unrelated chat text. `backup.png` is
  for the README only. If the set changes, update the list in
  `entry.json` and the Screenshots section below.

## Before submitting

1. The plugin repo is public, and the release tag exists:
   `git ls-remote --tags https://github.com/scheinriese/bb-plugin-boat.git`
   lists `v0.1.0` (an annotated tag that never moves). Private vulnerability
   reporting is on (repo Settings → Security), so the link in SECURITY.md
   works.
2. A clean install of that tag works on the current bb release:
   `bb plugin install git:https://github.com/scheinriese/bb-plugin-boat.git@^0.1.0`.
   A git install runs `npm install --omit=dev --omit=optional --ignore-scripts`
   and then builds, so it fails if bundled code imports a dev dependency.
   CI checks the same (`.github/workflows/ci.yml`, job "build").
3. `npm run typecheck` and `npm test` pass on the tagged commit.
4. `gh api user --jq .login` prints `scheinriese` (it must match
   `author.github`).
5. In a fork of get-bb/marketplace, on a branch named `submit-boat`, add the
   four kinds of files above, then run:
   `npm ci --ignore-scripts`, `npm run build`, `npm test`,
   `npm run gate:v1` and `npm run check`.
6. Commit only `entries/boat.json`, the icon, `screenshots/boat/*` and
   `overview/boat.md`. Open the pull request with the title
   `Add plugin entry: boat` and the body below.

Don't edit `marketplace.base.json` (collections such as New & notable are
the maintainers' choice).

## Pull request body

```markdown
## What the plugin does

Boat Cloud Agents runs Claude Code and Codex in boat.dev cloud sandboxes
from bb. Any chat can send a task to the cloud (a `boat` skill teaches it
`bb boat task start`); the agent works on its own branch and opens a draft
pull request, and the chat hears back when it's done. A Cloud agents page
shows every task with its transcript, report, pull request and private
preview link, plus a setup checklist (also `bb boat doctor`) that checks
the boat sign-in, plan and agent logins before any sandbox starts. Changes
can be reviewed by the other model, and work lands as draft pull requests
or ships to the base branch only after the user approves it. Optional
orchestrator chats plan a project's work, start the tasks and bring the
user only decisions and finished results. The plugin also adds a `bb boat`
CLI, agent tools and skills, send-menu and New thread entry points, and a
"Boat sandbox" machine provider.

## Source

- Repository: https://github.com/scheinriese/bb-plugin-boat
- Source: git, range `>=0.1.0 <1.0.0` (first release `v0.1.0`)
- Plugin id `boat` (from the package name `bb-plugin-boat`), not reserved,
  no existing entry.

## Plugin checks

- [ ] `npm ci`, `npm run typecheck`, `npm test` on `v0.1.0`: <result>
- [ ] Production-only install and `bb plugin build` (as a git install does): <result>
- [ ] `bb plugin install git:https://github.com/scheinriese/bb-plugin-boat.git@^0.1.0` on bb <version>: installs and loads
- [ ] gitleaks on the repo: no findings

## Marketplace checks

- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run gate:v1`
- [ ] `npm run check`

## Permissions, external services and security

- Full-trust plugin. It runs the user's `boat` CLI (boat.dev) on the bb
  machine: it creates, stops, resumes and deletes sandboxes, which cost
  money on the user's boat.dev plan, and runs commands in them. The setup
  checks only read (`boat status`, `limits`, `env list`, `ai profiles`),
  and run before a sandbox is created, so a broken setup uses no starts.
- Needs a boat.dev account and plan, the boat CLI signed in, GitHub
  connected on boat.dev with access to the user's repos, and a Claude or
  ChatGPT subscription connected in boat.dev. Task chats, chats on a Boat
  sandbox and cloud orchestrators need bb Connect.
- At most 3 sandboxes run at once by default, and the plugin never turns on
  boat's paid extra starts. Agents are told to ask before starting more
  than 3 tasks at once.
- Agents push branches and open pull requests with the GitHub access boat
  gives the sandbox. Ship pushes approved commits to a base branch, only
  after the user's approval (a click, or their message in the orchestrator
  chat). A git pre-push hook keeps tasks off protected branches (a guard,
  not a security boundary; the README says to protect branches on GitHub).
  Pushes to a folder inside the sandbox, such as a test's temporary remote,
  pass the hook.
- Uses `gh` on the bb machine read-only: `gh auth status` for the setup
  check, a project's rules file and, only if the user configures one, a
  custom evidence uploader script.
- Runs `git` in the user's local bb project folders to read branches, and
  pushes a branch only on an explicit button click.
- Opens a terminal in bb on the bb machine only when the user clicks
  **Sign in…** or **Run in terminal** on the setup checklist, and types that
  fix's command (`boat onboard`, using the boat path it found; or, for
  example, `boat billing plan 20`). Nothing else is typed.
- Composer entry points act only on the user's click: **Send to a cloud
  agent** puts one instruction line in front of the draft and sends it;
  **Start as a cloud task** turns the draft into a task's brief.
- Tasks run headless in boat by default, with no bb in the sandbox. Task
  chats are opt-in ("How tasks run"). New orchestrators run in a boat
  sandbox by default when bb Connect is set up, and on the bb machine
  otherwise (`--local` or the dialog to choose). Those sandboxes run bb's
  daemon with that machine's bb credentials. Cloud orchestrators start in
  full access, like task chats (a setting, on by default, documented in the
  README and docs/orchestrators.md).
- No secret settings, and no passwords or API keys stored. Environment
  secrets are shown by name only; values are dropped when read. The
  database keeps private preview links and reports with presigned evidence
  links (see below).
- Evidence uploads are off by default. The built-in uploader is part of the
  release (`assets/evidence-upload.mjs`) and reads its bucket keys from the
  user's boat environment, never from plugin settings.
- Calls other bb plugins through bb, when installed: Account Pooler and the
  Claude Code and Codex providers (`provider-usage.v1`, usage readings),
  Push notifications, and the built-in connect plugin's `status` (is bb
  Connect set up). Missing plugins degrade to "usage unknown", no
  notification, or orchestrators on the bb machine.
- Private preview links (`?_token=…`) and presigned evidence links (up to
  7 days) are posted into chats on purpose. The README and overview say so.
- Not affiliated with boat.dev.

## Screenshots

All of them show the real plugin UI in a separate bb with demo content (the
`acme` org, made-up tasks and sandboxes); no real repos, accounts, tokens or
paths.

1. `overview.png`: the Cloud agents page: the status line with plan,
   sandboxes and agent usage, work ready to review (each with the chat
   that started it), running tasks, previews and sandboxes.
2. `setup.png`: the "Set up cloud agents" checklist on a new account: what's
   done, and for the missing plan the command with Copy, Run in terminal
   and a boat.dev link.
3. `new-task.png`: the New task dialog: starters, the repo (with its
   project), what to do, the agent and the "What a task can reach" note.
4. `task.png`: one task's page: pull request, branch, sandbox, who started
   it, a live preview, and the agent's report with evidence links.
5. `orchestrators.png`: the same page with orchestrators: decisions under
   Needs you, one orchestrator per project, then work ready to review.
6. `projects.png`: the plugin's settings: projects with repos, environment,
   secret names and GitHub access checks, then usage limits.

## Overview

`overview/boat.md` is a copy of `PLUGIN_OVERVIEW.md` from the plugin
repository at `v0.1.0`.
```
