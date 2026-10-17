// Finding plugins: the system folders and the user's own, described from moduleinfo.json or by this binary run as a
// separate scan process (a broken plugin only takes that process down), cached by path and modification time.
use std::collections::HashMap;
use std::ffi::CStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use vst3::Steinberg::*;

const SCAN_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize, Deserialize, Clone)]
pub struct PluginInfo {
    pub format: String,
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub kind: String,
    pub path: String,
    // ok, failed (the scan could not describe it), incompatible (not built for this processor), crashed (it took the
    // engine down while loading)
    pub status: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Bundle {
    modified: u64,
    status: String,
    plugins: Vec<PluginInfo>,
    crashed: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Cache {
    bundles: HashMap<String, Bundle>,
}

static CATALOGUE: Mutex<Vec<PluginInfo>> = Mutex::new(Vec::new());
static CACHE_LOCK: Mutex<()> = Mutex::new(());

fn cache_file() -> Option<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        PathBuf::from(std::env::var("HOME").ok()?).join("Library/Caches")
    } else if cfg!(target_os = "windows") {
        PathBuf::from(std::env::var("LOCALAPPDATA").ok()?)
    } else {
        std::env::var("XDG_CACHE_HOME").map(PathBuf::from).or_else(|_| std::env::var("HOME").map(|home| PathBuf::from(home).join(".cache"))).ok()?
    };
    Some(base.join("openDAW").join("plugins.json"))
}

fn read_cache() -> Cache {
    cache_file().and_then(|file| std::fs::read(file).ok()).and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

fn write_cache(cache: &Cache) {
    let Some(file) = cache_file() else { return };
    if let Some(folder) = file.parent() { let _ = std::fs::create_dir_all(folder); }
    let _ = std::fs::write(file, serde_json::to_vec(cache).unwrap());
}

fn default_folders() -> Vec<PathBuf> {
    let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_default();
    if cfg!(target_os = "macos") {
        vec![PathBuf::from("/Library/Audio/Plug-Ins/VST3"), home.join("Library/Audio/Plug-Ins/VST3")]
    } else if cfg!(target_os = "windows") {
        vec![PathBuf::from(std::env::var("CommonProgramFiles").unwrap_or("C:\\Program Files\\Common Files".into())).join("VST3")]
    } else {
        vec![home.join(".vst3"), PathBuf::from("/usr/lib/vst3"), PathBuf::from("/usr/local/lib/vst3")]
    }
}

// other bundles (an AUv3 .app embeds a copy of its plugin for itself) are not searched
fn bundles(folder: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(folder) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|extension| extension == "vst3") {
            found.push(path);
        } else if path.is_dir() && path.extension().is_none() {
            bundles(&path, found);
        }
    }
}

// a macOS bundle names its binary in Info.plist, it need not be the bundle's own name
pub(crate) fn bundle_binary(bundle: &Path) -> PathBuf {
    let folder = bundle.join("Contents/MacOS");
    let named = std::fs::read_to_string(bundle.join("Contents/Info.plist")).ok().and_then(|plist| {
        let after = &plist[plist.find("<key>CFBundleExecutable</key>")? + "<key>CFBundleExecutable</key>".len()..];
        let start = after.find("<string>")? + "<string>".len();
        Some(after[start..start + after[start..].find("</string>")?].trim().to_string())
    }).filter(|name| folder.join(name).is_file());
    let only = || std::fs::read_dir(&folder).ok().and_then(|entries| {
        let files: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).filter(|path| path.is_file()).collect();
        if files.len() == 1 { files.into_iter().next() } else { None }
    });
    named.map(|name| folder.join(name)).or_else(only)
        .unwrap_or_else(|| folder.join(bundle.file_stem().unwrap_or_default()))
}

fn modified(path: &Path) -> u64 {
    let stamp = |path: &Path| std::fs::metadata(path).and_then(|meta| meta.modified()).ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map_or(0, |duration| duration.as_secs());
    stamp(path).max(stamp(&path.join("Contents/Resources/moduleinfo.json")))
}

// moduleinfo.json is written by hand-rolled serialisers: trailing commas are common
fn lenient_json(text: &str) -> Option<serde_json::Value> {
    let chars: Vec<char> = text.chars().collect();
    let mut cleaned = String::with_capacity(text.len());
    let mut in_string = false;
    let mut index = 0;
    while index < chars.len() {
        let char = chars[index];
        if in_string {
            cleaned.push(char);
            if char == '\\' && index + 1 < chars.len() {
                cleaned.push(chars[index + 1]);
                index += 1;
            } else if char == '"' {
                in_string = false;
            }
        } else if char == '"' {
            in_string = true;
            cleaned.push(char);
        } else if char == ',' {
            let next = chars[index + 1..].iter().find(|next| !next.is_whitespace());
            if !matches!(next, Some('}') | Some(']')) { cleaned.push(char); }
        } else {
            cleaned.push(char);
        }
        index += 1;
    }
    serde_json::from_str(&cleaned).ok()
}

