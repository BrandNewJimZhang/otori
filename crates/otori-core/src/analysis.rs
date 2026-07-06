//! BPM analysis bookkeeping. Detection runs in the GUI (Web Audio is
//! the only decoder in the stack — ADR-0001); this module owns which
//! tracks still need analysis and records outcomes, so results persist
//! across restarts and are visible to the CLI/agents via the index.

use rusqlite::Connection;
use serde::Serialize;

/// A track awaiting BPM analysis.
#[derive(Debug, Serialize)]
pub struct PendingTrack {
    pub id: i64,
    pub path: String,
}

/// Tracks never analyzed (bpm_analyzed_at IS NULL), oldest first.
pub fn list_bpm_pending(conn: &Connection) -> rusqlite::Result<Vec<PendingTrack>> {
    let mut stmt = conn.prepare(
        "SELECT id, path FROM tracks WHERE bpm_analyzed_at IS NULL ORDER BY id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(PendingTrack { id: row.get(0)?, path: row.get(1)? })
    })?;
    rows.collect()
}

/// Record an analysis outcome. `None` = analyzed, no steady beat —
/// distinct from never-analyzed, so the sweeper won't retry forever.
/// Unknown ids are an invariant break (the caller listed them from
/// this same index) and fail fast.
pub fn set_bpm(conn: &Connection, track_id: i64, bpm: Option<f64>) -> rusqlite::Result<()> {
    let updated = conn.execute(
        "UPDATE tracks SET bpm = ?1, bpm_analyzed_at = datetime('now') WHERE id = ?2",
        rusqlite::params![bpm, track_id],
    )?;
    if updated == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}
