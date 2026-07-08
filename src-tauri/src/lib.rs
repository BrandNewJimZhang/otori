//! Ōtori desktop shell: thin IPC glue over otori-core (ADR-0001 §3).
//! No business logic lives here — commands translate between the
//! frontend and the core, nothing more.

use std::sync::Mutex;

use otori_core::{analysis, db, query, scan, write};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

/// One shared connection guarded by a mutex: single-writer by
/// construction, matching the L5 coexistence model (per-operation
/// pooling only if the UI ever blocks on long scans).
struct Library(Mutex<otori_core::Connection>);

/// Handles to the tray menu items whose label/enabled state mirrors
/// playback (`update_tray` command). The tray itself lives for the
/// app's lifetime; only these items ever change.
struct Tray {
    now_playing: MenuItem<tauri::Wry>,
    playpause: MenuItem<tauri::Wry>,
    prev: MenuItem<tauri::Wry>,
    next: MenuItem<tauri::Wry>,
}

/// The active analysis model id, shared across the sweep and the UI.
/// Starts at the registry default; the GUI syncs the user's pref into
/// it at startup (`set_analysis_model`) and on every switch.
struct ActiveModel(Mutex<&'static str>);

/// Directories the engine searches for model weights, in priority
/// order: the writable data dir (downloaded models live here) then the
/// bundled resource dir (the small model ships here). Built once per
/// app launch from the resolved paths. Returns Err if the data dir
/// can't be resolved — the resource dir alone is enough for small, but
/// standard needs the data dir to land in, so resolve both up front
/// and surface a failure as a setup error, not a later analysis miss.
fn model_search_dirs(app: &tauri::AppHandle) -> Result<Vec<std::path::PathBuf>, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("models");
    let resource = app
        .path()
        .resolve("models", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("resource models dir: {e}"))?;
    Ok(vec![data, resource])
}

/// Resolve model paths for `id` across the two search dirs, or the
/// registry default when `id` is None. The thin wrapper every analysis
/// command goes through — it keeps the search-order policy in one place.
fn resolve_models(
    app: &tauri::AppHandle,
    id: Option<&str>,
) -> Result<otori_analysis::ModelPaths, String> {
    let dirs = model_search_dirs(app)?;
    let dirs: Vec<&std::path::Path> = dirs.iter().map(std::path::PathBuf::as_path).collect();
    // unwrap_or (not unwrap_or_else): default_id returns `&'static str`,
    // which won't unify with the borrowed `&str` through unwrap_or_else's
    // fn-pointer bound; eager eval is a const slice lookup and sidesteps it.
    let id = id.unwrap_or(otori_analysis::models::default_id());
    otori_analysis::models::resolve_model(&dirs, id).map_err(|e| e.to_string())
}

/// Display-sleep blocker — keeps the monitor awake while Stage mode
/// plays and releases it on pause/leave, so a set doesn't dim mid-song.
///
/// The held resource is OS-specific but cheap and per-process:
/// - macOS: a `caffeinate -d` child (macOS-native, no dependency).
///   Killing the child releases the assertion; if Ōtori dies, the child
///   dies with it.
/// - Windows: a `SetThreadExecutionState(ES_CONTINUOUS |
///   ES_DISPLAY_REQUIRED)` call (kernel32, zero extra dependency —
///   `windows-sys` is already in the tree via Tauri). Release restores
///   `ES_CONTINUOUS`. The state is thread-local in Win32, so this lives
///   on the Tauri command thread that toggles it; an app crash naturally
///   clears it since the thread is gone.
/// - other unix: no-op — the platform has no single portable equivalent;
///   `xdg-screensaver`/D-Bus inhibition is a larger surface than a
///   pre-alpha port needs, so display sleep is simply not blocked there.
#[cfg(target_os = "macos")]
struct SleepBlocker(Mutex<Option<std::process::Child>>);

#[cfg(target_os = "windows")]
struct SleepBlocker(Mutex<bool>);

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
struct SleepBlocker(Mutex<()>);

impl Default for SleepBlocker {
    fn default() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self(Mutex::new(None))
        }
        #[cfg(target_os = "windows")]
        {
            Self(Mutex::new(false))
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Self(Mutex::new(()))
        }
    }
}

/// What `sleep_action` decided, so the command can layer the OS side
/// effect on top without re-deriving the state.
#[derive(Debug, PartialEq, Eq)]
enum SleepAction {
    Acquired,
    Released,
    NoOp,
}

/// Pure state machine over `(awake, currently held)`: decide whether to
/// acquire, release, or do nothing. Extracted so the idempotency rule
/// (no double-spawn, no double-tear-down on repeated Stage toggles) is
/// unit-testable without spawning processes or calling Win32. The caller
/// owns the actual held resource and mutates it only on Acquired/Released.
fn sleep_action(awake: bool, held: bool) -> SleepAction {
    match (awake, held) {
        (true, false) => SleepAction::Acquired,
        (false, true) => SleepAction::Released,
        _ => SleepAction::NoOp,
    }
}

