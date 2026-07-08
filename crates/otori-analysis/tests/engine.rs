//! Engine integration test: synthetic click track through the real
//! Beat This! model. Ignored by default — needs the downloaded models
//! (scripts/download-models.sh). Run: cargo test -p otori-analysis -- --ignored

use std::io::Write;
use std::path::Path;

use otori_analysis::{models, AnalysisEngine};

/// Minimal PCM16 mono WAV writer — enough for a synthetic click track.
fn write_click_wav(path: &Path, bpm: f64, secs: f64, rate: u32) {
    let n = (secs * rate as f64) as usize;
    let period = (60.0 / bpm * rate as f64) as usize;
    let mut samples = vec![0i16; n];
    for (i, s) in samples.iter_mut().enumerate() {
        let since_click = i % period;
        if since_click < rate as usize / 100 {
            // 10ms decaying burst per beat.
            let env = 1.0 - since_click as f64 / (rate as f64 / 100.0);
            let osc = (i as f64 * 2.0 * std::f64::consts::PI * 1000.0 / rate as f64).sin();
            *s = (osc * env * i16::MAX as f64 * 0.8) as i16;
        }
    }
    let data_len = (samples.len() * 2) as u32;
    let mut f = std::fs::File::create(path).unwrap();
    f.write_all(b"RIFF").unwrap();
    f.write_all(&(36 + data_len).to_le_bytes()).unwrap();
    f.write_all(b"WAVEfmt ").unwrap();
    f.write_all(&16u32.to_le_bytes()).unwrap();
    f.write_all(&1u16.to_le_bytes()).unwrap(); // PCM
    f.write_all(&1u16.to_le_bytes()).unwrap(); // mono
    f.write_all(&rate.to_le_bytes()).unwrap();
    f.write_all(&(rate * 2).to_le_bytes()).unwrap();
    f.write_all(&2u16.to_le_bytes()).unwrap();
    f.write_all(&16u16.to_le_bytes()).unwrap();
    f.write_all(b"data").unwrap();
    f.write_all(&data_len.to_le_bytes()).unwrap();
    for s in &samples {
        f.write_all(&s.to_le_bytes()).unwrap();
    }
}

#[test]
#[ignore = "needs downloaded models (scripts/download-models.sh)"]
fn click_track_detects_known_bpm() {
    let models_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/models");
    let paths = models::resolve(&[&models_dir]).expect("models downloaded");
    let mut engine = AnalysisEngine::new(&paths).unwrap();

    let dir = std::env::temp_dir().join("otori-analysis-test");
    std::fs::create_dir_all(&dir).unwrap();
    let wav = dir.join("click128.wav");
    write_click_wav(&wav, 128.0, 30.0, 22050);

    let result = engine.analyze(&wav, None).unwrap();
    let verdict = result.verdict.expect("click track must not be beatless");
    assert!((verdict.bpm - 128.0).abs() < 0.5, "bpm = {}", verdict.bpm);
    assert!(verdict.bpm_max.is_none());
    assert!(result.head.is_some(), "steady click must anchor the head");
}
