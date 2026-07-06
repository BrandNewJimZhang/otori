//! VocaDB jacket provider: matching logic pinned on canned API JSON.
//! The network layer is thin; everything decidable is tested offline.

use otori_core::vocadb;

/// Trimmed real response shape from /api/songs?query=...&fields=Albums.
const SEARCH_JSON: &str = r#"{
  "items": [
    {
      "id": 868494,
      "name": "So Yoon diffsinger 1.0_Japanese",
      "artistString": "naff feat. Soyoon",
      "albums": []
    },
    {
      "id": 565232,
      "name": "アマツキツネ",
      "artistString": "荒木長仁 feat. 離途",
      "albums": []
    },
    {
      "id": 480290,
      "name": "アマツキツネ",
      "artistString": "まらしぃ feat. 高橋洋子",
      "albums": [
        { "id": 36044, "name": "アマツキツネ 10th Anniversary" },
        { "id": 99999, "name": "some compilation" }
      ]
    }
  ]
}"#;

#[test]
fn picks_exact_title_and_artist_overlap() {
    let hit = vocadb::pick_match(SEARCH_JSON, "アマツキツネ", Some("まらしぃ feat. 鏡音リン"))
        .unwrap()
        .expect("must match");
    assert_eq!(hit.song_id, 480290);
    // First album wins (albums are ordered by relevance server-side).
    assert_eq!(hit.album_id, Some(36044));
    assert_eq!(hit.album_name.as_deref(), Some("アマツキツネ 10th Anniversary"));
}

#[test]
fn title_must_match_exactly() {
    assert!(vocadb::pick_match(SEARCH_JSON, "アマツキツネ2", Some("まらしぃ"))
        .unwrap()
        .is_none());
}

#[test]
fn artist_disambiguates_same_title_entries() {
    // Two songs share the title; artist overlap picks the right one.
    let hit = vocadb::pick_match(SEARCH_JSON, "アマツキツネ", Some("荒木長仁"))
        .unwrap()
        .expect("must match the araki entry");
    assert_eq!(hit.song_id, 565232);
    assert_eq!(hit.album_id, None, "no albums on this entry");
}

#[test]
fn no_artist_given_requires_unique_title() {
    // Ambiguous without artist → refuse to guess (unsure = ask).
    assert!(vocadb::pick_match(SEARCH_JSON, "アマツキツネ", None)
        .unwrap()
        .is_none());
}

#[test]
fn artist_matching_ignores_feat_ordering_and_case() {
    let hit = vocadb::pick_match(SEARCH_JSON, "アマツキツネ", Some("MARASY feat. anyone"));
    // "marasy" does not appear in "まらしぃ feat. 高橋洋子" — no overlap, no match.
    assert!(hit.unwrap().is_none());
    // But a single overlapping name component is enough:
    let hit = vocadb::pick_match(SEARCH_JSON, "アマツキツネ", Some("高橋洋子"))
        .unwrap()
        .expect("shared component matches");
    assert_eq!(hit.song_id, 480290);
}

#[test]
fn malformed_json_is_an_error_not_a_panic() {
    assert!(vocadb::pick_match("{not json", "x", None).is_err());
    assert!(vocadb::pick_match(r#"{"items": "wrong type"}"#, "x", None).is_err());
}

/// VocaDB has duplicate entries for one song (seen in the wild:
/// アマツキツネ #15691/#17889, identical artist). Same-artist dupes are
/// one song — pick the entry that has album art. Different artists
/// still ambiguous → refuse.
const DUPES_JSON: &str = r#"{
  "items": [
    { "id": 15691, "name": "T", "artistString": "A feat. B", "albums": [] },
    { "id": 17889, "name": "T", "artistString": "A feat. B",
      "albums": [ { "id": 7, "name": "Album7" } ] }
  ]
}"#;

#[test]
fn same_artist_duplicates_resolve_to_the_one_with_albums() {
    let hit = vocadb::pick_match(DUPES_JSON, "T", Some("A")).unwrap().expect("dupes are one song");
    assert_eq!(hit.song_id, 17889);
    assert_eq!(hit.album_id, Some(7));
}

#[test]
fn exact_artist_string_narrows_ambiguity() {
    // "A" exactly matches entry 1's artistString → that's the tagged
    // entry; entry 2 is a different act that merely features A.
    let json = r#"{
      "items": [
        { "id": 1, "name": "T", "artistString": "A", "albums": [] },
        { "id": 2, "name": "T", "artistString": "B feat. A", "albums": [] }
      ]
    }"#;
    let hit = vocadb::pick_match(json, "T", Some("A")).unwrap().expect("exact narrows");
    assert_eq!(hit.song_id, 1);
}

