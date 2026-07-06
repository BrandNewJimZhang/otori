//! Tag writing under the L2 trust stack (PRODUCT.md):
//! provenance guards *before* (curated fields bounce agents),
//! dry-run plans *during* (diff first, `--apply` to make it real),
//! journal + first-touch snapshot *after* (every apply is undoable,
//! and a file's pre-Ōtori tags are always recoverable).
//!
//! Files are the SSOT for values; the index is the SSOT for trust.
//! Every write goes disk-first inside a db transaction: if the file
//! write fails, the index and journal roll back with it.

use std::fmt;
use std::path::Path;

use lofty::config::WriteOptions;
use lofty::file::TaggedFileExt;
use lofty::prelude::*;
use lofty::tag::Tag;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// Who is asking. The distinction is the whole point of L2: humans are
/// never blocked by curated flags, agents are.
#[derive(Debug, Clone, Copy)]
pub enum Actor<'a> {
    Human { via: &'a str },
    Agent { id: &'a str },
}

impl Actor<'_> {
    fn source(&self) -> &'static str {
        match self {
            Actor::Human { .. } => "human",
            Actor::Agent { .. } => "agent",
        }
    }
    fn label(&self) -> String {
        match self {
            Actor::Human { via } => (*via).to_string(),
            Actor::Agent { id } => format!("agent:{id}"),
        }
    }
    fn is_agent(&self) -> bool {
        matches!(self, Actor::Agent { .. })
    }
}

/// One requested field edit. Only fields the index knows: title,
/// artist, album (grows with the query surface, never ahead of it).
#[derive(Debug, Clone)]
pub struct FieldChange {
    pub field: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
pub struct PlannedChange {
    pub field: String,
    pub old: Option<String>,
    pub new: String,
}

/// A curated field an agent asked to change and was refused. Rendered
/// loudly so the agent can relay the proposal to a human (agents may
/// propose, never write).
#[derive(Debug, Serialize)]
pub struct SkippedField {
    pub field: String,
    pub current: String,
    pub proposed: String,
}

#[derive(Debug, Serialize)]
pub struct Plan {
    pub path: String,
    pub changes: Vec<PlannedChange>,
    pub skipped_curated: Vec<SkippedField>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub enum PlanOutcome {
    /// Nothing to do: every requested value already matches.
    Nothing,
    /// At least one field will change on apply.
    Changes,
    /// Every requested change bounced off a curated field.
    CuratedSkipsOnly,
}

impl Plan {
    pub fn outcome(&self) -> PlanOutcome {
        if !self.changes.is_empty() {
            PlanOutcome::Changes
        } else if !self.skipped_curated.is_empty() {
            PlanOutcome::CuratedSkipsOnly
        } else {
            PlanOutcome::Nothing
        }
    }
}

#[derive(Debug)]
pub enum WriteError {
    Db(rusqlite::Error),
    File(lofty::error::LoftyError),
    TrackNotIndexed(String),
    UnknownField(String),
    UnknownTransaction(i64),
    AlreadyUndone(i64),
}

impl fmt::Display for WriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WriteError::Db(e) => write!(f, "index error: {e}"),
            WriteError::File(e) => write!(f, "file error: {e}"),
            WriteError::TrackNotIndexed(p) => {
                write!(f, "not in the library index (scan first): {p}")
            }
            WriteError::UnknownField(name) => write!(f, "unknown tag field: {name}"),
            WriteError::UnknownTransaction(id) => write!(f, "no such transaction: {id}"),
            WriteError::AlreadyUndone(id) => write!(f, "transaction {id} is already undone"),
        }
    }
}

impl std::error::Error for WriteError {}

impl From<rusqlite::Error> for WriteError {
    fn from(e: rusqlite::Error) -> Self {
        WriteError::Db(e)
    }
}

impl From<lofty::error::LoftyError> for WriteError {
    fn from(e: lofty::error::LoftyError) -> Self {
        WriteError::File(e)
    }
}

const WRITABLE_FIELDS: &[&str] = &["title", "artist", "album"];

