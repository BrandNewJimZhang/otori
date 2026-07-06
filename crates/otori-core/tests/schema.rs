//! Schema-level invariants: provenance from day one, human supremacy.

use otori_core::db;

#[test]
fn opens_with_full_provenance_schema() {
    let conn = db::open_in_memory().unwrap();
    // Every table of the trust stack must exist from the first open.
    for table in [
        "tracks",
        "tag_values",
        "track_links",
        "first_touch_snapshots",
        "transactions",
        "tx_changes",
    ] {
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "missing table: {table}");
    }
}

#[test]
fn human_source_is_born_curated() {
    let conn = db::open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO tracks (path, format, first_seen, last_scanned)
         VALUES ('/x/a.mp3', 'mp3', datetime('now'), datetime('now'))",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tag_values (track_id, field, value, source, written_at)
         VALUES (1, 'title', 'My Title', 'human', datetime('now'))",
        [],
    )
    .unwrap();
    let curated: i64 = conn
        .query_row(
            "SELECT curated FROM tag_values WHERE track_id = 1 AND field = 'title'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(curated, 1, "human-sourced value must be auto-curated");
}

#[test]
fn non_human_sources_are_not_auto_curated() {
    let conn = db::open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO tracks (path, format, first_seen, last_scanned)
         VALUES ('/x/a.mp3', 'mp3', datetime('now'), datetime('now'))",
        [],
    )
    .unwrap();
    for (field, source) in [("title", "import"), ("artist", "agent"), ("album", "inferred")] {
        conn.execute(
            "INSERT INTO tag_values (track_id, field, value, source, written_at)
             VALUES (1, ?1, 'v', ?2, datetime('now'))",
            [field, source],
        )
        .unwrap();
        let curated: i64 = conn
            .query_row(
                "SELECT curated FROM tag_values WHERE track_id = 1 AND field = ?1",
                [field],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(curated, 0, "{source} must require an explicit curate step");
    }
}

#[test]
fn rejects_unknown_tag_source() {
    let conn = db::open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO tracks (path, format, first_seen, last_scanned)
         VALUES ('/x/a.mp3', 'mp3', datetime('now'), datetime('now'))",
        [],
    )
    .unwrap();
    let result = conn.execute(
        "INSERT INTO tag_values (track_id, field, value, source, written_at)
         VALUES (1, 'title', 'v', 'robot', datetime('now'))",
        [],
    );
    assert!(result.is_err(), "source outside the four-level ladder must be rejected");
}

#[test]
fn refuses_db_from_a_newer_schema() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("library.db");
    {
        let conn = db::open(&path).unwrap();
        conn.execute_batch("PRAGMA user_version = 999;").unwrap();
    }
    // Fail fast: a newer schema means a newer Ōtori wrote this library.
    assert!(db::open(&path).is_err());
}
