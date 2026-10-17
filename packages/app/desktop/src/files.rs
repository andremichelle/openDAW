use std::collections::HashMap;
use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde::Deserialize;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, MessageDialogBuilder, MessageDialogButtons, MessageDialogKind};

use crate::{mime, APP, HEADERS};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Options {
    suggested_name: Option<String>,
    multiple: bool,
    filters: Vec<Filter>,
}

#[derive(Deserialize)]
struct Filter {
    name: String,
    extensions: Vec<String>,
}

struct State {
    token: String,
    next_id: AtomicU64,
    picked: Mutex<HashMap<u64, PathBuf>>,
    streams: Mutex<HashMap<u64, (File, PathBuf)>>,
}

fn state() -> &'static State {
    static STATE: OnceLock<State> = OnceLock::new();
    STATE.get_or_init(|| {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).expect("no os randomness");
        State {
            token: bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
            next_id: AtomicU64::new(1),
            picked: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
        }
    })
}

pub fn token() -> &'static str {
    &state().token
}

fn next_id() -> u64 {
    state().next_id.fetch_add(1, Ordering::SeqCst)
}

fn respond(request: tiny_http::Request, status: u16, body: Vec<u8>, content_type: &str) {
    let mut response = tiny_http::Response::from_data(body).with_status_code(status);
    response.add_header(tiny_http::Header::from_bytes("Content-Type", content_type).unwrap());
    for (key, value) in HEADERS {
        response.add_header(tiny_http::Header::from_bytes(key, value).unwrap());
    }
    let _ = request.respond(response);
}

fn empty(request: tiny_http::Request, status: u16) {
    respond(request, status, Vec::new(), "text/plain; charset=utf-8")
}

fn text(request: tiny_http::Request, status: u16, body: String) {
    respond(request, status, body.into_bytes(), "text/plain; charset=utf-8")
}

fn dialog(options: &Options) -> FileDialogBuilder<tauri::Wry> {
    let app = APP.get().expect("app not ready");
    let mut builder = app.dialog().file();
    if let Some(window) = app.get_webview_window("main") {
        builder = builder.set_parent(&window);
    }
    if let Some(name) = &options.suggested_name {
        builder = builder.set_file_name(name);
    }
    for filter in &options.filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter(&filter.name, &extensions);
    }
    builder
}

fn chosen(path: Option<tauri_plugin_dialog::FilePath>) -> Option<PathBuf> {
    path.and_then(|path| path.into_path().ok())
}

fn file_name(path: &PathBuf) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
}

fn stream_op<T>(id: u64, op: impl FnOnce(&mut File) -> std::io::Result<T>) -> Result<T, String> {
    let mut streams = state().streams.lock().unwrap();
    let (file, _) = streams.get_mut(&id).ok_or("unknown stream")?;
    op(file).map_err(|error| error.to_string())
}

