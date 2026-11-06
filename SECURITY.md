# Security

## Reporting a problem

Please report security problems privately, through GitHub's private
vulnerability reporting:
https://github.com/scheinriese/bb-plugin-boat/security/advisories/new

Don't open a public issue for them. Include what you found, how to reproduce
it, and which version you used (`bb plugin source boat` shows it).

Fixes go into the latest release. Older 0.x releases don't get patches.

## Trust model

Workers (the coding agents in boat sandboxes) act on their own inside a
disposable sandbox. They install what they need and run what they decide
to; the plugin doesn't limit that. The boundary is what that sandbox can
reach (its boat environment's logins, variables and secret files), the
independent review, and your **Ship** approval. Every brief tells workers
that what they read is data, not instructions, and where their data may go.

What the plugin can't protect against:

- Prompt injection from content a worker reads: web pages, issues and
  comments by others, dependency files, command output.
- A compromised package or install script.
- A worker leaking anything its environment holds: variables, secret
  files, the sandbox's GitHub token while it lasts (about 8 hours), AI
  logins.
- Branches and pull requests on any repo boat's GitHub app can reach.
  Choose the app's repository access deliberately: all repositories is
  convenient; selected repositories limits the reach and costs one GitHub
  step per new repo.
- With boat credentials passed in (the boat CLI's login, for your whole
  account), starting, stopping or deleting any of your sandboxes.

What we recommend:

- Turn boat credentials off: `boat env set <env> --boat-credentials false`.
  The plugin doesn't need them in a sandbox: it runs boat on the bb
  machine, and task chats and cloud orchestrators reach it through bb
  Connect. If workers in an environment really need boat, give them a
  scoped key instead (`boat api-key create --env <env id> --actions <only
  what's needed> --ttl <short>`), stored as a secret variable of that
  environment. The setup check warns while an environment your workers use
  passes boat credentials.
- Put publish and deploy secrets only in the environments that need them,
  scoped to one bucket or service.
- On GitHub, add a ruleset on your base branches that blocks force pushes
  and deletion. Requiring pull requests on a base branch blocks **Ship** in
  projects that ship after approval.

An option, at a cost: without boat's AI proxy, workers can read your real
Claude and ChatGPT keys. The proxy (`boat ai proxy on`) passes placeholders
instead, so real keys never enter a sandbox. It's a paid boat add-on;
`boat ai proxy` shows the price. A project's settings note when real keys
go in.

## What the plugin can reach

bb plugins are full-trust code: this one runs inside bb's server with the
rights of the user who runs bb. In particular, it uses:

- **Your boat CLI login** on the bb machine. It creates, stops, resumes and
  deletes boat.dev sandboxes (which cost money on your boat plan), moves
  them to another size when you ask (or an agent, within limits; a larger
  size costs more per hour), runs commands in them, and hosts preview
  links from them. The setup checks only read (`boat status`,
  `boat limits`, `boat env list`, `boat ai profiles`) and are cached for
  about a minute. A project's access line reads `boat env info` and
  `boat ai proxy` (without on or off, it only shows). The plugin checks
  your setup before it creates a sandbox, so a broken setup doesn't use up
  starts.
- **Your `gh` login** on the bb machine, read-only: `gh auth status` for the
  setup check, a project's rules file and, if you configure one, your own
  evidence uploader script.
- **git** in your local bb project folders: it reads remotes and branches,
  asks GitHub for a branch's latest commit (`git ls-remote`, and `git fetch`
  of that one branch when the checkout is behind) with your git credentials,
  and pushes a branch only when you click "Push branch first" in the New
  orchestrator dialog.
- **A terminal in bb**, only when you click **Sign in…** or **Run in
  terminal** on the setup checklist: it opens a shell on the bb machine and
  types that fix's command (`boat onboard`, for example), and nothing else.
- **Your chat drafts**, only when you pick **Send to a cloud agent** in the
  send menu: it puts one line in front of the draft (asking the chat to use
  a cloud agent) and sends it. **Start as a cloud task** turns the draft
  into a task's brief.
- **Cloud sandboxes.** The plugin runs the agents, git, your project's setup
  and, if you turn it on, the evidence uploader there. It also checks the
  sandbox's size and memory: it reads `/proc` and the kernel log's
  out-of-memory lines (through `sudo -n` when the log needs it), and during
  a repo check a small script records the peak memory in `/tmp`. Tasks get
  the GitHub access, AI logins, variables and secret files of the boat
  environment you pick (and boat credentials, if it passes them), and their
  agents can read them. Tasks push branches
  and open pull requests, and **Ship** pushes approved commits to the base
  branch, only on your click or your message in the orchestrator's chat. A
  git hook stops pushes to protected branches (pushes to a folder inside
  the sandbox, like a test's temporary remote, pass), but it is a guard for
  well-behaved agents, not a security boundary. Protect your base branches
  on GitHub.
- **bb machine credentials** in the sandboxes of task chats, chats on a
  Boat sandbox and cloud orchestrators. Those sandboxes run bb's daemon,
  connected to your bb through bb Connect. Task chats are opt-in: How tasks
  run and your projects' **Run tasks as chats** decide per repo. You can
  also make a single task a chat: **Run as a chat** in New task, or
  **Continue as a chat** on a headless task's page, which installs bb into
  the task's existing sandbox (where other tasks may have run before) and
  writes its conversation to `~/.boat-tasks` there. For repos the rules
  don't run as chats, both warn and need your confirm, and agents' `bb boat
  task start --chat` and `bb boat task continue-as-chat` are refused. That
  confirm is a step in the UI, not a security boundary: any bb client can
  send it through the plugin's RPC, including an agent that already has bb
  access (a task chat, or a cloud orchestrator). A sandbox that runs bb, or
  had it installed, takes no repo the rules don't trust, headless or not.
  New orchestrators run in such a sandbox by default once bb Connect is set
  up (`--local` or "This computer" keeps them on the bb machine), and with
  full access in their sandbox unless you turn off **Full access for cloud
  orchestrators** (`cloudOrchestratorFullAccess`). An agent that a hostile
  repo talks into misbehaving could use those credentials. Keep **How tasks
  run** on **In boat** (the default) for repos you don't trust, and don't
  confirm the warning for them. That keeps them away from bb's credentials
  as long as no agent with bb access works for them; it isn't enough on its
  own once one does.
- **Other bb plugins**, through bb: usage readings (Account Pooler, the
  Claude Code and Codex providers), Push notifications and bb Connect's
  status, when installed.

## What it stores

- Tasks, reports, decisions, previews and projects in the plugin's SQLite
  database in bb's data folder (by default `~/.bb/plugins/boat/data.db`), plus
  the shared orchestrator protocol in `orchestrator-protocol.md` next to it.
- The everyday settings in bb's settings list; the plugin's own settings,
  your model presets, page state (a hidden orchestrator card) and the
  Claude ↔ Codex switching state (including orchestrators' handoff notes)
  in bb's plugin storage; each orchestrator's role and project on its
  thread. None of the settings are secret.
- No passwords or API keys. Environment secrets show by name only; the
  plugin drops their values as soon as it reads them, so they never reach
  the UI, the logs or a chat (agents can read them in their sandbox).
- No cloud service of its own: in the cloud there are only your sandboxes.
- Two kinds of links carry access on purpose, and the database keeps them:
  private preview links (`?_token=…`, they work as long as the sandbox
  exists) and evidence links in agents' reports (presigned, valid for up to
  7 days). They are posted into chats, so they reach your model provider and
  anyone who can read those chats.
