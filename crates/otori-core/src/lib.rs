//! Ōtori core — the engine room shared by the CLI and the Tauri app.
//!
//! Everything user-visible lives in the frontend (TypeScript). This crate
//! owns the heavy lifting: library scanning/indexing, tag read/write,
//! and lyrics parsing. GUI and CLI are two thin consumers of this crate;
//! neither may bypass it to touch files or the index directly (SSOT).

use serde::Serialize;

pub mod db;
pub mod query;
pub mod scan;
pub mod write;

// Consumers hold connections we hand out; they never open their own.
pub use rusqlite::Connection;

/// Track metadata as exposed to both CLI (`--json`) and GUI (IPC).
/// Field set intentionally minimal; grows only when a consumer needs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TrackTags {
    pub path: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

/// Read tags straight from an audio file (bypasses the index — for
/// `otori tags`, the one command that inspects files directly).
pub fn read_track_tags(path: &std::path::Path) -> Result<TrackTags, lofty::error::LoftyError> {
    use lofty::file::TaggedFileExt;
    use lofty::prelude::*;
    let tagged = lofty::read_from_path(path)?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    Ok(TrackTags {
        path: path.to_string_lossy().into_owned(),
        title: tag.and_then(|t| t.title().map(|v| v.into_owned())),
        artist: tag.and_then(|t| t.artist().map(|v| v.into_owned())),
        album: tag.and_then(|t| t.album().map(|v| v.into_owned())),
    })
}
