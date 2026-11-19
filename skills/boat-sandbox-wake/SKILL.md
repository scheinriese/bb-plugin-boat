---
name: boat-sandbox-wake
description: "Bring a stuck boat.dev sandbox and its chat back with one command, `bb boat sandbox wake <id>` (the `boat_wake` tool for orchestrators). Use when the user says \"wake this machine\", or a chat or task is stuck on \"Machine is paused\" or \"resuming\", or a Boat sandbox chat doesn't come back after a stop. Don't repair the sandbox by hand."
---

# Waking a stuck sandbox

When a chat or task on a Boat sandbox is stuck on **Machine is paused** or
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
3. A disk that's unreadable or stuck, or an npm zombie: it stops the sandbox
   and starts it again, boat.dev's fix for a stuck sandbox. A plain stop
   first (a fresh snapshot, nothing lost), followed by its status; `--force`
   only when nothing there could be lost (no turn running, no unpushed
   commits, changes or stashes in any checkout). Otherwise it stops and
   prints the facts and the exact commands.
4. Turns off the login message scripts, updates bb there safely when it's old
   or broken (from the server's download on the sandbox; without one it says
   so, with the npm registry as a manual step only), restarts bb's service,
   resumes bb's machine if it's suspended and waits until it connects.
5. Retries the chat: sends its pending provider retry now, retries its failed
   turn, or leaves it when its queue is already sending.

## Options

- `--dry-run`: only looks and prints the plan; changes nothing.
- `--json`: the report as JSON (steps, the diagnosis, what needs you).
- `--allow-paid-start`: allow a paid extra boat start when no included start
  is left. Only when the user agreed in this chat. Without it, the command
  stops and says so. Boat never turns on paid extra starts.

## When it stops

It exits 1 with **Needs you** and the commands to run when it stops for
safety: a stop it won't force (and why), a disk still unreadable after a stop
and a start, no boat start left, a paid start without `--allow-paid-start`,
or bb's machine not connecting. Tell the user what it says; don't work around
it.
