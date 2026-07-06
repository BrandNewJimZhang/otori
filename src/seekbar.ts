// Seek slider value semantics (audit P0): while the user drags, the
// thumb previews the target without seeking; the decoder seek happens
// once on release. Pure helpers shared by the player bar and Stage.

/** Slider max: finite duration, or 0 to render dead until metadata. */
export function seekMax(duration: number): number {
  return Number.isFinite(duration) ? duration : 0;
}

/** Thumb position: the scrub preview while dragging, else live position. */
export function seekShown(scrub: number | null, position: number, max: number): number {
  return Math.min(scrub ?? position, max);
}
