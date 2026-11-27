# Team avatars · motion spec

Two avatar systems, one motion language. **H3 Orbit** is the default. **H2 Calm faces** is an Appearance setting
("Appearance › Calm faces"). Prototype: [`motion/index.html`](motion/index.html) (self-contained; open in any browser).
Frames: [`frames/final-avatars-h3.png`](frames/final-avatars-h3.png), [`frames/final-avatars-h2-setting.png`](frames/final-avatars-h2-setting.png). Assets: [`avatars/`](avatars/).

## 0. Rules for both systems

**When motion plays**

| Surface | H3 Orbit | H2 Calm faces |
| --- | --- | --- |
| Nora's tile | Orbit loops while at least one member is working (the only loop in the sidebar). Events: join, leave, dock, wink, count tick, rest | No loop. Hover: breathe + glance. Events: petal step, wink, count tick, rest |
| Sidebar list rows (16 px) | Events only (badge in or out, dim) | Events only. Hover: face shows, glance, breathe while hovered |
| 24 px and up (Team page cards, member chat header, ask detail) | Events only | Idle sequence (§3.1) while visible; hover: glance |

- Never loop in the sidebar list except the orbit. Nothing pulses, shakes or flashes, including failed.
- Pause everything when the window is hidden or unfocused (`visibilitychange` / blur); the orbit resumes where it stopped.
- **Identity never animates on a state change**: body, outline and role feature stay put. State is one bottom-right badge, or dimming.
- **Reduced motion** (`prefers-reduced-motion: reduce`): no movement at all. See §4.

**Tokens**

| Token | Value |
| --- | --- |
| `ease-enter` | `cubic-bezier(.2,.8,.2,1)` |
| `ease-exit` | `cubic-bezier(.4,0,1,1)` |
| `ease-move` | `cubic-bezier(.65,0,.35,1)` |
| `linear` | the orbit only |
| Durations (ms) | 120 exit · 150 text · 180 badge in · 200 fade out · 240 dim, pill pop · 260 needs-you pop · 280 wink · 300 slide · 360 lift · 400 ring fade · 600 petal step · 4 000 breathe · 36 000 lap |

## 1. State on top of identity (both systems)

The badge sits bottom right: centre (19.6, 19.6) on a 24-unit face, r 4.3, with a 1-unit cut-out in the surface colour.
Both systems use the same badges.

