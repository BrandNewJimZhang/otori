//! Jacket resolution chain (the real point of metadata providers for
//! this library): embedded picture → per-track sidecar image → folder
//! cover → none. Sidecars are how agents deliver fetched jackets
//! without touching the audio file (L2: no tag write, no provenance
//! ceremony, trivially undoable by deleting the image).

use std::fs;
use std::path::Path;

use otori_core::artwork;

fn write_mp3(path: &Path) {
    let mut frame = vec![0xFF, 0xFB, 0x90, 0x00];
    frame.resize(417, 0);
    let mut bytes = Vec::new();
    for _ in 0..4 {
        bytes.extend_from_slice(&frame);
    }
    fs::write(path, bytes).unwrap();
}

/// Tiny valid 1x1 PNG.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
    0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
    0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x62, 0x00,
    0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

fn embed_picture(path: &Path) {
    use lofty::picture::{MimeType, Picture, PictureType};
    use lofty::prelude::*;
    use lofty::tag::{Tag, TagType};
    let mut tag = Tag::new(TagType::Id3v2);
    let picture = Picture::unchecked(PNG.to_vec())
        .pic_type(PictureType::CoverFront)
        .mime_type(MimeType::Png)
        .build();
    tag.push_picture(picture);
    tag.save_to_path(path, lofty::config::WriteOptions::default()).unwrap();
}

#[test]
fn embedded_picture_wins() {
    let dir = tempfile::tempdir().unwrap();
    let audio = dir.path().join("song.mp3");
    write_mp3(&audio);
    embed_picture(&audio);
    fs::write(dir.path().join("song.png"), PNG).unwrap();

    let art = artwork::resolve(&audio).unwrap().expect("must find embedded");
    assert_eq!(art.source, "embedded");
    assert_eq!(art.mime, "image/png");
    assert_eq!(art.data, PNG);
}

#[test]
fn sidecar_image_is_found_by_stem() {
    let dir = tempfile::tempdir().unwrap();
    let audio = dir.path().join("song.mp3");
    write_mp3(&audio);
    fs::write(dir.path().join("song.png"), PNG).unwrap();

    let art = artwork::resolve(&audio).unwrap().expect("must find sidecar");
    assert_eq!(art.source, "sidecar");
    assert_eq!(art.mime, "image/png");
}

#[test]
fn sidecar_prefers_jpg_over_png_when_both_exist() {
    // Priority is documented: jpg, jpeg, png, webp. First hit wins.
    let dir = tempfile::tempdir().unwrap();
    let audio = dir.path().join("song.mp3");
    write_mp3(&audio);
    fs::write(dir.path().join("song.jpg"), b"\xFF\xD8\xFF\xE0fakejpg").unwrap();
    fs::write(dir.path().join("song.png"), PNG).unwrap();

    let art = artwork::resolve(&audio).unwrap().unwrap();
    assert_eq!(art.mime, "image/jpeg");
}

#[test]
fn folder_cover_is_the_last_resort() {
    let dir = tempfile::tempdir().unwrap();
    let audio = dir.path().join("song.mp3");
    write_mp3(&audio);
    fs::write(dir.path().join("cover.png"), PNG).unwrap();

    let art = artwork::resolve(&audio).unwrap().expect("must find folder cover");
    assert_eq!(art.source, "folder");
}

#[test]
fn no_artwork_is_none_not_error() {
    let dir = tempfile::tempdir().unwrap();
    let audio = dir.path().join("song.mp3");
    write_mp3(&audio);
    assert!(artwork::resolve(&audio).unwrap().is_none());
}