/// Keep the display awake (Stage mode playing) or release it. Idempotent.
#[tauri::command(async)]
fn set_display_awake(state: tauri::State<'_, SleepBlocker>, awake: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        match sleep_action(awake, guard.is_some()) {
            SleepAction::Acquired => {
                let child = std::process::Command::new("/usr/bin/caffeinate")
                    .arg("-d")
                    .spawn()
                    .map_err(|e| format!("caffeinate: {e}"))?;
                *guard = Some(child);
            }
            SleepAction::Released => {
                if let Some(mut child) = guard.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
            SleepAction::NoOp => {}
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Power::{
            SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED,
        };
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        match sleep_action(awake, *guard) {
            SleepAction::Acquired => {
                // SAFETY: SetThreadExecutionState takes only flag bitfields
                // (compile-time constants here) and reads no pointers. It
                // sets thread-local execution state; documented reentrant.
                unsafe {
                    SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED);
                }
                *guard = true;
            }
            SleepAction::Released => {
                // SAFETY: as above; ES_CONTINUOUS alone clears the display
                // requirement — the conventional release idiom.
                unsafe {
                    SetThreadExecutionState(ES_CONTINUOUS);
                }
                *guard = false;
            }
            SleepAction::NoOp => {}
        }
        Ok(())
    }

    // No display-sleep blocking on other unix: the platform lacks a
    // single portable primitive, so the command is a successful no-op
    // rather than a hard error (display dimming is cosmetic, not a
    // playback failure).
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = state.0.lock().map_err(|e| e.to_string())?;
        let _ = awake;
        Ok(())
    }
}

#[tauri::command(async)]
fn scan_library(state: tauri::State<'_, Library>, dir: String) -> Result<scan::ScanReport, String> {
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    scan::scan(&mut conn, std::path::Path::new(&dir)).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn list_tracks(state: tauri::State<'_, Library>) -> Result<Vec<query::TrackRow>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    query::list_tracks(&conn).map_err(|e| e.to_string())
}

/// Per-field trust state for the inspector's provenance badges.
#[tauri::command(async)]
fn get_tag_provenance(
    state: tauri::State<'_, Library>,
    track_id: i64,
) -> Result<Vec<query::TagProvenance>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    query::tag_provenance(&conn, track_id).map_err(|e| e.to_string())
}

/// Mirror of write::FieldChange for IPC deserialization.
#[derive(serde::Deserialize)]
struct FieldChangeArg {
    field: String,
    value: String,
}

/// GUI tag save: the human-facing counterpart of `otori set --apply`.
/// One call = one journal transaction across all paths (batch undo).
/// Editing here is the oath — values land `human`-sourced, born
/// curated. Backup/snapshot/journal all happen inside the core.
#[tauri::command(async)]
fn set_tags(
    app: tauri::AppHandle,
    state: tauri::State<'_, Library>,
    paths: Vec<String>,
    changes: Vec<FieldChangeArg>,
) -> Result<Option<i64>, String> {
    let changes: Vec<write::FieldChange> = changes
        .into_iter()
        .map(|c| write::FieldChange { field: c.field, value: c.value })
        .collect();
    let edits: Vec<write::TrackChanges> = paths
        .into_iter()
        .map(|p| write::TrackChanges { path: p.into(), changes: changes.clone() })
        .collect();
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx_id = write::apply_set_many(&mut conn, &edits, write::Actor::Human { via: "gui" }, false)
        .map_err(|e| e.to_string())?;
    // The data_version watcher would catch this within ~1s; emit now so
    // the table refresh feels attached to the save, not to a poll.
    if tx_id.is_some() {
        let _ = app.emit("library-changed", ());
    }
    Ok(tx_id)
}

/// Analysis sweep, shell half (ADR-0001 A6): detection runs in Rust
/// (otori-analysis, Beat This!); the GUI only pulls the worklist and
/// asks for one track at a time. The engine loads models lazily on
/// the first call and lives for the app's lifetime.
#[tauri::command(async)]
fn list_analysis_pending(
    state: tauri::State<'_, Library>,
) -> Result<Vec<analysis::PendingTrack>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    analysis::list_analysis_pending(&conn).map_err(|e| e.to_string())
}

/// Lazily initialized beat-tracking engine. Behind its own mutex so a
/// long inference never blocks Library commands (table refresh, tag
/// saves) — only other analyses queue on it.
struct Analyzer(Mutex<Option<otori_analysis::AnalysisEngine>>);

