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
    let pending = analysis::list_analysis_pending(&conn).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, id);
    assert!(pending[0].needs_bpm);
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
    let pending = analysis::list_analysis_pending(&conn).unwrap();
    assert_eq!(pending.len(), 1);
    assert!(pending[0].needs_bpm);
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
    analysis::set_bpm(&conn, id, Some(analysis::DetectedBpm { bpm: 87.0, bpm_max: None, confidence: 0.6 }), "small").unwrap();
    analysis::set_mix_anchors(&conn, id, None, None, "small").unwrap();
    assert!(analysis::list_analysis_pending(&conn).unwrap().is_empty());

    // …then a wiki/provider hint arrives: analysis re-opens so the
    // detector can re-fold against the anchor.
    analysis::set_bpm_hint(&conn, id, 174.0, None, "provider:wiki").unwrap();
    let pending = analysis::list_analysis_pending(&conn).unwrap();
    assert_eq!(pending.len(), 1);
    assert!(pending[0].needs_bpm);
    assert_eq!(pending[0].hint_bpm, Some(174.0));
}

#[test]
fn hint_validation_rejects_junk() {
    let (conn, id) = seeded_library();
    assert!(analysis::set_bpm_hint(&conn, id, 0.0, None, "provider:wiki").is_err());
    assert!(analysis::set_bpm_hint(&conn, id, 3000.0, None, "provider:wiki").is_err());
    assert!(analysis::set_bpm_hint(&conn, id, 180.0, Some(140.0), "provider:wiki").is_err());
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
    analysis::set_bpm_hint(&conn, id, 180.0, None, "provider:wiki").unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();
    let (hint, source): (f64, String) = conn
        .query_row("SELECT bpm_hint, bpm_hint_source FROM tracks WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(hint, 180.0);
    assert_eq!(source, "provider:wiki");
}

#[test]
fn recording_a_steady_detection_stores_confidence() {
    let (conn, id) = seeded_library();
    analysis::set_bpm(&conn, id, Some(analysis::DetectedBpm { bpm: 128.3, bpm_max: None, confidence: 0.87 }), "small").unwrap();

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
    // BPM recorded, but mix anchors haven't been: still in the
    // worklist, flagged anchors-only.
    let pending = analysis::list_analysis_pending(&conn).unwrap();
    assert_eq!(pending.len(), 1);
    assert!(!pending[0].needs_bpm);
}

#[test]
fn recording_a_variable_tempo_stores_the_range() {
    let (conn, id) = seeded_library();
    analysis::set_bpm(&conn, id, Some(analysis::DetectedBpm { bpm: 140.0, bpm_max: Some(180.0), confidence: 0.6 }), "small").unwrap();

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
    analysis::set_bpm(&conn, id, None, "small").unwrap();

    let pending = analysis::list_analysis_pending(&conn).unwrap();
    assert_eq!(pending.len(), 1);
    assert!(!pending[0].needs_bpm);
    let bpm: Option<f64> = conn
        .query_row("SELECT bpm FROM tracks WHERE id = ?1", [id], |r| r.get(0))
        .unwrap();
    assert_eq!(bpm, None);
}

#[test]
fn mix_anchors_persist_and_clear_the_worklist() {
    let (conn, id) = seeded_library();
    analysis::set_bpm(&conn, id, Some(analysis::DetectedBpm { bpm: 128.0, bpm_max: None, confidence: 0.8 }), "small").unwrap();
    analysis::set_mix_anchors(
        &conn,
        id,
        Some(analysis::MixAnchor { bpm: 128.2, beat_sec: 0.31 }),
        Some(analysis::MixAnchor { bpm: 127.9, beat_sec: 231.4 }),
        "small",
    )
    .unwrap();

    assert!(analysis::list_analysis_pending(&conn).unwrap().is_empty());
    let (hb, hs, tb, ts): (f64, f64, f64, f64) = conn
        .query_row(
            "SELECT mix_head_bpm, mix_head_beat_sec, mix_tail_bpm, mix_tail_beat_sec
             FROM tracks WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert!((hb - 128.2).abs() < 1e-9 && (hs - 0.31).abs() < 1e-9);
    assert!((tb - 127.9).abs() < 1e-9 && (ts - 231.4).abs() < 1e-9);
}

#[test]
fn unstable_ends_are_recorded_as_anchorless_not_retried() {
    let (conn, id) = seeded_library();
    // Both ends unusable (variable tempo / beatless / too long): NULLs,
    // but analyzed — the sweeper must not revisit every launch.
    analysis::set_mix_anchors(&conn, id, None, None, "small").unwrap();

    let pending = analysis::list_analysis_pending(&conn).unwrap();
    assert_eq!(pending.len(), 1); // still needs the BPM verdict...
    assert!(pending[0].needs_bpm);
    analysis::set_bpm(&conn, id, None, "small").unwrap();
    assert!(analysis::list_analysis_pending(&conn).unwrap().is_empty());

    let anchors: (Option<f64>, Option<f64>) = conn
        .query_row(
            "SELECT mix_head_bpm, mix_tail_bpm FROM tracks WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(anchors, (None, None));
}

#[test]
fn unknown_track_fails_fast() {
    let (conn, _) = seeded_library();
    assert!(analysis::set_bpm(&conn, 9999, Some(analysis::DetectedBpm { bpm: 120.0, bpm_max: None, confidence: 0.5 }), "small").is_err());
    assert!(analysis::set_bpm_hint(&conn, 9999, 120.0, None, "tag").is_err());
    assert!(analysis::set_mix_anchors(&conn, 9999, None, None, "small").is_err());
}

#[test]
fn hint_candidates_lists_tracks_worth_a_provider_lookup() {
    let lib = tempfile::tempdir().unwrap();
    write_minimal_mp3(&lib.path().join("blank.mp3"));
    write_minimal_mp3(&lib.path().join("hinted.mp3"));
    write_minimal_mp3(&lib.path().join("confident.mp3"));
    write_minimal_mp3(&lib.path().join("shaky.mp3"));
    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();
    let id_of = |name: &str| -> i64 {
        conn.query_row(
            "SELECT id FROM tracks WHERE path LIKE ?1",
            [format!("%{name}")],
            |r| r.get(0),
        )
        .unwrap()
    };

    // hinted: already has an anchor — not a candidate.
    analysis::set_bpm_hint(&conn, id_of("hinted.mp3"), 174.0, None, "provider:vocadb").unwrap();
    // confident: strong steady detection — not worth a lookup.
    analysis::set_bpm(&conn, id_of("confident.mp3"), Some(analysis::DetectedBpm { bpm: 128.0, bpm_max: None, confidence: 0.9 }), "small").unwrap();
    // shaky: low confidence — candidate.
    analysis::set_bpm(&conn, id_of("shaky.mp3"), Some(analysis::DetectedBpm { bpm: 87.0, bpm_max: None, confidence: 0.3 }), "small").unwrap();
    // blank: never analyzed (or beatless) — candidate.

    let candidates = analysis::list_hint_candidates(&conn, 0.6).unwrap();
    let paths: Vec<&str> = candidates
        .iter()
        .map(|c| {
            Path::new(&c.path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap()
        })
        .collect();
    assert!(paths.contains(&"blank.mp3"));
    assert!(paths.contains(&"shaky.mp3"));
    assert!(!paths.contains(&"hinted.mp3"));
    assert!(!paths.contains(&"confident.mp3"));
}

// ---- reanalysis entry (docs/design/bpm-analysis-rust.md) ----

/// Mark a track fully analyzed with a given confidence, so reopen
/// scopes have something to distinguish.
fn analyzed(conn: &otori_core::Connection, id: i64, confidence: f64) {
    analysis::set_bpm(
        conn,
        id,
        Some(analysis::DetectedBpm { bpm: 120.0, bpm_max: None, confidence }),
        "small",
    )
    .unwrap();
    analysis::set_mix_anchors(conn, id, None, None, "small").unwrap();
}

fn seeded_pair() -> (otori_core::Connection, i64, i64) {
    let lib = tempfile::tempdir().unwrap();
    write_minimal_mp3(&lib.path().join("a.mp3"));
    write_minimal_mp3(&lib.path().join("b.mp3"));
    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();
    let mut ids = Vec::new();
    let mut stmt = conn.prepare("SELECT id FROM tracks ORDER BY id").unwrap();
    let rows: Vec<i64> = stmt.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
    ids.extend(rows);
    drop(stmt);
    (conn, ids[0], ids[1])
}

#[test]
fn reopen_all_requeues_every_track_keeping_values() {
    let (conn, a, b) = seeded_pair();
    analyzed(&conn, a, 0.9);
    analyzed(&conn, b, 0.9);
    assert_eq!(analysis::list_analysis_pending(&conn).unwrap().len(), 0);

    let n = analysis::reopen_analysis(&conn, analysis::ReopenScope::All).unwrap();
    assert_eq!(n, 2);
    assert_eq!(analysis::list_analysis_pending(&conn).unwrap().len(), 2);
    // Stale values stay visible until the sweep replaces them.
    let bpm: Option<f64> =
        conn.query_row("SELECT bpm FROM tracks WHERE id = ?1", [a], |r| r.get(0)).unwrap();
    assert_eq!(bpm, Some(120.0));
}

#[test]
fn reopen_low_confidence_requeues_only_shaky_and_beatless() {
    let (conn, a, b) = seeded_pair();
    analyzed(&conn, a, 0.2); // shaky
    analyzed(&conn, b, 0.9); // solid
    let n = analysis::reopen_analysis(&conn, analysis::ReopenScope::LowConfidence(0.4)).unwrap();
    assert_eq!(n, 1);
    let pending = analysis::list_analysis_pending(&conn).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, a);
}

#[test]
fn reopen_low_confidence_includes_beatless_verdicts() {
    let (conn, a, b) = seeded_pair();
    analysis::set_bpm(&conn, a, None, "small").unwrap(); // beatless verdict
    analysis::set_mix_anchors(&conn, a, None, None, "small").unwrap();
    analyzed(&conn, b, 0.9);
    let n = analysis::reopen_analysis(&conn, analysis::ReopenScope::LowConfidence(0.4)).unwrap();
    assert_eq!(n, 1);
    assert_eq!(analysis::list_analysis_pending(&conn).unwrap()[0].id, a);
}

#[test]
fn reopen_tracks_scope_hits_exactly_those_ids() {
    let (conn, a, b) = seeded_pair();
    analyzed(&conn, a, 0.9);
    analyzed(&conn, b, 0.9);
    let n = analysis::reopen_analysis(&conn, analysis::ReopenScope::Tracks(&[b])).unwrap();
    assert_eq!(n, 1);
    let pending = analysis::list_analysis_pending(&conn).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, b);
}

#[test]
fn reopen_unknown_track_fails_fast() {
    let (conn, _, _) = seeded_pair();
    let err = analysis::reopen_analysis(&conn, analysis::ReopenScope::Tracks(&[9999]));
    assert!(err.is_err(), "unknown ids are caller bugs, not no-ops");
}

// ---- model switch reanalysis (v14: analysis_model provenance) ----

#[test]
fn verdict_stamps_the_model_that_produced_it() {
    let (conn, id) = seeded_library();
    analysis::set_bpm(
        &conn,
        id,
        Some(analysis::DetectedBpm { bpm: 128.0, bpm_max: None, confidence: 0.8 }),
        "small",
    )
    .unwrap();
    analysis::set_mix_anchors(&conn, id, None, None, "standard").unwrap();
    let (bpm_model, mix_model): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT analysis_model, analysis_model FROM tracks WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    // set_mix_anchors runs second; the last writer wins, so the recorded
    // model is the one that last touched the row.
    assert_eq!(mix_model.as_deref(), Some("standard"));
    let _ = bpm_model;
}

#[test]
fn reopen_model_keeps_same_model_verdicts_and_re_runs_foreign() {
    let (conn, a, b) = seeded_pair();
    analyzed(&conn, a, 0.9); // analyzed() stamps "small"
    analysis::set_bpm(
        &conn,
        b,
        Some(analysis::DetectedBpm { bpm: 120.0, bpm_max: None, confidence: 0.9 }),
        "standard",
    )
    .unwrap();
    analysis::set_mix_anchors(&conn, b, None, None, "standard").unwrap();
    assert!(analysis::list_analysis_pending(&conn).unwrap().is_empty());

    // Switch to small: only the standard verdict (b) re-opens; the
    // small verdict (a) is kept — a round trip must not re-run the
    // whole library.
    let n = analysis::reopen_analysis(&conn, analysis::ReopenScope::Model("small")).unwrap();
    assert_eq!(n, 1);
    let pending = analysis::list_analysis_pending(&conn).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, b);
}

#[test]
fn reopen_model_treats_null_analysis_model_as_foreign() {
    let (conn, a, b) = seeded_pair();
    analyzed(&conn, a, 0.9); // "small"
    // Simulate a pre-v14 library row: analyzed but no model stamp.
    conn.execute(
        "UPDATE tracks SET analysis_model = NULL, bpm = 130.0,
            bpm_analyzed_at = datetime('now'), mix_analyzed_at = datetime('now')
         WHERE id = ?1",
        [b],
    )
    .unwrap();
    assert!(analysis::list_analysis_pending(&conn).unwrap().is_empty());

    // A model switch must re-run rows whose model is unknown (NULL),
    // not keep them — that's exactly the "older Ōtori wrote this" case.
    let n = analysis::reopen_analysis(&conn, analysis::ReopenScope::Model("small")).unwrap();
    assert_eq!(n, 1);
    let pending = analysis::list_analysis_pending(&conn).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, b);
}

