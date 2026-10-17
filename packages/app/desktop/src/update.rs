use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::{set_root, APP, HEADERS, SHELL_API, UPDATE_ORIGIN};

const POINTER_TIMEOUT: Duration = Duration::from_secs(3);
const BOOT_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Deserialize)]
struct Pointer {
    uuid: String,
    #[serde(rename = "shellApi")]
    shell_api: Option<u64>,
}

#[derive(Deserialize)]
struct Entry {
    path: String,
    size: u64,
    sha256: String,
    // bytes on the wire (the .br file where one exists); older manifests have none
    download: Option<u64>,
    // an optional component's file, downloaded only once the component is installed
    component: Option<String>,
}

impl Entry {
    fn transfer(&self) -> u64 {self.download.unwrap_or(self.size)}
}

#[derive(Deserialize)]
struct Manifest {
    #[serde(default)]
    components: Vec<ComponentInfo>,
    files: Vec<Entry>,
}

#[derive(Deserialize)]
struct ComponentInfo {
    name: String,
    label: String,
    description: String,
    selected: bool,
    // downloaded from their own URLs into the app data, not part of the build
    #[serde(default)]
    models: Vec<crate::components::Model>,
}

// a component the installer offers, with its download size
#[derive(Serialize, Clone)]
struct Choice {
    name: String,
    label: String,
    description: String,
    size: u64,
    selected: bool,
}

#[derive(Serialize, Clone)]
struct Status {
    phase: &'static str,
    message: String,
    done: u64,
    total: u64,
    installed: bool,
    core: u64,
    components: Vec<Choice>,
}

static STATUS: Mutex<Status> = Mutex::new(Status {
    phase: "checking", message: String::new(), done: 0, total: 0, installed: false, core: 0, components: Vec::new()
});
static CHOICE: Mutex<Option<Vec<String>>> = Mutex::new(None);
static SKIP: AtomicBool = AtomicBool::new(false);
static RETRY: AtomicBool = AtomicBool::new(false);
static WEB: Mutex<Option<PathBuf>> = Mutex::new(None);

fn status(phase: &'static str, message: impl Into<String>) {
    let mut status = STATUS.lock().unwrap();
    status.phase = phase;
    status.message = message.into();
}

fn progress(done: u64, total: u64) {
    let mut status = STATUS.lock().unwrap();
    status.done = done;
    status.total = total;
}

fn read_text(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok().map(|text| text.trim().to_string()).filter(|text| !text.is_empty())
}

fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, text)?;
    fs::rename(temporary, path)
}

fn is_installed(web: &Path, uuid: &str) -> bool {
    web.join(uuid).join("manifest.json").is_file()
}

fn installed(web: &Path) -> Option<String> {
    read_text(&web.join("current")).filter(|uuid| is_installed(web, uuid))
}

fn is_bad(web: &Path, uuid: &str) -> bool {
    read_text(&web.join("bad")).is_some_and(|text| text.lines().any(|line| line == uuid))
}

fn mark_bad(web: &Path, uuid: &str) {
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(web.join("bad")) {
        let _ = writeln!(file, "{uuid}");
    }
}

// The build that never reported a boot goes on the bad list and the previous build becomes current again
fn roll_back(web: &Path) -> Option<String> {
    let failed = read_text(&web.join("pending"))?;
    let _ = fs::remove_file(web.join("pending"));
    eprintln!("[update] build {failed} did not boot, rolling back");
    mark_bad(web, &failed);
    let previous = read_text(&web.join("previous")).filter(|uuid| uuid != &failed && is_installed(web, uuid))?;
    write_atomic(&web.join("current"), &previous).ok()?;
    Some(previous)
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5)).timeout_read(Duration::from_secs(30)).build()
}

enum Unavailable {
    Offline,
    NoBuild,
}

fn fetch_pointer() -> Result<Pointer, Unavailable> {
    let agent = ureq::AgentBuilder::new().timeout(POINTER_TIMEOUT).build();
    let url = format!("{UPDATE_ORIGIN}/tauri/build-info.json");
    match agent.get(&url).call() {
        Ok(response) => response.into_json().map_err(|error| {
            eprintln!("[update] {url} is no build info: {error}");
            Unavailable::NoBuild
        }),
        Err(ureq::Error::Status(code, _)) => {
            eprintln!("[update] {url}: status {code}");
            Err(Unavailable::NoBuild)
        }
        Err(error) => {
            eprintln!("[update] {url}: {error}");
            Err(Unavailable::Offline)
        }
    }
}

