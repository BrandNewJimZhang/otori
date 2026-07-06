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
}

const EXIT_PARTIAL: u8 = 2;
const EXIT_BAD_INPUT: u8 = 3;
const EXIT_LIBRARY: u8 = 4;

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
            let mut conn = open_library(cli.db)?;

            let plan =
                otori_core::write::plan_set(&mut conn, &path, &changes, actor, override_curated)
                    .map_err(|e| CliError::bad_input(e.to_string()))?;
            let tx_id = if apply && plan.outcome() == PlanOutcome::Changes {
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
            let mut conn = open_library(cli.db)?;
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
    }
}

fn open_library(db: Option<PathBuf>) -> Result<otori_core::Connection, CliError> {
    let path = match db {
        Some(p) => p,
        None => otori_core::db::default_path().map_err(CliError::library)?,
    };
    otori_core::db::open(&path).map_err(CliError::library)
}
