// TwoDeckEngine transition sequencing. DOM/WebAudio are faked — these
// tests pin the engine's deck bookkeeping across a crossfade:
//  - preloadNext must never touch the still-audible outgoing deck
//  - fades ride the audio clock (setValueCurveAtTime), not rAF, so a
//    hidden window (frozen rAF in WKWebView) can't stall them
//  - both fades anchor to the moment the incoming deck actually starts
//    sounding (play() resolves), not to plan-execution time — else the
//    fade-in's silent head burns off during deck spin-up and the track
//    enters mid-slope instead of from silence
//  - the deferred preload materializes once the outgoing deck retires

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alignEntry, planTransition, type TransitionPlan } from "./djmix";
import {
  advanceWorld,
  audios,
  createEngineWithAB,
  ctxs,
  filters,
  flushFadeAnchor,
  gains,
  installAudioFakes,
  pumpFrames,
  stallPlay,
  track,
  uninstallAudioFakes,
} from "./playback.fakes";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

const plainPlan = (durationSec: number): TransitionPlan => ({
  kind: "plain",
  durationSec,
  reason: "missing-anchor",
  gainOut: (t) => 1 - t,
  gainIn: (t) => t,
});

beforeEach(installAudioFakes);

afterEach(uninstallAudioFakes);

describe("TwoDeckEngine output latency", () => {
  it("reports the graph's output+base latency in ms", async () => {
    const engine = await createEngineWithAB();
    expect(engine.outputLatencyMs).toBeCloseTo(60, 5); // (0.05 + 0.01) s
  });

  it("is 0 before the graph exists", async () => {
    const { createEngine } = await import("./playback");
    expect(createEngine().outputLatencyMs).toBe(0);
  });
});

