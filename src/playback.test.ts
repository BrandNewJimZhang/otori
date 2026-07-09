// TwoDeckEngine transition sequencing. DOM/WebAudio are faked — these
// tests pin the engine's deck bookkeeping across a crossfade:
//  - preloadNext must never touch the still-audible outgoing deck
//  - fades ride the audio clock (setValueCurveAtTime), not rAF, so a
//    hidden window (frozen rAF in WKWebView) can't stall them
//  - the deferred preload materializes once the outgoing deck retires

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransitionPlan } from "./djmix";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

/** Every Audio constructed by the engine, in creation order (deck 0, 1). */
let audios: FakeAudio[] = [];
/** Every GainNode created by the engine graph, in deck order. */
let gains: FakeGainNode[] = [];

class FakeAudio {
  preload = "";
  playbackRate = 1;
  currentTime = 0;
  paused = true;
  readyState = 4; // HAVE_ENOUGH_DATA: preloads are always "ready" here
  duration = 300;
  error: MediaError | null = null;
  /** Every src assignment — the clobbering regression asserts on this. */
  srcWrites: string[] = [];
  private srcValue = "";
  private listeners = new Map<string, Array<() => void>>();

  constructor() {
    audios.push(this);
  }

  get src(): string {
    return this.srcValue;
  }

  set src(value: string) {
    this.srcValue = value;
    this.srcWrites.push(value);
  }

  addEventListener(type: string, cb: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  /** Fire a media event as the browser would ("ended" implies paused). */
  fire(type: string): void {
    if (type === "ended") this.paused = true;
    for (const cb of this.listeners.get(type) ?? []) cb();
  }

  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {}

  removeAttribute(name: string): void {
    if (name === "src") this.srcValue = "";
  }
}

class FakeAudioParam {
  value = 1;
  setValueCurveAtTime = vi.fn();
  cancelScheduledValues = vi.fn();
}

class FakeGainNode {
  gain = new FakeAudioParam();
  constructor() {
    gains.push(this);
  }
  connect(): void {}
}

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  destination = {};
  baseLatency = 0.01;
  outputLatency = 0.05;
  resume(): Promise<void> {
    return Promise.resolve();
  }
  createAnalyser() {
    return { fftSize: 0, smoothingTimeConstant: 0, connect: () => {} };
  }
  createMediaElementSource() {
    return { connect: () => {} };
  }
  createGain(): FakeGainNode {
    return new FakeGainNode();
  }
}

/** Manually pumped rAF: frames only advance when a test says so. */
let rafCallbacks = new Map<number, FrameRequestCallback>();
let rafNextId = 1;

function pumpFrames(): void {
  const pending = [...rafCallbacks.values()];
  rafCallbacks.clear();
  for (const cb of pending) cb(performance.now());
}

const track = (path: string) => ({ path, replaygainDb: null });

const plainPlan = (durationSec: number): TransitionPlan => ({
  kind: "plain",
  durationSec,
  gainOut: (t) => 1 - t,
  gainIn: (t) => t,
});

async function createEngineWithAB() {
  const { createEngine } = await import("./playback");
  const engine = createEngine();
  await engine.play(track("/a.flac"));
  engine.preloadNext(track("/b.flac"));
  // Park A inside its end window (duration 300): transitions are only
  // valid there — the engine rejects plans for a mid-play deck.
  audios[1].currentTime = 297;
  return engine;
}

beforeEach(() => {
  audios = [];
  gains = [];
  rafCallbacks = new Map();
  rafNextId = 1;
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = rafNextId++;
    rafCallbacks.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafCallbacks.delete(id);
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

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

    vi.advanceTimersByTime(4000);

    expect(engine.transitioning).toBe(false);
    expect(outgoing.paused).toBe(true); // A retired...
    expect(outgoing.src).toBe("asset:///c.flac"); // ...and reloaded with C
  });

  it("schedules fades on the audio clock and completes without any rAF frames", async () => {
    const engine = await createEngineWithAB();
    engine.beginTransition(plainPlan(4), "/a.flac");

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
    const plan: TransitionPlan = {
      kind: "beatmatched",
      durationSec: 4,
      outgoing: { rateFrom: 1, rateTo: 1.05, startOffsetSec: 0 },
      incoming: { rateFrom: 1 / 1.05, rateTo: 1, startOffsetSec: 2 },
      gainOut: (t) => 1 - t,
      gainIn: (t) => t,
    };
    engine.beginTransition(plan, "/a.flac");
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
    engine.seek(30);
    const pausesBefore = audios[1].paused;

    vi.advanceTimersByTime(4000); // the original timer slot

    // No double-retire, no stray state flips.
    expect(audios[1].paused).toBe(pausesBefore);
    expect(engine.transitioning).toBe(false);
  });
});
