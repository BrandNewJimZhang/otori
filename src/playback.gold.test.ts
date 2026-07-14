// GOLD replay suite — the five historical crossfade incidents, each
// replayed by injecting the real-world property its stub lacked when
// the bug shipped (queue latency, deck spin-up, user races, the deck
// clock). Alongside the replays, two invariants sampled continuously:
//
//   I1  equal-power loudness: gainOut² + gainIn² ≤ 1 + ε at every
//       audio-clock instant of a transition
//   I2  a plan whose premise no longer holds ("this playback is ending
//       NOW") is rejected, and rejection leaves every deck untouched
//
// Unlike playback.test.ts (behavioral spec of the current engine),
// these tests are append-only: each maps to a shipped incident and
// must stay red on the pre-fix engine. Verified red (monotonic — each
// pre-fix engine also fails every LATER incident, since the guards
// accumulated):
//   0f1c2b5^ — 7/7 red   ed8c1d1^ — 6 red   5659199^ — 5 red
//   79d58a7^ — 4 red     4498169^ — 2 red   current — 7/7 green

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planTransition } from "./djmix";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));
import {
  advanceWorld,
  audios,
  createEngineWithAB,
  ctxs,
  flushFadeAnchor,
  gains,
  installAudioFakes,
  track,
  uninstallAudioFakes,
} from "./playback.fakes";

// The real plain plan (equal-power), not a test-local ramp: the gold
// suite locks the shipped curve shapes, so I1 is meaningful.
const plan4 = () => planTransition(null, null, 4);

/** I1 at one instant: constant loudness across both decks. Base gain
    is unity here (volume 1, no ReplayGain). */
function assertEqualPowerInvariant(): void {
  const t = ctxs[0].currentTime;
  const out = gains[1].gain.valueAt(t); // deck 1: outgoing (A)
  const inn = gains[0].gain.valueAt(t); // deck 0: incoming (B)
  expect(out * out + inn * inn).toBeLessThanOrEqual(1 + 1e-3);
}

beforeEach(installAudioFakes);
afterEach(uninstallAudioFakes);

describe("incident 0f1c2b5 — preload landing mid-transition cut the outgoing deck dead", () => {
  it("outgoing deck keeps sounding a.flac for the whole fade despite a preload", async () => {
    const engine = await createEngineWithAB();
    const outgoing = audios[1];
    // Park A with 6s left (still inside the 4s fade + 3s slack window)
    // so it outlives the whole fade — its natural end is a different
    // event than the preload clobber this incident is about.
    outgoing.currentTime = 294;

    expect(engine.beginTransition(plan4(), "/a.flac")).toBe(true);
    await flushFadeAnchor();
    // The UI already advanced to B and preloads C — while A is fading.
    // On the pre-fix engine this src write hit the audible deck; the
    // fake's src-swap semantics (stop + rewind) make that failure
    // observable instead of silent.
    engine.preloadNext(track("/c.flac"));

    await advanceWorld(3900, () => {
      if (!engine.transitioning) return;
      expect(outgoing.src).toBe("asset:///a.flac");
      expect(outgoing.paused).toBe(false);
      assertEqualPowerInvariant();
    });

    // After the fade the deferred preload lands on the retired deck.
    await advanceWorld(200);
    expect(engine.transitioning).toBe(false);
    expect(outgoing.src).toBe("asset:///c.flac");
  });
});

describe("incident ed8c1d1 — seeking mid-fade fought the transition", () => {
  it("seek finalizes: outgoing retires, incoming wins at full gain, timer is inert", async () => {
    const engine = await createEngineWithAB();
    engine.beginTransition(plan4(), "/a.flac");
    await flushFadeAnchor();
    await advanceWorld(1000); // mid-fade

    engine.seek(30);

    expect(engine.transitioning).toBe(false);
    expect(audios[0].currentTime).toBe(30);
    expect(audios[0].paused).toBe(false);
    expect(audios[1].paused).toBe(true);
    expect(gains[0].gain.value).toBe(1); // automation cancelled, unity restored
    const pausedAfterSeek = audios[1].paused;

    await advanceWorld(4000); // the original finalize-timer slot
    expect(audios[1].paused).toBe(pausedAfterSeek); // no double retire
    expect(engine.transitioning).toBe(false);
  });
});

