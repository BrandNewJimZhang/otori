//! BPM analysis bookkeeping. Detection runs in the GUI (Web Audio is
//! the only decoder in the stack — ADR-0001); this module owns which
//! tracks still need analysis and records outcomes with trust
//! metadata. Value provenance ladder mirrors the tag stack: `tag`
//! (authored by the release, confidence 1.0) beats `detected`
//! (estimated, carries the detector's confidence and, for
//! variable-tempo material, a bpm..bpm_max range).

use rusqlite::Connection;
use serde::Serialize;

/// A track awaiting BPM analysis.
#[derive(Debug, Serialize)]
pub struct PendingTrack {
    pub id: i64,
    pub path: String,
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
/// Tag-sourced values set bpm_analyzed_at at scan time, so they never
/// appear here.
pub fn list_bpm_pending(conn: &Connection) -> rusqlite::Result<Vec<PendingTrack>> {
    let mut stmt = conn.prepare(
        "SELECT id, path FROM tracks WHERE bpm_analyzed_at IS NULL ORDER BY id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(PendingTrack { id: row.get(0)?, path: row.get(1)? })
    })?;
    rows.collect()
}

/// Record a detection outcome. `None` = analyzed, no steady beat —
/// distinct from never-analyzed, so the sweeper won't retry forever.
///
/// Fails fast on unknown ids (the caller listed them from this same
/// index) and on tag/provider-sourced rows: authored and curated
/// values are authoritative; detection must never clobber them.
pub fn set_bpm(
    conn: &Connection,
    track_id: i64,
    detected: Option<DetectedBpm>,
) -> rusqlite::Result<()> {
    let updated = match detected {
        Some(d) => conn.execute(
            "UPDATE tracks
             SET bpm = ?1, bpm_max = ?2, bpm_confidence = ?3,
                 bpm_source = 'detected', bpm_analyzed_at = datetime('now')
             WHERE id = ?4
               AND (bpm_source IS NULL OR bpm_source = 'detected')",
            rusqlite::params![d.bpm, d.bpm_max, d.confidence, track_id],
        )?,
        None => conn.execute(
            "UPDATE tracks
             SET bpm = NULL, bpm_max = NULL, bpm_confidence = NULL,
                 bpm_source = NULL, bpm_analyzed_at = datetime('now')
             WHERE id = ?1
               AND (bpm_source IS NULL OR bpm_source = 'detected')",
            [track_id],
        )?,
    };
    if updated == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

/// Record an editor-curated provider value (VocaDB/TouhouDB entry
/// BPM). Trust ladder: tag > provider > detected — replaces detection,
/// refuses to touch tag-sourced rows, confidence 1.0.
///
/// `provider` must be lowercase alphanumeric (it lands inside
/// bpm_source as 'provider:<name>' and must stay parseable); values
/// get the same 20-400 sanity window as tags, and a range ceiling
/// below its floor is data error.
pub fn set_provider_bpm(
    conn: &Connection,
    track_id: i64,
    bpm: f64,
    bpm_max: Option<f64>,
    provider: &str,
) -> rusqlite::Result<()> {
    let name_ok = !provider.is_empty()
        && provider.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let bpm_ok = (20.0..=400.0).contains(&bpm);
    let range_ok = bpm_max.is_none_or(|max| max >= bpm && max <= 400.0);
    if !name_ok || !bpm_ok || !range_ok {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "invalid provider bpm: provider={provider:?} bpm={bpm} bpm_max={bpm_max:?}"
        )));
    }
    let updated = conn.execute(
        "UPDATE tracks
         SET bpm = ?1, bpm_max = ?2, bpm_confidence = 1.0,
             bpm_source = 'provider:' || ?3, bpm_analyzed_at = datetime('now')
         WHERE id = ?4 AND (bpm_source IS NULL OR bpm_source != 'tag')",
        rusqlite::params![bpm, bpm_max, provider, track_id],
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
