# Team · design handoff

## 1. About this handoff

This is the build-ready design handoff for bb's **Team** feature: Nora (the
chief of staff), her members, project leads, and the asks they put to you.
It turns the final design frames into text: what every screen shows,
how every component is measured and coloured, the tokens, the avatar
rules, and the decisions that close the last open points.

It is written for build agents that can't open the design tool. Everything
you need is in this file, the PNGs next to it, and the spec it points to.

- **Spec:** [`../SPEC.md`](../SPEC.md). This file names sections by number
  (§5.9 and so on) and doesn't repeat them. The spec wins on behaviour;
  this file wins on look, measurements and copy layout.
- **The example day:** [`../EXAMPLE-DAY.md`](../EXAMPLE-DAY.md), Thursday
  26 November 2026. Every frame is a moment of that day, and every ask
  title, option, secondary action, receipt, time and count comes from it,
  word for word. A few frames show a hypothetical moment and say so.
- **Design files:** the Paper file "Plugin: Boat Cloud Agents (bb) · Team",
  pages "Team · Final · …" (screens), "Team · Final · kit" (the component
  kit) and "Team · build handoff" (the source of this document).
- **PNGs:** [`frames/`](frames/). Desktop frames are 1600 × 1000 at 1x;
  phone frames are 390 × 844 at 2x.
