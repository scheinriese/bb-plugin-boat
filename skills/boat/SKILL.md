---
name: boat
description: Run coding agents (Claude Code or Codex) in boat.dev cloud sandboxes with the `bb boat` CLI — check the setup, start tasks, request reviews, send follow-ups, inspect sandboxes, and close work. Use when the user asks to spin up a cloud sandbox or cloud agent, delegate coding work to the cloud, check on boat tasks, or clean up sandboxes.
---

# boat: cloud agents in boat.dev sandboxes

The Boat Cloud Agents plugin runs Claude Code and Codex in boat.dev
sandboxes, on the user's boat plan and their Claude and ChatGPT
subscriptions (connected in boat.dev). Everything goes through `bb boat …`,
which runs the user's signed-in `boat` CLI on the bb server's machine, so it
works from any chat, local or cloud. If you're an orchestrator with `boat_*`
tools, use the tools instead (see the `boat-orchestrator` skill).

## Words to use with the user

One word per idea:

- **task**: one piece of work: an agent in a sandbox, with a short id like
  `t_1a2b3c4d`. Roles: `implement` (works on its own branch, pushes, opens a
  draft pull request; in projects that ship after approval it only
  commits), `review` (an independent review), `custom` (anything else, like
  a check or a plan).
- **agent**: Claude Code or Codex.
- **sandbox**: the boat machine a task runs in.
- **project**: GitHub repos with their base branches, plus a boat
  environment. The user sets them up.
- **orchestrator**: a chat that plans and coordinates tasks for one
  project.
- **task chat**: a task the user can open as a bb chat ("How tasks run"
  set to chats, Run as a chat in New task, or Continue as a chat on a
  headless task's page). Otherwise a task runs headless in boat, and the
  user follows it on the Cloud agents page.
- **model preset**: Light, Review, Build, Deep or Frontier (`--tier`).

Don't say worker, slot, tier, relay or usage window to the user. Say task or
agent, room for a sandbox, model preset, Claude ↔ Codex switching, usage
limit.

## Setup problems

- When a command fails with `setup_required`, `unauthorized`,
  `provider_not_configured` or `boat_not_found`, run `bb boat doctor` and
  give the user the fix it prints for each problem. It never starts a
  sandbox, and exits 1 when something required is missing.
- Signing in (`boat onboard`), plans and agent logins are the user's to do:
  tell them the fix, don't run it.
- To check that everything works, `bb boat task start --test` starts a small
  task with no repo that changes nothing: it reports the sandbox's OS, Node
  and git versions and whether GitHub access works. It costs one sandbox
  start and a minute or two of a Small sandbox.

## How tasks report back

The chat that started a task gets a `[boat]` message when the task's turn
ends. Don't poll: end your turn and react to the message. Finished work also
shows under Ready to review on the Cloud agents page.

Idle sandboxes stop on their own, and resume on the next follow-up; their
files and the agent's conversation survive.

## Task chats and headless tasks

- `--headless` on `task start` works everywhere (quick checks nobody opens),
  except in a sandbox that runs bb for a repo the rules don't trust
  (`untrusted_sandbox`: use a new sandbox).
- `--chat` only when the user asked for a task chat, and only for repos in
  a project with Run tasks as chats on (or, with How tasks run set to As
  chats everywhere, any repo not in a project with it off). On
  `untrusted_repo`, don't retry and don't work around it: tell the user the
  hint. A task chat's sandbox can reach their bb, so they decide (Run as a
  chat in New task on the Cloud agents page, or a project). It needs bb
  Connect: on `connect_required`, give the user the fix.
- `bb boat task continue-as-chat <id>` moves a headless task into a task
  chat when the user wants to talk to its agent: bb on its sandbox and a
  chat with the same agent (about a minute). It needs a finished turn and
  bb Connect. Same trust rule; for other repos the user uses Continue as a
  chat on the task's page.
- Never call the plugin's RPC (`bb plugin rpc …`) to start or move chats.

## Agents

- "Coding agents" (`agents`) is Auto-detect by default: the plugin uses the
  agents connected in boat.dev. With one agent, every task and review uses
  it; don't ask for the other one.