#[test]
fn different_artist_ties_without_exact_match_refuse() {
    // Neither entry's artistString equals the query exactly, and they
    // are different acts → ambiguity stands, no guessing.
    let json = r#"{
      "items": [
        { "id": 1, "name": "T", "artistString": "A feat. C", "albums": [] },
        { "id": 2, "name": "T", "artistString": "B feat. A", "albums": [] }
      ]
    }"#;
    assert!(vocadb::pick_match(json, "T", Some("A")).unwrap().is_none());
}

#[test]
fn voicebank_suffixes_narrow_via_component_prefix() {
    // Tag says "すりぃ feat. 鏡音レン"; VocaDB suffixes the voicebank
    // ("鏡音レン V4X (Power)"). Every tagged component prefix-matching
    // an entry component beats the compilation that merely shares the
    // producer (seen in the wild: テレキャスタービーボーイ).
    let json = r#"{
      "items": [
        { "id": 233017, "name": "T", "artistString": "すりぃ feat. 鏡音レン V4X (Power)",
          "albums": [{ "id": 1, "name": "EGOIST" }] },
        { "id": 356187, "name": "T", "artistString": "すりぃ, OTOIRO feat. various",
          "albums": [{ "id": 2, "name": "compilation" }] }
      ]
    }"#;
    let hit = vocadb::pick_match(json, "T", Some("すりぃ feat. 鏡音レン"))
        .unwrap()
        .expect("prefix rule must disambiguate");
    assert_eq!(hit.song_id, 233017);
}

#[test]
fn nfd_tag_matches_nfc_database() {
    // macOS-written tags are NFD (バ = ハ + U+3099); VocaDB serves NFC.
    // Found in the wild: 裏表ラバーズ never matched until normalized.
    let nfd_title = "裏表ラハ\u{3099}ーズ"; // NFD bytes for 裏表ラバーズ
    let json = r#"{
      "items": [
        { "id": 1508, "name": "裏表ラバーズ", "artistString": "wowaka feat. 初音ミク",
          "albums": [{ "id": 413, "name": "Vocalolegend" }] }
      ]
    }"#;
    let hit = vocadb::pick_match(json, nfd_title, Some("wowaka feat. 初音ミク"))
        .unwrap()
        .expect("NFD input must match NFC database");
    assert_eq!(hit.song_id, 1508);
}

#[test]
fn matches_via_name_aliases() {
    // VocaDB display name is often romanized; JP title lives in names[].
    let json = r#"{
      "items": [
        { "id": 1508, "name": "Two-Faced Lovers", "artistString": "wowaka feat. Miku",
          "albums": [{ "id": 413, "name": "Vocalolegend" }],
          "names": [ { "value": "裏表ラバーズ" }, { "value": "Uraomote Lovers" } ] }
      ]
    }"#;
    let hit = vocadb::pick_match(json, "裏表ラバーズ", Some("wowaka"))
        .unwrap()
        .expect("alias must match");
    assert_eq!(hit.song_id, 1508);
    assert_eq!(hit.album_id, Some(413));
}

#[test]
fn cover_url_is_derived_from_album_id() {
    assert_eq!(
        vocadb::cover_url(36044),
        "https://vocadb.net/Album/CoverPicture/36044"
    );
}