fn route(mut request: tiny_http::Request, command: &str, query: &HashMap<String, String>) {
    let options: Options = query.get("options")
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or_default();
    let id: u64 = query.get("id").and_then(|id| id.parse().ok()).unwrap_or(0);
    let number = |key: &str| query.get(key).and_then(|value| value.parse::<u64>().ok());
    match command {
        "save" => match chosen(dialog(&options).blocking_save_file()) {
            None => empty(request, 204),
            Some(path) => match File::create(&path).and_then(|mut file| std::io::copy(request.as_reader(), &mut file)) {
                Ok(_) => text(request, 200, file_name(&path)),
                Err(error) => text(request, 500, error.to_string()),
            },
        },
        "pick-folder" => match chosen(APP.get().expect("app not ready").dialog().file().blocking_pick_folder()) {
            None => empty(request, 204),
            Some(path) => text(request, 200, path.to_string_lossy().into_owned()),
        },
        "open" => {
            let paths: Vec<PathBuf> = if options.multiple {
                dialog(&options).blocking_pick_files().unwrap_or_default()
                    .into_iter().filter_map(|path| path.into_path().ok()).collect()
            } else {
                chosen(dialog(&options).blocking_pick_file()).into_iter().collect()
            };
            let entries: Vec<serde_json::Value> = paths.into_iter().map(|path| {
                let id = next_id();
                let last_modified = std::fs::metadata(&path).and_then(|meta| meta.modified()).ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64).unwrap_or(0);
                let entry = serde_json::json!({"id": id, "name": file_name(&path), "lastModified": last_modified});
                state().picked.lock().unwrap().insert(id, path);
                entry
            }).collect();
            respond(request, 200, serde_json::to_vec(&entries).unwrap(), "application/json")
        }
        "read" => match state().picked.lock().unwrap().remove(&id) {
            None => empty(request, 404),
            Some(path) => match std::fs::read(&path) {
                Ok(bytes) => respond(request, 200, bytes, mime(&path)),
                Err(error) => text(request, 500, error.to_string()),
            },
        },
        "stream" => match chosen(dialog(&options).blocking_save_file()) {
            None => empty(request, 204),
            Some(path) => match File::create(&path) {
                Ok(file) => {
                    let id = next_id();
                    state().streams.lock().unwrap().insert(id, (file, path));
                    text(request, 200, id.to_string())
                }
                Err(error) => text(request, 500, error.to_string()),
            },
        },
        "write" => {
            let position = number("position");
            let result = stream_op(id, |file| {
                if let Some(position) = position {
                    file.seek(SeekFrom::Start(position))?;
                }
                std::io::copy(request.as_reader(), file)
            });
            match result {
                Ok(_) => empty(request, 204),
                Err(error) => text(request, 500, error),
            }
        }
        "seek" => match stream_op(id, |file| file.seek(SeekFrom::Start(number("position").unwrap_or(0)))) {
            Ok(_) => empty(request, 204),
            Err(error) => text(request, 500, error),
        },
        "truncate" => match stream_op(id, |file| file.set_len(number("size").unwrap_or(0))) {
            Ok(_) => empty(request, 204),
            Err(error) => text(request, 500, error),
        },
        "close" => match state().streams.lock().unwrap().remove(&id) {
            None => empty(request, 404),
            Some((mut file, _)) => match file.flush() {
                Ok(_) => empty(request, 204),
                Err(error) => text(request, 500, error.to_string()),
            },
        },
        "alert" => {
            let mut message = String::new();
            let _ = std::io::Read::read_to_string(request.as_reader(), &mut message);
            message_dialog(message, "openDAW").blocking_show();
            empty(request, 204)
        }
        "confirm" => {
            let mut message = String::new();
            let _ = std::io::Read::read_to_string(request.as_reader(), &mut message);
            let title = query.get("title").map(String::as_str).unwrap_or("openDAW");
            let ok = query.get("ok").cloned().unwrap_or_else(|| "OK".to_string());
            let approved = message_dialog(message, title)
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(ok, "Cancel".to_string()))
                .blocking_show();
            text(request, 200, approved.to_string())
        }
        "component-status" => text(request, 200, crate::components::status_json(query.get("name").map(String::as_str).unwrap_or(""))),
        "component-install" => {
            #[derive(Deserialize)]
            struct Install {
                name: String,
                models: Vec<crate::components::Model>,
            }
            let mut body = Vec::new();
            let _ = std::io::Read::read_to_end(request.as_reader(), &mut body);
            match serde_json::from_slice::<Install>(&body) {
                Ok(Install { name, models }) => {
                    crate::components::install(name, models);
                    empty(request, 204)
                }
                Err(error) => text(request, 400, error.to_string()),
            }
        }
        "component-model" => {
            let (name, path) = (query.get("name").cloned().unwrap_or_default(), query.get("path").cloned().unwrap_or_default());
            match crate::components::model(&name, &path) {
                Some(bytes) => respond(request, 200, bytes, "application/octet-stream"),
                None => empty(request, 404),
            }
        }
        "browse" => match query.get("url").filter(|url| url.starts_with("https://") || url.starts_with("http://")) {
            Some(url) => match crate::open_in_browser(url) {
                Ok(()) => empty(request, 204),
                Err(error) => text(request, 500, error.to_string()),
            },
            None => empty(request, 400),
        },
        "guard" => {
            crate::CLOSE_GUARDED.store(true, Ordering::SeqCst);
            crate::update::booted();
            empty(request, 204)
        }
        "quit" => {
            empty(request, 204);
            crate::quit_approved(APP.get().expect("app not ready"))
        }
        "quit-cancel" => {
            crate::quit_cancelled();
            empty(request, 204)
        }
        "title" => {
            if let Some(window) = APP.get().and_then(|app| app.get_webview_window("main")) {
                crate::set_title(&window, query.get("title").map(String::as_str).unwrap_or(""),
                    query.get("edited").is_some_and(|edited| edited == "true"));
            }
            empty(request, 204)
        }
        "menu" => {
            let mut json = Vec::new();
            let result = std::io::Read::read_to_end(request.as_reader(), &mut json)
                .map_err(|error| error.to_string())
                .and_then(|_| crate::menu::set(&json));
            match result {
                Ok(_) => empty(request, 204),
                Err(error) => text(request, 400, error),
            }
        }
        "abort" => {
            if let Some((file, path)) = state().streams.lock().unwrap().remove(&id) {
                drop(file);
                let _ = std::fs::remove_file(path);
            }
            empty(request, 204)
        }
        _ => empty(request, 404),
    }
}

// macOS: unparented, an app-modal alert sits above the floating plugin windows (a sheet would stay below them).
// Windows/Linux: owned by the main window, the plugin windows are owned too and the active dialog comes first.
fn message_dialog(message: String, title: &str) -> MessageDialogBuilder<tauri::Wry> {
    let dialog = APP.get().expect("app not ready").dialog().message(message).title(title);
    #[cfg(target_os = "macos")]
    return dialog;
    #[cfg(not(target_os = "macos"))]
    match APP.get().and_then(|app| app.get_webview_window("main")) {
        Some(window) => dialog.parent(&window),
        None => dialog,
    }
}

// Native file dialogs, file access and the menu for the page, guarded by the token injected into the main window
pub fn handle(request: tiny_http::Request) -> Option<tiny_http::Request> {
    let Some(rest) = request.url().strip_prefix("/__shell/") else { return Some(request) };
    let (command, query) = rest.split_once('?').unwrap_or((rest, ""));
    let command = command.to_string();
    let query: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
    let authorized = request.headers().iter()
        .any(|header| header.field.equiv("X-Shell-Token") && header.value.as_str() == token());
    if authorized {
        route(request, &command, &query);
    } else {
        empty(request, 403);
    }
    None
}