#[test]
fn hint_candidates_fold_the_cutoff_for_variable_tempo_verdicts() {
    let lib = tempfile::tempdir().unwrap();
    write_minimal_mp3(&lib.path().join("soflan-solid.mp3"));
    write_minimal_mp3(&lib.path().join("steady-shaky.mp3"));
    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();
    let id_of = |name: &str| -> i64 {
        conn.query_row(
            "SELECT id FROM tracks WHERE path LIKE ?1",
            [format!("%{name}")],
            |r| r.get(0),
        )
        .unwrap()
    };

    // Both store confidence 0.45 — but the soflan verdict's confidence
    // already carries the x0.5 range penalty (derive.rs), so against
    // the folded cutoff (0.3) it is a CLEAN detection, not a candidate.
    // The UI badge (query::TrackRow::bpm_shaky) folds the same way;
    // before this predicate was shared, the raw SQL comparison listed
    // soflan tracks the badge called clean (the 7aa83ea drift class).
    analysis::set_bpm(&conn, id_of("soflan-solid.mp3"), Some(analysis::DetectedBpm { bpm: 140.0, bpm_max: Some(200.0), confidence: 0.45 }), "small").unwrap();
    analysis::set_bpm(&conn, id_of("steady-shaky.mp3"), Some(analysis::DetectedBpm { bpm: 128.0, bpm_max: None, confidence: 0.45 }), "small").unwrap();

    let candidates = analysis::list_hint_candidates(&conn, analysis::SHAKY_CONFIDENCE).unwrap();
    let names: Vec<&str> = candidates
        .iter()
        .map(|c| Path::new(&c.path).file_name().and_then(|n| n.to_str()).unwrap())
        .collect();
    assert!(names.contains(&"steady-shaky.mp3"));
    assert!(!names.contains(&"soflan-solid.mp3"));
}