/// Analyze one pending track (decode + Beat This! + persist verdict
/// and anchors). `(async)` moves it off the main thread — at ~1s per
/// minute of audio, running it sync would freeze the event loop for
/// the whole inference.
#[tauri::command(async)]
fn analyze_track(
    app: tauri::AppHandle,
    library: tauri::State<'_, Library>,
    analyzer: tauri::State<'_, Analyzer>,
    active: tauri::State<'_, ActiveModel>,
    track_id: i64,
) -> Result<otori_analysis::PersistedVerdict, String> {
    // Read the work item, then release the library lock for the slow part.
    let item = {
        let conn = library.0.lock().map_err(|e| e.to_string())?;
        analysis::list_analysis_pending(&conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|t| t.id == track_id)
            .ok_or_else(|| format!("track {track_id} is not pending analysis"))?
    };
    let mut engine_slot = analyzer.0.lock().map_err(|e| e.to_string())?;
    // Rebuild the engine if the active model changed since it was loaded —
    // a switch drops the slot, the next track reloads under the new model.
    let active_id = *active.0.lock().map_err(|e| e.to_string())?;
    let need_rebuild =
        engine_slot.as_ref().is_none_or(|e| e.model() != active_id);
    if need_rebuild {
        let models = resolve_models(&app, Some(active_id))?;
        *engine_slot = Some(otori_analysis::AnalysisEngine::new(&models).map_err(|e| e.to_string())?);
    }
    let engine = engine_slot.as_mut().expect("initialized above");

    let verdict = {
        // Inference holds only the engine lock; take the library lock
        // just for the final writes inside analyze_and_persist.
        let conn = library.0.lock().map_err(|e| e.to_string())?;
        otori_analysis::analyze_and_persist(&conn, engine, &item).map_err(|e| e.to_string())?
    };
    Ok(verdict)
}

/// Reopen analysis (GUI reanalyze entry; scope mirrors the CLI).
#[tauri::command(async)]
fn reopen_analysis(
    state: tauri::State<'_, Library>,
    track_ids: Option<Vec<i64>>,
    low_confidence: Option<f64>,
    model: Option<String>,
) -> Result<usize, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = match (&track_ids, low_confidence, &model) {
        (Some(ids), _, _) => analysis::ReopenScope::Tracks(ids),
        (None, Some(t), _) => analysis::ReopenScope::LowConfidence(t),
        (None, None, Some(m)) => {
            // Validate the id up front: a typo should fail fast, not
            // silently reopen every track (NULL analysis_model matches
            // "not m"). The registry is the SSOT for valid ids.
            if otori_analysis::models::find(m).is_none() {
                return Err(format!(
                    "unknown analysis model {m:?}; expected one of {}",
                    otori_analysis::models::MODELS
                        .iter()
                        .map(|x| x.id)
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            analysis::ReopenScope::Model(m.as_str())
        }
        (None, None, None) => analysis::ReopenScope::All,
    };
    analysis::reopen_analysis(&conn, scope).map_err(|e| e.to_string())
}

/// Set the active analysis model for the sweep. Mount-time sync from
/// the user's pref (no reopen); the next `analyze_track` loads the
/// engine under it. A bogus id fails fast — the pref layer should have
/// validated, but the registry is the SSOT, never trust a string.
#[tauri::command(async)]
fn set_analysis_model(active: tauri::State<'_, ActiveModel>, id: String) -> Result<(), String> {
    let model = otori_analysis::models::find(&id)
        .ok_or_else(|| format!("unknown analysis model {id:?}"))?;
    *active.0.lock().map_err(|e| e.to_string())? = model.id;
    Ok(())
}

/// Switch the active analysis model and reopen only foreign-model
/// verdicts so the sweep re-runs them under the new model. Drops the
/// cached engine so the next track reloads. Emits `library-changed` so
/// the table/status bar refresh. Same-model verdicts are kept: a
/// small→standard→small round trip must not re-run the whole library.
#[tauri::command(async)]
fn switch_analysis_model(
    app: tauri::AppHandle,
    library: tauri::State<'_, Library>,
    analyzer: tauri::State<'_, Analyzer>,
    active: tauri::State<'_, ActiveModel>,
    id: String,
) -> Result<usize, String> {
    let model = otori_analysis::models::find(&id)
        .ok_or_else(|| format!("unknown analysis model {id:?}"))?;
    // Set first: if reopening fails, the active id already matches the
    // new model, so the next sweep won't fight a stale engine.
    *active.0.lock().map_err(|e| e.to_string())? = model.id;
    *analyzer.0.lock().map_err(|e| e.to_string())? = None;
    let reopened = {
        let conn = library.0.lock().map_err(|e| e.to_string())?;
        analysis::reopen_analysis(&conn, analysis::ReopenScope::Model(model.id))
            .map_err(|e| e.to_string())?
    };
    let _ = app.emit("library-changed", ());
    Ok(reopened)
}

/// Which beat models the UI can offer: the registry, each marked with
/// whether its weights are present in the search dirs. The cycle button
/// shows all registered models; an unavailable one is a
/// download-and-switch, not a hard error. `activeId` is echoed back so
/// the UI doesn't need a separate read for the current selection.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisModelInfo {
    id: String,
    label: String,
    available: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisModels {
    active_id: String,
    models: Vec<AnalysisModelInfo>,
}

#[tauri::command(async)]
fn list_analysis_models(
    app: tauri::AppHandle,
    active: tauri::State<'_, ActiveModel>,
) -> Result<AnalysisModels, String> {
    let dirs = model_search_dirs(&app)?;
    let dirs: Vec<&std::path::Path> = dirs.iter().map(std::path::PathBuf::as_path).collect();
    let available = otori_analysis::models::available_ids(&dirs);
    let active_id = active.0.lock().map_err(|e| e.to_string())?.to_string();
    let models = otori_analysis::models::MODELS
        .iter()
        .map(|m| AnalysisModelInfo {
            id: m.id.to_string(),
            label: m.label.to_string(),
            available: available.contains(&m.id),
        })
        .collect();
    Ok(AnalysisModels { active_id, models })
}

/// Download a model's weights into the writable models dir, verifying
/// the SHA-256 from the matching `.sha256` sidecar the upstream release
/// ships. Pure HTTP + fs — no Tauri in the inner logic, so the
/// verify-and-write step is unit-testable without the app. `(async)`
/// keeps the multi-MB download off the main thread; the GUI disables
/// the cycle button while the `download_analysis_model` promise is in
/// flight.
#[tauri::command(async)]
fn download_analysis_model(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let url = otori_analysis::models::download_url(&id)
        .ok_or_else(|| format!("model {id:?} has no download URL (it may be bundled)"))?;
    let data_dir = model_search_dirs(&app)?
        .into_iter()
        .next()
        .ok_or_else(|| "models data dir unresolved".to_string())?;
    let model = otori_analysis::models::find(&id)
        .ok_or_else(|| format!("unknown analysis model {id:?}"))?;
    let dest = data_dir.join(model.file);

    let bytes = http_get_bytes(url)?;
    // Fetch the `.sha256` sidecar the upstream release ships; a parse
    // failure of the sidecar is a download error, not a skip — a
    // download we can't verify must not load as a model.
    let sidecar = http_get_text(&format!("{url}.sha256"))?;
    let expected = parse_sha256_sidecar(&sidecar)?;
    verify_sha256(&bytes, &expected)?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("mkdir {}: {e}", data_dir.display()))?;
    std::fs::write(&dest, &bytes)
        .map_err(|e| format!("write {}: {e}", dest.display()))?;
    let _ = app.emit("analysis-model-downloaded", &id);
    Ok(())
}

/// HTTP GET returning the full body as bytes. Mirrors otori-core's
/// private helper (kept here so the shell is self-contained and the
/// model-download path doesn't grow a new cross-crate dependency).
fn http_get_bytes(url: &str) -> Result<Vec<u8>, String> {
    ureq::get(url)
        .header("User-Agent", "otori")
        .call()
        .map_err(|e| format!("GET {url}: {e}"))?
        .body_mut()
        .read_to_vec()
        .map_err(|e| format!("read {url}: {e}"))
}

/// HTTP GET returning the body as text (used for the `.sha256` sidecar).
fn http_get_text(url: &str) -> Result<String, String> {
    ureq::get(url)
        .header("User-Agent", "otori")
        .call()
        .map_err(|e| format!("GET {url}: {e}"))?
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("read {url}: {e}"))
}

