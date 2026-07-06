//! Read-only queries over the index — the single listing surface shared
//! by CLI (`--json`) and GUI (IPC). Writes never happen here.

use rusqlite::Connection;
use serde::Serialize;

/// One track as consumers see it: identity + the display tag trio.
/// Grows only when a consumer needs a field (minimal public surface).
#[derive(Debug, Clone, Serialize)]
pub struct TrackRow {
    pub id: i64,
    pub path: String,
    pub format: String,
    pub duration_secs: Option<f64>,
    /// ReplayGain track gain in dB (loudness normalization in the player).
    pub replaygain_db: Option<f64>,
    /// Detected tempo; NULL until analyzed (or beatless material).
    pub bpm: Option<f64>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

/// List every indexed track, ordered by artist → title → path so all
/// consumers agree on order without client-side sorting.
pub fn list_tracks(conn: &Connection) -> rusqlite::Result<Vec<TrackRow>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.path, t.format, t.duration_secs, t.replaygain_db, t.bpm,
                MAX(CASE WHEN v.field = 'title' THEN v.value END) AS title,
                MAX(CASE WHEN v.field = 'artist' THEN v.value END) AS artist,
                MAX(CASE WHEN v.field = 'album' THEN v.value END) AS album
         FROM tracks t
         LEFT JOIN tag_values v ON v.track_id = t.id
         GROUP BY t.id
         ORDER BY artist IS NULL, artist, title IS NULL, title, t.path",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(TrackRow {
            id: row.get(0)?,
            path: row.get(1)?,
            format: row.get(2)?,
            duration_secs: row.get(3)?,
            replaygain_db: row.get(4)?,
            bpm: row.get(5)?,
            title: row.get(6)?,
            artist: row.get(7)?,
            album: row.get(8)?,
        })
    })?;
    rows.collect()
}
