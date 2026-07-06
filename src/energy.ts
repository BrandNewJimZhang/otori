// Band energy from FFT data: drives Stage's beat-reactive visuals
// (art pulse, lighting glow). Kept as pure math so it's testable —
// the canvas/CSS consumers just read numbers.

/**
 * Loudest bin in [freqLo, freqHi) normalized to 0..1 between dbFloor
 * and dbCeil. Max, not average: a kick drum is a spike, and averaging
 * smears it (same reasoning as the Spectrum bars).
 */
export function bandEnergy(
  data: Float32Array,
  binHz: number,
  freqLo: number,
  freqHi: number,
  dbFloor = -72,
  dbCeil = -8,
): number {
  const lo = Math.max(0, Math.round(freqLo / binHz));
  const hi = Math.min(data.length - 1, Math.round(freqHi / binHz));
  let db = -Infinity;
  for (let b = lo; b <= hi; b++) {
    if (data[b] > db) db = data[b];
  }
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db - dbFloor) / (dbCeil - dbFloor)));
}

/**
 * Fast-attack / slow-release envelope: rises instantly on a hit,
 * decays by `release` per frame. The standard shape for beat-reactive
 * visuals — instant punch, smooth afterglow.
 */
export class Smoother {
  private value = 0;

  constructor(private release: number) {}

  push(next: number): number {
    this.value = next >= this.value ? next : this.value * this.release;
    return this.value;
  }
}
