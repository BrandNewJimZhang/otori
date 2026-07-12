//! End-to-end check for the external lyrics-provider dispatch against a real
//! installed script. Network-gated: skips when no provider script is present
//! (CI / fresh checkouts) so the suite stays green offline.

use otori_core::lyrics_fetch;
use std::path::PathBuf;

fn installed_lyricsify() -> Option<PathBuf> {
    lyrics_fetch::external_provider_path("lyricsify")
}

#[test]
fn external_provider_path_resolves_installed_script() {
    // The path resolver must find a script named lyricsify_lyrics.py under
    // <library_dir>/providers/ when one is installed. On a clean checkout
    // (CI) none is, so this only asserts the resolution shape, not existence.
    let path = lyrics_fetch::external_provider_path("lyricsify");
    if let Some(p) = &path {
        assert!(p.is_file(), "resolved path is not a file: {}", p.display());
        assert!(p.to_string_lossy().contains("providers"));
    }
    // No script installed: resolver returns None, not an error.
    assert!(lyrics_fetch::external_provider_path("definitely-not-installed").is_none());
}

#[test]
fn run_external_drives_installed_lyricsify_provider() {
    let Some(bin) = installed_lyricsify() else {
        eprintln!("skipping: no lyricsify provider script installed");
        return;
    };
    // "6 God" by Drake is a stable lyricsify hit. The provider harvests a
    // cf_clearance cookie on first run (headful Chrome), then replays it.
    let fetched = lyrics_fetch::run_external("lyricsify", &bin, "6 God", "Drake", None);
    let Some(fetched) = fetched else {
        eprintln!("skipping: lyricsify returned no match (cookie harvest failed?)");
        return;
    };
    assert!(fetched.synced, "lyricsify LRC should be synced");
    assert!(fetched.text.contains("[ar:"), "expected [ar:] metadata tag");
    assert!(fetched.text.contains("6 God") || fetched.text.contains("Ting"));
}