/// Parse a `sha256sum`-style sidecar (`<hash>  <filename>` or bare
/// `<hash>`), returning lowercase hex or an error if malformed. The
/// upstream release ships `<hash>  beat_this.onnx`; tolerate the bare
/// form too so a future asset change doesn't silently break.
fn parse_sha256_sidecar(text: &str) -> Result<String, String> {
    let first = text.split_whitespace().next().ok_or_else(|| "empty sha256 sidecar".to_string())?;
    if first.len() != 64 || !first.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("malformed sha256 sidecar: {first:?}"));
    }
    Ok(first.to_ascii_lowercase())
}

/// Verify `data` against a lowercase-hex SHA-256 `expected`. Fails fast
/// on mismatch — a corrupted download must not load as a model. Pure so
/// the check is unit-testable.
fn verify_sha256(data: &[u8], expected: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data);
    let got = hasher.finalize();
    let got_hex: String = got.iter().map(|b| format!("{b:02x}")).collect();
    if got_hex == expected {
        Ok(())
    } else {
        Err(format!("sha256 mismatch: expected {expected}, got {got_hex}"))
    }
}

#[tauri::command(async)]
fn get_lyrics(path: String) -> Result<Option<otori_core::lyrics::LyricsDoc>, String> {
    otori_core::lyrics::resolve(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

/// Persist the user's per-track lyrics sync nudge (render-time state
/// in the index; the LRC source is never rewritten).
#[tauri::command(async)]
fn set_lyrics_offset(
    state: tauri::State<'_, Library>,
    track_id: i64,
    offset_ms: i64,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    otori_core::lyrics::set_offset(&conn, track_id, offset_ms).map_err(|e| e.to_string())
}

/// Cover art payload: the data URL plus where it came from — the
/// inspector shows "Remove cover" only for embedded pictures.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtworkInfo {
    data_url: String,
    /// "embedded" | "sidecar" | "folder"
    source: &'static str,
}

/// Cover art as a data URL, or None. Resolution chain lives in
/// otori-core (embedded → sidecar image → folder cover) so CLI and
/// GUI agree on what art a track has.
#[tauri::command(async)]
fn get_artwork(path: String) -> Result<Option<ArtworkInfo>, String> {
    use base64::Engine;
    let art = otori_core::artwork::resolve(std::path::Path::new(&path))
        .map_err(|e| e.to_string())?;
    Ok(art.map(|a| {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&a.data);
        ArtworkInfo { data_url: format!("data:{};base64,{b64}", a.mime), source: a.source }
    }))
}

