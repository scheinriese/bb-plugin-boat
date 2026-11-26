# Team: the example day

One canonical day that every Team design uses, so screens can be compared
side by side. It follows [SPEC.md](SPEC.md): the ask contract (§5.9),
progress (§4.10), the ledger (§4), check-ins and health (§7), and the
decisions from design round 3 (§10.1). All names are fictional examples.
Times are local, on a Thursday.

## Cast

Each member's compute is described once, here. Screens must not show a
member somewhere else.

| Member | Role | Kind | Home chat | Runs on | Connections |
| --- | --- | --- | --- | --- | --- |
| **Nora** | Chief of staff | Lead | Main Mac (the bb machine) | Coordination only, no sandbox | None |
| **Iris** | Designer who codes | Specialist | Main Mac | One boat.dev sandbox (Medium) per assignment; Safari screenshots on the rented build Mac | None |
| **Developer** | Developer, internal tooling and consults | Specialist | Main Mac | One boat.dev sandbox (Small) per assignment | None |
| **Writer** | Writer | Specialist | Main Mac | No sandbox; drafts in its home chat | None |
| **Olive** | Personal assistant | Specialist, sensitive | Main Mac | The main Mac, because it needs the mail and calendar apps there (an exception the user set) | Mail, calendar |
| **Scout** | Job scout | Specialist, sensitive | Main Mac | Its own isolated boat.dev sandbox (Small). It appears only as a member row in the Team block, never under a project | Jobs database (plugin-held key) |
| **Web app lead** | Project lead for Web app | Project lead (orchestrator) | A boat.dev sandbox (cloud orchestrator) | Tasks in boat.dev sandboxes | None |
| **Docs lead** | Project lead for Docs site | Project lead (orchestrator) | Main Mac | Tasks in boat.dev sandboxes | None |

Standing instructions that matter today:
- **Olive** books car appointments "on weekday mornings only, before 11:00".
- **Scout** never applies without an approval.

## Projects

| Project | Icon (glyph) | Lead | Repos | Notes |
| --- | --- | --- | --- | --- |
| Web app | Globe | Web app lead | acme/web, acme/web-api | Has a staging environment |
| Docs site | Book | Docs lead | acme/docs | — |

Member home chats live in bb's Personal project, drawn in the Team block,
not under a project.

## Machines

- **Main Mac:** runs bb, Nora, Writer, Olive and the Docs lead.
- **Rented build Mac:** used only for Iris's Safari screenshots.
- **boat.dev sandboxes:** everything else.

## Routines

- **Nora's check-ins:** 09:00 and 18:00, a "what changed since last time"
  summary.
- **Scout's jobs check:** weekdays at 07:50 and 13:40 for new remote
  frontend roles, until 31 December. A code check runs first.

## Open work at the start of the day

From yesterday:

| Assignment | Member | Title | Done when |
| --- | --- | --- | --- |
| a2 | Iris | Pricing page: 3 layouts, then build the chosen one | PR open with WebKit or Safari screenshots at 3 widths and a preview link |
| a4 | Writer | Draft the release notes for Docs 2.4 | Draft shared as a file, with every change since 2.3 listed |
| a5 | Docs lead | Fix the docs search index | PR open with the search test passing |

## Timeline

Asks are `K1`–`K11`, in the order they're asked. Each ask is asked exactly
once. "Count" is the Nora tile's needs-you count right after the event
(§5.9).