fn sha256_of(path: &Path) -> Option<(u64, String)> {
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let size = std::io::copy(&mut file, &mut hasher).ok()?;
    Some((size, format!("{:x}", hasher.finalize())))
}

fn matches(path: &Path, entry: &Entry) -> bool {
    path.metadata().is_ok_and(|meta| meta.len() == entry.size)
        && sha256_of(path).is_some_and(|(size, sha)| size == entry.size && sha == entry.sha256)
}

fn safe_path(path: &str) -> bool {
    !path.is_empty() && !path.starts_with('/') && !path.contains('\\') && path.split('/').all(|segment| segment != ".." && !segment.is_empty())
}

// The server answers with the brotli file where one exists; ureq decodes it, the checks run on the decoded bytes
fn download_file(agent: &ureq::Agent, url: &str, target: &Path, entry: &Entry) -> Result<(), String> {
    let temporary = target.with_extension("download");
    let response = agent.get(url).call().map_err(|error| format!("{url}: {error}"))?;
    let mut reader = response.into_reader();
    let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    let mut size = 0u64;
    loop {
        let count = reader.read(&mut buffer).map_err(|error| format!("{url}: {error}"))?;
        if count == 0 { break; }
        hasher.update(&buffer[..count]);
        file.write_all(&buffer[..count]).map_err(|error| error.to_string())?;
        size += count as u64;
    }
    drop(file);
    let sha = format!("{:x}", hasher.finalize());
    if size != entry.size || sha != entry.sha256 {
        let _ = fs::remove_file(&temporary);
        return Err(format!("{} failed verification", entry.path));
    }
    fs::rename(&temporary, target).map_err(|error| error.to_string())
}

