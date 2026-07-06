//! Ōtori core — the engine room shared by the CLI and the Tauri app.
//!
//! Everything user-visible lives in the frontend (TypeScript). This crate
//! owns the heavy lifting: library scanning/indexing, tag read/write,
//! and lyrics parsing. GUI and CLI are two thin consumers of this crate;
//! neither may bypass it to touch files or the index directly (SSOT).

use serde::Serialize;

pub mod db;
pub mod scan;

/// Track metadata as exposed to both CLI (`--json`) and GUI (IPC).
/// Field set intentionally minimal; grows only when a consumer needs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TrackTags {
    pub path: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}
