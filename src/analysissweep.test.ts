// Sweep pacing + ETA: the duty-cycle cap that keeps background analysis
// invisible next to playback, and the rolling-mean ETA for the status
// bar. Both pure so the rules are testable without the loop.

import { describe, expect, it } from "vitest";
import { computeEtaMs, paceDelayMs } from "./analysissweep";

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

describe("computeEtaMs", () => {
  it("returns null until the window has seeded", () => {
    expect(computeEtaMs([], 834)).toBeNull();
    expect(computeEtaMs([30000], 834)).toBeNull();
    expect(computeEtaMs([30000, 30000, 30000], 834)).toBeNull();
  });

  it("returns null when nothing remains", () => {
    expect(computeEtaMs([30000, 30000, 30000, 30000], 0)).toBeNull();
  });

  it("projects remaining × rolling mean once seeded", () => {
    const samples = [30000, 30000, 30000, 30000]; // 30s/track wall time
    expect(computeEtaMs(samples, 10)).toBe(300000);
  });

  it("uses only the trailing window, dropping stale samples", () => {
    // 8 samples of 30s then 2 of 1s — window keeps the last 8, but the
    // last 8 here are [30s×6, 1s×2] = mean (180000+2000)/8 = 22750.
    const samples = [
      ...Array(8).fill(30000),
      1000,
      1000,
    ];
    expect(computeEtaMs(samples, 4)).toBe(91000);
  });
});