| # | Time | Who | What happens | Ask: verb · tier · unblocks · due | Count |
| --- | --- | --- | --- | --- | --- |
| 1 | 07:50 | Scout | Jobs check: the code check finds nothing new. Checked-quiet; no model turn | — | 0 |
| 2 | 08:05 | You → Nora | "Get the checkout rounding bug fixed today." Nora assigns **a1** to the Web app lead (done when: PR against main, tests passing, checked on staging). The lead dispatches task t1 at 08:12 | — | 0 |
| 3 | 08:40 | Iris | Posts 3 pricing layouts as an inline visual: A (comparison table), B (three cards), C (one plan with a monthly/yearly toggle) | **K2** Decide · Contained · building the pricing page (a2) · 12:00 | 1 |
| 4 | 08:52 | Web app lead | t1 needs the staging API restarted to check the fix | **K1** Approve · Contained (`restart-nonprod`) · the staging check for a1 · 09:30 | 2 |
| 5 | 09:00 | Nora | **Morning check-in:** "Since 18:00 yesterday: Docs PR #76 merged; nothing failed overnight; 2 asks waiting (K1, K2); 2 assignments running, 2 waiting on you" | — (links only) | 2 |
| 6 | 09:05 | You | On the phone: tap the push for K1, which opens the blocked thread, then Approve in the strip. Provenance: unverified tap. The restart runs at 09:06. Receipt: "Done; can't be undone, limited to staging · Wasn't me? Pause and revoke" | K1 answered | 1 |
| 7 | 09:20 | Web app lead → Developer | Consult **a7**: "Is checkout.spec flaky?" At 09:35 Developer answers: flaky since the time-zone change, fixed in the same PR (advice, not proof) | — | 1 |
| 8 | 09:45 | You → Olive | "Find a car service slot next week, mornings only." Olive starts **a3** | — | 1 |
| 9 | 10:15 | Olive | Finds Thu next week, 08:30, at the garage, which fits mornings only. The garage holds it until 17:00 | **K3** Approve · Confirm (`external-send`: 1 message from your account, books the slot) · a3 · 17:00 | 2 |
| 10 | 10:30 | Web app lead | **a1 done:** PR #128, tests passing, checked on staging. The checkout row turns from running to ready | **K4** Review · Confirm (the merge option) · shipping the fix · 16:00 | 3 |
| 11 | 10:50 | Docs lead | t5 (a5) has no measured activity for 30 min: **stalled**, nudged. The row turns amber. "Docs lead's plan: step 3 of 4" still says running, but that's self-reported | — | 3 |
| 12 | 11:15 | You | In Nora's tray: K2 → Layout B. Undo is available until 11:25. Next ask moves to K4 (due 16:00), then K3 (due 17:00) | K2 answered | 2 |
| 13 | 11:20 | Docs lead | Still no activity: incident "Docs search task stalled" in Problems. The Docs lead sends t5 a follow-up at 11:25, and the incident resolves at 11:30 when activity resumes | — | 2 |
| 14 | 11:40 | Writer | **a4 done:** release notes draft shared as a file | **K5** Review · Contained · publishing with Docs 2.4 · 17:00 | 3 |
| 15 | 12:30 | Iris | Her turn ends on "waiting for CI…" with no result: one automatic continue | — | 3 |
| 16 | 12:50 | Iris | The turn ends again without a result: a2 **stopped early**. Incident "Iris stopped early twice on a2" in Problems (§7.5) | **K6** Decide · Contained (Continue, Reassign or Cancel) · a2 · 14:00 | 4 |
| 17 | 13:00 | You | In Iris's thread strip: K6 → Continue. The continued turn shows measured activity at 13:05, and the stopped-early incident resolves | K6 answered | 3 |
| 18 | 13:10 | You | On the Mac: K3 → Approve. The confirm step reads "Send 1 message to the garage from your account and book Thu 08:30? It can't be unsent." The send is held 30 s and goes out at 13:11. **a3 done** at 13:12: booked, confirmation in mail | K3 answered | 2 |
| 19 | 13:40 | Scout | Jobs check: the jobs database connection fails twice. Incident "Jobs database connector dropped" | **K7** Do · Contained · Scout's job search · 18:00 | 3 |
| 20 | 14:00 | Build Mac | Goes offline while Iris's Safari screenshots are queued there; a2 is waiting. Incident "Build Mac offline" at 14:10 | — | 3 |
| 21 | 15:00 | Nora | The build Mac has been offline for 60 minutes with work waiting | **K8** Decide · Contained (run the check with WebKit in Iris's boat.dev sandbox instead, or wait for the build Mac) · a2 · 16:00 | 4 |
| 22 | 15:05 | You | In the Today list: K8 → Run it with WebKit in her sandbox | K8 answered | 3 |
| 23 | 15:30 | Docs lead | **a5 done:** PR #77, the search test passing | **K9** Review · Confirm (merge) · shipping the search fix · Fri 12:00 | 4 |
| 24 | 15:40 | Iris | **a2 done:** PR #131 with layout B, WebKit screenshots at 3 widths and a preview link | **K10** Review · Confirm (merge) · shipping the pricing page · Fri 12:00 | 5 |
| 25 | 16:05 | You | K5 → Accept (the release notes). On the Mac, K4 → Merge PR #128 through Harbormaster's Merge confirmation; merged at 16:06 | K4 and K5 answered | 3 |
| 26 | 17:05 | You | K7: enter the new jobs database key in bb's secure form (`bb secret request`). The probe passes at 17:06 and the connector incident resolves. Scout's check re-runs at 17:10 and finds 2 new roles; one is on-site only and is left out | K7 answered | 2 |
| 27 | 17:20 | Scout | Shortlists one role | **K11** Approve · Confirm (`submit-personal`: apply to the Frontend engineer role at Example Corp with your CV) · the application · Fri 12:00 | 3 |
| 28 | 17:30 | Build Mac | Back online; the incident resolves | — | 3 |
| 29 | 18:00 | Nora | **Evening check-in:** "Today: 6 assignments done; PR #128 merged; car service booked for Thu 08:30; 4 incidents opened and resolved; waiting on you: 2 PRs to review and merge (K9, K10), 1 application to approve (K11)" | — (links only) | 3 |

## Counts at three moments

| | 09:00 | 14:30 | 18:00 |
| --- | --- | --- | --- |
| **Nora tile count** (open asks) | 2: K1, K2 | 3: K4, K5, K7 | 3: K9, K10, K11 |
| By tier | 2 Contained | 1 Confirm (K4), 2 Contained (K5, K7) | 3 Confirm |
| By verb | 1 Approve, 1 Decide | 2 Review, 1 Do | 2 Review, 1 Approve |
| Overdue | 0 | 0 | 0 |
| Assignments running | 2: a4, a5 | 1: a5 | 0 |
| Waiting | 0 | 1: a2 (build Mac offline) | 0 |
| Needs you (blocked on an ask) | 2: a1 (K1), a2 (K2) | 0 | 0 |
| Done today | 0 | 4: a7, a1, a4, a3 | 6: a7, a1, a4, a3, a5, a2 |
| Merged today | 0 | 0 | 1: PR #128 |
| Incidents open | 0 | 2: jobs connector, build Mac | 0 |
| Incidents resolved today | 0 | 2: docs task stalled, Iris stopped early | 4 |
| Answered today, with receipts | 0 | 4: K1, K2, K6, K3 | 8: K1, K2, K6, K3, K8, K4, K5, K7 |

## Consistency rules this day follows

- **The staging restart is asked once**, at 08:52 (K1).
- **Iris shows 3 layouts** (A, B, C), and B is chosen.
- **Olive's slot** is Thu 08:30, inside "weekday mornings only, before
  11:00".
- **Scout** appears only as a member row and in asks. Its sandbox is never
  drawn under a project.
- **Every member has one compute description**, in the cast table.
- **Every Confirm ask** is answered with bb open and a confirm step: K3 on
  the Mac, and the K4 merge through Harbormaster's confirmation. No Confirm
  ask is answered from the phone or a push. K11 blocks no thread, so its
  confirm happens in the Team page's confirm view (`ask/K11`) tomorrow.
- **"Next ask" follows the stated order** (overdue, then soonest due, then
  Confirm before Contained, then oldest): after K2 at 11:15 it's K4 (16:00),
  then K3 (17:00).
- **Every incident is counted**, including Iris's stop at 12:50 (§7.5):
  four incidents open and resolve during the day.
- **Undo appears only where it works:** K2 (a choice, for 10 minutes) and
  the held message in K3 (30 s). K1's restart has no Undo.
- **The count on the Nora tile** always equals the open asks in the
  timeline.
