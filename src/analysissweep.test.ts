// Sweep pacing: the duty-cycle cap that keeps background analysis
// invisible next to playback, whatever the decode cost of the file.

import { describe, expect, it } from "vitest";
import { paceDelayMs } from "./analysissweep";

describe("paceDelayMs", () => {
  it("floors at the base pace for cheap tracks", () => {
    expect(paceDelayMs(50)).toBe(3000);
    expect(paceDelayMs(0)).toBe(3000);
  });

  it("scales the sleep to cap duty cycle for expensive decodes", () => {
    // 1s of work → 9s of sleep: ≤10% duty cycle.
    expect(paceDelayMs(1000)).toBe(9000);
  });

  it("keeps duty cycle at or under 10% past the floor boundary", () => {
    const work = 500;
    const delay = paceDelayMs(work);
    expect(work / (work + delay)).toBeLessThanOrEqual(0.1);
  });
});
