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
//! A manual override is the third tier, above detection: the user
//! states the tempo directly, so `set_bpm_manual` writes bpm/bpm_max
//! with source 'manual' and marks the track analyzed. Manual verdicts
//! are never shaky (`is_shaky_bpm` folds them out) and are skipped by
//! every bulk reopen — a whole-library reanalyze must not silently
//! discard a human's verdict. The one deliberate override is
//! ReanalyzeScope::Tracks ("reanalyze selected"): a direct gesture on
//! those exact rows means "replace whatever's here, including my own
//! earlier call."
//!
//! Besides the BPM column verdict, each pass records mix anchors:
//! per-end local beat grids (bpm + a measured beat) for crossfade
//! planning. Always detected — no external source knows beat phase —
//! so hint-satisfied tracks still pass through the sweeper once.

use rusqlite::Connection;
use serde::Serialize;

/// Confidence below which a steady detection counts as shaky. The ONE
/// authority for "shaky" — the GUI badge (query::TrackRow::bpm_shaky),
/// the CLI's hint-candidates/reanalyze defaults, and any future
/// consumer all fold from here. Before this existed, the UI kept its
/// own inline cutoff and drifted from the CLI (fixed in 7aa83ea);
/// keeping two copies re-opens that class of bug.
pub const SHAKY_CONFIDENCE: f64 = 0.6;

/// Is a detection shaky against `min_confidence`? Variable-tempo
/// (soflan) verdicts store confidence with the x0.5 range penalty
/// already applied (derive.rs: "a range is honest, a mean is a lie"),
/// so the cutoff folds with them — a clean soflan range is not shaky.
/// A detection with no recorded confidence is shaky by definition.
pub fn is_shaky_detection(
    bpm_max: Option<f64>,
    confidence: Option<f64>,
    min_confidence: f64,
) -> bool {
    let cutoff = if bpm_max.is_some() { min_confidence / 2.0 } else { min_confidence };
    confidence.unwrap_or(0.0) < cutoff
}

