# Design: Eval-expansion engine, round 4

Date: 2026-07-15
Status: closed — 39 silver locked; 0 clear-bug reds; 8 red-candidates
gold-ruled (1 fix, 7 keep)

Protocol: as round 3 (blind generation → adjudication; `it.skip` =
confirmed-bug pending fix, `RED-CANDIDATE` comment = preference call
asserted at actual behavior). Three new domains the feedback loop had
never touched: play-next queue + np-state mirror (queue/npstate), stage
visuals math (gel/energy), UI surface (uikeys/statusline/format).

## Outcomes

| Domain | Raw | Dup | Green | Red (skip) | Red-candidate |
| --- | --- | --- | --- | --- | --- |
| queue+npstate | 14 | 5 full + 3 partial | 9 | 0 | 1 |
| stageviz | 14 | 2 full + 3 partial | 13 | 0 | 3 |
| uisurface | 14 | many partial (mature suite) | 17 tests | 0 | 4 |
| **Total** | **42** | | **39 locked** | **0** | **8** |

Suite: 455 green + 1 skipped (VW-9, pre-existing), tsc clean. Files:
`queue.silver.test.ts`, `stageviz.silver.test.ts`,
`uisurface.silver.test.ts`.

## Ambiguities the adjudicator resolved without gold

Generator-flagged ambiguities that turned out to have one defensible
answer once held against the implementation and its call sites —
resolved in place, recorded here so the resolution is auditable:

- QU-14 (npstate title-field tension): the filename fallback resolves
  it — a playing track's payload title is never null, so "null =
  nothing playing" holds. No contract hole.
- GE-4c (grayscale share threshold): the floor is 5%; 6.25% colorful
  qualifies. Locked green.
- GE-13a (Smoother equal-input boundary): `>=` — an input equal to the
  envelope holds it. Locked green.
- GE-10b/c (corrupt binHz): degrades to silence via the empty-band
  clamp; fail-fast would be wrong in a 60fps render loop where binHz
  derives from sampleRate/fftSize. Locked green.
- UK-1c (⌘⇧F): shift-insensitive chord match → focus-search. Locked
  green (no competing macOS system chord).
- UK-6k ("?" in Stage): show-shortcuts is app chrome, not a table
  action — reachable mid-performance like ⌘,. Locked green.
- UK-11c/d (ETA hour cliff): rounding precedes the branch — "~60m"
  cannot render; 59.6min → "~1h 0m". Locked green.
- UK-13f (ISO stamp): the parser is strictly SQLite-shaped; ISO is
  out-of-contract garbage → placeholder. Locked green as a
  single-input-format tripwire.

## Red-candidates (asserted at actual, pending gold)

**Corrupt-input passthroughs, unreachable from production data (r3
PU-2/DJ-11 class — recommend keep):**

1. **QU-13a negative duration** — `buildNpState(·, -3)` passes -3 to
   the mini panel; `Number.isFinite` gates only non-finite. The audio
   element never reports negative durations.
2. **GE-11a collapsed dB range** — a bin exactly at dbFloor==dbCeil is
   0/0=NaN and both clamps propagate it to the canvas. No caller
   passes custom bounds (defaults -72/-8 only).
3. **GE-14c/d corrupt Smoother release** — release>1 grows the
   envelope above max input (1→1.5→2.25); negative release emits a
   negative frame. Only call sites pass literal 0.88/0.82.
4. **UK-11f negative ETA** — formatEta(-60000) renders "~-1m". etaMs
   derives from a rolling mean of positive durations.
5. **UK-12i negative seconds** — formatTime(-5) renders "-1:-5".
   Durations/positions are non-negative from index and audio element.

**Contract-edge calls (genuine preference questions):**

6. **GE-8a zero-width band** — contract says [freqLo, freqHi) so
   lo==hi should read 0; the inclusive-rounding implementation reads
   the shared bin (0.8125). Unreachable (fixed literal bands), but the
   half-open contract and the implementation disagree at the
   boundary. Recommend: keep (document) or align rounding — low
   stakes either way.
7. **UK-4j SELECT → global** — a focused native `<select>`'s arrow
   keys would be stolen by select-step. No `<select>` in the app
   today (grep-verified); locked rendering doubles as the tripwire.
   Recommend: keep until a select ships.
8. **UK-2h Home/End on a focused slider** — the slider carve-out is
   arrows-only, so Home/End jump the table selection instead of the
   native slider min/max jump. REACHABLE today (player-bar sliders
   are focusable). Recommend: fix — extend the carve-out to Home/End;
   a keyboard user on the volume slider expects the native jump, and
   losing table-edge navigation while a slider is focused costs
   nothing (Tab away first).

## Gold ruling + constraint feedback (2026-07-15)

The human approved the recommended dispositions in one pass (~1
preference bit):

| Finding | Ruling | Disposition |
| --- | --- | --- |
| UK-2h slider Home/End steal | fix | slider carve-out extends to Home/End → native min/max jump; spec test flipped red-first, then green |
| QU-13a negative duration | keep | audio element never reports negative (r3 PU-2 class) |
| GE-11a collapsed dB NaN | keep | default parameter pair only, no custom-bound caller |
| GE-14c/d corrupt release | keep | literal 0.88/0.82 at both call sites |
| UK-11f negative ETA | keep | rolling mean of positive durations |
| UK-12i negative seconds | keep | index/audio element are non-negative |
| GE-8a zero-width band | keep | fixed literal bands; locked rendering documents the contract disagreement |
| UK-4j SELECT hole | keep | no `<select>` in the app; locked rendering doubles as the tripwire |

Rulings recorded at each case (`GOLD RULING 2026-07-15` comments).
Suite after feedback: 455 green + 1 skip (VW-9, pre-existing), tsc
clean. Round 4 fully closed. Cumulative human preference bits across
four rounds: ~5. Cumulative silver: 130 locked cases.

## Convergence data — fourth point

| Metric | r1 | r2 | r3 | r4 |
| --- | --- | --- | --- | --- |
| Raw specs | 39 | 20 | 42 | 42 |
| Locked silver | 26 | 29 | 36 | 39 |
| Clear-bug reds | 6 | 0 | 8 | **0** |
| Red-candidates | 0 | 3 | 6 | 8 |
| Human bits in | ~2 | ~1 | ~1 | ~1 |

r4 sharpens the r3 correction rather than reverting it: convergence is
per-surface, but not all unswept surfaces start at the same point on
the curve. r3's three domains were young math extracted during the
App.tsx decomposition (djmix/virtualwindow — weeks old); r4's queue,
uikeys, statusline and format all predate the retrofit and carry
audit-hardened regression suites (uikeys alone: three audit rounds).
The red rate tracks surface MATURITY, not sweep order: audited
surfaces yield preference calls and unreachable-corruption findings;
young math yields real fail-fast holes. Where r3's reds clustered at
"missing corrupt-input guards", r4's red-candidates are the same shape
one severity lower — corrupt inputs that CANNOT arrive from production
data. The boundary-discipline gap exists everywhere; whether it is a
bug depends on whether anything can reach it.

Protocol observation: dedup pressure is much higher against mature
suites (uisurface: over half the raw specs partially or fully
covered) — the generator's blind independence keeps it honest, but
against an audit-hardened surface the expansion engine's marginal
value narrows to exactly the edges the audits never enumerated
(chord-modifier combinations, truthiness-vs-null gates, degenerate
config). That narrowing IS the convergence signal, arriving via dedup
rate rather than red rate.
