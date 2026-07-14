# Design: Eval-expansion engine, round 1

Date: 2026-07-15
Status: round complete — see execution record; 6 reds pending gold
adjudication

The third GAE engine — the one entirely absent from this repo (case
study §3.3): cases generated adversarially from the model's prior of
"what's correct for a music player", not hand-written against known
behavior. Round 1 is the minimal closed loop: generate → adjudicate
against the current engine → lock greens as silver, escalate reds to
the human for gold sampling.

## Domains (three, chosen for judgeability)

| Domain | Modules | Oracle |
| --- | --- | --- |
| Play order & queue | `playorder.ts`, `queue.ts` | pure functions, direct assertion |
| Lyric clock | `lyrictime.ts` | pure functions, direct assertion |
| Crossfade engine | `playback.ts` via `playback.fakes.ts` | Step-1 replay infra: parameterized world + sampled invariants |

Crossfade is the flagship: its held-out oracle (the gold suite's
`advanceWorld` + I1/I2 invariants) is exactly what Step 1 was built
for. The two pure domains calibrate the protocol cheaply.

## Generation protocol (anti-collapse measures)

- One **blind generator per domain**, run in parallel. Each receives:
  the module's public contract (signatures + doc comments), the domain's
  invariants, and the user-preference anchors from PRODUCT.md — but
  NOT the implementation bodies and NOT the existing test files.
  Rationale: reading the implementation locks implementation details
  (the drift failure mode); reading existing tests collapses generation
  into variants of what's already covered (the mode-collapse failure
  mode).
- Each candidate must name its **derivation**: which invariant, user
  expectation, or real-world property it stresses. Underivable cases
  are discarded at adjudication.
- Generators are asked for *boundary* cases: empty/degenerate inputs,
  precedence collisions between features, clock-skew extremes, races
  the real world can produce.

## Adjudication (silver layer semantics)

1. Dedup against each other and against existing coverage (this is the
   one step that reads existing tests — after generation, never before).
2. Implement survivors as vitest cases in `*.silver.test.ts` files,
   marked with their derivation in a comment.
3. Run against the current engine:
   - **Green** → locked as silver. Append-only from here; may be
     revoked only by a human (gold supersedes silver unconditionally).
   - **Red** → classified: (a) the expectation is right and the engine
     is wrong → a found bug, escalated to the human as a surprisal
     candidate; (b) the expectation is wrong (generator drifted from
     the actual product intent) → discarded, with the drift noted in
     the round report.
4. Drift anchor: any candidate contradicting a gold case (the five
   incident replays, the shaky-BPM semantic chain) is discarded
   without debate — silver yields to gold unconditionally.

## Acceptance for round 1

- ≥ 3 domains generated, each ≥ 8 raw candidates.
- Every locked silver case carries a derivation comment.
- Full suite (existing 303 + new silver) green at commit time; reds
  are either fixed (with the fix in the same round, if the human
  confirms the bug) or documented as discards.
- Round report: generated / deduped / green / red-bug / red-drift
  counts — the expansion-rate numerator the case study's convergence
  metric needs.

## Non-goals

- No UI-driving tests (the blind spot criterion stays "replayable",
  not "via CLI" — case study §3.2).
- No generation for the glue layer beyond what the fakes can replay.
- No changes to gold cases: this round only ever appends silver.

## Execution record (2026-07-15)

Three blind generators (playorder 15 specs, lyric-clock 12, crossfade
12 — 39 raw). After dedup against existing coverage and drift
screening, 29 cases implemented across three silver files.

| Domain | Raw | Deduped/discarded | Implemented | Green | Red |
| --- | --- | --- | --- | --- | --- |
| playorder/queue | 15 | 6 dup, 1 drift | 8 files' worth (9 tests) | 9 | 2 (probed, not committed) |
| lyric-clock | 12 | 1 dup | 13 tests | 12 | 1 (probed, not committed) |
| crossfade | 12 | 4 not implemented (XF-2/7/8/10 — next round) | 8 tests | 5 | 3 (committed as it.skip) |

**Green silver locked: 26 tests** (`playorder.silver.test.ts`,
`lyrictime.silver.test.ts`, `playback.silver.test.ts`), each with its
derivation. Full suite 329 green + 3 skipped.

**Red findings escalated for gold adjudication (6):**

1. **XF-1 pause-mid-fade** — `togglePause()` reaches only the active
   (incoming) deck; the outgoing deck keeps sounding through the
   pause. User anchor violated: pause must freeze the mix as a unit.
2. **XF-5 fade > outgoing remainder** — the end window admits such
   plans and the outgoing deck's natural death mid-fade drops heard
   loudness by ~0.5 in one 50ms sub-step (audible cliff).
3. **XF-4 incoming shorter than the fade** — arming never checks the
   incoming duration; a short incoming dies mid-fade leaving ≥150ms
   dead air with `transitioning` stuck true until the wall-clock
   finalizer; B's "ended" leaks to the shell as `onEnded(null)`.
4. **PO-2b repeat-one skip at the order edge** — `nextId` returns null
   (stop) while `upcomingPreview` previews the same state as a wrap:
   the panel promises [1,2], the skip stops playback. Panel and
   transport disagree — one of them lies.
5. **PO-15b enqueueNext duplicate input batch** — `enqueueNext([],
   [3,3])` returns `[3,3]`, violating the queue's no-dup invariant
   from inside. Mitigating: current callers pass Set-derived ids.
6. **LC-9 out-of-order word timestamps** — a later word lights before
   an earlier one (monotonicity violation) on wild LRC input.
   Mitigating: core sorts LINES by time but never word arrays.

**Drift discards (1):** PO-6 expected a filtered-out currentId to
re-enter the visible list (forward from head, backward from tail);
the existing suite locks `null` (stop) as intended behavior — the
shell owns re-entry. Generator drifted from the layering choice.

**Not expressible in the harness (1):** XF-9's real-WebAudio failure
mode (`setValueCurveAtTime` with duration 0 throws RangeError) — the
fake's `valueAt` cannot sample a zero-length curve. Noted in the test;
green verdict is fake-world-only.

**Expansion-rate numerator (the case-study convergence metric):**
round 1 added 26 locked cases + 6 candidate constraints from ~0 bits
of human input (generation ran entirely from contracts + PRODUCT.md
anchors). The human's gold ruling on the 6 reds is the next
preference-bit injection.
