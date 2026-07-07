//! Verdict derivation from beat timestamps: the semantics carried
//! over from the retired frontend detector (beatgrid.ts) — steady vs
//! soflan ranges, IBI-consistency confidence, hint octave folding,
//! per-end mix anchors.

use otori_analysis::derive::{mix_anchors, tempo_verdict};

/// Synthetic click grid: `bpm` for `secs` seconds starting at `start`.
fn grid(bpm: f64, secs: f64, start: f64) -> Vec<f32> {
    let period = 60.0 / bpm;
    let mut beats = Vec::new();
    let mut t = start;
    while t < start + secs {
        beats.push(t as f32);
        t += period;
    }
    beats
}

#[test]
fn steady_grid_reports_single_bpm() {
    let v = tempo_verdict(&grid(120.0, 60.0, 0.0), None).unwrap();
    assert!((v.bpm - 120.0).abs() < 0.5, "bpm = {}", v.bpm);
    assert!(v.bpm_max.is_none());
    assert!(v.confidence > 0.9, "confidence = {}", v.confidence);
    assert!(!v.hint_applied);
}

#[test]
fn empty_and_sparse_are_beatless() {
    assert!(tempo_verdict(&[], None).is_none());
    // 5 beats can't establish a grid.
    assert!(tempo_verdict(&grid(120.0, 2.4, 0.0), None).is_none());
}

#[test]
fn tempo_change_reports_range_with_halved_confidence() {
    let mut beats = grid(120.0, 60.0, 0.0);
    beats.extend(grid(150.0, 60.0, 60.0));
    let v = tempo_verdict(&beats, None).unwrap();
    assert!((v.bpm - 120.0).abs() < 2.0, "range floor = {}", v.bpm);
    let max = v.bpm_max.expect("soflan must report a range");
    assert!((max - 150.0).abs() < 2.0, "range ceiling = {max}");
    let steady = tempo_verdict(&grid(120.0, 60.0, 0.0), None).unwrap();
    assert!(v.confidence < steady.confidence);
}

#[test]
fn heavy_jitter_lowers_confidence_but_keeps_tempo() {
    // Alternating ±40ms on a 500ms period: IBIs swing 16% around the
    // median — the grid is right but nothing to beat-match against.
    let beats: Vec<f32> = (0..120)
        .map(|i| (i as f64 * 0.5 + if i % 2 == 0 { 0.04 } else { -0.04 }) as f32)
        .collect();
    let v = tempo_verdict(&beats, None).unwrap();
    assert!((v.bpm - 120.0).abs() < 3.0, "bpm = {}", v.bpm);
    assert!(v.confidence < 0.5, "confidence = {}", v.confidence);
}

#[test]
fn harmonic_hint_folds_octave_and_marks_verified() {
    // Model tracked half-time feel at 85; a curated 170 tag anchors it.
    let v = tempo_verdict(&grid(85.0, 60.0, 0.0), Some(170.0)).unwrap();
    assert!((v.bpm - 170.0).abs() < 1.0, "bpm = {}", v.bpm);
    assert!(v.hint_applied);
}

#[test]
fn exact_hint_confirms_without_changing_value() {
    let v = tempo_verdict(&grid(120.0, 60.0, 0.0), Some(120.0)).unwrap();
    assert!((v.bpm - 120.0).abs() < 0.5);
    assert!(v.hint_applied);
}

#[test]
fn non_harmonic_hint_is_ignored() {
    let v = tempo_verdict(&grid(120.0, 60.0, 0.0), Some(133.0)).unwrap();
    assert!((v.bpm - 120.0).abs() < 0.5, "measurement wins: {}", v.bpm);
    assert!(!v.hint_applied);
}

#[test]
fn ranges_never_fold_onto_hints() {
    // A soflan range is a measurement, not an octave ambiguity.
    let mut beats = grid(120.0, 60.0, 0.0);
    beats.extend(grid(150.0, 60.0, 60.0));
    let v = tempo_verdict(&beats, Some(240.0)).unwrap();
    assert!(v.bpm_max.is_some());
    assert!(!v.hint_applied);
}

#[test]
fn steady_track_anchors_both_ends() {
    let beats = grid(128.0, 180.0, 0.25);
    let (head, tail) = mix_anchors(&beats, 180.0, false);
    let head = head.expect("head anchor");
    let tail = tail.expect("tail anchor");
    assert!((head.bpm - 128.0).abs() < 0.5);
    assert!((tail.bpm - 128.0).abs() < 0.5);
    // Anchor beats must be real beats inside their windows.
    assert!((head.beat_sec - 0.25).abs() < 0.01, "head beat = {}", head.beat_sec);
    assert!(tail.beat_sec >= 135.0 && tail.beat_sec <= 180.0, "tail beat = {}", tail.beat_sec);
}

#[test]
fn truncated_decode_refuses_tail_anchor() {
    let beats = grid(128.0, 180.0, 0.0);
    let (head, tail) = mix_anchors(&beats, 180.0, true);
    assert!(head.is_some());
    assert!(tail.is_none(), "a truncated tail is not the tail that will play");
}

#[test]
fn tempo_change_inside_window_refuses_that_anchor() {
    // 120 BPM until 150s, then 160 — the change sits inside the tail
    // window (135s..180s), so its halves disagree.
    let mut beats = grid(120.0, 150.0, 0.0);
    beats.extend(grid(160.0, 30.0, 150.0));
    let (head, tail) = mix_anchors(&beats, 180.0, false);
    assert!(head.is_some());
    assert!(tail.is_none());
}

#[test]
fn beatless_window_refuses_anchor() {
    // Beats only in the first 60s of a 180s track: tail window empty.
    let beats = grid(128.0, 60.0, 0.0);
    let (head, tail) = mix_anchors(&beats, 180.0, false);
    assert!(head.is_some());
    assert!(tail.is_none());
}