/// Strip the embedded cover (inspector "Remove cover"). Full L2 in the
/// core; the journal cannot restore picture bytes, so the UI must not
/// offer `otori undo` for the returned tx (recovery = backups).
#[tauri::command(async)]
fn remove_artwork(
    app: tauri::AppHandle,
    state: tauri::State<'_, Library>,
    path: String,
) -> Result<i64, String> {
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx_id = write::remove_artwork(
        &mut conn,
        std::path::Path::new(&path),
        write::Actor::Human { via: "gui" },
    )
    .map_err(|e| e.to_string())?;
    // Cover thumbnails re-resolve through the same refresh pipe.
    let _ = app.emit("library-changed", ());
    Ok(tx_id)
}

/// Raw lyrics text + source for the inspector editor (unparsed — the
/// editor round-trips the human's exact text).
#[derive(serde::Serialize)]
struct RawLyrics {
    /// "embedded" | "sidecar"
    source: &'static str,
    text: String,
}

#[tauri::command(async)]
fn get_lyrics_raw(path: String) -> Result<Option<RawLyrics>, String> {
    otori_core::lyrics::read_raw(std::path::Path::new(&path))
        .map(|r| r.map(|(source, text)| RawLyrics { source, text }))
        .map_err(|e| e.to_string())
}

/// Inspector lyrics save: replace the sidecar `.lrc` wholesale — the
/// human decision the agent path (`write_sidecar`) refuses to make.
/// No event: no table column shows lyrics; the panel re-reads itself.
#[tauri::command(async)]
fn set_lyrics_raw(path: String, text: String) -> Result<(), String> {
    otori_core::lyrics::overwrite_sidecar(std::path::Path::new(&path), &text)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Status-bar menu, frontend contract: the UI mirrors playback state
/// here on every track/pause change (`title: None` = nothing playing).
/// Deliberately sync (main thread): set_text/set_enabled dispatch to
/// the main thread internally, so running here skips that hop — and
/// the work is a handful of NSMenu mutations, far below frame budget.
#[tauri::command]
fn update_tray(state: tauri::State<'_, Tray>, title: Option<String>, paused: bool) -> Result<(), String> {
    let playing = title.is_some();
    state
        .now_playing
        .set_text(title.unwrap_or_else(|| "Nothing playing".into()))
        .map_err(|e| e.to_string())?;
    state
        .playpause
        .set_text(if paused { "Play" } else { "Pause" })
        .map_err(|e| e.to_string())?;
    for item in [&state.playpause, &state.prev, &state.next] {
        item.set_enabled(playing).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// macOS status-bar menu. Left click toggles the mini player panel;
/// right click opens this menu. Item clicks are forwarded to the
/// frontend as a `tray-command` event ("playpause" / "next" / "prev")
/// so tray and on-screen transport share one set of handlers.
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();
    let now_playing = MenuItem::with_id(handle, "now_playing", "Nothing playing", false, None::<&str>)?;
    let playpause = MenuItem::with_id(handle, "playpause", "Play", false, None::<&str>)?;
    let prev = MenuItem::with_id(handle, "prev", "Previous", false, None::<&str>)?;
    let next = MenuItem::with_id(handle, "next", "Next", false, None::<&str>)?;
    let show = MenuItem::with_id(handle, "show", "Show Ōtori", true, None::<&str>)?;
    let menu = Menu::with_items(
        handle,
        &[
            &now_playing,
            &PredefinedMenuItem::separator(handle)?,
            &playpause,
            &prev,
            &next,
            &PredefinedMenuItem::separator(handle)?,
            &show,
            &PredefinedMenuItem::quit(handle, Some("Quit Ōtori"))?,
        ],
    )?;

    TrayIconBuilder::with_id("main")
        // Dedicated template mark (transparent bg, alpha-only): the app
        // icon's dark tile renders as a solid blob in template mode.
        .icon(tauri::include_image!("icons/tray-icon.png"))
        .icon_as_template(true)
        .menu(&menu)
        // Menu stays on right click only; left click opens the panel.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle_mini_panel(tray.app_handle(), rect);
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            id @ ("playpause" | "next" | "prev") => {
                let _ = app.emit("tray-command", id);
            }
            _ => {}
        })
        .build(app)?;

    app.manage(Tray { now_playing, playpause, prev, next });
    Ok(())
}

/// Mini player panel dimensions (logical px). Width also drives the
/// centering math; keep in sync with .mini-panel CSS in App.css.
const MINI_PANEL_SIZE: (f64, f64) = (340.0, 132.0);

