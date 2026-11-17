# Pluggable sandbox providers: research and design

Research and design only: this document changes no code. It looks at how the plugin, today tied to boat.dev, could work with several cloud sandbox providers, with Mac and iOS work as the priority. It also covers a second use case: short-lived Mac and Windows boxes for cross-platform browser testing.

**Reading guide.** For the decision, read the Summary and Part C. Part A is the code audit behind the refactor. Parts B and B2 are the sourced reference: one section per provider, then licensing, Windows and browser testing.

- **Date:** 2026-11-17. Prices are list prices in US dollars on that date, and they change.
- **Code audited:** this repository at commit `aaf1442` (version 0.2.8), and bb's public source at commit [`de34f34`](https://github.com/get-bb/bb/tree/de34f3492e4c69ade967e7b9b1345c9e8d62b03d).
- **Providers:** boat.dev (the baseline), Instabox, Darkbloom, Modal and Vercel Sandbox, plus Windows options and hosted browser-testing services.

## Summary

1. **No provider covers everything.** boat.dev, Modal and Vercel Sandbox are Linux-only. Of the five, only Instabox has a self-serve Mac API, since 2026-11-12, and its Xcode and Simulator details are still undocumented. None of the five sells Windows.
2. **Top recommendation:** keep boat.dev as the Linux default. Extract a provider interface modeled on bb's `SandboxBackend`. Then ship a cross-platform capture feature, which can overlap that work, before plugin-managed Mac agent workspaces. That puts the second use case ahead of the stated Mac priority, because it is cheap, low-risk and works with the plugin as it is (owner to confirm). Mac work can start the same day in bb's own chats, on a Mac enrolled by hand.
3. **Capture runs on per-minute runners.** Real Safari, and Edge and Chrome on Windows Server 2025, cost about $0.31 and $0.05 per 5-minute run on GitHub's hosted runners, or nothing for public repos, whose run logs are public, so the preview link must be masked. Whether Server 2025 renders like Windows 11, whether headed Edge works there, and whether Safari video records on these runners is unverified. Hosted grids cover Windows 11 x64 and real iPhones. TestingBot is pay as you go from about €60 per 1,000 minutes. Unlimited per-parallel plans cost $79 to $129 a month for desktop browsers, and $175 to $225 with real iPhones ([GitHub pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing), [TestingBot](https://testingbot.com/pricing), [BrowserStack](https://www.browserstack.com/pricing), [TestMu AI](https://www.testmuai.com/pricing.md)).
4. **Renting a Mac for agent work means leasing a whole Mac for at least 24 hours.** That is this report's reading of Apple's Section 3A, not legal advice; a Mac you own has no minimum. Start by enrolling an owned or rented Mac as a bb machine. Scaleway rents a 16 GiB Mac mini for €115 a month or €4.08 a day. Then add one Mac API: Instabox (macOS 26 with Xcode, from $10.80 a day, Linux too) or Scaleway (whole Mac minis, from €2.64 a day) ([Apple's license](https://www.apple.com/legal/sla/docs/macOS27.pdf), [Scaleway catalog](https://api.scaleway.com/product-catalog/v2alpha1/public-catalog/products?product_types=apple_silicon&page_size=100), [Instabox macOS](https://instabox.sh/docs/machines/macos.md)).
5. **Darkbloom is not fit for agents that hold credentials.** Its docs say Darkbloom can decrypt workspaces and that sandboxes "do not yet claim confidentiality" from the Mac's owner. It is invite-only, has no documented API (only a CLI and an MCP server) and no inbound ports, and doesn't address Apple's lease rule ([security](https://docs.darkbloom.dev/sandboxes/security), [overview](https://docs.darkbloom.dev/sandboxes/overview)).
6. **Modal and Vercel Sandbox are Linux options.** For Modal, reuse bb's official Modal machine provider rather than writing a client (inferred feasible; untested). Vercel needs a new adapter, a token-checking proxy for its public preview URLs, and a restart at the 24-hour session cap (see [Modal](#modal) and [Vercel Sandbox](#vercel-sandbox)).
7. **Two ways to run tasks on a new provider.** Task chats (bb on the sandbox) work on any provider with a lifecycle and an executor, but by default only for repos you trust, because the sandbox then holds bb's credentials. Headless tasks, the default, need an agent runner per provider: boat's today, then Instabox's CLI runner, then a generic one. Until then, untrusted repos stay on boat (see [Recommended architecture](#recommended-architecture)).
8. **Windows waits on bb, not on supply.** None of the five sells Windows, but Daytona, Orgo, Windows 365 for Agents, EC2 and Azure do. Each is gated (Daytona's Tier 3, Orgo's monthly plans, Windows 365's Intune and Agent 365 licenses). Microsoft's licensing seems to keep Windows 11 away from third-party sandboxes (inferred), and bb can't yet enroll Windows from a provider plugin. Use Windows as a capture target first (see [Windows sandboxes and licensing](#windows-sandboxes-and-licensing)).
9. **The refactor is moderate.** About 3% of the plugin's non-test TypeScript is coupled to boat, but it sits in the core modules (service, setup, the boat API, machine, sizing). The extraction itself (Phase 1a) can ship with no behavior change (see [How much is boat-specific](#how-much-is-boat-specific)).
10. **Pricing:** the owner's Instabox Mac prices and Darkbloom Linux and Mac prices are all confirmed. "Private beta" for Darkbloom is close: its sandboxes are invitation-only and labeled experimental, for Linux too (see [owner-supplied figures](#owner-supplied-figures)).
11. **Needs the owner:** a Mac budget (owned, monthly or leased), capture backends, a Mac provider account, and a decision on naming.

## How this was researched

- **Code audit.** Five independent audits covered lifecycle and limits, exec and the agent runner, repo, previews and secrets, bb machine enrollment, and setup and UI. A sixth pass grepped every boat call to check completeness and spot-checked the line pointers.
- **Providers and topics.** One researcher per topic used public sources only: docs, pricing pages, terms, GitHub and changelogs. No accounts were created, no paid APIs were called and no vendor was contacted. An independent checker then re-fetched the sources, recomputed the costs and corrected the draft section.
- **Final review.** Seven more reviewers tried to refute the draft, each through one lens: prices and cost math, the recommendation, Mac licensing and trust, testing and Windows facts, code claims, coverage of the brief, and citations and style. Together they re-checked several hundred claims and links, and their corrections are applied.
- **Labels.** "(unverified)" marks claims not confirmed in a primary source. "(inferred)" and "this report's reading" mark this report's own reasoning. "(untested)" marks what would need an account to try. "(vendor claim)" marks a vendor's statement about itself that nobody independent measured. "(old source)" flags a source from before 2026. Vendor comparison pages are treated as biased. Links to source code and runner images on main branches show their state on 2026-11-17 and can drift; bb links are pinned to a commit.

## Part A: what the plugin needs from a provider

### Two ways a task runs today

- **Headless tasks.** `boat prompt` starts Claude Code or Codex inside the sandbox through boat's own agent runner. The plugin then polls `boat conversations` and `boat events`, and uses `boat steer` and `boat interrupt` to talk to the turn ([src/boat-api.ts:1224](../../src/boat-api.ts#L1224), [src/service.ts](../../src/service.ts)). No bb runs in the sandbox.
- **Task chats.** The plugin registers boat as a bb machine provider. bb installs its daemon in the sandbox over `boat ssh` and runs the agent as a regular bb chat ([src/machine.ts:60](../../src/machine.ts#L60), [src/chat.ts](../../src/chat.ts)). Native composer chats on a "Boat sandbox" and cloud orchestrators use the same path. It needs bb Connect, and the sandbox then holds bb machine credentials ([README](../../README.md)).

Both modes share the rest: creating, stopping, resuming and deleting sandboxes, preparing the checkout through `boat exec`, previews, evidence, snapshots, environments, plan limits and the setup checks.

### What the plugin gets from boat.dev

Every boat call in the code, grouped by capability. A grep found 114 calls into the boat API wrapper in 10 files (69 of them in `src/service.ts`), 5 read-only setup calls and one `boat ssh` spawn; all of them are covered here. "Required" means a provider must offer it; "optional" names the fallback; "boat extra" means only boat has it and the plugin can live without it.

| Capability | boat mechanism | Pointers | Needed from a provider |
|---|---|---|---|
| **Lifecycle** | | | |
| CLI client and errors | `boat <sub> --json` spawned on the bb host; JSON Lines; error record `{event:"error",code,error,status}`; 60 s default timeout | `src/boat.ts:145`, `src/boat.ts:77`, `src/boat.ts:99` | Required: SDK or HTTP client mapped to one error shape |
| Create | `boat new --name --type [--environment] [--from] [-e K=V] [--ttl]`; reads `created` and `ready`, then `boat info` | `src/boat-api.ts:858`, `src/service.ts:898`, `src/service.ts:1667` | Required; idempotent by key or tag |
| Get and list | `boat info <id>` (`{sandbox}`); `boat list [--all]` (`{sandboxes}`); `not_found` or 404 means gone | `src/boat-api.ts:831`, `src/boat-api.ts:849`, `src/service.ts:4416` | Required |
| State model | Active: provisioned, cloning, ready, idle, running. Transitional: provisioning, starting, stopping, archiving, resuming, pending (waited out up to 120 s). Stopped: stopped, archived. Dead: error, cancelled | `src/boat-api.ts:74`, `src/service.ts:551`, `src/watchdog.ts:62`, `web/format.ts:180` | Required: normalized state plus the raw value |
| Stop and resume | `boat stop <id>` keeps disk and conversations; `boat resume <id> [--ttl] [--type]` counts as a start; stopped boxes go after 14 days | `src/boat-api.ts:920`, `src/boat-api.ts:925`, `src/service.ts:966`, `src/service.ts:3707` | Optional. Fallback: snapshot and terminate, or delete when idle |
| Delete | `boat delete <id> --yes` | `src/boat-api.ts:916`, `src/service.ts:1009`, `src/machine.ts:249` | Required |
| Orphan cleanup | Failed `boat new` deletes its `created` id; bb machines found by name `bb machine <key>` in `boat list --all` | `src/boat-api.ts:883`, `src/machine.ts:51`, `src/machine.ts:129` | Required: tags or idempotent create |
| Sizes and resize | `--type` small, default, large, xlarge (2 to 16 vCPU); plan sizes from `limits.machineTypes`; resize is stop plus `resume --type` | `src/boat-api.ts:9`, `src/setup.ts:253`, `src/sandbox-size.ts:1051` | Required: size catalog. Optional: resize (fallback: hide, or recreate) |
| Auto-stop and extend | `--ttl` on new and resume; deadline `archiveAfter`; `boat extend <id> --ttl`; cap parsed from English `trialLine`; keeper extends while bb chats work | `src/boat-api.ts:26`, `src/boat-api.ts:1014`, `src/keeper.ts:358` | Optional. Fallback: plugin idle stop. Keeper is a boat extra |
| Watchdog and idle stop | `boat list --all` each pass; suspends bb machines that boat stopped; `boat stop` after idle (state `idle`, nothing busy) | `src/watchdog.ts:573`, `src/service.ts:4937`, `src/service.ts:5048` | Required logic (plugin side); needs states and `stoppedAt` |
| **Exec and agent runner** | | | |
| Exec | `boat exec <id> --timeout 5..600 -- bash -lc <script>`; last record `{exitCode,stdout,stderr}` | `src/boat-api.ts:1018`, `src/boat-api.ts:1025` | Required; shell per OS |
| Detached exec | `boat exec <id> --detach -- bash -lc <cmd>` returns `{pid}` | `src/boat-api.ts:941`, `src/service.ts:3792`, `src/sandbox-size.ts:353` | Required, or exec plus `nohup` or `setsid` |
| Headless agent turn | `boat prompt <id> --provider <claude or codex> --resume <uuid> [--model] [--reasoning-effort]`; returns at `queued`; boat model ids, effort capped at max | `src/boat-api.ts:1224`, `src/boat.ts:219`, `src/service.ts:1836`, `src/tiers.ts:89` | Optional. Fallback: plugin ExecRunner, or task chats (trusted repos only) |
| Turn status and transcript | `boat conversations` (`running`); `boat events --convo` (prompt status, responses, `usage_limit`) | `src/boat-api.ts:1259`, `src/boat-api.ts:1279`, `src/service.ts:4712` | Optional, with a runner. Fallback: harness JSONL log read over exec |
| Steer and interrupt | `boat steer --convo <c> <text>`; `boat interrupt [--convo <c>]` | `src/boat-api.ts:1316`, `src/boat-api.ts:1320`, `src/service.ts:3072` | Optional. Fallback: kill the process group; interrupt, then a new turn |
| Cross-agent continuation | Same `--resume` id with the other `--provider` | `src/service.ts:4827`, `src/service.ts:2231` | Boat extra. Fallback: handover prompt plus transcript |
| Agent-busy state | Sandbox state `running` while boat's agent works; boat's auto-stop counts only that | `src/service.ts:852`, `src/service.ts:4723`, `src/keeper.ts:63` | Boat extra. Use task state plus a process sample |
| Process sampling | `boat ps <id>`: `{live, processes[{pid,command,cpuPercent}]}`; busy at 20% CPU, infra names excluded | `src/boat-api.ts:1311`, `src/boat-api.ts:137`, `src/service.ts:4912` | Optional. Fallback: `ps` over exec, or Get-Process |
| **Repo and GitHub** | | | |
| Logged-in gh in the box | boat GitHub App token via env `passGithub` (about 8 h); `gh auth setup-git`; expiry from `gh api -i user`; fix is `boat env upgrade` | `src/boat-api.ts:1114`, `src/boat-api.ts:1174`, `src/service.ts:1551`, `src/boat-api.ts:609` | Required. Fallback: mint on the bb host, inject `GH_TOKEN` and a credential helper |
| Access check and checkout | Script over exec: `gh api repos/$REPO`, `gh repo clone --filter=blob:none` into `$HOME/work/<task>`, marker `BOAT_SETUP` | `src/boat-api.ts:561`, `src/boat-api.ts:1053`, `src/boat-api.ts:1156` | Required: bash, git 2.20+, gh |
| Protected-branch hooks | sh hooks in `$HOME/.boat-hooks`, worktree `core.hooksPath`; `boat new -e GIT_CONFIG_*` pins `/home/user/.boat-hooks` | `src/boat-api.ts:499`, `src/boat-api.ts:1100`, `src/boat-api.ts:456`, `src/service.ts:923` | Required: sh, git, writable HOME. Optional: env at create |
| Ship and merge | `shipScript` over exec: fetch, rebase, `git push --no-verify`; merge is `gh pr merge` on the bb host | `src/boat-api.ts:654`, `src/service.ts:4068`, `src/github.ts:140` | Required for push delivery (disk kept). Merge needs no provider |
| **Agent logins** | | | |
| Claude and ChatGPT logins | boat.dev Agents tab; credential profile injected when `passAgentsCredentials` is on | `src/setup.ts:24`, `src/setup.ts:316`, `src/boat-api.ts:1208` | Required. Fallback: provider secrets (API keys), or bb Account Pooler for chats |
| Login detection and preflight | `boat ai profiles` plus `boat env list` (60 s cache) drive Auto-detect and refuse work before a start | `src/setup.ts:994`, `src/setup.ts:784`, `server.ts:125` | Optional. Fallback: the user sets Coding agents |
| AI credentials proxy | `boat ai proxy` (read only) plus env `proxyAiCredentials`: placeholder keys | `src/boat-api.ts:1216`, `src/service.ts:2849` | Boat extra |
| **Snapshots and environments** | | | |
| Environments | `boat env list`, `boat env info`, `boat new --environment`; pre-clones repos into `$HOME/<repo>` and runs its setup script | `src/boat-api.ts:825`, `src/boat-api.ts:1191`, `src/service.ts:940`, `src/boat-api.ts:1132` | Optional. Fallback: plugin-side profile and a fresh clone |
| Snapshots | `boat snapshot <id> <name>` (900 s); `boat snapshots`; `boat new --from <name or share code>` | `src/boat-api.ts:950`, `src/boat-api.ts:956`, `src/boat-api.ts:872` | Optional. Fallback: fresh box plus setup |
| Secrets | Env variables and secret files (`passSecrets`); `env info` returns values, the plugin keeps names | `src/boat-api.ts:1195`, `src/boat-api.ts:620` | Optional. The listing should return names only |
| **Previews and ports** | | | |
| Private port link | `boat host <id> <port> --private --title` gives `https://....on.boat.dev?_token=...`; same link after resume | `src/boat-api.ts:933`, `src/service.ts:3731`, `src/store.ts:278` | Optional. Fallback: provider proxy, bb shared port, or tunnel |
| Preview health and restart | bb host fetches `*.on.boat.dev` only (403 means stopped); restart by detached exec with `ss -ltnpH` and the Vite allow-host variable | `src/previews.ts:80`, `src/service.ts:454`, `src/service.ts:459` | Optional. Without it, health stays unknown |
| **Evidence** | | | |
| Uploader install | Base64 heredoc over exec; `sudo install` to `/usr/local/bin/evidence-upload`; Node 20+ | `src/evidence.ts:159`, `src/evidence.ts:169`, `src/service.ts:1606` | Optional (off by default). Needs sudo or a user dir |
| Bucket keys and links | `EVIDENCE_*` or `AWS_*` in the boat environment; SigV4 PUT, presigned GET (1 to 7 days); re-link with `bb boat sandbox exec ... evidence-upload --link` | `src/evidence.ts:26`, `assets/evidence-upload.mjs:224`, `src/protocol.ts:180` | Optional. Better: presign in the task's sandbox, where the keys live, and hand capture jobs only the URLs (Part B2) |
| **Limits, usage and start queue** | | | |
| Plan limits and start counts | `boat limits`: `canStart`, `startBlockedReason`, `checkoutRequired`, `starts.day/hour.remaining`, `activeSandboxes`, `machineTypes` | `src/boat-api.ts:789`, `src/service.ts:817`, `src/setup.ts:248` | Optional. Worth requiring: a concurrency max and canStart |
| Sandboxes at once and make room | cap is min(plan, setting); used counts the whole boat account; stops the least recently used idle box | `src/service.ts:790`, `src/service.ts:808`, `src/service.ts:842` | Required logic (plugin side). Unit: boxes or vCPUs |
| Usage and cost | `boat usage <id> --since --until` (seconds, dollars); `planIncluded.vmHoursRemaining` | `src/boat-api.ts:808`, `src/rpc-fidelity.ts:81`, `src/usage.ts:20` | Optional. Fallback: hide (the UI handles nulls) |
| Start queue | No boat call; waits only on agent quota (`agents_at_limit`) | `src/start-queue.ts:148`, `src/service.ts:1344` | Plugin side. Should also wait on provider capacity |
| **bb machine enrollment** | | | |
| Bootstrap executor | `boat ssh <id> 'bash -lc <argv>'`; enrollment bundle on stdin; streamed output | `src/machine.ts:63`, `src/machine.ts:71`, `src/machine.ts:73` | Required for bbEnrollment: exec with stdin and streaming |
| Machine provider `boat-sandbox` | create (adopt a `bx_` id, or `boat new`); suspend `boat stop`; resume `boat resume`, then bootstrap; remove `boat delete` | `src/machine.ts:136`, `src/machine.ts:167`, `src/machine.ts:226`, `src/machine.ts:245` | Optional (bbEnrollment) |
| Box prerequisites | Linux; login bash with Node 22.19+ (nvm); curl; egress to the bb server; daemon outlives exec; bb Connect on | `src/machine.ts:69`, `src/setup.ts:836` | Required for bbEnrollment |
| **Setup and UI** | | | |
| CLI found and signed in | `~/.ascii/bin/boat` or PATH; `boat --version`; `boat status` | `src/boat.ts:54`, `src/setup.ts:976`, `src/setup.ts:981` | Required, as a credentials check |
| Console, SSH and desktop links | `https://boat.dev/dashboard?sandbox=<id>`; `boat ssh <id>`; `desktopUrl` parsed, unused | `src/boat-api.ts:256`, `src/rpc.ts:167`, `web/overview.tsx:564`, `src/boat-api.ts:245` | Optional: hide when absent. Desktop matters for GUI runners |
| Wording and fix hints | `boat onboard`, `boat billing plan 20`, `boat env upgrade`, boat.dev labels | `src/setup.ts:21`, `src/service.ts:824`, `src/watchdog.ts:626` | Provider-supplied strings |

### Network and secrets model

The plugin holds no boat key. It spawns the local boat CLI, which uses the user's boat login on the bb host (`src/boat.ts:150`). What a sandbox receives is set in the boat environment, not by the plugin.

**Into the sandbox (boat environment toggles)**
- GitHub: boat's GitHub App token when `passGithub` is on. It lasts about 8 hours. The only refresh is `boat env upgrade` (`src/boat-api.ts:609`).
- Agent logins: the environment's credential profile when `passAgentsCredentials` is on (`src/setup.ts:291`).
- Secrets: variables and secret files when `passSecrets` is on. Evidence bucket keys live here, so every agent in that environment can read them (`src/evidence.ts:6`).
- boat's own login when `passSandboxCredentials` is on. Setup warns about it (`src/setup.ts:620`).
- Safe for third parties strips these. `proxyAiCredentials` swaps real AI keys for placeholder keys (`src/service.ts:2849`).
- The plugin itself adds only `GIT_CONFIG_*` hook variables with `boat new -e` (`src/boat-api.ts:456`). They are argv on the bb host and show in its process list. Never send secrets this way.

**bb credentials**
- Task chats and cloud orchestrators install bb in the box. The enrollment bundle goes over `boat ssh` stdin, not argv (`src/machine.ts:60`).
- bb core then adds machine credentials. For non-primary hosts it also forwards the server's gh login as `GH_TOKEN` with a credential helper ([configuration.md#L888-L918](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/docs/configuration.md#L888-L918), [git-credentials.ts#L8-L40](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/services/machines/git-credentials.ts#L8-L40)).
- Trust routing keeps these credentials away from untrusted code by default. Untrusted repos run headless unless the user confirms a task chat for them (`--chat`, Run as a chat or Continue as a chat), and a confirmed task's reviews still run headless (`src/service.ts:1431`, `src/service.ts:1465`, `src/service.ts:1468`). A sandbox that runs or ran bb is refused for an untrusted repo, except for a review in its own task's sandbox, and is never snapshotted (`src/service.ts:1190`, `src/service.ts:2884`). A provider without a headless runner loses this default split.

**Back to the bb host**
- `boat env list` and `boat env info` return `envContents` with values. The plugin keeps names only (`src/boat-api.ts:620`, `src/setup.ts:277`), but the values pass through process memory.

**Network**
- Inbound: the plugin uses only `boat host --private` links on `*.on.boat.dev`. They carry `?_token=`, set a cookie on the first visit and survive stop and resume (`src/boat-api.ts:933`, `src/store.ts:278`). boat also gives each sandbox public IPv6 and SSH (see [boat.dev](#boatdev-baseline)), but the plugin uses neither directly; `boat ssh` is a user hint and the enrollment transport.
- Health checks: the bb host fetches preview links, only on `*.on.boat.dev` (`src/previews.ts:80`).
- Outbound: assumed open and never configured. Boxes reach GitHub, package registries, AI APIs, the S3 or R2 bucket, and the bb server when enrolled.
- Agents run with full permissions in a disposable box (`src/chat.ts:278`). Guard rails: the protected-branch pre-push hook and a trust note in every brief (`src/briefs.ts:169`).

**What another provider must offer**
- Secret injection at create (variables or files), with a names-only listing.
- A GitHub token path: a provider app, or tokens minted on the bb host and injected as `GH_TOKEN` with a credential helper, as bb core does.
- Egress to GitHub, registries, AI APIs, the bucket and the bb server. Allowlists must include them.
- A token-gated HTTPS preview link. bb shared ports need a bb Connect session to view, so their links can't be shared.
- Test runners need only the preview URL and a presigned PUT URL minted in the task's sandbox (or on the bb host, if the user moves the bucket keys there). No GitHub token, agent logins or bucket keys.

### How much is boat-specific

**Call surface** (grep over `src/` and `server.ts`)
- 114 BoatApi call sites in 10 files: `src/service.ts` 69, `src/sandbox-size.ts` 11, `src/machine.ts` 8, `src/cli.ts` 6, `src/rpc.ts` 5, `src/rpc-fidelity.ts` 4, `src/keeper.ts` 4, `src/watchdog.ts` 3, `src/project-catalog.ts` 3, `src/tools.ts` 1.
- Plus 5 read-only setup reads through `cli.run` (`--version`, `status`, `limits`, `env list`, `ai profiles`; `src/setup.ts:976`, `src/setup.ts:994`) and 1 `boat ssh` spawn (`src/machine.ts:73`).
- 29 BoatApi methods; 27 distinct boat invocations.

**Lines** (three methods; they overlap, so don't add them)

| Method | Boat-coupled | Base | Share |
|---|---|---|---|
| Lexical (TypeScript parser): code with boat calls, boat JSON fields, ids and URLs, in-box paths and shell, or the size enum, plus strings naming boat; namespace-only names excluded | 1,472 lines in 66 files | 45,341 TS/TSX lines | 3.2% |
| Blast radius: non-blank lines of the innermost named function that calls boat directly | 3,404 lines in 13 files | 42,912 non-blank lines | 7.9% |
| Adapter core: `src/boat.ts` plus `src/boat-api.ts` | 1,669 lines; about 530 are provider-neutral git and GitHub scripts | 45,341 TS/TSX lines | 3.7% |

- Per-area structural counts from the audits (blocks that exist only for boat): lifecycle 2,175 of 5,336 non-blank lines (41%); exec and runner 1,823 of 6,663 (27%); repo, previews and secrets about 835 of 3,976 (21%); bb enrollment 104 hard lines, about 380 with `src/keeper.ts`.
- 63% of lexical logic lines sit in five files: `src/boat-api.ts` 278, `src/setup.ts` 177, `src/service.ts` 145, `src/memory.ts` 69, `src/sandbox-size.ts` 55.
- Counted at `aaf1442` with a TypeScript-parser script (lexical) and a per-function scan (blast radius); the scripts are not included.

**Thin adapters** (wording, enums, capability gates)
- `src/cli.ts`, `src/tools.ts`, `src/rpc.ts`, `src/rpc-fidelity.ts`, `src/rpc-size.ts`, `src/project-catalog.ts`: route calls through the provider; hide console and SSH links when absent.
- `contract*.ts`, `src/settings.ts`, `src/config.ts`, `src/settings-store.ts`, `web/`: size enum to provider size ids; provider-scoped settings; labels.
- `src/previews.ts` (host suffix), `src/evidence.ts` (installer per shell), `src/tiers.ts` (model ids move to the runner), `src/transcript.ts` (home dir), `src/usage.ts`, `src/briefs.ts` and protocol text (preview host, gh notes).
- `src/chat.ts`: the machine provider id and the adopt-a-sandbox inputs per provider (`src/chat.ts:167`).
- Already neutral: `src/chat-recovery.ts`, `src/steer-retry.ts`, `src/relay.ts`, `src/activity.ts` (provider id only), `src/limits.ts`, `src/quota.ts`, `src/start-queue*.ts`, `src/bootstrap.ts`, `src/github.ts`, `src/merge*.ts`, `src/local-projects.ts`.

**Deep changes**
- `src/boat.ts`, `src/boat-api.ts`: move to `providers/boat`. Keep the POSIX git scripts (prepareRepo, hooks, ship, access check) in a shared module with a shell and home parameter.
- `src/service.ts`: 69 call sites. 2,028 of 4,841 non-blank lines sit in methods that call boat: capacity and ensureSlot, createSandbox, ensureRunning, dispatch and follow-ups, collectResult, sweep, idle stop, previews, ship, snapshots, project access.
- `src/setup.ts`: BoatFacts is the data model. Split a neutral framework (about 40%) from a boat doctor (about 60%).
- `src/sandbox-size.ts`, `src/memory.ts`: boat size enum, resize through `resume --type`, Linux-only probe.
- `src/keeper.ts`: exists for boat's auto-stop. Run it only when the provider's TTL can't see bb activity.
- `src/watchdog.ts`: generic once states are normalized; boat wording.
- `src/machine.ts`: split a vendor backend from a neutral registration, in the shape of bb's `register.ts`.

**Tests**
- 70 test files, 20,937 lines.
- `FakeBoat` (`test/fakes.ts:169`) mirrors BoatApi and is cast into BoatService (`test/fakes.ts:855`). 39 test files use it. It becomes a FakeProvider.
- `test/fixtures/fake-boat.mjs` (259 lines) is a fake boat binary. It enforces `--json` after the subcommand (`test/fixtures/fake-boat.mjs:23`), and `createTestHost` requires `boatPath` (`test/fakes.ts:43`). 18 test files use it. Keep them as boat adapter tests.
- 8 captured boat JSON fixtures in `test/fixtures/boat-json` move with the boat parsers.
- `bx_` ids sit on 76 lines in 25 files; `BoatError` on 46 lines in 8 files. About 1,954 test lines mention boat or `bx_` (namespace included); the setup audit puts the provider-specific share near 622.
- Neutral wording breaks string checks in `test/setup.test.ts` (144 mentions), `test/setup-plugin.test.ts` (62), `test/config.test.ts` (37) and `test/settings.test.ts` (28).

**Verdict.** The refactor is moderate, not a rewrite. The boat calls are few in kind (27 distinct invocations) but sit in the central modules. So Phase 1 is mostly mechanical moving and renaming behind an interface. It also needs a real redesign of three things: the setup checks (`src/setup.ts`), the size model (`src/sandbox-size.ts`, `src/memory.ts`) and the state handling that `src/keeper.ts` and `src/watchdog.ts` build on.

### What changes per OS

| Topic | Linux (boat today; Modal, Vercel Sandbox) | macOS | Windows |
|---|---|---|---|
| Shell | `bash -lc` for every exec, detached exec and ssh (`src/boat-api.ts:1025`, `src/boat-api.ts:942`, `src/machine.ts:71`). Other images may lack bash or keep node and gh off the login PATH | `/bin/bash` is 3.2 and the login shell is zsh, so `bash -l` skips Homebrew's PATH in `~/.zprofile`. The memory probe uses bash 4 `printf` (`src/memory.ts:144`). The ship script already avoids `mapfile` (`src/boat-api.ts:665`) | No bash. Every in-box script (repo prep, hooks, ship, evidence, preview restart, probes) needs a PowerShell body, and quoting differs from `shellQuote` (`src/boat-api.ts:311`) |
| Paths | `/home/user` is hard-coded (`src/boat-api.ts:448`, `src/service.ts:1691`, `src/transcript.ts:13`). Modal runs as `node` in `/home/node`. Another HOME silently turns off the push guard | Home folders live under `/Users`, not `/home`. `/tmp` is `/private/tmp`. Spaces break `path=(\S+)` (`src/boat-api.ts:1156`) | `C:\Users\<name>`, `%TEMP%`, CRLF. Drive paths break the hook's local-remote test (`src/boat-api.ts:505`). `core.hooksPath=/dev/null` needs `NUL` (`src/ship-interaction.ts:28`) |
| Tools in scripts | Containers may lack `ss`, journalctl and systemd (`src/service.ts:457`, `src/memory.ts:165`) | No `ss` (use `lsof`), no `/proc`, no GNU `timeout`. Use `sysctl` and `vm_stat` | Get-NetTCPConnection, Stop-Process and CIM instead |
| Process model | The exec API must not reap detached children. The `boat ps` filters name Linux daemons (`src/boat-api.ts:137`) | `nohup` works. `ps` CPU% is per core. launchd, WindowServer and mds count as infrastructure. jetsam replaces the OOM killer | Start-Process or a scheduled task. Job objects can kill children when the session ends. Get-Process reports CPU seconds, so take two samples. ssh and services run in session 0 |
| Privileges | The evidence installer assumes passwordless sudo (`src/evidence.ts:169`) | sudo usually asks for a password | UAC; no `/usr/local` |
| Agent runner | Only boat has a full one; Instabox has a CLI-only one (Part B). Others: a plugin ExecRunner over detached exec, or task chats | ExecRunner with Homebrew or npm CLIs | ExecRunner in PowerShell |
| bb enrollment | Works with Node 22.19+, curl and egress. Without systemd the installer runs a nohup daemon | The installer supports Darwin but registers a LaunchAgent with `launchctl bootstrap gui/<uid>`, which needs a GUI login. Set `BB_INSTALL_SKIP_SERVICE=1`. Node is not preinstalled | Blocked at de34f34: bootstrap runs POSIX `sh`, and the installer refuses other OSes. Only a manual PowerShell enrollment exists |
| Sizes and cost | The size enum and the MemTotal check are boat-shaped (`src/memory.ts:72`) | Fixed hardware, often a 24 h minimum. Idle stop (`src/settings.ts:109`), delete on close (`src/settings.ts:359`) and resize then waste paid time | VM SKUs with their own minimums |
| GUI capture (runners) | Headless browser | Aqua session plus Screen Recording (TCC) permission for video | An interactive desktop session, not session 0 |

bb references: [bootstrap.ts#L7-L30](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/services/machines/bootstrap.ts#L7-L30), [install-machine.sh#L384-L391](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/assets/install-machine.sh#L384-L391), [#L994-L1023](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/assets/install-machine.sh#L994-L1023), [#L1047-L1118](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/assets/install-machine.sh#L1047-L1118), [manual-enrollment-command.ts#L19-L24](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/services/machines/manual-enrollment-command.ts#L19-L24), [platform-support.md#L10](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/docs/platform-support.md#L10).

Platform references for the table: zsh is the macOS default login shell ([Apple](https://support.apple.com/en-us/102360)), and Windows services run in session 0 ([Microsoft](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)). The other platform cells are common knowledge, not individually sourced (unverified).

**bb host side** (where the boat CLI runs)
- The binary lookup has no `.exe` or PATHEXT (`src/boat.ts:66`). On Windows, SIGTERM is a hard kill (`src/boat.ts:165`). The install hint is `curl ... | sh` (`src/setup.ts:20`).
- The prompt is one argv element (`src/boat-api.ts:1241`). Linux caps one argument at 32 pages, 128 KiB with 4 KiB pages ([execve(2)](https://man7.org/linux/man-pages/man2/execve.2.html)), and Windows caps a command line at 32,767 characters ([CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)). Briefs may be 100,000 chars (`contract.ts:739`).
- The host gh lookup tries Unix paths first (`src/github.ts:18`).

**Test-runner boxes**
- No enrollment, agent logins or GitHub. They need exec, a file pull or a presigned PUT, and the preview URL.
- boat's private links open in any browser. bb shared-port links need a bb Connect session.
- A headless browser (Playwright screenshots and video) avoids the macOS and Windows desktop rules. Capturing native apps needs them.

### bb's own machine layer and what to reuse

Links pin get-bb/bb at de34f34.

**Machine-provider API (core)**
- A plugin registers a provider with `bb.experimental_machines.register`: required `create`, `reconcileCleanup` and `remove`; optional `availability`, `validate`, `suspend` and `resume` ([machine-provider.ts#L69-L108](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/packages/plugin-sdk/src/machine-provider.ts#L69-L108)). `suspend` must stop any remaining compute ([#L97](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/packages/plugin-sdk/src/machine-provider.ts#L97)).
- Core owns enrollment. `bb.experimental_machines.bootstrap` takes a `MachineExecutor` with `command[]`, `stdin`, `onOutput` and `timeoutMs` ([machine-bootstrap.ts#L3-L13](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/packages/plugin-sdk/src/machine-bootstrap.ts#L3-L13)). It runs `sh -c` to fetch `/install.sh` with the enrollment JSON on stdin, or `sh -s -- --start` on resume. It allows 600 s for the exec and 120 s for the connection ([bootstrap.ts#L7-L30](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/services/machines/bootstrap.ts#L7-L30), [#L65-L121](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/services/machines/bootstrap.ts#L65-L121)).
- The installer accepts macOS and Linux only and needs Node 22.19+ ([install-machine.sh#L384-L409](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/assets/install-machine.sh#L384-L409)). It installs a systemd or launchd service, or a nohup daemon ([#L440-L461](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/assets/install-machine.sh#L440-L461), [#L994-L1023](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/assets/install-machine.sh#L994-L1023), [#L1047-L1118](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/assets/install-machine.sh#L1047-L1118)).
- Thread-lifetime launches of an ephemeral provider are ephemeral. Standalone `hosts.experimental_create` machines are persistent, so the plugin deletes them itself ([provider-orchestration.ts#L540-L550](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/services/machines/provider-orchestration.ts#L540-L550), [#L596-L606](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/services/machines/provider-orchestration.ts#L596-L606)).
- Core injects machine environment variables and, for non-primary hosts, forwards the server's gh login as `GH_TOKEN` with a credential helper ([configuration.md#L888-L918](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/docs/configuration.md#L888-L918), [git-credentials.ts#L8-L40](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/services/machines/git-credentials.ts#L8-L40)). Boxes reach bb through bb Connect or a direct URL ([configuration.md#L842-L848](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/docs/configuration.md#L842-L848)).
- Threads can start on a new provider machine with `environment: {type: 'provider', environmentProviderId, machine: {type: 'new', machineProviderId, inputs}}` ([shared.ts#L125-L139](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/packages/server-contract/src/api/shared.ts#L126-L140)). Host lifecycle calls: `hosts.experimental_create`, `experimental_listProviders`, `experimental_suspend`, `experimental_resume`, `experimental_reconcile` ([hosts.ts#L153-L192](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/packages/sdk/src/areas/hosts.ts#L153-L192)).
- Enrolled hosts can share ports through `ensureSharedPortTunnel` and `declareSharedPorts` ([backend-contract.ts#L2154-L2167](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/packages/plugin-sdk/src/backend-contract.ts#L2154-L2167)). Links answer at `<machine-label>--<port>.<domain>` behind bb Connect ([connect-next.md#L237-L243](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/docs/connect-next.md#L237-L243)).

**Modal plugin** (`plugins/environment-modal-sandbox`, marked Experimental: [package.json#L12](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/package.json#L12))
- `SandboxBackend`: parse inputs and resources, `allocationKey`, `availability`, `validate`, `create` (resource plus executor), `reconcileCleanup`, `suspend`, `resume`, `remove`, `displayName`, `close` ([sandbox-backend.ts#L57-L80](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers/sandbox-backend.ts#L57-L80)).
- `registerSandboxBackend` registers one machine provider and one project-checkout environment, and bootstraps after create and resume ([register.ts#L6-L121](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers/register.ts#L6-L121)). Invariants: converge on the key, checkpoint before returning an executor, idempotent suspend, resume and remove ([providers/README.md#L19-L54](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers/README.md#L19-L54)).
- Modal backend: strict inputs `{preset, image}` ([backend.ts#L32-L37](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers/modal/backend.ts#L32-L37)); pinned account ([#L154-L169](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers/modal/backend.ts#L154-L169)); create reuses `fromName(app, key)` or creates with tag `bbMachineKey` and a 24 h lifetime ([#L230-L299](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers/modal/backend.ts#L230-L299), [configuration.ts#L48](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/configuration.ts#L48)); suspend snapshots the filesystem, then terminates ([#L315-L359](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers/modal/backend.ts#L315-L359)); resume recreates from the snapshot ([#L360-L383](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers/modal/backend.ts#L360-L383)); remove terminates and deletes snapshots ([#L384-L397](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers/modal/backend.ts#L384-L397)).
- The executor passes argv to `sandbox.exec` with no shell ([client.ts#L111-L164](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers/modal/client.ts#L111-L164)).
- Idle pause and reconciliation live in the plugin ([server.ts#L76-L158](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/server.ts#L76-L158), [allocation-sweep.ts#L68-L69](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/allocation-sweep.ts#L68-L69)). Nothing saves before the 24 h limit ([README.md#L98-L100](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/README.md#L98-L100)).
- Image: Node 22.19, git, gh, claude-code and codex; it runs as `node` in `/home/node` ([Dockerfile#L1-L30](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/Dockerfile#L1-L30)).

**Reuse options**
1. Task chats on bb's own providers (Modal today), through `machine: {type: 'new'}`.
   - Pros: no vendor code here. Core clones the repo, runs `.bb-env-setup.sh`, and handles suspend and resume.
   - Cons: chats only, so untrusted repos lose the headless path that keeps bb credentials out. No `boat host` previews; shared ports need a Connect session. No plan limits, usage, sizes beyond presets, adopt or keep. Experimental APIs. Linux only.
2. Copy the `SandboxBackend` pattern into this plugin (about 200 lines, MIT; the bb notice is already in `THIRD_PARTY_NOTICES.md`).
   - Pros: proven invariants and a test shape ([register.test.ts#L21-L92](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers/register.test.ts#L21-L92)). boat maps onto it. `src/bootstrap.ts` already wraps any executor.
   - Cons: it covers lifecycle and the executor only. The plugin still needs exec for headless tasks, previews, limits, extend, list, adopt and keep. It owns vendor SDKs and credentials.
3. Contribute backends and core fixes upstream.
   - Pros: `providers/` is built for more backends. The macOS launchd and Windows bootstrap fixes must land in core anyway. MIT.
   - Cons: gated contributions ([CONTRIBUTING.md#L7-L13](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/CONTRIBUTING.md#L7-L13)). The plugin is Modal-branded. boat extras stay here.
4. For screenshot runners: bb's browser-automation plugin runs headless Chrome with screenshots on enrolled Linux and macOS hosts. It has no Windows build and no cloud provisioning ([browser-automation/README.md#L1-L14](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/browser-automation/README.md#L1-L14), [#L35](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/browser-automation/README.md#L35)).

**Recommendation**
- Now: option 2. Put a `SandboxProvider` in this plugin whose lifecycle and executor follow `SandboxBackend`. Port boat first, then Instabox, then the other Linux vendors.
- Option 1 for Modal (bb's own provider), chat-only and for trusted repos.
- Option 3 for core changes: a platform hint on bootstrap, the macOS service fallback, and Windows enrollment.

### Draft SandboxProvider interface

One instance per provider account and OS. Required members are what every provider must offer; optional members switch a capability off when absent, and the capability flags tell the rest of the plugin what to expect. `os` includes `'windows'`, though no provider in this report can fill it yet (see [Windows sandboxes and licensing](#windows-sandboxes-and-licensing)). Comments name the boat call each member replaces. Capture targets get their own, much smaller interface ([Test targets in the plugin](#test-targets-in-the-plugin)).

```ts
// Draft SandboxProvider for bb-plugin-boat. One instance per vendor account and OS.
// 'boat:' names what each member replaces today (src/boat-api.ts unless noted).
// Test-runner boxes (screenshots, video) use only create, get, delete, exec, execDetached,
// readFile, caps.desktop and caps.minBillingSeconds: no runner, no enrollment, no GitHub.
import type { MachineExecutor } from '@get-bb/plugin-sdk';
import type { PluginMachineProviderAvailability } from '@get-bb/plugin-sdk/machine-provider';

export type Os = 'linux' | 'macos' | 'windows';
export type Agent = 'claude' | 'codex';
export type SandboxState = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'deleted' | 'unknown';

export interface SandboxCapabilities {
  os: Os;                                    // boat: 'linux'
  arch: 'x64' | 'arm64';
  shell: 'bash' | 'powershell';              // boat: bash -lc (macOS: bash 3.2, login PATH set in zsh)
  tempDir: string;                           // boat: /tmp
  homeDir: string;                           // boat: /home/user
  sudo: boolean;                             // boat: passwordless (evidence installer)
  stop: 'keep-disk' | 'snapshot' | 'none';   // boat: keep-disk (boat stop)
  persistentDisk: boolean;                   // boat: true, also while stopped
  retentionAfterStopSeconds: number | null;  // boat: 14 days (src/service.ts:3707)
  resize: boolean;                           // boat: resume --type
  snapshots: boolean;                        // boat: snapshot, snapshots, new --from
  environments: boolean;                     // boat: env list, env info, new --environment
  envAtCreate: boolean;                      // boat: new -e
  autoStop: { atCreate: boolean; extendable: boolean; capSeconds: number | null; seesBbActivity: boolean } | null; // boat: --ttl, extend; sees only boat agents
  minBillingSeconds: number | null;          // boat: null; Mac hosts often 86400
  maxSessionSeconds: number | null;          // boat: null; Modal 86400
  execMaxSeconds: number;                    // boat: 600
    processList: 'native' | 'exec' | 'none';   // boat: native (boat ps)
  previews: 'token-link' | 'public' | 'bb-shared-port' | 'none'; // boat: token-link (host --private)
    agentBusyState: boolean;                   // boat: state 'running' while its agent works
  agentLogins: 'provider' | 'secrets' | 'none'; // boat: credential profile per environment
  githubAuth: 'provider' | 'injected' | 'none'; // boat: GitHub App via passGithub
  bbEnrollment: boolean;                     // boat: boat ssh, login bash with Node 22.19+
  desktop: boolean;                          // boat: desktopUrl (parsed, unused)
  ssh: boolean;                              // boat: boat ssh
    concurrencyUnit: 'sandboxes' | 'vcpus' | 'memoryGb'; // boat: sandboxes, counted account-wide
}

export interface SandboxInfo {
  id: string; name: string | null; key: string | null; sizeId: string | null;
  state: SandboxState; rawState: string;     // boat: provisioned to archived, error, cancelled
  createdAt: string | null;                  // boat: createdAt; also when a paid minimum lease ends
  agentBusy: boolean | null;                 // boat: state === 'running'
  stopsAt: string | null; stoppedAt: string | null; // boat: archiveAfter, stoppedAt
  error: string | null;
}
export interface SizeOption { id: string; label: string; vcpus: number; memoryGb: number; hourlyDollars: number | null; available: boolean; reason: string | null; needsApproval: boolean }
export interface CapacityReport {          // the plugin adds its own monthly spend cap on top
  canStart: boolean; blockedReason: string | null; setupRequired: string | null; // boat limits: canStart, startBlockedReason, checkoutRequired
  used: number; max: number | null;          // boat limits: activeSandboxes, currentLimits.activeSandboxes
  startWindows: { window: 'minute' | 'hour' | 'day'; remaining: number | null; resetsAt: string | null }[]; // boat limits: starts.*
  autoStopCapSeconds: number | null;         // boat: parsed from trialLine
  includedHoursLeft: number | null;          // boat: planIncluded.vmHoursRemaining
}
export interface ExecResult { exitCode: number; stdout: string; stderr: string }
export interface ProcessSample { live: boolean | null; processes: { pid: number | null; command: string; cpuPercent: number | null }[] }
export interface RunnerEvent { type: 'prompt' | 'response' | 'usage_limit'; turnId: string | null; status: string | null; content: string | null; error: string | null; at: number | null }

/** Replaces BoatError codes and the scraping of trial_auto_stop_required text. */
export interface ProviderError extends Error {
  code: 'not_found' | 'unauthorized' | 'setup_required' | 'at_capacity' | 'start_limited' | 'auto_stop_too_long' | 'size_unavailable' | 'timeout';
  capSeconds?: number; resetsAt?: string; hint?: string;
}

export interface SandboxProvider {
  readonly id: string;                       // 'boat'
  readonly displayName: string;              // 'boat.dev'
  readonly idPattern: RegExp;                // boat: /^bx_[A-Za-z0-9]+$/
  readonly caps: SandboxCapabilities;

  // Required
  availability(): Promise<PluginMachineProviderAvailability>; // boat --version, boat status
  capacity(opts?: { fresh?: boolean }): Promise<CapacityReport>; // boat limits
  sizes(): Promise<SizeOption[]>;            // MACHINE_TYPES plus limits.machineTypes
  create(req: {
    key: string; name: string; sizeId: string; environment?: string | null; snapshot?: string | null;
    env?: Record<string, string>; autoStopSeconds?: number | null; signal?: AbortSignal;
  }): Promise<SandboxInfo>;                  // boat new --name --type --environment --from -e --ttl; idempotent by key
  get(id: string): Promise<SandboxInfo | null>; // boat info; null on not_found or 404
  list(opts: { includeStopped: boolean; keyPrefix?: string }): Promise<SandboxInfo[]>; // boat list [--all]
  delete(id: string): Promise<'deleted' | 'gone'>; // boat delete --yes
  exec(id: string, script: string, opts: { timeoutMs: number; stdin?: string; signal?: AbortSignal }): Promise<ExecResult>; // boat exec --timeout -- bash -lc
  execDetached(id: string, script: string): Promise<{ pid: number | null }>; // boat exec --detach -- bash -lc
  explain(error: unknown): { code: string; message: string; hint: string } | null; // explainBoatError (src/setup.ts:887)

  // Optional: absent means the capability is off
  stop?(id: string): Promise<void>;          // boat stop
  resume?(id: string, opts?: { autoStopSeconds?: number | null; sizeId?: string | null }): Promise<void>; // boat resume --ttl --type
  extend?(id: string, seconds: number): Promise<{ stopsAt: string | null }>; // boat extend --ttl
  processes?(id: string): Promise<ProcessSample | null>; // boat ps
  readFile?(id: string, path: string): Promise<Uint8Array>; // none today (boat scp unused); runner artifacts
  hostPort?(id: string, port: number, title: string): Promise<{ url: string; stableAcrossResume: boolean }>; // boat host --private --title
  previewHostSuffix?: string;                // boat: .on.boat.dev (src/previews.ts:80)
  snapshot?(id: string, name: string): Promise<{ name: string; sizeBytes: number | null }>; // boat snapshot
  snapshots?(): Promise<{ names: string[]; included: number | null; used: number | null }>; // boat snapshots
  environments?(): Promise<{ name: string; isDefault: boolean }[]>; // boat env list
  environmentInfo?(name: string): Promise<{ secretNames: string[]; secretFiles: string[]; repos: string[]; passGithub: boolean | null; passSecrets: boolean | null; passAgentLogins: boolean | null }>; // boat env info, names only
  agentLogins?(environment: string | null): Promise<Agent[] | null>; // boat ai profiles plus env list
  usage?(id: string, window: { since?: string; until?: string }): Promise<{ seconds: number | null; dollars: number | null }>; // boat usage
  runner?: AgentRunner;                      // boat prompt, conversations, events, steer, interrupt
  executor?(id: string): MachineExecutor;    // boat ssh; required when caps.bbEnrollment
  links?(id: string): { console: string | null; shell: string | null; desktop: string | null }; // dashboardUrl, boat ssh <id>, desktopUrl
  hints?(): { signIn: string | null; upgrade: string | null; consoleName: string }; // boat onboard, boat billing plan
}

export interface AgentRunner {
  crossAgentResume: boolean;                 // boat: same --resume id with the other --provider
  start(id: string, turn: { conversationId: string; agent: Agent; model?: string | null; effort?: string | null; prompt: string }): Promise<{ turnId: string | null; model: string | null }>; // boat prompt --resume; returns at 'queued'
  running(id: string): Promise<Map<string, boolean>>; // boat conversations
  events(id: string, conversationId: string, cursor?: string): Promise<{ events: RunnerEvent[]; cursor?: string }>; // boat events --convo
  steer?(id: string, conversationId: string, text: string): Promise<void>; // boat steer --convo
  interrupt(id: string, conversationId: string | null): Promise<void>; // boat interrupt [--convo]
}
```

Three rules that the interface alone doesn't show:

- **Untrusted repos need a headless runner.** Today the rules run untrusted repos headless unless the user confirms a task chat for them, so by default bb's machine credentials stay out of their sandbox (`src/service.ts:1431`, `src/service.ts:1468`). A sandbox that runs or ran bb is refused for an untrusted repo, except for a review in its own task's sandbox, and is never snapshotted (`src/service.ts:1190`, `src/service.ts:2884`). A provider without `runner` can serve untrusted repos only through user-confirmed task chats, until the plugin has a generic exec-based runner.
- **The plugin needs exec on machines it uses.** Task chats today rely on the plugin's own exec before bb takes over: the per-task checkout, the protected-branch hook and the no-push marker (`prepareRepo`), the evidence uploader, and Ship. bb's hosts API has no exec for machines the plugin didn't create (a Mac enrolled by hand, bb's Modal machines). The route there is a plugin host entry that bb runs on enrolled machines, reached through `bb.hosts.experimental_client` ([backend-contract.ts](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/packages/plugin-sdk/src/backend-contract.ts#L2139-L2147); experimental, untested here). Without it, such machines run tasks in bb's own project checkout, without those steps.
- **Every create is idempotent by key.** A timed-out or aborted `boat new` can leave a sandbox the plugin never recorded (see the issues below). Providers with idempotency keys or tags close that gap: Instabox requires an `Idempotency-Key` header on lifecycle calls ([llms.txt](https://instabox.sh/llms.txt)), and bb's Modal backend tags each sandbox with its machine key ([backend.ts](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers/modal/backend.ts#L230-L299)).

### Issues found during the audit

Found by reading the code, not by running it, and not fixed here: this task changes no code.

1. A create that times out or is aborted loses the new sandbox's id, so it can hold a slot until its auto-stop (`src/boat.ts:164` rejects before the cleanup at `src/boat-api.ts:883`).
2. The start queue waits only when agents are at their usage limit (`src/start-queue.ts:148`). Capacity checks run after the task is inserted (`src/service.ts:1344`), so a full account fails queued work instead of holding it.
3. A manual Resume skips the slot check, so **Sandboxes at once** can be exceeded (`src/service.ts:2918`).
4. The per-minute start limit is never read, and `starts.unlimited` is read only by setup (`src/boat-api.ts:798`, `src/setup.ts:268`).
5. The plan's auto-stop cap is parsed from English text (`src/boat-api.ts:26`).
6. Git's hooks path is pinned to `/home/user/.boat-hooks` while the hooks are written to `$HOME/.boat-hooks` (`src/boat-api.ts:456`, `src/boat-api.ts:1100`). On any provider where HOME differs, the protected-branch guard is silently off.
7. `collectResult` doesn't treat `cancelled` as terminal, unlike the rest of the code (`src/service.ts:4718` vs `src/service.ts:574`).
8. docs/features.md promises a phone or desktop notice when an orchestrator's own messages are stuck, but the watchdog's `notifyUser` is deliberately a no-op (`server.ts:544`).
9. Docs drift: SECURITY.md calls the bb machine's `gh` use read-only, but merging runs `gh pr merge` there (`src/github.ts:140`). The boat.dev section below lists three more README and SECURITY.md statements that boat's docs contradict.

## Part B: providers

One section per provider, then Apple's license terms for hosted Macs, Windows, and the prices side by side. Each section was researched from public sources and then checked by a second, independent agent.

### boat.dev (baseline)

boat.dev, run by Dedale AI, Corp. (YC Fall 2026), sells Linux-only sandboxes: full virtual machines running Ubuntu 24.04 on x86_64 hosts in Germany, Finland and France, billed per second at a flat rate per size with a $20 monthly minimum ([pricing](https://docs.boat.dev/pricing), [YC](https://www.ycombinator.com/companies/boat), [terms](https://boat.dev/terms)). It fits the plugin's Linux work well: no session cap on paid plans, SSH with stdin for the bb bootstrap, token-gated previews, environments and a built-in agent runner. It has no macOS, Windows or GPU, and no public plans for them were found ([machines](https://docs.boat.dev/machines), [CI](https://docs.boat.dev/ci)).

#### OS and hardware

- Every sandbox runs Ubuntu 24.04 LTS (Linux 6.8, x86_64) from one shared image; saved snapshots replace custom images ([FAQ](https://docs.boat.dev/faq)).
- Four sizes, none with a GPU: small 2 vCPU/4 GB/51 GB disk, default 4/8/51, large 8/16/111, xlarge 16/32/251 ([machines](https://docs.boat.dev/machines)).
- Each sandbox is a full VM on a physical host dedicated to boat (AMD Ryzen 7 9700X or Ryzen 9 9950X), with shared vCPUs and nested KVM ([virtualization](https://docs.boat.dev/machines/virtualization)).
- You can't pick a region, and there is no US or Asia region ([home](https://boat.dev)).

#### API and SDK

- boat has a CLI, a REST API v1 with bearer keys, an OpenAPI 3.1 spec (122 path operations), and Python and TypeScript SDKs at 1.13.0, released 2026-10-28 ([API](https://docs.boat.dev/api/v1), [spec](https://docs.boat.dev/openapi/boat-v1.yaml), [npm](https://registry.npmjs.org/@boatdev%2Fsdk)).
- It is self-serve with a card and has no beta labels. Box was renamed boat on 2026-09-15. Old Box paths still work but return Deprecation headers ([migration](https://docs.boat.dev/migrating-from-box)).
- Keys can be limited to some actions and one sandbox. The API allows 10,000 requests per minute per IP ([scopes](https://docs.boat.dev/api-keys/scopes), [limits](https://docs.boat.dev/limits)).

#### Lifecycle

- boat says create, fork and resume usually take under a second ([fail fast](https://docs.boat.dev/machines/fail-fast)). Its own probes (summarized here, 90 days to 2026-11-17) show create-to-running daily averages of 0.5 to 3.2 s. Resume-to-SSH on a 15 GB test disk had a 2.2 s median day over 30 days, but 4.5 to 52 s on Nov 3 to 8 ([status data](https://status.ascii.dev/history.json)). No independent start benchmark was found; StarSling's third-party leaderboard measures builds, disk and network, not start times ([StarSling](https://github.com/starslingdev/hpc-sandbox-benchmarks/blob/297198a96ee827df5edcd918bd37b949526cfe20/LEADERBOARD.md)).
- Over the API, a waiting command times out at 600 s at most; detached commands have no limit ([command API](https://docs.boat.dev/api/reference/agent/execute-sandbox-command)).
- There is no pause or memory snapshot. The disk is saved every minute and at stop; a resume more than 10 minutes later is like a reboot ([snapshots](https://docs.boat.dev/snapshots)).
- Forks and share codes (`bsh_...`) reuse snapshots ([templates](https://docs.boat.dev/snapshots/templates)).
- Auto-stop is a fixed timer from create or resume, not an idle timer: 1 h by default, up to 30 days or off on paid plans. Only a running `boat prompt` pushes it back ([auto-stop](https://docs.boat.dev/long-running-tasks/auto-stop)).
- A stopped disk is kept at least 14 days; saved snapshots have no scheduled expiry ([data retention](https://docs.boat.dev/data-retention)).

#### Networking

- `boat host ID PORT --private` gives `https://NAME-PORT.on.boat.dev?_token=...`. The link sets a cookie, needs no boat sign-in and survives stop and resume. It carries HTTPS and WebSockets only, up to 50 ports, with no custom domains ([hosting](https://docs.boat.dev/hosting)).
- Each sandbox has public IPv6 and outbound IPv4; some lack their own IPv4, and the IP changes on every resume ([FAQ](https://docs.boat.dev/faq)). The llms.txt summary still says 'a public IPv4' ([llms.txt](https://docs.boat.dev/llms.txt)).
- Inbound is closed except SSH, boat's own ports and ports you publish. Outbound is open, with no egress allowlist ([security](https://docs.boat.dev/security)).
- `boat ssh`, `scp` and port forwarding work, and a desktop streams at 1920x1080 ([SSH](https://docs.boat.dev/ssh-access), [desktop](https://docs.boat.dev/desktop-streaming)).

#### Fit for this plugin

- Headless tasks: Claude Code and Codex are among seven built-in harnesses, with conversations that survive stop, native steering and interrupt ([agents](https://docs.boat.dev/integrated-agents), [steering](https://docs.boat.dev/integrated-agents/steering)). Events must be polled about once per second ([conversations](https://docs.boat.dev/integrated-agents/conversations)).
- Task chats: boat has real systemd and outbound internet ([machines](https://docs.boat.dev/machines)), and `boat ssh` accepts piped stdin, which the REST command API lacks ([SSH](https://docs.boat.dev/ssh-access), [command API](https://docs.boat.dev/api/reference/agent/execute-sandbox-command)). The plugin already installs bb's daemon this way ([machine.ts](../../src/machine.ts)).
- Environments hold variables, secret files, repos and agent logins ([environments](https://docs.boat.dev/environments)).
- Caveats:
  - The preselected onboarding answer (Safe for third parties) withholds every secret ([keys](https://docs.boat.dev/integrated-agents/keys)).
  - boat keeps `exec` commands and output 90 days, and other process output (SSH sessions, services such as bb's daemon) 72 hours, unless `--no-monitoring` ([history](https://docs.boat.dev/long-running-tasks/command-history)).
  - boat's signed file URLs last at most 1 hour and the sandbox serves them, so evidence still needs the plugin's bucket ([SSH](https://docs.boat.dev/ssh-access)).
- bb itself has no boat support; its only bundled cloud machine provider is Modal Sandbox [Experimental] ([bb](https://github.com/get-bb/bb/tree/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox)).

#### Mac specifics

None: no Xcode, iOS Simulator, Safari or safaridriver, so Apple's 24-hour lease rule doesn't arise ([machines](https://docs.boat.dev/machines)). The undated YC profile promises only more regions ([YC](https://www.ycombinator.com/companies/boat)), and boat's own comparison leaves boat unranked for macOS agents ([compare](https://boat.dev/compare/boat-vs-instabox)).

#### Windows

None: boat says it has no Windows runners. Wine runs some apps on the Linux desktop, but boat says GUI, driver and installer tests need real Windows ([CI](https://docs.boat.dev/ci)). No edition, RDP, size or price exists.

#### Cross-platform testing fit

- boat can be the Linux Chrome run and the preview host. `boat run` creates a sandbox, runs a command, prints the cost and deletes it ([llms.txt](https://docs.boat.dev/llms.txt)). Billing is per second, with no documented per-start minimum ([readiness](https://docs.boat.dev/readiness)).
- Chrome 151 and ffmpeg are preinstalled; Playwright isn't listed ([tools](https://docs.boat.dev/machines/tools)). `ascii-record-desktop` records the single screen to MP4 ([recording](https://docs.boat.dev/desktop-streaming/drive-and-record)).
- Graphics run on the CPU, so 3D CSS needs a trial run (unverified) ([machines](https://docs.boat.dev/machines)).
- Start limits bite before cost: 12 per minute, 60 per hour and 200 per day on the $20 plan ([limits](https://docs.boat.dev/limits)).

#### Pricing and example costs

| Item | Price | Billing | Source |
| --- | --- | --- | --- |
| small / default / large | $0.018 / $0.036 / $0.072 per hour | per second while running | [pricing](https://docs.boat.dev/pricing) |
| xlarge | $0.200 per hour | per second; $100+ plan | [pricing](https://docs.boat.dev/pricing) |
| Plans | $20 / $100 / $500 / $2,000 per month | paid back as VM time, no rollover; $20 minimum | [pricing](https://docs.boat.dev/pricing) |
| Extra starts | $0.03 / $0.05 / $0.07 each | up to 1.5x / 2x / 6x the included starts | [limits](https://docs.boat.dev/limits) |
| Extra saved snapshots | $0.056 per day each | 10 included per $20 of plan per seat | [pricing](https://docs.boat.dev/pricing) |
| AI credentials proxy | $1 per UTC day + $1 per 1,000 requests | from the wallet | [AI credentials](https://docs.boat.dev/ai-credentials) |
| Egress, automatic snapshots, IPs, URLs | $0 | included | [pricing](https://docs.boat.dev/pricing) |
| Trial | $0, 7 days | card; 25 compute hours | [trial](https://docs.boat.dev/free-trial) |

Claims in this plugin's own docs, checked against boat's docs:

- AI proxy is a paid add-on ([README](../../README.md)): confirmed, at the price above.
- GitHub token lasts about 8 hours ([SECURITY.md](../../SECURITY.md)): not found in boat's docs.
- Idle limits depend on your plan ([README](../../README.md)): differs; boat has no idle timer, only the fixed auto-stop ([FAQ](https://docs.boat.dev/faq)).
- Paid extra starts are off by default ([README](../../README.md)): differs; only invoice billing is off, and after a first payment the wallet pays extra starts automatically ([CLI](https://docs.boat.dev/cli-reference)).
- In-sandbox boat credentials act on your whole account ([SECURITY.md](../../SECURITY.md)): differs; boat says that key works on its own sandbox only ([scopes](https://docs.boat.dev/api-keys/scopes)).
- Auto-stop sees only headless agents, and `?_token=` links set a cookie ([features](../features.md)): confirmed ([auto-stop](https://docs.boat.dev/long-running-tasks/auto-stop), [hosting](https://docs.boat.dev/hosting)).

| Scenario | Math | Cost |
| --- | --- | --- |
| Linux 2 h, default 4 vCPU/8 GB, 10% or 100% CPU | 2 h × $0.036 (flat rate; CPU use doesn't change it) | $0.072 |
| Same plus the plugin's default 1 h idle wait | 3 h × $0.036 | $0.108 |
| Always-on Linux, 730 h | 730 × $0.036 = $26.28 ($20 from the plan, $6.28 from the wallet) | $26.28 |
| Linux Chrome test, 5 min, small | 300 s × $0.018 / 3,600 s | $0.0015 |
| 250 such tests in a day, $20 plan, spread over 5+ hours | 250 × $0.0015 + 50 extra starts × $0.03 | $1.875 |
| Mac 2 h (cheapest or 16 GB), always-on Mac, Mac or Windows 5 min test | no macOS or Windows | n/a |

VM time draws on the plan's included $20, so light use still bills $20 a month ([pricing](https://docs.boat.dev/pricing)).

#### Trust and security

- boat says its hosts are dedicated to it ([virtualization](https://docs.boat.dev/machines/virtualization)); its privacy policy names OVH and Hetzner as infrastructure hosts and Cloudflare for snapshot storage ([privacy](https://boat.dev/privacy)). So boat most likely rents dedicated servers (inferred; confirm with boat).
- Each sandbox is its own VM with its own kernel, and the user is root inside ([security](https://docs.boat.dev/security)). The blog says KVM ([blog](https://boat.dev/blog/containers-vs-vms)); a third-party probe detected QEMU/KVM ([StarSling](https://github.com/starslingdev/hpc-sandbox-benchmarks/blob/297198a96ee827df5edcd918bd37b949526cfe20/LEADERBOARD.md)).
- SOC 2 is in progress, and 99.95% uptime is measured, not an SLA ([compliance](https://docs.boat.dev/compliance)). The privacy policy is not a DPA; you email support for one ([privacy](https://boat.dev/privacy)).
- At-rest encryption is stated only for credential profiles and telemetry headers ([AI credentials](https://docs.boat.dev/ai-credentials)). The docs say snapshot copies can leave the EU, but the privacy policy says snapshots run in the EU ([compliance](https://docs.boat.dev/compliance), [privacy](https://boat.dev/privacy)). boat terminates TLS for preview URLs ([routing](https://docs.boat.dev/hosting/how-it-works)).
- By default a sandbox holds a real GitHub token, AI logins and secret files, and egress is open, so a prompt-injected agent can send them out. The AI proxy keeps only AI keys out ([security](https://docs.boat.dev/security), [AI credentials](https://docs.boat.dev/ai-credentials)).

#### Risks

- The company was founded in 2024 and has a team of 3; no disclosed funding beyond YC was found ([YC](https://www.ycombinator.com/companies/boat)).
- It changes fast (25 SDK releases in six weeks, seat limits changed on 2026-10-28) and has no changelog; the newest blog post is from 2026-08-11 ([npm](https://registry.npmjs.org/@boatdev%2Fsdk), [llms.txt](https://docs.boat.dev/llms.txt), [blog](https://boat.dev/blog)).
- Status probes over 90 days, in degraded/outage hours: API 18/1, creation 31/4, fork 77/13, dashboard 25/7, SSH 0/0 ([status data](https://status.ascii.dev/history.json)).
- The Terms let boat throttle, stop or delete resources and change prices, and cap liability at the greater of $100 or three months of fees ([terms](https://boat.dev/terms)).
- The comparison pages and Battleships are vendor-built, and the pricing page quotes Modal at both $0.760 and $0.476 per hour ([Battleships](https://battleships.dev), [pricing](https://docs.boat.dev/pricing)).

### Instabox

Instabox, from InsForge AI, Inc., gives each agent a persistent Linux microVM and, since 2026-11-12, a macOS VM on a whole leased Mac ([terms](https://instabox.sh/terms), [changelog](https://instabox.sh/changelog/macos.md)). Its own "Migrate from Boat" guide maps boat's CLI almost one to one ([from Boat](https://instabox.sh/docs/migrate/from-boat.md)). Linux is cheap, each Mac lease has a 24-hour minimum, and Windows is listed on the homepage but not launched or documented ([pricing](https://instabox.sh/pricing.md), [homepage](https://instabox.sh/)).

#### OS and hardware

- Linux: Firecracker microVMs on x86_64, Debian 13 (Ubuntu 24.04 for `ci`), 4 vCPU / 8 GiB by default, 20 GiB `/data` ([llms.txt](https://instabox.sh/llms.txt)). Sizes go up to 8/16 on Pro and 32/64 on Team ([limits](https://instabox.sh/docs/account/limits.md)).
- macOS 26 Tahoe with Xcode runs on M2, M2 Pro, M4 or M4 Pro Macs, on the Pro plan and up ([macOS](https://instabox.sh/docs/machines/macos.md)). VM sizes: M2 8 vCPU / 12 GiB, M2 Pro 12 / 24, M4 10 / 12, M4 Pro 14 / 36, each with a 64 GiB disk ([screenshot](https://instabox.sh/changelog/images/2026-11-12-macos/create-machine-macos.webp)).
- The docs say one machine per Mac at full size ([macOS](https://instabox.sh/docs/machines/macos.md)). The API also describes an undocumented half-size mode with two VMs per Mac (unverified; [OpenAPI](https://api.instabox.sh/v1/openapi.json)). If it ships, the lessor would run two macOS VMs on each leased Mac, which Apple's Section 3D ("a single instance or copy of the Apple Software as a provisioning tool") doesn't allow on its face (this report's reading; see [licensing](#macos-licensing-the-24-hour-rule)).
- You can't choose a region, and data stays in the US ([storage](https://instabox.sh/docs/machines/storage.md), [terms](https://instabox.sh/terms)).

#### API and SDK

- The REST API has a public OpenAPI 3.1 spec (132 paths), workspace-scoped `ibk_` keys and long-polled operations ([OpenAPI](https://api.instabox.sh/v1/openapi.json)). Clients: Go CLI 0.8.289 (2026-11-17; 307 releases since 2026-10-13), TypeScript SDK 0.9.0 and Python SDK 0.5.5 ([npm](https://registry.npmjs.org/instabox), [npm](https://registry.npmjs.org/@insforge/instabox-sdk), [PyPI](https://pypi.org/project/instabox-sdk/)). The TypeScript SDK can't accept the Mac lease ([sizes](https://instabox.sh/docs/machines/sizes.md)).
- Quotas: machine starts per minute (30 on Pro) and 32 concurrent execs. No general rate limit is documented ([limits](https://instabox.sh/docs/account/limits.md)).
- It opened invite-only on 2026-10-14 ([launch](https://x.com/instabox_sh/status/2110471625150005511)). On 2026-10-22 it said the waitlist was "still long" but that "Pro users skip the waitlist entirely"; Macs need Pro anyway ([blog](https://instabox.sh/blog/workos.md)). The API still has an invite gate for free accounts (`403 invite_required`) ([OpenAPI](https://api.instabox.sh/v1/openapi.json)). Instabox's blog and changelog announce no exit from beta as of 2026-11-17 ([blog](https://instabox.sh/blog.md), [changelog](https://instabox.sh/changelog.md)); a 2026-11-12 social-media claim otherwise is unverified. The source code is closed ([GitHub](https://github.com/InsForge)).

#### Lifecycle

- `exec` is synchronous (600 s max), streams over SSE and takes up to 1 MiB of stdin ([OpenAPI](https://api.instabox.sh/v1/openapi.json)). Background jobs have no exec timeout ([limits](https://instabox.sh/docs/account/limits.md)).
- Pause keeps memory and processes, stop keeps disks, and in both states you pay only for disk ([lifecycle](https://instabox.sh/docs/machines/lifecycle.md), [pricing](https://instabox.sh/pricing.md)). A resume takes "about a second" (vendor claim; [blog](https://instabox.sh/blog/wake-on-use.md)).
- Idle pause defaults to 30 minutes; paid plans can set 5 to 30 minutes or turn it off. Paid plans have no run limit by default; Free runs last 120 to 480 minutes ([auto-pause](https://instabox.sh/docs/machines/auto-pause.md)).
- Snapshots are disk-only, can be taken live and are free; forks take seconds ([snapshots](https://instabox.sh/docs/machines/snapshots.md)). Nothing expires on its own, and a delete deadline can be set up to 24 hours ahead ([storage](https://instabox.sh/docs/machines/storage.md)).

#### Networking

- Ports get `https://<port>-<id>.instabox.tech` URLs, public or private (a cookie for browsers, `Bearer ibp_…` for scripts), up to 16 per machine ([ports](https://instabox.sh/docs/access/ports.md), [limits](https://instabox.sh/docs/account/limits.md)).
- SSH goes through a gateway with short-lived certificates or tokens. Agent forwarding and remote forwarding don't work ([OpenAPI](https://api.instabox.sh/v1/openapi.json)).
- No egress allowlist or static IP is documented. Port 25 is closed, and uploads slow to about 50 Mbit/s after 512 MiB ([llms-full](https://instabox.sh/llms-full.txt)).
- With Org Secrets, a proxy intercepts all HTTPS on port 443, and clients must trust its CA ([secrets](https://instabox.sh/docs/security/secrets.md)).

#### Fit for this plugin

- Headless tasks: `instabox agent prompt|events|steer` runs Claude Code or Codex as a background job. It is CLI-only, with no REST API ([CLI](https://instabox.sh/docs/reference/cli.md)). The plugin already shells out to boat's CLI ([boat-api.ts](../../src/boat-api.ts)).
- `port publish --private` replaces `boat host --private` ([from Boat](https://instabox.sh/docs/migrate/from-boat.md)), and `GET /v1/usage` returns plan limits and credit ([OpenAPI](https://api.instabox.sh/v1/openapi.json)).
- Task chats: bb's installer needs Node.js 22.19+ and, on systemd hosts, a systemd user session ([installer](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/assets/install-machine.sh)). bb bootstraps with one 600 s command fed by stdin ([bootstrap.ts](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/services/machines/bootstrap.ts)). Instabox ships Node.js 22.23.3 ([limits](https://instabox.sh/docs/account/limits.md)) and has the same 600 s cap, so the daemon looks feasible (untested). The plugin bootstraps over `boat ssh` ([machine.ts](../../src/machine.ts)), and `instabox ssh` is the equivalent ([CLI](https://instabox.sh/docs/reference/cli.md)).
- The idle checks don't list a daemon's WebSocket as activity. On a paid plan, turn idle pause off or renew activity leases; the Terms ban keep-alive tricks on Free ([auto-pause](https://instabox.sh/docs/machines/auto-pause.md), [terms](https://instabox.sh/terms)). systemd units don't get the Secrets CA variables, so a daemon in a machine enrolled in Org Secrets may fail TLS (inferred; [secrets](https://instabox.sh/docs/security/secrets.md)).
- Secrets: there are no named environments, env is fixed at create, proxy Secrets are scoped to hosts, and direct Secrets arrive as variables ([from Boat](https://instabox.sh/docs/migrate/from-boat.md), [direct Secrets](https://instabox.sh/docs/security/direct-secrets.md)). For GitHub, store a token Secret for `github.com` and `api.github.com`, then run `gh auth setup-git` ([secrets](https://instabox.sh/docs/security/secrets.md)).
- bb has no Instabox code. Its Modal plugin's `SandboxBackend` interface is the template for adding a vendor ([bb](https://github.com/get-bb/bb/tree/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers)).

#### Mac specifics

- Apple's rule is enforced as a lease: one workspace holds a whole Mac for at least 24 hours, and a create without `acceptMinimumLease` fails ([macOS](https://instabox.sh/docs/machines/macos.md)).
- A stop inside the minimum waits until the minimum ends, unless you pass `--now`. New VMs reuse a live lease. Macs can't pause, and if no Mac is free the create fails with `503 no_capacity` ([macOS](https://instabox.sh/docs/machines/macos.md)). The Terms don't mention Apple ([terms](https://instabox.sh/terms)).
- The user is `admin` with password `admin`, and sudo doesn't prompt. SSH, exec and a desktop work ([macOS](https://instabox.sh/docs/machines/macos.md)), and the screen is reachable over a VNC WebSocket API ([OpenAPI](https://api.instabox.sh/v1/openapi.json)).
- Not documented: the Xcode version, Simulator runtimes, signing and keychain, Screen Recording, and whether ports, Secrets and the agent runner work on macOS. Running `safaridriver --enable` turns on Safari automation ([Apple](https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari)), and passwordless sudo should allow it (untested).

#### Windows

The homepage lists Windows ([homepage](https://instabox.sh/)), and the API models `windows` host-pool templates with a VNC desktop ([OpenAPI](https://api.instabox.sh/v1/openapi.json)). CLI 0.8.289 lists `windows` as a restricted admin template ([npm tarball](https://registry.npmjs.org/instabox/-/instabox-0.8.289.tgz)). No public template, edition, RDP support, size, price or date exists, so Windows is listed but not launched or documented.

#### Cross-platform testing fit

- Linux suits throwaway runs: billing is per second, and `instabox run` creates a machine, runs the command and deletes the machine ([run commands](https://instabox.sh/docs/machines/run-commands.md)). `agent-browser` has Chromium, and `ci` has the tools of GitHub's ubuntu-24.04 image except Edge ([limits](https://instabox.sh/docs/account/limits.md), [CI](https://instabox.sh/docs/use-cases/ci.md)). No recording feature is documented.
- Macs are poor throwaway runners: `instabox run --template macos` deletes the VM but bills the full 24 hours ([npm tarball](https://registry.npmjs.org/instabox/-/instabox-0.8.289.tgz)). Hold one lease and reuse it.
- Windows: n/a.

#### Pricing and example costs

| Item | Price | Billing | Source |
|---|---|---|---|
| Pro / Builder / Team | $20 / $100 / $500 a month | fee returns as usage credit | [pricing](https://instabox.sh/pricing.md) |
| vCPU | $0.004 per vCPU-hour | per second while running, allocated | [pricing](https://instabox.sh/pricing.md) |
| Memory | $0.00225 per GiB-hour | per second while running | [pricing](https://instabox.sh/pricing.md) |
| Disk beyond included | $0.08 per GiB-month | 200 GiB (Pro) to 5 TiB (Team) included | [pricing](https://instabox.sh/pricing.md) |
| Snapshots | free | n/a | [pricing](https://instabox.sh/pricing.md) |
| Egress | $0.02 per GiB | after 100 GiB to 50 TiB a month | [pricing](https://instabox.sh/pricing.md) |
| M2 / M4 | $0.45 / $0.75 per Mac-hour | 24 h minimum ($10.80 / $18.00), then per second | [pricing](https://instabox.sh/pricing.md) |
| M2 Pro / M4 Pro | $0.85 / $1.25 per Mac-hour | 24 h minimum ($20.40 / $30.00) | [pricing](https://instabox.sh/pricing.md) |

Owner-supplied figures (per Mac-hour, vCPU and memory included): M2 $0.45 confirmed; M2 Pro $0.85 confirmed; M4 $0.75 confirmed; M4 Pro $1.25 confirmed ([macOS](https://instabox.sh/docs/machines/macos.md)).

- Linux 2 h, 4 vCPU / 8 GiB: (4 × $0.004 + 8 × $0.00225) × 2 = $0.068. Billing is by allocation, so 10% and 100% CPU cost the same.
- Mac 2 h: two hours is under the minimum, so M2 (12 GiB; Simulator support unverified) costs 24 × $0.45 = $10.80. No 16 GiB size exists; M2 Pro (24 GiB) costs 24 × $0.85 = $20.40.
- Always-on Mac, 730 h: M2 730 × $0.45 = $328.50; M2 Pro 730 × $0.85 = $620.50. Add the $20 Pro fee, which returns as credit.
- Mac test, 5 min: a new M2 lease costs $10.80; runs inside a lease you already hold add nothing.
- Windows test, 5 min: n/a. For comparison, a 5-minute Linux run costs $0.034 × 5/60 = $0.0028.

#### Trust and security

- InsForge AI, Inc. is a Delaware corporation ([terms](https://instabox.sh/terms)) in YC's Spring 2026 batch, with six people in San Francisco ([YC](https://www.ycombinator.com/companies/instabox)).
- Machines run in AWS us-west-2 and on Latitude.sh bare metal ([sub-processors](https://instabox.sh/subprocessors)). Each is a VM with its own kernel ([privacy](https://instabox.sh/privacy)), on hosts the company oversubscribes ([blog](https://instabox.sh/blog/instabox-pricing.md)).
- Instabox doesn't say where the Macs run. The models match AWS EC2 Mac ([AWS](https://aws.amazon.com/ec2/instance-types/mac/)), but Instabox charges about half of AWS's on-demand M2 and M2 Pro host rates ($0.878 and $1.56 an hour; [AWS prices](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/dedicatedhost-ondemand.json)), so the host is unconfirmed. The privacy policy and the sub-processor list were last updated on 2026-11-09, three days before the Mac launch, and name only AWS us-west-2 and Latitude.sh ([privacy](https://instabox.sh/privacy), [sub-processors](https://instabox.sh/subprocessors)). Ask Instabox where the Macs run.
- Data is encrypted in transit (TLS) and at rest, and Secrets use AES-256-GCM ([privacy](https://instabox.sh/privacy)). InsForge says it passed a SOC 2 Type II audit and offers a BAA on request, but doesn't say whether the audit covers Instabox. No ISO 27001 claim or customer DPA was found ([trust center](https://instabox.sh/blog/trust-center.md)).
- After an account is deleted, its data leaves active systems within 30 days, and backups are overwritten within 90 days ([privacy](https://instabox.sh/privacy)). Exec history keeps the first 64 KiB of each output stream, so bootstrap calls should set `noHistory` ([OpenAPI](https://api.instabox.sh/v1/openapi.json)).
- Proxy Secrets keep GitHub tokens and AI keys out of the VM, but the proxy sees that traffic. Snapshots carry saved sign-ins to every workspace member ([secrets](https://instabox.sh/docs/security/secrets.md), [snapshots](https://instabox.sh/docs/machines/snapshots.md)).

#### Risks

- Young: founded in 2025 ([YC](https://www.ycombinator.com/companies/instabox)) and launched 2026-10-14. InsForge's CEO self-reported an $8M seed for InstaCloud, InsForge's agent cloud service, and named no investors (unverified; [RuntimeWire](https://runtimewire.com/article/instacloud-8m-seed-agent-cloud)).
- The status page lists 10 incidents from 2026-11-15 to 2026-11-17, each lasting 1 to 13 minutes ([status](https://statuspage.incident.io/instabox/history)).
- Churn: the CLI had 307 releases in five weeks, and the docs disagree on macOS env and the SDK version ([llms-full](https://instabox.sh/llms-full.txt), [SDK docs](https://instabox.sh/docs/reference/sdk.md)).
- The Terms allow AI-agent use but forbid reselling, make the customer liable for agents' actions and charges, and allow price changes on 30 days' notice ([terms](https://instabox.sh/terms)). Each plugin user should bring their own account.
- Lock-in: the API is proprietary, bulk export works only for paused or disabled workspaces ([OpenAPI](https://api.instabox.sh/v1/openapi.json)), and hosting is US-only.

### Darkbloom

Darkbloom (Eigen Labs) rents invitation-only, experimental Linux and macOS VMs on Apple silicon Macs owned by people in its network ([overview](https://docs.darkbloom.dev/sandboxes/overview), [introduction](https://docs.darkbloom.dev/introduction)). Prices are low and billed per second. But there is no documented API, no inbound networking, a 24-hour cap per boot and no Windows, and Darkbloom makes no confidentiality claim against the Mac's owner ([pricing](https://docs.darkbloom.dev/sandboxes/pricing), [security](https://docs.darkbloom.dev/sandboxes/security)). It does not fit credential-bearing agent work today.

#### OS and hardware

- Linux images are Ubuntu with git, compilers, Python and Node. macOS images have Xcode and Homebrew and are experimental. All images are arm64, and Linux has no GPU ([overview](https://docs.darkbloom.dev/sandboxes/overview)).
- Linux sizes run from c4-m8 (4 vCPU, 8 GiB, 32 GiB workspace) to c32-m128. macOS sizes run from mac-c4-m8 to mac-c8-m32 (8 vCPU, 32 GiB) ([pricing](https://docs.darkbloom.dev/sandboxes/pricing)). The host docs list only "the 4 to 12 vCPU sizes a provider Mac hosts," so it is unclear who runs the larger sizes ([hosting](https://docs.darkbloom.dev/provider/sandbox-hosting)).
- A macOS sandbox is always a VM, and a host runs at most two, "the kernel's limit" ([setup](https://docs.darkbloom.dev/provider/sandbox-setup)). Hosts need macOS 27 and an always-on, logged-in desktop, and macOS hosts need at least 16 cores and 64 GB ([hosting](https://docs.darkbloom.dev/provider/sandbox-hosting)).
- You can't choose a region or chip ([connect](https://docs.darkbloom.dev/sandboxes/create-and-connect)). At 05:53 UTC on 2026-11-17, the public stats listed 1,124 active inference providers (M1 to M6). That field counts connections: at 06:48 UTC only 954 were identified unique machines. Sandbox hosts aren't counted separately ([stats](https://api.darkbloom.dev/v1/stats)).

#### API and SDK

A web console can stop sandboxes but can't resume them ([lifecycle](https://docs.darkbloom.dev/sandboxes/lifecycle)). Otherwise the only interface is the proprietary `darkbloom-sandbox-cli`, for Apple silicon Macs and Linux, which "your Darkbloom contact sends you" until an installer is served ([quickstart](https://docs.darkbloom.dev/sandboxes/quickstart)). Automation uses `--json` output or a stdio MCP server with 12 tools. The docs have no REST reference or SDK ([MCP](https://docs.darkbloom.dev/sandboxes/mcp-tools), [index](https://docs.darkbloom.dev/llms.txt)). API keys (`dbx_sk_…`) last 90 days by default ([quickstart](https://docs.darkbloom.dev/sandboxes/quickstart)). Each platform needs its own grant, and until then "the sandbox API answers as if it did not exist" ([overview](https://docs.darkbloom.dev/sandboxes/overview)). The default limits are 2 running sandboxes and 256 GiB of workspaces, and starts are limited to "10 at once, then 1 a minute" ([limits](https://docs.darkbloom.dev/sandboxes/limits-and-billing)).

#### Lifecycle

- Commands run over SSH, with stdin and stdout piped ([connect](https://docs.darkbloom.dev/sandboxes/create-and-connect)).
- The idle stop (15 minutes by default, settable from 5 to 120) triggers when no client is attached and there is no traffic. "Work left running inside does not count" ([lifecycle](https://docs.darkbloom.dev/sandboxes/lifecycle)). Each boot ends after 240 minutes by default, or 1,440 at most ([connect](https://docs.darkbloom.dev/sandboxes/create-and-connect)).
- Only the workspace persists. Darkbloom pins the image, and the docs describe no snapshots ([lifecycle](https://docs.darkbloom.dev/sandboxes/lifecycle)).
- The workspace lives on one Mac and "is not backed up." If that Mac leaves the fleet, the workspace is lost. Stopped sandboxes are deleted after 30 days ([lifecycle](https://docs.darkbloom.dev/sandboxes/lifecycle)).
- Boot times are not published, and finding a Mac can take up to 5 minutes ([troubleshooting](https://docs.darkbloom.dev/sandboxes/troubleshooting)).

#### Networking

"A sandbox has no inbound ports and no public address," and the docs offer no preview URLs or static IPs ([overview](https://docs.darkbloom.dev/sandboxes/overview)). Egress is HTTPS on port 443 only, through a proxy (`127.0.0.1:3128`) with no DNS. It reaches a preset list, or at most 64 exact hostnames, fixed at create ([connect](https://docs.darkbloom.dev/sandboxes/create-and-connect), [quickstart](https://docs.darkbloom.dev/sandboxes/quickstart)). SSH runs through the CLI. Linux allows local port forwards, and macOS allows none ([connect](https://docs.darkbloom.dev/sandboxes/create-and-connect)).

#### Fit for this plugin

- bb has no Darkbloom support. Its sandbox environment plugin is for Modal ([bb](https://github.com/get-bb/bb/tree/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox)).
- Codex comes in the image with a `codex` runner (`--json` events, `--thread`). Claude Code gets only an `anthropic` egress set and a skill file ([agents](https://docs.darkbloom.dev/sandboxes/agents-and-mcp), [connect](https://docs.darkbloom.dev/sandboxes/create-and-connect)).
- bb's daemon could be installed over SSH with stdin. But bb turns on Node's env proxy only for `http://` or `https://` values ([node-network.ts](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/packages/process-utils/src/node-network.ts)), and Darkbloom shows the proxy without a scheme. It is also unknown whether daemon heartbeats prevent the idle stop (unverified; testing needs an account).
- There are no previews, snapshots, environments or plan-limit reads. Evidence would have to come back over SSH or go to an allowlisted bucket hostname (inferred). Secrets are files that last one boot (at most 32, up to 64 KiB each) ([security](https://docs.darkbloom.dev/sandboxes/security)). Only the machine that created a sandbox can reach it ([connect](https://docs.darkbloom.dev/sandboxes/create-and-connect)).

#### Mac specifics

- The docs don't state the sandbox Xcode version. The CI image pins Xcode 27.2 ([images](https://docs.darkbloom.dev/ci/runner-images)).
- The iOS Simulator, Safari, safaridriver, code signing, the keychain and sudo are not documented (unverified; checking needs an account). A Nov 9, 2026 release note says downloads from developer.apple.com through the sandbox egress "ended early" ([changelog](https://github.com/Layr-Labs/d-inference/blob/master/CHANGELOG.md)).
- A VNC desktop exists only if you choose one at create. The desktop locks after 20 minutes without input unless the CLI turns the lock off. `cua run` saves screenshots ([connect](https://docs.darkbloom.dev/sandboxes/create-and-connect), [agents](https://docs.darkbloom.dev/sandboxes/agents-and-mcp)).
- Darkbloom says nothing about Apple's 24-hour rule and bills per second ([pricing](https://docs.darkbloom.dev/sandboxes/pricing)). Apple's macOS 27 license (July 11, 2026) allows leases only for CI-style "Permitted Developer Services." Each lease must last at least "twenty-four (24) consecutive hours," with exclusive use and advance notice to Apple. Otherwise it allows macOS VMs only on Macs "you own or control," for listed purposes ([Apple](https://www.apple.com/legal/sla/docs/macOS27.pdf)). Darkbloom's terms make "no representation that provider participation is permitted" ([terms](https://www.darkbloom.ai/terms)). Its Aug 2026 plan required a legal sign-off, and whether it happened is not public ([plan](https://github.com/Layr-Labs/d-inference/blob/6575e0f32dbc8eac366cbe9fc37a1ac0af1c550d/docs/reports/2026-08-22-sandbox-platform-plan.md)). This is not legal advice.

#### Windows

None. Hosts are Apple silicon Macs only, and no Windows plans appear ([hosting](https://docs.darkbloom.dev/provider/sandbox-hosting), [terms](https://www.darkbloom.ai/terms)).

#### Cross-platform testing fit

Startup is free, billing is per second with a one-minute minimum, and `--ephemeral` deletes the workspace when the sandbox ends ([pricing](https://docs.darkbloom.dev/sandboxes/pricing), [connect](https://docs.darkbloom.dev/sandboxes/create-and-connect)). But macOS creates can fail with `no_capacity`, and only 2 sandboxes run at once by default. The preview must be HTTPS on port 443 at an allowlisted hostname, and no browsers are documented ([quickstart](https://docs.darkbloom.dev/sandboxes/quickstart), [limits](https://docs.darkbloom.dev/sandboxes/limits-and-billing), [connect](https://docs.darkbloom.dev/sandboxes/create-and-connect)). CI macOS VMs get a paravirtualized Metal GPU, but the docs don't say whether macOS sandboxes do ([images](https://docs.darkbloom.dev/ci/runner-images)). Darkbloom warns that a host Mac "can also alter a job's results" ([CI](https://docs.darkbloom.dev/ci/security)).

#### Pricing and example costs

| Item | Price | Billing | Source |
| - | - | - | - |
| Linux formula | $0.032/vCPU-h + $0.008/GiB-h | Per second from ready, 1-minute minimum per charge | [pricing](https://docs.darkbloom.dev/sandboxes/pricing) |
| Linux c4-m8 / c8-m32 | $0.192 / $0.512 per h | Same | [pricing](https://docs.darkbloom.dev/sandboxes/pricing) |
| Linux c4-m16 to c32-m128 | $0.256 to $2.048 per h | Same | [pricing](https://docs.darkbloom.dev/sandboxes/pricing) |
| mac-c4-m8, mac-c4-m16, mac-c8-m16, mac-c8-m32 | $0.35, $0.45, $0.70, $0.90 per h | Same | [pricing](https://docs.darkbloom.dev/sandboxes/pricing) |
| Balance hold | 1 hour at the size's price | Each boot-hour, settled to seconds used | [pricing](https://docs.darkbloom.dev/sandboxes/pricing) |
| Startup, stopped sandbox | $0 | Workspace deleted after 30 days stopped | [pricing](https://docs.darkbloom.dev/sandboxes/pricing) |
| Plan fees; egress | None; none listed | Prepaid, $0.50 minimum deposit | [billing](https://docs.darkbloom.dev/billing/pricing), [accounts](https://docs.darkbloom.dev/get-started/accounts-and-consoles) |

Owner-supplied figures:

- The Linux formula, c8-m32 at $0.512 and the four macOS prices: **confirmed** ([pricing](https://docs.darkbloom.dev/sandboxes/pricing)).
- "Around 1,100 Macs": **confirmed** as an inference count: 1,124 active inference providers, a count of connections, with 954 identified unique machines an hour later. The homepage counter (1,231) appears stale ([stats](https://api.darkbloom.dev/v1/stats)).
- "Private beta": **close**. Sandboxes are "experimental and open by invitation", for Linux too, and serve "accounts on Darkbloom's alpha list": a private alpha rather than a beta. The "public alpha" label in the terms covers inference only ([overview](https://docs.darkbloom.dev/sandboxes/overview), [hosting](https://docs.darkbloom.dev/provider/sandbox-hosting), [terms](https://www.darkbloom.ai/terms)).

Example costs. Darkbloom bills by size, not CPU use ([pricing](https://docs.darkbloom.dev/sandboxes/pricing)).

- Linux 2 h, c4-m8: 4 × $0.032 + 8 × $0.008 = $0.192/h, and 2 × $0.192 = **$0.384**, the same at 10% and at 100% CPU. Reference c8-m32: 2 × $0.512 = **$1.024**.
- Mac 2 h: mac-c4-m8 is 2 × $0.35 = **$0.70**. The 16 GiB option, mac-c4-m16, is 2 × $0.45 = **$0.90**.
- Always-on Mac, 730 h: 730 × $0.35 = **$255.50**, or 730 × $0.45 = **$328.50**. This takes at least 31 boots (730 / 24 = 30.4).
- Mac test, 5 minutes: 5/60 × $0.35 = **$0.029** (16 GiB: $0.0375). That is above the minimum, and a $0.35 hold comes first.
- Windows test, 5 minutes: **n/a**.

#### Trust and security

- Approved third parties own the Macs and earn 90% of each charge ([hosting](https://docs.darkbloom.dev/provider/sandbox-hosting)).
- Each sandbox is an Apple Virtualization framework VM with "no network card and no shared folders." Its traffic is tunneled to Darkbloom's gateway ([hosting](https://docs.darkbloom.dev/provider/sandbox-hosting)).
- The CLI checks a boot statement signed with an App Attest key ([security](https://docs.darkbloom.dev/sandboxes/security)). App Attest validates "the instance of your app running on a device" ([Apple](https://developer.apple.com/documentation/devicecheck/dcappattestservice)). It does not show that the owner is locked out (inferred).
- Darkbloom states: "Darkbloom can decrypt your workspace, and agent sandboxes do not yet claim confidentiality from the owner of the Mac they run on" ([security](https://docs.darkbloom.dev/sandboxes/security)). The owner could corrupt or roll back parts of the workspace without the sandbox noticing. With SIP off, "an administrator can read a running VM's memory" ([security](https://docs.darkbloom.dev/sandboxes/security), [hosting](https://docs.darkbloom.dev/provider/sandbox-hosting)).
- The CI docs say to "Assume everything inside the job" is visible to the owner ([CI](https://docs.darkbloom.dev/ci/security)). The Aug 2026 plan said the host "can still inspect or interpose on the session" ([plan](https://github.com/Layr-Labs/d-inference/blob/6575e0f32dbc8eac366cbe9fc37a1ac0af1c550d/docs/reports/2026-08-22-sandbox-platform-plan.md)).
- Beyond the VM boundary, protection from owners is contractual: the terms bind providers to keep SIP and Secure Boot on and not to inspect customer content ([terms](https://www.darkbloom.ai/terms)). Those terms describe inference, so whether they cover sandbox hosts is unconfirmed. The host add-on is "closed-source" ([threat model](https://github.com/Layr-Labs/d-inference/blob/master/docs/threat-model.yaml)).
- Darkbloom keeps gateway byte counts for 90 days and logs hostnames and client IPs ([security](https://docs.darkbloom.dev/sandboxes/security)). It publishes no SOC 2, ISO 27001, HIPAA or DPA ([privacy](https://www.darkbloom.ai/privacy)).
- For agents, treat GitHub tokens, Claude and Codex logins and bb machine credentials as exposed to the owner and to Darkbloom. Push code over SSH, as Darkbloom advises ([quickstart](https://docs.darkbloom.dev/sandboxes/quickstart)).

#### Risks

- Eigen Labs, the EigenLayer developer, raised a $100M Series B in February 2024 (old source) ([Latham & Watkins](https://www.lw.com/en/news/2024/02/latham-watkins-advises-eigenlabs-in-us100-million-series-b)). Darkbloom launched as a research preview on April 15, 2026 ([launch](https://www.eigenlabs.org/blog/project-darkbloom-unlocking-idle-compute-for-ai/)).
- On Oct 30, 2026, The Register reported low payouts and a shift toward CI ([The Register](https://www.theregister.com/ai-and-ml/2026/10/30/darkbloom-which-allowed-mac-users-to-rent-out-their-gpus-for-ai-inference-warns-of-low-payouts/5306782)). Host-side sandbox support, first for CI jobs, was merged on Oct 28, 2026 ([PR #1655](https://github.com/Layr-Labs/d-inference/pull/1655)).
- The Aug 28, 2026 terms cover only inference, which they call a "public alpha." They offer no SLA, cap liability at USD $100 and limit use to "internal business or personal use" ([terms](https://www.darkbloom.ai/terms)). The status page says it "will return in the future" ([status](https://status.darkbloom.dev/)).
- Owners can pause their Macs or put them on a schedule at any time ([setup](https://docs.darkbloom.dev/provider/sandbox-setup)). Lock-in is low (SSH, git), but integration depends on a CLI sent by hand ([quickstart](https://docs.darkbloom.dev/sandboxes/quickstart)).

### Modal

Modal Sandboxes are self-serve, per-second-billed Linux containers or VMs, driven only through Modal's SDKs ([guide](https://modal.com/docs/guide/sandboxes), [maturity](https://modal.com/docs/guide/feature-maturity)). They suit Linux agent work (bb already ships a Modal machine provider) and Linux-only browser runs ([bb](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/README.md)). Modal has no macOS or Windows and has announced neither, so it can't serve Mac or Windows agents, or the Mac and Windows half of the browser testing ([changelog](https://modal.com/changelog)).

#### OS and hardware

- Linux only, under gVisor or in a KVM virtual machine ([networking](https://modal.com/docs/guide/sandbox-networking)). VM sandboxes went GA on Oct 1, 2026 ([changelog](https://modal.com/changelog/give-agents-a-full-computer-with-vm-sandboxes)).
- x86-64 only: registry images must be `linux/amd64` ([Image](https://modal.com/docs/sdk/py/latest/Image)). Arm (NVIDIA Vera) is planned, with no date ([blog, Oct 19, 2026](https://modal.com/blog/nvidia-vera-sandboxes)).
- There are no fixed sizes. You request physical cores (1 core = 2 vCPU) and MiB, by default 0.125 core and 128 MiB, and sandboxes burst above that ([resources](https://modal.com/docs/guide/sandbox-resources)). The maximum request is not published ([limits](https://modal.com/docs/guide/resources)). 4 vCPU / 8 GiB is `cpu=2, memory=8192`.
- Disk is capped at 512 GiB and cannot be raised ([resources](https://modal.com/docs/guide/sandbox-resources)). Pinning a region costs 1.15x (broad) or 1.75x (narrow) ([regions](https://modal.com/docs/guide/region-selection)).

#### API and SDK

- There is no documented REST API; only the official SDKs are stable ([maturity](https://modal.com/docs/guide/feature-maturity)). Python is the primary SDK (1.6.4, Nov 11, 2026). The JS/TS `modal` package (Node 22+) and the Go SDK are Beta and pre-1.0, and their minor releases can break APIs ([SDKs](https://modal.com/docs/guide/sdk-javascript-go), [notes](https://modal.com/docs/sdk/py/releases), [README](https://github.com/modal-labs/modal-client/tree/main/js), [releases](https://modal.com/docs/sdk/js/releases)).
- The JS release notes list 0.11.2 (Nov 16, 2026), but the npm `latest` tag is still 0.11.1 ([npm](https://registry.npmjs.org/modal)).
- Auth is a token ID and secret, and tokens can be given an expiry since Sep 28, 2026 ([changelog](https://modal.com/changelog/set-expiration-times-for-api-and-service-user-tokens)). Service users need Team or Enterprise ([users](https://modal.com/docs/guide/service-users)). No numeric rate limits are published. Concurrency is capped at 100 containers on Starter and 5,000 on Team ([pricing](https://modal.com/pricing)).

#### Lifecycle

- `create` blocks until the sandbox is scheduled, or raises `ResourceExhaustedError` ([notes](https://modal.com/docs/sdk/py/releases)). `exec` streams output, takes stdin, supports a PTY and has no default timeout ([reference](https://modal.com/docs/sdk/js/latest/Sandbox)). Output stays readable for 10 minutes after a command ends, and no API to reattach to a running exec is documented ([exec](https://modal.com/docs/guide/sandbox-spawn)). Background processes survive between execs ([bb](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/README.md)).
- Lifetime is at most 24 hours (default 5 minutes), and Modal recommends snapshotting into a new sandbox ([guide](https://modal.com/docs/guide/sandboxes)). `idle_timeout` counts only running execs, stdin writes and open tunnel connections as activity ([guide](https://modal.com/docs/guide/sandboxes)), so a daemon's outbound connection would not keep a sandbox alive (inferred).
- There is no pause or resume. Filesystem and directory snapshots are Images, kept 30 days by default or indefinitely. Memory snapshots are Alpha: they terminate the sandbox and expire after 7 days ([snapshots](https://modal.com/docs/guide/sandbox-snapshots)). Exit snapshots (Beta, Oct 27, 2026) save the filesystem on terminate, idle timeout, lifetime expiry and OOM, with no durability guarantee ([docs](https://modal.com/docs/guide/sandbox-exit-snapshots)).
- Modal claims a median start under 0.5 s ([blog, Jul 16, 2026](https://modal.com/blog/scaling-to-1-million-concurrent-sandboxes-in-seconds)). ComputeSDK measured a 549 ms median on Aug 7, 2026 ([sequential](https://github.com/computesdk/benchmarks/blob/master/results/sequential_tti/latest.json)), and medians of 750 to 940 ms for 100 concurrent creates from Oct 16 to Nov 6. Its Nov 13 run failed at the same time as a Modal incident ([burst](https://github.com/computesdk/benchmarks/tree/master/results/burst_tti), [status](https://status.modal.com/)).

#### Networking

- Inbound traffic is blocked by default ([networking](https://modal.com/docs/guide/sandbox-networking)). Ports are exposed as tunnels declared at create time, with random but public URLs ([tunnels](https://modal.com/docs/guide/tunnels)). Connect Tokens give token-gated HTTP and WebSocket access to any port, and `inbound_cidr_allowlist` covers them and encrypted tunnels ([networking](https://modal.com/docs/guide/sandbox-networking)).
- There is no managed SSH. You can run sshd behind an unencrypted TCP tunnel, which is open to any IP, or use `modal shell` ([tunnels](https://modal.com/docs/guide/tunnels), [networking](https://modal.com/docs/guide/sandbox-networking), [CLI](https://modal.com/docs/cli/latest/shell)).
- Outbound traffic is open by default. Controls are `block_network`, a CIDR allowlist and a Beta domain allowlist, and DNS is not filtered unless all traffic is blocked ([networking](https://modal.com/docs/guide/sandbox-networking)). Static IPs need Proxies (Beta, Team and up) ([proxies](https://modal.com/docs/guide/proxy-ips)).

#### Fit for this plugin

- Task chats already work: bb's official "Modal Sandbox [Experimental]" plugin (bb 0.43.0 and later) runs them. It creates one named 24-hour sandbox per machine, with 1 core and 2 GiB by default, from an image with Claude Code and Codex ([README](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/README.md), [config](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/configuration.ts#L48-L49), [changelog](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/CHANGELOG.md)). bb core installs its daemon through exec, with the enrollment JSON on stdin ([bootstrap](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/services/machines/bootstrap.ts)), and the installer starts the daemon with `nohup` ([installer](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/assets/install-machine.sh#L274)).
- After 15 idle minutes (the default), the plugin snapshots a machine's filesystem with no expiry and terminates the sandbox. Resume restores the snapshot into a new sandbox with the same host identity ([server](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/server.ts#L118), [backend](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers/modal/backend.ts#L315-L359)). Nothing is saved before the 24-hour expiry ([README](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/README.md)). Exit snapshots could close that gap (inferred).
- bb exposes this provider through `hosts.experimental_create` ([README](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/README.md)), so this plugin could reuse it instead of writing its own Modal adapter (inferred). bb pins `modal` 0.10.1 and calls Modal's internal gRPC API ([package](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/package.json), [client](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers/modal/client.ts#L196)), which Modal says is use-at-your-own-risk ([maturity](https://modal.com/docs/guide/feature-maturity)).
- Modal documents no agent runner, steering or agent logins, so headless tasks need a runner in the plugin. Modal's example runs `claude -p` through exec with a PTY and an `ANTHROPIC_API_KEY` Secret ([example](https://github.com/modal-labs/modal-client/blob/main/js/examples/sandbox-agent.ts)).
- Secrets can be passed as env vars, Modal Secrets, per-exec env vars, files or an OIDC token ([reference](https://modal.com/docs/sdk/py/latest/Sandbox)). Beta Outbound Policies keep keys outside the sandbox, but only over HTTP/1.1 and only from named Secrets ([injection](https://modal.com/docs/guide/sandbox-secret-injection)). Modal documents no GitHub integration. bb core passes `GH_TOKEN` from the bb server's `gh` login to machines ([credentials](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/services/machines/git-credentials.ts)).
- `boat host --private` maps to Connect Tokens, and evidence uploads can use the open outbound network (inferred). No documented API returns plan limits. Python's `app.sandboxes.stats()` reports cost by tag ([App](https://modal.com/docs/sdk/py/latest/App)).

#### Mac specifics

Modal has no macOS or Apple hardware, so there is no Xcode, iOS Simulator, keychain signing, GUI session, Safari or safaridriver ([Image](https://modal.com/docs/sdk/py/latest/Image)). Apple's 24-hour minimum-lease rule does not apply, and the docs never mention macOS ([docs](https://modal.com/llms-full.txt)).

#### Windows

There are no Windows sandboxes, and none are announced in the docs, the Sep to Nov 2026 changelog or the blog ([changelog](https://modal.com/changelog)). Edition, sizes, prices and RDP are n/a.

#### Cross-platform testing fit

Modal works well as a short-lived Linux runner: it bills per second with no minimum increment ([billing](https://modal.com/docs/guide/billing)). Its example runs Playwright's Chromium headed on Xvfb ([example](https://modal.com/docs/examples/computer_use_vnc)). It cannot run Safari on macOS or Edge and Chrome on Windows, which is what the owner needs.

#### Pricing and example costs

| Item | Price | Billing | Source |
|---|---|---|---|
| Sandbox CPU | $0.00003942 per physical core-second ($0.1419/h; 1 core = 2 vCPU) | Per second on max(request, usage); minimum 0.125 core; 3x the Function rate | [pricing](https://modal.com/pricing), [product](https://modal.com/products/sandboxes) |
| Sandbox memory | $0.00000667 per GiB-second ($0.0240/h) | Same; minimum 128 MiB | [pricing](https://modal.com/pricing), [product](https://modal.com/products/sandboxes) |
| Starter | $0/month, $30 credit, 3 seats | Card required | [pricing](https://modal.com/pricing), [billing](https://modal.com/docs/guide/billing) |
| Team | $250/month, $100 credit | Monthly | [pricing](https://modal.com/pricing) |
| Region pinning | 1.15x or 1.75x | Multiplier | [regions](https://modal.com/docs/guide/region-selection) |
| Egress | $0.04/GiB beyond 1 TiB (Starter) or 10 TiB (Team) | Since Oct 1, 2026 | [egress](https://modal.com/docs/guide/network-egress-billing) |
| Volumes | $0.09/GiB-month, 1 TiB free | Monthly | [pricing](https://modal.com/pricing) |
| Snapshot storage | Not published (unverified; ask Modal) | n/a | [security](https://modal.com/docs/guide/security) |

The 24-hour maximum sandbox lifetime is confirmed ([guide](https://modal.com/docs/guide/sandboxes)).

The examples use 2 h = 7,200 s and 4 vCPU = 2 cores:

| Scenario | Math | Cost |
|---|---|---|
| Linux 2 h, 2 cores and 8 GiB reserved (any CPU use; also the bursting high case) | 2 × 7,200 × $0.00003942 = $0.5676; 8 × 7,200 × $0.00000667 = $0.3842 | $0.95 |
| Linux 2 h, 8 GiB reserved, CPU bursting, low case (10% = 0.2 core) | 0.2 × 7,200 × $0.00003942 = $0.0568, plus $0.3842 | $0.44 |
| Linux 2 h, everything bursting, low case, 2 GiB average RAM (assumed) | $0.0568 + 2 × 7,200 × $0.00000667 ($0.0960) | $0.15 |
| Mac 2 h, 16 GB Mac, always-on Mac (730 h), Mac or Windows test (5 min) | No macOS or Windows | n/a |
| Reference: Linux browser test, 5 min, 1 core and 4 GiB | 300 × $0.00003942 = $0.0118; 4 × 300 × $0.00000667 = $0.0080 | $0.02 |

Spiky use raises the low case. If 90% of seconds sit at the 0.125-core floor and 10% use 2 cores, billing averages 0.3125 core, or $0.0887 of CPU. An always-on Linux box with 2 cores and 8 GiB costs 2 × 2,628,000 × $0.00003942 + 8 × 2,628,000 × $0.00000667 = $207.19 + $140.23 = $347.42 for 730 hours. Because of the 24-hour cap, that takes at least 31 chained sandboxes.

#### Trust and security

- Modal runs no physical servers of its own ([DPA, Oct 31, 2025](https://modal.com/legal/dpa)). Its capacity comes from AWS, GCP, Azure and OCI ([blog, Dec 28, 2025](https://modal.com/blog/gpu-health)), in a pool spanning 20+ clouds ([blog, Oct 14, 2026](https://modal.com/blog/1-billion-annualized-run-rate-series-d)).
- Each sandbox runs under gVisor or in a KVM VM ([networking](https://modal.com/docs/guide/sandbox-networking)), on hosts shared with other customers ([blog, Nov 12, 2026](https://modal.com/blog/sandbox-bursting)).
- Modal provides a SOC 2 Type II report, a GDPR DPA, HIPAA on Enterprise, TLS 1.3 and encryption at rest. It makes no ISO 27001 claim ([security](https://modal.com/docs/guide/security)). Snapshots, Images, Secrets and logs are stored in the US ([residency](https://modal.com/docs/guide/data-residency)).
- Customer data is "expunged promptly following completion of processing", and an account is deleted within 60 days of termination ([terms](https://modal.com/legal/terms)). How long exec output and logs are kept is not stated (unverified).
- Any process in the sandbox can read secrets passed as env vars ([injection](https://modal.com/docs/guide/sandbox-secret-injection)), and snapshots keep any credentials written to disk. Use expiring tokens, scoped GitHub tokens, a separate Environment and budgets ([budgets](https://modal.com/docs/guide/budgets)).

#### Risks

- Company: a $750M Series D at a $15.75B valuation (Oct 14, 2026), over $1B annualized run rate and 200+ staff ([blog](https://modal.com/blog/1-billion-annualized-run-rate-series-d)).
- The JS SDK, domain allowlists, Outbound Policies, exit snapshots and Proxies are Beta, and memory snapshots are Alpha ([SDKs](https://modal.com/docs/guide/sdk-javascript-go), [networking](https://modal.com/docs/guide/sandbox-networking), [injection](https://modal.com/docs/guide/sandbox-secret-injection), [exit](https://modal.com/docs/guide/sandbox-exit-snapshots), [proxies](https://modal.com/docs/guide/proxy-ips), [snapshots](https://modal.com/docs/guide/sandbox-snapshots)). The SDKs are the only supported interfaces ([maturity](https://modal.com/docs/guide/feature-maturity)), and no way to export snapshots is documented.
- 2026 incidents include a 14-minute sandbox outage (Sep 16) and 23 minutes of creation failures (Nov 10) ([status](https://status.modal.com/)).
- The terms (May 2026) allow internal business use only and forbid reselling or giving third parties direct access ([terms](https://modal.com/legal/terms)). Each plugin user should therefore bring their own Modal account (inferred).

### Vercel Sandbox

Vercel Sandbox runs Linux-only Firecracker microVMs on bare-metal AWS EC2 hosts and has been generally available since January 30, 2026 ([GA](https://vercel.com/changelog/vercel-sandboxes-ga), [bounty post](https://vercel.com/blog/one-million-dollar-hacker-challenge-for-vercel-sandbox)). It is a cheap, fast Linux workspace with Claude Code and Codex preinstalled ([pricing](https://vercel.com/docs/sandbox/pricing), [managed images](https://vercel.com/changelog/vercel-sandbox-managed-images)), and its SDK appears to cover what a bb machine needs (inferred). It has no macOS, no Windows, no private preview URLs and no hosted agent runner, so it fits Linux agent work only ([docs](https://vercel.com/docs/sandbox), [guide](https://vercel.com/docs/sandbox/working-with-sandbox)).

#### OS and hardware

- Images must be `linux/amd64` ([images](https://vercel.com/docs/sandbox/concepts/images)). The default is Ubuntu 26.04 "universal", and Amazon Linux 2023 survives only on deprecated runtimes ([managed images](https://vercel.com/changelog/vercel-sandbox-managed-images)).
- Sizes are 1 vCPU or an even number up to 32, with 2 GB per vCPU, capped at 4 vCPU on Hobby, 8 on Pro and 32 on Enterprise; every sandbox gets 64 GB of NVMe disk ([pricing](https://vercel.com/docs/sandbox/pricing), [64 GB](https://vercel.com/changelog/vercel-sandbox-64-gb-storage)).
- Each sandbox is a container inside its own microVM on shared hosts ([snapshot post](https://vercel.com/blog/optimizing-vercel-sandbox-snapshots), [security model, undated](https://vercel.com/docs/sandbox/concepts/security)). No dedicated hosts, GPUs or CPU models are documented ([pricing](https://vercel.com/docs/sandbox/pricing)).
- The docs list 19 regions mapped to AWS regions, default `iad1` ([regions](https://vercel.com/docs/sandbox/concepts/regions)); a September 2026 changelog says 20 ([changelog](https://vercel.com/changelog/vercel-sandbox-is-now-available-in-all-regions)).

#### API and SDK

- Beta began June 25, 2025 ([changelog](https://vercel.com/changelog/run-untrusted-code-with-vercel-sandbox)); GA followed on January 30, 2026 ([GA](https://vercel.com/changelog/vercel-sandboxes-ga)).
- Interfaces: `@vercel/sandbox` 4.0.0 (November 12, 2026, Apache-2.0), Python `vercel-sandbox` 1.0.0, the `sandbox` CLI 4.12.0 and a bearer-token REST API ([npm](https://registry.npmjs.org/@vercel/sandbox), [PyPI](https://pypi.org/project/vercel-sandbox/), [CLI changelog](https://github.com/vercel/sandbox/blob/main/packages/sandbox/CHANGELOG.md), [REST](https://vercel.com/docs/rest-api/sandboxes/execute-a-command)).
- A local plugin would use an access token plus team and project IDs ([auth](https://vercel.com/docs/sandbox/concepts/authentication)). Whether [project-scoped tokens](https://vercel.com/docs/accounts/access-tokens) cover every Sandbox call is unverified; a test call would confirm.
- Pro allows 10,000 control-plane requests per minute and up to 5,000 new vCPUs per minute ([pricing](https://vercel.com/docs/sandbox/pricing)).

#### Lifecycle

- `runCommand` blocks or runs detached with streamed logs until the session ends; stdin arrived on October 26, 2026 ([SDK reference](https://vercel.com/docs/sandbox/sdk-reference), [stdin](https://vercel.com/changelog/vercel-sandbox-commands-now-support-stdin)).
- Sessions default to 5 minutes and extend to 45 minutes on Hobby or 24 hours on Pro and Enterprise ([pricing](https://vercel.com/docs/sandbox/pricing)). The timeout is a fixed deadline, and no idle stop is documented ([duration guide](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence)).
- By default every stop or timeout snapshots the filesystem, and the next SDK call starts a new session from it ([concepts](https://vercel.com/docs/sandbox/concepts)). Processes and memory are lost ([comparison](https://vercel.com/kb/guide/vercel-sandbox-vs-e2b)).
- Snapshots expire 30 days after last use (configurable), stay in their region and outlive deleted sandboxes by default; unresumable sandboxes are removed after 14 days ([snapshots](https://vercel.com/docs/sandbox/concepts/snapshots), [persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes)).
- Vercel claims startup "in milliseconds" ([docs](https://vercel.com/docs/sandbox)), but its November 2026 figures are 1.05 seconds in Seoul and 0.7 seconds median with drives ([startup](https://vercel.com/changelog/vercel-sandbox-starts-up-to-four-times-faster), [drives startup](https://vercel.com/changelog/vercel-sandbox-with-drives-now-starts-up-to-2-4x-faster)). An August 2026 third-party test measured 1.85 seconds to create and 3.33 to resume ([LogRocket](https://blog.logrocket.com/comparing-ai-agent-sandbox-platforms-e2b-modal-daytona-and-more/)).
- Vercel says sandboxes are "not designed to run continuously" ([concepts](https://vercel.com/docs/sandbox/concepts)).

#### Networking

- Up to 15 ports get public `*.vercel.run` URLs that anyone with the URL can reach ([guide](https://vercel.com/docs/sandbox/working-with-sandbox), [CLI reference](https://vercel.com/docs/sandbox/cli-reference)). WebSockets through them can drop, and Vercel suggests connecting outward from the sandbox ([guide](https://vercel.com/docs/sandbox/working-with-sandbox)).
- No OpenSSH endpoint is documented: `sandbox connect` (alias `ssh`) and `openInteractive()` give a PTY over an authenticated WebSocket ([CLI reference](https://vercel.com/docs/sandbox/cli-reference), [SDK reference](https://vercel.com/docs/sandbox/sdk-reference)).
- Egress is allow-all by default, with deny-all and live SNI-domain or CIDR allowlists, and brokering injects headers outside the VM ([firewall](https://vercel.com/docs/sandbox/concepts/firewall)). Static IPs need Enterprise Secure Compute ([changelog](https://vercel.com/changelog/vercel-sandbox-now-supports-secure-compute)).

#### Fit for this plugin

- Task chats look feasible but untested. bb's Modal plugin installs the daemon by exec with bootstrap secrets on stdin ([bb Modal plugin](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/README.md)), and Vercel has detached commands, stdin and open egress ([SDK reference](https://vercel.com/docs/sandbox/sdk-reference)). The daemon must restart every session, and the plugin must add idle stop (inferred). bb has no Vercel Sandbox code at commit de34f34 (grep of the [clone](https://github.com/get-bb/bb/tree/de34f3492e4c69ade967e7b9b1345c9e8d62b03d)).
- Headless tasks lack boat's runner: Vercel's `durable-harness` is experimental and needs a Vercel deployment ([harness, undated](https://vercel.com/docs/agent-harnesses/claude-code)). Anthropic's Claude Managed Agents can use Vercel Sandbox as a self-hosted environment through a beta API ([guide](https://vercel.com/kb/guide/run-claude-managed-agent-tools-with-vercel-sandbox)).
- The universal image ships Claude Code, Codex, gh and tmux ([managed images](https://vercel.com/changelog/vercel-sandbox-managed-images)), but Vercel doesn't manage agent logins ([CLI reference](https://vercel.com/docs/sandbox/cli-reference)).
- Secrets go in through create-time env (copied to forks), per-command env, stdin, files or brokering, and GitHub needs a token in the `git` source or brokering ([SDK reference](https://vercel.com/docs/sandbox/sdk-reference), [guide](https://vercel.com/docs/sandbox/working-with-sandbox)). Managed credentials cover npm only ([credentials, undated](https://vercel.com/docs/sandbox/credentials)). Vercel's AI SDK harness keeps subscription tokens on the host ([changelog](https://vercel.com/changelog/ai-sdk-harness-native-subscription-authentication)); doing that for bb-run CLIs is unverified.
- `boat host --private` has no equivalent, so the plugin needs its own token-checking proxy (inferred). Evidence uploads count as data transfer ([pricing](https://vercel.com/docs/sandbox/pricing)). A billing-charges API exists, but no Sandbox quota endpoint was found ([billing API](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges)).

#### Mac specifics

No macOS hardware or VM exists, and none is announced in the docs or changelog through November 16, 2026 ([docs](https://vercel.com/docs/sandbox), [changelog](https://vercel.com/changelog/sitemap.md)). Vercel CI is Linux-only too ([Vercel CI](https://vercel.com/docs/ci)), and nested virtualization is disabled ([findings](https://vercel.com/blog/findings-from-the-1-million-dollar-vercel-sandbox-challenge)). Xcode, the iOS Simulator, signing, screen access, Safari and Apple's 24-hour lease rule are n/a.

#### Windows

None: images must be `linux/amd64`, and no Windows edition, RDP, size or price exists or is announced ([images](https://vercel.com/docs/sandbox/concepts/images), [changelog](https://vercel.com/changelog/sitemap.md)).

#### Cross-platform testing fit

- Short Linux runs fit: memory bills in 1-minute increments and Active CPU in milliseconds ([pricing](https://vercel.com/docs/sandbox/pricing), [comparison](https://vercel.com/kb/guide/vercel-sandbox-vs-e2b)).
- No browsers are preinstalled ([Dockerfile](https://github.com/vercel/sandbox/blob/main/images/universal/Dockerfile)). Playwright supports Ubuntu 26.04 since 1.61.0 ([release](https://github.com/microsoft/playwright/releases/tag/v1.61.0)) and records video per browser context ([Playwright](https://playwright.dev/docs/videos)).
- Vercel offers no desktop or VNC and points such workloads to E2B ([comparison](https://vercel.com/kb/guide/vercel-sandbox-vs-e2b)). It can't run Safari on macOS or Edge and Chrome on Windows, so it is only a Linux baseline ([images](https://vercel.com/docs/sandbox/concepts/images)).

#### Pricing and example costs

| Item | Price | Billing | Source |
|---|---|---|---|
| Active CPU (iad1) | $0.128 per vCPU-hour | busy CPU only; model waits excluded | [pricing](https://vercel.com/docs/sandbox/pricing) |
| Provisioned memory (iad1) | $0.0212 per GB-hour | wall clock, 1-minute increments | [pricing](https://vercel.com/docs/sandbox/pricing) |
| Creations | $0.60 per 1M | per create | [pricing](https://vercel.com/docs/sandbox/pricing) |
| Data transfer | Pro: Flat Rate CDN (1 TB/month); Enterprise: $0.15/GB | outbound and port traffic | [pricing](https://vercel.com/docs/sandbox/pricing), [CDN](https://vercel.com/docs/pricing/flat-rate-cdn) |
| Snapshot storage | $0.08 per GB-month | daily average | [pricing](https://vercel.com/docs/sandbox/pricing) |
| Frankfurt (fra1) | $0.184 per vCPU-hour; $0.0304 per GB-hour | regional | [pricing](https://vercel.com/docs/sandbox/pricing) |
| Hobby | $0 | 5 CPU-hours, 420 GB-hours, 10 concurrent, 45-minute sessions; non-commercial | [pricing](https://vercel.com/docs/sandbox/pricing), [terms](https://vercel.com/legal/terms) |
| Pro | $20/month | includes $20 usage credit; 10,000 concurrent | [Pro plan](https://vercel.com/docs/plans/pro-plan), [pricing](https://vercel.com/docs/sandbox/pricing) |

Assumptions in the research brief, checked:

- Firecracker microVMs: confirmed ([security model, undated](https://vercel.com/docs/sandbox/concepts/security)).
- Amazon Linux 2023: differs; the default is Ubuntu 26.04 since SDK v3 in August 2026 ([managed images](https://vercel.com/changelog/vercel-sandbox-managed-images)).
- No SSH: differs; no OpenSSH endpoint is documented, but `sandbox ssh` opens a WebSocket shell ([CLI reference](https://vercel.com/docs/sandbox/cli-reference)).
- `/docs/vercel-sandbox`: differs; it redirects (308) to [/docs/sandbox](https://vercel.com/docs/sandbox).

Example costs (Pro, iad1, [pricing](https://vercel.com/docs/sandbox/pricing)):

- Linux 2 hours, 4 vCPU/8 GB, 10% CPU: memory 8 × 2 × $0.0212 = $0.339; CPU 4 × 2 × 0.10 × $0.128 = $0.102; one creation $0.0000006; total $0.44.
- Same at 100% CPU: $0.339 + 4 × 2 × $0.128 ($1.024) = $1.36.
- A 2-hour session is allowed on Pro and Enterprise (24 hours), not on Hobby (45 minutes), and the Pro fee's $20 credit absorbs both ([pricing](https://vercel.com/docs/sandbox/pricing)).
- Mac 2 hours (cheapest or 16 GB), always-on Mac (730 hours), Mac 5-minute run, Windows 5-minute run: n/a.
- Reference Linux 5-minute capture, 2 vCPU/4 GB at 100%: 4 × 5/60 × $0.0212 + 2 × 5/60 × $0.128 = $0.007 + $0.021 = $0.03.
- An idle 4 vCPU/8 GB sandbox (1% CPU) left on for a day: 192 × $0.0212 + 0.96 × $0.128 = $4.19.

#### Trust and security

- AWS owns the bare-metal EC2 hosts, and Vercel runs its Hive platform on them ([bounty post](https://vercel.com/blog/one-million-dollar-hacker-challenge-for-vercel-sandbox), [GA blog](https://vercel.com/blog/vercel-sandbox-is-now-generally-available)).
- The microVM is the boundary, run under Firecracker's jailer, and Vercel says hardware side channels remain ([bounty post](https://vercel.com/blog/one-million-dollar-hacker-challenge-for-vercel-sandbox), [findings](https://vercel.com/blog/findings-from-the-1-million-dollar-vercel-sandbox-challenge), [security model, undated](https://vercel.com/docs/sandbox/concepts/security)).
- The August 2026 bounty paid $242,000. A kernel zero-day leaked host memory from production sandboxes and, on a matching test setup, crashed or took over the host; a cross-tenant snapshot swap was fixed within a week; no customer data access was reported ([findings](https://vercel.com/blog/findings-from-the-1-million-dollar-vercel-sandbox-challenge)).
- Snapshots are encrypted at rest, and Vercel uses AES-256 at rest and TLS 1.3 in transit ([security model, undated](https://vercel.com/docs/sandbox/concepts/security), [compliance](https://vercel.com/docs/security/compliance)).
- Vercel has SOC 2 Type 2, ISO 27001:2022, PCI DSS and TISAX AL2, plus a GDPR DPA and HIPAA BAAs, but Sandbox scope isn't stated ([compliance](https://vercel.com/docs/security/compliance)). The Sandbox overview, security and pricing pages don't say how long command output is kept (unverified) ([docs](https://vercel.com/docs/sandbox), [security model](https://vercel.com/docs/sandbox/concepts/security), [pricing](https://vercel.com/docs/sandbox/pricing)).
- Hobby and Pro-trial content may be used to train Vercel's and third parties' AI; paid Pro is opt-in ([terms](https://vercel.com/legal/terms)).
- For agents holding tokens: broker AI keys, deny egress by default, use 1-hour GitHub App tokens and keep long-lived secrets out of create-time env (inferred from [firewall](https://vercel.com/docs/sandbox/concepts/firewall) and [guide](https://vercel.com/docs/sandbox/working-with-sandbox)).

#### Risks

- Vercel, founded in 2015, raised $300M at $9.3B in September 2025 ([Series F](https://vercel.com/blog/series-f)); In April 2026 the press reported, citing Forbes, a $340M run rate and IPO readiness (secondhand, unverified).
- The terms ban reselling or making the service available to third parties, and Hobby is non-commercial ([terms](https://vercel.com/legal/terms)), so each user needs their own account, in practice Pro (inferred). The AUP bans scraping, proxying and dodging rate limits ([AUP](https://vercel.com/legal/acceptable-use-policy)).
- The API moves fast: SDK 2.0, 3.0 and 4.0 shipped in May, August and November 2026 ([npm](https://registry.npmjs.org/@vercel/sandbox)). Docs disagree on region count, runtime disk size and CLI detach ([pricing](https://vercel.com/docs/sandbox/pricing), [CLI changelog](https://github.com/vercel/sandbox/blob/main/packages/sandbox/CHANGELOG.md)).
- From late May to November 10, 2026, four status incidents touched Sandbox: three minor and one major dashboard incident of about 45 minutes ([status](https://www.vercel-status.com/api/v2/incidents.json)).
- Lock-in is moderate: SDK, CLI and images are open, but snapshots and drives are region-bound with no documented export ([snapshots](https://vercel.com/docs/sandbox/concepts/snapshots)).

### macOS licensing: the 24-hour rule

This is not legal advice. It reads Apple's public terms only, and any provider may hold private terms with Apple.

#### What the license says

Apple's newest macOS license is "macOS 27" ([Apple SLAs](https://www.apple.com/legal/sla/)), for macOS 27 Golden Gate ([Apple](https://www.apple.com/os/macos/)). Its version is EA2005, dated July 11, 2026 ([SLA](https://www.apple.com/legal/sla/docs/macOS27.pdf)).

- **Leasing (3A).** You may lease macOS "in its entirety" only for "the sole purpose of providing Permitted Developer Services". "Each lease period must be for a minimum period of twenty-four (24) consecutive hours." The lessee "must have sole and exclusive use and control of the Apple Software and the Apple-branded hardware". The lessee must first accept Apple's terms, Xcode's included. Permitted Developer Services "means continuous integration services, including but not limited to software development, building software from source, automated testing during software development, and running necessary developer tools to support such activities". Each lessor "must provide Apple with advance notice" ([SLA](https://www.apple.com/legal/sla/docs/macOS27.pdf)), on a page behind an Apple sign-in ([Apple](https://developer.apple.com/contact/macos-license/)).
- **3B to 3D.** A sublessor "shall also be considered a Lessor". On a leased Mac, "either a Lessor or a Lessee (but not both)" may run VMs, and a lessor may virtualize only "a single instance or copy of the Apple Software as a provisioning tool" ([SLA](https://www.apple.com/legal/sla/docs/macOS27.pdf)).
- **Your own Macs (2B(iii), 2I, 2J).** You may run "up to two (2) additional copies or instances" in VMs "on each Apple-branded computer you own or control", for "software development", "testing during software development", macOS Server, or "personal, non-commercial use", but not for "service bureau, time-sharing, terminal sharing, relay service or other similar types of services" outside Section 3. Section 2I extends that ban to all macOS use unless Section 3 or another Apple license applies, and lets one remote device at a time "control the graphical desktop session". Section 2J bars leasing outside Section 3 ([SLA](https://www.apple.com/legal/sla/docs/macOS27.pdf)).

**New in macOS 27:** 2B(iii) now starts, and 3A's lead-in now ends, with "except as otherwise provided in writing, signed, or issued by an authorized representative of Apple", 3A(iv) adds "the terms of this License", and 2N bans tampering with recording indicators ([SLA](https://www.apple.com/legal/sla/docs/macOS27.pdf)). Tahoe's license (EA1955) has none of these ([Tahoe SLA](https://www.apple.com/legal/sla/docs/macOSTahoe.pdf)). Each guest follows the license of the macOS version it runs, so Instabox's macOS 26 VMs fall under Tahoe's terms, whose Section 3 is the same. No public exception process was found; in September 2026, Apple developer support pointed a forum asker only to Apple's public legal pages ([forum](https://developer.apple.com/forums/thread/845455); unverified, because the forum blocks automated reading).

**History:** Section 3 first appears in Big Sur (EA1705, 2020), not Catalina, and a diff of the license PDFs shows it unchanged through Tahoe; the two-VM grant dates to OS X Lion ([Big Sur SLA](https://www.apple.com/legal/sla/docs/macOSBigSur.pdf), [Catalina SLA](https://www.apple.com/legal/sla/docs/macOSCatalina.pdf), [Lion SLA](https://www.apple.com/legal/sla/docs/macosx107.pdf)).

#### How hosted-Mac providers handle it

- **Whole Mac for 24 hours, then hourly.** AWS bills EC2 Mac "per second, with a 24-hour minimum allocation period for the Dedicated Host to comply with the Apple macOS Software License Agreement" ([AWS FAQ](https://aws.amazon.com/ec2/instance-types/mac/faqs/)), one bare-metal instance per host ([AWS docs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html)). Scaleway cites "licensing restrictions" for its 24 hours and sets no minimum for Asahi Linux ([Scaleway](https://github.com/scaleway/docs-content/blob/main/pages/apple-silicon/faq.mdx)). Instabox leases "a Mac to only one customer at a time, for at least 24 hours", then bills per second; new machines reuse a live lease ([Instabox](https://instabox.sh/docs/machines/macos.md)). MacStadium rents Macs monthly, "dedicated to one customer at a time" ([MacStadium](https://www.macstadium.com/pricing)).
- **Per-minute VMs on provider Macs.** Each GitHub runner "is a new virtual machine", with macOS runners in "Azure data centers" ([GitHub](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)). Bitrise wrote in July 2026 that "two VMs belonging to different customers can share the same physical hardware" ([Bitrise](https://bitrise.io/blog/post/wwdc26-the-virtualization-framework-updates-that-matter-for-large-mac-fleets)). GitHub's runner docs don't mention Apple's license, but its product terms do: "You appoint GitHub as your authorized developer with respect to Apple software included in Actions. GitHub is responsible for complying with the terms for any such software included in Actions" ([GitHub terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)). Bitrise's basis is not public. Cirrus Labs wrote in 2022 that "Apple’s EULA only allows 2 additional VMs per host" ([archived post](https://web.archive.org/web/20250209113930/https://cirrus-ci.org/blog/2022/07/07/isolating-network-between-tarts-macos-virtual-machines/), old) and closed Cirrus Runners to new customers in April 2026 ([Cirrus Labs](https://cirruslabs.org/)). Xcode Cloud is Apple's own ([Xcode Cloud](https://developer.apple.com/xcode-cloud/)).
- **Other people's Macs.** Darkbloom runs "other people's GitHub Actions jobs and agent sandboxes in virtual machines on your Apple silicon Mac" ([Darkbloom](https://docs.darkbloom.dev/provider/sandbox-hosting.md)); owners keep a quarter of the cores and memory ([setup](https://docs.darkbloom.dev/provider/sandbox-setup.md)). macOS sandboxes are experimental and invitation-only ([overview](https://docs.darkbloom.dev/sandboxes/overview.md)). Its terms make "no representation that provider participation is permitted under any such third-party licenses" ([terms](https://www.darkbloom.ai/terms), updated August 28, 2026).

| Option | Price | Minimum | Source |
| - | - | - | - |
| EC2 mac2.metal (M1), us-east-1 | $0.65/hour | 24 h, then per second | [price file](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/dedicatedhost-ondemand.json), [page](https://aws.amazon.com/ec2/dedicated-hosts/pricing/) |
| EC2 mac-m4.metal (M4), us-east-1 | $1.23/hour | 24 h | [price file](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/dedicatedhost-ondemand.json) |
| Scaleway M1-M (8 GiB) / M2-M (16 GiB) / M4-S (16 GiB), Paris | €0.11 / 0.17 / 0.22 per hour, or €75 / 115 / 149 a month | 24 h; VAT not stated | [catalog](https://api.scaleway.com/product-catalog/v2alpha1/public-catalog/products?product_types=apple_silicon&page_size=100) |
| Instabox M2 / M4 | $0.45 / $0.75 per hour | 24 h ($10.80 / $18.00); Pro plan | [Instabox](https://instabox.sh/docs/machines/macos.md) |
| MacStadium M2.S (8 GB) / M4.S (16 GB) | $109 / $149 a month | monthly, prepaid | [MacStadium](https://www.macstadium.com/pricing) |
| GitHub macOS runner (3 or 4 core) | $0.062/minute | whole minutes per job | [GitHub](https://docs.github.com/en/billing/reference/actions-runner-pricing) |
| Darkbloom mac-c4-m8 | $0.35/hour | per second, one-minute minimum | [Darkbloom](https://docs.darkbloom.dev/get-started/pricing-overview.md) |

A 10-minute Safari screenshot run costs: GitHub 10 × $0.062 = $0.62; Darkbloom $0.35 × 10/60 = $0.06; Instabox M2 $0.45 × 24 = $10.80; EC2 mac2 $0.65 × 24 = $15.60; Scaleway M1-M €0.11 × 24 = €2.64. Later runs in the same lease add no Mac charge, so an Instabox M2 lease beats GitHub above $10.80 ÷ $0.062 = 174 minutes (2.9 hours) of macOS use a day, and a Scaleway M1-M lease above about 47 minutes (€2.64 at an ECB rate of 1.1014 on 2026-11-16, before VAT).

#### What it means for per-hour Mac sandboxes

- **Consistent on its face:** a whole Mac for one customer for 24 hours or more, billed hourly afterward (Instabox, EC2, Scaleway). Section 3 says nothing about billing units ([SLA](https://www.apple.com/legal/sla/docs/macOS27.pdf)). Instabox's page doesn't say how lessees accept Apple's terms or whether Apple was notified ([Instabox](https://instabox.sh/docs/machines/macos.md)).
- **Arguable, readings differ:** per-minute VMs on provider Macs meet "own or control" and resemble "testing during software development", but many customers per Mac looks like the excluded "time-sharing" ([SLA](https://www.apple.com/legal/sla/docs/macOS27.pdf)). In 2020 MacStadium called that "just not allowed with macOS" ([blog](https://www.macstadium.com/blog/developers-big-sur-and-vindication), old, a competitor's view). Bitrise may hold private Apple terms: Section 2I, in both the Tahoe and macOS 27 licenses, allows uses "otherwise licensed by Apple", and macOS 27 adds the written-waiver wording. Nothing public says it does.
- **Risky:** leasing a whole Mac for under 24 hours, or re-leasing it inside the window, fails 3A(ii) and (iii) ([SLA](https://www.apple.com/legal/sla/docs/macOS27.pdf)). Darkbloom's VMs serve strangers, not the owner's development, and nobody gets the Mac for 24 hours (this report's reading of the [Darkbloom docs](https://docs.darkbloom.dev/provider/sandbox-hosting.md)).
- **For the plugin:** keep each user the lessee on their own provider account, as with boat today ([README](../../README.md)). Pooling Macs would make the owner a "Lessor" with 3C duties ([SLA](https://www.apple.com/legal/sla/docs/macOS27.pdf)). Agent coding sessions and Safari tests of preview builds match listed examples ("software development", "building software from source", "automated testing during software development"), though the head term is "continuous integration services". Monitoring live production sites fits least clearly ([SLA](https://www.apple.com/legal/sla/docs/macOS27.pdf); this report's reading). The 24-hour minimum binds leases only: a Mac the user owns or controls may run up to two macOS VMs for development under 2B(iii), with no minimum period.

#### Xcode, signing and simulators in the cloud

- The Xcode and Apple SDKs Agreement (EA2002, June 8, 2026) is "AUTHORIZED ONLY FOR EXECUTION ON AN APPLE-BRANDED PRODUCT RUNNING MACOS", allows installs on computers "owned or controlled by You" (2.2A), and without Apple's written permission forbids you to "rent, lease, lend, upload to or host on any website or server" (2.7) ([Xcode agreement](https://www.apple.com/legal/sla/docs/xcode.pdf)). So don't share a plugin-built Xcode snapshot across users (this report's reading).
- The Developer Program agreement (updated October 29, 2026) forbids uploading an App Store distribution certificate "to a cloud repository for use by a third party" (5.1), and says "You may not use a Service Provider to submit an Application to the App Store or use TestFlight on Your behalf" (2.9) ([DPLA](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/)). Cloud signing keeps keys at Apple ("you can’t transmit or store the private key on your Mac"), and xcodebuild accepts App Store Connect API keys on headless machines ([Xcode 13 notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-13-release-notes)). The Notary API avoids "a macOS dependency" ([Notary API](https://developer.apple.com/documentation/notaryapi)).
- Simulators work in macOS VMs: GitHub's macOS 26 arm64 runner, a VM, ships iOS 26 simulators ([runner image](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)) (inferred). The 2B ban on iOS in VMs targets iOS itself, not Xcode's Simulator (this report's reading of the [SLA](https://www.apple.com/legal/sla/docs/macOS27.pdf) and [Xcode agreement](https://www.apple.com/legal/sla/docs/xcode.pdf)).
- VM limits: two running macOS VMs per Mac ([Darkbloom setup](https://docs.darkbloom.dev/provider/sandbox-setup.md)); no Mac App Store sign-in ([Parallels](https://kb.parallels.com/en/131160), July 2026); no Apple Media Services, Find My, Wallet or Apple's cloud backup ([Apple Support](https://support.apple.com/en-us/120468)); nested virtualization only for non-macOS guests on M3 or later ([Apple docs](https://developer.apple.com/documentation/virtualization/vzgenericplatformconfiguration/isnestedvirtualizationsupported)). MacStadium reports video missing from screen capture in Tahoe guests ([MacStadium docs](https://docs.macstadium.com/remote-desktop-vdi/reference/known-issues), undated), so test VM video evidence first.

### Windows sandboxes and licensing

None of the providers the plugin targets sells Windows machines. Daytona, Orgo, Microsoft and the CI runners do. None of the third-party sandboxes found in this research documents Windows 11 today; Cua's Windows 11 cloud closed on 2026-10-18 ([Cua](https://cua.ai/blog/cloud-windows-ga-macos-preview)).

#### Who offers Windows

boat.dev, Modal and Vercel Sandbox run only Linux, and Darkbloom runs Linux and macOS. boat runs Windows apps only through Wine ([boat](https://docs.boat.dev/llms.txt), [Wine](https://docs.boat.dev/windows-apps.md), [Modal](https://modal.com/docs/guide/sandboxes), [Vercel](https://vercel.com/docs/sandbox), [Darkbloom](https://docs.darkbloom.dev/llms.txt)). Instabox's homepage lists Windows ([homepage](https://instabox.sh/)), but its changelog announces no Windows product ([changelog](https://instabox.sh/changelog.md)). But its docs say "Windows machines take no env" ([environment](https://instabox.sh/docs/machines/environment.md)), and the admin help in its CLI lists "windows" as a restricted per-org template ([CLI 0.8.289](https://registry.npmjs.org/instabox/-/instabox-0.8.289.tgz)). That suggests gated testing (unverified until Instabox announces it).

Daytona's Windows VMs offer computer use with screen recording, pause with memory, fork, and a 60-minute idle auto-pause. The docs limit them to Tier 3 orgs on request and don't mention SSH ([Daytona](https://www.daytona.io/docs/en/windows-sandboxes.md)), although a July 2026 post said all orgs could use them ([blog](https://www.daytona.io/dotfiles/windows-sandboxes)). Orgo's Windows VMs have a PowerShell exec endpoint and public URLs but no SSH ([Orgo](https://docs.orgo.ai/llms.txt), [exec](https://docs.orgo.ai/api-reference/computers/bash), [URLs](https://docs.orgo.ai/guides/public-urls), [SSH](https://docs.orgo.ai/guides/ssh)).

Windows 365 for Agents lends Cloud PCs. An app checks one out in up to 30 seconds and drives it through MCP tools, which include command execution and browser automation ([MCP](https://learn.microsoft.com/en-us/windows-365/agents/mcp-tool-overview)). Each Cloud PC resets after its session or after 30 idle minutes ([lifecycle](https://learn.microsoft.com/en-us/windows-365/agents/agent-session-lifecycle)). Setting up a pool requires Intune and Agent 365 licenses ([prerequisites](https://learn.microsoft.com/en-us/windows-365/agents/create-provisioning-policy-agents)). Cua's Windows 11 cloud shut down on 2026-10-18 ([Cua](https://cua.ai/blog/cloud-windows-ga-macos-preview)).

| Provider | Status | Edition | Price and billing | Source |
|---|---|---|---|---|
| boat.dev, Modal, Vercel, Darkbloom | None | n/a | n/a | See text |
| Instabox | Not public | Unknown | Unknown | [docs](https://instabox.sh/docs/machines/environment.md), [CLI](https://registry.npmjs.org/instabox/-/instabox-0.8.289.tgz) |
| Daytona | Tier 3 ($500 top-up), on request | Server 2025 (July 2026 article) | $0.0504/vCPU-h + $0.0162/GiB-h + $0.0858/vCPU-h Windows + $0.000108/GiB-h disk after 5 GiB; per second | [pricing](https://www.daytona.io/pricing), [tiers](https://www.daytona.io/docs/en/limits.md), [article](https://www.daytona.io/dotfiles/microsoft-office-in-daytona-windows-sandboxes) |
| Orgo | Self-serve, paid plans | Not documented | $47/month per Windows Medium (2 vCPU, 8 GB) on a plan from $29/month; included in Scale ($399/month); not hourly | [pricing](https://docs.orgo.ai/guides/pricing), [plans](https://orgo.ai/pricing.md) |
| Windows 365 for Agents | GA (June 2026) | Enterprise images (Windows 11 inferred) | $0.40/h (US), hourly windows rounded up; optional $5/PC/month always-available | [pricing](https://learn.microsoft.com/en-us/windows-365/agents/pricing-paygo-always-available), [GA](https://learn.microsoft.com/en-us/windows-365/agents/whats-new), [pools](https://learn.microsoft.com/en-us/windows-365/agents/cloud-pc-agent-pools), [images](https://learn.microsoft.com/en-us/windows-365/enterprise/device-images) |
| Azure D2s v5, East US | GA | Server; client with own licenses | $0.188/h Server; $0.096/h Linux or Dev/Test; full minutes | [prices](https://prices.azure.com/api/retail/prices?$filter=armSkuName%20eq%20%27Standard_D2s_v5%27%20and%20armRegionName%20eq%20%27eastus%27), [billing](https://azure.microsoft.com/en-us/pricing/details/virtual-machines/windows/) |
| AWS m7i.large, us-east-1 | GA | Server; no client licenses sold | $0.1928/h (Linux $0.1008); per second, 60 s minimum | [prices](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20East%20%28N.%20Virginia%29/Windows/index.json), [billing](https://aws.amazon.com/ec2/pricing/on-demand/) |
| GitHub Actions | GA | Server 2025 x64; Windows 11 Enterprise arm64 | $0.010/min, rounded up per job; free in public repos | [pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing), [free](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [images](https://github.com/actions/runner-images) |
| Blacksmith | Public beta | Server 2025 | $0.008/min (2 vCPU); free minutes count Windows double | [pricing](https://www.blacksmith.sh/pricing), [docs](https://docs.blacksmith.sh/blacksmith-runners/overview) |
| Azure Playwright Workspaces | Available (limits page updated 2026-09-14) | Not documented | $0.02/test minute (Linux $0.01) | [prices](https://prices.azure.com/api/retail/prices?$filter=contains%28meterName%2C%20%27Playwright%27%29%20and%20armRegionName%20eq%20%27eastus%27), [docs](https://learn.microsoft.com/en-us/azure/app-testing/playwright-workspaces/resource-limits-quotas-capacity) |

A 10-minute run on Daytona windows-medium costs (2 × $0.0504 + 8 × $0.0162 + 2 × $0.0858 + 45 × $0.000108) = $0.4069/h × 10/60 = $0.068. At 600 runs a month (100 h), that is $40.69. The same run costs 10 × $0.010 = $0.10 on windows-2025 or windows-11-arm (free in public repos) and $0.1928 × 10/60 = $0.032 on AWS, plus disk. On Windows 365 for Agents, a task alone in its hourly window is billed the full hour, $0.40.

#### Licensing: Windows Server vs Windows client

Microsoft's license for service providers (SPLA) says "the Windows Desktop Operating System cannot be used to provide a hosted client, hosted graphical user interface or desktop as a service" ([SPUR](https://www.microsoft.com/licensing/spur/productoffering/WindowsServer/all)). On Windows Server, each GUI user needs an RDS SAL, whether access is over RDS "or other technology" ([SPUR](https://www.microsoft.com/licensing/spur/productoffering/WindowsServer/all)). The exception is two users per instance who handle the provider's own testing, maintenance and administration. SPLA use of Listed Providers (Alibaba, Amazon, Google, Microsoft) ended after 2025-09-30 ([SPUR terms](https://www.microsoft.com/licensing/spur/product/UniversalLicenseTerms/all), [Listed Providers](https://www.microsoft.com/licensing/docs/view/Listed-Providers)). Their license-included instances are still available, and on AWS each includes two remote connections for admin use only ([AWS FAQ](https://aws.amazon.com/windows/faq/)).

Windows 11 needs the customer's own licenses. Users with per-user Windows Enterprise, Education or VDA subscriptions may run it in their own Azure accounts ([Product Terms](https://www.microsoft.com/licensing/terms/productoffering/WindowsDesktopOperatingSystem/EAEAS)), and Visual Studio subscribers may run it there for dev/test ([Learn](https://learn.microsoft.com/en-us/azure/virtual-machines/windows/client-images)). Outside Azure, subscriptions may run on shared servers in two places: an Authorized Outsourcer (a provider that neither is nor runs on a Listed Provider) or a Cloud Solution Provider-Hoster ([terms](https://www.microsoft.com/licensing/terms/product/ForallSoftware/EAEAS), [glossary](https://www.microsoft.com/licensing/terms/product/Glossary/EAEAS)). On Listed Providers, VDA users need hardware dedicated to the customer ([Product Terms](https://www.microsoft.com/licensing/terms/productoffering/WindowsDesktopOperatingSystem/EAEAS)), and AWS sells no Windows client licenses ([AWS FAQ](https://aws.amazon.com/windows/faq/)). So a third-party sandbox vendor can resell Windows Server but not Windows 11 (inferred).

For browser tests, Edge and Playwright both support Windows Server ([Edge](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-supported-operating-systems), [Playwright](https://playwright.dev/docs/intro)). Server 2025 shares build 26100 with Windows 11 24H2 ([Server](https://learn.microsoft.com/en-us/windows/release-health/windows-server-release-info), [Windows 11](https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information)). Windows 11 adds the Segoe UI Variable font, and not every font is preinstalled in every image (both lists date from 2022) ([Windows 11 fonts](https://learn.microsoft.com/en-us/typography/fonts/windows_11_font_list), [Windows 10 fonts](https://learn.microsoft.com/en-us/typography/fonts/windows_10_font_list)). Chrome 136 and later draw non-overlay Fluent scrollbars on Windows and Linux ([Chrome](https://chromestatus.com/feature/5693137379917824)). Whether the owner's pages look the same on Server 2025 and Windows 11 is unverified. GitHub's windows-11-arm runner is only a rough Windows 11 check: it runs Windows 11 Enterprise build 26200 on Arm64 with Edge and Chrome 157, against Server 2025 build 26100 with 156 on windows-2025. Playwright doesn't officially support Windows on Arm, and processes there can't take the foreground ([#41339](https://github.com/microsoft/playwright/issues/41339), [#14049](https://github.com/actions/runner-images/issues/14049)). Compare against a Windows 11 x64 capture.

#### Claude Code, Codex and bb on Windows

Claude Code supports Windows 10 1809+ and Server 2019+. It uses Git Bash when Git for Windows is installed and PowerShell otherwise, and it has no sandboxing on native Windows ([setup](https://code.claude.com/docs/en/setup.md)). Microsoft made its Microsoft Execution Containers (MXC) sandbox GA on Windows 11 on 2026-10-07 and says Claude Code will adopt it ([Windows blog](https://blogs.windows.com/windowsexperience/2026/10/07/building-windows-for-hybrid-intelligence/)). Anthropic's docs don't mention this (unverified). Codex runs natively in PowerShell with an MXC, elevated or unelevated sandbox ([Codex](https://learn.chatgpt.com/docs/windows/windows-sandbox)). MXC needs Windows 11 24H2 or 25H2, and Codex's support matrix doesn't list Windows Server. Under MXC, leftover child processes stop when a command exits.

bb's native Windows 11 x64 host is alpha and needs Git for Windows ([platform support](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/docs/platform-support.md#L5-L43)). It shipped in 0.45.0 on 2026-10-02 ([changelog](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/changelog-metadata.ts#L28-L31)). bb's Windows CI runs on Windows Server 2025, and Windows 11 installs are not yet verified ([CI](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/docs/windows-ci.md#L3-L7), [gaps](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/docs/windows-ci.md#L200-L201)). Windows machines enroll with a PowerShell `irm ... install.ps1 | iex` command ([command](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/services/machines/manual-enrollment-command.ts#L19-L24)) and need Node.js 22.19+ ([guide](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/packages/templates/src/templates/bb-guide-machines.md#L383-L386)). The installer starts the daemon through WMI and registers it under the user's Run key ([WMI](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/assets/install-machine-windows.mjs#L736-L740), [Run key](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/assets/install-machine-windows.mjs#L31)), so the daemon stops when the user signs out ([Windows CI](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/docs/windows-ci.md#L184-L201)). The bootstrap that bb runs for plugins uses `sh` and install.sh ([bootstrap.ts](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/services/machines/bootstrap.ts#L7-L30)), and install.sh exits on anything but macOS or Linux ([install-machine.sh](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/assets/install-machine.sh#L384-L390)). So task chats on Windows need a change in bb itself.

#### What changes on Windows

- **Shell.** Windows Server 2025 comes with OpenSSH installed ([install](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)). Windows OpenSSH starts cmd.exe unless an admin sets DefaultShell ([config](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration)), and cmd rejects commands longer than 8191 characters ([Daytona](https://www.daytona.io/docs/en/windows-sandboxes.md)). The plugin's `bash -lc` wrapper ([machine.ts](../../src/machine.ts#L71)) must become PowerShell. PowerShell's `-EncodedCommand` flag exists for commands that need "complex, nested quoting" ([pwsh](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pwsh)).
- **Paths and files.** Paths use drive letters, and bb compares them case-insensitively ([host paths](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/docs/api_to_audit.md#L20-L28)). MAX_PATH is 260 characters unless both a registry setting and the app manifest opt in ([MAX_PATH](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation)). The plugin's files under /tmp must move ([briefs.ts](../../src/briefs.ts#L91), [memory.ts](../../src/memory.ts#L194)). Git for Windows checks out CRLF line endings by default ([installer](https://github.com/git-for-windows/build-extra/blob/main/installer/install.iss)). chmod can change only the write bit ([Node fs](https://github.com/nodejs/node/blob/main/doc/api/fs.md)), and Git decides what is executable from the file extension or a `#!` line ([run-command.c](https://github.com/git/git/blob/master/run-command.c)).
- **Processes.** Windows has no POSIX signals, so Node turns SIGTERM and SIGINT into a forced kill ([Node](https://github.com/nodejs/node/blob/main/doc/api/child_process.md)), and bb stops processes with `taskkill /T /F` ([Windows CI](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/docs/windows-ci.md#L184-L201)). Windows OpenSSH kills a session's processes when the session ends ([Win32-OpenSSH, 2018 to 2021](https://github.com/PowerShell/Win32-OpenSSH/issues/1195)), so previews started with `nohup` die. A detached server needs WMI `Win32_Process.Create`, a scheduled task ([tasks](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/register-scheduledtask)) or a service ([services](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/new-service)).
- **Agent runner.** No Windows provider has an API like boat's prompt, events and steer. The plugin would have to launch claude or codex through PowerShell, detach it, poll a log file for progress and stop it by killing its process tree (inferred).
- **Tools.** WinGet works only after a user has signed in once ([WinGet](https://learn.microsoft.com/en-us/windows/package-manager/winget/)), Chocolatey installs from an admin shell ([Chocolatey](https://docs.chocolatey.org/en-us/choco/setup/)), and Scoop needs no admin rights ([Scoop](https://github.com/ScoopInstaller/Scoop)). Dev Drive, which reduces Defender's scanning overhead, is documented for Windows 11 and listed among Windows Server 2025's new storage features ([Dev Drive](https://learn.microsoft.com/en-us/windows/dev-drive/), [Server 2025](https://learn.microsoft.com/en-us/windows-server/get-started/whats-new-windows-server-2025)). Whether Defender's performance mode applies on Server images is unverified.
- **bb enrollment.** bb's plugin bootstrap needs a PowerShell path for two steps: running install.ps1, and running `install-machine-windows.mjs --start` after each resume. The second step is needed because the Run key starts the daemon only when a user signs in ([guide](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/packages/templates/src/templates/bb-guide-machines.md#L383-L386)).

### Prices side by side

All figures come from the provider sections above, where the math and sources are. "n/a" means the provider can't do it.

| Scenario | boat.dev | Instabox | Darkbloom | Modal | Vercel Sandbox |
|---|---|---|---|---|---|
| Linux agent task, 2 h, 4 vCPU / 8 GiB | $0.07 | $0.07 | $0.38 | $0.95 reserved; $0.15 to $0.44 bursting | $0.44 at 10% CPU; $1.36 at 100% |
| Mac task, 2 h | n/a | $10.80 (M2, 12 GiB) or $20.40 (M2 Pro, 24 GiB); 24 h minimum | $0.70 (8 GiB); $0.90 (16 GiB) | n/a | n/a |
| Always-on Mac, 730 h | n/a | $328.50 (M2) or $620.50 (M2 Pro) | $255.50 (8 GiB) or $328.50 (16 GiB), over at least 31 boots | n/a | n/a |
| Mac test run, 5 min | n/a | $10.80 for a new lease; nothing extra inside a held lease | $0.03 | n/a | n/a |
| Windows test run, 5 min | n/a | n/a | n/a | n/a | n/a |
| Plan fee | $20/month, paid back as VM time | $20/month Pro (required for Mac), paid back as credit | None; prepaid balance | $0 Starter with $30 credit | $20/month Pro with $20 credit |

For reference, outside the five ([licensing](#macos-licensing-the-24-hour-rule), [hosted testing](#hosted-browser-testing-services-vs-raw-boxes)):

- GitHub-hosted runners: a 5-minute run costs $0.31 on macOS and $0.05 on Windows, and nothing in public repos.
- AWS EC2 Mac (M1): at least $15.60 per allocation (24 hours), or $474.50 for a month.
- Scaleway Mac mini (Paris, before VAT): €2.64 (M1, 8 GiB) or €4.08 (M2, 16 GiB) per 24-hour lease, or €75 (M1) to €115 (M2) a month for a whole Mac.
- MacStadium: $109 (M2, 8 GB) or $149 (M4, 16 GB) a month for a dedicated Mac.
- Daytona macOS sandboxes: $60.08 per 24-hour reservation of an M4 Pro Mac mini (12 cores, 24 GiB), up to two sandboxes on it, with Xcode and the iPhone simulator in the image ([Daytona](https://www.daytona.com/docs/macos-sandboxes)).
- Codemagic: 500 free macOS M2 minutes a month for individuals, then $0.095 a minute ([Codemagic](https://codemagic.io/pricing/)).

#### Owner-supplied figures

| Figure | Verdict | Official value | Source |
|---|---|---|---|
| Instabox M2 $0.45/h | Confirmed | $0.45 per Mac-hour; 24 h minimum ($10.80), then per second | [Instabox macOS](https://instabox.sh/docs/machines/macos.md) |
| Instabox M2 Pro $0.85/h | Confirmed | $0.85; 24 h minimum ($20.40) | [Instabox macOS](https://instabox.sh/docs/machines/macos.md) |
| Instabox M4 $0.75/h | Confirmed | $0.75; 24 h minimum ($18.00) | [Instabox macOS](https://instabox.sh/docs/machines/macos.md) |
| Instabox M4 Pro $1.25/h | Confirmed | $1.25; 24 h minimum ($30.00) | [Instabox macOS](https://instabox.sh/docs/machines/macos.md) |
| Darkbloom Linux $0.032/vCPU-h + $0.008/GiB-h; c8-m32 $0.512/h | Confirmed | Same; per second from ready, one-minute minimum | [Darkbloom pricing](https://docs.darkbloom.dev/sandboxes/pricing) |
| Darkbloom mac-c4-m8 $0.35, mac-c4-m16 $0.45, mac-c8-m16 $0.70, mac-c8-m32 $0.90 per hour | Confirmed | Same | [Darkbloom pricing](https://docs.darkbloom.dev/sandboxes/pricing) |
| Darkbloom has about 1,100 Macs | Confirmed, as an inference count | 1,124 active inference providers at 05:53 UTC on 2026-11-17 (a count of connections; 954 identified unique machines at 06:48 UTC). The homepage counter (1,231) appears stale. Sandbox hosts aren't counted separately | [stats](https://api.darkbloom.dev/v1/stats) |
| Darkbloom Mac sandboxes are in private beta | Close | Invitation-only ("experimental and open by invitation"), for Linux too, serving "accounts on Darkbloom's alpha list": a private alpha rather than a beta. The "public alpha" in the terms covers inference only | [overview](https://docs.darkbloom.dev/sandboxes/overview), [hosting](https://docs.darkbloom.dev/provider/sandbox-hosting), [terms](https://www.darkbloom.ai/terms) |

## Part B2: cross-platform browser testing

The owner's second use case is different from agent workspaces: rent a Mac for real Safari and WebKit rendering (an Astro site with scroll-driven animations and 3D CSS that Linux WebKit can't reproduce), and Windows for Edge, Chrome, font rendering and scrollbars, across all projects.

### Test runner vs agent workspace

| | Test runner | Agent workspace |
|---|---|---|
| Lifetime | Minutes | Hours to days |
| State | None: a fresh image each run | Checkout, caches, logins, bb's daemon |
| Credentials on the box | The preview link and an upload path | GitHub token, agent logins, bb machine credentials |
| Needs | The real browser on the target OS, a display session, screen capture, outbound HTTPS | Shell, git, Node, long-lived processes, previews, snapshots |
| Billing that fits | Per minute or per second, no minimum | Hourly or monthly; minimums spread over many tasks |

Which providers suit which, given their billing minimums:

- **Mac test runner.** Per-minute macOS CI runners fit: GitHub's macOS runner costs $0.062 a minute, so a 5-minute capture costs $0.31 ([GitHub pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)). Hosted grids fit at volume ([below](#hosted-browser-testing-services-vs-raw-boxes)). Instabox Macs fit only inside a lease that is already held, because every new lease bills 24 hours ([Instabox macOS](https://instabox.sh/docs/machines/macos.md)). Darkbloom bills per second ([Darkbloom pricing](https://docs.darkbloom.dev/sandboxes/pricing)), but needs an invitation, can't reach preview URLs that aren't HTTPS on port 443 at an allowlisted hostname, documents no browsers, and warns that a host Mac "can also alter a job's results" ([Darkbloom CI security](https://docs.darkbloom.dev/ci/security)).
- **Windows test runner.** GitHub's Windows Server 2025 x64 runners cost $0.010 a minute ([GitHub runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)). The Windows 11 Arm64 runner costs the same but isn't a capture backend: Playwright doesn't officially support Windows on Arm ([#41339](https://github.com/microsoft/playwright/issues/41339)). Windows 10 and 11 on x64 come from hosted grids, or Windows 11 from a GitHub larger runner with the "Base Windows 11 Desktop" image ($0.022 a minute for 4 cores; GitHub Team or Enterprise Cloud only, billed even in public repos) ([larger runners](https://docs.github.com/en/actions/reference/runners/larger-runners), [billing](https://docs.github.com/en/actions/concepts/runners/larger-runners)). None of the five providers in this report sells Windows.
- **Linux baseline.** Any Linux provider works, billed per second: a 5-minute run on boat's small size costs about $0.0015 ([boat section](#boatdev-baseline)).
- **Mac agent workspace.** A Mac the user owns, with no minimum, or a whole rented Mac for at least 24 hours: Scaleway (from €2.64 a day for an 8 GiB M1 or €4.08 for a 16 GiB M2, before VAT), an Instabox lease (from $10.80 a day), EC2 Mac (from $15.60 a day), or a Mac rented by the month (Scaleway from €75, MacStadium from $109) ([licensing section](#macos-licensing-the-24-hour-rule)). For short Mac tasks, a GitHub macOS runner could also host a throwaway bb machine at $0.062 a minute, with Xcode preinstalled. But jobs stop after 6 hours, only 5 macOS jobs run at once on Free, Pro and Team, nothing persists, and bb's credentials would sit on GitHub's VM ([limits](https://docs.github.com/en/actions/reference/limits)). Whether that fits GitHub's Actions terms is unverified.
- **Windows agent workspace.** Not available from the five providers; see [Windows sandboxes and licensing](#windows-sandboxes-and-licensing).

### Safari and WebKit automation on cloud Macs

#### safaridriver and real Safari

Safari's driver is `/usr/bin/safaridriver`; WebDriver stays off until `safaridriver --enable` runs, which may need `sudo` ([Apple](https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari)). With passwordless sudo this works unattended: GitHub's image build runs `sudo safaridriver --enable` and sets `AllowRemoteAutomation` in `~/Library/WebDriver/com.apple.Safari.plist` ([runner-images](https://github.com/actions/runner-images/blob/main/images/macos/scripts/build/install-safari.sh)).

Each macOS instance runs one Safari with one WebDriver session, in a clean automation window under a "glass pane" that blocks stray input ([Apple](https://developer.apple.com/documentation/safari-developer-tools/webdriver)). Parallel captures need one VM each, and Apple's macOS 27 license allows two extra macOS VMs per Mac for development and testing ([license](https://www.apple.com/legal/sla/docs/macOS27.pdf)). Safari has no headless mode ([WebdriverIO](https://webdriver.io/docs/platforms/web)). It needs a logged-in GUI (Aqua) session; SSH into a Mac where nobody is logged in gets a command-line session ([Apple, 2017](https://developer.apple.com/library/archive/documentation/DeveloperTools/Conceptual/testing_with_xcode/chapters/08-automation.html)). CI images use auto-login ([runner-images](https://github.com/actions/runner-images/blob/main/images/macos/scripts/build/configure-autologin.sh)), which FileVault blocks ([Apple](https://support.apple.com/en-us/102316)).

Take Screenshot returns the visual viewport only ([W3C](https://www.w3.org/TR/webdriver2/#take-screenshot)), and MDN lists no WebDriver BiDi support in Safari ([MDN](https://github.com/mdn/browser-compat-data/blob/main/webdriver/bidi/session.json)).

Video needs OS capture, which macOS gates behind the Screen Recording permission ([Apple](https://developer.apple.com/documentation/screencapturekit), [runner-images](https://github.com/actions/runner-images/blob/main/images/macos/scripts/build/configure-tccdb-macos.sh)): `screencapture -V <seconds>` ([ss64](https://ss64.com/mac/screencapture.html), third-party), ffmpeg's avfoundation input ([ffmpeg](https://ffmpeg.org/ffmpeg-devices.html#avfoundation)) or ScreenCaptureKit. MDM privacy profiles can't grant it ([Apple](https://developer.apple.com/documentation/devicemanagement/privacypreferencespolicycontrol/services-data.dictionary)), and macOS 27's permission defaults have no Screen Recording key and need the user's consent ([Apple](https://developer.apple.com/documentation/devicemanagement/appsettings), [keys](https://developer.apple.com/documentation/devicemanagement/appsettingsappdictionaryobject)). CI images write TCC database rows with SIP disabled ([Cirrus Labs](https://github.com/cirruslabs/macos-image-templates/blob/main/.github/workflows/base.yml), [script](https://github.com/cirruslabs/macos-image-templates/blob/main/scripts/update-tcc-database.sh), [CircleCI](https://github.com/CircleCI-Public/macos-orb/blob/main/src/scripts/add-safari-permissions.sh)), and GitHub's script still does on macOS 27 ([runner-images](https://github.com/actions/runner-images/blob/main/images/macos/scripts/build/configure-tccdb-macos-27.sh)), which says apps can no longer access that database directly ([Apple](https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes)). GitHub also pre-approves replayd, because on macOS 15 and later legacy capture raises a recurring alert that takes focus ([runner-images](https://github.com/actions/runner-images/blob/main/images/macos/scripts/build/configure-tccdb-macos.sh)).

Safari 27's MCP server (`safaridriver --mcp`) lets Claude Code and Codex load pages, read the DOM and take screenshots, but it needs the "Allow remote automation and external agents" setting and has no video tool ([Apple](https://developer.apple.com/documentation/safari-developer-tools/connecting-an-ai-agent-to-safari)).

#### Playwright WebKit is not Safari

Playwright's WebKit is a patched build of WebKit's main branch and can't drive Safari; Playwright advises running it on a Mac for the closest-to-Safari results ([Playwright](https://playwright.dev/docs/browsers#webkit)). On Linux it runs WebKit's GTK port when headed and WPE port when headless ([script](https://github.com/microsoft/playwright/blob/main/browser_patches/webkit/pw_run.sh)), which paint with Skia and use coordinated graphics ([GTK](https://github.com/WebKit/WebKit/blob/main/Source/cmake/OptionsGTK.cmake), [WPE](https://github.com/WebKit/WebKit/blob/main/Source/cmake/OptionsWPE.cmake)), while the Cocoa port uses Core Graphics and Core Animation ([WebKit](https://github.com/WebKit/WebKit/blob/main/Source/WTF/wtf/PlatformUse.h)).

Safari 26.0 (September 2025) added scroll-driven animations ([Apple](https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes)), and Safari 26.4 (March 2026) moved them to the compositor thread ([WebKit](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/)). WebKit builds that path only for Cocoa: its preference requires `ENABLE(THREADED_ANIMATIONS)` ([preferences](https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml)), which defaults to 1 on Cocoa and 0 elsewhere ([Cocoa](https://github.com/WebKit/WebKit/blob/main/Source/WTF/wtf/PlatformEnableCocoa.h), [default](https://github.com/WebKit/WebKit/blob/main/Source/WTF/wtf/PlatformEnable.h)). Linux builds still support the properties, which have no feature flag, but run them on the main thread ([CSS properties](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/css/CSSProperties.json)) (inferred from source). WebKit bug 327193 shows the risk: Safari 27's threaded path drew a `translate: none` keyframe wrongly on iOS and macOS ([bug](https://bugs.webkit.org/show_bug.cgi?id=327193)). The fix shipped in Safari Technology Preview 256 on November 4, 2026, for macOS 27 and 26 only ([Apple](https://developer.apple.com/documentation/safari-technology-preview-release-notes/stp-release-256), [MacRumors](https://www.macrumors.com/2026/11/04/apple-releases-safari-technology-preview-256/)); the preview has its own safaridriver ([Apple](https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari)).

Record the Safari version with each capture: the 27.3 beta (November 16, 2026) alone lists 16 animation fixes, most for scroll and view timelines ([Apple](https://developer.apple.com/documentation/safari-release-notes/safari-27_3-release-notes)).

#### iOS Simulator Safari

The Simulator ships with Xcode, which is free ([Apple](https://developer.apple.com/documentation/safari-developer-tools/installing-xcode-and-simulators)) but needs Apple ID credentials to download ([xcodes](https://github.com/XcodesOrg/xcodes/blob/main/README.md)), so images must include it. Xcode 27 carries the iOS 27 SDK and needs macOS Tahoe 26.6 or later ([Apple](https://developer.apple.com/documentation/xcode-release-notes/xcode-27-release-notes)); iOS 26 simulators still run with Xcode 26 ([runner-images](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)). The iOS 27.2 arm64 runtime is 8,321,588,736 bytes, about 8.3 GB ([catalog](https://devimages-cdn.apple.com/downloads/xcode/simulators/index2.dvtdownloadableindex)), and installs with `xcodebuild -downloadPlatform iOS` ([Apple](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)).

safaridriver drives it with `platformName: "ios"` and `safari:useSimulator: true` ([WebKit, 2019](https://webkit.org/blog/9395/webdriver-is-coming-to-safari-in-ios-13/), [Appium Safari driver](https://appium.github.io/appium-safari-driver/latest/reference/capabilities/)). Appium's XCUITest driver also works but builds WebDriverAgent unless it is prebuilt ([capabilities](https://github.com/appium/appium-xcuitest-driver/blob/master/docs/guides/capability-sets.md), [prebuilt WDA](https://github.com/appium/appium-xcuitest-driver/blob/master/docs/guides/run-prebuilt-wda.md)). `xcrun simctl openurl` opens the page, and `io screenshot` and `io recordVideo` capture the whole device screen ([NSHipster](https://nshipster.com/simctl/), third-party). The Simulator needs an Aqua session too ([Apple, 2017](https://developer.apple.com/library/archive/documentation/DeveloperTools/Conceptual/testing_with_xcode/chapters/08-automation.html)).

It runs in Apple-silicon VMs: GitHub's Xcode 27 image, with iOS 27.0 to 27.2 simulators ([runner-images](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md)), runs on GitHub's 3-core M1, 7 GB VM runners ([GitHub](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)). In Cua's tests a Virtualization-framework guest's paravirtualized GPU reported a reduced Metal profile ([Cua, 2026](https://github.com/trycua/cua/blob/main/blog/gpu-passthrough-macos-vms.md)); its effect on Safari rendering is untested (unverified; compare captures against a physical Mac). A fresh simulator can use over 300% CPU for 1 to 2 minutes, so CircleCI recommends restoring a warm snapshot ([CircleCI](https://support.circleci.com/hc/en-us/articles/46737392770203-Reducing-iOS-Simulator-CPU-Overhead-on-macOS-Executors)); Bitrise recommends a 90-second boot timeout ([Bitrise](https://github.com/bitrise-steplib/bitrise-step-xcode-start-simulator/blob/main/step.yml)).

#### A capture recipe

1. **Boot a pre-baked image.** Provider: auto-login with FileVault off, passwordless sudo, Safari launched once and automation enabled ([Cirrus Labs](https://github.com/cirruslabs/macos-image-templates/blob/main/templates/vanilla-tahoe.pkr.hcl)). The display must fit the largest viewport: Tart defaults to 1024x768 ([Tart](https://github.com/openai/tart/blob/main/docs/quick-start.md)) and uses 72 ppi on hosts without a screen ([source](https://github.com/openai/tart/blob/main/Sources/tart/Platform/Darwin.swift)), likely `devicePixelRatio` 1 (unverified; log it per capture). No independent boot benchmark was found; MacStadium claims its Orka VMs start in under a minute ([vendor blog, 2025](https://macstadium.com/blog/orka-cluster-on-aws-how-enterprises-can-accelerate-app-development-on-ec2-macs)), but the first run of an uncached image can take several minutes ([docs](https://docs.macstadium.com/orka/orka-resources/image-caching)).
2. **Run inside the GUI session.** Provider: a LaunchAgent in the user's `gui/<UID>` domain, which Apple's developer support prefers to SSH ([forums, 2024](https://developer.apple.com/forums/thread/765060)), or a guest agent like Tart's, whose `tart exec` service runs as a global LaunchAgent ([Tart](https://github.com/openai/tart-guest-agent/blob/main/README.md)). bb's daemon would need the same placement (inferred).
3. **Start video.** Provider: Screen Recording pre-granted to the capturing process (an image built with SIP off), or host-side capture such as the Virtualization framework VNC server that Tart exposes experimentally ([Tart](https://github.com/openai/tart/blob/main/Sources/tart/Commands/Run.swift)) (unverified; a test recording would confirm). On macOS 27, Section 2N bars interfering with screen-recording indicators, so prefer host-side capture and don't copy GitHub's alert suppression into plugin images without checking ([license](https://www.apple.com/legal/sla/docs/macOS27.pdf); this report's reading).
4. **Capture Safari.** Run WebdriverIO or Selenium on the Mac itself; an old man page says the driver listens on localhost only ([man page, 2017](https://www.manpagez.com/man/1/safaridriver/)) (unverified; check `man safaridriver`). No public timing for Safari's first launch or session start was found. Open the tokenized private preview link, because automation windows start without cookies ([Apple](https://developer.apple.com/documentation/safari-developer-tools/webdriver), [plugin docs](../features.md#previews)). Safari 26.2 changed navigation's default readiness state to Interactive ([Apple](https://developer.apple.com/documentation/safari-release-notes/safari-26_2-release-notes)), so wait for load and `document.fonts.ready`, then scroll, wait two frames and take a viewport screenshot at each position.
5. **Optional iOS pass.** Provider: Xcode, a runtime and about 3 vCPU for the first boot ([CircleCI](https://support.circleci.com/hc/en-us/articles/46737392770203-Reducing-iOS-Simulator-CPU-Overhead-on-macOS-Executors)).
6. **Upload and destroy.** Provider: egress to the bucket. Apple's license sets a 24-hour minimum for each lease of a Mac ([license](https://www.apple.com/legal/sla/docs/macOS27.pdf)); see the licensing section.

Reference price (GitHub Actions is not a plugin provider):

| Runner | Price | Billing | Source |
|---|---|---|---|
| macOS standard (3-core M1 or 4-core Intel) | $0.062 per minute | Rounded up to whole minutes per job; free on public repositories | [pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing), [runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) |

Example math at that rate ([pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)), with assumed durations (unverified; time real runs on each provider):

- Safari-only capture, 4 billed minutes: 4 × $0.062 = $0.248.
- 20 Safari captures per workday for 22 workdays: 20 × 22 = 440 runs; 440 × 4 = 1,760 minutes; 1,760 × $0.062 = $109.12 per month on a private repository, or $91.12 to $97.12 after the plan's included $12 to $18, and $0 on a public one ([runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).

### Windows browser automation

#### Playwright with Edge and Chrome

- Playwright 1.65.1 (November 13, 2026) is the current release ([npm](https://registry.npmjs.org/playwright)). It supports Windows 11+ and Windows Server 2019+ with Node.js 22, 24 or 26 ([requirements](https://playwright.dev/docs/intro#system-requirements)).
- Its bundled browser has been a Chrome for Testing build since 1.57, which isn't the browser users run ([release notes](https://playwright.dev/docs/release-notes)). The `msedge` and `chrome` channels drive the installed browsers, and `npx playwright install msedge` overwrites the system copy ([browsers](https://playwright.dev/docs/browsers)). Version 1.65 was tested against Chrome 157 and Edge 156 ([release notes](https://playwright.dev/docs/release-notes)).
- Use x64. In June 2026 a maintainer wrote "I don't think we officially support windows arm" ([#41339](https://github.com/microsoft/playwright/issues/41339)).
- `recordVideo` saves one .webm per page when the context closes. By default it is scaled to fit 800x800 ([videos](https://playwright.dev/docs/videos)). Since 1.64 it uses VP9 and has an `fps` option ([release notes](https://playwright.dev/docs/release-notes)). `page.screencast` (1.59+) adds explicit start and stop, at 25 fps by default ([Screencast](https://playwright.dev/docs/api/class-screencast)).
- Both build video from JPEG frames of the DevTools screencast, encoded with Playwright's ffmpeg ([crPage.ts](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/crPage.ts), [videoRecorder.ts](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/videoRecorder.ts)). So they need no desktop capture (inferred from the code). The frames are lossy, though, so use PNG screenshots for font evidence.

#### Headless, RDP and the interactive desktop

- Every headless Chromium launch gets `--hide-scrollbars`, including the branded channels ([chromium.ts](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/chromium.ts)). Playwright has no scrollbar API ([#30228](https://github.com/microsoft/playwright/issues/30228), 2024). Scrollbar evidence therefore needs headed runs.
- Without a channel, headless runs use chrome-headless-shell, which renders in software by default ([source](https://chromium.googlesource.com/chromium/src/+/main/headless/lib/headless_content_main_delegate.cc)). The channels use Chrome's new headless mode, which changes screenshots and GPU behavior ([#33566](https://github.com/microsoft/playwright/issues/33566), 2024).
- Headed runs need an interactive desktop. Services run in session 0 and can't show UI ([services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)). Scheduled tasks with an S4U logon get a non-interactive desktop ([logon types](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type)). In August 2026 a runner-images contributor confirmed that windows-11-arm jobs run in an interactive session on WinSta0, but that processes there can't take the system foreground; the reporter's check passed on windows-latest ([#14049](https://github.com/actions/runner-images/issues/14049)). Headed Edge on those runners is unverified until one run succeeds.
- On EC2 or Azure, use autologon plus a task that starts at logon. Sysinternals Autologon stores the password as an LSA secret, while the registry method stores it in plain text ([autologon](https://learn.microsoft.com/en-us/troubleshoot/windows-server/user-profiles-and-logon/turn-on-automatic-logon)).
- SmartBear says that minimizing the RDP window drops the session's GUI and that closing RDP locks the machine. Its fix is `tscon <session> /dest:console` ([minimized](https://support.smartbear.com/testcomplete/docs/testing-with/running/via-rdp/in-minimized-window.html), [unlocked](https://support.smartbear.com/testcomplete/docs/testing-with/running/via-rdp/keeping-computer-unlocked.html)). Microsoft's tscon page doesn't document this use ([tscon](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/tscon)) (unverified; a headed screenshot after the handoff would confirm it).
- Chromium stops rendering occluded windows, and a locked screen counts every window as occluded ([occlusion](https://chromium.googlesource.com/chromium/src/+/main/docs/windows_native_window_occlusion_tracking.md)). Playwright passes `--disable-backgrounding-occluded-windows` ([switches](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/chromiumSwitches.ts)), which makes Chromium treat occluded pages as visible ([web_contents_impl.cc](https://chromium.googlesource.com/chromium/src/+/main/content/browser/web_contents/web_contents_impl.cc)). That doesn't cover minimized windows. Whether frames keep coming on a locked screen is unverified (a screenshot taken while locked would confirm it).
- Chromium turns off GPU features when the display adapter is a Microsoft-vendor one ([blocklist](https://chromium.googlesource.com/chromium/src/+/main/gpu/config/software_rendering_list.json)), and it can fall back to D3D11 WARP software rendering ([gl_switches.cc](https://chromium.googlesource.com/chromium/src/+/main/ui/gl/gl_switches.cc)). 3D CSS on GPU-less VMs may therefore differ from users' machines (unverified; comparing with a GPU instance would confirm it).
- Desktop capture tools also need the desktop. ffmpeg's ddagrab fails without access to it ([ddagrab](https://ffmpeg.org/ffmpeg-filters.html#ddagrab), [DuplicateOutput](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutput1-duplicateoutput)), and Windows.Graphics.Capture draws a yellow border around what it captures ([screen capture](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture)).

#### Fonts and scrollbars

- Linux can't stand in for Windows text. On Windows, Chromium takes its text settings from the Windows session ([font_render_params_win.cc](https://chromium.googlesource.com/chromium/src/+/main/ui/gfx/font_render_params_win.cc)), while on Linux it takes them from fontconfig ([font_render_params_linux.cc](https://chromium.googlesource.com/chromium/src/+/main/ui/gfx/font_render_params_linux.cc)).
- Many Windows fonts are optional packages that some images lack ([font support](https://learn.microsoft.com/en-us/globalization/input/font-support), 2023). Server 2025's desktop follows the Windows 11 style and pins Edge to the Start menu ([what's new](https://learn.microsoft.com/en-us/windows-server/get-started/whats-new-windows-server-2025)). Whether it ships Segoe UI Variable is unverified (comparing `C:\Windows\Fonts` with Windows 11 would confirm it).
- Playwright forces an sRGB color profile ([switches](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/chromiumSwitches.ts)).
- Chrome 136 made 15px Fluent scrollbars the default on both Windows and Linux ([Chrome Status](https://chromestatus.com/feature/5693137379917824)), so scrollbar width alone doesn't separate the two. Overlay scrollbars are off by default on Windows, so Chrome's scrollbars take layout space ([features](https://chromium.googlesource.com/chromium/src/+/main/ui/native_theme/features/native_theme_features.cc)). When overlay mode is on, Chromium can follow the `DynamicScrollbars` registry value ([settings](https://chromium.googlesource.com/chromium/src/+/main/ui/native_theme/os_settings_provider_win.cc)).
- Firefox on Windows 11 draws overlay scrollbars and follows the "Always show scrollbars" setting ([Firefox 100](https://www.mozilla.org/en-US/firefox/100.0/releasenotes/), 2022). In March 2026 a Microsoft Q&A moderator described Edge's Fluent overlay scrollbars as an edge://flags option ([Q&A](https://learn.microsoft.com/en-us/answers/questions/5831483/size-of-scroll-bar)) (unverified; checking edge://flags on the box would confirm it).
- Playwright emulates `prefers-reduced-motion: no-preference` by default ([params](https://github.com/microsoft/playwright/blob/main/docs/src/api/params.md)). Chromium's smooth scrolling still follows the Windows animation setting ([animation_win.cc](https://chromium.googlesource.com/chromium/src/+/main/ui/gfx/animation/animation_win.cc)).
- `page.screenshot` leaves animations running, while `toHaveScreenshot` turns them off by default ([params](https://github.com/microsoft/playwright/blob/main/docs/src/api/params.md)).

#### A capture recipe

1. Wake or extend the preview. Its private link carries a token ([features](../features.md#previews)). Provider: outbound HTTPS and a way to pass secrets.
2. Start an x64 Windows Server 2025 box, such as a GitHub job on `windows-2025` ([runner-images](https://github.com/actions/runner-images)). Provider: an API to start boxes, per-second or per-minute billing, and an interactive session.
   - Boot time: stock EC2 AMIs launched in about 45 s with Fast Launch ([AWS](https://aws.amazon.com/blogs/modernizing-with-aws/launch-windows-faster-on-ec2/), 2022). GitHub and Azure boot times are unverified (measuring them would confirm).
   - Windows 11 x64 instead of Server needs your own license on dedicated AWS hardware ([AWS](https://aws.amazon.com/blogs/modernizing-with-aws/bringing-your-windows-11-image-to-aws-with-vm-import-export/), 2022) or Windows 11 Enterprise E3/E5 rights on Azure ([Microsoft](https://learn.microsoft.com/en-us/azure/virtual-machines/windows/windows-desktop-multitenant-hosting-deployment)).
3. Install Playwright and its ffmpeg ([registry](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/registry/index.ts)), and use the preinstalled Edge and Chrome. These can trail the current release: the `windows-2025` image (built November 3) has version 156, while the more recently rebuilt `windows-2022` image (Server 2022, built November 12) has 157 ([2025](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-VS2026-Readme.md), [2022](https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md)). Provider: current browsers.
4. Set the display to 1920x1080 with `Set-DisplayResolution`. In 2021 the runners defaulted to 1024x768 ([#2935](https://github.com/actions/runner-images/issues/2935)). Run headed `msedge` and `chrome` at scale factors 1, 1.25 and 1.5 (Playwright's default is 1 ([params](https://github.com/microsoft/playwright/blob/main/docs/src/api/params.md))). Take PNG screenshots of the viewport (not full page) and record one scroll. Provider: an unlocked desktop.
5. Save the browser versions, OS build, ClearType settings and scrollbar settings with the files. Provider: PowerShell.
6. Upload to presigned PUT URLs created in the boat sandbox, so the Windows box never holds bucket keys ([S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html)). Presigned links last at most 7 days ([expiry](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)). The plugin's current uploader would need the bucket keys on the box ([uploader](../../assets/evidence-upload.mjs)). Provider: outbound HTTPS.
7. Delete the box. An EC2 instance terminates on shutdown only if it's configured to ([EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/Using_ChangingInstanceInitiatedShutdownBehavior.html)). Azure keeps billing a VM shut down from inside Windows until it's deallocated ([Azure](https://learn.microsoft.com/en-us/azure/virtual-machines/states-billing)). Provider: an API to delete boxes.

| Option | Price | Billing | Source |
| --- | --- | --- | --- |
| GitHub Windows 2-core x64 | $0.010/min | Rounded up per job; free in public repos | [GitHub](https://docs.github.com/en/billing/reference/actions-runner-pricing) |
| EC2 m7i.large Windows, us-east-1 | $0.1928/h | Per second, 60 s minimum | [price list](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20East%20(N.%20Virginia)/Windows/index.json), [EC2](https://aws.amazon.com/ec2/pricing/on-demand/) |
| Azure D2s v5 Windows, East US | $0.188/h | Full minutes | [retail API](https://prices.azure.com/api/retail/prices?$filter=armRegionName%20eq%20%27eastus%27%20and%20armSkuName%20eq%20%27Standard_D2s_v5%27%20and%20priceType%20eq%20%27Consumption%27), [FAQ](https://azure.microsoft.com/en-us/pricing/details/virtual-machines/windows/) |
| Playwright Workspaces, Windows browsers | $0.02/test min | Per second | [App Testing](https://azure.microsoft.com/en-us/pricing/details/app-testing/) |

Example costs per run:

- **GitHub:** a 6 min 20 s job bills as 7 min, so 7 × $0.010 = $0.07.
- **EC2, 12 minutes:** compute is 0.2 h × $0.1928 = $0.0386. A public IPv4 address adds 0.2 h × $0.005 = $0.001 ([VPC](https://aws.amazon.com/vpc/pricing/)). A 30 GB gp3 disk adds 30 × $0.08 × 0.2/730 = $0.0007 ([EBS](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ebs.json)). The total is about $0.040.
- **Azure, 12 minutes:** 12 × $0.188/60 = $0.0376, before disk and IP charges.
- **Playwright Workspaces:** 2 browsers × 3 viewports × 40 s = 4 test minutes, and 4 × $0.02 = $0.08. Whether its Windows pool offers `msedge`, `chrome` or headed mode is unverified (a trial run would confirm).

### Hosted browser-testing services vs raw boxes

#### Services

Playwright can't drive branded Safari; it tests its own WebKit build ([Playwright docs](https://github.com/microsoft/playwright/blob/main/docs/src/browsers.md)). So hosted Playwright on macOS means that WebKit build, and real desktop Safari needs WebDriver, such as Selenium ([BrowserStack](https://www.browserstack.com/docs/automate/playwright/browsers-and-os), [TestMu AI](https://www.testmuai.com/support/docs/playwright-testing.md), [Sauce Labs](https://docs.saucelabs.com/web-apps/automated-testing/playwright.md), [TestingBot](https://testingbot.com/support/web-automate/playwright/options.md)). Apple allows one Safari instance and one WebDriver session at a time, so parallel Safari runs need separate Macs or macOS VMs ([Apple, undated](https://developer.apple.com/documentation/webkit/about-webdriver-for-safari)).

| Service | Real Safari | Windows Edge and Chrome | Playwright support | Price | Source |
|---|---|---|---|---|---|
| BrowserStack Automate | Safari 27 on macOS 27 "Golden Gate", 26.4 on Tahoe; real iPhones | Windows 10, 11 | macOS: WebKit build, not Safari; real iPhones with Safari | $99 to $129 per parallel a month for desktop; $175 to $225 with real devices | [list](https://www.browserstack.com/list-of-browsers-and-platforms/automate), [pricing](https://www.browserstack.com/pricing) |
| TestMu AI (formerly LambdaTest) | Safari on Golden Gate, labeled Beta on a June 2026 page | Windows 10, 11 | macOS: `pw-webkit`, not Safari; real iPhones in beta | $79 to $99 for desktop only; real devices are a separate $199 to $249 plan | [Golden Gate](https://www.testmuai.com/test-on-macos-golden-gate/), [Playwright](https://www.testmuai.com/support/docs/playwright-testing.md), [pricing](https://www.testmuai.com/pricing.md) |
| Sauce Labs | Safari 26 and 27, "with the required subscription" | Windows 10, 11 | WebKit 26.6 build, not Safari; no macOS 27 yet | $149 to $199 | [macOS](https://docs.saucelabs.com/web-apps/macos-apple-silicon.md), [Playwright](https://docs.saucelabs.com/web-apps/automated-testing/playwright.md), [pricing](https://saucelabs.com/pricing) |
| TestingBot | Safari 27 on Golden Gate, 26 on Tahoe; real iPhones | Windows 10, 11 | WebKit build, not Safari | €0.06 a minute, or €90 to €120 unlimited | [browsers](https://testingbot.com/support/web-automate/browsers.md), [pricing](https://testingbot.com/pricing) |
| Azure Playwright Workspaces | None: Linux and Windows hosts only | Windows (edition unverified) | Playwright test runner or NUnit only | $0.02 a Windows minute | [limits](https://learn.microsoft.com/en-us/azure/app-testing/playwright-workspaces/resource-limits-quotas-capacity), [prices](https://prices.azure.com/api/retail/prices?$filter=contains%28productName,%27App%20Testing%27%29) |
| GitHub Actions runners | Safari 27.2 and SafariDriver on a macOS 26 VM | Windows Server 2025 x64; Windows 11 Arm64 (Playwright unsupported); Windows 11 x64 on larger runners | Any you install (Playwright: x64 only) | $0.062 (macOS), $0.010 (Windows) a minute | [macOS image](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md), [runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing) |

- LambdaTest renamed itself TestMu AI on January 12, 2026 ([press release](https://www.aap.com.au/aapreleases/cision20260112ae60862/)). Its Playwright on real iPhones is a beta that the account team must switch on, for Playwright 1.53 to 1.60 ([docs](https://www.testmuai.com/support/docs/playwright-ios-device.md)). BrowserStack has run Playwright on real iPhones with Safari since June 2025 ([press release](https://www.browserstack.com/press/browserstack-becomes-the-first-platform-to-enable-playwright-testing-on-real-ios-devices-with-safari)).
- Microsoft retired Microsoft Playwright Testing on March 8, 2026, in favor of Playwright Workspaces ([notice](https://www.microsoft.com/releasecommunications/api/v2/azure/499860)).
- Visual-diff services mostly re-render captured DOM instead of recording a live browser: Percy-managed Chrome, Firefox and Edge render on Linux, though Percy can also capture through BrowserStack Automate on a chosen OS, which keeps system fonts and scrollbars ([Percy](https://www.browserstack.com/docs/percy/project-settings/cross-browser)), Chromatic pauses animations ([notes](https://www.chromatic.com/docs/infrastructure-release-notes/)), and Applitools re-renders DOM states ([Applitools](https://applitools.com/platform-pricing/)). Browserbase is Chromium only ([docs](https://docs.browserbase.com/platform/browser/getting-started/remote-browser-versus-local-browser.md)); Browserless lists no Safari ([docs](https://docs.browserless.io/baas/infrastructure/supported-browsers.md)).
- The grids record session video and screenshots ([BrowserStack](https://www.browserstack.com/pricing), [TestMu AI](https://www.testmuai.com/support/docs/playwright-testing.md), [Sauce](https://saucelabs.com/pricing), [TestingBot](https://testingbot.com/pricing)). Boat's private links carry a `_token` that boat says to redact from logs, and hosting the port again returns the same token ([boat API](https://docs.boat.dev/api/reference/agent/expose-a-port)). Grids and runners should open these links without a tunnel, and vendor logs and videos will then hold the token (both unverified; one test session per vendor would confirm).

#### Prices

| Item | Price | Source |
|---|---|---|
| GitHub standard runner, macOS | $0.062 a minute | [GitHub](https://docs.github.com/en/billing/reference/actions-runner-pricing) |
| GitHub standard runner, Windows x64 or Arm64 | $0.010 a minute | [GitHub](https://docs.github.com/en/billing/reference/actions-runner-pricing) |
| GitHub included compute | $12 (Free), $18 (Pro, Team) a month; standard runners free in public repos | [GitHub](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |
| BrowserStack Automate Desktop, 1 parallel | $99 a month billed annually, $129 monthly | [BrowserStack](https://www.browserstack.com/pricing) |
| BrowserStack Automate Desktop & Mobile, 1 parallel | $175 annual, $225 monthly | [BrowserStack](https://www.browserstack.com/pricing) |
| TestMu AI Automation Desktop (All OS), 1 parallel | $79 annual, $99 monthly | [TestMu AI](https://www.testmuai.com/pricing.md) |
| Sauce Labs Virtual Device Cloud, 1 parallel | $149 annual, $199 monthly | [Sauce](https://saucelabs.com/pricing) |
| TestingBot pay as you go | €60 per 1,000 minutes (1 parallel) to €600 per 15,000 (10 parallels), so €0.06 to €0.04 a minute; real devices included; credits never expire; before VAT | [TestingBot](https://testingbot.com/pricing) |
| TestingBot Automated, 1 parallel | €50 a month billed annually or €70 monthly, 1,000 minutes, real devices included; free for open-source projects | [TestingBot](https://testingbot.com/pricing) |
| TestMu AI Real Device Plus Automation, 1 parallel | $199 annual, $249 monthly; real devices only, no desktop | [TestMu AI](https://www.testmuai.com/pricing.md) |
| TestingBot Automated Pro, 1 parallel | €90 annual, €120 monthly, before VAT | [TestingBot](https://testingbot.com/pricing) |
| Azure Playwright Workspaces, Windows | $0.02 a minute, billed by the second | [prices](https://prices.azure.com/api/retail/prices?$filter=contains%28productName,%27App%20Testing%27%29), [Azure](https://azure.microsoft.com/en-us/pricing/details/app-testing/) |
| AWS EC2 Mac (us-east-1), mac2 (M1) or mac-m4 | $0.65 or $1.23 a host-hour, 24-hour minimum | [prices](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/dedicatedhost-ondemand.json), [AWS](https://aws.amazon.com/ec2/instance-types/mac/) |
| AWS t3.large Windows Server (us-east-1) | $0.1108 an hour | [prices](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20East%20%28N.%20Virginia%29/Windows/index.json) |

GitHub cut runner prices up to 39% on January 1, 2026 ([GitHub](https://github.com/resources/insights/2026-pricing-changes-for-github-actions)). On October 28, 2026, it replaced free minutes with a dollar pool of "the same value", which Copilot cloud sandboxes also draw on ([changelog](https://github.blog/changelog/2026-10-28-work-from-anywhere-with-a-new-connected-copilot-cloud-experience/)). Whether Sauce's self-serve plans include macOS 14 to 27 is unverified; a written answer from Sauce would confirm it.

#### The math: hosted services vs raw boxes

Heavy use is 20 runs a day for 30 days: 600 runs, 3,000 Mac minutes and 3,000 Windows minutes. Light use is 10 runs a week: 10 × 52 / 12 = 43.3 runs, or 217 minutes per OS.

- GitHub, private repo ([rates](https://docs.github.com/en/billing/reference/actions-runner-pricing)): heavy is 3,000 × $0.062 + 3,000 × $0.010 = $186 + $30 = $216, or $198 after Pro's $18. Light is 216.7 × $0.062 + 216.7 × $0.010 = $13.43 + $2.17 = $15.60, or $0 to $3.60 after the allowance. Public repos pay $0 ([billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
- A hosted parallel has unlimited minutes, so both volumes cost the same: $79 to $99 (TestMu AI), $99 to $129 (BrowserStack), $149 to $199 (Sauce) ([TestMu AI](https://www.testmuai.com/pricing.md), [BrowserStack](https://www.browserstack.com/pricing), [Sauce](https://saucelabs.com/pricing)). Heavy use is 6,000 session minutes (200 a day), so one queued parallel suffices.
- TestingBot ([pricing](https://testingbot.com/pricing)): light is 433 × €0.06 = €26 pay as you go; heavy is €90 to €120 unlimited, since pay as you go would be 6,000 × €0.04 = €240.
- Break-even, private repo ([rates](https://docs.github.com/en/billing/reference/actions-runner-pricing)): a 5-minute Mac plus Windows pair costs 5 × $0.062 + 5 × $0.010 = $0.36 on GitHub. A $79 plan wins above 79 / 0.36 = 219 pairs a month, a $129 plan above 358. The included allowance adds 33 to 50 pairs.
- AWS bills EC2 Mac per second with a 24-hour minimum, citing Apple's license ([AWS](https://aws.amazon.com/ec2/instance-types/mac/)), and the current macOS license still requires 24-hour leases ([Apple](https://www.apple.com/legal/sla/docs/macOS27.pdf)). A mac2 therefore costs at least 24 × $0.65 = $15.60 per allocation, one 24-hour block a week costs 52/12 × $15.60 = $67.60 a month, and keeping it costs 730 × $0.65 = $474.50 (M4: 730 × $1.23 = $897.90). A Windows Server m7i.large started only for heavy runs costs 50 hours × $0.1928 = $9.64, plus boot time and disk; a burstable t3.large lists at $0.1108 an hour but bills extra CPU above its baseline ([burstable](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances-unlimited-mode-concepts.html)).

#### Fit for this owner

- Light use: GitHub is cheapest if Windows Server will do. macos-latest has safaridriver enabled ([script](https://github.com/actions/runner-images/blob/main/images/macos/scripts/build/install-safari.sh)), and windows-latest ships Edge, Chrome and their drivers ([image](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-VS2026-Readme.md)). The workflow dispatch API starts a run and returns its ID ([REST docs](https://docs.github.com/en/rest/actions/workflows)). Run from each site's repo, because GitHub bars runner use unrelated to the repository's project ([terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)). In a public repo any signed-in user can download artifacts ([docs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)), so send evidence to the plugin's bucket.
- Safari screen video on GitHub is unverified. The image pre-approves screen capture for the runner agent ([script](https://github.com/actions/runner-images/blob/main/images/macos/scripts/build/configure-tccdb-macos.sh)); one test job would confirm it.
- Whether Server 2025 or Windows 11 Arm64 matches Windows 11 x64 fonts and scrollbars is unverified; one side-by-side capture would show it. Raw Windows 11 clients are hard to rent: AWS WorkSpaces BYOL needs 50 WorkSpaces per Region a month ([AWS](https://docs.aws.amazon.com/workspaces/latest/adminguide/byol-windows-images.html)). GitHub's larger runners can boot a "Base Windows 11 Desktop" image at $0.022 a minute for 4 cores, but only for organizations on GitHub Team or Enterprise Cloud, and never free ([larger runners](https://docs.github.com/en/actions/reference/runners/larger-runners)). Otherwise, use a grid for Windows 11: TestingBot per minute when light, TestMu AI or BrowserStack per parallel when heavy.
- Real iPhones: TestingBot runs Selenium against mobile Safari on real devices ([docs](https://testingbot.com/support/web-automate/mobile.md)). For Playwright, only BrowserStack is generally available; which plan covers it is unverified (its plan comparison would confirm).
- Raw Macs pay off only when kept busy, for example as the owner's bb machine for Mac and iOS work. For 5-minute captures, a $15.60 minimum loses to a $0.31 GitHub run (5 × $0.062).
- A leaked preview link keeps working until its token changes. boat has no rotate command, but `boat host ID PORT --public` followed by `boat host ID PORT` issues a new token, and the old link stops working; the port is open without a token between the two calls, so stop the app first ([boat hosting](https://docs.boat.dev/hosting)). The plugin can rotate the token after each external capture.

### Test targets in the plugin

**What it is.** A `capture` capability for tasks: "take real Safari (macOS), Safari in the iOS Simulator, and Edge and Chrome (Windows) captures of this preview link." A Linux agent task on boat gets a Mac Safari capture of its own preview; the plugin runs it elsewhere and attaches the results to the task as evidence, like today's screenshots.

**How a task asks for one.** Task chats, orchestrators and native chats can call a plugin tool. Headless tasks, the default, run no bb in their sandbox, so they can't call plugin tools ([features](../features.md#how-tasks-run-in-boat-or-as-task-chats)). For them the plugin starts captures itself: when a task reports a preview (the `PREVIEW:` line it already parses, [src/briefs.ts](../../src/briefs.ts#L85)), from a new `CAPTURE:` report line, from the task page, or from an orchestrator's tools.

**Request and result.** The request names the preview link, the targets (`macos-safari`, `ios-simulator-safari`, `windows-edge`, `windows-chrome`, and the Linux baselines `linux-chrome`, `linux-firefox` and `linux-webkit`), viewport sizes and scale factors, scroll positions or a short script, and whether to record video. The result holds screenshot and video links plus the OS and browser versions that actually ran.

**Where it runs.** The plugin, on the bb machine, starts the run with its own credentials, waits, and posts the results back to the task. The agent never sees runner or grid credentials. The capture box holds only the preview link and short-lived upload links, never the agent's credentials.

**Backends**, in the order the plugin would try them:

1. **A Mac the user already holds and isn't busy** (a monthly or owned Mac enrolled in bb, or a held lease). It costs nothing extra and keeps the preview token out of third-party logs. On a Mac the plugin didn't create, the capture runs through the plugin's host entry (see [Part A](#draft-sandboxprovider-interface)). It needs a logged-in GUI session, passwordless sudo for `safaridriver --enable` and a Screen Recording grant for video ([Safari automation](#safari-and-webkit-automation-on-cloud-macs)).
2. **GitHub Actions in the site's own repo.** One workflow file per project, started through the workflow dispatch API, which returns the run ([GitHub REST](https://docs.github.com/en/rest/actions/workflows)). The workflow must be on the default branch, and dispatching needs Actions write access, while the plugin uses the `gh` login read-only today ([events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [SECURITY.md](../../SECURITY.md)). Running from the site's repo keeps inside GitHub's rule that runners serve the repository's own project; the same terms allow Actions only "to develop and test your application(s)", so keep captures to preview builds ([GitHub terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)).
   - **Safari:** a job on `macos-latest` (macOS 26, Safari 27.2) drives real Safari through `safaridriver`, which the image enables ([image](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md), [script](https://github.com/actions/runner-images/blob/main/images/macos/scripts/build/install-safari.sh)).
   - **iOS Simulator:** a second job on the `xcode-27` image, which has the iOS 27 simulators but an older desktop Safari (27.0.1) ([image](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md)).
   - **Windows:** a job on `windows-2025` runs Playwright with the `msedge` and `chrome` channels, headed (unverified: one headed run must succeed first).
   - **Cost:** a 5-minute run costs $0.31 on macOS and $0.05 on Windows in a private repo, and nothing in a public one ([GitHub pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)).
3. **A WebDriver grid account** (TestingBot, TestMu AI or BrowserStack) for Windows 10 and 11 on x64, other Safari versions and real iPhones. Recordings stay with the vendor; the plugin links to them or copies them into the bucket.
4. **A Linux baseline** in any sandbox (Playwright's Chromium, Firefox and WebKit), labeled "not Safari".

**Preview access.** boat's private link carries its token in the query and works in any browser without a tunnel ([boat hosting](https://docs.boat.dev/hosting)), which keeps remote capture simple. But the token then reaches runner logs, grid logs and recordings. In a public repo, anyone signed in to GitHub can read workflow run logs ([run logs](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs)). So the workflow's first step masks the preview link and any upload links with `::add-mask::` ([workflow commands](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands)). Capture unreleased work from private repos, and rotate the token after each external capture: `boat host ID PORT --public` followed by `boat host ID PORT` issues a new one ([boat hosting](https://docs.boat.dev/hosting)).

**Evidence upload.** The best default is presigned upload links minted where the bucket keys already live, in the task's sandbox, and handed to the capture job; the capture box then never holds keys, and the links expire within at most 7 days ([S3 presigned uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html), [expiry](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)). That needs a small uploader feature: today the bundled uploader is a Node script that signs uploads with keys from the boat environment ([assets/evidence-upload.mjs](../../assets/evidence-upload.mjs), [src/evidence.ts](../../src/evidence.ts)). The fallback is to store the bucket keys as repository secrets, the same trust model as the boat environment. Don't use workflow artifacts for private sites: in a public repo, any signed-in user can download them ([GitHub artifacts](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)).

**Limits to design for.** Safari allows one WebDriver session per macOS instance, so parallel Safari captures need parallel machines ([Apple](https://developer.apple.com/documentation/webkit/about-webdriver-for-safari)). Headless Chromium hides scrollbars and renders in software, so Windows scrollbar and font evidence needs headed runs ([Windows automation](#windows-browser-automation)). Whether Safari screen video records on GitHub's runners is unverified; one test job would settle it.

**Interface sketch:**

```ts
type CaptureBrowser =
  | "macos-safari" | "ios-simulator-safari"
  | "windows-edge" | "windows-chrome"
  | "linux-chrome" | "linux-firefox" | "linux-webkit";

interface CaptureTarget {
  id: string;                       // "github-actions", "grid", "held-mac", "sandbox"
  browsers: CaptureBrowser[];
  realBrowser: boolean;             // false for Playwright's WebKit
  minBillingSeconds: number | null; // 60 on GitHub (whole minutes); 86,400 for a new Mac lease
  maxParallel: number | null;       // Safari: one WebDriver session per macOS instance
  capture(request: CaptureRequest, signal: AbortSignal): Promise<CaptureResult>;
}

interface CaptureRequest {
  taskId: string;
  url: string;                      // the task's preview link
  browsers: CaptureBrowser[];
  viewports: { width: number; height: number; scale?: number }[];
  scrollPositions?: number[];
  script?: string;                  // optional WebDriver or Playwright steps
  video: boolean;
}

interface CaptureResult {
  items: {
    browser: CaptureBrowser;
    os: string;
    browserVersion: string;
    screenshots: string[];          // evidence links
    video: string | null;
  }[];
  costUsd: number | null;
}
```

## Part C: recommendation

### The matrix

Details and sources are in Part B. Prices are list prices on 2026-11-17.

| Provider | OS and Mac hardware | API maturity | Sessions | Previews and SSH | bb machine (task chats) | Price: Linux 4 vCPU / 8 GiB; Mac | Trust |
|---|---|---|---|---|---|---|---|
| boat.dev | Linux (Ubuntu 24.04, x86_64). No Mac, no Windows | GA, self-serve: CLI, REST v1, TS and Python SDKs | No cap on paid plans; fixed auto-stop (1 h default, up to 30 days or off); disk snapshots | Token-gated preview links; SSH with stdin | Yes, today | $0.036/h flat, per second; $20/month minimum | Dedicated EU hosts; one KVM VM per sandbox; SOC 2 in progress |
| Instabox | Linux (Firecracker, x86_64); macOS 26 with Xcode in a VM on a whole leased Mac (M2, M2 Pro, M4, M4 Pro); Windows listed but not launched | Public REST API (OpenAPI), CLI with an agent runner, TS and Python SDKs; launched 2026-10-14, Pro skips the waitlist | Linux: no cap on paid plans, pause keeps memory, free disk snapshots. Mac: no pause, 24 h minimum lease | Public or token-gated port URLs; SSH gateway | Likely on paid Linux (untested); macOS unknown | $0.034/h; Mac $0.45 to $1.25/h with a 24 h minimum ($10.80 to $30) | Six-person YC company; AWS and Latitude.sh; Mac host unstated |
| Darkbloom | Linux (arm64) and experimental macOS VMs on Macs owned by approved third parties. No Windows | Experimental, invite-only; CLI sent by hand; no documented REST API or SDK | 24 h max per boot; idle stop ignores work inside; no snapshots | No inbound ports or preview URLs; SSH through the CLI | Unverified, and it would hold credentials Darkbloom says to keep out | $0.192/h; Mac $0.35 to $0.90/h, per second | No confidentiality claimed against the Mac's owner; Darkbloom can decrypt workspaces |
| Modal | Linux only (gVisor or KVM VMs, x86-64) | Platform GA; Python SDK stable, JS and Go SDKs Beta | 24 h max lifetime; no pause; filesystem snapshots (memory snapshots Alpha) | Public tunnels or token-gated Connect Tokens; no managed SSH | Yes, through bb's official Modal plugin (experimental) | about $0.48/h reserved, less when bursting; $0 plan with $30 credit | Capacity rented from large clouds; shared hosts; SOC 2 Type II |
| Vercel Sandbox | Linux only (Firecracker, x86-64) | GA since 2026-01-30; TS and Python SDKs, CLI | 24 h max on Pro (45 min on Hobby); no idle stop; filesystem snapshots | Public, unauthenticated URLs (up to 15 ports); no OpenSSH | Likely (untested); daemon restarts every session | $0.22/h at 10% CPU to $0.68/h at 100%; $20/month Pro | Vercel's platform on AWS bare metal; Firecracker microVMs; broad compliance |

Reading the matrix:

- **No single provider covers the brief.** boat.dev, Modal and Vercel are Linux-only. Darkbloom has Macs but fails on trust, networking and API access. Of the five, only Instabox has a self-serve Mac API, and nobody among the five sells Windows.
- **Mac work splits in two.** Among options that fit, short Safari and Simulator captures are cheapest on per-minute macOS CI runners, which GitHub runs under its own responsibility for Apple's terms; Darkbloom bills less per run but is out on trust and access ([licensing](#macos-licensing-the-24-hour-rule)). Renting a Mac for agent work means a whole-Mac lease of at least 24 hours (Apple's Section 3A), which Instabox enforces ([Instabox macOS](https://instabox.sh/docs/machines/macos.md)). A Mac the user owns has no minimum.
- **Cheaper whole Macs exist outside the five.** Scaleway rents Mac minis by the day (from €2.64, 24-hour minimum) or the month (from €75), with a public API, and Daytona sells macOS sandboxes on reserved Macs ($60.08 a day) (see [Prices side by side](#prices-side-by-side)). Neither was researched in depth here.
- **bb already has the machine layer.** The plugin registers boat as a bb machine provider today ([src/machine.ts](../../src/machine.ts)), and bb ships an official Modal provider with an internal backend interface meant for more vendors ([bb providers](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers/README.md)).

### Recommended architecture

**Two layers, kept apart.**

1. **Sandbox providers**: machines where agents work for hours. They need exec, a lifecycle, previews, secrets, a GitHub credential, and either bb enrollment or an agent runner.
2. **Test targets**: short-lived browsers that capture a preview URL and return screenshots and video. They need no agent logins, no bb daemon and no repo credentials, only the preview link and short-lived upload links.

Mixing them would force the 24-hour Mac lease onto five-minute captures, and put agent credentials on boxes that only need a URL.

**Two runners per provider.**

- **Task chats** (bb enrollment) work wherever a provider gives a lifecycle and an executor: bb installs its daemon and runs Claude Code or Codex as a bb chat ([bb Modal plugin README](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/README.md)). They need bb Connect (on macOS, also a logged-in GUI session for bb's LaunchAgent), and they put bb machine credentials in the sandbox, plus the bb server's `gh` token, which reaches every repo that login can reach ([git-credentials.ts](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/services/machines/git-credentials.ts)). So the plugin's trust rules keep them to repos you trust, unless the user confirms a task chat for an untrusted one ([src/service.ts:1466](../../src/service.ts#L1466)).
- **Headless tasks**, the default, need an agent runner on each provider: boat's today; Instabox's `instabox agent prompt|events|steer|interrupt` next (CLI only, with resumable conversations) ([Instabox CLI](https://instabox.sh/docs/reference/cli.md)); a generic exec-based runner for the rest (Part A). Until a provider has one, untrusted repos (unless the user confirms a task chat) and users without bb Connect stay on boat.
- **The plugin's own steps** (checkout with the push guard, the evidence uploader, size checks, previews) still need exec, a preview path and a GitHub credential from the provider, as Part A lists. On machines another plugin or the user creates (bb's Modal provider, a Mac enrolled by hand), bb gives the plugin no exec; they would run through a plugin host entry reached with `bb.hosts.experimental_client` (experimental, untested here; see Part A).

**Where the code lives.** Follow the layout bb uses for its Modal backend ([bb providers](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers/README.md)): vendor calls in one folder per provider, everything else provider-neutral.

```text
src/providers/
  types.ts          SandboxProvider, capabilities, CapacityReport (Part A)
  registry.ts       enabled providers; picks one per project, task and OS
  machine.ts        registers any provider as a bb machine provider
                    (today's src/machine.ts minus the boat calls)
  shell.ts          POSIX or PowerShell script rendering, home and temp paths
  exec-runner.ts    later: headless runner on exec for providers without one
  boat/             today's boat.ts and most of boat-api.ts, setup checks,
                    fake CLI fixtures
  instabox/         REST client, CLI runner adapter, Mac lease handling
  scaleway/         optional: whole-Mac leases through Scaleway's API
  vercel/           SDK adapter
  bb-provider/      chat-only machines: another plugin's bb machine provider
                    (bb's modal-sandbox) and existing bb machines; not a full
                    SandboxProvider (no exec, limits or sizes without a host entry)
src/capture/
  types.ts          CaptureTarget, CaptureRequest, CaptureResult
  github-actions.ts workflow in the project's own repo
  grid.ts           WebDriver grid account (Windows 11 x64, real iPhones)
  sandbox.ts        capture inside a sandbox or a held Mac
```

An alternative for the Linux vendors: contribute Instabox or Vercel backends to bb's own sandbox plugin, which documents how to add one, and drive them through `bb-provider/`, keeping only runners, previews and Mac lease rules here ([bb providers](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/providers/README.md)). bb wants an approved issue before a pull request ([CONTRIBUTING](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/CONTRIBUTING.md)).

**Users bring their own accounts.** Modal, Vercel and Instabox all forbid reselling or giving third parties access ([Modal terms](https://modal.com/legal/terms), [Vercel section](#vercel-sandbox), [Instabox terms](https://instabox.sh/terms)). Apple's license makes whoever leases Macs to others a Lessor with enforcement and notice duties ([macOS 27 SLA](https://www.apple.com/legal/sla/docs/macOS27.pdf)). So the plugin should never pool accounts or Macs across users. Each user signs in to their own providers, as they do with boat today.

### Settings and UI

- **Settings → Providers:** enable providers and pick a default for Linux and one for macOS. Use each vendor's CLI login on the bb machine where one exists (boat, and Instabox's `instabox login`), as the plugin does with boat today. Store a token as a bb secret setting only where no CLI login exists, and update SECURITY.md, which today promises no stored API keys ([SECURITY.md](../../SECURITY.md)). The setup checklist shows one row per enabled provider, from its `availability()` and doctor checks.
- **Projects:** a **Runs on** choice (provider and size) and a **Needs macOS** switch. Mac-only projects never start on Linux.
- **New task:** show a provider or OS choice only when more than one is enabled. Before the first Mac task of a lease, say what it costs ("Starts a 24-hour Mac lease: $10.80").
- **Sandboxes page:** group by provider. Show a Mac lease's end time, and keep the lease until then rather than stopping it early, since a stop inside the minimum doesn't save money ([Instabox macOS](https://instabox.sh/docs/machines/macos.md)).
- **Capture:** per project, the capture targets (Safari on macOS, Safari in the iOS Simulator, Edge and Chrome on Windows, Chrome on Linux), the backend for each, and a monthly budget.

### Tiers, quotas and the start queue

- **Model tiers and agent quotas don't change.** They describe Claude and Codex subscriptions, not sandboxes, and the audit found them provider-independent ([src/limits.ts](../../src/limits.ts), [src/quota.ts](../../src/quota.ts)). Only the model-id and effort mapping in `src/tiers.ts` moves into each runner.
- **Plan limits become a CapacityReport per provider:** concurrency in its own unit (sandboxes, vCPUs or memory), start windows, the auto-stop cap and included hours, with sizes from `sizes()` (Part A). boat's `limits` maps onto it directly. Providers without a limits API get plugin-side limits: **Sandboxes at once** per provider, plus an optional monthly spend cap computed from the provider's price table.
- **Make room, then queue.** Today a full account first makes room: with **Make room at your sandbox limit** on (the default), the plugin stops the least recently used idle sandbox, and the task fails only when nothing can be stopped or boat's start limits are used up ([src/service.ts](../../src/service.ts#L817), [settings](../settings.md)). The start queue itself waits only when agents are at their usage limit ([src/start-queue.ts](../../src/start-queue.ts)). With several providers and scarce Macs: make room per provider lane, never count a Mac lease inside its paid minimum as room, and queue instead of failing.
- **Mac leases are a pool of one, per user.** When the provider bills 24 hours at a time, the plugin keeps one lease, runs queued Mac tasks and captures on it until the lease ends, and stops it then unless work is waiting. It never shares a lease across users, for the licensing reason above.

### Phased plan

| Phase | What | Why this order | Needs the owner |
|---|---|---|---|
| 0 | Decisions and accounts: capture backends, Mac budget, a Mac provider account, and the id scheme for new providers (the display name can be decided any time). Enroll a rented or owned Mac by hand in bb and use bb's own chats on it now. File a bb issue asking for a Windows bootstrap path for plugin machine providers | Accounts gate Phases 2 to 4; Phase 1 needs none. bb wants an issue before a pull request | Yes: all of it |
| 1 | 1a: extract the provider interface with boat.dev as the only implementation. 1b: the audit fixes that change behavior (idempotent creates, a start queue that waits for capacity, the hooks path) | Every later phase needs it. 1a changes no behavior, so it is safe to ship alone; 1b ships separately | Review only |
| 2 | Cross-platform capture (test targets): a held Mac and GitHub Actions first, then a grid | Solves the Safari and Windows testing need at cents per run, with no new Mac lease and only a preview link and upload links on other boxes; doesn't depend on Phase 1 and can overlap it | Merge a capture workflow into each site repo's default branch; let the plugin's `gh` login dispatch workflows; a grid account if wanted |
| 3a | Plugin tasks on an existing bb machine: an owned Mac, or one rented by the month | No provider API work, and bb already supports macOS hosts. But the plugin's checkout, hook, Ship and evidence steps need a plugin host entry there, or Mac tasks run in bb's own checkout without them | Enroll the Mac, with auto-login on so bb's LaunchAgent can register |
| 3b | One Mac API adapter (Instabox or Scaleway), plus Instabox's agent runner for headless tasks | Lets the plugin start and stop leases itself; Instabox's Linux side also checks the interface on a second vendor | Provider account; vendor answers |
| 4 | Modal (through bb's own provider) and Vercel Sandbox | A plugin user asked for them (per the research brief), but they are Linux-only, so they add choice rather than new capability | Modal and Vercel accounts for testing |
| 5 | Windows workspaces | Blocked by bb and by the plugin's POSIX assumptions, not by supply: Daytona, Orgo, Windows 365 for Agents, EC2 and Azure sell Windows machines with APIs, but none of the five does | Provider choice; bb support |

**This order puts the second use case first.** The brief makes Mac and iOS work the priority. Capture still comes first because it is cheap, low-risk and works with the plugin as it is, while Mac agent work can start at once in bb's own chats on a Mac enrolled by hand (Phase 0). Swap Phases 2 and 3a if routing the plugin's own tasks to a Mac matters more.

**Phase 1: extract the interface.** Split `src/boat-api.ts` and `src/boat.ts` into a boat adapter and neutral modules. Add a state normalizer, the CapacityReport, the shell abstraction and provider-scoped ids, and generalize the bb machine registration in the shape of bb's `SandboxBackend`. Then, as a separate step because they change behavior, fix the audit issues that would otherwise multiply with each provider: idempotent creates, a start queue that waits for capacity, and the hooks path. The existing tests keep passing against the fake boat CLI, and a second fake provider tests the neutral code. Part A has the sizes and the invasive spots.

**Phase 2: cross-platform capture.** A `capture` tool for task chats and orchestrators, plus plugin-started captures for headless tasks, with results as evidence links. Details are in [Test targets in the plugin](#test-targets-in-the-plugin). It answers the most concrete need (Safari rendering of scroll-driven and 3D CSS, Windows fonts and scrollbars) for far less money and risk than Mac workspaces.

**Phase 3: Mac agent workspaces.** Start with an existing machine: bb can enroll a Mac by hand with `bb machine create --provider manual` ([bb machines guide](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/packages/templates/src/templates/bb-guide-machines.md#L372-L392)). The plugin then routes Mac tasks there as task chats, using bb's existing-machine selection ([environment-provider types](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/packages/server-contract/src/api/shared.ts#L126-L140)). Manual machines never idle-suspend and can't be suspended or resumed, so an hourly lease enrolled by hand bills until someone deletes it; this step suits owned or monthly Macs. The plugin can't run commands on a machine it didn't create, so its own steps (the per-task checkout, the protected-branch hook, Ship and the evidence uploader) need a plugin host entry, reached through `bb.hosts.experimental_client` ([backend-contract.ts](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/packages/plugin-sdk/src/backend-contract.ts#L2139-L2147); experimental). Without one, Mac tasks run in bb's own project checkout without those steps. bb's macOS installer also registers a LaunchAgent, which needs a logged-in GUI session: turn on auto-login (FileVault off), or set `BB_INSTALL_SKIP_SERVICE=1` and restart the daemon after reboots ([install-machine.sh](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/apps/server/src/assets/install-machine.sh#L1047-L1118)). Then add one Mac API adapter so the plugin can start and stop leases itself:

- **Instabox:** macOS 26 with Xcode in a VM, Linux on the same account, and an agent runner. But Mac support is days old, and Xcode, Simulator and signing details are undocumented ([Instabox section](#instabox)).
- **Scaleway:** whole Mac minis with VNC and SSH, a public API and a 24-hour minimum it can enforce with automatic deletion ([FAQ](https://github.com/scaleway/docs-content/blob/main/pages/apple-silicon/faq.mdx), [API docs](https://github.com/scaleway/docs-content/tree/main/pages/apple-silicon/api-cli)). It is cheaper, but Paris-only and not researched in depth here.

**Phase 4: Modal and Vercel.** For Modal, drive bb's own `modal-sandbox` machine provider through `hosts.experimental_create` instead of writing a Modal client ([bb Modal plugin README](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/plugins/environment-modal-sandbox/README.md)). The user installs bb's official Modal plugin. That path is chat-only, so trusted repos unless the user confirms, with no boat-style preview links, plan limits or usage, and the plugin can't run its own steps there without a host entry; if users want more, port Modal into the plugin's own adapter later. For Vercel, write an adapter on `@vercel/sandbox`, with a token-checking proxy for previews, because its URLs are public ([Vercel section](#vercel-sandbox)).

**Phase 5: Windows.** Start when bb can enroll Windows hosts from a provider plugin and the user picks a Windows provider. Meanwhile, a Windows VM or PC can be enrolled by hand with bb's PowerShell command (bb's native Windows host is alpha) ([bb machines guide](https://github.com/get-bb/bb/blob/de34f3492e4c69ade967e7b9b1345c9e8d62b03d/packages/templates/src/templates/bb-guide-machines.md#L372-L392)), and Windows stays a capture target.

**Darkbloom is not in the plan.** Revisit it if it publishes an API, offers isolation from host owners (or Macs it owns), and states its basis under Apple's license.

### Open questions

**Need vendor contact or an account** (the research rules allowed neither):

- **Instabox:** Xcode and Simulator versions on the Mac image; whether signing, the keychain, Screen Recording and `safaridriver` work in headless sessions; whether ports, Secrets and the agent runner work on macOS; where the Macs are hosted, and when the sub-processor list will name them; whether Apple was notified under Section 3A and how lessees accept Apple's terms; whether the half-size mode (two VMs per Mac) fits Section 3D; whether a new Pro signup gets access at once; whether bb's daemon stays connected under idle pause and Org Secrets, and whether its LaunchAgent can register on the Mac VMs (is a GUI session logged in?); how long a macOS create takes; whether Mac lease charges draw on the plan credit; Windows edition, sizes, price and date; whether its SOC 2 report covers Instabox.
- **Scaleway:** macOS versions and Xcode on its Mac minis, stock, VAT for the owner's location, and how mature its Apple silicon API is.
- **Darkbloom:** any written Apple arrangement; whether customers can restrict sandboxes to Darkbloom-owned Macs; a GA date and service level.
- **Modal:** whether this plugin may drive bb's `modal-sandbox` provider through `hosts.experimental_create` and reuse its settings (Phase 4 depends on it); snapshot storage price; maximum CPU and memory per sandbox; JS SDK stability plans.
- **Vercel:** whether project-scoped tokens cover every Sandbox call; whether bb's daemon runs and restarts each session; whether Sandbox is in the SOC 2 and HIPAA scope; how long command output is kept.
- **Daytona:** whether Windows sandboxes still need Tier 3; how mature its macOS sandboxes and SDK are.
- **GitHub:** whether Safari screen video records on hosted macOS runners; whether headed Edge and Chrome render, with scrollbars, on `windows-2025`; whether a throwaway bb machine on a macOS runner fits the Actions terms.
- **Grids:** whether logs and session videos keep the preview token, and for how long; whether Sauce Labs' self-serve plans include current macOS; which BrowserStack plan covers Playwright on real iPhones.
- **Azure:** Playwright Workspaces' Windows edition, `msedge` and `chrome` channels, and headed mode.
- **boat.dev:** SOC 2 timeline; any plans for macOS or Windows; a token rotation that doesn't leave the port open in between.
- **bb:** whether provider plugins will get a Windows bootstrap path and a service mode for the Windows daemon; whether a plugin may enroll a Windows box as a manual machine with the PowerShell command bb prints (inferred possible).

**Need the owner:**

- Mac budget: an owned Mac ($0 a month), a Mac rented by the month (€75 to 115 at Scaleway before VAT, $109 to $149 at MacStadium, $328.50 for an Instabox M2), or 24-hour leases on demand (€2.64 to 4.08 at Scaleway, $10.80 to $30 at Instabox)?
- Phase order: capture before Mac workspaces, as proposed, or the other way round?
- Capture: GitHub Actions only, or also a grid account for Windows 11 x64 and real iPhones? Are the site repos public (free runner minutes, but public logs) or private?
- May the plugin's `gh` login dispatch workflows, and may capture workflows hold evidence-bucket keys as repository secrets if presigned links aren't built?
- Accept Instabox's maturity risk (one month old; Macs since 2026-11-12) for Mac work, or start with Scaleway or an owned Mac?
- Allow Darkbloom for work without secrets, or leave it out entirely?
- Require task chats (and so bb Connect) for non-boat providers until their runners exist?
- Naming (below).

### Naming

The plugin is "Boat Cloud Agents", its commands live under `bb boat`, and its skills are `boat` and `boat-orchestrator` ([package.json](../../package.json)). Once it supports several providers, "Boat" names one vendor among many, and the README already has to explain that the plugin isn't made by boat.dev ([README](../../README.md)). Options, without a decision:

- **Keep the name.** No migration and no lost recognition, but more confusion with the vendor as other providers arrive.
- **A descriptive name**, such as "Cloud Agents", which the plugin's page already uses. Clear, but generic and hard to search for.
- **A new name** that keeps the nautical theme without naming a vendor (a harbor or fleet idea). Check existing products and marks first.

A rename touches the plugin id and settings keys, the `bb boat` command namespace (keep an alias), the skill names, the agent tool names (`boat_*`), the data folder (`plugins/boat`), the bb machine provider and environment ids (`boat-sandbox`, `boat-sandbox-personal`) that bb stores on existing machines and threads, the marketplace entry, the docs and the screenshots ([src/machine.ts](../../src/machine.ts), [src/tools.ts](../../src/tools.ts)). The display name can change last, but pick the id scheme for new providers' machine and environment ids before Phase 1.
