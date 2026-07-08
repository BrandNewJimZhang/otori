//! Pure derivation: Beat This! beat timestamps → the verdicts the
//! index stores. This is where the retired frontend detector's
//! *semantics* survive (beatgrid.ts): steady vs soflan ranges,
//! confidence, hint octave folding, per-end mix anchors. No I/O, no
//! inference — fully testable with synthetic beat grids.

/// Whole-track tempo verdict for the BPM column.
#[derive(Debug, Clone, Copy)]
pub struct TempoVerdict {
    /// Tempo, or the range floor when the track varies.
    pub bpm: f64,
    /// Range ceiling for variable-tempo (soflan) material; None = steady.
    pub bpm_max: Option<f64>,
    /// 0..1: inter-beat-interval consistency (grid cleanliness).
    pub confidence: f64,
    /// An external hint anchored the octave (or confirmed the value).
    pub hint_applied: bool,
}

/// A local beat grid at one end of a track: tempo measured inside the
/// mix window plus one real detected beat inside it (absolute seconds).
#[derive(Debug, Clone, Copy)]
pub struct MixAnchor {
    pub bpm: f64,
    pub beat_sec: f64,
}

/// A grid needs enough beats over enough time to be a grid at all.
const MIN_BEATS: usize = 16;
const MIN_SPAN_SEC: f64 = 8.0;
/// Soflan windowing: local tempo over WINDOW_SEC slices stepping by
/// half; windows disagreeing beyond STEADY_TOLERANCE = variable tempo.
const WINDOW_SEC: f64 = 15.0;
const STEADY_TOLERANCE: f64 = 0.05;
/// An interval counts as on-grid within this ratio of the local tempo.
const CONSISTENCY_TOLERANCE: f64 = 0.06;
/// A window needs this many intervals for a trustworthy local tempo.
const MIN_WINDOW_IBIS: usize = 8;
/// Octave tolerance when comparing a detection to an external hint.
const HINT_MATCH_TOLERANCE: f64 = 0.06;
/// Mix window: the stretch of track a transition actually plays.
const MIX_WINDOW_SEC: f64 = 45.0;
/// A local measurement below this grid consistency didn't measure a
/// real tempo (mixed beat populations, heavy jitter): it must not
/// drive a verdict or anchor a tempo bend.
const MIN_TRUSTED_CONSISTENCY: f64 = 0.4;

/// Interquartile mean of intervals: robust to a missed/extra beat
/// (outlier interval) *and* to bimodal jitter, where a plain median
/// picks one mode.
fn iqm(intervals: &mut [f64]) -> f64 {
    intervals.sort_by(|a, b| a.total_cmp(b));
    let n = intervals.len();
    let (lo, hi) = (n / 4, (3 * n).div_ceil(4).max(n / 4 + 1));
    let mid = &intervals[lo..hi.min(n)];
    mid.iter().sum::<f64>() / mid.len() as f64
}

/// Consecutive-beat intervals whose *both* endpoints fall in [start, end).
fn window_ibis(beats: &[f64], start: f64, end: f64) -> Vec<f64> {
    beats
        .windows(2)
        .filter(|w| w[0] >= start && w[1] < end)
        .map(|w| w[1] - w[0])
        .collect()
}

/// Local tempo + grid consistency for one time window. None when the
/// window has too few intervals to measure.
fn window_tempo(beats: &[f64], start: f64, end: f64) -> Option<(f64, f64)> {
    let mut ibis = window_ibis(beats, start, end);
    if ibis.len() < MIN_WINDOW_IBIS {
        return None;
    }
    let period = iqm(&mut ibis);
    let on_grid = ibis
        .iter()
        .filter(|&&i| (i - period).abs() / period <= CONSISTENCY_TOLERANCE)
        .count();
    Some((60.0 / period, on_grid as f64 / ibis.len() as f64))
}

