# Design: Eval-expansion engine, round 1

Date: 2026-07-15
Status: executing (worktree `gae-eval-expansion-r1`)

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
