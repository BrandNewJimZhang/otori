//! LRCLIB lyrics provider: response parsing pinned on canned API JSON.
//! Same split as vocadb: everything decidable is tested offline, the
//! network layer stays thin.

use otori_core::lrclib;

/// Real response shape from /api/get (trimmed).
const HIT_BOTH: &str = r#"{
  "id": 151738,
  "trackName": "The Chain",
  "artistName": "Fleetwood Mac",
  "albumName": "Rumours",
  "duration": 271.0,
  "instrumental": false,
  "plainLyrics": "Listen to the wind blow\nWatch the sun rise",
  "syncedLyrics": "[00:27.93] Listen to the wind blow\n[00:31.10] Watch the sun rise"
}"#;

const HIT_PLAIN_ONLY: &str = r#"{
  "id": 1, "trackName": "T", "artistName": "A", "albumName": null,
  "duration": 100.0, "instrumental": false,
  "plainLyrics": "Just words",
  "syncedLyrics": null
}"#;

const HIT_INSTRUMENTAL: &str = r#"{
  "id": 2, "trackName": "T", "artistName": "A", "albumName": null,
  "duration": 100.0, "instrumental": true,
  "plainLyrics": null, "syncedLyrics": null
}"#;

#[test]
fn synced_lyrics_win_over_plain() {
    let fetched = lrclib::pick_lyrics(HIT_BOTH).unwrap().expect("must yield lyrics");
    assert!(fetched.synced);
    assert!(fetched.text.starts_with("[00:27.93]"));
}

#[test]
fn plain_only_falls_back_to_static() {
    let fetched = lrclib::pick_lyrics(HIT_PLAIN_ONLY).unwrap().expect("must yield lyrics");
    assert!(!fetched.synced);
    assert_eq!(fetched.text, "Just words");
}

#[test]
fn instrumental_yields_none() {
    // Instrumental is an answer, not a miss — but there is nothing to
    // write as a sidecar.
    assert!(lrclib::pick_lyrics(HIT_INSTRUMENTAL).unwrap().is_none());
}

#[test]
fn empty_lyrics_yield_none() {
    let empty = r#"{
      "id": 3, "trackName": "T", "artistName": "A", "albumName": null,
      "duration": 100.0, "instrumental": false,
      "plainLyrics": "", "syncedLyrics": null
    }"#;
    assert!(lrclib::pick_lyrics(empty).unwrap().is_none());
}

#[test]
fn malformed_json_is_an_error() {
    assert!(lrclib::pick_lyrics("not json").is_err());
}

#[test]
fn get_url_encodes_query_params() {
    let url = lrclib::get_url("アマツキツネ", "まらしぃ", Some("Album X"), Some(271.4));
    assert!(url.starts_with("https://lrclib.net/api/get?"));
    // Duration is sent in whole seconds (LRCLIB matches with tolerance).
    assert!(url.contains("duration=271"), "{url}");
    assert!(url.contains("album_name=Album%20X"), "{url}");
    // Multibyte titles must be percent-encoded, never raw.
    assert!(!url.contains("アマツキツネ"), "{url}");
}

#[test]
fn get_url_omits_absent_album_and_duration() {
    let url = lrclib::get_url("T", "A", None, None);
    assert!(!url.contains("album_name"), "{url}");
    assert!(!url.contains("duration"), "{url}");
}

#[test]
fn get_url_nfc_normalizes_before_encoding() {
    // macOS tags are often NFD (バ = ハ + combining mark); LRCLIB stores
    // NFC. Same rule as vocadb — equal glyphs must build equal URLs.
    let nfd = "ハ\u{3099}";
    let nfc = "バ";
    assert_eq!(
        lrclib::get_url(nfd, "A", None, None),
        lrclib::get_url(nfc, "A", None, None)
    );
}
