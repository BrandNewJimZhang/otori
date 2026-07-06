// Shared idle policy for the 60fps visualizer loops (Spectrum bars,
// Stage beat drive). A paused media element feeds silence into the
// analyser, so bars/pulses decay to zero within a second — after
// that, scheduling more frames burns CPU drawing a static image.

/** Motion below this is invisible on screen; treat as settled. */
const MOTION_EPSILON = 0.001;

/** Keep scheduling frames? Always while playing; while paused, only
    until the on-screen motion (bar heights, falling peak caps,
    smoothed pulse energy) settles. The caller restarts its loop when
    `paused` flips back — this only decides when to stop. */
export function shouldKeepDrawing(paused: boolean, motion: number): boolean {
  return !paused || motion > MOTION_EPSILON;
}
