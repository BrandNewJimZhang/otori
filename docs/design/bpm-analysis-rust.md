# Design: BPM analysis moves to Rust (Beat This! via beat-this)

Date: 2026-07-07
Status: approved design
Authorized by: ADR-0001 amendment A6

Replace the frontend's classical-DSP beat detector (`beatgrid.ts`
autocorrelation) with the Beat This! transformer model, running in
Rust through the `beat-this` crate (pure-Rust `rten` ONNX backend, no
Python, no system libraries). The founding motivation: the classical
detector's known failure modes — octave errors without a hint, low
confidence on weak-percussion material, ×1.5 errors on breakbeats —
are exactly the errors a curated DJ library cannot absorb, and Beat
This! is the current SOTA with a ready-made Rust port.

## What stays, what moves, what dies

- **Stays (unchanged)**: the trust model. External BPM is a hint,
  never a result; the detector owns the `bpm` column; `bpm_source`
  records `detected` / `detected+hint`. The schema does not change.
- **Stays**: the sweep loop shape — idle-priority, one track at a
  time, duty-cycle throttled, resumable via `bpm_analyzed_at IS NULL`.
- **Moves**: decoding and detection. Web Audio decode + `beatgrid.ts`
  DSP → symphonia decode + Beat This! inference inside a new
  `otori-analysis` crate. The WebView no longer decodes for analysis
  (it keeps decoding for *playback* — that half of ADR-0001 A1 is
  untouched).
- **Dies**: `beatgrid.ts`, `beatservice.ts`, and their tests. The
  sweep (`analysissweep.ts`) survives as a thin IPC pump.

## New crate: `otori-analysis`

Separate crate, not part of `otori-core`: core is bookkeeping and must
stay light for consumers that never analyze (inference pulls in rten +
symphonia + rubato, and model weights at runtime). Dependency
direction: `otori-analysis` → `otori-core` (for types only, if at
all); never the reverse.

```
otori-analysis
├── engine.rs    — beat-this wrapper: model loading, analyze(path, hint)
├── derive.rs    — pure functions: beats[] → verdict (TDD lives here)
└── models.rs    — model path resolution (single source of truth)
```

### derive.rs — from beat timestamps to the index's verdict

Beat This! outputs beat/downbeat timestamps in seconds. Everything
the index stores derives from that list with pure, synthetic-testable
functions (this is where the old `beatgrid.ts` semantics survive):

- **Steady tempo**: median inter-beat interval → BPM.
- **Soflan detection**: local BPM over a sliding window of beats;
  windows disagreeing > 5% → `bpm..bpm_max` range, confidence halved
  (same contract as before: a range is honest, a mean is a lie).
- **Confidence**: fraction of inter-beat intervals within tolerance
  of the local median (IBI consistency). Clean grid → ~1.0; sloppy
  or rubato material → low. Replaces autocorrelation peak strength;
  same 0..1 column, same < 0.4 "shaky" threshold downstream.
- **Hint reconciliation**: unchanged `applyHint` semantics (×0.5/1/2/3
  fold within 6%). Beat This! rarely makes octave errors, but the
  fold is what earns `detected+hint` provenance, and a curated hint
  should still anchor the octave on the rare miss.
- **Mix anchors**: head/tail 45 s windows, anchor = local median
  tempo + a real detected beat inside the window. Local steadiness
  check as before (both window halves agree within 5%). Strictly
  better input than before: actual beat positions instead of a folded
  envelope phase.
- **Beatless**: no beats returned, or IBI consistency below floor →
  `None`, recorded as analyzed (same "don't retry forever" contract).

### engine.rs — inference

- `BeatThis::new(&RtenRuntime, mel_path, beat_path)` once per process
  (lazy static in the Tauri state / CLI), `analyze_file(path)` per
  track. ~10 MB small model: verified F-measure ≥ 0.99 vs the Python
  reference; the 83 MB full model is not worth 8× the bundle.
- Inference runs on a blocking thread (`spawn_blocking` in Tauri).
  Cost ~1 s per minute of audio on Apple Silicon — heavier than the
  old DSP but entirely off the WebView main thread, and the sweep's
  duty-cycle pacing already absorbs it.
- Decode cap: keep 15 min like the old path; `truncated` still
  suppresses the tail anchor.

### Models: downloaded, not vendored

- `scripts/download-models.sh` fetches `mel_spectrogram.onnx`
  (~270 KB) and `beat_this_small.onnx` (~10 MB) from the beat-this-rs
  GitHub release, sha256-verified, into `src-tauri/models/`
  (gitignored). Binary weights do not enter git.
