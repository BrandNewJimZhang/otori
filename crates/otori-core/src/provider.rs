//! Shared plumbing for online metadata/lyrics providers (vocadb,
//! lrclib): text normalization, URL encoding, and the identifying
//! User-Agent. Provider-specific matching logic stays in each module.

use unicode_normalization::UnicodeNormalization;

/// Identify ourselves to provider APIs (both VocaDB and LRCLIB ask
/// clients to send a descriptive User-Agent).
pub(crate) const USER_AGENT: &str =
    concat!("Otori/", env!("CARGO_PKG_VERSION"), " (music library manager)");

/// NFC-normalize before comparing or sending: tags written on macOS are
/// often NFD (バ = ハ + combining voicing mark) while the providers
/// serve NFC — equal glyphs, unequal bytes (found the hard way:
/// 裏表ラバーズ).
pub(crate) fn nfc(s: &str) -> String {
    s.trim().nfc().collect()
}

pub(crate) fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}