- With both, tasks start on the "Agent for tasks" setting, and reviews on
  the other agent. When a task's agent is near its usage limit, a
  follow-up goes to the other agent on its own, and so does a review when
  the agent picked for it is (the task history says so; the user can turn
  this off). Pass `--agent` only when the work needs that agent: naming
  one (or a model, or an effort level only one agent has) turns this off.
- `agents_at_limit` means every agent the user has is near its usage limit.
  Tell the user and wait for a reset (`bb boat relay status` shows usage).

## Costs: ask before more than 3 at once

Each task uses sandbox time on the user's boat plan and agent usage on their
subscription. Ask the user before you start more than 3 tasks at once,
unless they asked for more. "Sandboxes at once" (`maxActiveSandboxes`,
default 3) caps how many run; `bb boat status` shows the room left.

## Commands

| Command | Use |
| --- | --- |
| `bb boat doctor` | Check the setup: boat CLI, sign-in, plan, agent logins, environment, GitHub, bb Connect. Read-only |
| `bb boat status` | Setup summary, plan, room for sandboxes, open tasks |
| `bb boat task start --test` | The test task (no repo, changes nothing; `--agent codex` to test Codex) |
| `bb boat task start --title "…" --brief "…" --tier build --reason "…"` | Start a task on this chat's project (repo, base branch, environment come from it). The model preset (`light`, `review`, `build`, `deep`, `frontier`) picks model and effort for the agent. Add `--project <id>`, `--repo owner/name`, `--agent codex`, `--effort`, `--model`, `--branch`, `--base`, `--role review`, `--sandbox <id>`, `--type small`, `--context-from t_…`, `--headless` (or `--chat`, see Task chats) |
| `bb boat task start … --brief-file brief.md` | Long briefs from a file on your machine |
| `bb boat task review <id>` | Independent review of a task's work, by the other agent by default |
| `bb boat task followup <id> --message "…"` | Next turn in the same conversation (`--agent codex` switches to the other agent at the same preset, `--tier deep` changes the preset, `--steer` redirects a running turn, `--evidence-only` only asks for uploads and needs no message) |
| `bb boat task show <id>` | Status, pull request, branch, sandbox, the agent's report, history |
| `bb boat task transcript <id>` | What the agent did step by step |
| `bb boat task list [--mine] [--all]` | Tasks |
| `bb boat task interrupt <id>` | Stop the running turn |
| `bb boat task continue-as-chat <id>` | Move a headless task into a task chat (bb on its sandbox, a chat with the same agent; follow-ups then go there) |
| `bb boat task close <id> [--cancel] [--keep-sandbox]` | Finish a task; deletes its sandbox unless shared. Unshipped work (projects that ship after approval) is refused unless the user said to discard it (`--discard`) |
| `bb boat task ship <id>` | Projects that ship after approval: push the task's commits to its base branch. Only from the task's orchestrator chat, after the user said so there |
| `bb boat preview list` / `preview wake\|extend\|stop <id>` | Previews agents left running (private links), and bringing a sleeping one back |
| `bb boat sandbox list [--all]` / `sandbox new [--repo …]` / `sandbox info\|stop\|resume\|delete <id>` | Sandboxes |
| `bb boat sandbox exec <id> -- <command>` | Run a shell command in a sandbox |
| `bb boat sandbox snapshot <id> <name>` / `sandbox snapshots` | Save a sandbox as a snapshot; list saved ones (`--snapshot <name>` on task start starts from one) |
| `bb boat project list [--local]` | Projects (and local bb projects as `local:<id>`) |
| `bb boat project add --name "Web app" --repo acme/web@main` | Add a project (repeat `--repo` for more repos; `--environment`, `--snapshot`, `--protocol`, `--workers`, `--delivery`, `--protected-branches "release, develop"`, `--instructions` or `--instructions-file`) |
| `bb boat project set <id> --delivery pr\|push` | Change a project: how work lands (draft pull requests, or ship after approval), and the same options as `add` (`none` clears protected branches or instructions) |
| `bb boat orchestrator new --project <id> --prompt "…"` | Start an orchestrator for a project (`--local` on this computer, `--cloud` in a new small boat sandbox, which needs bb Connect; without either, the cloud when bb Connect is set up; `--take-over <thread>` continues a previous one) |
| `bb boat orchestrator on` / `off` | Make the current chat an orchestrator, or stop (tools load on its next session) |
| `bb boat protocol show [--project <id>]` | The orchestrator protocol: shared rules, model presets, then the project's rules file |
| `bb boat relay status` | Each agent's usage, and which agent each orchestrator runs on |
| `bb boat config get [key]` | Every setting with its value (or one) |
| `bb boat config set <key> <value>` / `config reset <key>` | Change one setting, or put it back to its default |
| `bb boat config export [--output <file>]` | Back up every setting, the projects, model presets and the custom protocol as JSON |
| `bb boat config import <file> [--dry-run] [--replace-projects]` | Restore such a file (older versions' files too): applies it, then prints what changed (`--dry-run` only shows what would). A file with an invalid value is refused, dry run or not. Merges projects unless `--replace-projects` |

Add `--json` for machine-readable output. Every command has `--help`.

## Settings

`bb boat config get` lists every setting: bb's settings list (for example
`agents`, `workers`, `machineType`, `maxActiveSandboxes`,
`workerInstructions`) and the plugin's own (for example `relayEnabled`,
`extraProtectedBranches`, `evidenceUploader`,
`cloudOrchestratorFullAccess`). Change one with
`bb boat config set <key> <value>`, and only when the user asks.
`bb plugin config boat set` can't reach the plugin's own settings.

