// Settings-surface logic: crossfade slider semantics shared by the MIX
// popover and the settings overlay (SSOT — the 1s→2s floor rounding
// lived inline in App.tsx and would have been duplicated).

import { describe, expect, it } from "vitest";
import { CROSSFADE_SLIDER_MAX, crossfadeFromSlider } from "./settings";

describe("crossfadeFromSlider", () => {
  it("0 disables (gapless)", () => {
    expect(crossfadeFromSlider(0)).toBe(0);
  });

  it("1 rounds up to the 2s floor", () => {
    expect(crossfadeFromSlider(1)).toBe(2);
  });

  it("passes 2..max through unchanged", () => {
    expect(crossfadeFromSlider(2)).toBe(2);
    expect(crossfadeFromSlider(8)).toBe(8);
    expect(crossfadeFromSlider(CROSSFADE_SLIDER_MAX)).toBe(CROSSFADE_SLIDER_MAX);
  });
});
