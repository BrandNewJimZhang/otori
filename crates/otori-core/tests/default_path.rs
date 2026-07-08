//! Cross-platform default library path resolution.
//!
//! `default_path()` reads the OS-specific home/data dir, but the
//! per-platform branch is a pure function over env strings so it can be
//! exercised without mutating the process environment (which would race
//! other tests in the same process). Each platform maps its env vars to a
//! library dir; `default_path` is the runtime wiring of env → dir →
//! `library.db`, with a mkdir for the host platform.
//!
//! Path assertions are separator-agnostic (parent + file_name) so the
//! Windows branch can be verified on a unix host without coupling to `\`
//! vs `/`.

use otori_core::db;
use std::path::PathBuf;

/// Assert `dir` is `<root>/otori` regardless of path separator — the
/// only contract `library_dir` makes per platform is "otori under the
/// OS data root". Comparing components survives `\` vs `/` differences
/// between the host running the test and the platform under test.
fn assert_otori_under(dir: &std::path::Path, root: &std::path::Path) {
    assert_eq!(dir.file_name(), Some(std::ffi::OsStr::new("otori")), "{dir:?} not .../otori");
    assert_eq!(dir.parent(), Some(root), "{dir:?} not under {root:?}");
}

#[test]
fn library_dir_macos_uses_library_application_support_under_home() {
    // macOS: ~/Library/Application Support/otori — unchanged from the
    // pre-port path, so an existing macOS install keeps its library.
    let home = PathBuf::from("/Users/test");
    let dir = db::library_dir(db::Platform::Macos, Some(home.clone()), None, None).unwrap();
    assert_otori_under(&dir, &home.join("Library/Application Support"));
}

#[test]
fn library_dir_macos_without_home_is_a_fail_fast_error() {
    // HOME unset on macOS is a setup error, not a silent cwd fallback.
    assert!(db::library_dir(db::Platform::Macos, None, None, None).is_err());
}

#[test]
fn library_dir_windows_uses_appdata_roaming() {
    // Windows: %APPDATA%\otori (Roaming, syncs across machines on a
    // domain — matching Tauri's app_data_dir, so the GUI's downloaded
    // models and the CLI's db share one root).
    let appdata = PathBuf::from(r"C:\Users\test\AppData\Roaming");
    let dir = db::library_dir(db::Platform::Windows, None, Some(appdata.clone()), None).unwrap();
    assert_otori_under(&dir, &appdata);
}

#[test]
fn library_dir_windows_without_appdata_is_a_fail_fast_error() {
    // APPDATA unset (rare; e.g. a service account) is a setup error.
    assert!(db::library_dir(db::Platform::Windows, None, None, None).is_err());
}

#[test]
fn library_dir_linux_uses_xdg_data_home_then_home_local_share() {
    // Linux: $XDG_DATA_HOME wins when set, else ~/.local/share/otori.
    let xdg = PathBuf::from("/custom/xdg");
    let via_xdg = db::library_dir(
        db::Platform::Linux,
        Some(PathBuf::from("/home/test")),
        None,
        Some(xdg.clone()),
    )
    .unwrap();
    assert_otori_under(&via_xdg, &xdg);

    let home = PathBuf::from("/home/test");
    let via_home = db::library_dir(db::Platform::Linux, Some(home.clone()), None, None).unwrap();
    assert_otori_under(&via_home, &home.join(".local/share"));
}

#[test]
fn library_dir_linux_without_any_home_is_a_fail_fast_error() {
    assert!(db::library_dir(db::Platform::Linux, None, None, None).is_err());
    // XDG alone without a HOME is allowed (XDG_DATA_HOME is absolute).
    let xdg = PathBuf::from("/x");
    let dir = db::library_dir(db::Platform::Linux, None, None, Some(xdg.clone())).unwrap();
    assert_otori_under(&dir, &xdg);
}
