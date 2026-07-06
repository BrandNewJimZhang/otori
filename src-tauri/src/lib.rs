//! Ōtori desktop shell: thin IPC glue over otori-core (ADR-0001 §3).
//! No business logic lives here — commands translate between the
//! frontend and the core, nothing more.

use std::sync::Mutex;

use otori_core::{analysis, db, query, scan};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
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

/// Display-sleep blocker: a `caffeinate -d` child (macOS-native, no
/// dependency) held while Stage mode plays. Dropping/killing the child
/// releases the assertion; if Ōtori dies, the child dies with it.
struct SleepBlocker(Mutex<Option<std::process::Child>>);

/// Keep the display awake (Stage mode playing) or release it. Idempotent.
#[tauri::command]
fn set_display_awake(state: tauri::State<'_, SleepBlocker>, awake: bool) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    match (awake, guard.as_mut()) {
        (true, None) => {
            let child = std::process::Command::new("/usr/bin/caffeinate")
                .arg("-d")
                .spawn()
                .map_err(|e| format!("caffeinate: {e}"))?;
            *guard = Some(child);
        }
        (false, Some(child)) => {
            let _ = child.kill();
            let _ = child.wait();
            *guard = None;
        }
        _ => {}
    }
    Ok(())
}

#[tauri::command]
fn scan_library(state: tauri::State<'_, Library>, dir: String) -> Result<scan::ScanReport, String> {
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    scan::scan(&mut conn, std::path::Path::new(&dir)).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_tracks(state: tauri::State<'_, Library>) -> Result<Vec<query::TrackRow>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    query::list_tracks(&conn).map_err(|e| e.to_string())
}

/// BPM sweep, shell half: the GUI decodes and detects (Web Audio is
/// the only decoder in the stack); these two commands let it pull the
/// worklist and persist outcomes into the index.
#[tauri::command]
fn list_bpm_pending(
    state: tauri::State<'_, Library>,
) -> Result<Vec<analysis::PendingTrack>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    analysis::list_bpm_pending(&conn).map_err(|e| e.to_string())
}

/// Mirror of analysis::DetectedBpm for IPC deserialization.
#[derive(serde::Deserialize)]
struct DetectedBpmArg {
    bpm: f64,
    bpm_max: Option<f64>,
    confidence: f64,
}

#[tauri::command]
fn set_bpm(
    state: tauri::State<'_, Library>,
    track_id: i64,
    detected: Option<DetectedBpmArg>,
    used_hint: bool,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let detected = detected.map(|d| analysis::DetectedBpm {
        bpm: d.bpm,
        bpm_max: d.bpm_max,
        confidence: d.confidence,
    });
    match (detected, used_hint) {
        (Some(d), true) => analysis::set_bpm_verified(&conn, track_id, d),
        (d, _) => analysis::set_bpm(&conn, track_id, d),
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_lyrics(path: String) -> Result<Option<otori_core::lyrics::LyricsDoc>, String> {
    otori_core::lyrics::resolve(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

/// Cover art as a data URL, or None. Resolution chain lives in
/// otori-core (embedded → sidecar image → folder cover) so CLI and
/// GUI agree on what art a track has.
#[tauri::command]
fn get_artwork(path: String) -> Result<Option<String>, String> {
    use base64::Engine;
    let art = otori_core::artwork::resolve(std::path::Path::new(&path))
        .map_err(|e| e.to_string())?;
    Ok(art.map(|a| {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&a.data);
        format!("data:{};base64,{b64}", a.mime)
    }))
}

/// Status-bar menu, frontend contract: the UI mirrors playback state
/// here on every track/pause change (`title: None` = nothing playing).
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

/// macOS status-bar menu. Item clicks are forwarded to the frontend as
/// a `tray-command` event ("playpause" / "next" / "prev") so tray and
/// on-screen transport share one set of handlers.
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
        .icon(app.default_window_icon().expect("bundle has an icon").clone())
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
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

/// macOS menu bar. Items forward to the frontend as `menu-command`
/// events (same handler set as the tray/transport). The Edit submenu's
/// predefined clipboard roles are what make ⌘C/⌘V/⌘X work inside the
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
        &[&MenuItem::with_id(handle, "menu_scan", "Scan Folder…", true, Some("CmdOrCtrl+O"))?],
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
            app.manage(SleepBlocker(Mutex::new(None)));
            spawn_library_watcher(app.handle().clone(), path.clone());
            spawn_launch_rescan(app.handle().clone(), path);
            setup_tray(app)?;
            setup_app_menu(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_library,
            list_tracks,
            get_lyrics,
            get_artwork,
            update_tray,
            set_display_awake,
            list_bpm_pending,
            set_bpm
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