/// Whole-track tempo verdict from beat timestamps. Steady tracks get a
/// single bpm; tracks whose windows disagree get a bpm..bpm_max range
/// with halved confidence (a range is honest, a mean is a lie). None =
/// beatless / too sparse to call — callers record "analyzed, nothing
/// usable", not an error.
pub fn tempo_verdict(beats: &[f32], hint_bpm: Option<f64>) -> Option<TempoVerdict> {
    let beats: Vec<f64> = beats.iter().map(|&b| b as f64).collect();
    if beats.len() < MIN_BEATS {
        return None;
    }
    let (first, last) = (beats[0], beats[beats.len() - 1]);
    if last - first < MIN_SPAN_SEC {
        return None;
    }

    // Window the track; each window measures a local tempo.
    let mut locals: Vec<(f64, f64)> = Vec::new();
    let mut total_windows = 0usize;
    let mut start = first;
    loop {
        let end = start + WINDOW_SEC;
        total_windows += 1;
        if let Some(t) = window_tempo(&beats, start, end) {
            locals.push(t);
        }
        if end >= last {
            break;
        }
        start += WINDOW_SEC / 2.0;
    }
    if locals.is_empty() {
        return None;
    }

    // Fold each window onto the median window's octave before judging
    // steadiness: the tracker flips metrical level mid-track (half-time
    // breakdowns), and a ×2/×3 split between clean windows is octave
    // ambiguity, not soflan — "85–171" is one tempo tracked at two
    // levels. Genuine tempo changes sit off the harmonics and survive.
    let mut sorted: Vec<f64> = locals.iter().map(|&(b, _)| b).collect();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let reference = sorted[sorted.len() / 2];
    for local in &mut locals {
        local.0 = fold_to_reference(local.0, reference);
    }

    // Confidence: mean grid consistency, diluted by windows that
    // failed to measure (parts of the track had no usable grid).
    let coverage = locals.len() as f64 / total_windows as f64;
    let consistency = locals.iter().map(|&(_, c)| c).sum::<f64>() / locals.len() as f64;
    let confidence = (consistency * coverage).min(1.0);

    // A window straddling a metrical flip mixes two beat populations
    // and reads an artifact between the octaves — its intervals don't
    // sit on its own grid, so its consistency exposes it. Judge on
    // trusted windows; when none qualify (heavy jitter) every window
    // is equally rough, so use them all.
    let mut bpms: Vec<f64> = locals
        .iter()
        .filter(|&&(_, c)| c >= MIN_TRUSTED_CONSISTENCY)
        .map(|&(b, _)| b)
        .collect();
    if bpms.is_empty() {
        bpms = locals.iter().map(|&(b, _)| b).collect();
    }

    let lo = bpms.iter().copied().fold(f64::INFINITY, f64::min);
    let hi = bpms.iter().copied().fold(0.0, f64::max);
    if hi / lo > 1.0 + STEADY_TOLERANCE {
        // Variable tempo. Hints don't re-fold ranges: a soflan range
        // is a measurement, not an octave ambiguity.
        return Some(TempoVerdict {
            bpm: lo,
            bpm_max: Some(hi),
            confidence: confidence * 0.5,
            hint_applied: false,
        });
    }

    // Steady: median of local tempos (robust to one flaky window).
    bpms.sort_by(|a, b| a.total_cmp(b));
    let bpm = bpms[bpms.len() / 2];
    Some(apply_hint(
        TempoVerdict { bpm, bpm_max: None, confidence, hint_applied: false },
        hint_bpm,
    ))
}

/// Fold one window's tempo onto the reference octave. Only a harmonic
/// (×2/×0.5/×3/×⅓ — same family as `apply_hint`) that lands within
/// STEADY_TOLERANCE of the reference folds; anything else keeps its
/// measured value, so a genuine 1.5× soflan is never bent into range.
fn fold_to_reference(bpm: f64, reference: f64) -> f64 {
    [2.0, 0.5, 3.0, 1.0 / 3.0]
        .iter()
        .map(|f| bpm * f)
        .find(|folded| (folded / reference - 1.0).abs() <= STEADY_TOLERANCE)
        .unwrap_or(bpm)
}

/// Reconcile a steady detection with an external hint (tag / provider
/// — founding-user decision: hints anchor analysis, never replace it).
/// If the hint sits on a ×0.5/×1/×2/×3 relation of the measurement,
/// fold the measurement onto the hint's octave and mark it verified
/// (small confidence boost on exact agreement). A non-harmonic hint is
/// someone else's number — keep the measurement.
fn apply_hint(verdict: TempoVerdict, hint_bpm: Option<f64>) -> TempoVerdict {
    let Some(hint) = hint_bpm else { return verdict };
    for factor in [1.0, 2.0, 0.5, 3.0, 1.0 / 3.0] {
        let folded = verdict.bpm * factor;
        if (folded - hint).abs() / hint <= HINT_MATCH_TOLERANCE {
            return TempoVerdict {
                bpm: folded,
                bpm_max: None,
                confidence: (verdict.confidence + if factor == 1.0 { 0.1 } else { 0.05 }).min(1.0),
                hint_applied: true,
            };
        }
    }
    verdict
}

/// Per-end mix anchors from the whole-track beat list. An end anchors
/// only when its window is locally steady (both halves independently
/// measure agreeing tempos) and its grid is clean enough; anything
/// else — tempo change inside the window, beatless stretch, sloppy
/// grid — refuses, and the crossfade planner falls back to a plain
/// fade. `truncated` = the decode didn't reach the real end; the tail
/// we'd measure isn't the tail that will play.
pub fn mix_anchors(
    beats: &[f32],
    duration_sec: f64,
    truncated: bool,
) -> (Option<MixAnchor>, Option<MixAnchor>) {
    let beats: Vec<f64> = beats.iter().map(|&b| b as f64).collect();
    let win = MIX_WINDOW_SEC.min(duration_sec);
    let head = window_anchor(&beats, 0.0, win);
    let tail = if truncated { None } else { window_anchor(&beats, duration_sec - win, duration_sec) };
    (head, tail)
}

fn window_anchor(beats: &[f64], start: f64, end: f64) -> Option<MixAnchor> {
    // Local steadiness: both halves must independently measure tempos
    // that agree — one measurement over the window would average a
    // mid-window tempo change into a plausible-looking lie.
    let mid = start + (end - start) / 2.0;
    let (a, _) = window_tempo(beats, start, mid)?;
    let (b, _) = window_tempo(beats, mid, end)?;
    if a.max(b) / a.min(b) > 1.0 + STEADY_TOLERANCE {
        return None;
    }
    let (bpm, consistency) = window_tempo(beats, start, end)?;
    if consistency < MIN_TRUSTED_CONSISTENCY {
        return None;
    }
    // The anchor beat is a real detected beat, not a derived phase.
    let beat_sec = *beats.iter().find(|&&t| t >= start)?;
    Some(MixAnchor { bpm, beat_sec })
}