fn kind_of(sub_categories: &str) -> &'static str {
    if sub_categories.split('|').any(|category| category == "Instrument") { "instrument" } else { "effect" }
}

fn from_module_info(bundle: &Path) -> Option<Vec<PluginInfo>> {
    let text = std::fs::read_to_string(bundle.join("Contents/Resources/moduleinfo.json")).ok()?;
    let json = lenient_json(&text)?;
    let factory_vendor = json["Factory Info"]["Vendor"].as_str().unwrap_or("").to_string();
    Some(json["Classes"].as_array()?.iter()
        .filter(|class| class["Category"] == "Audio Module Class")
        .filter_map(|class| {
            let categories = class["Sub Categories"].as_array()
                .map(|categories| categories.iter().filter_map(|category| category.as_str()).collect::<Vec<_>>().join("|"))
                .unwrap_or_default();
            Some(PluginInfo {
                format: "vst3".into(),
                id: class["CID"].as_str()?.to_uppercase(),
                name: class["Name"].as_str().unwrap_or("").to_string(),
                vendor: class["Vendor"].as_str().map(str::to_string).unwrap_or(factory_vendor.clone()),
                kind: kind_of(&categories).into(),
                path: bundle.to_string_lossy().into(),
                status: "ok".into(),
            })
        }).collect())
}

// whether the bundle carries a binary for the processor this engine runs on
fn compatible(bundle: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        let Ok(bytes) = std::fs::read(bundle_binary(bundle)) else { return false };
        let wanted: u32 = if cfg!(target_arch = "aarch64") { 0x0100_000C } else { 0x0100_0007 };
        let be = |offset: usize| bytes.get(offset..offset + 4).map(|word| u32::from_be_bytes(word.try_into().unwrap()));
        let le = |offset: usize| bytes.get(offset..offset + 4).map(|word| u32::from_le_bytes(word.try_into().unwrap()));
        match be(0) {
            Some(0xCAFE_BABE) | Some(0xCAFE_BABF) => {
                let stride = if be(0) == Some(0xCAFE_BABF) { 32 } else { 20 };
                (0..be(4).unwrap_or(0) as usize).any(|index| be(8 + index * stride) == Some(wanted))
            }
            Some(0xCFFA_EDFE) => le(4) == Some(wanted),
            _ => false,
        }
    }
    #[cfg(target_os = "windows")]
    { bundle.join("Contents").join(if cfg!(target_arch = "aarch64") { "arm64-win" } else { "x86_64-win" }).is_dir() }
    #[cfg(target_os = "linux")]
    { bundle.join("Contents").join(format!("{}-linux", std::env::consts::ARCH)).is_dir() }
}

fn from_scan_process(bundle: &Path) -> Option<Vec<PluginInfo>> {
    let mut child = Command::new(std::env::current_exe().ok()?).arg("--scan").arg(bundle)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Err(_) => return None,
            Ok(None) if started.elapsed() > SCAN_TIMEOUT => {
                let _ = child.kill();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    // some plugins crash while the process exits (their own clean-up), after the result was printed
    let mut output = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut output).ok()?;
    serde_json::from_str::<Vec<PluginInfo>>(output.lines().last()?).ok()
}

fn describe(path: &Path) -> Bundle {
    let modified = modified(path);
    if !compatible(path) {
        let name = path.file_stem().map(|stem| stem.to_string_lossy().to_string()).unwrap_or_default();
        return Bundle { modified, status: "incompatible".into(), crashed: false, plugins: vec![PluginInfo {
            format: "vst3".into(), id: String::new(), name, vendor: String::new(), kind: String::new(),
            path: path.to_string_lossy().into(), status: "incompatible".into()
        }] };
    }
    match from_module_info(path).or_else(|| from_scan_process(path)) {
        Some(plugins) => Bundle { modified, status: "ok".into(), crashed: false, plugins },
        None => {
            let name = path.file_stem().map(|stem| stem.to_string_lossy().to_string()).unwrap_or_default();
            Bundle { modified, status: "failed".into(), crashed: false, plugins: vec![PluginInfo {
                format: "vst3".into(), id: String::new(), name, vendor: String::new(), kind: String::new(),
                path: path.to_string_lossy().into(), status: "failed".into()
            }] }
        }
    }
}

