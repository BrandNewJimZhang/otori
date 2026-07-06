// Beat analysis: BPM + downbeat phase from an onset-energy envelope.
// Synthetic envelopes with known tempo prove the math before any real
// audio touches it.

import { describe, expect, it } from "vitest";
import { analyzeTempo, detectBeats, ENVELOPE_HZ } from "./beatgrid";

/** Synthesize an onset envelope: a spike every `period` seconds. */
function clicks(bpm: number, seconds: number, phase = 0, jitter = 0): Float32Array {
  const env = new Float32Array(Math.round(seconds * ENVELOPE_HZ));
  const period = 60 / bpm;
  for (let t = phase; t < seconds; t += period) {
    const j = jitter ? (Math.sin(t * 999) * jitter) : 0; // deterministic pseudo-jitter
    const idx = Math.round((t + j) * ENVELOPE_HZ);
    if (idx >= 0 && idx < env.length) env[idx] = 1;
  }
  return env;
}

describe("detectBeats", () => {
  it("finds the BPM of a clean click track", () => {
    const grid = detectBeats(clicks(128, 30));
    expect(grid).not.toBeNull();
    expect(grid!.bpm).toBeCloseTo(128, 0);
  });

  it("finds slow and fast tempos inside the DJ range", () => {
    expect(detectBeats(clicks(85, 30))!.bpm).toBeCloseTo(85, 0);
    expect(detectBeats(clicks(174, 30))!.bpm).toBeCloseTo(174, 0);
  });

  it("recovers the beat phase (first beat offset)", () => {
    const grid = detectBeats(clicks(120, 30, 0.25))!;
    // First beat should land at 0.25s modulo the beat period (0.5s).
    const period = 60 / grid.bpm;
    const phaseMod = grid.firstBeatSec % period;
    expect(Math.abs(phaseMod - 0.25)).toBeLessThan(0.06);
  });

  it("tolerates mild timing jitter", () => {
    const grid = detectBeats(clicks(140, 30, 0, 0.01));
    expect(grid).not.toBeNull();
    expect(Math.abs(grid!.bpm - 140)).toBeLessThan(3);
  });

  it("returns null for beatless material", () => {
    // Constant energy: no periodicity to lock onto.
    const flat = new Float32Array(30 * ENVELOPE_HZ).fill(0.5);
    expect(detectBeats(flat)).toBeNull();
    // Silence.
    expect(detectBeats(new Float32Array(30 * ENVELOPE_HZ))).toBeNull();
  });

  it("finds high-BPM Japanese electronic tempos without halving", () => {
    // J-core / rhythm-game boss tiers: the old 180 ceiling forced
    // these to fold to half tempo (founding-user report).
    // At 100Hz envelope resolution a 190+ BPM lag is ~30 samples, so
    // quantization costs ~1 BPM — fine for display and mixing.
    expect(Math.abs(detectBeats(clicks(190, 30))!.bpm - 190)).toBeLessThan(2);
    expect(Math.abs(detectBeats(clicks(200, 30))!.bpm - 200)).toBeLessThan(2);
    expect(Math.abs(detectBeats(clicks(222, 30))!.bpm - 222)).toBeLessThan(2);
  });

  it("reports high confidence for clean clicks", () => {
    const grid = detectBeats(clicks(128, 30))!;
    expect(grid.confidence).toBeGreaterThan(0.5);
    expect(grid.confidence).toBeLessThanOrEqual(1);
  });
});

/** Two tempo sections back to back (soflan). */
function soflan(bpmA: number, bpmB: number, secsEach: number): Float32Array {
  const a = clicks(bpmA, secsEach);
  const b = clicks(bpmB, secsEach);
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

describe("analyzeTempo", () => {
  it("steady track: single bpm, no range", () => {
    const r = analyzeTempo(clicks(128, 40))!;
    expect(r.bpm).toBeCloseTo(128, 0);
    expect(r.bpmMax).toBeNull();
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it("variable-tempo track: reports the min-max range", () => {
    const r = analyzeTempo(soflan(140, 178, 25))!;
    expect(r.bpmMax).not.toBeNull();
    // Windows straddling the tempo change blur the endpoints slightly;
    // ±2 BPM is fine for a range display.
    expect(Math.abs(r.bpm - 140)).toBeLessThan(2);
    expect(Math.abs(r.bpmMax! - 178)).toBeLessThan(2);
  });

  it("variable tempo carries reduced confidence", () => {
    const steady = analyzeTempo(clicks(140, 50))!;
    const varying = analyzeTempo(soflan(140, 178, 25))!;
    expect(varying.confidence).toBeLessThan(steady.confidence);
  });

  it("beatless material yields null", () => {
    expect(analyzeTempo(new Float32Array(40 * ENVELOPE_HZ).fill(0.5))).toBeNull();
  });

  it("short signals fall back to whole-signal detection", () => {
    // Too short to window, still long enough for one detect pass.
    const r = analyzeTempo(clicks(120, 10));
    expect(r).not.toBeNull();
    expect(r!.bpm).toBeCloseTo(120, 0);
  });

  it("a hint folds a half-tempo detection up to the anchored octave", () => {
    // Sparse kick pattern reads as 87; the wiki says 174 — the hint
    // re-folds the octave. Simulate with a 87 click + 174 hint.
    const r = analyzeTempo(clicks(87, 40), 174)!;
    expect(r.bpm).toBeCloseTo(174, 0);
    expect(r.hintApplied).toBe(true);
  });

  it("a hint folds a double-tempo detection down", () => {
    const r = analyzeTempo(clicks(174, 40), 87)!;
    expect(r.bpm).toBeCloseTo(87, 0);
    expect(r.hintApplied).toBe(true);
  });

  it("a hint that disagrees non-harmonically is ignored", () => {
    // Detection 128 vs hint 174: not an octave relation — the hint is
    // wrong or the song differs; keep the measurement, flag nothing.
    const r = analyzeTempo(clicks(128, 40), 174)!;
    expect(r.bpm).toBeCloseTo(128, 0);
    expect(r.hintApplied).toBe(false);
  });

  it("hint agreement within tolerance boosts confidence", () => {
    const plain = analyzeTempo(clicks(174, 40))!;
    const hinted = analyzeTempo(clicks(174, 40), 174)!;
    expect(hinted.confidence).toBeGreaterThanOrEqual(plain.confidence);
    expect(hinted.hintApplied).toBe(true);
  });
});
