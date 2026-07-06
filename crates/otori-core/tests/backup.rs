//! Library backup: the index db is the one asset that cannot be
//! rebuilt from files (provenance, curated flags, journal, snapshots).
//! These tests pin the backup path and its safety properties.

use otori_core::{backup, db};

#[test]
fn backup_copies_a_live_library() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("library.db");
    let conn = db::open(&src).unwrap();
    conn.execute_batch(
        "INSERT INTO tracks (path, format, first_seen, last_scanned)
         VALUES ('/l/a.mp3', 'mp3', datetime('now'), datetime('now'));
         INSERT INTO tag_values (track_id, field, value, source, curated, written_at)
         VALUES (1, 'title', 'Precious', 'human', 1, datetime('now'));",
    )
    .unwrap();

    let dest = dir.path().join("backup.db");
    backup::backup(&conn, &dest).unwrap();

    // The backup opens as a normal library and carries the trust layer.
    let restored = db::open(&dest).unwrap();
    let (value, curated): (String, i64) = restored
        .query_row(
            "SELECT value, curated FROM tag_values WHERE field = 'title'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(value, "Precious");
    assert_eq!(curated, 1);
}

#[test]
fn backup_refuses_to_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("library.db");
    let conn = db::open(&src).unwrap();
    let dest = dir.path().join("existing.db");
    std::fs::write(&dest, b"do not clobber me").unwrap();

    assert!(backup::backup(&conn, &dest).is_err(), "existing files are sacred");
    assert_eq!(std::fs::read(&dest).unwrap(), b"do not clobber me");
}

#[test]
fn default_backup_name_is_timestamped_and_unique() {
    let dir = tempfile::tempdir().unwrap();
    let a = backup::default_backup_path(dir.path()).unwrap();
    assert!(a.file_name().unwrap().to_string_lossy().starts_with("library-"));
    assert!(a.extension().unwrap() == "db");
    // Creating the first one then asking again yields a different name.
    std::fs::write(&a, b"x").unwrap();
    let b = backup::default_backup_path(dir.path()).unwrap();
    assert_ne!(a, b, "second backup in the same second must not collide");
}

#[test]
fn auto_backup_keeps_newest_and_prunes_oldest() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("library.db");
    let conn = db::open(&src).unwrap();
    let backups = dir.path().join("backups");

    // Simulate an existing over-quota backup set with fake old files.
    std::fs::create_dir_all(&backups).unwrap();
    for i in 0..backup::AUTO_KEEP + 2 {
        std::fs::write(backups.join(format!("library-2026010{}-000000.db", i + 1)), b"old")
            .unwrap();
    }

    backup::auto_backup(&conn, &backups).unwrap();

    let mut names: Vec<String> = std::fs::read_dir(&backups)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(
        names.len(),
        backup::AUTO_KEEP,
        "prune to the keep-limit: {names:?}"
    );
    // The oldest fakes are gone; the newest entry is the fresh backup.
    assert!(!names.contains(&"library-20260101-000000.db".to_string()));
}
