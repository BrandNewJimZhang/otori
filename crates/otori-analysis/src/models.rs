//! Model file resolution — the single source of truth for which ONNX
//! files the engine needs, where they live, and where to fetch any that
//! aren't bundled. Weights are downloaded artifacts
//! (scripts/download-models.sh / the GUI download command), never
//! committed.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};

pub const MEL_FILE: &str = "mel_spectrogram.onnx";

/// One selectable beat model. The id is the SSOT string the index
/// stamps into `analysis_model` and the prefs round-trip; the filename
/// is where the weights live; `download_url` is where an unbundled
/// model's weights come from (None = ships in the app bundle). Adding a
/// model = one registry entry plus a download line in
/// scripts/download-models.sh.
#[derive(Debug, Clone, Copy)]
pub struct BeatModel {
    /// Stable id stored in the index and prefs (e.g. "small", "standard").
    pub id: &'static str,
    /// ONNX filename under the models dir.
    pub file: &'static str,
    /// One-line label for the UI cycle button / status bar.
    pub label: &'static str,
    /// Where to download the weights when absent, or None when the model
    /// is bundled with the app (small). The GUI download command and the
    /// CLI fetch script both read this, so the URL lives in one place.
    pub download_url: Option<&'static str>,
}

/// The selectable beat models, in cycle order. The first entry is the
/// default a fresh install ships with (small: 10 MB, F-measure ≥0.99);
/// standard (83 MB FP32) is the accuracy ceiling, opt-in for users who
/// hit small-model misses. small is bundled; standard is downloaded on
/// demand from `download_url`.
pub const MODELS: &[BeatModel] = &[
    BeatModel {
        id: "small",
        file: "beat_this_small.onnx",
        label: "Small",
        download_url: None,
    },
    BeatModel {
        id: "standard",
        file: "beat_this.onnx",
        label: "Standard",
        download_url: Some(
            "https://github.com/danigb/beat-this-rs/releases/download/model-large/beat_this.onnx",
        ),
    },
];

/// The default model id — first in `MODELS`, and the one a fresh prefs
/// blob resolves to. Kept as a function (not a const) so adding models
/// can't accidentally orphan a hard-coded default.
pub fn default_id() -> &'static str {
    MODELS[0].id
}

/// Look up a model by id, or None for an unknown id. The registry is
/// the SSOT; callers that receive an id from prefs or the index go
/// through here rather than re-listing models.
pub fn find(id: &str) -> Option<BeatModel> {
    MODELS.iter().copied().find(|m| m.id == id)
}

/// The download URL for a model's weights, or None when it's bundled
/// (small). The single source the GUI download command and the CLI
/// fetch script both consult.
pub fn download_url(id: &str) -> Option<&'static str> {
    find(id).and_then(|m| m.download_url)
}

#[derive(Debug, Clone)]
pub struct ModelPaths {
    pub mel: PathBuf,
    pub beat: PathBuf,
    /// The id of the selected beat model — stamped into the index so a
    /// later switch can reopen only foreign-model verdicts.
    pub model_id: &'static str,
}

/// Search `dirs` in order for `name`, returning the first existing
/// file. The GUI passes [writable data dir, bundled resource dir] so a
/// downloaded standard model in the data dir wins, while the bundled
/// small model in the resource dir is the fallback; the CLI passes a
/// single dir.
fn find_file(dirs: &[&Path], name: &str) -> Option<PathBuf> {
    dirs.iter().map(|d| d.join(name)).find(|p| p.is_file())
}

/// Resolve both model files for the default model across `dirs`. Fails
/// fast with the fix in the message — a missing model is a setup
/// error, not a skip.
pub fn resolve(dirs: &[&Path]) -> Result<ModelPaths> {
    resolve_model(dirs, default_id())
}

/// Resolve both model files across `dirs` for a specific model id.
/// Unknown id → fail fast (prefs corruption, not a silent fallback):
/// the registry is the SSOT, and guessing would write a verdict
/// stamped with a model the user never chose. The mel front-end is
/// shared across models, so it's resolved once; the beat file is the
/// model-specific one.
pub fn resolve_model(dirs: &[&Path], id: &str) -> Result<ModelPaths> {
    let model = find(id)
        .ok_or_else(|| anyhow!("unknown analysis model {id:?}; expected one of {}", model_ids()))?;
    let mel = find_file(dirs, MEL_FILE).ok_or_else(|| {
        anyhow!("beat-tracking mel model missing: {MEL_FILE} — run scripts/download-models.sh")
    })?;
    let beat = find_file(dirs, model.file).ok_or_else(|| {
        // bail! (return Err) can't live in this closure — it would force
        // the closure to return a Result. Construct the error directly.
        let hint = if model.download_url.is_some() {
            " — download it via the GUI, or run scripts/download-models.sh"
        } else {
            " — run scripts/download-models.sh"
        };
        anyhow!("beat-tracking model missing: {}{}", model.file, hint)
    })?;
    Ok(ModelPaths { mel, beat, model_id: model.id })
}

