// SILVER layer — eval-expansion round 3 (protocol: docs/design/
// eval-expansion-round1.md). Player-surface utilities domain: seekbar,
// gain, lyricfollow, vizidle. Cases generated adversarially from the
// module contracts by a blind generator (no implementation, no
// existing tests in context), then adjudicated against the current
// implementations. Each case carries its derivation. Silver semantics:
// append-only for the model; a human may revoke any case (gold wins).
//
// Dedup record (exactly-covered assertions skipped, not re-asserted):
// - PU-1 (partial): seekMax(NaN)/Infinity → 0 covered by seekbar.test
//   "renders a dead slider"; only -Infinity implemented below.
// - PU-4: seekShown clamp (null-position and scrub, both over max) is
//   exactly the behavior of seekbar.test "clamps both to the track
//   length" — dup, skipped.
// - PU-5: sliderFill(·, 0/NaN/Infinity) → "0%" is exactly seekbar.test
//   "renders an empty track when max is dead" — dup, skipped.
// - PU-6 (partial): the clamp legs (-5→"0.0%", overshoot→"100.0%") are
//   exactly seekbar.test "clamps overshoot and negatives"; only the
//   non-round decimal case (127, 300) implemented below.
// - PU-7 (partial): effectiveGain(null) → 1 is exactly gain.test "null
//   gain means unity"; only the null × volume composition implemented.
// - PU-10: the exact >= boundary (elapsed == FOLLOW_GRACE_MS → true)
//   is exactly lyricfollow.test "resumes once the grace window has
//   passed" (10_000 + FOLLOW_GRACE_MS vs 10_000) — dup, skipped.
// - PU-12: shouldKeepDrawing(false, 0) → true is exactly vizidle.test
//   "always draws while playing" — dup, skipped.

import { describe, expect, it } from "vitest";
import { seekMax, seekShown, sliderFill } from "./seekbar";
import { effectiveGain } from "./gain";
import { shouldFollow } from "./lyricfollow";
import { shouldKeepDrawing } from "./vizidle";

describe("silver: seekMax non-finite and negative durations (PU-1, PU-2)", () => {
  // Derivation: "dead slider until metadata" pushed across the whole
  // non-finite family — existing coverage stops at NaN/+Infinity.
  it("renders a dead slider for -Infinity too (PU-1)", () => {
    expect(seekMax(-Infinity)).toBe(0);
  });

  // GOLD RULING 2026-07-15: keep as-is (corrupt negative durations do
  // not occur from the index; finite passthrough locked). Spec argued seekMax(-3.5)
  // should be 0 — a negative duration is corrupt metadata, and a range
  // control with max < min renders a dead-but-broken slider (UX
  // argument: same treatment as NaN/∞). The current implementation
  // guards only with Number.isFinite and passes -3.5 through. Contract
  // comment says "finite duration, or 0" — silent on sign, so both
  // behaviors are defensible; asserting the ACTUAL until gold rules.
  it("passes a negative finite duration through (PU-2, actual behavior)", () => {
    expect(seekMax(-3.5)).toBe(-3.5);
  });
});

describe("silver: seekShown zero-scrub falsiness trap (PU-3)", () => {
  // Derivation: scrub = 0 is a valid drag-to-start; an implementation
  // that tests scrub truthiness (|| instead of ??) would snap back to
  // the live position mid-drag. Existing coverage only uses a nonzero
  // scrub, so the falsiness trap is unprobed.
  it("previews a drag to the very start (scrub 0 is not 'no scrub')", () => {
    expect(seekShown(0, 187.2, 300)).toBe(0);
  });
});

describe("silver: sliderFill decimal precision mid-range (PU-6)", () => {
  // Derivation: the contract promises a single-decimal CSS percent;
  // existing coverage only exercises round values (25.0, 100.0). A
  // non-round ratio catches rounding-direction and formatting drift.
  it("formats a non-round ratio to one decimal", () => {
    expect(sliderFill(127, 300)).toBe("42.3%");
  });
});