/// Compute what `apply_set` would do — the dry-run diff. Reads only.
pub fn plan_set(
    conn: &mut Connection,
    path: &Path,
    changes: &[FieldChange],
    actor: Actor<'_>,
    override_curated: bool,
) -> Result<Plan, WriteError> {
    let path_str = path.to_string_lossy().into_owned();
    let track_id = find_track(conn, &path_str)?;
    let mut plan = Plan {
        path: path_str,
        changes: Vec::new(),
        skipped_curated: Vec::new(),
    };

    for change in changes {
        if !WRITABLE_FIELDS.contains(&change.field.as_str()) {
            return Err(WriteError::UnknownField(change.field.clone()));
        }
        let current: Option<(Option<String>, i64)> = conn
            .query_row(
                "SELECT value, curated FROM tag_values WHERE track_id = ?1 AND field = ?2",
                params![track_id, change.field],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (old_value, curated) = match current {
            Some((v, c)) => (v, c == 1),
            None => (None, false),
        };

        if old_value.as_deref() == Some(change.value.as_str()) {
            continue; // no-op: already the requested value
        }
        if curated && actor.is_agent() && !override_curated {
            plan.skipped_curated.push(SkippedField {
                field: change.field.clone(),
                current: old_value.unwrap_or_default(),
                proposed: change.value.clone(),
            });
            continue;
        }
        plan.changes.push(PlannedChange {
            field: change.field.clone(),
            old: old_value,
            new: change.value.clone(),
        });
    }
    Ok(plan)
}

/// Apply a set of field edits: first-touch snapshot, disk write, index
/// update, journal — one transaction. Returns the journal tx id, or
/// `None` when the plan had nothing to apply.
pub fn apply_set(
    conn: &mut Connection,
    path: &Path,
    changes: &[FieldChange],
    actor: Actor<'_>,
    override_curated: bool,
) -> Result<Option<i64>, WriteError> {
    let plan = plan_set(conn, path, changes, actor, override_curated)?;
    if plan.changes.is_empty() {
        return Ok(None);
    }
    let track_id = find_track(conn, &plan.path)?;
    let tx = conn.transaction().map_err(WriteError::Db)?;

    // First touch: snapshot the file's original tags before Ōtori ever
    // writes to it. INSERT OR IGNORE keeps the first snapshot immutable.
    let original = crate::read_track_tags(path)?;
    tx.execute(
        "INSERT OR IGNORE INTO first_touch_snapshots (track_id, snapshot, captured_at)
         VALUES (?1, ?2, datetime('now'))",
        params![track_id, serde_json::to_string(&original).unwrap()],
    )?;

    tx.execute(
        "INSERT INTO transactions (actor, started_at) VALUES (?1, datetime('now'))",
        [actor.label()],
    )?;
    let tx_id = tx.last_insert_rowid();

    // Disk first: if the file write fails, everything above rolls back.
    write_fields_to_file(
        path,
        plan.changes.iter().map(|c| (c.field.as_str(), Some(c.new.as_str()))),
    )?;

    for change in &plan.changes {
        let old: Option<(Option<String>, Option<String>, i64)> = tx
            .query_row(
                "SELECT value, source, curated FROM tag_values
                 WHERE track_id = ?1 AND field = ?2",
                params![track_id, change.field],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let (old_value, old_source, old_curated) = old.unwrap_or((None, None, 0));

        tx.execute(
            "INSERT INTO tag_values (track_id, field, value, source, curated, written_by, written_at, tx_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), ?7)
             ON CONFLICT (track_id, field) DO UPDATE SET
               value = excluded.value, source = excluded.source,
               curated = excluded.curated, written_by = excluded.written_by,
               written_at = excluded.written_at, tx_id = excluded.tx_id",
            params![
                track_id,
                change.field,
                change.new,
                actor.source(),
                // Human values are born curated; anything else must earn it.
                if actor.is_agent() { 0 } else { 1 },
                actor.label(),
                tx_id
            ],
        )?;
        tx.execute(
            "INSERT INTO tx_changes (tx_id, track_id, field, old_value, old_source, old_curated, new_value, new_source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                tx_id,
                track_id,
                change.field,
                old_value,
                old_source,
                old_curated,
                change.new,
                actor.source()
            ],
        )?;
    }

    tx.commit()?;
    Ok(Some(tx_id))
}

/// Roll back a whole applied transaction: file values, index values,
/// provenance, and curated flags all return to their pre-apply state.
pub fn undo(conn: &mut Connection, tx_id: i64) -> Result<(), WriteError> {
    let undone: i64 = conn
        .query_row("SELECT undone FROM transactions WHERE id = ?1", [tx_id], |r| r.get(0))
        .optional()?
        .ok_or(WriteError::UnknownTransaction(tx_id))?;
    if undone != 0 {
        return Err(WriteError::AlreadyUndone(tx_id));
    }

    struct Reverted {
        track_id: i64,
        path: String,
        field: String,
        old_value: Option<String>,
        old_source: Option<String>,
        old_curated: i64,
    }
    let rows: Vec<Reverted> = conn
        .prepare(
            "SELECT c.track_id, t.path, c.field, c.old_value, c.old_source, c.old_curated
             FROM tx_changes c JOIN tracks t ON t.id = c.track_id
             WHERE c.tx_id = ?1",
        )?
        .query_map([tx_id], |r| {
            Ok(Reverted {
                track_id: r.get(0)?,
                path: r.get(1)?,
                field: r.get(2)?,
                old_value: r.get(3)?,
                old_source: r.get(4)?,
                old_curated: r.get(5)?,
            })
        })?
        .collect::<Result<_, _>>()?;

    let tx = conn.transaction()?;
    for row in &rows {
        write_fields_to_file(
            Path::new(&row.path),
            std::iter::once((row.field.as_str(), row.old_value.as_deref())),
        )?;
        if row.old_source.is_none() && row.old_value.is_none() {
            // The field did not exist before this transaction.
            tx.execute(
                "DELETE FROM tag_values WHERE track_id = ?1 AND field = ?2",
                params![row.track_id, row.field],
            )?;
        } else {
            tx.execute(
                "UPDATE tag_values SET value = ?3, source = ?4, curated = ?5,
                 written_by = 'undo', written_at = datetime('now'), tx_id = NULL
                 WHERE track_id = ?1 AND field = ?2",
                params![row.track_id, row.field, row.old_value, row.old_source, row.old_curated],
            )?;
        }
    }
    tx.execute("UPDATE transactions SET undone = 1 WHERE id = ?1", [tx_id])?;
    tx.commit()?;
    Ok(())
}

/// The onboarding oath: mark existing values as curated so past labor
/// is protected before any agent touches the library. `path = None`
/// curates the whole library. Returns how many fields were protected.
pub fn curate(conn: &mut Connection, path: Option<&Path>) -> Result<u64, WriteError> {
    let count = match path {
        Some(p) => {
            let path_str = p.to_string_lossy();
            let track_id = find_track(conn, &path_str)?;
            conn.execute(
                "UPDATE tag_values SET curated = 1
                 WHERE track_id = ?1 AND curated = 0 AND value IS NOT NULL",
                [track_id],
            )?
        }
        None => conn.execute(
            "UPDATE tag_values SET curated = 1 WHERE curated = 0 AND value IS NOT NULL",
            [],
        )?,
    };
    Ok(count as u64)
}

fn find_track(conn: &Connection, path: &str) -> Result<i64, WriteError> {
    conn.query_row("SELECT id FROM tracks WHERE path = ?1", [path], |r| r.get(0))
        .optional()?
        .ok_or_else(|| WriteError::TrackNotIndexed(path.to_string()))
}

/// Write field values straight to the audio file. `None` removes the
/// field (undo of a fill-empty).
fn write_fields_to_file<'a>(
    path: &Path,
    fields: impl Iterator<Item = (&'a str, Option<&'a str>)>,
) -> Result<(), WriteError> {
    let tagged = lofty::read_from_path(path)?;
    let mut tag = tagged
        .primary_tag()
        .or_else(|| tagged.first_tag())
        .cloned()
        .unwrap_or_else(|| Tag::new(tagged.primary_tag_type()));
    for (field, value) in fields {
        match (field, value) {
            ("title", Some(v)) => tag.set_title(v.to_string()),
            ("title", None) => tag.remove_title(),
            ("artist", Some(v)) => tag.set_artist(v.to_string()),
            ("artist", None) => tag.remove_artist(),
            ("album", Some(v)) => tag.set_album(v.to_string()),
            ("album", None) => tag.remove_album(),
            (other, _) => return Err(WriteError::UnknownField(other.to_string())),
        }
    }
    tag.save_to_path(path, WriteOptions::default())?;
    Ok(())
}
