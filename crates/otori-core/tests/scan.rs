//! Scan behavior: index what's there, skip iCloud placeholders honestly,
//! report unreadable files instead of dying on them.

use std::fs;
use std::path::Path;

use otori_core::{db, scan};

/// A few valid MPEG-1 Layer III frames (128kbps, 44.1kHz) — just enough
/// for lofty to probe the file as MP3 and attach an ID3v2 tag to it.
fn write_minimal_mp3(path: &Path) {
    let mut frame = vec![0xFF, 0xFB, 0x90, 0x00];
    frame.resize(417, 0);
    let mut bytes = Vec::new();
    for _ in 0..4 {
        bytes.extend_from_slice(&frame);
    }
    fs::write(path, bytes).unwrap();
}

fn write_tagged_mp3(path: &Path, title: &str, artist: &str) {
    use lofty::prelude::*;
    use lofty::tag::{Tag, TagType};
    write_minimal_mp3(path);
    let mut tag = Tag::new(TagType::Id3v2);
    tag.set_title(title.to_string());
    tag.set_artist(artist.to_string());
    tag.save_to_path(path, lofty::config::WriteOptions::default())
        .unwrap();
}

#[test]
fn indexes_audio_files_with_import_provenance() {
    let lib = tempfile::tempdir().unwrap();
    write_tagged_mp3(&lib.path().join("song.mp3"), "Iris", "Camellia");

    let mut conn = db::open_in_memory().unwrap();
    let report = scan::scan(&mut conn, lib.path()).unwrap();

    assert_eq!(report.added, 1);
    let (value, source, curated): (String, String, i64) = conn
        .query_row(
            "SELECT v.value, v.source, v.curated FROM tag_values v
             JOIN tracks t ON t.id = v.track_id
             WHERE t.path LIKE '%song.mp3' AND v.field = 'title'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(value, "Iris");
    // Tags read from disk are 'import': protected only after `otori curate`.
    assert_eq!(source, "import");
    assert_eq!(curated, 0);
}

#[test]
fn skips_and_reports_icloud_placeholders() {
    let lib = tempfile::tempdir().unwrap();
    write_tagged_mp3(&lib.path().join("real.mp3"), "A", "B");
    fs::write(lib.path().join(".evicted.mp3.icloud"), b"plist junk").unwrap();

    let mut conn = db::open_in_memory().unwrap();
    let report = scan::scan(&mut conn, lib.path()).unwrap();

    assert_eq!(report.added, 1, "placeholder must not be indexed as a track");
    assert_eq!(report.skipped_icloud.len(), 1);
    assert!(report.skipped_icloud[0].ends_with("evicted.mp3"));
}

#[test]
fn reports_unreadable_files_without_aborting_the_scan() {
    let lib = tempfile::tempdir().unwrap();
    write_tagged_mp3(&lib.path().join("good.mp3"), "A", "B");
    fs::write(lib.path().join("bad.mp3"), b"not audio at all").unwrap();

    let mut conn = db::open_in_memory().unwrap();
    let report = scan::scan(&mut conn, lib.path()).unwrap();

    // The broken file is still a track on disk — indexed, tagless, reported.
    assert_eq!(report.added, 2);
    assert_eq!(report.unreadable.len(), 1);
    assert!(report.unreadable[0].ends_with("bad.mp3"));
}

#[test]
fn ignores_non_audio_files() {
    let lib = tempfile::tempdir().unwrap();
    fs::write(lib.path().join("cover.jpg"), b"jpeg").unwrap();
    fs::write(lib.path().join("notes.txt"), b"text").unwrap();

    let mut conn = db::open_in_memory().unwrap();
    let report = scan::scan(&mut conn, lib.path()).unwrap();
    assert_eq!(report.added, 0);
}

#[test]
fn rescan_does_not_duplicate_tracks() {
    let lib = tempfile::tempdir().unwrap();
    write_tagged_mp3(&lib.path().join("song.mp3"), "Iris", "Camellia");

    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();
    let report = scan::scan(&mut conn, lib.path()).unwrap();

    assert_eq!(report.added, 0);
    assert_eq!(report.updated, 1);
    let count: i64 = conn
        .query_row("SELECT count(*) FROM tracks", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
}
