//! Library database: schema, migrations, and the provenance trust stack.
//!
//! Design (PRODUCT.md L2, founding-user decisions 2026-07-07):
//! - Files are the SSOT for tag *values*; this db is the index plus the
//!   trust layer (provenance, curated flags, journal) — the one part
//!   that cannot be rebuilt from files.
//! - Source ladder: human > agent > import > inferred. `human` values
//!   are born curated; `import` values earn protection via `otori curate`.
//! - `file_hash` detects moves/exact duplicates only. Same-track
//!   dual/triple-format linking (mp3/flac/alac) is N-to-N and lives in
//!   `track_links` as link groups, not pairs.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

/// Bumped on every schema change. `open` refuses newer versions (fail
/// fast: a newer Ōtori wrote that library) and migrates older ones.
const SCHEMA_VERSION: i64 = 15;

const SCHEMA: &str = r#"
CREATE TABLE tracks (
    id           INTEGER PRIMARY KEY,
    path         TEXT NOT NULL UNIQUE,
    file_hash    TEXT,             -- move/exact-dup detection, NOT format linking
    format       TEXT NOT NULL,
    duration_secs REAL,            -- file property, no provenance; refreshed each scan
    replaygain_db REAL,            -- RG track gain in dB; file property like duration
    bpm          REAL,             -- verified tempo (or range floor), detector-owned
    bpm_max      REAL,             -- range ceiling when tempo varies (soflan); NULL = steady
    bpm_confidence REAL,           -- 0..1 detector confidence
    bpm_source   TEXT              -- how bpm was produced
                 CHECK (bpm_source IN ('detected', 'detected+hint', 'manual') OR bpm_source IS NULL),
    bpm_analyzed_at TEXT,          -- set once analysis ran (bpm NULL = beatless)
    analysis_model  TEXT,          -- which beat model produced the verdict (model switch reopens foreign-model rows)
    bpm_hint     REAL,             -- external anchor (tag/provider); analysis input, not output
    bpm_hint_max REAL,             -- hint range ceiling
    bpm_hint_source TEXT           -- 'tag' | 'provider:<name>'
                 CHECK (bpm_hint_source = 'tag'
                        OR bpm_hint_source LIKE 'provider:%'
                        OR bpm_hint_source IS NULL),
    mix_head_bpm REAL,             -- local tempo of the mix-in window (track head)
    mix_head_beat_sec REAL,        -- a measured beat inside that window
    mix_tail_bpm REAL,             -- local tempo of the mix-out window (track tail)
    mix_tail_beat_sec REAL,        -- a measured beat inside that window (absolute secs)
    mix_analyzed_at TEXT,          -- set once anchor analysis ran (NULL anchor = unstable end)
    lyrics_offset_ms INTEGER NOT NULL DEFAULT 0, -- user sync nudge; render-time, never rewrites files
    icloud_state TEXT NOT NULL DEFAULT 'local'
                 CHECK (icloud_state IN ('local', 'evicted')),
    first_seen   TEXT NOT NULL,
    last_scanned TEXT NOT NULL
);

CREATE TABLE tag_values (
    track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    field      TEXT NOT NULL,
    value      TEXT,
    source     TEXT NOT NULL
               CHECK (source IN ('human', 'agent', 'import', 'inferred')),
    curated    INTEGER NOT NULL DEFAULT 0,
    written_by TEXT,
    written_at TEXT NOT NULL,
    tx_id      INTEGER REFERENCES transactions(id),
    PRIMARY KEY (track_id, field)
);

-- Human supremacy, structurally: a human-sourced value is curated at
-- birth; no code path can forget to set the flag.
CREATE TRIGGER tag_values_human_born_curated
AFTER INSERT ON tag_values
WHEN NEW.source = 'human' AND NEW.curated = 0
BEGIN
    UPDATE tag_values SET curated = 1
    WHERE track_id = NEW.track_id AND field = NEW.field;
END;

-- Same-track multi-format link groups: all rows sharing a group_id are
-- the same musical track in different encodings.
CREATE TABLE track_links (
    group_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL UNIQUE REFERENCES tracks(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, track_id)
);

-- Immutable: a file's complete original tags before Ōtori's first write.
CREATE TABLE first_touch_snapshots (
    track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    snapshot    TEXT NOT NULL,
    captured_at TEXT NOT NULL
);

