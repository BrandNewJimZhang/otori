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
  // Gold-adjudicated 2026-07-15: real bug, fixed — togglePause now
  // finalizes an in-flight transition (outgoing retires, incoming at
  // full gain) before pausing, the same idiom as seek.
  it("freezes both media clocks while paused and lands cleanly after unpause", async () => {
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
  // Gold-adjudicated 2026-07-15: real bug, fixed — the fade duration
  // now clamps to the outgoing remainder at arming, so the ramp
  // reaches silence exactly as the media ends.
  it("accepted: no loudness cliff at the outgoing deck's death — rejected: gapless still works", async () => {
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
  // Gold-adjudicated 2026-07-15: real bug, fixed — the fade duration
  // also clamps to the incoming remainder, so a short incoming
  // reaches unity exactly at its natural end (which then advances the
  // shell as any track end would).
  it("a 2s incoming under a 4s fade leaves no silence window and no stuck flag", async () => {
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

// ---------------------------------------------------------------------------
// Eval-expansion round 2 — the four remaining specs from round 1's blind
// generation (XF-2, XF-7, XF-8, XF-10), adjudicated against the post-
// round-1 engine (togglePause finalizes an in-flight transition; the
// fade duration clamps to both decks' remainders at arming).
// ---------------------------------------------------------------------------

describe("XF-2 — manual skip (play a new track) at fade midpoint", () => {
  // Derivation: 2s into a 4s crossfade the user skips to Z — the shell's
  // step() calls engine.play(). Engine reading: play() runs
  // cancelTransition() first (epoch bump strands the anchor, timer
  // cleared, curves cancelled, static gains restored), then Z lands on
  // the idle deck — which mid-fade is the OUTGOING deck (ownership
  // flipped at arm), so A's element is src-swapped to Z and B (the
  // fade's incoming deck) retires as "previous". Expected: a
  // deterministic teardown — transitioning false once Z sounds, exactly
  // one audible source (Z at unity base gain), no residual automation
  // on either old gain, and no advance/ended callback after the skip
  // that would move the queue past Z. Harness note: A parks at 294
  // (6s left) so the 4s plan is unclamped and 2000ms is the true
  // midpoint — at the default 297 the round-1 clamp shortens the fade
  // to 3s.
  it("tears the fade down deterministically: one audible source, static gains, no late callbacks", async () => {
    const engine = await createEngineWithAB();
    audios[1].currentTime = 294;
    const advances: string[] = [];
    const endeds: Array<string | null> = [];
    engine.onTransitionAdvance((p) => advances.push(p));
    engine.onEnded((p) => endeds.push(p));

    expect(engine.beginTransition(plan(4), "/a.flac")).toBe(true);
    await flushFadeAnchor();
    expect(advances).toEqual(["/b.flac"]); // the one arm-time advance
    await advanceWorld(2000, () => {
      if (engine.transitioning) assertEqualPowerInvariant();
    });

    await engine.play(track("/z.flac")); // the shell's step() on user skip

    // Z sounds on deck 1 (the old outgoing element, src-swapped);
    // deck 0 (the fade's incoming) retired as "previous".
    expect(engine.transitioning).toBe(false); // no stuck flag
    expect(audios.length).toBe(2); // no third source exists at all
    expect(audios[1].src).toBe("asset:///z.flac");
    expect(audibleDecks()).toEqual([1]); // Z alone
    expect(gains[1].gain.valueAt(ctxs[0].currentTime)).toBe(1); // at unity

    await advanceWorld(5000, () => {
      expect(engine.transitioning).toBe(false);
      expect(audibleDecks()).toEqual([1]); // never zero, never two
      const t = ctxs[0].currentTime;
      // No residual automation: valueAt equals the static value on
      // BOTH old gains — a curve still mid-flight would diverge.
      expect(gains[0].gain.valueAt(t)).toBe(gains[0].gain.value);
      expect(gains[1].gain.valueAt(t)).toBe(gains[1].gain.value);
      expect(gains[1].gain.valueAt(t)).toBe(1);
    });
    // No callback after the skip may advance the queue past Z.
    expect(advances).toEqual(["/b.flac"]);
    expect(endeds).toEqual([]);
  });
});

describe("XF-7 — togglePause landing on the fade's terminal sample", () => {
  // Derivation: pause arrives in the same sub-step as the finalize
  // timer's expiry (~3950ms of a 4s fade). Two legal serializations —
  // pause-after-completion (timer won: transition already finalized,
  // togglePause just pauses B) and pause-before (round-1 fix:
  // togglePause finalizes first, then pauses). Both converge on the
  // same end state: B paused at full gain, A retired, world silent.
  // The test probes which one ran (at 3950ms the 4000ms timer has not
  // fired, so pause-before is the deterministic choice), then asserts
  // the shared end state, the silent paused window (no callback beyond
  // the arm-time advance), and a one-sub-step resume at gain² ≈ 1.
  // Harness note: A parks at 294 so the 4s plan is unclamped and the
  // terminal sample really sits at ~4000ms.
  it("pause at the terminal sample lands silent; resume restores one deck at unity", async () => {
    const engine = await createEngineWithAB();
    audios[1].currentTime = 294;
    const advances: string[] = [];
    engine.onTransitionAdvance((p) => advances.push(p));

    expect(engine.beginTransition(plan(4), "/a.flac")).toBe(true);
    await flushFadeAnchor();
    await advanceWorld(3950, () => {
      if (engine.transitioning) assertEqualPowerInvariant();
    });

    // Probe the serialization the engine took.
    const finalizedBeforePause = !engine.transitioning;
    expect(finalizedBeforePause).toBe(false); // pause-before path
    engine.togglePause();

    expect(engine.transitioning).toBe(false); // not stuck while paused
    expect(audios[0].paused).toBe(true); // incoming paused...
    expect(gains[0].gain.valueAt(ctxs[0].currentTime)).toBe(1); // ...at unity
    expect(audios[1].paused).toBe(true); // A not sounding through the pause
    expect(audios[1].src).toBe(""); // retired, not parked

    // The fade window's remainder plus a paused stretch: silent, the
    // original timer slot passes inertly, no further advances.
    await advanceWorld(1100, () => {
      expect(engine.transitioning).toBe(false);
      expect(audios[0].paused).toBe(true);
      expect(audios[1].paused).toBe(true);
      expect(playingLoudness()).toBe(0);
    });
    expect(advances).toEqual(["/b.flac"]); // only the arm-time advance

    engine.togglePause(); // resume within +2000ms
    await advanceWorld(50, () => {
      // Within one sub-step: exactly one audible deck at gain² ≈ 1 —
      // no half-gain relic, no loudness jump beyond pause→unity.
      expect(audibleDecks()).toEqual([0]);
      expect(playingLoudness()).toBeCloseTo(1, 2);
    });
    await advanceWorld(850, () => {
      expect(audibleDecks()).toEqual([0]);
      expect(playingLoudness()).toBeCloseTo(1, 2);
    });
    expect(advances).toEqual(["/b.flac"]);
  });
});

describe("XF-8 — outgoing deck with non-finite duration", () => {
  // Derivation: a live stream (duration = Infinity) or missing metadata
  // (NaN) makes `remaining` non-finite. Engine reading: the end-window
  // check is `Number.isFinite(remaining) && remaining > durationSec + 3`
  // — non-finite remaining short-circuits the check to "pass", so the
  // plan is ACCEPTED (not rejected!), and the round-1 clamp also guards
  // with Number.isFinite, leaving the full 8s duration. Adjudicated:
  // acceptance is fine as long as nothing non-finite reaches a gain
  // curve, I1 holds throughout, the wall-clock timer finalizes (the
  // outgoing deck never fires "ended" — its duration is unreachable),
  // A is hard-stopped afterward (paused, src removed — not left rolling
  // silently), and exactly one advance fires.
  const armWithOutgoingDuration = async (duration: number) => {
    const engine = await createFreshEngine();
    await engine.play(track("/a.flac"));
    engine.preloadNext(track("/b.flac"));
    audios[1].duration = duration;
    audios[1].currentTime = 42;
    return engine;
  };

  for (const [label, duration] of [
    ["Infinity", Infinity],
    ["NaN (metadata never loaded)", Number.NaN],
  ] as const) {
    it(`duration = ${label}: finite gains, timer-driven finalize, A hard-stopped`, async () => {
      const engine = await armWithOutgoingDuration(duration);
      const advances: string[] = [];
      const endeds: Array<string | null> = [];
      engine.onTransitionAdvance((p) => advances.push(p));
      engine.onEnded((p) => endeds.push(p));

      expect(engine.beginTransition(plan(8), "/a.flac")).toBe(true);
      await flushFadeAnchor();

      // Nothing non-finite reached the scheduled automation itself.
      for (const g of [gains[0], gains[1]]) {
        expect(g.gain.setValueCurveAtTime).toHaveBeenCalledTimes(1);
        const curve = g.gain.setValueCurveAtTime.mock.calls[0][0];
        expect(curve.every((v) => Number.isFinite(v))).toBe(true);
      }

      await advanceWorld(8500, () => {
        const t = ctxs[0].currentTime;
        expect(Number.isFinite(gains[0].gain.valueAt(t))).toBe(true);
        expect(Number.isFinite(gains[1].gain.valueAt(t))).toBe(true);
        if (engine.transitioning) assertEqualPowerInvariant();
      });

      // The wall-clock timer finalized: A hard-stopped, not left
      // rolling silently on the idle deck.
      expect(engine.transitioning).toBe(false);
      expect(audios[1].paused).toBe(true);
      expect(audios[1].src).toBe("");
      expect(audibleDecks()).toEqual([0]);
      expect(gains[0].gain.valueAt(ctxs[0].currentTime)).toBeCloseTo(1, 3);
      expect(advances).toEqual(["/b.flac"]); // exactly one advance
      expect(endeds).toEqual([]);
    });
  }
});

describe("XF-10 — beginTransition while playback is paused", () => {
  // Derivation: the plan's premise is "this playback is ending NOW" —
  // a paused deck is not ending. Engine reading: beginTransition checks
  // `if (from.audio.paused) return false` before touching anything, so
  // rejection with zero side effects is expected: A frozen at its
  // position, B parked with src set and not playing, no callbacks, no
  // queued/deferred transition firing later on its own. Resume must
  // restore the premise: A plays on, and the same arm now returns true.
  it("rejects with zero side effects; after resume the same arm succeeds", async () => {
    const engine = await createEngineWithAB();
    const advances: string[] = [];
    const endeds: Array<string | null> = [];
    engine.onTransitionAdvance((p) => advances.push(p));
    engine.onEnded((p) => endeds.push(p));

    engine.togglePause(); // A paused in its end window
    expect(audios[1].paused).toBe(true);

    expect(engine.beginTransition(plan(4), "/a.flac")).toBe(false);

    expect(engine.transitioning).toBe(false);
    await advanceWorld(2000, () => {
      // No deck state change, and no deferred transition fires later.
      expect(engine.transitioning).toBe(false);
      expect(audios[1].paused).toBe(true);
      expect(audios[1].currentTime).toBe(297); // A frozen at its position
      expect(audios[0].paused).toBe(true);
      expect(audios[0].currentTime).toBe(0);
      expect(audios[0].src).toBe("asset:///b.flac"); // B still parked
    });
    expect(advances).toEqual([]);
    expect(endeds).toEqual([]);

    engine.togglePause(); // resume: normal life continues
    await advanceWorld(500);
    expect(audios[1].paused).toBe(false);
    expect(audios[1].currentTime).toBeCloseTo(297.5, 3);

    // The premise holds again: a re-arm now succeeds.
    expect(engine.beginTransition(plan(4), "/a.flac")).toBe(true);
  });
});
