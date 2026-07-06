//! `otori status` — the library's vital signs (L3 observability).

use otori_core::{db, status};

fn seed(conn: &otori_core::Connection) {
    conn.execute_batch(
        "INSERT INTO tracks (path, format, first_seen, last_scanned)
         VALUES ('/l/a.mp3', 'mp3', datetime('now'), datetime('now')),
                ('/l/b.flac', 'flac', datetime('now'), datetime('now')),
                ('/l/c.mp3', 'mp3', datetime('now'), datetime('now'));
         INSERT INTO tag_values (track_id, field, value, source, curated, written_at)
         VALUES (1, 'title', 'A', 'import', 1, datetime('now')),
                (1, 'artist', 'X', 'human', 1, datetime('now')),
                (2, 'title', 'B', 'import', 0, datetime('now'));
         INSERT INTO transactions (actor, started_at, undone)
         VALUES ('cli', datetime('now'), 0),
                ('agent:claude', datetime('now'), 1);",
    )
    .unwrap();
}

#[test]
fn status_reports_counts_and_coverage() {
    let conn = db::open_in_memory().unwrap();
    seed(&conn);
    let s = status::status(&conn).unwrap();

    assert_eq!(s.tracks, 3);
    assert_eq!(s.formats.get("mp3"), Some(&2));
    assert_eq!(s.formats.get("flac"), Some(&1));
    // Missing = tracks without a non-null value for the field.
    assert_eq!(s.missing.get("title"), Some(&1)); // only c.mp3 lacks title
    assert_eq!(s.missing.get("artist"), Some(&2));
    assert_eq!(s.missing.get("album"), Some(&3));
    // Curated coverage counts curated values, sources break down provenance.
    assert_eq!(s.tag_values, 3);
    assert_eq!(s.curated_values, 2);
    assert_eq!(s.sources.get("human"), Some(&1));
    assert_eq!(s.sources.get("import"), Some(&2));
    assert_eq!(s.transactions, 2);
    assert_eq!(s.undone_transactions, 1);
    assert_eq!(s.schema_version, 7);
}

#[test]
fn empty_library_is_all_zeroes_not_an_error() {
    let conn = db::open_in_memory().unwrap();
    let s = status::status(&conn).unwrap();
    assert_eq!(s.tracks, 0);
    assert_eq!(s.tag_values, 0);
    assert!(s.formats.is_empty());
    // Missing counts are still reported (0 tracks -> 0 missing).
    assert_eq!(s.missing.get("title"), Some(&0));
}
