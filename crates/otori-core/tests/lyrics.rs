//! Lyrics degradation ladder (PRODUCT.md): word-level → line-level →
//! static → none. Every rung is a complete experience; these tests pin
//! the parser and the source-resolution order (embedded → sidecar).

use std::fs;

use otori_core::lyrics::{self, LyricsKind};
use otori_core::{db, query};

// ---- LRC parsing ----

#[test]
fn parses_standard_lrc_lines_sorted() {
    let lrc = "\
[ti:Test Song]
[ar:Test Artist]

[00:12.00]First line
[00:07.50]Comes first despite file order
[01:03.20]Last line";
    let doc = lyrics::parse_lrc(lrc);
    assert_eq!(doc.kind, LyricsKind::LineSynced);
    assert_eq!(doc.lines.len(), 3);
    assert_eq!(doc.lines[0].time_ms, 7_500);
    assert_eq!(doc.lines[0].text, "Comes first despite file order");
    assert_eq!(doc.lines[1].time_ms, 12_000);
    assert_eq!(doc.lines[2].time_ms, 63_200);
}

#[test]
fn multiple_timestamps_share_one_text() {
    // Chorus lines commonly carry several timestamps.
    let doc = lyrics::parse_lrc("[00:10.00][00:50.00]Chorus line");
    assert_eq!(doc.lines.len(), 2);
    assert_eq!(doc.lines[0].time_ms, 10_000);
    assert_eq!(doc.lines[1].time_ms, 50_000);
    assert_eq!(doc.lines[0].text, doc.lines[1].text);
}

#[test]
fn offset_tag_shifts_all_lines() {
    let doc = lyrics::parse_lrc("[offset:+500]\n[00:10.00]Shifted");
    assert_eq!(doc.lines[0].time_ms, 10_500);
    let doc = lyrics::parse_lrc("[offset:-500]\n[00:10.00]Shifted");
    assert_eq!(doc.lines[0].time_ms, 9_500);
}

#[test]
fn offset_never_makes_time_negative() {
    let doc = lyrics::parse_lrc("[offset:-5000]\n[00:01.00]Early");
    assert_eq!(doc.lines[0].time_ms, 0);
}

#[test]
fn enhanced_lrc_yields_word_level() {
    let lrc = "[00:10.00]<00:10.00>Never <00:10.40>gonna <00:10.80>give";
    let doc = lyrics::parse_lrc(lrc);
    assert_eq!(doc.kind, LyricsKind::WordSynced);
    let words = doc.lines[0].words.as_ref().unwrap();
    assert_eq!(words.len(), 3);
    assert_eq!(words[0].time_ms, 10_000);
    assert_eq!(words[0].text, "Never ");
    assert_eq!(words[2].time_ms, 10_800);
    // Line text is the concatenation, so line-level renderers just work.
    assert_eq!(doc.lines[0].text, "Never gonna give");
}

#[test]
fn mixed_word_and_line_stays_word_synced_overall() {
    let lrc = "\
[00:10.00]<00:10.00>Word <00:10.40>synced
[00:20.00]Plain line";
    let doc = lyrics::parse_lrc(lrc);
    assert_eq!(doc.kind, LyricsKind::WordSynced);
    assert!(doc.lines[0].words.is_some());
    assert!(doc.lines[1].words.is_none());
}

#[test]
fn text_without_timestamps_is_static() {
    let doc = lyrics::parse_lrc("Just some lyrics\nwith no timing at all");
    assert_eq!(doc.kind, LyricsKind::Static);
    assert_eq!(doc.lines.len(), 2);
    assert_eq!(doc.lines[0].time_ms, 0);
}

#[test]
fn hour_long_timestamps_parse() {
    // Rare but legal: [mm:ss.xx] with mm > 59 (long mixes).
    let doc = lyrics::parse_lrc("[75:00.00]Deep into the mix");
    assert_eq!(doc.lines[0].time_ms, 75 * 60 * 1000);
}

// ---- source resolution ----

fn write_mp3(path: &std::path::Path) {
    let mut frame = vec![0xFF, 0xFB, 0x90, 0x00];
    frame.resize(417, 0);
    let mut bytes = Vec::new();
    for _ in 0..4 {
        bytes.extend_from_slice(&frame);
    }
    fs::write(path, bytes).unwrap();
}

