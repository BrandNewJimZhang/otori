//! Migration behavior across schema versions.

use otori_core::db;

#[test]
fn v10_reopens_detections_made_by_the_narrow_window_detector() {
    // A v9 library with a detected value (produced by the 70-180
    // detector, possibly octave-halved). Rolling user_version back to
    // 9 and reopening runs the v10 migration.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lib.db");
    {
        let conn = db::open(&path).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (path, format, first_seen, last_scanned,
                 bpm, bpm_confidence, bpm_source, bpm_analyzed_at)
             VALUES ('/a.mp3', 'mp3', datetime('now'), datetime('now'),
                 87.0, 0.8, 'detected', datetime('now'));
             -- A real v9 library predates the v11 mix-anchor columns;
             -- drop them so the replayed migrations can re-add them.
             ALTER TABLE tracks DROP COLUMN mix_head_bpm;
             ALTER TABLE tracks DROP COLUMN mix_head_beat_sec;
             ALTER TABLE tracks DROP COLUMN mix_tail_bpm;
             ALTER TABLE tracks DROP COLUMN mix_tail_beat_sec;
             ALTER TABLE tracks DROP COLUMN mix_analyzed_at;",
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
