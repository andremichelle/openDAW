// a release build has no console window on Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod components;
mod files;
#[cfg(target_os = "linux")]
mod isolation;
mod log;
mod menu;
mod shell_update;
mod uninstall;
mod update;
mod wclap;
mod zoom;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use tauri::utils::config::{BackgroundThrottlingPolicy, WebviewUrl};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, WindowEvent};

// Bump when a primitive is added or changed; a build's build-info.json shellApi must not exceed it
pub const SHELL_API: u64 = 3;
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

// macOS asks before Dock "Quit", logout, restart and shutdown; tao does not answer, which would mean "terminate now".
// Once the page guards its work it is asked like for Cmd+Q, and macOS waits for its answer.
#[cfg(target_os = "macos")]
mod terminate {
    use std::sync::atomic::{AtomicBool, Ordering};
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::NSApplication;

    const NOW: usize = 1;
    const LATER: usize = 2;

    static PENDING: AtomicBool = AtomicBool::new(false);
    pub static APPROVED: AtomicBool = AtomicBool::new(false);

    extern "C-unwind" fn should_terminate(_delegate: &AnyObject, _selector: Sel, _sender: *mut AnyObject) -> usize {
        if APPROVED.load(Ordering::SeqCst) || !super::CLOSE_GUARDED.load(Ordering::SeqCst) { return NOW; }
        let Some(app) = super::APP.get() else { return NOW };
        PENDING.store(true, Ordering::SeqCst);
        super::request_quit(app);
        LATER
    }

    pub fn install() {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let Some(delegate) = NSApplication::sharedApplication(mtm).delegate() else { return };
        let object: &AnyObject = delegate.as_ref();
        let class: &AnyClass = object.class();
        let imp: Imp = unsafe { std::mem::transmute(should_terminate as extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize) };
        let added = unsafe { objc2::ffi::class_addMethod(class as *const AnyClass as *mut AnyClass, sel!(applicationShouldTerminate:), imp, c"Q@:@".as_ptr()) };
        if !added.as_bool() { eprintln!("[openDAW] could not answer applicationShouldTerminate"); }
    }

    // the page's answer to a quit macOS asked for; false when macOS did not ask
    pub fn reply(quit: bool) -> bool {
        if !PENDING.swap(false, Ordering::SeqCst) { return false; }
        if let Some(app) = super::APP.get() {
            let _ = app.run_on_main_thread(move || {
                if let Some(mtm) = MainThreadMarker::new() { NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(quit); }
            });
        }
        true
    }
}

// the page decided to quit: macOS goes on with a quit it asked for, any other quit exits here
pub fn quit_approved(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        terminate::APPROVED.store(true, Ordering::SeqCst);
        if terminate::reply(true) { return; }
    }
    app.exit(0)
}

// the version this build was made as (a test build is 0.0.<n>, set by desktop.yml), the one the updater compares
pub fn app_version() -> String {
    APP.get().map(|app| app.package_info().version.to_string()).unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

// the page kept the app open: a logout or restart macOS asked for is cancelled
pub fn quit_cancelled() {
    #[cfg(target_os = "macos")]
    terminate::reply(false);
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
fn popout_script(label: &str, token: &str) -> String {
    format!(r#"(() => {{
        if (window.__shellClose__) {{return}}
        const shell = path => fetch(`http://127.0.0.1:{PORT}/${{path}}&token={token}`, {{mode: "no-cors"}}).catch(() => {{}})
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
            shell("__close?label={label}")
        }}
        window.close = window.__shellClose__
    }})()"#)
}

