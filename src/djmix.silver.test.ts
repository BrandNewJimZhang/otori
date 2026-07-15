// SILVER layer — eval-expansion round 3 (protocol: docs/design/
// eval-expansion-round1.md). Cases generated adversarially from the
// transition-planning contract by a blind generator (no implementation,
// no existing tests in context), then adjudicated against the current
// engine. Each case carries its derivation. Silver semantics:
// append-only for the model; a human may revoke any case (gold wins).
//
// Round-3 adjudication semantics (round-2 refinement):
// - clear-bug reds keep the SPEC assertion under `it.skip` with a
//   "PENDING GOLD ADJUDICATION" note describing actual behavior;
// - preference-call reds assert ACTUAL behavior with a
//   "RED-CANDIDATE (gold ruling pending)" note carrying the spec's
//   preference.

import { describe, expect, it } from "vitest";
import { planTransition, type MixPoint } from "./djmix";

const point = (bpm: number, beatSec = 0): MixPoint => ({ bpm, beatSec });

describe("silver: degenerate BPM anchors (DJ-1..DJ-4)", () => {
  // Derivation: analysis anchors come from an external BPM detector;
  // a zero/NaN/negative bpm is corrupt data, and the planner's fold
  // loop (`while (ratio > 1.5) ratio /= 2; while (ratio < 0.66)
  // ratio *= 2`) has no guard against non-finite ratios.

  // Gold-adjudicated 2026-07-15, fixed by the positive-finite anchor
  // guard. Was: nontermination — outgoing bpm 0 gives ratio = 128/0 = Infinity;
  // Infinity / 2 === Infinity, so `while (ratio > 1.5)` never exits.
  // Verified by reading the source, not by running it.
  it("DJ-1: outgoing bpm 0 falls back to a plain finite fade", () => {
    const plan = planTransition(point(0), point(128), 8);
    expect(plan.kind).toBe("plain");
    expect(plan.durationSec).toBe(8);
    expect(Number.isFinite(plan.durationSec)).toBe(true);
  });

  // Gold-adjudicated 2026-07-15, fixed by the positive-finite anchor
  // guard. Was: nontermination — incoming bpm 0 gives ratio = 0/128 = 0;
  // 0 * 2 === 0, so `while (ratio < 0.66)` never exits.
  // Verified by reading the source, not by running it.
  it("DJ-2: incoming bpm 0 falls back to a plain finite fade", () => {
    const plan = planTransition(point(128), point(0), 8);
    expect(plan.kind).toBe("plain");
    expect(plan.durationSec).toBe(8);
    expect(Number.isFinite(plan.durationSec)).toBe(true);
  });

  // Gold-adjudicated 2026-07-15, fixed by the positive-finite anchor
  // guard. Was: NaN bpm
  // gives ratio = NaN; both fold-loop comparisons are false so the
  // loop exits, but |NaN - 1| > 0.08 is ALSO false, so the corrupt
  // pair is ACCEPTED as beatmatched: durationSec NaN (Math.max(1,
  // NaN) is NaN), rateTo NaN, rateFrom NaN, startOffsetSec NaN — a
  // fully NaN-poisoned plan handed to the playback engine. Spec
  // expects the corrupt anchor to be rejected to a plain fade.
  it("DJ-3: NaN bpm falls back to plain with no NaN anywhere", () => {
    const plan = planTransition(point(NaN), point(128), 8);
    expect(plan.kind).toBe("plain");
    expect(plan.durationSec).toBe(8);
    expect(Number.isNaN(plan.durationSec)).toBe(false);
  });

  // Gold-adjudicated 2026-07-15, fixed by the positive-finite anchor
  // guard. Was: nontermination — bpm -120 vs 120 gives ratio = -1 < 0.66; the
  // doubling loop drives it -2, -4, ... toward -Infinity, and
  // -Infinity * 2 === -Infinity stays < 0.66, so `while (ratio <
  // 0.66)` never exits. Verified by reading the source, not by
  // running it.
  it("DJ-4: negative bpm falls back to a plain finite fade", () => {
    const plan = planTransition(point(-120), point(120), 8);
    expect(plan.kind).toBe("plain");
    expect(plan.durationSec).toBe(8);
    expect(Number.isFinite(plan.durationSec)).toBe(true);
  });
});

