# Changelog

## Unreleased

- Wake Boat sandboxes gently: at most 2 a minute account-wide, with a doubling pause after a failed wake, on every path that resumes one.
- Turn off Ubuntu's login message scripts over boat's exec API before bb's SSH setup; one could hang on a file not restored yet, so SSH sessions never started.
- Tell why a sandbox didn't wake (boat.dev still restoring its disk, a refused restore, a stuck SSH session, SSH unreachable) on bb's machine card and the sandbox's tasks. Retry later by itself (2 to 16 minutes), and after 5 failures put it under Needs you.
- Back off stopping and deleting a sandbox after boat.dev fails one.
- Move a sandbox off a boat.dev node that keeps failing its disk, once the plugin itself has seen the same failure for over 15 minutes. It checks first with a test fork, then makes a plain stop, and forces it only if boat refuses it. All this happens on its own only when no chat or task there is busy and no git checkout has unpushed, uncommitted or stashed work. Otherwise it goes under Needs you, with the commands and the last snapshot's time.
- Recognise bb's daemon broken by an auto-update (an npm zombie, its unit stuck stopping, a module it can't load) and put the repair by hand under Needs you.
- With automatic paid Claude fallback on, continue Claude chats that stopped at a usage limit once paid Claude is available: a pending provider retry is sent now, a skipped one is retried. Any Claude Code chat on this bb; headless tasks only with the headless opt-in.
- One automatic resume per stopped turn, at most ten per pass and three seconds apart. Nothing is continued on a stale, rejected or held reading, or after an auth, credit or spend-limit failure.
- New setting, Resume chats stopped at a limit when paid Claude is available (on by default, only with the fallback on), and a per-project Never continue on paid Claude (`bb boat project set <id> --paid-claude never`).
- Tasks record the resume, orchestrators hear once per pass which workers continued, and the usage view counts the chats resumed in the last day.
- Pace resumes so they can't become a burst of wakes: failed attempts count toward the ten per check and wait their turn, a failure ends the check and backs off (5 minutes, doubling to an hour), machines that are starting, stopping or failed are left alone, and waking one takes one of two wakes a minute, shared with the watchdog.
- Leave a chat alone when provider-retry or bb's queue answers in a shape this version doesn't know, instead of retrying on a guess.
- The paid resume's and the watchdog's wakes also wait while the sandbox wake pacer has no slot free, so together they never wake more than 2 sandboxes a minute.
- A machine that failed to start long ago is skipped on its own instead of holding every wake; only a failure of a wake the plugin made holds them, found by looking again at each machine it woke in the last 15 minutes, on every check. The watchdog's resumes share the wakes and wait out the hold, but a machine whose watchdog resume keeps failing never holds the others; its notice says when it's tried again. A chat's try cut off by a restart may go again after ten minutes, only while the request it tried is still the failed one.
- Read bb's own files (its data dir and nvm node) right after a wake, before bb starts, so boat.dev restores them first; bounded to 60 seconds and 1.5 GiB.
- Update bb on a resumed sandbox safely when it's older than the server or its install is broken: the build bb already downloaded there goes into a fresh folder, is checked and swapped in; on any failure bb starts again and the note says what became of the old one, with a backoff. bb's own in-place update is never stopped half way: Boat waits for it (up to 3 minutes). A hung one isn't fought: a zombie `npm install` goes to the daemon repair under Needs you, and one waiting on the disk to Boat's wake retries.
- Spread usage-limit reset retries that would wake a Boat sandbox to one machine every 30 seconds. On bb 0.49, decline provider retry's consent question for Boat's own chats and resume each stopped turn once itself.
- Open task chats on a sandbox in any bb project, not only Personal: before the chat opens, add the sandbox's checkout to the project as a source (never asking for the default), or reuse the project's source on that sandbox. If bb refuses, open the chat in Personal, still under its orchestrator, and say why on the task.
- Remove the sources the plugin added once no open task is on their sandbox (a review in the same workspace counts) or their machine goes, and on a sweep after a restart. Reopening a task adds its source back. Sources it didn't add, like your own computer's, and a project's last source are never deleted.
- New `bb boat sandbox wake <sandbox, task or chat id>` (the `boat_wake` tool, and the `boat-sandbox-wake` skill) brings a stuck sandbox and its chat back in one go: a paced resume within the start limit, a look at the disk, SSH login and bb there, a stop and a start for a disk that's unreadable or stuck (boat.dev's fix; forced only when nothing could be lost), login scripts off, bb's safe update, bb's service and machine back, and the chat's retry. `--dry-run` only prints the plan, `--json` the report, `--status` a running or last wake; a paid extra start needs `--allow-paid-start`. A read waiting on the disk is waited for first; a force needs a test fork that reads the snapshot fine; nothing is stopped under a running turn, or without time left to start it again. One wake per sandbox at a time, at most 25 minutes; the command waits 90 seconds, then the asking chat hears when it's done. It ends with Needs you and the commands when it stops for safety. The orchestrator protocol tells orchestrators to use it instead of repairing a machine by hand.

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