#[test]
fn sidecar_lrc_is_found() {
    let dir = tempfile::tempdir().unwrap();
    let audio = dir.path().join("song.mp3");
    write_mp3(&audio);
    fs::write(dir.path().join("song.lrc"), "[00:01.00]From sidecar").unwrap();

    let doc = lyrics::resolve(&audio).unwrap().expect("sidecar must be found");
    assert_eq!(doc.kind, LyricsKind::LineSynced);
    assert_eq!(doc.lines[0].text, "From sidecar");
    assert_eq!(doc.source, "sidecar");
}

#[test]
fn embedded_lyrics_win_over_sidecar() {
    use lofty::prelude::*;
    use lofty::tag::{ItemKey, Tag, TagType};

    let dir = tempfile::tempdir().unwrap();
    let audio = dir.path().join("song.mp3");
    write_mp3(&audio);
    let mut tag = Tag::new(TagType::Id3v2);
    tag.insert_text(ItemKey::UnsyncLyrics, "[00:02.00]From the tag".to_string());
    tag.save_to_path(&audio, lofty::config::WriteOptions::default()).unwrap();
    fs::write(dir.path().join("song.lrc"), "[00:01.00]From sidecar").unwrap();

    let doc = lyrics::resolve(&audio).unwrap().expect("embedded must be found");
    assert_eq!(doc.lines[0].text, "From the tag");
    assert_eq!(doc.source, "embedded");
}

#[test]
fn no_lyrics_resolves_to_none_not_error() {
    let dir = tempfile::tempdir().unwrap();
    let audio = dir.path().join("song.mp3");
    write_mp3(&audio);
    assert!(lyrics::resolve(&audio).unwrap().is_none());
}

// ---- sidecar delivery (fetched lyrics land as .lrc, PRODUCT.md) ----

#[test]
fn write_sidecar_records_provenance_and_resolves() {
    let dir = tempfile::tempdir().unwrap();
    let audio = dir.path().join("song.mp3");
    write_mp3(&audio);

    let sidecar =
        lyrics::write_sidecar(&audio, "[00:01.00]Fetched line", "agent:lrclib").unwrap();
    assert_eq!(sidecar, dir.path().join("song.lrc"));

    // Provenance rides in the standard [by:] creator tag.
    let content = fs::read_to_string(&sidecar).unwrap();
    assert!(content.starts_with("[by:agent:lrclib]"), "{content}");

    // The chain picks it up; the header is metadata, not a lyric line.
    let doc = lyrics::resolve(&audio).unwrap().expect("sidecar must resolve");
    assert_eq!(doc.source, "sidecar");
    assert_eq!(doc.lines.len(), 1);
    assert_eq!(doc.lines[0].text, "Fetched line");
}

// ---- per-track sync offset (user-adjusted, lives in the index) ----

#[test]
fn lyrics_offset_defaults_to_zero_and_roundtrips() {
    let conn = db::open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO tracks (path, format, first_seen, last_scanned)
         VALUES ('/x/a.mp3', 'mp3', datetime('now'), datetime('now'))",
        [],
    )
    .unwrap();

    let tracks = query::list_tracks(&conn).unwrap();
    assert_eq!(tracks[0].lyrics_offset_ms, 0, "unset offset must read as 0");

    lyrics::set_offset(&conn, tracks[0].id, 300).unwrap();
    assert_eq!(query::list_tracks(&conn).unwrap()[0].lyrics_offset_ms, 300);

    // Negative offsets (lyrics ahead of the music) are legal.
    lyrics::set_offset(&conn, tracks[0].id, -250).unwrap();
    assert_eq!(query::list_tracks(&conn).unwrap()[0].lyrics_offset_ms, -250);
}

#[test]
fn set_offset_fails_fast_on_unknown_track() {
    let conn = db::open_in_memory().unwrap();
    let err = lyrics::set_offset(&conn, 42, 100).expect_err("unknown id must fail");
    assert!(matches!(err, rusqlite::Error::QueryReturnedNoRows));
}

#[test]
fn write_sidecar_refuses_to_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let audio = dir.path().join("song.mp3");
    write_mp3(&audio);
    fs::write(dir.path().join("song.lrc"), "[00:01.00]Hand-made").unwrap();

    let err = lyrics::write_sidecar(&audio, "[00:02.00]Fetched", "agent:lrclib")
        .expect_err("must refuse");
    assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
    // The existing file is untouched.
    let content = fs::read_to_string(dir.path().join("song.lrc")).unwrap();
    assert_eq!(content, "[00:01.00]Hand-made");
}
