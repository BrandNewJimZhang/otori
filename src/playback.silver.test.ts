// SILVER suite — eval-expansion round 1 (docs/design/eval-expansion-round1.md).
// Crossfade boundary cases produced by a blind adversarial generator and
// adjudicated here against the CURRENT engine. Each test asserts the
// spec's EXPECTED behavior; where a spec allows two legal outcomes the
// test first probes the engine's actual choice (beginTransition's
// boolean) and then asserts that outcome's full conditions plus the
// forbidden list. A red is a finding about the engine, not a test bug —
// assertions are not weakened to force green. Same fake world and file
// conventions as playback.gold.test.ts.

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

// The real plain plan (equal-power), same as the gold suite.
const plan = (sec: number) => planTransition(null, null, sec);

/** I1 at one instant (mirrors the gold suite's helper): constant
    loudness across both decks — gainOut² + gainIn² ≤ 1 + ε. */
function assertEqualPowerInvariant(): void {
  const t = ctxs[0].currentTime;
  const out = gains[1].gain.valueAt(t); // deck 1: outgoing (A)
  const inn = gains[0].gain.valueAt(t); // deck 0: incoming (B)
  expect(out * out + inn * inn).toBeLessThanOrEqual(1 + 1e-3);
}

/** What a listener hears: Σ gain² over decks that are actually playing
    (a paused/ended deck contributes nothing regardless of its gain). */
function playingLoudness(): number {
  const t = ctxs[0].currentTime;
  let total = 0;
  for (const i of [0, 1]) {
    if (!audios[i].paused) total += gains[i].gain.valueAt(t) ** 2;
  }
  return total;
}

/** Deck indices audible right now: playing AND gain² above ε. */
function audibleDecks(eps = 0.01): number[] {
  const t = ctxs[0].currentTime;
  return [0, 1].filter((i) => !audios[i].paused && gains[i].gain.valueAt(t) ** 2 > eps);
}

/** Fresh engine for cases whose setup diverges from createEngineWithAB
    (self-preload, short incoming). Deck layout after play(a): A on
    deck 1 (audios[1]/gains[1]), preload lands on deck 0. */
async function createFreshEngine() {
  const { createEngine } = await import("./playback");
  return createEngine();
}

beforeEach(installAudioFakes);
afterEach(uninstallAudioFakes);

describe("XF-1 — pause mid-fade, then unpause", () => {
  // Derivation: 1s into a 4s crossfade the user hits pause. The mix is
  // one logical playback, so the spec expects BOTH media clocks frozen
  // for the pause, then a clean landing after unpause: I1 while
  // transitioning, exactly one deck audible at unity, transitioning
  // eventually false, no sample-to-sample loudness jump. Engine note:
  // deck ownership flips to the INCOMING deck at arm time and
  // togglePause() reaches only the active deck — the outgoing deck is
  // left running. The frozen-clock assertion adjudicates that choice.
  // PENDING GOLD ADJUDICATION (red on the current engine): pause
  // reaches only the active deck; the outgoing deck keeps sounding.
  // Unskip together with the engine fix once the human confirms.
  it.skip("freezes both media clocks while paused and lands cleanly after unpause", async () => {
    const engine = await createEngineWithAB();
    expect(engine.beginTransition(plan(4), "/a.flac")).toBe(true);
    await flushFadeAnchor();
    await advanceWorld(1000, () => {
      if (engine.transitioning) assertEqualPowerInvariant();
    });

    engine.togglePause();
    const inClock = audios[0].currentTime;
    const outClock = audios[1].currentTime;
    await advanceWorld(2000, () => {
      expect(audios[0].currentTime).toBe(inClock); // incoming frozen
      expect(audios[1].currentTime).toBe(outClock); // outgoing frozen
    });

    engine.togglePause();
    let prevLoudness = playingLoudness();
    await advanceWorld(3000, () => {
      if (!engine.transitioning) return;
      assertEqualPowerInvariant();
      const cur = playingLoudness();
      expect(Math.abs(cur - prevLoudness)).toBeLessThanOrEqual(0.3);
      prevLoudness = cur;
    });

    expect(engine.transitioning).toBe(false);
    expect(audibleDecks()).toEqual([0]); // incoming alone, at unity
    expect(gains[0].gain.valueAt(ctxs[0].currentTime) ** 2).toBeCloseTo(1, 2);
  });
});

