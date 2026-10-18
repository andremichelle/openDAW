// Uninstall from Tools > Uninstall openDAW (plans/shell-updates.md, plans/tauri.md phase 6). macOS and Linux have no
// uninstaller, Windows' NSIS uninstaller misses the plugin scan cache. Asked twice (the app, then the projects, kept
// unless the user says otherwise), done when the app exits so nothing is in use.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Scope {
    // the app, the downloaded studio builds, components, logs and the plugin scan cache
    App,
    // also the projects, samples and settings in the webview's storage
    Everything,
}

// the folders the app writes, resolved per platform
pub struct Folders {
    pub data: PathBuf,
    pub local_data: PathBuf,
    pub cache: PathBuf,
    pub config: PathBuf,
    pub plugin_cache: Option<PathBuf>,
    // macOS keeps a WKWebView's storage under ~/Library/WebKit and ~/Library/HTTPStorages
    pub webkit: Vec<PathBuf>,
    pub logs: Option<PathBuf>,
}

static CHOSEN: Mutex<Option<Scope>> = Mutex::new(None);

pub fn targets(scope: Scope, folders: &Folders) -> Vec<PathBuf> {
    let mut targets = match scope {
        Scope::App => vec![folders.data.join("web"), folders.data.join("components")],
        Scope::Everything => {
            let mut all = vec![folders.data.clone(), folders.local_data.clone(), folders.cache.clone(), folders.config.clone()];
            all.extend(folders.webkit.iter().cloned());
            all
        }
    };
    if scope == Scope::App { targets.extend(folders.logs.clone()); }
    targets.extend(folders.plugin_cache.clone());
    targets
}

// the engine's scan cache (scan.rs cache_file)
fn plugin_cache() -> Option<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        PathBuf::from(std::env::var("HOME").ok()?).join("Library/Caches")
    } else if cfg!(target_os = "windows") {
        PathBuf::from(std::env::var("LOCALAPPDATA").ok()?)
    } else {
        std::env::var("XDG_CACHE_HOME").map(PathBuf::from).or_else(|_| std::env::var("HOME").map(|home| PathBuf::from(home).join(".cache"))).ok()?
    };
    Some(base.join("openDAW"))
}

fn folders(app: &AppHandle) -> Option<Folders> {
    let path = app.path();
    let identifier = &app.config().identifier;
    let webkit = if cfg!(target_os = "macos") {
        std::env::var("HOME").map(|home| ["Library/WebKit", "Library/HTTPStorages"].iter()
            .map(|folder| PathBuf::from(&home).join(folder).join(identifier)).collect()).unwrap_or_default()
    } else { Vec::new() };
    Some(Folders {
        data: path.app_data_dir().ok()?, local_data: path.app_local_data_dir().ok()?, cache: path.app_cache_dir().ok()?,
        config: path.app_config_dir().ok()?, plugin_cache: plugin_cache(), webkit, logs: crate::log::folder().map(Path::to_path_buf)
    })
}

// a deb belongs to the package manager, the app cannot remove itself
fn packaged() -> bool {cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_none()}

pub fn ask(app: &AppHandle) {
    let what = if packaged() {
        "This removes the downloaded studio, its components and logs. Remove the app itself with your package manager afterwards."
    } else {
        "This removes the app, the downloaded studio, its components and logs."
    };
    let handle = app.clone();
    app.dialog().message(what).title("Uninstall openDAW?")
        .buttons(MessageDialogButtons::OkCancelCustom("Uninstall".into(), "Cancel".into()))
        .show(move |uninstall| if uninstall {
            let again = handle.clone();
            handle.dialog().message("Delete your projects, samples and settings as well? This cannot be undone.").title("Your Projects")
                .buttons(MessageDialogButtons::OkCancelCustom("Keep Them".into(), "Delete Everything".into()))
                .show(move |keep| {
                    *CHOSEN.lock().unwrap() = Some(if keep { Scope::App } else { Scope::Everything });
                    crate::request_quit(&again);
                });
        });
}

// the app exits: true when it uninstalled, then nothing else runs (no update, no restart)
pub fn finish(app: &AppHandle) -> bool {
    let Some(scope) = CHOSEN.lock().unwrap().take() else { return false };
    let Some(folders) = folders(app) else { return true };
    for target in targets(scope, &folders) {
        if target.exists() && std::fs::remove_dir_all(&target).is_err() { eprintln!("[uninstall] {} stays", target.display()); }
    }
    remove_app();
    true
}

fn remove_app() {
    let Ok(exe) = std::env::current_exe() else { return };
    if cfg!(target_os = "windows") {
        // the NSIS uninstaller removes the program files and the shortcuts
        if let Some(uninstaller) = exe.parent().map(|dir| dir.join("uninstall.exe")).filter(|path| path.is_file()) {
            let _ = std::process::Command::new(uninstaller).spawn();
        }
    } else if cfg!(target_os = "macos") {
        if let Some(bundle) = exe.ancestors().find(|path| path.extension().is_some_and(|extension| extension == "app")) {
            let _ = std::fs::remove_dir_all(bundle);
        }
    } else if let Some(image) = std::env::var_os("APPIMAGE") {
        let _ = std::fs::remove_file(image);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folders() -> Folders {
        Folders {
            data: "/data/studio.opendaw".into(), local_data: "/local/studio.opendaw".into(), cache: "/cache/studio.opendaw".into(),
            config: "/config/studio.opendaw".into(), plugin_cache: Some("/cache/openDAW".into()),
            webkit: vec!["/Library/WebKit/studio.opendaw".into()], logs: Some("/data/studio.opendaw/logs".into())
        }
    }

    // the projects live in the webview's storage, keeping them removes only what the app downloaded and wrote itself
    #[test]
    fn uninstalling_the_app_keeps_the_projects() {
        let targets = targets(Scope::App, &folders());
        assert_eq!(targets, vec![PathBuf::from("/data/studio.opendaw/web"), "/data/studio.opendaw/components".into(),
            "/data/studio.opendaw/logs".into(), "/cache/openDAW".into()]);
        assert!(!targets.iter().any(|path| path == Path::new("/local/studio.opendaw") || path.starts_with("/Library/WebKit")));
    }

    #[test]
    fn uninstalling_everything_leaves_nothing() {
        let targets = targets(Scope::Everything, &folders());
        for folder in ["/data/studio.opendaw", "/local/studio.opendaw", "/cache/studio.opendaw", "/config/studio.opendaw", "/cache/openDAW",
            "/Library/WebKit/studio.opendaw"] {
            assert!(targets.contains(&PathBuf::from(folder)), "{folder} stays behind");
        }
    }
}
