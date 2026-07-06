//! VocaDB jacket provider (Tier 1, PRODUCT.md Metadata providers).
//! Matching philosophy mirrors the wiki rules of engagement: exact
//! title match, artist-component overlap to disambiguate, and when
//! ambiguity remains — no match, never a guess.
//!
//! Split: pure matching logic (`pick_match`, testable offline) vs the
//! thin network calls (`search_song`, `download_cover`).

use serde::Deserialize;

use crate::provider::{nfc, urlencode, USER_AGENT};

pub const API_BASE: &str = "https://vocadb.net";

#[derive(Debug)]
pub struct Match {
    pub song_id: i64,
    pub song_name: String,
    pub artist_string: String,
    pub album_id: Option<i64>,
    pub album_name: Option<String>,
    /// Jacket source tier (founding-user priority, 2026-07-07):
    /// self-titled single > rhythm-game jacket (outside this provider:
    /// maimai, then プロセカ, via the wiki workflow) > studio/compilation.
    /// `true` = the chosen album is self-titled (auto-deliver);
    /// `false` = fallback tier (deliver only on explicit opt-in).
    pub album_is_self_titled: bool,
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
        self.primary_name_is(title)
            || self
                .names
                .iter()
                .any(|n| nfc(&n.value).to_lowercase() == nfc(title).to_lowercase())
    }

    /// The display name itself matches (not just an alias). Re-records
    /// like "X (10th Anniversary)" carry plain "X" as an alias; when a
    /// tie needs breaking, the primary-name entry is the original.
    fn primary_name_is(&self, title: &str) -> bool {
        nfc(&self.name).to_lowercase() == nfc(title).to_lowercase()
    }
}

#[derive(Deserialize)]
struct AlbumRef {
    id: i64,
    name: String,
    #[serde(rename = "discType", default)]
    disc_type: String,
}

/// Pick the album per the jacket priority: a self-titled album (name ==
/// song title; prefer discType "Single" among them) wins; otherwise the
/// first listed album, marked as fallback tier.
fn choose_album<'a>(albums: &'a [AlbumRef], title: &str) -> Option<(&'a AlbumRef, bool)> {
    let wanted = nfc(title).to_lowercase();
    let mut self_titled = albums
        .iter()
        .filter(|a| nfc(&a.name).to_lowercase() == wanted);
    if let Some(single) = self_titled
        .clone()
        .find(|a| a.disc_type.eq_ignore_ascii_case("Single"))
    {
        return Some((single, true));
    }
    if let Some(any_self_titled) = self_titled.next() {
        return Some((any_self_titled, true));
    }
    albums.first().map(|a| (a, false))
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
            // Containment, not equality: tags say "flower", VocaDB says
            // "v4 flower"; tags say "鏡音レン", VocaDB "鏡音レン V4X".
            wanted
                .iter()
                .any(|w| have.iter().any(|h| h.contains(w.as_str()) || w.contains(h.as_str())))
        });
        // Vocalist overlap alone keeps every Miku cover of the song.
        // Narrow in two steps: (1) exact full-string match — that's
        // the entry the file was tagged from; (2) all-components
        // containment — VocaDB decorates vocalists with voicebank
        // versions both as suffix ("鏡音レン V4X (Power)") and prefix
        // ("v4 flower"), so require every tagged component to appear
        // within some entry component.
        let wanted_full = nfc(artist).to_lowercase();
        let exact: Vec<&SongItem> = candidates
            .iter()
            .filter(|c| nfc(&c.artist_string).to_lowercase() == wanted_full)
            .copied()
            .collect();
        if !exact.is_empty() {
            candidates = exact;
        } else {
            let all_contained: Vec<&SongItem> = candidates
                .iter()
                .filter(|c| {
                    let have = artist_components(&c.artist_string);
                    wanted
                        .iter()
                        .all(|w| have.iter().any(|h| h.contains(w.as_str())))
                })
                .copied()
                .collect();
            if !all_contained.is_empty() {
                candidates = all_contained;
            }
        }
        // Alias-only matches (re-records: "X (10th Anniversary)" carries
        // "X" as alias) lose to entries whose display name IS the title.
        if candidates.len() > 1 {
            let primary: Vec<&SongItem> = candidates
                .iter()
                .filter(|c| c.primary_name_is(title))
                .copied()
                .collect();
            if !primary.is_empty() {
                candidates = primary;
            }
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
    let chosen = choose_album(&hit.albums, title);
    Ok(Some(Match {
        song_id: hit.id,
        song_name: hit.name.clone(),
        artist_string: hit.artist_string.clone(),
        album_id: chosen.map(|(a, _)| a.id),
        album_name: chosen.map(|(a, _)| a.name.clone()),
        album_is_self_titled: chosen.map(|(_, st)| st).unwrap_or(false),
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
