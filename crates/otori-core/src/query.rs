//! Read-only queries over the index — the single listing surface shared
//! by CLI (`--json`) and GUI (IPC). Writes never happen here.

use rusqlite::Connection;
use serde::Serialize;

use crate::analysis;

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
    /// Tempo (or range floor); NULL until analyzed (or beatless).
    pub bpm: Option<f64>,
    /// Range ceiling for variable-tempo (soflan) tracks; NULL = steady.
    pub bpm_max: Option<f64>,
    /// 0..1 detector confidence.
    pub bpm_confidence: Option<f64>,
    /// External anchor awaiting/used in verification (tag/provider).
    pub bpm_hint: Option<f64>,
    /// Should the BPM warn in a listing? Computed here from the shaky
    /// authority (analysis::is_shaky_bpm) so every projection — GUI
    /// badge, future consumers — agrees with the CLI without keeping
    /// its own cutoff (the 7aa83ea drift).
    pub bpm_shaky: bool,
    /// Mix-in anchor: local tempo + a measured beat at the track head.
    /// NULL with mix_analyzed = that end is unstable — no beat-match.
    pub mix_head_bpm: Option<f64>,
    pub mix_head_beat_sec: Option<f64>,
    /// Mix-out anchor: same, measured at the track tail.
    pub mix_tail_bpm: Option<f64>,
    pub mix_tail_beat_sec: Option<f64>,
    /// Anchor analysis ran (NULL anchors are a verdict, not a gap).
    pub mix_analyzed: bool,
    /// User's per-track lyrics sync nudge in ms; positive = lyrics later.
    pub lyrics_offset_ms: i64,
    /// When the file first entered the library (SQLite `datetime('now')`,
    /// UTC "YYYY-MM-DD HH:MM:SS") — the GUI's Added column.
    pub first_seen: String,
    /// When beat analysis last ran; NULL = pending — the Analyzed column.
    pub bpm_analyzed_at: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

/// List every indexed track, ordered by artist → title → path so all
/// consumers agree on order without client-side sorting.
pub fn list_tracks(conn: &Connection) -> rusqlite::Result<Vec<TrackRow>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.path, t.format, t.duration_secs, t.replaygain_db,
                t.bpm, t.bpm_max, t.bpm_confidence, t.bpm_hint,
                t.mix_head_bpm, t.mix_head_beat_sec, t.mix_tail_bpm, t.mix_tail_beat_sec,
                t.mix_analyzed_at IS NOT NULL, t.lyrics_offset_ms,
                t.first_seen, t.bpm_analyzed_at,
                MAX(CASE WHEN v.field = 'title' THEN v.value END) AS title,
                MAX(CASE WHEN v.field = 'artist' THEN v.value END) AS artist,
                MAX(CASE WHEN v.field = 'album' THEN v.value END) AS album
         FROM tracks t
         LEFT JOIN tag_values v ON v.track_id = t.id
         GROUP BY t.id
         ORDER BY artist IS NULL, artist, title IS NULL, title, t.path",
    )?;
    let rows = stmt.query_map([], |row| {
        let bpm: Option<f64> = row.get(5)?;
        let bpm_max: Option<f64> = row.get(6)?;
        let bpm_confidence: Option<f64> = row.get(7)?;
        let bpm_hint: Option<f64> = row.get(8)?;
        Ok(TrackRow {
            id: row.get(0)?,
            path: row.get(1)?,
            format: row.get(2)?,
            duration_secs: row.get(3)?,
            replaygain_db: row.get(4)?,
            bpm,
            bpm_max,
            bpm_confidence,
            bpm_hint,
            bpm_shaky: analysis::is_shaky_bpm(bpm, bpm_max, bpm_confidence, bpm_hint),
            mix_head_bpm: row.get(9)?,
            mix_head_beat_sec: row.get(10)?,
            mix_tail_bpm: row.get(11)?,
            mix_tail_beat_sec: row.get(12)?,
            mix_analyzed: row.get(13)?,
            lyrics_offset_ms: row.get(14)?,
            first_seen: row.get(15)?,
            bpm_analyzed_at: row.get(16)?,
            title: row.get(17)?,
            artist: row.get(18)?,
            album: row.get(19)?,
        })
    })?;
    rows.collect()
}

/// Per-field trust state for one track — the provenance layer the
/// GUI inspector renders as badges (source + curated lock). Read-only
/// view over `tag_values`; the write path in `write.rs` owns mutation.
#[derive(Debug, Clone, Serialize)]
pub struct TagProvenance {
    pub field: String,
    pub value: Option<String>,
    pub source: String,
    pub curated: bool,
    pub written_by: Option<String>,
    pub written_at: String,
}

/// All known tag fields for a track with their provenance. Empty for
/// an unknown/unscanned track id (a valid initial state, not an error).
pub fn tag_provenance(conn: &Connection, track_id: i64) -> rusqlite::Result<Vec<TagProvenance>> {
    let mut stmt = conn.prepare(
        "SELECT field, value, source, curated, written_by, written_at
         FROM tag_values WHERE track_id = ?1 ORDER BY field",
    )?;
    let rows = stmt.query_map([track_id], |row| {
        Ok(TagProvenance {
            field: row.get(0)?,
            value: row.get(1)?,
            source: row.get(2)?,
            curated: row.get::<_, i64>(3)? == 1,
            written_by: row.get(4)?,
            written_at: row.get(5)?,
        })
    })?;
    rows.collect()
}
