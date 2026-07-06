//! Track audio analysis bookkeeping. Detection runs in the GUI (Web
//! Audio is the only decoder in the stack — ADR-0001); this module
//! owns which tracks still need analysis and records outcomes.
//!
//! Trust model (founding-user decision 2026-07-07): external BPM data
//! — TBPM tags, VocaDB/wiki/provider values — is a *hint*: a great
//! analysis anchor, never a result. The detector verifies every hint
//! (octave folding against the anchor) and owns the bpm column;
//! `bpm_source` records whether a hint anchored the verification
//! ('detected+hint') or not ('detected').
//!
//! Besides the BPM column verdict, each pass records mix anchors:
//! per-end local beat grids (bpm + a measured beat) for crossfade
//! planning. Always detected — no external source knows beat phase —
//! so hint-satisfied tracks still pass through the sweeper once.

use rusqlite::Connection;
use serde::Serialize;

/// A track with analysis still missing. `needs_bpm` distinguishes
/// "detect the column tempo too" from "mix anchors only".
#[derive(Debug, Serialize)]
pub struct PendingTrack {
    pub id: i64,
    pub path: String,
    pub needs_bpm: bool,
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

/// A local beat grid at one end of a track: tempo measured inside the
/// mix window plus one beat inside it (absolute seconds from track
/// start) — enough to reconstruct every beat of that window without
/// extrapolating across the track.
#[derive(Debug, Clone, Copy)]
pub struct MixAnchor {
    pub bpm: f64,
    pub beat_sec: f64,
}

/// Tracks with any analysis missing (BPM verdict or mix anchors).
pub fn list_analysis_pending(conn: &Connection) -> rusqlite::Result<Vec<PendingTrack>> {
    // Blank cells fill before stale re-verifications: a track with no
    // number at all hurts more than one showing a probably-right value.
    let mut stmt = conn.prepare(
        "SELECT id, path, bpm_analyzed_at IS NULL, bpm_hint, bpm_hint_max FROM tracks
         WHERE bpm_analyzed_at IS NULL OR mix_analyzed_at IS NULL
         ORDER BY bpm IS NOT NULL, id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(PendingTrack {
            id: row.get(0)?,
            path: row.get(1)?,
            needs_bpm: row.get(2)?,
            hint_bpm: row.get(3)?,
            hint_bpm_max: row.get(4)?,
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

/// A track whose tempo would benefit from an external hint lookup.
#[derive(Debug, Serialize)]
pub struct HintCandidate {
    pub id: i64,
    pub path: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    /// Current detection, if any (None = blank/beatless).
    pub bpm: Option<f64>,
    pub bpm_confidence: Option<f64>,
}

/// Tracks worth a provider BPM lookup: no hint yet, and either never
/// produced a value or detected below `min_confidence`. Ordered
/// blank-first (a missing number hurts more than a shaky one).
pub fn list_hint_candidates(
    conn: &Connection,
    min_confidence: f64,
) -> rusqlite::Result<Vec<HintCandidate>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.path, t.bpm, t.bpm_confidence,
                MAX(CASE WHEN v.field = 'title' THEN v.value END) AS title,
                MAX(CASE WHEN v.field = 'artist' THEN v.value END) AS artist
         FROM tracks t
         LEFT JOIN tag_values v ON v.track_id = t.id
         WHERE t.bpm_hint IS NULL
           AND (t.bpm IS NULL OR t.bpm_confidence < ?1)
         GROUP BY t.id
         ORDER BY t.bpm IS NOT NULL, t.id",
    )?;
    let rows = stmt.query_map([min_confidence], |row| {
        Ok(HintCandidate {
            id: row.get(0)?,
            path: row.get(1)?,
            bpm: row.get(2)?,
            bpm_confidence: row.get(3)?,
            title: row.get(4)?,
            artist: row.get(5)?,
        })
    })?;
    rows.collect()
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

/// Record mix anchors for both ends. `None` for an end = that end has
/// no stable local grid (variable tempo inside the window, beatless,
/// or the detector failed) — beat-matching must not be attempted
/// there. Recorded as analyzed either way so the sweeper moves on.
/// Fails fast on unknown ids.
pub fn set_mix_anchors(
    conn: &Connection,
    track_id: i64,
    head: Option<MixAnchor>,
    tail: Option<MixAnchor>,
) -> rusqlite::Result<()> {
    let updated = conn.execute(
        "UPDATE tracks
         SET mix_head_bpm = ?1, mix_head_beat_sec = ?2,
             mix_tail_bpm = ?3, mix_tail_beat_sec = ?4,
             mix_analyzed_at = datetime('now')
         WHERE id = ?5",
        rusqlite::params![
            head.map(|a| a.bpm),
            head.map(|a| a.beat_sec),
            tail.map(|a| a.bpm),
            tail.map(|a| a.beat_sec),
            track_id
        ],
    )?;
    if updated == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}
