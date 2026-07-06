//! BPM analysis bookkeeping: which tracks still need analysis, and
//! recording results. Detection itself runs in the GUI (Web Audio
//! decode); the index stores the outcome so it survives restarts and
//! is visible to the CLI/agents.

use std::fs;
use std::path::Path;

use otori_core::{analysis, db, scan};

fn write_minimal_mp3(path: &Path) {
    let mut frame = vec![0xFF, 0xFB, 0x90, 0x00];
    frame.resize(417, 0);
    let mut bytes = Vec::new();
    for _ in 0..4 {
        bytes.extend_from_slice(&frame);
    }
    fs::write(path, bytes).unwrap();
}

fn seeded_library() -> (otori_core::Connection, i64) {
    let lib = tempfile::tempdir().unwrap();
    write_minimal_mp3(&lib.path().join("a.mp3"));
    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();
    let id: i64 = conn
        .query_row("SELECT id FROM tracks LIMIT 1", [], |r| r.get(0))
        .unwrap();
    (conn, id)
}

#[test]
fn fresh_tracks_are_pending_analysis() {
    let (conn, id) = seeded_library();
    let pending = analysis::list_bpm_pending(&conn).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, id);
    assert!(pending[0].path.ends_with("a.mp3"));
}

#[test]
fn recording_a_bpm_clears_pending_and_lists_the_value() {
    let (conn, id) = seeded_library();
    analysis::set_bpm(&conn, id, Some(128.3)).unwrap();

    assert!(analysis::list_bpm_pending(&conn).unwrap().is_empty());
    let bpm: f64 = conn
        .query_row("SELECT bpm FROM tracks WHERE id = ?1", [id], |r| r.get(0))
        .unwrap();
    assert!((bpm - 128.3).abs() < 1e-9);
}

#[test]
fn beatless_result_is_recorded_as_analyzed_without_a_bpm() {
    let (conn, id) = seeded_library();
    // None = analyzed, no steady beat (ambient) — distinct from
    // "never analyzed", so the sweeper won't retry forever.
    analysis::set_bpm(&conn, id, None).unwrap();

    assert!(analysis::list_bpm_pending(&conn).unwrap().is_empty());
    let bpm: Option<f64> = conn
        .query_row("SELECT bpm FROM tracks WHERE id = ?1", [id], |r| r.get(0))
        .unwrap();
    assert_eq!(bpm, None);
}

#[test]
fn unknown_track_fails_fast() {
    let (conn, _) = seeded_library();
    assert!(analysis::set_bpm(&conn, 9999, Some(120.0)).is_err());
}
