## What you get

Ask any bb chat to use a cloud agent, and Claude Code or Codex takes the
task in its own boat.dev sandbox. The agent works on its own branch and
opens a draft pull request, and the chat that asked hears back when it's
done. A Cloud agents page in the sidebar shows every task with its
transcript, report, pull request and preview link.

- **Start from anywhere:** any chat (the `boat` skill teaches it
  `bb boat task start`), New task on the Cloud agents page, **Send to a
  cloud agent** in the send menu, or a whole chat on a Boat sandbox.
- **A setup check** on the page and in `bb boat doctor` reads your boat
  sign-in, plan and agent logins before anything starts, and a test task
  proves it all works.
- **Reviews by the other model** (with both agents): Codex reviews
  Claude's work and the other way round.
- **Draft pull requests**, or work that ships to the base branch only after
  you approve it, plus private preview links served from the sandbox.
- **Protected branches:** tasks never push to main, master, a project's
  base branch or branches you add.
- **Usage limits:** with both agents, a task that hits its agent's limit
  continues on the other one; new work waits instead of starting on paid
  extra usage.
- **Screenshots and recordings** (optional), uploaded to your own
  S3-compatible bucket before a sandbox is deleted.

## Orchestrators (optional)

For a goal that keeps producing tasks, an orchestrator, a chat that plans
and coordinates tasks for one project, starts the tasks (`boat_dispatch`),
gets each change reviewed and brings you only decisions and finished
results. It can run in its own sandbox and switch between Claude and Codex
near a usage limit.

## Getting started

1. Install boat: `curl -fsSL https://boat.dev/install | sh`. It signs you in
   and starts a plan. When it asks who the sandboxes are for, answer "just
   me".
2. Connect Claude or ChatGPT on boat.dev → Agents, and GitHub on boat.dev →
   Environment.
3. Open Cloud agents in the sidebar (or run `bb boat doctor`), then Run a
   test task.

## Requirements and costs

- bb 0.48 or later, on macOS or Linux (the boat CLI runs on those).
- A boat.dev account and plan (https://boat.dev): a 7-day trial with a
  card, then from $20 a month. Each task uses sandbox time on your plan
  (Small at half rate, Large at double; a stopped sandbox uses none).
- A Claude or ChatGPT subscription, or both, connected in boat.dev. Tasks
  use its usage limits.
- GitHub connected on boat.dev, with access to your repos.
- bb Connect, only for task chats, chats on a Boat sandbox and cloud
  orchestrators.

The plugin runs at most 3 sandboxes at once unless you raise it, and never
turns on boat's paid extra starts. It is a community plugin, not affiliated
with boat.dev.

## Trust and data

- Full-trust code inside bb's server. It runs the boat CLI with your login,
  creates and deletes sandboxes that cost money, and lets agents push
  branches and open pull requests. A git hook guards protected branches; it
  is not a security boundary. It opens a terminal only when you click Sign
  in… or Run in terminal, and types that one command.
- Agents run every command without asking, inside their sandbox, with what
  your boat environment gives them: GitHub access, your agent login,
  variables and secret files. Keep secrets out of environments you use for
  repos you don't trust.
- Tasks run headless in boat by default. Task chats and cloud orchestrators
  run bb in their sandbox with this bb machine's credentials; cloud
  orchestrators get full access unless you turn it off.
- Its database on the bb machine keeps tasks, reports and projects,
  including private preview links (with their token) and presigned evidence
  links, which are also posted into chats. It stores no passwords or API
  keys, and shows environment secrets by name only.
