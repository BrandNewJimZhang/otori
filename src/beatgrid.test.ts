// Beat analysis: BPM + downbeat phase from an onset-energy envelope.
// Synthetic envelopes with known tempo prove the math before any real
// audio touches it.

import { describe, expect, it } from "vitest";
import { detectBeats, ENVELOPE_HZ } from "./beatgrid";

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

  it("is honest about tempos outside the DJ range", () => {
    // 60 BPM pure clicks have no energy at any lag inside the 70-180
    // window — the honest answer is "no grid", never a made-up tempo.
    expect(detectBeats(clicks(60, 30))).toBeNull();
  });
});
