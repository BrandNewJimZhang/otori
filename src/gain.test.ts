// Gain math for the playback engine: ReplayGain dB → linear factor,
// with a pre-amp headroom clamp. Pure math, tested; the engine applies
// the result to its GainNode.

import { describe, expect, it } from "vitest";
import { effectiveGain } from "./gain";

describe("effectiveGain", () => {
  it("converts dB to a linear factor (RG 89dB reference)", () => {
    expect(effectiveGain(0)).toBeCloseTo(1);
    expect(effectiveGain(-6.02)).toBeCloseTo(0.5, 2);
    expect(effectiveGain(6.02)).toBeCloseTo(2, 2);
  });

  it("null gain (no RG data) means unity — never guess a correction", () => {
    expect(effectiveGain(null)).toBe(1);
  });

  it("clamps extreme positive gains to the headroom ceiling", () => {
    // +60 dB would be a 1000x blast on a malformed tag.
    expect(effectiveGain(60)).toBeLessThanOrEqual(4);
  });

  it("scales by the user volume multiplicatively", () => {
    expect(effectiveGain(0, 0.5)).toBeCloseTo(0.5);
    expect(effectiveGain(-6.02, 0.5)).toBeCloseTo(0.25, 2);
  });
});
