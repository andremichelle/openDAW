mod components;
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

// An empty title (no project): macOS shows the app's name in the menu bar already, elsewhere the window carries it
pub fn set_title(window: &tauri::WebviewWindow, title: &str, edited: bool) {
    let title = if title.is_empty() && cfg!(not(target_os = "macos")) { "openDAW Studio" } else { title };
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

fn open_window(handle: &AppHandle, counter: &Arc<AtomicUsize>, url: tauri::Url, features: tauri::webview::NewWindowFeatures,
               from_main: bool) -> NewWindowResponse<tauri::Wry> {
    let label = format!("popout-{}", counter.fetch_add(1, Ordering::SeqCst));
    let utility = url.query_pairs().any(|(key, _)| key == "utility");
    let close = popout_script(&label);
    let builder = WebviewWindowBuilder::new(handle, label, WebviewUrl::External("about:blank".parse().unwrap()));
    let builder = match (features.size(), features.position()) {
        (None, None) => builder.inner_size(1000.0, 800.0).center(),
        (None, Some(_)) => builder.inner_size(1000.0, 800.0),
        _ => builder,
    };
    let (nested_handle, nested_counter) = (handle.clone(), counter.clone());
    let builder = builder
        .window_features(features)
        .decorations(!utility)
        .accept_first_mouse(true)
        .disable_drag_drop_handler()
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .on_new_window(move |url, features| open_window(&nested_handle, &nested_counter, url, features, false))
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        .on_page_load(move |window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = window.eval(&close);
            }
        });
    let builder = if utility { in_front(builder, handle) } else { builder };
    let window = builder.build().unwrap();
    #[cfg(target_os = "macos")]
    if utility {
        hide_on_deactivate(&window);
    }
    let (closing, app) = (window.clone(), handle.clone());
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            // a foreign page (an OAuth login) cannot reach the shell to close itself
            if closing.url().is_ok_and(|url| is_foreign(&url)) {
                if from_main {
                    // what the callback pages send on unload, so the studio stops waiting
                    if let Some(main) = app.get_webview_window("main") {
                        let _ = main.eval(r#"for (const name of ["auth-callback", "tone3000-callback"]) {
                            const channel = new BroadcastChannel(name)
                            channel.postMessage({type: "closed"})
                            channel.close()
                        }"#);
                    }
                }
                return;
            }
            api.prevent_close();
            let _ = closing.eval("window.__shellClose__ ? window.__shellClose__() : null");
        }
    });
    NewWindowResponse::Create { window }
}

fn is_foreign(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https") && !(url.host_str() == Some("127.0.0.1") && url.port() == Some(PORT))
}

static ROOT: RwLock<Option<Arc<PathBuf>>> = RwLock::new(None);

pub fn root() -> Option<Arc<PathBuf>> {
    ROOT.read().unwrap().clone()
}

const ENGINE_PORT: u16 = 47112;
static ENGINE: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);

// The native engine is the default; OPENDAW_NATIVE_ENGINE=0 keeps the engine in the webview
fn native_engine() -> bool {
    std::env::var("OPENDAW_NATIVE_ENGINE").map_or(true, |value| value != "0")
}

// A bundle runs its sidecar next to the shell executable. A debug build always runs the engine crate's release
// build, since tauri-build also copies a possibly stale sidecar next to the debug executable.
fn engine_binary() -> PathBuf {
    if let Ok(path) = std::env::var("OPENDAW_ENGINE") {
        return PathBuf::from(path);
    }
    let development = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/engine/target/release/opendaw-engine"));
    if cfg!(debug_assertions) {
        return development;
    }
    std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join("opendaw-engine"))).filter(|path| path.is_file())
        .unwrap_or(development)
}

// The native engine process serves the build in root; it is started once, with the shell token
fn start_engine(root: &Path) {
    let mut engine = ENGINE.lock().unwrap();
    if !native_engine() || engine.is_some() { return; }
    let binary = engine_binary();
    // the engine exits when this pipe closes, so it never outlives the shell
    let command = std::process::Command::new(&binary).env("OPENDAW_ENGINE_TOKEN", files::token()).env("OPENDAW_DIST", root)
        .stdin(std::process::Stdio::piped()).spawn();
    match command {
        Ok(child) => *engine = Some(child),
        Err(error) => eprintln!("[openDAW] cannot start the engine {} ({error})", binary.display()),
    }
}

// a key a plugin window left unhandled, replayed in the studio so its shortcuts work while the plugin is in front
fn replay_key(url: &str) {
    let text = |key: &str| serde_json::Value::String(query_value(url, key).unwrap_or_default());
    let flag = |key: &str| query_value(url, key).as_deref() == Some("1");
    let kind = if query_value(url, "type").as_deref() == Some("keyup") { "keyup" } else { "keydown" };
    let script = format!("document.body.dispatchEvent(new KeyboardEvent(\"{kind}\", {{code: {}, key: {}, shiftKey: {}, ctrlKey: {}, \
        altKey: {}, metaKey: {}, repeat: {}, bubbles: true, cancelable: true}}))",
        text("code"), text("key"), flag("shift"), flag("ctrl"), flag("alt"), flag("meta"), flag("repeat"));
    if let Some(window) = APP.get().and_then(|app| app.get_webview_window("main")) {
        let _ = window.eval(script);
    }
}

