//! `otori` — agent-first CLI for the Ōtori music library.
//!
//! Contract for every subcommand (see ADR-0001):
//! - `--json` emits machine-readable output with a stable schema
//! - destructive operations support `--dry-run` and default to it
//! - errors go to stderr as structured JSON; exit codes are semantic

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "otori", version, about = "Ōtori music library CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print tags of an audio file as JSON
    Tags { path: String },
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Command::Tags { path } => {
            // Placeholder until lofty-backed reading lands in otori-core.
            let tags = otori_core::TrackTags {
                path,
                title: None,
                artist: None,
                album: None,
            };
            println!("{}", serde_json::to_string_pretty(&tags).unwrap());
        }
    }
}
