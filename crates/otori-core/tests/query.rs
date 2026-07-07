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
