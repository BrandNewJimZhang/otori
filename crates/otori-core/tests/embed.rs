//! Embedding artwork into the audio file: a real file write, so the
//! full L2 stack applies — first-touch snapshot, journal, undo.

use std::fs;
use std::path::{Path, PathBuf};

use otori_core::write::{self, Actor};
use otori_core::{artwork, db, scan};

fn write_mp3(path: &Path) {
    let mut frame = vec![0xFF, 0xFB, 0x90, 0x00];
    frame.resize(417, 0);
    let mut bytes = Vec::new();
    for _ in 0..4 {
        bytes.extend_from_slice(&frame);
    }
    fs::write(path, bytes).unwrap();
}

const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
    0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
    0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x62, 0x00,
    0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

/// Indexed library with one track that has a sidecar jacket.
fn library_with_sidecar(dir: &Path) -> (otori_core::Connection, PathBuf) {
    let audio = dir.join("song.mp3");
    write_mp3(&audio);
    fs::write(dir.join("song.png"), PNG).unwrap();
    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, dir).unwrap();
    (conn, audio)
}

#[test]
fn embeds_sidecar_into_file_and_journals() {
    let dir = tempfile::tempdir().unwrap();
    let (mut conn, audio) = library_with_sidecar(dir.path());

    let tx_id = write::embed_artwork(&mut conn, &audio, Actor::Agent { id: "claude" })
        .unwrap();

    // The file itself now carries the picture (chain reports embedded).
    let art = artwork::resolve(&audio).unwrap().unwrap();
    assert_eq!(art.source, "embedded");
    assert_eq!(art.data, PNG);
    // Sidecar is intentionally kept (undo falls back to it).
    assert!(dir.path().join("song.png").exists());

    // Journaled like any other write.
    let (field, new_source): (String, String) = conn
        .query_row(
            "SELECT field, new_source FROM tx_changes WHERE tx_id = ?1",
            [tx_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(field, "picture");
    assert_eq!(new_source, "agent");
    // First-touch snapshot exists.
    let snaps: i64 = conn
        .query_row("SELECT count(*) FROM first_touch_snapshots", [], |r| r.get(0))
        .unwrap();
    assert_eq!(snaps, 1);
}

#[test]
fn refuses_when_picture_already_embedded() {
    let dir = tempfile::tempdir().unwrap();
    let (mut conn, audio) = library_with_sidecar(dir.path());
    write::embed_artwork(&mut conn, &audio, Actor::Human { via: "cli" }).unwrap();

    let err = write::embed_artwork(&mut conn, &audio, Actor::Human { via: "cli" });
    assert!(err.is_err(), "double embed must refuse, not overwrite");
}

#[test]
fn refuses_without_any_artwork_to_embed() {
    let dir = tempfile::tempdir().unwrap();
    let audio = dir.path().join("bare.mp3");
    write_mp3(&audio);
    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, dir.path()).unwrap();

    assert!(write::embed_artwork(&mut conn, &audio, Actor::Human { via: "cli" }).is_err());
}

#[test]
fn undo_removes_the_embedded_picture() {
    let dir = tempfile::tempdir().unwrap();
    let (mut conn, audio) = library_with_sidecar(dir.path());
    let tx_id = write::embed_artwork(&mut conn, &audio, Actor::Human { via: "cli" }).unwrap();

    write::undo(&mut conn, tx_id).unwrap();

    // File is picture-free again; the chain falls back to the sidecar.
    let art = artwork::resolve(&audio).unwrap().unwrap();
    assert_eq!(art.source, "sidecar");
    let undone: i64 = conn
        .query_row("SELECT undone FROM transactions WHERE id = ?1", [tx_id], |r| r.get(0))
        .unwrap();
    assert_eq!(undone, 1);
}

#[test]
fn unindexed_file_fails_fast() {
    let dir = tempfile::tempdir().unwrap();
    let audio = dir.path().join("ghost.mp3");
    write_mp3(&audio);
    fs::write(dir.path().join("ghost.png"), PNG).unwrap();
    let mut conn = db::open_in_memory().unwrap();
    // Never scanned: embedding must refuse (scan first), not silently index.
    assert!(write::embed_artwork(&mut conn, &audio, Actor::Human { via: "cli" }).is_err());
}
