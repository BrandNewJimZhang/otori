// ReplayGain dB → linear gain factor. Kept pure for testing; the
// playback engine multiplies this into its GainNode.

/** Malformed tags can claim absurd gains; cap the linear factor at 4x
    (+12 dB) — beyond that it's data error, not loudness correction. */
const MAX_LINEAR = 4;

/**
 * Linear gain for a track: 10^(dB/20), scaled by user volume.
 * `null` (no RG data) is unity — absence of data is not a correction.
 */
export function effectiveGain(replaygainDb: number | null, volume = 1): number {
  const rg = replaygainDb == null ? 1 : Math.min(MAX_LINEAR, Math.pow(10, replaygainDb / 20));
  return rg * volume;
}