/// Where the mini panel opens: centered under the tray icon, clamped
/// into the monitor's work area. Pure math, unit-tested; all inputs in
/// the same (physical or logical) coordinate space.
fn mini_panel_origin(
    icon_pos: (f64, f64),
    icon_size: (f64, f64),
    panel_size: (f64, f64),
    work_pos: (f64, f64),
    work_size: (f64, f64),
) -> (f64, f64) {
    let x = icon_pos.0 + icon_size.0 / 2.0 - panel_size.0 / 2.0;
    let x = x.max(work_pos.0).min(work_pos.0 + work_size.0 - panel_size.0);
    let y = (icon_pos.1 + icon_size.1).max(work_pos.1);
    (x, y)
}

/// Left-click on the tray icon: show the mini player under the icon,
/// or hide it if it's already up. The window is created once at setup
/// (hidden) and repositioned per click; `#mini` routes the shared
/// frontend bundle to the panel UI.
fn toggle_mini_panel(app: &tauri::AppHandle, tray_rect: tauri::Rect) {
    let Some(win) = app.get_webview_window("mini") else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    let scale = win.scale_factor().unwrap_or(1.0);
    let icon_pos = tray_rect.position.to_logical::<f64>(scale);
    let icon_size = tray_rect.size.to_logical::<f64>(scale);
    // Work area of the monitor hosting the tray icon (menu bar height
    // etc. already subtracted); falls back to opening flush below.
    let (work_pos, work_size) = app
        .monitor_from_point(icon_pos.x + icon_size.width / 2.0, icon_pos.y + 1.0)
        .ok()
        .flatten()
        .map(|m| {
            let wa = m.work_area();
            (
                wa.position.to_logical::<f64>(scale),
                wa.size.to_logical::<f64>(scale),
            )
        })
        .map(|(p, s)| ((p.x, p.y), (s.width, s.height)))
        .unwrap_or(((icon_pos.x - 2000.0, icon_pos.y + icon_size.height), (4000.0, 4000.0)));
    let (x, y) = mini_panel_origin(
        (icon_pos.x, icon_pos.y),
        (icon_size.width, icon_size.height),
        MINI_PANEL_SIZE,
        work_pos,
        work_size,
    );
    let _ = win.set_position(tauri::LogicalPosition::new(x, y + MINI_PANEL_GAP));
    let _ = win.show();
    let _ = win.set_focus();
    // Ask the main window for a state snapshot so the panel is fresh
    // even if it missed earlier np-state broadcasts.
    let _ = app.emit("np-refresh", ());
}

/// Gap between the menu bar bottom and the panel, matching NSMenu.
const MINI_PANEL_GAP: f64 = 6.0;

/// The hidden mini-player window, created once at startup. Frameless,
/// transparent (rounded corners drawn by CSS), skips the Dock/taskbar,
/// follows the active Space, and auto-hides on focus loss like NSMenu.
fn setup_mini_panel(app: &tauri::App) -> tauri::Result<()> {
    let win = tauri::WebviewWindowBuilder::new(
        app,
        "mini",
        tauri::WebviewUrl::App("index.html#mini".into()),
    )
    .inner_size(MINI_PANEL_SIZE.0, MINI_PANEL_SIZE.1)
    .decorations(false)
    .transparent(true)
    .shadow(true)
    .resizable(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .visible(false)
    .build()?;

    // NSMenu behavior: clicking anywhere else dismisses the panel.
    let handle = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            let _ = handle.hide();
        }
    });
    Ok(())
}