describe("silver: tempo folding numerics (DJ-5, DJ-6)", () => {
  // Derivation: half/double pairing must not just pick the right
  // KIND (existing test covers 87/174 kind + outgoing rateTo) — the
  // bar quantization stays in the OUTGOING grid and the entry offset
  // stays in the INCOMING grid. Kind/rateTo parts of DJ-5 are dup of
  // the existing "half-tempo pairing" test and are not re-asserted
  // in isolation; duration/offset are new.
  it("DJ-5: 87 vs 174 folds up to unity rates with outgoing-bar duration and bar-2 entry", () => {
    // incoming beatSec = 4.8 beat periods of 174 → fractional beat 0.8.
    const plan = planTransition(point(87), point(174, (4.8 * 60) / 174), 11);
    expect(plan.kind).toBe("beatmatched");
    if (plan.kind !== "beatmatched") return;
    // Folded ratio 174/87 = 2 → 1: every rate is exactly 1.
    expect(plan.outgoing.rateFrom).toBe(1);
    expect(plan.outgoing.rateTo).toBe(1);
    expect(plan.incoming.rateFrom).toBe(1);
    expect(plan.incoming.rateTo).toBe(1);
    // 11s at 87 BPM → 11 / (240/87) = 3.99 → 4 bars of the OUTGOING grid.
    expect(plan.durationSec).toBeCloseTo(11.03448, 4);
    // Entry lands one incoming bar past the folded first beat:
    // offset ∈ [inBar, inBar + inPeriod) = [1.37931, 1.72414).
    const inPeriod = 60 / 174;
    const inBar = inPeriod * 4;
    expect(plan.incoming.startOffsetSec).toBeCloseTo(1.655172, 5);
    expect(plan.incoming.startOffsetSec).toBeGreaterThanOrEqual(inBar);
    expect(plan.incoming.startOffsetSec).toBeLessThan(inBar + inPeriod);
  });

  it("DJ-6: 170.5 vs 85 folds down with near-unity ramps and 11 outgoing bars", () => {
    // incoming beatSec = 2/17 s → fractional beat 2/17 of the 85 grid.
    const plan = planTransition(point(170.5), point(85, 2 / 17), 15);
    expect(plan.kind).toBe("beatmatched");
    if (plan.kind !== "beatmatched") return;
    // 85/170.5 = 0.49853 folds up to 0.9970674 (within the 8% window).
    expect(plan.outgoing.rateTo).toBeCloseTo(0.9970674, 6);
    expect(plan.incoming.rateFrom).toBeCloseTo(1.0029412, 6);
    // 15s at 170.5 BPM → 15 / 1.40762 = 10.66 → 11 bars.
    expect(plan.durationSec).toBeCloseTo(15.48387, 4);
    // Bar-2 entry on the incoming 85 grid: 2/17 + 240/85.
    expect(plan.incoming.startOffsetSec).toBeCloseTo(2.941176, 5);
  });
});

describe("silver: acceptance-window boundaries (DJ-7, DJ-8, DJ-9)", () => {
  // Derivation: the fold window (0.66, 1.5) and the ±8% stretch
  // ceiling are both strict comparisons — the generator probes the
  // exact boundary values and the float dust around them.
  it("DJ-7: exact fold boundaries 1.5 and 0.66 do not fold and reject to plain", () => {
    // 150/100 = 1.5 is NOT > 1.5 → no fold; |1.5-1| = 0.5 > 0.08 → plain.
    expect(planTransition(point(100), point(150), 8).kind).toBe("plain");
    // 66/100 = 0.66 is NOT < 0.66 → no fold; |0.66-1| = 0.34 → plain.
    expect(planTransition(point(100), point(66), 8).kind).toBe("plain");
  });

  // RED-CANDIDATE (gold ruling pending): 108/100 evaluates to 1.08
  // exactly, but |1.08 - 1| = 0.08000000000000007 in IEEE-754, which
  // is > 0.08 — the nominal +8% pair is rejected by float dust. The
  // spec prefers an epsilon-tolerant acceptance (a DJ WOULD mix
  // 108 over 100); the engine's strict `>` is defensible as "the
  // ceiling is exclusive". Asserting actual: plain.
  it("DJ-8: nominal +8% pair (100 vs 108) is rejected to plain by float dust", () => {
    const plan = planTransition(point(100), point(108), 8);
    expect(plan.kind).toBe("plain");
    expect(plan.durationSec).toBe(8);
  });

  // RED-CANDIDATE (gold ruling pending): acceptance is symmetric in
  // the LINEAR ratio (|0.92 - 1| = 0.0799999... passes) but the
  // incoming deck's starting rate is the RECIPROCAL, 1/0.92 =
  // 1.0869565 — above the 1.08 comfort ceiling the constant
  // documents. The spec prefers a log-domain (ratio and 1/ratio both
  // within window) acceptance test; the engine's linear window is
  // defensible since ±8% is itself a heuristic. Asserting actual.
  it("DJ-9: -8% pair is accepted although the incoming reciprocal rate exceeds +8%", () => {
    const plan = planTransition(point(100, 90), point(92, 5), 8);
    expect(plan.kind).toBe("beatmatched");
    if (plan.kind !== "beatmatched") return;
    expect(plan.outgoing.rateTo).toBeCloseTo(0.92, 10);
    expect(plan.incoming.rateFrom).toBeCloseTo(1.0869565, 6);
    expect(plan.incoming.rateFrom).toBeGreaterThan(1.08); // the tension
    // 8s at 100 BPM → round(8/2.4) = 3 bars → 7.2s.
    expect(plan.durationSec).toBeCloseTo(7.2, 10);
    expect(plan.incoming.startOffsetSec).toBeCloseTo(3.0434783, 6);
  });
});

