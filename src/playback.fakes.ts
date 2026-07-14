// Test doubles for the playback engine's DOM/WebAudio surface, shared
// by the behavioral suite (playback.test.ts) and the gold replay suite
// (playback.gold.test.ts). One authoritative fake world: media elements
// (with parameterized spin-up latency), gain automation that EVALUATES
// scheduled curves instead of merely recording calls, the audio clock,
// and a manually pumped rAF — plus advanceWorld(), which moves every
// clock coherently so invariants can be sampled mid-flight.

import { vi } from "vitest";

/** Every Audio constructed by the engine, in creation order (deck 0, 1).
    Cleared in place by installAudioFakes so imported bindings stay live. */
export const audios: FakeAudio[] = [];
/** Every GainNode created by the engine graph, in deck order. */
export const gains: FakeGainNode[] = [];
/** The engine's AudioContext (built once per engine, on first play). */
export const ctxs: FakeAudioContext[] = [];

export class FakeAudio {
  preload = "";
  playbackRate = 1;
  currentTime = 0;
  paused = true;
  readyState = 4; // HAVE_ENOUGH_DATA: preloads are always "ready" here
  duration = 300;
  error: MediaError | null = null;
  /** WKWebView-style startup latency: play() resolves (and sound
      starts) only after this many fake-timer ms. 0 = immediate. */
  spinUpMs = 0;
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
    // A src swap resets the element: playback stops, position zeroes —
    // exactly why a preload landing on a still-audible deck is fatal.
    if (value !== this.srcValue) {
      this.paused = true;
      this.currentTime = 0;
    }
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
    if (this.spinUpMs > 0) {
      return new Promise((resolve) =>
        setTimeout(() => {
          this.paused = false;
          resolve();
        }, this.spinUpMs),
      );
    }
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

interface ScheduledCurve {
  curve: Float32Array;
  startTime: number;
  duration: number;
}

export class FakeAudioParam {
  value = 1;
  private curves: ScheduledCurve[] = [];

  setValueCurveAtTime = vi.fn((curve: Float32Array, startTime: number, duration: number) => {
    this.curves.push({ curve, startTime, duration });
  });

  cancelScheduledValues = vi.fn((time: number) => {
    // Drop any automation still running at or after `time` — in-flight
    // curves included, matching how the engine uses it (cancel, then
    // restore a static value).
    this.curves = this.curves.filter((c) => c.startTime + c.duration <= time);
  });

  /** Evaluate the automation at an audio-clock time: the active curve
      (linear interpolation between its samples) wins; otherwise the
      static value. This is what lets tests assert the SHAPE of a fade
      against the clock rather than just that a call happened. */
  valueAt(time: number): number {
    for (let i = this.curves.length - 1; i >= 0; i--) {
      const c = this.curves[i];
      if (time >= c.startTime && time <= c.startTime + c.duration) {
        const pos = ((time - c.startTime) / c.duration) * (c.curve.length - 1);
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        const frac = pos - lo;
        return c.curve[lo] * (1 - frac) + c.curve[hi] * frac;
      }
    }
    return this.value;
  }
}

export class FakeGainNode {
  gain = new FakeAudioParam();
  constructor() {
    gains.push(this);
  }
  connect(): void {}
}

export class FakeAudioContext {
  state = "running";
  currentTime = 0;
  constructor() {
    ctxs.push(this);
  }
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
const rafCallbacks = new Map<number, FrameRequestCallback>();
let rafNextId = 1;

export function pumpFrames(): void {
  const pending = [...rafCallbacks.values()];
  rafCallbacks.clear();
  for (const cb of pending) cb(performance.now());
}

export const track = (path: string) => ({ path, replaygainDb: null });

/** Flush the microtask hops that anchor fades once the incoming
    deck's play() resolves — the fake resolves immediately. */
export async function flushFadeAnchor(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

/** Swap a deck's play() for one that resolves only when the test says
    the deck started sounding (spin-up latency under manual control;
    for clock-driven latency set spinUpMs instead). */
export function stallPlay(audio: FakeAudio): () => void {
  let release!: () => void;
  audio.play = () =>
    new Promise<void>((resolve) => {
      release = () => {
        audio.paused = false;
        resolve();
      };
    });
  return () => release();
}

/**
 * Advance every clock in the fake world coherently: the audio clock,
 * each playing element's media clock (rate-aware, firing "ended" at the
 * end of the file), and the fake timers — in sub-steps, flushing
 * microtasks and calling `onSample` after each so an invariant can be
 * checked continuously rather than only at hand-picked instants.
 */
export async function advanceWorld(
  ms: number,
  onSample?: () => void,
  stepMs = 50,
): Promise<void> {
  let remaining = ms;
  while (remaining > 0) {
    const dt = Math.min(stepMs, remaining);
    remaining -= dt;
    for (const ctx of ctxs) ctx.currentTime += dt / 1000;
    for (const audio of audios) {
      if (audio.paused) continue;
      audio.currentTime = Math.min(audio.duration, audio.currentTime + (dt / 1000) * audio.playbackRate);
      if (audio.currentTime >= audio.duration) audio.fire("ended");
    }
    vi.advanceTimersByTime(dt);
    for (let i = 0; i < 3; i++) await Promise.resolve();
    onSample?.();
  }
}

/** Engine with A playing and B preloaded — the standard two-deck
    opening position. A is parked inside its end window (duration 300):
    transitions are only valid there — the engine rejects plans for a
    mid-play deck. */
export async function createEngineWithAB() {
  const { createEngine } = await import("./playback");
  const engine = createEngine();
  await engine.play(track("/a.flac"));
  engine.preloadNext(track("/b.flac"));
  audios[1].currentTime = 297;
  return engine;
}

export function installAudioFakes(): void {
  audios.length = 0;
  gains.length = 0;
  ctxs.length = 0;
  rafCallbacks.clear();
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
}

export function uninstallAudioFakes(): void {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
}
