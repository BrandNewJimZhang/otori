// SILVER layer — eval-expansion round 4 (protocol: docs/design/
// eval-expansion-round1.md). Stage-visuals math domain: gel lighting
// (gelHues/gelColor) and FFT band energy (bandEnergy/Smoother). Cases
// generated adversarially from the module contracts by a blind
// generator (no implementation, no existing tests in context), then
// adjudicated against the current implementations. Each case carries
// its derivation. Silver semantics: append-only for the model; a human
// may revoke any case (gold wins).
//
// Dedup record (exactly-covered assertions skipped, not re-asserted):
// - GE-1 (single-hue → analogous +30 top) is gel.test "single-hue
//   cover" — dup, skipped.
// - GE-3 (second hue inside the 45° exclusion) is gel.test "hues
//   closer than the separation floor collapse" — dup, skipped.
// - GE-6 (partial): gelColor(390)/(-30) normalization is gel.test
//   "normalizes hue into 0..360"; only fractional and -0 below.
// - GE-7 (partial): beyond-boundary clamps (-100 → 0, 0 dB → 1) are
//   energy.test "clamps to 0 below the floor and 1 above the ceiling";
//   only the exact-at-boundary legs implemented below.
// - GE-12/13 (partial): plain attack/decay/retrigger with release 0.5
//   is energy.test "rises instantly and decays gradually" +
//   "retriggers instantly"; the exact geometric 3-step trace, the
//   equal-input boundary, and negative inputs are new below.

import { describe, expect, it } from "vitest";
import { gelColor, gelHues } from "./gel";
import { bandEnergy, Smoother } from "./energy";

/** RGBA buffer from [r, g, b, alpha, count] runs. */
function pixels(...runs: [number, number, number, number, number][]): Uint8ClampedArray {
  const total = runs.reduce((n, run) => n + run[4], 0);
  const buf = new Uint8ClampedArray(total * 4);
  let i = 0;
  for (const [r, g, b, a, count] of runs) {
    for (let k = 0; k < count; k++) {
      buf[i++] = r;
      buf[i++] = g;
      buf[i++] = b;
      buf[i++] = a;
    }
  }
  return buf;
}

function fft(values: Record<number, number>, size = 128): Float32Array {
  const data = new Float32Array(size).fill(-120);
  for (const [bin, db] of Object.entries(values)) data[Number(bin)] = db;
  return data;
}

