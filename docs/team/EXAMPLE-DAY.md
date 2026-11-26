# Team: the example day

One canonical day that every Team design uses, so screens can be compared
side by side and polished from one source. It follows [SPEC.md](SPEC.md):
- the ask contract (§5.9);
- progress and colours (§4.10);
- the ledger (§4);
- rollover (§6.8);
- check-ins and health (§7);
- the copy rules (§10.4).

All names are fictional examples. The day is **Thursday 26 November 2026**,
in local time. "Next week" means Thursday 3 December 2026, and "tomorrow"
means Friday 27 November 2026.

Ids such as a1, t1 and K1 are handles for this document only. UI copy never
shows them (§10.4); designs use the titles below.

## Cast

Each member's compute is described once, here. Screens must not show a
member running anywhere else.

| Member | Role | Kind | Home chat | Runs on | Connections |
| --- | --- | --- | --- | --- | --- |
| **Nora** | Chief of staff | Lead | Main Mac (the bb machine) | Coordination only, no sandbox | None |
| **Iris** | Designer who codes | Specialist | Main Mac | One boat.dev sandbox, size Default, per assignment. Safari screenshots on the rented build Mac | None |
| **Developer** | Developer, internal tooling and consults | Specialist | Main Mac | One boat.dev sandbox, size Small, per assignment | None |
| **Writer** | Writer | Specialist | Main Mac | No sandbox; drafts in its own threads | None |
| **Olive** | Personal assistant | Specialist, sensitive | Main Mac | The main Mac, because it needs the mail and calendar apps there (an exception the user set) | Mail, calendar |
| **Scout** | Job scout | Specialist, sensitive | Main Mac | Its own isolated boat.dev sandbox, size Small, started only for its checks. It appears only as a member row, never under a project | Jobs database (key held by Team) |
| **Web app lead** | Project lead for Web app | Project lead (orchestrator) | A boat.dev sandbox, size Small (cloud orchestrator) | Its tasks run in boat.dev sandboxes, size Default | None |
| **Docs lead** | Project lead for Docs site | Project lead (orchestrator) | Main Mac | Its tasks run in boat.dev sandboxes, size Default | None |

Standing instructions that matter today:
- **Olive** books car appointments "on weekday mornings only, before 11:00".
- **Scout** never applies without an approval.

Settings that matter today:
- **Sandboxes at once:** 5.
- Reviews run on the other agent (Codex).
- **Ask Nora:** ⌘⇧J.

## Projects

| Project | Icon (glyph) | Lead | Repos | Notes |
| --- | --- | --- | --- | --- |
| Web app | Globe | Web app lead | acme/web, acme/web-api | Has a staging environment |
| Docs site | Book | Docs lead | acme/docs | — |

**Where work is drawn** (§10.4 default):
- A member's work for a project sits in that project's section, and the
  member's row reads "in <project>".
  - Iris's pricing page and Developer's consult are in Web app.
  - Writer's release notes are in Docs site.
- Olive's and Scout's work belongs to no project and nests under their own
  member rows.

## Machines

- **Main Mac:** runs bb, Nora, Writer, Olive and the Docs lead.
- **Rented build Mac:** used only for Iris's Safari screenshots. It's
  offline from **14:00** to 17:30; the UI always says "offline since 14:00".
- **boat.dev sandboxes:** everything else.

## Routines

- **Nora's check-ins:** 09:00 and 18:00. A "what changed since last time"
  summary that **names** the waiting asks, never counts them.
- **Scout's jobs check:** weekdays at 07:50 and 13:40 for new remote
  frontend roles, until 31 December. A code check runs first.

## Assignments

| Handle | Member | Title (UI) | Project | Mode | Started | Done when | Budget (§4.7) | Used by the end |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a1 | Web app lead (task t1) | Fix the checkout total rounding | Web app | Work | Today 08:05 | PR against main, tests passing, checked on staging | 20 turns, 12 h | 9 turns, 08:05–10:30 |
| a2 | Iris | Pricing page | Web app | Work | Yesterday 14:00 | PR with screenshots at 3 widths and a preview link | 20 turns, **48 h** (set at creation for multi-day work: `budget-set` event, yesterday 14:00) | 19 turns. Amber "needs attention · projected over budget" from 12:50 (23 projected) until 15:40 |
| a3 | Olive | Car service next week | — | Work | Today 09:45 | Slot booked within "weekday mornings, before 11:00", confirmation in mail | 20 turns, 12 h | 4 turns |
| a4 | Writer | Docs 2.4 release notes | Docs site | Work | Yesterday 16:00 | Draft shared as a file, every change since 2.3 listed | 20 turns, **48 h** (`budget-set` event, yesterday 16:00) | 6 turns |
| a5 | Docs lead (task t5) | Fix the docs search index | Docs site | Work | Yesterday 17:00 | PR with the search test passing | 20 turns, **48 h** (`budget-set` event, yesterday 17:00) | 13 turns |
| a7 | Developer | Is checkout.spec flaky? | Web app | Consult (from the Web app lead) | Today 09:20 | An answer | 4 turns | 1 turn |

