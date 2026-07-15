// SILVER layer — eval-expansion round 3 (protocol: docs/design/
// eval-expansion-round1.md). Row-virtualization/scroll-math domain.
// Cases generated adversarially from the virtualwindow contract by a
// blind generator (no implementation, no existing tests in context),
// then adjudicated against the current engine. Round-2 semantics:
// greens assert the actual engine output; clear-bug reds (invariant
// violations) are it.skip asserting the SPEC expectation, marked
// "PENDING GOLD ADJUDICATION"; preference-call reds assert ACTUAL,
// marked "RED-CANDIDATE (gold ruling pending)". Silver is append-only
// for the model; a human may revoke any case (gold wins).
//
// Dedup log (specs exactly covered by gold, skipped):
// - VW-7a  reveal-down bottom-align — gold "scrolls down just enough".
// - VW-10  centerOffset clamps to 0 / to max — gold lines 118-126
//          cover both clamp ends; scale difference only.
// - VW-12c rowWindow whole-list-fits — gold "renders the whole list
//          when it fits in the viewport".

import { describe, expect, it } from "vitest";
import {
  centerOffset,
  reanchorOffset,
  revealOffset,
  rowWindow,
  type RowWindow,
} from "./virtualwindow";

// Universal rowWindow invariants asserted in every green case:
// 0 ≤ start ≤ end ≤ total; padTop = start·rowHeight;
// padTop + padBottom + (end−start)·rowHeight = total·rowHeight; pads ≥ 0.
function expectWindowInvariants(w: RowWindow, rowHeight: number, total: number) {
  expect(w.start).toBeGreaterThanOrEqual(0);
  expect(w.end).toBeGreaterThanOrEqual(w.start);
  expect(w.end).toBeLessThanOrEqual(total);
  expect(w.padTop).toBe(w.start * rowHeight);
  expect(w.padTop).toBeGreaterThanOrEqual(0);
  expect(w.padBottom).toBeGreaterThanOrEqual(0);
  expect(w.padTop + w.padBottom + (w.end - w.start) * rowHeight).toBe(total * rowHeight);
}

describe("silver: fractional scrollTop misalignment (VW-1)", () => {
  // Derivation: "every pixel-visible row is rendered" × misaligned
  // scrollTop. visibleCount = ceil(viewport/rowHeight) counts aligned
  // rows only; a fractional offset makes the band straddle one more
  // row boundary than the count covers.

  // PENDING GOLD ADJUDICATION (red on the current engine): actual
  // { start: 9, end: 19 }. Band [99.5, 199.5] touches rows 9..19
  // (11 rows), but firstVisible=floor(9.95)=9 + visibleCount=ceil(10)=10
  // renders only rows 9..18; row 19 ([190,200]) is visible at
  // [190,199.5] yet unrendered → visible gap, breaking the no-gap
  // invariant. Never shipped visibly because LibraryTable.tsx passes
  // overscan: 8 (line 146), which papers over the one-row undercount.
  it.skip("renders the partially visible last row under a fractional scrollTop", () => {
    const w = rowWindow({ scrollTop: 99.5, viewport: 100, rowHeight: 10, total: 5000, overscan: 0 });
    expect(w.start).toBe(9);
    expect(w.end).toBe(20); // spec: last touched row 19 must be inside [start, end)
  });

  it("overscan 1 already papers over the fractional undercount (companion, green)", () => {
    const w = rowWindow({ scrollTop: 99.5, viewport: 100, rowHeight: 10, total: 5000, overscan: 1 });
    expect(w).toEqual({ start: 8, end: 20, padTop: 80, padBottom: (5000 - 20) * 10 });
    expectWindowInvariants(w, 10, 5000);
  });
});

