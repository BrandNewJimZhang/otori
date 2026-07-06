//! BPM analysis bookkeeping: hints vs verified detections.
//!
//! External BPM data (TBPM tags, VocaDB/wiki/provider values) is a
//! *hint* — an analysis anchor, never a result (founding-user decision
//! 2026-07-07: published BPM is a great basis but can't be used
//! directly). The GUI detector verifies hints (octave folding) and
//! owns the bpm column; hints live in their own columns.

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
fn fresh_tracks_are_pending_with_no_hint() {
    let (conn, id) = seeded_library();
    let pending = analysis::list_bpm_pending(&conn).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, id);
    assert_eq!(pending[0].hint_bpm, None);
}

#[test]
fn tbpm_tag_becomes_a_hint_and_stays_pending() {
    let lib = tempfile::tempdir().unwrap();
    write_mp3_with_tbpm(&lib.path().join("tagged.mp3"), "185");

    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();

    // Tag lands as a hint, NOT as bpm; detection still pending, and
    // the pending row carries the hint for octave anchoring.
    let (bpm, hint, source): (Option<f64>, f64, String) = conn
        .query_row(
            "SELECT bpm, bpm_hint, bpm_hint_source FROM tracks WHERE path LIKE '%tagged.mp3'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(bpm, None);
    assert_eq!(hint, 185.0);
    assert_eq!(source, "tag");
    let pending = analysis::list_bpm_pending(&conn).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].hint_bpm, Some(185.0));
}

#[test]
fn nonsense_tbpm_tags_are_ignored() {
    let lib = tempfile::tempdir().unwrap();
    write_mp3_with_tbpm(&lib.path().join("zero.mp3"), "0");

    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();

    let hint: Option<f64> = conn
        .query_row("SELECT bpm_hint FROM tracks WHERE path LIKE '%zero.mp3'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(hint, None);
}

#[test]
fn provider_hint_reopens_analysis_for_verification() {
    let (conn, id) = seeded_library();
    // Old detection exists…
    analysis::set_bpm(&conn, id, Some(analysis::DetectedBpm { bpm: 87.0, bpm_max: None, confidence: 0.6 })).unwrap();
    assert!(analysis::list_bpm_pending(&conn).unwrap().is_empty());

    // …then a wiki/provider hint arrives: analysis re-opens so the
    // detector can re-fold against the anchor.
    analysis::set_bpm_hint(&conn, id, 174.0, None, "provider:tunebat").unwrap();
    let pending = analysis::list_bpm_pending(&conn).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].hint_bpm, Some(174.0));
}

#[test]
fn hint_validation_rejects_junk() {
    let (conn, id) = seeded_library();
    assert!(analysis::set_bpm_hint(&conn, id, 0.0, None, "provider:tunebat").is_err());
    assert!(analysis::set_bpm_hint(&conn, id, 3000.0, None, "provider:tunebat").is_err());
    assert!(analysis::set_bpm_hint(&conn, id, 180.0, Some(140.0), "provider:tunebat").is_err());
    assert!(analysis::set_bpm_hint(&conn, id, 150.0, None, "Provider:X").is_err());
    assert!(analysis::set_bpm_hint(&conn, id, 150.0, None, "tag").is_ok());
    assert!(analysis::set_bpm_hint(&conn, id, 150.0, None, "provider:vocadb").is_ok());
}

#[test]
fn scan_does_not_clobber_a_provider_hint_with_a_tag() {
    let lib = tempfile::tempdir().unwrap();
    write_mp3_with_tbpm(&lib.path().join("both.mp3"), "90");
    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();
    let id: i64 = conn
        .query_row("SELECT id FROM tracks LIMIT 1", [], |r| r.get(0))
        .unwrap();

    // Deliberate provider import wins over the rescanned tag.
    analysis::set_bpm_hint(&conn, id, 180.0, None, "provider:tunebat").unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();
    let (hint, source): (f64, String) = conn
        .query_row("SELECT bpm_hint, bpm_hint_source FROM tracks WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(hint, 180.0);
    assert_eq!(source, "provider:tunebat");
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
fn unknown_track_fails_fast() {
    let (conn, _) = seeded_library();
    assert!(analysis::set_bpm(&conn, 9999, Some(analysis::DetectedBpm { bpm: 120.0, bpm_max: None, confidence: 0.5 })).is_err());
    assert!(analysis::set_bpm_hint(&conn, 9999, 120.0, None, "tag").is_err());
}
