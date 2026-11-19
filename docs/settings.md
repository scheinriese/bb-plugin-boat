# Settings

Settings → Plugins → Boat Cloud Agents. The plugin's setup checklist comes
first, followed by **Agents**, **Sandboxes & cost**, **Orchestrators** and
**Notifications**. **Advanced** is collapsed and holds the remaining choices,
model presets, protocol, and backup and restore. Projects has a link to the
Cloud agents **Projects** page. Mobile settings show setup status, needs-you
and ready counts, notifications and the paid-usage guard.
`bb boat config get` lists every setting with its value, and
`bb boat config set <key> <value>` / `bb boat config reset <key>` change
any of them. Use these commands rather than `bb plugin config boat set`:
after migration, Boat's values live in the plugin's own storage.

On the first update, legacy fields can still appear above the grouped
section. Their effective values are copied safely before those fields are
hidden. Reload the plugin once more to finish the transition; see
[Moving from an older version](#moving-from-an-older-version).

## Common settings

| Setting | Key | Default | What it does |
| --- | --- | --- | --- |
| Coding agents | `agents` | `auto` | Auto-detect (`auto`) from boat.dev, or Claude and Codex (`both`), Only Claude (`claude`), Only Codex (`codex`). With one agent, every task and review runs on it |
| How tasks run | `workers` | `boat` | Delegated work: In boat (`boat`), As chats for projects (`projects`) or As chats everywhere (`all`). Native starts keep the environment selected in bb. Chats need bb Connect |
| Boat environment | `environment` | empty | The boat environment new sandboxes start from; empty is your boat default. A project can pick its own |
| Default sandbox size | `machineType` | `default` | For new task sandboxes: `small`, `default`, `large` or `xlarge` ([sizes](features.md#sandbox-sizes-and-memory)). A project or a task can pick another |
| Sandboxes at once | `maxActiveSandboxes` | `3` | The most sandboxes running at the same time; 0 is your plan's limit |
| Agent for tasks | `implementProvider` | `claude` | For tasks that don't name an agent. With one agent connected, it runs everything |
| Agent for reviews | `reviewProvider` | `codex` | When a task already ran on this agent, its review uses the other one. With one agent connected, it reviews too |
| Stop idle sandboxes after (min) | `stopIdleAfterMinutes` | `60` | A sandbox whose agent has finished and is waiting for you stops after this long, to save sandbox hours. Work still running, background jobs included, keeps it on (up to 12 hours). Your next message starts it again; anything the agent kept in memory or `/tmp` is lost. 0 is never |
| Notify my devices | `pushNotifications` | off | Push only when work needs you or is ready; routine working, review and idle-stop updates stay in bb |
| Instructions for every task | `workerInstructions` | empty | Added to every task's brief: house rules, test commands, commit style. Don't put credentials here |

**Stop idle sandboxes after** is in minutes: 15, 30, 60 (an hour, the
default), 120 or 240, any other number, or 0 for never
(`bb boat config set stopIdleAfterMinutes 120`). A value you set
stays when the default changes.

## Grouped settings

The checklist shows the current setup step and a fix when one fails, then
offers a test task. After setup it becomes a compact status line. It also
warns when a worker environment passes boat credentials into sandboxes.

**Agents** holds agent detection and the task/review agent defaults.
**Sandboxes & cost** holds the default size, capacity and idle-stop choices.
**Orchestrators** holds coordination defaults. **Notifications** holds Needs
you, Ready and the off-by-default Progress option. Everything else is under **Advanced**, including
How tasks run, environment, instructions, evidence uploads and usage limits.
Rows requiring both agents are unavailable when only one is configured.

The Projects page contains repos, environment, snapshot, size, reviewer and
delivery settings, with secrets shown by name only. An unset project reviewer
inherits the global setting; an explicit native task drawer choice wins.

| Section | Setting | Key | Default |
| --- | --- | --- | --- |
| Advanced | Screenshots and recordings | `evidenceUploader` | empty (off) |
| Advanced | When an agent hits its limit mid-task, continue with the other one | `autoFailover` | on |
| Advanced | Don't start work on paid extra usage | `avoidExtraUsage` | on |
| Usage limits | Allow automatic paid Claude fallback | `paidClaudeFallback` | off |
| Usage limits | Include headless Boat tasks in paid fallback | `paidClaudeHeadless` | off |
| Usage limits | Resume chats stopped at a limit when paid Claude is available | `resumeStoppedChats` | on (only with `paidClaudeFallback`) |
| Advanced | Claude ↔ Codex switching for orchestrators | `relayEnabled` | off |
| Advanced | Switch at (% of a usage limit) | `relaySwitchAt` | `90` |
| Advanced | Switch back below (%) | `relaySwitchBackBelow` | `50` (at least 5 below Switch at) |
| Advanced | Wait before switching back (min) | `relayQuietMinutes` | `10` |
| Advanced | Model for tasks | `implementModel` | empty (the Build preset's model) |
| Advanced | Model for reviews | `reviewModel` | empty (the Review preset's model) |
| Advanced | Effort | `reasoningEffort` | `default` (boat's) |
| Orchestrators | Agent for orchestrators | `relayPreferred` | `claude` (Claude Code); `codex` |
| Orchestrators | Effort for orchestrators | `orchestratorEffort` | `high`; `low`, `medium`, `xhigh` |
| Orchestrators | Tasks at once before asking | `tasksBeforeAsking` | `5`; 0 never asks |
| Orchestrators | Orchestrators in the sidebar | `sidebarLayout` | `sections` |
| Orchestrators | Size for chats on a Boat sandbox | `orchestratorMachineType` | `small` |
| Orchestrators | Full access for cloud orchestrators | `cloudOrchestratorFullAccess` | on |
| Advanced | Hard stop after (hours) | `sandboxTtlHours` | `2` |
| Advanced | Recover any chat after a steer Bad Request | `recoverChatsAfterSteer` | on |
| Advanced | Make room at your sandbox limit | `freeSlotsWhenFull` | on |
| Advanced | Delete sandboxes when tasks close | `deleteSandboxOnClose` | on (sandboxes with unshipped work are kept) |
| Advanced | Where reviews run | `reviewSandbox` | `auto` (a new sandbox if there's room); `new`, `same` |
| Advanced | Extra protected branches | `extraProtectedBranches` | empty |
| Advanced | boat CLI location | `boatPath` | empty (finds `~/.ascii/bin/boat`, then `PATH`) |

Each row in the plugin's settings has a short description. For example:

```sh
bb boat config set relaySwitchAt 85
bb boat config set orchestratorEffort medium
bb boat config set cloudOrchestratorFullAccess false
bb boat config reset relaySwitchAt
```

**Agent for orchestrators** was "Main agent for orchestrators" under Usage
limits; it kept its key, so backups still set it. What both orchestrator
settings do: [Agent, model and effort](orchestrators.md#agent-model-and-effort).

## Back up and restore

Export your setup to a JSON file, and import it on another bb or after a
reinstall:

```sh
bb boat config export --output boat-config.json
bb boat config import boat-config.json --dry-run   # show what would change
bb boat config import boat-config.json
```

![Back up and restore: an import shows what it would change before anything is written](screenshots/backup.png)

- The file holds every setting, your
  projects, your model presets and your custom orchestrator protocol. It
  holds no tasks, sandboxes, chats or secrets, and no page state such as a
  hidden orchestrator card.
- Import merges: it adds and updates projects and keeps the others. It
  applies the file, then prints what changed (settings old → new, projects
  added, updated or removed, presets, protocol). Run it with `--dry-run`
  first to see the changes without applying them. Setting keys it doesn't
  know are reported and skipped; a file with an invalid value or project is
  refused as a whole, in a dry run too. A project without a sandbox size in
  the file (a backup from before projects had one) keeps the size it has.
- `--replace-projects` also removes projects that aren't in the file. It
  refuses to remove a project with open tasks or a running orchestrator.
- Settings → **Advanced → Back up and restore** does the same: Export downloads the
  file; Import shows the changes, then Apply.
- Your instructions and project names are in the file, so keep it private
  if they are.

### Moving from an older version

The grouped layout migrates the effective legacy settings automatically.
The first load keeps the old descriptors readable and copies their values
to plugin storage. One additional plugin reload hides the legacy fields and
uses the saved values in the grouped section. An unreadable migration record
blocks loading rather than silently replacing your choices with defaults.

Keep a backup before updating:

1. On the old version: `bb boat config export --output boat-config.json`.
2. Update the plugin.
3. Reload the plugin once more to finish the grouped-settings migration.
4. Check the values. If restoring a backup, first use
   `bb boat config import boat-config.json --dry-run`, then import it after
   checking the summary.

Import reads backups from older versions (format version 1) and maps them:

- "Workers run as" and "Workers for repos outside your projects" become
  **How tasks run**: in boat stays **In boat**; chats for projects with
  boat for other repos becomes **As chats for projects**; chats for both
  becomes **As chats everywhere**.
- "Check interval" is no longer a setting; the summary lists it as
  ignored.
- If "Switch back below" isn't at least 5 under "Switch at", it's lowered
  to fit, and the summary says so.
- A version 1 file sets every setting it has, including the old defaults:
  **Coding agents** becomes "Claude and Codex" (not Auto-detect) and
  **Sandboxes at once** becomes 0 (your plan's limit, not 3). Check the
  dry-run summary; `bb boat config reset agents` and
  `bb boat config reset maxActiveSandboxes` give you the new defaults.

If values were already lost by an older update before this migration was
available, restore a backup or set them with `bb boat config set`; the
migration cannot reconstruct values that are no longer stored.

## Automatic paid Claude fallback

`bb boat config set paidClaudeFallback true` authorizes ongoing automatic
Claude extra usage for eligible bb task chats and orchestrators. It is off by
default and can stay on alongside `avoidExtraUsage`: this is a narrow exception,
not permission for paid Codex or arbitrary provider changes.

The order is included allowance on the requested/default agent, included allowance
on the other connected agent, then authorized Claude extra usage when all
connected agents have reached `relaySwitchAt`. A recent affirmative Account
Pooler availability signal and active Claude routing are required. Unknown,
stale, disabled or refused paid availability keeps work waiting. A reported
usage/billing failure blocks further automatic paid admission during its tracked
hold. Fresh included quota takes precedence again after reset. Running turns
are not interrupted just to change providers; orchestrators use the existing
handoff/successor path, retaining their workspace and task relationships.

Claude enforces the account's spend cap and credit availability. Boat cannot
read or verify the numeric cap, balance, tax, bundle discount or auto-reload
configuration, does not track a separate money budget, and never purchases
credits. Set and verify the desired monthly cap in Claude before enabling this
policy. Auto-reload purchases and monthly consumption are separate billing
controls. Do not present the usage percentage or an allowed header as euros
remaining or proof that a particular request is being billed.

The availability signal comes from Account Pooler. Headless Boat tasks may
use separately stored credentials. They require a separate paid confirmation
unless `paidClaudeHeadless` is enabled too. Enable that only after confirming
those environments use the same Claude subscription account and billing controls
as bb; leave it off for different accounts or API keys. Boat does not attest
every environment login. An explicitly chosen Codex/model/reviewer
is not silently turned into paid Claude; fixed-agent requests can remain queued.
Native Send now retains its documented core override. Ordinary local chats that
are not registered Boat orchestrators/tasks are not automatically migrated by
this plugin. This policy cannot guarantee completion when a provider, network,
authentication, sandbox or billing account is unavailable.

Task history records `paid-fallback-authorized` separately from a manual
`paid-start-approved` receipt. The context line and Cloud agents home indicate
when extra usage is permitted; the actual provider determines whether a request
uses included quota or credits. Disable the policy to prevent new automatic
paid admissions; already running turns are governed by the provider's billing
controls. The setting persists across restarts and is included in config
backups. Tests use fake providers, never paid requests.

### Chats stopped at a limit

With the fallback on, `resumeStoppedChats` (on by default) continues Claude
Code chats whose latest turn stopped at a usage limit (a 429, such as the
Account Pooler's "No Account Pooler account is currently eligible") once paid
Claude is available. That uses the same check a start makes. It covers any
Claude Code chat on this bb, not only Boat tasks. It runs on its own
one-minute timer, apart from the relay and the task checks, and once a few
seconds after chats stop while paid Claude is already available. A burst of
stops makes one check.

Which chats it finds: the ones bb reported stopped at a limit while this
version of the plugin was running, and any chat with a provider retry waiting
in bb's queue. A chat that stopped before this version was installed, or while
the plugin was off, and has no retry waiting, isn't found; continue it by hand
(`bb thread retry <id>`).

- A retry bb's provider-retry plugin queued for the reset is sent now, the same
  as `bb provider-retry retry`. A retry that goes out within ten minutes anyway
  is left alone.
- A turn provider-retry skipped (`beyond-maximum-wait`), or one with no
  decision a minute after it failed, is retried like `bb thread retry`. A
  retry that someone cancelled stays cancelled. If provider-retry can't be
  asked, or bb answers in a shape this version doesn't know, the chat is left
  alone (the plugin log says so), never retried on a guess. So on a bb whose
  provider-retry has no `decision.get`, only retries waiting in bb's queue are
  sent; a turn provider-retry skipped stays stopped.
- Not continued: archived chats, chats with a turn running or a message
  queued, Codex chats, an orchestrator that is being handed over or was taken
  over, an older chat of a task, and failures that aren't a usage limit
  (authentication, credits, a spend limit).
- Each stopped turn is continued once. A continued turn that stops again
  stays stopped, so a spend limit can't cause a loop.
- Nothing is continued while the reading is stale, Claude is on hold after a
  refused turn, or extra usage is rejected.
- Headless Boat tasks that stopped at a limit in the last week get a
  follow-up, only with `paidClaudeHeadless`, at most one a check.
- A project can stay on included usage: **Never continue on paid Claude** in
  its settings, or `bb boat project set <id> --paid-claude never`. It applies
  to the project's task chats, its orchestrators and every chat in its linked
  bb project. A backup restores it as it was, on or off.

Pacing, so that continuing many chats never becomes a burst of wakes that
boat.dev's start limit or its storage can't take:

- A check makes at most ten attempts, three seconds apart; failed attempts
  count too. The rest wait for the next check.
- The first failure ends the check, and the next one waits 5 minutes, doubling
  up to an hour (this survives a restart). A failed stopped turn gets three
  tries in all; a refusal that proves nothing was sent (the turn moved on, or
  the chat is gone) doesn't use one. A chat's try cut off by a restart may go
  again after ten minutes, as bb refuses a retry that already went out. A
  headless follow-up that failed while its sandbox is up, or was cut off,
  isn't tried again, as it may have reached the agent.
- The chat's machine is checked first. One that is starting, stopping, being
  created or removed, offline or failed is left alone. Waking a suspended
  machine or a stopped sandbox takes one of two wakes a minute, a budget the
  watchdog's own resumes share (kept across restarts). A machine bb couldn't
  start is left alone on its own (bb keeps that message until it starts
  again), never holding the others. Only when a wake the plugin made fails
  (the call, or the machine failing to start within 15 minutes of it) is no
  machine woken for 15 minutes.

A task records a `paid-resume` event. `bb boat relay check` (which also runs
a check now) and the plugin log list each chat that continued, and an
orchestrator gets one message per check naming its workers that continued.
The next step line in Settings › Usage limits counts the stopped chats
continued on paid Claude in the last day.
