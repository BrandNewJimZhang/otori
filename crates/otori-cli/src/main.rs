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
    }
}

fn open_library(db: Option<PathBuf>) -> Result<otori_core::Connection, CliError> {
    let path = match db {
        Some(p) => p,
        None => otori_core::db::default_path().map_err(CliError::library)?,
    };
    otori_core::db::open(&path).map_err(CliError::library)
}