- Bundled as Tauri resources; resolved at runtime through one
  function in `models.rs` (resource dir in the app, `--models-dir`
  flag / env in the CLI). Missing models = fail fast with the
  download instruction in the message, not a silent skip.

## Analysis IPC collapses to one command

Old surface: frontend pulls `list_analysis_pending`, computes, pushes
`set_bpm` + `set_mix_anchors`. New surface:

- `analyze_track(track_id)` — Tauri command; reads path + hint from
  the index, runs the engine, persists verdict + anchors through the
  existing `analysis.rs` writers, returns the verdict for UI use.
- `list_analysis_pending` stays (the sweep still needs the worklist).
- `set_bpm` / `set_mix_anchors` IPC commands are **removed** (minimal
  public surface: their only caller was the sweep). The core functions
  stay — `analyze_track` calls them in-process.

`analysissweep.ts` becomes: list pending → `analyze_track(id)` each →
pace. The duty-cycle math keys off the IPC round-trip time, same as
today.

## Full reanalysis entry (core + CLI + GUI)

Reopening analysis today means a new hint, a tag rescan, or a
hand-written migration bump (v10 precedent). That was tolerable when
the algorithm never changed; it isn't anymore. Formal entry:

- **Core**: `reopen_analysis(conn, scope)` in `analysis.rs`, scope =
  `All` | `LowConfidence(f64)` | `Tracks(Vec<i64>)`. Sets
  `bpm_analyzed_at = NULL, mix_analyzed_at = NULL` for the scope.
  Hints and detected values stay in place until overwritten — the
  sweep re-verdicts; nothing blanks out meanwhile.
- **CLI**: `otori reanalyze [--low-confidence <t> | --track <id>...]`,
  dry-run by default printing the affected count, `--apply` to
  execute (matches the destructive-op contract).
- **GUI**: Backstage inspector "Reanalyze" action (single track =
  selected, plus a library-wide entry); fires `reopen_analysis` via
  IPC then re-arms the sweep.
- **Algorithm swap migration**: v12 resets all `*_analyzed_at` once,
  so every library re-verdicts under Beat This! automatically. Future
  algorithm tweaks use the reanalyze entry, not migrations.

## CLI parity: `otori analyze`

ADR-0001's parity consequence ("anything the GUI can do must be
expressible as a CLI call") was silently violated by A1 — detection
existed only inside the GUI. With the engine in Rust this is a thin
wrapper: `otori analyze [--pending | --track <id>...]` drains the
worklist headless, same engine, same writers, `--json` output. Agents
can now produce verdicts without a WebView.

## Status bar (analysis visibility)

The sweep is deliberately silent; combined with a reanalysis entry
that can queue thousands of tracks, invisible hours-long work reads
as "broken". One thin strip at the window bottom (below the player
bar), not a second toolbar:

- **Analysis**: `analyzing · N left` while the sweep runs (count from
  the sweep's own worklist, decremented locally — no new IPC); idle
  → library stats (`N tracks · M analyzed`).
- **Scan**: the existing scan progressbar (`App.tsx` scan-progress)
  relocates here, so all background state lives in one place.
- Click on the analysis segment → Backstage low-confidence view
  (future; not v1).
- Height ~24 px, text-only, no spinners; it must read as ambient
  state, not activity theater.

## Testing

- `derive.rs`: pure unit tests — synthetic beat lists (steady grid,
  soflan two-tempo, jittered, sparse, empty) drive every verdict
  branch. This is the TDD core, no models needed.
- `engine.rs`: integration test behind `#[ignore]` (needs downloaded
  models): synthetic click-track WAV → expect the known BPM ±0.5.
- Frontend: sweep test updates to the new IPC shape; status bar
  component test; dead `beatgrid.test.ts` / decode paths removed.

## Rejected alternatives

- **onnxruntime-web in the frontend** (route B): keeps ADR-0001 A1
  intact but ships a wasm runtime + model to the WebView, blocks the
  main thread or needs workers, and forecloses CLI parity. Rejected.
- **Improving the classical DSP** (route C): bounded win, octave
  errors remain structural. Rejected as primary; `derive.rs` keeps
  the classical *verdict semantics* (ranges, confidence, hints) which
  were never the weak part.
- **Full 83 MB model**: ≤1% F-measure gain for 8× the weight. Small
  model, revisit only on observed misses.
