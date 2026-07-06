// Band energy extraction: the number that drives Stage's beat-reactive
// visuals. Pure math over FFT data, so the visual layer stays untested
// canvas/CSS and this stays provable.

import { describe, expect, it } from "vitest";
import { bandEnergy, Smoother } from "./energy";

function fft(values: Record<number, number>, size = 128): Float32Array {
  const data = new Float32Array(size).fill(-120);
  for (const [bin, db] of Object.entries(values)) data[Number(bin)] = db;
  return data;
}

describe("bandEnergy", () => {
  // binHz = 10: bin i covers ~i*10 Hz.
  it("normalizes the loudest bin in range from dbFloor..dbCeil to 0..1", () => {
    const data = fft({ 5: -40 }); // 50Hz, inside 30-150
    // -40 between floor -72 and ceil -8: (72-40)/64 = 0.5
    expect(bandEnergy(data, 10, 30, 150)).toBeCloseTo(0.5);
  });

  it("ignores bins outside the band", () => {
    const data = fft({ 2: -10, 50: -10 }); // 20Hz and 500Hz, both outside
    expect(bandEnergy(data, 10, 30, 150)).toBe(0);
  });

  it("clamps to 0 below the floor and 1 above the ceiling", () => {
    expect(bandEnergy(fft({ 5: -100 }), 10, 30, 150)).toBe(0);
    expect(bandEnergy(fft({ 5: 0 }), 10, 30, 150)).toBe(1);
  });

  it("empty or inverted band yields 0", () => {
    expect(bandEnergy(fft({}), 10, 30, 150)).toBe(0);
    expect(bandEnergy(fft({ 5: -10 }), 10, 150, 30)).toBe(0);
  });
});

describe("Smoother", () => {
  it("rises instantly and decays gradually (fast attack, slow release)", () => {
    const s = new Smoother(0.5);
    expect(s.push(1)).toBe(1); // attack: jump straight up
    const first = s.push(0); // release: decay toward 0
    expect(first).toBeCloseTo(0.5);
    const second = s.push(0);
    expect(second).toBeCloseTo(0.25);
    expect(second).toBeLessThan(first);
  });

  it("a louder value during decay retriggers instantly", () => {
    const s = new Smoother(0.5);
    s.push(1);
    s.push(0);
    expect(s.push(0.9)).toBe(0.9);
  });
});
