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

/// Read pixel dimensions from image header bytes (PNG IHDR, JPEG SOFn,
/// WebP VP8/VP8L/VP8X). `None` for unrecognized or truncated data —
/// callers treat that as "cannot verify", not as an error.
/// Header-only parsing: no decoder dependency for a size check.
pub fn probe_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    // PNG: 8-byte signature, IHDR fixed at offset 16 (width) / 20 (height).
    if data.starts_with(&[0x89, b'P', b'N', b'G']) && data.len() >= 24 {
        let width = u32::from_be_bytes(data[16..20].try_into().ok()?);
        let height = u32::from_be_bytes(data[20..24].try_into().ok()?);
        return Some((width, height));
    }
    // JPEG: walk markers to the first SOFn (C0-CF minus C4/C8/CC).
    if data.starts_with(&[0xFF, 0xD8]) {
        let mut i = 2;
        while i + 9 <= data.len() {
            if data[i] != 0xFF {
                return None; // marker desync
            }
            let marker = data[i + 1];
            if matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
                let height = u32::from(u16::from_be_bytes([data[i + 5], data[i + 6]]));
                let width = u32::from(u16::from_be_bytes([data[i + 7], data[i + 8]]));
                return Some((width, height));
            }
            if marker == 0xD9 {
                return None; // EOI before any SOF
            }
            let len = usize::from(u16::from_be_bytes([data[i + 2], data[i + 3]]));
            i += 2 + len;
        }
        return None;
    }
    // WebP: RIFF container, then VP8X (extended) / VP8L (lossless) / VP8 (lossy).
    if data.len() >= 30 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        match &data[12..16] {
            b"VP8X" => {
                let w = 1 + u32::from_le_bytes([data[24], data[25], data[26], 0]);
                let h = 1 + u32::from_le_bytes([data[27], data[28], data[29], 0]);
                return Some((w, h));
            }
            b"VP8L" if data.len() >= 25 => {
                let bits = u32::from_le_bytes(data[21..25].try_into().ok()?);
                let w = (bits & 0x3FFF) + 1;
                let h = ((bits >> 14) & 0x3FFF) + 1;
                return Some((w, h));
            }
            b"VP8 " if data.len() >= 30 => {
                let w = u32::from(u16::from_le_bytes([data[26], data[27]]) & 0x3FFF);
                let h = u32::from(u16::from_le_bytes([data[28], data[29]]) & 0x3FFF);
                return Some((w, h));
            }
            _ => return None,
        }
    }
    None
}
