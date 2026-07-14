//! Query layer: read-only views over the index for CLI and GUI alike.

use std::fs;

use otori_core::{db, query, scan};

#[test]
fn lists_tracks_with_their_tags() {
    let conn = db::open_in_memory().unwrap();
    conn.execute_batch(
        "INSERT INTO tracks (path, format, first_seen, last_scanned)
         VALUES ('/lib/a.mp3', 'mp3', datetime('now'), datetime('now'));
         INSERT INTO tag_values (track_id, field, value, source, written_at)
         VALUES (1, 'title', 'Iris', 'import', datetime('now')),
                (1, 'artist', 'Camellia', 'import', datetime('now')),
                (1, 'album', 'U.U.F.O.', 'import', datetime('now'));",
    )
    .unwrap();

    let tracks = query::list_tracks(&conn).unwrap();
    assert_eq!(tracks.len(), 1);
    let t = &tracks[0];
    assert_eq!(t.path, "/lib/a.mp3");
    assert_eq!(t.format, "mp3");
    assert_eq!(t.title.as_deref(), Some("Iris"));
    assert_eq!(t.artist.as_deref(), Some("Camellia"));
    assert_eq!(t.album.as_deref(), Some("U.U.F.O."));
}

#[test]
fn lists_track_duration() {
    let conn = db::open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO tracks (path, format, duration_secs, first_seen, last_scanned)
         VALUES ('/lib/a.mp3', 'mp3', 245.5, datetime('now'), datetime('now'))",
        [],
    )
    .unwrap();

    let tracks = query::list_tracks(&conn).unwrap();
    assert_eq!(tracks[0].duration_secs, Some(245.5));
}

#[test]
fn missing_tags_are_none_not_errors() {
    let conn = db::open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO tracks (path, format, first_seen, last_scanned)
         VALUES ('/lib/untagged.flac', 'flac', datetime('now'), datetime('now'))",
        [],
    )
    .unwrap();

    let tracks = query::list_tracks(&conn).unwrap();
    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0].title, None);
    assert_eq!(tracks[0].artist, None);
}

#[test]
fn listing_is_stable_and_ordered() {
    // Deterministic order (artist, then title, then path) so the GUI
    // and repeated CLI calls agree without client-side sorting.
    let conn = db::open_in_memory().unwrap();
    conn.execute_batch(
        "INSERT INTO tracks (path, format, first_seen, last_scanned)
         VALUES ('/lib/b.mp3', 'mp3', datetime('now'), datetime('now')),
                ('/lib/a.mp3', 'mp3', datetime('now'), datetime('now'));
         INSERT INTO tag_values (track_id, field, value, source, written_at)
         VALUES (1, 'artist', 'ZUN', 'import', datetime('now')),
                (2, 'artist', 'Camellia', 'import', datetime('now'));",
    )
    .unwrap();

    let tracks = query::list_tracks(&conn).unwrap();
    assert_eq!(tracks[0].artist.as_deref(), Some("Camellia"));
    assert_eq!(tracks[1].artist.as_deref(), Some("ZUN"));
}

#[test]
fn scan_then_list_roundtrip() {
    use lofty::prelude::*;
    use lofty::tag::{Tag, TagType};

    let lib = tempfile::tempdir().unwrap();
    let p = lib.path().join("t.mp3");
    let mut frame = vec![0xFF, 0xFB, 0x90, 0x00];
    frame.resize(417, 0);
    let mut bytes = Vec::new();
    for _ in 0..4 {
        bytes.extend_from_slice(&frame);
    }
    fs::write(&p, bytes).unwrap();
    let mut tag = Tag::new(TagType::Id3v2);
    tag.set_title("Ghost".into());
    tag.save_to_path(&p, lofty::config::WriteOptions::default())
        .unwrap();

    let mut conn = db::open_in_memory().unwrap();
    scan::scan(&mut conn, lib.path()).unwrap();
    let tracks = query::list_tracks(&conn).unwrap();
    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0].title.as_deref(), Some("Ghost"));
    assert!(tracks[0].id > 0);
}

