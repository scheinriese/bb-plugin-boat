## Follow cloud work from bb

Start Claude Code or Codex in a boat.dev sandbox from an existing chat or
bb’s native composer. Today puts decisions and ready changes first; task
chats keep their review history, transcript, preview and sandbox facts together.

- Structured options with recommendations and Undo.
- Independent reviews, with a reviewer per task or project.
- Pull requests or shipping to the base branch after an in-thread confirmation.
- Durable reset waits and explicit approval for potential paid extra usage.
- Project rules, snapshots, measured memory and sandbox usage.
- Optional Workbench sidebar for nested work trees and queued requests.

## Requirements and costs

Requires bb 0.48.1, a boat.dev plan, a connected agent subscription or API key,
and GitHub access for repository work. bb Connect is required for native Boat
sandbox chats and task chats. Sandbox time and agent usage are billed by
those services; the plugin adds no service charge. Current plans: https://boat.dev.

## Trust and setup

This is full-trust plugin code. It runs the Boat CLI with your login and lets
agents work with the access and secrets supplied by your Boat environment.
Plugin-prepared delegated checkouts guard protected branches; native checkouts
and machine lifecycle stay with bb. Read the security policy before installing.

Run `bb boat doctor` for read-only setup checks. A test task uses a real sandbox
and agent usage. Existing users should export a private settings backup and
reload once more after upgrading to finish the grouped-settings migration.

Source and guide: https://github.com/scheinriese/bb-plugin-boat.
Optional companion: https://github.com/scheinriese/bb-plugin-workbench-sidebar.