/// macOS menu bar. Items forward to the frontend as `menu-command`
/// events (same handler set as the tray/transport). The Edit submenu's
/// predefined roles are what make ⌘C/⌘V/⌘X/⌘A work inside the
/// webview's text fields on macOS — do not remove them. In-app keys
/// (Space, S, arrows) stay in the webview router; menu items carry
/// accelerators only where the webview doesn't already own the chord.
fn setup_app_menu(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();
    let app_menu = Submenu::with_items(
        handle,
        "Ōtori",
        true,
        &[
            &PredefinedMenuItem::about(handle, None, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, Some("Quit Ōtori"))?,
        ],
    )?;
    let file = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &MenuItem::with_id(handle, "menu_scan", "Scan Folder…", true, Some("CmdOrCtrl+O"))?,
            &MenuItem::with_id(handle, "menu_reanalyze", "Reanalyze Library", true, None::<&str>)?,
        ],
    )?;
    let edit = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            // ⌘A in text fields needs this role too (same wry mechanism
            // as the clipboard trio). The Backstage table keeps its own
            // ⌘A: the webview router preventDefaults it in the global
            // zone, so the accelerator only fires where routing is
            // "native" — i.e. inside inputs/textareas.
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;
    let playback = Submenu::with_items(
        handle,
        "Playback",
        true,
        &[
            &MenuItem::with_id(handle, "menu_playpause", "Play/Pause", true, None::<&str>)?,
            &MenuItem::with_id(handle, "menu_next", "Next Track", true, None::<&str>)?,
            &MenuItem::with_id(handle, "menu_prev", "Previous Track", true, None::<&str>)?,
        ],
    )?;
    let view = Submenu::with_items(
        handle,
        "View",
        true,
        &[
            &MenuItem::with_id(handle, "menu_stage", "Toggle Stage", true, None::<&str>)?,
            // ⌘I lives in the webview key router; no accelerator here.
            &MenuItem::with_id(handle, "menu_inspector", "Toggle Inspector", true, None::<&str>)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::fullscreen(handle, None)?,
        ],
    )?;
    let menu = Menu::with_items(handle, &[&app_menu, &file, &edit, &playback, &view])?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if let Some(cmd) = event.id().as_ref().strip_prefix("menu_") {
            let _ = app.emit("menu-command", cmd);
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let path = db::default_path()?;
            let conn = db::open(&path)?;
            app.manage(Library(Mutex::new(conn)));
            app.manage(SleepBlocker::default());
            app.manage(Analyzer(Mutex::new(None)));
            app.manage(ActiveModel(Mutex::new(otori_analysis::models::default_id())));
            spawn_library_watcher(app.handle().clone(), path.clone());
            spawn_launch_rescan(app.handle().clone(), path);
            setup_tray(app)?;
            setup_mini_panel(app)?;
            setup_app_menu(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_library,
            list_tracks,
            get_tag_provenance,
            set_tags,
            get_lyrics,
            get_lyrics_raw,
            set_lyrics_raw,
            set_lyrics_offset,
            get_artwork,
            remove_artwork,
            update_tray,
            set_display_awake,
            list_analysis_pending,
            analyze_track,
            reopen_analysis,
            set_analysis_model,
            switch_analysis_model,
            list_analysis_models,
            download_analysis_model
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Rescan-on-launch (PRODUCT.md: rescan-on-launch + manual refresh
/// instead of FSEvents watching). Runs on its own connection off the
/// main thread so startup never blocks on a large library walk; the
/// data_version watcher turns its commit into `library-changed`, so
/// the UI refreshes through the same path as any external writer.
/// Backfills duration_secs for pre-v3 libraries as a side effect.
fn spawn_launch_rescan(app: tauri::AppHandle, db_path: std::path::PathBuf) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        let Ok(mut conn) = db::open(&db_path) else {
            eprintln!("launch rescan: cannot open {}", db_path.display());
            return;
        };
        match scan::rescan_all(&mut conn) {
            // No-commit outcomes (empty roots / nothing changed) still
            // notify: a pre-v4 library has no roots recorded yet, and
            // the UI treats the event as a cheap refresh either way.
            Ok(_) => {
                // Pre-v4 libraries have no roots, so the rescan can't
                // reach their NULL durations — fill them directly.
                if let Err(e) = scan::backfill_durations(&mut conn) {
                    eprintln!("duration backfill failed: {e}");
                }
                let _ = app.emit("library-changed", ());
            }
            Err(e) => eprintln!("launch rescan failed: {e}"),
        }
    });
}

