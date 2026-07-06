//! BPM analysis bookkeeping. Detection runs in the GUI (Web Audio is
//! the only decoder in the stack — ADR-0001); this module owns which
//! tracks still need analysis and records outcomes.
//!
//! Trust model (founding-user decision 2026-07-07): external BPM data
//! — TBPM tags, VocaDB/wiki/provider values — is a *hint*: a great
//! analysis anchor, never a result. The detector verifies every hint
//! (octave folding against the anchor) and owns the bpm column;
//! `bpm_source` records whether a hint anchored the verification
//! ('detected+hint') or not ('detected').

use rusqlite::Connection;
use serde::Serialize;

/// A track awaiting BPM analysis, with its anchor if one exists.
#[derive(Debug, Serialize)]
pub struct PendingTrack {
    pub id: i64,
    pub path: String,
    /// External anchor for octave folding (tag/provider), if any.
    pub hint_bpm: Option<f64>,
    pub hint_bpm_max: Option<f64>,
}

/// One detection outcome from the GUI's beat analyzer.
#[derive(Debug, Clone, Copy)]
pub struct DetectedBpm {
    /// Tempo, or the range floor when the track varies.
    pub bpm: f64,
    /// Range ceiling for variable-tempo (soflan) material; None = steady.
    pub bpm_max: Option<f64>,
    /// Detector confidence 0..1 (autocorrelation peak strength).
    pub confidence: f64,
}

/// Tracks never analyzed (bpm_analyzed_at IS NULL), oldest first.
pub fn list_bpm_pending(conn: &Connection) -> rusqlite::Result<Vec<PendingTrack>> {
    // Blank cells fill before stale re-verifications: a track with no
    // number at all hurts more than one showing a probably-right value.
    let mut stmt = conn.prepare(
        "SELECT id, path, bpm_hint, bpm_hint_max FROM tracks
         WHERE bpm_analyzed_at IS NULL
         ORDER BY bpm IS NOT NULL, id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(PendingTrack {
            id: row.get(0)?,
            path: row.get(1)?,
            hint_bpm: row.get(2)?,
            hint_bpm_max: row.get(3)?,
        })
    })?;
    rows.collect()
}

/// Record a detection outcome. `None` = analyzed, no steady beat —
/// distinct from never-analyzed, so the sweeper won't retry forever.
/// `used_hint` marks whether an external anchor folded the octave.
/// Fails fast on unknown ids.
pub fn set_bpm(
    conn: &Connection,
    track_id: i64,
    detected: Option<DetectedBpm>,
) -> rusqlite::Result<()> {
    set_bpm_with_source(conn, track_id, detected, false)
}

/// `set_bpm` variant recording that the hint anchored the result.
pub fn set_bpm_verified(
    conn: &Connection,
    track_id: i64,
    detected: DetectedBpm,
) -> rusqlite::Result<()> {
    set_bpm_with_source(conn, track_id, Some(detected), true)
}

fn set_bpm_with_source(
    conn: &Connection,
    track_id: i64,
    detected: Option<DetectedBpm>,
    used_hint: bool,
) -> rusqlite::Result<()> {
    let source = if used_hint { "detected+hint" } else { "detected" };
    let updated = match detected {
        Some(d) => conn.execute(
            "UPDATE tracks
             SET bpm = ?1, bpm_max = ?2, bpm_confidence = ?3,
                 bpm_source = ?4, bpm_analyzed_at = datetime('now')
             WHERE id = ?5",
            rusqlite::params![d.bpm, d.bpm_max, d.confidence, source, track_id],
        )?,
        None => conn.execute(
            "UPDATE tracks
             SET bpm = NULL, bpm_max = NULL, bpm_confidence = NULL,
                 bpm_source = NULL, bpm_analyzed_at = datetime('now')
             WHERE id = ?1",
            [track_id],
        )?,
    };
    if updated == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

/// Record an external BPM hint (tag / provider / wiki). Reopens
/// analysis: a new anchor means the detector should re-verify with it.
/// `source` is 'tag' or 'provider:<lowercase-alphanum>'.
pub fn set_bpm_hint(
    conn: &Connection,
    track_id: i64,
    bpm: f64,
    bpm_max: Option<f64>,
    source: &str,
) -> rusqlite::Result<()> {
    let source_ok = source == "tag"
        || source
            .strip_prefix("provider:")
            .is_some_and(|name| {
                !name.is_empty()
                    && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            });
    let bpm_ok = (20.0..=400.0).contains(&bpm);
    let range_ok = bpm_max.is_none_or(|max| max >= bpm && max <= 400.0);
    if !source_ok || !bpm_ok || !range_ok {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "invalid bpm hint: source={source:?} bpm={bpm} bpm_max={bpm_max:?}"
        )));
    }
    let updated = conn.execute(
        "UPDATE tracks
         SET bpm_hint = ?1, bpm_hint_max = ?2, bpm_hint_source = ?3,
             bpm_analyzed_at = NULL
         WHERE id = ?4",
        rusqlite::params![bpm, bpm_max, source, track_id],
    )?;
    if updated == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

/// A TBPM-style tag value, sanity-checked. Rejects zero/negative and
/// absurd values (a 10 or 3000 BPM tag is data error, not tempo).
pub fn parse_tag_bpm(raw: &str) -> Option<f64> {
    let bpm: f64 = raw.trim().parse().ok()?;
    if !(20.0..=400.0).contains(&bpm) {
        return None;
    }
    Some(bpm)
}