describe("silver: gelHues two-gel and seam behavior (GE-2/5)", () => {
  // Derivation: "dominant hue lights the floor; the strongest
  // sufficiently-distinct hue lights the top" — red/cyan is the
  // maximally separated pair, the clean two-gel happy path.
  it("red-dominant + cyan cover yields two distinct gels at 0° and 180°", () => {
    const [floor, top] = gelHues(pixels([255, 0, 0, 255, 5], [0, 255, 255, 255, 3]))!;
    expect(floor).toBeCloseTo(0, 0);
    expect(top).toBeCloseTo(180, 0);
  });

  // Derivation: hues straddling 0°/360° must read as red (circular
  // mean, not ≈180 linear), the adjacent bin must fail separation by
  // CIRCULAR distance (~10°, not ~345°), and the +30 analogous top
  // must wrap back into [0, 360).
  it("seam-straddling reds: circular floor, wrapped analogous top", () => {
    const [floor, top] = gelHues(pixels([255, 0, 21, 255, 5], [255, 21, 0, 255, 3]))!;
    expect(floor).toBeCloseTo(355, 0);
    expect(top).toBeCloseTo(25, 0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(360);
  });
});

describe("silver: gelHues qualification gates (GE-4)", () => {
  // Derivation: alpha < 50% is "not part of the art" — a fully
  // transparent buffer has zero usable pixels, house gels stay.
  it("an all-transparent cover has no gel", () => {
    expect(gelHues(pixels([255, 0, 0, 64, 4]))).toBeNull();
  });

  // Derivation: the "effectively grayscale" share gate — 1 saturated
  // pixel in 16 (6.25%) sits just above the 5% floor and must count.
  // Resolves the generator's flagged ambiguity: the threshold is 5%.
  it("a colorful share just above the floor still picks gels", () => {
    const [floor, top] = gelHues(pixels([255, 0, 0, 255, 1], [128, 128, 128, 255, 15]))!;
    expect(floor).toBeCloseTo(0, 0);
    expect(top).toBeCloseTo(30, 0);
  });
});

describe("silver: gelColor edge rendering (GE-6)", () => {
  // Derivation: invariant — any finite hue renders valid CSS with the
  // hue in [0, 360); -0 must not emit a "-0" token.
  it("rounds fractional hues and normalizes -0", () => {
    expect(gelColor(22.5)).toBe("hsl(23 85% 68%)");
    expect(gelColor(-0)).toBe("hsl(0 85% 68%)");
  });
});

describe("silver: bandEnergy exact boundaries (GE-7)", () => {
  // Derivation: "normalized to 0..1 between dbFloor and dbCeil" — the
  // endpoints themselves must map to exactly 0 and 1, not near-misses.
  it("maps a bin exactly at dbFloor to 0 and exactly at dbCeil to 1", () => {
    expect(bandEnergy(fft({ 0: -72 }), 10, 0, 40)).toBe(0);
    expect(bandEnergy(fft({ 0: -8 }), 10, 0, 40)).toBe(1);
  });
});

describe("silver: bandEnergy corrupt geometry (GE-8/9/10)", () => {
  // Derivation: a band entirely beyond the FFT data selects no bins —
  // silence, not NaN from an empty max.
  it("a band beyond the data length reads 0", () => {
    expect(bandEnergy(fft({ 0: -20, 3: -20 }, 4), 10, 1000, 2000)).toBe(0);
  });

  // Derivation: NaN dB values CAN occur in a Float32Array; the loudest
  // REAL bin must win and NaN must never propagate to the render path.
  it("NaN bins are skipped, the loudest real bin wins", () => {
    const data = fft({ 0: -40, 1: NaN, 2: -50, 3: -60 }, 4);
    expect(bandEnergy(data, 10, 0, 40)).toBeCloseTo(0.5);
  });

  it("an all--Infinity (silent) band reads 0", () => {
    const data = new Float32Array(4).fill(-Infinity);
    expect(bandEnergy(data, 10, 0, 40)).toBe(0);
  });

  // Derivation: corrupt binHz (0, negative) makes the bin indices
  // NaN/negative — no bins resolve, and the clamp holds at 0. The
  // degradation is silence, never NaN reaching the canvas; fail-fast
  // would be wrong here (60fps render loop, binHz is derived from
  // sampleRate/fftSize and cannot corrupt without a code bug).
  it("zero or negative binHz degrades to silence, not NaN", () => {
    const data = fft({ 0: -20, 3: -20 }, 4);
    expect(bandEnergy(data, 0, 0, 40)).toBe(0);
    expect(bandEnergy(data, -10, 0, 40)).toBe(0);
  });

  // GOLD RULING 2026-07-15: keep as-is (both production call sites
  // pass fixed literal bands, a zero-width band cannot occur; the
  // locked rendering documents the contract/implementation boundary
  // disagreement). Was flagged: the contract's band is half-open
  // [freqLo, freqHi), so freqLo == freqHi selects nothing and should
  // read 0. The implementation rounds both edges to bin indices and
  // loops inclusively, so a zero-width band at 20Hz reads bin 2 and
  // returns 0.8125.
  it("a zero-width band reads the shared bin (contract says 0 — flagged)", () => {
    const data = new Float32Array(4).fill(-20);
    expect(bandEnergy(data, 10, 20, 20)).toBeCloseTo(0.8125);
  });
});

describe("silver: bandEnergy degenerate dB range (GE-11)", () => {
  // Derivation: dbFloor == dbCeil turns the normalization into x/0 —
  // ±Infinity clamps correctly on either side of the threshold.
  it("clamps above and below a collapsed dbFloor==dbCeil threshold", () => {
    expect(bandEnergy(fft({ 0: -30 }), 10, 0, 40, -40, -40)).toBe(1);
    expect(bandEnergy(fft({ 0: -50 }), 10, 0, 40, -40, -40)).toBe(0);
  });

  // GOLD RULING 2026-07-15: keep as-is (the dB range is a default
  // parameter pair (-72, -8); no caller passes custom bounds, so
  // dbFloor == dbCeil requires a code change to occur — same ruling
  // as r3 DJ-11). Was flagged: a bin EXACTLY at the collapsed threshold
  // is 0/0 = NaN, and both clamps pass NaN through (Math.min/max
  // propagate it) — a NaN would reach the canvas.
  it("NaN at an exactly-collapsed threshold (clamp forbids — flagged)", () => {
    expect(bandEnergy(fft({ 0: -40 }), 10, 0, 40, -40, -40)).toBeNaN();
  });
});

describe("silver: Smoother envelope trace (GE-12/13)", () => {
  // Derivation: "rises instantly on a hit, decays by `release` per
  // frame" — the exact geometric sequence is the contract's shape,
  // and re-attack triggers the moment input exceeds the envelope.
  it("attacks from rest, decays geometrically, re-attacks over the tail", () => {
    const s = new Smoother(0.9);
    expect(s.push(0.2)).toBe(0.2);
    expect(s.push(1.0)).toBe(1.0);
    expect(s.push(0)).toBeCloseTo(0.9);
    expect(s.push(0)).toBeCloseTo(0.81);
    expect(s.push(0)).toBeCloseTo(0.729);
    expect(s.push(0.95)).toBe(0.95);
  });

  // Derivation: the >= attack boundary — an input EQUAL to the
  // envelope holds it (no decay step). Resolves the generator's
  // flagged ambiguity toward the hold reading.
  it("an input equal to the envelope holds it, not decays it", () => {
    const s = new Smoother(0.5);
    s.push(1.0);
    expect(s.push(1.0)).toBe(1.0);
  });

  // Derivation: a negative input is below the envelope, so the decay
  // path rules — the raw negative must never surface mid-afterglow.
  it("negative inputs during afterglow decay normally", () => {
    const s = new Smoother(0.5);
    s.push(1.0);
    expect(s.push(-1)).toBeCloseTo(0.5);
    expect(s.push(-1)).toBeCloseTo(0.25);
  });
});

describe("silver: Smoother degenerate release configs (GE-14)", () => {
  // Derivation: release 0 = one-frame envelope death; release 1 = an
  // infinite hold. Both are monotone and never exceed the max input.
  it("release 0 drops in one frame; release 1 never decays", () => {
    const dead = new Smoother(0);
    dead.push(1.0);
    expect(dead.push(0)).toBe(0);
    const hold = new Smoother(1);
    hold.push(1.0);
    expect(hold.push(0)).toBe(1);
    expect(hold.push(0)).toBe(1);
  });

  // GOLD RULING 2026-07-15: keep as-is (the only two constructor call
  // sites pass literal 0.88/0.82; a corrupt release requires a code
  // change — same ruling as GE-11a). Was flagged: release > 1 GROWS
  // the envelope above the max input seen (1 → 1.5 → 2.25), and a
  // negative release emits a negative frame (1 → -0.5) — both violate
  // the envelope invariant outright.
  it("corrupt release configs leak through the envelope (flagged)", () => {
    const grow = new Smoother(1.5);
    grow.push(1.0);
    expect(grow.push(0)).toBeCloseTo(1.5);
    expect(grow.push(0)).toBeCloseTo(2.25);
    const flip = new Smoother(-0.5);
    flip.push(1.0);
    expect(flip.push(0)).toBeCloseTo(-0.5);
  });
});
