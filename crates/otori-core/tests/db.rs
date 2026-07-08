//! Migration behavior across schema versions.

use otori_core::db;

#[test]
fn v10_reopens_detections_made_by_the_narrow_window_detector() {
    // A v9 library with a detected value (produced by the 70-180
    // detector, possibly octave-halved). Rolling user_version back to
    // 9 and reopening runs the v10 migration. A real v9 library has no
    // mix-anchor or lyrics_offset_ms columns yet — drop them so the
    // replayed v11/v12 migrations see a physically v9-shaped schema.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lib.db");
    {
        let conn = db::open(&path).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (path, format, first_seen, last_scanned,
                 bpm, bpm_confidence, bpm_source, bpm_analyzed_at)
             VALUES ('/a.mp3', 'mp3', datetime('now'), datetime('now'),
                 87.0, 0.8, 'detected', datetime('now'));
             -- A real v9 library predates the v11 mix-anchor, v12
             -- lyrics-offset, and v14 analysis-model columns; drop
             -- them so the replayed migrations can re-add them.
             ALTER TABLE tracks DROP COLUMN mix_head_bpm;
             ALTER TABLE tracks DROP COLUMN mix_head_beat_sec;
             ALTER TABLE tracks DROP COLUMN mix_tail_bpm;
             ALTER TABLE tracks DROP COLUMN mix_tail_beat_sec;
             ALTER TABLE tracks DROP COLUMN mix_analyzed_at;
             ALTER TABLE tracks DROP COLUMN lyrics_offset_ms;
             ALTER TABLE tracks DROP COLUMN analysis_model;",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 9).unwrap();
    }
    let conn = db::open(&path).unwrap();

    // Old detection is reopened (value kept for display until the
    // sweep replaces it, but analysis is pending again).
    let (bpm, analyzed_at): (Option<f64>, Option<String>) = conn
        .query_row(
            "SELECT bpm, bpm_analyzed_at FROM tracks WHERE path = '/a.mp3'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(bpm, Some(87.0), "stale value stays visible until re-swept");
    assert_eq!(analyzed_at, None, "analysis must be pending again");
    assert_eq!(otori_core::analysis::list_analysis_pending(&conn).unwrap().len(), 1);
}

#[test]
fn v13_reopens_everything_for_the_beat_this_engine() {
    // The v12→v13 migration marks the detector swap (classical
    // autocorrelation → Beat This!): every verdict and every mix
    // anchor predates the new engine, so all analysis reopens. Values
    // stay visible until the sweep replaces them (v10 precedent).
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lib.db");
    {
        let conn = db::open(&path).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (path, format, first_seen, last_scanned,
                 bpm, bpm_confidence, bpm_source, bpm_analyzed_at,
                 mix_head_bpm, mix_head_beat_sec, mix_analyzed_at)
             VALUES ('/a.mp3', 'mp3', datetime('now'), datetime('now'),
                 120.0, 0.9, 'detected', datetime('now'),
                 120.0, 0.5, datetime('now'));
             -- A real v12 library predates the v14 analysis-model column;
             -- drop it so the replayed v14 migration can re-add it.
             ALTER TABLE tracks DROP COLUMN analysis_model;",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 12).unwrap();
    }
    let conn = db::open(&path).unwrap();
    let (bpm, bpm_at, mix_at): (Option<f64>, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT bpm, bpm_analyzed_at, mix_analyzed_at FROM tracks WHERE path = '/a.mp3'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(bpm, Some(120.0), "stale value stays visible until re-swept");
    assert_eq!(bpm_at, None);
    assert_eq!(mix_at, None, "anchors re-measure under the new engine too");
}

#[test]
fn v14_adds_analysis_model_without_reopening_or_dropping_values() {
    // The v13→v14 migration adds the analysis_model column (NULL on
    // existing rows) but does NOT reopen analysis or clear values — a
    // pure additive column add. NULL means "unknown model"; the next
    // sweep stamps the active model, and a later model switch re-runs
    // these rows (ReopenScope::Model treats NULL as foreign).
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lib.db");
    {
        let conn = db::open(&path).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (path, format, first_seen, last_scanned,
                 bpm, bpm_confidence, bpm_source, bpm_analyzed_at,
                 mix_head_bpm, mix_head_beat_sec, mix_analyzed_at)
             VALUES ('/a.mp3', 'mp3', datetime('now'), datetime('now'),
                 120.0, 0.9, 'detected', datetime('now'),
                 120.0, 0.5, datetime('now'));
             ALTER TABLE tracks DROP COLUMN analysis_model;",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 13).unwrap();
    }
    let conn = db::open(&path).unwrap();
    let (bpm, bpm_at, model): (Option<f64>, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT bpm, bpm_analyzed_at, analysis_model FROM tracks WHERE path = '/a.mp3'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(bpm, Some(120.0), "v14 must not clear existing values");
    assert!(bpm_at.is_some(), "v13 detection stays analyzed");
    assert_eq!(model, None, "existing rows get NULL (unknown model)");
    // Nothing reopens: a pure column add must not queue work. (Both
    // timestamps set, so the worklist sees this row as done.)
    assert!(otori_core::analysis::list_analysis_pending(&conn).unwrap().is_empty());
}
