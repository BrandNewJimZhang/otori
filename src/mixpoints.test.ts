// Mix points come from the index (persisted anchors); tracks the
// sweeper hasn't reached fall back to one on-demand Rust analysis.

import { beforeEach, describe, expect, it, vi } from "vitest";

const analyzeTrack = vi.fn();
vi.mock("./ipc", () => ({
  analyzeTrack: (...args: unknown[]) => analyzeTrack(...args),
}));

import { headMixPoint, tailMixPoint } from "./mixpoints";
import type { TrackRow } from "./types";

function track(over: Partial<TrackRow>): TrackRow {
  return {
    id: 1,
    path: "/lib/a.flac",
    bpm: null,
    bpm_max: null,
    bpm_confidence: null,
    bpm_source: null,
    bpm_hint: null,
    bpm_shaky: false,
    mix_head_bpm: null,
    mix_head_beat_sec: null,
    mix_tail_bpm: null,
    mix_tail_beat_sec: null,
    mix_analyzed: false,
    ...over,
  } as TrackRow;
}

beforeEach(() => {
  analyzeTrack.mockReset();
});

describe("persisted anchors (fast path)", () => {
  it("reads both ends from the index without IPC", async () => {
    const t = track({
      mix_analyzed: true,
      mix_head_bpm: 128,
      mix_head_beat_sec: 0.25,
      mix_tail_bpm: 128,
      mix_tail_beat_sec: 200.5,
    });
    expect(await headMixPoint(t)).toEqual({ bpm: 128, beatSec: 0.25 });
    expect(await tailMixPoint(t)).toEqual({ bpm: 128, beatSec: 200.5 });
    expect(analyzeTrack).not.toHaveBeenCalled();
  });

  it("analyzed-but-anchorless ends mean plain fade, not re-analysis", async () => {
    const t = track({ mix_analyzed: true });
    expect(await headMixPoint(t)).toBeNull();
    expect(await tailMixPoint(t)).toBeNull();
    expect(analyzeTrack).not.toHaveBeenCalled();
  });
});

describe("on-demand analysis (unswept tracks)", () => {
  it("asks Rust once and shares the result across both ends", async () => {
    analyzeTrack.mockResolvedValue({
      bpm: 174,
      bpm_max: null,
      confidence: 0.9,
      hint_applied: false,
      head: { bpm: 174, beat_sec: 0.1 },
      tail: { bpm: 174, beat_sec: 180.2 },
    });
    const t = track({ id: 7 });
    const [head, tail] = await Promise.all([headMixPoint(t), tailMixPoint(t)]);
    expect(head).toEqual({ bpm: 174, beatSec: 0.1 });
    expect(tail).toEqual({ bpm: 174, beatSec: 180.2 });
    expect(analyzeTrack).toHaveBeenCalledTimes(1);
    expect(analyzeTrack).toHaveBeenCalledWith(7);
  });

  it("analysis failure degrades to plain fade, never throws", async () => {
    // E.g. the background sweep won the race and the track is no
    // longer pending — this transition fades plainly, next one reads
    // the persisted anchors.
    analyzeTrack.mockRejectedValue(new Error("not pending"));
    const t = track({ id: 8 });
    expect(await tailMixPoint(t)).toBeNull();
  });
});
