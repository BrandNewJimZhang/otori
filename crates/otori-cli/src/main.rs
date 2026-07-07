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
    /// Fetch lyrics from LRCLIB and save them as a sidecar .lrc
    FetchLyrics {
        path: PathBuf,
        /// Actually write the sidecar; default reports the match only
        #[arg(long)]
        apply: bool,
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
    /// Record a provider-sourced BPM hint into the index (external
    /// values anchor the detector's verification; they are never the
    /// final bpm themselves)
    ImportBpm {
        path: PathBuf,
        /// Tempo, or the range floor for variable-tempo tracks
        #[arg(long)]
        bpm: f64,
        /// Range ceiling for variable-tempo (soflan) tracks
        #[arg(long)]
        bpm_max: Option<f64>,
        /// Provider name, lowercase alphanumeric (lands in bpm_source
        /// as 'provider:<name>')
        #[arg(long)]
        provider: String,
        #[arg(long)]
        json: bool,
    },
    /// Fetch an editor-curated BPM from VocaDB into the index
    FetchBpm {
        path: PathBuf,
        /// Actually write the index; default reports the match only
        #[arg(long)]
        apply: bool,
        #[arg(long)]
        json: bool,
    },
    /// List tracks whose tempo would benefit from an external hint
    /// (no hint yet; blank or low-confidence detection)
    HintCandidates {
        /// Confidence below which a detection counts as shaky
        #[arg(long, default_value_t = 0.6)]
        min_confidence: f64,
        /// Cap the list (0 = everything)
        #[arg(long, default_value_t = 0)]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
    /// Embed the resolved sidecar/folder artwork into the audio file
    EmbedArtwork {
        path: PathBuf,
        /// Actually write (file + journal); default reports what would embed
        #[arg(long)]
        apply: bool,
        /// Identify as an agent (journaled actor)
        #[arg(long)]
        agent: Option<String>,
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
    /// Reopen BPM/mix analysis so the next sweep re-verdicts (values
    /// stay visible until replaced). Dry-run by default.
    Reanalyze {
        /// Reopen only shaky detections below this confidence (plus
        /// beatless verdicts); omit for the whole library
        #[arg(long, conflicts_with = "track")]
        low_confidence: Option<f64>,
        /// Reopen exactly these track ids
        #[arg(long)]
        track: Vec<i64>,
        /// Actually reopen; default reports the affected count only
        #[arg(long)]
        apply: bool,
        #[arg(long)]
        json: bool,
    },
    /// Run beat analysis headless (same engine as the GUI sweep)
    Analyze {
        /// Analyze everything currently pending
        #[arg(long, conflicts_with = "track")]
        pending: bool,
        /// Analyze exactly these track ids (reopens them first)
        #[arg(long)]
        track: Vec<i64>,
        /// Directory holding the ONNX models (default: $OTORI_MODELS_DIR)
        #[arg(long)]
        models_dir: Option<PathBuf>,
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
        Command::FetchLyrics { path, apply, json } => {
            if !path.is_file() {
                return Err(CliError::bad_input(format!(
                    "not a file: {}",
                    path.display()
                )));
            }
            // Refuse when lyrics already exist — replacing is a human
            // decision (delete the sidecar / clear the tag first).
            if otori_core::lyrics::resolve(&path)
                .map_err(|e| CliError::bad_input(e.to_string()))?
                .is_some()
            {
                return Err(CliError::bad_input(
                    "track already has lyrics; remove them first to refetch",
                ));
            }
            let tags = otori_core::read_track_tags(&path)
                .map_err(|e| CliError::bad_input(e.to_string()))?;
            let title = tags
                .title
                .as_deref()
                .map(strip_category_markers)
                .ok_or_else(|| CliError::bad_input("track has no title tag to search by"))?;
            let artist = tags
                .artist
                .as_deref()
                .ok_or_else(|| CliError::bad_input("track has no artist tag to search by"))?;
            let duration = otori_core::read_duration_secs(&path).ok();

            let response =
                otori_core::lrclib::get_lyrics(&title, artist, tags.album.as_deref(), duration)
                    .map_err(CliError::library)?;
            let mut fetched = match response {
                Some(body) => {
                    otori_core::lrclib::pick_lyrics(&body).map_err(CliError::library)?
                }
                None => None,
            };
            // Signature miss → title search. Doujin artist tags rarely
            // match LRCLIB's; duration (a file property) disambiguates.
            if fetched.is_none() {
                let search =
                    otori_core::lrclib::search_lyrics(&title).map_err(CliError::library)?;
                fetched = otori_core::lrclib::pick_search_hit(&search, &title, duration)
                    .map_err(CliError::library)?;
            }
            let Some(fetched) = fetched else {
                if json {
                    println!("{}", serde_json::json!({ "matched": false, "title": title }));
                } else {
                    println!("no LRCLIB record for \"{title}\" — {artist} (or instrumental)");
                }
                return Ok(ExitCode::from(EXIT_PARTIAL));
            };

            if !apply {
                if json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "matched": true, "synced": fetched.synced,
                            "lines": fetched.text.lines().count(),
                            "applied": false,
                        })
                    );
                } else {
                    let kind = if fetched.synced { "synced" } else { "plain (static)" };
                    println!(
                        "match: {kind} lyrics, {} lines",
                        fetched.text.lines().count()
                    );
                    println!("dry run — pass --apply to write the sidecar .lrc");
                }
                return Ok(ExitCode::SUCCESS);
            }

            let sidecar =
                otori_core::lyrics::write_sidecar(&path, &fetched.text, "agent:lrclib")
                    .map_err(|e| CliError::bad_input(format!("write sidecar: {e}")))?;
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "matched": true, "applied": true,
                        "synced": fetched.synced, "sidecar": sidecar,
                    })
                );
            } else {
                println!("lyrics saved: {}", sidecar.display());
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::ImportBpm { path, bpm, bpm_max, provider, json } => {
            let conn = open_library(cli.db.clone())?;
            let path_str = path.to_string_lossy();
            let (track_id, source): (i64, Option<String>) = conn
                .query_row(
                    "SELECT id, bpm_source FROM tracks WHERE path = ?1",
                    [path_str.as_ref()],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|_| CliError::bad_input("track is not in the library index (scan first)"))?;
            let _ = source; // hints replace hints; no ladder gate needed
            otori_core::analysis::set_bpm_hint(
                &conn, track_id, bpm, bpm_max, &format!("provider:{provider}"),
            )
            .map_err(|e| CliError::bad_input(e.to_string()))?;
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "applied": true, "hint_bpm": bpm, "hint_bpm_max": bpm_max,
                        "hint_source": format!("provider:{provider}"),
                        "note": "hint recorded; detector will verify on next sweep",
                    })
                );
            } else {
                println!(
                    "BPM hint saved: {bpm}{} (provider:{provider}); detector verifies on next sweep",
                    bpm_max.map(|m| format!("\u{2013}{m}")).unwrap_or_default()
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::HintCandidates { min_confidence, limit, json } => {
            let conn = open_library(cli.db.clone())?;
            let mut candidates =
                otori_core::analysis::list_hint_candidates(&conn, min_confidence)
                    .map_err(|e| CliError::library(e.to_string()))?;
            if limit > 0 {
                candidates.truncate(limit);
            }
            if json {
                println!("{}", serde_json::to_string(&candidates).map_err(|e| CliError::library(e.to_string()))?);
            } else {
                println!("{} tracks would benefit from a BPM hint:", candidates.len());
                for c in &candidates {
                    let state = match (c.bpm, c.bpm_confidence) {
                        (Some(bpm), Some(conf)) => format!("{bpm:.1} @ {:.0}%", conf * 100.0),
                        _ => "blank".to_string(),
                    };
                    println!(
                        "  [{state}] {} — {}",
                        c.title.as_deref().unwrap_or("(untitled)"),
                        c.artist.as_deref().unwrap_or("?"),
                    );
                }
                println!("fetch-bpm each (VocaDB), or import-bpm from wiki/local tooling");
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::FetchBpm { path, apply, json } => {
            if !path.is_file() {
                return Err(CliError::bad_input(format!(
                    "not a file: {}",
                    path.display()
                )));
            }
            let conn = open_library(cli.db.clone())?;
            let path_str = path.to_string_lossy();
            let track_id: i64 = conn
                .query_row(
                    "SELECT id FROM tracks WHERE path = ?1",
                    [path_str.as_ref()],
                    |r| r.get(0),
                )
                .map_err(|_| CliError::bad_input("track is not in the library index (scan first)"))?;
            let tags = otori_core::read_track_tags(&path)
                .map_err(|e| CliError::bad_input(e.to_string()))?;
            let title = tags
                .title
                .as_deref()
                .map(strip_category_markers)
                .ok_or_else(|| CliError::bad_input("track has no title tag to search by"))?;
            let search =
                otori_core::vocadb::search_song(&title).map_err(CliError::library)?;
            let hit = otori_core::vocadb::pick_match(&search, &title, tags.artist.as_deref())
                .map_err(CliError::library)?;
            let Some(hit) = hit else {
                if json {
                    println!("{}", serde_json::json!({ "matched": false, "title": title }));
                } else {
                    println!("no unambiguous VocaDB match for \"{title}\"");
                }
                return Ok(ExitCode::from(EXIT_PARTIAL));
            };
            let Some(bpm) = hit.bpm else {
                if json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "matched": true, "song_id": hit.song_id, "bpm": null,
                        })
                    );
                } else {
                    println!(
                        "matched \"{}\" (#{}) but the entry has no BPM recorded",
                        hit.song_name, hit.song_id
                    );
                }
                return Ok(ExitCode::from(EXIT_PARTIAL));
            };

            if !apply {
                if json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "matched": true, "song_id": hit.song_id,
                            "bpm": bpm, "bpm_max": hit.bpm_max, "applied": false,
                        })
                    );
                } else {
                    match hit.bpm_max {
                        Some(max) => println!("match: {bpm}\u{2013}{max} BPM (variable) — {}", hit.song_name),
                        None => println!("match: {bpm} BPM — {}", hit.song_name),
                    }
                    println!("dry run — pass --apply to write the index");
                }
                return Ok(ExitCode::SUCCESS);
            }

            otori_core::analysis::set_bpm_hint(&conn, track_id, bpm, hit.bpm_max, "provider:vocadb")
                .map_err(|e| CliError::library(e.to_string()))?;
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "matched": true, "applied": true,
                        "hint_bpm": bpm, "hint_bpm_max": hit.bpm_max,
                        "hint_source": "provider:vocadb",
                        "note": "hint recorded; detector will verify on next sweep",
                    })
                );
            } else {
                println!("BPM hint saved: {bpm}{} (provider:vocadb); detector verifies on next sweep",
                    hit.bpm_max.map(|m| format!("\u{2013}{m}")).unwrap_or_default());
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
        Command::EmbedArtwork { path, apply, agent, json } => {
            use otori_core::write::Actor;
            if !path.is_file() {
                return Err(CliError::bad_input(format!(
                    "not a file: {}",
                    path.display()
                )));
            }
            let art = otori_core::artwork::resolve(&path)
                .map_err(|e| CliError::bad_input(e.to_string()))?;
            let plan = match &art {
                Some(a) if a.source == "embedded" => {
                    return Err(CliError::bad_input(
                        "a picture is already embedded; nothing to do",
                    ))
                }
                Some(a) => a,
                None => {
                    return Err(CliError::bad_input(
                        "no artwork to embed (no sidecar image, no folder cover)",
                    ))
                }
            };
            let dims = otori_core::artwork::probe_dimensions(&plan.data);
            if !apply {
                if json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "would_embed": plan.source, "mime": plan.mime,
                            "bytes": plan.data.len(),
                            "width": dims.map(|d| d.0), "height": dims.map(|d| d.1),
                            "applied": false,
                        })
                    );
                } else {
                    println!(
                        "would embed {} image ({}, {} bytes) — pass --apply to write",
                        plan.source,
                        plan.mime,
                        plan.data.len()
                    );
                }
                return Ok(ExitCode::SUCCESS);
            }
            let actor = match agent.as_deref() {
                Some(id) => Actor::Agent { id },
                None => Actor::Human { via: "cli" },
            };
            let mut conn = open_library(cli.db.clone())?;
            // Pre-write db backup happens inside the core (write.rs).
            let tx_id = otori_core::write::embed_artwork(&mut conn, &path, actor)
                .map_err(|e| CliError::bad_input(e.to_string()))?;
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "applied": true, "tx_id": tx_id,
                        "embedded": plan.source,
                        "width": dims.map(|d| d.0), "height": dims.map(|d| d.1),
                    })
                );
            } else {
                println!("embedded as transaction {tx_id} (otori undo {tx_id})");
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
                // Pre-write db backup happens inside the core (write.rs).
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
            // Pre-write db backup happens inside the core (write.rs).
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
        Command::Reanalyze { low_confidence, track, apply, json } => {
            let conn = open_library(cli.db)?;
            let scope = if !track.is_empty() {
                otori_core::analysis::ReopenScope::Tracks(&track)
            } else if let Some(t) = low_confidence {
                otori_core::analysis::ReopenScope::LowConfidence(t)
            } else {
                otori_core::analysis::ReopenScope::All
            };
            let affected = if apply {
                otori_core::analysis::reopen_analysis(&conn, scope)
                    .map_err(|e| CliError::bad_input(e.to_string()))? as i64
            } else {
                // Dry-run: count what the scope would reopen.
                match scope {
                    otori_core::analysis::ReopenScope::All => conn
                        .query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get::<_, i64>(0))
                        .map_err(CliError::library)?,
                    otori_core::analysis::ReopenScope::LowConfidence(t) => conn
                        .query_row(
                            "SELECT COUNT(*) FROM tracks WHERE bpm_analyzed_at IS NOT NULL
                             AND (bpm IS NULL OR bpm_confidence < ?1)",
                            [t],
                            |r| r.get::<_, i64>(0),
                        )
                        .map_err(CliError::library)?,
                    otori_core::analysis::ReopenScope::Tracks(ids) => ids.len() as i64,
                }
            };
            if json {
                println!(
                    "{}",
                    serde_json::json!({ "applied": apply, "reopened": affected })
                );
            } else if apply {
                println!("reopened analysis for {affected} track(s); sweep re-verdicts on next launch (or run `otori analyze --pending`)");
            } else {
                println!("would reopen {affected} track(s); rerun with --apply");
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Analyze { pending, track, models_dir, json } => {
            let conn = open_library(cli.db)?;
            if !pending && track.is_empty() {
                return Err(CliError::bad_input("pass --pending or --track <id>"));
            }
            let models_dir = models_dir
                .or_else(|| std::env::var_os("OTORI_MODELS_DIR").map(PathBuf::from))
                .ok_or_else(|| {
                    CliError::bad_input("pass --models-dir or set OTORI_MODELS_DIR")
                })?;
            let models = otori_analysis::models::resolve(&models_dir)
                .map_err(|e| CliError::bad_input(e.to_string()))?;
            let mut engine = otori_analysis::AnalysisEngine::new(&models)
                .map_err(|e| CliError::library(e.to_string()))?;

            if !track.is_empty() {
                otori_core::analysis::reopen_analysis(
                    &conn,
                    otori_core::analysis::ReopenScope::Tracks(&track),
                )
                .map_err(|e| CliError::bad_input(e.to_string()))?;
            }
            let worklist = otori_core::analysis::list_analysis_pending(&conn)
                .map_err(CliError::library)?;
            let mut results = Vec::new();
            let mut failures = 0usize;
            for item in &worklist {
                match analyze_one(&conn, &mut engine, item) {
                    Ok(v) => results.push(v),
                    Err(e) => {
                        failures += 1;
                        eprintln!(
                            "{}",
                            serde_json::json!({ "error": e, "kind": "analysis", "path": item.path })
                        );
                    }
                }
            }
            if json {
                println!("{}", serde_json::json!({ "analyzed": results, "failures": failures }));
            } else {
                for r in &results {
                    println!("{r}");
                }
                println!("{} analyzed, {failures} failed", results.len());
            }
            Ok(if failures > 0 { ExitCode::from(EXIT_PARTIAL) } else { ExitCode::SUCCESS })
        }
        Command::SchemaVersion => {
            println!("{CLI_SCHEMA_VERSION}");
            Ok(ExitCode::SUCCESS)
        }
    }
}

