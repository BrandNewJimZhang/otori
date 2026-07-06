//! BPM analysis bookkeeping: which tracks still need analysis, and
//! recording results with trust metadata (source, confidence, range).
//! Detection itself runs in the GUI; TBPM tags are read at scan time.

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

fn write_mp3_with_tbpm(path: &Path, bpm: &str) {
    use lofty::prelude::*;
    use lofty::tag::{ItemKey, Tag, TagType};
    write_minimal_mp3(path);
    let mut tag = Tag::new(TagType::Id3v2);
    tag.insert_text(ItemKey::IntegerBpm, bpm.to_string());
    tag.save_to_path(path, lofty::config::WriteOptions::default()).unwrap();
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
fn scan_trusts_a_tbpm_tag_and_skips_detection() {
    let lib = tempfile::tempdir().unwrap();
    write_mp3_with_tbpm(&lib.path().join("tagged.mp3"), "185");

    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();

    // Tag value lands directly: bpm set, source 'tag', confidence 1,
    // and the track is NOT pending detection.
    let (bpm, source, conf): (f64, String, f64) = conn
        .query_row(
            "SELECT bpm, bpm_source, bpm_confidence FROM tracks WHERE path LIKE '%tagged.mp3'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(bpm, 185.0);
    assert_eq!(source, "tag");
    assert_eq!(conf, 1.0);
    assert!(analysis::list_bpm_pending(&conn).unwrap().is_empty());
}

#[test]
fn nonsense_tbpm_tags_are_ignored() {
    let lib = tempfile::tempdir().unwrap();
    write_mp3_with_tbpm(&lib.path().join("zero.mp3"), "0");

    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();

    // 0 / unparseable TBPM = no data, not "0 BPM": still pending.
    assert_eq!(analysis::list_bpm_pending(&conn).unwrap().len(), 1);
}

#[test]
fn recording_a_steady_detection_stores_confidence() {
    let (conn, id) = seeded_library();
    analysis::set_bpm(&conn, id, Some(analysis::DetectedBpm { bpm: 128.3, bpm_max: None, confidence: 0.87 })).unwrap();

    let (bpm, bpm_max, conf, source): (f64, Option<f64>, f64, String) = conn
        .query_row(
            "SELECT bpm, bpm_max, bpm_confidence, bpm_source FROM tracks WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert!((bpm - 128.3).abs() < 1e-9);
    assert_eq!(bpm_max, None);
    assert!((conf - 0.87).abs() < 1e-9);
    assert_eq!(source, "detected");
    assert!(analysis::list_bpm_pending(&conn).unwrap().is_empty());
}

#[test]
fn recording_a_variable_tempo_stores_the_range() {
    let (conn, id) = seeded_library();
    analysis::set_bpm(&conn, id, Some(analysis::DetectedBpm { bpm: 140.0, bpm_max: Some(180.0), confidence: 0.6 })).unwrap();

    let (bpm, bpm_max): (f64, Option<f64>) = conn
        .query_row("SELECT bpm, bpm_max FROM tracks WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(bpm, 140.0);
    assert_eq!(bpm_max, Some(180.0));
}

#[test]
fn beatless_result_is_recorded_as_analyzed_without_a_bpm() {
    let (conn, id) = seeded_library();
    analysis::set_bpm(&conn, id, None).unwrap();

    assert!(analysis::list_bpm_pending(&conn).unwrap().is_empty());
    let bpm: Option<f64> = conn
        .query_row("SELECT bpm FROM tracks WHERE id = ?1", [id], |r| r.get(0))
        .unwrap();
    assert_eq!(bpm, None);
}

#[test]
fn tag_sourced_bpm_is_never_overwritten_by_detection() {
    let lib = tempfile::tempdir().unwrap();
    write_mp3_with_tbpm(&lib.path().join("tagged.mp3"), "185");
    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();
    let id: i64 = conn
        .query_row("SELECT id FROM tracks LIMIT 1", [], |r| r.get(0))
        .unwrap();

    // A stray detection result must not clobber the authoritative tag.
    assert!(analysis::set_bpm(&conn, id, Some(analysis::DetectedBpm { bpm: 92.0, bpm_max: None, confidence: 0.9 })).is_err());
    let bpm: f64 = conn
        .query_row("SELECT bpm FROM tracks WHERE id = ?1", [id], |r| r.get(0))
        .unwrap();
    assert_eq!(bpm, 185.0);
}

#[test]
fn unknown_track_fails_fast() {
    let (conn, _) = seeded_library();
    assert!(analysis::set_bpm(&conn, 9999, Some(analysis::DetectedBpm { bpm: 120.0, bpm_max: None, confidence: 0.5 })).is_err());
}
