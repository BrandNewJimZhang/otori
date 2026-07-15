# Design: Eval-expansion engine, round 2

Date: 2026-07-15
Status: closed — 29 silver locked, 0 confirmed reds; 3 red-candidates
gold-ruled (1 fixed, 1 kept, 1 won't-fix)

Protocol: identical to round 1 (docs/design/eval-expansion-round1.md)
— blind generation from contracts + PRODUCT.md anchors, adjudication
against the current engine, silver append-only. One refinement: reds
that are preference calls rather than clear bugs are recorded as
`RED-CANDIDATE` comments asserting the ACTUAL behavior (suite stays
green, finding preserved in place) instead of `it.skip` — the skip
idiom now means "confirmed bug, fix pending".

## Batch 1: crossfade — the four specs r1 left unimplemented

XF-2 (manual skip mid-fade), XF-7 (pause at the fade's terminal
sample), XF-8 (Infinity/NaN outgoing duration, two variants), XF-10
(arm while paused). **All five tests green on the current engine** —
the r1 fixes (pause-finalize, two-sided duration clamp) plus play()'s
existing cancelTransition path generalize to every one of them. Two
harness adaptations, neither weakening: A parked at 294 (not 297) so
the r1 clamp doesn't compress the plan and distort the specs' time
semantics; "no three audible sources" expressed as the structurally
stronger "exactly one audible + no residual automation".

## Batch 2: library view-logic — new domain, 16 blind specs

| Outcome | Count | Cases |
| --- | --- | --- |
| Green | 11 | LB-1/2/5/6/7/8/9/10/11/12/13 + LB-14b, LB-16c/d/e |
| Dup-skipped | 2 | LB-15 (scrollAnchorId), LB-14a/c, LB-16a/b/g |
| Red-candidate | 3 | LB-3, LB-4, LB-16f |

24 tests in `library.silver.test.ts`. The greens lock real behavior
the existing suite never pinned: NFKC folding in BOTH directions for
type-ahead, halfwidth-katakana composition in search, ghost-anchor
degradation, shift-shrink through the anchor, meta-toggle anchor
survival, input immutability under U+3000 queries.

**Red-candidates (preference calls for gold ruling):**

1. **LB-3 dangling qualifier** — `artist:` (mid-typing) parses as a
   literal term today, matching titles that contain "artist:".
   Recommendation: keep as-is (the mid-typing state self-corrects on
   the next keystroke; low stakes).
2. **LB-4 fullwidth colon** — `ａｒｔｉｓｔ：ryo` never enters the
   qualifier path (norm runs after the regex), yielding zero results.
   Recommendation: adopt the spec — IME users hit this; norm the raw
   term before the qualifier regex (one-line fix).
3. **LB-16f degenerate BPM range** — `bpm == bpm_max` would render
   "174–174". Upstream check: the analyzer's range branch requires
   `hi/lo > 1.05` (derive.rs STEADY_TOLERANCE), so it never emits a
   degenerate range — the branch is unreachable from real data.
   Recommendation: won't-fix (upstream invariant holds); the
   red-candidate comment documents the reliance.

## Convergence data — second data point

| Metric | Round 1 | Round 2 |
| --- | --- | --- |
| Raw specs generated | 39 | 20 (4 carried XF + 16 LB) |
| Locked silver tests | 26 | 29 |
| Confirmed real bugs | 6 | **0** |
| Preference calls | 0 | 3 |
| Human preference bits in | ~2 | ~1 (blanket approval of the three recommendations) |

The direction the case study predicts is visible after one feedback
cycle: r1's constraint feedback didn't just fix six bugs — it closed
the entire adjacent failure surface (all four r2 crossfade specs land
green on guards built for r1's reds). The finding mix shifted from
"engine violates its own invariants" to "the contract is ambiguous at
the edges" — the discriminator is now probing product intent, which
is exactly where the human's gold role lives.

## Gold ruling (2026-07-15)

The human approved all three recommendations in one pass:

| Case | Ruling | Action |
| --- | --- | --- |
| LB-3 dangling `artist:` | keep as-is | ruling recorded at the case; literal interpretation locked |
| LB-4 fullwidth colon | fix | `filterTracks` folds the raw term (NFKC) BEFORE the qualifier parse — `ａｒｔｉｓｔ：ryo` now qualifies; red-first, test flipped to the spec expectation |
| LB-16f degenerate range | won't-fix | unreachable upstream (derive.rs STEADY_TOLERANCE); the locked "174–174" rendering doubles as a tripwire if the tolerance ever loosens |

A protocol note the fix surfaced: folding before the parse also makes
the qualifier regex operate on lowercased input (the explicit /i and
per-branch toLowerCase became dead weight and were removed) — the
qualifier path and the needle path now share one normalization point,
which is the SSOT shape the r1 shaky-BPM fix established for
constants. Round 2 fully closed.
