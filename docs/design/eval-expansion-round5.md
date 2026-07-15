# Design: Eval-expansion engine, round 5

Date: 2026-07-15
Status: closed — 36 silver locked; 0 clear-bug reds; 3 red-candidates
gold-ruled (1 fix, 2 keep)

Protocol: as round 4 (blind generation → adjudication; `it.skip` =
confirmed-bug pending fix, `RED-CANDIDATE` comment = preference call
asserted at actual behavior). Three domains the feedback loop had never
touched: preference persistence (prefs/settings — the ONE surface where
corrupt input is production-reachable), analysis flow
(analysismodel/analysissweep), UI chrome (menus/toasts/mixpoints).

## Outcomes

| Domain | Raw | Dup | Green | Red (skip) | Red-candidate |
| --- | --- | --- | --- | --- | --- |
| prefsurface | 14 | 4 full + 3 partial | 13 | 0 | 2 |
| analysisflow | 14 | 6 full + 4 partial | 11 | 0 | 1 |
| uichrome | 14 | 6 full + 4 partial | 9 tests | 0 | 0 |
| **Total** | **42** | | **36 locked** | **0** | **3** |

Suite: r5 worktree total after this round: 36 new tests across
`prefsurface.silver.test.ts`, `analysisflow.silver.test.ts`,
`uichrome.silver.test.ts`; all green, tsc clean.

## Ambiguities the adjudicator resolved without gold

- PR-7 (out-of-range volume: clamp vs whole-blob reject): the existing
  suite already locks whole-blob rejection for the v1 field set
  (volume/sort/shuffle/repeat/theme validate as a unit); later-arrival
  fields degrade individually. The asymmetry is the documented v1/v2
  seam, recorded in the silver file header. Locked green.
- PR-8 (negative crossfade: clamp vs default): both land on 0 —
  mechanism indistinguishable, value locked.
- PR-10/11 (mixed-validity collections: filter item-wise vs degrade
  whole field): Array.every gates degrade the WHOLE array/map. The
  safe direction (nothing hidden that shouldn't be; auto layout) and
  the field never poisons the rest. Locked green at actual.
- AF-11 (tight 9·w vs conservative 10·w stretch): the existing test
  locks 1000→9000, so the stretch is the tight bound; crossover at
  w = 1000/3. Locked green at 333/334.
- AF-8 (download-start toast): contract names only the failure toast;
  the "Downloading …" announcement before the fetch is actual behavior
  and matches the product anchor. Locked green.
- AF-9 (availability filter in nextModelId): cycling lands on
  unavailable models — that IS the download-on-demand entry point.
  Locked green.
- UC-4 (partial-overlap queueAdd payload): full id list — enqueueNext
  self-dedups downstream; the menu doesn't pre-filter. Locked green.
- UC-13 ("this once" vs "at most once" on rejection): the inflight map
  never evicts, so a rejection is cached forever; "at most once per
  track" is the documented reading. Locked green with a repeat-call
  probe.

## Red-candidates (asserted at actual, pending gold)

1. **PR-13f slider fractional passthrough** — `crossfadeFromSlider(1.5)`
   returns 1.5, inside the inaudible band the doc comment promises to
   close ("rounds 1 up to the 2s floor so a tiny fade can't produce an
   inaudible half-crossfade" — but only the exact value 1 is mapped).
   Reachability: both production sliders step by 1, so a fractional
   needs a programmatic dispatch or a future finer step. The comment
   and the implementation disagree about the (0,2) interval.
   Recommend: fix cheaply (floor the whole open interval) or reword
   the comment — low stakes; the comment's promise is the better
   contract.
2. **PR-14a out-of-range slider passthrough** — 17 and -1 pass through
   unclamped. Reachability: range inputs are min/max-bounded, so
   out-of-range needs programmatic dispatch; loadPrefs's 0..30 gate
   catches -1 on the next launch but keeps 17. Same class as r4's
   unreachable-corruption findings. Recommend: keep.
3. **AF-10a single-model registry cycles to itself** — `nextModelId`
   returns the active id when the registry has one entry; the contract
   says null = "nothing to cycle to". Harmless today:
   performModelSelect's already-active guard eats the no-op select.
   Recommend: keep (locked rendering doubles as the tripwire) or the
   one-line `models.length < 2` guard — preference call.

## Gold ruling + constraint feedback (2026-07-15)

The human approved the recommended dispositions in one pass (~1
preference bit):

| Finding | Ruling | Disposition |
| --- | --- | --- |
| PR-13f slider fractional passthrough | fix | the whole (0,2) interval rounds up to the 2s floor — the comment's promise is the contract; spec test flipped red-first, then green |
| PR-14a out-of-range slider passthrough | keep | range inputs are min/max-bounded; loadPrefs gates persisted values |
| AF-10a single-model registry self-cycle | keep | already-active guard eats the no-op; locked rendering is the tripwire |

Rulings recorded at each case. Suite after feedback: 495 green + 1
skip (VW-9, pre-existing), tsc clean. Round 5 fully closed. Cumulative
human preference bits across five rounds: ~6. Cumulative silver: 166
locked cases.

## Convergence data — fifth point

| Metric | r1 | r2 | r3 | r4 | r5 |
| --- | --- | --- | --- | --- | --- |
| Raw specs | 39 | 20 | 42 | 42 | 42 |
| Locked silver | 26 | 29 | 36 | 39 | 36 |
| Clear-bug reds | 6 | 0 | 8 | 0 | **0** |
| Red-candidates | 0 | 3 | 6 | 8 | **3** |
| Human bits in | ~2 | ~1 | ~1 | ~1 | ~1 |

r5 is the second consecutive zero-clear-bug round, and the first where
even the red-candidate count FELL on unswept ground (8 → 3). The r4
maturity reading holds and sharpens: all three r5 domains predate the
retrofit and carry hand-written suites; the expansion engine's yield
narrowed to (a) contract-vs-implementation wording gaps (PR-13f: the
comment promises a floor the code doesn't implement), (b)
unreachable-corruption passthroughs (PR-14a, same class as r4's), and
(c) a contract-letter deviation with a guard downstream (AF-10a).
Notably the prefs domain — the one surface where corrupt input IS
production-reachable — produced zero clear bugs: its corrupt-input
discipline was audit-hardened from birth (the P1 audit finding that
created it). The boundary-discipline gap the case study predicts for
unswept ground is real but its severity is gated by reachability, and
reachable surfaces got hardened first by ordinary audit pressure.

Protocol observation: the adjudicator resolved 8 generator ambiguities
without gold this round (vs 8 in r4) — but three of them (PR-7's
v1/v2 seam, PR-10/11's whole-field degradation, UC-13's cached
rejection) required reading the implementation's POLICY, not just its
output: the resolution documents a design decision that lived only in
code. The silver layer is accreting the missing prose contract as a
side effect of adjudication — each resolved ambiguity is a sentence
the module header never wrote down.