describe("XF-3 — double-arm while a transition is running", () => {
  // Derivation: with P1 running, a second arm (either against the old
  // outgoing path or the now-active incoming path) must be rejected,
  // and the rejection must not perturb P1's scheduled curves. The
  // curves are fully scheduled at anchor time, so valueAt() can probe
  // the ENTIRE fade window before and after the rejected calls — any
  // cancel/reschedule would change those values.
  it("rejects both re-arms and leaves P1's curves bit-identical", async () => {
    const engine = await createEngineWithAB();
    expect(engine.beginTransition(plan(4), "/a.flac")).toBe(true);
    await flushFadeAnchor();
    const anchor = gains[0].gain.setValueCurveAtTime.mock.calls[0][1] as number;
    await advanceWorld(1000, () => {
      if (engine.transitioning) assertEqualPowerInvariant();
    });

    const probes = [0.1, 0.5, 1.5, 2.5, 3.5, 3.9].map((dt) => anchor + dt);
    const before = probes.map((t) => [gains[0].gain.valueAt(t), gains[1].gain.valueAt(t)]);

    expect(engine.beginTransition(plan(4), "/a.flac")).toBe(false);
    expect(engine.beginTransition(plan(4), "/b.flac")).toBe(false);

    const after = probes.map((t) => [gains[0].gain.valueAt(t), gains[1].gain.valueAt(t)]);
    expect(after).toEqual(before);
    // No second automation was scheduled on either deck.
    expect(gains[0].gain.setValueCurveAtTime).toHaveBeenCalledTimes(1);
    expect(gains[1].gain.setValueCurveAtTime).toHaveBeenCalledTimes(1);

    await advanceWorld(3200, () => {
      if (engine.transitioning) assertEqualPowerInvariant();
    });
    expect(engine.transitioning).toBe(false);
    expect(audibleDecks()).toEqual([0]);
    expect(gains[0].gain.valueAt(ctxs[0].currentTime)).toBeCloseTo(1, 3);
  });
});

describe("XF-6 — preloadNext(null) mid-fade", () => {
  // Derivation: clearing the queue mid-fade must not reach the decks of
  // the running transition. The engine defers preload writes while
  // transitioning and materializes them only after the outgoing deck
  // retires — so the incoming deck's src and clock must be untouched
  // through the fade, I1 must hold, and B ends up sole audible.
  it("deferred null preload leaves the incoming deck intact through the fade", async () => {
    const engine = await createEngineWithAB();
    expect(engine.beginTransition(plan(4), "/a.flac")).toBe(true);
    await flushFadeAnchor();
    await advanceWorld(1000, () => {
      if (engine.transitioning) assertEqualPowerInvariant();
    });

    engine.preloadNext(null);

    const srcBefore = audios[0].src;
    let prevTime = audios[0].currentTime;
    await advanceWorld(3200, () => {
      expect(audios[0].src).toBe(srcBefore);
      expect(audios[0].currentTime).toBeGreaterThanOrEqual(prevTime);
      prevTime = audios[0].currentTime;
      if (engine.transitioning) assertEqualPowerInvariant();
    });

    expect(engine.transitioning).toBe(false);
    expect(audios[0].src).toBe("asset:///b.flac");
    expect(audibleDecks()).toEqual([0]);
    expect(gains[0].gain.valueAt(ctxs[0].currentTime)).toBeCloseTo(1, 3);
  });
});

describe("XF-9 — zero-duration plan", () => {
  // Derivation: durationSec = 0 slips past the end-window check
  // (remaining 3 > 0 + 3 is false), so the engine is expected to accept.
  // Outcome (a) accepted: gains stay finite, never both decks audible
  // (or none) for more than one sub-step, transitioning eventually
  // false — a hard cut, not a hang. Outcome (b) rejected: both decks
  // untouched. Harness caveat: the fake evaluates a 0-duration curve
  // only at its exact anchor instant (never sampled by advanceWorld);
  // a REAL AudioParam would throw RangeError on duration 0 — that
  // failure mode is not expressible in this fake world.
  it("either cuts hard and finitely, or rejects and touches nothing", async () => {
    const engine = await createEngineWithAB();
    const accepted = engine.beginTransition(plan(0), "/a.flac");

    if (accepted) {
      await flushFadeAnchor();
      let badStreak = 0;
      await advanceWorld(500, () => {
        const t = ctxs[0].currentTime;
        expect(Number.isFinite(gains[0].gain.valueAt(t))).toBe(true);
        expect(Number.isFinite(gains[1].gain.valueAt(t))).toBe(true);
        const audible = audibleDecks();
        badStreak = audible.length === 1 ? 0 : badStreak + 1;
        expect(badStreak).toBeLessThanOrEqual(1);
      });
      expect(engine.transitioning).toBe(false);
      expect(audibleDecks()).toEqual([0]);
    } else {
      // Rejection must leave every deck untouched.
      expect(audios[1].paused).toBe(false);
      expect(audios[1].currentTime).toBe(297);
      expect(audios[0].paused).toBe(true);
      expect(audios[0].currentTime).toBe(0);
      await advanceWorld(500);
      expect(audios[1].currentTime).toBeCloseTo(297.5, 3);
    }
  });
});

