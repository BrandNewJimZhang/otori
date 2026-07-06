//! LRCLIB lyrics provider (lrclib.net): the Tier-1 code path of the
//! lyrics ladder's online rung (PRODUCT.md). Signature lookup by
//! title/artist/album/duration; synced LRC preferred, plain text as
//! the static fallback; instrumental is an answer, not a miss.
//!
//! Same split as vocadb: pure response parsing (`pick_lyrics`,
//! testable offline) vs the thin network call (`get_lyrics`).

use serde::Deserialize;

use crate::provider::{nfc, urlencode, USER_AGENT};

pub const API_BASE: &str = "https://lrclib.net";

/// What a hit gives us: LRC text ready to land as a sidecar, plus
/// whether it carries timestamps (decides the ladder rung).
#[derive(Debug)]
pub struct FetchedLyrics {
    pub text: String,
    pub synced: bool,
}

#[derive(Deserialize)]
struct GetResponse {
    instrumental: bool,
    #[serde(rename = "plainLyrics")]
    plain_lyrics: Option<String>,
    #[serde(rename = "syncedLyrics")]
    synced_lyrics: Option<String>,
}

/// Decide what (if anything) a /api/get response yields: synced LRC
/// wins, plain text degrades to static, instrumental/empty → `None`.
pub fn pick_lyrics(get_json: &str) -> Result<Option<FetchedLyrics>, String> {
    let response: GetResponse =
        serde_json::from_str(get_json).map_err(|e| format!("LRCLIB response: {e}"))?;
    if response.instrumental {
        return Ok(None);
    }
    if let Some(synced) = response.synced_lyrics.filter(|s| !s.trim().is_empty()) {
        return Ok(Some(FetchedLyrics { text: synced, synced: true }));
    }
    if let Some(plain) = response.plain_lyrics.filter(|s| !s.trim().is_empty()) {
        return Ok(Some(FetchedLyrics { text: plain, synced: false }));
    }
    Ok(None)
}

/// Build the /api/get signature-lookup URL. NFC-normalize inputs (macOS
/// tags are often NFD, LRCLIB stores NFC — same lesson as vocadb).
/// Duration is whole seconds; LRCLIB matches with its own tolerance.
pub fn get_url(
    title: &str,
    artist: &str,
    album: Option<&str>,
    duration_secs: Option<f64>,
) -> String {
    let mut url = format!(
        "{API_BASE}/api/get?track_name={}&artist_name={}",
        urlencode(&nfc(title)),
        urlencode(&nfc(artist))
    );
    if let Some(album) = album {
        url.push_str("&album_name=");
        url.push_str(&urlencode(&nfc(album)));
    }
    if let Some(secs) = duration_secs {
        url.push_str(&format!("&duration={}", secs.round() as u64));
    }
    url
}

/// Look up lyrics by track signature. Network; 404 (no record) is a
/// clean miss, not an error. Returns the raw JSON for `pick_lyrics`.
pub fn get_lyrics(
    title: &str,
    artist: &str,
    album: Option<&str>,
    duration_secs: Option<f64>,
) -> Result<Option<String>, String> {
    let url = get_url(title, artist, album, duration_secs);
    match ureq::get(&url).header("User-Agent", USER_AGENT).call() {
        Ok(mut response) => response
            .body_mut()
            .read_to_string()
            .map(Some)
            .map_err(|e| format!("read {url}: {e}")),
        Err(ureq::Error::StatusCode(404)) => Ok(None),
        Err(e) => Err(format!("GET {url}: {e}")),
    }
}
