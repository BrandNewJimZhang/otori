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

// Range covers Japanese electronic music: J-core/rhythm-game tiers
// live at 170-230+ (dnb 174, J-core 180-200, denpa/boss tiers 200+).
// The old 180 ceiling folded those to half tempo.
const BPM_MIN = 70;
const BPM_MAX = 230;
/** Autocorrelation needs several periods to lock; require 8s of signal. */
const MIN_SIGNAL_SEC = 8;

export interface BeatGrid {
  bpm: number;
  /** Seconds from stream start to the first detected beat. */
  firstBeatSec: number;
  /** 0..1: autocorrelation peak strength vs the signal's own floor. */
  confidence: number;
}

/** Whole-track tempo verdict for the BPM column. */
export interface TempoAnalysis {
  /** Tempo, or the range floor when the track varies. */
  bpm: number;
  /** Range ceiling for variable-tempo (soflan) material; null = steady. */
  bpmMax: number | null;
  confidence: number;
  /** An external hint anchored the octave (or confirmed the value). */
  hintApplied: boolean;
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
  const floor = energy / x.length;
  if (bestLag === 0 || bestScore < floor * 0.1) return null;
  // Confidence: peak strength relative to the variance floor, squashed
  // to 0..1. A clean click track saturates; mushy periodicity sits low.
  const confidence = Math.min(1, bestScore / floor);

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

  return { bpm, firstBeatSec: phaseBin / ENVELOPE_HZ, confidence };
}

/** Windowing for variable-tempo detection: analyze WINDOW_SEC slices
    stepping by half, then reconcile. Doujin/rhythm-game music changes
    tempo mid-track (soflan) — a whole-track autocorrelation would
    average that into a lie. */
const WINDOW_SEC = 15;
/** Windows disagreeing by more than this ratio = variable tempo. */
const STEADY_TOLERANCE = 0.05;

/**
 * Whole-track tempo analysis. Steady tracks get a single bpm; tracks
 * whose windows disagree get a bpm..bpmMax range with reduced
 * confidence. Null when nothing periodic is found anywhere.
 */
export function analyzeTempo(envelope: Float32Array, hintBpm?: number | null): TempoAnalysis | null {
  const win = WINDOW_SEC * ENVELOPE_HZ;
  if (envelope.length < win * 2) {
    const grid = detectBeats(envelope);
    return grid
      ? applyHint({ bpm: grid.bpm, bpmMax: null, confidence: grid.confidence, hintApplied: false }, hintBpm)
      : null;
  }

  const bpms: number[] = [];
  const confs: number[] = [];
  for (let start = 0; start + win <= envelope.length; start += win / 2) {
    const grid = detectBeats(envelope.subarray(start, start + win));
    if (grid) {
      bpms.push(grid.bpm);
      confs.push(grid.confidence);
    }
  }
  if (bpms.length === 0) return null;

  const lo = Math.min(...bpms);
  const hi = Math.max(...bpms);
  const meanConf = confs.reduce((a, b) => a + b, 0) / confs.length;
  // Windows that failed detection dilute confidence: they mean parts
  // of the track had no usable beat.
  const coverage = bpms.length / Math.floor((envelope.length - win) / (win / 2) + 1);
  const confidence = Math.min(1, meanConf * coverage);

  if (hi / lo <= 1 + STEADY_TOLERANCE) {
    // Steady: report the median (robust to one flaky window).
    const sorted = [...bpms].sort((a, b) => a - b);
    return applyHint(
      { bpm: sorted[Math.floor(sorted.length / 2)], bpmMax: null, confidence, hintApplied: false },
      hintBpm,
    );
  }
  // Variable tempo: a range is honest; halve confidence — a single
  // number can't represent this track, and crossfade planning should
  // not trust either endpoint blindly. Hints don't re-fold ranges:
  // a soflan range is a measurement, not an octave ambiguity.
  return { bpm: lo, bpmMax: hi, confidence: confidence * 0.5, hintApplied: false };
}

/** Octave tolerance when comparing a detection to an external hint. */
const HINT_MATCH_TOLERANCE = 0.06;

/**
 * Reconcile a steady detection with an external hint (tag / provider /
 * wiki — founding-user decision: hints anchor analysis, never replace
 * it). Detection's octave is its weak axis: sparse kicks read half,
 * busy hats read double. If the hint sits on a ×0.5/×1/×2/×3 relation
 * of the measurement, fold the measurement onto the hint's octave and
 * mark it verified (small confidence boost on exact agreement).
 * A non-harmonic hint is someone else's number — keep the measurement.
 */
function applyHint(result: TempoAnalysis, hintBpm?: number | null): TempoAnalysis {
  if (hintBpm == null || result.bpmMax != null) return result;
  for (const factor of [1, 2, 0.5, 3, 1 / 3]) {
    const folded = result.bpm * factor;
    if (Math.abs(folded - hintBpm) / hintBpm <= HINT_MATCH_TOLERANCE) {
      return {
        bpm: folded,
        bpmMax: null,
        confidence: Math.min(1, result.confidence + (factor === 1 ? 0.1 : 0.05)),
        hintApplied: true,
      };
    }
  }
  return result;
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
