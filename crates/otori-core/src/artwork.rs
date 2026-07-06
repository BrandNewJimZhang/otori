//! Jacket resolution: embedded picture → per-track sidecar image →
//! folder cover → none.
//!
//! Sidecar images are the agent delivery path for fetched jackets
//! (PRODUCT.md Metadata providers): dropping `<stem>.jpg` next to the
//! audio file adds art without writing a byte into the audio file —
//! no tag write, no provenance ceremony, undo = delete the image.
//! Embedded pictures still win so files that ship with art keep it.

use std::path::Path;

use lofty::file::TaggedFileExt;
use serde::Serialize;

/// Sidecar/folder image extensions in priority order.
const SIDECAR_EXTENSIONS: &[(&str, &str)] = &[
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("png", "image/png"),
    ("webp", "image/webp"),
];

/// Folder-level cover filenames (stem only), in priority order.
const FOLDER_STEMS: &[&str] = &["cover", "folder", "front"];

#[derive(Debug, Serialize)]
pub struct Artwork {
    /// "embedded" | "sidecar" | "folder"
    pub source: &'static str,
    pub mime: String,
    #[serde(skip)] // CLI/IPC decide how to encode bytes (file path vs data URL)
    pub data: Vec<u8>,
}

/// Find cover art for an audio file. `Ok(None)` when there is none —
/// the Stage placeholder takes over.
pub fn resolve(audio: &Path) -> Result<Option<Artwork>, lofty::error::LoftyError> {
    let tagged = lofty::read_from_path(audio)?;
    if let Some(picture) = tagged
        .primary_tag()
        .or_else(|| tagged.first_tag())
        .and_then(|t| t.pictures().first())
    {
        return Ok(Some(Artwork {
            source: "embedded",
            mime: picture
                .mime_type()
                .map(|m| m.to_string())
                .unwrap_or_else(|| "image/jpeg".to_string()),
            data: picture.data().to_vec(),
        }));
    }

    // Per-track sidecar: same stem, image extension.
    for (ext, mime) in SIDECAR_EXTENSIONS {
        let candidate = audio.with_extension(ext);
        if let Ok(data) = std::fs::read(&candidate) {
            return Ok(Some(Artwork { source: "sidecar", mime: (*mime).to_string(), data }));
        }
    }

    // Folder cover: shared by every track in the directory.
    if let Some(dir) = audio.parent() {
        for stem in FOLDER_STEMS {
            for (ext, mime) in SIDECAR_EXTENSIONS {
                let candidate = dir.join(format!("{stem}.{ext}"));
                if let Ok(data) = std::fs::read(&candidate) {
                    return Ok(Some(Artwork {
                        source: "folder",
                        mime: (*mime).to_string(),
                        data,
                    }));
                }
            }
        }
    }

    Ok(None)
}
