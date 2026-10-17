// Optional components: files of the served build marked with a component name (FFmpeg, manuals, docs, the ONNX
// runtime). A selected component's files come with every studio update; Neural Demux also downloads its models
// straight from their URLs into <app data>/components/neural, kept across studio updates.
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::{root, APP, UPDATE_ORIGIN};

#[derive(Deserialize, Clone)]
pub struct Model {
    pub path: String,
    pub url: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Deserialize)]
struct Entry {
    path: String,
    size: u64,
    sha256: String,
    download: Option<u64>,
    component: Option<String>,
}

#[derive(Deserialize)]
struct Manifest {
    files: Vec<Entry>,
}

#[derive(Serialize, Clone)]
struct Status {
    installed: bool,
    selected: bool,
    phase: &'static str,
    done: u64,
    total: u64,
    message: String,
}

static STATUS: Mutex<Option<Status>> = Mutex::new(None);

fn base() -> Option<PathBuf> {
    Some(APP.get()?.path().app_data_dir().ok()?.join("components"))
}

fn directory(name: &str) -> Option<PathBuf> {
    Some(base()?.join(name))
}

// whether the first-launch choice was made; until then the installer asks
pub fn choice_made() -> bool {
    base().is_some_and(|dir| dir.join("chosen").is_file())
}

pub fn select(names: &[String]) {
    let Some(base) = base() else { return };
    for name in names {
        let _ = fs::create_dir_all(base.join(name));
        let _ = fs::write(base.join(name).join("selected"), "");
    }
    let _ = fs::write(base.join("chosen"), "");
}

pub fn is_selected(name: &str) -> bool {
    directory(name).is_some_and(|dir| dir.join("selected").is_file())
}

fn component_files_present(name: &str) -> bool {
    let Some(root) = root() else { return false };
    let Ok(bytes) = fs::read(root.join("manifest.json")) else { return false };
    let Ok(manifest) = serde_json::from_slice::<Manifest>(&bytes) else { return false };
    manifest.files.iter().filter(|entry| entry.component.as_deref() == Some(name))
        .all(|entry| root.join(&entry.path).metadata().is_ok_and(|meta| meta.len() == entry.size))
}

// selected, its files are in the served build, and Neural Demux has its models
pub fn is_installed(name: &str) -> bool {
    is_selected(name) && component_files_present(name)
        && (name != "neural" || directory(name).is_some_and(|dir| dir.join("models-installed").is_file()))
}

fn safe(path: &str) -> bool {
    !path.is_empty() && !path.starts_with('/') && !path.contains('\\') && path.split('/').all(|part| part != ".." && !part.is_empty())
}

fn sha256_of(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).ok()?;
    Some(format!("{:x}", hasher.finalize()))
}

fn set_status(phase: &'static str, done: u64, total: u64, message: impl Into<String>) {
    *STATUS.lock().unwrap() = Some(Status { installed: false, selected: false, phase, done, total, message: message.into() });
}

pub fn status_json(name: &str) -> String {
    let status = STATUS.lock().unwrap().clone().unwrap_or(Status {
        installed: false, selected: false, phase: "idle", done: 0, total: 0, message: String::new()
    });
    serde_json::to_string(&Status { installed: is_installed(name), selected: is_selected(name), ..status }).unwrap()
}

pub fn model_path(name: &str, model: &Model) -> Option<PathBuf> {
    safe(&model.path).then(|| directory(name).map(|dir| dir.join("models").join(&model.path))).flatten()
}

pub fn has_model(name: &str, model: &Model) -> bool {
    model_path(name, model).and_then(|path| sha256_of(&path)).as_deref() == Some(model.sha256.as_str())
}

pub fn mark_models_installed(name: &str) -> Result<(), String> {
    let directory = directory(name).ok_or("no app data folder")?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs::write(directory.join("models-installed"), "").map_err(|error| error.to_string())
}

