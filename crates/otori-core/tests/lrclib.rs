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

// ---- search fallback (/api/search when the /api/get signature misses) ----

/// Trimmed real response shape from /api/search?track_name=...
const SEARCH_JSON: &str = r#"[
  {
    "id": 1, "trackName": "フォニイ", "artistName": "WagakkiBand",
    "albumName": "X", "duration": 191.0, "instrumental": false,
    "plainLyrics": "plain A", "syncedLyrics": null
  },
  {
    "id": 2, "trackName": "フォニイ", "artistName": "ツミキ, 可不",
    "albumName": "Y", "duration": 205.0, "instrumental": false,
    "plainLyrics": "plain B", "syncedLyrics": "[00:01.00]synced B"
  },
  {
    "id": 3, "trackName": "フォニイ (piano ver.)", "artistName": "Z",
    "albumName": null, "duration": 204.0, "instrumental": false,
    "plainLyrics": "plain C", "syncedLyrics": "[00:01.00]synced C"
  }
]"#;

#[test]
fn search_picks_exact_title_within_duration_tolerance() {
    // 204s track: id 2 (205s, exact title) wins; id 3 is a title
    // mismatch, id 1 is 13s off.
    let hit = lrclib::pick_search_hit(SEARCH_JSON, "フォニイ", Some(204.0))
        .unwrap()
        .expect("must match");
    assert!(hit.synced);
    assert_eq!(hit.text, "[00:01.00]synced B");
}

#[test]
fn search_title_must_match_exactly() {
    assert!(lrclib::pick_search_hit(SEARCH_JSON, "フォニイ2", Some(204.0))
        .unwrap()
        .is_none());
}

#[test]
fn search_without_duration_requires_unique_title_hit() {
    // No duration to disambiguate: two exact-title candidates with
    // conflicting durations = ambiguity, never a guess.
    assert!(lrclib::pick_search_hit(SEARCH_JSON, "フォニイ", None)
        .unwrap()
        .is_none());
}

#[test]
fn search_duration_gate_rejects_everything_too_far() {
    assert!(lrclib::pick_search_hit(SEARCH_JSON, "フォニイ", Some(300.0))
        .unwrap()
        .is_none());
}

#[test]
fn search_prefers_synced_among_candidates() {
    // Both id 1 and id 2 are within tolerance of 198s; id 2 has synced
    // lyrics and wins even though id 1 is closer in duration.
    let hit = lrclib::pick_search_hit(SEARCH_JSON, "フォニイ", Some(198.0))
        .unwrap()
        .expect("must match");
    assert!(hit.synced);
}

#[test]
fn search_nfc_normalizes_titles() {
    let json = r#"[{
      "id": 9, "trackName": "バラード", "artistName": "A", "albumName": null,
      "duration": 100.0, "instrumental": false,
      "plainLyrics": "words", "syncedLyrics": null
    }]"#;
    // NFD query (ハ + combining voicing mark) must match the NFC record.
    let hit = lrclib::pick_search_hit(json, "ハ\u{3099}ラート\u{3099}", Some(100.0))
        .unwrap()
        .expect("must match across normalization forms");
    assert_eq!(hit.text, "words");
}

#[test]
fn search_prefers_closest_duration_among_synced() {
    // Covers of the same song differ by a couple of seconds; the
    // closest duration is the right recording (sync timing differs
    // between covers even when the words match).
    let json = r#"[
      {"id": 1, "trackName": "T", "artistName": "cover band", "albumName": null,
       "duration": 191.0, "instrumental": false,
       "plainLyrics": null, "syncedLyrics": "[00:01.00]cover timing"},
      {"id": 2, "trackName": "T", "artistName": "original", "albumName": null,
       "duration": 189.0, "instrumental": false,
       "plainLyrics": null, "syncedLyrics": "[00:01.00]original timing"}
    ]"#;
    let hit = lrclib::pick_search_hit(json, "T", Some(189.0)).unwrap().unwrap();
    assert_eq!(hit.text, "[00:01.00]original timing");
}