No delegation tree comes near its 120-turn budget.

**Wall time.** Each assignment finishes inside its budget, so none expires:
- a2 runs 25 h 40 min of 48 h;
- a4 runs 19 h 40 min of 48 h;
- a5 runs 22 h 30 min of 48 h;
- a1, a3 and a7 finish well inside the 12 h default.

The three carried-over assignments got the longer budget when they were
created, as §4.7 allows, and the ledger records it. No extension is needed
today.

## Ask records

These are canonical. Every screen uses exactly this wording.

**Verb defaults** (§5.9):

| Verb | Primary | Secondary |
| --- | --- | --- |
| Approve | Approve, or Approve… with the lock when it needs the confirm step | Deny |
| Decide | The options | Not now |
| Review | Merge… for pull requests, Accept for other work | Send back |
| Do | The action, named ("Enter key…") | Not now |

- A ★ marks an option the member actually recommends; most asks have none.
- "Tier" is for the design only and is never shown.
- **Button labels (§5.9):** a Confirm action keeps its verb with "…" and
  the lock (Approve…, Merge…). The confirm step's own button restates the
  action. "Review and confirm" appears only on the phone, as the redirect
  into the bb phone app.

| Ask | Title (UI) | Verb | Tier | Unblocks | Options | Secondary | Asked by · marker on | Due |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| K1 | Restart the staging API | Approve | Contained | Checking the checkout fix on staging | Approve | Deny | Web app lead · task row "Fix the checkout total rounding" (Web app) | 09:30 |
| K2 | Pick a pricing page layout | Decide | Contained | Building the pricing page | A · Comparison table; **B · Three cards ★** (Iris); C · One plan with a toggle | Not now | Iris · task row "Pricing page" (Web app) | 12:00 |
| K3 | Book the car service for Thu 3 Dec, 08:30 | Approve | Confirm | Booking the service and telling the garage | Approve… 🔒 | Deny | Olive · Olive's row | 17:00 (the garage holds the slot until then) |
| K4 | Review and merge the checkout fix | Review | Confirm | Shipping the checkout fix | Merge… 🔒 | Send back | Web app lead · task row "Fix the checkout total rounding" (Web app) | 16:00 |
| K5 | Review the Docs 2.4 release notes | Review | Contained | Publishing the notes with Docs 2.4 | Accept | Send back | Writer · row "Docs 2.4 release notes" (Docs site) | 17:00 |
| K6 | Continue the pricing page build? | Decide | Contained | Finishing the pricing page | **Continue ★** (Nora: CI was still running); Reassign; Cancel | Not now | Nora, for Iris · task row "Pricing page" (Web app) | 14:00 |
| K7 | Enter the new jobs database key | Do | Contained | Scout's job search | Enter key… | Not now | Scout · Scout's row | 18:00 |
| K8 | The build Mac is offline: where should the Safari check run? | Decide | Contained | Finishing the pricing page screenshots | **Run it with WebKit in Iris's sandbox ★** (Nora); Wait for the build Mac | Not now | Nora · task row "Pricing page" (Web app) | 16:00 |
| K9 | Review and merge the docs search fix | Review | Confirm | Shipping the docs search fix | Merge… 🔒 | Send back | Docs lead · task row "Fix the docs search index" (Docs site) | Fri 27 Nov, 12:00 |
| K10 | Review and merge the pricing page | Review | Confirm | Shipping the pricing page | Merge… 🔒 | Send back | Iris · task row "Pricing page" (Web app) | Fri 27 Nov, 12:00 |
| K11 | Apply to the Frontend engineer role at Example Corp | Approve | Confirm | Sending your application | Approve… 🔒 | Deny | Scout · Scout's row | Fri 27 Nov, 12:00 |

