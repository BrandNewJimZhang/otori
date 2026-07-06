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

/// The /api/get signature lookup wants LRCLIB's exact artist string;
/// doujin tags rarely agree with it. The fallback searches by title
/// only and disambiguates on our side — duration is the anchor (it
/// comes from the file, not from anyone's tagging conventions).
const DURATION_TOLERANCE_SECS: f64 = 10.0;

#[derive(Deserialize)]
struct SearchHit {
    #[serde(rename = "trackName", default)]
    track_name: String,
    #[serde(default)]
    duration: f64,
    instrumental: bool,
    #[serde(rename = "plainLyrics")]
    plain_lyrics: Option<String>,
    #[serde(rename = "syncedLyrics")]
    synced_lyrics: Option<String>,
}

impl SearchHit {
    fn lyrics(&self) -> Option<FetchedLyrics> {
        if self.instrumental {
            return None;
        }
        if let Some(s) = self.synced_lyrics.as_ref().filter(|s| !s.trim().is_empty()) {
            return Some(FetchedLyrics { text: s.clone(), synced: true });
        }
        self.plain_lyrics
            .as_ref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| FetchedLyrics { text: s.clone(), synced: false })
    }
}

/// Decide which /api/search hit (if any) is *the* track. Exact title
/// match required (NFC, case-insensitive — vocadb's rule); duration
/// within tolerance is the disambiguator. Without a duration, only a
/// unique exact-title hit counts — ambiguity is never a guess. Among
/// survivors, synced lyrics beat a closer duration: the rung matters
/// more than a couple of seconds.
pub fn pick_search_hit(
    search_json: &str,
    title: &str,
    duration_secs: Option<f64>,
) -> Result<Option<FetchedLyrics>, String> {
    let hits: Vec<SearchHit> =
        serde_json::from_str(search_json).map_err(|e| format!("LRCLIB response: {e}"))?;
    let wanted = nfc(title).to_lowercase();
    let mut candidates: Vec<&SearchHit> = hits
        .iter()
        .filter(|h| nfc(&h.track_name).to_lowercase() == wanted)
        .collect();

    match duration_secs {
        Some(secs) => {
            candidates.retain(|h| (h.duration - secs).abs() <= DURATION_TOLERANCE_SECS)
        }
        None if candidates.len() > 1 => return Ok(None),
        None => {}
    }

    // Synced beats plain (the rung matters more than seconds); within
    // a rung, the closest duration is the right recording — covers of
    // the same song carry the same words with different timing.
    let distance = |h: &SearchHit| match duration_secs {
        Some(secs) => (h.duration - secs).abs(),
        None => 0.0,
    };
    let best = candidates
        .into_iter()
        .filter(|h| h.lyrics().is_some())
        .min_by(|a, b| {
            let synced = |h: &SearchHit| h.lyrics().is_some_and(|l| l.synced);
            synced(b)
                .cmp(&synced(a))
                .then(distance(a).total_cmp(&distance(b)))
        });
    Ok(best.and_then(|h| h.lyrics()))
}

/// Search LRCLIB by title. Network; returns the raw JSON array for
/// `pick_search_hit`.
pub fn search_lyrics(title: &str) -> Result<String, String> {
    let url = format!("{API_BASE}/api/search?track_name={}", urlencode(&nfc(title)));
    ureq::get(&url)
        .header("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| format!("GET {url}: {e}"))?
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("read {url}: {e}"))
}