#[test]
fn lists_added_and_analyzed_timestamps() {
    // The GUI's Added / Analyzed columns read these straight off the row:
    // first_seen is NOT NULL from the first scan; bpm_analyzed_at stays
    // NULL until the sweep passes (pending, not an error).
    let conn = db::open_in_memory().unwrap();
    conn.execute_batch(
        "INSERT INTO tracks (path, format, first_seen, last_scanned, bpm, bpm_analyzed_at)
         VALUES ('/lib/a.mp3', 'mp3', '2026-07-01 10:00:00', datetime('now'),
                 172.0, '2026-07-02 12:00:00'),
                ('/lib/b.mp3', 'mp3', '2026-07-03 09:00:00', datetime('now'), NULL, NULL);",
    )
    .unwrap();

    let tracks = query::list_tracks(&conn).unwrap();
    assert_eq!(tracks[0].first_seen, "2026-07-01 10:00:00");
    assert_eq!(tracks[0].bpm_analyzed_at.as_deref(), Some("2026-07-02 12:00:00"));
    assert_eq!(tracks[1].first_seen, "2026-07-03 09:00:00");
    assert_eq!(tracks[1].bpm_analyzed_at, None, "unanalyzed = pending, not missing data");
}

#[test]
fn tag_provenance_exposes_the_trust_layer() {
    let conn = db::open_in_memory().unwrap();
    conn.execute_batch(
        "INSERT INTO tracks (path, format, first_seen, last_scanned)
         VALUES ('/lib/a.mp3', 'mp3', datetime('now'), datetime('now'));
         INSERT INTO tag_values (track_id, field, value, source, curated, written_by, written_at)
         VALUES (1, 'title',  'Iris',     'human',  1, 'gui',          datetime('now')),
                (1, 'artist', 'Camellia', 'agent',  0, 'agent:claude', datetime('now')),
                (1, 'album',  'U.U.F.O.', 'import', 0, NULL,           datetime('now'));",
    )
    .unwrap();

    let rows = query::tag_provenance(&conn, 1).unwrap();
    assert_eq!(rows.len(), 3);
    let title = rows.iter().find(|r| r.field == "title").unwrap();
    assert_eq!(title.value.as_deref(), Some("Iris"));
    assert_eq!(title.source, "human");
    assert!(title.curated);
    assert_eq!(title.written_by.as_deref(), Some("gui"));
    let album = rows.iter().find(|r| r.field == "album").unwrap();
    assert_eq!(album.source, "import");
    assert!(!album.curated);
    assert_eq!(album.written_by, None);
}

#[test]
fn tag_provenance_unknown_track_is_empty() {
    let conn = db::open_in_memory().unwrap();
    let rows = query::tag_provenance(&conn, 999).unwrap();
    assert!(rows.is_empty(), "no rows is a valid initial state, not corruption");
}

#[test]
fn bpm_shaky_is_computed_in_the_index_not_the_projection() {
    let conn = db::open_in_memory().unwrap();
    conn.execute_batch(
        "INSERT INTO tracks (path, format, first_seen, last_scanned, bpm, bpm_max, bpm_confidence, bpm_hint) VALUES
         ('/lib/steady-shaky.mp3',  'mp3', datetime('now'), datetime('now'), 128, NULL, 0.5,  NULL),
         ('/lib/steady-solid.mp3',  'mp3', datetime('now'), datetime('now'), 128, NULL, 0.6,  NULL),
         ('/lib/soflan-solid.mp3',  'mp3', datetime('now'), datetime('now'), 140, 200,  0.45, NULL),
         ('/lib/soflan-shaky.mp3',  'mp3', datetime('now'), datetime('now'), 140, 200,  0.25, NULL),
         ('/lib/no-confidence.mp3', 'mp3', datetime('now'), datetime('now'), 128, NULL, NULL, NULL),
         ('/lib/hint-only.mp3',     'mp3', datetime('now'), datetime('now'), NULL, NULL, NULL, 185),
         ('/lib/blank.mp3',         'mp3', datetime('now'), datetime('now'), NULL, NULL, NULL, NULL);",
    )
    .unwrap();

    let tracks = query::list_tracks(&conn).unwrap();
    let shaky_of = |name: &str| -> bool {
        tracks.iter().find(|t| t.path.ends_with(name)).unwrap().bpm_shaky
    };
    // Steady detections warn below the cutoff.
    assert!(shaky_of("steady-shaky.mp3"));
    assert!(!shaky_of("steady-solid.mp3"));
    // Variable-tempo verdicts store confidence with the x0.5 range
    // penalty (derive.rs) — the cutoff folds with it, so a clean
    // soflan range is not shaky.
    assert!(!shaky_of("soflan-solid.mp3"));
    assert!(shaky_of("soflan-shaky.mp3"));
    // A detection with no recorded confidence is shaky by definition.
    assert!(shaky_of("no-confidence.mp3"));
    // An unverified external hint warns; a truly blank row has nothing
    // to warn about.
    assert!(shaky_of("hint-only.mp3"));
    assert!(!shaky_of("blank.mp3"));
}