- **Avatar SVGs:** [`avatars/`](avatars/) (see [§5](#5-avatars)).
- **Motion:** [`MOTION-SPEC.md`](MOTION-SPEC.md) and the self-contained
  prototype [`motion/index.html`](motion/index.html), which you can open in
  any browser. They ship separately; [§6](#6-still-not-fitting-decided)
  lists where this file overrides them.

**How to read it**

1. Find the moment you're building in the [frame index](#2-frame-index)
   and open its PNG.
2. Build each piece from the [component specs](#3-component-specs), using
   the [tokens](#4-tokens) by name.
3. Check [§6](#6-still-not-fitting-decided) before you finish. Where a
   frame and this file differ, **this file wins**. Several frames were
   drawn before the §6 decisions; for example, the 14:30 frames still read
   "· then 1 more" with three asks open.

**Notation.** Sizes are CSS px. Type is `size/line-height weight`, so
`13/18 500` means 13 px Inter, an 18 px line, medium weight. Colours are
token names from [§4](#4-tokens), with the dark hex in brackets where that
helps. Values are read from the kit's computed styles, not from pixels.

**Rules that apply everywhere** (from §10.4 and the final review):

- No ids in UI copy (no `a…`, `t…`, `k…`, no K1). One copyable handle
  appears only in the task detail panel.
- No tier labels. "Contained" and "Confirm" are never shown; a small lock
  marks actions that need the confirm step.
- One needs-you count, and only on the Nora tile. The Team nav entry has
  no badge.
- The status words are the §10.4 list only (see [§4.3](#43-status-vocabulary-104)).
- Sentence case. "Cloud sandbox", never the vendor name. Ask Nora is ⌘⇧J.
- No internal names (`team_wait`, `restart-nonprod`, `submit-personal`,
  "bb secret request", tool names, record fields).
- bb-native visual language: no coloured side bars on cards, no cards in
  cards, no chips where plain text works, no glows or gradients. State is
  shown by the avatar badge, a 6 px amber dot, amber text in the meta line,
  and hairlines.
- Design annotations are never UI copy. In the PNGs, dashed "NOTE" boxes
  and anything outside the app frame are notes to you, not product text.

---

## 2. Frame index

Every final frame, grouped by the Paper page it lives on, in the order of
the day. "PNG" links to the file in `frames/`.

`frames/` holds the 26 frames a phase-1 build needs (linked below; the
others are named only and live in the Paper file). Also in `frames/`:
[`handoff-components.png`](frames/handoff-components.png), the component
sheet with redlines for §3.

### Team · Final · home and answering (desktop, 1600 × 1000)

| PNG | Time | Shows | Count |
| --- | --- | --- | --- |
| [final-home-0900](frames/final-home-0900.png) | 09:00 | Home: Nora's morning check-in in her chat and her ask tray above the composer | 2 |
| [final-home-k1-strip](frames/final-home-k1-strip.png) | 09:00 (inset after 09:05) | Composer strip in the task's chat: "Restart the staging API" | 2 |
| final-home-k2-before | 11:15 | Before the tap: "Pick a pricing page layout" in Nora's tray | 3 |
| [final-home-k2-after](frames/final-home-k2-after.png) | 11:16 | After choosing B in the tray: the receipt, then the Next line | 2 |
| [final-home-k6-strip](frames/final-home-k6-strip.png) | 12:50–13:00 | Strip in the pricing page thread: continue after stopping early | 4 |
| [final-home-k3-confirm](frames/final-home-k3-confirm.png) | 13:10 | Inline confirm step for the car service booking | 3 |
| [final-home-k3-held](frames/final-home-k3-held.png) | 13:10 → 13:11 | Held send "Sending in 30 s · Cancel", then sent | 2 |
| [final-home-k4-merge](frames/final-home-k4-merge.png) | 15:52 | Harbormaster's Merge confirmation for PR #128 in the task's chat | 4, then 3 |

### Team · Final · Team page (desktop)

| PNG | Time | Shows | Count |
| --- | --- | --- | --- |
| [final-team-today-1430](frames/final-team-today-1430.png) | 14:30 | Today: Your move, Answered today, problems | 3 |
| [final-team-board-flow-1430](frames/final-team-board-flow-1430.png) | 14:30 | Board by flow, with the detail panel open on the checkout fix | 3 |
| [final-team-board-project-1430](frames/final-team-board-project-1430.png) | 14:30 | Board by project | 3 |
| final-team-sandboxes-1430 | 14:30 | Sandboxes tab | 3 |
| final-team-usage-1430 | 14:30 | Usage tab | 3 |
| final-team-projects | any time (sidebar at 14:30) | Projects tab | 3 |
| [final-team-confirm-view-k11](frames/final-team-confirm-view-k11.png) | 18:00 | Confirm view for the job application, confirming; with the timed-out and "changed" states | 3 |
| final-team-overdue | 16:05, hypothetical | Overdue first, if the checkout fix had not been merged | — |
| final-team-many-asks | hypothetical | A heavy day with 24 open asks: grouped by due day, Show all | — |

The Team page chrome is identical on every tab: title "Team", "Ask Nora
⌘⇧J" on the right, and the tabs Today · Board · Sandboxes · Usage ·
Projects (the active tab has a 2 px underline). Board card titles never
wrap past 2 lines, even with the detail panel open.

### Team · Final · phone (390 × 844, 2x)

| PNG | Time | Shows |
| --- | --- | --- |
| final-phone-nora-0900 | 09:00 | Nora's chat with her tray |
| final-phone-k1-push | 09:05 | The push opens the task's chat |
| [final-phone-k1-strip](frames/final-phone-k1-strip.png) | 09:05 | Approve in the composer context row (the honest two-tap flow) |
| final-phone-k1-receipt | 09:06 | The receipt for 10 s, then Next |
| [final-phone-drawer-1430](frames/final-phone-drawer-1430.png) | 14:30 | The drawer, in Workbench's row anatomy |
| [final-phone-team-1630](frames/final-phone-team-1630.png) | 16:30 | Compact Team page, Today (scrolls; see §6) |
| final-phone-merge | the path, not the day (880 × 844) | One merge on the phone: "Review and confirm" opens Harbormaster's Merge confirmation |

### Team · Final · states (desktop)

| PNG | Time | Shows |
| --- | --- | --- |
| [final-state-zero-asks-0800](frames/final-state-zero-asks-0800.png) | 08:00 | Zero asks: no count, no tray |
| [final-state-stale-tap](frames/final-state-stale-tap.png) | 09:07, hypothetical | A stale tap changes nothing and says why |
| [final-state-stalled-1050](frames/final-state-stalled-1050.png) | 10:50, inset 11:20–11:30 | Stalled · nudged: slate, measured, not self-reported |
| final-state-two-devices | 11:15, second device hypothetical | Two devices, one answer: the first wins |
| final-state-rollover-notice-1210 | 12:10, inset 12:14 | Rollover is a notice, not an ask |
| [final-state-stopped-early-1250](frames/final-state-stopped-early-1250.png) | 12:50 | Stopped early: paused in slate, resumable, not closed |
| final-state-connector-1340 | 13:40, inset 17:05–17:06 | Connector dropped: an incident and one Do ask |
| [final-state-offline-mac-1500](frames/final-state-offline-mac-1500.png) | 15:00 | Build Mac offline: needs attention, then one ask |

### Team · Final · rollover and first run (desktop)

| PNG | Time | Shows |
| --- | --- | --- |
| final-roll-notice-1210 | 12:10 | The home chat compacts for the third time: the rollover notice |
| final-roll-note | 12:11 | Edit note: the rollover waits while you edit |
| final-roll-fresh-1214 | 12:14 | The fresh home chat starts; open asks come along |
| final-roll-undo-guard | 13:20, hypothetical | Undo with the activity guard |
| final-first-team-off | before Team | Team off, offered calmly in Cloud agents → Settings |
| [final-first-member](frames/final-first-member.png) | Team just turned on | Nora only; add the first member (five templates plus Start blank) |
| [final-first-native](frames/final-first-native.png) | 14:30 | Team without Workbench: bb's own thread list (§11.2, option B) |
| final-first-native-note | — | Developer note that sits beside the frame above (annotation, not UI) |

### Team · Final · light (exact re-skins in light tokens)

| PNG | Time | Shows |
| --- | --- | --- |
| [final-light-home-0900](frames/final-light-home-0900.png) | 09:00 | Home in light tokens (count 2) |
| [final-light-team-today-1430](frames/final-light-team-today-1430.png) | 14:30 | Team page, Today, in light tokens (count 3) |
| final-light-phone-nora-0900 | 09:00 | Nora's chat on the phone, light |
| final-light-phone-team-1630 | 16:30 | Compact Team page on the phone, light |
| final-light-tokens-annotation | — | Annotation: light tokens and contrast |

### Team · Final · avatars

| PNG | Shows |
| --- | --- |
| [final-avatars-h3](frames/final-avatars-h3.png) | Default H3 Orbit asset sheet: cast, states, the Nora tile at 09:00, 14:30 and 18:00 |
| [final-avatars-h2-setting](frames/final-avatars-h2-setting.png) | 14:30, H2 Calm faces: the Appearance setting in place (sidebar and Nora tile, no orbit) |
| final-avatars-motion | Motion frame strips for both systems |

### Team · Final · kit

The kit page holds the parts every screen is built from; the component
specs below carry its values. Its sheets (`kit-desktop-frame-dark`,
`kit-desktop-frame-light`, `kit-faces`, `kit-components-dark`,
`kit-components-light`, `kit-light-tokens`) show the 09:00 desktop frame
in both themes (sidebar, Nora tile, empty content column and
above-composer slot), the H3 cast and badges, every component in dark and
light, and the light token table. They may not be in `frames/`.

---

## 3. Component specs

Ten components. Each one lists its anatomy with sizes, type, colours and
states, then its copy rules. Light mode uses the same geometry with the
light tokens ([§4.2](#42-light)).

**Buttons** (shared by every component):

| Kind | Fill / border | Label | Padding | Radius |
| --- | --- | --- | --- | --- |
| Primary | `button.primary` fill (#E6E6E6) | `12/16 500`, #151515 (14.63:1) | 5 × 12 | 6 |
| Secondary | 1 px `button.border` (#333333), no fill | `12/16 400`, `text.ink` | 5 × 12 | 6 |
| Text button | none | `12/16 400`, `text.secondary` | 5 × 8 | 6 |
| Small (strip only) | as primary / secondary | `12/16` | 3 × 10 (secondary 2 × 10 inside its 1 px border) | 5 |

- Light: the primary is `text.strong` (#262626) with a white label; the
  secondary has a 1 px `button.border` (#8F8F8F, see §6) and a `text.body`
  label; the text button is `text.secondary` (#525252).
- **Lock:** a 12 px inline SVG after the label, 6 px gap, stroke in the
  label colour. A Confirm action keeps its verb + "…" + lock: "Approve…",
  "Merge…". The confirm step's own button restates the action instead.
- The gap between buttons is 8.

### 3.1 Nora tile

The top of the sidebar: H3 orbit and dock, the one needs-you count, and
a preview line.

**Redlines**

- Tile: 304 wide (sidebar 320 − 8 inset on each side) × 64 high, radius 10,
  `bg.tile` (#262626), 1 px `line.tile` (#303030). Padding L 2, R 10; gap
  6 between parts. 12 px from the tile to the nav below.
- Parts, left to right:
  1. **Orbit:** a 64 × 50 slot holding the orbit asset (72 × 56 units).
     Nora is 40.8 px with her centre at (36, 28) in asset units. The ring
     is dashed `orbit.ring` (#4A4A4A), 0.8 px, dash 1.5 / 2.5. Satellites
     are 14.4–16.8 px (scale .65 + .05 · sin a). They draw behind Nora in
     the top half and in front in the bottom half.
  2. **Name:** "Nora" `13/16 600` `text.ink`, then " · chief of staff"
     `13/16 400` `text.secondary`.
  3. **Preview line:** `12/16 400` `text.secondary`, 3 px under the name.
     One line, ellipsis, with the full text in the tooltip.
  4. **Dock:** 18 px discs in `bg.tile`, each holding a 16 px face.
     They're absolutely positioned at a 10 px step, so the slot is
     18 + 10 × (n − 1) wide (28 with two faces, 38 with three) × 18 high.
     At most 3 faces show; the newest is nearest the count and on top.
     Docked faces have no badge.
  5. **Count pill:** 20 high, min-width 22, padding 0 7, radius 10,
     `status.amber` fill; the number is `12/16 700` #151515 (9.60:1).
     Light: #B45309 with a white number (5.02:1).
- On a light tile (`bg.selected` #EDEDED), all tile text uses
  `text.secondary` (#525252, 6.67:1). In dark, never put `text.meta`
  (#8A8A8A) on the tile: it's 4.38:1 and fails.

**States**

| State | Orbit | Dock | Pill | Preview (example day) |
| --- | --- | --- | --- | --- |
| 09:00 | Writer, Docs lead | Iris, Web app lead | 2 | "Morning check-in at 09:00" |
| 14:30 | Docs lead | Web app lead, Writer, Scout | 3 | "Next: Review and merge the checkout fix · then 2 more" |
| 18:00 | empty; the ring fades and Nora rests (eyes closed) | Docs lead, Iris, Scout | 3 | "Evening check-in at 18:00" |
| Zero asks (08:00) | as measured | none | none ("0" is never drawn) | Nora's latest line |

- **Orbit** holds members and leads with measured activity (working).
  **Dock** holds whoever has an ask to you still open, one face per asker
  however many asks they have; Nora's own asks dock nobody. **Neither**:
  idle, quiet, paused, stalled, or waiting on something other than you.
- Motion (join, leave, dock, wink, count tick, rest) is in
  `MOTION-SPEC.md` §2, using this tile's geometry (see §6).

**Copy rules**

- The pill is the only needs-you number in the app.
- The preview reads either "Next: <title> · then N more" (the Next-line
  rule, [§3.9](#39-next-line)) or Nora's latest line ("Morning check-in at
  09:00").
- No provider logo on Nora.

### 3.2 Member row

The Team section of the sidebar: compact, one line, and it never repeats
a task's state.

**Redlines**

- Section label "Team" `12/15 400` `text.section` (#B7B7B7), Workbench's
  section label. The list is 311 wide; sections are 12 apart.
- Row: 28 high, padding L 10, R 14, gap 7. The row starts at list x 4, so
  content starts 10 in.
- Parts:
  1. **Face:** an 18 × 18 slot holding a 16 px H3 face
     (`face-<member>-<state>-<theme>.svg`). A working member gets no second
     ring on the row: the face's ring badge is the ring.
  2. **Name:** `13/16 400` `text.row`, grows, one line.
  3. **Status:** `12/16 400` `text.meta`, right-aligned, doesn't shrink.
     Amber only for needs attention; slate for paused and stalled.
  4. **Dot slot:** 12 × 28, always empty on member rows, so statuses line
     up with the task rows' markers.

**States** (the face carries the state: a badge at the bottom right, or a
dim; see [§5](#5-avatars)):
idle · working (ring badge) · quiet (body at 55 %) · stalled · nudged
(55 % + slate clock) · waiting for <…> · needs attention (amber triangle) ·
paused · stopped early (slate disc) · failed (red disc) · in <project> ·
sending in 30 s (held send, §6). At 16 px, needs you has **no** face
badge: the task row's amber marker is the one signal.

At 09:00: Iris "in Web app", Developer "idle", Writer "in Docs site",
Olive "idle", Scout "idle".

**Copy rules**

- "idle", never "free".
- A member's project work reads "in Web app", in neutral, even while that
  task needs you. The member row never repeats the task's state.
- No provider logo on member rows. The provider shows in the chat header,
  the composer and a tooltip (§10.5).
- Olive's and Scout's work belongs to no project and nests under their own
  member rows.

### 3.3 Task row (with project header, review row and nesting)

Workbench's row anatomy inside project sections: project → task → review
or sub-thread, with continuous tree lines (§10.5).

**Redlines**

- **Indents:** content starts at x 10 (project header), 34 (task) and 58
  (level 3: review or sub-thread). Padding R 14, gap 7.
- **Tree lines:** 1 px `line.tree` (#343434) at x 19 (under the project)
  and x 43 (under a task). Absolutely positioned, top 0 and bottom 0 on
  every child row, so the line runs unbroken.
- **Row heights:**

| Row | Height |
| --- | --- |
| Project header | 28 (lead box 18) |
| Task, status inline on the right | 28 |
| Task with a second line | 42 |
| Level-3 sub-thread with a second line | 42 |
| Review row (one line) | 28 |

- In a 42 row, the icon slot aligns to the top with padding-top 5.
- **Project header** (Workbench's parent row; no separate section label):
  lead box-blob 18, project name `13/16 400` `text.row`, lead name
  `12/16 400` `text.meta`, chevron `icon.chevron`, and the dot slot.
  Clicking it opens the lead's chat. An active, expanded parent shows the
  chevron and edit.
- **Parts of a task row:**
  1. **Icon slot:** 18 × 18. The assignee's face, or the lead box, at 16.
  2. **Title:** `13/16 400` `text.row`, one line, ellipsis.
  3. **Second line:** `11/14 400` `text.meta`. It's `status.amber` for
     "needs you · <ask title>".
  4. **Needs-you marker:** a 6 px `status.amber` dot in a 12 × 26 slot
     (12 × 28 on one-line rows), top-aligned. One marker per open ask, on
     the blocked thread's row only.
  5. **Running ring:** 18 px, `ring.track` (#2C2C2C) with a `ring.arc`
     (#BDBDBD) arc. That's neutral on Team rows; the 10 px face or lead box
     sits inside at (4, 4). Your own plain chats keep Workbench's orange
     arc.
  6. **Provider chip** (only when the provider is non-default or the task
     was handed off): 16 high, radius 4, padding 0 4, gap 2,
     `chip.bg` (#1F1F1F), 1 px `chip.border` (#3A3A3A). Provider glyphs and
     "›" in `10/12` `text.meta`, reading "Claude › Codex". The time and
     reason show on hover.
- **Review row:** 28 high at level 3, a ring with the provider glyph, and
  "Codex reviewing…" `13/16` italic `text.secondary`. Review rows are
  always marked.
- **Stalled task:** the icon slot shows the assignee's stalled face (body
  at 55 % + slate clock badge) instead of a running ring. The status reads
  in `status.slate`, e.g. "stalled · nudged 10:50 · quiet since 10:20"
  (see §6: the clock is used everywhere).

**Example (09:00 sidebar)**

```
Web app            Web app lead                    ›   (header 28)
│ Fix the checkout total rounding               •      (42, marker)
│   needs you · Restart the staging API                (amber)
│ │ Is checkout.spec flaky?                            (level 3, Developer's consult)
│ │   advice, not proof · answered 09:35
│ Pricing page                                  •      (42, Iris)
│   needs you · Pick a pricing page layout
Docs site          Docs lead                       ›
│ (ring) Fix the docs search index      working        (28)
│ (ring) Docs 2.4 release notes         working        (28, Writer)
```

The consult row belongs to 09:35 and later. Variants drawn in the kit (as
examples, not moments of the day): a handed-off task with its provider
chip ("working · on Codex after the handoff") and a stalled task.

**States:** working (ring) · quiet · stalled · nudged (slate) · waiting
for <…> · needs you (amber second line + marker) · needs attention ·
paused · stopped early (slate) · failed (red) · done (folds into the done
group). A review ask is an ask, so the row reads "needs you", never "ready
to merge".

**Copy rules:** §10.4 words only. A provider mark on a task row only when
it's non-default or handed off; review rows are always marked; never on
Nora or member rows. No ids, no tool names.

### 3.4 Ask row

One open ask: who asked, the title and due time, what it unblocks, and the
answer buttons. It appears in the tray, in Today's Your move, and in the
detail panel.

**Redlines**

- Row padding 12 × 14. Face 20, gap 10 to the text column. The text column
  has an 8 px gap between title, meta and buttons; buttons are 8 apart.
  Rows are separated by a 1 px `line.hairline` (#242424).
- **Title:** `13/18 500` `text.ink`, followed by " · due 09:30" in
  `text.meta`. When overdue, the due part is `status.amber` "overdue".
- **Meta:** `12/16 400` `text.meta`, reading "<asker> · unblocks <what>".
- **Buttons:** the shared buttons above.
- **Decide options** are secondary buttons ("A · Comparison table"). A
  recommended option carries ★, which is neutral, never amber. Under the
  buttons, "★ Iris recommends B" in `12/16` `text.meta`.

**Verbs and buttons** (§5.9; copy from EXAMPLE-DAY's ask records)

| Verb | Buttons | Example |
| --- | --- | --- |
| Approve | Approve / Deny | "Restart the staging API · due 09:30", Web app lead · unblocks checking the checkout fix on staging |
| Approve, confirm | Approve… 🔒 / Deny (Approve… opens the confirm step) | "Book the car service for Thu 3 Dec, 08:30 · due 17:00", Olive · unblocks booking the service and telling the garage |
| Decide | the options, then Not now (text button) | "Pick a pricing page layout · due 12:00": A · Comparison table / B · Three cards ★ / C · One plan with a toggle |
| Review, PR | Merge… 🔒 / Send back | "Review and merge the checkout fix · due 16:00", Web app lead · unblocks shipping the checkout fix |
| Review, other | Accept / Send back | "Review the Docs 2.4 release notes · due 17:00", Writer · unblocks publishing the notes with Docs 2.4 |
| Do | Enter key… / Not now | "Enter the new jobs database key · due 18:00", Scout · unblocks Scout's job search (the key form is Mac only) |

**States:** open · overdue · confirming (replaced by the confirm step,
[§3.7](#37-confirm-step)) · answered (replaced by its receipt for 10 s,
[§3.8](#38-receipt)) · stale (a tap that arrived after another answer
changes nothing: "Already answered 09:05 on the phone: Approve").

**Copy rules:** the title, options and secondary action are verbatim from
the ask record. A Confirm action keeps its verb + "…" + lock. No tier
labels, no ids.

### 3.5 Composer context-row strip

It sits above the blocked thread's composer. It's bb's own composer
context row ("1 task from this chat · ready"), not a card.

**Redlines**

- 36 high, padding L 12, R 6, gap 10, radius 8, `bg.tray` (#181818), 1 px
  `line.border` (#313131). No coloured side bar.
- Parts:
  1. A 6 px `status.amber` dot (radius 3).
  2. "needs you" `12/16 400` `status.amber`, doesn't shrink.
  3. The ask: "<title>" in `12/16 400` `text.ink`, then
     " · <asker> · due 09:30" in `text.meta`. It grows, one line, ellipsis.
  4. The ask's verbs as small buttons (radius 5, padding 3 × 10), e.g.
     Approve / Deny.

**States**

- **Open**, and **overdue** (the due part reads "overdue" in amber).
- **Confirming:** short scopes confirm inline, in place.
- **Held send:** "Sending in 18 s · Cancel", counting down from 30 s.
- **Answered:** the strip collapses to the receipt for 10 s, then goes
  away once the thread resumes.
- **Stale:** "Already answered 09:05 on the phone: Approve".

On the phone, the strip is how a push is answered: the push opens the
task's chat and the strip takes the tap. That makes two taps, and it's the
honest flow.

### 3.6 Ask tray

It sits in Nora's chat above the composer and lists every open ask (the
kit shows 14:30).

**Redlines**

- `bg.tray` (#181818), 1 px `line.border` (#313131), radius 10.
- **Header:** padding 10 × 14, gap 8, with a `line.hairline` under it.
  It holds a 6 px amber dot, "Waiting on you" `12/16 500` `status.amber`,
  "most urgent first" `12/16 400` `text.meta` (grows), and "Fold" `12/16`
  `text.secondary`. No count: the Nora tile owns it.
- **Rows:** ask rows ([§3.4](#34-ask-row)) with
  hairlines between them. The first 3 show, then "Show all", which goes to
  Today.
- **Held-send line:** "Sending in 18 s · Cancel" at the top of the tray
  for the full 30 s.

**Order** (the same in Today's Your move, Ask Nora and the Next line):
overdue first, then the soonest due, then Confirm before Contained at the
same due time, then the oldest.

**States**

- Empty: hidden.
- One ask: one row.
- Many asks: the first 3 + Show all.
- Overdue: overdue asks go first.
- 20 or more: the first 3, and Show all goes to Today.
- Folded: the header line only.
- **During a receipt** (decided, §6): the tray stays interactive. The
  answered row shows its receipt, then collapses after 10 s; the other
  rows stay in place and can be answered meanwhile. The Next line follows
  the receipt.

At 14:30 the tray holds "Review and merge the checkout fix · due 16:00"
(Merge… 🔒 / Send back), "Review the Docs 2.4 release notes · due 17:00"
(Accept / Send back) and "Enter the new jobs database key · due 18:00"
(Enter key… / Not now).

### 3.7 Confirm step

Four forms, chosen by where the ask runs (§5.9):

| Form | When | Where |
| --- | --- | --- |
| A · Inline | Short scopes | In place of the ask row where the choice was made (tray, Today, strip) |
| B · Held send | After confirming a send | The receipt row; Cancel stays reachable for 30 s |
| C · Merge confirmation | Every merge or ship, on any device | Harbormaster's Merge confirmation in the task's chat |
| D · Confirm view | Needs reading space: documents, a CV, a message over three lines, more than one recipient | A Team page view (`ask/<id>` route); full screen on the phone |

Nothing is confirmable in the detail panel before a choice: the panel
shows the options first (for example Merge… 🔒 / Send back).

On the phone, every non-merge confirm uses the confirm view, full screen.
The push and the compact page only offer "Review and confirm".

**A · Inline (13:10)**

- A box in `bg.tray`, 1 px `line.border`, radius 10. It replaces the ask
  row in place, with the same padding (12 × 14). Face 20, gap 10; the text
  column has a 10 px gap.
- Context: "Olive · Book the car service for Thu 3 Dec, 08:30" `12/16`
  `text.meta`.
- Restated scope: "Send this message to the garage from your account and
  book Thu 3 Dec, 08:30? It can't be unsent." `14/20 500` `text.ink`.
- The message in full: indented 12 (padding 2 × 0), with lines 2 apart.
  "To the garage, from your account" in `12/16` `text.meta`, then each
  message line in `13/20 400` `text.row`.
- Buttons: primary "Send and book Thu 3 Dec, 08:30", secondary "Cancel".

**B · Held send (13:10 → 13:11)**

- A receipt row (see [§3.8](#38-receipt)) with a 14 px clock icon in
  `text.secondary` in place of the check.
- Title "Book the car service for Thu 3 Dec, 08:30". Under it: "Approved
  13:10 · " in `text.meta`, "Sending in 30 s" in `text.ink`, " · " and
  "Cancel" in `text.link`. "unverified tap" on the right.
- Then: "Approved 13:10 · sent 13:11 · can't be unsent".
- While it's held, the member and task rows read "sending in 30 s" (§6).

**C · Harbormaster Merge confirmation (15:52)**

It shows in the task's chat on every device.

- A box in `bg.tray`, 1 px `line.border`, radius 10, in three bands split
  by `line.hairline`:
  1. Head (padding 14 × 16, gap 2): "Merge PR #128 into main?" `15/22 500`
     `text.ink`; "Fix the checkout total rounding · Web app lead" `12/16`
     `text.meta`.
  2. Checks (padding 12 × 16, gap 6): each is a 14 px icon + `13/18`
     `text.row`. "Tests passing" and "Checked on staging" have a
     `status.green` check. "Merges exactly 3f2a9c1, the PR's current HEAD"
     has a commit icon in `text.secondary`, with the hash in Menlo 12.
  3. Foot (padding 12 / 16 / 14, gap 10): "A merge can't be undone. A
     rollback would be a new ask." `12/16` `text.secondary`, then primary
     "Merge PR #128 into main" and secondary "Cancel".

**D · Confirm view (18:00, the job application)**

- Back link: a 12 px chevron and "Today" `12/16` `text.secondary`, with
  padding-bottom 14.
- Head (gap 4, padding-bottom 16):
  - the asker's face 20 and "Scout · Due Fri 27 Nov, 12:00" `12/16`
    `text.meta`;
  - the title "Apply to the Frontend engineer role at Example Corp"
    `18/26 600` `text.ink`;
  - "Unblocks sending your application" `12/16` `text.meta`.
- Bands split by `line.hairline` (padding 14 vertical unless noted):
  1. "Cover note" label `12/16` `text.meta`, then the note `14/22 400`
     `text.row`.
  2. Attachment (padding 12, gap 10): a 16 px file icon, "cv.pdf" `13/18`
     `text.row`, and "Open" `12/16` `text.link`.
  3. Options: "Approve…" 🔒 (primary), "Deny" (secondary), "Not now"
     (text button).
  4. **Confirming** (gap 10), after Approve…: the restated scope "Send your
     CV (cv.pdf) and this cover note to Example Corp's careers form from
     your account? It can't be unsent." `14/20 500` `text.ink`, then
     primary "Send the application" and secondary "Cancel".
  5. **Timed out:** a 36 px state row. A 14 px clock icon, "This
     confirmation timed out." `13/18` `text.row`, and "Review it again"
     `13/18` `text.link`.
  6. **Changed:** a 36 px state row. A 14 px refresh icon, "This ask
     changed; check it again." `13/18` `text.row`, and what changed in
     `12/16` `text.meta` ("Nora updated the cover note").

**Copy rules**

- Restate the full scope in plain words, including "It can't be unsent" or
  "can't be undone".
- The confirm button restates the action ("Send and book Thu 3 Dec,
  08:30", "Merge PR #128 into main", "Send the application"). Cancel is
  the only other button.
- "Review and confirm" appears only on the phone, as the redirect.

### 3.8 Receipt

A receipt shows for 10 s on the surface you answered from, then the
answer moves to Answered today (newest first).

**Redlines**

- Row padding 9 × 0, gap 10, `line.hairline` under it, items aligned to
  the top.
- A 14 px `status.green` check (stroke 1.5), with margin-top 2.
- Text column (gap 1):
  - the title `13/18 400` `text.row`;
  - the receipt `12/16 400` `text.meta`, with links in `text.link`.
- Provenance on the right: `12/18 400` `text.meta`, doesn't shrink.

**Anatomy of the receipt text**

- **Both times:** "<Verb> 09:05 · ran 09:06" means when you answered, then
  when it happened.
- **Reversibility:** "can't be undone, limited to staging", "can't be
  unsent", or a link "Undo until 11:25". Undo appears only where the
  effect can really be reversed within a set window. Money, production
  and merges never get Undo.
- **Wasn't me?** A link, "Wasn't me? Pause and revoke", that stays until
  the grant expires.
- **Provenance:** "unverified tap" (buttons) or "typed reply". Every
  answer on the example day is "unverified tap".

**States:** done (check) · held (clock, "Sending in 30 s · Cancel") ·
verifying (neutral ring, "Key saved 17:05 · checking").

**Answered today at 18:00, newest first** (verbatim):

| Title | Receipt |
| --- | --- |
| Enter the new jobs database key | Key works · checked 17:06 |
| Review and merge the checkout fix | Approved 15:52 · merged 15:53 · can't be undone |
| Review the Docs 2.4 release notes | Accepted 15:50 · handed to the Docs lead 15:51 · Undo until 16:00 |
| The build Mac is offline: where should the Safari check run? | Chose WebKit in Iris's sandbox 15:05 · started 15:06 |
| Book the car service for Thu 3 Dec, 08:30 | Approved 13:10 · sent 13:11 · can't be unsent |
| Continue the pricing page build? | Continued 13:00 · resumed 13:05 |
| Pick a pricing page layout | Chose B 11:15 · building from 11:16 · Undo until 11:25 |
| Restart the staging API | Approved 09:05 · ran 09:06 · can't be undone, limited to staging · Wasn't me? Pause and revoke |

Every row ends in "unverified tap".

### 3.9 Next line

It follows a receipt on every surface and opens the next ask.

**Redlines**

- 32 high, with `line.hairline` at the top and bottom. Gap 6, items
  centred.
- "Next:" `12/16 400` `text.meta`, then the title `12/16 500` `text.ink`,
  then the count part `12/16 400` `text.meta`. A spacer grows, and a
  14 px arrow in `text.secondary` sits at the right.

**Copy rules (decided, §6)**

N is the number of asks still open after the next one.

| N | Line |
| --- | --- |
| 0 | "Next: <title>" |
| 1 | "Next: <title> · then 1 more" |
| 2 or more | "Next: <title> · then N more", with the real count |

- With nothing left, there's no line.
- The order matches the tray.
- The same text drives the Nora tile's preview line.

Example, at 11:16 after choosing B for "Pick a pricing page layout":
"Next: Review and merge the checkout fix · then 1 more" (due 16:00 comes
before the car service, due 17:00).

### 3.10 Ask Nora overlay (⌘⇧J)

It opens from anywhere: a one-line ask to Nora, plus every waiting ask
(the kit shows 09:00).

**Redlines**

- Panel: 560 wide, radius 12, `bg.sidebar` (#1B1B1B), 1 px `line.border`,
  shadow `0 16px 40px rgba(0,0,0,.45)`. This is the overlay's elevation,
  not a glow.
- Input: 48 high, padding 0 14, gap 10. Nora's face 20, the placeholder
  "Ask Nora anything" `14/20 400` `text.meta`, and the shortcut hint "⌘⇧J"
  on the right in `text.meta`.
- List: the label "Waiting on you", then one link row per ask. Rows are 32
  high, padding 0 8, radius 6; the selected row is `bg.tile` (#262626).
  Each row has the asker's face 16, the title (`13/16` `text.row`), and
  "due 09:30" on the right in `12/16` `text.meta`.
- At 09:00: "Restart the staging API" (due 09:30) and "Pick a pricing page
  layout" (due 12:00).

**Behaviour:** Enter sends the line to Nora. A row jumps to its thread or
answers the ask there. A Confirm ask opens its confirm step by the §5.9
rule.

**States**

- No asks: the input only.
- Overdue asks first.
- 20 or more: a searchable list.
- Same order as the tray, no count.

The shortcut defaults to ⌘⇧J and can be rebound in bb's keyboard
settings. mod+J stays bb's panel toggle.

---

## 4. Tokens

Dark is bb's dark base. Light is bb's light base plus the §10.4 WCAG
values. Contrast is WCAG 2, computed against the background named in each
column. Text needs 4.5:1, UI marks 3:1. Team adds no new surfaces: map
these onto bb's theme variables where they exist.

### 4.1 Dark

Ratios are against `bg.canvas` #151515 · `bg.sidebar` #1B1B1B ·
`bg.tile` #262626.

| Token | Hex | Use | Contrast |
| --- | --- | --- | --- |
| `bg.canvas` | #151515 | Main column, Team page | surface |
| `bg.sidebar` | #1B1B1B | Sidebar, overlay panel; the badge cut colour | surface |
| `bg.tray` | #181818 | Tray, strip, confirm and Merge boxes | surface |
| `bg.tile` | #262626 | Nora tile, selected list row, selected overlay row | surface |
| `line.hairline` | #242424 | Separators | decorative |
| `line.border` | #313131 | Box borders | decorative |
| `button.border` | #333333 | Secondary button border | the label identifies the button |
| `line.tile` | #303030 | Nora tile border | decorative |
| `line.tree` | #343434 | Sidebar tree lines, 1 px | decorative |
| `text.ink` | #EDEDED | Titles, ask titles, secondary button labels | 15.60 · 14.71 · 12.93 |
| `text.row` | #C1C1C1 | Row titles, names, body copy | 10.14 · 9.57 · 8.41 |
| `text.secondary` | #A8A8A8 | Text buttons, review rows, all text on the Nora tile, icons | 7.68 · 7.24 · 6.36 |
| `text.meta` | #8A8A8A | Meta, second lines, statuses, placeholders. **Never on #262626** | 5.29 · 4.99 · 4.38 ✗ |
| `text.section` | #B7B7B7 | Workbench section label ("Team") | 9.11 · 8.59 |
| `status.amber` | #F0B135 | Needs you, needs attention: text, 6 px dot, badge, count pill (number #151515, 9.60) | 9.60 · 9.06 · 7.96 |
| `status.green` | #5BD08A | Receipt checks, passing checks | 9.42 · 8.89 |
| `status.red` | #E06C6C | Failed only | 5.68 · 5.36 · 4.71 |
| `status.slate` | #9BA6BA | Stalled · nudged, paused · stopped early | 7.44 · 7.02 |
| `text.link` | #7AA2E0 | Undo, Cancel, Wasn't me?, Review it again, ask links | 7.02 · 6.62 (6.83 on `bg.tray`) |
| `ring.arc` / `ring.track` | #BDBDBD / #2C2C2C | Running ring on Team rows (your own chats keep Workbench's orange) | arc 9.72 · 9.17 |
| `icon.chevron` | #6E6E6E | Chevrons; marks only, never text | 3.58 · 3.38 (mark) |
| `button.primary` | #E6E6E6 | Primary fill, label #151515 | label 14.63 |
| `chip.bg` / `chip.border` | #1F1F1F / #3A3A3A | Provider chip | decorative |
| `orbit.ring` | #4A4A4A | Dashed orbit ring on the Nora tile | decorative |
| `badge.working.track` | #3A3A3A | Track of the working badge ring (arc is `ring.arc`) | decorative |
| `note.border` | #3A3A3A | Dashed border of annotation boxes, **design files only** | — |

### 4.2 Light

Ratios are against `bg.canvas` #FFFFFF · `bg.sidebar` #FAFAFA ·
`bg.raised` #F9F9F9.

| Token | Hex | Use | Contrast |
| --- | --- | --- | --- |
| `bg.canvas` | #FFFFFF | Main column, composer; the badge cut colour | surface |
| `bg.sidebar` | #FAFAFA | Sidebar | surface |
| `bg.raised` | #F9F9F9 | Tray, strip, confirm and Merge boxes | surface |
| `bg.selected` | #EDEDED | Nora tile, selected row | surface |
| `line.hairline` | #E9E9E9 | Separators | decorative |
| `line.border` | #DFDFDF | Borders, ring track, tree lines, composer border | decorative |
| `text.strong` | #262626 | Titles; primary button fill (white label 15.13) | 15.13 · 14.50 · 14.37 |
| `text.body` | #333333 | Row titles, body, secondary button label | 12.63 · 12.10 · 12.00 |
| `text.secondary` | #525252 | Icons, labels, text buttons, **all text on the Nora tile** | 7.81 · 7.49 · 7.42 (6.67 on #EDEDED) |
| `text.meta` / `ring.arc` | #707070 | Meta, second lines, statuses; ring arc. **Not on #EDEDED** (4.23) | 4.95 · 4.74 · 4.70 |
| `status.amber` | #B45309 | Needs you / attention text, dot, badge, pill (white number 5.02) | 5.02 · 4.81 · 4.77 |
| `status.green` | #15803D | Receipt checks | 5.02 · 4.81 · 4.76 |
| `status.red` | #B91C1C | Failed only | 6.47 · 6.20 · 6.15 |
| `status.slate` | #64748B | Stalled, paused | 4.76 · 4.56 · 4.52 |
| `text.link` | #4075AA | Undo, Cancel, links | 4.84 · 4.63 · 4.59 |
| `button.border` | **#8F8F8F** (was #BDBDBD, 1.88) | Secondary button border, fixed to ≥ 3:1 (§6) | 3.23 · 3.10 · 3.07 |
| `flag.claude` | #D97757 | Lead box-blob flag (both themes) | 3.12 (mark) |

- In light mode, neutral icons are the dark SVGs inverted (#C1C1C1 becomes
  #3E3E3E). You can also map them to `text.secondary`; both pass.
- Light amber never sits on #EDEDED as text (4.29). On the tile, only the
  pill (white on amber, 5.02) is amber.
- The light faces get a 0.8-unit outline (see [§5](#5-avatars)).

### 4.3 Status vocabulary (§10.4)

This is the one list: rows use these words and no others.

| Status (as shown) | Meaning | Tone | Mark |
| --- | --- | --- | --- |
| idle | No open work. Never "free" | Neutral | No badge |
| working | Measured activity in the last 10 min | Neutral | Activity ring badge, #BDBDBD (light #707070) |
| quiet | Running, but 10 min without measured activity | Neutral | Face body at 55 %, no badge |
| stalled · nudged | 30 min without activity, nudged (§4.10) | Slate | Body at 55 % + slate clock badge, **everywhere** (rows, cards, detail; §6) |
| waiting for <member / the build Mac / the usage reset / CI> | A declared wait | Neutral | No badge; leaves the orbit, not docked |
| needs you | An ask is open on this row (one marker per ask, §5.9) | Amber | 6 px dot on the blocked row; amber "!" disc on faces 20 px and up; docks on Nora's tile |
| needs attention | An offline machine, or a projected budget overrun | Amber | Amber triangle "!" badge |
| paused · stopped early | Stopped early with no ask open (resumable) | Slate | Slate disc ❚❚ |
| failed | The work failed (nothing fails on the example day) | Red | Red disc ×; never pulses |
| in <project> | The member's work is shown under that project (member rows only) | Neutral | Never repeats the task's state |
| done | Merged, accepted or finished, with no review waiting | Neutral | Folds into the done group |
| sending in 30 s | A confirmed send held for its 30 s Cancel window (added by this handoff, §6) | Neutral | No badge |

### 4.4 Type scale

Inter throughout; Menlo 12 for the one handle and commit hashes.

| Style | Use |
| --- | --- |
| `20/26 600`, −0.01em | Team page title |
| `18/26 600` | Confirm view title, detail panel title |
| `15/22 500` | Merge confirmation title (phone top bar: `15/20 600`) |
| `14/22 400` | Messages, the cover note |
| `14/20 500` | Restated scope (overlay input: `14/20 400`) |
| `13/18 500` | Ask title (receipt title and check rows: `13/18 400`) |
| `13/16 400` | Sidebar rows, names ("Nora" on the tile: 600) |
| `12/16 400` | Meta, statuses, links. Primary button labels 500; the count is 700 |
| `12/15 400` | Sidebar section label |
| `11/14 400` | Row second line |
| `10/12 400` | Provider chip glyph row |
| Menlo `12/16` | The handle in the detail panel, commit hashes |

### 4.5 Spacing

| px | Where |
| --- | --- |
| 2 | Message block lines; chip gap |
| 3 | Tile name → preview |
| 6 | Tile gap, lock gap, Next gap |
| 7 | Sidebar row gap |
| 8 | Sidebar inset, button gap, ask text column gap, overlay row padding |
| 10 | Row indent, face → text, tray header padding Y, strip gap, confirm column gap |
| 12 | Ask row padding Y, section gap, strip padding L, tile → nav |
| 14 | Row padding X, sidebar row padding R, confirm view band padding |
| 16 | Merge confirmation padding X |
| 34 · 58 | Task and level-3 indents |
| 19 · 43 | Tree line x positions |

**Heights:** 28 row · 32 Next line, overlay link row · 36 strip, state
row · 42 two-line row · 48 overlay input · 64 Nora tile.

### 4.6 Radii

| px | Where |
| --- | --- |
| 3 | 6 px dot (fully round) |
| 4 | Provider chip |
| 5 | Small strip buttons |
| 6 | Buttons, overlay link rows |
| 8 | Composer strip |
| 10 | Tray, confirm box, Merge box, Nora tile, count pill |
| 12 | Ask Nora panel |

---

## 5. Avatars

There are two systems with one set of states.

- **H3 Orbit** is the default everywhere: blob creatures for Nora and the
  members, and box-blobs for project leads. On Nora's tile, working
  members orbit her and waiting-on-you members dock beside the count.
- **H2 Calm faces** is the Appearance setting "Appearance › Calm faces".
  It uses generative outlines: Nora is a sun-flower; Iris a blob,
  Developer a hexagon, Writer a pill, Olive a circle, Scout a triangle;
  leads are notched folder tiles with the project glyph and a provider
  mark. H2 has no orbit and no dock. Its Nora tile is the flower at 40 px
  (x 8), the text, and the pill. Badges, dims and transitions are the same
  as H3.

### 5.1 Faces and sizes

- Every face is a 24-unit viewBox. Draw them at these sizes:

| Size | Where |
| --- | --- |
| 10 | Inside an 18 px running ring |
| 16 | Sidebar rows, docked faces |
| 18 | Project header lead box |
| 20 | Asks, messages, overlay input |
| 24 | Lists, Team page |
| 64 × 50 | Nora tile orbit slot |

- **Identity never changes with state:** the body, outline and role
  feature stay put. State is one badge at the bottom right, or a dim.
- **Leads:** a graphite box-blob, the project glyph (globe = Web app,
  book = Docs site) and a flag in the provider colour. Both leads,
  including the **Docs lead**, carry the **Claude** flag `flag.claude`
  #D97757. This is settled, and it holds even on default-provider leads.
- **Light faces** add a 0.8-unit outline in a darker body hue (≥ 3:1 on
  white):

| Face | Outline | On white |
| --- | --- | --- |
| Nora | #A27A00 | 3.95 (3.37 on #EDEDED; the butter fill alone is 1.59) |
| Iris | #C2336F | 5.25 |
| Developer | #2A4FB8 | 7.22 |
| Writer | #6E55D6 | 5.34 |
| Olive | #5F7A12 | 4.91 |
| Scout | #137A6E | 5.20 |
| Lead box top | #7A7A7A | 4.29 |

### 5.2 Badge corner and dim

- **Corner:** one badge, at the bottom right. Its centre is (19.6, 19.6)
  on the 24-unit face. The disc has r 4.0 and sits inside a cut ring of
  r 4.8 in the surface colour (dark #1B1B1B, light #FFFFFF), so the badge
  reads on any body.
- **Badges:**

| State | Badge |
| --- | --- |
| working | Neutral ring: track #3A3A3A, arc #BDBDBD (light #DFDFDF / #707070). Static |
| needs you | Amber disc with "!" |
| needs attention | Amber triangle with "!" |
| paused · stopped early | Slate disc ❚❚ |
| stalled · nudged | Slate disc with a clock (+ dim) |
| failed | Red disc × |
| idle, quiet | None |

  Light badges are #B45309, #64748B and #B91C1C with white glyphs
  (≥ 4.76:1).
- **Dim:** quiet and stalled draw the body at 55 %, never below 50 %, so
  the silhouette and role feature still read. No other state dims.
- **Where badges hide:**
  - On 16 px sidebar rows, there's no needs-you badge: the row's amber
    marker is the one signal per ask.
  - Docked faces on Nora's tile have no badge.
  - Running members show only the face's ring badge, with no second ring
    on the row.
- Nothing pulses, shakes or flashes, including failed.

### 5.3 Assets in `avatars/`

Each file is one complete SVG (face + badge + cut ring baked in) on a
24-unit viewBox, for one theme. Use the file for the state; don't compose
badges at runtime unless you rebuild them to the values above.

What's in `avatars/` (256 face SVGs plus the Nora tiles):

- `h3/` (default, Orbit): 6 members + 2 leads × 8 states × dark/light = 128 files.
- `h3/nora-tile/`: `orbit-0900|1430|none-<dark|light>.svg` (the orbit
  composition only) and `tile_0900.svg`, `tile_1430.svg`, `tile_1800.svg`
  (dark, the full tile with orbit, dock and pill, for reference).
- `h2/` (Appearance › Calm faces): the same 128 keys, outline-driven.
- `h2/nora-tile/`: `nora-tile-h2.svg` and `nora-tile-h2-rest.svg` (no orbit).

The naming scheme:

- `h3/face-<member>-<state>-<dark|light>.svg`
  - `<member>`: `nora`, `iris`, `dev` (Developer), `writer`, `olive`,
    `scout`.
  - `<state>`: `idle`, `working`, `needs` (needs you), `attention` (needs
    attention), `paused` (paused · stopped early), `quiet`, `stalled`
    (stalled · nudged), `failed`.
- `h3/lead-<project>-<state>-<dark|light>.svg`: project lead box-blobs.
  `<project>` is `web` (Web app lead, globe) or `docs` (Docs lead, book).
  Both have the Claude flag; states as above.
- `h3/nora-tile/orbit-<moment>-<dark|light>.svg`: the orbit composition for the
  tile's 64 × 50 slot (72 × 56 units).
  - `0900`: Writer and Docs lead orbit.
  - `1430`: Docs lead orbits.
  - `none`: the empty orbit at rest (18:00).
  - The dock and the pill are **not** in the asset. Build them in the DOM
    from §3.1.
- `h2/face-<member>-<state>-<dark|light>.svg` and `h2/lead-<web|docs>-…`:
  the Calm faces set, same keys and states, same badges. Both H2 leads carry
  the Claude provider mark.

---

## 6. Still not fitting: decided

These were the open points left by the final review. Each is now decided;
build them as written here, even where a frame shows otherwise.

1. **Rollover quote (§6.8).** The fresh home chat's handover note quotes
   **up to the last 5 user requests, or all of them if there are fewer**.
   The example day has only 2 (08:05 and 09:45), so both are quoted.
   Relayed messages are never quoted as the user's.
2. **The tray during a receipt.** The tray **stays interactive**. The
   answered row shows its receipt, then **collapses after 10 s**; the
   other rows stay where they are and can be answered at any time. The
   Next line follows the receipt.
3. **Held-send status word.** While a confirmed send is held (Olive,
   13:10–13:11), the member and task rows read **"sending in 30 s"**
   (neutral, no badge). It's added to the §10.4 list
   ([§4.3](#43-status-vocabulary-104)). The receipt line keeps "Sending in
   30 s · Cancel" (the strip and tray count down, "Sending in 18 s ·
   Cancel") for the full 30 s, then "sent 13:11 · can't be unsent".
4. **Next line count.** Where N asks remain after the next one, the line
   is "· then 1 more" for N = 1 and "· then N more" with the **real
   count** for N ≥ 2. With N = 0 there's no "then" part. This replaces the
   earlier at-most "then 1 more" rule, and it drives the Nora tile's
   preview too. At 14:30 that's "Next: Review and merge the checkout fix ·
   then 2 more".
5. **Compact phone Team page (16:30).** It **scrolls**. Older Answered
   today rows sit below the fold, and the page doesn't squeeze to fit one
   screen.
6. **Light secondary-button border.** It's fixed from #BDBDBD (1.88:1) to
   **#8F8F8F**: 3.23:1 on #FFFFFF, 3.10:1 on #FAFAFA and 3.07:1 on
   #F9F9F9. It clears 3:1 on every light surface a button sits on.
   (#949494 would be 3.03:1 on white but only 2.88:1 on the tray, so it
   was rejected.)
7. **Motion tile geometry.** `MOTION-SPEC.md` §2 is aligned to the kit:
   - **18 px dock discs holding 16 px faces, at a 10 px step**, not 12;
   - the tile's real size (304 × 64, orbit slot 64 × 50);
   - the badge geometry and working-ring colours from §5.2.

   The motion timings, easing and choreography are unchanged. Where the
   motion spec's numbers differ from this file, this file wins.
8. **Stalled badge.** The stalled mark is the **slate clock badge (with
   the 55 % dim) everywhere**: sidebar rows, Board cards, the detail
   panel, the timeline, Problems, and the faces. The "broken slate ring"
   drawn in some frames and in the motion spec is retired. The status text
   stays `status.slate` "stalled · nudged".

**Remaining copy gaps.** These are placeholders in the frames. The build
writes them from real data and doesn't copy them:

- **The garage message** in the car service confirm step ("Hello, I'd like
  to book a car service…"). The real text is whatever Olive drafted.
- **The cover note** in the job application confirm view. The real text
  is whatever Scout drafted.
- **The merge HEAD** in the Merge confirmation (`3f2a9c1`). Use the PR's
  real current HEAD, short form, in Menlo.
- **Handles:** the one copyable handle in the task detail panel (shown as
  `a_8x2k4m`). Use the real assignment handle.
- Members' chat lines, Nora's 15:00 message and "You're clear" were
  composed for the frames and are illustrative. Real ones come from the
  agents.

**Lead flag.** The Docs lead's flag is **Claude** (#D97757), the same as
the Web app lead's, in H3 and H2. Any asset that shows a Codex mark on the
Docs lead is wrong and must be regenerated before it ships.

**Still open** (not decided; follow the rule that already exists):

- **The Nora tile preview at 09:00 and 18:00.** The kit shows Nora's
  latest line ("Morning check-in at 09:00", "Evening check-in at 18:00");
  the motion spec shows the Next line. Both are allowed by the §3.1 rule.
- **The checkout-fix merge strip and the Merge confirmation.** They were drawn one at a time
  in the task's chat. Whether they can both be visible at once isn't
  specified.

---

## 7. Where to look in the spec

[§5.9](../SPEC.md#59-ask-contract) ask contract, confirm flow, receipts ·
[§4.10](../SPEC.md#410-progress-shown-to-the-user) progress and stalls ·
[§6.8](../SPEC.md#68-rolling-over-long-lived-home-chats) rollover ·
[§7.4](../SPEC.md#74-check-ins) check-ins ·
[§10.2](../SPEC.md#102-screens-and-states) screens and states ·
[§10.4](../SPEC.md#104-user-facing-copy-and-visual-rules) copy, statuses, light WCAG ·
[§10.5](../SPEC.md#105-sidebar-provider-marks-and-nesting) provider marks and nesting ·
[§11.2](../SPEC.md#112-sidebar-strategy) sidebar strategy ·
[EXAMPLE-DAY](../EXAMPLE-DAY.md): [ask records](../EXAMPLE-DAY.md#ask-records),
[timeline](../EXAMPLE-DAY.md#timeline), [counts](../EXAMPLE-DAY.md#counts-at-three-moments),
[sidebar at 14:30](../EXAMPLE-DAY.md#sidebar-at-1430).
