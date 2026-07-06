//! Library vital signs (L3 observability): one call answers "how big,
//! how complete, how protected, what happened". Read-only.

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Status {
    pub schema_version: i64,
    pub tracks: i64,
    /// Track count per file format.
    pub formats: BTreeMap<String, i64>,
    /// Tracks lacking a value, per display field.
    pub missing: BTreeMap<&'static str, i64>,
    pub tag_values: i64,
    pub curated_values: i64,
    /// Tag value count per provenance source.
    pub sources: BTreeMap<String, i64>,
    pub transactions: i64,
    pub undone_transactions: i64,
}

const DISPLAY_FIELDS: &[&str] = &["title", "artist", "album"];

pub fn status(conn: &Connection) -> rusqlite::Result<Status> {
    let schema_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let tracks: i64 = conn.query_row("SELECT count(*) FROM tracks", [], |r| r.get(0))?;

    let mut formats = BTreeMap::new();
    let mut stmt = conn.prepare("SELECT format, count(*) FROM tracks GROUP BY format")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    for row in rows {
        let (format, count) = row?;
        formats.insert(format, count);
    }

    let mut missing = BTreeMap::new();
    for field in DISPLAY_FIELDS {
        let with_value: i64 = conn.query_row(
            "SELECT count(*) FROM tag_values WHERE field = ?1 AND value IS NOT NULL",
            [field],
            |r| r.get(0),
        )?;
        missing.insert(*field, tracks - with_value);
    }

    let tag_values: i64 =
        conn.query_row("SELECT count(*) FROM tag_values WHERE value IS NOT NULL", [], |r| {
            r.get(0)
        })?;
    let curated_values: i64 = conn.query_row(
        "SELECT count(*) FROM tag_values WHERE curated = 1 AND value IS NOT NULL",
        [],
        |r| r.get(0),
    )?;

    let mut sources = BTreeMap::new();
    let mut stmt = conn.prepare(
        "SELECT source, count(*) FROM tag_values WHERE value IS NOT NULL GROUP BY source",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    for row in rows {
        let (source, count) = row?;
        sources.insert(source, count);
    }

    let transactions: i64 =
        conn.query_row("SELECT count(*) FROM transactions", [], |r| r.get(0))?;
    let undone_transactions: i64 =
        conn.query_row("SELECT count(*) FROM transactions WHERE undone = 1", [], |r| r.get(0))?;

    Ok(Status {
        schema_version,
        tracks,
        formats,
        missing,
        tag_values,
        curated_values,
        sources,
        transactions,
        undone_transactions,
    })
}
