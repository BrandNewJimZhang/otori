//! The L2 trust stack end to end: plan (dry-run) → apply (snapshot +
//! file write + provenance + journal) → undo. Every PRODUCT.md L2 rule
//! has a test here; if one of these breaks, delegation stops being safe.

use std::fs;
use std::path::{Path, PathBuf};

use otori_core::write::{self, Actor, FieldChange, PlanOutcome};
use otori_core::{db, scan};

fn write_tagged_mp3(path: &Path, title: &str, artist: &str) {
    use lofty::prelude::*;
    use lofty::tag::{Tag, TagType};
    let mut frame = vec![0xFF, 0xFB, 0x90, 0x00];
    frame.resize(417, 0);
    let mut bytes = Vec::new();
    for _ in 0..4 {
        bytes.extend_from_slice(&frame);
    }
    fs::write(path, bytes).unwrap();
    let mut tag = Tag::new(TagType::Id3v2);
    tag.set_title(title.to_string());
    tag.set_artist(artist.to_string());
    tag.save_to_path(path, lofty::config::WriteOptions::default())
        .unwrap();
}

/// Scanned library with one track; returns (conn, track path).
fn library_with_track(dir: &Path) -> (otori_core::Connection, PathBuf) {
    let p = dir.join("song.mp3");
    write_tagged_mp3(&p, "Old Title", "Old Artist");
    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, dir).unwrap();
    (conn, p)
}

fn human(field: &str, value: &str) -> FieldChange {
    FieldChange { field: field.into(), value: value.into() }
}