describe("TwoDeckEngine transitions", () => {
  it("rejects a stale plan whose outgoing track is no longer playing", async () => {
    const engine = await createEngineWithAB();
    const deckA = audios[1]; // A plays on deck 1, B preloads on deck 0

    // A ends naturally: gapless advance to B, then C preloads on the
    // now-idle deck — the exact state a slow anchor analysis races.
    deckA.fire("ended");
    engine.preloadNext(track("/c.flac"));

    // The late plan was made for "A's tail into B's head". A is gone:
    // executing it would fade the playing B into C mid-track.
    expect(engine.beginTransition(plainPlan(4), "/a.flac")).toBe(false);
    expect(engine.transitioning).toBe(false);
    expect(audios[1].paused).toBe(true); // idle deck (holding C) untouched
  });

  it("rejects a stale plan after the same track restarted from the top", async () => {
    const engine = await createEngineWithAB();
    const deckA = audios[1];

    // The user re-clicked A while its plan was still computing anchors:
    // same path, but the premise ("this playback is ending") is gone.
    deckA.currentTime = 0;

    expect(engine.beginTransition(plainPlan(4), "/a.flac")).toBe(false);
    expect(engine.transitioning).toBe(false);
    expect(audios[0].paused).toBe(true); // B must not start over A's intro
  });

  it("rejects a stale plan while the outgoing deck is paused", async () => {
    const engine = await createEngineWithAB();

    // Paused inside the end window: a fade would start the next track
    // sounding over silence with no user action.
    engine.togglePause();

    expect(engine.beginTransition(plainPlan(4), "/a.flac")).toBe(false);
    expect(engine.transitioning).toBe(false);
    expect(audios[0].paused).toBe(true);
  });

  it("keeps the outgoing deck audible when a preload lands mid-transition", async () => {
    const engine = await createEngineWithAB();
    // A plays on deck 1 (play() targets the idle deck), B preloads on deck 0.
    const outgoing = audios[1];
    expect(outgoing.src).toBe("asset:///a.flac");

    expect(engine.beginTransition(plainPlan(4), "/a.flac")).toBe(true);
    const writesDuringFade = outgoing.srcWrites.length;

    // UI advanced to B and immediately preloads C — while A is fading.
    engine.preloadNext(track("/c.flac"));

    expect(outgoing.srcWrites.length).toBe(writesDuringFade); // src untouched
    expect(outgoing.src).toBe("asset:///a.flac");
    expect(outgoing.paused).toBe(false); // still fading out, still audible
  });

  it("materializes the deferred preload once the transition completes", async () => {
    const engine = await createEngineWithAB();
    const outgoing = audios[1];
    engine.beginTransition(plainPlan(4), "/a.flac");
    engine.preloadNext(track("/c.flac"));
    await flushFadeAnchor();

    vi.advanceTimersByTime(4000);

    expect(engine.transitioning).toBe(false);
    expect(outgoing.paused).toBe(true); // A retired...
    expect(outgoing.src).toBe("asset:///c.flac"); // ...and reloaded with C
  });

  it("anchors both fades to the moment the incoming deck starts sounding", async () => {
    const engine = await createEngineWithAB();
    const releasePlay = stallPlay(audios[0]); // incoming deck spin-up stalls

    expect(engine.beginTransition(plainPlan(4), "/a.flac")).toBe(true);
    expect(engine.transitioning).toBe(true); // reservation holds while pending

    // Deck spin-up burns 300ms of audio-clock time before sound exists.
    // Scheduling the curves now would waste the fade-in's silent head
    // on a deck nobody can hear yet.
    ctxs[0].currentTime = 0.3;
    const [gainOut, gainIn] = [gains[1], gains[0]];
    expect(gainOut.gain.setValueCurveAtTime).not.toHaveBeenCalled();
    expect(gainIn.gain.setValueCurveAtTime).not.toHaveBeenCalled();

    releasePlay();
    await flushFadeAnchor();

    // Both curves anchor to the sounding moment — out and in stay
    // symmetric, and the fade-in starts from true silence.
    expect(gainOut.gain.setValueCurveAtTime.mock.calls[0][1]).toBe(0.3);
    expect(gainIn.gain.setValueCurveAtTime.mock.calls[0][1]).toBe(0.3);
  });

  it("keeps deferring preloads while the incoming deck spins up", async () => {
    const engine = await createEngineWithAB();
    const outgoing = audios[1];
    const releasePlay = stallPlay(audios[0]);
    engine.beginTransition(plainPlan(4), "/a.flac");

    // A preload landing during spin-up must not touch the still-audible
    // outgoing deck any more than one landing mid-fade would.
    engine.preloadNext(track("/c.flac"));
    expect(outgoing.src).toBe("asset:///a.flac");
    expect(outgoing.paused).toBe(false);

    releasePlay();
    await flushFadeAnchor();
    vi.advanceTimersByTime(4000);

    expect(engine.transitioning).toBe(false);
    expect(outgoing.src).toBe("asset:///c.flac"); // deferred preload landed
  });

  it("drops the pending fade when play() interrupts during deck spin-up", async () => {
    const engine = await createEngineWithAB();
    const releasePlay = stallPlay(audios[0]);
    engine.beginTransition(plainPlan(4), "/a.flac");

    await engine.play(track("/d.flac")); // user clicked another track

    releasePlay(); // the stale spin-up settles afterwards
    await flushFadeAnchor();

    // The dead transition must not schedule fades over D's playback.
    for (const gain of gains) {
      expect(gain.gain.setValueCurveAtTime).not.toHaveBeenCalled();
    }
    expect(engine.transitioning).toBe(false);
  });

  it("schedules fades on the audio clock and completes without any rAF frames", async () => {
    const engine = await createEngineWithAB();
    audios[1].currentTime = 295; // 5s left: the 4s fade fits physically
    engine.beginTransition(plainPlan(4), "/a.flac");
    await flushFadeAnchor();

    // Both fades are one-shot audio-clock automations, not per-frame writes.
    const [gainOut, gainIn] = [gains[1], gains[0]];
    expect(gainOut.gain.setValueCurveAtTime).toHaveBeenCalledTimes(1);
    expect(gainIn.gain.setValueCurveAtTime).toHaveBeenCalledTimes(1);
    const [curve, , duration] = gainIn.gain.setValueCurveAtTime.mock.calls[0];
    expect(duration).toBe(4);
    expect(curve[0]).toBe(0); // fade-in enters silent
    expect(curve[curve.length - 1]).toBeCloseTo(1, 5); // and lands at unity

    // Window hidden: rAF never fires. The transition must still finish.
    vi.advanceTimersByTime(4000);
    expect(engine.transitioning).toBe(false);
    expect(audios[1].paused).toBe(true);
  });

  it("ramps playbackRate over rAF frames for beat-matched plans", async () => {
    const engine = await createEngineWithAB();
    audios[1].currentTime = 295; // 5s left: the 4s fade fits physically
    const plan: TransitionPlan = {
      kind: "beatmatched",
      durationSec: 4,
      outgoing: { rateFrom: 1, rateTo: 1.05, startOffsetSec: 0 },
      incoming: { rateFrom: 1 / 1.05, rateTo: 1, startOffsetSec: 2 },
      outGrid: { bpm: 120, beatSec: 295 }, // anchor ON the beat: zero phase shift
      inGrid: { bpm: 126, beatSec: 2 },
      bassSwap: { atSec: 2, rampSec: 0.5 },
      gainOut: (t) => 1 - t,
      gainIn: (t) => t,
    };
    engine.beginTransition(plan, "/a.flac");
    await flushFadeAnchor();
    expect(audios[0].currentTime).toBe(2); // incoming enters on its offset

    vi.advanceTimersByTime(2000); // halfway
    pumpFrames();
    expect(audios[1].playbackRate).toBeCloseTo(1.025, 3);
    expect(audios[0].playbackRate).toBeCloseTo((1 / 1.05 + 1) / 2, 3);

    vi.advanceTimersByTime(2000);
    pumpFrames();
    vi.advanceTimersByTime(0); // completion timer already due
    expect(engine.transitioning).toBe(false);
    expect(audios[0].playbackRate).toBe(1); // settled at natural tempo
  });

  it("phase-aligns the beat-matched entry at the anchor instant (spin-up compensated)", async () => {
    const engine = await createEngineWithAB();
    const outgoing = audios[1];
    const incoming = audios[0];
    // Real planner output so the grids are consistent with the ramps.
    const outGrid = { bpm: 125, beatSec: 290 };
    const inGrid = { bpm: 128, beatSec: 0.25 };
    const plan = planTransition(outGrid, inGrid, 8);
    if (plan.kind !== "beatmatched") throw new Error("expected beatmatched");

    // Park the outgoing deck mid-beat inside its end window, then make
    // the incoming deck take 730ms to start sounding: the anchor
    // instant (and thus the outgoing phase) is unknowable at plan time.
    outgoing.currentTime = 292.3;
    incoming.spinUpMs = 730;
    expect(engine.beginTransition(plan, "/a.flac")).toBe(true);
    await advanceWorld(730);

    // The entry seek happened at the anchor, phase-locked to where the
    // outgoing deck ACTUALLY is now — not to where it was at begin.
    const expected = alignEntry(plan, outgoing.currentTime);
    expect(incoming.currentTime).toBeCloseTo(expected, 3);
    expect(expected).toBeGreaterThan(plan.incoming.startOffsetSec); // 730ms drift ≠ 0 phase
  });

  it("swaps the low end at the planned bar boundary (beat-matched only)", async () => {
    const engine = await createEngineWithAB();
    // 120 BPM, 8s request → 4 bars (8s), swap at bar 2 (4s), 0.5s ramp.
    const plan = planTransition({ bpm: 120, beatSec: 290 }, { bpm: 120, beatSec: 0 }, 8);
    if (plan.kind !== "beatmatched") throw new Error("expected beatmatched");
    audios[1].currentTime = 291;
    expect(engine.beginTransition(plan, "/a.flac")).toBe(true);
    await flushFadeAnchor();

    const [inEq, outEq] = [filters[0], filters[1]]; // deck 0 incoming, deck 1 outgoing
    const t0 = ctxs[0].currentTime;
    // Incoming bass shelved off until the swap; outgoing at full.
    expect(inEq.gain.valueAt(t0 + 1)).toBeLessThan(-20);
    expect(outEq.gain.valueAt(t0 + 1)).toBeCloseTo(0, 5);
    // Mid-ramp both are moving; after the swap the roles are traded.
    expect(inEq.gain.valueAt(t0 + 4.5)).toBeCloseTo(0, 5);
    expect(outEq.gain.valueAt(t0 + 4.5)).toBeLessThan(-20);

    // Finalize restores flat EQ on both decks for normal playback.
    await advanceWorld(8000);
    const tEnd = ctxs[0].currentTime;
    expect(engine.transitioning).toBe(false);
    expect(inEq.gain.valueAt(tEnd)).toBe(0);
    expect(outEq.gain.valueAt(tEnd)).toBe(0);
  });

  it("plain fades keep both decks' EQ flat", async () => {
    const engine = await createEngineWithAB();
    engine.beginTransition(plainPlan(4), "/a.flac");
    await flushFadeAnchor();
    const t = ctxs[0].currentTime + 2;
    expect(filters[0].gain.valueAt(t)).toBe(0);
    expect(filters[1].gain.valueAt(t)).toBe(0);
  });

  it("cancels scheduled fades when play() interrupts a transition", async () => {
    const engine = await createEngineWithAB();
    engine.beginTransition(plainPlan(4), "/a.flac");
    expect(engine.transitioning).toBe(true);

    await engine.play(track("/d.flac"));

    expect(engine.transitioning).toBe(false);
    for (const gain of gains) {
      expect(gain.gain.cancelScheduledValues).toHaveBeenCalled();
    }
  });

  it("seek during a transition finalizes it: outgoing retires, incoming full gain", async () => {
    const engine = await createEngineWithAB();
    const outgoing = audios[1];
    const incoming = audios[0];
    engine.beginTransition(plainPlan(4), "/a.flac");
    await flushFadeAnchor(); // fades are live on the audio clock
    engine.preloadNext(track("/c.flac")); // deferred behind the fade

    engine.seek(30);

    // The fade's premise (this tail against this head) is gone: the
    // incoming track wins immediately, at full gain, on the new spot.
    expect(engine.transitioning).toBe(false);
    expect(incoming.currentTime).toBe(30);
    expect(incoming.paused).toBe(false);
    expect(outgoing.paused).toBe(true);
    const incomingGain = gains[0];
    expect(incomingGain.gain.cancelScheduledValues).toHaveBeenCalled();
    expect(incomingGain.gain.value).toBe(1);
    // The deferred preload materialized on the retired deck.
    expect(outgoing.src).toBe("asset:///c.flac");
  });

  it("seek outside a transition just seeks", async () => {
    const engine = await createEngineWithAB();
    engine.seek(12);
    expect(audios[1].currentTime).toBe(12); // active deck (A)
    expect(engine.transitioning).toBe(false);
  });

  it("a finalized-by-seek transition does not re-finalize on its timer", async () => {
    const engine = await createEngineWithAB();
    engine.beginTransition(plainPlan(4), "/a.flac");
    await flushFadeAnchor(); // the finalize timer is armed
    engine.seek(30);
    const pausesBefore = audios[1].paused;

    vi.advanceTimersByTime(4000); // the original timer slot

    // No double-retire, no stray state flips.
    expect(audios[1].paused).toBe(pausesBefore);
    expect(engine.transitioning).toBe(false);
  });
});

