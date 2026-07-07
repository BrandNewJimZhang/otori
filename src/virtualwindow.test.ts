// Row virtualization math: which slice of a fixed-row-height list is
// on screen, plus the spacer heights that keep the scrollbar honest.

import { describe, expect, it } from "vitest";
import { revealOffset, rowWindow } from "./virtualwindow";

const ROW = 30;

describe("rowWindow", () => {
  it("renders from the top with overscan below", () => {
    const w = rowWindow({ scrollTop: 0, viewport: 300, rowHeight: ROW, total: 1000, overscan: 4 });
    expect(w.start).toBe(0);
    // 300/30 = 10 visible rows, + 4 overscan below (no rows above 0).
    expect(w.end).toBe(14);
    expect(w.padTop).toBe(0);
    expect(w.padBottom).toBe((1000 - 14) * ROW);
  });

  it("keeps overscan rows on both sides once scrolled", () => {
    const w = rowWindow({ scrollTop: 3000, viewport: 300, rowHeight: ROW, total: 1000, overscan: 4 });
    // first visible row = 3000/30 = 100; overscan pulls start back 4.
    expect(w.start).toBe(96);
    expect(w.end).toBe(114);
    expect(w.padTop).toBe(96 * ROW);
    expect(w.padBottom).toBe((1000 - 114) * ROW);
  });

  it("clamps the tail so it never renders past the last row", () => {
    const w = rowWindow({ scrollTop: 29700, viewport: 300, rowHeight: ROW, total: 1000, overscan: 4 });
    expect(w.end).toBe(1000);
    expect(w.padBottom).toBe(0);
    // Every visible row is still covered near the bottom.
    expect(w.start).toBeLessThanOrEqual(990);
  });

  it("renders the whole list when it fits in the viewport", () => {
    const w = rowWindow({ scrollTop: 0, viewport: 600, rowHeight: ROW, total: 5, overscan: 4 });
    expect(w.start).toBe(0);
    expect(w.end).toBe(5);
    expect(w.padTop).toBe(0);
    expect(w.padBottom).toBe(0);
  });

  it("handles an empty list without negative padding", () => {
    const w = rowWindow({ scrollTop: 0, viewport: 300, rowHeight: ROW, total: 0, overscan: 4 });
    expect(w.start).toBe(0);
    expect(w.end).toBe(0);
    expect(w.padTop).toBe(0);
    expect(w.padBottom).toBe(0);
  });

  it("never lets padTop or padBottom go negative on overscroll", () => {
    const w = rowWindow({ scrollTop: 999999, viewport: 300, rowHeight: ROW, total: 20, overscan: 4 });
    expect(w.padTop).toBeGreaterThanOrEqual(0);
    expect(w.padBottom).toBe(0);
    expect(w.end).toBe(20);
  });

  it("keeps a scrolled-to index within the rendered window", () => {
    // Selecting a row far down then virtualizing must include it: the
    // window derived from that row's scroll offset covers the index.
    const idx = 500;
    const scrollTop = idx * ROW - 150; // browser centers roughly; approximate
    const w = rowWindow({ scrollTop, viewport: 300, rowHeight: ROW, total: 1000, overscan: 4 });
    expect(idx).toBeGreaterThanOrEqual(w.start);
    expect(idx).toBeLessThan(w.end);
  });
});

describe("revealOffset", () => {
  const HEAD = 34;

  it("returns null when the row is already fully visible", () => {
    // Row 5 sits at 150..180, viewport (minus header) is 34..300.
    expect(
      revealOffset({ index: 5, scrollTop: 0, viewport: 300, rowHeight: ROW, headroom: HEAD }),
    ).toBeNull();
  });

  it("scrolls up so a row above the fold clears the sticky header", () => {
    const off = revealOffset({ index: 100, scrollTop: 5000, viewport: 300, rowHeight: ROW, headroom: HEAD });
    // Row top 3000; must land headroom below the container top.
    expect(off).toBe(3000 - HEAD);
  });

  it("scrolls down just enough to reveal a row below the fold", () => {
    const off = revealOffset({ index: 20, scrollTop: 0, viewport: 300, rowHeight: ROW, headroom: HEAD });
    // Row bottom 630; align it to the viewport bottom.
    expect(off).toBe(630 - 300);
  });

  it("never returns a negative offset for the very first row", () => {
    const off = revealOffset({ index: 0, scrollTop: 500, viewport: 300, rowHeight: ROW, headroom: HEAD });
    expect(off).toBe(0);
  });
});
