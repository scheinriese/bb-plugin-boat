# Boat Cloud Agents for bb

Run Claude Code and Codex in [boat.dev](https://boat.dev) cloud sandboxes
from [bb](https://getbb.app). Ask any chat to send a task to the cloud,
follow it on the Cloud agents page, and review the pull request. For a
steady stream of related work, an orchestrator chat can plan it, start the
tasks and get each change reviewed.

This is a community plugin. It is not made by or affiliated with boat.dev or
bb. The workflow is inspired by Conductor's cloud workflow.

![The Cloud agents page: work ready to review, running tasks, previews and sandboxes](docs/screenshots/overview.png)

![One task: its pull request, preview link and the agent's report](docs/screenshots/task.png)

## Getting started

You need bb 0.48 or later, a boat.dev account with a plan, and a Claude or
ChatGPT subscription. The steps below set up the rest.

1. **Install boat** on the machine that runs bb:
   ```sh
   curl -fsSL https://boat.dev/install | sh
   ```
   It signs you in and starts a plan (7-day trial, card required). When it
   asks who the sandboxes are for, answer **just me**. The other answer
   turns on "Safe for third parties", and agents then get no logins.
   Already have boat? `boat onboard` signs you in and finishes whatever your
   account still needs; it's safe to run again.
2. **Connect an agent** on boat.dev → [Agents](https://boat.dev/dashboard?tab=agents):
   sign in with Claude (Pro or Max) and/or ChatGPT (Plus, Pro or Team), or
   add an API key. Tasks use these subscriptions.
3. **Connect GitHub** on [boat.dev](https://boat.dev/dashboard) →
   Environment → Connect GitHub, and give boat access to your repos. Tasks
   clone and push with it.
4. **Install the plugin:**
   ```sh
   # Follows the default branch
   bb plugin install https://github.com/scheinriese/bb-plugin-boat

   # Or follows 0.1.x release tags (the marketplace listing follows every 0.x release)
   bb plugin install git:https://github.com/scheinriese/bb-plugin-boat.git@^0.1.0
   ```
   bb shows what it will install and asks you to confirm. A plugin is
   full-trust code, so read [Trust and data](#trust-and-data) first.
5. **Check the setup.** Open **Cloud agents** in bb's sidebar. Until
   everything is in place, it shows a "Set up cloud agents" checklist with a
   fix for each problem (**Sign in…** opens a terminal that runs
   `boat onboard`; other commands have **Run in terminal**). Or run:
   ```sh
   bb boat doctor
   ```
   It checks the boat CLI, your sign-in, plan, agent logins, boat
   environment and bb Connect, without starting a sandbox. GitHub access
   can only be seen from inside a sandbox, so it shows your last task's
   check (your first task on a repo checks it).

   ![The setup checklist: what's done, and the fix for what's missing](docs/screenshots/setup.png)
6. **Run a test task.** Click **Run a test task** on the page, or run
   `bb boat task start --test`. It needs no repo and changes nothing: the
   agent reports the sandbox's OS, Node and git versions and whether GitHub
   access works. That proves your sign-in, plan and agent login, for one
   sandbox start and a minute or two of a Small sandbox.
7. **Real work.** Ask any chat, for example: "Use a cloud agent to fix the
   flaky login test in acme/web." Or click **New task**, pick the repo and
   say what to do. The agent works on its own branch and opens a draft pull
   request, and the chat that started it hears back when it's done.

There's nothing to set first: **Coding agents** follows what's connected in
boat.dev, and tasks run headless in boat. Once you work on the same repos
often, add them as [projects](#projects).

## Three ways to use it

| | Task from a chat | Cloud agents page | Boat sandbox chat |
| --- | --- | --- | --- |
| How you start it | Ask any chat to use a cloud agent, or **Send to a cloud agent** in the send menu | **New task** (also **Start a cloud task** on bb's New thread screen) | Pick **Boat sandbox** in a new chat's environment menu |
| Where the agent runs | In its own boat sandbox | In its own boat sandbox | The whole chat runs in a boat sandbox |
| Where you follow it | The chat hears back when a turn ends; the details are on the Cloud agents page | On the Cloud agents page: transcript, report, pull request, preview | In the chat, like any other |
| Can you type into it | Through the chat that started it, or the task's reply box | The task's reply box | Yes, it's a regular chat |
| Needs bb Connect | No (only for task chats) | No (only for task chats) | Yes |
| Best for | Handing off a piece of work without leaving your conversation | Starting work directly, checking a repo, a test task | Long hands-on sessions that keep going while this computer sleeps |

A **task chat** is a task you can open as a bb chat and type into: set
**How tasks run** to one of the "As chats" options (needs bb Connect). See
[How tasks run](#how-tasks-run-in-boat-or-as-task-chats). Turn on bb Connect
with `bb account login` (then `bb connect on` if it's off); the setup
checklist shows its state.

For a goal that keeps producing tasks, an **orchestrator** (a chat that plans
and coordinates tasks for one project) does the planning, starting and
reviewing for you. See [Go further](#go-further-orchestrators).

## Costs

The plugin adds no service of its own. Each task uses two things you already
pay for:

- **Sandbox time on your boat.dev plan.** Small sandboxes run at half rate,
  Large at double; XLarge needs boat's $100 plan or higher. boat's $20 plan
  includes about 555 hours of Default sandbox time a month (about $0.036 an
  hour). A stopped sandbox uses no sandbox time, and waking it counts as a
  start. The trial lasts 7 days (card required) and allows 2 sandboxes at
  once, 75 starts a day and an auto-stop of at most 2 hours. The plugin
  reads that cap from `boat limits` and keeps every sandbox it starts,
  resumes or extends within it. `boat limits` shows what's left.
- **Agent usage on your Claude or ChatGPT subscription**, from the same
  usage limits you use everywhere else.

What the plugin does to keep that down:

- At most 3 sandboxes run at once (**Sandboxes at once**; 0 means your
  plan's limit). Agents using the plugin ask you before they start more
  than 3 tasks at once.
- A sandbox stops once its agent has waited 30 minutes (**Stop idle
  sandboxes after**). The task picks up again on your next message. Closing
  a task deletes its sandbox.
- When your agents are near their usage limits, new tasks wait for a reset
  instead of starting on paid extra usage (**Don't start work on paid extra
  usage**).
- It never turns on boat's paid extra starts (`boat billing extra-starts`,
  off by default).

An orchestrator uses sandbox hours and agent usage faster than single tasks:
it starts several tasks, and a review for each.

## What a task can reach

The agent runs every command without asking, inside its sandbox. It can use
what your boat environment gives it: push access to its GitHub repos, your
Claude or ChatGPT login, its variables and secret files. A hostile README or
issue could try to talk it into sending those somewhere, so keep secrets out
of environments you use for repos you don't trust.

- Tasks never push to protected branches (`main`, `master`, base branches
  and the ones you add). A git hook enforces it, but it's a guard for
  well-behaved agents, not a security boundary: protect your base branches
  on GitHub too.
- Task chats and cloud orchestrators also run bb in their sandbox, with this
  bb machine's credentials, connected through bb Connect. Use them only for
  repos you trust. **How tasks run** → "As chats for projects" allows task
  chats only in projects that have **Run tasks as chats** on.
- boat's AI credentials proxy (`boat ai proxy on`, a paid boat feature)
  gives sandboxes placeholder keys, so your real Claude and ChatGPT
  credentials never enter them.

More in [Trust and data](#trust-and-data).

## Features

### The Cloud agents page

The page in bb's sidebar changes with what you have:

- **Until the setup is complete:** the "Set up cloud agents" checklist (if
  you already have tasks, it sits above them). Each row says what's missing
  and how to fix it: a command to copy or **Run in terminal**, a button
  that opens boat.dev, or **Sign in…**. Optional things (bb Connect,
  GitHub, the GitHub CLI, a first project) sit under "Later, if you need
  them".
- **Before your first task:** "Start your first task", with the three ways
  above and **Run a test task**.
- **Every day:** a status line (your boat plan, sandboxes against your limit, sandbox
  hours left, each agent's usage), then **Ready to review** (finished work
  with its note, pull request and preview link), **Running**, **Previews**
  (live and sleeping ones), **Sandboxes** (each says what uses it) and
  **Recently done**.
- **With an orchestrator:** **Needs you** (decisions only you can make) and
  **Orchestrators** move to the top.

The header has **New task**, and a ⋯ menu with **New sandbox**, **New chat
in a Boat sandbox** and **New orchestrator…**. Each task opens a page with
its report, review, transcript, previews, history and a reply box, plus
**Request review** and, where it applies, **Ship** or **Save as snapshot**
(a finished test task offers **New task** instead). In the reply box,
**Agent with room** (the default with both agents) continues on the task's
agent, or on the other one when it's near its limit; **Keep Claude** (or
Codex) never switches.
A task started from a chat shows "From" and the chat's name; one started by
an orchestrator links to it. A finished turn of a task you started (from a chat
or the page) lands in **Ready to review**; an orchestrator's tasks wait for
the orchestrator first.

### Start from anywhere in bb

- **Any chat:** ask it to use a cloud agent. The `boat` skill teaches it
  `bb boat task start`. The chat gets a `[boat]` message when the task's
  turn ends, so you don't need to watch it.
- **The send menu:** **Send to a cloud agent** in a chat sends your message
  with a request to use one. On bb's New thread screen, **Start as a cloud
  task** turns your draft into a task (the repo comes from the chat's
  project).
- **The New thread screen's side panel:** **Start a cloud task** opens the
  New task form.
- **The environment menu:** **Boat sandbox** runs a whole chat in a
  sandbox, with a size chip next to it. Sizes your plan can't use are
  greyed out with boat's reason.
- **A task chat's header:** **Ship** and **Request review**. An
  orchestrator's header has **Open board**.
- **A chat's menu:** **Coordinate from this chat…** makes it the
  orchestrator for a project.
- **bb's home screen:** "Hand a task to a cloud agent", with **New task**.

### New task

![New task: a starter, the repo, what to do and the agent](docs/screenshots/new-task.png)

New task asks for the repo, what to do and the agent; branch, base branch,
role, model, sandbox and size are under **More options**. Starters fill in
the brief:

- **Check this repo runs in a sandbox:** installs, tests and starts the
  app without changing code, and reports what the boat environment is
  missing. It runs on the Light model preset. When it's done, **Save as
  snapshot** keeps that sandbox's setup, and the project's tasks can start
  from it.
- **Fix a bug:** what's wrong, where, the error output, what you expected
  and how to check.
- **Explore and plan, no changes** (on the Review model preset).
- **Test task (no repo).**

A good brief has the goal, the context (files, issues, earlier decisions),
the constraints, how to check the result, and anything special about the
pull request. The agent can't ask questions mid-task. The plugin adds the
checkout, the push rules and a report block at the end of the agent's
answer.

### Projects

A project is one or more GitHub repos, each with a base branch, plus the
boat environment its tasks start in. Single tasks don't need one, but a
project lets you set things once per repo, and every orchestrator works on
one. New installs start with none.

![Settings: projects with their repos, environment, secrets by name and GitHub access, then usage limits](docs/screenshots/projects.png)

- Add one in Settings → Plugins → Boat Cloud Agents → Projects, or:
  ```sh
  bb boat project add --name "Web app" --repo acme/web@main --environment web
  ```
  Repeat `--repo` for more repos; the first is the main one, and tasks
  clone the others next to it.
- Per project: the boat environment, a snapshot tasks start from, how work
  lands, **Run tasks as chats**, protected branches, instructions added to
  each task's brief, and an orchestrator rules file in its main repo.
- From the command line:
  ```sh
  bb boat project set web-app --protected-branches "release, develop" --instructions-file house-rules.md
  ```
  `none` clears protected branches or instructions.

### How tasks run: in boat, or as task chats

**How tasks run** decides what a task's agent is:

- **In boat** (default): headless in boat. You follow it on the Cloud
  agents page (transcript, report, reply box). No bb runs in the sandbox,
  and bb Connect isn't needed.
- **As chats for projects:** tasks on repos of projects with **Run tasks as
  chats** on are bb chats on their sandbox, nested under the chat that
  started them. Other repos still run in boat (with an "Untrusted repo"
  badge).
- **As chats everywhere:** every task is a task chat, unless its project
  has **Run tasks as chats** off.

Open a task chat to watch every step or write to it; the plugin treats your
turn as part of the task. Ultracode (Claude) and Ultra (Codex) work there.
Task chats need bb Connect and take about a minute longer to start. Their
sandbox holds bb machine credentials, so keep them for repos you trust.

Idle sandboxes stop on their own. Their files and agent conversations
survive and resume on the next follow-up. Closing a task deletes its
sandbox, unless another open task uses it.

### How work lands: pull requests, or ship after approval

Each project picks one (Projects → "How work lands", or
`bb boat project set <id> --delivery pr|push`):

- **Draft pull requests** (default): the agent pushes its own branch and
  opens a draft pull request against the base branch. You merge it on
  GitHub.
- **Ship to the base branch after I approve:** the agent only commits, in
  its sandbox. A git hook refuses its pushes to GitHub, so nothing gets
  there until you approve. Reviews run in the task's sandbox, where the commits
  are. Then you ship:
  - **Ship** on the task's page, card or task chat header: your click is the
    approval. It shows once a finished turn left commits or changed files;
    a task that changed nothing has nothing to ship.
  - Or tell the orchestrator in its chat; it calls `boat_ship`. The plugin
    only ships from the task's own orchestrator chat, after the latest turn
    was reported there and you wrote in that chat since. An agent claiming
    you approved isn't enough.
  - The plugin rebases the commits onto the latest base branch and pushes.
    It never forces. Uncommitted changes, files the agent never added, or
    conflicts stop it before anything is pushed. Then the task closes and
    its sandbox is deleted.
  - Until it ships, the sandbox holds the only copy. Closing or cancelling
    such a task asks you to discard the work, and `bb boat sandbox delete`
    refuses. A task with nothing to ship closes like any other. boat deletes stopped sandboxes after 14 days, so after 10 days
    you get a Needs-you question.

### Reviews

**Request review** (on a task's page, in a task chat's header, or
`bb boat task review <id>`) starts an independent review in a fresh context.
With both agents it runs on the other one: **Agent for reviews** (Codex by
default), or the other agent when the task already ran on that one. With one
agent, the same agent reviews. The review reports a verdict and its
findings; send them back with a follow-up.

### Protected branches

Tasks never push to `main`, `master`, the task's base branch, the base
branch any of your projects uses for that repo, a project's protected
branches, or the branches in **Extra protected branches** (Advanced). The
plugin refuses tasks that point at one, and a git pre-push hook in every
task checkout enforces it. Pushes to a folder inside the sandbox (say, a
temporary remote your repo's own tests create) are let through: they can't
reach GitHub.

The hook is a guard for well-behaved agents, not a security boundary. For
hard enforcement, protect your base branches on GitHub.

### Previews

Agents leave a preview running when their change shows in a browser, and
report it in their report block:
`PREVIEW: port=4321 path=/settings cmd="npm run dev -- --host 0.0.0.0 --port 4321"`.

- The plugin runs `boat host <sandbox> <port> --private` and keeps the link,
  port, page and command. Private links carry a token (`?_token=…`): the
  first visit sets a cookie and opens the page, so the link works in any
  browser. Nobody without the link gets in.
- Previews show as **live**, **sleeping** (the sandbox stopped, or the
  server isn't running) or **expired** (the sandbox is gone), with the time
  left before auto-stop. The Cloud agents page lists live and sleeping
  ones; expired ones stay on their task's page.
- **Wake** resumes the sandbox, restarts the stored command, hosts the port
  again (same link) and opens it. **Extend** keeps the sandbox on 2 more
  hours (at most your plan's auto-stop cap). **Stop** stops the sandbox.
- A sandbox with a live preview whose task waits on you isn't stopped as
  idle, and it's the last one stopped to make room.
- `bb boat preview list | wake | extend | stop`, and `boat_preview` for
  orchestrators.

### Snapshots

- Start sandboxes from a saved snapshot: set it on a project, or pass
  `--snapshot <name>` to `bb boat task start` (`none` starts fresh).
- **Save as snapshot** on a finished "Check this repo runs in a sandbox"
  task, or `bb boat sandbox snapshot <id> <name>`, saves one;
  `bb boat sandbox snapshots` lists them with your plan's allowance.
- Sandboxes that run bb (task chats and cloud orchestrators) can't be
  saved: their disk holds bb's login.
- A missing snapshot, or a plan without snapshots, gets a plain message
  instead of boat's raw error.

### Environments, secrets and GitHub access

Tasks start in a **boat environment**: the repos it clones, the variables
and secret files it injects, and whether your GitHub and AI logins go in.
Empty **Boat environment** uses your boat default; a project can pick its
own.

- **Create one and add secrets** on the boat.dev dashboard, or with the boat
  CLI: `boat env new web`, then `boat env set-var web KEY` (the value comes
  from stdin, so it stays out of your shell history), and
  `boat env set-file web .env.local --from ./my.env` for files. Running
  sandboxes keep the old version until `boat env upgrade web`.
- **"Safe for third parties"** hides your agent logins and GitHub from
  sandboxes. While it's on, the setup check fails and tasks don't start;
  turn it off on boat.dev → Environment or with
  `boat env set <name> --safe-for-third-parties false`.
- **Secrets by name only.** The plugin shows an environment's secret names
  (project settings, `bb boat status`). It drops the values as soon as it
  reads `boat env info`, so it never puts them in the UI, the logs or a
  chat. Agents can still read them in their sandbox: that's what the
  environment is for.
- **Repo access.** Before a task starts, the plugin asks GitHub from inside
  the sandbox what boat's login may do with each repo. No access stops the
  task with "Connect GitHub on boat.dev → Environment and give boat access
  to this repo". Read-only access is enough for reviews, not for tasks that
  push. The last result per repo shows in the project settings and
  `bb boat status`; the setup checklist shows the newest one.
- **Expired GitHub logins.** boat gives sandboxes a GitHub token that lasts
  about 8 hours. Before a follow-up that needs GitHub (a push, a pull
  request) or a ship, the plugin checks it. An expired one is reported with
  what to do: `boat env upgrade <name>` to refresh running sandboxes, or a
  new task.

### Screenshots and recordings

A task's sandbox is deleted when the task closes, so agents upload their
screenshots and recordings before they finish. This is off by default. Turn
it on in Settings → Setup → **Screenshots and recordings**
(`evidenceUploader`):

- **Off** (empty, the default).
- **Built-in uploader** (`builtin`): the uploader that ships with the plugin
  (`assets/evidence-upload.mjs`). It has no dependencies, needs Node 20+ in
  the sandbox, and uploads to any S3-compatible bucket (Cloudflare R2, AWS
  S3, MinIO and others).
- **Your own script** (`owner/repo:path[@ref]`): fetched from GitHub with
  the bb machine's `gh` login. Pin it to a commit (`@<commit sha>`), so a
  later push to that repo can't change what runs in your sandboxes.

Every task sandbox then gets an `evidence-upload` command. Agents run
`evidence-upload <files or folders> --name <short label>`. It prints one
link per file, and they paste the links into their report (with an
`EVIDENCE:` line in the report block). `evidence-upload --link <key>` prints a
fresh link for a file already uploaded, and `--help` shows all options of
the built-in uploader.

The built-in uploader reads its configuration from environment variables.
Set them in your boat environment, never in the plugin settings:

| Variable | Needed | Meaning |
| --- | --- | --- |
| `EVIDENCE_BUCKET` | yes | Bucket name |
| `EVIDENCE_ACCESS_KEY_ID`, `EVIDENCE_SECRET_ACCESS_KEY` | yes | Keys with write access to the bucket. `EVIDENCE_R2_ACCESS_KEY_ID` / `EVIDENCE_R2_SECRET_ACCESS_KEY` and `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` work too |
| `EVIDENCE_ENDPOINT` or `CLOUDFLARE_ACCOUNT_ID` | for R2 and other S3 services | The S3 endpoint URL. With only `CLOUDFLARE_ACCOUNT_ID`, it's `https://<account id>.r2.cloudflarestorage.com`. Without either, AWS S3 (`https://s3.<region>.amazonaws.com`) |
| `EVIDENCE_REGION` | no | Default `auto` for R2, else `us-east-1` |
| `EVIDENCE_LINK_DAYS` | no | How long links work, 1–7 days (default 7) |

For example, for Cloudflare R2:

```sh
boat env set-var web EVIDENCE_BUCKET
boat env set-var web EVIDENCE_ACCESS_KEY_ID
boat env set-var web EVIDENCE_SECRET_ACCESS_KEY
boat env set-var web CLOUDFLARE_ACCOUNT_ID
bb boat config set evidenceUploader builtin
```

- Keep the bucket private. Links are presigned: anyone with a link can open
  that file until the link expires.
- The task history says which variables a sandbox is missing (names only).
  A failed install never stops a task; the agent then reports that uploads
  failed.
- When a report mentions screenshots or recordings without links, an
  orchestrator asks the agent to upload them before closing the task
  (`boat_followup` with `evidence_only`, or
  `bb boat task followup <id> --evidence-only`).
- `bb boat task show` lists every link a task's turns uploaded.

### Coding agents and usage limits

**Coding agents** is on Auto-detect by default: the plugin reads which
Claude and ChatGPT logins are connected in boat.dev for the environment new
sandboxes use. With one agent, every task and review runs on it (reviews
still run, in a fresh context), and switching agents is off. Pick by hand
(Claude and Codex, Only Claude, Only Codex) if bb's Account Pooler logs your
task chats in instead. When your choice disagrees with boat.dev, the setup
checklist warns and offers **Use Auto-detect**.

- **Don't start work on paid extra usage** (on by default): when every
  agent you have is near its usage limit, new tasks wait for a reset
  instead. The start fails with `agents_at_limit`, and you're told. Chats
  already running carry on.

With both agents:

- New tasks start on **Agent for tasks** (Claude Code by default), and
  reviews run on **Agent for reviews** (Codex), so each change gets a
  second opinion from the other model.
- **When an agent hits its limit mid-task, continue with the other one** (on
  by default): the task carries on with the other agent in the same
  sandbox. A follow-up also goes to the other agent when the task's agent
  is at or above **Switch at** (90% by default) and the other has room; a
  review does when the agent picked for it is. The task history says so, for example "Claude is at 95% of its
  limit; continued with Codex". This never happens when you or an
  orchestrator asked for a specific agent (by name, a model, or an effort
  level only one agent has), and steers stay with the running agent.
- **Claude ↔ Codex switching for orchestrators** (off by default) moves an
  orchestrator to the other agent near a limit. See
  [docs/orchestrators.md](docs/orchestrators.md#claude--codex-switching).

Usage readings come from bb's Provider usage (the Account Pooler for the
agents it routes, else the Claude Code and Codex providers). Reading them
costs no tokens. When any chat on this bb fails on a usage limit, that agent
counts as full until the limit resets. `bb boat relay status` shows each
agent's usage.

### Model presets

A task can run with a model preset: Light, Review, Build, Deep or Frontier
(`--tier` on the command line). The preset picks the model and effort for
the task's agent, and the plugin records preset, model, effort and the
reason on the task. Orchestrators always pick one. Edit the table in
Settings → Models when model ids change:

| Preset | Claude | Codex | Use for |
| --- | --- | --- | --- |
| Light | claude-sonnet-5-5 · high | gpt-6.1-sol · medium | Mechanical or exactly specified work |
| Review | claude-opus-5-5 · high | gpt-6.1-sol · high | Reviews and audits; small fixes with a known cause |
| Build | claude-opus-5-5 · xhigh | gpt-6.1-sol · xhigh | Normal implementation and debugging |
| Deep | claude-opus-5-5 · ultracode | gpt-6.1-sol · ultra | Parallel exploration plus independent checking |
| Frontier | claude-fable-5-1 · xhigh | gpt-6-astra · xhigh | Only after Deep fell short |

- Without a preset, tasks use **Model for tasks** and reviews **Model for
  reviews** (Settings → Models); empty means the Build and Review presets.
- Tasks in boat can't use Ultracode or Ultra, so there Deep runs at max and
  the brief asks Claude to use helper agents.
- Model ids are bb's (`claude-opus-5-5`); tasks in boat get boat's
  (`opus-5-5`).
- Frontier at max, Ultracode or Ultra is refused unless you approved it
  (`--user-approved`).
- A follow-up keeps the task's preset.

### Commands

Everything is available as `bb boat …`, from any chat or terminal. Every
command has `--help`, and `--json` gives machine-readable output.

| Command | Purpose |
| --- | --- |
| `bb boat doctor` | Check the setup, with a fix for each problem; never starts a sandbox |
| `bb boat status` | Setup summary, plan limits, sandboxes, open tasks, repo access |
| `bb boat task start --test` | Start the test task: no repo, changes nothing |
| `bb boat task start --title … --brief …` | Start a task (`--repo`, `--project`, `--agent`, `--tier`, `--snapshot`, `--sandbox`, `--type` …) |
| `bb boat task review <id>` | Independent review of a task's work |
| `bb boat task followup <id> --message …` | Next turn (`--agent` switches agent, `--tier` changes preset, `--steer` redirects a running turn) |
| `bb boat task show \| transcript \| list \| interrupt \| close` | Inspect and finish tasks |
| `bb boat task ship <id>` | Ship approved work (projects that ship after approval) |
| `bb boat task ready <id> --note …` | Put a task under Ready to review (what `boat_ready` does, for chats without tools) |
| `bb boat decision add \| list \| resolve` | Decisions only you can make, under Needs you (`boat_needs_you`, `boat_resolve`) |
| `bb boat task wait <id>…` | Block until tasks stop running; a last resort: ending the turn is better, the chat is told when a turn ends |
| `bb boat preview list \| wake \| extend \| stop` | Previews |
| `bb boat sandbox list \| new \| info \| stop \| resume \| delete \| exec` | Sandboxes |
| `bb boat sandbox snapshot \| snapshots` | Snapshots |
| `bb boat project list [--local] \| add \| set \| remove` | Projects (`--protected-branches`, `--instructions`, `--delivery`, `--workers` …) |
| `bb boat config get [key] \| set <key> <value> \| reset <key>` | Every setting, wherever it's shown |
| `bb boat config export \| import` | Back up and restore settings, projects, model presets and protocol |
| `bb boat orchestrator new \| on \| off \| list` | Orchestrators ([docs/orchestrators.md](docs/orchestrators.md)) |
| `bb boat protocol show \| path` | The orchestrator protocol |
| `bb boat relay status \| check \| switch` | Agent usage and Claude ↔ Codex switching |

Orchestrators get the same as agent tools (`boat_dispatch`, `boat_review`,
`boat_followup`, `boat_tasks`, `boat_ship` and others). The `boat` and
`boat-orchestrator` skills teach agents how to use them.

## Settings

Settings → Plugins → Boat Cloud Agents. bb's settings list there has the
everyday choices; the plugin's own sections below it have the rest.
`bb boat config get` lists every setting with its value, and
`bb boat config set <key> <value>` / `bb boat config reset <key>` change
any of them. (`bb plugin config boat set` only reaches bb's list.)

**bb's settings list**

| Setting | Key | Default | What it does |
| --- | --- | --- | --- |
| Coding agents | `agents` | `auto` | Auto-detect (`auto`) from boat.dev, or Claude and Codex (`both`), Only Claude (`claude`), Only Codex (`codex`). With one agent, every task and review runs on it |
| How tasks run | `workers` | `boat` | In boat (`boat`), As chats for projects (`projects`) or As chats everywhere (`all`). Chats need bb Connect |
| Boat environment | `environment` | empty | The boat environment new sandboxes start from; empty is your boat default. A project can pick its own |
| Default sandbox size | `machineType` | `default` | `small` (2 vCPU, 4 GB), `default` (4 vCPU, 8 GB), `large` (8 vCPU, 16 GB), `xlarge` (16 vCPU, 32 GB). You can pick another per task |
| Sandboxes at once | `maxActiveSandboxes` | `3` | The most sandboxes running at the same time; 0 is your plan's limit |
| Agent for tasks | `implementProvider` | `claude` | For tasks that don't name an agent. With one agent connected, it runs everything |
| Agent for reviews | `reviewProvider` | `codex` | When a task already ran on this agent, its review uses the other one. With one agent connected, it reviews too |
| Stop idle sandboxes after (min) | `stopIdleAfterMinutes` | `30` | Stops a task's sandbox once its agent has waited this long; 0 is never |
| Notify my devices | `pushNotifications` | off | A notice when a task finishes a turn. Notices about agent switches and usage limits always go out |
| Instructions for every task | `workerInstructions` | empty | Added to every task's brief: house rules, test commands, commit style. Don't put credentials here |

**The plugin's own sections**, in this order:

1. **Setup:** the same checklist as on the Cloud agents page, plus
   **Screenshots and recordings**, and **boat CLI location** when the boat
   CLI isn't found.
2. **Projects:** your projects, with their repos, environment, protected
   branches, instructions and GitHub access.
3. **Usage limits:** what happens near a usage limit. The rows that need
   both agents are greyed out with one.
4. **Models:** the model presets, and models for tasks without one.
5. **Orchestrators (optional):** the sidebar, the size of chats on a Boat
   sandbox, full access for cloud orchestrators, and the orchestrator
   protocol.
6. **Advanced** (collapsed).
7. **Back up and restore.**

| Section | Setting | Key | Default |
| --- | --- | --- | --- |
| Setup | Screenshots and recordings | `evidenceUploader` | empty (off) |
| Usage limits | When an agent hits its limit mid-task, continue with the other one | `autoFailover` | on |
| Usage limits | Don't start work on paid extra usage | `avoidExtraUsage` | on |
| Usage limits | Claude ↔ Codex switching for orchestrators | `relayEnabled` | off |
| Usage limits | Main agent for orchestrators | `relayPreferred` | `claude` |
| Usage limits | Switch at (% of a usage limit) | `relaySwitchAt` | `90` |
| Usage limits | Switch back below (%) | `relaySwitchBackBelow` | `50` (at least 5 below Switch at) |
| Usage limits | Wait before switching back (min) | `relayQuietMinutes` | `10` |
| Models | Model for tasks | `implementModel` | empty (the Build preset's model) |
| Models | Model for reviews | `reviewModel` | empty (the Review preset's model) |
| Models | Effort | `reasoningEffort` | `default` (boat's) |
| Orchestrators | Orchestrators in the sidebar | `sidebarLayout` | `sections` |
| Orchestrators | Size for chats on a Boat sandbox | `orchestratorMachineType` | `small` |
| Orchestrators | Full access for cloud orchestrators | `cloudOrchestratorFullAccess` | on |
| Advanced | Hard stop after (hours) | `sandboxTtlHours` | `2` |
| Advanced | Make room at your sandbox limit | `freeSlotsWhenFull` | on |
| Advanced | Delete sandboxes when tasks close | `deleteSandboxOnClose` | on (sandboxes with unshipped work are kept) |
| Advanced | Where reviews run | `reviewSandbox` | `auto` (a new sandbox if there's room); `new`, `same` |
| Advanced | Extra protected branches | `extraProtectedBranches` | empty |
| Advanced | boat CLI location | `boatPath` | empty (finds `~/.ascii/bin/boat`, then `PATH`) |

Each row in the plugin's settings has a short description. For example:

```sh
bb boat config set relaySwitchAt 85
bb boat config set cloudOrchestratorFullAccess false
bb boat config reset relaySwitchAt
```

## Back up and restore

Export your setup to a JSON file, and import it on another bb or after a
reinstall:

```sh
bb boat config export --output boat-config.json
bb boat config import boat-config.json --dry-run   # show what would change
bb boat config import boat-config.json
```

![Back up and restore: an import shows what it would change before anything is written](docs/screenshots/backup.png)

- The file holds every setting (bb's list and the plugin's own), your
  projects, your model presets and your custom orchestrator protocol. It
  holds no tasks, sandboxes, chats or secrets.
- Import merges: it adds and updates projects and keeps the others. It
  applies the file, then prints what changed (settings old → new, projects
  added, updated or removed, presets, protocol). Run it with `--dry-run`
  first to see the changes without applying them. Setting keys it doesn't
  know are reported and skipped; a file with an invalid value or project is
  refused as a whole, in a dry run too.
- `--replace-projects` also removes projects that aren't in the file. It
  refuses to remove a project with open tasks or a running orchestrator.
- Settings → **Back up and restore** does the same: Export downloads the
  file; Import shows the changes, then Apply.
- Your instructions and project names are in the file, so keep it private
  if they are.

### Moving from an older version

Older versions kept every setting in bb's settings list. This version keeps
only the everyday ones there, and the rest (usage limits, models, the
orchestrator settings, screenshots and recordings, Advanced) in the plugin's
own storage. The moved values don't carry over on their own, so take a
backup first:

1. On the old version: `bb boat config export --output boat-config.json`.
2. Update the plugin.
3. `bb boat config import boat-config.json --dry-run`, check the summary,
   then run it without `--dry-run`.

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

Already updated without a backup? Set the moved values again in the
plugin's settings sections or with `bb boat config set`.

## Go further: orchestrators

An orchestrator is a chat that plans and coordinates tasks for one project.
You tell it the goal; it splits the work into tasks, starts them, gets each
change reviewed (by the other agent, when you have both), and brings you
only decisions and finished results. It never writes code itself.

Use one for a goal that keeps producing tasks. For one fix that fits in one
task, a single task is quicker and cheaper.

[docs/orchestrators.md](docs/orchestrators.md) covers when to use one,
starting one (**New orchestrator…**, or **Coordinate from this chat…** in a
chat's menu), cloud orchestrators and full access, Claude ↔ Codex
switching, and the orchestrator protocol.

## Trust and data

**What it runs.** The plugin runs inside bb's server, with your rights, like
any bb plugin. On the bb machine it runs:

- the `boat` CLI, with your login. The setup checks only read (`boat
  status`, `limits`, `env list`, `ai profiles`) and are cached for about a
  minute;
- `gh` (read-only): `gh auth status` for the setup check, and fetching
  project rules files and your own uploader script;
- `git` in your local bb project folders: it reads branches, asks GitHub for
  a branch's latest commit (`git ls-remote`, and `git fetch` of that one
  branch when your checkout is behind) with your git credentials, and
  pushes a branch only when you click "Push branch first";
- a terminal in bb, only when you click **Sign in…** or **Run in terminal**
  on the setup checklist: it opens a shell on the bb machine and types that
  fix's command (`boat onboard`, for example), and nothing else.

In a chat, **Send to a cloud agent** puts one line in front of your draft
(asking the chat to use a cloud agent) and sends it, only when you pick it.

In sandboxes it runs the agents, git, your project's setup and, if you turn
it on, the evidence uploader.

**What it can reach.**

- Your boat account: it creates, stops and deletes sandboxes, which cost
  money on your plan. It checks your setup before it creates one, so a
  broken setup doesn't use up starts.
- Whatever your boat environment gives tasks: GitHub access (agents push
  branches and open pull requests; Ship pushes to the base branch), AI
  logins, variables and secret files.
- Task chats, chats on a Boat sandbox and cloud orchestrators run bb's
  daemon in their sandbox, with bb machine credentials, connected through
  bb Connect. Task chats are opt-in. New orchestrators run in such a
  sandbox by default once bb Connect is set up (pick This computer, or
  `--local`, to keep them here), and with full access unless you turn
  **Full access for cloud orchestrators** off. An agent that a hostile repo
  talks into misbehaving could use those credentials. Keep tasks in boat for
  repos you don't trust.
- Other bb plugins on this bb, when installed: usage readings (Account
  Pooler, the Claude Code and Codex providers), Push notifications, and bb
  Connect's status (to know whether sandboxes can reach this bb).

**What it stores.**

- Tasks, events, reports, decisions, previews and projects in the plugin's
  SQLite database in bb's data folder (by default `~/.bb/plugins/boat/`),
  plus your custom protocol (`orchestrator-protocol.md`) next to it. The
  database keeps private preview links with their token, and agents'
  reports with their presigned evidence links.
- The everyday settings in bb's settings; the plugin's own settings, your
  model presets and the switching state (including orchestrators' handoff
  notes) in bb's plugin storage; each orchestrator's role and project on
  its thread. None of the settings are secret. The plugin stores no
  passwords or API keys.
- Environment secrets show by name only: the plugin never puts their values
  in the UI, the logs or a chat (agents can read them in their sandbox).
- The plugin runs no cloud service of its own; in the cloud there are only
  your sandboxes.

**Links that carry access.** Private preview links (`?_token=…`) work for
anyone who has them, as long as the sandbox exists. Evidence links are
presigned and work for up to 7 days. Both are posted into chats, so they
reach your model provider and anyone who can read those chats.

To report a security problem, see [SECURITY.md](SECURITY.md).

## Development

```sh
git clone https://github.com/scheinriese/bb-plugin-boat.git
cd bb-plugin-boat
npm ci
npm run typecheck
npm test                          # node --test; no network, uses a fake boat CLI
bb plugin install "$(pwd)"        # path install
bb plugin dev                     # rebuild and reload on save
```

Layout: `server.ts` wires everything. `src/boat.ts` runs the boat CLI and
`src/boat-api.ts` types its JSON. `src/setup.ts` holds the setup checks
(`bb boat doctor`, the checklist, the checks before a sandbox).
`src/service.ts` owns tasks, capacity, dispatch and the monitor.
`src/settings.ts` declares both kinds of settings, `src/settings-store.ts`
merges them, and `src/config.ts` backs them up. `src/cli.ts`, `src/tools.ts`
and `src/rpc.ts` are the CLI, agent tools and UI RPC. `src/machine.ts` is
the Boat sandbox machine provider. `app.tsx` and `web/` are the UI
(`web/entry-points.tsx` adds the send menu, side panel and header actions).
`skills/` teach agents, and `assets/evidence-upload.mjs` is the built-in
uploader.

## License

MIT, see [LICENSE](LICENSE). The bundled UI components come from bb's
component registry and shadcn/ui, both MIT; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