describe("TwoDeckEngine progress ticks", () => {
  // WKWebView suspends the media element's `timeupdate` event (like
  // rAF) when the window is occluded or not key, while the audio clock
  // keeps running — the bar freezes but the music plays on. Progress
  // ticks must therefore ride a timer sampling the deck clock, not the
  // DOM event. This fake world never fires `timeupdate` and never pumps
  // rAF — exactly the hidden-window condition.
  it("ticks from the deck clock without timeupdate events or rAF frames", async () => {
    const engine = await createEngineWithAB();
    const ticks: number[] = [];
    engine.onTimeUpdate((secs) => ticks.push(secs));

    await advanceWorld(1000);

    expect(ticks.length).toBeGreaterThanOrEqual(3); // ~4Hz cadence
    // A parked at 297; after 1s of playback the clock reads ~298.
    expect(ticks[ticks.length - 1]).toBeCloseTo(298, 1);
  });

  it("does not tick while paused", async () => {
    const engine = await createEngineWithAB();
    const ticks: number[] = [];
    engine.onTimeUpdate((secs) => ticks.push(secs));

    engine.togglePause();
    await advanceWorld(1000);

    expect(ticks).toEqual([]);
  });

  it("follows the incoming deck once a transition hands off", async () => {
    const engine = await createEngineWithAB();
    engine.beginTransition(plainPlan(4), "/a.flac");
    await flushFadeAnchor(); // ownership flipped to the incoming deck
    const ticks: number[] = [];
    engine.onTimeUpdate((secs) => ticks.push(secs));

    await advanceWorld(1000);

    // The incoming track started from 0 — ticks report ITS clock, not
    // the still-audible outgoing deck parked near 297.
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (const t of ticks) expect(t).toBeLessThan(5);
  });
});