**Answers on the day.** All are taps, so every provenance is "unverified
tap" (§5.9); no ask is answered by a typed reply today.

| Ask | Answered | Surface and device | Confirm step | Receipt (both times) |
| --- | --- | --- | --- | --- |
| K1 | 09:05 | Phone: the push opens the task's chat, and the strip answers (two taps) | — | "Approved 09:05 · ran 09:06 · can't be undone, limited to staging · Wasn't me? Pause and revoke" |
| K2 | 11:15 | Nora's tray, Mac | — | "Chose B 11:15 · building from 11:16 · Undo until 11:25" |
| K6 | 13:00 | The strip in the pricing page thread, Mac | — | "Continued 13:00 · resumed 13:05" |
| K3 | 13:10 | Nora's tray, Mac: Approve… | **Inline** (a short scope): "Send this message to the garage from your account and book Thu 3 Dec, 08:30? It can't be unsent." The message is two lines, shown in full. Buttons: **Send and book Thu 3 Dec, 08:30** and Cancel | "Approved 13:10 · sent 13:11 · can't be unsent". The send was held 30 s with "Sending in … · Cancel" |
| K8 | 15:05 | Today list, Mac | — | "Chose WebKit in Iris's sandbox 15:05 · started 15:06" (no Undo once started) |
| K5 | 15:50 | Today list, Mac | — | "Accepted 15:50 · handed to the Docs lead 15:51 · Undo until 16:00" |
| K4 | 15:52 | Nora's tray: Merge… → the task's chat, Mac | Harbormaster's Merge confirmation (checks, exact HEAD, "can't be undone"). Buttons: **Merge PR #128 into main** and Cancel | "Approved 15:52 · merged 15:53 · can't be undone" |
| K7 | 17:05 | The secure key form, Mac. At 16:30 the phone's compact Team page showed "Enter the key on your Mac" | — | "Key saved 17:05 · checking", then "Key works · checked 17:06" (the ask closes when the probe passes) |
| K9, K10, K11 | open at 18:00 | — | K9 and K10: Merge… opens the task's chat (Merge confirmation). K11: Approve… opens the **confirm view**, because the CV and cover note need reading space; its button reads **Send the application** | — |

K11's restated scope in the confirm view: "Send your CV (cv.pdf) and this
cover note to Example Corp's careers form from your account? It can't be
unsent." It shows "Due Fri 27 Nov, 12:00".

## Timeline

"Count" is the Nora tile's needs-you count right after the event (§5.9).