fn open_window(handle: &AppHandle, counter: &Arc<AtomicUsize>, url: tauri::Url, features: tauri::webview::NewWindowFeatures,
               from_main: bool) -> NewWindowResponse<tauri::Wry> {
    let label = format!("popout-{}", counter.fetch_add(1, Ordering::SeqCst));
    let utility = url.query_pairs().any(|(key, _)| key == "utility");
    let close = popout_script(&label, files::token());
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
        // the script carries the shell token, so it only goes into the studio's own pages
        .on_page_load(move |window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) && is_own_page(payload.url()) {
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

// The engine comes with each release (plans/engine-updates.md), a debug build runs the engine crate's release build
fn engine_binary(root: &Path) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("OPENDAW_ENGINE") {
        return Some(PathBuf::from(path));
    }
    if cfg!(debug_assertions) {
        return Some(PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/engine/target/release/opendaw-engine")));
    }
    release_engine(root)
}

// the platform's folder in a release's engine/ (deploy.yml builds one per installer platform)
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub const ENGINE_PLATFORM: &str = "macos-arm64";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
pub const ENGINE_PLATFORM: &str = "macos-intel";
#[cfg(target_os = "windows")]
pub const ENGINE_PLATFORM: &str = "windows";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub const ENGINE_PLATFORM: &str = "linux";
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
pub const ENGINE_PLATFORM: &str = "linux-arm64";

// downloaded files are not executable, macOS and Linux need the bit
fn release_engine(root: &Path) -> Option<PathBuf> {
    let path = root.join("engine").join(ENGINE_PLATFORM).join(engine_file_name());
    if !path.is_file() { return None; }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&path).ok()?.permissions();
        if permissions.mode() & 0o111 != 0o111 {
            permissions.set_mode(0o755);
            std::fs::set_permissions(&path, permissions).map_err(|error| eprintln!("[openDAW] {} is not executable ({error})", path.display())).ok()?;
        }
    }
    Some(path)
}

// opendaw-engine.exe on Windows
fn engine_file_name() -> String {format!("opendaw-engine{}", std::env::consts::EXE_SUFFIX)}

// Windows: the engine and its plugin scans run without a console window of their own
#[cfg(target_os = "windows")]
fn without_console(command: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000)
}

#[cfg(not(target_os = "windows"))]
fn without_console(command: &mut std::process::Command) -> &mut std::process::Command {command}


// The native engine process serves the build in root, with the shell token
fn spawn_engine(binary: &Path, root: &Path) -> Option<std::process::Child> {
    // the engine exits when this pipe closes, so it never outlives the shell
    let mut command = std::process::Command::new(binary);
    without_console(&mut command).env("OPENDAW_ENGINE_TOKEN", files::token()).env("OPENDAW_DIST", root)
        .env("OPENDAW_SHELL_PID", std::process::id().to_string()).stdin(std::process::Stdio::piped());
    if log::folder().is_some() { command.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()); }
    let mut child = command.spawn().map_err(|error| eprintln!("[openDAW] cannot start the engine {} ({error})", binary.display())).ok()?;
    log::attach(&mut child);
    Some(child)
}

// the running engine's binary, and a count that retires the watcher of a replaced engine
static ENGINE_BINARY: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);
static ENGINE_GENERATION: AtomicUsize = AtomicUsize::new(0);

// a rollback to the previous build (watch_boot) runs that build's engine
fn start_engine(root: &Path) {
    if !native_engine() { return; }
    let Some(binary) = engine_binary(root) else {
        eprintln!("[openDAW] {} has no engine for {ENGINE_PLATFORM}", root.display());
        return;
    };
    if ENGINE.lock().unwrap().is_some() {
        if ENGINE_BINARY.lock().unwrap().as_ref() == Some(&binary) { return; }
        stop_engine();
    }
    let mut engine = ENGINE.lock().unwrap();
    *engine = spawn_engine(&binary, root);
    if engine.is_some() {
        println!("[openDAW] engine {}", binary.display());
        *ENGINE_BINARY.lock().unwrap() = Some(binary.clone());
        let generation = ENGINE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        let root = root.to_path_buf();
        std::thread::spawn(move || watch_engine(binary, root, generation));
    }
}

