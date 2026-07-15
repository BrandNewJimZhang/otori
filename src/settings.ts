// Settings-surface logic shared by the MIX popover and the settings
// overlay. The slider maps 0→off and rounds anything below 2s up to
// the 2s floor so a tiny fade can't produce an inaudible
// half-crossfade (PR-13f gold ruling: the whole (0,2) interval, not
// just the exact value 1).

/** Upper bound of the crossfade sliders (both MIX popover and Settings). */
export const CROSSFADE_SLIDER_MAX = 16;

/** Map a raw slider value to crossfade seconds: 0 = off, (0,2) → 2s floor. */
export function crossfadeFromSlider(value: number): number {
  return value > 0 && value < 2 ? 2 : value;
}
