# Name check: "Harbormaster"

Checked on 2026-11-19, public sources only, no sign-ups. This is a desk check,
not legal advice.

## Verdict

1. **Go with caveats.** "Harbormaster" is free where it matters most (npm, Homebrew, crates, no live US software mark, no plugin in the bb marketplace).
2. **Biggest risk is the near name "Harbor", not "Harbormaster".** Two active agent tools already ship a `harbor` CLI, and goharbor's registry is huge.
3. **One direct lookalike:** a small macOS app, also called Harbormaster, for running many coding agents (0 stars, since Oct 2026). Plus a CI/CD product at harbormaster.io.
4. **Not verified:** EUIPO and WIPO could not be queried from a script. Run those two searches by hand before the brand goes on a website or logo.
5. **Suggestion:** use `bb harbormaster` as the documented namespace. Keep `bb harbor` as the short alias, but don't lead with it in docs. Keep `bb boat` as the alias as planned.

## 1. Trademarks

Source for the US marks is Trademarkia's index of USPTO records (the USPTO
search itself is a JavaScript app that a script can't drive):
[HARBORMASTER](https://www.trademarkia.com/search/trademarks?query=harbormaster),
[HARBORMASTER*](https://www.trademarkia.com/search/trademarks?query=harbormaster*),
[HARBOR MASTER](https://www.trademarkia.com/search/trademarks?query=harbor%20master).
Re-confirm any hit you care about on the
[USPTO search](https://tmsearch.uspto.gov/).

### US, "HARBORMASTER" (one word): 1 live mark, not software

| Owner | Serial | Class | Status |
| --- | --- | --- | --- |
| Harbormaster Toy Company, LLC | 99197710 | 28 (wooden toy boats) | Live, pending (filed 2025-05-22) |

Everything else is dead. The only software one is old: QuickStream Software,
serial 75361434, class 9, filed 1997, abandoned 1998. Other dead marks are in
classes 3, 6, 9 (a boat monitoring system and telescopes), 19, 23, 33, 36
and 37.

### US, "HARBOR MASTER" (two words): 2 live marks

| Owner | Serial | Class | Status |
| --- | --- | --- | --- |
| Imangi Studios, LLC | 85085293 | 9 (computer game programs and software) | Live, registered (renewed 2021, to 2031) |
| Central Garden & Pet Company | 74138760 | 12 (boat covers) | Live, registered |

The class 9 one is a mobile game, so the goods are far from an agent
orchestrator. It is the only live mark of the three in a software class, and
it is worth a look from a trademark attorney if you file your own.

### EUIPO and WIPO: not checked

[WIPO Global Brand Database](https://branddb.wipo.int/) and
[TMview](https://www.tmdn.org/tmview/) (which includes EUIPO) are
JavaScript apps behind bot protection. A scripted request was rejected, and a
web search found no HARBORMASTER filing but cannot prove there is none.
**To do by hand:** search "harbormaster" and "harbor master" in
[EUIPO eSearch plus](https://euipo.europa.eu/eSearch/), WIPO and the
[UK IPO](https://www.search-for-trademark.service.gov.uk/), filtered to Nice
classes 9 and 42.

### Near name "Harbor"

Harbor (the container registry) is a CNCF graduated project
([CNCF page](https://www.cncf.io/projects/harbor/)). Harbor in the agent
space is a product ([gethrbr.com](https://gethrbr.com)) and a framework
([harborframework.com](https://harborframework.com)), both below. "Harbor"
alone is a crowded word in developer tools. "Harbormaster" is a longer, more
distinctive word, but a reader may still shorten it to "Harbor".

## 2. Dev tools and products with the same or a near name

### Same name: "Harbormaster"

| What | Where | Use | Overlap |
| --- | --- | --- | --- |
| **Harbormaster, macOS app**: kanban of coding-agent tasks, each in its own worktree and session, installs a `harbormaster` command | [finete/harbormaster](https://github.com/finete/harbormaster) | 0 stars, created 2026-10-05, Homebrew via its own tap only | **High in meaning**: coding agents, task board, reviews. Low in reach. |
| Harbormaster, "portable workflow automation for CI/CD" | [harbormaster.io](https://harbormaster.io) | A live company site | Medium: dev tools, different job |
| Harbormaster (Phabricator and Phorge): the build and CI application | [Phorge docs](https://we.phorge.it/book/phorge/article/harbormaster/) | Established in Phorge, [phorge](https://github.com/phorgeit/phorge) has 211 stars | Low: a feature name inside a forge tool (Phorge is the maintained fork of Phabricator) |
| harbormaster, "the tiniest container orchestrator" | [skorokithakis/harbormaster](https://github.com/skorokithakis/harbormaster) | 45 stars, AGPL, active | Medium: "orchestrator" and a name collision on GitHub search |
| harbormaster, Kubernetes webhook | [Nike-Inc/harbormaster](https://github.com/Nike-Inc/harbormaster) | 41 stars, last push 2017 | Low, dormant. Its [Docker Hub image](https://hub.docker.com/r/nikeoss/harbormaster) has about 627k pulls. |
| harbormaster, docker remote host forwarding | [tanishq-dubey/harbormaster](https://github.com/tanishq-dubey/harbormaster) | 9 stars, 2020 | Low |
| harbormaster, MCP server routing Q&A across projects | [FleetQ/harbormaster](https://github.com/FleetQ/harbormaster) | 3 stars, 2026 | Low to medium: AI and MCP |
| `@simon-says-build/harbormaster`, port-lease daemon | [npm](https://www.npmjs.com/package/@simon-says-build/harbormaster) | Scoped npm package, 2026-11 | Low |
| Harbormaster CLI (generates web apps), `harbormaster-cli`, `harbormaster-ai` | [npm](https://www.npmjs.com/package/harbormaster-cli) | Dormant since 2022, 31 downloads a month | Low |
| harbormaster, Feature Flag CLI | [npm `@micoverde/harbormaster`](https://www.npmjs.com/package/@micoverde/harbormaster) | Scoped, 2026-04 | Low |

Several small GitHub repos also use the name (a MinIO admin UI, a Docker
registry frontend, an Anno 1800 mod). A GitHub search for "harbormaster"
returns about a dozen of them, none with more than 50 stars.

### Near name: "Harbor"

| What | Where | Use |
| --- | --- | --- |
| **Harbor** (CNCF graduated) container registry | [goharbor/harbor](https://github.com/goharbor/harbor) | 29.8k stars. Official CLI: [goharbor/harbor-cli](https://github.com/goharbor/harbor-cli), 167 stars, in Homebrew as [`harbor-cli`](https://formulae.brew.sh/formula/harbor-cli). |
| **Harbor** agent and model evaluation framework (from the Terminal-Bench team); runs Claude Code, Codex and others | [harbor-framework/harbor](https://github.com/harbor-framework/harbor), [site](https://harborframework.com) | 7.3k stars. [PyPI `harbor`](https://pypi.org/project/harbor/), about 9M downloads in the last month ([pypistats](https://pypistats.org/packages/harbor)). Installs a `harbor` command (`[project.scripts] harbor` in its [pyproject](https://github.com/harbor-framework/harbor/blob/main/pyproject.toml)). |
| **Harbor** memory, guardrails and code review for coding agents; installs via `harborloop` and ships a `harbor` binary | [gethrbr.com](https://gethrbr.com), [npm `harborloop`](https://www.npmjs.com/package/harborloop) | Active, released 2026-11-15. **Closest to the plan's "reviews and safety rules".** |
| AgentHarbor, a desktop app for coding-agent usage | [abhiunix/AgentHarbor](https://github.com/abhiunix/AgentHarbor) | 16 stars |
| agent-harbor, a TUI agent orchestrator | [JesseZen/agent-harbor](https://github.com/JesseZen/agent-harbor) | 3 stars |

### AI-agent products named "Harbormaster"

A web search for "Harbormaster AI coding agents orchestrator" found none
beyond the small macOS app above. The crowded names in this space are the
orchestrators themselves (Coral, Tide Commander and others), not Harbormaster.

### Package names

| Registry | `harbormaster` | `harbor` |
| --- | --- | --- |
| npm | **Free** ([registry](https://registry.npmjs.org/harbormaster)) | Taken: [old port-assignment utility](https://www.npmjs.com/package/harbor), last release 2022, about 1.8k downloads a month |
| PyPI | Taken: [docker host forwarding script](https://pypi.org/project/harbormaster/), 2020, about 33 downloads a month | Taken: the Harbor evaluation framework (above) |
| Homebrew core (formula and cask) | **Free** ([formula](https://formulae.brew.sh/api/formula/harbormaster.json), [cask](https://formulae.brew.sh/api/cask/harbormaster.json), both 404) | Free as a name in core, but `harbor-cli` exists |
| crates.io | **Free** ([API](https://crates.io/api/v1/crates/harbormaster)) | Taken |
| RubyGems | Free | not checked |
| Docker Hub | [`nikeoss/harbormaster`](https://hub.docker.com/r/nikeoss/harbormaster) and two small ones | not checked |

The plugin is installed through the bb marketplace, not npm, so the npm
and PyPI names matter only if you later publish a standalone package. If you
do, claim `harbormaster` on npm early.

## 3. bb plugin marketplace and community plugins

- The [community marketplace repo](https://github.com/get-bb/marketplace) is
  public. Checked its `entries/` (634 files at the time) and the rest of the
  repo: **no entry, tag, description or reserved id mentions "harbor"**.
- The [bb repo](https://github.com/get-bb/bb) (cloned at commit `df9619d`) has no
  occurrence of "harbor" anywhere, so there is no built-in plugin, skill or
  command with that name.
- Nearby entries, for positioning only: `boat` (this plugin's current id),
  `bb-box` (a computer per thread on Docker, Tart, SSH, boat.dev and others),
  `cloud-sandbox`, `dockside`, `orchestrator-mode`, `agent-board`,
  `account-pool-balanced`. None is named like Harbormaster.
- Marketplace rules to plan around ([README](https://github.com/get-bb/marketplace#readme)):
  the entry id must equal the file name; and "a new marketplace pull request
  for a source, name, or brand change". So the rename needs a new PR that
  adds `entries/harbormaster.json` (or changes the `boat` entry), and the
  `boat` entry is currently owned by a different GitHub account than this
  repo's `origin`. Settle who files that PR before the rename work starts.
- Skill and plugin ids: pick the id now (`harbormaster`) so it can be
  reserved in the same PR.

## 4. Domains and handles (quick look)

RDAP and DNS, 2026-11-19:

| Name | Result |
| --- | --- |
| harbormaster.dev | **Registered** since 2020-05-28, expires 2027-05-28, locked (update, transfer and delete prohibited), no website reachable |
| harbormaster.sh | **Has nameservers, so registered**; RDAP not available for `.sh`; no website reachable |
| harbormaster.app | **Registered** 2026-08-13, resolves to an IP, no HTTPS response |
| harbormaster.com | Registered since 1999, returns 403 |
| harbormaster.io | Registered, live CI/CD product site |
| harbormaster.ai | Registered 2026-03-19, live site |
| GitHub user `harbormaster` | Taken (created 2025-07-18, 0 repos) |
| GitHub user `harbormaster-dev` | Free |
| GitHub org `harbormaster-public` | Taken (1 repo, a framework from 2023) |

Plain read: the obvious short domains are gone. Alternatives to check by
hand: `useharbormaster.com`, `harbormaster.tools`, `getharbormaster.dev`.
For GitHub, the plugin already lives under its own owner; no org is needed.

## 5. Command name: `harbor`

- `bb harbor` is a subcommand of `bb`, not a new binary on `PATH`. So it does
  not shadow the `harbor` command (the Harbor evaluation framework, goharbor
  and the `harborloop` binary all use that name), and they don't shadow it.
  Nothing breaks at runtime.
- **The confusion is in docs and search.** "harbor CLI" already means three
  things (goharbor, the evaluation framework, the memory and guardrails
  tool). Questions like "harbor task start" in an issue or a prompt will
  be ambiguous, and an agent that has `harbor` on its `PATH` may run the
  wrong one if a skill says `harbor ...` without the `bb ` prefix.
- **Do not ship a standalone `harbor` executable.** Always write `bb harbor`
  or `bb harbormaster` in skills, docs, error messages and agent prompts.
- **Recommendation:** make `bb harbormaster` the documented, canonical
  namespace (unambiguous, and what search finds), keep `bb harbor` as a short
  alias, and keep `bb boat` working. Existing skills and prompts that say
  `bb boat ...` (for example `PLUGIN_OVERVIEW.md`, `SECURITY.md` and the entry prompt in
  `web/entry-logic.ts`) keep working through the alias.
- Whichever you choose, `bb harbor` needs no check against bb's own commands:
  the bb repo has no command or plugin by that name.

## Top risks, in order

1. **`harbor` is crowded in exactly this space** (agent evaluation, agent
   guardrails and review, container registry). Lean on the full word
   "Harbormaster" and avoid "Harbor" as a standalone brand.
2. **A small lookalike, Harbormaster for macOS.** Same word, same audience
   (coding agents, task board), shipping its own `harbormaster` command. It is
   tiny today, but it would be searchable next to this plugin, and the
   `harbormaster` command name could collide if either ever ships a binary.
3. **EUIPO and WIPO are unchecked**, and the short domains are taken, so a
   logo and a website would need a different domain.
4. **Marketplace move:** the rename needs a new marketplace entry, and the
   `boat` entry sits under another owner's account.

## What would change the verdict

- A live HARBORMASTER or HARBOR MASTER mark in class 9 or 42 at EUIPO or
  WIPO, or a letter from the macOS app's author: reconsider.
- If you will never publish outside the bb marketplace and never ship a
  binary, the remaining risks are small and "go" is reasonable.