describe("silver: rowWindow at exact and out-of-range offsets", () => {
  // Derivation: the aligned baseline plus the two scroll positions a
  // browser can actually produce outside [0, max]: rubber-banding
  // (negative) and momentum overshoot (past the end).

  it("exactly aligned scrollTop renders precisely the visible rows (VW-2)", () => {
    const w = rowWindow({ scrollTop: 100, viewport: 100, rowHeight: 10, total: 5000, overscan: 0 });
    expect(w).toEqual({ start: 10, end: 20, padTop: 100, padBottom: 49800 });
    expectWindowInvariants(w, 10, 5000);
  });

  it("negative scrollTop clamps start to 0 without a gap (VW-3, green adjusted)", () => {
    // Spec predicted end=10 (overscan counted from the clamped band);
    // actual convention counts visibleCount+overscan from the
    // UNCLAMPED firstVisible=-3, giving end=min(5000, -3+10+2)=9.
    // No gap: band [-25,75] ends in row 7 ([70,80]), rendered ✓.
    // (At overscan 0 this same convention would undercount — that
    // family is the VW-1/VW-5 red; here the invariant holds.)
    const w = rowWindow({ scrollTop: -25, viewport: 100, rowHeight: 10, total: 5000, overscan: 2 });
    expect(w).toEqual({ start: 0, end: 9, padTop: 0, padBottom: (5000 - 9) * 10 });
    expectWindowInvariants(w, 10, 5000);
  });

  it("overscroll past the end renders zero rows with full padTop (VW-4)", () => {
    // firstVisible=5005 > total: start clamps to total=5000, end too →
    // start=end (nothing rendered — nothing IS visible past the end).
    // Identity still holds: 50000 + 0 + 0·10 = 5000·10 ✓.
    const w = rowWindow({ scrollTop: 50050, viewport: 100, rowHeight: 10, total: 5000, overscan: 1 });
    expect(w).toEqual({ start: 5000, end: 5000, padTop: 50000, padBottom: 0 });
    expectWindowInvariants(w, 10, 5000);
  });
});

describe("silver: sub-row viewport (VW-5)", () => {
  // Derivation: viewport < rowHeight — visibleCount=ceil(0.6)=1 can
  // never cover a band that straddles a row boundary. Same undercount
  // class as VW-1, kept as a separate id (distinct trigger: tiny
  // viewport rather than fractional scrollTop).

  // PENDING GOLD ADJUDICATION (red on the current engine): actual
  // { start: 9, end: 10 } — only row 9 rendered, but the band
  // [95, 101] also shows row 10 at [100, 101] → visible gap.
  it.skip("renders both rows straddled by a viewport smaller than a row", () => {
    const w = rowWindow({ scrollTop: 95, viewport: 6, rowHeight: 10, total: 100, overscan: 0 });
    expect(w.start).toBe(9);
    expect(w.end).toBe(11); // spec: rows 9 and 10 both touch the band
  });
});

describe("silver: revealOffset header math and idempotence", () => {
  const VIEW = { viewport: 400, rowHeight: 10, headroom: 30 };

  // Derivation: "reveal is a fixpoint — applying the returned offset
  // and asking again yields null", probed at the extremes (row 0 from
  // deep scroll, last row of a large list, negative scrollTop).

  it("reveals row 0 from deep scroll at exactly 0, then null (VW-6)", () => {
    expect(revealOffset({ index: 0, scrollTop: 500, ...VIEW })).toBe(0);
    expect(revealOffset({ index: 0, scrollTop: 0, ...VIEW })).toBeNull();
  });

  it("reveals the very last row bottom-aligned, then null (VW-7b; 7a dup, skipped)", () => {
    // Row 4999 bottom = 30 + 5000·10 = 50030; align to viewport bottom.
    const off = revealOffset({ index: 4999, scrollTop: 0, ...VIEW });
    expect(off).toBe(49630);
    expect(revealOffset({ index: 4999, scrollTop: 49630, ...VIEW })).toBeNull();
  });

  it("treats a rubber-banded (negative) scrollTop consistently (VW-8)", () => {
    // (a) Row 0: top 30 ≥ viewTop -20, bottom 40 ≤ viewBottom 350 → null.
    expect(revealOffset({ index: 0, scrollTop: -50, ...VIEW })).toBeNull();
    // (b) Row 50: bottom 540 > 350 → bottom-align at 540 - 400 = 140.
    expect(revealOffset({ index: 50, scrollTop: -50, ...VIEW })).toBe(140);
  });

  // PENDING GOLD ADJUDICATION (red on the current engine): when
  // usable viewport (viewport - headroom = 8) < rowHeight (10) the
  // row can never fit; the reveal↔apply cycle never reaches null.
  // Trace (index 20, top=230, bottom=240): scrollTop 0 → 202
  // (bottom-align); scrollTop 202 → viewTop 232 > 230 → 200
  // (top-align); scrollTop 200 → viewBottom 238 < 240 → 202.
  // Ping-pong 200 ↔ 202 forever — a caller looping "reveal until
  // null" hangs. Spec: the second call must return null (fixpoint).
  it.skip("reaches a fixpoint even when the usable viewport is smaller than a row (VW-9)", () => {
    const first = revealOffset({ index: 20, scrollTop: 0, viewport: 38, rowHeight: 10, headroom: 30 });
    expect(first).toBe(202);
    expect(revealOffset({ index: 20, scrollTop: first!, viewport: 38, rowHeight: 10, headroom: 30 })).toBeNull();
  });
});

