//! `otori` — agent-first CLI for the Ōtori music library.
//!
//! Contract for every subcommand (see ADR-0001, AGENTS.md):
//! - `--json` emits machine-readable output with a stable schema
//! - destructive operations support `--dry-run` and default to it
//! - errors go to stderr as structured JSON; exit codes are semantic:
//!   0 ok / 2 partial success / 3 bad input / 4 corrupt or unopenable library

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "otori", version, about = "Ōtori music library CLI")]
struct Cli {
    /// Library database path (default: ~/Library/Application Support/otori/library.db)
    #[arg(long, global = true)]
    db: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Scan a directory into the library index
    Scan {
        dir: PathBuf,
        /// Emit the scan report as JSON
        #[arg(long)]
        json: bool,
    },
    /// List indexed tracks
    List {
        /// Emit tracks as JSON
        #[arg(long)]
        json: bool,
    },
    /// Print tags of an audio file as JSON (reads the file, not the index)
    Tags { path: PathBuf },
    /// Print lyrics for an audio file (embedded tag, then sidecar .lrc)
    Lyrics {
        path: PathBuf,
        /// Emit the parsed lyrics document as JSON
        #[arg(long)]
        json: bool,
    },
    /// Locate cover art (embedded -> sidecar image -> folder cover)
    Artwork {
        path: PathBuf,
        /// Write the image bytes to this file (otherwise report only)
        #[arg(long)]
        out: Option<PathBuf>,
        /// Minimum acceptable dimension in px (exit 2 below; jackets
        /// for the Stage need at least this on the shorter side)
        #[arg(long, default_value_t = 500)]
        min_size: u32,
        #[arg(long)]
        json: bool,
    },
    /// Snapshot the library db (provenance/journal are not rebuildable)
    Backup {
        /// Destination file (default: timestamped name next to the db)
        dest: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    /// Fetch a jacket from VocaDB and save it as a sidecar image
    Jacket {
        path: PathBuf,
        /// Actually download and write the sidecar; default reports the match only
        #[arg(long)]
        apply: bool,
        /// Resolution floor in px (shorter side)
        #[arg(long, default_value_t = 500)]
        min_size: u32,
        /// Accept a studio/compilation album cover when no self-titled
        /// single exists (jacket priority: self-titled single > rhythm
        /// game jacket via wiki > this fallback)
        #[arg(long)]
        allow_album_cover: bool,
        #[arg(long)]
        json: bool,
    },
    /// Edit tag fields (dry-run by default; --apply to write)
    Set {
        path: PathBuf,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        artist: Option<String>,
        #[arg(long)]
        album: Option<String>,
        /// Actually write (file + index + journal); default is dry-run diff
        #[arg(long)]
        apply: bool,
        /// Identify as an agent; curated fields will be skipped
        #[arg(long)]
        agent: Option<String>,
        /// Allow overwriting curated fields (rendered loudly in the diff)
        #[arg(long)]
        override_curated: bool,
        /// Emit the plan/result as JSON
        #[arg(long)]
        json: bool,
    },
    /// Mark existing tag values as curated (protected from agents)
    Curate {
        /// One file; omit with --all for the whole library
        path: Option<PathBuf>,
        /// Curate every indexed value
        #[arg(long)]
        all: bool,
        #[arg(long)]
        json: bool,
    },
    /// Roll back an applied transaction (file + index + provenance)
    Undo { tx_id: i64 },
    /// List applied transactions
    Journal {
        #[arg(long)]
        json: bool,
    },
    /// Library vital signs: counts, completeness, protection, history
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Print the CLI JSON schema version
    SchemaVersion,
}

const EXIT_PARTIAL: u8 = 2;
const EXIT_BAD_INPUT: u8 = 3;
const EXIT_LIBRARY: u8 = 4;

/// Version of every `--json` output schema in this binary. Bump on any
/// breaking change to a JSON shape; additive fields do not bump it
/// (consumers must tolerate unknown fields). Documented in AGENTS.md.
const CLI_SCHEMA_VERSION: &str = "1";

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli) {
        Ok(code) => code,
        Err(e) => {
            eprintln!(
                "{}",
                serde_json::json!({ "error": e.message, "kind": e.kind })
            );
            ExitCode::from(e.exit)
        }
    }
}

struct CliError {
    kind: &'static str,
    message: String,
    exit: u8,
}

