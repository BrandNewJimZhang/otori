// Beat grid detection: BPM + first-beat phase from an onset envelope.
//
// Pipeline (offline, per track, off the audio thread):
//   decode → mono → onset energy envelope (ENVELOOPE_HZ) → autocorrelation
//   over the DJ tempo range → parabolic peak refine → phase by folding
//   the envelope at the beat period.
// This is deliberately classical DSP: no ML model, no dependency, fully
// testable with synthetic click tracks. Accuracy target is "good enough
// to plan a bar-quantized crossfade", not rekordbox-grade grid editing.

/** Envelope sample rate (Hz). 100Hz = 10ms resolution, plenty for beats. */
export const ENVELOPE_HZ = 100;

const BPM_MIN = 70;
const BPM_MAX = 180;
/** Autocorrelation needs several periods to lock; require 8s of signal. */
const MIN_SIGNAL_SEC = 8;

export interface BeatGrid {
  bpm: number;
  /** Seconds from stream start to the first detected beat. */
  firstBeatSec: number;
}

/**
 * Detect tempo and phase from an onset-energy envelope. Returns null
 * when no periodicity stands out (beatless/ambient material) — callers
 * must treat that as "cannot beat-match", not as an error.
 */
export function detectBeats(envelope: Float32Array): BeatGrid | null {
  if (envelope.length < MIN_SIGNAL_SEC * ENVELOPE_HZ) return null;

  // Mean-remove so constant energy doesn't correlate everywhere.
  let mean = 0;
  for (const v of envelope) mean += v;
  mean /= envelope.length;
  const x = new Float32Array(envelope.length);
  let energy = 0;
  for (let i = 0; i < envelope.length; i++) {
    x[i] = envelope[i] - mean;
    energy += x[i] * x[i];
  }
  if (energy < 1e-9) return null; // silence

  // Autocorrelation over lags covering BPM_MAX..BPM_MIN.
  const lagMin = Math.floor((60 / BPM_MAX) * ENVELOPE_HZ);
  const lagMax = Math.ceil((60 / BPM_MIN) * ENVELOPE_HZ);
  let bestLag = 0;
  let bestScore = 0;
  const scores = new Float32Array(lagMax + 1);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let sum = 0;
    for (let i = lag; i < x.length; i++) sum += x[i] * x[i - lag];
    scores[lag] = sum / (x.length - lag);
    if (scores[lag] > bestScore) {
      bestScore = scores[lag];
      bestLag = lag;
    }
  }
  // Periodicity must clearly beat the signal's own variance floor.
  if (bestLag === 0 || bestScore < (energy / x.length) * 0.1) return null;

  // Harmonic disambiguation: a click at T also correlates at 2T (half
  // tempo). Prefer the smallest lag (fastest tempo) whose score holds
  // up against the best — that's the actual beat, not the bar. The
  // 0.45 floor accounts for non-integer periods, where only every
  // other beat lands on the same envelope sample (score halves).
  for (let div = 4; div >= 2; div--) {
    const cand = Math.round(bestLag / div);
    // Check the neighborhood: sub-sample periods smear across ±1 lag.
    for (const c of [cand, cand - 1, cand + 1]) {
      if (c >= lagMin && c <= lagMax && scores[c] >= bestScore * 0.45) {
        bestLag = c;
        bestScore = scores[c];
        div = 0; // break outer
        break;
      }
    }
  }

  // Parabolic interpolation around the peak for sub-sample lag.
  let lag = bestLag;
  if (bestLag > lagMin && bestLag < lagMax) {
    const y0 = scores[bestLag - 1];
    const y1 = scores[bestLag];
    const y2 = scores[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) lag = bestLag + (0.5 * (y0 - y2)) / denom;
  }
  const bpm = (60 * ENVELOPE_HZ) / lag;

  // Phase: fold the envelope at the period; the strongest bin is the beat.
  const period = lag;
  const bins = Math.max(1, Math.round(period));
  const folded = new Float32Array(bins);
  for (let i = 0; i < envelope.length; i++) {
    folded[Math.floor(i % period) % bins] += envelope[i];
  }
  let phaseBin = 0;
  for (let i = 1; i < bins; i++) if (folded[i] > folded[phaseBin]) phaseBin = i;

  return { bpm, firstBeatSec: phaseBin / ENVELOPE_HZ };
}

/**
 * Onset-energy envelope from decoded samples: rectified spectral-flux
 * style — per-window RMS rise, half-wave rectified. Mono input.
 */
export function onsetEnvelope(samples: Float32Array, sampleRate: number): Float32Array {
  const hop = Math.round(sampleRate / ENVELOPE_HZ);
  const frames = Math.floor(samples.length / hop);
  const env = new Float32Array(frames);
  let prevRms = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = start; i < start + hop; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / hop);
    env[f] = Math.max(0, rms - prevRms); // rises only: onsets, not decays
    prevRms = rms;
  }
  return env;
}
