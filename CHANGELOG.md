# Changelog

## Unreleased

- Wake Boat sandboxes gently: at most 2 a minute account-wide, with a doubling pause after a failed wake, on every path that resumes one.
- Turn off Ubuntu's login message scripts over boat's exec API before bb's SSH setup; one could hang on a file not restored yet, so SSH sessions never started.
- Tell why a sandbox didn't wake (boat.dev still restoring its disk, a refused restore, a stuck SSH session, SSH unreachable) on bb's machine card and the sandbox's tasks. Retry later by itself (2 to 16 minutes), and after 5 failures put it under Needs you.
- Back off stopping and deleting a sandbox after boat.dev fails one.
- Move a sandbox off a boat.dev node that keeps failing its disk, once the plugin itself has seen the same failure for over 15 minutes. It checks first with a test fork, then makes a plain stop, and forces it only if boat refuses it. All this happens on its own only when no chat or task there is busy and no git checkout has unpushed, uncommitted or stashed work. Otherwise it goes under Needs you, with the commands and the last snapshot's time.
- Recognise bb's daemon broken by an auto-update (an npm zombie, its unit stuck stopping, a module it can't load) and put the repair by hand under Needs you.

## 0.2.8

- Recover transient npm dependency fetch failures while installing bb on a Boat sandbox: up to three attempts on the same allocation, with 30s/60s backoff, cancellation and the original setup deadline.
- Report exhausted installation retries as `bootstrap_retryable`, with no agent turn started and normal failed-dispatch cleanup.
- Leave authentication, integrity, permissions and post-install failures unchanged. This recovery does not freeze bb core's dependency graph; reproducible bb artifacts remain an upstream packaging concern.

## 0.2.7

- Retry a task chat's turn once when the provider answers Bad Request right after a steer, repeating the steer, and show it as Retrying instead of Agent stopped.
- Recover any other chat the same way, behind a new setting, Recover any chat after a steer Bad Request (on by default); on Codex, resume a goal the failure blocked.
- Send these as a new turn or not at all, so they don't run after newer messages or a stop. One exception: if bb won't remove one that it grouped with newer messages, those go out after at most two minutes, and the stale message once with them.

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