#[test]
fn plan_shows_diff_without_touching_anything() {
    let dir = tempfile::tempdir().unwrap();
    let (mut conn, path) = library_with_track(dir.path());

    let plan = write::plan_set(
        &mut conn,
        &path,
        &[human("title", "New Title")],
        Actor::Human { via: "cli" },
        false,
    )
    .unwrap();

    assert_eq!(plan.changes.len(), 1);
    assert_eq!(plan.changes[0].old.as_deref(), Some("Old Title"));
    assert_eq!(plan.changes[0].new, "New Title");

    // Dry-run must not write: file and index unchanged.
    let on_disk = otori_core::read_track_tags(&path).unwrap();
    assert_eq!(on_disk.title.as_deref(), Some("Old Title"));
    let journal: i64 = conn
        .query_row("SELECT count(*) FROM transactions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(journal, 0);
}

#[test]
fn apply_writes_file_index_and_journal_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let (mut conn, path) = library_with_track(dir.path());

    let tx_id = write::apply_set(
        &mut conn,
        &path,
        &[human("title", "New Title")],
        Actor::Human { via: "cli" },
        false,
    )
    .unwrap()
    .expect("apply must produce a transaction");

    // File is the SSOT for values — the write must reach disk.
    let on_disk = otori_core::read_track_tags(&path).unwrap();
    assert_eq!(on_disk.title.as_deref(), Some("New Title"));

    // Index reflects it with human provenance (born curated).
    let (value, source, curated): (String, String, i64) = conn
        .query_row(
            "SELECT v.value, v.source, v.curated FROM tag_values v
             JOIN tracks t ON t.id = v.track_id
             WHERE v.field = 'title'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(value, "New Title");
    assert_eq!(source, "human");
    assert_eq!(curated, 1);

    // Journal has old and new.
    let (old_v, new_v): (String, String) = conn
        .query_row(
            "SELECT old_value, new_value FROM tx_changes WHERE tx_id = ?1",
            [tx_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(old_v, "Old Title");
    assert_eq!(new_v, "New Title");
}

#[test]
fn first_touch_snapshot_is_taken_once_and_never_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let (mut conn, path) = library_with_track(dir.path());

    write::apply_set(&mut conn, &path, &[human("title", "V2")], Actor::Human { via: "cli" }, false)
        .unwrap();
    write::apply_set(&mut conn, &path, &[human("title", "V3")], Actor::Human { via: "cli" }, false)
        .unwrap();

    let (count, snapshot): (i64, String) = conn
        .query_row(
            "SELECT count(*), MAX(snapshot) FROM first_touch_snapshots",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(count, 1, "exactly one snapshot per file, ever");
    // Snapshot preserves the pre-Ōtori state, not any later value.
    assert!(snapshot.contains("Old Title"), "snapshot must hold the original: {snapshot}");
}

#[test]
fn agents_cannot_overwrite_curated_fields_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let (mut conn, path) = library_with_track(dir.path());

    // Human writes → curated.
    write::apply_set(
        &mut conn,
        &path,
        &[human("title", "[Contest, BOF2013, 1st] Real Title")],
        Actor::Human { via: "cli" },
        false,
    )
    .unwrap();

    // Agent tries to "normalize" it.
    let plan = write::plan_set(
        &mut conn,
        &path,
        &[human("title", "Real Title")],
        Actor::Agent { id: "claude" },
        false,
    )
    .unwrap();

    assert!(plan.changes.is_empty(), "curated field must not appear as a change");
    assert_eq!(plan.skipped_curated.len(), 1);
    assert_eq!(plan.skipped_curated[0].field, "title");

    // And apply refuses identically (defense in depth, not just the plan).
    let tx = write::apply_set(
        &mut conn,
        &path,
        &[human("title", "Real Title")],
        Actor::Agent { id: "claude" },
        false,
    )
    .unwrap();
    assert!(tx.is_none(), "nothing to apply → no transaction");
    let on_disk = otori_core::read_track_tags(&path).unwrap();
    assert_eq!(
        on_disk.title.as_deref(),
        Some("[Contest, BOF2013, 1st] Real Title"),
        "the curated value survives"
    );
}

#[test]
fn override_curated_is_explicit_and_journaled() {
    let dir = tempfile::tempdir().unwrap();
    let (mut conn, path) = library_with_track(dir.path());

    write::apply_set(&mut conn, &path, &[human("title", "Curated")], Actor::Human { via: "cli" }, false)
        .unwrap();

    let tx_id = write::apply_set(
        &mut conn,
        &path,
        &[human("title", "Agent Override")],
        Actor::Agent { id: "claude" },
        true, // --override-curated
    )
    .unwrap()
    .expect("override must apply");

    let on_disk = otori_core::read_track_tags(&path).unwrap();
    assert_eq!(on_disk.title.as_deref(), Some("Agent Override"));
    // The journal must remember it was a curated value that got replaced.
    let old_source: String = conn
        .query_row(
            "SELECT old_source FROM tx_changes WHERE tx_id = ?1",
            [tx_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(old_source, "human");
}

#[test]
fn agents_may_fill_empty_fields_without_ceremony() {
    // Fill-empty is the agent's main job (lowest invasiveness rank).
    let dir = tempfile::tempdir().unwrap();
    let (mut conn, path) = library_with_track(dir.path());

    let tx = write::apply_set(
        &mut conn,
        &path,
        &[human("album", "Heart of android")],
        Actor::Agent { id: "claude" },
        false,
    )
    .unwrap();
    assert!(tx.is_some());
    let on_disk = otori_core::read_track_tags(&path).unwrap();
    assert_eq!(on_disk.album.as_deref(), Some("Heart of android"));
    let source: String = conn
        .query_row("SELECT source FROM tag_values WHERE field = 'album'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(source, "agent");
}

#[test]
fn undo_restores_file_and_index_and_marks_tx() {
    let dir = tempfile::tempdir().unwrap();
    let (mut conn, path) = library_with_track(dir.path());

    let tx_id = write::apply_set(
        &mut conn,
        &path,
        &[human("title", "Mistake")],
        Actor::Human { via: "cli" },
        false,
    )
    .unwrap()
    .unwrap();

    write::undo(&mut conn, tx_id).unwrap();

    let on_disk = otori_core::read_track_tags(&path).unwrap();
    assert_eq!(on_disk.title.as_deref(), Some("Old Title"), "file restored");
    let (value, source): (String, String) = conn
        .query_row("SELECT value, source FROM tag_values WHERE field = 'title'", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(value, "Old Title");
    assert_eq!(source, "import", "provenance restored too");
    let undone: i64 = conn
        .query_row("SELECT undone FROM transactions WHERE id = ?1", [tx_id], |r| r.get(0))
        .unwrap();
    assert_eq!(undone, 1);
}

#[test]
fn undo_twice_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let (mut conn, path) = library_with_track(dir.path());
    let tx_id = write::apply_set(&mut conn, &path, &[human("title", "X")], Actor::Human { via: "cli" }, false)
        .unwrap()
        .unwrap();
    write::undo(&mut conn, tx_id).unwrap();
    assert!(write::undo(&mut conn, tx_id).is_err(), "double undo must fail fast");
}

#[test]
fn curate_protects_import_values() {
    let dir = tempfile::tempdir().unwrap();
    let (mut conn, path) = library_with_track(dir.path());

    let count = write::curate(&mut conn, Some(&path)).unwrap();
    assert_eq!(count, 2, "title + artist from scan get the oath");

    // Now the agent bounces off them.
    let plan = write::plan_set(
        &mut conn,
        &path,
        &[human("title", "Normalized")],
        Actor::Agent { id: "claude" },
        false,
    )
    .unwrap();
    assert!(plan.changes.is_empty());
    assert_eq!(plan.skipped_curated.len(), 1);
}

#[test]
fn plan_outcome_distinguishes_noop_from_skip() {
    let dir = tempfile::tempdir().unwrap();
    let (mut conn, path) = library_with_track(dir.path());

    // Same value as on disk → no-op, not a change and not a skip.
    let plan = write::plan_set(
        &mut conn,
        &path,
        &[human("title", "Old Title")],
        Actor::Human { via: "cli" },
        false,
    )
    .unwrap();
    assert!(plan.changes.is_empty());
    assert!(plan.skipped_curated.is_empty());
    assert_eq!(plan.outcome(), PlanOutcome::Nothing);
}

#[test]
fn unknown_track_fails_fast() {
    let mut conn = db::open_in_memory().unwrap();
    let err = write::plan_set(
        &mut conn,
        Path::new("/nowhere/ghost.mp3"),
        &[human("title", "X")],
        Actor::Human { via: "cli" },
        false,
    );
    assert!(err.is_err(), "unindexed path must error, not silently index");
}