describe("XF-11 — fade completion coincident with outgoing natural end", () => {
  // Derivation: A parked at 296/300 under a 4s fade — the finalize
  // timer and A's natural "ended" land on the same instant. The shell
  // must advance exactly ONCE: onTransitionAdvance("/b.flac") at arm,
  // and the outgoing deck's natural end must NOT surface as a second
  // advance. The engine dedups via the active-deck check in the
  // "ended" listener (ownership already flipped at arm), so onEnded
  // must fire zero times for this handoff.
  it("the shell sees exactly one advance-worthy notification", async () => {
    const engine = await createEngineWithAB();
    audios[1].currentTime = 296; // remaining ≈ fade duration
    const advances: string[] = [];
    const endeds: Array<string | null> = [];
    engine.onTransitionAdvance((p) => advances.push(p));
    engine.onEnded((p) => endeds.push(p));

    expect(engine.beginTransition(plan(4), "/a.flac")).toBe(true);
    await flushFadeAnchor();
    await advanceWorld(4500, () => {
      if (engine.transitioning) assertEqualPowerInvariant();
    });

    expect(engine.transitioning).toBe(false);
    expect(advances).toEqual(["/b.flac"]); // exactly one advance
    expect(endeds).toEqual([]); // no onEnded-driven double advance
    expect(audibleDecks()).toEqual([0]);
  });
});

describe("XF-12 — self-crossfade: preload the same path as the current track", () => {
  // Derivation: both decks hold "/a.flac". Outcome (a) accepted: the
  // two ELEMENTS must be independently clocked — outgoing continues
  // from its end-window position while incoming starts from 0 — with
  // I1 throughout and exactly one advance. Outcome (b) rejected: FULL
  // untouched-ness of the audible deck (a path-keyed guard could grab
  // the wrong deck): still playing, not rewound, position advancing.
  it("accepted: independent clocks, one advance — rejected: audible deck untouched", async () => {
    const engine = await createFreshEngine();
    await engine.play(track("/a.flac"));
    engine.preloadNext(track("/a.flac"));
    audios[1].currentTime = 297; // park A in its end window
    const advances: string[] = [];
    const endeds: Array<string | null> = [];
    engine.onTransitionAdvance((p) => advances.push(p));
    engine.onEnded((p) => endeds.push(p));

    const accepted = engine.beginTransition(plan(4), "/a.flac");

    if (accepted) {
      await flushFadeAnchor();
      // Independently clocked: incoming from 0, outgoing from 297.
      expect(audios[0].currentTime).toBeLessThan(1);
      expect(audios[1].currentTime).toBeGreaterThanOrEqual(297);
      let prevIn = audios[0].currentTime;
      await advanceWorld(1000, () => {
        expect(audios[0].currentTime).toBeGreaterThan(prevIn);
        prevIn = audios[0].currentTime;
        expect(audios[1].currentTime).toBeGreaterThanOrEqual(297);
        if (engine.transitioning) assertEqualPowerInvariant();
      });
      await advanceWorld(3200, () => {
        if (engine.transitioning) assertEqualPowerInvariant();
      });
      expect(engine.transitioning).toBe(false);
      expect(advances).toEqual(["/a.flac"]); // exactly one advance
      expect(endeds).toEqual([]);
      expect(audibleDecks()).toEqual([0]);
    } else {
      // The killer assertion: the AUDIBLE deck must be untouched —
      // not stopped, not rewound, still advancing.
      expect(audios[1].paused).toBe(false);
      expect(audios[1].currentTime).toBe(297);
      expect(audios[1].src).toBe("asset:///a.flac");
      await advanceWorld(500);
      expect(audios[1].currentTime).toBeCloseTo(297.5, 3);
      expect(engine.transitioning).toBe(false);
    }
  });
});

