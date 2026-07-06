// Gel extraction: the cover art picks the stage's lighting colors.
// Pure math over RGBA pixel data, same testing seam as energy.ts —
// the canvas reader in gel.ts stays a thin untested consumer.

import { describe, expect, it } from "vitest";
import { gelColor, gelHues } from "./gel";

/** RGBA buffer from [r, g, b, count] runs. */
function pixels(...runs: [number, number, number, number][]): Uint8ClampedArray {
  const total = runs.reduce((n, run) => n + run[3], 0);
  const buf = new Uint8ClampedArray(total * 4);
  let i = 0;
  for (const [r, g, b, count] of runs) {
    for (let k = 0; k < count; k++) {
      buf[i++] = r;
      buf[i++] = g;
      buf[i++] = b;
      buf[i++] = 255;
    }
  }
  return buf;
}

describe("gelHues", () => {
  it("single-hue cover: that hue on the floor, analogous shift up top", () => {
    const result = gelHues(pixels([255, 0, 0, 100]));
    expect(result).not.toBeNull();
    const [floor, top] = result!;
    expect(floor).toBeCloseTo(0, 0);
    expect(top).toBeCloseTo(30, 0);
  });

  it("two distinct hue regions: dominant on the floor, second up top", () => {
    const [floor, top] = gelHues(pixels([0, 0, 255, 70], [255, 160, 0, 30]))!;
    expect(floor).toBeCloseTo(240, 0);
    expect(top).toBeGreaterThan(20);
    expect(top).toBeLessThan(50);
  });

  it("hues closer than the separation floor collapse into one gel family", () => {
    // Red 0° + red-orange 20°: too close for a second gel, analogous instead.
    const [floor, top] = gelHues(pixels([255, 0, 0, 60], [255, 85, 0, 40]))!;
    expect(floor).toBeCloseTo(0, 0);
    expect(top).toBeCloseTo(30, 0);
  });

  it("separation is circular across the 0° seam", () => {
    // 350° + 20° are 30° apart around the wheel, not 330°.
    const [, top] = gelHues(pixels([255, 0, 42, 60], [255, 85, 0, 40]))!;
    expect(top).toBeGreaterThan(10);
    expect(top).toBeLessThan(45); // analogous of ~350, wrapped — not ~20 kept as-is
  });

  it("ignores near-white and near-black pixels around a saturated subject", () => {
    const result = gelHues(pixels([255, 255, 255, 60], [10, 10, 10, 30], [0, 128, 255, 10]));
    expect(result).not.toBeNull();
    expect(result![0]).toBeCloseTo(210, 0);
  });

  it("grayscale or near-empty covers have no gel", () => {
    expect(gelHues(pixels([128, 128, 128, 100]))).toBeNull();
    expect(gelHues(pixels([255, 255, 255, 50], [0, 0, 0, 50]))).toBeNull();
    expect(gelHues(new Uint8ClampedArray(0))).toBeNull();
  });

  it("a tiny saturated region below the qualified floor does not count", () => {
    // 2% saturated: statistically noise, keep the house gels.
    expect(gelHues(pixels([200, 200, 200, 98], [255, 0, 0, 2]))).toBeNull();
  });
});

describe("gelColor", () => {
  it("renders a hue as a stage-friendly hsl color", () => {
    expect(gelColor(210)).toBe("hsl(210 85% 68%)");
  });

  it("normalizes hue into 0..360", () => {
    expect(gelColor(390)).toBe("hsl(30 85% 68%)");
    expect(gelColor(-30)).toBe("hsl(330 85% 68%)");
  });
});
