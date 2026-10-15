mod files;
mod menu;
mod update;
mod wclap;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use tauri::utils::config::{BackgroundThrottlingPolicy, WebviewUrl};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, WindowEvent};

// Bump when a primitive is added or changed; a build's build-info.json shellApi must not exceed it
pub const SHELL_API: u64 = 1;
const PORT: u16 = 47110;
// Where the shell looks for studio builds; DEV until the public release builds with OPENDAW_UPDATE_ORIGIN=https://opendaw.studio
pub const UPDATE_ORIGIN: &str = match option_env!("OPENDAW_UPDATE_ORIGIN") {
    Some(origin) => origin,
    None => "https://dev.opendaw.studio",
};
const DEFAULT_DIST: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../studio/dist-desktop");

pub static APP: OnceLock<AppHandle> = OnceLock::new();
pub static CLOSE_GUARDED: AtomicBool = AtomicBool::new(false);

pub fn set_title(window: &tauri::WebviewWindow, title: &str, edited: bool) {
    let _ = window.set_title(title);
    #[cfg(target_os = "macos")]
    {
        let handle = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(pointer) = handle.ns_window() {
                // ns_window is the live NSWindow of this webview window, used on the main thread only
                let ns_window = unsafe { &*(pointer as *const objc2_app_kit::NSWindow) };
                ns_window.setDocumentEdited(edited);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    if edited {
        let _ = window.set_title(&format!("{title} *"));
    }
}

// Plugin windows float above the studio like in other DAWs: on macOS at floating level and hidden while another app
// is active, elsewhere owned by the main window
fn in_front<'a>(builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>, app: &AppHandle)
                -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    // never resizable by the user, which keeps the top edges for dragging; a size change comes from the page (resizeBy)
    let builder = builder.resizable(false);
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        builder.always_on_top(true)
    }
    #[cfg(not(target_os = "macos"))]
    match app.get_webview_window("main") {
        Some(main) => builder.parent(&main).unwrap_or_else(|error| panic!("popout parent ({error})")),
        None => builder,
    }
}

#[cfg(target_os = "macos")]
fn hide_on_deactivate(window: &tauri::WebviewWindow) {
    let handle = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(pointer) = handle.ns_window() {
            // ns_window is the live NSWindow of this webview window, used on the main thread only
            let ns_window = unsafe { &*(pointer as *const objc2_app_kit::NSWindow) };
            ns_window.setHidesOnDeactivate(true);
        }
    });
}

// Quit and closing the main window ask the page first once it has installed its unsaved-work guard
pub fn request_quit(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(window) if CLOSE_GUARDED.load(Ordering::SeqCst) => {
            let _ = window.eval("window.__OPENDAW_SHELL__?.close?.()");
        }
        _ => app.exit(0),
    }
}

pub const HEADERS: [(&str, &str); 4] = [
    ("Cross-Origin-Opener-Policy", "same-origin"),
    ("Cross-Origin-Embedder-Policy", "require-corp"),
    ("Cross-Origin-Resource-Policy", "cross-origin"),
    ("Cache-Control", "no-store"),
];

pub fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "wasm" => "application/wasm",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "gif" => "image/gif",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "aif" | "aiff" => "audio/aiff",
        "m4a" => "audio/mp4",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "md" | "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

// wry ignores window.close() and window.resizeBy() on opener-linked windows, and a frameless popout drags by its
// [data-window-drag] element (nodes come from the opener realm, so no instanceof), all through the shell
fn popout_script(label: &str) -> String {
    format!(r#"(() => {{
        if (window.__shellClose__) {{return}}
        const shell = path => fetch(`http://127.0.0.1:{PORT}/${{path}}`, {{mode: "no-cors"}}).catch(() => {{}})
        window.resizeBy = (deltaX, deltaY) => shell(`__resize?label={label}&dx=${{Math.round(deltaX)}}&dy=${{Math.round(deltaY)}}`)
        window.addEventListener("pointerdown", event => {{
            const target = event.target
            if (event.button !== 0 || typeof target?.closest !== "function") {{return}}
            if (target.closest("[data-window-drag]") === null || target.closest("[data-class='button']") !== null) {{return}}
            shell("__drag?label={label}")
        }}, {{capture: true}})
        let closing = false
        window.__shellClose__ = () => {{
            if (closing) {{return}}
            closing = true
            window.dispatchEvent(new Event("beforeunload"))
            fetch("http://127.0.0.1:{PORT}/__close?{label}", {{mode: "no-cors"}}).catch(() => {{}})
        }}
        window.close = window.__shellClose__
    }})()"#)
}

static ROOT: RwLock<Option<Arc<PathBuf>>> = RwLock::new(None);

pub fn root() -> Option<Arc<PathBuf>> {
    ROOT.read().unwrap().clone()
}

pub fn set_root(root: PathBuf) {
    println!("[openDAW] serving {} (shell api {SHELL_API})", root.display());
    match required_shell_api(&root) {
        Some(required) if required > SHELL_API => eprintln!("[openDAW] build needs shell api {required}, this shell has {SHELL_API}"),
        Some(_) => {}
        None => eprintln!("[openDAW] build-info.json has no shellApi"),
    }
    *ROOT.write().unwrap() = Some(Arc::new(root));
}

fn resolve(root: &Path, url_path: &str) -> (PathBuf, u16) {
    let clean = url_path.split(['?', '#']).next().unwrap_or("/").trim_start_matches('/');
    let clean = if clean.is_empty() { "index.html" } else { clean };
    if clean.split('/').any(|segment| segment == "..") {
        return (root.join("index.html"), 403);
    }
    let candidate = root.join(clean);
    if candidate.is_file() {
        (candidate, 200)
    } else if Path::new(clean).extension().is_none() {
        (root.join("index.html"), 200)
    } else {
        (candidate, 404)
    }
}

