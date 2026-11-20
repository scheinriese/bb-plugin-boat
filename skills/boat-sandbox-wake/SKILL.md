---
name: boat-sandbox-wake
description: "Bring a stuck boat.dev sandbox and its chat back with one command, `bb boat sandbox wake <id>` (the `boat_wake` tool for orchestrators). Use when the user says \"wake this machine\", or a chat or task is stuck on \"Machine is paused\" or \"resuming\", or a boat.dev sandbox chat doesn't come back after a stop. Don't repair the sandbox by hand."
---

# Waking a stuck sandbox

When a chat or task on a boat.dev sandbox is stuck on **Machine is paused** or
**resuming**, or the user says "wake this machine", run:

```sh
bb boat sandbox wake <id>
```

The id can be the sandbox (`bx_…`), the task (`t_…`) or the chat's thread
id; a chat is followed to its workspace, its bb machine and its sandbox.
Orchestrators use the `boat_wake` tool with the same id. Don't repair the
sandbox by hand (no `pkill`, no new `boat stop` to read a stop's state, no
`npm install` of bb): the command does each step safely and says what it did.

## What it does

1. Resumes a stopped sandbox, paced (at most 2 wakes a minute for the
   account) and within the boat start limit.
2. Waits until boat's exec answers, then looks at it: the disk restoring or
   failing (`HYDRATOR FAILED … 503`, "Input/output error"), SSH logins that
   hang, bb's daemon broken or older than the server, an `npm install` zombie.
   A read waiting on the disk is waited for first (up to 2 minutes).
3. A disk that's unreadable, reads still stuck after that wait, or an npm
   zombie: it stops the sandbox and starts it again, boat.dev's fix for a
   stuck sandbox. A plain stop first (a fresh snapshot, nothing lost),
   followed by its status. `--force` only when nothing there could be lost
   (no turn running, no unpushed commits, changes or stashes in any checkout)
   and a test fork of its snapshot reads fine on another node. Otherwise it
   stops and prints the facts and the exact commands.
4. Turns off the login message scripts. bb's machine suspended: only `bb
   machine resume` (bb's own resume updates bb safely and starts it). Not
   suspended but disconnected: updates bb there safely when it's old or broken
   (from the server's download on the sandbox; without one, the server's
   exact version from the npm registry) and restarts bb's service. Then it
   waits until the machine connects.
5. Retries the chat: sends its pending provider retry now, retries its failed
   turn, or leaves it when its queue is already sending.

One wake per sandbox runs at a time; a second one shows the first one's
progress. A wake takes about 25 minutes at most. The command waits up to 90
seconds, then the wake goes on: `bb boat sandbox wake <id> --status` shows
it, and the chat that asked gets a `[boat]` message when it's done. A wake
cut off between its stop and its start (a reload) is finished by the plugin:
it starts the sandbox again.

## Options

- `--dry-run`: only looks and prints the plan; changes nothing.
- `--json`: the report as JSON (steps, the diagnosis, what needs you).
- `--status`: the running or last wake of that sandbox; starts nothing.
  Orchestrators: `boat_wake` with `status: true`.
- `--force-wake`: wake a sandbox whose tasks are all cancelled or closed (or
  a closed task's, or its chat's). Only when the user asks. A chat of a task
  that's cancelled or closed is never retried, with or without it: before the
  machine comes back, its pending provider retry is cancelled, and its other
  queued messages are listed for the user to cancel in bb if they're stale.
- `--allow-paid-start`: allow a paid extra boat start when no included start
  is left. Only when the user agreed in this chat. Without it, the command
  stops and says so. Harbormaster never turns on paid extra starts.

## When it stops

It exits 1 with **Needs you** and the commands to run when it stops for
safety:

- a turn is running there (a headless agent, or a chat on a machine that's
  connected or that Harbormaster can't read): a stop would interrupt it;
- a stop it won't force, and why (work that could be lost, or a test fork
  that couldn't read the snapshot);
- a disk still unreadable after a stop and a start;
- no boat start left, or a paid start without `--allow-paid-start`;
- too little of its time (about 25 minutes) left to stop the sandbox and
  start it again (nothing is stopped then);
- bb's machine on the sandbox couldn't be looked up, so its chats can't be
  checked;
- the sandbox's tasks are all cancelled or closed (wake it anyway with
  `--force-wake` only when the user asks; their chats are never retried);
- a closed task's pending provider retry Harbormaster couldn't cancel (cancel it with
  `bb provider-retry cancel <chat id>` first);
- bb's machine not connecting.

Tell the user what it says; don't work around it.
