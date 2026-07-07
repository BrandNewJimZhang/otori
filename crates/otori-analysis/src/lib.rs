//! Audio analysis engine: Beat This! (transformer beat tracking) via
//! the `beat-this` crate, plus pure derivation from beat timestamps
//! to the verdicts the index stores. Design:
//! docs/design/bpm-analysis-rust.md (ADR-0001 A6).

pub mod derive;
pub mod engine;
pub mod models;

pub use derive::{mix_anchors, tempo_verdict, MixAnchor, TempoVerdict};
pub use engine::AnalysisEngine;
