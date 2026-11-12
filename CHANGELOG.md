# Changelog

## 0.2.6

- Show manually created coordinating bb chats and their native child-thread activity in Today and the compact Home summary.
- Keep nested delegations together and avoid repeating Boat-managed tasks; preserve the chats' existing instructions and execution setup.

## 0.2.5

- Distinguish an agent failure from a stopped sandbox in the composer banner and offer a follow-up instead of an unrelated VM resume.
- Refresh sandbox power from bb’s host state; show unavailable or transitional states instead of assuming the sandbox is on.
- Preserve guarded memory recovery and keep historical task chats from inheriting another chat’s recovery banner.

## 0.2.4

- Keep task activity and status metadata on the current chat after a handover, so stopped or older chats do not inherit a newer chat’s spinner.
- Keep idle task rows quiet and show a static pause icon while waiting for a usage reset.

## 0.2.3

- Keep long Home questions, task names and action labels inside their rows, with an ellipsis and full details available on opening.
- Prefer authored short decision labels and keep the usage summary clear of the heading on narrow screens.

## 0.2.2

- Keep the Today, Sandboxes and Projects tabs aligned across page switches and while opening the project editor.
- Use a shared page width and consistent tab label weight so selecting a tab does not move its neighbours.

## 0.2.1

- Allow installation on bb 0.49.0; remove the unnecessary bb minor-version ceiling while retaining the SDK compatibility range.
- Check both bb 0.48.1 and 0.49.0 builds and their SDK versions in CI, plus a weekly check against the latest bb and SDK.

## 0.2.0

- Today, Sandboxes and Projects with live decisions, event history and usage.
- Native composer starters, sandbox size, snapshot and reviewer choices.
- Decision options with recommendations and Undo; nested independent reviews.
- Task panels: Overview, Reviews, Transcript and Sandbox, with measured memory.
- In-thread Merge and Ship confirmations bound to fresh source facts.
- Durable reset waits and per-request paid-start approval, including named-agent admission checks.
- Project rules, local project pairing and explicit snapshot replacement.
- Grouped settings with a two-load migration that preserves existing values.
- Optional integration with the separate Workbench sidebar.

Before updating from 0.1.x, export a private settings backup. Reload Boat once
more after updating to finish the grouped settings migration. Automated checks
use offline fixtures; they do not claim a real paid sandbox run.