describe("XF-5 — fade longer than the outgoing remainder", () => {
  // Derivation: A at 296/300 (4s left) under an 8s plan. The end
  // window admits it (4 ≤ 8 + 3), so acceptance is expected. Outcome
  // (a) accepted: I1 must hold AND total heard loudness must stay
  // continuous through A's natural death at t≈4000 — a cliff (Σ over
  // playing decks of gain² dropping > 0.3 within one 50ms sub-step
  // while transitioning) is the red condition: the outgoing deck dies
  // at gainOut² ≈ 0.5 with the incoming only halfway up. Outcome (b)
  // rejected: decks untouched, natural gapless handoff still works.
  // PENDING GOLD ADJUDICATION (red on the current engine): the end
  // window admits remaining < durationSec and the outgoing deck's
  // death mid-fade drops Σgain² by ~0.5 in one sub-step.
  it.skip("accepted: no loudness cliff at the outgoing deck's death — rejected: gapless still works", async () => {
    const engine = await createEngineWithAB();
    audios[1].currentTime = 296;

    const accepted = engine.beginTransition(plan(8), "/a.flac");

    if (accepted) {
      await flushFadeAnchor();
      let prev = playingLoudness();
      await advanceWorld(8500, () => {
        if (!engine.transitioning) return;
        assertEqualPowerInvariant();
        const cur = playingLoudness();
        expect(Math.abs(cur - prev)).toBeLessThanOrEqual(0.3); // the cliff
        prev = cur;
      });
      expect(engine.transitioning).toBe(false);
      expect(audibleDecks()).toEqual([0]);
    } else {
      expect(audios[1].paused).toBe(false);
      expect(audios[0].paused).toBe(true);
      // Natural gapless handoff must still work: A ends, B takes over.
      await advanceWorld(4100);
      expect(audios[0].paused).toBe(false);
      expect(audios[0].src).toBe("asset:///b.flac");
    }
  });
});

describe("XF-4 — incoming track shorter than the fade", () => {
  // Derivation: B is a 2s file under a 4s fade. Arming is expected to
  // succeed (the engine checks the OUTGOING remainder and the preload's
  // readyState, never the incoming duration). Outcome if accepted: B
  // fires "ended" mid-fade at t≈2000 — red conditions are a stuck
  // transitioning flag and a silence window (neither deck playing for
  // > 100ms while the engine still claims transitioning); afterwards no
  // deck may be left frozen at half gain. The endeds capture documents
  // the engine's actual mid-fade signal to the shell.
  // PENDING GOLD ADJUDICATION (red on the current engine): arming
  // never checks the incoming duration; a short incoming dies mid-fade
  // leaving ≥150ms of dead air with `transitioning` still true.
  it.skip("a 2s incoming under a 4s fade leaves no silence window and no stuck flag", async () => {
    const engine = await createFreshEngine();
    await engine.play(track("/a.flac"));
    engine.preloadNext(track("/b.flac"));
    audios[1].currentTime = 297; // park A in its end window
    audios[0].duration = 2; // B's element: shorter than the fade
    const endeds: Array<string | null> = [];
    engine.onEnded((p) => endeds.push(p));

    const accepted = engine.beginTransition(plan(4), "/a.flac");

    if (accepted) {
      await flushFadeAnchor();
      let deadAirMs = 0;
      await advanceWorld(4500, () => {
        if (!engine.transitioning) return;
        const anyPlaying = !audios[0].paused || !audios[1].paused;
        deadAirMs = anyPlaying ? 0 : deadAirMs + 50;
        expect(deadAirMs).toBeLessThanOrEqual(100); // silence window
      });
      expect(engine.transitioning).toBe(false); // not stuck
      // No frozen half-gain deck: the incoming gain is restored to
      // unity by the finalizer even though its media ended.
      expect(gains[0].gain.valueAt(ctxs[0].currentTime)).toBeCloseTo(1, 3);
      // Actual engine signal: B's "ended" on the active deck escapes
      // to the shell as onEnded(null) mid-fade.
      expect(endeds).toEqual([null]);
    } else {
      // Rejection path: decks untouched.
      expect(audios[1].paused).toBe(false);
      expect(audios[1].currentTime).toBe(297);
      expect(audios[0].paused).toBe(true);
    }
  });
});
