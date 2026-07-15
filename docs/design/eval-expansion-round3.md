# Design: Eval-expansion engine, round 3

Date: 2026-07-15
Status: closed — 36 silver locked; 8 clear-bug reds pending gold
adjudication; 6 red-candidates pending gold ruling

Protocol: as round 2 (blind generation → adjudication; `it.skip` =
confirmed-bug pending fix, `RED-CANDIDATE` comment = preference call
asserted at actual behavior). Three new domains, all pure: transition
planning (djmix), row virtualization (virtualwindow), player-surface
utilities (seekbar/gain/lyricfollow/vizidle).

## Outcomes

| Domain | Raw | Dup | Green | Red (skip) | Red-candidate |
| --- | --- | --- | --- | --- | --- |
| djmix | 14 | 2 partial | 6 | 4 | 4 |
| virtualwindow | 14 | 3 | 17 tests | 3 | 0 |
| player-utils | 14 | 4 full + 3 partial | 7 | 1 | 2 |
| **Total** | **42** | | **36 locked** | **8** | **6** |

Suite: 401 green + 8 skipped (7 this round + 1 pre-existing), tsc
clean.

## Clear-bug reds (it.skip, pending gold)

**Cluster 1 — the fold loop has no corrupt-input guard (djmix, one
root cause, four cases):**
- DJ-1/2/4: bpm 0, Infinity, or negative on either anchor makes
  `foldedRatio`'s while loop diverge — planTransition NEVER RETURNS
  (verified by source reasoning, not run: Infinity/2===Infinity,
  0*2===0, negative diverges to -Infinity). A corrupt analysis row
  would hang the UI thread mid-crossfade-arming.
- DJ-3: NaN bpm is worse — both loop conditions and the ±8% rejection
  are false for NaN, so the plan is ACCEPTED as beatmatched with NaN
  duration/rates/offset handed to the engine. Fail-fast violation:
  corrupt data mapped to a "normal" plan.
- Fix shape: one positive-finite guard on both anchors before folding
  → plain fade. Reachability: requires a corrupt index row (Rust side
  validates BPM output, but hint-derived and hand-edited paths exist).

**Cluster 2 — rowWindow counts aligned rows, not intersected rows
(virtualwindow, one root cause, two trigger surfaces):**
- VW-1: fractional scrollTop (99.5) leaves the last intersected row
  unrendered — a visible gap. VW-5: viewport smaller than one row,
  same gap. Root cause: `visibleCount = ceil(viewport/rowHeight)`
  undercounts by one when the window straddles a row boundary.
- Production masks it: LibraryTable passes overscan 8, so the gap has
  never shipped visibly. The invariant is still broken at the
  contract level; trackpad subpixel scrolling hits fractional
  scrollTop constantly.
- VW-9: `revealOffset` ping-pongs (200↔202, trace in the test) when
  usable height < rowHeight — the reveal→apply→ask-again cycle never
  reaches null. Unreachable at production sizes (headroom 34,
  viewport ≥ 300) but a contract-level nontermination.

**Cluster 3 — NaN passes the null gate (gain):**
- PU-9: `effectiveGain(NaN, v)` → NaN (NaN == null is false; Math.min
  doesn't stop NaN) → a NaN reaches the GainNode (silence or
  full-scale garbage). Low reachability: replaygain_db is number|null
  from the Rust index.

## Red-candidates (asserted at actual, pending gold)

1. **DJ-8 float dust at the +8% boundary** — 108 vs 100 BPM rejects
   to plain because |1.08−1| = 0.08000000000000007 > 0.08. Defensible
   as an open-interval ceiling; spec prefers epsilon tolerance.
2. **DJ-9 reciprocal rate overflow** — ratio 0.92 accepted but the
   incoming deck starts at 1/0.92 ≈ 1.087, past the ±8% comfort
   ceiling. Spec prefers log-domain symmetric acceptance.
3. **DJ-11 plain zero-duration passthrough** — null anchor +
   requestedSec 0 → durationSec 0 plan (NaN hazard at execution).
   Unreachable today: crossfadeSec 0 means MIX off, shell never arms.
4. **DJ-12 truncated mod on negative beatSec** — bar-2 entry lands a
   beat early (1.7 < barLength 2.0) for beat grids extrapolated
   backward past zero. Spec prefers Euclidean mod.
5. **PU-2 negative duration passes seekMax** — corrupt metadata could
   render a max<min range control. Spec prefers 0 (dead slider).
6. **PU-11 clock skew freezes shouldFollow** — elapsed < 0 suppresses
   following until the wall clock catches up. Note: shouldFollow has
   NO production call site right now (Stage integration pending);
   with performance.now() as the clock the skew is unreachable.

## Convergence data — third point

| Metric | r1 | r2 | r3 |
| --- | --- | --- | --- |
| Raw specs | 39 | 20 | 42 |
| Locked silver | 26 | 29 | 36 |
| Clear-bug reds | 6 | 0 | 8 |
| Red-candidates | 0 | 3 | 6 |
| Human bits in | ~2 | ~1 | pending |

The r2 "reds dropped to zero" point does NOT extrapolate: r3 swept
three domains the feedback loop had never touched and the red rate
jumped back up. The convergence claim is per-surface, not global —
each new domain starts at its own point on the curve. Notably the r3
reds cluster in exactly the shape the case study predicts for
unswept ground: missing corrupt-input guards (fail-fast holes), not
logic errors — the product logic was right everywhere the happy path
runs; what's missing is the discipline at the data boundary.

One protocol observation: the two "hang" clusters were adjudicated by
source reasoning without executing the nonterminating inputs — the
discriminator can classify reds it cannot safely run. This is a
capability the replay-infra oracle doesn't have; it belongs to the
adjudicator layer.