/// Analyze one pending track and persist verdict + anchors through the
/// same core writers the GUI uses. Returns a human line for stdout.
fn analyze_one(
    conn: &otori_core::Connection,
    engine: &mut otori_analysis::AnalysisEngine,
    item: &otori_core::analysis::PendingTrack,
) -> Result<String, String> {
    use otori_core::analysis::{set_bpm, set_bpm_verified, set_mix_anchors, DetectedBpm, MixAnchor};

    let result = engine
        .analyze(std::path::Path::new(&item.path), item.hint_bpm)
        .map_err(|e| e.to_string())?;
    let line = if item.needs_bpm {
        match result.verdict {
            Some(v) => {
                let detected = DetectedBpm {
                    bpm: (v.bpm * 10.0).round() / 10.0,
                    bpm_max: v.bpm_max.map(|m| (m * 10.0).round() / 10.0),
                    confidence: (v.confidence * 100.0).round() / 100.0,
                };
                if v.hint_applied {
                    set_bpm_verified(conn, item.id, detected).map_err(|e| e.to_string())?;
                } else {
                    set_bpm(conn, item.id, Some(detected)).map_err(|e| e.to_string())?;
                }
                match v.bpm_max {
                    Some(max) => format!("{}: {:.1}\u{2013}{max:.1} BPM", item.path, v.bpm),
                    None => format!("{}: {:.1} BPM", item.path, v.bpm),
                }
            }
            None => {
                set_bpm(conn, item.id, None).map_err(|e| e.to_string())?;
                format!("{}: beatless", item.path)
            }
        }
    } else {
        format!("{}: anchors only", item.path)
    };
    let to_anchor = |a: otori_analysis::MixAnchor| MixAnchor { bpm: a.bpm, beat_sec: a.beat_sec };
    set_mix_anchors(conn, item.id, result.head.map(to_anchor), result.tail.map(to_anchor))
        .map_err(|e| e.to_string())?;
    Ok(line)
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