| State | Badge | Body | H2 face (24 px and up) |
| --- | --- | --- | --- |
| idle | none | 100 % | dot eyes, smile |
| working | activity ring: #2E2E2E disc, ¾ arc #BDBDBD (light: #E6E6E6 / #6B6B6B), static | 100 % | eyes down-right, flat mouth |
| needs you | amber #F0B135 disc, "!" | 100 % | wide eyes, small "o" |
| quiet | none | 55 % | closed eyes |
| paused · stopped early | slate #9BA6BA disc, ❚❚ | 100 % (H2: fill 60 % toward slate) | closed eyes, flat mouth |
| stalled · nudged | slate clock badge (#9BA6BA disc, clock glyph), the same everywhere | 55 % | closed eyes, wavy mouth |
| failed | red #E06C6C disc, × | 100 % | × eyes, flat mouth |

- Dim is 55 %, never below 50 %, so the silhouette and role feature always read.
- **16 px sidebar rows**: needs you has no avatar badge. The row's amber marker is the one signal per ask. All other badges show.
- Working replaces the R4 green dot with the neutral activity ring, so it matches the Team rows' #BDBDBD running ring.
  Member rows don't get a second ring.

**Transition** (any state → any state):
1. The old badge exits: 120 ms `ease-exit`, scale 1 → .7, fade out.
2. The new badge enters after 80 ms: 180 ms `ease-enter`, scale .5 → 1, fade in. Needs you uses 260 ms with one 12 % overshoot (.5 → 1.12 → 1).
3. The body dims or undims: 240 ms ease (undim 160 ms). H2's paused tint takes 240 ms.
4. The H2 face mood swaps at badge entry (+80 ms), with no tween.
5. The row's second line crossfades in 150 ms. The amber row marker fades in 150 ms.

## 2. H3 Orbit · Nora's tile

**Geometry** (tile 288 × 56, origin top left)
- Orbit centre (36, 28); ellipse rx 29, ry 21; ring dashed #4A4A4A, 0.8 px, dash 1.5/2.5.
- Nora is the 24-unit face scaled 1.7 (40.8 px) at (15.6, 7.2).
- Satellites use scale .65 + .05·sin(a), so 14.4 to 16.8 px. They draw behind Nora while sin(a) < 0 (top half) and in front otherwise.
- Text starts at x 76. Dock slot centres x 244, 234, 224 (18 px faces, 10 px step, matching the kit tile), y 28. The count pill is at right 12, 20 px tall.

**Who goes where**
- **Orbit**: members and leads with measured activity (working).
- **Dock**: members and leads who asked you something still open. Each asker gets one face, however many asks.
  Nora's own asks dock nobody.
- **Neither**: idle, quiet, paused, stalled, or waiting on something other than you (Iris at 14:30, waiting for the build Mac).
  Stalled and paused members leave the orbit.

**Motion**
- **Lap**: 36 s, linear (10°/s), clockwise. Satellites are spaced evenly at 360°/n. When n changes, they re-space along the ring in 300 ms `ease-move`.
  There are at most 6 satellites. With 7 or more, the six most recent show and the ring stroke goes from 0.8 to 1.4.
- **Join**: 300 ms `ease-enter`. The satellite slides out of Nora's centre (scale 0 → slot size) and stays behind her for the first 40 %.
- **Leave** (stops working, no ask): 300 ms `ease-exit` back into Nora's centre, scale → 0, behind her.
- **Leave to dock** (asks you): 300 ms `ease-move`, a straight slide from its orbit position to dock slot 0 (nearest the count), shrinking to 18 px.
  The wink and the count tick fire on arrival (t = 300 ms).
- **Dock order**: the newest is nearest the count and on top. At most 3 faces show; older ones tuck behind (opacity 0), and the count says how many.
  Docked faces carry no badge.
- **Answered**: the face shrinks to 50 % and fades out in place (200 ms `ease-exit`). The rest close up (300 ms `ease-move`). The count ticks down with no pop.
- **Wink** (every new ask, Nora's own too): her open right eye becomes an arch for 280 ms. Her head tilts −6° and rises 0.6 px (360 ms `ease-move`, pivot at the chin).
- **Count tick**:
  - The old number slides up 10 px and fades (140 ms `ease-exit`). The new one rises from 10 px below (160 ms `ease-enter`).
  - On an increase, the pill also pops to 1.15 (240 ms, starting at 120 ms).
  - On a decrease, there's no pop.
  - The first ask brings the pill in (scale .6 → 1, 180 ms). The last answer takes it out (120 ms).
- **Status line**: "Next: <title> · then 1 more". It crossfades in 150 ms. Its right edge moves with the dock (300 ms). It truncates with an ellipsis, and the full text is in the tooltip.
- **Rest**: 400 ms after the orbit empties, the ring fades out (400 ms) and Nora's eyes close (downward arcs, swapped with no tween).
  - When an ask lands during rest, she opens her eyes, winks, and stays awake 1.2 s after the wink, then closes them again.
  - A join wakes her at once, and the ring fades back in.

**Example day** (counts and askers from EXAMPLE-DAY; the dock lists oldest → newest)

| Moment | Orbit | Dock | Count | Status line |
| --- | --- | --- | --- | --- |
| 09:00 | Writer, Docs lead | Iris, Web app lead | 2 | Next: Restart the staging API · then 1 more |
| 14:30 | Docs lead | Web app lead, Writer, Scout | 3 | Next: Review and merge the checkout fix · then 1 more |
| 18:00 | — (rest, eyes closed) | Docs lead, Iris, Scout | 3 | Next: Review and merge the docs search fix · then 1 more |

The afternoon (as the prototype plays it):
- 15:00: Nora asks, so she winks and the count goes to 4.
- 15:05: Iris joins and the count goes to 3.
- 15:30: Docs lead leaves to dock, she winks, and the count goes to 4.
- 15:40: Iris docks, the count goes to 5, and Nora rests.
- 15:50: Writer's face fades out (4).
- 15:52: Web app lead's face fades out (3).
- 17:06: Scout's face fades out (2).
- 17:10: Scout joins and Nora wakes.
- 17:20: Scout docks and the count goes to 3. Nora rests.
- 18:00: still resting.

## 3. H2 Calm faces (Appearance › Calm faces)

H2 swaps every avatar for a generative outline:
- Nora: sun-flower.
- Members: Iris blob, Developer hexagon, Writer pill, Olive circle, Scout triangle.
- Leads: notched folder tiles with the project glyph and a provider dot.

There's no orbit and no dock. Nora's tile is the flower (40 px at x 8), the text and the count pill. Same badges and transitions as §1.

### 3.1 Idle sequence (10 s, the Iris loop)

| t (s) | Phase | What moves |
| --- | --- | --- |
| 0–1 | rest | nothing |
| 1–5 | breathe | one 4 s cycle, `ease-move`. Soft outlines only: Iris's lobes run phase 0 → 2π. Nora's petal amplitude goes .20 → .22 → .20 |
| 5.0 | blink | eyes become lines for 140 ms |
| 6.0–7.22 | glance | eyes shift 0.04 × size: 180 ms out (`ease-move`), 800 ms hold, 240 ms back |
| 7.22–10 | rest | nothing |

- Hard outlines (hexagon, pill, circle, triangle, lead tile) skip breathe: rest, blink, glance, rest.
- In the product, blinks jitter 6 to 10 s apart, and there's at most one glance per sequence.
- It plays only at 24 px and up outside the sidebar list, while visible (§0).

### 3.2 Reactions
- **Hover, sidebar row (16 px)**:
  1. The inner mark crossfades to the face (120 ms).
  2. At 120 ms, the eyes glance toward the name (180 ms).
  3. Soft outlines breathe while the pointer stays.
  4. On leave, everything settles in 200 ms and the face goes back to the mark (120 ms).
- **Hover, 24 px and up**: glance only.
- **Ask lands (the member who asked)**:
  - At 24 px and up: the needs-you badge pops in (260 ms). At 120 ms there's one blink and a 6 % lift (360 ms, sine). Then the needs-you face holds still.
  - At 16 px in the list: only the row's amber marker fades in (150 ms).
- **Nora's tile, ask lands**:
  - The petals turn one step (45°, one petal, 600 ms `ease-move`).
  - She winks at 200 ms (280 ms).
  - The count ticks at 300 ms (as in §2).
- **Nora's tile, hover**: the petals breathe (4 s, ±.02), and her eyes glance at the count.
- **Nora's tile, rest** (nothing runs): her eyes close and hover does nothing. An ask wakes her the same way as in H3 (wink, then 1.2 s awake).

## 4. Reduced motion

No movement. Every change still happens, instantly:
- **Orbit**: satellites sit evenly spaced at fixed angles (first at −35°) with no drift. Join, leave and dock swap in place.
- **Nora**: no wink and no tilt. Her eyes still close at rest.
- **Count**: changes with no slide and no pop.
- **Badges**: appear and disappear with no scale or fade. Dim applies at once.
- **H2**: no breathe, blink, glance, lift or petal step. Hover still swaps the 16 px mark for the face, because that's a state change, not motion.

## 5. Build notes
- **Nora's tile**: one `requestAnimationFrame` loop, SVG transforms only. The pill and badges use CSS / Web Animations. No layout properties animate.
- **Orbit angle**: accumulates as `base += dt × 10°/s` and freezes while hidden.
- **Re-spacing**: tween each satellite's angular offset along the shortest arc. Don't tween x/y, or it cuts across the ring.
- **H2 outlines**: generated per frame from polar functions (Iris: .86 + .09 sin(3t+φ) + .05 sin(5t+2φ); Nora: .8 + a cos(8(t+r))).
  Cache by parameters.
- **Faces**: H3 and H2 faces per member and state are in `avatars/h3/` and `avatars/h2/`. Nora's wink and rest variants are in the prototype (`NORA.wink`, `NORA.sleep`).