/// L5 coexistence, shell side: when an agent edits the library from the
/// CLI, the GUI must reflect it live. SQLite's `PRAGMA data_version`
/// increments (per connection) whenever *another* connection commits,
/// which is exactly the external-writer signal — so this watcher uses
/// its own read-only connection and polls cheaply (~1s, one PRAGMA).
/// Contract for the frontend: listen for the `library-changed` Tauri
/// event (no payload) and re-fetch whatever it displays.
fn spawn_library_watcher(app: tauri::AppHandle, db_path: std::path::PathBuf) {
    std::thread::spawn(move || {
        let Ok(conn) = db::open(&db_path) else {
            // Watcher is an enhancement; its absence must not kill the app.
            eprintln!("library watcher: cannot open {}", db_path.display());
            return;
        };
        let read_version =
            |c: &otori_core::Connection| c.query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0));
        let Ok(mut last) = read_version(&conn) else { return };
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            match read_version(&conn) {
                Ok(v) if v != last => {
                    last = v;
                    let _ = app.emit("library-changed", ());
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!("library watcher stopped: {e}");
                    return;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    // main dropped rten_thread_cap (the thread-cap helper + its tests were
    // removed); the windows port added sleep_action/SleepAction. Merge =
    // neither rten_thread_cap, both sleep symbols.
    use super::{mini_panel_origin, parse_sha256_sidecar, sleep_action, verify_sha256, SleepAction};

    #[test]
    fn mini_panel_centers_under_the_tray_icon() {
        // Icon at x=1000 w=30, panel w=300 → centered: 1000+15-150.
        let (x, y) = mini_panel_origin(
            (1000.0, 0.0),
            (30.0, 24.0),
            (300.0, 180.0),
            (0.0, 25.0),
            (1440.0, 875.0),
        );
        assert_eq!((x, y), (865.0, 25.0));
    }

    #[test]
    fn mini_panel_clamps_to_the_right_screen_edge() {
        // Icon near the right edge: panel must not overflow the work area.
        let (x, _) = mini_panel_origin(
            (1420.0, 0.0),
            (30.0, 24.0),
            (300.0, 180.0),
            (0.0, 25.0),
            (1440.0, 875.0),
        );
        assert_eq!(x, 1140.0); // work right edge 1440 - panel 300
    }

    #[test]
    fn mini_panel_clamps_to_the_left_screen_edge() {
        let (x, _) = mini_panel_origin(
            (10.0, 0.0),
            (30.0, 24.0),
            (300.0, 180.0),
            (0.0, 25.0),
            (1440.0, 875.0),
        );
        assert_eq!(x, 0.0);
    }

    #[test]
    fn mini_panel_opens_below_the_menu_bar() {
        // Work area starts under the menu bar (y=25); the tray rect
        // bottom (0+24) is above it, so the panel lands at the work top.
        let (_, y) = mini_panel_origin(
            (700.0, 0.0),
            (30.0, 24.0),
            (300.0, 180.0),
            (0.0, 25.0),
            (1440.0, 875.0),
        );
        assert_eq!(y, 25.0);
    }

    #[test]
    fn commands_run_off_the_main_thread() {
        // Tauri v2 runs sync commands ON THE MAIN THREAD ("Commands
        // without the async keyword are executed on the main thread
        // unless defined with #[tauri::command(async)]"). A slow sync
        // command (decode, inference, big SELECT) freezes the whole
        // event loop — the 1s UI stalls this app must never have. So:
        // every command must be `(async)` except update_tray, which
        // mutates NSMenu items and therefore must stay on main.
        let src = include_str!("lib.rs");
        let mut bare_command_fns = Vec::new();
        let lines: Vec<&str> = src.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if line.trim() != "#[tauri::command]" {
                continue;
            }
            // The next `fn` line names the offending command.
            let name = lines[i + 1..]
                .iter()
                .find_map(|l| l.trim().strip_prefix("fn ").map(|r| {
                    r.split('(').next().unwrap_or(r).to_string()
                }))
                .unwrap_or_else(|| "<unknown>".into());
            bare_command_fns.push(name);
        }
        assert_eq!(
            bare_command_fns,
            vec!["update_tray".to_string()],
            "sync #[tauri::command] runs on the main thread and stalls the UI; \
             mark it #[tauri::command(async)] (only update_tray may stay sync)"
        );
    }

    #[test]
    fn sleep_action_truth_table_is_idempotent() {
        // The pure decision over (want_awake, currently_held). The two
        // NoOp cells are the idempotency contract: the frontend toggles
        // on every Stage transition, so a repeated awake=true while
        // already held must not re-spawn caffeinate / re-call Win32, and
        // a repeated awake=false while released must not tear down twice.
        use SleepAction::*;
        assert_eq!(sleep_action(true, false), Acquired);
        assert_eq!(sleep_action(true, true), NoOp);
        assert_eq!(sleep_action(false, true), Released);
        assert_eq!(sleep_action(false, false), NoOp);
    }

    #[test]
    fn sleep_action_caller_round_trip_does_not_double_acquire() {
        // Simulate the caller layering the OS side effect on the pure
        // decision: it only mutates `held` on Acquired/Released. A
        // burst of identical toggles must leave held set exactly once
        // (no double-spawn) and clear exactly once (no double-release).
        let mut held = false;
        for awake in [true, true, true, false, false, true, false, false] {
            match sleep_action(awake, held) {
                SleepAction::Acquired => held = true,
                SleepAction::Released => held = false,
                SleepAction::NoOp => {}
            }
        }
        assert!(!held, "final release must clear; no leaked hold");
    }

    #[test]
    fn sha256_sidecar_parses_sha256sum_format() {
        // The upstream release ships "<hash>  beat_this.onnx"; the first
        // whitespace token is the hash, rest (filename) is ignored.
        let s = parse_sha256_sidecar(
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789  beat_this.onnx",
        )
        .unwrap();
        assert_eq!(s, "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");
    }

    #[test]
    fn sha256_sidecar_parses_bare_hash() {
        // Tolerate the bare form so a future asset change doesn't break.
        let s = parse_sha256_sidecar(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        )
        .unwrap();
        assert_eq!(s, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    }

    #[test]
    fn sha256_sidecar_rejects_short_and_non_hex() {
        assert!(parse_sha256_sidecar("tooshort").is_err());
        // 64 chars but with a non-hex char in the middle.
        assert!(parse_sha256_sidecar(
            "zzz3456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        )
        .is_err());
    }

    #[test]
    fn verify_sha256_accepts_a_matching_digest() {
        // "abc" → the well-known SHA-256; prove the verifier accepts it.
        let expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        verify_sha256(b"abc", expected).unwrap();
    }

    #[test]
    fn verify_sha256_rejects_a_mismatch() {
        // A mismatched digest must fail — a corrupted download must not
        // load as a model.
        let wrong = "0000000000000000000000000000000000000000000000000000000000000000";
        assert!(verify_sha256(b"abc", wrong).is_err());
    }
}