// An engine that went down is replaced at once, the studio reconnects once the user restarts its engine
fn watch_engine(binary: PathBuf, root: PathBuf, generation: usize) {
    const MAX_RESTARTS: usize = 10;
    let mut restarts: Vec<std::time::Instant> = Vec::new();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if ENGINE_GENERATION.load(Ordering::SeqCst) != generation { return; }
        let mut engine = ENGINE.lock().unwrap();
        let Some(child) = engine.as_mut() else { return };
        let Ok(Some(status)) = child.try_wait() else { continue };
        restarts.retain(|time| time.elapsed().as_secs() < 60);
        if restarts.len() == MAX_RESTARTS {
            eprintln!("[openDAW] the engine stopped ({status}) {MAX_RESTARTS} times within a minute, it is not started again");
            *engine = None;
            return;
        }
        restarts.push(std::time::Instant::now());
        eprintln!("[openDAW] the engine stopped ({status}), starting a new one");
        *engine = spawn_engine(&binary, &root);
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

// closing its stdin lets the engine exit on its own (it clears its plugin trials), a hung one is killed
fn stop_engine() {
    if let Some(mut child) = ENGINE.lock().unwrap().take() {
        drop(child.stdin.take());
        let started = std::time::Instant::now();
        while started.elapsed() < std::time::Duration::from_secs(1) {
            if !matches!(child.try_wait(), Ok(None)) { return; }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
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

fn is_own_page(url: &tauri::Url) -> bool {
    url.as_str() == "about:blank" || (url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(PORT))
}

// the shell's own endpoints answer only callers that know the token: the studio, its popouts and the engine
fn has_token(url: &str, token: &str) -> bool {query_value(url, "token").as_deref() == Some(token)}

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
    let guarded = ["/__drag", "/__resize", "/__quit", "/__key", "/__cycle-home", "/__close"];
    if guarded.iter().any(|path| url.starts_with(path)) && !has_token(&url, files::token()) {
        let _ = request.respond(tiny_http::Response::empty(403));
        return;
    }
    if url.starts_with("/__show") {
        if let Some(app) = APP.get() {
            let main = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(window) = main.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            });
        }
        let _ = request.respond(tiny_http::Response::empty(204));
    } else if url.starts_with("/__drag") {
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
    } else if url.starts_with("/__quit") {
        // Cmd+Q in a plugin window: the native menu never sees it, the engine passes it on
        if let Some(app) = APP.get() {
            let main = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(window) = main.get_webview_window("main") { let _ = window.set_focus(); }
                request_quit(&main);
            });
        }
        let _ = request.respond(tiny_http::Response::empty(204));
    } else if url.starts_with("/__key") {
        replay_key(&url);
        let _ = request.respond(tiny_http::Response::empty(204));
    } else if url.starts_with("/__cycle-home") {
        if let Some(window) = APP.get().and_then(|app| app.get_webview_window("main")) {
            let _ = window.set_focus();
        }
        let _ = request.respond(tiny_http::Response::empty(204));
    } else if url.starts_with("/__close") {
        if let Some(window) = popout(&url) {
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

fn run_server(listener: std::net::TcpListener) {
    let server = tiny_http::Server::from_listener(listener, None).expect("shell server");
    for request in server.incoming_requests() {
        std::thread::spawn(move || serve(request));
    }
}

fn required_shell_api(root: &Path) -> Option<u64> {
    let bytes = std::fs::read(root.join("build-info.json")).ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes).ok()?.get("shellApi")?.as_u64()
}

// another openDAW holds the shell's port: it shows its window (answers 204), this start ends
fn show_running() -> bool {
    use std::io::{Read, Write};
    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", PORT)) else { return false };
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
    let mut reply = [0u8; 12];
    stream.write_all(b"GET /__show HTTP/1.0\r\n\r\n").is_ok() && stream.read_exact(&mut reply).is_ok() && reply.ends_with(b" 204")
}

fn main() {
    // WebKitGTK before 321889@main hides SharedArrayBuffer even on a cross-origin isolated page
    #[cfg(target_os = "linux")]
    if std::env::var_os("JSC_useSharedArrayBuffer").is_none() { std::env::set_var("JSC_useSharedArrayBuffer", "1"); }
    // one openDAW at a time: the shell's port is the lock, before anything else (the engine) starts
    let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", PORT)) else {
        if show_running() { return; }
        panic!("port {PORT} is taken by another program, openDAW cannot start");
    };
    // OPENDAW_DIST, or a debug build without OPENDAW_UPDATE, serves a local build and skips the update flow
    let local = std::env::var("OPENDAW_DIST").ok().map(PathBuf::from)
        .or_else(|| (cfg!(debug_assertions) && std::env::var("OPENDAW_UPDATE").is_err()).then(|| PathBuf::from(DEFAULT_DIST)));
    let updating = local.is_none();
    if let Some(local) = local {
        set_root(local);
    }
    std::thread::spawn(move || run_server(listener));
    std::thread::spawn(wclap::run_plugin_server);
    let engine_info = if native_engine() { format!(", engine: {{port: {ENGINE_PORT}, token: \"{}\"}}", files::token()) } else { String::new() };
    let shell_info = format!("window.__OPENDAW_SHELL__ = {{token: \"{}\", api: {SHELL_API}{engine_info}}}", files::token());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_menu_event(|app, event| menu::clicked(app, event.id().as_ref()))
        .setup(move |app| {
            let handle = app.handle().clone();
            let _ = APP.set(handle.clone());
            menu::start(&handle)?;
            if !cfg!(debug_assertions) { log::start(&app.path().app_data_dir()?); }
            #[cfg(target_os = "macos")]
            install_cycle_monitor(handle.clone());
            #[cfg(target_os = "macos")]
            terminate::install();
            let counter = Arc::new(AtomicUsize::new(0));
            if updating {
                update::start(app.path().app_data_dir()?);
                shell_update::start(app.handle().clone());
            }
            let url = format!("http://127.0.0.1:{PORT}/{}", if updating { "__splash" } else { "" });
            // Linux loads the studio once the webview can isolate it
            let start = if cfg!(target_os = "linux") { "about:blank" } else { url.as_str() };
            let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(start.parse().unwrap()))
                .title(if cfg!(target_os = "macos") { "" } else { "openDAW Studio" })
                .inner_size(1400.0, 900.0)
                .maximized(true)
                // a click coming from a plugin window (the engine is an app of its own) acts at once, not only activates
                .accept_first_mouse(true)
                .background_color(tauri::window::Color(21, 23, 25, 255))
                .disable_drag_drop_handler()
                .background_throttling(BackgroundThrottlingPolicy::Disabled)
                .devtools(true)
                .initialization_script(&shell_info)
                .on_new_window(move |url, features| open_window(&handle, &counter, url, features, true))
                .build()?;
            zoom::restore(&main);
            #[cfg(target_os = "linux")]
            main.with_webview(move |webview| isolation::load(&webview.inner(), &url))?;
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
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                stop_engine();
                if !uninstall::finish(app) { shell_update::finish(app); }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_file_name_has_the_platform_suffix() {
        assert_eq!(engine_file_name(), format!("opendaw-engine{}", std::env::consts::EXE_SUFFIX));
        assert!(!cfg!(target_os = "windows") || engine_file_name().ends_with(".exe"));
    }

    // a release carries its own engine, the shell runs it instead of the bundled one
    #[test]
    fn a_release_engine_is_run_from_the_release() {
        let root = std::env::temp_dir().join(format!("opendaw-release-engine-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(release_engine(&root), None, "a release without engines");
        let folder = root.join("engine").join(ENGINE_PLATFORM);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join(engine_file_name()), b"engine").unwrap();
        let engine = release_engine(&root);
        assert_eq!(engine, Some(folder.join(engine_file_name())));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(engine.unwrap()).unwrap().permissions().mode() & 0o111, 0o111, "downloaded files are not executable");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn shell_endpoints_need_the_token() {
        assert!(has_token("/__close?label=popout-1&token=abc", "abc"));
        assert!(!has_token("/__close?label=popout-1", "abc"));
        assert!(!has_token("/__close?label=popout-1&token=abd", "abc"));
        assert!(!has_token("/__quit?token=", "abc"));
    }

    #[test]
    fn only_own_pages_get_the_popout_script() {
        assert!(is_own_page(&"about:blank".parse().unwrap()));
        assert!(is_own_page(&format!("http://127.0.0.1:{PORT}/popout.html").parse().unwrap()));
        assert!(!is_own_page(&"https://accounts.google.com/o/oauth2".parse().unwrap()));
        assert!(!is_own_page(&"http://127.0.0.1:8080/".parse().unwrap()));
    }
}
