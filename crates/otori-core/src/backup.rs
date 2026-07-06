//! Library backup (founding-user decision 2026-07-07: "we must protect
//! the existing metadata"). The index db is the single non-rebuildable
//! asset — tag values can be rescanned from files, but provenance,
//! curated flags, the journal, and first-touch snapshots exist nowhere
//! else. `VACUUM INTO` produces a consistent snapshot of a live
//! database without blocking readers or writers.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

/// Snapshot the open library into `dest`. Refuses to overwrite:
/// backups protect data, they never destroy it.
pub fn backup(conn: &Connection, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        return Err(format!(
            "refusing to overwrite existing file: {}",
            dest.display()
        ));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    conn.execute("VACUUM INTO ?1", [dest.to_string_lossy()])
        .map_err(|e| format!("backup failed: {e}"))?;
    Ok(())
}

/// How many automatic backups to keep (manual backups are never pruned
/// — pruning only ever touches `library-*.db` inside the auto dir).
pub const AUTO_KEEP: usize = 10;

/// Safety-net backup: snapshot into `dir` with a timestamped name,
/// then prune the oldest auto-backups beyond [`AUTO_KEEP`]. Called
/// before the first destructive write of a session so "the agent ate
/// my library" always has a same-day recovery point.
pub fn auto_backup(conn: &Connection, dir: &Path) -> Result<PathBuf, String> {
    let dest = default_backup_path(dir)?;
    backup(conn, &dest)?;

    // Prune: timestamped names sort chronologically, oldest first.
    let mut autos: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("cannot list {}: {e}", dir.display()))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .map(|n| {
                    let n = n.to_string_lossy();
                    n.starts_with("library-") && n.ends_with(".db")
                })
                .unwrap_or(false)
        })
        .collect();
    autos.sort();
    let excess = autos.len().saturating_sub(AUTO_KEEP);
    for old in autos.into_iter().take(excess) {
        // Best-effort: a failed prune must not fail the backup.
        let _ = std::fs::remove_file(old);
    }
    Ok(dest)
}

/// Timestamped, collision-free backup filename inside `dir`:
/// `library-YYYYMMDD-HHMMSS.db`, with a `-N` suffix if that exact
/// name already exists (two backups in one second).
pub fn default_backup_path(dir: &Path) -> Result<PathBuf, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    // Format UTC seconds as YYYYMMDD-HHMMSS without a chrono dependency.
    let days = now / 86_400;
    let (y, m, d) = civil_from_days(days as i64);
    let secs = now % 86_400;
    let stamp = format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    );
    let base = dir.join(format!("library-{stamp}.db"));
    if !base.exists() {
        return Ok(base);
    }
    for n in 1..100 {
        let candidate = dir.join(format!("library-{stamp}-{n}.db"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("cannot find a free backup filename".to_string())
}

/// Days-since-epoch → (year, month, day). Howard Hinnant's civil
/// algorithm; exact for the proleptic Gregorian calendar.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
