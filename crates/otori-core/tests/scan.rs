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
fn scan_records_replaygain_track_gain() {
    use lofty::prelude::*;
    use lofty::tag::{ItemKey, Tag, TagType};
    let lib = tempfile::tempdir().unwrap();
    let p = lib.path().join("rg.mp3");
    write_minimal_mp3(&p);
    let mut tag = Tag::new(TagType::Id3v2);
    tag.insert_text(ItemKey::ReplayGainTrackGain, "-7.25 dB".to_string());
    tag.save_to_path(&p, lofty::config::WriteOptions::default()).unwrap();

    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();

    let rg: f64 = conn
        .query_row("SELECT replaygain_db FROM tracks WHERE path LIKE '%rg.mp3'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!((rg - -7.25).abs() < 1e-6);
}

#[test]
fn tracks_without_replaygain_stay_null() {
    let lib = tempfile::tempdir().unwrap();
    write_tagged_mp3(&lib.path().join("plain.mp3"), "A", "B");

    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();

    // No RG tag → NULL, not 0.0: "no data" and "0 dB adjustment" differ.
    let rg: Option<f64> = conn
        .query_row("SELECT replaygain_db FROM tracks WHERE path LIKE '%plain.mp3'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(rg, None);
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
fn scan_records_duration_from_file_properties() {
    let lib = tempfile::tempdir().unwrap();
    write_tagged_mp3(&lib.path().join("song.mp3"), "Iris", "Camellia");

    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();

    // Duration is a file property, not a tag: no provenance, always
    // refreshed on scan (player seek bar now, multi-format linking later).
    let duration: f64 = conn
        .query_row(
            "SELECT duration_secs FROM tracks WHERE path LIKE '%song.mp3'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(duration > 0.0, "duration must be read from the audio file");
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

#[test]
fn scan_records_its_root_for_later_rescan() {
    let lib = tempfile::tempdir().unwrap();
    write_tagged_mp3(&lib.path().join("a.mp3"), "A", "B");

    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();
    scan::scan(&mut conn, lib.path()).unwrap(); // re-scan must not duplicate the root

    let (count, root): (i64, String) = conn
        .query_row("SELECT count(*), max(root) FROM scan_roots", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(count, 1);
    assert_eq!(root, lib.path().to_string_lossy());
}

#[test]
fn rescan_all_walks_every_recorded_root() {
    let lib_a = tempfile::tempdir().unwrap();
    let lib_b = tempfile::tempdir().unwrap();
    write_tagged_mp3(&lib_a.path().join("a.mp3"), "A", "X");
    write_tagged_mp3(&lib_b.path().join("b.mp3"), "B", "Y");

    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib_a.path()).unwrap();
    scan::scan(&mut conn, lib_b.path()).unwrap();

    // New files appear in both roots after the initial scans.
    write_tagged_mp3(&lib_a.path().join("a2.mp3"), "A2", "X");
    write_tagged_mp3(&lib_b.path().join("b2.mp3"), "B2", "Y");

    let report = scan::rescan_all(&mut conn).unwrap();
    assert_eq!(report.added, 2);
    assert_eq!(report.updated, 2);
}

#[test]
fn rescan_all_without_recorded_roots_is_a_no_op() {
    let mut conn = db::open_in_memory().unwrap();
    let report = scan::rescan_all(&mut conn).unwrap();
    assert_eq!(report.added, 0);
    assert_eq!(report.updated, 0);
}

#[test]
fn backfill_durations_fills_only_null_rows_from_indexed_files() {
    let lib = tempfile::tempdir().unwrap();
    write_tagged_mp3(&lib.path().join("old.mp3"), "Old", "X");

    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();

    // Simulate a pre-v3 library: indexed track, duration never recorded,
    // and (pre-v4) no scan root to re-walk.
    conn.execute("UPDATE tracks SET duration_secs = NULL", []).unwrap();
    conn.execute("DELETE FROM scan_roots", []).unwrap();

    let filled = scan::backfill_durations(&mut conn).unwrap();
    assert_eq!(filled, 1);
    let d: f64 = conn
        .query_row("SELECT duration_secs FROM tracks WHERE path LIKE '%old.mp3'", [], |r| r.get(0))
        .unwrap();
    assert!(d > 0.0);

    // Second run touches nothing — only NULL rows are candidates.
    assert_eq!(scan::backfill_durations(&mut conn).unwrap(), 0);
}

#[test]
fn backfill_durations_skips_missing_files_without_failing() {
    let mut conn = db::open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO tracks (path, format, first_seen, last_scanned)
         VALUES ('/gone/away.mp3', 'mp3', datetime('now'), datetime('now'))",
        [],
    )
    .unwrap();

    // A vanished file is not corruption of the index — it is the normal
    // fate of paths over time; the backfill reports 0 and moves on.
    assert_eq!(scan::backfill_durations(&mut conn).unwrap(), 0);
}
