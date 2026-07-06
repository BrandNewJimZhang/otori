// Beat-matched transition planning: given the outgoing track's tail
// anchor and the incoming track's head anchor, compute the tempo ramps
// and gain curves a DJ would perform by hand.

import { describe, expect, it } from "vitest";
import { planTransition, type MixPoint } from "./djmix";

const point = (bpm: number, beatSec = 0): MixPoint => ({ bpm, beatSec });

describe("planTransition", () => {
  it("plans a beat-matched transition for compatible tempos", () => {
    const plan = planTransition(point(126), point(128), 8);
    expect(plan.kind).toBe("beatmatched");
    if (plan.kind !== "beatmatched") return;
    // Outgoing ramps from unity to the incoming tempo.
    expect(plan.outgoing.rateFrom).toBe(1);
    expect(plan.outgoing.rateTo).toBeCloseTo(128 / 126, 5);
    // Incoming starts at the outgoing tempo and lands on unity.
    expect(plan.incoming.rateFrom).toBeCloseTo(126 / 128, 5);
    expect(plan.incoming.rateTo).toBe(1);
  });

  it("aligns the incoming track to start on a downbeat", () => {
    const plan = planTransition(point(128), point(128, 0.37), 8);
    if (plan.kind !== "beatmatched") throw new Error("expected beatmatched");
    // Start offset must sit on the incoming grid: firstBeat + n*period.
    const period = 60 / 128;
    const offBeat = (plan.incoming.startOffsetSec - 0.37) % period;
    expect(Math.min(offBeat, period - offBeat)).toBeLessThan(1e-6);
  });

  it("quantizes the crossfade to whole bars of the outgoing track", () => {
    const plan = planTransition(point(120), point(122), 10);
    if (plan.kind !== "beatmatched") throw new Error("expected beatmatched");
    // 120 BPM → bar = 2s; 10s requested → 10/2 = 5 bars exactly.
    const barSec = (60 / 120) * 4;
    expect(plan.durationSec % barSec).toBeCloseTo(0, 6);
    expect(plan.durationSec).toBeGreaterThan(0);
  });

  it("falls back to plain crossfade when tempos are too far apart", () => {
    // 128 vs 174: no DJ pitch-bends 36%.
    const plan = planTransition(point(128), point(174), 8);
    expect(plan.kind).toBe("plain");
  });

  it("falls back to plain crossfade when either grid is missing", () => {
    expect(planTransition(null, point(128), 8).kind).toBe("plain");
    expect(planTransition(point(128), null, 8).kind).toBe("plain");
  });

  it("equal-power curve: gains cross at -3dB and sum to constant power", () => {
    const plan = planTransition(point(128), point(128), 8);
    const { gainOut, gainIn } = plan;
    expect(gainOut(0)).toBeCloseTo(1);
    expect(gainIn(0)).toBeCloseTo(0);
    expect(gainOut(1)).toBeCloseTo(0);
    expect(gainIn(1)).toBeCloseTo(1);
    for (const t of [0.25, 0.5, 0.75]) {
      expect(gainOut(t) ** 2 + gainIn(t) ** 2).toBeCloseTo(1, 5);
    }
  });

  it("half-tempo pairing folds the ratio (87 vs 174 mixes at 2:1)", () => {
    // Drum'n'bass over downtempo: DJs mix these at the folded ratio.
    const plan = planTransition(point(87), point(174), 8);
    expect(plan.kind).toBe("beatmatched");
    if (plan.kind !== "beatmatched") return;
    expect(plan.outgoing.rateTo).toBeCloseTo(174 / 2 / 87, 5);
  });
});
