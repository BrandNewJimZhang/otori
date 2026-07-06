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

/// Scan `root` recursively into the library database, remembering the
/// root so `rescan_all` (launch / manual refresh) can re-walk it.
pub fn scan(conn: &mut Connection, root: &Path) -> rusqlite::Result<ScanReport> {
    let mut report = ScanReport::default();
    let tx = conn.transaction()?;

    tx.execute(
        "INSERT INTO scan_roots (root, first_scanned, last_scanned)
         VALUES (?1, datetime('now'), datetime('now'))
         ON CONFLICT (root) DO UPDATE SET last_scanned = datetime('now')",
        [root.to_string_lossy()],
    )?;

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

        match read_file(path) {
            Ok(scanned) => {
                // Duration and ReplayGain are file properties, not tags:
                // no provenance, refreshed on every scan.
                tx.execute(
                    "UPDATE tracks SET duration_secs = ?1, replaygain_db = ?2 WHERE id = ?3",
                    rusqlite::params![scanned.duration_secs, scanned.replaygain_db, track_id],
                )?;
                for (field, value) in scanned.fields {
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

/// Re-walk every recorded scan root (rescan-on-launch / manual refresh).
/// No roots recorded — e.g. a library from before scan_roots existed —
/// is a valid empty state, not an error; the report is simply empty.
pub fn rescan_all(conn: &mut Connection) -> rusqlite::Result<ScanReport> {
    let roots: Vec<String> = {
        let mut stmt = conn.prepare("SELECT root FROM scan_roots ORDER BY root")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut total = ScanReport::default();
    for root in roots {
        let report = scan(conn, Path::new(&root))?;
        total.added += report.added;
        total.updated += report.updated;
        total.skipped_icloud.extend(report.skipped_icloud);
        total.unreadable.extend(report.unreadable);
    }
    Ok(total)
}

/// Fill duration for indexed tracks that predate schema v3 (duration
/// column) — pre-v4 libraries also lack scan_roots, so rescan_all
/// cannot reach them. Reads each file directly; vanished or unreadable
/// files are skipped (paths dying is normal, not index corruption).
/// Returns how many rows were filled.
pub fn backfill_durations(conn: &mut Connection) -> rusqlite::Result<u64> {
    let candidates: Vec<(i64, String)> = {
        let mut stmt =
            conn.prepare("SELECT id, path FROM tracks WHERE duration_secs IS NULL")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let tx = conn.transaction()?;
    let mut filled = 0u64;
    for (id, path) in candidates {
        if let Ok(scanned) = read_file(Path::new(&path)) {
            tx.execute(
                "UPDATE tracks SET duration_secs = ?1 WHERE id = ?2",
                rusqlite::params![scanned.duration_secs, id],
            )?;
            filled += 1;
        }
    }
    tx.commit()?;
    Ok(filled)
}

fn has_audio_extension(name: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, ext)| AUDIO_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
}

/// What one file yields at scan time: file properties plus readable
/// tag fields.
struct ScannedFile {
    duration_secs: f64,
    /// ReplayGain track gain in dB, parsed from "-7.25 dB" style tags.
    replaygain_db: Option<f64>,
    fields: Vec<(&'static str, String)>,
}

fn read_file(path: &Path) -> Result<ScannedFile, lofty::error::LoftyError> {
    use lofty::tag::ItemKey;
    let tagged = lofty::read_from_path(path)?;
    let duration_secs = tagged.properties().duration().as_secs_f64();
    let mut fields = Vec::new();
    let mut replaygain_db = None;
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
        replaygain_db = tag
            .get_string(ItemKey::ReplayGainTrackGain)
            .and_then(parse_replaygain_db);
    }
    Ok(ScannedFile { duration_secs, replaygain_db, fields })
}

/// "−7.25 dB" / "-7.25dB" / "-7.25" → dB value. Unparseable → None:
/// a malformed tag is missing data, not a 0 dB adjustment.
fn parse_replaygain_db(raw: &str) -> Option<f64> {
    raw.trim()
        .trim_end_matches("dB")
        .trim_end_matches("DB")
        .trim()
        .replace('\u{2212}', "-") // typographic minus, seen in the wild
        .parse()
        .ok()
}