impl CliError {
    fn library(e: impl std::fmt::Display) -> Self {
        Self { kind: "library", message: e.to_string(), exit: EXIT_LIBRARY }
    }
    fn bad_input(message: impl Into<String>) -> Self {
        Self { kind: "bad_input", message: message.into(), exit: EXIT_BAD_INPUT }
    }
}

fn run(cli: Cli) -> Result<ExitCode, CliError> {
    match cli.command {
        Command::Scan { dir, json } => {
            if !dir.is_dir() {
                return Err(CliError::bad_input(format!(
                    "not a directory: {}",
                    dir.display()
                )));
            }
            let mut conn = open_library(cli.db)?;
            let report = otori_core::scan::scan(&mut conn, &dir).map_err(CliError::library)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&report).unwrap());
            } else {
                println!(
                    "added {}, updated {}, icloud-skipped {}, unreadable {}",
                    report.added,
                    report.updated,
                    report.skipped_icloud.len(),
                    report.unreadable.len()
                );
                for p in &report.skipped_icloud {
                    println!("  icloud: {p}");
                }
                for p in &report.unreadable {
                    println!("  unreadable: {p}");
                }
            }
            // Partial success: the library indexed, but some files need attention.
            if !report.unreadable.is_empty() || !report.skipped_icloud.is_empty() {
                return Ok(ExitCode::from(EXIT_PARTIAL));
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::List { json } => {
            let conn = open_library(cli.db)?;
            let tracks = otori_core::query::list_tracks(&conn).map_err(CliError::library)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&tracks).unwrap());
            } else {
                for t in &tracks {
                    println!(
                        "{} — {} [{}]",
                        t.artist.as_deref().unwrap_or("?"),
                        t.title.as_deref().unwrap_or(&t.path),
                        t.format
                    );
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Tags { path } => {
            if !path.is_file() {
                return Err(CliError::bad_input(format!(
                    "not a file: {}",
                    path.display()
                )));
            }
            let tags = otori_core::read_track_tags(&path)
                .map_err(|e| CliError::bad_input(e.to_string()))?;
            println!("{}", serde_json::to_string_pretty(&tags).unwrap());
            Ok(ExitCode::SUCCESS)
        }
        Command::Lyrics { path, json } => {
            if !path.is_file() {
                return Err(CliError::bad_input(format!(
                    "not a file: {}",
                    path.display()
                )));
            }
            let doc = otori_core::lyrics::resolve(&path)
                .map_err(|e| CliError::bad_input(e.to_string()))?;
            match doc {
                Some(doc) if json => {
                    println!("{}", serde_json::to_string_pretty(&doc).unwrap())
                }
                Some(doc) => {
                    for line in &doc.lines {
                        println!("{}", line.text);
                    }
                }
                None if json => println!("null"),
                None => println!("(no lyrics: not embedded, no sidecar .lrc)"),
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Artwork { path, out, min_size, json } => {
            if !path.is_file() {
                return Err(CliError::bad_input(format!(
                    "not a file: {}",
                    path.display()
                )));
            }
            let art = otori_core::artwork::resolve(&path)
                .map_err(|e| CliError::bad_input(e.to_string()))?;
            match art {
                Some(art) => {
                    let dims = otori_core::artwork::probe_dimensions(&art.data);
                    // Quality floor: a low-res jacket on the Stage is worse
                    // than none. Unknown dimensions count as below-floor —
                    // the agent must deliver something verifiable.
                    let below_floor = match dims {
                        Some((w, h)) => w.min(h) < min_size,
                        None => true,
                    };
                    if let Some(out) = &out {
                        std::fs::write(out, &art.data).map_err(|e| {
                            CliError::bad_input(format!("cannot write {}: {e}", out.display()))
                        })?;
                    }
                    if json {
                        println!(
                            "{}",
                            serde_json::json!({
                                "source": art.source,
                                "mime": art.mime,
                                "bytes": art.data.len(),
                                "width": dims.map(|d| d.0),
                                "height": dims.map(|d| d.1),
                                "below_min_size": below_floor,
                                "min_size": min_size,
                                "written_to": out,
                            })
                        );
                    } else {
                        let size = dims
                            .map(|(w, h)| format!("{w}x{h}"))
                            .unwrap_or_else(|| "unknown size".to_string());
                        println!("{} ({}, {}, {} bytes)", art.source, art.mime, size, art.data.len());
                        if below_floor {
                            println!("WARNING: below the {min_size}px floor — replace with a larger jacket");
                        }
                    }
                    if below_floor {
                        return Ok(ExitCode::from(EXIT_PARTIAL));
                    }
                    Ok(ExitCode::SUCCESS)
                }
                None if json => {
                    println!("null");
                    Ok(ExitCode::SUCCESS)
                }
                None => {
                    println!("(no artwork: not embedded, no sidecar, no folder cover)");
                    Ok(ExitCode::SUCCESS)
                }
            }
        }
        Command::Backup { dest, json } => {
            let db_path = match &cli.db {
                Some(p) => p.clone(),
                None => otori_core::db::default_path().map_err(CliError::library)?,
            };
            let conn = otori_core::db::open(&db_path).map_err(CliError::library)?;
            let dest = match dest {
                Some(d) => d,
                None => {
                    let dir = db_path
                        .parent()
                        .ok_or_else(|| CliError::bad_input("db path has no parent directory"))?
                        .join("backups");
                    otori_core::backup::default_backup_path(&dir)
                        .map_err(CliError::library)?
                }
            };
            otori_core::backup::backup(&conn, &dest).map_err(CliError::library)?;
            let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
            if json {
                println!(
                    "{}",
                    serde_json::json!({ "backup": dest, "bytes": size })
                );
            } else {
                println!("backed up to {} ({size} bytes)", dest.display());
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Jacket { path, apply, min_size, allow_album_cover, json } => {
            if !path.is_file() {
                return Err(CliError::bad_input(format!(
                    "not a file: {}",
                    path.display()
                )));
            }
            // Refuse to fetch when art already exists — replacing is a
            // human decision (delete the old one first).
            if otori_core::artwork::resolve(&path)
                .map_err(|e| CliError::bad_input(e.to_string()))?
                .is_some()
            {
                return Err(CliError::bad_input(
                    "track already has artwork; remove it first to refetch",
                ));
            }
            let tags = otori_core::read_track_tags(&path)
                .map_err(|e| CliError::bad_input(e.to_string()))?;
            let title = tags
                .title
                .as_deref()
                .map(strip_category_markers)
                .ok_or_else(|| CliError::bad_input("track has no title tag to search by"))?;
            let search =
                otori_core::vocadb::search_song(&title).map_err(CliError::library)?;
            let matched =
                otori_core::vocadb::pick_match(&search, &title, tags.artist.as_deref())
                    .map_err(CliError::library)?;

            let Some(m) = matched else {
                if json {
                    println!("{}", serde_json::json!({ "matched": false, "title": title }));
                } else {
                    println!("no unambiguous VocaDB match for \"{title}\" — not guessing");
                }
                return Ok(ExitCode::from(EXIT_PARTIAL));
            };
            let Some(album_id) = m.album_id else {
                if json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "matched": true, "song_id": m.song_id,
                            "album_id": null,
                            "next": "rhythm-game wiki (maimai, then プロセカ), see AGENTS.md",
                        })
                    );
                } else {
                    println!(
                        "matched song {} ({}) but it has no album with cover art",
                        m.song_id, m.song_name
                    );
                    println!("next: rhythm-game wiki jacket (maimai, then プロセカ) — see AGENTS.md");
                }
                return Ok(ExitCode::from(EXIT_PARTIAL));
            };

            // Jacket priority (founding-user, 2026-07-07): self-titled
            // single auto-delivers; a studio/compilation cover is the
            // LAST resort — behind the rhythm-game wiki tier, which
            // lives outside this provider. Require explicit opt-in.
            if !m.album_is_self_titled && !allow_album_cover {
                if json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "matched": true, "song_id": m.song_id,
                            "album_id": album_id, "album_name": m.album_name,
                            "album_is_self_titled": false,
                            "applied": false,
                            "next": "try the rhythm-game wiki first (maimai, then プロセカ); \
                                     re-run with --allow-album-cover to accept this album cover",
                        })
                    );
                } else {
                    println!(
                        "no self-titled single; nearest album: {} (id {album_id})",
                        m.album_name.as_deref().unwrap_or("?")
                    );
                    println!(
                        "jacket priority: try the rhythm-game wiki first (maimai, then プロセカ);"
                    );
                    println!("re-run with --allow-album-cover to accept this album cover");
                }
                return Ok(ExitCode::from(EXIT_PARTIAL));
            };

            if !apply {
                if json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "matched": true, "song_id": m.song_id,
                            "song_name": m.song_name, "artist": m.artist_string,
                            "album_id": album_id, "album_name": m.album_name,
                            "cover_url": otori_core::vocadb::cover_url(album_id),
                            "applied": false,
                        })
                    );
                } else {
                    println!(
                        "match: {} — {} (album: {})",
                        m.song_name,
                        m.artist_string,
                        m.album_name.as_deref().unwrap_or("?")
                    );
                    println!("dry run — pass --apply to download the jacket");
                }
                return Ok(ExitCode::SUCCESS);
            }

            let data = otori_core::vocadb::download_cover(album_id).map_err(CliError::library)?;
            let dims = otori_core::artwork::probe_dimensions(&data);
            let below_floor = match dims {
                Some((w, h)) => w.min(h) < min_size,
                None => true,
            };
            if below_floor {
                let size = dims
                    .map(|(w, h)| format!("{w}x{h}"))
                    .unwrap_or_else(|| "unknown".to_string());
                return Err(CliError::bad_input(format!(
                    "cover is below the {min_size}px floor ({size}) — not delivering"
                )));
            }
            let ext = if data.starts_with(&[0x89, b'P']) { "png" } else { "jpg" };
            let sidecar = path.with_extension(ext);
            if sidecar.exists() {
                return Err(CliError::bad_input(format!(
                    "sidecar already exists: {}",
                    sidecar.display()
                )));
            }
            std::fs::write(&sidecar, &data)
                .map_err(|e| CliError::bad_input(format!("write {}: {e}", sidecar.display())))?;
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "matched": true, "applied": true,
                        "album_id": album_id, "album_name": m.album_name,
                        "sidecar": sidecar,
                        "width": dims.map(|d| d.0), "height": dims.map(|d| d.1),
                    })
                );
            } else {
                let (w, h) = dims.unwrap();
                println!("jacket saved: {} ({w}x{h})", sidecar.display());
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Set { path, title, artist, album, apply, agent, override_curated, json } => {
            use otori_core::write::{Actor, FieldChange, PlanOutcome};
            let mut changes = Vec::new();
            for (field, value) in [("title", title), ("artist", artist), ("album", album)] {
                if let Some(value) = value {
                    changes.push(FieldChange { field: field.into(), value });
                }
            }
            if changes.is_empty() {
                return Err(CliError::bad_input("nothing to set: pass --title/--artist/--album"));
            }
            let agent_id = agent.as_deref();
            let actor = match agent_id {
                Some(id) => Actor::Agent { id },
                None => Actor::Human { via: "cli" },
            };
            let mut conn = open_library(cli.db.clone())?;

            let plan =
                otori_core::write::plan_set(&mut conn, &path, &changes, actor, override_curated)
                    .map_err(|e| CliError::bad_input(e.to_string()))?;
            let tx_id = if apply && plan.outcome() == PlanOutcome::Changes {
                // Safety net before any destructive write: the trust layer
                // (provenance/journal) lives only in this db.
                auto_backup(&cli.db)?;
                otori_core::write::apply_set(&mut conn, &path, &changes, actor, override_curated)
                    .map_err(CliError::library)?
            } else {
                None
            };

            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "applied": tx_id.is_some(),
                        "tx_id": tx_id,
                        "plan": plan,
                    })
                );
            } else {
                for c in &plan.changes {
                    println!(
                        "  {}: {} -> {}",
                        c.field,
                        c.old.as_deref().unwrap_or("(empty)"),
                        c.new
                    );
                }
                for s in &plan.skipped_curated {
                    println!(
                        "  SKIPPED (curated) {}: {} — proposed: {}",
                        s.field, s.current, s.proposed
                    );
                }
                match (tx_id, plan.outcome()) {
                    (Some(id), _) => println!("applied as transaction {id} (otori undo {id})"),
                    (None, PlanOutcome::Nothing) => println!("nothing to change"),
                    (None, _) if !apply => println!("dry run — pass --apply to write"),
                    (None, _) => {}
                }
            }
            // Exit 2: the caller asked for changes that bounced off curated fields.
            if plan.outcome() == PlanOutcome::CuratedSkipsOnly
                || (!plan.skipped_curated.is_empty() && apply)
            {
                return Ok(ExitCode::from(EXIT_PARTIAL));
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Curate { path, all, json } => {
            if path.is_none() && !all {
                return Err(CliError::bad_input(
                    "pass a file path, or --all to curate the whole library",
                ));
            }
            let mut conn = open_library(cli.db)?;
            let count = otori_core::write::curate(&mut conn, path.as_deref())
                .map_err(|e| CliError::bad_input(e.to_string()))?;
            if json {
                println!("{}", serde_json::json!({ "curated": count }));
            } else {
                println!("protected {count} field values");
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Undo { tx_id } => {
            let mut conn = open_library(cli.db.clone())?;
            // Undo rewrites files and the trust layer — same safety net.
            auto_backup(&cli.db)?;
            otori_core::write::undo(&mut conn, tx_id)
                .map_err(|e| CliError::bad_input(e.to_string()))?;
            println!("transaction {tx_id} rolled back");
            Ok(ExitCode::SUCCESS)
        }
        Command::Journal { json } => {
            let conn = open_library(cli.db)?;
            let mut stmt = conn
                .prepare(
                    "SELECT x.id, x.actor, x.started_at, x.undone, count(c.tx_id)
                     FROM transactions x LEFT JOIN tx_changes c ON c.tx_id = x.id
                     GROUP BY x.id ORDER BY x.id DESC",
                )
                .map_err(CliError::library)?;
            let rows: Vec<(i64, String, String, i64, i64)> = stmt
                .query_map([], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })
                .map_err(CliError::library)?
                .collect::<Result<_, _>>()
                .map_err(CliError::library)?;
            if json {
                let out: Vec<_> = rows
                    .iter()
                    .map(|(id, actor, at, undone, fields)| {
                        serde_json::json!({
                            "tx_id": id, "actor": actor, "at": at,
                            "undone": *undone == 1, "fields": fields,
                        })
                    })
                    .collect();
                println!("{}", serde_json::to_string_pretty(&out).unwrap());
            } else {
                for (id, actor, at, undone, fields) in &rows {
                    println!(
                        "#{id}  {at}  {actor}  {fields} field(s){}",
                        if *undone == 1 { "  [undone]" } else { "" }
                    );
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Status { json } => {
            let conn = open_library(cli.db)?;
            let s = otori_core::status::status(&conn).map_err(CliError::library)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&s).unwrap());
            } else {
                println!("tracks: {}", s.tracks);
                for (format, count) in &s.formats {
                    println!("  {format}: {count}");
                }
                println!("tag completeness (missing):");
                for (field, count) in &s.missing {
                    println!("  {field}: {count} missing");
                }
                println!(
                    "curated: {}/{} values protected",
                    s.curated_values, s.tag_values
                );
                for (source, count) in &s.sources {
                    println!("  {source}: {count}");
                }
                println!(
                    "journal: {} transaction(s), {} undone",
                    s.transactions, s.undone_transactions
                );
                println!("schema: v{}", s.schema_version);
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::SchemaVersion => {
            println!("{CLI_SCHEMA_VERSION}");
            Ok(ExitCode::SUCCESS)
        }
    }
}

fn open_library(db: Option<PathBuf>) -> Result<otori_core::Connection, CliError> {
    let path = match db {
        Some(p) => p,
        None => otori_core::db::default_path().map_err(CliError::library)?,
    };
    otori_core::db::open(&path).map_err(CliError::library)
}

/// Strip the owner's leading category markers from a title before
/// searching external databases: "[Vocaloid] アマツキツネ" → "アマツキツネ".
/// The scheme is personal curation, not part of the song's name.
fn strip_category_markers(title: &str) -> String {
    let mut rest = title.trim();
    while rest.starts_with('[') {
        match rest.split_once(']') {
            Some((_, tail)) => rest = tail.trim_start(),
            None => break,
        }
    }
    rest.to_string()
}

/// Pre-destructive-write safety net: timestamped snapshot into
/// `<db-dir>/backups/`, keeping the newest few. Failure aborts the
/// write — no backup, no mutation.
fn auto_backup(db: &Option<PathBuf>) -> Result<(), CliError> {
    let db_path = match db {
        Some(p) => p.clone(),
        None => otori_core::db::default_path().map_err(CliError::library)?,
    };
    let conn = otori_core::db::open(&db_path).map_err(CliError::library)?;
    let dir = db_path
        .parent()
        .ok_or_else(|| CliError::bad_input("db path has no parent directory"))?
        .join("backups");
    otori_core::backup::auto_backup(&conn, &dir).map_err(CliError::library)?;
    Ok(())
}