// Cmd+` cycles the studio's windows, then the plugin windows of the engine process, which hands back to the main window
fn cycle_windows(app: &AppHandle) {
    let mut windows: Vec<tauri::WebviewWindow> = app.webview_windows().into_values()
        .filter(|window| window.is_visible().unwrap_or(false)).collect();
    windows.sort_by_key(|window| (window.label() != "main", window.label().to_string()));
    let focused = windows.iter().position(|window| window.is_focused().unwrap_or(false));
    if let Some(next) = focused.and_then(|index| windows.get(index + 1)) {
        let _ = next.set_focus();
        return;
    }
    let passed = ENGINE.lock().unwrap().as_mut().and_then(|child| child.stdin.as_mut())
        .is_some_and(|stdin| std::io::Write::write_all(stdin, b"cycle\n").is_ok());
    if !passed {
        if let Some(first) = windows.first() { let _ = first.set_focus(); }
    }
}

// the key left of 1 (US) or left of Y (ISO), macOS cycles windows with it
#[cfg(target_os = "macos")]
fn install_cycle_monitor(app: AppHandle) {
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
    const CYCLE_KEY: u16 = 50;
    let handler = block2::RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        let event_ref = unsafe { event.as_ref() };
        if event_ref.modifierFlags().contains(NSEventModifierFlags::Command) && event_ref.keyCode() == CYCLE_KEY {
            cycle_windows(&app);
            return std::ptr::null_mut();
        }
        event.as_ptr()
    });
    std::mem::forget(unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler) });
}

fn stop_engine() {
    if let Some(mut child) = ENGINE.lock().unwrap().take() {
        let _ = child.kill();
    }
}

pub fn set_root(root: PathBuf) {
    start_engine(&root);
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
    let html = root.join(format!("{}.html", clean.trim_end_matches('/')));
    // the manuals and the scripting docs are sites of their own: folder index pages and extensionless pages
    let own_site = clean.starts_with("manuals/") || clean == "manuals" || clean.starts_with("docs/");
    if candidate.is_file() {
        (candidate, 200)
    } else if candidate.join("index.html").is_file() {
        (candidate.join("index.html"), 200)
    } else if html.is_file() {
        (html, 200)
    } else if own_site {
        (candidate, 404)
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

pub fn open_in_browser(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    command.arg(url).spawn().map(|_| ())
}

// only the same-origin callback page may post, so another site cannot slip its own login into the studio
fn auth_callback(request: &mut tiny_http::Request, url: &str) -> u16 {
    let channel = query_value(url, "channel").filter(|name| name == "auth-callback" || name == "tone3000-callback");
    let same_origin = request.headers().iter()
        .any(|header| header.field.equiv("Origin") && header.value.as_str() == format!("http://127.0.0.1:{PORT}"));
    let (Some(channel), true) = (channel, same_origin && request.method() == &tiny_http::Method::Post) else { return 403 };
    let mut body = Vec::new();
    let _ = std::io::Read::read_to_end(request.as_reader(), &mut body);
    let Ok(message) = serde_json::from_slice::<serde_json::Value>(&body) else { return 400 };
    let Some(main) = APP.get().and_then(|app| app.get_webview_window("main")) else { return 503 };
    let _ = main.eval(&format!("{{const channel = new BroadcastChannel({}); channel.postMessage({message}); channel.close()}}",
        serde_json::Value::String(channel)));
    let _ = main.unminimize();
    let _ = main.set_focus();
    204
}

fn serve(request: tiny_http::Request) {
    let Some(request) = files::handle(request) else { return };
    let Some(mut request) = update::handle(request) else { return };
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
    } else if url.starts_with("/__auth-callback") {
        let status = auth_callback(&mut request, &url);
        let _ = request.respond(tiny_http::Response::empty(status));
    } else if url.starts_with("/__key") {
        replay_key(&url);
        let _ = request.respond(tiny_http::Response::empty(204));
    } else if url.starts_with("/__cycle-home") {
        if let Some(window) = APP.get().and_then(|app| app.get_webview_window("main")) {
            let _ = window.set_focus();
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
    let engine_info = if native_engine() { format!(", engine: {{port: {ENGINE_PORT}, token: \"{}\"}}", files::token()) } else { String::new() };
    let shell_info = format!("window.__OPENDAW_SHELL__ = {{token: \"{}\", api: {SHELL_API}{engine_info}}}", files::token());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(|app, event| menu::clicked(app, event.id().as_ref()))
        .setup(move |app| {
            let handle = app.handle().clone();
            let _ = APP.set(handle.clone());
            #[cfg(target_os = "macos")]
            install_cycle_monitor(handle.clone());
            let counter = Arc::new(AtomicUsize::new(0));
            if updating {
                update::start(app.path().app_data_dir()?);
            }
            let url = format!("http://127.0.0.1:{PORT}/{}", if updating { "__splash" } else { "" });
            let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title(if cfg!(target_os = "macos") { "" } else { "openDAW Studio" })
                .inner_size(1400.0, 900.0)
                .maximized(true)
                .background_color(tauri::window::Color(21, 23, 25, 255))
                .disable_drag_drop_handler()
                .background_throttling(BackgroundThrottlingPolicy::Disabled)
                .devtools(true)
                .initialization_script(&shell_info)
                .on_new_window(move |url, features| open_window(&handle, &counter, url, features, true))
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
        .build(tauri::generate_context!())
        .expect("tauri build")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                stop_engine();
            }
        });
}