CREATE TABLE transactions (
    id         INTEGER PRIMARY KEY,
    actor      TEXT NOT NULL,
    started_at TEXT NOT NULL,
    undone     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tx_changes (
    tx_id       INTEGER NOT NULL REFERENCES transactions(id),
    track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    field       TEXT NOT NULL,
    old_value   TEXT,
    old_source  TEXT,
    old_curated INTEGER NOT NULL DEFAULT 0,
    new_value   TEXT,
    new_source  TEXT NOT NULL
);

-- Directories the user has scanned; rescan-on-launch walks these
-- (PRODUCT.md: rescan-on-launch + manual refresh instead of FSEvents).
CREATE TABLE scan_roots (
    root          TEXT PRIMARY KEY,
    first_scanned TEXT NOT NULL,
    last_scanned  TEXT NOT NULL
);
"#;

/// Which host the library lives on. The pure `library_dir` resolver is
/// parameterized over this so its per-platform branch can be tested
/// without mutating the process environment (which would race other
/// tests). `default_path` wires the live env vars into it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Macos,
    Windows,
    Linux,
}

/// The OS this build runs on, chosen at compile time. Identifying it by
/// `target_os` (not arch) keeps the library root an OS concern — a
/// Windows-ARM64 build still wants `%APPDATA%`. Any unix that isn't
/// macOS falls through to the Linux (XDG) branch, so BSD etc. keep
/// building on the unix convention.
#[cfg(target_os = "macos")]
pub const HOST: Platform = Platform::Macos;
#[cfg(target_os = "windows")]
pub const HOST: Platform = Platform::Windows;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub const HOST: Platform = Platform::Linux;

/// Resolve the library *directory* for `platform` from the supplied env
/// values, without touching the process environment or the filesystem.
///
/// - macOS: `$HOME/Library/Application Support/otori`
/// - Windows: `%APPDATA%\otori` (Roaming — same root Tauri's
///   `app_data_dir` uses, so the GUI's downloaded models and the CLI's
///   db coexist)
/// - Linux: `$XDG_DATA_HOME/otori`, else `$HOME/.local/share/otori`
///
/// Unset home/data env is a setup error — return Err rather than fall
/// back to cwd (fail fast: a wrong root silently fragments the library
/// across machines is worse than a loud open failure).
pub fn library_dir(
    platform: Platform,
    home: Option<PathBuf>,
    appdata: Option<PathBuf>,
    xdg_data_home: Option<PathBuf>,
) -> Result<PathBuf, String> {
    match platform {
        Platform::Macos => {
            let home = home.ok_or("HOME is not set")?;
            Ok(home.join("Library/Application Support/otori"))
        }
        Platform::Windows => {
            let appdata = appdata.ok_or("APPDATA is not set")?;
            Ok(appdata.join("otori"))
        }
        Platform::Linux => {
            if let Some(xdg) = xdg_data_home {
                Ok(xdg.join("otori"))
            } else {
                let home = home.ok_or("HOME is not set (and XDG_DATA_HOME unset)")?;
                Ok(home.join(".local/share/otori"))
            }
        }
    }
}

/// Default library location, host-resolved: `~/Library/Application
/// Support/otori/library.db` on macOS, `%APPDATA%\otori\library.db` on
/// Windows, `$XDG_DATA_HOME/otori/library.db` (or `~/.local/share/otori`)
/// on Linux. Creates the directory on first run.
pub fn default_path() -> Result<PathBuf, String> {
    let dir = library_dir(
        HOST,
        std::env::var_os("HOME").map(PathBuf::from),
        std::env::var_os("APPDATA").map(PathBuf::from),
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from),
    )?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir.join("library.db"))
}

/// Open (creating or migrating as needed) the library database at `path`.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    init(conn)
}

/// In-memory database with the full schema — tests and dry runs.
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    init(Connection::open_in_memory()?)
}