/// Comma-joined ids, for error messages that name the valid set.
fn model_ids() -> String {
    MODELS.iter().map(|m| m.id).collect::<Vec<_>>().join(", ")
}

/// Which model ids are *available* across `dirs` (weights present in
/// any dir). Drives the UI: a model not yet downloaded is offered as a
/// download-and-switch, not silently skipped. The mel front-end is
/// shared, so it's not per-model.
pub fn available_ids(dirs: &[&Path]) -> Vec<&'static str> {
    MODELS.iter().filter(|m| find_file(dirs, m.file).is_some()).map(|m| m.id).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_lists_small_first_and_is_the_default() {
        // The fresh-install default must be the first registry entry,
        // and small is the no-download model a new user starts with.
        assert_eq!(default_id(), "small");
        assert_eq!(MODELS[0].id, "small");
    }

    #[test]
    fn find_returns_registered_models_and_rejects_unknown() {
        assert_eq!(find("small").map(|m| m.file), Some("beat_this_small.onnx"));
        assert_eq!(find("standard").map(|m| m.file), Some("beat_this.onnx"));
        assert!(find("turbo").is_none());
    }

    #[test]
    fn download_url_is_none_for_bundled_small_and_some_for_standard() {
        // small ships in the bundle (no download); standard is fetched
        // on demand, so it must carry the URL the GUI/CLI consult.
        assert_eq!(download_url("small"), None);
        let url = download_url("standard").expect("standard has a download URL");
        assert!(url.contains("beat_this.onnx"), "URL points at the beat model asset");
    }

    #[test]
    fn resolve_model_finds_beat_in_a_later_dir_than_mel() {
        // The GUI's two-dir case: mel + small live in the bundled
        // resource dir, a downloaded standard lives in the data dir.
        // Per-file first-hit must let mel and beat come from different
        // dirs without forcing one location to hold both.
        let tmp = tempfile::tempdir().unwrap();
        let resource = tmp.path().join("resource");
        let data = tmp.path().join("data");
        std::fs::create_dir_all(&resource).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(resource.join(MEL_FILE), b"mel").unwrap();
        std::fs::write(resource.join("beat_this_small.onnx"), b"small").unwrap();
        std::fs::write(data.join("beat_this.onnx"), b"standard").unwrap();
        let dirs = [data.as_path(), resource.as_path()];

        let small = resolve_model(&dirs, "small").unwrap();
        assert_eq!(small.model_id, "small");
        assert_eq!(small.beat.file_name().unwrap(), "beat_this_small.onnx");

        let standard = resolve_model(&dirs, "standard").unwrap();
        assert_eq!(standard.model_id, "standard");
        // standard's beat came from data; mel came from resource.
        assert_eq!(standard.beat, data.join("beat_this.onnx"));
        assert_eq!(standard.mel, resource.join(MEL_FILE));
    }

    #[test]
    fn available_ids_unions_across_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let resource = tmp.path().join("resource");
        let data = tmp.path().join("data");
        std::fs::create_dir_all(&resource).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(resource.join(MEL_FILE), b"mel").unwrap();
        std::fs::write(resource.join("beat_this_small.onnx"), b"small").unwrap();
        std::fs::write(data.join("beat_this.onnx"), b"standard").unwrap();
        let dirs = [data.as_path(), resource.as_path()];

        let mut got = available_ids(&dirs);
        got.sort();
        assert_eq!(got, vec!["small", "standard"]);
    }

    #[test]
    fn resolve_model_fails_fast_on_unknown_id() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join(MEL_FILE), b"mel").unwrap();
        std::fs::write(dir.join("beat_this_small.onnx"), b"small").unwrap();
        let err = resolve_model(&[dir], "turbo").unwrap_err();
        assert!(err.to_string().contains("small"), "error names the valid set");
    }
}
