//! Library scan: walk a directory, index audio files, read tags via lofty.
//!
//! Honesty rules (PRODUCT.md):
//! - `.icloud` placeholders are skipped and reported — never downloaded,
//!   never guessed at.
//! - Unreadable audio files are indexed (they exist on disk) but their
//!   tag failure is reported, and the scan carries on.
//! - Tags read from disk get provenance `import`: real protection comes
//!   from `otori curate`, not from the scanner.

use std::path::Path;

use lofty::file::TaggedFileExt;
use lofty::prelude::*;
use rusqlite::Connection;
use serde::Serialize;
use walkdir::WalkDir;

const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "m4a", "alac", "ogg", "opus", "wav", "aiff"];

/// What a scan did, structured for `--json` output and the GUI alike.
#[derive(Debug, Default, Serialize)]
pub struct ScanReport {
    pub added: u64,
    pub updated: u64,
    /// Logical paths (placeholder name un-mangled) of iCloud-evicted files.
    pub skipped_icloud: Vec<String>,
    /// Indexed files whose tags could not be parsed.
    pub unreadable: Vec<String>,
}

/// Scan `root` recursively into the library database.
pub fn scan(conn: &mut Connection, root: &Path) -> rusqlite::Result<ScanReport> {
    let mut report = ScanReport::default();
    let tx = conn.transaction()?;

    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy();

        // iCloud placeholder: ".<name>.<ext>.icloud" stands in for "<name>.<ext>".
        if let Some(stem) = name.strip_prefix('.').and_then(|n| n.strip_suffix(".icloud")) {
            if has_audio_extension(stem) {
                report
                    .skipped_icloud
                    .push(path.with_file_name(stem).to_string_lossy().into_owned());
            }
            continue;
        }
        if !has_audio_extension(&name) {
            continue;
        }

        let path_str = path.to_string_lossy();
        let format = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        let existing: Option<i64> = tx
            .query_row("SELECT id FROM tracks WHERE path = ?1", [&path_str], |row| {
                row.get(0)
            })
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;

        let track_id = match existing {
            Some(id) => {
                tx.execute(
                    "UPDATE tracks SET last_scanned = datetime('now') WHERE id = ?1",
                    [id],
                )?;
                report.updated += 1;
                id
            }
            None => {
                tx.execute(
                    "INSERT INTO tracks (path, format, first_seen, last_scanned)
                     VALUES (?1, ?2, datetime('now'), datetime('now'))",
                    [path_str.as_ref(), format.as_str()],
                )?;
                report.added += 1;
                tx.last_insert_rowid()
            }
        };

        match read_tags(path) {
            Ok(fields) => {
                for (field, value) in fields {
                    // Scan never overwrites: only fills fields the index
                    // doesn't know yet. Conflict reporting is a later cut.
                    tx.execute(
                        "INSERT INTO tag_values (track_id, field, value, source, written_by, written_at)
                         VALUES (?1, ?2, ?3, 'import', 'scan', datetime('now'))
                         ON CONFLICT (track_id, field) DO NOTHING",
                        rusqlite::params![track_id, field, value],
                    )?;
                }
            }
            Err(_) => report.unreadable.push(path_str.into_owned()),
        }
    }

    tx.commit()?;
    Ok(report)
}

fn has_audio_extension(name: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, ext)| AUDIO_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
}

fn read_tags(path: &Path) -> Result<Vec<(&'static str, String)>, lofty::error::LoftyError> {
    let tagged = lofty::read_from_path(path)?;
    let mut fields = Vec::new();
    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        if let Some(v) = tag.title() {
            fields.push(("title", v.into_owned()));
        }
        if let Some(v) = tag.artist() {
            fields.push(("artist", v.into_owned()));
        }
        if let Some(v) = tag.album() {
            fields.push(("album", v.into_owned()));
        }
    }
    Ok(fields)
}
