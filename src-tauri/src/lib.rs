//! Ōtori desktop shell: thin IPC glue over otori-core (ADR-0001 §3).
//! No business logic lives here — commands translate between the
//! frontend and the core, nothing more.

use std::sync::Mutex;

use otori_core::{db, query, scan};
use tauri::Manager;

/// One shared connection guarded by a mutex: single-writer by
/// construction, matching the L5 coexistence model (per-operation
/// pooling only if the UI ever blocks on long scans).
struct Library(Mutex<otori_core::Connection>);

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

#[tauri::command]
fn get_lyrics(path: String) -> Result<Option<otori_core::lyrics::LyricsDoc>, String> {
    otori_core::lyrics::resolve(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

/// Embedded cover art as a data URL, or None. Reading the file per call
/// keeps it stateless; cache in the frontend per track if it ever lags.
#[tauri::command]
fn get_artwork(path: String) -> Result<Option<String>, String> {
    use base64::Engine;
    use lofty::file::TaggedFileExt;
    let tagged =
        lofty::read_from_path(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Ok(None);
    };
    let Some(picture) = tag.pictures().first() else {
        return Ok(None);
    };
    let mime = picture
        .mime_type()
        .map(|m| m.to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    let b64 = base64::engine::general_purpose::STANDARD.encode(picture.data());
    Ok(Some(format!("data:{mime};base64,{b64}")))
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_library,
            list_tracks,
            get_lyrics,
            get_artwork
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
