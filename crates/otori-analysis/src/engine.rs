//! Inference engine: symphonia decode + Beat This! transformer via
//! the `beat-this` crate (pure-Rust rten runtime), then derivation to
//! index verdicts. One engine per process — model load costs seconds.

use std::path::Path;

use anyhow::Result;
use beat_this::{load_audio, BeatThis, RtenRuntime, Runtime};

use crate::derive::{mix_anchors, tempo_verdict, MixAnchor, TempoVerdict};
use crate::models::ModelPaths;

/// Decode target: the model's native rate; load_audio resamples.
const DECODE_RATE: u32 = 22050;
/// Decode cap, matching the retired frontend path: beyond this the
/// tail anchor is suppressed (`truncated`) rather than mismeasured.
const MAX_DECODE_SEC: f64 = 15.0 * 60.0;

/// Everything one analysis pass produces for one track.
#[derive(Debug, Clone, Copy)]
pub struct TrackAnalysis {
    /// None = analyzed, no usable grid (beatless) — a verdict, not an error.
    pub verdict: Option<TempoVerdict>,
    pub head: Option<MixAnchor>,
    pub tail: Option<MixAnchor>,
}

pub struct AnalysisEngine {
    tracker: BeatThis<<RtenRuntime as Runtime>::Model>,
}

impl AnalysisEngine {
    pub fn new(models: &ModelPaths) -> Result<Self> {
        Ok(Self { tracker: BeatThis::new(&RtenRuntime, &models.mel, &models.beat)? })
    }

    /// Decode + track beats + derive verdicts. `hint_bpm` anchors
    /// octave folding (tag/provider value — hint, never result).
    /// Blocking and CPU-heavy (~1s per minute of audio): callers run
    /// this off any latency-sensitive thread.
    pub fn analyze(&mut self, path: &Path, hint_bpm: Option<f64>) -> Result<TrackAnalysis> {
        let audio = load_audio(path, DECODE_RATE)?;
        let max_samples = (MAX_DECODE_SEC * audio.sample_rate as f64) as usize;
        let truncated = audio.samples.len() > max_samples;
        let samples =
            if truncated { &audio.samples[..max_samples] } else { &audio.samples[..] };
        let duration_sec = samples.len() as f64 / audio.sample_rate as f64;

        let analysis = self.tracker.analyze_audio(samples, audio.sample_rate)?;
        let verdict = tempo_verdict(&analysis.beats, hint_bpm);
        let (head, tail) = mix_anchors(&analysis.beats, duration_sec, truncated);
        Ok(TrackAnalysis { verdict, head, tail })
    }
}
