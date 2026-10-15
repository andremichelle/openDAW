use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use crate::{mime, HEADERS};

pub const PLUGIN_PORT: u16 = 47111;

#[derive(Default)]
struct State {
    bundles: Mutex<HashMap<String, HashMap<String, Vec<u8>>>>,
}

fn state() -> &'static State {
    static STATE: OnceLock<State> = OnceLock::new();
    STATE.get_or_init(State::default)
}

fn respond_empty(request: tiny_http::Request, status: u16) {
    let _ = request.respond(tiny_http::Response::empty(status));
}

pub fn handle(mut request: tiny_http::Request) -> Option<tiny_http::Request> {
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match segments.as_slice() {
        ["__wclap", "file", uuid, rest @ ..] => {
            let mut bytes = Vec::new();
            let _ = std::io::Read::read_to_end(request.as_reader(), &mut bytes);
            let file = urlencoding_decode(&rest.join("/"));
            state().bundles.lock().unwrap().entry(uuid.to_string()).or_default().insert(file, bytes);
            respond_empty(request, 204);
        }
        ["__wclap", "release", uuid] => {
            state().bundles.lock().unwrap().remove(*uuid);
            respond_empty(request, 204);
        }
        ["wclap", uuid, rest @ ..] => {
            let file = urlencoding_decode(&rest.join("/"));
            let bytes = state().bundles.lock().unwrap().get(*uuid).and_then(|files| files.get(&file).cloned());
            match bytes {
                Some(bytes) => {
                    let mut response = tiny_http::Response::from_data(bytes);
                    response.add_header(tiny_http::Header::from_bytes("Content-Type", mime(Path::new(&file))).unwrap());
                    for (key, value) in HEADERS {
                        response.add_header(tiny_http::Header::from_bytes(key, value).unwrap());
                    }
                    let _ = request.respond(response);
                }
                None => {
                    println!("[wclap] 404 {file}");
                    respond_empty(request, 404);
                }
            }
        }
        _ => return Some(request),
    }
    None
}

fn urlencoding_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// The plugin-only origin: the studio's wclap-frame.html plus the uploaded bundles, nothing else of the studio
pub fn run_plugin_server(root: Arc<PathBuf>) {
    let server = tiny_http::Server::http(("127.0.0.1", PLUGIN_PORT)).expect("plugin port taken");
    for request in server.incoming_requests() {
        let root = root.clone();
        std::thread::spawn(move || {
            let Some(request) = handle(request) else { return };
            if request.url().split('?').next() == Some("/wclap-frame.html") {
                let path = root.join("wclap-frame.html");
                let mut response = tiny_http::Response::from_data(std::fs::read(&path).unwrap_or_default());
                response.add_header(tiny_http::Header::from_bytes("Content-Type", mime(&path)).unwrap());
                for (key, value) in HEADERS {
                    response.add_header(tiny_http::Header::from_bytes(key, value).unwrap());
                }
                let _ = request.respond(response);
            } else {
                respond_empty(request, 404);
            }
        });
    }
}