// Streams url into target, verified by sha256 (and size when known); progress reports bytes on the wire
pub fn fetch(agent: &ureq::Agent, url: &str, target: &Path, sha256: &str, size: Option<u64>, progress: &mut dyn FnMut(u64)) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = crate::update::temporary_of(target);
    let response = agent.get(url).call().map_err(|error| format!("{url}: {error}"))?;
    let mut reader = response.into_reader();
    let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    let mut written = 0u64;
    loop {
        let count = reader.read(&mut buffer).map_err(|error| format!("{url}: {error}"))?;
        if count == 0 { break; }
        hasher.update(&buffer[..count]);
        file.write_all(&buffer[..count]).map_err(|error| error.to_string())?;
        written += count as u64;
        progress(count as u64);
    }
    drop(file);
    let digest = format!("{:x}", hasher.finalize());
    if digest != sha256 || size.is_some_and(|size| size != written) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("{url} failed verification"));
    }
    fs::rename(&temporary, target).map_err(|error| error.to_string())
}

fn install_blocking(name: &str, models: &[Model]) -> Result<(), String> {
    let root = root().ok_or("no build is served")?;
    let directory = directory(name).ok_or("no app data folder")?;
    let manifest: Manifest = serde_json::from_slice(&fs::read(root.join("manifest.json")).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let runtime: Vec<&Entry> = manifest.files.iter()
        .filter(|entry| entry.component.as_deref() == Some(name) && safe(&entry.path))
        .filter(|entry| sha256_of(&root.join(&entry.path)).as_deref() != Some(entry.sha256.as_str()))
        .collect();
    let missing: Vec<&Model> = models.iter()
        .filter(|model| safe(&model.path))
        .filter(|model| sha256_of(&directory.join("models").join(&model.path)).as_deref() != Some(model.sha256.as_str()))
        .collect();
    let total = runtime.iter().map(|entry| entry.download.unwrap_or(entry.size)).sum::<u64>() + missing.iter().map(|model| model.bytes).sum::<u64>();
    let done = Mutex::new(0u64);
    set_status("downloading", 0, total, "");
    let agent = crate::update::agent();
    let release = root.file_name().and_then(|name| name.to_str()).unwrap_or("").to_string();
    let progress = |count: u64, failed: bool| {
        let mut done = done.lock().unwrap();
        *done = if failed { done.saturating_sub(count) } else { *done + count };
        set_status("downloading", (*done).min(total), total, "");
    };
    // a failed attempt takes back the bytes it counted, its retry counts them again
    let attempt = |url: &str, target: &Path, sha256: &str, size: Option<u64>| crate::update::with_retries(|| {
        let mut counted = 0u64;
        let result = fetch(&agent, url, target, sha256, size, &mut |count| {
            counted += count;
            progress(count, false)
        });
        if result.is_err() { progress(counted, true); }
        result
    });
    crate::update::in_parallel(&runtime, |entry| {
        let url = format!("{UPDATE_ORIGIN}/tauri/releases/{release}/{}", entry.path);
        attempt(&url, &root.join(&entry.path), &entry.sha256, Some(entry.size))
    })?;
    for model in missing {
        attempt(&model.url, &directory.join("models").join(&model.path), &model.sha256, None)?;
    }
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs::write(directory.join("selected"), "").map_err(|error| error.to_string())?;
    if !models.is_empty() {fs::write(directory.join("models-installed"), "").map_err(|error| error.to_string())?;}
    Ok(())
}

pub fn install(name: String, models: Vec<Model>) {
    if STATUS.lock().unwrap().as_ref().is_some_and(|status| status.phase == "downloading") { return; }
    set_status("downloading", 0, 0, "");
    std::thread::spawn(move || match install_blocking(&name, &models) {
        Ok(()) => {
            println!("[components] {name} installed");
            set_status("done", 0, 0, "");
        }
        Err(error) => {
            eprintln!("[components] {name}: {error}");
            set_status("error", 0, 0, error);
        }
    });
}

pub fn model(name: &str, path: &str) -> Option<Vec<u8>> {
    if !safe(path) { return None; }
    fs::read(directory(name)?.join("models").join(path)).ok()
}