describe("silver: effectiveGain composition with user volume (PU-7, PU-8)", () => {
  // Derivation: "absence of data is not a correction" × user volume —
  // null must contribute exactly unity, so the result IS the volume.
  it("null RG with volume returns the volume exactly (PU-7)", () => {
    expect(effectiveGain(null, 0.5)).toBe(0.5);
  });

  // Derivation: the headroom cap must apply to the RG factor BEFORE
  // the volume multiply — capping the product instead would wrongly
  // limit loud volume settings. 18 dB → 7.943 linear, capped to 4,
  // then × 2 volume = 8 (> MAX_LINEAR, proving cap-then-scale order).
  it("caps the RG factor before scaling by volume (PU-8)", () => {
    expect(effectiveGain(18, 2)).toBe(8);
  });
});

describe("silver: effectiveGain NaN replaygain (PU-9)", () => {
  // Derivation: "null (no RG data) is unity" — NaN is equally
  // no-data, and a NaN reaching the engine's GainNode silences the
  // output entirely (Web Audio treats NaN gain as broken). Clear-bug
  // red per the spec's anchor: NaN must degrade to the null path.
  // Actual: NaN == null is false, so Math.min(4, 10^(NaN/20)) = NaN
  // and NaN * 0.7 = NaN reaches the caller.
  // Reachability note: replaygain_db is number|null from the Rust
  // index, so a NaN is unlikely from the normal path; only a
  // hypothetical tag-parsing edge could produce it. Gold may rule
  // won't-fix on reachability grounds.
  // Gold-adjudicated 2026-07-15, fixed: NaN now falls back to unity
  // like null. Was: actual NaN.
  it("treats NaN replaygain as no-data and returns the volume", () => {
    expect(effectiveGain(NaN, 0.7)).toBe(0.7);
  });
});

describe("silver: shouldFollow under backwards clock skew (PU-11)", () => {
  // GOLD RULING 2026-07-15: keep as-is (no production call site yet;
  // performance.now() is monotonic when Stage wires it). Spec noted: nowMs < lastManualScrollMs
  // (elapsed -9000ms) — the spec argues TRUE ("never freeze"): the
  // asymmetric cost is a lyrics pane frozen until the wall clock
  // catches up (~13s here) versus one spurious re-centering. The
  // current implementation returns FALSE (-9000 >= 4000 fails), i.e.
  // it stays paused through the skew. The contract is silent on
  // non-monotonic time, so both behaviors are defensible.
  // Reachability note: shouldFollow has no production call site yet
  // (only tests reference it); if the eventual caller feeds
  // performance.now() — monotonic by spec — backwards skew is
  // unreachable and this stays theoretical. Asserting the ACTUAL.
  it("stays paused when the clock runs backwards (actual behavior)", () => {
    expect(shouldFollow(1000, 10_000)).toBe(false);
  });
});

describe("silver: shouldKeepDrawing epsilon boundary and NaN motion (PU-13, PU-14)", () => {
  // Derivation: "motion below this is invisible" + strict > — motion
  // exactly AT the epsilon is invisible, so the loop stops; existing
  // coverage brackets the boundary (0.0005, 0.4) without touching it.
  it("stops exactly at the epsilon, keeps drawing just above (PU-13)", () => {
    expect(shouldKeepDrawing(true, 0.001)).toBe(false);
    expect(shouldKeepDrawing(true, 0.0011)).toBe(true);
  });

  // Derivation: a NaN from a broken analyser read must fail toward
  // stopping the loop (safe direction: a stuck frame, not a stuck
  // 60fps burn). NaN > epsilon is false, so the loop stops.
  it("stops the loop on NaN motion while paused (PU-14)", () => {
    expect(shouldKeepDrawing(true, NaN)).toBe(false);
  });
});