describe("silver: requestedSec degeneracy (DJ-10, DJ-11)", () => {
  // Derivation: the advisory duration is quantized with Math.max(1,
  // Math.round(req/barSec)) on the beatmatched path but passed
  // through RAW on the plain path — the generator probes 0 and
  // negative requests on both paths.
  it("DJ-10: zero and negative requests floor at one bar when beatmatched", () => {
    const zero = planTransition(point(120), point(120), 0);
    expect(zero.kind).toBe("beatmatched");
    if (zero.kind !== "beatmatched") return;
    expect(zero.durationSec).toBe(2); // 1 bar of 120 BPM
    expect(zero.incoming.startOffsetSec).toBe(2); // beatSec 0 → bar 2 entry

    const negative = planTransition(point(120), point(120), -5);
    expect(negative.kind).toBe("beatmatched");
    if (negative.kind !== "beatmatched") return;
    expect(negative.durationSec).toBe(2); // max(1, round(-2.5)) = 1 bar
  });

  // RED-CANDIDATE (gold ruling pending): the plain path passes
  // requestedSec through unquantized, so a 0 request yields a
  // zero-duration plan — a divide-by-duration NaN hazard for any
  // executor that normalizes t = elapsed/durationSec. Defensible
  // because the shell never arms 0 (crossfadeSec 0 means MIX off),
  // so the hazard is unreachable today. Asserting actual: 0.
  it("DJ-11: plain path passes a zero request through as durationSec 0", () => {
    const plan = planTransition(null, point(128), 0);
    expect(plan.kind).toBe("plain");
    expect(plan.durationSec).toBe(0);
  });
});

describe("silver: anchor-second edge cases (DJ-12, DJ-13)", () => {
  // RED-CANDIDATE (gold ruling pending): a negative incoming beatSec
  // (anchor before track zero, e.g. from an analysis offset) hits
  // JS truncated `%`: -0.3 % 0.5 = -0.3, so startOffsetSec = -0.3 +
  // 2.0 = 1.7 — BELOW the incoming bar length 2.0, i.e. not the
  // documented "enter at bar 2" position (it is one beat early,
  // though still ≥ 0 and on the beat grid). The spec prefers a
  // Euclidean mod, which would give 0.2 + 2.0 = 2.2. Asserting
  // actual: 1.7.
  it("DJ-12: negative incoming beatSec enters one beat before bar 2", () => {
    const plan = planTransition(point(120), point(120, -0.3), 8);
    expect(plan.kind).toBe("beatmatched");
    if (plan.kind !== "beatmatched") return;
    expect(plan.incoming.startOffsetSec).toBeCloseTo(1.7, 10);
    const inBar = (60 / 120) * 4;
    expect(plan.incoming.startOffsetSec).toBeLessThan(inBar); // the tension
  });

  // Derivation: multi-octave pairing (30 vs 240 = three fold steps)
  // combined with a long request stresses the fold loop's step count
  // and the round-half-up of Math.round.
  it("DJ-13: 30 vs 240 triple-fold stays at unity and quantizes 300s to 38 bars", () => {
    const plan = planTransition(point(30), point(240, 0.15), 300);
    expect(plan.kind).toBe("beatmatched");
    if (plan.kind !== "beatmatched") return;
    // 240/30 = 8 folds 8 → 4 → 2 → 1: unity rates.
    expect(plan.outgoing.rateTo).toBe(1);
    expect(plan.incoming.rateFrom).toBe(1);
    // barSec = 8s; round(300/8) = round(37.5) = 38 (round half up) → 304s.
    expect(plan.durationSec).toBe(304);
    expect(plan.durationSec % 8).toBe(0);
    // (0.15 % 0.25) + 1.0 = 1.15, finite.
    expect(plan.incoming.startOffsetSec).toBeCloseTo(1.15, 10);
    expect(Number.isFinite(plan.incoming.startOffsetSec)).toBe(true);
  });
});

describe("silver: gain curve domain clamping (DJ-14)", () => {
  // Derivation: an executor with clock jitter can call the curves
  // slightly outside [0, 1]; the gains must clamp, not extrapolate
  // (cos past π/2 goes NEGATIVE — a phase-inverting gain). The
  // equal-power identity at t ∈ {0, 0.25, 0.5, 0.75, 1} is dup of
  // the existing "equal-power curve" test and is skipped here; only
  // the out-of-domain clamping is new.
  it("clamps t below 0 and above 1 to the endpoint gains", () => {
    const plan = planTransition(point(128), point(128), 8);
    expect(plan.gainOut(-0.5)).toBe(1);
    expect(plan.gainIn(-0.5)).toBe(0);
    expect(plan.gainOut(1.5)).toBeCloseTo(0, 10);
    expect(plan.gainIn(1.5)).toBe(1);
  });
});