describe("incident 5659199 — queue latency: the plan outlived the track it was made for", () => {
  it("a plan arriving after natural advance is rejected and touches nothing", async () => {
    const engine = await createEngineWithAB();

    // Anchor analysis queued behind the sweeper's engine lock: by the
    // time the plan lands, A (3s remaining) has ended and gaplessly
    // advanced to B, and C is already preloading — the exact race.
    await advanceWorld(3500);
    expect(audios[0].paused).toBe(false); // B took over
    engine.preloadNext(track("/c.flac"));

    const idleBefore = audios[1].src;
    expect(engine.beginTransition(plan4(), "/a.flac")).toBe(false); // I2
    expect(engine.transitioning).toBe(false);
    expect(audios[0].paused).toBe(false); // B plays on, untouched
    expect(audios[1].src).toBe(idleBefore); // preload deck untouched
  });
});

describe("incident 79d58a7 — same path, dead premise: the deck clock is authoritative", () => {
  it("rejects the plan after the user restarted the outgoing track", async () => {
    const engine = await createEngineWithAB();
    // Repeat-one / re-click: same file, position back at the top. The
    // plan's premise ("this playback is ending NOW") is gone.
    audios[1].currentTime = 0;

    expect(engine.beginTransition(plan4(), "/a.flac")).toBe(false); // I2
    expect(engine.transitioning).toBe(false);
    expect(audios[0].paused).toBe(true); // B must not start over A's intro
  });

  it("rejects the plan while the outgoing deck is paused in its end window", async () => {
    const engine = await createEngineWithAB();
    engine.togglePause();

    expect(engine.beginTransition(plan4(), "/a.flac")).toBe(false); // I2
    expect(engine.transitioning).toBe(false);
    expect(audios[0].paused).toBe(true);
  });
});

describe("incident 4498169 — deck spin-up burned the fade-in's silent head", () => {
  it("5a: with 300ms spin-up, both curves anchor where sound exists — fade-in from true silence", async () => {
    const engine = await createEngineWithAB();
    audios[0].spinUpMs = 300; // WKWebView asset fetch + decode latency

    expect(engine.beginTransition(plan4(), "/a.flac")).toBe(true);
    expect(engine.transitioning).toBe(true); // reservation holds while pending

    // During spin-up no curve may be scheduled: anchoring at plan time
    // is the shipped bug — the incoming track would enter mid-slope.
    await advanceWorld(250);
    expect(gains[0].gain.setValueCurveAtTime).not.toHaveBeenCalled();

    await advanceWorld(100); // play() resolves at 300ms; anchor lands
    const anchor = gains[0].gain.setValueCurveAtTime.mock.calls[0][1] as number;
    expect(anchor).toBeCloseTo(0.3, 3); // anchored at the sounding moment...
    expect(gains[0].gain.valueAt(anchor)).toBeLessThanOrEqual(1e-3); // ...from silence
    expect(gains[1].gain.setValueCurveAtTime.mock.calls[0][1]).toBeCloseTo(anchor, 6);

    // And the full fade obeys I1 from that anchor onward.
    await advanceWorld(4000, () => {
      if (engine.transitioning) assertEqualPowerInvariant();
    });
    expect(engine.transitioning).toBe(false);
  });

  it("5b: incoming play() rejection retires the outgoing deck (UI already advanced)", async () => {
    const engine = await createEngineWithAB();
    audios[0].play = () => Promise.reject(new Error("decode failed"));
    let error = "";
    engine.onError((m) => (error = m));

    expect(engine.beginTransition(plan4(), "/a.flac")).toBe(true);
    await flushFadeAnchor();

    // The UI followed the incoming track at handoff: leaving the
    // outgoing deck playing would strand audio the UI can't see.
    expect(engine.transitioning).toBe(false);
    expect(audios[1].paused).toBe(true);
    expect(error).toContain("decode failed");
  });
});
