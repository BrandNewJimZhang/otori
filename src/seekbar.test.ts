// Scrub-preview semantics (audit P0: dragging the seek slider must not
// fire a decoder seek per pixel — preview while dragging, commit once).

import { describe, expect, it } from "vitest";
import { seekMax, seekShown, sliderFill } from "./seekbar";

describe("seekMax", () => {
  it("passes a finite duration through", () => {
    expect(seekMax(203.5)).toBe(203.5);
  });

  it("renders a dead slider until metadata loads (NaN/∞ → 0)", () => {
    expect(seekMax(NaN)).toBe(0);
    expect(seekMax(Infinity)).toBe(0);
  });
});

describe("sliderFill", () => {
  it("maps value/max to a CSS percent", () => {
    expect(sliderFill(50, 200)).toBe("25.0%");
    expect(sliderFill(1, 1)).toBe("100.0%");
  });

  it("renders an empty track when max is dead (0/NaN/∞)", () => {
    expect(sliderFill(10, 0)).toBe("0%");
    expect(sliderFill(10, NaN)).toBe("0%");
    expect(sliderFill(10, Infinity)).toBe("0%");
  });

  it("clamps overshoot and negatives", () => {
    expect(sliderFill(300, 200)).toBe("100.0%");
    expect(sliderFill(-5, 200)).toBe("0.0%");
  });
});

describe("seekShown", () => {
  it("shows the live position when not scrubbing", () => {
    expect(seekShown(null, 42, 100)).toBe(42);
  });

  it("shows the scrub preview while dragging", () => {
    expect(seekShown(90, 42, 100)).toBe(90);
  });

  it("clamps both to the track length", () => {
    expect(seekShown(null, 120, 100)).toBe(100);
    expect(seekShown(150, 42, 100)).toBe(100);
  });
});
