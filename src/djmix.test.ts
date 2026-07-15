// Beat-matched transition planning: given the outgoing track's tail
// anchor and the incoming track's head anchor, compute the tempo ramps
// and gain curves a DJ would perform by hand.

import { describe, expect, it } from "vitest";
import { alignEntry, MAX_RATE_STRETCH, planTransition, type MixPoint } from "./djmix";

const point = (bpm: number, beatSec = 0): MixPoint => ({ bpm, beatSec });

const mod = (a: number, m: number) => ((a % m) + m) % m;

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

  it("accepts pairs up to ±12% (modern controller pitch range)", () => {
    // 100 vs 108 (8%) and 100 vs 111 (11%) both mixable now.
    expect(planTransition(point(100), point(108), 8).kind).toBe("beatmatched");
    expect(planTransition(point(100), point(111), 8).kind).toBe("beatmatched");
    // 100 vs 113 (13%) is past the stretch ceiling.
    expect(planTransition(point(100), point(113), 8).kind).toBe("plain");
    expect(MAX_RATE_STRETCH).toBeCloseTo(0.12, 10);
  });

  it("plain fallbacks carry the reason for the degrade", () => {
    const noAnchor = planTransition(null, point(128), 8);
    if (noAnchor.kind !== "plain") throw new Error("expected plain");
    expect(noAnchor.reason).toBe("missing-anchor");

    const badGrid = planTransition(point(NaN), point(128), 8);
    if (badGrid.kind !== "plain") throw new Error("expected plain");
    expect(badGrid.reason).toBe("missing-anchor");

    const gap = planTransition(point(128), point(174), 8);
    if (gap.kind !== "plain") throw new Error("expected plain");
    expect(gap.reason).toBe("tempo-gap");
  });

  it("beatmatched plans carry both grids for execution-time alignment", () => {
    const outG = point(126, 200.13);
    const inG = point(128, 0.37);
    const plan = planTransition(outG, inG, 8);
    if (plan.kind !== "beatmatched") throw new Error("expected beatmatched");
    expect(plan.outGrid).toEqual(outG);
    expect(plan.inGrid).toEqual(inG);
  });
});

describe("alignEntry", () => {
  it("shifts the planned entry by the outgoing beat-phase fraction", () => {
    const outG = point(128, 0);
    const inG = point(128, 0.37);
    const plan = planTransition(outG, inG, 8);
    if (plan.kind !== "beatmatched") throw new Error("expected beatmatched");
    const outPeriod = 60 / 128;
    // Outgoing sits 40% through its current beat at the anchor instant.
    const pos = 618 * outPeriod + 0.4 * outPeriod;
    const entry = alignEntry(plan, pos);
    const inPeriod = 60 / 128;
    const phaseIn = mod(entry - 0.37, inPeriod) / inPeriod;
    expect(phaseIn).toBeCloseTo(0.4, 6);
    // Never enters earlier than the planned musical entry point.
    expect(entry).toBeGreaterThanOrEqual(plan.incoming.startOffsetSec);
    expect(entry).toBeLessThan(plan.incoming.startOffsetSec + inPeriod);
  });

  it("locks the next beat of both decks to the same wall-clock instant", () => {
    // Different tempos: incoming runs at rateFrom until the ramp starts,
    // so its beat interval in wall time equals the outgoing period.
    const outG = point(126, 100.5);
    const inG = point(132, 3.11);
    const plan = planTransition(outG, inG, 8);
    if (plan.kind !== "beatmatched") throw new Error("expected beatmatched");
    const pos = 287.234; // arbitrary anchor instant
    const entry = alignEntry(plan, pos);

    const outPeriod = 60 / 126;
    const inPeriod = 60 / 132;
    const outToNext = outPeriod - mod(pos - 100.5, outPeriod); // wall secs at rate 1
    // Incoming track-secs to its next beat, converted by its start rate.
    const inToNext = (inPeriod - mod(entry - 3.11, inPeriod)) / plan.incoming.rateFrom;
    expect(inToNext).toBeCloseTo(outToNext, 6);
  });

  it("is exact-phase idempotent: aligning on a beat leaves the plan entry", () => {
    const plan = planTransition(point(120), point(120, 0), 8);
    if (plan.kind !== "beatmatched") throw new Error("expected beatmatched");
    const outPeriod = 60 / 120;
    // Anchor lands exactly on an outgoing beat → zero phase shift.
    expect(alignEntry(plan, 100 * outPeriod)).toBeCloseTo(plan.incoming.startOffsetSec, 9);
  });
});