describe("silver: centerOffset degenerate viewport (VW-11)", () => {
  // Derivation: usable = viewport - headroom hits 0 and goes negative
  // (tiny window, tall sticky header) — division/centering math must
  // stay finite and inside the scroll range.

  it("viewport equal to headroom aligns the row top, finite and in range (VW-11a, green adjusted)", () => {
    // Spec predicted 105 (centering the row midpoint in the
    // zero-height usable area); actual convention: usable=0 →
    // lead=max(0, floor((0-10)/2))=0 → row-top alignment at 100.
    // Convention difference only; finite + in [0, maxScroll] holds.
    expect(centerOffset({ index: 10, viewport: 30, rowHeight: 10, headroom: 30, total: 100 })).toBe(100);
  });

  it("viewport smaller than headroom stays finite (VW-11b, green adjusted)", () => {
    // usable = -10 → lead clamps to 0 → 100; clampScroll keeps it.
    expect(centerOffset({ index: 10, viewport: 20, rowHeight: 10, headroom: 30, total: 100 })).toBe(100);
  });
});

describe("silver: short list where everything fits (VW-12)", () => {
  // Derivation: total·rowHeight + headroom < viewport — the scroll
  // range is empty (max scroll would be negative), so every scroll
  // helper must answer "stay at 0 / already visible". (12c rowWindow
  // whole-list-fits: dup of gold, skipped.)

  it("centerOffset clamps to 0 when the max scroll is negative (VW-12a)", () => {
    // Unclamped 20 - 180 = -160; clampScroll's upper bound is itself
    // negative (30 + 50 - 400 = -320), and max(0, ·) wins → 0.
    expect(centerOffset({ index: 2, viewport: 400, rowHeight: 10, headroom: 30, total: 5 })).toBe(0);
  });

  it("revealOffset is null for every row of a fully visible list (VW-12b)", () => {
    expect(revealOffset({ index: 4, scrollTop: 0, viewport: 400, rowHeight: 10, headroom: 30 })).toBeNull();
  });
});

describe("silver: reanchor wasVisible boundary precision (VW-13)", () => {
  // Derivation: wasVisible = oldTop ≥ scrollTop+headroom AND
  // oldTop+rowHeight ≤ scrollTop+viewport — both comparisons probed
  // exactly at and one row past each edge. scrollTop 1000 → the
  // usable band is [1030, 1400]; rows 100..136 qualify.
  const base = { viewport: 400, rowHeight: 10, headroom: 30, total: 5000, scrollTop: 1000, newIndex: 200 };

  it("row top exactly at the header edge counts as visible (oldIndex 100)", () => {
    // oldTop 1030 ≥ 1030 → preserve: 30 + 2000 - (1030 - 1000) = 2000.
    expect(reanchorOffset({ ...base, oldIndex: 100 })).toBe(2000);
  });

  it("one row higher sits under the sticky header → centers (oldIndex 99)", () => {
    // oldTop 1020 < 1030 → centerOffset(200) = 2000 - 180 = 1820.
    expect(reanchorOffset({ ...base, oldIndex: 99 })).toBe(1820);
  });

  it("row bottom exactly at the viewport bottom counts as visible (oldIndex 136)", () => {
    // oldTop 1390, bottom 1400 ≤ 1400 → 30 + 2000 - 390 = 1640.
    expect(reanchorOffset({ ...base, oldIndex: 136 })).toBe(1640);
  });

  it("one row lower is clipped by the fold → centers (oldIndex 137)", () => {
    // bottom 1410 > 1400 → center 1820.
    expect(reanchorOffset({ ...base, oldIndex: 137 })).toBe(1820);
  });

  it("unknown previous position (-1) centers (oldIndex -1)", () => {
    expect(reanchorOffset({ ...base, oldIndex: -1 })).toBe(1820);
  });
});

describe("silver: reanchor preserved offset clamps at the max end (VW-14)", () => {
  // Derivation: preserving the viewport offset for a row moved near
  // the tail overshoots the scroll range. Gold covers the clamp-to-0
  // end of this path only; the max-scroll end is new.
  it("clamps the preserved offset to the max scroll", () => {
    // oldIndex 110 (oldTop 1130, visible in [1030, 1400]); unclamped
    // 30 + 49950 - 130 = 49850 > max 30 + 50000 - 400 = 49630.
    const off = reanchorOffset({
      oldIndex: 110,
      newIndex: 4995,
      scrollTop: 1000,
      viewport: 400,
      rowHeight: 10,
      headroom: 30,
      total: 5000,
    });
    expect(off).toBe(49630);
  });
});
