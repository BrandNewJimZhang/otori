//! Online lyrics fetch: the provider ladder (PRODUCT.md: embedded → sidecar
//! → online). LRCLIB is the in-core Tier-1 provider (`lrclib.rs`); other
//! sources (grey-area, never tracked) plug in as external executables that
//! speak a tiny line protocol so this crate never references them by name.
//!
//! External provider protocol:
//!   <bin> <title> <artist> [duration_secs]
//!   - stdout: the LRC text (empty stdout = clean miss)
//!   - stderr: human-readable diagnostics (logged by the caller)
//!   - exit 0: ran to completion (miss or hit decided by stdout)
//!   - non-zero: provider error (treated as a miss, not a hard failure,
//!     so one broken provider can't abort the ladder)
//!
//! The dispatch returns [`FetchedLyrics`] (re-exported from `lrclib`) so
//! every provider lands through the same `write_sidecar` path with its own
//! provenance tag.

use std::path::Path;
use std::process::Command;

use crate::lrclib::FetchedLyrics;
use crate::provider::nfc;


/// Provenance written into the sidecar `[by:]` tag for a provider. Mirrors
/// `agent:lrclib` / `agent:netease`; `lrclib` is the in-core name so both
/// paths share one convention.
pub fn provenance_for(name: &str) -> String {
    format!("agent:{name}")
}

/// Run an external lyrics provider and return its LRC output, or `None` on a
/// clean miss / provider error. `name` is the provider label (provenance +
/// diagnostics); `bin` is the executable path. Title/artist are NFC-normalized
/// to match the in-core providers (macOS NFD tags vs NFC sources).
///
/// Network is the provider's concern; this function only marshals args and
/// reads stdout, so it is deterministic and offline-testable with a stub bin.
pub fn run_external(
    name: &str,
    bin: &Path,
    title: &str,
    artist: &str,
    duration_secs: Option<f64>,
) -> Option<FetchedLyrics> {
    let mut cmd = Command::new(bin);
    cmd.arg(nfc(title)).arg(nfc(artist));
    if let Some(secs) = duration_secs {
        cmd.arg(format!("{}", secs.round() as u64));
    }
    let output = cmd.output().ok()?;
    if !output.status.success() {
        // A broken provider must not abort the ladder; surface the
        // diagnostic on stderr for the caller's logs and treat as a miss.
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!(
            "external lyrics provider {name} exited {:?}: {}",
            output.status.code(),
            stderr.trim()
        );
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return None;
    }
    // Synced iff the LRC carries at least one `[mm:ss.xx]` line; the sidecar
    // ladder (`parse_lrc`) re-derives the exact rung, this is just the hit
    // signal for the caller.
    let synced = text.lines().any(|l| l.trim_start().starts_with('[') && l.contains(':'));
    Some(FetchedLyrics { text, synced })
}

/// Resolve an external provider's executable under the app data dir's
/// `providers/` folder (the same dir `library.db` lives in). Grey-area
/// scripts co-locate with the index, survive app updates, and never enter
/// git. `name` is the provider label, e.g. `"lyricsify"`; the resolved
/// path is `<library_dir>/providers/lyricsify_lyrics.py` (the conventional
/// suffix) or `<library_dir>/providers/lyricsify` if no suffixed file exists.
///
/// Returns `None` when no script is installed for `name` (a clean "provider
/// not configured" signal, not an error).
pub fn external_provider_path(name: &str) -> Option<std::path::PathBuf> {
    let dir = crate::db::default_path().ok()?.parent()?.join("providers");
    let candidates = [
        dir.join(format!("{name}_lyrics.py")),
        dir.join(format!("{name}_lyrics.sh")),
        dir.join(name),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// LRCLIB ladder rung, factored out of the CLI so the Tauri fetch command and
/// `otori fetch-lyrics` share one implementation. Returns the first hit:
/// signature `/api/get` lookup, then title-only `/api/search` with duration
/// disambiguation. `None` = clean miss (or instrumental).
pub fn lrclib_ladder(
    title: &str,
    artist: &str,
    album: Option<&str>,
    duration_secs: Option<f64>,
) -> Result<Option<FetchedLyrics>, String> {
    let response = crate::lrclib::get_lyrics(title, artist, album, duration_secs)?;
    if let Some(body) = response {
        if let Some(fetched) = crate::lrclib::pick_lyrics(&body)? {
            return Ok(Some(fetched));
        }
    }
    // Signature miss → title search. Doujin artist tags rarely match
    // LRCLIB's; duration (a file property) disambiguates.
    let search = crate::lrclib::search_lyrics(title)?;
    Ok(crate::lrclib::pick_search_hit(&search, title, duration_secs)?)
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A stub provider binary: prints canned LRC to stdout. Proves the
    /// dispatch reads stdout and classifies synced vs static.
    fn write_stub_provider(lrc: &str) -> std::path::PathBuf {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("provider.sh");
        let mut f = std::fs::File::create(&path).unwrap();
        write!(f, "#!/bin/sh\nprintf '%s' {:?}\n", lrc).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).unwrap();
        }
        // Leak the dir so the script survives the call. tempfile cleans up
        // on process exit; this test is short-lived.
        std::mem::forget(dir);
        path
    }

    #[test]
    fn external_provider_synced_lrc_is_detected() {
        let bin = write_stub_provider("[00:01.00]hello\n[00:03.00]world\n");
        let fetched =
            run_external("stub", &bin, "T", "A", None).expect("stub should yield lyrics");
        assert!(fetched.synced);
        assert!(fetched.text.contains("[00:01.00]hello"));
    }

    #[test]
    fn external_provider_empty_stdout_is_a_clean_miss() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.sh");
        let mut f = std::fs::File::create(&path).unwrap();
        write!(f, "#!/bin/sh\ntrue\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).unwrap();
        }
        std::mem::forget(dir);
        assert!(run_external("stub", &path, "T", "A", None).is_none());
    }

    #[test]
    fn external_provider_nonzero_exit_is_a_miss_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fail.sh");
        let mut f = std::fs::File::create(&path).unwrap();
        write!(f, "#!/bin/sh\necho oops >&2\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).unwrap();
        }
        std::mem::forget(dir);
        // A broken provider must not abort the ladder.
        assert!(run_external("stub", &path, "T", "A", None).is_none());
    }

    #[test]
    fn provenance_tag_matches_agent_convention() {
        assert_eq!(provenance_for("lrclib"), "agent:lrclib");
        assert_eq!(provenance_for("lyricsify"), "agent:lyricsify");
        assert_eq!(provenance_for("netease"), "agent:netease");
    }
}
