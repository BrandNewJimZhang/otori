//! One-track orchestration: engine verdict → index persistence via
//! the core writers. The single implementation behind both the CLI
//! (`otori analyze`) and the GUI sweep (`analyze_track` IPC) — the
//! rounding and hint bookkeeping must not fork between them.

use std::path::Path;

use anyhow::Result;
use otori_core::analysis::{
    set_bpm, set_bpm_verified, set_mix_anchors, DetectedBpm, MixAnchor, PendingTrack,
};
use otori_core::Connection;
use serde::Serialize;

use crate::engine::AnalysisEngine;

/// What one pass wrote to the index, IPC/JSON-shaped for consumers.
#[derive(Debug, Clone, Serialize)]
pub struct PersistedVerdict {
    /// None = beatless (or the pass was anchors-only and left bpm as is).
    pub bpm: Option<f64>,
    pub bpm_max: Option<f64>,
    pub confidence: Option<f64>,
    pub hint_applied: bool,
    pub head: Option<PersistedAnchor>,
    pub tail: Option<PersistedAnchor>,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct PersistedAnchor {
    pub bpm: f64,
    pub beat_sec: f64,
}

/// Analyze one pending track and persist through the same writers in
/// one place. The BPM column is only touched when the worklist says
/// the verdict is missing (`needs_bpm`); anchors are recorded always.
/// Column values round (0.1 BPM / 1% confidence — display precision);
/// anchors keep full precision (beat phase feeds sample math).
pub fn analyze_and_persist(
    conn: &Connection,
    engine: &mut AnalysisEngine,
    item: &PendingTrack,
) -> Result<PersistedVerdict> {
    let result = engine.analyze(Path::new(&item.path), item.hint_bpm)?;

    let mut out = PersistedVerdict {
        bpm: None,
        bpm_max: None,
        confidence: None,
        hint_applied: false,
        head: result.head.map(|a| PersistedAnchor { bpm: a.bpm, beat_sec: a.beat_sec }),
        tail: result.tail.map(|a| PersistedAnchor { bpm: a.bpm, beat_sec: a.beat_sec }),
    };
    if item.needs_bpm {
        match result.verdict {
            Some(v) => {
                let detected = DetectedBpm {
                    bpm: round1(v.bpm),
                    bpm_max: v.bpm_max.map(round1),
                    confidence: (v.confidence * 100.0).round() / 100.0,
                };
                if v.hint_applied {
                    set_bpm_verified(conn, item.id, detected)?;
                } else {
                    set_bpm(conn, item.id, Some(detected))?;
                }
                out.bpm = Some(detected.bpm);
                out.bpm_max = detected.bpm_max;
                out.confidence = Some(detected.confidence);
                out.hint_applied = v.hint_applied;
            }
            None => set_bpm(conn, item.id, None)?,
        }
    }
    let anchor = |a: PersistedAnchor| MixAnchor { bpm: a.bpm, beat_sec: a.beat_sec };
    set_mix_anchors(conn, item.id, out.head.map(anchor), out.tail.map(anchor))?;
    Ok(out)
}

fn round1(n: f64) -> f64 {
    (n * 10.0).round() / 10.0
}