| # | Time | Who | What happens | Ask | Count |
| --- | --- | --- | --- | --- | --- |
| 1 | 07:50 | Scout | Jobs check: the code check finds nothing new. Checked, quiet; no model turn | — | 0 |
| 2 | 08:05 | You → Nora | "Get the checkout rounding bug fixed today." | — | 0 |
| 3 | 08:06 | Nora | Replies: "Assigned to the Web app lead. I'll tell you when the fix is ready for your review." The lead starts task t1 at 08:12 | — | 0 |
| 4 | 08:40 | Iris | Posts the 3 pricing layouts as an inline visual | K2 asked | 1 |
| 5 | 08:52 | Web app lead | The checkout fix needs the staging API restarted to check it on staging | K1 asked | 2 |
| 6 | 09:00 | Nora | **Morning check-in:** "Since 18:00 yesterday: the docs PR #76 was merged; nothing failed overnight. Waiting on you: Restart the staging API; Pick a pricing page layout." | — (links only) | 2 |
| 7 | 09:05 | You | K1, on the phone (see the answers table). The restart runs at 09:06 | K1 answered | 1 |
| 8 | 09:20 | Web app lead → Developer | Consult: "Is checkout.spec flaky?" At 09:35 Developer answers: flaky since the time-zone change, fixed in the same PR (advice, not proof) | — | 1 |
| 9 | 09:45 | You → Olive | "Find a car service slot next week, mornings only." | — | 1 |
| 10 | 10:15 | Olive | Finds Thu 3 Dec, 08:30, at the garage, inside "weekday mornings, before 11:00" | K3 asked | 2 |
| 11 | 10:30 | Web app lead | The checkout fix is finished: PR #128, tests passing, checked on staging. It moves to **Needs you** on the Board until it's merged | K4 asked | 3 |
| 12 | 10:50 | Docs lead | The docs search task has had no measured activity for 30 min: **stalled · nudged**, in slate. "Docs lead's plan: step 3 of 4" still says running, but that's self-reported | — | 3 |
| 13 | 11:15 | You | K2 → B, in Nora's tray. **Next ask** reads "Next: Review and merge the checkout fix · then 1 more" (K4 is due 16:00, before K3 at 17:00) | K2 answered | 2 |
| 14 | 11:20 | Docs lead | Still no activity: incident "Docs search task stalled" in Problems. A follow-up goes to the task at 11:25, and the incident resolves at 11:30 when activity resumes | — | 2 |
| 15 | 11:40 | Writer | The release notes draft is shared as a file. It's in Needs you until accepted | K5 asked | 3 |
| 16 | 12:10 | Nora | Her home chat compacts for the 3rd time: a **rollover notice** with the handoff note. It's a notice, not an ask, so it isn't counted | — | 3 |
| 17 | 12:14 | Nora | Quiet (no turn running, no draft being typed): a fresh home chat starts. The open asks (K3, K4, K5) carry over to its tray. The tile stays one row, and the old chat is under Earlier conversations | — | 3 |
| 18 | 12:30 | Iris | Her turn ends on "waiting for CI…" with no result: one automatic continue | — | 3 |
| 19 | 12:50 | Iris | The turn ends again without a result: the pricing page is **paused · stopped early** (not closed). Incident "Iris stopped early twice" in Problems. The budget projection turns amber | K6 asked | 4 |
| 20 | 13:00 | You | K6 → Continue, in the pricing page strip. Measured activity resumes at 13:05, and the incident resolves | K6 answered | 3 |
| 21 | 13:10 | You | K3, inline confirm in Nora's tray. The send is held 30 s, and goes out at 13:11. The car service is done at 13:12: booked, confirmation in mail | K3 answered | 2 |
| 22 | 13:40 | Scout | Jobs check: the jobs database connection fails twice. Incident "Jobs database connector dropped" | K7 asked | 3 |
| 23 | 14:00 | Build Mac | Goes offline while Iris's Safari screenshots are queued there. The pricing page row reads "waiting for the build Mac · offline since 14:00" in amber (needs attention, not an ask). The ledger opens the incident at 14:10 | — | 3 |
| 24 | 15:00 | Nora | The build Mac has been offline since 14:00, with work waiting | K8 asked | 4 |
| 25 | 15:05 | You | K8 → Run it with WebKit in Iris's sandbox, in the Today list | K8 answered | 3 |
| 26 | 15:30 | Docs lead | The docs search fix is finished: PR #77, the search test passing. It goes to Needs you | K9 asked | 4 |
| 27 | 15:40 | Iris | The pricing page is finished: PR #131, layout B, WebKit screenshots at 3 widths and a preview link. It goes to Needs you | K10 asked | 5 |
| 28 | 15:50 | You | K5 → Accept, in the Today list | K5 answered | 4 |
| 29 | 15:52 | You | K4 → Merge… → Harbormaster's Merge confirmation in the task's chat: **Merge PR #128 into main**. Merged at 15:53 | K4 answered | 3 |
| 30 | 16:30 | You (phone) | The compact Team page shows K7 as "Enter the key on your Mac" (the secure key form isn't available on the phone) | — | 3 |
| 31 | 17:05 | You | K7: the new key in the secure form on the Mac → "key saved · checking". The probe passes at 17:06, the ask closes, and the connector incident resolves. Scout's check re-runs at 17:10 and finds 2 new roles; one is on-site only and is left out | K7 answered at 17:06 | 2 |
| 32 | 17:20 | Scout | Shortlists one role | K11 asked | 3 |
| 33 | 17:30 | Build Mac | Back online; the incident resolves | — | 3 |
| 34 | 18:00 | Nora | **Evening check-in:** "Today: the checkout fix was merged; the Docs 2.4 release notes were accepted; the car service is booked for Thu 3 Dec, 08:30. Four problems came up and were resolved: the docs search stall, Iris's stop, the jobs connector and the build Mac. Waiting on you: Review and merge the docs search fix; Review and merge the pricing page; Apply to the Frontend engineer role at Example Corp." | — (links only) | 3 |

## Counts at three moments

| | 09:00 | 14:30 | 18:00 |
| --- | --- | --- | --- |
| **Nora tile count** (open asks) | 2: K1, K2 | 3: K4, K5, K7 | 3: K9, K10, K11 |
| By verb | 1 Approve, 1 Decide | 2 Review, 1 Do | 2 Review, 1 Approve |
| With a lock (Confirm) | 0 | 1 (K4) | 3 |
| Overdue | 0 | 0 | 0 |
| Board: Running | 2: release notes, docs search | 1: docs search | 0 |
| Board: Waiting | 0 | 1: pricing page (waiting for the build Mac) | 0 |
| Board: Needs you | 2: checkout fix (K1), pricing page (K2) | 2: checkout fix (review, K4), release notes (review, K5) | 2: docs search fix (review, K9), pricing page (review, K10) |
| Board: Done today | 0 | 2: the consult, the car service | 4: the consult, the car service, the release notes, the checkout fix (after the merge) |
| Merged today | 0 | 0 | 1: PR #128 |
| Incidents open | 0 | 2: jobs connector, build Mac | 0 |
| Incidents resolved today | 0 | 2: docs search stall, Iris's stop | 4 |
| Answered today (newest first) | — | K3, K6, K2, K1 | K7, K4, K5, K8, K3, K6, K2, K1 |
| Sidebar amber markers (one per ask) | 2: checkout fix row, pricing page row | 3: checkout fix row, release notes row, Scout's row | 3: docs search fix row, pricing page row, Scout's row |

## Usage

From the Team page's Usage tab.

| | 09:00 | 14:30 | 18:00 |
| --- | --- | --- | --- |
| Claude, current 5-hour window | 18% | 64% | 31% (new window from 17:00) |
| Claude, this week | 42% | 49% | 53% |
| Codex, this week (reviews) | 9% | 15% | 17% |
| Sandboxes running (of 5 at once) | 4: Web app lead (Small), checkout fix (Default), docs search (Default), Iris (Default) | 3: Web app lead (Small), docs search (Default), Iris (Default) | 1: Web app lead (Small) |
| Sandbox hours today | 1.2 h | 9.8 h | 15.5 h |

## Sidebar at 14:30

- **Nora tile:** count 3; preview "Next: Review and merge the checkout fix".
- **Members:**
  - Iris "in Web app" (neutral);
  - Developer: idle;
  - Writer "in Docs site" (neutral);
  - Olive: idle, last line "Booked Thu 3 Dec, 08:30";
  - Scout: amber marker (K7).
- **Web app** (Globe):
  - Web app lead;
  - "Fix the checkout total rounding": amber marker (K4);
  - "Pricing page" (Iris): "waiting for the build Mac · offline since
    14:00", amber text with no marker.
- **Docs site** (Book):
  - Docs lead;
  - "Fix the docs search index": working;
  - "Docs 2.4 release notes" (Writer): amber marker (K5).

## Consistency rules this day follows

- **Each ask has one title, asked once.** The staging restart (K1) is asked
  only at 08:52.
- **Iris shows 3 layouts** (A, B, C) and recommends B; B is chosen.
- **Olive's slot** is Thu 3 Dec, 08:30, inside "weekday mornings only,
  before 11:00".
- **Scout** appears only as a member row and in asks. Its sandbox is never
  drawn under a project.
- **Every member has one compute description**, in the cast table, with its
  sandbox size.
- **Every Confirm ask** is answered with bb open and the full restated
  scope.
  - K3 is confirmed inline in Nora's tray, because its scope is short.
  - K4 uses Harbormaster's Merge confirmation in the task's chat, as all
    merges do, on any device; its button reads "Merge PR #128 into main".
  - K11 will use the confirm view, because it needs reading space.
  - No Confirm ask is answered from a push or the compact Team page.
- **"Next ask"** shows one title and "then 1 more" at most, in the stated
  order (overdue, soonest due, Confirm before Contained, oldest).
- **Colours:**
  - amber means needs you (a marker, one per ask) or needs attention (the
    offline build Mac, the projected overrun);
  - slate means stalled (the docs search at 10:50);
  - nothing turns red today, because nothing failed.
- **Finished work waiting for review is an ask.** It sits in Needs you, and
  it reaches Done today only after the merge or accept.
- **Stopped early is paused, not closed:** the pricing page resumes after
  K6.
- **The rollover is a notice:** it waits only for "no turn running, no
  draft", and the open asks carry over.
- **Every incident is counted:** four open and resolve during the day.
- **Undo appears only where it works:** K2 and K5 for 10 minutes, and K3's
  held send for 30 s. The restart, the merge and the started WebKit run
  have none.
- **The Nora tile's count** always equals the open asks in the timeline.
