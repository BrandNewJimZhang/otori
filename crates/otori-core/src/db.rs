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

use std::path::Path;

use rusqlite::Connection;

/// Bumped on every schema change. `open` refuses newer versions (fail
/// fast: a newer Ōtori wrote that library) and migrates older ones.
const SCHEMA_VERSION: i64 = 10;

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
                 CHECK (bpm_source IN ('detected', 'detected+hint') OR bpm_source IS NULL),
    bpm_analyzed_at TEXT,          -- set once analysis ran (bpm NULL = beatless)
    bpm_hint     REAL,             -- external anchor (tag/provider); analysis input, not output
    bpm_hint_max REAL,             -- hint range ceiling
    bpm_hint_source TEXT           -- 'tag' | 'provider:<name>'
                 CHECK (bpm_hint_source = 'tag'
                        OR bpm_hint_source LIKE 'provider:%'
                        OR bpm_hint_source IS NULL),
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

/// Default library location: `~/Library/Application Support/otori/library.db`
/// (macOS-first; revisit when a second platform lands).
pub fn default_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    let dir = std::path::Path::new(&home)
        .join("Library/Application Support/otori");
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
    Ok(conn)
}