/// Should a BPM value warn in a listing? Shaky detections and
/// unverified external hints do; a blank row has nothing to warn about.
/// A manual verdict (the user said so) is never shaky.
pub fn is_shaky_bpm(
    bpm: Option<f64>,
    bpm_max: Option<f64>,
    confidence: Option<f64>,
    hint: Option<f64>,
    bpm_source: Option<&str>,
) -> bool {
    if bpm_source == Some("manual") {
        return false;
    }
    if bpm.is_some() {
        return is_shaky_detection(bpm_max, confidence, SHAKY_CONFIDENCE);
    }
    hint.is_some()
}

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
    // Manual BPM verdicts are never pending on the BPM axis — the user
    // settled it — but mix anchors are still detector work, so a manual
    // track lacking anchors still appears (needs_bpm false, anchors only).
    let mut stmt = conn.prepare(
        "SELECT id, path,
                (bpm_analyzed_at IS NULL AND bpm_source IS DISTINCT FROM 'manual'),
                bpm_hint, bpm_hint_max
         FROM tracks
         WHERE (bpm_analyzed_at IS NULL AND bpm_source IS DISTINCT FROM 'manual')
            OR mix_analyzed_at IS NULL
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
/// `model` stamps which analysis model produced the verdict, so a
/// later model switch can reopen only foreign-model verdicts. Fails
/// fast on unknown ids.
pub fn set_bpm(
    conn: &Connection,
    track_id: i64,
    detected: Option<DetectedBpm>,
    model: &str,
) -> rusqlite::Result<()> {
    set_bpm_with_source(conn, track_id, detected, false, model)
}

/// `set_bpm` variant recording that the hint anchored the result.
pub fn set_bpm_verified(
    conn: &Connection,
    track_id: i64,
    detected: DetectedBpm,
    model: &str,
) -> rusqlite::Result<()> {
    set_bpm_with_source(conn, track_id, Some(detected), true, model)
}

fn set_bpm_with_source(
    conn: &Connection,
    track_id: i64,
    detected: Option<DetectedBpm>,
    used_hint: bool,
    model: &str,
) -> rusqlite::Result<()> {
    let source = if used_hint { "detected+hint" } else { "detected" };
    let updated = match detected {
        Some(d) => conn.execute(
            "UPDATE tracks
             SET bpm = ?1, bpm_max = ?2, bpm_confidence = ?3,
                 bpm_source = ?4, bpm_analyzed_at = datetime('now'),
                 analysis_model = ?5
             WHERE id = ?6",
            rusqlite::params![d.bpm, d.bpm_max, d.confidence, source, model, track_id],
        )?,
        None => conn.execute(
            "UPDATE tracks
             SET bpm = NULL, bpm_max = NULL, bpm_confidence = NULL,
                 bpm_source = NULL, bpm_analyzed_at = datetime('now'),
                 analysis_model = ?2
             WHERE id = ?1",
            rusqlite::params![track_id, model],
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
/// produced a value or shaky against `min_confidence` (folded for
/// variable-tempo verdicts — `is_shaky_detection` is the authority).
/// Ordered blank-first (a missing number hurts more than a shaky one).
pub fn list_hint_candidates(
    conn: &Connection,
    min_confidence: f64,
) -> rusqlite::Result<Vec<HintCandidate>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.path, t.bpm, t.bpm_confidence, t.bpm_max,
                MAX(CASE WHEN v.field = 'title' THEN v.value END) AS title,
                MAX(CASE WHEN v.field = 'artist' THEN v.value END) AS artist
         FROM tracks t
         LEFT JOIN tag_values v ON v.track_id = t.id
         WHERE t.bpm_hint IS NULL
         GROUP BY t.id
         ORDER BY t.bpm IS NOT NULL, t.id",
    )?;
    let rows = stmt.query_map([], |row| {
        let bpm_max: Option<f64> = row.get(4)?;
        Ok((
            HintCandidate {
                id: row.get(0)?,
                path: row.get(1)?,
                bpm: row.get(2)?,
                bpm_confidence: row.get(3)?,
                title: row.get(5)?,
                artist: row.get(6)?,
            },
            bpm_max,
        ))
    })?;
    // The shaky predicate lives in Rust, not SQL: one authority for
    // the fold, shared with the GUI badge.
    let mut out = Vec::new();
    for row in rows {
        let (candidate, bpm_max) = row?;
        if candidate.bpm.is_none()
            || is_shaky_detection(bpm_max, candidate.bpm_confidence, min_confidence)
        {
            out.push(candidate);
        }
    }
    Ok(out)
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

/// Which tracks a reanalysis pass reopens.
#[derive(Debug, Clone, Copy)]
pub enum ReopenScope<'a> {
    /// Every track (algorithm change, parameter sweep).
    All,
    /// Shaky detections below the threshold, plus beatless verdicts —
    /// the tracks where a better pass could actually change the answer.
    LowConfidence(f64),
    /// Exactly these tracks (GUI "reanalyze selected").
    Tracks(&'a [i64]),
    /// Only tracks whose verdict came from a *different* model than
    /// `model` (or from no model — pre-v14 libraries). Used when the
    /// user switches the active analysis model: stale same-model
    /// verdicts are kept (a switch to standard then back to small must
    /// not re-run the whole library), foreign-model verdicts are re-run.
    Model(&'a str),
}

/// Record a manual (user-stated) BPM verdict. The third trust tier,
/// above detection: writes bpm/bpm_max directly with source 'manual'
/// and marks the track analyzed, so it leaves the pending worklist and
/// never warns as shaky. Sanity-gated like a hint (20..400 BPM, range
/// ceiling >= floor) so a typo can't poison mix planning. Fails fast on
/// unknown ids. Bulk reopen scopes (All/LowConfidence/Model) skip
/// manual rows; only ReopenScope::Tracks ("reanalyze selected")
/// overrides one — see the trust-model note at the top of this module.
pub fn set_bpm_manual(
    conn: &Connection,
    track_id: i64,
    bpm: f64,
    bpm_max: Option<f64>,
) -> rusqlite::Result<()> {
    let bpm_ok = (20.0..=400.0).contains(&bpm);
    let range_ok = bpm_max.is_none_or(|max| max >= bpm && max <= 400.0);
    if !bpm_ok || !range_ok {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "invalid manual bpm: bpm={bpm} bpm_max={bpm_max:?}"
        )));
    }
    let updated = conn.execute(
        "UPDATE tracks
         SET bpm = ?1, bpm_max = ?2, bpm_confidence = NULL,
             bpm_source = 'manual', bpm_analyzed_at = datetime('now')
         WHERE id = ?3",
        rusqlite::params![bpm, bpm_max, track_id],
    )?;
    if updated == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

/// Reopen analysis for a scope: clears `bpm_analyzed_at` and
/// `mix_analyzed_at` so the sweep re-verdicts. Detected values and
/// hints stay in place until overwritten — a probably-right number
/// beats a blank column mid-resweep (v10 migration precedent).
/// Manual verdicts (source 'manual') are skipped by every bulk scope
/// (All/LowConfidence/Model): a whole-library reanalyze must not
/// discard a human's verdict. `Tracks` is the one deliberate override
/// — "reanalyze selected" replaces whatever's on those exact rows,
/// manual included. Returns the number of tracks reopened. Fails fast
/// when a `Tracks` scope names an unknown id.
pub fn reopen_analysis(conn: &Connection, scope: ReopenScope) -> rusqlite::Result<usize> {
    // Manual verdicts survive every bulk reopen; only a direct Tracks
    // gesture on those exact rows overrides one (see trust model above).
    const SKIP_MANUAL: &str = " AND bpm_source IS DISTINCT FROM 'manual'";
    let reopened = match scope {
        ReopenScope::All => conn.execute(
            &format!(
                "UPDATE tracks SET bpm_analyzed_at = NULL, mix_analyzed_at = NULL
                 WHERE 1=1{SKIP_MANUAL}"
            ),
            [],
        )?,
        ReopenScope::LowConfidence(threshold) => conn.execute(
            &format!(
                "UPDATE tracks SET bpm_analyzed_at = NULL, mix_analyzed_at = NULL
                 WHERE bpm_analyzed_at IS NOT NULL
                   AND (bpm IS NULL OR bpm_confidence < ?1){SKIP_MANUAL}"
            ),
            [threshold],
        )?,
        ReopenScope::Tracks(ids) => {
            let mut stmt = conn.prepare(
                "UPDATE tracks SET bpm_analyzed_at = NULL, mix_analyzed_at = NULL
                 WHERE id = ?1",
            )?;
            let mut n = 0;
            for &id in ids {
                if stmt.execute([id])? == 0 {
                    return Err(rusqlite::Error::QueryReturnedNoRows);
                }
                n += 1;
            }
            n
        }
        ReopenScope::Model(model) => conn.execute(
            &format!(
                // Reopen verdicts whose recorded model differs from the
                // active one (or is NULL — a pre-v14 library). Same-model
                // verdicts stay: a small→standard→small round trip must not
                // re-run the whole library on the way back. Manual verdicts
                // are kept regardless of model — they are not detector output.
                "UPDATE tracks SET bpm_analyzed_at = NULL, mix_analyzed_at = NULL
                 WHERE bpm_analyzed_at IS NOT NULL
                   AND (analysis_model IS NULL OR analysis_model != ?1){SKIP_MANUAL}"
            ),
            [model],
        )?,
    };
    Ok(reopened)
}

/// Record mix anchors for both ends. `None` for an end = that end has
/// no stable local grid (variable tempo inside the window, beatless,
/// or the detector failed) — beat-matching must not be attempted
/// there. Recorded as analyzed either way so the sweeper moves on.
/// `model` stamps which analysis model measured the anchors (same
/// reasoning as `set_bpm`). Fails fast on unknown ids.
pub fn set_mix_anchors(
    conn: &Connection,
    track_id: i64,
    head: Option<MixAnchor>,
    tail: Option<MixAnchor>,
    model: &str,
) -> rusqlite::Result<()> {
    let updated = conn.execute(
        "UPDATE tracks
         SET mix_head_bpm = ?1, mix_head_beat_sec = ?2,
             mix_tail_bpm = ?3, mix_tail_beat_sec = ?4,
             mix_analyzed_at = datetime('now'),
             analysis_model = ?5
         WHERE id = ?6",
        rusqlite::params![
            head.map(|a| a.bpm),
            head.map(|a| a.beat_sec),
            tail.map(|a| a.bpm),
            tail.map(|a| a.beat_sec),
            model,
            track_id
        ],
    )?;
    if updated == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}