// Downloads into {uuid}.partial, reusing verified files from an earlier attempt and identical files of the current build
fn download(web: &Path, uuid: &str, current: Option<&str>) -> Result<(), String> {
    let agent = agent();
    let base = format!("{UPDATE_ORIGIN}/tauri/releases/{uuid}");
    let manifest_bytes = agent.get(&format!("{base}/manifest.json")).call()
        .map_err(|error| error.to_string())?
        .into_string().map_err(|error| error.to_string())?;
    let manifest: Manifest = serde_json::from_str(&manifest_bytes).map_err(|error| error.to_string())?;
    let local: HashMap<String, PathBuf> = current
        .and_then(|current| {
            let root = web.join(current);
            let bytes = fs::read(root.join("manifest.json")).ok()?;
            let manifest: Manifest = serde_json::from_slice(&bytes).ok()?;
            Some(manifest.files.into_iter().map(|entry| (entry.sha256, root.join(entry.path))).collect())
        })
        .unwrap_or_default();
    let partial = web.join(format!("{uuid}.partial"));
    let mut done = 0u64;
    let mut transferred = 0u64;
    let wanted = |entry: &&Entry| entry.component.as_deref().map_or(true, crate::components::is_selected);
    let models: Vec<(String, crate::components::Model)> = manifest.components.iter()
        .filter(|component| crate::components::is_selected(&component.name))
        .flat_map(|component| component.models.iter().filter(|model| !crate::components::has_model(&component.name, model))
            .map(|model| (component.name.clone(), model.clone())))
        .collect();
    let total = manifest.files.iter().filter(wanted).map(Entry::transfer).sum::<u64>() + models.iter().map(|(_, model)| model.bytes).sum::<u64>();
    progress(0, total);
    for entry in manifest.files.iter().filter(wanted) {
        if SKIP.load(Ordering::SeqCst) {
            return Err("skipped".into());
        }
        if !safe_path(&entry.path) {
            return Err(format!("unsafe path {}", entry.path));
        }
        let target = partial.join(&entry.path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        if !matches(&target, entry) {
            let copied = local.get(&entry.sha256)
                .is_some_and(|source| fs::copy(source, &target).is_ok() && matches(&target, entry));
            if !copied {
                download_file(&agent, &format!("{base}/{}", entry.path), &target, entry)?;
                transferred += entry.transfer();
            }
        }
        done += entry.transfer();
        progress(done, total);
    }
    for (name, model) in &models {
        if SKIP.load(Ordering::SeqCst) {
            return Err("skipped".into());
        }
        let target = crate::components::model_path(name, model).ok_or_else(|| format!("unsafe model path {}", model.path))?;
        crate::components::fetch(&agent, &model.url, &target, &model.sha256, None, &mut |count| {
            done += count;
            progress(done.min(total), total);
        })?;
        transferred += model.bytes;
    }
    for component in manifest.components.iter().filter(|component| !component.models.is_empty() && crate::components::is_selected(&component.name)) {
        crate::components::mark_models_installed(&component.name)?;
    }
    let files: u64 = manifest.files.iter().map(|entry| entry.size).sum();
    println!("[update] {uuid}: {:.1} MB of files, {:.1} MB downloaded", files as f64 / 1048576.0, transferred as f64 / 1048576.0);
    fs::write(partial.join("manifest.json"), manifest_bytes).map_err(|error| error.to_string())?;
    let complete = web.join(uuid);
    if complete.exists() {
        fs::remove_dir_all(&complete).map_err(|error| error.to_string())?;
    }
    fs::rename(&partial, &complete).map_err(|error| error.to_string())
}

// Makes uuid current, keeps the old current as previous and deletes every other build
fn switch(web: &Path, uuid: &str, previous: Option<&str>) -> std::io::Result<()> {
    if let Some(previous) = previous {
        write_atomic(&web.join("previous"), previous)?;
    }
    write_atomic(&web.join("pending"), uuid)?;
    write_atomic(&web.join("current"), uuid)?;
    for entry in fs::read_dir(web)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.path().is_dir() && name != uuid && Some(name.as_str()) != previous {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
}

// First launch: the installer lists the optional components with their sizes and waits for the user's choice
fn ask_components(uuid: &str) {
    let url = format!("{UPDATE_ORIGIN}/tauri/releases/{uuid}/manifest.json");
    let Ok(manifest) = agent().get(&url).call().map_err(|error| error.to_string())
        .and_then(|response| response.into_json::<Manifest>().map_err(|error| error.to_string())) else { return };
    if manifest.components.is_empty() { return; }
    let size_of = |name: Option<&str>| manifest.files.iter().filter(|entry| entry.component.as_deref() == name).map(Entry::transfer).sum::<u64>();
    let choices: Vec<Choice> = manifest.components.iter().map(|info| Choice {
        name: info.name.clone(), label: info.label.clone(), description: info.description.clone(),
        size: size_of(Some(&info.name)) + info.models.iter().map(|model| model.bytes).sum::<u64>(), selected: info.selected
    }).collect();
    {
        let mut status = STATUS.lock().unwrap();
        status.core = size_of(None);
        status.components = choices;
    }
    status("choose", "");
    *CHOICE.lock().unwrap() = None;
    let names = loop {
        if let Some(names) = CHOICE.lock().unwrap().take() { break names; }
        std::thread::sleep(Duration::from_millis(100));
    };
    let names: Vec<String> = names.into_iter().filter(|name| manifest.components.iter().any(|info| &info.name == name)).collect();
    crate::components::select(&names);
}

fn choose(web: &Path) -> Option<PathBuf> {
    status("checking", "Checking for updates");
    let mut current = installed(web);
    if read_text(&web.join("pending")).is_some() {
        current = roll_back(web).or(current);
    }
    STATUS.lock().unwrap().installed = current.is_some();
    match fetch_pointer() {
        Ok(pointer) if Some(&pointer.uuid) != current.as_ref() => {
            let required = pointer.shell_api.unwrap_or(SHELL_API);
            if required > SHELL_API {
                eprintln!("[update] build {} needs shell api {required}, this shell has {SHELL_API}", pointer.uuid);
                if current.is_none() {
                    status("error", "This studio version needs a newer openDAW app. Please download the latest app.");
                }
            } else if is_bad(web, &pointer.uuid) {
                eprintln!("[update] build {} is marked bad", pointer.uuid);
            } else {
                if current.is_none() && !crate::components::choice_made() {ask_components(&pointer.uuid);}
                status("downloading", "Downloading the studio");
                match download(web, &pointer.uuid, current.as_deref()).and_then(|_| switch(web, &pointer.uuid, current.as_deref()).map_err(|error| error.to_string())) {
                    Ok(_) => {
                        watch_boot(web.to_path_buf(), pointer.uuid.clone());
                        current = Some(pointer.uuid);
                    }
                    Err(error) => {
                        eprintln!("[update] {error}");
                        if current.is_none() {
                            status("error", format!("The download failed ({error})"));
                        }
                    }
                }
            }
        }
        Ok(_) => {}
        Err(Unavailable::Offline) if current.is_none() => status("offline", "The first launch needs an internet connection."),
        Err(Unavailable::NoBuild) if current.is_none() => {
            let host = UPDATE_ORIGIN.split("://").nth(1).unwrap_or(UPDATE_ORIGIN);
            status("error", format!("No desktop build is available yet ({host})."))
        }
        Err(_) => {}
    }
    current.map(|uuid| web.join(uuid))
}

// A new build that does not report its boot in time is rolled back during this session too
fn watch_boot(web: PathBuf, uuid: String) {
    std::thread::spawn(move || {
        std::thread::sleep(BOOT_TIMEOUT);
        if read_text(&web.join("pending")).as_deref() != Some(uuid.as_str()) { return; }
        if let Some(previous) = roll_back(&web) {
            set_root(web.join(previous));
            if let Some(window) = APP.get().and_then(|app| app.get_webview_window("main")) {
                let _ = window.eval("location.replace('/')");
            }
        }
    });
}

// The studio guards its close once it has booted, which confirms a freshly installed build
pub fn booted() {
    if let Some(web) = WEB.lock().unwrap().as_ref() {
        let _ = fs::remove_file(web.join("pending"));
    }
}

pub fn start(data: PathBuf) {
    let web = data.join("web");
    *WEB.lock().unwrap() = Some(web.clone());
    std::thread::spawn(move || {
        if let Err(error) = fs::create_dir_all(&web) {
            return status("error", format!("Cannot create {} ({error})", web.display()));
        }
        println!("[update] builds in {}, updates from {UPDATE_ORIGIN}", web.display());
        loop {
            SKIP.store(false, Ordering::SeqCst);
            if let Some(root) = choose(&web) {
                set_root(root);
                return status("ready", "");
            }
            while !RETRY.swap(false, Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    });
}

fn reply(request: tiny_http::Request, body: Vec<u8>, content_type: &str) {
    let mut response = tiny_http::Response::from_data(body);
    response.add_header(tiny_http::Header::from_bytes("Content-Type", content_type).unwrap());
    for (key, value) in HEADERS {
        response.add_header(tiny_http::Header::from_bytes(key, value).unwrap());
    }
    let _ = request.respond(response);
}

// The splash page and its status, served before any studio build is chosen
pub fn handle(request: tiny_http::Request) -> Option<tiny_http::Request> {
    let path = request.url().split('?').next().unwrap_or("").to_string();
    match path.as_str() {
        "/__splash" => {
            let page = SPLASH.replace("{LOGO}", LOGO).replace("{VERSION}", env!("CARGO_PKG_VERSION"));
            reply(request, page.into_bytes(), "text/html; charset=utf-8")
        }
        "/__splash/rubik-300.woff2" => reply(request, RUBIK_300.to_vec(), "font/woff2"),
        "/__splash/rubik-400.woff2" => reply(request, RUBIK_400.to_vec(), "font/woff2"),
        "/__update/status" => {
            let body = serde_json::to_vec(&*STATUS.lock().unwrap()).unwrap();
            reply(request, body, "application/json")
        }
        "/__update/skip" => {
            SKIP.store(true, Ordering::SeqCst);
            reply(request, Vec::new(), "text/plain")
        }
        "/__update/choose" => {
            let selected = request.url().split_once("selected=").map(|(_, names)| names.split('&').next().unwrap_or("").to_string()).unwrap_or_default();
            *CHOICE.lock().unwrap() = Some(selected.split(',').filter(|name| !name.is_empty()).map(String::from).collect());
            reply(request, Vec::new(), "text/plain")
        }
        "/__update/retry" => {
            RETRY.store(true, Ordering::SeqCst);
            reply(request, Vec::new(), "text/plain")
        }
        _ => return Some(request),
    }
    None
}

const SPLASH: &str = include_str!("../splash/splash.html");
const LOGO: &str = include_str!("../../studio/public/favicon.svg");
const RUBIK_300: &[u8] = include_bytes!("../../studio/public/fonts/rubik-300.woff2");
const RUBIK_400: &[u8] = include_bytes!("../../studio/public/fonts/rubik-400.woff2");
