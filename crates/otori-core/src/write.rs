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

/// One track's worth of edits inside a batch save (GUI multi-select,
/// future CLI bulk operations). One batch = one journal transaction.
#[derive(Debug, Clone)]
pub struct TrackChanges {
    pub path: std::path::PathBuf,
    pub changes: Vec<FieldChange>,
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
    /// The pre-write safety net failed. No backup, no mutation.
    Backup(String),
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
            WriteError::Backup(e) => write!(f, "pre-write backup failed (write aborted): {e}"),
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

/// Apply a set of field edits to one track. The N=1 case of
/// [`apply_set_many`] — one path, same trust stack.
pub fn apply_set(
    conn: &mut Connection,
    path: &Path,
    changes: &[FieldChange],
    actor: Actor<'_>,
    override_curated: bool,
) -> Result<Option<i64>, WriteError> {
    let edits = [TrackChanges { path: path.to_path_buf(), changes: changes.to_vec() }];
    apply_set_many(conn, &edits, actor, override_curated)
}

/// Pre-destructive-write safety net as a core invariant (ADR-0001 A5):
/// snapshot the db into `<db-dir>/backups/` before any mutation, so no
/// consumer (CLI, GUI IPC, future callers) can skip it. In-memory
/// databases have no path and are skipped — nothing durable to protect.
fn backup_before_mutation(conn: &Connection) -> Result<(), WriteError> {
    let dir = match conn.path() {
        Some(p) if !p.is_empty() => match Path::new(p).parent() {
            Some(parent) => parent.join("backups"),
            None => return Ok(()),
        },
        _ => return Ok(()), // in-memory / temp db
    };
    crate::backup::auto_backup(conn, &dir).map_err(WriteError::Backup)?;
    Ok(())
}

/// Apply field edits across N tracks as ONE journal transaction:
/// db auto-backup, per-file first-touch snapshots, disk-first writes,
/// index + journal — all inside a single db transaction, so
/// `undo <txid>` rolls back the whole batch (GUI multi-select save).
/// Returns the tx id, or `None` when no plan had anything to apply.
///
/// A file failure mid-batch rolls back the db AND compensates files
/// already written (files are rescannable; the trust layer is not —
/// the db transaction protects the asset that matters most).
pub fn apply_set_many(
    conn: &mut Connection,
    edits: &[TrackChanges],
    actor: Actor<'_>,
    override_curated: bool,
) -> Result<Option<i64>, WriteError> {
    // Plan everything first: no-op batches must not journal or backup.
    let mut planned: Vec<(i64, &TrackChanges, Plan)> = Vec::new();
    for edit in edits {
        let plan = plan_set(conn, &edit.path, &edit.changes, actor, override_curated)?;
        if plan.changes.is_empty() {
            continue;
        }
        let track_id = find_track(conn, &plan.path)?;
        planned.push((track_id, edit, plan));
    }
    if planned.is_empty() {
        return Ok(None);
    }

    backup_before_mutation(conn)?;

    let tx = conn.transaction().map_err(WriteError::Db)?;
    tx.execute(
        "INSERT INTO transactions (actor, started_at) VALUES (?1, datetime('now'))",
        [actor.label()],
    )?;
    let tx_id = tx.last_insert_rowid();

    // Files written so far, with their pre-write values — the
    // compensation list if a later file in the batch fails.
    let mut written: Vec<(&Path, Vec<(String, Option<String>)>)> = Vec::new();

    let apply_one = |tx: &rusqlite::Transaction,
                         track_id: i64,
                         edit: &TrackChanges,
                         plan: &Plan|
     -> Result<Vec<(String, Option<String>)>, WriteError> {
        // First touch: snapshot the file's original tags before Ōtori
        // ever writes to it. INSERT OR IGNORE keeps the first immutable.
        let original = crate::read_track_tags(&edit.path)?;
        tx.execute(
            "INSERT OR IGNORE INTO first_touch_snapshots (track_id, snapshot, captured_at)
             VALUES (?1, ?2, datetime('now'))",
            params![track_id, serde_json::to_string(&original).unwrap()],
        )?;

        // Disk first: if the file write fails, the db rolls back.
        write_fields_to_file(
            &edit.path,
            plan.changes.iter().map(|c| (c.field.as_str(), Some(c.new.as_str()))),
        )?;
        let pre_write: Vec<(String, Option<String>)> =
            plan.changes.iter().map(|c| (c.field.clone(), c.old.clone())).collect();

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
        Ok(pre_write)
    };

    for (track_id, edit, plan) in &planned {
        match apply_one(&tx, *track_id, edit, plan) {
            Ok(pre_write) => written.push((&edit.path, pre_write)),
            Err(e) => {
                // Compensate files already written this batch (best
                // effort: file values are rescannable; the original
                // error is what the caller must see either way).
                drop(tx);
                for (path, fields) in written.iter().rev() {
                    let _ = write_fields_to_file(
                        path,
                        fields.iter().map(|(f, v)| (f.as_str(), v.as_deref())),
                    );
                }
                return Err(e);
            }
        }
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

    // Undo rewrites files AND the trust layer — same safety net.
    backup_before_mutation(conn)?;

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

/// Embed the track's resolved artwork (sidecar or folder cover) into
/// the audio file itself. A real file write → full L2: first-touch
/// snapshot, journal (undo removes the picture; the source image stays
/// on disk as the fallback). Refuses when a picture is already
/// embedded (replacement = undo/remove first, then re-embed) and when
/// there is nothing to embed.
pub fn embed_artwork(
    conn: &mut Connection,
    path: &Path,
    actor: Actor<'_>,
) -> Result<i64, WriteError> {
    let path_str = path.to_string_lossy().into_owned();
    let track_id = find_track(conn, &path_str)?;

    let art = crate::artwork::resolve(path)?;
    let art = match art {
        Some(a) if a.source == "embedded" => {
            return Err(WriteError::UnknownField(
                "a picture is already embedded; undo the embed or strip it first".to_string(),
            ))
        }
        Some(a) => a,
        None => {
            return Err(WriteError::UnknownField(
                "no artwork to embed (no sidecar image, no folder cover)".to_string(),
            ))
        }
    };

    // Real file write → same pre-mutation safety net as apply_set.
    backup_before_mutation(conn)?;

    let tx = conn.transaction().map_err(WriteError::Db)?;

    // First touch: same immutable snapshot rule as tag writes.
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

    // Disk first: failure rolls back snapshot + journal together.
    let tagged = lofty::read_from_path(path)?;
    let mut tag = tagged
        .primary_tag()
        .or_else(|| tagged.first_tag())
        .cloned()
        .unwrap_or_else(|| Tag::new(tagged.primary_tag_type()));
    let mime = match art.mime.as_str() {
        "image/png" => lofty::picture::MimeType::Png,
        "image/webp" => lofty::picture::MimeType::Unknown("image/webp".to_string()),
        _ => lofty::picture::MimeType::Jpeg,
    };
    let picture = lofty::picture::Picture::unchecked(art.data)
        .pic_type(lofty::picture::PictureType::CoverFront)
        .mime_type(mime)
        .build();
    tag.push_picture(picture);
    tag.save_to_path(path, WriteOptions::default())?;

    // Journal: old = no picture, new = picture from this source. The
    // journal stores provenance, not bytes — undo means "remove".
    tx.execute(
        "INSERT INTO tx_changes (tx_id, track_id, field, old_value, old_source, old_curated, new_value, new_source)
         VALUES (?1, ?2, 'picture', NULL, NULL, 0, ?3, ?4)",
        params![tx_id, track_id, art.source, actor.source()],
    )?;
    tx.commit()?;
    Ok(tx_id)
}

/// Strip the embedded picture from the audio file (inspector "Remove
/// cover"). The mirror of [`embed_artwork`]: refuses when nothing is
/// embedded, full L2 (backup, first-touch snapshot, journal). Sidecar
/// and folder images are files on disk, not tags — untouched; the
/// resolve chain falls back to them after removal.
///
/// The journal stores provenance, not bytes, so undoing a removal is
/// impossible (`("picture", Some(_))` fails in undo) — recovery is the
/// first-touch snapshot / file backups, and callers must not promise
/// an undo handle for this transaction.
pub fn remove_artwork(
    conn: &mut Connection,
    path: &Path,
    actor: Actor<'_>,
) -> Result<i64, WriteError> {
    let path_str = path.to_string_lossy().into_owned();
    let track_id = find_track(conn, &path_str)?;

    match crate::artwork::resolve(path)? {
        Some(a) if a.source == "embedded" => {}
        _ => {
            return Err(WriteError::UnknownField(
                "no embedded picture to remove (sidecar/folder art is a file, not a tag)"
                    .to_string(),
            ))
        }
    }

    // Real file write → same pre-mutation safety net as apply_set.
    backup_before_mutation(conn)?;

    let tx = conn.transaction().map_err(WriteError::Db)?;

    // First touch: same immutable snapshot rule as tag writes.
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

    // Disk first: failure rolls back snapshot + journal together.
    write_fields_to_file(path, std::iter::once(("picture", None)))?;

    // Journal: old = there was an embedded picture, new = none.
    tx.execute(
        "INSERT INTO tx_changes (tx_id, track_id, field, old_value, old_source, old_curated, new_value, new_source)
         VALUES (?1, ?2, 'picture', 'embedded', NULL, 0, NULL, ?3)",
        params![tx_id, track_id, actor.source()],
    )?;
    tx.commit()?;
    Ok(tx_id)
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
            // Undo of embed_artwork. The journal cannot hold image bytes,
            // so only removal is expressible — which is exactly what
            // undoing an embed means (the sidecar the image came from is
            // kept on disk; the chain falls back to it).
            ("picture", None) => {
                while !tag.pictures().is_empty() {
                    tag.remove_picture(0);
                }
            }
            ("picture", Some(_)) => {
                return Err(WriteError::UnknownField(
                    "picture cannot be restored from the journal; re-embed from the sidecar"
                        .to_string(),
                ))
            }
            (other, _) => return Err(WriteError::UnknownField(other.to_string())),
        }
    }
    tag.save_to_path(path, WriteOptions::default())?;
    Ok(())
}
