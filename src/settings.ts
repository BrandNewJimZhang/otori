// Settings-surface logic shared by the MIX popover and the settings
// overlay. The slider maps 0→off and rounds 1 up to the 2s floor so a
// tiny fade can't produce an inaudible half-crossfade.

/** Upper bound of the crossfade sliders (both MIX popover and Settings). */
export const CROSSFADE_SLIDER_MAX = 16;

/** Map a raw slider value to crossfade seconds: 0 = off, 1 → 2s floor. */
export function crossfadeFromSlider(value: number): number {
  return value === 1 ? 2 : value;
}
