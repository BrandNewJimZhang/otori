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
    /// Tempo (or range floor); NULL until analyzed (or beatless).
    pub bpm: Option<f64>,
    /// Range ceiling for variable-tempo (soflan) tracks; NULL = steady.
    pub bpm_max: Option<f64>,
    /// 0..1 detector confidence.
    pub bpm_confidence: Option<f64>,
    /// External anchor awaiting/used in verification (tag/provider).
    pub bpm_hint: Option<f64>,
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
            bpm_max: row.get(6)?,
            bpm_confidence: row.get(7)?,
            bpm_hint: row.get(8)?,
            mix_head_bpm: row.get(9)?,
            mix_head_beat_sec: row.get(10)?,
            mix_tail_bpm: row.get(11)?,
            mix_tail_beat_sec: row.get(12)?,
            mix_analyzed: row.get(13)?,
            lyrics_offset_ms: row.get(14)?,
            title: row.get(15)?,
            artist: row.get(16)?,
            album: row.get(17)?,
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
