// The app updates itself (plans/shell-updates.md): it checks at launch and every few hours, downloads in the background
// and asks to restart. macOS and Linux install right away (the new version runs from the next start), Windows when the
// app exits (its installer closes the app). Restart goes through the page's unsaved-work guard.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::UPDATE_ORIGIN;

const FIRST_CHECK: Duration = Duration::from_secs(20);
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

// downloaded, installed when the app exits (Windows)
static PENDING: Mutex<Option<(Update, Vec<u8>)>> = Mutex::new(None);
static READY: AtomicBool = AtomicBool::new(false);
static RESTART: AtomicBool = AtomicBool::new(false);
static OUTDATED_TOLD: AtomicBool = AtomicBool::new(false);

// written by the install job of desktop.yml next to the installers
fn feed(origin: &str) -> String {format!("{origin}/install/openDAW-latest.json")}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK);
        loop {
            if !READY.load(Ordering::SeqCst) {
                if let Err(error) = tauri::async_runtime::block_on(check(&app)) { eprintln!("[app update] {error}"); }
            }
            std::thread::sleep(INTERVAL);
        }
    });
}

async fn check(app: &AppHandle) -> Result<(), String> {
    let url = feed(UPDATE_ORIGIN).parse().map_err(|error| format!("{error}"))?;
    let updater = app.updater_builder().endpoints(vec![url]).and_then(|builder| builder.build()).map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
        if crate::update::needs_newer_shell() && !OUTDATED_TOLD.swap(true, Ordering::SeqCst) {
            tell(app, "The latest studio needs a newer openDAW app.".into());
        }
        return Ok(());
    };
    let version = update.version.clone();
    println!("[app update] downloading {version}");
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|error| error.to_string())?;
    if cfg!(target_os = "windows") {
        *PENDING.lock().unwrap() = Some((update, bytes));
    } else if let Err(error) = update.install(&bytes) {
        tell(app, format!("openDAW {version} could not be installed ({error})."));
        return Err(error.to_string());
    }
    READY.store(true, Ordering::SeqCst);
    println!("[app update] {version} is ready");
    let handle = app.clone();
    app.dialog().message(format!("openDAW {version} is ready. Restart now to use it?")).title("openDAW Update")
        .buttons(MessageDialogButtons::OkCancelCustom("Restart".into(), "Later".into()))
        .show(move |restart| if restart {
            RESTART.store(true, Ordering::SeqCst);
            crate::request_quit(&handle);
        });
    Ok(())
}

fn tell(app: &AppHandle, message: String) {
    let install = format!("{UPDATE_ORIGIN}/install");
    app.dialog().message(format!("{message} Please download it from {install}")).title("openDAW Update").show(|_| {});
}

// the app exits: Windows installs now (the installer closes the app and starts the new version), a chosen restart
// starts the installed version
pub fn finish(app: &AppHandle) {
    if let Some((update, bytes)) = PENDING.lock().unwrap().take() {
        if let Err(error) = update.install(&bytes) { eprintln!("[app update] {error}"); }
        return;
    }
    if READY.load(Ordering::SeqCst) && RESTART.load(Ordering::SeqCst) {
        tauri::process::restart(&app.env());
    }
}

#[cfg(test)]
mod tests {
    use super::feed;

    // the file name the install job writes (scripts/latest-json.mjs)
    #[test]
    fn the_feed_is_next_to_the_installers() {
        assert_eq!(feed("https://dev.opendaw.studio"), "https://dev.opendaw.studio/install/openDAW-latest.json");
        assert!(include_str!("../scripts/latest-json.mjs").contains("\"openDAW-latest.json\""));
    }
}