fn init(conn: Connection) -> rusqlite::Result<Connection> {
    conn.pragma_update(None, "foreign_keys", true)?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version == 0 {
        conn.execute_batch(SCHEMA)?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    } else if version > SCHEMA_VERSION {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN),
            Some(format!(
                "library schema v{version} is newer than this Ōtori (v{SCHEMA_VERSION}); \
                 upgrade Ōtori instead of downgrading the library"
            )),
        ));
    }
    // version in 1..=SCHEMA_VERSION: migrate stepwise to current.
    if version == 1 {
        // v2: undo must restore curated flags, so the journal records them.
        conn.execute_batch(
            "ALTER TABLE tx_changes ADD COLUMN old_curated INTEGER NOT NULL DEFAULT 0;",
        )?;
        conn.pragma_update(None, "user_version", 2)?;
    }
    if (1..=2).contains(&version) {
        // v3: duration for the player seek bar; backfilled by the next scan.
        conn.execute_batch("ALTER TABLE tracks ADD COLUMN duration_secs REAL;")?;
        conn.pragma_update(None, "user_version", 3)?;
    }
    if (1..=3).contains(&version) {
        // v4: remember scan roots so launch/manual rescans can re-walk them.
        conn.execute_batch(
            "CREATE TABLE scan_roots (
                root          TEXT PRIMARY KEY,
                first_scanned TEXT NOT NULL,
                last_scanned  TEXT NOT NULL
            );",
        )?;
        conn.pragma_update(None, "user_version", 4)?;
    }
    if (1..=4).contains(&version) {
        // v5: ReplayGain track gain for loudness normalization;
        // backfilled by the next scan like duration was in v3.
        conn.execute_batch("ALTER TABLE tracks ADD COLUMN replaygain_db REAL;")?;
        conn.pragma_update(None, "user_version", 5)?;
    }
    if (1..=5).contains(&version) {
        // v6: detected tempo. bpm_analyzed_at records that analysis
        // ran; bpm stays NULL for beatless material, so the sweeper
        // can tell "pending" from "no steady beat".
        conn.execute_batch(
            "ALTER TABLE tracks ADD COLUMN bpm REAL;
             ALTER TABLE tracks ADD COLUMN bpm_analyzed_at TEXT;",
        )?;
        conn.pragma_update(None, "user_version", 6)?;
    }
    if (1..=6).contains(&version) {
        // v7: tempo trust — range ceiling for variable-tempo tracks
        // (soflan), detector confidence, and value provenance (tag
        // beats detection). Re-analyze everything: detection semantics
        // changed, and TBPM tags weren't read before.
        conn.execute_batch(
            "ALTER TABLE tracks ADD COLUMN bpm_max REAL;
             ALTER TABLE tracks ADD COLUMN bpm_confidence REAL;
             ALTER TABLE tracks ADD COLUMN bpm_source TEXT
                 CHECK (bpm_source IN ('tag', 'detected') OR bpm_source IS NULL);
             UPDATE tracks SET bpm = NULL, bpm_analyzed_at = NULL;",
        )?;
        conn.pragma_update(None, "user_version", 7)?;
    }
    if version == 7 {
        // v8: bpm_source grows 'provider:<name>'. SQLite cannot relax a
        // column CHECK in place; drop + re-add (v7 already reset bpm
        // data, and tag values are restored by the next scan).
        conn.execute_batch(
            "ALTER TABLE tracks DROP COLUMN bpm_source;
             ALTER TABLE tracks ADD COLUMN bpm_source TEXT
                 CHECK (bpm_source IN ('tag', 'detected')
                        OR bpm_source LIKE 'provider:%'
                        OR bpm_source IS NULL);
             UPDATE tracks SET bpm = NULL, bpm_max = NULL,
                 bpm_confidence = NULL, bpm_analyzed_at = NULL;",
        )?;
        conn.pragma_update(None, "user_version", 8)?;
    }
    if (7..=8).contains(&version) {
        // v9: external BPM demoted from result to hint (analysis
        // anchor). bpm becomes detector-owned; tag/provider values
        // move to bpm_hint*. Migrate existing tag/provider rows into
        // hints and reopen their analysis for verification.
        conn.execute_batch(
            "ALTER TABLE tracks ADD COLUMN bpm_hint REAL;
             ALTER TABLE tracks ADD COLUMN bpm_hint_max REAL;
             ALTER TABLE tracks ADD COLUMN bpm_hint_source TEXT
                 CHECK (bpm_hint_source = 'tag'
                        OR bpm_hint_source LIKE 'provider:%'
                        OR bpm_hint_source IS NULL);
             UPDATE tracks SET
                 bpm_hint = bpm, bpm_hint_max = bpm_max,
                 bpm_hint_source = bpm_source,
                 bpm = NULL, bpm_max = NULL, bpm_confidence = NULL,
                 bpm_source = NULL, bpm_analyzed_at = NULL
             WHERE bpm_source = 'tag' OR bpm_source LIKE 'provider:%';
             UPDATE tracks SET bpm_source = NULL WHERE bpm_source NOT IN ('detected', 'detected+hint');",
        )?;
        // Old narrow CHECK on bpm_source (v8) tolerated these values;
        // the new semantics live in code (set_bpm writes only
        // 'detected'/'detected+hint'), so no column rebuild needed.
        conn.pragma_update(None, "user_version", 9)?;
    }
    if version == 9 {
        // v10: the detector's search window widened (180 → 230 BPM) —
        // every pre-v10 detection may carry the octave-halving error
        // the narrow window forced on 170-230 BPM material. Reopen
        // analysis for all detected rows; keep the stale value visible
        // until the sweep replaces it (a probably-right number beats
        // a blank column mid-resweep). Hints are untouched.
        conn.execute_batch(
            "UPDATE tracks SET bpm_analyzed_at = NULL
             WHERE bpm_source IN ('detected', 'detected+hint');",
        )?;
        conn.pragma_update(None, "user_version", 10)?;
    }
    if (1..=10).contains(&version) {
        // v11: mix anchors — per-end local beat grids (bpm + a measured
        // beat) for crossfade planning. The head grid serves the track
        // as mix-in, the tail grid as mix-out; a whole-track bpm can't
        // do either job on variable-tempo (soflan) material, and
        // extrapolating a head grid to the tail drifts half a beat over
        // an album cut even when the tempo is steady. NULL anchor with
        // mix_analyzed_at set = that end is unstable (no beat-match
        // there, plain fade). Backfilled by the sweeper.
        conn.execute_batch(
            "ALTER TABLE tracks ADD COLUMN mix_head_bpm REAL;
             ALTER TABLE tracks ADD COLUMN mix_head_beat_sec REAL;
             ALTER TABLE tracks ADD COLUMN mix_tail_bpm REAL;
             ALTER TABLE tracks ADD COLUMN mix_tail_beat_sec REAL;
             ALTER TABLE tracks ADD COLUMN mix_analyzed_at TEXT;",
        )?;
        conn.pragma_update(None, "user_version", 11)?;
    }
    if (1..=11).contains(&version) {
        // v12: per-track lyrics sync offset (user nudge in the player).
        // Index-only state like column widths would be, but per *track*
        // — it cannot be rebuilt from files, so it lives here.
        conn.execute_batch(
            "ALTER TABLE tracks ADD COLUMN lyrics_offset_ms INTEGER NOT NULL DEFAULT 0;",
        )?;
        conn.pragma_update(None, "user_version", 12)?;
    }
    if (1..=12).contains(&version) {
        // v13: detector swap — classical autocorrelation (frontend)
        // retired for Beat This! in Rust (ADR-0001 A6). Every verdict
        // and every mix anchor predates the new engine; reopen all
        // analysis, keep stale values visible until the sweep
        // replaces them (v10 precedent). Hints are untouched. Future
        // algorithm tweaks use `otori reanalyze`, not migrations.
        conn.execute_batch(
            "UPDATE tracks SET bpm_analyzed_at = NULL, mix_analyzed_at = NULL;",
        )?;
        conn.pragma_update(None, "user_version", 13)?;
    }
    if (1..=13).contains(&version) {
        // v14: record which beat model produced each verdict, so a
        // user-facing model switch (small ↔ standard) can reopen only
        // foreign-model rows instead of the whole library. NULL on
        // existing rows = "unknown model"; the next sweep stamps the
        // active model, and a model switch re-runs them (ReopenScope::Model).
        conn.execute_batch("ALTER TABLE tracks ADD COLUMN analysis_model TEXT;")?;
        conn.pragma_update(None, "user_version", 14)?;
    }
    if (1..=14).contains(&version) {
        // v15: bpm_source grows 'manual' for user-stated BPM overrides
        // (the trust tier above detection). SQLite cannot relax a column
        // CHECK in place; drop + re-add (v8 precedent). Existing values
        // are all 'detected'/'detected+hint'/NULL, so no data rewrite.
        conn.execute_batch(
            "ALTER TABLE tracks DROP COLUMN bpm_source;
             ALTER TABLE tracks ADD COLUMN bpm_source TEXT
                 CHECK (bpm_source IN ('detected', 'detected+hint', 'manual')
                        OR bpm_source IS NULL);",
        )?;
        conn.pragma_update(None, "user_version", 15)?;
    }
    Ok(conn)
}