// Every plugin in the default and the given folders. `force` describes every bundle again (Rescan).
pub fn run(folders: &[String], force: bool) -> Vec<PluginInfo> {
    let _guard = CACHE_LOCK.lock().unwrap();
    let mut found = Vec::new();
    for folder in default_folders().into_iter().chain(folders.iter().map(PathBuf::from)) { bundles(&folder, &mut found); }
    found.sort();
    found.dedup();
    let mut cache = read_cache();
    let mut next = Cache::default();
    for path in found {
        let key = path.to_string_lossy().to_string();
        let current = modified(&path);
        let bundle = match cache.bundles.remove(&key) {
            Some(bundle) if !force && bundle.modified == current => bundle,
            _ => describe(&path),
        };
        next.bundles.insert(key, bundle);
    }
    write_cache(&next);
    let catalogue = catalogue_of(&next);
    println!("[plugins] {} plugins in {} bundles", catalogue.iter().filter(|plugin| plugin.status == "ok").count(), next.bundles.len());
    *CATALOGUE.lock().unwrap() = catalogue.clone();
    catalogue
}

fn catalogue_of(cache: &Cache) -> Vec<PluginInfo> {
    let mut catalogue: Vec<PluginInfo> = cache.bundles.values().flat_map(|bundle| bundle.plugins.iter().map(|plugin| {
        let mut plugin = plugin.clone();
        if bundle.crashed { plugin.status = "crashed".into(); }
        plugin
    })).collect();
    catalogue.sort_by(|a, b| (a.vendor.to_lowercase(), a.name.to_lowercase()).cmp(&(b.vendor.to_lowercase(), b.name.to_lowercase())));
    catalogue
}

// The plugin a box names: from the last scan, else the cache (a project can open before the first scan finished)
pub fn find(format: &str, id: &str) -> Option<PluginInfo> {
    let matches = |plugin: &&PluginInfo| plugin.format == format && plugin.id.eq_ignore_ascii_case(id) && plugin.status != "incompatible";
    if let Some(plugin) = CATALOGUE.lock().unwrap().iter().find(matches) { return Some(plugin.clone()); }
    let cached = catalogue_of(&read_cache());
    if let Some(plugin) = cached.iter().find(matches) { return Some(plugin.clone()); }
    run(&[], false).iter().find(matches).cloned()
}

// set while a plugin loads: a marker still set at the next start means it took the engine down
pub struct Loading(String);

impl Loading {
    pub fn new(path: &str) -> Self {
        mark_loading(path, true);
        Self(path.to_string())
    }
}

impl Drop for Loading {
    fn drop(&mut self) {mark_loading(&self.0, false)}
}

fn mark_loading(path: &str, loading: bool) {
    let _guard = CACHE_LOCK.lock().unwrap();
    let mut cache = read_cache();
    if let Some(bundle) = cache.bundles.get_mut(path) {
        if bundle.crashed == loading { return; }
        bundle.crashed = loading;
        write_cache(&cache);
    }
}

// `--scan <bundle>`: describes one bundle by loading it and prints its plugins as JSON (none for a bundle that only
// holds classes for other hosts, nothing at all when it cannot be loaded), then exits
pub fn scan_process(bundle: &str) -> ! {
    let Some(plugins) = (unsafe { load_and_describe(Path::new(bundle)) }) else { std::process::exit(1) };
    println!("{}", serde_json::to_string(&plugins).unwrap());
    let _ = std::io::Write::flush(&mut std::io::stdout());
    std::process::exit(0)
}

unsafe fn load_and_describe(bundle: &Path) -> Option<Vec<PluginInfo>> {
    let module = crate::plugins::module(bundle)?;
    let factory = &module.factory;
    let mut factory_info: PFactoryInfo = std::mem::zeroed();
    factory.getFactoryInfo(&mut factory_info);
    let factory_vendor = CStr::from_ptr(factory_info.vendor.as_ptr()).to_string_lossy().to_string();
    let factory2 = factory.cast::<IPluginFactory2>();
    let text = |chars: &[i8]| CStr::from_ptr(chars.as_ptr()).to_string_lossy().to_string();
    let hex = |cid: &TUID| cid.iter().map(|byte| format!("{:02X}", *byte as u8)).collect::<String>();
    Some((0..factory.countClasses()).filter_map(|index| {
        let (category, name, vendor, categories, cid) = match factory2.as_ref() {
            Some(factory2) => {
                let mut info: PClassInfo2 = std::mem::zeroed();
                if factory2.getClassInfo2(index, &mut info) != kResultOk { return None; }
                (text(&info.category), text(&info.name), text(&info.vendor), text(&info.subCategories), info.cid)
            }
            None => {
                let mut info: PClassInfo = std::mem::zeroed();
                if factory.getClassInfo(index, &mut info) != kResultOk { return None; }
                (text(&info.category), text(&info.name), String::new(), String::new(), info.cid)
            }
        };
        if category != "Audio Module Class" { return None; }
        Some(PluginInfo {
            format: "vst3".into(), id: hex(&cid), name,
            vendor: if vendor.is_empty() { factory_vendor.clone() } else { vendor },
            kind: kind_of(&categories).into(), path: bundle.to_string_lossy().into(), status: "ok".into()
        })
    }).collect())
}