fn respond(request: tiny_http::Request, bytes: Vec<u8>, status: u16, content_type: &str) {
    let mut response = tiny_http::Response::from_data(bytes).with_status_code(status);
    response.add_header(tiny_http::Header::from_bytes("Content-Type", content_type).unwrap());
    for (key, value) in HEADERS {
        response.add_header(tiny_http::Header::from_bytes(key, value).unwrap());
    }
    let _ = request.respond(response);
}

fn query_value(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    url::form_urlencoded::parse(query.as_bytes()).find(|(name, _)| name == key).map(|(_, value)| value.into_owned())
}

fn popout(url: &str) -> Option<tauri::WebviewWindow> {
    APP.get().and_then(|app| app.get_webview_window(&query_value(url, "label")?))
}

fn serve(request: tiny_http::Request) {
    let Some(request) = files::handle(request) else { return };
    let Some(request) = update::handle(request) else { return };
    let url = request.url().to_string();
    if url.starts_with("/__drag") {
        if let Some(window) = popout(&url) {
            let _ = window.start_dragging();
        }
        let _ = request.respond(tiny_http::Response::empty(204));
    } else if url.starts_with("/__resize") {
        if let Some(window) = popout(&url) {
            let delta = |key| query_value(&url, key).and_then(|value| value.parse::<f64>().ok()).unwrap_or(0.0);
            if let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) {
                let size = size.to_logical::<f64>(scale);
                let _ = window.set_size(tauri::LogicalSize::new(size.width + delta("dx"), size.height + delta("dy")));
            }
        }
        let _ = request.respond(tiny_http::Response::empty(204));
    } else if url.starts_with("/__close") {
        let label = url.split('?').nth(1).unwrap_or("");
        if let Some(window) = APP.get().and_then(|app| app.get_webview_window(label)) {
            let _ = window.destroy();
        }
        let _ = request.respond(tiny_http::Response::empty(204));
    } else if let Some(root) = root() {
        let (path, status) = resolve(&root, &url);
        if status != 200 {
            println!("[serve] {status} {url}");
        }
        respond(request, std::fs::read(&path).unwrap_or_default(), status, mime(&path));
    } else {
        let _ = request.respond(tiny_http::Response::empty(503));
    }
}

fn run_server() {
    let server = tiny_http::Server::http(("127.0.0.1", PORT)).expect("port taken");
    for request in server.incoming_requests() {
        std::thread::spawn(move || serve(request));
    }
}

fn required_shell_api(root: &Path) -> Option<u64> {
    let bytes = std::fs::read(root.join("build-info.json")).ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes).ok()?.get("shellApi")?.as_u64()
}

fn main() {
    // OPENDAW_DIST, or a debug build without OPENDAW_UPDATE, serves a local build and skips the update flow
    let local = std::env::var("OPENDAW_DIST").ok().map(PathBuf::from)
        .or_else(|| (cfg!(debug_assertions) && std::env::var("OPENDAW_UPDATE").is_err()).then(|| PathBuf::from(DEFAULT_DIST)));
    let updating = local.is_none();
    if let Some(local) = local {
        set_root(local);
    }
    std::thread::spawn(run_server);
    std::thread::spawn(wclap::run_plugin_server);
    let shell_info = format!("window.__OPENDAW_SHELL__ = {{token: \"{}\", api: {SHELL_API}}}", files::token());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(|app, event| menu::clicked(app, event.id().as_ref()))
        .setup(move |app| {
            let handle = app.handle().clone();
            let _ = APP.set(handle.clone());
            let counter = Arc::new(AtomicUsize::new(0));
            if updating {
                update::start(app.path().app_data_dir()?);
            }
            let url = format!("http://127.0.0.1:{PORT}/{}", if updating { "__splash" } else { "" });
            let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("openDAW")
                .inner_size(1400.0, 900.0)
                .background_color(tauri::window::Color(21, 23, 25, 255))
                .disable_drag_drop_handler()
                .background_throttling(BackgroundThrottlingPolicy::Disabled)
                .devtools(true)
                .initialization_script(&shell_info)
                .on_new_window(move |url, features| {
                    let label = format!("popout-{}", counter.fetch_add(1, Ordering::SeqCst));
                    let utility = url.query_pairs().any(|(key, _)| key == "utility");
                    let close = popout_script(&label);
                    let builder = WebviewWindowBuilder::new(&handle, label, WebviewUrl::External("about:blank".parse().unwrap()))
                        .window_features(features)
                        .decorations(!utility)
                        .accept_first_mouse(true)
                        .disable_drag_drop_handler()
                        .background_throttling(BackgroundThrottlingPolicy::Disabled)
                        .on_document_title_changed(|window, title| {
                            let _ = window.set_title(&title);
                        })
                        .on_page_load(move |window, payload| {
                            if matches!(payload.event(), PageLoadEvent::Finished) {
                                let _ = window.eval(&close);
                            }
                        });
                    let builder = if utility { in_front(builder, &handle) } else { builder };
                    let window = builder.build().unwrap();
                    #[cfg(target_os = "macos")]
                    if utility {
                        hide_on_deactivate(&window);
                    }
                    let closing = window.clone();
                    window.on_window_event(move |event| {
                        if let WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = closing.eval("window.__shellClose__ ? window.__shellClose__() : null");
                        }
                    });
                    NewWindowResponse::Create { window }
                })
                .build()?;
            let quitting = app.handle().clone();
            main.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    request_quit(&quitting);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri run");
}
