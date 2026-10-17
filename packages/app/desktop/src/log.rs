// Release builds write the shell's and the engine's output to <app data>/logs/openDAW.log, the session before is kept
// as openDAW.previous.log
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

// plugins may print on every audio block, the engine's output stops there
const LIMIT: u64 = 10 * 1024 * 1024;

static FOLDER: OnceLock<PathBuf> = OnceLock::new();
static ENGINE_LOG: Mutex<Option<File>> = Mutex::new(None);
static CUT: AtomicBool = AtomicBool::new(false);

pub fn start(data: &Path) {
    let folder = data.join("logs");
    if fs::create_dir_all(&folder).is_err() { return; }
    let current = folder.join("openDAW.log");
    let _ = fs::rename(&current, folder.join("openDAW.previous.log"));
    let Ok(file) = OpenOptions::new().create(true).append(true).open(&current) else { return };
    *ENGINE_LOG.lock().unwrap() = file.try_clone().ok();
    redirect(file);
    let _ = FOLDER.set(folder);
    println!("[openDAW] {} on {} {}", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH);
}

pub fn folder() -> Option<&'static Path> {FOLDER.get().map(PathBuf::as_path)}

// the engine's output is piped through the shell, which counts it against the limit
pub fn attach(child: &mut Child) {
    if let Some(stdout) = child.stdout.take() { std::thread::spawn(move || copy(stdout)); }
    if let Some(stderr) = child.stderr.take() { std::thread::spawn(move || copy(stderr)); }
}

fn copy(mut reader: impl Read) {
    let mut buffer = vec![0u8; 1 << 14];
    while let Ok(count) = reader.read(&mut buffer) {
        if count == 0 { break; }
        let mut file = ENGINE_LOG.lock().unwrap();
        let Some(file) = file.as_mut() else { continue };
        if file.metadata().is_ok_and(|meta| meta.len() < LIMIT) {
            let _ = file.write_all(&buffer[..count]);
        } else if !CUT.swap(true, Ordering::SeqCst) {
            let _ = file.write_all(b"\n[openDAW] the log reached 10 MB, the engine's further output is left out\n");
        }
    }
}

#[cfg(unix)]
fn redirect(file: File) {
    use std::os::fd::AsRawFd;
    extern "C" {
        fn dup2(from: i32, to: i32) -> i32;
    }
    unsafe {
        dup2(file.as_raw_fd(), 1);
        dup2(file.as_raw_fd(), 2);
    }
}

#[cfg(windows)]
fn redirect(file: File) {
    use std::os::windows::io::IntoRawHandle;
    #[link(name = "kernel32")]
    extern "system" {
        fn SetStdHandle(id: u32, handle: *mut std::ffi::c_void) -> i32;
    }
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    const STD_ERROR_HANDLE: u32 = -12i32 as u32;
    let handle = file.into_raw_handle();
    unsafe {
        SetStdHandle(STD_OUTPUT_HANDLE, handle);
        SetStdHandle(STD_ERROR_HANDLE, handle);
    }
}
