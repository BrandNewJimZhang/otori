//! Model file resolution — the single source of truth for which ONNX
//! files the engine needs and where they live. Weights are downloaded
//! artifacts (scripts/download-models.sh), never committed.

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};

pub const MEL_FILE: &str = "mel_spectrogram.onnx";
/// Small model (~10 MB): F-measure ≥ 0.99 vs the Python reference;
/// the 83 MB full model buys ≤1% for 8× the weight.
pub const BEAT_FILE: &str = "beat_this_small.onnx";

#[derive(Debug, Clone)]
pub struct ModelPaths {
    pub mel: PathBuf,
    pub beat: PathBuf,
}

/// Resolve both model files under `dir`, failing fast with the fix in
/// the message — a missing model is a setup error, not a skip.
pub fn resolve(dir: &Path) -> Result<ModelPaths> {
    let paths = ModelPaths { mel: dir.join(MEL_FILE), beat: dir.join(BEAT_FILE) };
    for p in [&paths.mel, &paths.beat] {
        if !p.is_file() {
            bail!(
                "beat-tracking model missing: {} — run scripts/download-models.sh",
                p.display()
            );
        }
    }
    Ok(paths)
}