## Writing a brief

Agents run unattended and can't ask questions. A good brief has:

1. **Goal**: the outcome in one or two sentences.
2. **Context**: relevant files, modules, prior decisions, links to issues.
3. **Constraints**: what must not change, style or library rules.
4. **Acceptance criteria**: concrete checks, plus tests to add or run.
5. **Delivery**: `implement` tasks push a branch and open a draft pull
   request on their own (or only commit, in projects that ship after
   approval); say if the pull request should target a different base
   branch.

The plugin adds the repository location, git setup, the user's and the
project's instructions, and a required `=== REPORT ===` block at the end of
the agent's answer.

## Screenshots and recordings

When the user turned uploads on ("Screenshots and recordings",
`evidenceUploader`: `builtin`, or their own `owner/repo:path@ref` script),
every task sandbox has `evidence-upload`. Agents run
`evidence-upload <files or folders> --name <short label>` and paste the
printed links into their report; `evidence-upload --link <key>` prints a
fresh link. The built-in uploader reads its bucket and keys from the boat
environment (`EVIDENCE_BUCKET`, `EVIDENCE_ACCESS_KEY_ID`,
`EVIDENCE_SECRET_ACCESS_KEY`, and `EVIDENCE_ENDPOINT` or
`CLOUDFLARE_ACCOUNT_ID`). Never ask for or print key values.

## Rules

- Use task ids from command output. Never guess them.
- Prefer one task per independent change; don't run two `implement` tasks
  on the same branch.
- Never point a task at a protected branch: `main`, `master`, the task's
  base branch, any project's base branch or protected branches for that
  repo, or one in the user's "Extra protected branches"
  (`extraProtectedBranches`). Tasks push their own branch and open a draft
  pull request. The plugin refuses such tasks.
- In projects that ship after approval, work reaches the base branch only
  through `bb boat task ship` after the user's OK in the orchestrator chat
  (or their Ship click). Never discard unshipped work unless the user says
  so.
- Frontier at `--effort max` is refused unless the user approved it
  (`--user-approved`).
- Close tasks when their work is merged or abandoned, so sandboxes are
  freed.
- Don't delete sandboxes that open tasks use (`sandbox delete` refuses).
- If a start fails with `boat_at_capacity`, close or stop something, reuse a
  sandbox with `--sandbox <id>`, or tell the user that a bigger boat plan
  (`boat billing plan`) or a higher "Sandboxes at once" raises the limit.
- `bb boat config import` and `bb boat config set` change the user's
  settings: run them only when the user asks, and show them the
  `--dry-run` summary of an import first.
