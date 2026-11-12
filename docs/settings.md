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
