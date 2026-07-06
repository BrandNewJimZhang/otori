//! VocaDB jacket provider (Tier 1, PRODUCT.md Metadata providers).
//! Matching philosophy mirrors the wiki rules of engagement: exact
//! title match, artist-component overlap to disambiguate, and when
//! ambiguity remains — no match, never a guess.
//!
//! Split: pure matching logic (`pick_match`, testable offline) vs the
//! thin network calls (`search_song`, `download_cover`).

use serde::Deserialize;
use unicode_normalization::UnicodeNormalization;

/// NFC-normalize before comparing: tags written on macOS are often NFD
/// (バ = ハ + combining voicing mark) while VocaDB serves NFC — equal
/// glyphs, unequal bytes (found the hard way: 裏表ラバーズ).
fn nfc(s: &str) -> String {
    s.trim().nfc().collect()
}

pub const API_BASE: &str = "https://vocadb.net";
const USER_AGENT: &str = concat!("Otori/", env!("CARGO_PKG_VERSION"), " (music library manager)");

#[derive(Debug)]
pub struct Match {
    pub song_id: i64,
    pub song_name: String,
    pub artist_string: String,
    pub album_id: Option<i64>,
    pub album_name: Option<String>,
}

#[derive(Deserialize)]
struct SearchResponse {
    items: Vec<SongItem>,
}

#[derive(Deserialize)]
struct SongItem {
    id: i64,
    name: String,
    #[serde(rename = "artistString", default)]
    artist_string: String,
    #[serde(default)]
    albums: Vec<AlbumRef>,
    /// All names incl. aliases in other languages; `name` alone is the
    /// display name (often romanized) and misses JP titles.
    #[serde(default)]
    names: Vec<NameRef>,
}

#[derive(Deserialize)]
struct NameRef {
    value: String,
}

impl SongItem {
    fn has_name(&self, title: &str) -> bool {
        let wanted = nfc(title).to_lowercase();
        std::iter::once(&self.name)
            .chain(self.names.iter().map(|n| &n.value))
            .any(|n| nfc(n).to_lowercase() == wanted)
    }
}

#[derive(Deserialize)]
struct AlbumRef {
    id: i64,
    name: String,
}

/// Decide which search hit (if any) is *the* song. Exact title match
/// required; artist narrows same-title candidates by name-component
/// overlap; ambiguity (or no artist to disambiguate with) → `None`.
pub fn pick_match(
    search_json: &str,
    title: &str,
    artist: Option<&str>,
) -> Result<Option<Match>, String> {
    let response: SearchResponse =
        serde_json::from_str(search_json).map_err(|e| format!("VocaDB response: {e}"))?;

    let mut candidates: Vec<&SongItem> = response
        .items
        .iter()
        .filter(|item| item.has_name(title))
        .collect();

    if let Some(artist) = artist {
        let wanted = artist_components(artist);
        candidates.retain(|item| {
            let have = artist_components(&item.artist_string);
            wanted.iter().any(|w| have.contains(w))
        });
        // Vocalist overlap alone keeps every Miku cover of the song.
        // When the full artist string matches exactly, that's the
        // entry the file is tagged from — narrow to it.
        let wanted_full = nfc(artist).to_lowercase();
        let exact: Vec<&SongItem> = candidates
            .iter()
            .filter(|c| nfc(&c.artist_string).to_lowercase() == wanted_full)
            .copied()
            .collect();
        if !exact.is_empty() {
            candidates = exact;
        }
    }

    // Zero hits → no match. Multiple hits: VocaDB has duplicate entries
    // for one song (verified: アマツキツネ #15691/#17889), so identical
    // artistString dupes are one song — prefer the highest-rated
    // (sort=RatingScore puts it first) that has album art. Anything
    // less than identical → unsure = no match; the artist filter above
    // already dropped covers/remixes, so a remaining tie is real
    // ambiguity, not noise.
    let hit = match candidates.len() {
        0 => return Ok(None),
        1 => candidates[0],
        _ => {
            let first_artist = candidates[0].artist_string.trim();
            if !candidates
                .iter()
                .all(|c| c.artist_string.trim() == first_artist)
            {
                return Ok(None);
            }
            candidates
                .iter()
                .find(|c| !c.albums.is_empty())
                .unwrap_or(&candidates[0])
        }
    };
    Ok(Some(Match {
        song_id: hit.id,
        song_name: hit.name.clone(),
        artist_string: hit.artist_string.clone(),
        album_id: hit.albums.first().map(|a| a.id),
        album_name: hit.albums.first().map(|a| a.name.clone()),
    }))
}

/// Split an artist string into comparable name components:
/// "まらしぃ feat. 鏡音リン" → {"まらしぃ", "鏡音リン"}.
fn artist_components(s: &str) -> Vec<String> {
    nfc(s)
        .to_lowercase()
        .replace("feat.", ",")
        .replace(" x ", ",")
        .replace(['&', '、'], ",")
        .split(',')
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

/// Full-size album cover endpoint (redirects to the original image).
pub fn cover_url(album_id: i64) -> String {
    format!("{API_BASE}/Album/CoverPicture/{album_id}")
}

/// Search VocaDB for a song by title. Network; returns the raw JSON
/// for `pick_match`.
pub fn search_song(title: &str) -> Result<String, String> {
    let url = format!(
        "{API_BASE}/api/songs?query={}&maxResults=10&fields=Albums,Names&nameMatchMode=Exact&sort=RatingScore",
        urlencode(&nfc(title))
    );
    http_get_string(&url)
}

/// Download an album cover. Returns raw image bytes; the caller runs
/// the resolution floor before delivering anything.
pub fn download_cover(album_id: i64) -> Result<Vec<u8>, String> {
    http_get_bytes(&cover_url(album_id))
}

fn http_get_string(url: &str) -> Result<String, String> {
    ureq::get(url)
        .header("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| format!("GET {url}: {e}"))?
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("read {url}: {e}"))
}

fn http_get_bytes(url: &str) -> Result<Vec<u8>, String> {
    ureq::get(url)
        .header("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| format!("GET {url}: {e}"))?
        .body_mut()
        .read_to_vec()
        .map_err(|e| format!("read {url}: {e}"))
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}
